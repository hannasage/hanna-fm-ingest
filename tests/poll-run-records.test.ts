import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK_SKEW_TOLERANCE_MS, LOGIN_WARN_DAYS, POLL_LIMIT, POLL_MAX_PAGES, POLLER_RUNS_KEEP_DAYS } from "../src/settings.ts";
import { counts, runPoll, type CliResult } from "./support/cli.ts";
import { adminClient, localStack } from "./support/env.ts";
import {
  deadAddress,
  json,
  recentFrom,
  startFakeSpotify,
  type Answer,
  type FakeSpotify,
  type Handler,
} from "./support/fake-spotify.ts";
import { secretsFoundIn } from "./support/leaks.ts";
import { startProxy } from "./support/proxy.ts";

// Synthetic values only. Nothing here is a real credential, track or listening record.
const CLIENT_ID = "synth-client-id-0001";
const CLIENT_SECRET = "synth-client-secret-0001";
const REFRESH_TOKEN = "SYNTH-REFRESH-TOKEN-0001";
const ACCESS_TOKEN = "SYNTH-ACCESS-TOKEN-0001";

const WARNING = "::warning::could not record the poll run";
const PRUNE_WARNING = "::warning::could not delete old poll run records";
const KIND_PATTERN = /^[a-z0-9_]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_RECORDED = "::warning::Spotify login date is not recorded. Run set-state spotify_authorized_at <date>.";
const loginOld = (days: number) => `::warning::Spotify login is ${days} days old. Re-authorize it before day 180.`;

const db = adminClient();

/** A login date that many whole days old, plus a minute, so a slow run cannot tip it into the day before. */
const authorizedDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS - 60_000).toISOString();

async function setAuthorized(value: string | null): Promise<void> {
  const cleared = await db.from("poller_state").delete().neq("key", "");
  if (cleared.error) throw new Error(`Could not clear poller_state: ${cleared.error.code}`);
  if (value === null) return;
  const { error } = await db.from("poller_state").insert({ key: "spotify_authorized_at", value });
  if (error) throw new Error(`Could not seed poller_state: ${error.code}`);
}

beforeEach(async () => {
  for (const table of ["plays", "poller_runs"]) {
    const { error } = await db.from(table).delete().gt("id", 0);
    if (error) throw new Error(`Could not clear ${table}: ${error.code}`);
  }
  // A recent login date by default, so the login reminder stays quiet unless a test is about it.
  await setAuthorized(authorizedDaysAgo(1));
});

const tokenOk = (): Answer =>
  json({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "user-read-recently-played" });

type Item = Record<string, unknown>;

function item(id: number, playedAt: string, trackOver: Record<string, unknown> = {}): Item {
  const tag = String(id).padStart(12, "0");
  return {
    track: {
      album: { name: `Synthetic Album ${id}`, type: "album", uri: `spotify:album:SYNTHALB${tag}`, artists: [{ name: "Synthetic Album Artist" }] },
      artists: [{ name: `Synthetic Artist ${id}`, uri: `spotify:artist:SYNTHART${tag}` }],
      name: `Synthetic Track ${id}`,
      type: "track",
      uri: `spotify:track:SYNTH${tag}`,
      is_local: false,
      ...trackOver,
    },
    played_at: playedAt,
    context: null,
  };
}

const page = (items: Item[]): Answer => json({ href: "https://synthetic.invalid/page", limit: 50, next: null, cursors: null, items });

const seconds = (iso: string, delta: number) => new Date(Date.parse(iso) + delta * 1000).toISOString();

type Scenario = { token?: Handler; recent?: Handler };

async function poll(
  scenario: Scenario,
  env: Record<string, string | undefined> = {},
): Promise<{ result: CliResult; fake: FakeSpotify }> {
  const fake = await startFakeSpotify({
    token: scenario.token ?? (() => tokenOk()),
    recent: scenario.recent ?? (() => page([])),
  });
  try {
    const result = await runPoll({
      SPOTIFY_CLIENT_ID: CLIENT_ID,
      SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
      SPOTIFY_REFRESH_TOKEN: REFRESH_TOKEN,
      SPOTIFY_ACCOUNTS_BASE: fake.url,
      SPOTIFY_API_BASE: fake.url,
      ...env,
    });
    return { result, fake };
  } finally {
    await fake.close();
  }
}

function secrets() {
  return [
    { name: "SPOTIFY_CLIENT_SECRET", value: CLIENT_SECRET },
    { name: "SPOTIFY_REFRESH_TOKEN", value: REFRESH_TOKEN },
    { name: "access token", value: ACCESS_TOKEN },
    { name: "SUPABASE_SECRET_KEY", value: localStack().key },
    { name: "base64 client login", value: Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") },
  ];
}

type RunRow = {
  id: number;
  started_at: string;
  finished_at: string;
  outcome: string;
  fetched: number | null;
  stored: number | null;
  failure_kind: string | null;
  created_at: string;
};

async function runs(): Promise<RunRow[]> {
  const { data, error } = await db.from("poller_runs").select("*").order("id");
  if (error) throw new Error(`Could not read poller_runs: ${error.code}`);
  return (data ?? []) as RunRow[];
}

/** The one row a run must have written. Also checks the row and the output hold no secret. */
async function onlyRun(result: CliResult): Promise<RunRow> {
  const rows = await runs();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(secretsFoundIn(JSON.stringify(row), secrets())).toEqual([]);
  expect(secretsFoundIn(result.output, secrets())).toEqual([]);
  expect(Date.parse(row.finished_at)).toBeGreaterThanOrEqual(Date.parse(row.started_at));
  if (row.failure_kind !== null) expect(row.failure_kind).toMatch(KIND_PATTERN);
  return row;
}

describe("poll run records: a run that finished ok", () => {
  it("writes one ok row with the fetched and stored counts, and no failure kind", async () => {
    const before = Date.now();
    const { result } = await poll({
      recent: () => page([item(1, "2026-11-20T10:00:00Z"), item(2, "2026-11-20T10:04:00Z"), item(3, "2026-11-20T10:08:00Z")]),
    });
    const after = Date.now();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const row = await onlyRun(result);
    expect(row).toMatchObject({ outcome: "ok", fetched: 3, stored: 3, failure_kind: null });
    // Times come from the run's own clock, so they sit inside the window the test measured.
    expect(Date.parse(row.started_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(row.finished_at)).toBeLessThanOrEqual(after + 1000);
  });

  it("counts a repeat as fetched but not stored", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z"), item(2, "2026-11-20T10:04:00Z")];
    await poll({ recent: () => page(items) });
    const again = await poll({ recent: () => page([...items, item(3, "2026-11-20T10:08:00Z")]) });

    expect(again.result.status).toBe(0);
    const rows = await runs();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: "ok", fetched: 3, stored: 1, failure_kind: null });
  });

  it("writes an ok row with zero stored when every play is a repeat, and exits 0", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z"), item(2, "2026-11-20T10:04:00Z")];
    await poll({ recent: () => page(items) });
    const again = await poll({ recent: () => page(items) });

    expect(again.result.status).toBe(0);
    const rows = await runs();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: "ok", fetched: 2, stored: 0, failure_kind: null });
  });

  it("writes an ok row with zero counts for a quiet window", async () => {
    const { result } = await poll({ recent: () => page([]) });
    expect(result.status).toBe(0);
    expect(await onlyRun(result)).toMatchObject({ outcome: "ok", fetched: 0, stored: 0, failure_kind: null });
  });

  it("writes an ok row for a window of only local files and episodes, which exits 0", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z", { is_local: true }), item(2, "2026-11-20T10:01:00Z", { type: "episode" })];
    const { result } = await poll({ recent: () => page(items) });
    expect(result.status).toBe(0);
    expect(await onlyRun(result)).toMatchObject({ outcome: "ok", fetched: 2, stored: 0, failure_kind: null });
  });

  it("writes one row per run, so two runs make two rows", async () => {
    await poll({});
    await poll({});
    expect(await runs()).toHaveLength(2);
  });

  it("prints nothing extra: the report and the notes are as before", async () => {
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z")]) });
    expect(result.stderr).toBe("");
    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 1 });
    expect(result.stdout).not.toMatch(/poller_runs|outcome|failure_kind/);
  });
});

describe("poll run records: a run that failed", () => {
  const inFuture = (secondsAhead: number) => new Date(Date.now() + secondsAhead * 1000).toISOString();

  // Each case: what Spotify does, the kind the row must carry, and the counts (null when the run never got a page).
  const cases: {
    name: string;
    scenario: Scenario;
    env?: () => Promise<Record<string, string>>;
    kind: string;
    fetched: number | null;
    stored: number | null;
  }[] = [
    {
      name: "the login is expired (invalid_grant)",
      scenario: { token: () => json({ error: "invalid_grant", error_description: `revoked ${REFRESH_TOKEN}` }, 400) },
      kind: "login_expired",
      fetched: null,
      stored: null,
    },
    {
      name: "the token call refuses the app (401 invalid_client)",
      scenario: { token: () => json({ error: "invalid_client" }, 401) },
      kind: "forbidden",
      fetched: null,
      stored: null,
    },
    {
      name: "recently-played says 401",
      scenario: { recent: () => json({ error: { status: 401, message: ACCESS_TOKEN } }, 401) },
      kind: "forbidden",
      fetched: null,
      stored: null,
    },
    {
      name: "recently-played says 403",
      scenario: { recent: () => json({ error: { status: 403, message: ACCESS_TOKEN } }, 403) },
      kind: "forbidden",
      fetched: null,
      stored: null,
    },
    {
      name: "recently-played says 429",
      scenario: { recent: () => json({}, 429, { "retry-after": "42" }) },
      kind: "rate_limited",
      fetched: null,
      stored: null,
    },
    {
      name: "the token call says 429",
      scenario: { token: () => json({}, 429) },
      kind: "rate_limited",
      fetched: null,
      stored: null,
    },
    {
      name: "recently-played sends malformed JSON",
      scenario: { recent: () => ({ status: 200, body: `{"items": [ ${ACCESS_TOKEN}` }) },
      kind: "bad_response",
      fetched: null,
      stored: null,
    },
    {
      name: "the token answer is not JSON",
      scenario: { token: () => ({ status: 200, body: `<html>${REFRESH_TOKEN}` }) },
      kind: "bad_response",
      fetched: null,
      stored: null,
    },
    {
      name: "the answer has the wrong shape",
      scenario: { recent: () => json({ items: "nope" }) },
      kind: "bad_response",
      fetched: null,
      stored: null,
    },
    {
      name: "a page holds more than 50 items",
      scenario: {
        recent: () => page(Array.from({ length: POLL_LIMIT + 1 }, (_, index) => item(index + 1, seconds("2026-11-20T10:00:00Z", index * 200)))),
      },
      kind: "bad_response",
      fetched: null,
      stored: null,
    },
    {
      name: "Spotify cannot be reached (dead address)",
      scenario: {},
      env: async () => {
        const dead = await deadAddress();
        return { SPOTIFY_ACCOUNTS_BASE: dead, SPOTIFY_API_BASE: dead };
      },
      kind: "network",
      fetched: null,
      stored: null,
    },
    {
      name: "Spotify answers 500",
      scenario: { recent: () => ({ status: 500, body: `oops ${ACCESS_TOKEN}` }) },
      kind: "spotify_unavailable",
      fetched: null,
      stored: null,
    },
    {
      name: "Spotify answers 503",
      scenario: { recent: () => ({ status: 503, body: "" }) },
      kind: "spotify_unavailable",
      fetched: null,
      stored: null,
    },
    {
      name: "Spotify answers an unexpected 4xx",
      scenario: { recent: () => ({ status: 418, body: "" }) },
      kind: "spotify_unavailable",
      fetched: null,
      stored: null,
    },
    {
      name: "the token call answers 500",
      scenario: { token: () => ({ status: 500, body: `oops ${REFRESH_TOKEN}` }) },
      kind: "spotify_unavailable",
      fetched: null,
      stored: null,
    },
    {
      name: "the token call answers an unexpected 400 that is not invalid_grant",
      scenario: { token: () => json({ error: "unsupported_grant_type" }, 400) },
      kind: "spotify_unavailable",
      fetched: null,
      stored: null,
    },
    {
      name: "an item is malformed among good ones",
      scenario: { recent: () => page([item(1, "2026-11-20T10:00:00Z"), item(2, "not a date")]) },
      kind: "malformed_items",
      fetched: 2,
      stored: 1,
    },
    {
      name: "every item is malformed",
      scenario: { recent: () => page([item(1, "not a date"), item(2, "also not a date")]) },
      kind: "malformed_items",
      fetched: 2,
      stored: 0,
    },
    {
      name: "the poll reaches the page cap",
      scenario: {
        recent: recentFrom(
          Array.from({ length: POLL_MAX_PAGES * POLL_LIMIT + 50 }, (_, index) => item(index + 1, seconds("2026-11-20T08:00:00Z", index * 100))),
        ),
      },
      kind: "page_cap",
      fetched: POLL_MAX_PAGES * POLL_LIMIT,
      stored: POLL_MAX_PAGES * POLL_LIMIT,
    },
  ];

  it.each(cases)("writes a failed row with the right kind when $name", async ({ scenario, env, kind, fetched, stored }) => {
    const { result } = await poll(scenario, env ? await env() : {});
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("::warning::could not");
    const row = await onlyRun(result);
    expect(row).toMatchObject({ outcome: "failed", failure_kind: kind, fetched, stored });
  });

  it("writes a failed row with kind future_cursor when the newest stored play is ahead of the clock", async () => {
    const { error } = await db.from("plays").insert({
      track_uri: "spotify:track:SYNTH000000000001",
      track_name: "Synthetic Track 1",
      artist_name: "Synthetic Artist 1",
      album_name: "Synthetic Album 1",
      ended_at: inFuture(3600),
      ms_played: 200000,
      source: "export",
    });
    expect(error).toBeNull();
    const { result, fake } = await poll({});
    expect(result.status).toBe(1);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await onlyRun(result)).toMatchObject({ outcome: "failed", failure_kind: "future_cursor", fetched: null, stored: null });
  });

  it("writes kind stalled when Spotify gives no older page to go back to", async () => {
    const same = Array.from({ length: POLL_LIMIT }, (_, index) => item(index + 1, seconds("2026-11-20T08:00:00Z", index * 100)));
    const { result } = await poll({ recent: () => page(same) });
    expect(result.status).toBe(1);
    expect(await onlyRun(result)).toMatchObject({ outcome: "failed", failure_kind: "stalled", fetched: POLL_LIMIT, stored: POLL_LIMIT });
  });

  it("writes kind database_error when the database refuses a read of the plays", async () => {
    const proxy = await startProxy(() => ({ status: 500, body: JSON.stringify({ message: CLIENT_SECRET, code: "XX000" }) }), {
      table: "plays",
      methods: ["GET"],
    });
    try {
      const { result, fake } = await poll({}, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(1);
      expect(fake.tokenRequests).toHaveLength(0);
      expect(result.stderr).toContain("The database refused a read");
      expect(await onlyRun(result)).toMatchObject({ outcome: "failed", failure_kind: "database_error", fetched: null, stored: null });
    } finally {
      await proxy.close();
    }
  });

  it("writes kind database_error, with the counts so far, when the database refuses a batch of plays", async () => {
    const proxy = await startProxy(() => ({ status: 500, body: JSON.stringify({ message: CLIENT_SECRET, code: "XX000" }) }));
    try {
      const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z")]) }, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("The database refused a batch");
      expect(result.stderr).not.toContain("::warning::");
      expect(await onlyRun(result)).toMatchObject({ outcome: "failed", failure_kind: "database_error", fetched: 1, stored: 0 });
    } finally {
      await proxy.close();
    }
  });

  it("keeps the original messages and adds nothing to them", async () => {
    const { result } = await poll({ recent: () => json({ error: { status: 403 } }, 403) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Spotify refused the request (HTTP 403). The Spotify login must be renewed, and it needs the user-read-recently-played scope.\n",
    );
  });
});

describe("poll run records: nothing to write", () => {
  it.each(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY"])(
    "writes nothing and exits 2 when %s is not set",
    async (name) => {
      const { result } = await poll({}, { [name]: undefined });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(`${name} is not set.\n`);
      expect(await runs()).toEqual([]);
    },
  );

  it("writes nothing and exits 2 on a Spotify address the poll refuses", async () => {
    const { result } = await poll({}, { SPOTIFY_API_BASE: "http://example.com" });
    expect(result.status).toBe(2);
    expect(await runs()).toEqual([]);
  });

  it("writes nothing and keeps exit 1 when the database cannot be reached, without leaking a secret", async () => {
    const dead = await deadAddress();
    const { result, fake } = await poll({}, { SUPABASE_URL: dead });
    expect(result.status).toBe(1);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(result.stderr).toContain("The database refused a read");
    expect(result.stderr).not.toContain("Spotify login");
    expect(secretsFoundIn(result.output, secrets())).toEqual([]);
    expect(await runs()).toEqual([]);
  });
});

describe("poll run records: a record that cannot be written", () => {
  const refuseInserts = (): Promise<Awaited<ReturnType<typeof startProxy>>> =>
    startProxy(() => ({ status: 500, body: JSON.stringify({ message: `${CLIENT_SECRET} ${localStack().key}`, code: "XX000" }) }), {
      table: "poller_runs",
    });

  it("keeps exit 0 for an ok run and prints only the warning", async () => {
    const proxy = await refuseInserts();
    try {
      const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z")]) }, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe(`${WARNING}\n`);
      expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 1 });
      expect(secretsFoundIn(result.output, secrets())).toEqual([]);
      expect(proxy.writes()).toBe(1);
    } finally {
      await proxy.close();
    }
    expect(await runs()).toEqual([]);
  });

  it("keeps exit 1 for a failed run, with its own message first and then the warning", async () => {
    const proxy = await refuseInserts();
    try {
      const { result } = await poll({ recent: () => json({ error: { status: 403 } }, 403) }, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `Spotify refused the request (HTTP 403). The Spotify login must be renewed, and it needs the user-read-recently-played scope.\n${WARNING}\n`,
      );
      expect(secretsFoundIn(result.output, secrets())).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("keeps exit 1 for a run that finished with a problem, after its error annotation", async () => {
    const proxy = await refuseInserts();
    try {
      const { result } = await poll(
        { recent: () => page([item(1, "2026-11-20T10:00:00Z"), item(2, "not a date")]) },
        { SUPABASE_URL: proxy.url },
      );
      expect(result.status).toBe(1);
      const lines = result.stderr.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^::error::1 item from Spotify could not be read/);
      expect(lines[lines.length - 1]).toBe(WARNING);
      expect(lines).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it("treats an answer that is not JSON as a failure to record, never a crash", async () => {
    const proxy = await startProxy(() => ({ status: 404, body: "not json" }), { table: "poller_runs" });
    try {
      const { result } = await poll({}, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe(`${WARNING}\n`);
    } finally {
      await proxy.close();
    }
  });

  it("keeps exit 1 and adds the warning when the record gets a 503 after a failed run", async () => {
    const proxy = await startProxy(() => ({ status: 503, body: "" }), { table: "poller_runs" });
    try {
      const { result } = await poll({ recent: () => ({ status: 500, body: "x" }) }, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(WARNING);
    } finally {
      await proxy.close();
    }
  });
});

describe(`poll run records: deleting rows older than ${POLLER_RUNS_KEEP_DAYS} days`, () => {
  /** A stored run that finished that many days ago. `minutesAhead` puts it in the runner's future instead. */
  async function seedRun(daysAgo: number, outcome: "ok" | "failed" = "ok", minutesAhead = 0): Promise<number> {
    const finished = new Date(Date.now() - daysAgo * DAY_MS + minutesAhead * 60_000);
    const { data, error } = await db
      .from("poller_runs")
      .insert({
        started_at: new Date(finished.getTime() - 1000).toISOString(),
        finished_at: finished.toISOString(),
        outcome,
        fetched: outcome === "ok" ? 1 : null,
        stored: outcome === "ok" ? 1 : null,
        failure_kind: outcome === "ok" ? null : "network",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Could not seed a run: ${error?.code}`);
    return (data as { id: number }).id;
  }

  const ids = async () => (await runs()).map((row) => row.id);

  it("is a named setting of 90 days", () => {
    expect(POLLER_RUNS_KEEP_DAYS).toBe(90);
  });

  it("deletes only the rows older than the setting, and keeps the new one", async () => {
    const old1 = await seedRun(POLLER_RUNS_KEEP_DAYS + 1);
    const old2 = await seedRun(POLLER_RUNS_KEEP_DAYS + 200);
    const young1 = await seedRun(POLLER_RUNS_KEEP_DAYS - 1);
    const young2 = await seedRun(0);

    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const ids = (await runs()).map((row) => row.id);
    expect(ids).not.toContain(old1);
    expect(ids).not.toContain(old2);
    expect(ids).toContain(young1);
    expect(ids).toContain(young2);
    expect(ids).toHaveLength(3);
  });

  it("also runs at the end of a failed run", async () => {
    const old = await seedRun(POLLER_RUNS_KEEP_DAYS + 5, "failed");
    const { result } = await poll({ recent: () => json({}, 429) });
    expect(result.status).toBe(1);
    const rows = await runs();
    expect(rows.map((row) => row.id)).not.toContain(old);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", failure_kind: "rate_limited" });
  });

  it("leaves the poller_state rows and the plays alone", async () => {
    await seedRun(POLLER_RUNS_KEEP_DAYS + 5);
    const state = await db.from("poller_state").upsert({ key: "spotify_authorized_at", value: "2026-01-01" });
    expect(state.error).toBeNull();
    try {
      await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z")]) });
      const { data } = await db.from("poller_state").select("key");
      expect(data).toEqual([{ key: "spotify_authorized_at" }]);
      const plays = await db.from("plays").select("id");
      expect(plays.data).toHaveLength(1);
    } finally {
      await db.from("poller_state").delete().eq("key", "spotify_authorized_at");
    }
  });

  it("is a named clock tolerance of 5 minutes", () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });

  it("keeps the newest ok row however old, when the new run is a failure", async () => {
    // A 91-day outage: the last good run is older than the limit. The site still needs it for its last-success time.
    const newestOk = await seedRun(POLLER_RUNS_KEEP_DAYS + 1, "ok");
    const olderOk = await seedRun(POLLER_RUNS_KEEP_DAYS + 40, "ok");
    const olderFailed = await seedRun(POLLER_RUNS_KEEP_DAYS + 60, "failed");

    const { result } = await poll({ recent: () => json({}, 429) });
    expect(result.status).toBe(1);

    const left = await ids();
    expect(left).toContain(newestOk);
    expect(left).not.toContain(olderOk);
    expect(left).not.toContain(olderFailed);
    expect(left).toHaveLength(2);
  });

  it("keeps the newest failed row however old, when the new run is ok", async () => {
    const newestFailed = await seedRun(POLLER_RUNS_KEEP_DAYS + 1, "failed");
    const olderFailed = await seedRun(POLLER_RUNS_KEEP_DAYS + 40, "failed");
    const olderOk = await seedRun(POLLER_RUNS_KEEP_DAYS + 60, "ok");

    const { result } = await poll({});
    expect(result.status).toBe(0);

    const left = await ids();
    expect(left).toContain(newestFailed);
    expect(left).not.toContain(olderFailed);
    expect(left).not.toContain(olderOk);
    expect(left).toHaveLength(2);
  });

  it("keeps both newest rows, an ok one and a failed one, after a 91-day outage", async () => {
    const ok = await seedRun(POLLER_RUNS_KEEP_DAYS + 1, "ok");
    const failed = await seedRun(POLLER_RUNS_KEEP_DAYS + 2, "failed");
    const oldOk = await seedRun(POLLER_RUNS_KEEP_DAYS + 3, "ok");
    const oldFailed = await seedRun(POLLER_RUNS_KEEP_DAYS + 4, "failed");

    // The new run is ok, so it is the newest ok row. Then the 91-day-old ok row is plain old data.
    const { result } = await poll({});
    expect(result.status).toBe(0);

    const left = await ids();
    expect(left).toContain(failed);
    expect(left).not.toContain(ok);
    expect(left).not.toContain(oldOk);
    expect(left).not.toContain(oldFailed);
    expect(left).toHaveLength(2);
  });

  it("skips the delete when the runner clock is more than 5 minutes behind the newest row", async () => {
    // A row finished 10 minutes ahead of this run's clock: the clock is behind, so the cutoff cannot be trusted.
    const ahead = await seedRun(0, "ok", 10);
    const old = await seedRun(POLLER_RUNS_KEEP_DAYS + 30, "ok");

    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const left = await ids();
    expect(left).toContain(ahead);
    expect(left).toContain(old);
    expect(left).toHaveLength(3);
  });

  it("still deletes when the newest row is only a little ahead, inside the 5 minute tolerance", async () => {
    const ahead = await seedRun(0, "ok", 2);
    const old = await seedRun(POLLER_RUNS_KEEP_DAYS + 30, "ok");

    const { result } = await poll({});
    expect(result.status).toBe(0);

    const left = await ids();
    expect(left).toContain(ahead);
    expect(left).not.toContain(old);
  });

  it("warns, and keeps the exit code, when the delete fails", async () => {
    const proxy = await startProxy(() => ({ status: 500, body: JSON.stringify({ message: CLIENT_SECRET }) }), {
      table: "poller_runs",
      methods: ["DELETE"],
    });
    try {
      const { result } = await poll({}, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe(`${PRUNE_WARNING}\n`);
      expect(secretsFoundIn(result.output, secrets())).toEqual([]);
    } finally {
      await proxy.close();
    }
    expect(await runs()).toHaveLength(1);
  });
});

describe(`poll run records: the login reminder (warns from ${LOGIN_WARN_DAYS} days)`, () => {
  it("is a named setting of 150 days", () => {
    expect(LOGIN_WARN_DAYS).toBe(150);
  });

  it("warns that the date is not recorded when the key is absent, and keeps exit 0", async () => {
    await setAuthorized(null);
    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`${NOT_RECORDED}\n`);
    expect(await runs()).toHaveLength(1);
  });

  it("is silent when the login is one day under the limit", async () => {
    await setAuthorized(authorizedDaysAgo(LOGIN_WARN_DAYS - 1));
    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("warns, with the whole days, when the login is exactly the limit old", async () => {
    await setAuthorized(authorizedDaysAgo(LOGIN_WARN_DAYS));
    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`${loginOld(LOGIN_WARN_DAYS)}\n`);
  });

  it("warns with the real age when the login is older still", async () => {
    await setAuthorized(authorizedDaysAgo(171));
    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`${loginOld(171)}\n`);
  });

  it("reads a plain date as the start of that day in UTC", async () => {
    const day = new Date(Date.now() - 160 * DAY_MS).toISOString().slice(0, 10);
    await setAuthorized(day);
    const { result } = await poll({});
    expect(result.stderr).toMatch(/^::warning::Spotify login is 160 days old\. Re-authorize it before day 180\.\n$/);
  });

  it("warns that the date is not recorded when the stored value is not a date", async () => {
    await setAuthorized("not a date");
    const { result } = await poll({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`${NOT_RECORDED}\n`);
  });

  it("is silent when the stored date is in the future", async () => {
    await setAuthorized(new Date(Date.now() + 3 * DAY_MS).toISOString());
    const { result } = await poll({});
    expect(result.stderr).toBe("");
  });

  it("never prints the stored value or a secret", async () => {
    const value = authorizedDaysAgo(160);
    await setAuthorized(value);
    const { result } = await poll({});
    expect(result.stderr).toBe(`${loginOld(160)}\n`);
    expect(result.output).not.toContain(value);
    expect(result.output).not.toContain(value.slice(0, 10));
    expect(secretsFoundIn(result.output, secrets())).toEqual([]);
  });

  it("also warns at the end of a failed run, and keeps exit 1", async () => {
    await setAuthorized(authorizedDaysAgo(155));
    const { result } = await poll({ recent: () => json({}, 429) });
    expect(result.status).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^Spotify is limiting requests/);
    expect(lines[lines.length - 1]).toBe(loginOld(155));
  });

  it("also warns at the end of a run that finished with a problem, after the error annotation", async () => {
    await setAuthorized(null);
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z"), item(2, "not a date")]) });
    expect(result.status).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^::error::/);
    expect(lines[lines.length - 1]).toBe(NOT_RECORDED);
  });

  it("prints nothing and changes nothing when the read fails", async () => {
    await setAuthorized(null);
    const proxy = await startProxy(() => ({ status: 500, body: JSON.stringify({ message: CLIENT_SECRET, code: "XX000" }) }), {
      table: "poller_state",
      methods: ["GET"],
    });
    try {
      const { result } = await poll({}, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(secretsFoundIn(result.output, secrets())).toEqual([]);
    } finally {
      await proxy.close();
    }
    expect(await runs()).toHaveLength(1);
    const state = await db.from("poller_state").select("key");
    expect(state.data).toEqual([]);
  });

  it("prints nothing when the read answers with something that is not JSON", async () => {
    const proxy = await startProxy(() => ({ status: 200, body: "not json" }), { table: "poller_state", methods: ["GET"] });
    try {
      const { result } = await poll({}, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      await proxy.close();
    }
  });

  it("does not run when a setting is missing (exit 2)", async () => {
    await setAuthorized(null);
    const { result } = await poll({}, { SPOTIFY_CLIENT_ID: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SPOTIFY_CLIENT_ID is not set.\n");
  });
});
