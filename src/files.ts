import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { COLUMN_KEYS, SIGNAL_KEYS } from "./mapping.ts";
import { MAX_FILE_BYTES } from "./settings.ts";

/**
 * Why a poll run failed, as a fixed word. It is stored with the run record, so it holds no secret and no data.
 * - spotify_unavailable: Spotify answered 5xx, or a status the poller does not expect.
 * - database_error: the database refused a read or a write, or answered with nothing the poll can read.
 * - stalled: the page walk could not go back to an older page.
 * - bug: an exception the poller did not plan for. Its text is never stored.
 * - other: a last resort, for a planned stop that names no kind.
 */
export type FailureKind =
  | "login_expired"
  | "forbidden"
  | "rate_limited"
  | "bad_response"
  | "network"
  | "future_cursor"
  | "malformed_items"
  | "page_cap"
  | "spotify_unavailable"
  | "database_error"
  | "stalled"
  | "bug"
  | "other";

/**
 * An error whose message is safe to show: it never holds file content or a secret.
 * A failure of the poll may also name its kind, for the run record.
 */
export class UserError extends Error {
  readonly kind: FailureKind | undefined;

  constructor(message: string, kind?: FailureKind) {
    super(message);
    this.kind = kind;
  }
}

/** Every key the importer reads, for the check that a file uses the mapped names. */
const MAPPED_KEYS: string[] = [...Object.values(COLUMN_KEYS), ...Object.values(SIGNAL_KEYS)];

/** Rejects anything that is not a regular file, or is over the size cap. Reads no content. */
export function assertReadable(path: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new UserError("The path was not found.");
  }
  if (!stat.isFile()) throw new UserError("The path is not a regular file.");
  if (stat.size > MAX_FILE_BYTES) {
    throw new UserError(
      `${basename(path)} is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit.`,
    );
  }
}

/** Lists the export files at a path: the file itself, or the .json files in a directory. */
export function exportFiles(path: string): string[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new UserError("The path was not found.");
  }
  if (!stat.isDirectory()) {
    assertReadable(path);
    return [path];
  }

  const files = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(path, entry.name))
    .sort();
  if (files.length === 0) throw new UserError("The directory holds no .json files.");
  for (const file of files) assertReadable(file);
  return files;
}

/** Reads one file and returns its rows. Throws if it is not valid JSON or not a list. */
export function readRows(file: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // The parser's own message can quote the file. Say only which file.
    throw new UserError(`${basename(file)} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new UserError(`${basename(file)} is not a list of plays.`);
  }
  return parsed;
}

export type FileCheck = {
  /** How many rows the file holds. */
  rows: number;
  /** Mapped keys that no row of the file holds. */
  missingKeys: string[];
};

/**
 * The first pass over one file: checks it is valid and keeps only two facts about it.
 * The rows are dropped when this returns, so no run holds every file's rows at once.
 */
export function checkFile(file: string): FileCheck {
  const rows = readRows(file);
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    for (const key of MAPPED_KEYS) if (key in row) seen.add(key);
  }
  return { rows: rows.length, missingKeys: MAPPED_KEYS.filter((key) => !seen.has(key)) };
}
