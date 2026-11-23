import { beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_STATE_KEYS } from "../src/settings.ts";
import { runSetState, type CliResult } from "./support/cli.ts";
import { adminClient, localStack } from "./support/env.ts";
import { deadAddress } from "./support/fake-spotify.ts";
import { secretsFoundIn } from "./support/leaks.ts";

// Synthetic values only.
const KEY = "spotify_authorized_at";
const db = adminClient();

beforeEach(async () => {
  const { error } = await db.from("poller_state").delete().neq("key", "");
  if (error) throw new Error(`Could not clear poller_state: ${error.code}`);
});

type StateRow = { key: string; value: string; updated_at: string };

async function state(): Promise<StateRow[]> {
  const { data, error } = await db.from("poller_state").select("*").order("key");
  if (error) throw new Error(`Could not read poller_state: ${error.code}`);
  return (data ?? []) as StateRow[];
}

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const instant = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();

/** A refused command: exit 2, one plain line, nothing stored, nothing echoed. */
function expectRefused(result: CliResult, message: string, echoed: string[] = []): void {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${message}\n`);
  // The fixed message may itself show an example date, so it is cut out before looking for an echo.
  const rest = result.output.replace(message, "");
  for (const text of echoed) expect(rest).not.toContain(text);
  expect(secretsFoundIn(result.output, [{ name: "SUPABASE_SECRET_KEY", value: localStack().key }])).toEqual([]);
}

const BAD_KEY = `set-state allows only these keys: ${ALLOWED_STATE_KEYS.join(", ")}.`;
const BAD_VALUE = "The value must be a date (YYYY-MM-DD) or an ISO time, such as 2026-11-20T10:00:00Z.";
const FUTURE = "The value is in the future. Give the time the login was authorized.";
const USAGE = `Usage: set-state <key> <value>\n  key: one of ${ALLOWED_STATE_KEYS.join(", ")}\n  value: a date (YYYY-MM-DD) or an ISO time, not in the future`;

describe("set-state: accepted values", () => {
  it("allows only spotify_authorized_at for now", () => {
    expect([...ALLOWED_STATE_KEYS]).toEqual([KEY]);
  });

  it("stores a date, prints only the key, and never the value", async () => {
    const value = day(-30);
    const before = Date.now();
    const result = runSetState([KEY, value]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Recorded ${KEY}.\n`);
    expect(result.stderr).toBe("");
    expect(result.output).not.toContain(value);
    const rows = await state();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: KEY, value });
    expect(Date.parse(rows[0]!.updated_at)).toBeGreaterThanOrEqual(before - 5000);
  });

  it("accepts today's date", async () => {
    const result = runSetState([KEY, day(0)]);
    expect(result.status).toBe(0);
    expect((await state())[0]).toMatchObject({ value: day(0) });
  });

  it.each([
    ["a UTC instant", "2026-11-20T10:00:00Z"],
    ["an instant with milliseconds", "2026-11-20T10:00:00.123Z"],
    ["an instant with an offset", "2026-11-20T10:00:00+02:00"],
    ["an instant with no seconds", "2026-11-20T10:00Z"],
  ])("accepts %s", async (_label, value) => {
    const result = runSetState([KEY, value]);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain(value);
    expect((await state())[0]).toMatchObject({ key: KEY, value });
  });

  it("accepts an instant a moment ago", async () => {
    const value = instant(-5);
    expect(runSetState([KEY, value]).status).toBe(0);
    expect((await state())[0]).toMatchObject({ value });
  });

  it("is idempotent: the same call twice leaves one row with the same value", async () => {
    const value = day(-10);
    expect(runSetState([KEY, value]).status).toBe(0);
    const first = (await state())[0]!;
    expect(runSetState([KEY, value]).status).toBe(0);
    const rows = await state();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: KEY, value });
    expect(Date.parse(rows[0]!.updated_at)).toBeGreaterThanOrEqual(Date.parse(first.updated_at));
  });

  it("replaces the value and moves updated_at when called with a new one", async () => {
    expect(runSetState([KEY, day(-60)]).status).toBe(0);
    const first = (await state())[0]!;
    expect(runSetState([KEY, day(-5)]).status).toBe(0);
    const rows = await state();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(day(-5));
    expect(Date.parse(rows[0]!.updated_at)).toBeGreaterThan(Date.parse(first.updated_at));
  });
});

describe("set-state: refused input", () => {
  it.each(["other_key", "SPOTIFY_AUTHORIZED_AT", "spotify_authorized_at ", "", "spotify-authorized-at", "x".repeat(65)])(
    "exits 2 for the key %j, stores nothing, and does not echo it",
    async (key) => {
      const result = runSetState([key, day(-1)]);
      expectRefused(result, BAD_KEY, key.length > 3 ? [key] : []);
      expect(await state()).toEqual([]);
    },
  );

  it.each([
    "tomorrow",
    "",
    " ",
    "2026-13-01",
    "2026-02-30",
    "2026-00-10",
    "2026-11-2",
    "20261120",
    "2026-11-20 10:00:00",
    "2026-11-20T25:00:00Z",
    "2026-11-20T10:61:00Z",
    "2026-11-20T10:00:00",
    "2026-11-20T10:00:00Zjunk",
    "2026-11-20\n",
    "1700000000",
    "SYNTH-SECRET-VALUE-0001",
    "2026-11-20;drop table poller_state",
    "2026-11-20T10:00:00Z".padEnd(250, "0"),
  ])("exits 2 for the value %j, stores nothing, and does not echo it", async (value) => {
    const result = runSetState([KEY, value]);
    expectRefused(result, BAD_VALUE, value.length > 3 ? [value.trim()] : []);
    expect(await state()).toEqual([]);
  });

  it("refuses a date in the future", async () => {
    const value = day(2);
    const result = runSetState([KEY, value]);
    expectRefused(result, FUTURE, [value]);
    expect(await state()).toEqual([]);
  });

  it("refuses an instant in the future", async () => {
    const value = instant(3600);
    const result = runSetState([KEY, value]);
    expectRefused(result, FUTURE, [value]);
    expect(await state()).toEqual([]);
  });

  it("refuses a far-future date", async () => {
    expectRefused(runSetState([KEY, "2099-01-01"]), FUTURE, ["2099"]);
    expect(await state()).toEqual([]);
  });

  it("leaves the stored value alone when a later call is refused", async () => {
    expect(runSetState([KEY, "2026-11-01"]).status).toBe(0);
    expectRefused(runSetState([KEY, day(3)]), FUTURE);
    expectRefused(runSetState([KEY, "nonsense"]), BAD_VALUE);
    expectRefused(runSetState(["other_key", "2026-11-02"]), BAD_KEY);
    expect((await state())[0]).toMatchObject({ key: KEY, value: "2026-11-01" });
  });

  it.each([[[]], [[KEY]], [[KEY, "2026-11-01", "extra"]]])("exits 2 with the usage for the arguments %j", async (args) => {
    const result = runSetState(args);
    expectRefused(result, USAGE);
    expect(await state()).toEqual([]);
  });
});

describe("set-state: setup and database", () => {
  it.each(["SUPABASE_URL", "SUPABASE_SECRET_KEY"])("exits 2 and names %s when it is not set", async (name) => {
    const result = runSetState([KEY, day(-1)], { [name]: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`${name} is not set.\n`);
    expect(await state()).toEqual([]);
  });

  it("exits 2 when SUPABASE_URL is plain http to another host", () => {
    const result = runSetState([KEY, day(-1)], { SUPABASE_URL: "http://example.com" });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SUPABASE_URL must start with https://, unless the host is localhost or 127.0.0.1.\n");
  });

  it("exits 1 with a plain message when the database cannot be reached, without the value or the key", async () => {
    const dead = await deadAddress();
    const value = day(-3);
    const result = runSetState([KEY, value], { SUPABASE_URL: dead });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^The database refused the state change \(code [A-Za-z0-9_]+\)\./);
    expect(result.output).not.toContain(value);
    expect(secretsFoundIn(result.output, [{ name: "SUPABASE_SECRET_KEY", value: localStack().key }])).toEqual([]);
    expect(await state()).toEqual([]);
  });

  it("exits 1 when the key is wrong, naming no secret", () => {
    const result = runSetState([KEY, day(-3)], { SUPABASE_SECRET_KEY: "synth-wrong-key-0001" });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("synth-wrong-key-0001");
  });
});
