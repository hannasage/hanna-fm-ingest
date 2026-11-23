import { createClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import { importExport } from "./import-export.ts";
import { emptyCounts, formatReport } from "./report.ts";

const USAGE = "Usage: import-export <path>\n  path: a Spotify Extended Streaming History .json file, or a directory of them.";

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** The key is sent over https, or to this computer. Never over plain http to another host. */
function checkAddress(address: string): void {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    // The parser's message can quote the address. Say only which variable.
    fail("SUPABASE_URL is not a valid address.", 2);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    fail("SUPABASE_URL must start with https://, unless the host is localhost or 127.0.0.1.", 2);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, path, ...extra] = argv;
  if (command !== "import-export") fail(USAGE, 2);
  if (!path || extra.length > 0) fail(`A path is required, and only one.\n${USAGE}`, 2);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url) fail("SUPABASE_URL is not set.", 2);
  if (!key) fail("SUPABASE_SECRET_KEY is not set.", 2);
  checkAddress(url);

  let client;
  try {
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch {
    fail("SUPABASE_URL is not a valid address.", 2);
  }

  const counts = emptyCounts();
  try {
    await importExport(client, path, counts, (line) => process.stderr.write(`${line}\n`));
  } catch (error) {
    // Say what went wrong, then the partial counts, on stderr. Nothing goes to stdout.
    // A failure that is not a UserError shows its kind and never its text, which could hold a row or a key.
    const kind = error instanceof Error ? error.name : "unknown";
    const message =
      error instanceof UserError
        ? error.message
        : `The import stopped on an unexpected ${kind} error. No details are shown, so no data leaks.`;
    process.stderr.write(`${message}\n`);
    if (counts.read > 0) process.stderr.write(formatReport(counts, { partial: true }));
    process.exit(1);
  }

  process.stdout.write(formatReport(counts));
  if (counts.read > 0 && counts.imported + counts.duplicate === 0) {
    fail(
      "Nothing was stored, and no play was a repeat. Either a key name in src/mapping.ts does not match the export, or every row was dropped. The counts above show which.",
      1,
    );
  }
}

await main(process.argv.slice(2));
