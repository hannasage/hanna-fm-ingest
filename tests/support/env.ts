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
