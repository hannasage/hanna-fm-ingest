import { basename } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkFile, exportFiles, readRows, UserError } from "./files.ts";
import { classifyRow, type Play } from "./parse.ts";
import { emptyCounts, type Counts } from "./report.ts";
import { BATCH_SIZE } from "./settings.ts";
import { storeBatch } from "./store.ts";

/**
 * Reads an export (one file, or a directory of files), drops what must not be stored,
 * and inserts the rest.
 *
 * Two passes. The first checks every file and keeps only its row count, so a bad file fails
 * the whole run before anything is written. The second takes one file at a time: it reads the
 * file, classifies each row, and stores plays in batches. `counts` is updated after every
 * batch, so a caller can report it after a failure. `warn` gets one line per file whose
 * rows hold none of a mapped key. It never gets row content.
 */
export async function importExport(
  client: SupabaseClient,
  path: string,
  counts: Counts = emptyCounts(),
  warn: (line: string) => void = () => {},
): Promise<Counts> {
  const files = exportFiles(path);

  const expectedRows = new Map<string, number>();
  let total = 0;
  for (const file of files) {
    const { rows, missingKeys } = checkFile(file);
    expectedRows.set(file, rows);
    total += rows;
    if (rows > 0 && missingKeys.length > 0) {
      const names = missingKeys.map((key) => `"${key}"`).join(", ");
      const noun = missingKeys.length === 1 ? "key" : "keys";
      warn(`warning: ${basename(file)}: no row holds the mapped ${noun}: ${names}.`);
    }
  }
  counts.read = total;

  for (const file of files) await importFile(client, file, expectedRows.get(file) ?? 0, counts);
  return counts;
}

async function importFile(
  client: SupabaseClient,
  file: string,
  expected: number,
  counts: Counts,
): Promise<void> {
  const rows = readRows(file);
  if (rows.length !== expected) throw new UserError(`${basename(file)} changed while the import ran.`);

  let batch: Play[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const inserted = await storeBatch(client, batch);
    counts.imported += inserted;
    counts.duplicate += batch.length - inserted;
    batch = [];
  };

  for (const row of rows) {
    const result = classifyRow(row);
    if ("dropped" in result) {
      counts.dropped[result.dropped] += 1;
      continue;
    }
    batch.push(result.play);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
}
