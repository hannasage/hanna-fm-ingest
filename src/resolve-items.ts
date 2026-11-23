import type { SupabaseClient } from "@supabase/supabase-js";
import { insertPending, loadItems, settle, type StoredItem } from "./item-store.ts";
import {
  albumQuery,
  artistQuery,
  decide,
  parseCandidate,
  trackQuery,
  type Candidate,
  type Context,
  type Kind,
} from "./matching.ts";
import type { MusicBrainz } from "./musicbrainz.ts";
import { artistKey } from "./names.ts";
import { itemId, scanPlays } from "./scan-plays.ts";

export type ResolveCounts = {
  /** Item rows created this run. */
  new: number;
  /** Items settled this run with an MBID, or merged into the row that has it. */
  resolved: number;
  /** Items settled this run as unresolved: MusicBrainz cannot match them. */
  unresolved: number;
  /** Items this run tried and left pending, because MusicBrainz was unavailable. */
  pending: number;
  /** Requests sent to MusicBrainz, retries included. */
  requests: number;
  /** Searches answered from the cache. */
  cache_hits: number;
};

export function emptyResolveCounts(): ResolveCounts {
  return { new: 0, resolved: 0, unresolved: 0, pending: 0, requests: 0, cache_hits: 0 };
}

/** Counts only. No name from the plays and no response text ever goes in this report. */
export function formatResolveReport(counts: ResolveCounts, options: { partial?: boolean } = {}): string {
  return [
    `new: ${counts.new}`,
    `resolved: ${counts.resolved}`,
    `unresolved: ${counts.unresolved}`,
    `pending: ${counts.pending}`,
    `requests: ${counts.requests}`,
    `cache_hits: ${counts.cache_hits}`,
    ...(options.partial ? ["partial: true"] : []),
    "",
  ].join("\n");
}

/** What to ask MusicBrainz for each kind, and how to read the answer. */
const SEARCH = {
  track: { entity: "recording", query: trackQuery, list: "recordings", nameKey: "title" },
  album: { entity: "release-group", query: albumQuery, list: "release-groups", nameKey: "title" },
  artist: { entity: "artist", query: artistQuery, list: "artists", nameKey: "name" },
} as const;

/** Tracks first, so their artist credits can settle artists before an artist search is needed. */
const ORDER: Kind[] = ["track", "album", "artist"];

/**
 * Finds the distinct tracks, artists and albums in the plays, stores a pending row for each that has none,
 * and settles every pending row: by MusicBrainz search, through the one rate-limited queue and the cache.
 *
 * Pending rows from an earlier run, where MusicBrainz was unavailable, are tried again.
 * An item MusicBrainz cannot match becomes unresolved. It is never dropped.
 */
export async function resolveItems(
  client: SupabaseClient,
  musicbrainz: MusicBrainz,
  counts: ResolveCounts = emptyResolveCounts(),
): Promise<ResolveCounts> {
  const contexts = await scanPlays(client);

  let stored = await loadItems(client);
  const known = new Set(stored.map((item) => itemId(item.kind, item.source_key)));
  const fresh = [...contexts.entries()].filter(([id]) => !known.has(id)).map(([, context]) => context);
  if (fresh.length > 0) {
    counts.new += await insertPending(client, fresh);
    stored = await loadItems(client);
  }

  const work = new Map<Kind, { item: StoredItem; context: Context }[]>(ORDER.map((kind) => [kind, []]));
  for (const item of stored) {
    const context = contexts.get(itemId(item.kind, item.source_key));
    if (item.state === "pending" && context) work.get(item.kind)?.push({ item, context });
  }
  const pendingArtists = new Map(work.get("artist")?.map((entry) => [entry.context.key, entry]));
  const settledHere = new Set<number>();

  for (const kind of ORDER) {
    for (const { item, context } of work.get(kind) ?? []) {
      if (settledHere.has(item.id)) continue;

      if (context.name === "") {
        if (await settle(client, item, { state: "unresolved", reason: "empty_name", score: null, name: null })) counts.unresolved += 1;
        continue;
      }

      const search = SEARCH[kind];
      const result = await musicbrainz.search(search.entity, search.query(context), (body) =>
        parseCandidate(body, search.list, search.nameKey),
      );
      if (result.outcome === "unavailable") {
        counts.pending += 1;
        continue;
      }

      const decision = decide(result.value);
      const settled = await settle(client, item, decision);
      if (!settled) continue;
      if (decision.state === "resolved") counts.resolved += 1;
      else counts.unresolved += 1;

      if (kind === "track" && decision.state === "resolved" && result.value) {
        counts.resolved += await settleArtistFromCredit(client, context, result.value, pendingArtists, settledHere);
      }
    }
  }
  return counts;
}

/**
 * A matched track names its artists. When one of them is the artist the plays name for this track,
 * the artist row settles from the credit, with no search of its own. Returns how many rows settled.
 */
async function settleArtistFromCredit(
  client: SupabaseClient,
  track: Context,
  candidate: Candidate,
  pendingArtists: Map<string, { item: StoredItem; context: Context }>,
  settledHere: Set<number>,
): Promise<number> {
  const entry = pendingArtists.get(artistKey(track.artist ?? ""));
  if (!entry || entry.context.name === "" || settledHere.has(entry.item.id)) return 0;
  const credit = candidate.credits.find((each) => artistKey(each.name) === entry.context.key);
  if (!credit) return 0;

  settledHere.add(entry.item.id);
  const settled = await settle(client, entry.item, { state: "resolved", mbid: credit.mbid, score: candidate.score, name: credit.name });
  return settled ? 1 : 0;
}
