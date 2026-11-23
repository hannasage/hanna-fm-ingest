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

/**
 * The longest Retry-After wait the command accepts: five minutes. A longer one is cut to this.
 * The wait applies to the whole queue, so the next lookup waits too. The run's lock lease is far longer.
 */
export const MB_RETRY_AFTER_MAX_MS = 5 * 60 * 1000;

/** How long one MusicBrainz request may take before it counts as no answer. */
export const MB_REQUEST_TIMEOUT_MS = 30_000;

/** Rows read from the database in one request. The API returns at most 1000 a request. */
export const PAGE_SIZE = 1000;

/** Hits asked of MusicBrainz for each search. More than one, so a second hit with the same score shows the match is not clear. */
export const MB_MATCH_FETCH_LIMIT = 5;

/** The most bytes read from one MusicBrainz answer: 1 MB. A larger answer stops the run. */
export const MB_MAX_RESPONSE_BYTES = 1024 * 1024;

/** A cached answer older than this, measured from its fetched_at, is fetched again: 90 days. */
export const MB_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** A name longer than this many characters is not searched: it is unresolved with reason name_too_long. */
export const MB_MAX_NAME_LENGTH = 200;

/** The run stops, with exit 1, after this many lookups in a row that MusicBrainz could not answer. */
export const RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE = 5;

/**
 * The run stops, with exit 1, after this many lookups in a row that MusicBrainz refused (a 4xx other than 401 and 403).
 * One refused lookup is that item's problem. Many in a row mean the address or the request is wrong.
 */
export const RESOLVE_MAX_CONSECUTIVE_REFUSED = 5;

/** An item that has been left pending this many times is skipped, unless the run is given --retry-failed. */
export const RESOLVE_MAX_ATTEMPTS = 5;

/** A progress line goes to stderr after every this many items. */
export const RESOLVE_PROGRESS_EVERY = 25;

/** The name of the lock that keeps resolve-items to one run at a time. */
export const RESOLVE_LOCK_NAME = "resolve-items";

/** How long a run holds the lock before it must refresh it: 30 minutes. A run that dies frees it by running out. */
export const RESOLVE_LOCK_LEASE_MS = 30 * 60 * 1000;
