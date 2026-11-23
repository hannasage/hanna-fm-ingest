import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import { insertPending, loadItems, recordAttempt, settle, type Settlement, type StoredItem } from "./item-store.ts";
import {
  albumQuery,
  artistQuery,
  decide,
  parseCandidates,
  primaryCredits,
  trackQuery,
  type Candidate,
  type Context,
  type Decision,
  type Kind,
} from "./matching.ts";
import type { MusicBrainz, SearchEntity, SearchResult } from "./musicbrainz.ts";
import { artistKey } from "./names.ts";
import { itemId, scanPlays } from "./scan-plays.ts";
import {
  MB_MAX_NAME_LENGTH,
  RESOLVE_MAX_ATTEMPTS,
  RESOLVE_MAX_CONSECUTIVE_REFUSED,
  RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE,
  RESOLVE_PROGRESS_EVERY,
} from "./settings.ts";

/**
 * Every count is of items. Each item that was pending when the run began lands in exactly one of
 * resolved, unresolved, pending, skipped, exhausted or remaining, so `total` is their sum. `new` and the last two are not of that kind.
 */
export type ResolveCounts = {
  /** Item rows created this run. */
  new: number;
  /** Items that were pending when the run began, the new ones included. */
  total: number;
  /** Items settled this run with an MBID, or merged into the row that has it. An artist settled from a track's credit counts here. */
  resolved: number;
  /** Items settled this run as unresolved: MusicBrainz cannot match them, they cannot be searched, or MusicBrainz refused them RESOLVE_MAX_ATTEMPTS times. */
  unresolved: number;
  /** Items this run tried and left pending, because MusicBrainz was unavailable or refused the lookup. */
  pending: number;
  /** Pending items this run did not try: no play names them any more, or another run settled them. */
  skipped: number;
  /** Pending items that have failed RESOLVE_MAX_ATTEMPTS times or more, and so are stuck until the command is given --retry-failed. */
  exhausted: number;
  /** Pending items this run did not reach: the run stopped, or reached its --limit. */
  remaining: number;
  /** Requests sent to MusicBrainz, retries included. */
  requests: number;
  /** Searches answered from the cache. */
  cache_hits: number;
};

export function emptyResolveCounts(): ResolveCounts {
  return { new: 0, total: 0, resolved: 0, unresolved: 0, pending: 0, skipped: 0, exhausted: 0, remaining: 0, requests: 0, cache_hits: 0 };
}

/** Counts only. No name from the plays and no response text ever goes in this report. */
export function formatResolveReport(counts: ResolveCounts, options: { partial?: boolean } = {}): string {
  return [
    `new: ${counts.new}`,
    `total: ${counts.total}`,
    `resolved: ${counts.resolved}`,
    `unresolved: ${counts.unresolved}`,
    `pending: ${counts.pending}`,
    `skipped: ${counts.skipped}`,
    `exhausted: ${counts.exhausted}`,
    `remaining: ${counts.remaining}`,
    `requests: ${counts.requests}`,
    `cache_hits: ${counts.cache_hits}`,
    ...(options.partial ? ["partial: true"] : []),
    "",
  ].join("\n");
}

export type ResolveOptions = {
  /** Try items that have already failed RESOLVE_MAX_ATTEMPTS times. */
  retryFailed?: boolean;
  /** Process at most this many items. The rest stay pending and are counted as remaining. */
  limit?: number;
  /** Gets a progress line, with counts only, after every RESOLVE_PROGRESS_EVERY items. */
  progress?: (line: string) => void;
  /** Gets each failure kind (http_503, dns, ...) the first time it is seen in the run, and never again. */
  onUnavailableKind?: (kind: string) => void;
  /** Runs before each item. The command uses it to refresh its lock, and it throws when the lock is lost. (The client also refreshes it before every request.) */
  heartbeat?: () => Promise<void>;
};

/** What to ask MusicBrainz for each kind, and how to read the answer. */
const SEARCH = {
  track: { entity: "recording", list: "recordings", nameKey: "title" },
  album: { entity: "release-group", list: "release-groups", nameKey: "title" },
  artist: { entity: "artist", list: "artists", nameKey: "name" },
} as const;

/** Tracks first, so their artist credits can settle artists before an artist search is needed. */
const ORDER: Kind[] = ["track", "album", "artist"];

type Entry = { item: StoredItem; context: Context };

const tooLong = (text: string | undefined): boolean => text !== undefined && Array.from(text).length > MB_MAX_NAME_LENGTH;

/**
 * Finds the distinct tracks, artists and albums in the plays, stores a pending row for each that has none,
 * and settles every pending row: by MusicBrainz search, through the one rate-limited queue and the cache.
 *
 * Pending rows from an earlier run, where MusicBrainz was unavailable, are tried again, up to RESOLVE_MAX_ATTEMPTS.
 * An item MusicBrainz cannot match becomes unresolved. It is never dropped.
 *
 * A failed lookup (unavailable, or refused with a 4xx) leaves the item pending and is charged to it as an attempt only
 * once MusicBrainz has then answered a different lookup, which shows the failure was the item's own. A failure that
 * ends the run, or that was never followed by an answer, says nothing about the item and costs it nothing. So an
 * outage, or a wrong MB_API_BASE, can never use up an item's attempts. A refused item settles as unresolved
 * `bad_query` only when its attempts reach RESOLVE_MAX_ATTEMPTS. An item that reaches the limit while unavailable is
 * `exhausted`: it waits for --retry-failed, and the command exits 1 while any exist.
 *
 * One bad item never stops the run: a refused lookup settles only that item. The run does stop, with a UserError,
 * on a 401 or 403, a lost lock, an unusable answer, and after RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE lookups in a
 * row that MusicBrainz could not answer, or RESOLVE_MAX_CONSECUTIVE_REFUSED that it refused.
 * The counts are filled in as the run goes, so they are true when it stops.
 */
export async function resolveItems(
  client: SupabaseClient,
  musicbrainz: MusicBrainz,
  counts: ResolveCounts = emptyResolveCounts(),
  options: ResolveOptions = {},
): Promise<ResolveCounts> {
  const contexts = await scanPlays(client);

  let stored = await loadItems(client);
  const known = new Set(stored.map((item) => itemId(item.kind, item.source_key)));
  const fresh = [...contexts.entries()].filter(([itemKey]) => !known.has(itemKey)).map(([, context]) => context);
  if (fresh.length > 0) {
    counts.new += await insertPending(client, fresh);
    stored = await loadItems(client);
  }

  const work = new Map<Kind, Entry[]>(ORDER.map((kind) => [kind, []]));
  for (const item of stored) {
    if (item.state !== "pending") continue;
    counts.total += 1;
    const context = contexts.get(itemId(item.kind, item.source_key));
    if (context) work.get(item.kind)?.push({ item, context });
    else counts.skipped += 1; // no play names it any more
  }
  const pendingArtists = new Map(work.get("artist")?.map((entry) => [entry.context.key, entry]));
  // The MBID of each artist already matched, so a track or album credited to that artist is accepted under any spelling.
  const artistMbids = new Map<string, string>();
  for (const item of stored) if (item.kind === "artist" && item.mbid) artistMbids.set(item.source_key, item.mbid);

  const settledHere = new Set<number>();
  const kinds = new Set<string>();
  /** Items whose lookup failed since MusicBrainz last gave a fresh answer. They are charged once it does. */
  let suspects: { item: StoredItem; refused: boolean }[] = [];
  let processed = 0;
  let unavailableInARow = 0;
  let refusedInARow = 0;
  const workable = ORDER.reduce(
    (sum, kind) => sum + (work.get(kind) ?? []).filter((entry) => options.retryFailed || entry.item.attempts < RESOLVE_MAX_ATTEMPTS).length,
    0,
  );
  const planned = options.limit === undefined ? workable : Math.min(workable, options.limit);

  try {
    for (const kind of ORDER) {
      for (const { item, context } of work.get(kind) ?? []) {
        if (settledHere.has(item.id)) continue;
        if (!options.retryFailed && item.attempts >= RESOLVE_MAX_ATTEMPTS) {
          counts.exhausted += 1;
          continue;
        }
        if (options.limit !== undefined && processed >= options.limit) continue;

        processed += 1;
        await options.heartbeat?.();

        const settled = await resolveOne(item, context);
        if (settled === "pending") {
          counts.pending += 1;
          unavailableInARow += 1;
          if (unavailableInARow >= RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE) {
            throw new UserError(
              `MusicBrainz could not answer ${unavailableInARow} lookups in a row, so the run stopped. Items already settled are kept. Run the command again later.`,
            );
          }
        } else if (settled === "gone") {
          counts.skipped += 1; // another run settled it first
        } else if (settled === "resolved") {
          counts.resolved += 1;
        } else {
          counts.unresolved += 1;
        }
        if (refusedInARow >= RESOLVE_MAX_CONSECUTIVE_REFUSED) {
          throw new UserError(
            `MusicBrainz refused ${refusedInARow} lookups in a row, so the run stopped. Check MB_API_BASE and MB_USER_AGENT. Items already settled are kept.`,
          );
        }
        if (processed % RESOLVE_PROGRESS_EVERY === 0) options.progress?.(`progress: ${processed} of ${planned} items`);
      }
    }
  } finally {
    counts.requests = musicbrainz.requests;
    counts.cache_hits = musicbrainz.cacheHits;
    counts.remaining = counts.total - (counts.resolved + counts.unresolved + counts.pending + counts.skipped + counts.exhausted);
  }
  return counts;

  /** Settles one item, and says how it ended. Updates the two runs-in-a-row counters. */
  async function resolveOne(item: StoredItem, context: Context): Promise<"resolved" | "unresolved" | "pending" | "gone"> {
    const unsearchable = unsearchableReason(context);
    if (unsearchable) return settleWith(item, { state: "unresolved", reason: unsearchable, score: null, name: null });

    const result = await search(context);
    if (result.outcome === "unavailable") {
      suspects.push({ item, refused: false });
      if (!kinds.has(result.kind)) {
        kinds.add(result.kind);
        options.onUnavailableKind?.(result.kind);
      }
      return "pending";
    }

    if (result.outcome === "rejected") {
      // This lookup was refused, so it is not settled on first sight: a wrong address or a 408 would settle every item.
      unavailableInARow = 0;
      refusedInARow += 1;
      suspects.push({ item, refused: true });
      return "pending";
    }
    // A fresh answer means MusicBrainz is up and is not refusing, so both runs of failures end, and the
    // failures before it were each their own item's. An answer from the cache says nothing about MusicBrainz, so it ends neither.
    if (!result.cached) {
      unavailableInARow = 0;
      refusedInARow = 0;
      await chargeSuspects();
    }

    const known = context.kind === "artist" ? undefined : artistMbids.get(artistKey(context.artist ?? ""));
    const decision = decide(result.candidates, context, known);
    const ended = await settleWith(item, settlementOf(decision));
    if (ended === "resolved" && decision.state === "resolved") {
      if (context.kind === "artist") artistMbids.set(context.key, decision.mbid);
      if (context.kind === "track") {
        const settledArtists = await settleArtistFromCredit(context, decision.credits);
        counts.resolved += settledArtists;
      }
    }
    return ended;
  }

  /**
   * Charges each item that failed since the last fresh answer: one attempt, and for a refused item that has now been
   * refused RESOLVE_MAX_ATTEMPTS times, a settlement as unresolved `bad_query`. Moves the item out of `pending`
   * when that settles it or makes it exhausted.
   */
  async function chargeSuspects(): Promise<void> {
    const charged = suspects;
    suspects = [];
    for (const { item, refused } of charged) {
      if (refused && item.attempts + 1 >= RESOLVE_MAX_ATTEMPTS) {
        counts.pending -= 1;
        if (await settle(client, item, { state: "unresolved", reason: "bad_query", score: null, name: null })) counts.unresolved += 1;
        else counts.skipped += 1; // another run settled it first
        continue;
      }
      await recordAttempt(client, item);
      if (item.attempts + 1 >= RESOLVE_MAX_ATTEMPTS) {
        counts.pending -= 1;
        counts.exhausted += 1;
      }
    }
  }

  async function settleWith(item: StoredItem, settlement: Settlement): Promise<"resolved" | "unresolved" | "gone"> {
    if (!(await settle(client, item, settlement))) return "gone";
    return settlement.state;
  }

  /**
   * A matched track names its artists. When its primary artist is the artist the plays name for this track,
   * the artist row settles from the credit, with no search of its own, no score, and the reason `credit`.
   * Returns how many rows settled.
   */
  async function settleArtistFromCredit(track: Context, credits: Candidate["credits"]): Promise<number> {
    const entry = pendingArtists.get(artistKey(track.artist ?? ""));
    if (!entry || entry.context.name === "" || settledHere.has(entry.item.id)) return 0;
    const credit = primaryCredits({ credits }).find((each) => artistKey(each.name) === entry.context.key);
    if (!credit) return 0;

    settledHere.add(entry.item.id);
    const ended = await settleWith(entry.item, { state: "resolved", mbid: credit.mbid, score: null, name: credit.name, reason: "credit" });
    if (ended !== "resolved") {
      // Another run settled the artist first. It was counted in `total`, and the loop will not reach it, so it is counted here.
      counts.skipped += 1;
      return 0;
    }
    artistMbids.set(entry.context.key, credit.mbid);
    return 1;
  }

  /** Why an item is not worth a request, or undefined when it is. */
  function unsearchableReason(context: Context): "empty_name" | "name_too_long" | "no_artist" | undefined {
    if (context.name === "") return "empty_name";
    if (tooLong(context.name) || (context.kind !== "artist" && tooLong(context.artist))) return "name_too_long";
    // A title alone matches too many other songs and albums, so a missing artist is never searched.
    if (context.kind !== "artist" && !context.artist) return "no_artist";
    return undefined;
  }

  async function search(context: Context): Promise<SearchResult> {
    const { entity, list, nameKey } = SEARCH[context.kind];
    const parse = (body: unknown): Candidate[] => parseCandidates(body, list, nameKey);
    const ask = (query: string): Promise<SearchResult> => musicbrainz.search(entity as SearchEntity, query, parse);

    if (context.kind === "artist") return ask(artistQuery(context));
    if (context.kind === "album") return ask(albumQuery(context));

    // An album name too long to send is left out of the question, as a blank one is.
    const asked: Context = tooLong(context.album) ? { ...context, album: undefined } : context;
    const first = await ask(trackQuery(asked));
    // The album is asked for as an exact phrase, and a release can carry a slightly different title (an edition, a
    // reissue). When no recording matched that phrase at all, ask once more without it.
    if (first.outcome === "ok" && first.candidates.length === 0 && asked.album) return ask(trackQuery(asked, { withAlbum: false }));
    return first;
  }
}

/** What an item is settled as, for a decision about its search. */
function settlementOf(decision: Decision): Settlement {
  if (decision.state === "resolved") return { state: "resolved", mbid: decision.mbid, score: decision.score, name: decision.name };
  return { state: "unresolved", reason: decision.reason, score: decision.score, name: decision.name };
}
