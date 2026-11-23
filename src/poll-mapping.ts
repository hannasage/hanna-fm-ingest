import { parseTimestamp, storableText } from "./parse.ts";
import type { PlayRow } from "./store.ts";

/**
 * The one place that turns an item of Spotify's recently-played answer into a stored play.
 * Nothing else reads the answer's keys.
 */

export const POLL_SKIP_REASONS = ["no_track", "malformed"] as const;
export type PollSkipReason = (typeof POLL_SKIP_REASONS)[number];

export type Mapped = { play: PlayRow } | { skipped: PollSkipReason };

const TRACK_URI_PREFIX = "spotify:track:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text the database can store, with something in it. */
function filled(value: unknown): value is string {
  return storableText(value) && value.trim() !== "";
}

/**
 * Item shape: { track: { uri, name, type, is_local, artists: [{ name }], album: { name } }, played_at }.
 * - Not a track (a local file, an episode, a missing track, a URI that is not a track URI): skipped as no_track.
 * - A missing or odd field on a track: skipped as malformed.
 * - The artist is the track's first listed artist. The export holds the album artist, which can differ.
 *   Ticket 7 compares them with real data.
 */
export function mapItem(raw: unknown): Mapped {
  if (!isRecord(raw)) return { skipped: "malformed" };
  const track = raw.track;
  if (!isRecord(track)) return { skipped: "no_track" };

  const uri = track.uri;
  if (
    track.is_local === true ||
    track.type !== "track" ||
    typeof uri !== "string" ||
    !uri.startsWith(TRACK_URI_PREFIX) ||
    uri.length === TRACK_URI_PREFIX.length
  ) {
    return { skipped: "no_track" };
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
    (albumName !== undefined && albumName !== null && !storableText(albumName))
  ) {
    return { skipped: "malformed" };
  }

  return {
    play: {
      track_uri: uri,
      track_name: track.name,
      artist_name: artistName,
      // An empty album name (a takedown) is stored as no album.
      album_name: typeof albumName === "string" && albumName.trim() !== "" ? albumName : null,
      ended_at: new Date(Math.floor(Date.parse(playedAt) / 1000) * 1000).toISOString(),
      ms_played: null,
      source: "poll",
    },
  };
}
