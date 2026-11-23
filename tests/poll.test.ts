import { beforeEach, describe, expect, it } from "vitest";
import { DEDUPE_WINDOW_SECONDS } from "../src/settings.ts";
import { counts, runPoll, type CliResult } from "./support/cli.ts";
import { adminClient, localStack } from "./support/env.ts";
import {
  deadAddress,
  json,
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
const ROTATED_TOKEN = "SYNTH-ROTATED-TOKEN-0002";
const ACCESS_TOKEN = "SYNTH-ACCESS-TOKEN-0001";

const db = adminClient();

beforeEach(async () => {
  const { error } = await db.from("plays").delete().gt("id", 0);
  if (error) throw new Error(`Could not clear plays: ${error.code}`);
});

// Messages the command must print, exactly. Each is plain and holds no token, key or response text.
const MSG = {
  renew:
    "The Spotify login must be renewed: the refresh token is expired, revoked or invalid. Create a new one and update SPOTIFY_REFRESH_TOKEN.",
  client:
    "Spotify refused the app credentials. Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
  refused:
    "Spotify refused the request (HTTP 401). The Spotify login must be renewed, and it needs the user-read-recently-played scope.",
  refused403:
    "Spotify refused the request (HTTP 403). The Spotify login must be renewed, and it needs the user-read-recently-played scope.",
  limited: "Spotify is limiting requests (HTTP 429). Wait, then run the poll again.",
  limitedAfter42: "Spotify is limiting requests (HTTP 429). Wait, then run the poll again. Retry after 42 seconds.",
  notJson: "Spotify sent a response that is not valid JSON.",
  shape: "Spotify sent a response in a shape the poller does not know.",
  network: "Could not reach Spotify. Check the network, then run the poll again.",
  status500: "Spotify answered with an unexpected status (HTTP 500).",
  rotated:
    "warning: Spotify sent a new refresh token. Update SPOTIFY_REFRESH_TOKEN with the new value, because the old one may stop working.",
};

const tokenOk = (extra: Record<string, unknown> = {}): Answer =>
  json({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "user-read-recently-played", ...extra });

type Item = Record<string, unknown>;

/** One recently-played item, in the shape Spotify documents. `id` makes the track unique. */
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

type Scenario = { token?: Handler; recent?: Handler };

/** Runs the real command against the local database and a fake Spotify. */
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

/** Every secret the command holds. Their values must never appear in output. */
function secrets() {
  return [
    { name: "SPOTIFY_CLIENT_SECRET", value: CLIENT_SECRET },
    { name: "SPOTIFY_REFRESH_TOKEN", value: REFRESH_TOKEN },
    { name: "rotated refresh token", value: ROTATED_TOKEN },
    { name: "access token", value: ACCESS_TOKEN },
    { name: "SUPABASE_SECRET_KEY", value: localStack().key },
    { name: "base64 client login", value: Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") },
  ];
}

function expectNoSecrets(result: CliResult): void {
  expect(secretsFoundIn(result.output, secrets())).toEqual([]);
}

function expectFailure(result: CliResult, message: string): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${message}\n`);
  expectNoSecrets(result);
}

async function stored() {
  const { data, error } = await db.from("plays").select("*").order("ended_at").order("id");
  if (error) throw new Error(`Could not read plays: ${error.code}`);
  return data ?? [];
}

const ms = (iso: string) => Date.parse(iso);
const seconds = (iso: string, delta: number) => new Date(ms(iso) + delta * 1000).toISOString();

/** Puts one play from an export in the table, the way the importer would. */
async function seedExportPlay(id: number, endedAt: string): Promise<void> {
  const tag = String(id).padStart(12, "0");
  const { error } = await db.from("plays").insert({
    track_uri: `spotify:track:SYNTH${tag}`,
    track_name: `Synthetic Track ${id}`,
    artist_name: `Synthetic Artist ${id}`,
    album_name: `Synthetic Album ${id}`,
    ended_at: endedAt,
    ms_played: 200000,
    source: "export",
  });
  if (error) throw new Error(`Could not seed a play: ${error.code}`);
}

const T0 = "2026-11-20T10:00:00.000Z";

describe("poll: storing plays", () => {
  it("exchanges the refresh token, asks for 50 plays, and stores each new one", async () => {
    const items = [
      item(1, "2026-11-20T10:00:05.678Z"),
      item(2, "2026-11-20T10:04:09.001Z", { album: { name: "", artists: [{ name: "X" }] } }),
      item(3, "2026-11-20T10:08:00.999Z"),
    ];
    const { result, fake } = await poll({ recent: () => page(items) });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(counts(result.stdout)).toEqual({ fetched: 3, stored: 3, duplicate: 0, skipped: 0, no_track: 0, malformed: 0 });
    expect(result.stdout).toContain("possible_gap: false");

    // The token request follows the refresh-token page: form body, Basic login.
    expect(fake.tokenRequests).toHaveLength(1);
    const tokenRequest = fake.tokenRequests[0]!;
    const form = new URLSearchParams(tokenRequest.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(tokenRequest.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenRequest.headers.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );

    // The recently-played request: limit 50, a Bearer token, and no cursor on an empty table.
    expect(fake.recentRequests).toHaveLength(1);
    const recent = fake.recentRequests[0]!;
    expect(recent.query.get("limit")).toBe("50");
    expect(recent.query.has("after")).toBe(false);
    expect(recent.query.has("before")).toBe(false);
    expect(recent.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    const rows = await stored();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      track_uri: "spotify:track:SYNTH000000000001",
      track_name: "Synthetic Track 1",
      artist_name: "Synthetic Artist 1",
      album_name: "Synthetic Album 1",
      ms_played: null,
      source: "poll",
    });
    // played_at is cut to whole seconds, never rounded up.
    expect(new Date(rows[0]!.ended_at as string).toISOString()).toBe("2026-11-20T10:00:05.000Z");
    expect(new Date(rows[1]!.ended_at as string).toISOString()).toBe("2026-11-20T10:04:09.000Z");
    expect(new Date(rows[2]!.ended_at as string).toISOString()).toBe("2026-11-20T10:08:00.000Z");
    // An empty album name (a takedown) is stored as no album.
    expect(rows[1]!.album_name).toBeNull();
    expectNoSecrets(result);
  });

  it("stores nothing on a second run, and sends the latest stored end time as the cursor", async () => {
    const items = [item(1, "2026-11-20T10:00:05.678Z"), item(2, "2026-11-20T10:04:09.001Z")];
    const first = await poll({ recent: () => page(items) });
    expect(counts(first.result.stdout)).toMatchObject({ fetched: 2, stored: 2, duplicate: 0 });

    const second = await poll({ recent: () => page(items) });
    expect(second.result.status).toBe(0);
    expect(counts(second.result.stdout)).toMatchObject({ fetched: 2, stored: 0, duplicate: 2 });
    expect(await stored()).toHaveLength(2);
    // The cursor is the latest stored end time in milliseconds (whole seconds, as stored).
    expect(second.fake.recentRequests[0]!.query.get("after")).toBe(String(ms("2026-11-20T10:04:09.000Z")));
  });

  it("skips local files and anything that is not a track, and counts them by reason", async () => {
    const items = [
      item(1, "2026-11-20T10:00:00Z"),
      item(2, "2026-11-20T10:01:00Z", { is_local: true, uri: "spotify:local:Synthetic+Artist::Synthetic+Song::200" }),
      item(3, "2026-11-20T10:02:00Z", { type: "episode", uri: "spotify:episode:SYNTH000000000003" }),
      item(4, "2026-11-20T10:03:00Z", { uri: "spotify:artist:SYNTH000000000004" }),
      { track: null, played_at: "2026-11-20T10:04:00Z" },
      { played_at: "2026-11-20T10:05:00Z" },
    ];
    const { result } = await poll({ recent: () => page(items) });

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toEqual({ fetched: 6, stored: 1, duplicate: 0, skipped: 5, no_track: 5, malformed: 0 });
    expect(await stored()).toHaveLength(1);
  });

  it("skips an item with a missing or invalid field as malformed, and keeps going", async () => {
    const items = [
      item(1, "not a date"),
      item(2, "2026-11-20T10:01:00Z", { name: "" }),
      item(3, "2026-11-20T10:02:00Z", { artists: [] }),
      item(4, "2026-11-20T10:03:00Z", { name: "Bad \u0000 name" }),
      "not an object",
      item(5, "2026-11-20T10:04:00Z"),
    ];
    const { result } = await poll({ recent: () => page(items as Item[]) });

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toEqual({ fetched: 6, stored: 1, duplicate: 0, skipped: 5, no_track: 0, malformed: 5 });
    expect(await stored()).toHaveLength(1);
  });

  it("handles an empty page", async () => {
    const { result } = await poll({ recent: () => page([]) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toEqual({ fetched: 0, stored: 0, duplicate: 0, skipped: 0, no_track: 0, malformed: 0 });
  });

  it("stores a play that is the same twice in one answer only once", async () => {
    const items = [item(1, "2026-11-20T10:00:05.100Z"), item(1, "2026-11-20T10:00:05.900Z")];
    const { result } = await poll({ recent: () => page(items) });
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 1, duplicate: 1 });
    expect(await stored()).toHaveLength(1);
  });
});

describe("poll: matching plays already stored", () => {
  it("settings: the window is one named setting, 10 seconds by default", () => {
    expect(DEDUPE_WINDOW_SECONDS).toBe(10);
  });

  it("does not store a play already imported from an export, at the exact end time", async () => {
    await seedExportPlay(1, "2026-11-20T10:00:05Z");
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:05.678Z")]) });

    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 0, duplicate: 1 });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("export");
  });

  it("does not store a play already imported from an export, a few seconds off", async () => {
    await seedExportPlay(1, "2026-11-20T10:00:00Z");
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:05.678Z")]) });

    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 0, duplicate: 1 });
    expect(await stored()).toHaveLength(1);
  });

  it("honors the window at both edges: inside or on the edge is a repeat, one second beyond is new", async () => {
    const W = DEDUPE_WINDOW_SECONDS;
    // Four tracks, each stored by an export at T0. Each poll time is one edge case.
    for (const id of [1, 2, 3, 4]) await seedExportPlay(id, T0);
    const items = [
      item(1, seconds(T0, W)), // on the late edge: repeat
      item(2, seconds(T0, W + 1)), // just past the late edge: new
      item(3, seconds(T0, -W)), // on the early edge: repeat
      item(4, seconds(T0, -W - 1)), // just past the early edge: new
    ];
    const { result } = await poll({ recent: () => page(items) });

    expect(counts(result.stdout)).toMatchObject({ fetched: 4, stored: 2, duplicate: 2 });
    const polled = (await stored()).filter((row) => row.source === "poll");
    expect(polled.map((row) => row.track_uri).sort()).toEqual([
      "spotify:track:SYNTH000000000002",
      "spotify:track:SYNTH000000000004",
    ]);
  });

  it("matches only the same track: another track at the same time is stored", async () => {
    await seedExportPlay(1, T0);
    const { result } = await poll({ recent: () => page([item(2, T0)]) });
    expect(counts(result.stdout)).toMatchObject({ stored: 1, duplicate: 0 });
    expect(await stored()).toHaveLength(2);
  });
});

describe("poll: possible gap", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => item(index + 1, seconds("2026-11-20T10:00:00Z", index * 200)));

  it("prints possible_gap: true and exits 0 when exactly 50 plays come back", async () => {
    const { result } = await poll({ recent: () => page(many(50)) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ fetched: 50, stored: 50 });
    expect(result.stdout).toContain("possible_gap: true");
  });

  it("prints possible_gap: false for 49 plays", async () => {
    const { result } = await poll({ recent: () => page(many(49)) });
    expect(result.stdout).toContain("possible_gap: false");
    expect(result.stdout).not.toContain("possible_gap: true");
  });
});

describe("poll: failures are loud and plain", () => {
  it("exits 1 and says the login must be renewed when the refresh token is rejected (invalid_grant)", async () => {
    const { result, fake } = await poll({
      token: () => json({ error: "invalid_grant", error_description: `Refresh token revoked ${REFRESH_TOKEN}` }, 400),
    });
    expectFailure(result, MSG.renew);
    expect(fake.recentRequests).toHaveLength(0);
    expect(await stored()).toHaveLength(0);
  });

  it("exits 1 and names the app credentials when the client is rejected", async () => {
    const { result } = await poll({
      token: () => json({ error: "invalid_client", error_description: `Invalid client ${CLIENT_SECRET}` }, 401),
    });
    expectFailure(result, MSG.client);
  });

  it("exits 1 on a token answer with no access token, without echoing it", async () => {
    const { result } = await poll({ token: () => json({ token_type: "Bearer", refresh_token: ROTATED_TOKEN }) });
    expectFailure(result, MSG.shape);
  });

  it("exits 1 on 401 from recently-played, and never prints the response body", async () => {
    const { result } = await poll({
      recent: () => json({ error: { status: 401, message: `Invalid access token ${ACCESS_TOKEN}` } }, 401),
    });
    expectFailure(result, MSG.refused);
  });

  it("exits 1 on 403 from recently-played", async () => {
    const { result } = await poll({ recent: () => json({ error: { status: 403, message: ACCESS_TOKEN } }, 403) });
    expectFailure(result, MSG.refused403);
  });

  it("exits 1 on 429 with the retry hint when Spotify sends one", async () => {
    const { result } = await poll({ recent: () => json({ error: "slow down" }, 429, { "retry-after": "42" }) });
    expectFailure(result, MSG.limitedAfter42);
  });

  it("exits 1 on 429 with no hint to repeat when Spotify sends none or something odd", async () => {
    const none = await poll({ recent: () => json({}, 429) });
    expectFailure(none.result, MSG.limited);
    const odd = await poll({ recent: () => json({}, 429, { "retry-after": `soon ${ACCESS_TOKEN}` }) });
    expectFailure(odd.result, MSG.limited);
  });

  it("exits 1 on 429 from the token endpoint", async () => {
    const { result } = await poll({ token: () => json({}, 429, { "retry-after": "42" }) });
    expectFailure(result, MSG.limitedAfter42);
  });

  it("exits 1 on malformed JSON from recently-played", async () => {
    const { result } = await poll({ recent: () => ({ status: 200, body: `{"items": [ ${ACCESS_TOKEN}` }) });
    expectFailure(result, MSG.notJson);
  });

  it("exits 1 on malformed JSON from the token endpoint", async () => {
    const { result } = await poll({ token: () => ({ status: 200, body: `<html>${REFRESH_TOKEN}` }) });
    expectFailure(result, MSG.notJson);
  });

  it("exits 1 when the answer is JSON of the wrong shape", async () => {
    const { result } = await poll({ recent: () => json({ items: "nope" }) });
    expectFailure(result, MSG.shape);
    const nested = await poll({ recent: () => json([1, 2, 3]) });
    expectFailure(nested.result, MSG.shape);
  });

  it("exits 1 on any other status, without the body", async () => {
    const { result } = await poll({ recent: () => ({ status: 500, body: `oops ${ACCESS_TOKEN}` }) });
    expectFailure(result, MSG.status500);
  });

  it("exits 1 when Spotify cannot be reached", async () => {
    const dead = await deadAddress();
    const { result } = await poll({}, { SPOTIFY_ACCOUNTS_BASE: dead, SPOTIFY_API_BASE: dead });
    expectFailure(result, MSG.network);
  });

  it("exits 1 when the token works but the API address is dead", async () => {
    const dead = await deadAddress();
    const { result } = await poll({}, { SPOTIFY_API_BASE: dead });
    expectFailure(result, MSG.network);
  });

  it("exits 1 and stores nothing when the database refuses a write, naming no secret", async () => {
    const proxy = await startProxy(() => ({ status: 500, body: JSON.stringify({ message: CLIENT_SECRET, code: "XX000" }) }));
    try {
      const { result } = await poll(
        { recent: () => page([item(1, "2026-11-20T10:00:00Z")]) },
        { SUPABASE_URL: proxy.url },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("The database refused a batch");
      expectNoSecrets(result);
    } finally {
      await proxy.close();
    }
    expect(await stored()).toHaveLength(0);
  });
});

describe("poll: refresh token rotation", () => {
  it("warns, without printing any token, and carries on", async () => {
    const { result } = await poll({
      token: () => tokenOk({ refresh_token: ROTATED_TOKEN }),
      recent: () => page([item(1, "2026-11-20T10:00:00Z")]),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`${MSG.rotated}\n`);
    expect(counts(result.stdout)).toMatchObject({ stored: 1 });
    expectNoSecrets(result);
  });

  it("is quiet when the answer repeats the token already in use", async () => {
    const { result } = await poll({ token: () => tokenOk({ refresh_token: REFRESH_TOKEN }) });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("poll: no secret in any output", () => {
  it("keeps every token and key out of the output of a good run", async () => {
    const { result } = await poll({
      token: () => tokenOk({ refresh_token: ROTATED_TOKEN }),
      recent: () => page([item(1, "2026-11-20T10:00:00Z")]),
    });
    expect(result.output.length).toBeGreaterThan(0);
    expectNoSecrets(result);
  });

  it("keeps the report to counts: no track, artist or album name", async () => {
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z")]) });
    expect(result.output).not.toMatch(/Synthetic|SYNTH|spotify:/);
  });
});

describe("poll: two at once", () => {
  it("stores each play once when two polls run together", async () => {
    const items = Array.from({ length: 8 }, (_, index) => item(index + 1, seconds("2026-11-20T10:00:00Z", index * 200)));
    const fake = await startFakeSpotify({ token: () => tokenOk(), recent: () => page(items) });
    try {
      const env = {
        SPOTIFY_CLIENT_ID: CLIENT_ID,
        SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
        SPOTIFY_REFRESH_TOKEN: REFRESH_TOKEN,
        SPOTIFY_ACCOUNTS_BASE: fake.url,
        SPOTIFY_API_BASE: fake.url,
      };
      const [a, b] = await Promise.all([runPoll(env), runPoll(env)]);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      const storedByEach = counts(a.stdout).stored! + counts(b.stdout).stored!;
      expect(storedByEach).toBe(8);
      expect(counts(a.stdout).duplicate! + counts(b.stdout).duplicate!).toBe(8);
      const rows = await stored();
      expect(rows).toHaveLength(8);
      expect(new Set(rows.map((row) => row.track_uri)).size).toBe(8);
    } finally {
      await fake.close();
    }
  });
});

describe("poll: setup", () => {
  const goodEnv = (fake: string) => ({
    SPOTIFY_CLIENT_ID: CLIENT_ID,
    SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
    SPOTIFY_REFRESH_TOKEN: REFRESH_TOKEN,
    SPOTIFY_ACCOUNTS_BASE: fake,
    SPOTIFY_API_BASE: fake,
  });

  it.each(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY"])(
    "exits 2 and names %s when it is not set",
    async (name) => {
      const { result, fake } = await poll({}, { [name]: undefined });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(`${name} is not set.\n`);
      expect(fake.tokenRequests).toHaveLength(0);
    },
  );

  it.each(["SPOTIFY_ACCOUNTS_BASE", "SPOTIFY_API_BASE"])(
    "exits 2 before sending anything when %s is plain http to another host",
    async (name) => {
      const { result, fake } = await poll({}, { [name]: "http://example.com" });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(`${name} must start with https://, unless the host is localhost or 127.0.0.1.\n`);
      expect(fake.tokenRequests).toHaveLength(0);
      expect(fake.recentRequests).toHaveLength(0);
      expectNoSecrets(result);
    },
  );

  it("exits 2 when SUPABASE_URL is plain http to another host", async () => {
    const { result } = await poll({}, { SUPABASE_URL: "http://example.com" });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SUPABASE_URL must start with https://, unless the host is localhost or 127.0.0.1.\n");
  });

  it("exits 2 on an address that does not parse, without quoting it", async () => {
    const { result } = await poll({}, { SPOTIFY_API_BASE: `not a url ${CLIENT_SECRET}` });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SPOTIFY_API_BASE is not a valid address.\n");
  });

  it("refuses extra words after the command", async () => {
    const fake2 = await startFakeSpotify({ token: () => tokenOk(), recent: () => page([]) });
    try {
      const extra = await runPoll(goodEnv(fake2.url), ["unexpected"]);
      expect(extra.status).toBe(2);
      expect(extra.stderr).toContain("Usage: poll");
      expect(fake2.tokenRequests).toHaveLength(0);
    } finally {
      await fake2.close();
    }
  });
});
