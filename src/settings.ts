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

/** The most pages one poll reads. A page holds up to POLL_LIMIT plays. Reaching this is a failure, not a quiet stop. */
export const POLL_MAX_PAGES = 20;

/** The most bytes the poll reads from one Spotify response: 1 MB. A larger one is refused. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The most characters a track, artist or album name may hold. A longer one makes the item malformed. */
export const MAX_TEXT_CHARS = 500;

/** A play stamped more than this many seconds ahead of the clock is malformed. */
export const FUTURE_TOLERANCE_SECONDS = 60;

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
 * The longest Retry-After wait the command accepts: 120 seconds. A longer one is cut to this.
 * The wait applies to the whole queue, so the next lookup waits too. The run refreshes its lock lease before every
 * try, and the lease (RESOLVE_LOCK_LEASE_MS) is far longer than this wait and a request together, so one item
 * can never outlive it.
 */
export const MB_RETRY_AFTER_MAX_MS = 120 * 1000;

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

/** A poll run record older than this many days is deleted at the end of a run. */
export const POLLER_RUNS_KEEP_DAYS = 90;

/**
 * The run that sees the Spotify login this many days old, or older, prints a warning.
 * The refresh token lasts about six months, so 150 days leaves a month to renew it.
 */
export const LOGIN_WARN_DAYS = 150;

/** The age, in days, at which the Spotify login is taken to expire. The warning names it. */
export const LOGIN_EXPIRY_DAYS = 180;

/**
 * When the runner's clock is more than this many milliseconds behind the newest run record, the delete of old
 * records is skipped: a clock that is wrong would put the cutoff in the wrong place. 5 minutes.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** How long the poll waits for the database when it records a run or deletes old records. A stuck call must not hold the run open. */
export const RECORD_TIMEOUT_MS = 10_000;

/** The keys `set-state` may write to the poller_state table. Add a key here to allow it. */
export const ALLOWED_STATE_KEYS = ["spotify_authorized_at"] as const;
