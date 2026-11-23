import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addressProblem, spotifyAddressProblem } from "./address.ts";
import { UserError } from "./files.ts";
import { importExport } from "./import-export.ts";
import { acquireLock, refreshLock, releaseLock, type Lease } from "./job-lock.ts";
import { MusicBrainz } from "./musicbrainz.ts";
import { emptyPollCounts, poll, pollNotes, pollProblemKind, pollProblems } from "./poll.ts";
import { emptyCounts, formatPollReport, formatReport } from "./report.ts";
import { loginReminder } from "./login-reminder.ts";
import { finishedRecord, recordRun, stoppedRecord } from "./run-record.ts";
import { checkState, setState, STATE_MESSAGES } from "./set-state.ts";
import { formatResolveReport, resolveItems, emptyResolveCounts } from "./resolve-items.ts";
import {
  DEFAULT_MB_API_BASE,
  LOGIN_SCOPES,
  LOGIN_TIMEOUT_MS,
  RECORD_TIMEOUT_MS,
  DEFAULT_SPOTIFY_ACCOUNTS_BASE,
  DEFAULT_SPOTIFY_API_BASE,
  RESOLVE_LOCK_LEASE_MS,
  RESOLVE_LOCK_NAME,
  RESOLVE_MAX_ATTEMPTS,
} from "./settings.ts";
import { loginRedirectUri, runLogin } from "./spotify-login.ts";
import type { SpotifyConfig } from "./spotify.ts";
import { SupabaseCache } from "./item-store.ts";

const IMPORT_USAGE =
  "Usage: import-export <path>\n  path: a Spotify Extended Streaming History .json file, or a directory of them.";
const RESOLVE_USAGE = [
  "Usage: resolve-items [--limit N] [--retry-failed]",
  "  Reads SUPABASE_URL, SUPABASE_SECRET_KEY and MB_USER_AGENT. MB_API_BASE is for tests.",
  "  --limit N       process at most N items, then print how many remain",
  `  --retry-failed  try items that have failed ${RESOLVE_MAX_ATTEMPTS} times or more (exhausted items)`,
  "  Exit codes: 0 done, 1 stopped, or items stayed pending, or items are stuck (exhausted), 2 bad setting or argument, 3 another run holds the lock.",
].join("\n");
const POLL_USAGE = "Usage: poll\n  Reads recent plays from Spotify and stores the new ones. It takes no arguments.";
const LOGIN_USAGE = [
  "Usage: spotify-login",
  "  Gets a Spotify refresh token. Reads SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from the environment, never from arguments.",
  "  It takes no arguments. SPOTIFY_LOGIN_PORT is optional: the redirect address registered in the Spotify app must name the same port.",
  "  SUPABASE_URL and SUPABASE_SECRET_KEY are optional: with both set, it records spotify_authorized_at.",
].join("\n");
const USAGE = `${IMPORT_USAGE}\n${RESOLVE_USAGE}\n${POLL_USAGE}\n${STATE_MESSAGES.usage}\n${LOGIN_USAGE}`;

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

/** A required variable, or exit 2 naming it. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set.`, 2);
  return value;
}

/** A Spotify address from the environment, or the default. Exits 2 unless it is Spotify's own host over https, or this computer. */
function spotifyBase(name: string, fallback: string, host: string): string {
  const address = process.env[name] || fallback;
  const problem = spotifyAddressProblem(name, address, host);
  if (problem !== null) fail(problem, 2);
  return address.replace(/\/+$/, "");
}

function spotifyConfig(): SpotifyConfig {
  const clientId = required("SPOTIFY_CLIENT_ID");
  const clientSecret = required("SPOTIFY_CLIENT_SECRET");
  const refreshToken = required("SPOTIFY_REFRESH_TOKEN");
  const base = spotifyBase;
  return {
    clientId,
    clientSecret,
    refreshToken,
    accountsBase: base("SPOTIFY_ACCOUNTS_BASE", DEFAULT_SPOTIFY_ACCOUNTS_BASE, "accounts.spotify.com"),
    apiBase: base("SPOTIFY_API_BASE", DEFAULT_SPOTIFY_API_BASE, "api.spotify.com"),
  };
}

async function runPoll(): Promise<void> {
  const client = connect();
  const config = spotifyConfig();
  const warn = (line: string) => process.stderr.write(`${line}\n`);

  // Configuration is checked by now, so the run is recorded however it ends from here on.
  const startedAt = new Date();
  const counts = emptyPollCounts();
  try {
    await poll(client, config, counts, warn);
  } catch (error) {
    // A UserError holds fixed text. Any other failure shows its kind only, never its text,
    // which could hold a token, a key or a play.
    process.stderr.write(`${describeStop(error, "poll")}\n`);
    await recordRun(client, stoppedRecord(startedAt, counts, error), warn);
    await warnAboutLogin(client, warn);
    process.exit(1);
  }
  process.stdout.write(formatPollReport(counts));
  // A run that skipped a malformed item (and so maybe stored nothing by mistake), or stopped short, is never green.
  // Each line is a GitHub annotation, so the run page shows it.
  const problems = pollProblems(counts);
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`);
  // A window of only local files and episodes is green. It gets a plain note, not an annotation.
  for (const note of pollNotes(counts)) process.stderr.write(`${note}\n`);
  await recordRun(client, finishedRecord(startedAt, counts, pollProblemKind(counts)), warn);
  await warnAboutLogin(client, warn);
  if (problems.length > 0) process.exit(1);
}

/** The last thing a poll run does: warn when the Spotify login date is missing or old. It never changes the exit code. */
async function warnAboutLogin(client: ReturnType<typeof connect>, warn: (line: string) => void): Promise<void> {
  const line = await loginReminder(client);
  if (line !== null) warn(line);
}

/** Records one fact about the poller, such as when the Spotify login was authorized. Nothing it was given is ever printed. */
async function runSetState(args: string[]): Promise<void> {
  if (args.length !== 2) fail(STATE_MESSAGES.usage, 2);
  let state;
  try {
    state = checkState(args[0]!, args[1]!);
  } catch (error) {
    fail(describeStop(error, "command"), 2);
  }
  const client = connect();
  try {
    await setState(client, state.key, state.value);
  } catch (error) {
    fail(describeStop(error, "command"), 1);
  }
  process.stdout.write(`Recorded ${state.key}.\n`);
}

/**
 * The way `spotify-login` records the login date: the same check and the same write as `set-state`.
 * Null when the two database variables are not both set. A bad address does not stop the login, which has
 * already printed the token by then: the record fails, and the person is told how to record it by hand.
 */
function loginRecorder(): ((date: string) => Promise<void>) | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return async (date) => {
    // The key is sent over https, or to this computer. Checked here, with no exit, so the login still ends cleanly.
    const problem = addressProblem("SUPABASE_URL", url);
    if (problem) throw new UserError(problem);
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const state = checkState("spotify_authorized_at", date);
    await setState(client, state.key, state.value, AbortSignal.timeout(RECORD_TIMEOUT_MS));
  };
}

/** Gets a refresh token by the authorization code flow. The helper itself, `runLogin`, is in src/spotify-login.ts. */
async function runSpotifyLogin(args: string[]): Promise<void> {
  if (args.length > 0) fail(LOGIN_USAGE, 2);
  const clientId = required("SPOTIFY_CLIENT_ID");
  const clientSecret = required("SPOTIFY_CLIENT_SECRET");
  const accountsBase = spotifyBase("SPOTIFY_ACCOUNTS_BASE", DEFAULT_SPOTIFY_ACCOUNTS_BASE, "accounts.spotify.com");
  let redirectUri: string;
  try {
    redirectUri = loginRedirectUri(process.env.SPOTIFY_LOGIN_PORT);
  } catch (error) {
    fail(describeStop(error, "command"), 2);
  }
  process.exitCode = await runLogin({
    clientId,
    clientSecret,
    accountsBase,
    redirectUri,
    scopes: LOGIN_SCOPES,
    isTty: process.stdout.isTTY === true,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    timeoutMs: LOGIN_TIMEOUT_MS,
    recordAuthorized: loginRecorder(),
  });
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

/** Reads the flags of resolve-items. Exits 2 on anything else. */
function resolveFlags(args: string[]): { limit: number | undefined; retryFailed: boolean } {
  let limit: number | undefined;
  let retryFailed = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--retry-failed") {
      retryFailed = true;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        fail(`--limit needs a whole number of 1 or more.\n${RESOLVE_USAGE}`, 2);
      }
      limit = Number(value);
    } else {
      fail(`resolve-items does not take that argument.\n${RESOLVE_USAGE}`, 2);
    }
  }
  return { limit, retryFailed };
}

async function runResolve(args: string[]): Promise<void> {
  const flags = resolveFlags(args);
  const agent = userAgent();
  const base = process.env.MB_API_BASE || DEFAULT_MB_API_BASE;
  checkAddress("MB_API_BASE", base);
  const client = connect();

  // One run at a time: the one-request-a-second limit is kept inside a run, so two runs would break it.
  let lease: Lease | null;
  try {
    lease = await acquireLock(client, RESOLVE_LOCK_NAME, RESOLVE_LOCK_LEASE_MS);
  } catch (error) {
    fail(describeStop(error, "run"), 1);
  }
  if (lease === null) {
    fail("Another resolve-items run holds the lock, so this one did not start and changed nothing. Wait for it to finish, then run the command again. A run that died frees the lock in 30 minutes.", 3);
  }
  const held = lease;

  // A stop by signal frees the lock first, so the next run need not wait out the lease.
  // From then on the run does no new item: the next heartbeat never returns, and the exit comes from here.
  let stopping = false;
  for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15]] as const) {
    process.once(signal, () => {
      stopping = true;
      void releaseLock(client, held).finally(() => process.exit(128 + number));
    });
  }

  // Refreshes the lease. It runs before every item and before every request to MusicBrainz, retries included.
  // It throws when the lock was lost.
  const heartbeat = async (): Promise<void> => {
    if (stopping) await new Promise<never>(() => undefined);
    if (!(await refreshLock(client, held, RESOLVE_LOCK_LEASE_MS))) {
      throw new UserError("This run lost its lock, because its lease ran out and another run took it. It stopped so two runs never work at once.");
    }
  };

  const musicbrainz = new MusicBrainz({ base, userAgent: agent, cache: new SupabaseCache(client), beforeAttempt: heartbeat });
  const counts = emptyResolveCounts();
  try {
    await resolveItems(client, musicbrainz, counts, {
      ...flags,
      progress: (line) => process.stderr.write(`${line}\n`),
      onUnavailableKind: (kind) => process.stderr.write(`MusicBrainz was unavailable: ${kind}\n`),
      heartbeat,
    });
  } catch (error) {
    // Say what went wrong, then the partial counts, on stderr. Nothing goes to stdout.
    process.stderr.write(`${describeStop(error, "run")}\n`);
    process.stderr.write(formatResolveReport(counts, { partial: true }));
    await releaseLock(client, held);
    process.exit(1);
  }
  await releaseLock(client, held);

  process.stdout.write(formatResolveReport(counts));
  if (counts.skipped > 0) {
    process.stderr.write(`${counts.skipped} items were skipped: no play names them any more, or another run settled them.\n`);
  }
  if (counts.remaining > 0) process.stderr.write(`${counts.remaining} items remain. Run the command again to go on.\n`);
  let failed = false;
  if (counts.pending > 0) {
    process.stderr.write(`${counts.pending} items stayed pending because MusicBrainz was unavailable or refused them. Run the command again later.\n`);
    failed = true;
  }
  if (counts.exhausted > 0) {
    const tried = flags.retryFailed ? "were tried again and still failed" : "were not tried";
    process.stderr.write(
      `${counts.exhausted} items are stuck: each has failed ${RESOLVE_MAX_ATTEMPTS} times or more, and ${tried}. Run the command with --retry-failed to try them again.\n`,
    );
    failed = true;
  }
  if (failed) process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "import-export") await runImport(rest[0], rest.slice(1));
  else if (command === "resolve-items") await runResolve(rest);
  else if (command === "poll") {
    if (rest.length > 0) fail(POLL_USAGE, 2);
    await runPoll();
  }
  else if (command === "set-state") await runSetState(rest);
  else if (command === "spotify-login") await runSpotifyLogin(rest);
  else fail(USAGE, 2);
}

await main(process.argv.slice(2));
