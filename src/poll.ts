import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import { mapItem, POLL_SKIP_REASONS, type PollSkipReason } from "./poll-mapping.ts";
import { DEDUPE_WINDOW_SECONDS, POLL_LIMIT } from "./settings.ts";
import { fetchRecentlyPlayed, MESSAGES, refreshAccessToken, type SpotifyConfig } from "./spotify.ts";
import { printableCode, storeBatch, type PlayRow } from "./store.ts";

export type PollCounts = {
  fetched: number;
  stored: number;
  duplicate: number;
  skipped: Record<PollSkipReason, number>;
  /** True when a full page came back, so older plays may be missing. */
  possibleGap: boolean;
};

export function emptyPollCounts(): PollCounts {
  return {
    fetched: 0,
    stored: 0,
    duplicate: 0,
    skipped: Object.fromEntries(POLL_SKIP_REASONS.map((reason) => [reason, 0])) as Record<PollSkipReason, number>,
    possibleGap: false,
  };
}

/** The most rows one read of the plays table returns. A read that hits it may be cut short. */
const READ_LIMIT = 1000;

function readFailed(error: { code?: unknown }): UserError {
  // The error text can quote a row or the address. Report a plain code only.
  return new UserError(
    `The database refused a read (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the poll again.`,
  );
}

/** The latest stored end time in milliseconds, or null when nothing is stored. */
async function latestEndedAt(client: SupabaseClient): Promise<number | null> {
  const { data, error } = await client
    .from("plays")
    .select("ended_at")
    .order("ended_at", { ascending: false })
    .limit(1);
  if (error) throw readFailed(error);
  const latest = (data ?? [])[0]?.ended_at;
  if (latest === undefined) return null;
  const time = Date.parse(String(latest));
  if (Number.isNaN(time)) throw new UserError("The database gave an end time the poll cannot read.");
  return time;
}

/** Stored end times, in milliseconds, near the candidates, grouped by track. */
async function storedNear(client: SupabaseClient, candidates: PlayRow[]): Promise<Map<string, number[]>> {
  const times = candidates.map((play) => Date.parse(play.ended_at));
  const margin = DEDUPE_WINDOW_SECONDS * 1000;
  const { data, error } = await client
    .from("plays")
    .select("track_uri, ended_at")
    .in("track_uri", [...new Set(candidates.map((play) => play.track_uri))])
    .gte("ended_at", new Date(Math.min(...times) - margin).toISOString())
    .lte("ended_at", new Date(Math.max(...times) + margin).toISOString())
    .limit(READ_LIMIT);
  if (error) throw readFailed(error);
  const rows = data ?? [];
  if (rows.length >= READ_LIMIT) {
    throw new UserError("The database returned more nearby plays than the poll can check. Nothing was stored.");
  }
  const found = new Map<string, number[]>();
  for (const row of rows) {
    const list = found.get(String(row.track_uri)) ?? [];
    list.push(Date.parse(String(row.ended_at)));
    found.set(String(row.track_uri), list);
  }
  return found;
}

/**
 * One poll: reads the latest stored end time, trades the refresh token for an access token,
 * asks Spotify for plays after that time, and stores the new ones.
 *
 * A play is a repeat when the same track has a stored end time within DEDUPE_WINDOW_SECONDS of it
 * (the edge counts), or when the table's exact key already holds it. Two plays in one answer
 * are checked against each other the same way.
 *
 * `counts` is updated as the poll goes. `warn` gets plain warning lines, never a token.
 */
export async function poll(
  client: SupabaseClient,
  config: SpotifyConfig,
  counts: PollCounts = emptyPollCounts(),
  warn: (line: string) => void = () => {},
): Promise<PollCounts> {
  // The database is read first, so a database problem is found before the login is used.
  const afterMs = await latestEndedAt(client);

  const token = await refreshAccessToken(config);
  // Said at once, so a later failure cannot hide it.
  if (token.rotatedRefreshToken !== null) warn(MESSAGES.rotated);

  const items = await fetchRecentlyPlayed(config, token.accessToken, afterMs);
  counts.fetched = items.length;
  counts.possibleGap = items.length >= POLL_LIMIT;

  const candidates: PlayRow[] = [];
  for (const item of items) {
    const mapped = mapItem(item);
    if ("skipped" in mapped) counts.skipped[mapped.skipped] += 1;
    else candidates.push(mapped.play);
  }
  if (candidates.length === 0) return counts;

  const near = await storedNear(client, candidates);
  const windowMs = DEDUPE_WINDOW_SECONDS * 1000;
  const fresh: PlayRow[] = [];
  for (const play of candidates) {
    const time = Date.parse(play.ended_at);
    const known = near.get(play.track_uri) ?? [];
    if (known.some((other) => Math.abs(other - time) <= windowMs)) {
      counts.duplicate += 1;
      continue;
    }
    fresh.push(play);
    near.set(play.track_uri, [...known, time]);
  }
  if (fresh.length === 0) return counts;

  // Two polls at once can both pass the check above. The table's exact key still keeps one row,
  // and the rows it refuses are counted as repeats.
  const inserted = await storeBatch(client, fresh);
  counts.stored += inserted;
  counts.duplicate += fresh.length - inserted;
  return counts;
}
