import { beforeEach, describe, expect, it } from "vitest";
import { POLL_LIMIT, POLL_MAX_PAGES, POLLER_RUNS_KEEP_DAYS } from "../src/settings.ts";
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

const db = adminClient();

beforeEach(async () => {
  for (const table of ["plays", "poller_runs"]) {
    const { error } = await db.from(table).delete().gt("id", 0);
    if (error) throw new Error(`Could not clear ${table}: ${error.code}`);
  }
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
      name: "Spotify answers with an unexpected status",
      scenario: { recent: () => ({ status: 500, body: `oops ${ACCESS_TOKEN}` }) },
      kind: "other",
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

  it("writes kind other when Spotify gives no older page to go back to", async () => {
    const same = Array.from({ length: POLL_LIMIT }, (_, index) => item(index + 1, seconds("2026-11-20T08:00:00Z", index * 100)));
    const { result } = await poll({ recent: () => page(same) });
    expect(result.status).toBe(1);
    expect(await onlyRun(result)).toMatchObject({ outcome: "failed", failure_kind: "other", fetched: POLL_LIMIT, stored: POLL_LIMIT });
  });

  it("writes kind other, with the counts so far, when the database refuses a batch of plays", async () => {
    const proxy = await startProxy(() => ({ status: 500, body: JSON.stringify({ message: CLIENT_SECRET, code: "XX000" }) }));
    try {
      const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z")]) }, { SUPABASE_URL: proxy.url });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("The database refused a batch");
      expect(result.stderr).not.toContain("::warning::");
      expect(await onlyRun(result)).toMatchObject({ outcome: "failed", failure_kind: "other", fetched: 1, stored: 0 });
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
  async function seedRun(daysAgo: number): Promise<number> {
    const finished = new Date(Date.now() - daysAgo * DAY_MS);
    const { data, error } = await db
      .from("poller_runs")
      .insert({
        started_at: new Date(finished.getTime() - 1000).toISOString(),
        finished_at: finished.toISOString(),
        outcome: "ok",
        fetched: 1,
        stored: 1,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Could not seed a run: ${error?.code}`);
    return (data as { id: number }).id;
  }

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
    const old = await seedRun(POLLER_RUNS_KEEP_DAYS + 5);
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
