import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** An error whose message is safe to show: it never holds file content or a secret. */
export class UserError extends Error {}

/** Lists the export files at a path: the file itself, or the .json files in a directory. */
export function exportFiles(path: string): string[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new UserError("The path was not found.");
  }
  if (!stat.isDirectory()) return [path];

  const files = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(path, entry.name))
    .sort();
  if (files.length === 0) throw new UserError("The directory holds no .json files.");
  return files;
}

/** Reads every file and returns its rows. Throws before returning anything if one file is bad. */
export function readRows(files: string[]): unknown[] {
  const rows: unknown[] = [];
  for (const file of files) {
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
    for (const row of parsed) rows.push(row);
  }
  return rows;
}
