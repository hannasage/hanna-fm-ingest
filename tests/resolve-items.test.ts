import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MB_API_BASE, MATCH_MIN_SCORE, MB_MIN_INTERVAL_MS, RESOLVE_MAX_ATTEMPTS } from "../src/settings.ts";
import { counts, runResolve, startResolve, type CliResult } from "./support/cli.ts";
import { artistA, FULL, fromCatalog, SMALL } from "./support/catalog.ts";
import { clearTables, find, id, items, seedPlays, T1, T2, T3, uri } from "./support/data.ts";
import { adminClient, localStack } from "./support/env.ts";
import { answer, startFakeMb, type FakeMb, type Reply, type Seen } from "./support/fake-mb.ts";
import {
  publishedArtistSearch,
  publishedRecordingSearch,
  publishedReleaseGroupSearch,
} from "./support/published-examples.ts";
import { USER_AGENT } from "./support/inproc.ts";

/**
 * The real command, run as a person runs it, against the local database and a fake MusicBrainz server.
 * Matching rules and counts are tested faster, in this process, in resolve-flow.test.ts.
 */
const db = adminClient();

let servers: FakeMb[] = [];
async function fake(respond: (request: Seen, count: number) => Reply): Promise<FakeMb> {
  const server = await startFakeMb(respond);
  servers.push(server);
  return server;
}

function resolve(server: FakeMb, env: Record<string, string | undefined> = {}, args: string[] = []): Promise<CliResult> {
  return runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: server.base, ...env }, args);
}

function expectNoKey(...results: CliResult[]): void {
  const { key } = localStack();
  for (const result of results) expect(result.output.includes(key)).toBe(false);
}

/**
 * Every gap between two requests the server saw is at least the interval. Both ends are read from one
 * clock with its fraction, and nothing is allowed to round: a gap of 999.9 ms fails.
 */
function expectGapsAtLeast(server: FakeMb, minimum: number): void {
  for (const gap of server.gaps()) expect(gap).toBeGreaterThanOrEqual(minimum);
}

async function lockedUntil(): Promise<string | null | undefined> {
  const { data } = await db.from("job_locks").select("locked_until").eq("name", "resolve-items").maybeSingle();
  return data === null ? undefined : (data as { locked_until: string | null }).locked_until;
}

beforeEach(async () => {
  await clearTables(db);
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

describe("resolve-items: stored items", () => {
  it("stores every artist, album and track with an MBID and a Spotify alias", async () => {
    await seedPlays(db, [T1, T2, T3, T1]);
    const server = await fake(fromCatalog(FULL));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items(db);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.state === "resolved" && row.resolved_at !== null)).toBe(true);

    expect(find(rows, "track", "SYNTH Song One")).toMatchObject({
      mbid: id(21),
      spotify_uri: T1.uri,
      source_key: T1.uri,
      match_score: 100,
      matched_name: "SYNTH Song One",
      reason: null,
    });
    expect(find(rows, "track", "SYNTH Song Two").mbid).toBe(id(22));
    expect(find(rows, "track", "SYNTH Song Three").mbid).toBe(id(23));
    expect(find(rows, "album", "SYNTH Album A")).toMatchObject({
      mbid: id(31),
      match_score: 100,
      matched_name: "SYNTH Album A",
      source_key: JSON.stringify(["synth album a", "synth artist a"]),
    });
    expect(find(rows, "album", "SYNTH Album B").match_score).toBe(92);
    expect(new Set(rows.map((row) => row.mbid)).size).toBe(7);
    expectNoKey(result);
  });

  it("settles each artist from a track's credit, with no artist search, a null score and the reason credit", async () => {
    await seedPlays(db, [T1, T2, T3]);
    const server = await fake(fromCatalog(FULL));

    const result = await resolve(server);

    const rows = await items(db);
    expect(find(rows, "artist", "SYNTH Artist A")).toMatchObject({
      mbid: artistA.id,
      state: "resolved",
      source_key: "synth artist a",
      spotify_uri: null,
      match_score: null,
      reason: "credit",
    });
    expect(find(rows, "artist", "SYNTH Artist B").mbid).toBe(id(12));
    expect(server.seen.filter((request) => request.path.endsWith("/artist"))).toHaveLength(0);
    // 3 tracks and 2 albums.
    expect(server.seen).toHaveLength(5);
    expect(counts(result.stdout)).toMatchObject({ new: 7, total: 7, resolved: 7, unresolved: 0, pending: 0, skipped: 0, remaining: 0, requests: 5, cache_hits: 0 });
  });

  it("searches an artist by name when no track settled it", async () => {
    await seedPlays(db, [{ uri: uri(4), track: "SYNTH Unmatched", artist: "SYNTH Artist C", album: null }]);
    const server = await fake(fromCatalog({ artists: { "SYNTH Artist C": { id: id(13), score: 100, name: "SYNTH Artist C" } } }));

    await resolve(server);

    expect(find(await items(db), "artist", "SYNTH Artist C")).toMatchObject({ state: "resolved", mbid: id(13), match_score: 100, reason: null });
    expect(server.seen.filter((request) => request.path.endsWith("/artist")).map((request) => request.fields.artist)).toEqual(["SYNTH Artist C"]);
  });

  it("searches by track, artist and album, and by album and artist, asking for JSON and five hits", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    await resolve(server);

    const [track, album] = server.seen;
    expect(track?.path).toBe("/ws/2/recording");
    expect(track?.fields).toEqual({ recording: T1.track, artistname: T1.artist, release: T1.album });
    expect(album?.path).toBe("/ws/2/release-group");
    expect(album?.fields).toEqual({ releasegroup: T1.album, artistname: T1.artist });
    for (const request of server.seen) {
      expect(request.params.get("fmt")).toBe("json");
      expect(request.params.get("limit")).toBe("5");
      expect(request.accept).toBe("application/json");
    }
  });

  it("sends the User-Agent exactly as set in MB_USER_AGENT", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    await resolve(server);

    expect(server.seen.length).toBeGreaterThan(0);
    for (const request of server.seen) expect(request.userAgent).toBe(USER_AGENT);
  });

  it("keeps the exact text of names with quotes, backslashes and emoji in the search, and one artist for spellings that differ only in case", async () => {
    const odd = 'SYNTH "Quoted" \\ Song \u{1F3B5}';
    await seedPlays(db, [
      { uri: uri(5), track: odd, artist: "SYNTH Artist A", album: null },
      { uri: uri(6), track: "SYNTH Plain", artist: "synth  artist a", album: null },
    ]);
    const server = await fake(fromCatalog({ tracks: { [odd]: { id: id(41), score: 100, title: odd, artists: [artistA] } } }));

    await resolve(server);

    expect(server.seen[0]?.fields.recording).toBe(odd);
    expect((await items(db)).filter((row) => row.kind === "artist")).toHaveLength(1);
  });

  it("records a blank artist as unresolved, never searches a track by its title alone, and leaves a blank album out", async () => {
    await seedPlays(db, [{ uri: uri(7), track: "SYNTH Blank Artist Song", artist: "  ", album: " " }]);
    const server = await fake(fromCatalog({}));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items(db);
    expect(rows.filter((row) => row.kind === "album")).toHaveLength(0);
    expect(rows.find((row) => row.kind === "artist")).toMatchObject({ state: "unresolved", reason: "empty_name" });
    expect(find(rows, "track", "SYNTH Blank Artist Song")).toMatchObject({ state: "unresolved", reason: "no_artist" });
    expect(server.seen).toHaveLength(0);
  });

  it("keeps a second Spotify track for the same recording, pointing at the row that holds the MBID", async () => {
    await seedPlays(db, [
      { uri: uri(8), track: "SYNTH Single Version", artist: "SYNTH Artist A", album: null },
      { uri: uri(9), track: "SYNTH Album Version", artist: "SYNTH Artist A", album: null },
    ]);
    const hit = (title: string) => ({ id: id(51), score: 100, title, artists: [artistA] });
    const server = await fake(
      fromCatalog({ tracks: { "SYNTH Single Version": hit("SYNTH Single Version"), "SYNTH Album Version": hit("SYNTH Album Version") } }),
    );

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items(db);
    const first = find(rows, "track", "SYNTH Single Version");
    const second = find(rows, "track", "SYNTH Album Version");
    expect(first).toMatchObject({ mbid: id(51), merged_into: null, state: "resolved" });
    expect(second).toMatchObject({ mbid: null, merged_into: first.id, state: "resolved", spotify_uri: uri(9) });
  });
});

describe("resolve-items: shapes copied from the MusicBrainz documentation", () => {
  // These answers are copied from the official search page, not made up. Ticket 7 checks the command against a live response.
  const empty = (request: Seen): Reply => ({
    status: 200,
    body: answer.empty(request.path.endsWith("/recording") ? "recordings" : request.path.endsWith("/artist") ? "artists" : "release-groups"),
  });

  it("reads a recording search answer, and settles the artist from its credit", async () => {
    const recording = publishedRecordingSearch.recordings[0];
    const credit = recording["artist-credit"][0].artist;
    await seedPlays(db, [{ uri: uri(20), track: recording.title, artist: credit.name, album: null }]);
    const server = await fake((request) => (request.path.endsWith("/recording") ? { status: 200, body: publishedRecordingSearch } : empty(request)));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items(db);
    expect(find(rows, "track", recording.title)).toMatchObject({ state: "resolved", mbid: recording.id, match_score: 100, matched_name: recording.title });
    expect(find(rows, "artist", credit.name)).toMatchObject({ state: "resolved", mbid: credit.id, reason: "credit", match_score: null });
  });

  it("reads a release-group search answer", async () => {
    const group = publishedReleaseGroupSearch["release-groups"][0];
    const credit = group["artist-credit"][0].artist;
    await seedPlays(db, [{ uri: uri(21), track: "SYNTH Other", artist: credit.name, album: group.title }]);
    const server = await fake((request) => (request.path.endsWith("/release-group") ? { status: 200, body: publishedReleaseGroupSearch } : empty(request)));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    expect(find(await items(db), "album", group.title)).toMatchObject({ state: "resolved", mbid: group.id, match_score: 100, matched_name: group.title });
    expect(server.seen.find((request) => request.path.endsWith("/release-group"))?.fields.releasegroup).toBe(group.title);
  });

  it("reads an artist search answer, where two artists are both named Fred and both score 100, and refuses to pick one", async () => {
    const [first, second] = publishedArtistSearch.artists;
    expect([first.name, second.name, first.score, second.score]).toEqual(["Fred", "Fred", "100", "100"]);
    await seedPlays(db, [{ uri: uri(22), track: "SYNTH Unmatched", artist: "Fred", album: null }]);
    const server = await fake((request) => (request.path.endsWith("/artist") ? { status: 200, body: publishedArtistSearch } : empty(request)));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    expect(find(await items(db), "artist", "Fred")).toMatchObject({ state: "unresolved", reason: "ambiguous", mbid: null, match_score: 100, matched_name: "Fred" });
  });
});

describe("resolve-items: queue and cache", () => {
  it("never sends more than one request a second, measured at the server on one clock, with no rounding", async () => {
    await seedPlays(db, [T1, T2, T3]);
    const server = await fake(fromCatalog(FULL));

    const result = await resolve(server);

    expect(server.seen.length).toBeGreaterThanOrEqual(4);
    expect(server.gaps().length).toBe(server.seen.length - 1);
    expectGapsAtLeast(server, MB_MIN_INTERVAL_MS);
    expect(counts(result.stdout).requests).toBe(server.seen.length);
  });

  it("serves a repeat run from the stored items, and a rebuilt table from the cache, with no request", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    const first = await resolve(server);
    const before = await items(db);
    expect(server.seen).toHaveLength(2);
    expect(counts(first.stdout).requests).toBe(2);

    const second = await resolve(server);
    expect(server.seen).toHaveLength(2);
    expect(counts(second.stdout)).toMatchObject({ new: 0, total: 0, requests: 0, cache_hits: 0 });
    expect(await items(db)).toEqual(before);

    // Lose the item rows. The answers are still cached, so the lookups need no request.
    const { error } = await db.from("items").delete().neq("id", 0);
    expect(error).toBeNull();
    const third = await resolve(server);
    expect(third.status, third.output).toBe(0);
    expect(server.seen).toHaveLength(2);
    expect(counts(third.stdout)).toMatchObject({ new: 3, requests: 0, cache_hits: 2, resolved: 3 });
    const after = await items(db);
    expect(after.map((row) => [row.kind, row.mbid])).toEqual(before.map((row) => [row.kind, row.mbid]));

    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(2);
  });
});

describe("resolve-items: one run at a time", () => {
  it("lets only one of two simultaneous runs work, and refuses the other with exit 3, so the rate stays under one a second", async () => {
    await seedPlays(db, [T1, T2, T3]);
    const server = await fake(fromCatalog(FULL));

    const [a, b] = await Promise.all([resolve(server), resolve(server)]);

    expect([a.status, b.status].sort(), `${a.output}\n${b.output}`).toEqual([0, 3]);
    const loser = a.status === 3 ? a : b;
    expect(loser.stderr).toMatch(/another/i);
    expect(loser.stdout).toBe("");
    // One run's requests, and every gap across all of them at least one second.
    expect(server.seen).toHaveLength(5);
    expectGapsAtLeast(server, MB_MIN_INTERVAL_MS);
    const rows = await items(db);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.state === "resolved")).toBe(true);
    expectNoKey(a, b);
  });

  it("exits 3 with a plain message, and changes nothing, while another run holds the lock", async () => {
    await seedPlays(db, [T1]);
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await db.from("job_locks").insert({ name: "resolve-items", locked_until: until });
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server);

    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/another/i);
    expect(server.seen).toHaveLength(0);
    expect(await items(db)).toHaveLength(0);
    // The database writes the time without trailing zeros, so compare the instants, not the text.
    expect(new Date((await lockedUntil())!).getTime()).toBe(new Date(until).getTime());
    expectNoKey(result);
  });

  it("takes a lock whose lease has passed, and frees it at the end", async () => {
    await seedPlays(db, [T1]);
    await db.from("job_locks").insert({ name: "resolve-items", locked_until: new Date(Date.now() - 60_000).toISOString() });
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    expect(await lockedUntil()).toBeNull();
  });

  it("frees the lock when the run stops with an error", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(() => ({ status: 401 }));

    const result = await resolve(server);

    expect(result.status).toBe(1);
    expect(await lockedUntil()).toBeNull();
  });

  it("frees the lock when it is stopped with SIGTERM, and a later run finishes the work with no item searched twice", async () => {
    await seedPlays(db, [1, 2, 3, 4, 5, 6].map((n) => ({ uri: uri(n), track: `SYNTH Track ${n}`, artist: "SYNTH Artist A", album: null })));
    const first = await fake(fromCatalog({}));
    const running = startResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: first.base });

    await waitFor(() => first.seen.length >= 2);
    running.stop("SIGTERM");
    const stopped = await running.done;

    expect(stopped.status).not.toBe(0);
    expect(await lockedUntil()).toBeNull();
    // A request already sent to the database can still land after the command is gone.
    await new Promise((done) => setTimeout(done, 500));
    const rows = await items(db);
    const left = rows.filter((row) => row.state === "pending");
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(rows.length);

    const second = await fake(fromCatalog({}));
    const resumed = await resolve(second);

    expect(resumed.status, resumed.output).toBe(0);
    // Only what was left is searched. An item the stopped run had settled is not asked about again.
    // (The one the stopped run was on may already be in the cache, and then it costs no request.)
    const settled = rows.filter((row) => row.state !== "pending").map((row) => row.name);
    const asked = second.seen.map((request) => request.fields.recording ?? request.fields.artist);
    expect(asked.filter((name) => settled.includes(name ?? ""))).toEqual([]);
    expect(second.seen.length).toBeLessThanOrEqual(left.length);
    expect(second.seen.length).toBeGreaterThanOrEqual(left.length - 1);
    expect(counts(resumed.stdout)).toMatchObject({ total: left.length, unresolved: left.length, remaining: 0 });
    expect((await items(db)).every((row) => row.state === "unresolved")).toBe(true);
  }, 60_000);

  it("after a crash (SIGKILL) holds the lock until the lease passes, then resumes and ends complete", async () => {
    await seedPlays(db, [1, 2, 3, 4, 5, 6].map((n) => ({ uri: uri(n), track: `SYNTH Track ${n}`, artist: "SYNTH Artist A", album: null })));
    const first = await fake(fromCatalog({}));
    const running = startResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: first.base });
    await waitFor(() => first.seen.length >= 2);
    running.stop("SIGKILL");
    await running.done;
    // A request already sent to the database can still land after the command is gone.
    await new Promise((done) => setTimeout(done, 500));
    const left = (await items(db)).filter((row) => row.state === "pending").length;
    expect(left).toBeGreaterThan(0);

    const second = await fake(fromCatalog({}));
    const blocked = await resolve(second);
    expect(blocked.status).toBe(3);
    expect(second.seen).toHaveLength(0);

    await db.from("job_locks").update({ locked_until: new Date(Date.now() - 1000).toISOString() }).eq("name", "resolve-items");
    const resumed = await resolve(second);

    expect(resumed.status, resumed.output).toBe(0);
    expect(counts(resumed.stdout)).toMatchObject({ total: left, remaining: 0 });
    expect((await items(db)).every((row) => row.state === "unresolved")).toBe(true);
  }, 60_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waited too long");
    await new Promise((done) => setTimeout(done, 25));
  }
}

describe("resolve-items: flags", () => {
  it("--limit N processes at most N items and prints how many remain", async () => {
    await seedPlays(db, [1, 2, 3, 4, 5].map((n) => ({ uri: uri(n), track: `SYNTH Track ${n}`, artist: "SYNTH Artist A", album: null })));
    const server = await fake(fromCatalog({}));

    const result = await resolve(server, {}, ["--limit", "2"]);

    expect(result.status, result.output).toBe(0);
    expect(server.seen).toHaveLength(2);
    expect(counts(result.stdout)).toMatchObject({ total: 6, unresolved: 2, remaining: 4, requests: 2 });
    expect((await items(db)).filter((row) => row.state === "pending")).toHaveLength(4);
  });

  it("exits 1 and counts as exhausted an item that failed too often, names --retry-failed, and tries it only when that flag is passed", async () => {
    await seedPlays(db, [T1]);
    await db.from("items").insert({ kind: "track", name: T1.track, source_key: T1.uri, attempts: RESOLVE_MAX_ATTEMPTS });
    const server = await fake(fromCatalog(SMALL));

    const stuck = await resolve(server);
    expect(stuck.status, stuck.output).toBe(1);
    expect(counts(stuck.stdout)).toMatchObject({ skipped: 0, exhausted: 1 });
    expect(stuck.stderr).toMatch(/--retry-failed/);
    expect(stuck.stderr).toMatch(/stuck/);
    expect(find(await items(db), "track", T1.track).state).toBe("pending");
    expect(server.seen.some((request) => request.path.endsWith("/recording"))).toBe(false);

    // Still stuck on the next run, and still exit 1: it is never quiet.
    expect((await resolve(server)).status).toBe(1);

    const retried = await resolve(server, {}, ["--retry-failed"]);
    expect(retried.status, retried.output).toBe(0);
    expect(counts(retried.stdout)).toMatchObject({ skipped: 0, exhausted: 0, resolved: 1 });
    expect(find(await items(db), "track", T1.track).state).toBe("resolved");
  });

  it.each([
    ["--limit with no number", ["--limit"]],
    ["--limit 0", ["--limit", "0"]],
    ["--limit -3", ["--limit", "-3"]],
    ["--limit 1.5", ["--limit", "1.5"]],
    ["--limit abc", ["--limit", "abc"]],
    ["an unknown flag", ["--bogus"]],
    ["a stray word", ["now"]],
  ])("exits 2 before any request for %s", async (_name, args) => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server, {}, args);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage/);
    expect(server.seen).toHaveLength(0);
    expect(await items(db)).toHaveLength(0);
  });
});

describe("resolve-items: no match", () => {
  it("stores an item MusicBrainz cannot match as unresolved, and does not ask again", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog({}));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items(db);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ state: "unresolved", reason: "no_match", mbid: null, match_score: null, matched_name: null });
      expect(row.resolved_at).not.toBeNull();
    }
    expect(counts(result.stdout)).toMatchObject({ new: 3, unresolved: 3, resolved: 0, pending: 0 });

    const seenBefore = server.seen.length;
    await resolve(server);
    expect(server.seen).toHaveLength(seenBefore);
  });

  it("treats a score under MATCH_MIN_SCORE as unresolved and keeps the score and name, and one at the threshold as resolved", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(
      fromCatalog({
        tracks: { [T1.track]: { id: id(61), score: MATCH_MIN_SCORE - 1, title: T1.track, artists: [artistA] } },
        albums: { [T1.album!]: { id: id(62), score: MATCH_MIN_SCORE, title: "SYNTH Album A", artists: [artistA] } },
        artists: { [T1.artist]: { id: id(63), score: MATCH_MIN_SCORE - 1, name: T1.artist } },
      }),
    );

    await resolve(server);

    const rows = await items(db);
    expect(find(rows, "track", T1.track)).toMatchObject({
      state: "unresolved",
      reason: "below_threshold",
      mbid: null,
      match_score: MATCH_MIN_SCORE - 1,
      matched_name: T1.track,
    });
    expect(find(rows, "artist", T1.artist)).toMatchObject({ state: "unresolved", reason: "below_threshold", match_score: MATCH_MIN_SCORE - 1 });
    expect(find(rows, "album", T1.album!)).toMatchObject({ state: "resolved", mbid: id(62), match_score: MATCH_MIN_SCORE });
  });

  it("does not resolve a remix, a different title, a featured credit or a different artist, however high the score, and keeps the refused hit's score and name", async () => {
    await seedPlays(db, [T1, T2, T3]);
    const other = { id: id(70), name: "SYNTH Someone Else" };
    const server = await fake(
      fromCatalog({
        tracks: {
          [T1.track]: { id: id(71), score: 100, title: "SYNTH Song One (SYNTH Remix)", artists: [artistA] },
          [T2.track]: { id: id(72), score: 98, title: T2.track, artists: [other, artistA] },
        },
        albums: { [T1.album!]: { id: id(73), score: 99, title: T1.album!, artists: [other] } },
        artists: { [T3.artist]: { id: id(74), score: 97, name: "SYNTH Artist B and Friends" } },
      }),
    );

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items(db);
    expect(find(rows, "track", T1.track)).toMatchObject({ state: "unresolved", reason: "no_match", mbid: null, match_score: 100, matched_name: "SYNTH Song One (SYNTH Remix)" });
    expect(find(rows, "track", T2.track)).toMatchObject({ state: "unresolved", reason: "no_match", mbid: null, match_score: 98, matched_name: T2.track });
    expect(find(rows, "album", T1.album!)).toMatchObject({ state: "unresolved", reason: "no_match", mbid: null, match_score: 99 });
    expect(find(rows, "artist", T3.artist)).toMatchObject({
      state: "unresolved",
      reason: "no_match",
      mbid: null,
      match_score: 97,
      matched_name: "SYNTH Artist B and Friends",
    });
  });

  it("resolves an artist by an alias MusicBrainz returned in the hit, and not by one it did not", async () => {
    await seedPlays(db, [
      { uri: uri(30), track: "SYNTH Unmatched One", artist: "SYNTH Alias Artist", album: null },
      { uri: uri(31), track: "SYNTH Unmatched Two", artist: "SYNTH Other Artist", album: null },
    ]);
    const server = await fake(
      fromCatalog({
        artists: {
          "SYNTH Alias Artist": { id: id(75), score: 95, name: "SYNTH Legal Name", aliases: ["SYNTH Stage Name", "synth  alias artist"] },
          "SYNTH Other Artist": { id: id(76), score: 95, name: "SYNTH Legal Name Two", aliases: ["SYNTH Stage Name Two"] },
        },
      }),
    );

    await resolve(server);

    const rows = await items(db);
    expect(find(rows, "artist", "SYNTH Alias Artist")).toMatchObject({ state: "resolved", mbid: id(75), matched_name: "SYNTH Legal Name" });
    expect(find(rows, "artist", "SYNTH Other Artist")).toMatchObject({ state: "unresolved", reason: "no_match", match_score: 95 });
  });

  it("has a threshold of 90", () => {
    expect(MATCH_MIN_SCORE).toBe(90);
  });

  it("reaches the real MusicBrainz over https unless MB_API_BASE says otherwise", () => {
    expect(DEFAULT_MB_API_BASE).toBe("https://musicbrainz.org/ws/2");
  });
});

describe("resolve-items: MusicBrainz unavailable", () => {
  const BODY = { error: "synthetic" };
  const noAlbum = { ...T1, album: null };

  it.each([503, 429])(
    "retries a %i with growing waits, leaves the items pending, names the kind once on stderr, and exits 1; a later run settles them",
    async (status) => {
      await seedPlays(db, [noAlbum]);
      const down = await fake(() => ({ status, body: BODY }));

      const result = await resolve(down);

      expect(result.status, result.output).toBe(1);
      // 2 items (the track and its artist), 3 attempts each.
      expect(down.seen).toHaveLength(6);
      const gaps = down.gaps();
      expect(gaps[0]).toBeGreaterThanOrEqual(1000);
      expect(gaps[1]).toBeGreaterThanOrEqual(2000);
      const rows = await items(db);
      expect(rows).toHaveLength(2);
      // An outage says nothing about an item, so no attempt is charged for it.
      for (const row of rows) {
        expect(row).toMatchObject({ state: "pending", mbid: null, reason: null, resolved_at: null, attempts: 0, last_attempt_at: null });
      }
      expect(counts(result.stdout)).toMatchObject({ pending: 2, unresolved: 0, resolved: 0, requests: 6 });
      expect(result.stderr.match(new RegExp(`http_${status}`, "g"))).toHaveLength(1);
      expect(await lockedUntil()).toBeNull();
      expectNoKey(result);

      const up = await fake(fromCatalog({ tracks: { [T1.track]: FULL.tracks![T1.track]! } }));
      const later = await resolve(up);

      expect(later.status, later.output).toBe(0);
      expect(counts(later.stdout)).toMatchObject({ new: 0, resolved: 2, pending: 0 });
      const settled = await items(db);
      expect(settled.map((row) => row.state)).toEqual(["resolved", "resolved"]);
      expect(settled.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    },
    60_000,
  );

  it("honours Retry-After, and a retry that works settles the item", async () => {
    await seedPlays(db, [T1]);
    const catalog = fromCatalog(SMALL);
    const server = await fake((request, count) => (count === 1 ? { status: 429, headers: { "retry-after": "2" }, body: BODY } : catalog(request)));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    expect(server.gaps()[0]).toBeGreaterThanOrEqual(2000);
    expect(server.seen).toHaveLength(3);
    expect(counts(result.stdout)).toMatchObject({ resolved: 3, pending: 0, requests: 3 });
  }, 60_000);

  it("treats a server that cannot be reached as unavailable, names the kind, keeps the items pending and exits 1", async () => {
    await seedPlays(db, [noAlbum]);
    const closed = await startFakeMb(() => ({ status: 200 }));
    const base = closed.base;
    await closed.close();

    const result = await runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: base });

    expect(result.status, result.output).toBe(1);
    expect((await items(db)).map((row) => row.state)).toEqual(["pending", "pending"]);
    expect(counts(result.stdout)).toMatchObject({ pending: 2, requests: 6 });
    expect(result.stderr.match(/connection_refused/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("127.0.0.1");
  }, 60_000);

  it("does not follow a redirect, and reports it as unavailable", async () => {
    await seedPlays(db, [noAlbum]);
    const server = await fake(() => ({ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } }));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(1);
    expect(server.seen.length).toBe(6);
    expect(result.stderr).toMatch(/redirect/);
  }, 60_000);

  it("leaves an item MusicBrainz refuses with a 400 pending with one attempt, goes on, and exits 1", async () => {
    await seedPlays(db, [T1, { ...T2, album: null }]);
    const catalog = fromCatalog(SMALL);
    const server = await fake((request) => (request.fields.recording === T2.track ? { status: 400, body: BODY } : catalog(request)));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(1);
    const rows = await items(db);
    expect(find(rows, "track", T2.track)).toMatchObject({ state: "pending", reason: null, attempts: 1 });
    expect(find(rows, "track", T1.track).state).toBe("resolved");
    expect(counts(result.stdout)).toMatchObject({ pending: 1, resolved: 3, remaining: 0 });
    expect(result.stderr).toMatch(/refused/);
  });

  it("does not settle or charge any item when every lookup is refused, as with a wrong MB_API_BASE", async () => {
    await seedPlays(db, [noAlbum]);
    const server = await fake(() => ({ status: 404, body: BODY }));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(1);
    expect((await items(db)).every((row) => row.state === "pending" && row.attempts === 0)).toBe(true);
    expect(counts(result.stdout)).toMatchObject({ unresolved: 0, pending: 2 });
  });

  it("refreshes the lock lease before every request to MusicBrainz, not only before each item", async () => {
    await seedPlays(db, [noAlbum]);
    const server = await fake(() => ({ status: 503, body: BODY }));
    const seen = new Set<string>();
    const running = startResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: server.base });
    let finished = false;
    void running.done.then(() => void (finished = true));

    while (!finished) {
      const value = await lockedUntil();
      if (value) seen.add(value);
      await new Promise((done) => setTimeout(done, 50));
    }
    const result = await running.done;

    expect(result.status, result.output).toBe(1);
    expect(server.seen).toHaveLength(6);
    // Refreshed only before each item, the lease would take 2 values in this run (one for each item). The retries of one
    // item are seconds apart, and each one starts with a refresh, so the lease takes more values than that.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it.each([401, 403])("stops with exit 1 on a %i and leaves the items pending", async (status) => {
    await seedPlays(db, [noAlbum]);
    const server = await fake(() => ({ status, body: BODY }));

    const result = await resolve(server);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`status ${status}`));
    expect((await items(db)).every((row) => row.state === "pending")).toBe(true);
    expect(server.seen).toHaveLength(1);
    expectNoKey(result);
  });

  it.each([
    ["an answer with no result list", { status: 200, body: { count: 1 } }],
    ["a hit with no usable ID", { status: 200, body: { count: 1, recordings: [{ id: "x", score: "100", title: "t" }] } }],
    ["text that is not JSON", { status: 200, body: undefined }],
  ] as [string, Reply][])("stops with exit 1 on %s, leaves the items pending, and caches nothing", async (_name, reply) => {
    await seedPlays(db, [noAlbum]);
    const server = await fake(() => reply);

    const result = await resolve(server);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MusicBrainz/);
    expect((await items(db)).every((row) => row.state === "pending")).toBe(true);
    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(0);
    expectNoKey(result);
  });

  it("stops with exit 1 on an answer over 1 MB, and caches nothing", async () => {
    await seedPlays(db, [noAlbum]);
    const server = await fake(() => ({ status: 200, body: { count: 0, offset: 0, recordings: [], pad: "x".repeat(1_100_000) } }));

    const result = await resolve(server);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/larger than/);
    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });
});

describe("resolve-items: settings and secrets", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["only spaces", "   "],
    ["holding a line break", "SYNTH-test/0.0\r\nX-Injected: 1"],
    ["holding a character a header cannot carry", "SYNTH-test/0.0 é"],
  ])("exits 2 before any request when MB_USER_AGENT is %s", async (_name, value) => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server, { MB_USER_AGENT: value });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/MB_USER_AGENT/);
    expect(server.seen).toHaveLength(0);
    expect(await items(db)).toHaveLength(0);
    expectNoKey(result);
  });

  it("exits 2 when MB_API_BASE is plain http to another host, or not an address", async () => {
    const plain = await runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: "http://musicbrainz.example/ws/2" });
    const broken = await runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: "not an address" });
    for (const result of [plain, broken]) {
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/MB_API_BASE/);
      expectNoKey(result);
    }
  });

  it("exits 2 when SUPABASE_URL or SUPABASE_SECRET_KEY is missing, or the URL is plain http to another host", async () => {
    const base = { MB_USER_AGENT: USER_AGENT, MB_API_BASE: "http://127.0.0.1:1/ws/2" };
    expect((await runResolve({ ...base, SUPABASE_URL: undefined })).status).toBe(2);
    expect((await runResolve({ ...base, SUPABASE_SECRET_KEY: undefined })).status).toBe(2);
    const remote = await runResolve({ ...base, SUPABASE_URL: "http://db.example" });
    expect(remote.status).toBe(2);
    expectNoKey(remote);
  });

  it("never prints the key, even when the database cannot be reached", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server, { SUPABASE_URL: "http://127.0.0.1:1" });

    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expectNoKey(result);
    expect(server.seen).toHaveLength(0);
  });

  it("never prints a name from the plays", async () => {
    await seedPlays(db, [T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server);

    expect(result.output).not.toContain("SYNTH");
  });
});
