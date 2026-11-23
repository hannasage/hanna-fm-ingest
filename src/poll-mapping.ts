import { parseTimestamp, storableText } from "./parse.ts";
import { FUTURE_TOLERANCE_SECONDS, MAX_TEXT_CHARS } from "./settings.ts";
import type { PlayRow } from "./store.ts";

/**
 * The one place that turns an item of Spotify's recently-played answer into a stored play.
 * Nothing else reads the answer's keys.
 */

export const POLL_SKIP_REASONS = ["no_track", "malformed"] as const;
export type PollSkipReason = (typeof POLL_SKIP_REASONS)[number];

export type Mapped =
  | {
      play: PlayRow;
      /** Spotify's track length in milliseconds, or null when it sent none. It is not stored. */
      durationMs: number | null;
    }
  | { skipped: PollSkipReason };

const TRACK_URI_PREFIX = "spotify:track:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text the database can store, with something in it, and not longer than MAX_TEXT_CHARS. */
function filled(value: unknown): value is string {
  return storableText(value) && value.trim() !== "" && value.length <= MAX_TEXT_CHARS;
}

/** A play time cut down to whole seconds, as the table stores it. `playedAt` is an ISO time. */
export function toEndedAt(playedAt: string): string {
  return new Date(Math.floor(Date.parse(playedAt) / 1000) * 1000).toISOString();
}

/** A stored end time as the Unix milliseconds Spotify's `after` takes, or null when it is not a time. */
export function endedAtToCursorMs(endedAt: string): number | null {
  const time = Date.parse(endedAt);
  return Number.isNaN(time) ? null : time;
}

/** An item's `played_at` in Unix milliseconds, or null when it holds none that can be read. */
export function playedAtMs(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const playedAt = parseTimestamp(raw.played_at);
  return playedAt === null ? null : Date.parse(playedAt);
}

/**
 * Item shape: { track: { uri, name, type, is_local, duration_ms, artists: [{ name }], album: { name } }, played_at }.
 * - A local file (`is_local` is true) or an episode (`type` is "episode"): skipped as no_track. Only these two.
 * - Anything else that is not a readable track is skipped as malformed: a missing or renamed `track`
 *   object, a missing `type`, a missing or bad `uri`, a missing or odd field, a name over MAX_TEXT_CHARS,
 *   or a played_at more than FUTURE_TOLERANCE_SECONDS after `nowMs`. A renamed field must be loud, so it
 *   never reads as a local file.
 * - The artist is the track's first listed artist. The export holds the album artist, which can differ.
 *   Ticket 7 compares them with real data.
 */
export function mapItem(raw: unknown, nowMs: number): Mapped {
  if (!isRecord(raw)) return { skipped: "malformed" };
  const track = raw.track;
  if (!isRecord(track)) return { skipped: "malformed" };

  if (track.is_local === true || track.type === "episode") return { skipped: "no_track" };

  const uri = track.uri;
  if (
    track.type !== "track" ||
    typeof uri !== "string" ||
    !uri.startsWith(TRACK_URI_PREFIX) ||
    uri.length === TRACK_URI_PREFIX.length
  ) {
    return { skipped: "malformed" };
  }

  const artists = Array.isArray(track.artists) ? track.artists : [];
  const firstArtist: unknown = artists[0];
  const artistName = isRecord(firstArtist) ? firstArtist.name : undefined;
  const album = track.album;
  const albumName = isRecord(album) ? album.name : undefined;

  // played_at is stored as ended_at, cut to whole seconds. It is not yet known whether Spotify's
  // played_at marks the start or the end of a play. Ticket 7 measures this with real data.
  const playedAt = parseTimestamp(raw.played_at);

  if (
    !filled(uri) ||
    !filled(track.name) ||
    !filled(artistName) ||
    playedAt === null ||
    Date.parse(playedAt) > nowMs + FUTURE_TOLERANCE_SECONDS * 1000 ||
    (albumName !== undefined && albumName !== null && !(storableText(albumName) && albumName.length <= MAX_TEXT_CHARS))
  ) {
    return { skipped: "malformed" };
  }

  const duration = track.duration_ms;
  return {
    play: {
      track_uri: uri,
      track_name: track.name,
      artist_name: artistName,
      // An empty album name (a takedown) is stored as no album.
      album_name: typeof albumName === "string" && albumName.trim() !== "" ? albumName : null,
      ended_at: toEndedAt(playedAt),
      ms_played: null,
      source: "poll",
    },
    durationMs: typeof duration === "number" && Number.isInteger(duration) && duration >= 0 ? duration : null,
  };
}
