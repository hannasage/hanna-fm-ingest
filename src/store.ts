import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import type { Play } from "./parse.ts";

const BATCH_SIZE = 500;

/**
 * Stores plays and returns how many were new.
 * A play already stored (same track_uri and ended_at) is skipped, never changed.
 * Each batch is one request, so a failed run can simply be run again.
 */
export async function storePlays(
  client: SupabaseClient,
  plays: Play[],
  onBatch?: (inserted: number) => void,
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < plays.length; start += BATCH_SIZE) {
    const batch = plays.slice(start, start + BATCH_SIZE);
    const { data, error } = await client
      .from("plays")
      .upsert(batch, { onConflict: "track_uri,ended_at", ignoreDuplicates: true })
      .select("id");
    if (error) {
      // The error text can quote a row or the address. Report the code only.
      throw new UserError(
        `The database refused a batch (code ${error.code || "none"}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: plays already stored are skipped.`,
      );
    }
    const count = data?.length ?? 0;
    inserted += count;
    onBatch?.(count);
  }
  return inserted;
}
