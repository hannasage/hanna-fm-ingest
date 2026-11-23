import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { localStack } from "./env.ts";

const root = process.cwd();

export type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Everything the command printed. */
  output: string;
};

/**
 * Runs the real command in a child process, the way a person would.
 * Pass `env` to replace the connection values. An undefined value removes the variable.
 */
function prepare(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { url, key } = localStack();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // A value in the shell that runs the tests must not reach the command by accident.
    MB_USER_AGENT: undefined,
    MB_API_BASE: undefined,
    SPOTIFY_CLIENT_ID: undefined,
    SPOTIFY_CLIENT_SECRET: undefined,
    SPOTIFY_REFRESH_TOKEN: undefined,
    SPOTIFY_ACCOUNTS_BASE: undefined,
    SPOTIFY_API_BASE: undefined,
    SUPABASE_URL: url,
    SUPABASE_SECRET_KEY: key,
    ...env,
  };
  for (const name of Object.keys(childEnv)) {
    if (childEnv[name] === undefined) delete childEnv[name];
  }
  // The test-only names are not part of the command's environment.
  delete childEnv.TEST_SUPABASE_URL;
  delete childEnv.TEST_SUPABASE_SECRET_KEY;
  delete childEnv.TEST_SUPABASE_ANON_KEY;
  delete childEnv.TEST_SUPABASE_DB_URL;

  // Node runs the command directly, with tsx loaded as a module. The `tsx` program would start a second
  // process, and a signal sent to the first would not reach the one doing the work.
  return {
    command: process.execPath,
    args: ["--import", "tsx", join(root, "src", "cli.ts"), command, ...args],
    env: childEnv,
  };
}

function run(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): CliResult {
  const prepared = prepare(command, args, env);
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: root,
    env: prepared.env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** A command that is running: stop it with `stop`, or wait for its result with `done`. */
export type Running = {
  stop: (signal: NodeJS.Signals) => void;
  done: Promise<CliResult>;
};

function start(command: string, args: string[], env: Record<string, string | undefined>): Running {
  const prepared = prepare(command, args, env);
  const child = spawn(prepared.command, prepared.args, {
    cwd: root,
    env: prepared.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<CliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    // A command stopped by a signal has no exit status. Report it as 128 plus the signal number, as a shell does.
    child.on("close", (status, signal) =>
      resolve({ status: status ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : null), stdout, stderr, output: `${stdout}\n${stderr}` }),
    );
  });
  return { stop: (signal) => void child.kill(signal), done };
}

function runAsync(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  return start(command, args, env).done;
}

export function runImport(
  path: string | undefined,
  env: Record<string, string | undefined> = {},
): CliResult {
  return run("import-export", path === undefined ? [] : [path], env);
}

/** Runs `set-state <key> <value>`. Pass `env` to replace the connection values. */
export function runSetState(
  args: string[],
  env: Record<string, string | undefined> = {},
): CliResult {
  return run("set-state", args, env);
}

/** Same as runImport, without blocking, so two imports can run at once. */
export function runImportAsync(
  path: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  return runAsync("import-export", [path], extraEnv);
}

/**
 * Runs resolve-items. It is always asynchronous: the fake MusicBrainz server runs in the test's own
 * process, and a blocking call would stop it from answering. Pass `env` to set MB_USER_AGENT and
 * MB_API_BASE, or to remove a variable.
 */
export function runResolve(env: Record<string, string | undefined> = {}, args: string[] = []): Promise<CliResult> {
  return runAsync("resolve-items", args, env);
}

/** Same as runResolve, but hands back the running command, so a test can stop it part way. */
export function startResolve(env: Record<string, string | undefined> = {}, args: string[] = []): Running {
  return start("resolve-items", args, env);
}

/** Reads "name: 12" lines from the command's count report. */
export function counts(stdout: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = /^\s*([a-z_]+):\s+(\d+)\s*$/.exec(line);
    if (match?.[1] && match[2]) found[match[1]] = Number(match[2]);
  }
  return found;
}

/**
 * Runs `poll` without blocking. It must not block: the fake Spotify server runs in this
 * same process, and a blocked process cannot answer it.
 * The Spotify names start unset, so a test sets only what it means to.
 */
export function runPoll(
  env: Record<string, string | undefined> = {},
  extraArgs: string[] = [],
): Promise<CliResult> {
  const running = start("poll", extraArgs, env);
  // A poll that hangs must not hang the test run.
  const timer = setTimeout(() => running.stop("SIGKILL"), 120_000);
  return running.done.finally(() => clearTimeout(timer));
}
