import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../src/files.ts";
import { parseCandidates, trackQuery } from "../src/matching.ts";
import { emptyResolveCounts, resolveItems, type ResolveOptions } from "../src/resolve-items.ts";
import {
  MB_MAX_NAME_LENGTH,
  RESOLVE_MAX_ATTEMPTS,
  RESOLVE_MAX_CONSECUTIVE_REFUSED,
  RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE,
  RESOLVE_PROGRESS_EVERY,
} from "../src/settings.ts";
import { artistA, FULL, fromCatalog, SMALL } from "./support/catalog.ts";
import { clearTables, find, id, items, seedPlays, T1, uri, type PlayInput } from "./support/data.ts";
import { adminClient } from "./support/env.ts";
import { answer } from "./support/fake-mb.ts";
import { inProcess, networkError, type Call, type Fail, type FetchReply } from "./support/inproc.ts";

/**
 * These tests run the resolver in this process, against the local database, with a fake MusicBrainz and a
 * fake clock, so they are fast and exact. The command line itself (exit codes, the lock, output) is tested
 * in resolve-items.test.ts.
 */
const db = adminClient();

type Respond = (call: Call, count: number) => FetchReply | Fail;

async function run(respond: Respond, options: ResolveOptions = {}) {
  const harness = inProcess(db, respond);
  const counts = emptyResolveCounts();
  const outcome = await resolveItems(db, harness.musicbrainz, counts, options).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { ...harness, counts, outcome };
}

const play = (n: number, overrides: Partial<PlayInput> = {}): PlayInput => ({
  uri: uri(n),
  track: `SYNTH Track ${n}`,
  artist: "SYNTH Artist A",
  album: null,
  ...overrides,
});

/** An answer with no hit, whatever is searched. */
const nothing: Respond = (call) => ({
  status: 200,
  body: answer.empty(call.path.endsWith("/recording") ? "recordings" : call.path.endsWith("/artist") ? "artists" : "release-groups"),
});

/** Answers from a catalog, except that a track whose name starts with `prefix` gets `reply`. */
function except(prefix: string, reply: FetchReply | Fail, otherwise: Respond = nothing): Respond {
  return (call, count) => (call.fields.recording?.startsWith(prefix) ? reply : otherwise(call, count));
}

/** Every item that was pending at the start lands in exactly one count. */
function expectPartition(counts: ReturnType<typeof emptyResolveCounts>): void {
  expect(counts.resolved + counts.unresolved + counts.pending + counts.skipped + counts.exhausted + counts.remaining).toBe(counts.total);
}

beforeEach(async () => {
  await clearTables(db);
});

describe("counts", () => {
  it("puts every item in exactly one count: resolved, unresolved, pending, skipped, exhausted or remaining", async () => {
    await seedPlays(db, [
      T1,
      play(10, { track: "SYNTH Nothing Here", artist: "SYNTH Artist N" }),
      play(11, { track: "SYNTH Down", artist: "SYNTH Artist D" }),
      play(12, { track: "SYNTH Capped", artist: "SYNTH Artist E" }),
    ]);
    // An item the plays no longer mention, and one that has already failed as many times as allowed.
    const orphan = await db.from("items").insert({ kind: "track", name: "SYNTH Orphan", source_key: uri(999) });
    const capped = await db.from("items").insert({ kind: "track", name: "SYNTH Capped", source_key: uri(12), attempts: RESOLVE_MAX_ATTEMPTS });
    expect(orphan.error).toBeNull();
    expect(capped.error).toBeNull();
    const catalog = fromCatalog(SMALL);

    const { counts, outcome } = await run(except("SYNTH Down", { status: 503 }, catalog));

    expect(outcome).toBeUndefined();
    // track, album and artist of the first play settle; the track with no hit, and the artists D, N and E, are unresolved.
    // The orphan is skipped: no play names it. The capped one is exhausted: it has failed as often as allowed.
    expect(counts).toMatchObject({ new: 8, total: 10, resolved: 3, unresolved: 4, pending: 1, skipped: 1, exhausted: 1, remaining: 0 });
    expectPartition(counts);
    const rows = await items(db);
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.state === "pending")).toHaveLength(3); // down, capped, orphan
  });

  it("counts an artist settled from a track's credit as resolved, and not as a search", async () => {
    await seedPlays(db, [T1]);

    const { counts, calls } = await run(fromCatalog(SMALL));

    expect(counts).toMatchObject({ total: 3, resolved: 3, unresolved: 0, pending: 0, skipped: 0, exhausted: 0, remaining: 0, requests: 2 });
    expect(calls.map((call) => call.path.split("/").at(-1))).toEqual(["recording", "release-group"]);
  });

  it("counts a credit-settled artist that another run settled first as skipped, so the counts add up and nothing is left remaining", async () => {
    await seedPlays(db, [T1]);
    let beats = 0;

    const { counts, outcome } = await run(fromCatalog(SMALL), {
      heartbeat: async () => {
        beats += 1;
        // Before the first item: another run settles the artist. This run still holds its old view of the row.
        if (beats === 1) {
          const { error } = await db
            .from("items")
            .update({ state: "resolved", mbid: id(88), resolved_at: new Date().toISOString() })
            .eq("kind", "artist")
            .eq("state", "pending");
          if (error) throw new Error(`could not settle the artist: ${error.code}`);
        }
      },
    });

    expect(outcome).toBeUndefined();
    expect(counts).toMatchObject({ total: 3, resolved: 2, unresolved: 0, pending: 0, skipped: 1, exhausted: 0, remaining: 0 });
    expectPartition(counts);
    expect(find(await items(db), "artist", T1.artist)).toMatchObject({ state: "resolved", mbid: id(88) });
  });

  it("reports the requests and cache hits of the run", async () => {
    await seedPlays(db, [T1]);
    await run(fromCatalog(SMALL));
    await db.from("items").delete().neq("id", 0);

    const { counts } = await run(fromCatalog(SMALL));

    expect(counts).toMatchObject({ requests: 0, cache_hits: 2, resolved: 3 });
  });
});

describe("--limit", () => {
  it("processes at most N items, says how many remain, and a later run finishes them", async () => {
    await seedPlays(db, [1, 2, 3, 4, 5].map((n) => play(n)));

    const first = await run(nothing, { limit: 2 });

    expect(first.counts).toMatchObject({ total: 6, unresolved: 2, remaining: 4, pending: 0, skipped: 0 });
    const rows = await items(db);
    expect(rows.filter((row) => row.state === "pending")).toHaveLength(4);
    expect(rows.every((row) => row.attempts === 0)).toBe(true);

    const second = await run(nothing);
    expect(second.counts).toMatchObject({ new: 0, total: 4, unresolved: 4, remaining: 0 });
    expect((await items(db)).every((row) => row.state === "unresolved")).toBe(true);
  });

  it("does not count an artist settled from a credit against the limit", async () => {
    await seedPlays(db, [T1]);

    const { counts } = await run(fromCatalog(FULL), { limit: 2 });

    // The track and the album use the limit. The artist settles from the track's credit, so nothing remains.
    expect(counts).toMatchObject({ total: 3, resolved: 3, remaining: 0 });
  });
});

describe("progress", () => {
  it("prints a line every RESOLVE_PROGRESS_EVERY items, with counts only", async () => {
    expect(RESOLVE_PROGRESS_EVERY).toBe(25);
    await seedPlays(db, Array.from({ length: 60 }, (_, index) => play(index + 1)));
    const lines: string[] = [];

    await run(nothing, { progress: (line) => lines.push(line) });

    // 60 tracks and 1 artist.
    expect(lines).toEqual(["progress: 25 of 61 items", "progress: 50 of 61 items"]);
  });

  it("refreshes the lock before every item it processes", async () => {
    await seedPlays(db, [1, 2, 3].map((n) => play(n)));
    let beats = 0;

    await run(nothing, { heartbeat: async () => void (beats += 1) });

    expect(beats).toBe(4); // 3 tracks and 1 artist
  });

  it("stops the run when the heartbeat says the lock was lost", async () => {
    await seedPlays(db, [1, 2, 3].map((n) => play(n)));
    let beats = 0;

    const { outcome, counts } = await run(nothing, {
      heartbeat: async () => {
        beats += 1;
        if (beats === 2) throw new UserError("lock lost");
      },
    });

    expect(outcome).toBeInstanceOf(UserError);
    expect(counts.unresolved).toBe(1);
  });
});

describe("outages", () => {
  it("keeps the failure kind of each outage and reports each kind once", async () => {
    await seedPlays(db, [play(1, { track: "SYNTH Down A" }), play(2, { track: "SYNTH Down B" }), play(3, { track: "SYNTH Dns" })]);
    const kinds: string[] = [];
    const respond: Respond = (call) =>
      call.fields.recording === "SYNTH Dns" ? { fail: networkError("ENOTFOUND", "getaddrinfo ENOTFOUND x") } : { status: 503 };

    const { counts, outcome } = await run(respond, { onUnavailableKind: (kind) => kinds.push(kind) });

    expect(outcome).toBeUndefined();
    expect(kinds).toEqual(["http_503", "dns"]);
    expect(counts.pending).toBe(4); // three tracks and the artist
  });

  it("records an attempt on each item an outage left pending, and on no other", async () => {
    await seedPlays(db, [T1, play(2, { track: "SYNTH Down" })]);

    await run(except("SYNTH Down", { status: 503 }, fromCatalog(SMALL)));

    const rows = await items(db);
    expect(find(rows, "track", "SYNTH Down")).toMatchObject({ state: "pending", attempts: 1 });
    expect(find(rows, "track", "SYNTH Down").last_attempt_at).not.toBeNull();
    expect(find(rows, "track", T1.track)).toMatchObject({ state: "resolved", attempts: 0, last_attempt_at: null });
  });

  it("stops after RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE unavailable results in a row, says how many items are left, and charges no item", async () => {
    expect(RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE).toBe(5);
    await seedPlays(db, Array.from({ length: 12 }, (_, index) => play(index + 1, { track: `SYNTH Down ${index + 1}` })));

    const { outcome, counts, calls } = await run(() => ({ status: 503 }));

    expect(outcome).toBeInstanceOf(UserError);
    expect((outcome as UserError).message).toMatch(/MusicBrainz/);
    expect(calls).toHaveLength(5 * 3);
    expect(counts).toMatchObject({ total: 13, pending: 5, remaining: 8, exhausted: 0 });
    expectPartition(counts);
    // An outage says nothing about the item that happened to be asked: the one that tripped the stop, and the four before it, are not charged.
    const rows = await items(db);
    expect(rows.every((row) => row.attempts === 0 && row.last_attempt_at === null)).toBe(true);
  });

  it("never exhausts the same items by outage: five runs that each stop on an outage leave every attempt count at zero", async () => {
    await seedPlays(db, Array.from({ length: 12 }, (_, index) => play(index + 1, { track: `SYNTH Down ${index + 1}` })));

    for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt += 1) {
      const { outcome, counts } = await run(() => ({ status: 503 }));
      expect(outcome, `run ${attempt}`).toBeInstanceOf(UserError);
      expect(counts.exhausted).toBe(0);
    }

    const rows = await items(db);
    expect(rows.every((row) => row.state === "pending" && row.attempts === 0)).toBe(true);

    // The sixth run, with MusicBrainz back, still reaches every item.
    const up = await run(nothing);
    expect(up.outcome).toBeUndefined();
    expect(up.counts).toMatchObject({ total: 13, unresolved: 13, exhausted: 0, remaining: 0 });
  });

  it("charges an item only once MusicBrainz has answered another lookup, and not an item that failed at the end of an outage", async () => {
    await seedPlays(db, [play(1, { track: "SYNTH Down 1" }), play(2, { track: "SYNTH Up 2" }), play(3, { track: "SYNTH Down 3" })]);

    await run(except("SYNTH Down", { status: 503 }));

    const rows = await items(db);
    // Down 1 failed, then Up 2 was answered: the failure was the item's own, so it is charged.
    expect(find(rows, "track", "SYNTH Down 1").attempts).toBe(1);
    // The artist search that follows is answered too, so Down 3 is charged as well.
    expect(find(rows, "track", "SYNTH Down 3").attempts).toBe(1);
  });

  it("does not charge an item that fails last in a run with no answer after it", async () => {
    await seedPlays(db, [play(1, { track: "SYNTH Up 1", artist: "  " }), play(2, { track: "SYNTH Down 2", artist: "SYNTH Artist D" })]);

    // The artist search of Artist D is down too, so nothing answers after the failing track.
    const { counts } = await run((call, count) => (call.fields.recording || call.fields.artist ? { status: 503 } : nothing(call, count)));

    const rows = await items(db);
    expect(find(rows, "track", "SYNTH Down 2")).toMatchObject({ state: "pending", attempts: 0 });
    expect(counts.pending).toBe(2);
  });

  it("does not stop when a good answer breaks the run of failures", async () => {
    const names = ["Down", "Down", "Down", "Down", "Up", "Down", "Down", "Down", "Down"];
    await seedPlays(db, names.map((name, index) => play(index + 1, { track: `SYNTH ${name} ${index + 1}` })));

    const { outcome, counts } = await run(except("SYNTH Down", { status: 503 }));

    expect(outcome).toBeUndefined();
    expect(counts.pending).toBe(8);
  });

  it("does not let an answer from the cache break the run of failures, because it says nothing about MusicBrainz", async () => {
    const cached = play(5, { track: "SYNTH Cached" });
    const names = ["Down", "Down", "Down", "Down", "Cached", "Down", "Down"];
    await seedPlays(db, names.map((name, index) => (name === "Cached" ? cached : play(index + 1, { track: `SYNTH Down ${index + 1}` }))));
    // Put the lookup for the cached track in the cache first.
    const warm = inProcess(db, nothing);
    await warm.musicbrainz.search(
      "recording",
      trackQuery({ kind: "track", key: cached.uri, name: cached.track, artist: cached.artist }),
      (body) => parseCandidates(body, "recordings", "title"),
    );

    const { outcome, counts } = await run(except("SYNTH Down", { status: 503 }));

    expect(outcome).toBeInstanceOf(UserError);
    expect(counts.cache_hits).toBe(1);
    expect(counts.pending).toBe(5);
  });

  it("counts an item that has failed RESOLVE_MAX_ATTEMPTS times as exhausted, never as skipped, unless --retry-failed is passed", async () => {
    await seedPlays(db, [T1]);
    await db.from("items").insert({ kind: "track", name: T1.track, source_key: T1.uri, attempts: RESOLVE_MAX_ATTEMPTS });

    const skipped = await run(fromCatalog(SMALL));
    // The album settles. The track is exhausted, so the artist has no credit to settle from and is searched, and unmatched.
    expect(skipped.counts).toMatchObject({ skipped: 0, exhausted: 1, resolved: 1, unresolved: 1 });
    expectPartition(skipped.counts);
    expect(skipped.calls.some((call) => call.path.endsWith("/recording"))).toBe(false);
    expect(find(await items(db), "track", T1.track).state).toBe("pending");

    const retried = await run(fromCatalog(SMALL), { retryFailed: true });
    expect(retried.counts).toMatchObject({ skipped: 0, exhausted: 0, resolved: 1 });
    expect(find(await items(db), "track", T1.track).state).toBe("resolved");
  });

  it("counts an item as exhausted in the run in which it reaches the limit, and tries it no more until --retry-failed", async () => {
    await seedPlays(db, [T1]);
    await db.from("items").insert({ kind: "track", name: T1.track, source_key: T1.uri, attempts: RESOLVE_MAX_ATTEMPTS - 1 });

    // The track is down, and the album that follows is answered, so the failure was the track's own.
    const reached = await run(except(T1.track, { status: 503 }, fromCatalog(SMALL)));
    expect(reached.counts).toMatchObject({ pending: 0, exhausted: 1 });
    expectPartition(reached.counts);
    expect(find(await items(db), "track", T1.track)).toMatchObject({ state: "pending", attempts: RESOLVE_MAX_ATTEMPTS });

    const after = await run(fromCatalog(SMALL));
    expect(after.counts.exhausted).toBe(1);
    expect(after.calls.some((call) => call.fields.recording === T1.track)).toBe(false);
  });

  it("keeps counting attempts on a retried item that is still down, and keeps it exhausted", async () => {
    await seedPlays(db, [T1]);
    await db.from("items").insert({ kind: "track", name: T1.track, source_key: T1.uri, attempts: RESOLVE_MAX_ATTEMPTS });

    const { counts } = await run(except(T1.track, { status: 503 }, fromCatalog(SMALL)), { retryFailed: true });

    expect(find(await items(db), "track", T1.track).attempts).toBe(RESOLVE_MAX_ATTEMPTS + 1);
    expect(counts.exhausted).toBe(1);
    expectPartition(counts);
  });

  it("settles pending items on a later run when MusicBrainz is back", async () => {
    await seedPlays(db, [T1]);
    const down = await run(() => ({ status: 503 }));
    expect(down.counts.pending).toBe(3); // the track, its album and its artist
    const rows = await items(db);
    expect(rows.every((row) => row.state === "pending")).toBe(true);

    const up = await run(fromCatalog(SMALL));

    expect(up.counts).toMatchObject({ new: 0, resolved: 3, pending: 0 });
    expect((await items(db)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });
});

describe("a bad item does not stop the run", () => {
  it("leaves an item MusicBrainz refuses (a 400) pending with one attempt, never settling it on first sight, and goes on", async () => {
    await seedPlays(db, [T1, play(2, { track: "SYNTH Refused" })]);
    const catalog = fromCatalog(SMALL);

    const { outcome, counts, calls } = await run(except("SYNTH Refused", { status: 400, body: { error: "synthetic" } }, catalog));

    expect(outcome).toBeUndefined();
    const rows = await items(db);
    expect(find(rows, "track", "SYNTH Refused")).toMatchObject({ state: "pending", reason: null, mbid: null, attempts: 1 });
    expect(find(rows, "track", "SYNTH Refused").last_attempt_at).not.toBeNull();
    expect(find(rows, "track", T1.track).state).toBe("resolved");
    expect(counts.pending).toBe(1);
    expectPartition(counts);
    expect(calls.filter((call) => call.fields.recording === "SYNTH Refused")).toHaveLength(1);
  });

  it("settles a refused item as unresolved bad_query only when its attempts reach RESOLVE_MAX_ATTEMPTS", async () => {
    await seedPlays(db, [play(1, { track: "SYNTH Refused" })]);

    for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt += 1) {
      // A good item that follows each time, so MusicBrainz is seen to answer and the refusal is the item's own.
      await seedPlays(db, [play(100 + attempt, { track: `SYNTH Fine ${attempt}`, artist: "SYNTH Artist F" })]);
      const { counts } = await run(except("SYNTH Refused", { status: 400, body: { error: "synthetic" } }));

      const refused = find(await items(db), "track", "SYNTH Refused");
      if (attempt < RESOLVE_MAX_ATTEMPTS) {
        expect(refused, `run ${attempt}`).toMatchObject({ state: "pending", attempts: attempt, reason: null });
        expect(counts.pending, `run ${attempt}`).toBe(1);
      } else {
        expect(refused).toMatchObject({ state: "unresolved", reason: "bad_query", mbid: null });
        expect(counts.pending).toBe(0);
        expectPartition(counts);
      }
    }
  });

  it("burns nothing for good when the address is wrong or the answer is a 408: no attempt is charged and no item is settled", async () => {
    for (const status of [404, 408]) {
      await clearTables(db);
      await seedPlays(db, Array.from({ length: 9 }, (_, index) => play(index + 1)));

      const { outcome } = await run(() => ({ status }));

      expect(outcome, `status ${status}`).toBeInstanceOf(UserError);
      const rows = await items(db);
      expect(rows.every((row) => row.state === "pending" && row.attempts === 0 && row.reason === null), `status ${status}`).toBe(true);
    }
  });

  it("stops the run on a 401 or a 403, leaving the item pending", async () => {
    for (const status of [401, 403]) {
      await clearTables(db);
      await seedPlays(db, [T1]);

      const { outcome, counts } = await run(() => ({ status }));

      expect(outcome).toBeInstanceOf(UserError);
      expect(counts).toMatchObject({ pending: 0, unresolved: 0 });
      expect((await items(db)).every((row) => row.state === "pending")).toBe(true);
    }
  });

  it("stops after RESOLVE_MAX_CONSECUTIVE_REFUSED refusals in a row, so a wrong address cannot settle or charge any item", async () => {
    expect(RESOLVE_MAX_CONSECUTIVE_REFUSED).toBe(5);
    await seedPlays(db, Array.from({ length: 9 }, (_, index) => play(index + 1)));

    const { outcome, counts, calls } = await run(() => ({ status: 404 }));

    expect(outcome).toBeInstanceOf(UserError);
    expect(calls).toHaveLength(5);
    expect(counts).toMatchObject({ unresolved: 0, pending: 5, remaining: 5 });
    expectPartition(counts);
    expect((await items(db)).every((row) => row.state === "pending" && row.attempts === 0)).toBe(true);
  });

  it("makes no request for a name over MB_MAX_NAME_LENGTH, and settles it as name_too_long", async () => {
    expect(MB_MAX_NAME_LENGTH).toBe(200);
    const exact = "e".repeat(MB_MAX_NAME_LENGTH);
    const long = "l".repeat(MB_MAX_NAME_LENGTH + 1);
    await seedPlays(db, [play(1, { track: long }), play(2, { track: exact })]);

    const { counts, calls } = await run(nothing);

    const rows = await items(db);
    expect(find(rows, "track", long)).toMatchObject({ state: "unresolved", reason: "name_too_long", match_score: null });
    expect(find(rows, "track", exact)).toMatchObject({ state: "unresolved", reason: "no_match" });
    expect(calls.map((call) => call.fields.recording)).toContain(exact);
    expect(calls.map((call) => call.fields.recording)).not.toContain(long);
    expect(counts.unresolved).toBe(3);
  });

  it("treats a too-long artist as name_too_long for the artist and for its tracks, and leaves a too-long album out of the track search", async () => {
    const long = "l".repeat(MB_MAX_NAME_LENGTH + 1);
    await seedPlays(db, [play(1, { artist: long }), play(2, { album: long })]);

    const { calls } = await run(nothing);

    const rows = await items(db);
    expect(find(rows, "artist", long)).toMatchObject({ reason: "name_too_long" });
    expect(find(rows, "track", "SYNTH Track 1")).toMatchObject({ reason: "name_too_long" });
    expect(find(rows, "album", long)).toMatchObject({ reason: "name_too_long" });
    const second = calls.find((call) => call.fields.recording === "SYNTH Track 2");
    expect(second).toBeDefined();
    expect(second?.fields.release).toBeUndefined();
  });

  it("never searches a track or an album by its title alone: with no artist it is unresolved with reason no_artist", async () => {
    await seedPlays(db, [play(1, { artist: "  ", album: "SYNTH Album X" })]);

    const { calls, counts } = await run(nothing);

    expect(calls).toHaveLength(0);
    const rows = await items(db);
    expect(find(rows, "track", "SYNTH Track 1")).toMatchObject({ state: "unresolved", reason: "no_artist" });
    expect(find(rows, "album", "SYNTH Album X")).toMatchObject({ state: "unresolved", reason: "no_artist" });
    expect(rows.find((row) => row.kind === "artist")).toMatchObject({ state: "unresolved", reason: "empty_name" });
    expect(counts).toMatchObject({ unresolved: 3, requests: 0 });
  });
});

describe("matching safety", () => {
  const hit = (overrides: Record<string, unknown> = {}) => ({
    id: id(21),
    score: 100,
    title: T1.track,
    artists: [artistA],
    ...overrides,
  });
  const track = (...hits: ReturnType<typeof hit>[]) => fromCatalog({ tracks: { [T1.track]: hits } });

  it("refuses a hit whose credited artist is not the artist played", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);

    await run(track(hit({ artists: [{ id: id(99), name: "SYNTH Someone Else" }] })));

    const rows = await items(db);
    expect(find(rows, "track", T1.track)).toMatchObject({ state: "unresolved", reason: "no_match", mbid: null });
    // The artist was not settled from that track's credit, so it was searched on its own.
    expect(find(rows, "artist", T1.artist).reason).not.toBe("credit");
  });

  it("accepts a hit when a credit is the artist already matched, even under another name", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);
    await db.from("items").insert({
      kind: "artist",
      name: T1.artist,
      source_key: "synth artist a",
      state: "resolved",
      mbid: artistA.id,
      resolved_at: new Date().toISOString(),
    });

    await run(track(hit({ artists: [{ id: artistA.id, name: "SYNTH Artist A (stylized)" }] })));

    expect(find(await items(db), "track", T1.track)).toMatchObject({ state: "resolved", mbid: id(21) });
  });

  it("refuses a remix, and a hit that credits the played artist only as a guest, even at a score of 95", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);

    await run(track(hit({ score: 95, title: "SYNTH Song One (SYNTH Other Remix)" })));
    expect(find(await items(db), "track", T1.track)).toMatchObject({
      state: "unresolved",
      reason: "no_match",
      mbid: null,
      match_score: 95,
      matched_name: "SYNTH Song One (SYNTH Other Remix)",
    });

    await clearTables(db);
    await seedPlays(db, [{ ...T1, album: null }]);
    await run(track(hit({ score: 95, artists: [{ id: id(99), name: "SYNTH Main Act" }, artistA] })));
    expect(find(await items(db), "track", T1.track)).toMatchObject({ state: "unresolved", reason: "no_match", mbid: null, match_score: 95 });
  });

  it("accepts a hit that credits the played artist first and a guest after, and settles the artist from the first credit", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);

    await run(track(hit({ artists: [artistA, { id: id(99), name: "SYNTH Guest" }] })));

    const rows = await items(db);
    expect(find(rows, "track", T1.track)).toMatchObject({ state: "resolved", mbid: id(21) });
    expect(find(rows, "artist", T1.artist)).toMatchObject({ state: "resolved", mbid: artistA.id, reason: "credit" });
  });

  it("records ambiguous, and settles nothing, when two different IDs both score at or above the threshold", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);

    await run(track(hit(), hit({ id: id(22), score: 95 })));

    expect(find(await items(db), "track", T1.track)).toMatchObject({
      state: "unresolved",
      reason: "ambiguous",
      mbid: null,
      match_score: 100,
    });
  });

  it("compares the raw score with the threshold: 89.6 is below 90", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);

    await run(track(hit({ score: 89.6 })));

    expect(find(await items(db), "track", T1.track)).toMatchObject({ state: "unresolved", reason: "below_threshold", mbid: null });
  });

  it("settles an artist from a track's credit with match_score null and reason credit, never the track's score", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);

    const { calls } = await run(track(hit({ score: 97 })));

    const rows = await items(db);
    expect(find(rows, "track", T1.track).match_score).toBe(97);
    expect(find(rows, "artist", T1.artist)).toMatchObject({
      state: "resolved",
      mbid: artistA.id,
      match_score: null,
      matched_name: artistA.name,
      reason: "credit",
    });
    expect(calls.some((call) => call.path.endsWith("/artist"))).toBe(false);
  });

  it("retries once without the album when no result matches the exact album phrase", async () => {
    await seedPlays(db, [T1]);
    const withoutAlbum = track(hit());
    const respond: Respond = (call, count) => (call.fields.release !== undefined ? nothing(call, count) : withoutAlbum(call));

    const { calls } = await run(respond);

    const searches = calls.filter((call) => call.path.endsWith("/recording"));
    expect(searches.map((call) => call.fields.release)).toEqual([T1.album, undefined]);
    expect(find(await items(db), "track", T1.track)).toMatchObject({ state: "resolved", mbid: id(21) });
  });

  it("retries only once, and not when the first search found hits", async () => {
    await seedPlays(db, [T1]);

    const none = await run(nothing);
    expect(none.calls.filter((call) => call.path.endsWith("/recording"))).toHaveLength(2);

    await clearTables(db);
    await seedPlays(db, [T1]);
    const low = await run(track(hit({ score: 50 })));
    expect(low.calls.filter((call) => call.path.endsWith("/recording"))).toHaveLength(1);
    expect(find(await items(db), "track", T1.track).reason).toBe("below_threshold");
  });

  it("strips NUL characters from what MusicBrainz sends, so the names and the cache can be stored", async () => {
    await seedPlays(db, [{ ...T1, album: null }]);
    const body = answer.recording(hit({ title: "SYNTH Song\u0000 One", artists: [{ id: artistA.id, name: "SYNTH Artist A" }] }));

    const { outcome } = await run((call) =>
      call.path.endsWith("/recording") ? { status: 200, text: JSON.stringify(body) } : nothing(call, 0),
    );

    expect(outcome).toBeUndefined();
    expect(find(await items(db), "track", T1.track)).toMatchObject({ state: "resolved", matched_name: "SYNTH Song One" });
    const { data } = await db.from("mb_cache").select("candidates");
    expect(JSON.stringify(data)).not.toContain("\\u0000");
  });
});

describe("size", () => {
  it("pages over more than 1000 items, and settles every one", async () => {
    const tracks = 1010;
    await seedPlays(db, Array.from({ length: tracks }, (_, index) => play(index + 1)));

    const { counts, outcome } = await run(nothing);

    expect(outcome).toBeUndefined();
    expect(counts).toMatchObject({ new: tracks + 1, total: tracks + 1, unresolved: tracks + 1, remaining: 0 });
    const rows = await items(db);
    expect(rows).toHaveLength(tracks + 1);
    expect(rows.every((row) => row.state === "unresolved")).toBe(true);

    // A second run finds nothing new and nothing to settle.
    const again = await run(nothing);
    expect(again.counts).toMatchObject({ new: 0, total: 0, requests: 0 });
  }, 180_000);

  it("finishes the work a stopped run left, with no item searched twice", async () => {
    await seedPlays(db, [1, 2, 3, 4, 5, 6].map((n) => play(n)));
    const seen: string[] = [];
    const record: Respond = (call, count) => {
      seen.push(`${call.path}:${call.fields.recording ?? call.fields.artist}`);
      return nothing(call, count);
    };

    const stopped = await run(record, { limit: 3 });
    expect(stopped.counts.remaining).toBe(4);
    const resumed = await run(record);

    expect(resumed.counts).toMatchObject({ new: 0, total: 4, unresolved: 4, remaining: 0 });
    expect(new Set(seen).size).toBe(seen.length);
    expect((await items(db)).every((row) => row.state === "unresolved")).toBe(true);
  });
});
