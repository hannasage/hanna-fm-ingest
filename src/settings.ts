/** Named settings. Each has one home here, so a change is one edit. */

/** A play shorter than this many milliseconds is dropped as too_short. */
export const MIN_PLAY_MS = 30_000;

/** The largest export file the command will read: 500 MB. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** How many plays go to the database in one request. */
export const BATCH_SIZE = 500;

/**
 * A poll play counts as one already stored when the same track has a stored end time within
 * this many seconds of it, either side (the edge counts). This is in addition to the table's
 * exact-match key. Ticket 7 measures the right window with real data.
 */
export const DEDUPE_WINDOW_SECONDS = 10;

/** How many plays one poll asks Spotify for. 50 is the most the endpoint gives. */
export const POLL_LIMIT = 50;

/** How long one Spotify request may take before the poll gives up. */
export const SPOTIFY_TIMEOUT_MS = 30_000;

/** Where Spotify's token and API calls go, unless a test points the poll elsewhere. */
export const DEFAULT_SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
export const DEFAULT_SPOTIFY_API_BASE = "https://api.spotify.com/v1";
