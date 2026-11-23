import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import type { Cache } from "./musicbrainz.ts";
import type { Candidate, Context, Kind } from "./matching.ts";
import { stripNul } from "./names.ts";
import { BATCH_SIZE, MB_CACHE_MAX_AGE_MS, PAGE_SIZE } from "./settings.ts";
import { printableCode } from "./store.ts";

type DbError = { code?: unknown } | null;

/** A database failure is reported by a plain code only: its text can quote a row or the address. */
function refused(what: string, error: NonNullable<DbError>): UserError {
  return new UserError(
    `The database refused ${what} (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: items already settled are kept.`,
  );
}

/** The SHA-256 of a request URL, in lower-case hex. It is the cache key, so a long name cannot overflow an index row. */
export const requestHash = (url: string): string => createHash("sha256").update(url).digest("hex");

/**
 * The cache table, `mb_cache`: the parsed candidates of each MusicBrainz request, by the hash of its URL.
 * A row older than MB_CACHE_MAX_AGE_MS, measured from fetched_at, reads as a miss, and the next put replaces it.
 */
export class SupabaseCache implements Cache {
  constructor(
    private readonly client: SupabaseClient,
    private readonly maxAgeMs: number = MB_CACHE_MAX_AGE_MS,
  ) {}

  async get(url: string): Promise<unknown> {
    const { data, error } = await this.client
      .from("mb_cache")
      .select("candidates, fetched_at")
      .eq("request_hash", requestHash(url))
      .maybeSingle();
    if (error) throw refused("a cache read", error);
    if (data === null) return undefined;
    const row = data as { candidates: unknown; fetched_at: string };
    if (Date.now() - new Date(row.fetched_at).getTime() > this.maxAgeMs) return undefined;
    return row.candidates;
  }

  async put(url: string, candidates: Candidate[]): Promise<void> {
    const { error } = await this.client
      .from("mb_cache")
      .upsert({ request_hash: requestHash(url), candidates, fetched_at: new Date().toISOString() }, { onConflict: "request_hash" });
    if (error) throw refused("a cache write", error);
  }

  async remove(url: string): Promise<void> {
    const { error } = await this.client.from("mb_cache").delete().eq("request_hash", requestHash(url));
    if (error) throw refused("a cache delete", error);
  }
}

export type StoredItem = {
  id: number;
  kind: Kind;
  source_key: string;
  state: "pending" | "resolved" | "unresolved";
  mbid: string | null;
  attempts: number;
};

/** Every stored item, a page at a time. */
export async function loadItems(client: SupabaseClient): Promise<StoredItem[]> {
  const all: StoredItem[] = [];
  let after = 0;
  for (;;) {
    const { data, error } = await client
      .from("items")
      .select("id, kind, source_key, state, mbid, attempts")
      .gt("id", after)
      .order("id")
      .limit(PAGE_SIZE);
    if (error) throw refused("a read of the items", error);
    const rows = data as StoredItem[];
    all.push(...rows);
    const last = rows.at(-1);
    if (rows.length < PAGE_SIZE || !last) return all;
    after = last.id;
  }
}

/**
 * Adds a pending row for each item. A row that already exists, from this run or another one
 * running at the same time, is left alone, so no item is ever stored twice. Returns how many were new.
 */
export async function insertPending(client: SupabaseClient, contexts: Context[]): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < contexts.length; start += BATCH_SIZE) {
    const rows = contexts.slice(start, start + BATCH_SIZE).map((context) => ({
      kind: context.kind,
      source_key: stripNul(context.key),
      name: stripNul(context.name),
      spotify_uri: context.uri ?? null,
    }));
    const { data, error } = await client
      .from("items")
      .upsert(rows, { onConflict: "kind,source_key", ignoreDuplicates: true })
      .select("id");
    if (error) throw refused("a batch of new items", error);
    inserted += data.length;
  }
  return inserted;
}

export type Settlement =
  | { state: "resolved"; mbid: string; score: number | null; name: string; reason?: "credit" }
  | {
      state: "unresolved";
      reason: "no_match" | "below_threshold" | "ambiguous" | "empty_name" | "no_artist" | "bad_query" | "name_too_long";
      score: number | null;
      name: string | null;
    };

/** Postgres code for a unique index that would be broken. */
const UNIQUE_VIOLATION = "23505";

/**
 * Settles one pending item. It touches a row only while the row is still pending, so when two runs
 * race, the first to settle an item wins and the other changes nothing. Returns whether this call settled it.
 *
 * Two items can name the same MusicBrainz entity (a song on an album and on a single). The first keeps
 * the MBID. The other keeps its own row with no MBID and `merged_into` set to the first, so its alias is kept.
 */
export async function settle(
  client: SupabaseClient,
  item: { id: number; kind: Kind },
  settlement: Settlement,
): Promise<boolean> {
  const resolved_at = new Date().toISOString();
  // MusicBrainz scores are whole numbers in practice. The column holds whole numbers, so a fraction is rounded to store.
  // The comparison with the threshold has already been made on the raw score.
  const common = {
    resolved_at,
    match_score: settlement.score === null ? null : Math.round(settlement.score),
    matched_name: settlement.name === null ? null : stripNul(settlement.name),
  };
  const patch =
    settlement.state === "resolved"
      ? { ...common, state: "resolved", mbid: settlement.mbid, reason: settlement.reason ?? null }
      : { ...common, state: "unresolved", reason: settlement.reason };

  const attempt = async (values: Record<string, unknown>) =>
    client.from("items").update(values).eq("id", item.id).eq("state", "pending").select("id");

  const first = await attempt(patch);
  if (!first.error) return first.data.length > 0;
  if (first.error.code !== UNIQUE_VIOLATION || settlement.state !== "resolved") {
    throw refused("an item update", first.error);
  }

  const owner = await client.from("items").select("id").eq("kind", item.kind).eq("mbid", settlement.mbid).maybeSingle();
  if (owner.error) throw refused("an item lookup", owner.error);
  if (owner.data === null) throw new UserError("An item's MusicBrainz ID is held by a row that then vanished. Run the command again.");
  const ownerId = (owner.data as { id: number }).id;

  const merged = await attempt({ ...common, state: "resolved", mbid: null, merged_into: ownerId, reason: settlement.reason ?? null });
  if (merged.error) throw refused("an item update", merged.error);
  return merged.data.length > 0;
}

/**
 * Records that a try ended with MusicBrainz unavailable. `attempts` is what this run read, plus one.
 * Only one run works at a time (see job-lock.ts), so no other run can move the count between the read and this write.
 */
export async function recordAttempt(client: SupabaseClient, item: { id: number; attempts: number }): Promise<void> {
  const { error } = await client
    .from("items")
    .update({ attempts: item.attempts + 1, last_attempt_at: new Date().toISOString() })
    .eq("id", item.id)
    .eq("state", "pending");
  if (error) throw refused("an item update", error);
}
