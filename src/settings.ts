/** Named settings. Each has one home here, so a change is one edit. */

/** A play shorter than this many milliseconds is dropped as too_short. */
export const MIN_PLAY_MS = 30_000;

/** The largest export file the command will read: 500 MB. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** How many plays go to the database in one request. */
export const BATCH_SIZE = 500;

/**
 * A MusicBrainz match counts only when MusicBrainz's own score, 0 to 100, is at least this.
 * A lower score leaves the item unresolved. The score and the matched name are stored either way.
 */
export const MATCH_MIN_SCORE = 90;

/** Where MusicBrainz lookups go unless MB_API_BASE says otherwise (tests only). */
export const DEFAULT_MB_API_BASE = "https://musicbrainz.org/ws/2";

/**
 * The least time between one MusicBrainz request ending and the next one starting.
 * MusicBrainz allows one request a second, so this is the whole guarantee.
 */
export const MB_MIN_INTERVAL_MS = 1000;

/** Tries per lookup when MusicBrainz is busy or down (503, 429, other server errors, no answer). */
export const MB_MAX_ATTEMPTS = 3;

/** Wait after the first failed try. It doubles after each one. A Retry-After header can lengthen it. */
export const MB_BACKOFF_BASE_MS = 1000;

/** The longest Retry-After wait the command accepts. A longer one is cut to this. */
export const MB_RETRY_AFTER_MAX_MS = 30_000;

/** How long one MusicBrainz request may take before it counts as no answer. */
export const MB_REQUEST_TIMEOUT_MS = 30_000;

/** Rows read from the database in one request. The API returns at most 1000 a request. */
export const PAGE_SIZE = 1000;
