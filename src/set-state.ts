import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import { ALLOWED_STATE_KEYS } from "./settings.ts";
import { printableCode } from "./store.ts";

/**
 * Every message here is fixed text. None quotes the key or the value the person typed,
 * so a mistyped secret is never printed back.
 */
export const STATE_MESSAGES = {
  usage: `Usage: set-state <key> <value>\n  key: one of ${ALLOWED_STATE_KEYS.join(", ")}\n  value: a date (YYYY-MM-DD) or an ISO time, not in the future`,
  badKey: `set-state allows only these keys: ${ALLOWED_STATE_KEYS.join(", ")}.`,
  badValue: "The value must be a date (YYYY-MM-DD) or an ISO time, such as 2026-11-20T10:00:00Z.",
  future: "The value is in the future. Give the time the login was authorized.",
  refused: (code: string) => `The database refused the state change (code ${code}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again.`,
} as const;

export function isAllowedKey(key: string): key is (typeof ALLOWED_STATE_KEYS)[number] {
  return (ALLOWED_STATE_KEYS as readonly string[]).includes(key);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** True when year, month and day name a real day (so 2026-02-30 is not one). */
function isRealDay(year: string, month: string, day: string): boolean {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}

/**
 * The moment a value names, in milliseconds, or null when it is neither a real YYYY-MM-DD date nor an ISO instant.
 * A date means the start of that day in UTC. An instant must carry an offset or Z.
 */
export function stateValueMs(value: string): number | null {
  const date = DATE.exec(value);
  if (date) return isRealDay(date[1]!, date[2]!, date[3]!) ? Date.parse(`${value}T00:00:00Z`) : null;
  const instant = INSTANT.exec(value);
  if (!instant || !isRealDay(instant[1]!, instant[2]!, instant[3]!)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Checks both arguments. Throws a UserError with fixed text. Returns the key and value to store. */
export function checkState(key: string, value: string, nowMs: number = Date.now()): { key: (typeof ALLOWED_STATE_KEYS)[number]; value: string } {
  if (!isAllowedKey(key)) throw new UserError(STATE_MESSAGES.badKey);
  const ms = stateValueMs(value);
  if (ms === null) throw new UserError(STATE_MESSAGES.badValue);
  if (ms > nowMs) throw new UserError(STATE_MESSAGES.future);
  return { key, value };
}

/** Stores one state row, or replaces the value of the row that holds the key. Run twice with one value, it leaves one row. */
export async function setState(client: SupabaseClient, key: string, value: string): Promise<void> {
  const { error } = await client
    .from("poller_state")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  // The error text can quote the row or the address. Report a plain code only.
  if (error) throw new UserError(STATE_MESSAGES.refused(printableCode(error.code)));
}
