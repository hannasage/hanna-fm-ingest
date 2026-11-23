import type { SupabaseClient } from "@supabase/supabase-js";
import { exportFiles, readRows } from "./files.ts";
import { classifyRow, type Play } from "./parse.ts";
import { emptyCounts, type Counts } from "./report.ts";
import { storePlays } from "./store.ts";

/**
 * Reads an export (one file, or a directory of files), drops what must not be stored,
 * and inserts the rest. Files are all read and checked before the first write.
 * `counts` is filled in as the run goes, so a caller can report it after a failure.
 */
export async function importExport(
  client: SupabaseClient,
  path: string,
  counts: Counts = emptyCounts(),
): Promise<Counts> {
  const rows = readRows(exportFiles(path));
  counts.read = rows.length;

  const plays: Play[] = [];
  for (const row of rows) {
    const result = classifyRow(row);
    if ("play" in result) plays.push(result.play);
    else counts.dropped[result.dropped] += 1;
  }

  await storePlays(client, plays, (inserted) => {
    counts.imported += inserted;
  });
  counts.duplicate = plays.length - counts.imported;
  return counts;
}
