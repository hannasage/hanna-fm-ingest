import { beforeEach, describe, expect, it } from "vitest";
import { acquireLock, refreshLock, releaseLock } from "../src/job-lock.ts";
import { RESOLVE_LOCK_LEASE_MS, RESOLVE_LOCK_NAME } from "../src/settings.ts";
import { clearTables } from "./support/data.ts";
import { adminClient } from "./support/env.ts";

const db = adminClient();
const NAME = "test-job";

async function lockedUntil(name = NAME): Promise<number | null> {
  const { data, error } = await db.from("job_locks").select("locked_until").eq("name", name).maybeSingle();
  if (error) throw new Error(`could not read the lock: ${error.code}`);
  const value = (data as { locked_until: string | null } | null)?.locked_until;
  return value ? new Date(value).getTime() : null;
}

beforeEach(async () => {
  await clearTables(db);
});

describe("job lock", () => {
  it("is named resolve-items, with a lease of 30 minutes", () => {
    expect(RESOLVE_LOCK_NAME).toBe("resolve-items");
    expect(RESOLVE_LOCK_LEASE_MS).toBe(30 * 60 * 1000);
  });

  it("is taken by one holder, refused to a second, and free again after release", async () => {
    const first = await acquireLock(db, NAME, 60_000);
    expect(first).not.toBeNull();
    expect(await acquireLock(db, NAME, 60_000)).toBeNull();

    await releaseLock(db, first!);
    expect(await lockedUntil()).toBeNull();
    expect(await acquireLock(db, NAME, 60_000)).not.toBeNull();
  });

  it("holds for the lease", async () => {
    const before = Date.now();
    await acquireLock(db, NAME, 60_000);
    const until = (await lockedUntil())!;
    expect(until).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
  });

  it("lets exactly one of many simultaneous callers take it", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => acquireLock(db, NAME, 60_000)));
    expect(results.filter((lease) => lease !== null)).toHaveLength(1);
  });

  it("can be taken once the lease has passed, and then the old holder can neither refresh nor release it", async () => {
    const old = await acquireLock(db, NAME, 60_000);
    await db.from("job_locks").update({ locked_until: new Date(Date.now() - 1000).toISOString() }).eq("name", NAME);

    const next = await acquireLock(db, NAME, 60_000);
    expect(next).not.toBeNull();
    expect(await refreshLock(db, old!, 60_000)).toBe(false);
    await releaseLock(db, old!);
    expect(await lockedUntil()).not.toBeNull();
    expect(await refreshLock(db, next!, 60_000)).toBe(true);
  });

  it("moves the lease forward when refreshed", async () => {
    const lease = await acquireLock(db, NAME, 1_000);
    const before = (await lockedUntil())!;
    expect(await refreshLock(db, lease!, 120_000)).toBe(true);
    expect((await lockedUntil())!).toBeGreaterThan(before + 100_000);
    // A second refresh works too: the holder's record of the lease moved with it.
    expect(await refreshLock(db, lease!, 120_000)).toBe(true);
  });
});
