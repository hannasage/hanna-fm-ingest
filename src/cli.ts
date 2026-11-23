import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addressProblem } from "./address.ts";
import { UserError } from "./files.ts";
import { importExport } from "./import-export.ts";
import { MusicBrainz } from "./musicbrainz.ts";
import { emptyCounts, formatReport } from "./report.ts";
import { formatResolveReport, resolveItems, emptyResolveCounts } from "./resolve-items.ts";
import { DEFAULT_MB_API_BASE } from "./settings.ts";
import { SupabaseCache } from "./item-store.ts";

const IMPORT_USAGE =
  "Usage: import-export <path>\n  path: a Spotify Extended Streaming History .json file, or a directory of them.";
const USAGE = `${IMPORT_USAGE}\nUsage: resolve-items\n  Reads SUPABASE_URL, SUPABASE_SECRET_KEY and MB_USER_AGENT. MB_API_BASE is for tests.`;

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** The key is sent over https, or to this computer. Never over plain http to another host. */
function checkAddress(name: string, address: string): void {
  const problem = addressProblem(name, address);
  if (problem) fail(problem, 2);
}

/** Reads and checks the two database variables, and opens the client. Exits 2 on a bad one. */
function connect(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url) fail("SUPABASE_URL is not set.", 2);
  if (!key) fail("SUPABASE_SECRET_KEY is not set.", 2);
  checkAddress("SUPABASE_URL", url);
  try {
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch {
    fail("SUPABASE_URL is not a valid address.", 2);
  }
}

/** A stop that is not a UserError shows its kind and never its text, which could hold a row or a key. */
function describeStop(error: unknown, doing: string): string {
  if (error instanceof UserError) return error.message;
  const kind = error instanceof Error ? error.name : "unknown";
  return `The ${doing} stopped on an unexpected ${kind} error. No details are shown, so no data leaks.`;
}

async function runImport(path: string | undefined, extra: string[]): Promise<void> {
  if (!path || extra.length > 0) fail(`A path is required, and only one.\n${IMPORT_USAGE}`, 2);
  const client = connect();

  const counts = emptyCounts();
  try {
    await importExport(client, path, counts, (line) => process.stderr.write(`${line}\n`));
  } catch (error) {
    // Say what went wrong, then the partial counts, on stderr. Nothing goes to stdout.
    process.stderr.write(`${describeStop(error, "import")}\n`);
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

/** MusicBrainz asks every client for a User-Agent that says who it is. A header cannot hold a line break or a non-ASCII character. */
function userAgent(): string {
  const value = process.env.MB_USER_AGENT;
  if (value === undefined || value.trim() === "") {
    fail(
      "MB_USER_AGENT is not set. MusicBrainz requires a User-Agent that says who is calling and how to reach them, in the form: AppName/1.0 ( contact ). The command has no default and the repository holds no contact detail.",
      2,
    );
  }
  if (!/^[\x20-\x7e]+$/.test(value)) {
    fail("MB_USER_AGENT may hold only printable ASCII characters, on one line.", 2);
  }
  return value;
}

async function runResolve(extra: string[]): Promise<void> {
  if (extra.length > 0) fail(`resolve-items takes no arguments.\n${USAGE}`, 2);
  const agent = userAgent();
  const base = process.env.MB_API_BASE || DEFAULT_MB_API_BASE;
  checkAddress("MB_API_BASE", base);
  const client = connect();

  const musicbrainz = new MusicBrainz({ base, userAgent: agent, cache: new SupabaseCache(client) });
  const counts = emptyResolveCounts();
  try {
    await resolveItems(client, musicbrainz, counts);
  } catch (error) {
    counts.requests = musicbrainz.requests;
    counts.cache_hits = musicbrainz.cacheHits;
    process.stderr.write(`${describeStop(error, "run")}\n`);
    process.stderr.write(formatResolveReport(counts, { partial: true }));
    process.exit(1);
  }
  counts.requests = musicbrainz.requests;
  counts.cache_hits = musicbrainz.cacheHits;
  process.stdout.write(formatResolveReport(counts));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "import-export") await runImport(rest[0], rest.slice(1));
  else if (command === "resolve-items") await runResolve(rest);
  else fail(USAGE, 2);
}

await main(process.argv.slice(2));
