import type { SupabaseClient } from "@supabase/supabase-js";
import { stateValueMs } from "./set-state.ts";
import { LOGIN_EXPIRY_DAYS, LOGIN_WARN_DAYS, RECORD_TIMEOUT_MS } from "./settings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The state key that holds when the Spotify login was authorized. */
const KEY = "spotify_authorized_at";

/** Fixed lines. None holds the stored value or a secret. */
export const LOGIN_MESSAGES = {
  notRecorded: `::warning::Spotify login date is not recorded. Run set-state ${KEY} <date>.`,
  old: (days: number) => `::warning::Spotify login is ${days} days old. Re-authorize it before day ${LOGIN_EXPIRY_DAYS}.`,
} as const;

/** The warning line for a stored login date, or null when the login is young enough. `value` is the stored text. */
export function loginWarningFor(value: string, nowMs: number): string | null {
  const authorizedMs = stateValueMs(value);
  if (authorizedMs === null) return LOGIN_MESSAGES.notRecorded;
  const days = Math.floor((nowMs - authorizedMs) / DAY_MS);
  return days >= LOGIN_WARN_DAYS ? LOGIN_MESSAGES.old(days) : null;
}

/**
 * Reads the login date and returns the warning line the run should print, or null for none.
 * A read that fails, or answers with something odd, returns null: the reminder never changes the run.
 * It never throws, and the line never holds the stored value.
 */
export async function loginReminder(client: SupabaseClient, nowMs: number = Date.now()): Promise<string | null> {
  try {
    const { data, error } = await client
      .from("poller_state")
      .select("value")
      .eq("key", KEY)
      .abortSignal(AbortSignal.timeout(RECORD_TIMEOUT_MS));
    if (error) return null;
    const rows: unknown[] = data ?? [];
    if (rows.length === 0) return LOGIN_MESSAGES.notRecorded;
    const row = rows[0];
    if (typeof row !== "object" || row === null || !("value" in row) || typeof row.value !== "string") return null;
    return loginWarningFor(row.value, nowMs);
  } catch {
    return null;
  }
}
