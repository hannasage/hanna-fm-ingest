import { UserError } from "./files.ts";
import { escapePhrase } from "./names.ts";
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

/** The top hit of a search, as MusicBrainz reported it. */
export type Candidate = {
  mbid: string;
  /** MusicBrainz's own score, 0 to 100. */
  score: number;
  name: string;
  /** The artists credited on a recording. Empty for other kinds. */
  credits: { mbid: string; name: string }[];
};

export type Decision =
  | { state: "resolved"; mbid: string; score: number; name: string }
  | { state: "unresolved"; reason: "no_match"; score: null; name: null }
  | { state: "unresolved"; reason: "below_threshold"; score: number; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const phrase = (field: string, value: string): string => `${field}:"${escapePhrase(value)}"`;

/** Lucene query for a track. An empty artist or album is left out, never searched as empty text. */
export function trackQuery(context: Context): string {
  const parts = [phrase("recording", context.name)];
  if (context.artist) parts.push(phrase("artistname", context.artist));
  if (context.album) parts.push(phrase("release", context.album));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the top hit from a search answer. `list` is the answer's list name (recordings,
 * release-groups, artists) and `nameKey` is the key holding a hit's name (title or name).
 * An empty list is no match and returns null. A malformed answer throws.
 */
export function parseCandidate(body: unknown, list: string, nameKey: "title" | "name"): Candidate | null {
  if (!isRecord(body)) throw new UserError(WRONG_SHAPE);
  const hits = body[list];
  if (!Array.isArray(hits)) throw new UserError(WRONG_SHAPE);
  if (hits.length === 0) return null;

  const hit: unknown = hits[0];
  if (!isRecord(hit)) throw new UserError(WRONG_SHAPE);
  const { id } = hit;
  const name = hit[nameKey];
  const score = typeof hit.score === "string" && hit.score.trim() !== "" ? Number(hit.score) : hit.score;
  if (typeof id !== "string" || !UUID.test(id)) throw new UserError(WRONG_SHAPE);
  if (typeof name !== "string") throw new UserError(WRONG_SHAPE);
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) throw new UserError(WRONG_SHAPE);

  const credits: Candidate["credits"] = [];
  const credit = hit["artist-credit"];
  if (Array.isArray(credit)) {
    for (const entry of credit as unknown[]) {
      const artist = isRecord(entry) ? entry.artist : undefined;
      if (isRecord(artist) && typeof artist.id === "string" && UUID.test(artist.id) && typeof artist.name === "string") {
        credits.push({ mbid: artist.id.toLowerCase(), name: artist.name });
      }
    }
  }
  return { mbid: id.toLowerCase(), score: Math.round(score), name, credits };
}

/** Accept the top hit only when its score meets MATCH_MIN_SCORE. */
export function decide(candidate: Candidate | null): Decision {
  if (candidate === null) return { state: "unresolved", reason: "no_match", score: null, name: null };
  if (candidate.score < MATCH_MIN_SCORE) {
    return { state: "unresolved", reason: "below_threshold", score: candidate.score, name: candidate.name };
  }
  return { state: "resolved", mbid: candidate.mbid, score: candidate.score, name: candidate.name };
}
