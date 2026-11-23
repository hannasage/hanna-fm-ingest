import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import type { Play } from "./parse.ts";

/** The pattern the site repository uses for any value it prints from a failure. */
const SAFE_TOKEN = /^[A-Za-z0-9_]{1,40}$/;

/** A database error code is printed only when it is a plain token. */
function printableCode(code: unknown): string {
  if (typeof code !== "string" || code === "") return "none";
  return SAFE_TOKEN.test(code) ? code : "unknown";
}

/**
 * Stores one batch of plays in one request and returns how many were new.
 * A play already stored (same track_uri and ended_at) is skipped, never changed,
 * so a failed run can simply be run again.
 */
export async function storeBatch(client: SupabaseClient, batch: Play[]): Promise<number> {
  const { data, error } = await client
    .from("plays")
    .upsert(batch, { onConflict: "track_uri,ended_at", ignoreDuplicates: true })
    .select("id");
  if (error) {
    // The error text can quote a row or the address. Report a plain code only.
    throw new UserError(
      `The database refused a batch (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: plays already stored are skipped.`,
    );
  }
  if (data === null) {
    throw new UserError(
      "The database gave no answer for a batch, so nothing can be counted. Run the command again: plays already stored are skipped.",
    );
  }
  return data.length;
}
