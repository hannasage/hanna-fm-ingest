import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addressProblem, spotifyAddressProblem } from "./address.ts";
import { UserError } from "./files.ts";
import { importExport } from "./import-export.ts";
import { emptyPollCounts, poll } from "./poll.ts";
import { emptyCounts, formatPollReport, formatReport } from "./report.ts";
import { DEFAULT_SPOTIFY_ACCOUNTS_BASE, DEFAULT_SPOTIFY_API_BASE } from "./settings.ts";
import type { SpotifyConfig } from "./spotify.ts";

const USAGE_IMPORT =
  "Usage: import-export <path>\n  path: a Spotify Extended Streaming History .json file, or a directory of them.";
const USAGE_POLL = "Usage: poll\n  Reads recent plays from Spotify and stores the new ones. It takes no arguments.";
const USAGE = `${USAGE_IMPORT}\n${USAGE_POLL}`;

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** A required variable, or exit 2 naming it. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set.`, 2);
  return value;
}

/** An address variable, checked before anything is sent to it. */
function checkedAddress(name: string, address: string): string {
  const problem = addressProblem(name, address);
  if (problem !== null) fail(problem, 2);
  return address;
}

function supabaseClient(): SupabaseClient {
  const url = required("SUPABASE_URL");
  const key = required("SUPABASE_SECRET_KEY");
  checkedAddress("SUPABASE_URL", url);
  try {
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch {
    return fail("SUPABASE_URL is not a valid address.", 2);
  }
}

async function runImport(path: string): Promise<void> {
  const client = supabaseClient();

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

function spotifyConfig(): SpotifyConfig {
  const clientId = required("SPOTIFY_CLIENT_ID");
  const clientSecret = required("SPOTIFY_CLIENT_SECRET");
  const refreshToken = required("SPOTIFY_REFRESH_TOKEN");
  const base = (name: string, fallback: string, host: string) => {
    const address = process.env[name] || fallback;
    const problem = spotifyAddressProblem(name, address, host);
    if (problem !== null) fail(problem, 2);
    return address.replace(/\/+$/, "");
  };
  return {
    clientId,
    clientSecret,
    refreshToken,
    accountsBase: base("SPOTIFY_ACCOUNTS_BASE", DEFAULT_SPOTIFY_ACCOUNTS_BASE, "accounts.spotify.com"),
    apiBase: base("SPOTIFY_API_BASE", DEFAULT_SPOTIFY_API_BASE, "api.spotify.com"),
  };
}

async function runPoll(): Promise<void> {
  const client = supabaseClient();
  const config = spotifyConfig();

  const counts = emptyPollCounts();
  try {
    await poll(client, config, counts, (line) => process.stderr.write(`${line}\n`));
  } catch (error) {
    // A UserError holds fixed text. Any other failure shows its kind only, never its text,
    // which could hold a token, a key or a play.
    const kind = error instanceof Error ? error.name : "unknown";
    process.stderr.write(
      `${
        error instanceof UserError
          ? error.message
          : `The poll stopped on an unexpected ${kind} error. No details are shown, so no data leaks.`
      }\n`,
    );
    process.exit(1);
  }
  process.stdout.write(formatPollReport(counts));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "import-export") {
    const [path, ...extra] = rest;
    if (!path || extra.length > 0) fail(`A path is required, and only one.\n${USAGE_IMPORT}`, 2);
    return runImport(path);
  }
  if (command === "poll") {
    if (rest.length > 0) fail(USAGE_POLL, 2);
    return runPoll();
  }
  return fail(USAGE, 2);
}

await main(process.argv.slice(2));
