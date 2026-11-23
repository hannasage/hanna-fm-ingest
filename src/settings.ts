/** Named settings. Each has one home here, so a change is one edit. */

/** A play shorter than this many milliseconds is dropped as too_short. */
export const MIN_PLAY_MS = 30_000;

/** The largest export file the command will read: 500 MB. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** How many plays go to the database in one request. */
export const BATCH_SIZE = 500;
