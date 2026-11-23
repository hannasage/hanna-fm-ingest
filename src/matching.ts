import { UserError } from "./files.ts";
import { artistKey, escapePhrase, normalizeName, stripNul } from "./names.ts";
import { MATCH_MIN_SCORE } from "./settings.ts";

export type Kind = "artist" | "album" | "track";

/** One item as the plays show it. `key` is its identity: see names.ts. */
export type Context = {
  kind: Kind;
  key: string;
  name: string;
  /** The Spotify track URI. Tracks only. */
  uri?: string;
  /** The artist name as played. Tracks and albums. May be empty. */
  artist?: string;
  /** The album name as played. Tracks only. Absent when the play has none. */
  album?: string;
};

/** One hit of a search, as MusicBrainz reported it. */
export type Candidate = {
  mbid: string;
  /** MusicBrainz's own score, 0 to 100, exactly as sent. It is never rounded before it is compared. */
  score: number;
  name: string;
  /** The aliases the hit came with, as text. Only an artist hit carries any. */
  aliases: string[];
  /**
   * The artists credited on a recording or release group, in MusicBrainz's order, under each name they carry.
   * The first one is the primary artist. Empty for an artist hit, and for a hit whose first credit could not be read.
   */
  credits: { mbid: string; name: string }[];
};

export type Decision =
  | { state: "resolved"; mbid: string; score: number; name: string; credits: Candidate["credits"] }
  | { state: "unresolved"; reason: "no_match"; score: number | null; name: string | null }
  | { state: "unresolved"; reason: "below_threshold" | "ambiguous"; score: number; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const phrase = (field: string, value: string): string => `${field}:"${escapePhrase(value)}"`;

/**
 * Lucene query for a track. An empty artist or album is left out, never searched as empty text.
 * `withAlbum: false` leaves the album out too, for the retry when no recording matched the exact album phrase.
 */
export function trackQuery(context: Context, options: { withAlbum?: boolean } = {}): string {
  const parts = [phrase("recording", context.name)];
  if (context.artist) parts.push(phrase("artistname", context.artist));
  if (context.album && options.withAlbum !== false) parts.push(phrase("release", context.album));
  return parts.join(" AND ");
}

export function albumQuery(context: Context): string {
  const parts = [phrase("releasegroup", context.name)];
  if (context.artist) parts.push(phrase("artistname", context.artist));
  return parts.join(" AND ");
}

export function artistQuery(context: Context): string {
  return phrase("artist", context.name);
}

const WRONG_SHAPE = "MusicBrainz sent an answer in a shape this command does not know. Nothing was stored for it.";
const WRONG_CACHE = "A cached MusicBrainz answer is not in the shape this command stores.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The most hits read from one answer. MusicBrainz is asked for fewer, so a longer list is read no further. */
const MAX_HITS = 100;

/** The most aliases kept for one hit, so a cached answer stays small. */
const MAX_ALIASES = 100;

/**
 * Reads every hit from a search answer. `list` is the answer's list name (recordings, release-groups,
 * artists) and `nameKey` is the key holding a hit's name (title or name). An empty list is no hit.
 * A malformed answer throws.
 *
 * An artist credit is `{ artist: { id, name } }`, as on the MusicBrainz search page, and the first one is the
 * primary artist. A credit may also carry the name it was credited under, and then that name counts as well.
 * An artist hit's `aliases` is a list of `{ name, ... }`, as on that page. NUL characters are stripped from every name.
 */
export function parseCandidates(body: unknown, list: string, nameKey: "title" | "name"): Candidate[] {
  if (!isRecord(body)) throw new UserError(WRONG_SHAPE);
  const hits = body[list];
  if (!Array.isArray(hits)) throw new UserError(WRONG_SHAPE);

  return hits.slice(0, MAX_HITS).map((hit: unknown): Candidate => {
    if (!isRecord(hit)) throw new UserError(WRONG_SHAPE);
    const { id } = hit;
    const name = hit[nameKey];
    const score = typeof hit.score === "string" && hit.score.trim() !== "" ? Number(hit.score) : hit.score;
    if (typeof id !== "string" || !UUID.test(id)) throw new UserError(WRONG_SHAPE);
    if (typeof name !== "string") throw new UserError(WRONG_SHAPE);
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) throw new UserError(WRONG_SHAPE);

    const aliases: string[] = [];
    if (Array.isArray(hit.aliases)) {
      for (const alias of (hit.aliases as unknown[]).slice(0, MAX_ALIASES)) {
        if (isRecord(alias) && typeof alias.name === "string") aliases.push(stripNul(alias.name));
      }
    }

    const credits: Candidate["credits"] = [];
    const credit = hit["artist-credit"];
    if (Array.isArray(credit)) {
      for (const [index, entry] of (credit as unknown[]).entries()) {
        const artist = isRecord(entry) ? entry.artist : undefined;
        if (!isRecord(artist) || typeof artist.id !== "string" || !UUID.test(artist.id) || typeof artist.name !== "string") {
          // A credit that cannot be read is skipped. When it is the first, nobody can say who the primary artist is.
          if (index === 0) break;
          continue;
        }
        const mbid = artist.id.toLowerCase();
        credits.push({ mbid, name: stripNul(artist.name) });
        const credited = (entry as Record<string, unknown>).name;
        if (typeof credited === "string" && credited !== artist.name) credits.push({ mbid, name: stripNul(credited) });
      }
    }
    return { mbid: id.toLowerCase(), score, name: stripNul(name), aliases, credits };
  });
}

/** Checks a cached answer, which is a list of candidates as parseCandidates made them. Throws when it is not. */
export function readCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) throw new UserError(WRONG_CACHE);
  return value.map((hit: unknown): Candidate => {
    if (!isRecord(hit) || typeof hit.mbid !== "string" || !UUID.test(hit.mbid)) throw new UserError(WRONG_CACHE);
    const { score, name, credits, aliases } = hit;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) throw new UserError(WRONG_CACHE);
    if (typeof name !== "string" || !Array.isArray(credits)) throw new UserError(WRONG_CACHE);
    // A row cached before aliases were kept has none, so it is read as the wrong shape and fetched again.
    if (!Array.isArray(aliases) || !(aliases as unknown[]).every((alias) => typeof alias === "string")) throw new UserError(WRONG_CACHE);
    const read = (credits as unknown[]).map((credit) => {
      if (!isRecord(credit) || typeof credit.mbid !== "string" || !UUID.test(credit.mbid) || typeof credit.name !== "string") {
        throw new UserError(WRONG_CACHE);
      }
      return { mbid: credit.mbid, name: credit.name };
    });
    return { mbid: hit.mbid, score, name, aliases: aliases as string[], credits: read };
  });
}

/**
 * The credits that belong to the primary (first) artist of a hit, under every name that artist carries.
 * A guest or featured artist is not among them.
 */
export function primaryCredits(hit: Pick<Candidate, "credits">): Candidate["credits"] {
  const first = hit.credits[0];
  return first === undefined ? [] : hit.credits.filter((credit) => credit.mbid === first.mbid);
}

/**
 * Chooses among the hits of one search.
 *
 * A hit is taken into account only when it names what was played:
 * - An artist hit: its name, or one of the aliases it came with, equals the artist played, both normalized as a source key is.
 * - A track or album hit: its title equals the title played, normalized the same way. And when the play names an
 *   artist, the hit's primary (first) artist credit, under any name it carries, names that artist, or is the artist
 *   already matched (`knownArtistMbid`). A match only on a featured credit does not count.
 * - Of the hits left, those whose raw score is at least MATCH_MIN_SCORE count. When two different MusicBrainz
 *   IDs count, the match is `ambiguous` and nothing is settled. A search can find the same name twice.
 * - Otherwise the best hit left is `below_threshold`. When no hit is left, it is `no_match`, and the score and
 *   name of the best hit that was refused are kept, so a wrong match can be audited.
 */
export function decide(candidates: Candidate[], context: Context, knownArtistMbid?: string): Decision {
  const best = (hits: Candidate[]): Candidate | undefined => hits.reduce<Candidate | undefined>((top, hit) => (top === undefined || hit.score > top.score ? hit : top), undefined);

  const wantedName = normalizeName(context.name);
  const checksArtist = context.kind !== "artist" && Boolean(context.artist);
  const wantedArtist = artistKey(context.artist ?? "");
  const fits = (hit: Candidate): boolean => {
    if (context.kind === "artist") return [hit.name, ...hit.aliases].some((each) => normalizeName(each) === wantedName);
    if (normalizeName(hit.name) !== wantedName) return false;
    if (!checksArtist) return true;
    return primaryCredits(hit).some((credit) => credit.mbid === knownArtistMbid || artistKey(credit.name) === wantedArtist);
  };

  const acceptable = candidates.filter(fits);
  const counting = acceptable.filter((hit) => hit.score >= MATCH_MIN_SCORE);
  const top = best(counting);
  if (top !== undefined) {
    if (new Set(counting.map((hit) => hit.mbid)).size > 1) {
      return { state: "unresolved", reason: "ambiguous", score: top.score, name: top.name };
    }
    return { state: "resolved", mbid: top.mbid, score: top.score, name: top.name, credits: top.credits };
  }
  const near = best(acceptable);
  if (near !== undefined) return { state: "unresolved", reason: "below_threshold", score: near.score, name: near.name };
  const refused = best(candidates);
  return { state: "unresolved", reason: "no_match", score: refused?.score ?? null, name: refused?.name ?? null };
}
