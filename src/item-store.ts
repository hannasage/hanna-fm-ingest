import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import type { Cache } from "./musicbrainz.ts";
import type { Context, Kind } from "./matching.ts";
import { BATCH_SIZE, PAGE_SIZE } from "./settings.ts";
import { printableCode } from "./store.ts";

type DbError = { code?: unknown } | null;

/** A database failure is reported by a plain code only: its text can quote a row or the address. */
function refused(what: string, error: NonNullable<DbError>): UserError {
  return new UserError(
    `The database refused ${what} (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: items already settled are kept.`,
  );
}

/** The cache table, `mb_cache`: the JSON answer to each MusicBrainz request, by request. */
export class SupabaseCache implements Cache {
  constructor(private readonly client: SupabaseClient) {}

  async get(key: string): Promise<unknown> {
    const { data, error } = await this.client.from("mb_cache").select("response").eq("query", key).maybeSingle();
    if (error) throw refused("a cache read", error);
    return data === null ? undefined : (data as { response: unknown }).response;
  }

  async put(key: string, body: unknown): Promise<void> {
    const { error } = await this.client
      .from("mb_cache")
      .upsert({ query: key, response: body, fetched_at: new Date().toISOString() }, { onConflict: "query" });
    if (error) throw refused("a cache write", error);
  }
}

export type StoredItem = { id: number; kind: Kind; source_key: string; state: "pending" | "resolved" | "unresolved" };

/** Every stored item, a page at a time. */
export async function loadItems(client: SupabaseClient): Promise<StoredItem[]> {
  const all: StoredItem[] = [];
  let after = 0;
  for (;;) {
    const { data, error } = await client
      .from("items")
      .select("id, kind, source_key, state")
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
      source_key: context.key,
      name: context.name,
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
  | { state: "resolved"; mbid: string; score: number; name: string }
  | { state: "unresolved"; reason: "no_match" | "below_threshold" | "empty_name"; score: number | null; name: string | null };

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
  const common = { resolved_at, match_score: settlement.score, matched_name: settlement.name };
  const patch =
    settlement.state === "resolved"
      ? { ...common, state: "resolved", mbid: settlement.mbid, reason: null }
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

  const merged = await attempt({ ...common, state: "resolved", mbid: null, merged_into: ownerId, reason: null });
  if (merged.error) throw refused("an item update", merged.error);
  return merged.data.length > 0;
}
