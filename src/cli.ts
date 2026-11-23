import { createClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import { importExport } from "./import-export.ts";
import { emptyCounts, formatReport } from "./report.ts";

const USAGE = "Usage: import-export <path>\n  path: a Spotify Extended Streaming History .json file, or a directory of them.";

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  const [command, path, ...extra] = argv;
  if (command !== "import-export") fail(USAGE, 2);
  if (!path || extra.length > 0) fail(`A path is required, and only one.\n${USAGE}`, 2);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url) fail("SUPABASE_URL is not set.", 2);
  if (!key) fail("SUPABASE_SECRET_KEY is not set.", 2);

  let client;
  try {
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch {
    // The library's message can quote the address. Say only which variable.
    fail("SUPABASE_URL is not a valid address.", 2);
  }

  const counts = emptyCounts();
  try {
    await importExport(client, path, counts);
  } catch (error) {
    if (counts.read > 0) process.stdout.write(`${formatReport(counts)}\n`);
    if (error instanceof UserError) fail(error.message, 1);
    // Any other failure: say what kind, never its text, which could hold a row or a key.
    const kind = error instanceof Error ? error.name : "unknown";
    fail(`The import stopped on an unexpected ${kind} error. No details are shown, so no data leaks.`, 1);
  }
  process.stdout.write(formatReport(counts));
}

await main(process.argv.slice(2));
