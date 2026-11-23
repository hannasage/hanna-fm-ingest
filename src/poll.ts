import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError, type FailureKind } from "./files.ts";
import {
  endedAtToCursorMs,
  mapItem,
  playedAtMs,
  POLL_SKIP_REASONS,
  type PollSkipReason,
} from "./poll-mapping.ts";
import {
  BATCH_SIZE,
  DEDUPE_WINDOW_SECONDS,
  FUTURE_TOLERANCE_SECONDS,
  POLL_LIMIT,
  POLL_MAX_PAGES,
} from "./settings.ts";
import {
  fetchRecentlyPlayed,
  MESSAGES,
  refreshAccessToken,
  type Paging,
  type SpotifyConfig,
} from "./spotify.ts";
import { printableCode, storeBatch, type PlayRow } from "./store.ts";

export type PollCounts = {
  fetched: number;
  stored: number;
  /** Plays within DEDUPE_WINDOW_SECONDS of a stored play from an export, for the same track. */
  duplicateExport: number;
  /** Plays whose exact key (track and end time) was already stored or came twice. */
  duplicateExact: number;
  skipped: Record<PollSkipReason, number>;
  /**
   * Set when the poll stopped before reaching plays it already holds, so older plays may be missing.
   * `capped`: it read POLL_MAX_PAGES pages. `stalled`: Spotify gave no older page to go back to.
   */
  gap: "capped" | "stalled" | null;
};

export function emptyPollCounts(): PollCounts {
  return {
    fetched: 0,
    stored: 0,
    duplicateExport: 0,
    duplicateExact: 0,
    skipped: { no_track: 0, malformed: 0 },
    gap: null,
  };
}

export function totalSkipped(counts: PollCounts): number {
  return POLL_SKIP_REASONS.reduce((sum, reason) => sum + counts.skipped[reason], 0);
}

/** Fixed lines for the failures that are not an exception. None holds a play or a secret. */
export const POLL_MESSAGES = {
  futureCursor: `The newest stored play is more than ${FUTURE_TOLERANCE_SECONDS} seconds in the future, so the poll cannot use it as its starting point. Fix or delete that row, then run the poll again.`,
  capped: `Spotify has more plays than one poll reads (${POLL_MAX_PAGES} pages of ${POLL_LIMIT}). The plays fetched were stored. Plays older than those may be missing.`,
  stalled:
    "The poller could not page back to older plays, so it stopped. The plays fetched were stored. Plays older than those may be missing.",
  onlyNoTrack: (fetched: number) =>
    `Spotify sent ${fetched} item${fetched === 1 ? "" : "s"} and every one was a local file or an episode, which has no track to store. Nothing was stored. This is normal until a real play appears.`,
  allSkipped: (fetched: number) =>
    `Spotify sent ${fetched} item${fetched === 1 ? "" : "s"} and every one was skipped, so nothing was stored. The counts above show why. Check src/poll-mapping.ts against Spotify's answer.`,
  someMalformed: (malformed: number) =>
    `${malformed} item${malformed === 1 ? "" : "s"} from Spotify could not be read (a field is missing or odd). The readable plays were stored. Check src/poll-mapping.ts against Spotify's answer.`,
} as const;

/**
 * Why a poll that kept no play at all (nothing stored, nothing a repeat) came out so, from its skip counts.
 * Local files and episodes (`no_track`) are normal, so a window of only those is no failure: the poll
 * exits 0 and says so (`pollNotes`). It is a failure when at least one skipped item is `malformed`,
 * which means a field was renamed or is odd.
 */
function keptNothing(counts: PollCounts): boolean {
  return counts.fetched > 0 && counts.stored + counts.duplicateExport + counts.duplicateExact === 0;
}

/**
 * The reasons a finished poll must still exit 1, as plain lines. A run that stored nothing
 * by mistake (a malformed item among the skips), or that skipped a malformed item, or that stopped
 * short of older plays, is never green. A window of only local files and episodes is not a mistake.
 */
export function pollProblems(counts: PollCounts): string[] {
  const problems: string[] = [];
  if (counts.gap === "capped") problems.push(POLL_MESSAGES.capped);
  if (counts.gap === "stalled") problems.push(POLL_MESSAGES.stalled);
  if (counts.skipped.malformed > 0) {
    problems.push(keptNothing(counts) ? POLL_MESSAGES.allSkipped(counts.fetched) : POLL_MESSAGES.someMalformed(counts.skipped.malformed));
  }
  return problems;
}

/**
 * The kind to store for a finished run that must still exit 1, or null when the run is green.
 * One kind per run. A stop short of older plays comes first, because plays may be missing.
 * "No older page" is `stalled`: it is not the page cap.
 */
export function pollProblemKind(counts: PollCounts): FailureKind | null {
  if (counts.gap === "capped") return "page_cap";
  if (counts.gap === "stalled") return "stalled";
  if (counts.skipped.malformed > 0) return "malformed_items";
  return null;
}

/** Plain lines for a poll that is green but kept nothing because every item was a local file or an episode. */
export function pollNotes(counts: PollCounts): string[] {
  return keptNothing(counts) && counts.skipped.malformed === 0 ? [POLL_MESSAGES.onlyNoTrack(counts.fetched)] : [];
}

/** The most rows one read of the plays table returns. A read that hits it may be cut short. */
const READ_LIMIT = 1000;

/** How many track URIs one read names, so the request address stays short. */
const URIS_PER_READ = 50;

function readFailed(error: { code?: unknown }): UserError {
  // The error text can quote a row or the address. Report a plain code only.
  return new UserError(
    `The database refused a read (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the poll again.`,
    "database_error",
  );
}

/** The part of a stored row the poll reads. */
type StoredPlay = { track_uri: string; ended_at: string };

function isStoredPlay(value: unknown): value is StoredPlay {
  return (
    typeof value === "object" &&
    value !== null &&
    "track_uri" in value &&
    typeof value.track_uri === "string" &&
    "ended_at" in value &&
    typeof value.ended_at === "string"
  );
}

const UNREADABLE_ROW = "The database gave a row the poll cannot read.";

/** The latest stored end time in milliseconds, or null when nothing is stored. */
async function latestEndedAt(client: SupabaseClient, nowMs: number): Promise<number | null> {
  const { data, error } = await client
    .from("plays")
    .select("track_uri, ended_at")
    .order("ended_at", { ascending: false })
    .limit(1);
  if (error) throw readFailed(error);
  const rows: unknown[] = data ?? [];
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isStoredPlay(row)) throw new UserError(UNREADABLE_ROW, "database_error");
  const cursor = endedAtToCursorMs(row.ended_at);
  if (cursor === null) throw new UserError("The database gave an end time the poll cannot read.", "database_error");
  // A bad row ahead of the clock would hide every real play. Say so; never clamp it away.
  if (cursor > nowMs + FUTURE_TOLERANCE_SECONDS * 1000) throw new UserError(POLL_MESSAGES.futureCursor, "future_cursor");
  return cursor;
}

/** The smallest and largest of the times, by a loop (a spread of many values can overflow the stack). */
function bounds(times: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const time of times) {
    if (time < min) min = time;
    if (time > max) max = time;
  }
  return { min, max };
}

/**
 * Stored end times, in milliseconds, near the candidates, grouped by track. Only rows that came
 * from an export are read: a poll row is told apart by its exact key alone.
 */
async function exportTimesNear(client: SupabaseClient, candidates: PlayRow[]): Promise<Map<string, number[]>> {
  const margin = DEDUPE_WINDOW_SECONDS * 1000;
  const uris = [...new Set(candidates.map((play) => play.track_uri))];
  const found = new Map<string, number[]>();
  for (let start = 0; start < uris.length; start += URIS_PER_READ) {
    const chunk = uris.slice(start, start + URIS_PER_READ);
    const { min, max } = bounds(
      candidates.filter((play) => chunk.includes(play.track_uri)).map((play) => Date.parse(play.ended_at)),
    );
    const { data, error } = await client
      .from("plays")
      .select("track_uri, ended_at")
      .eq("source", "export")
      .in("track_uri", chunk)
      .gte("ended_at", new Date(min - margin).toISOString())
      .lte("ended_at", new Date(max + margin).toISOString())
      .limit(READ_LIMIT);
    if (error) throw readFailed(error);
    const rows: unknown[] = data ?? [];
    if (rows.length >= READ_LIMIT) {
      throw new UserError("The database returned more nearby plays than the poll can check. Nothing was stored.");
    }
    for (const row of rows) {
      if (!isStoredPlay(row)) throw new UserError(UNREADABLE_ROW, "database_error");
      const time = endedAtToCursorMs(row.ended_at);
      if (time === null) throw new UserError(UNREADABLE_ROW, "database_error");
      found.set(row.track_uri, [...(found.get(row.track_uri) ?? []), time]);
    }
  }
  return found;
}

/** The oldest play time on a page in milliseconds, or null when no item holds a readable one. */
function oldestOf(items: unknown[]): number | null {
  let oldest: number | null = null;
  for (const item of items) {
    const time = playedAtMs(item);
    if (time !== null && (oldest === null || time < oldest)) oldest = time;
  }
  return oldest;
}

/** True when an item's time, cut to whole seconds as it is stored, is after the cursor. */
function isAfter(item: unknown, cursor: number): boolean {
  const time = playedAtMs(item);
  return time !== null && Math.floor(time / 1000) * 1000 > cursor;
}

/**
 * Reads pages until one is short, empty, or holds only plays at or before the stored cursor.
 * The first page uses `after` (the cursor); every later page uses `before` (the oldest time seen),
 * because Spotify refuses both together. Stops with a gap at POLL_MAX_PAGES, or when Spotify gives no
 * older page. Any gap is for the caller to report after what was fetched is stored.
 */
async function fetchPages(
  config: SpotifyConfig,
  accessToken: string,
  cursor: number | null,
): Promise<{ items: unknown[]; gap: PollCounts["gap"] }> {
  const items: unknown[] = [];
  let paging: Paging = cursor === null ? {} : { afterMs: cursor };
  let before: number | null = null;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await fetchRecentlyPlayed(config, accessToken, paging);
    const oldest = oldestOf(page);
    // A page asked for plays before `before`. One that is not older means Spotify ignored it.
    if (before !== null && oldest !== null && oldest >= before) return { items, gap: "stalled" };
    for (const item of page) items.push(item);

    if (page.length < POLL_LIMIT) return { items, gap: null };
    if (cursor !== null && !page.some((item) => isAfter(item, cursor))) return { items, gap: null };
    if (oldest === null) return { items, gap: "stalled" };
    if (pageNumber >= POLL_MAX_PAGES) return { items, gap: "capped" };
    before = oldest;
    paging = { beforeMs: oldest };
  }
}

/**
 * One poll: reads the latest stored end time, trades the refresh token for an access token,
 * reads Spotify's recent plays (paging back past a full page), and stores the new ones.
 *
 * A play is a repeat of an export play when the same track has a stored export end time within
 * DEDUPE_WINDOW_SECONDS of it (the edge counts). A repeat of a poll play is told apart by the
 * table's exact key alone, so a replay of a short track is kept.
 *
 * `counts` is updated as the poll goes. `warn` gets plain warning lines, never a token.
 */
export async function poll(
  client: SupabaseClient,
  config: SpotifyConfig,
  counts: PollCounts = emptyPollCounts(),
  warn: (line: string) => void = () => {},
  nowMs: number = Date.now(),
): Promise<PollCounts> {
  // The database is read first, so a database problem is found before the login is used.
  const cursor = await latestEndedAt(client, nowMs);

  const token = await refreshAccessToken(config);
  // Said at once, so a later failure cannot hide it.
  if (token.rotatedRefreshToken !== null) warn(MESSAGES.rotated);

  const { items, gap } = await fetchPages(config, token.accessToken, cursor);
  counts.fetched = items.length;
  counts.gap = gap;

  const candidates: PlayRow[] = [];
  for (const item of items) {
    const mapped = mapItem(item, nowMs);
    if ("skipped" in mapped) counts.skipped[mapped.skipped] += 1;
    else candidates.push(mapped.play);
  }
  if (candidates.length === 0) return counts;

  const near = await exportTimesNear(client, candidates);
  const windowMs = DEDUPE_WINDOW_SECONDS * 1000;
  const seen = new Set<string>();
  const fresh: PlayRow[] = [];
  for (const play of candidates) {
    const time = Date.parse(play.ended_at);
    if ((near.get(play.track_uri) ?? []).some((other) => Math.abs(other - time) <= windowMs)) {
      counts.duplicateExport += 1;
      continue;
    }
    const key = `${play.track_uri}\n${play.ended_at}`;
    if (seen.has(key)) {
      counts.duplicateExact += 1;
      continue;
    }
    seen.add(key);
    fresh.push(play);
  }

  // Two polls at once can both pass the checks above. The table's exact key still keeps one row,
  // and the rows it refuses are counted as exact repeats.
  for (let start = 0; start < fresh.length; start += BATCH_SIZE) {
    const batch = fresh.slice(start, start + BATCH_SIZE);
    const inserted = await storeBatch(client, batch);
    counts.stored += inserted;
    counts.duplicateExact += batch.length - inserted;
  }
  return counts;
}
