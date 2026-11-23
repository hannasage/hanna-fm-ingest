import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The local stack's address and secret key, put in memory by the global setup. */
export function localStack(): { url: string; key: string } {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("TEST_SUPABASE_* is not set. Is global setup running?");
  return { url, key };
}

export function adminClient(): SupabaseClient {
  const { url, key } = localStack();
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The local stack's browser-role key, for checks that the browser roles can read nothing. */
export function anonClient(): SupabaseClient {
  const { url } = localStack();
  const anon = process.env.TEST_SUPABASE_ANON_KEY;
  if (!anon) throw new Error("TEST_SUPABASE_ANON_KEY is not set. Is global setup running?");
  return createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Runs SQL on the local stack's database and returns each query's output, one text value per line.
 * It connects with `psql`, to the address `supabase status` reports, so no container name is written here.
 * The address holds the local password, so it goes to psql in the environment and never in an argument.
 */
export function psql(...queries: string[]): string[] {
  const address = process.env.TEST_SUPABASE_DB_URL;
  if (!address) throw new Error("TEST_SUPABASE_DB_URL is not set. Is global setup running?");
  const url = new URL(address);
  const output = execFileSync("psql", ["-At", ...queries.flatMap((query) => ["-c", query])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port,
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
    },
  });
  return output.trim().split("\n");
}
