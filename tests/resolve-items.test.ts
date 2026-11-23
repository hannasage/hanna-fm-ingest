import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MB_API_BASE, MATCH_MIN_SCORE } from "../src/settings.ts";
import { counts, runResolve, type CliResult } from "./support/cli.ts";
import { adminClient, anonClient, localStack } from "./support/env.ts";
import { answer, startFakeMb, type FakeMb, type Reply, type Seen } from "./support/fake-mb.ts";

const db = adminClient();
const USER_AGENT = "SYNTH-resolve-test/0.0 ( synthetic-contact.invalid )";

/** Made-up IDs. None of them belongs to any real artist, album or recording. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = {
  id: number;
  kind: string;
  mbid: string | null;
  name: string;
  source_key: string;
  spotify_uri: string | null;
  state: string;
  reason: string | null;
  match_score: number | null;
  matched_name: string | null;
  merged_into: number | null;
  resolved_at: string | null;
  created_at: string;
};

async function items(): Promise<Row[]> {
  const { data, error } = await db.from("items").select("*").order("id");
  if (error) throw new Error(`could not read items: ${error.code}`);
  return data as Row[];
}

function find(rows: Row[], kind: string, name: string): Row {
  const row = rows.find((candidate) => candidate.kind === kind && candidate.name === name);
  if (!row) throw new Error(`no ${kind} item named ${name}`);
  return row;
}

type PlayInput = { uri: string; track: string; artist: string; album: string | null };

async function seedPlays(inputs: PlayInput[]): Promise<void> {
  const rows = inputs.map((input, index) => ({
    track_uri: input.uri,
    track_name: input.track,
    artist_name: input.artist,
    album_name: input.album,
    ended_at: new Date(Date.UTC(2024, 0, 1, 0, index)).toISOString(),
    ms_played: 200_000,
    source: "export",
  }));
  const { error } = await db.from("plays").insert(rows);
  if (error) throw new Error(`could not seed plays: ${error.code}`);
}

const uri = (n: number) => `spotify:track:SYNTH${String(n).padStart(18, "0")}`;
const T1: PlayInput = { uri: uri(1), track: "SYNTH Song One", artist: "SYNTH Artist A", album: "SYNTH Album A" };
const T2: PlayInput = { uri: uri(2), track: "SYNTH Song Two", artist: "SYNTH Artist A", album: "SYNTH Album A" };
const T3: PlayInput = { uri: uri(3), track: "SYNTH Song Three", artist: "SYNTH Artist B", album: "SYNTH Album B" };

type Catalog = {
  tracks?: Record<string, { id: string; score: number; title: string; artists: { id: string; name: string }[] }>;
  albums?: Record<string, { id: string; score: number; title: string }>;
  artists?: Record<string, { id: string; score: number; name: string }>;
};

/** Answers a search from a table of synthetic hits. Anything not in the table gets an empty list. */
function fromCatalog(catalog: Catalog): (request: Seen) => Reply {
  return (request) => {
    if (request.path.endsWith("/recording")) {
      const hit = catalog.tracks?.[request.fields.recording ?? ""];
      return { status: 200, body: hit ? answer.recording(hit) : answer.empty("recordings") };
    }
    if (request.path.endsWith("/release-group")) {
      const hit = catalog.albums?.[request.fields.releasegroup ?? ""];
      return { status: 200, body: hit ? answer.releaseGroup(hit) : answer.empty("release-groups") };
    }
    if (request.path.endsWith("/artist")) {
      const hit = catalog.artists?.[request.fields.artist ?? ""];
      return { status: 200, body: hit ? answer.artist(hit) : answer.empty("artists") };
    }
    return { status: 404 };
  };
}

const artistA = { id: id(11), name: "SYNTH Artist A" };
/** Credited under another spelling, so the artist row cannot be settled from the track and needs its own search. */
const artistBCredit = { id: id(12), name: "SYNTH Artist B (credited)" };

/** Three tracks, two albums, two artists. Artist A is settled from a track's credit. Artist B needs a search. */
const FULL: Catalog = {
  tracks: {
    "SYNTH Song One": { id: id(21), score: 100, title: "SYNTH Song One", artists: [artistA] },
    "SYNTH Song Two": { id: id(22), score: 97, title: "SYNTH Song Two", artists: [artistA] },
    "SYNTH Song Three": { id: id(23), score: 95, title: "SYNTH Song Three", artists: [artistBCredit] },
  },
  albums: {
    "SYNTH Album A": { id: id(31), score: 100, title: "SYNTH Album A" },
    "SYNTH Album B": { id: id(32), score: 92, title: "SYNTH Album B" },
  },
  artists: { "SYNTH Artist B": { id: id(12), score: 100, name: "SYNTH Artist B" } },
};

/** One track and its album, for the tests that need few requests. */
const SMALL: Catalog = { tracks: { [T1.track]: FULL.tracks![T1.track]! }, albums: { [T1.album!]: FULL.albums![T1.album!]! } };

let servers: FakeMb[] = [];
async function fake(respond: (request: Seen, count: number) => Reply): Promise<FakeMb> {
  const server = await startFakeMb(respond);
  servers.push(server);
  return server;
}

function resolve(server: FakeMb, env: Record<string, string | undefined> = {}): Promise<CliResult> {
  return runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: server.base, ...env });
}

function expectNoKey(...results: CliResult[]): void {
  const { key } = localStack();
  for (const result of results) expect(result.output.includes(key)).toBe(false);
}

beforeEach(async () => {
  for (const [table, column, empty] of [
    ["items", "id", 0],
    ["mb_cache", "query", ""],
    ["plays", "id", 0],
  ] as const) {
    const { error } = await db.from(table).delete().neq(column, empty);
    if (error) throw new Error(`could not clear ${table}: ${error.code}`);
  }
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

describe("resolve-items: stored items", () => {
  it("stores every artist, album and track with an MBID and a Spotify alias", async () => {
    await seedPlays([T1, T2, T3, T1]);
    const server = await fake(fromCatalog(FULL));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items();
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.state === "resolved" && row.resolved_at !== null)).toBe(true);

    const song = find(rows, "track", "SYNTH Song One");
    expect(song).toMatchObject({
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

  it("settles an artist from a track's credit with no request, and searches when the credit name differs", async () => {
    await seedPlays([T1, T2, T3]);
    const server = await fake(fromCatalog(FULL));

    const result = await resolve(server);

    const rows = await items();
    expect(find(rows, "artist", "SYNTH Artist A")).toMatchObject({
      mbid: artistA.id,
      state: "resolved",
      source_key: "synth artist a",
      spotify_uri: null,
    });
    expect(find(rows, "artist", "SYNTH Artist B").mbid).toBe(id(12));
    const artistSearches = server.seen.filter((request) => request.path.endsWith("/artist"));
    expect(artistSearches.map((request) => request.fields.artist)).toEqual(["SYNTH Artist B"]);
    // 3 tracks, 2 albums, 1 artist search.
    expect(server.seen).toHaveLength(6);
    expect(counts(result.stdout)).toMatchObject({ new: 7, resolved: 7, unresolved: 0, pending: 0, requests: 6, cache_hits: 0 });
  });

  it("searches by track, artist and album, and by album and artist, asking for JSON and one hit", async () => {
    await seedPlays([T1]);
    const server = await fake(fromCatalog(SMALL));

    await resolve(server);

    const [track, album] = server.seen;
    expect(track?.path).toBe("/ws/2/recording");
    expect(track?.fields).toEqual({ recording: T1.track, artistname: T1.artist, release: T1.album });
    expect(album?.path).toBe("/ws/2/release-group");
    expect(album?.fields).toEqual({ releasegroup: T1.album, artistname: T1.artist });
    for (const request of server.seen) {
      expect(request.params.get("fmt")).toBe("json");
      expect(request.params.get("limit")).toBe("1");
      expect(request.accept).toBe("application/json");
    }
  });

  it("sends the User-Agent exactly as set in MB_USER_AGENT", async () => {
    await seedPlays([T1]);
    const server = await fake(fromCatalog(SMALL));

    await resolve(server);

    expect(server.seen.length).toBeGreaterThan(0);
    for (const request of server.seen) expect(request.userAgent).toBe(USER_AGENT);
  });

  it("keeps the exact text of names with quotes, backslashes and emoji in the search, and one artist for spellings that differ only in case", async () => {
    const odd = 'SYNTH "Quoted" \\ Song \u{1F3B5}';
    await seedPlays([
      { uri: uri(5), track: odd, artist: "SYNTH Artist A", album: null },
      { uri: uri(6), track: "SYNTH Plain", artist: "synth  artist a", album: null },
    ]);
    const server = await fake(fromCatalog({ tracks: { [odd]: { id: id(41), score: 100, title: odd, artists: [artistA] } } }));

    await resolve(server);

    expect(server.seen[0]?.fields.recording).toBe(odd);
    const rows = await items();
    expect(rows.filter((row) => row.kind === "artist")).toHaveLength(1);
  });

  it("records a blank name as unresolved with no request for it, and leaves a blank album out", async () => {
    await seedPlays([{ uri: uri(7), track: "SYNTH Blank Artist Song", artist: "  ", album: " " }]);
    const server = await fake(fromCatalog({}));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items();
    expect(rows.filter((row) => row.kind === "album")).toHaveLength(0);
    expect(rows.find((row) => row.kind === "artist")).toMatchObject({ state: "unresolved", reason: "empty_name" });
    expect(server.seen.map((request) => request.fields)).toEqual([{ recording: "SYNTH Blank Artist Song" }]);
  });

  it("keeps a second Spotify track for the same recording, pointing at the row that holds the MBID", async () => {
    await seedPlays([
      { uri: uri(8), track: "SYNTH Single Version", artist: "SYNTH Artist A", album: null },
      { uri: uri(9), track: "SYNTH Album Version", artist: "SYNTH Artist A", album: null },
    ]);
    const hit = (title: string) => ({ id: id(51), score: 100, title, artists: [artistA] });
    const server = await fake(
      fromCatalog({ tracks: { "SYNTH Single Version": hit("SYNTH Single Version"), "SYNTH Album Version": hit("SYNTH Album Version") } }),
    );

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items();
    const first = find(rows, "track", "SYNTH Single Version");
    const second = find(rows, "track", "SYNTH Album Version");
    expect(first).toMatchObject({ mbid: id(51), merged_into: null, state: "resolved" });
    expect(second).toMatchObject({ mbid: null, merged_into: first.id, state: "resolved", spotify_uri: uri(9) });
  });
});

describe("resolve-items: queue and cache", () => {
  it("never sends more than one request a second, measured at the server", async () => {
    await seedPlays([T1, T2, T3]);
    const server = await fake(fromCatalog(FULL));

    const result = await resolve(server);

    expect(server.seen.length).toBeGreaterThanOrEqual(4);
    const gaps = server.gaps();
    expect(gaps.length).toBe(server.seen.length - 1);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1000);
    expect(counts(result.stdout).requests).toBe(server.seen.length);
  });

  it("serves a repeat run from the stored items, and a rebuilt table from the cache, with no request", async () => {
    await seedPlays([T1]);
    const server = await fake(fromCatalog(SMALL));

    const first = await resolve(server);
    const before = await items();
    expect(server.seen).toHaveLength(2);
    expect(counts(first.stdout).requests).toBe(2);

    const second = await resolve(server);
    expect(server.seen).toHaveLength(2);
    expect(counts(second.stdout)).toMatchObject({ new: 0, requests: 0, cache_hits: 0 });
    expect(await items()).toEqual(before);

    // Lose the item rows. The answers are still cached, so the lookups need no request.
    const { error } = await db.from("items").delete().neq("id", 0);
    expect(error).toBeNull();
    const third = await resolve(server);
    expect(third.status, third.output).toBe(0);
    expect(server.seen).toHaveLength(2);
    expect(counts(third.stdout)).toMatchObject({ new: 3, requests: 0, cache_hits: 2, resolved: 3 });
    const after = await items();
    expect(after.map((row) => [row.kind, row.mbid])).toEqual(before.map((row) => [row.kind, row.mbid]));

    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(2);
  });

  it("does not make two runs at once create duplicate items", async () => {
    await seedPlays([T1, T2]);
    const server = await fake(fromCatalog(FULL));

    const [a, b] = await Promise.all([
      runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: server.base }),
      runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: server.base }),
    ]);

    expect(a.status, a.output).toBe(0);
    expect(b.status, b.output).toBe(0);
    const rows = await items();
    // 2 tracks, 1 album, 1 artist.
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => `${row.kind}|${row.source_key}`)).size).toBe(4);
    expect(rows.every((row) => row.state === "resolved")).toBe(true);
    expect(new Set(rows.map((row) => row.mbid)).size).toBe(4);
    expectNoKey(a, b);
  });
});

describe("resolve-items: no match", () => {
  it("stores an item MusicBrainz cannot match as unresolved, and does not ask again", async () => {
    await seedPlays([T1]);
    const server = await fake(fromCatalog({}));

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    const rows = await items();
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
    await seedPlays([T1]);
    const server = await fake(
      fromCatalog({
        tracks: { [T1.track]: { id: id(61), score: MATCH_MIN_SCORE - 1, title: "SYNTH Song One (other)", artists: [artistA] } },
        albums: { [T1.album!]: { id: id(62), score: MATCH_MIN_SCORE, title: "SYNTH Album A" } },
        artists: { [T1.artist]: { id: id(63), score: MATCH_MIN_SCORE - 1, name: "SYNTH Artist A (other)" } },
      }),
    );

    await resolve(server);

    const rows = await items();
    expect(find(rows, "track", T1.track)).toMatchObject({
      state: "unresolved",
      reason: "below_threshold",
      mbid: null,
      match_score: MATCH_MIN_SCORE - 1,
      matched_name: "SYNTH Song One (other)",
    });
    expect(find(rows, "artist", T1.artist)).toMatchObject({ state: "unresolved", reason: "below_threshold", match_score: MATCH_MIN_SCORE - 1 });
    expect(find(rows, "album", T1.album!)).toMatchObject({ state: "resolved", mbid: id(62), match_score: MATCH_MIN_SCORE });
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

  it.each([503, 429])(
    "retries a %i with growing waits, then records the items as pending, not unresolved, and settles them on a later run",
    async (status) => {
      await seedPlays([{ ...T1, album: null }]);
      const down = await fake(() => ({ status, body: BODY }));

      const result = await resolve(down);

      expect(result.status, result.output).toBe(0);
      // 2 items (the track and its artist), 3 attempts each.
      expect(down.seen).toHaveLength(6);
      const gaps = down.gaps();
      expect(gaps[0]).toBeGreaterThanOrEqual(1000);
      expect(gaps[1]).toBeGreaterThanOrEqual(2000);
      const rows = await items();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ state: "pending", mbid: null, reason: null, resolved_at: null });
      }
      expect(counts(result.stdout)).toMatchObject({ pending: 2, unresolved: 0, resolved: 0, requests: 6 });
      expectNoKey(result);

      const up = await fake(fromCatalog({ tracks: { [T1.track]: FULL.tracks![T1.track]! } }));
      const later = await resolve(up);

      expect(later.status, later.output).toBe(0);
      expect(counts(later.stdout)).toMatchObject({ new: 0, resolved: 2, pending: 0 });
      const settled = await items();
      expect(settled.map((row) => row.state)).toEqual(["resolved", "resolved"]);
      expect(settled.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    },
    60_000,
  );

  it("honours Retry-After, and a retry that works settles the item", async () => {
    await seedPlays([T1]);
    const catalog = fromCatalog(SMALL);
    const server = await fake((request, count) =>
      count === 1 ? { status: 429, headers: { "retry-after": "2" }, body: BODY } : catalog(request),
    );

    const result = await resolve(server);

    expect(result.status, result.output).toBe(0);
    expect(server.gaps()[0]).toBeGreaterThanOrEqual(2000);
    expect(server.seen).toHaveLength(3);
    expect(counts(result.stdout)).toMatchObject({ resolved: 3, pending: 0, requests: 3 });
  }, 60_000);

  it("treats a server that cannot be reached as unavailable, so the items stay pending", async () => {
    await seedPlays([{ ...T1, album: null }]);
    const closed = await startFakeMb(() => ({ status: 200 }));
    const base = closed.base;
    await closed.close();

    const result = await runResolve({ MB_USER_AGENT: USER_AGENT, MB_API_BASE: base });

    expect(result.status, result.output).toBe(0);
    expect((await items()).map((row) => row.state)).toEqual(["pending", "pending"]);
    expect(counts(result.stdout)).toMatchObject({ pending: 2, requests: 6 });
  }, 60_000);

  it.each([
    ["a refusal (400)", { status: 400, body: BODY }],
    ["an answer with no result list", { status: 200, body: { count: 1 } }],
    ["a hit with no usable ID", { status: 200, body: { count: 1, recordings: [{ id: "x", score: "100", title: "t" }] } }],
  ] as [string, Reply][])("stops with exit 1 on %s, and leaves the items pending", async (_name, reply) => {
    await seedPlays([{ ...T1, album: null }]);
    const server = await fake(() => reply);

    const result = await resolve(server);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MusicBrainz/);
    expect((await items()).every((row) => row.state === "pending")).toBe(true);
    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(0);
    expectNoKey(result);
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
    await seedPlays([T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server, { MB_USER_AGENT: value });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/MB_USER_AGENT/);
    expect(server.seen).toHaveLength(0);
    expect(await items()).toHaveLength(0);
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
    await seedPlays([T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server, { SUPABASE_URL: "http://127.0.0.1:1" });

    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expectNoKey(result);
    expect(server.seen).toHaveLength(0);
  });

  it("never prints a name from the plays", async () => {
    await seedPlays([T1]);
    const server = await fake(fromCatalog(SMALL));

    const result = await resolve(server);

    expect(result.output).not.toContain("SYNTH");
  });
});

describe("items tables: browser roles", () => {
  it("lets the browser roles read and write nothing in items or mb_cache", async () => {
    const anon = anonClient();
    for (const table of ["items", "mb_cache"]) {
      const read = await anon.from(table).select("*").limit(1);
      expect(read.error?.code, `${table} read`).toBe("42501");
      const write = await anon.from(table).insert({});
      expect(write.error?.code, `${table} write`).toBe("42501");
    }
  });

  it("turns row-level security on and forces it, and grants nothing on either table or the sequence", () => {
    const queries = [
      `select string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity, ',' order by c.relname)
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('items', 'mb_cache')`,
      `select string_agg(r || ':' || t || ':' || has_table_privilege(r, 'public.' || t, 'select,insert,update,delete,references,trigger,truncate'), ',' order by r, t)
      from unnest(array['anon', 'authenticated', 'public']) r, unnest(array['items', 'mb_cache']) t`,
      `select string_agg(r || ':' || has_sequence_privilege(r, 'public.items_id_seq', 'usage,select,update'), ',' order by r)
      from unnest(array['anon', 'authenticated']) r`,
    ];
    const out = execFileSync(
      "docker",
      ["exec", "supabase_db_hanna-fm-ingest", "psql", "-U", "postgres", "-At", ...queries.flatMap((query) => ["-c", query])],
      { encoding: "utf8" },
    ).trim().split("\n");
    expect(out[0]).toBe("items:true:true,mb_cache:true:true");
    expect(out[1]).not.toContain(":true");
    expect(out[2]).toBe("anon:false,authenticated:false");
  });
});
