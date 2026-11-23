import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import { RESOLVE_LOCK_LEASE_MS } from "./settings.ts";
import { printableCode } from "./store.ts";

/**
 * A lock held by this run. `lockedUntil` is the lease as this run last wrote it, in ISO form.
 * `next` is a lease being written right now: the row may hold either value until the write returns.
 */
export type Lease = { name: string; lockedUntil: string; next?: string };

function refused(what: string, error: { code?: unknown }): UserError {
  return new UserError(
    `The database refused ${what} (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again.`,
  );
}

const inFuture = (ms: number): string => new Date(Date.now() + ms).toISOString();

/**
 * Takes the lock named `name`, or returns null when another run holds it. The take is one update that
 * matches only a row with no lease or a lease that has passed, so of many simultaneous callers one wins.
 * It uses no database advisory lock: the lease is a column, and a run that dies frees it by running out.
 */
export async function acquireLock(client: SupabaseClient, name: string, leaseMs: number = RESOLVE_LOCK_LEASE_MS): Promise<Lease | null> {
  const made = await client.from("job_locks").upsert({ name }, { onConflict: "name", ignoreDuplicates: true });
  if (made.error) throw refused("a lock write", made.error);

  const lockedUntil = inFuture(leaseMs);
  const { data, error } = await client
    .from("job_locks")
    .update({ locked_until: lockedUntil })
    .eq("name", name)
    .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
    .select("name");
  if (error) throw refused("a lock update", error);
  return data.length > 0 ? { name, lockedUntil } : null;
}

/**
 * Moves the lease forward. It changes the row only while the row still holds this run's own lease value,
 * so a run whose lease passed, and whose lock another run then took, cannot extend the other run's lock.
 * Returns false when the lock is no longer this run's.
 */
export async function refreshLock(client: SupabaseClient, lease: Lease, leaseMs: number = RESOLVE_LOCK_LEASE_MS): Promise<boolean> {
  const lockedUntil = inFuture(leaseMs);
  lease.next = lockedUntil;
  const { data, error } = await client
    .from("job_locks")
    .update({ locked_until: lockedUntil })
    .eq("name", lease.name)
    .eq("locked_until", lease.lockedUntil)
    .select("name");
  delete lease.next;
  if (error) throw refused("a lock refresh", error);
  if (data.length === 0) return false;
  lease.lockedUntil = lockedUntil;
  return true;
}

/**
 * Frees the lock, only if it still holds this run's lease, which includes a refresh still being written.
 * A failure here is not worth stopping for: the lease runs out.
 */
export async function releaseLock(client: SupabaseClient, lease: Lease): Promise<void> {
  const held = lease.next === undefined ? [lease.lockedUntil] : [lease.lockedUntil, lease.next];
  await client.from("job_locks").update({ locked_until: null }).eq("name", lease.name).in("locked_until", held);
}
