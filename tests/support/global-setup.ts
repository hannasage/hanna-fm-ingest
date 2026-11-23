import { execFileSync } from "node:child_process";
import { redactLines } from "./redact.ts";

/**
 * Reads the local Supabase stack's address and key from `supabase status`.
 * The values live in process memory only. No test writes them to disk or prints them.
 */
export default function setup() {
  let output: string;
  try {
    output = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const reason = redactLines(stderr).trim() || (error as Error).message.split("\n")[0];
    throw new Error(
      `Local Supabase is not running or did not answer. Start it with \`npm run db:start\`, then run the tests again. The CLI said: ${reason}`,
    );
  }
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  const url = values.API_URL;
  const key = values.SECRET_KEY || values.SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("The Supabase CLI did not report the address and secret key the tests need.");
  }
  process.env.TEST_SUPABASE_URL = url;
  process.env.TEST_SUPABASE_SECRET_KEY = key;
}
