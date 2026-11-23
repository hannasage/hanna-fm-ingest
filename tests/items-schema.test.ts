import { beforeEach, describe, expect, it } from "vitest";
import { clearTables, id } from "./support/data.ts";
import { adminClient, anonClient, psql } from "./support/env.ts";

const db = adminClient();
const CHECK = "23514";
const FOREIGN_KEY = "23503";
const NOW = () => new Date().toISOString();

let counter = 0;
type NewItem = Record<string, unknown>;

/** Inserts one row and returns the database's answer, so a test can read the error code. */
async function insert(values: NewItem): Promise<{ code: string | undefined; id: number | undefined }> {
  counter += 1;
  const row = { kind: "artist", name: "SYNTH A", source_key: `key-${counter}`, ...values };
  const { data, error } = await db.from("items").insert(row).select("id").maybeSingle();
  return { code: error?.code, id: (data as { id: number } | null)?.id };
}

const resolved = (extra: NewItem = {}): NewItem => ({ state: "resolved", mbid: id(++counter), resolved_at: NOW(), ...extra });
const unresolved = (reason: string | null): NewItem => ({ state: "unresolved", reason, resolved_at: NOW() });

beforeEach(async () => {
  await clearTables(db);
});

describe("items: merged_into", () => {
  it("must point at a row of the same kind", async () => {
    const track = await insert({ kind: "track", ...resolved() });
    expect(track.code).toBeUndefined();

    const sameKind = await insert({ kind: "track", state: "resolved", merged_into: track.id, resolved_at: NOW() });
    expect(sameKind.code).toBeUndefined();

    const otherKind = await insert({ kind: "album", state: "resolved", merged_into: track.id, resolved_at: NOW() });
    expect(otherKind.code).toBe(FOREIGN_KEY);
  });

  it("cannot point at the row itself", async () => {
    const row = await insert({ kind: "track", ...resolved() });
    const { error } = await db.from("items").update({ mbid: null, merged_into: row.id }).eq("id", row.id!);
    expect(error?.code).toBe(CHECK);
  });

  it("cannot be set together with an mbid", async () => {
    const target = await insert({ kind: "track", ...resolved() });
    const both = await insert({ kind: "track", ...resolved({ merged_into: target.id }) });
    expect(both.code).toBe(CHECK);
  });
});

describe("items: reason", () => {
  it.each(["no_match", "below_threshold", "empty_name", "ambiguous", "no_artist", "bad_query", "name_too_long"])(
    "is allowed on an unresolved row: %s",
    async (reason) => {
      expect((await insert(unresolved(reason))).code).toBeUndefined();
    },
  );

  it("is refused when it is not one of the listed values", async () => {
    expect((await insert(unresolved("because"))).code).toBe(CHECK);
  });

  it("is refused on a pending row", async () => {
    expect((await insert({ reason: "no_match" })).code).toBe(CHECK);
  });

  it("is refused on a resolved row, except credit on a resolved artist", async () => {
    expect((await insert({ kind: "track", ...resolved({ reason: "no_match" }) })).code).toBe(CHECK);
    expect((await insert({ kind: "track", ...resolved({ reason: "credit" }) })).code).toBe(CHECK);
    expect((await insert({ kind: "artist", ...resolved({ reason: "no_match" }) })).code).toBe(CHECK);
    expect((await insert({ kind: "artist", ...resolved({ reason: "credit" }) })).code).toBeUndefined();
  });
});

describe("items: the other rules", () => {
  it("starts with no attempts, and refuses a negative count", async () => {
    const row = await insert({});
    const { data } = await db.from("items").select("attempts, last_attempt_at").eq("id", row.id!).single();
    expect(data).toEqual({ attempts: 0, last_attempt_at: null });
    const { error } = await db.from("items").update({ attempts: -1 }).eq("id", row.id!);
    expect(error?.code).toBe(CHECK);
  });

  it("keeps state, mbid and resolved_at in line", async () => {
    expect((await insert({ state: "resolved", resolved_at: NOW() })).code).toBe(CHECK);
    expect((await insert({ ...resolved(), resolved_at: null })).code).toBe(CHECK);
    expect((await insert({ state: "pending", resolved_at: NOW() })).code).toBe(CHECK);
    expect((await insert({ mbid: id(900) })).code).toBe(CHECK);
  });

  it("refuses a score outside 0 to 100, and an unknown kind or state", async () => {
    expect((await insert({ ...unresolved("below_threshold"), match_score: 101 })).code).toBe(CHECK);
    expect((await insert({ kind: "label" })).code).toBe(CHECK);
    expect((await insert({ state: "done" })).code).toBe(CHECK);
  });

  it("keeps one row for a kind and source key, and one row for a kind and MBID", async () => {
    const first = await insert({ kind: "track", source_key: "same", ...resolved({ mbid: id(901) }) });
    expect(first.code).toBeUndefined();
    expect((await insert({ kind: "track", source_key: "same" })).code).toBe("23505");
    expect((await insert({ kind: "track", ...resolved({ mbid: id(901) }) })).code).toBe("23505");
    expect((await insert({ kind: "album", ...resolved({ mbid: id(901) }) })).code).toBeUndefined();
  });
});

describe("mb_cache", () => {
  it("is keyed by a 64-character lower-case hex hash, and refuses anything else", async () => {
    const good = await db.from("mb_cache").insert({ request_hash: "a".repeat(64), candidates: [] });
    expect(good.error).toBeNull();
    for (const bad of ["a".repeat(63), "A".repeat(64), "g".repeat(64), "https://example.invalid/ws/2/artist?query=x"]) {
      const { error } = await db.from("mb_cache").insert({ request_hash: bad, candidates: [] });
      expect(error?.code, bad).toBe(CHECK);
    }
  });
});

describe("items tables: browser roles", () => {
  it("lets the browser roles read and write nothing in items, mb_cache or job_locks", async () => {
    const anon = anonClient();
    for (const table of ["items", "mb_cache", "job_locks"]) {
      const read = await anon.from(table).select("*").limit(1);
      expect(read.error?.code, `${table} read`).toBe("42501");
      const write = await anon.from(table).insert({});
      expect(write.error?.code, `${table} write`).toBe("42501");
    }
  });

  it("turns row-level security on and forces it, and grants nothing on any of the three tables or the sequence", () => {
    const tables = `array['items', 'mb_cache', 'job_locks']`;
    const out = psql(
      `select string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity, ',' order by c.relname)
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('items', 'mb_cache', 'job_locks')`,
      `select string_agg(r || ':' || t || ':' || has_table_privilege(r, 'public.' || t, 'select,insert,update,delete,references,trigger,truncate'), ',' order by r, t)
      from unnest(array['anon', 'authenticated', 'public']) r, unnest(${tables}) t`,
      `select string_agg(r || ':' || has_sequence_privilege(r, 'public.items_id_seq', 'usage,select,update'), ',' order by r)
      from unnest(array['anon', 'authenticated']) r`,
    );
    expect(out[0]).toBe("items:true:true,job_locks:true:true,mb_cache:true:true");
    expect(out[1]).not.toContain(":true");
    expect(out[2]).toBe("anon:false,authenticated:false");
  });
});
