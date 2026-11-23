import { beforeEach, describe, expect, it } from "vitest";
import { DEDUPE_WINDOW_SECONDS, POLL_LIMIT, POLL_MAX_PAGES } from "../src/settings.ts";
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
  rotated: "::warning::Spotify issued a new refresh token. Re-authorize and store the new token.",
  someMalformed: (n: number) =>
    `${n} item${n === 1 ? "" : "s"} from Spotify could not be read (a field is missing or odd). The readable plays were stored. Check src/poll-mapping.ts against Spotify's answer.`,
  allSkipped: (n: number) =>
    `Spotify sent ${n} item${n === 1 ? "" : "s"} and every one was skipped, so nothing was stored. The counts above show why. Check src/poll-mapping.ts against Spotify's answer.`,
  onlyNoTrack: (n: number) =>
    `Spotify sent ${n} item${n === 1 ? "" : "s"} and every one was a local file or an episode, which has no track to store. Nothing was stored. This is normal until a real play appears.`,
  futureCursor:
    "The newest stored play is more than 60 seconds in the future, so the poll cannot use it as its starting point. Fix or delete that row, then run the poll again.",
  stalled:
    "The poller could not page back to older plays, so it stopped. The plays fetched were stored. Plays older than those may be missing.",
  capped: "Spotify has more plays than one poll reads (20 pages of 50). The plays fetched were stored. Plays older than those may be missing.",
  tooMany: "Spotify sent more than 50 items in one page, which is more than the poller accepts.",
  tooLarge: "Spotify sent a response larger than 1 MB, so the poller did not read it.",
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

/** The report's parts always add up: fetched = stored + duplicate + skipped, and duplicate = export + exact. */
function expectBalanced(result: CliResult): void {
  const c = counts(result.stdout);
  expect(c.fetched).toBe(c.stored! + c.duplicate! + c.skipped!);
  expect(c.duplicate).toBe(c.duplicate_export! + c.duplicate_exact!);
  expect(c.skipped).toBe(c.no_track! + c.malformed!);
}

const ms = (iso: string) => Date.parse(iso);
const seconds = (iso: string, delta: number) => new Date(ms(iso) + delta * 1000).toISOString();

/** Puts one play in the table, the way the importer (export) or the poller (poll) would. */
async function seedPlay(id: number, endedAt: string, source: "export" | "poll"): Promise<void> {
  const tag = String(id).padStart(12, "0");
  const { error } = await db.from("plays").insert({
    track_uri: `spotify:track:SYNTH${tag}`,
    track_name: `Synthetic Track ${id}`,
    artist_name: `Synthetic Artist ${id}`,
    album_name: `Synthetic Album ${id}`,
    ended_at: endedAt,
    ms_played: source === "export" ? 200000 : null,
    source,
  });
  if (error) throw new Error(`Could not seed a play: ${error.code}`);
}

const seedExportPlay = (id: number, endedAt: string) => seedPlay(id, endedAt, "export");

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
    expect(counts(result.stdout)).toEqual({
      fetched: 3,
      stored: 3,
      duplicate: 0,
      duplicate_export: 0,
      duplicate_exact: 0,
      skipped: 0,
      no_track: 0,
      malformed: 0,
    });
    expect(result.stdout).not.toContain("possible_gap");
    expectBalanced(result);

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
    expectBalanced(first.result);

    const second = await poll({ recent: () => page(items) });
    expect(second.result.status).toBe(0);
    // Two poll rows already hold these exact keys, so the table's key refuses them.
    expect(counts(second.result.stdout)).toMatchObject({ fetched: 2, stored: 0, duplicate: 2, duplicate_exact: 2, duplicate_export: 0 });
    expectBalanced(second.result);
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
    expect(counts(result.stdout)).toMatchObject({ fetched: 6, stored: 1, duplicate: 0, skipped: 5, no_track: 5, malformed: 0 });
    expectBalanced(result);
    expect(await stored()).toHaveLength(1);
  });

  it("skips an item with a missing or invalid field as malformed, stores the valid ones, then exits 1", async () => {
    const items = [
      item(1, "not a date"),
      item(2, "2026-11-20T10:01:00Z", { name: "" }),
      item(3, "2026-11-20T10:02:00Z", { artists: [] }),
      item(4, "2026-11-20T10:03:00Z", { name: "Bad \u0000 name" }),
      "not an object",
      item(5, "2026-11-20T10:04:00Z"),
    ];
    const { result } = await poll({ recent: () => page(items as Item[]) });

    expect(result.status).toBe(1);
    expect(counts(result.stdout)).toMatchObject({ fetched: 6, stored: 1, duplicate: 0, skipped: 5, no_track: 0, malformed: 5 });
    expectBalanced(result);
    expect(await stored()).toHaveLength(1);
    expect(result.stderr).toBe(`::error::${MSG.someMalformed(5)}\n`);
    expectNoSecrets(result);
  });

  it("handles an empty page", async () => {
    const { result } = await poll({ recent: () => page([]) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ fetched: 0, stored: 0, duplicate: 0, skipped: 0, no_track: 0, malformed: 0 });
    expect(result.stderr).toBe("");
  });

  it("stores a play that is the same twice in one answer only once", async () => {
    const items = [item(1, "2026-11-20T10:00:05.100Z"), item(1, "2026-11-20T10:00:05.900Z")];
    const { result } = await poll({ recent: () => page(items) });
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 1, duplicate: 1, duplicate_exact: 1 });
    expectBalanced(result);
    expect(await stored()).toHaveLength(1);
  });
});

describe("poll: matching plays already stored", () => {
  it("does not store a play already imported from an export, at the exact end time", async () => {
    await seedExportPlay(1, "2026-11-20T10:00:05Z");
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:05.678Z")]) });

    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 0, duplicate: 1, duplicate_export: 1, duplicate_exact: 0 });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("export");
  });

  it("does not store a play already imported from an export, a few seconds off", async () => {
    await seedExportPlay(1, "2026-11-20T10:00:00Z");
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:05.678Z")]) });

    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 0, duplicate: 1, duplicate_export: 1 });
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

    expect(counts(result.stdout)).toMatchObject({ fetched: 4, stored: 2, duplicate: 2, duplicate_export: 2 });
    expectBalanced(result);
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

  it("keeps a replay of the same track inside the window when the stored play is a poll row", async () => {
    await seedPlay(1, T0, "poll");
    const { result } = await poll({ recent: recentFrom([item(1, seconds(T0, 5))]) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 1, duplicate: 0 });
    expect((await stored()).map((row) => row.source)).toEqual(["poll", "poll"]);
  });

  it("drops that same replay when the stored play is an export row", async () => {
    await seedExportPlay(1, T0);
    const { result } = await poll({ recent: recentFrom([item(1, seconds(T0, 5))]) });
    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 0, duplicate: 1, duplicate_export: 1, duplicate_exact: 0 });
    expect(await stored()).toHaveLength(1);
  });

  it("keeps two plays of one track a few seconds apart in the same answer, because the exact key tells them apart", async () => {
    const { result } = await poll({ recent: () => page([item(1, seconds(T0, 0)), item(1, seconds(T0, 5))]) });
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 2, duplicate: 0 });
  });

  it("counts a repeat of an export play and a repeat of a poll play apart, and the parts add up", async () => {
    await seedExportPlay(1, T0);
    await seedPlay(2, T0, "poll");
    const items = [item(1, seconds(T0, 3)), item(2, T0), item(3, seconds(T0, 20))];
    const { result } = await poll({ recent: () => page(items) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({
      fetched: 3,
      stored: 1,
      duplicate: 2,
      duplicate_export: 1,
      duplicate_exact: 1,
    });
    expectBalanced(result);
  });
});

describe("poll: paging back over a full page", () => {
  const T = "2026-11-20T08:00:00Z";
  /** `count` plays, one every 100 seconds from `start`, with ids from `firstId`. */
  const run = (count: number, start: string, firstId: number) =>
    Array.from({ length: count }, (_, index) => item(firstId + index, seconds(start, index * 100)));

  it("recovers every play when a full page is followed by older plays", async () => {
    const all = run(120, T, 1);
    const { result, fake } = await poll({ recent: recentFrom(all) });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(counts(result.stdout)).toMatchObject({ fetched: 120, stored: 120, duplicate: 0, skipped: 0 });
    expect(result.stdout).not.toContain("possible_gap");
    expectBalanced(result);
    expect(await stored()).toHaveLength(120);

    // Three pages: no cursor, then `before` the oldest play of the page before. Never both parameters.
    expect(fake.recentRequests).toHaveLength(3);
    const [first, second, third] = fake.recentRequests.map((request) => request.query);
    expect(first!.has("after") || first!.has("before")).toBe(false);
    const newestFirst = [...all].sort((a, b) => ms(b.played_at as string) - ms(a.played_at as string));
    expect(second!.get("before")).toBe(String(ms(newestFirst[49]!.played_at as string)));
    expect(second!.has("after")).toBe(false);
    expect(third!.get("before")).toBe(String(ms(newestFirst[99]!.played_at as string)));
    expect(third!.has("after")).toBe(false);
  });

  it("asks with `after` first when a play is stored, then pages back with `before` only", async () => {
    await seedPlay(900, seconds(T, -1000), "poll");
    const { result, fake } = await poll({ recent: recentFrom(run(120, T, 1)) });

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ fetched: 120, stored: 120 });
    expect(fake.recentRequests).toHaveLength(3);
    const [first, second] = fake.recentRequests.map((request) => request.query);
    expect(first!.get("after")).toBe(String(ms(seconds(T, -1000))));
    expect(first!.has("before")).toBe(false);
    expect(second!.has("after")).toBe(false);
    expect(second!.has("before")).toBe(true);
  });

  it("stops when a page holds only plays at or before the stored cursor", async () => {
    const cursor = seconds(T, 6000);
    await seedPlay(900, cursor, "poll");
    // 60 plays after the cursor, then 90 at or before it.
    const newer = run(60, seconds(cursor, 100), 1);
    const older = run(90, seconds(cursor, -9000), 100);
    const { result, fake } = await poll({ recent: recentFrom([...newer, ...older]) });

    expect(result.status).toBe(0);
    // Page 1 (after): 50 newer. Page 2 (before): 10 newer and 40 older. Page 3: 50 older, all at or before the cursor, so it stops.
    expect(fake.recentRequests).toHaveLength(3);
    expect(counts(result.stdout)).toMatchObject({ fetched: 150, stored: 150 });
    expectBalanced(result);
  });

  it("stops at once when the first page is not full", async () => {
    const { fake } = await poll({ recent: recentFrom(run(POLL_LIMIT - 1, T, 1)) });
    expect(fake.recentRequests).toHaveLength(1);
  });

  it("stops on an empty page after a full one", async () => {
    const { result, fake } = await poll({ recent: recentFrom(run(POLL_LIMIT, T, 1)) });
    expect(result.status).toBe(0);
    expect(fake.recentRequests).toHaveLength(2);
    expect(counts(result.stdout)).toMatchObject({ fetched: POLL_LIMIT, stored: POLL_LIMIT });
  });

  it("stores what it fetched, then exits 1 with a plain message, when it reaches the page cap", async () => {
    const all = run(POLL_MAX_PAGES * POLL_LIMIT + 50, T, 1);
    const { result, fake } = await poll({ recent: recentFrom(all) });

    expect(fake.recentRequests).toHaveLength(POLL_MAX_PAGES);
    expect(result.status).toBe(1);
    expect(counts(result.stdout)).toMatchObject({ fetched: POLL_MAX_PAGES * POLL_LIMIT, stored: POLL_MAX_PAGES * POLL_LIMIT });
    expect(result.stdout).toContain("possible_gap: true");
    expect(result.stderr).toBe(`::error::${MSG.capped}\n`);
    expect(await stored()).toHaveLength(POLL_MAX_PAGES * POLL_LIMIT);
    expectNoSecrets(result);
  });

  it("does not loop when Spotify ignores `before` and sends the same page again", async () => {
    const same = run(POLL_LIMIT, T, 1);
    const { result, fake } = await poll({ recent: () => page(same) });
    expect(fake.recentRequests).toHaveLength(2);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("possible_gap: true");
    expect(result.stderr).toBe(`::error::${MSG.stalled}\n`);
    expect(counts(result.stdout)).toMatchObject({ fetched: POLL_LIMIT, stored: POLL_LIMIT });
    expect(await stored()).toHaveLength(POLL_LIMIT);
  });
});

describe("poll: failing loudly", () => {
  it("exits 1 when every item was skipped (a renamed field), with an error annotation", async () => {
    const renamed = [item(1, "2026-11-20T10:00:00Z"), item(2, "2026-11-20T10:01:00Z")].map((entry) => {
      const track: Record<string, unknown> = { ...(entry.track as Record<string, unknown>), title: "x" };
      delete track.name;
      return { ...entry, track };
    });
    const { result } = await poll({ recent: () => page(renamed) });

    expect(result.status).toBe(1);
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 0, skipped: 2, malformed: 2 });
    expect(result.stderr).toBe(`::error::${MSG.allSkipped(2)}\n`);
    expect(await stored()).toHaveLength(0);
    expectNoSecrets(result);
  });

  it("exits 0 with a plain note when every item is a local file or an episode", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z", { is_local: true }), item(2, "2026-11-20T10:01:00Z", { type: "episode" })];
    const { result } = await poll({ recent: () => page(items) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 0, duplicate: 0, skipped: 2, no_track: 2, malformed: 0 });
    // A plain line, not an error annotation: the run stays green.
    expect(result.stderr).toBe(`${MSG.onlyNoTrack(2)}\n`);
    expect(result.stderr).not.toContain("::error::");
    expect(await stored()).toHaveLength(0);
  });

  it("exits 0 for a window that holds only local files, run after run, until a real play appears", async () => {
    const local = (n: number, minute: number) =>
      item(n, `2026-11-20T10:0${minute}:00Z`, { is_local: true, uri: `spotify:local:Synthetic+Artist::Synthetic+Song+${n}::200` });
    const window = [local(1, 0), local(2, 1), local(3, 2)];

    const first = await poll({ recent: () => page(window) });
    const second = await poll({ recent: () => page(window) });

    for (const { result } of [first, second]) {
      expect(result.status).toBe(0);
      expect(counts(result.stdout)).toMatchObject({ fetched: 3, stored: 0, duplicate: 0, skipped: 3, no_track: 3, malformed: 0 });
      expect(result.stderr).toBe(`${MSG.onlyNoTrack(3)}\n`);
    }
    expect(await stored()).toHaveLength(0);

    const real = await poll({ recent: () => page([...window, item(9, "2026-11-20T10:09:00Z")]) });
    expect(real.result.status).toBe(0);
    expect(counts(real.result.stdout)).toMatchObject({ fetched: 4, stored: 1, no_track: 3 });
    expect(real.result.stderr).toBe("");
  });

  it("still exits 1 when nothing was stored and even one skipped item is malformed, among local files", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z", { is_local: true }), item(2, "not a date"), item(3, "2026-11-20T10:02:00Z", { type: "episode" })];
    const { result } = await poll({ recent: () => page(items) });

    expect(result.status).toBe(1);
    expect(counts(result.stdout)).toMatchObject({ fetched: 3, stored: 0, skipped: 3, no_track: 2, malformed: 1 });
    expect(result.stderr).toBe(`::error::${MSG.allSkipped(3)}\n`);
  });

  it("exits 0 when some items are skipped as no_track and others are stored", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z", { is_local: true }), item(2, "2026-11-20T10:01:00Z")];
    const { result } = await poll({ recent: () => page(items) });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits 0 when every item is already stored", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z")];
    await poll({ recent: () => page(items) });
    const again = await poll({ recent: () => page(items) });
    expect(again.result.status).toBe(0);
  });
});

describe("poll: dates in the future", () => {
  const inFuture = (secondsAhead: number) => new Date(Date.now() + secondsAhead * 1000).toISOString();

  it("rejects a play stamped more than 60 seconds ahead as malformed, after storing the good ones", async () => {
    const items = [item(1, "2026-11-20T10:00:00Z"), item(2, inFuture(3600))];
    const { result } = await poll({ recent: () => page(items) });
    expect(result.status).toBe(1);
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 1, malformed: 1 });
    expect(result.stderr).toBe(`::error::${MSG.someMalformed(1)}\n`);
    expect((await stored()).map((row) => row.track_uri)).toEqual(["spotify:track:SYNTH000000000001"]);
  });

  it("accepts a play stamped a few seconds ahead of the clock", async () => {
    const { result } = await poll({ recent: () => page([item(1, inFuture(30))]) });
    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ stored: 1, malformed: 0 });
  });

  it("exits 1 naming the problem when the stored cursor is more than 60 seconds ahead, before it uses the login", async () => {
    await seedExportPlay(1, inFuture(3600));
    const { result, fake } = await poll({ recent: () => page([item(2, "2026-11-20T10:00:00Z")]) });
    expectFailure(result, MSG.futureCursor);
    expect(result.stderr).not.toContain("::error::");
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await stored()).toHaveLength(1);
  });

  it("goes on when the stored cursor is only a few seconds ahead", async () => {
    await seedExportPlay(1, inFuture(30));
    const { result } = await poll({ recent: () => page([]) });
    expect(result.status).toBe(0);
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

describe("poll: limits on what Spotify sends", () => {
  it("refuses a page with more than 50 items, and stores nothing", async () => {
    const items = Array.from({ length: 51 }, (_, index) => item(index + 1, seconds("2026-11-20T10:00:00Z", index * 200)));
    const { result } = await poll({ recent: () => page(items) });
    expectFailure(result, MSG.tooMany);
    expect(await stored()).toHaveLength(0);
  });

  it("refuses a response body over 1 MB, and never prints any of it", async () => {
    const huge = "Z".repeat(1_048_577);
    const { result } = await poll({ recent: () => ({ status: 200, body: `{"items":[],"pad":"${huge}"}` }) });
    expectFailure(result, MSG.tooLarge);
    expect(result.output).not.toContain("ZZZZZZZZ");
  });

  it("refuses an oversized body from the token endpoint too", async () => {
    const huge = "Z".repeat(1_048_577);
    const { result, fake } = await poll({ token: () => ({ status: 200, body: `{"pad":"${huge}"}` }) });
    expectFailure(result, MSG.tooLarge);
    expect(fake.recentRequests).toHaveLength(0);
  });

  it("reads a body just under 1 MB", async () => {
    const pad = "Z".repeat(1_040_000);
    const { result } = await poll({ recent: () => ({ status: 200, body: `{"items":[],"pad":"${pad}"}` }) });
    expect(result.status).toBe(0);
  });

  it.each([
    ["track name", { name: "N".repeat(501) }],
    ["artist name", { artists: [{ name: "A".repeat(501) }] }],
    ["album name", { album: { name: "B".repeat(501), artists: [{ name: "X" }] } }],
  ])("counts a %s over 500 characters as malformed, and keeps the good play", async (_label, over) => {
    const { result } = await poll({
      recent: () => page([item(1, "2026-11-20T10:00:00Z", over), item(2, "2026-11-20T10:01:00Z")]),
    });
    expect(counts(result.stdout)).toMatchObject({ fetched: 2, stored: 1, malformed: 1 });
  });

  it("keeps a name of exactly 500 characters", async () => {
    const { result } = await poll({ recent: () => page([item(1, "2026-11-20T10:00:00Z", { name: "N".repeat(500) })]) });
    expect(counts(result.stdout)).toMatchObject({ fetched: 1, stored: 1, malformed: 0 });
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
  it("stores each play once when two polls run together, both holding their answers until both have asked", async () => {
    const items = Array.from({ length: 8 }, (_, index) => item(index + 1, seconds("2026-11-20T10:00:00Z", index * 200)));
    let asked = 0;
    let release: () => void = () => {};
    const bothAsked = new Promise<void>((resolve) => (release = resolve));
    const fake = await startFakeSpotify({
      token: () => tokenOk(),
      // A start barrier: neither answer goes out until both polls have read the empty table and asked.
      recent: async () => {
        asked += 1;
        if (asked === 2) release();
        await Promise.race([bothAsked, new Promise((resolve) => setTimeout(resolve, 15_000))]);
        return page(items);
      },
    });
    try {
      const env = {
        SPOTIFY_CLIENT_ID: CLIENT_ID,
        SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
        SPOTIFY_REFRESH_TOKEN: REFRESH_TOKEN,
        SPOTIFY_ACCOUNTS_BASE: fake.url,
        SPOTIFY_API_BASE: fake.url,
      };
      const [a, b] = await Promise.all([runPoll(env), runPoll(env)]);
      // Both were waiting at the same time, so the two polls really overlapped.
      expect(asked).toBe(2);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(counts(a.stdout).stored! + counts(b.stdout).stored!).toBe(8);
      expect(counts(a.stdout).duplicate_exact! + counts(b.stdout).duplicate_exact!).toBe(8);
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

  it.each([
    ["SPOTIFY_ACCOUNTS_BASE", "accounts.spotify.com", "http://example.com"],
    ["SPOTIFY_API_BASE", "api.spotify.com", "http://example.com"],
    ["SPOTIFY_ACCOUNTS_BASE", "accounts.spotify.com", "https://evil.example"],
    ["SPOTIFY_API_BASE", "api.spotify.com", "https://api.spotify.com.evil.example"],
  ])("exits 2 before sending anything when %s is %s, an address Spotify does not use (%s)", async (name, host, address) => {
    const { result, fake } = await poll({}, { [name]: address });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`${name} must be https://${host}, or localhost or 127.0.0.1 for tests.\n`);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(fake.recentRequests).toHaveLength(0);
    expectNoSecrets(result);
  });

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
