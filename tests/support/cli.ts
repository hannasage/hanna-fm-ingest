import { spawn, spawnSync } from "node:child_process";
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
  path: string | undefined,
  env: Record<string, string | undefined>,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { url, key } = localStack();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
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

  return {
    command: join(root, "node_modules", ".bin", "tsx"),
    args: [join(root, "src", "cli.ts"), "import-export", ...(path === undefined ? [] : [path])],
    env: childEnv,
  };
}

export function runImport(
  path: string | undefined,
  env: Record<string, string | undefined> = {},
): CliResult {
  const { command, args, env: childEnv } = prepare(path, env);
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** Same as runImport, without blocking, so two imports can run at once. */
export function runImportAsync(path: string): Promise<CliResult> {
  const { command, args, env } = prepare(path, {});
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, output: `${stdout}\n${stderr}` }));
  });
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
