import { cpSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COLUMN_KEYS, SIGNAL_KEYS } from "../src/mapping.ts";
import { counts, runImport, runImportAsync } from "./support/cli.ts";
import { adminClient, localStack } from "./support/env.ts";
import { startProxy } from "./support/proxy.ts";

const fixtures = join(process.cwd(), "tests", "fixtures");
const basic = join(fixtures, "basic.fixture.json");
const second = join(fixtures, "second.fixture.json");
const malformed = join(fixtures, "malformed.fixture.json");

const db = adminClient();
const scratch = mkdtempSync(join(tmpdir(), "hanna-fm-ingest-tests-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A new empty folder for one test. */
function folder(name: string): string {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** One valid play row. `id` makes the track unique. Pass `over` to change or add keys. */
function play(id: string | number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2024-05-01T00:00:00Z",
    ms_played: 200000,
    master_metadata_track_name: `Synthetic Track ${id}`,
    master_metadata_album_artist_name: "Synthetic Artist X",
    master_metadata_album_album_name: "Synthetic Album X",
    spotify_track_uri: `spotify:track:SYNTHX${String(id).padStart(12, "0")}`,
    episode_name: null,
    spotify_episode_uri: null,
    incognito_mode: false,
    ...over,
  };
}

/** Writes rows to a new folder and returns the file path. */
function writeRows(name: string, rows: unknown[]): string {
  const path = join(folder(name), `${name}.fixture.json`);
  writeFileSync(path, JSON.stringify(rows));
  return path;
}

/** A row without one key. */
function without(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...row };
  delete copy[key];
  return copy;
}

/** Every stored play. The API returns at most 1000 rows a request, so this reads page by page. */
async function allPlays() {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("plays")
      .select("*")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`Could not read plays: ${error.code}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

beforeEach(async () => {
  const { error } = await db.from("plays").delete().gt("id", 0);
  if (error) throw new Error(`Could not clear plays: ${error.code}`);
});

// Every value that must never reach the database or the terminal.
const PRIVATE_MARKERS = [
  "203.0.113.",
  "ZZ",
  "SYNTH-PLATFORM",
  "SYNTH-UA",
  "PODCAST",
  "PRIVATE",
  "spotify:episode",
];

describe("import-export", () => {
  it("imports the expected plays from one file and reports counts", async () => {
    const result = runImport(basic);

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toEqual({
      read: 11,
      imported: 5,
      duplicate: 1,
      dropped: 5,
      podcast: 2,
      private_session: 1,
      no_track: 1,
      too_short: 1,
      malformed: 0,
      not_attempted: 0,
    });
    expect(result.stderr).toBe("");

    const rows = await allPlays();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.track_uri)).toEqual([
      "spotify:track:SYNTH000000000000000001",
      "spotify:track:SYNTH000000000000000002",
      "spotify:track:SYNTH000000000000000003",
      "spotify:track:SYNTH000000000000000004",
      "spotify:track:SYNTH000000000000000005",
    ]);
    const first = rows[0]!;
    expect(first).toMatchObject({
      track_name: "Synthetic Song One",
      artist_name: "Synthetic Artist A",
      album_name: "Synthetic Album A",
      ms_played: 215000,
      source: "export",
    });
    expect(new Date(first.ended_at as string).toISOString()).toBe("2024-01-01T10:00:00.000Z");
    // Boundaries: the shortest kept play (30000 ms) is kept, the largest integer column value is kept,
    // and a missing album stays null. A play of 29999 ms is dropped as too short.
    expect(rows[1]).toMatchObject({ ms_played: 30000, album_name: null });
    expect(rows[2]).toMatchObject({ ms_played: 2147483647 });
    expect(rows.every((r) => r.source === "export")).toBe(true);
  });

  it("stores no IP, country, user agent, platform, podcast or private-session data", async () => {
    runImport(basic);
    const rows = await allPlays();
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "album_name",
          "artist_name",
          "created_at",
          "ended_at",
          "id",
          "ms_played",
          "source",
          "track_name",
          "track_uri",
        ].sort(),
      );
    }
    const stored = JSON.stringify(rows);
    for (const marker of PRIVATE_MARKERS) {
      expect(stored, `a stored row holds "${marker}"`).not.toContain(marker);
    }
  });

  it("stores nothing new on a second import", async () => {
    runImport(basic);
    const before = await allPlays();

    const again = runImport(basic);

    expect(again.status).toBe(0);
    expect(counts(again.stdout)).toMatchObject({
      read: 11,
      imported: 0,
      duplicate: 6,
      dropped: 5,
    });
    expect(await allPlays()).toEqual(before);
  });

  it("imports a directory of files, ignores other files, and counts repeats across files", async () => {
    const dir = folder("directory");
    cpSync(basic, join(dir, "Streaming_History_Audio_a.fixture.json"));
    cpSync(second, join(dir, "Streaming_History_Audio_b.fixture.json"));
    writeFileSync(join(dir, "notes.txt"), "not an export file");

    const result = runImport(dir);

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({
      read: 14,
      imported: 7,
      duplicate: 2,
      dropped: 5,
    });
    expect(await allPlays()).toHaveLength(7);
  });

  it("counts malformed rows as dropped, keeps the good row, and prints no row content", async () => {
    const result = runImport(malformed);

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toEqual({
      read: 16,
      imported: 1,
      duplicate: 0,
      dropped: 15,
      podcast: 0,
      private_session: 0,
      no_track: 1,
      too_short: 0,
      malformed: 14,
      not_attempted: 0,
    });
    const rows = await allPlays();
    expect(rows.map((r) => r.track_uri)).toEqual(["spotify:track:SYNTHMALGOOD0000000001"]);
    expect(result.output).not.toContain("Synthetic Malformed");
    expect(result.output).not.toContain("not a date");
  });

  it("keeps Unicode, emoji and SQL characters intact", async () => {
    const path = join(folder("special"), "special.fixture.json");
    const name = "Sÿnthetic 🎵 日本語 '; DROP TABLE plays; --";
    writeFileSync(
      path,
      JSON.stringify([
        {
          ts: "2024-04-01T00:00:00Z",
          ms_played: 123456,
          incognito_mode: false,
          master_metadata_track_name: name,
          master_metadata_album_artist_name: "Artíst \"Quoted\" \\ Slash",
          master_metadata_album_album_name: "Álbum 🌙",
          spotify_track_uri: "spotify:track:SYNTHSPECIAL000000001",
        },
      ]),
    );

    expect(runImport(path).status).toBe(0);

    const rows = await allPlays();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      track_name: name,
      artist_name: 'Artíst "Quoted" \\ Slash',
      album_name: "Álbum 🌙",
    });
  });

  it("imports more than ten thousand plays, then stores nothing on a repeat", async () => {
    const path = join(folder("large"), "large.fixture.json");
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      ts: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString(),
      ms_played: 30000 + i,
      incognito_mode: false,
      master_metadata_track_name: `Synthetic Track ${i}`,
      master_metadata_album_artist_name: "Synthetic Artist L",
      master_metadata_album_album_name: "Synthetic Album L",
      spotify_track_uri: `spotify:track:SYNTHLARGE${String(i).padStart(12, "0")}`,
    }));
    writeFileSync(path, JSON.stringify(rows));

    const first = runImport(path);
    expect(first.status).toBe(0);
    expect(counts(first.stdout)).toMatchObject({ read: 12_000, imported: 12_000, duplicate: 0 });

    const again = runImport(path);
    expect(counts(again.stdout)).toMatchObject({ read: 12_000, imported: 0, duplicate: 12_000 });
    const { count } = await db.from("plays").select("*", { count: "exact", head: true });
    expect(count).toBe(12_000);
  }, 120_000);

  it("stores each play once when two imports of the same file run at the same time", async () => {
    const [a, b] = await Promise.all([runImportAsync(basic), runImportAsync(basic)]);

    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(counts(a.stdout).imported! + counts(b.stdout).imported!).toBe(5);
    expect(await allPlays()).toHaveLength(5);
  });

  it("never prints a row's content, a private value or the key", () => {
    const result = runImport(basic);
    const { key } = localStack();

    expect(result.status).toBe(0);
    expect(result.output).not.toContain(key);
    for (const text of ["Synthetic", "spotify:", "SYNTH", ...PRIVATE_MARKERS]) {
      expect(result.output, `the output holds "${text}"`).not.toContain(text);
    }
  });
});

describe("import-export input failures", () => {
  const cases: { name: string; make: () => string | undefined; says: RegExp }[] = [
    {
      name: "no path argument",
      make: () => undefined,
      says: /path/i,
    },
    {
      name: "a path that does not exist",
      make: () => join(scratch, "does-not-exist"),
      says: /not found|does not exist/i,
    },
    {
      name: "an empty directory",
      make: () => folder("empty"),
      says: /no .*json/i,
    },
    {
      name: "a file that is not JSON",
      make: () => {
        const path = join(folder("bad-json"), "broken.fixture.json");
        writeFileSync(path, '[{"track": "SYNTH-LEAK-CHECK", ');
        return path;
      },
      says: /not valid JSON/i,
    },
    {
      name: "JSON that is not a list of plays",
      make: () => {
        const path = join(folder("not-a-list"), "object.fixture.json");
        writeFileSync(path, '{"track": "SYNTH-LEAK-CHECK"}');
        return path;
      },
      says: /list/i,
    },
    {
      name: "a directory with one good file and one broken file",
      make: () => {
        const dir = folder("half-broken");
        cpSync(basic, join(dir, "a.fixture.json"));
        writeFileSync(join(dir, "b.fixture.json"), "SYNTH-LEAK-CHECK {");
        return dir;
      },
      says: /not valid JSON/i,
    },
  ];

  it.each(cases)("fails clearly and stores nothing for $name", async ({ make, says }) => {
    const result = runImport(make());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(says);
    expect(result.output).not.toContain("SYNTH-LEAK-CHECK");
    expect(await allPlays()).toHaveLength(0);
  });
});

describe("import-export drop rules", () => {
  it("drops a row as private unless the private flag is exactly false", async () => {
    const odd = [
      without(play(1), SIGNAL_KEYS.private_session),
      play(2, { [SIGNAL_KEYS.private_session]: null }),
      play(3, { [SIGNAL_KEYS.private_session]: "false" }),
      play(4, { [SIGNAL_KEYS.private_session]: 0 }),
      play(5, { [SIGNAL_KEYS.private_session]: "true" }),
      play(6, { [SIGNAL_KEYS.private_session]: true }),
    ];
    const path = writeRows("failsafe", [...odd, play(7)]);

    const result = runImport(path);

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({ read: 7, imported: 1, private_session: 6, dropped: 6 });
    expect((await allPlays()).map((r) => r.track_uri)).toEqual(["spotify:track:SYNTHX000000000007"]);
  });

  it("drops a play under 30000 ms as too_short, keeps 30000, and still calls a negative one malformed", async () => {
    const path = writeRows("min-play", [
      play(1, { ms_played: 29999 }),
      play(2, { ms_played: 30000 }),
      play(3, { ms_played: 0 }),
      play(4, { ms_played: -1 }),
      play(5, { ms_played: 29999, episode_name: "SYNTH-PODCAST-EPISODE-NAME" }),
    ]);

    const result = runImport(path);

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toMatchObject({
      read: 5,
      imported: 1,
      too_short: 2,
      malformed: 1,
      podcast: 1,
    });
    expect((await allPlays()).map((r) => r.ms_played)).toEqual([30000]);
  });

  it("drops a row with no usable track URI as no_track, and calls a podcast only a row with episode fields", async () => {
    const path = writeRows("no-track", [
      play(1, { spotify_track_uri: null }),
      play(2, { spotify_track_uri: "" }),
      play(3, { spotify_track_uri: 12345 }),
      play(4, { spotify_track_uri: "spotify:local:SYNTH:SYNTH:SYNTH:1" }),
      play(5, { spotify_track_uri: "spotify:episode:SYNTH000000000000000E02" }),
      play(6, { spotify_track_uri: "spotify:track:" }),
      without(play(7), COLUMN_KEYS.track_uri),
      play(8, { episode_name: "SYNTH-PODCAST-EPISODE-NAME" }),
      play(9, { spotify_track_uri: null, spotify_episode_uri: "spotify:episode:SYNTH000000000000000E03" }),
      play(10, { incognito_mode: true, episode_name: "SYNTH-PODCAST-EPISODE-NAME" }),
      play(11),
    ]);

    const result = runImport(path);

    expect(result.status).toBe(0);
    expect(counts(result.stdout)).toEqual({
      read: 11,
      imported: 1,
      duplicate: 0,
      dropped: 10,
      podcast: 2,
      private_session: 1,
      no_track: 7,
      too_short: 0,
      malformed: 0,
      not_attempted: 0,
    });
  });

  it("exits 1 with a plain message, after the counts, when nothing was stored and nothing was a repeat", () => {
    const path = writeRows("all-private", [
      without(play(1), SIGNAL_KEYS.private_session),
      without(play(2), SIGNAL_KEYS.private_session),
    ]);

    const result = runImport(path);

    expect(result.status).toBe(1);
    expect(counts(result.stdout)).toMatchObject({ read: 2, imported: 0, duplicate: 0, private_session: 2 });
    expect(result.stderr).toContain(
      "Nothing was stored, and no play was a repeat. Either a key name in src/mapping.ts does not match the export, or every row was dropped. The counts above show which.\n",
    );
  });

  it("exits 0 on a rerun where every play is a repeat", () => {
    runImport(basic);
    expect(runImport(basic).status).toBe(0);
  });
});

describe("import-export mapping warning", () => {
  it("names the one mapped key that no row in a file holds, once, without any row content", () => {
    const path = writeRows("one-key-missing", [
      without(play(1), SIGNAL_KEYS.private_session),
      without(play(2), SIGNAL_KEYS.private_session),
    ]);

    const result = runImport(path);

    expect(result.stderr).toContain(
      'warning: one-key-missing.fixture.json: no row holds the mapped key: "incognito_mode".\n',
    );
    expect(result.stderr.match(/warning:/g)).toHaveLength(1);
    expect(result.output).not.toContain("Synthetic");
  });

  it("names every mapped key when a file uses other names", () => {
    const path = writeRows("all-keys-missing", [{ timestamp: "2024-01-01", song: "SYNTH-LEAK-CHECK" }]);

    const result = runImport(path);

    const line = result.stderr.split("\n").find((l) => l.startsWith("warning:")) ?? "";
    for (const key of [...Object.values(COLUMN_KEYS), ...Object.values(SIGNAL_KEYS)]) {
      expect(line, `the warning does not name ${key}`).toContain(`"${key}"`);
    }
    expect(result.output).not.toContain("SYNTH-LEAK-CHECK");
  });

  it("warns once for each file that needs it, and stays quiet for a good file", () => {
    const dir = folder("warn-per-file");
    writeFileSync(join(dir, "a.fixture.json"), JSON.stringify([without(play(1), "ts")]));
    writeFileSync(join(dir, "b.fixture.json"), JSON.stringify([without(play(2), "ts"), play(3)]));
    writeFileSync(join(dir, "c.fixture.json"), JSON.stringify([without(play(4), "ts")]));
    cpSync(basic, join(dir, "d.fixture.json"));

    const result = runImport(dir);

    const warnings = result.stderr.split("\n").filter((l) => l.startsWith("warning:"));
    expect(warnings).toEqual([
      'warning: a.fixture.json: no row holds the mapped key: "ts".',
      'warning: c.fixture.json: no row holds the mapped key: "ts".',
    ]);
  });
});

describe("import-export file checks", () => {
  it("rejects a path that is not a regular file, before reading it", () => {
    const result = runImport("/dev/null");

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("The path is not a regular file.\n");
  });

  it("rejects a file over 500 MB, before reading it, and stores nothing", async () => {
    const dir = folder("too-big");
    cpSync(basic, join(dir, "a.fixture.json"));
    const big = join(dir, "b.fixture.json");
    writeFileSync(big, "");
    truncateSync(big, 500 * 1024 * 1024 + 1); // a sparse file: it takes no disk space

    const result = runImport(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("b.fixture.json is larger than the 500 MB limit.\n");
    expect(await allPlays()).toHaveLength(0);
  });
});

/** The first line of the command's error output. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

describe("import-export connection failures", () => {
  it("names a missing SUPABASE_URL", () => {
    const result = runImport(basic, { SUPABASE_URL: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SUPABASE_URL is not set.\n");
    expect(result.stdout).toBe("");
  });

  it("names a missing SUPABASE_SECRET_KEY", () => {
    const result = runImport(basic, { SUPABASE_SECRET_KEY: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SUPABASE_SECRET_KEY is not set.\n");
    expect(result.stdout).toBe("");
  });

  it("rejects an address that is not a URL", () => {
    const result = runImport(basic, { SUPABASE_URL: "not a url" });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SUPABASE_URL is not a valid address.\n");
  });

  it.each(["http://example.com", "http://192.0.2.1:54321", "ftp://localhost"])(
    "rejects %s: an address must be https unless the host is localhost or 127.0.0.1",
    (url) => {
      const result = runImport(basic, { SUPABASE_URL: url });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        "SUPABASE_URL must start with https://, unless the host is localhost or 127.0.0.1.\n",
      );
      expect(result.stdout).toBe("");
    },
  );

  it("rejects an http address before it sends the key anywhere", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // 0.0.0.0 reaches the local listener, but it is neither localhost nor 127.0.0.1.
      const result = await runImportAsync(basic, { SUPABASE_URL: `http://0.0.0.0:${port}` });
      expect(result.status).toBe(2);
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("allows an http address on localhost", () => {
    const result = runImport(basic, { SUPABASE_URL: "http://localhost:1" });
    // It passes the address check and then fails to connect, which is exit 1, not 2.
    expect(result.status).toBe(1);
  });

  it("fails with the exact message, without echoing the key, when the database rejects the key", async () => {
    const bad = "not-a-real-key-0123456789";
    const result = runImport(basic, { SUPABASE_SECRET_KEY: bad });

    expect(result.status).toBe(1);
    expect(firstLine(result.stderr)).toBe(
      "The database refused a batch (code PGRST301). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: plays already stored are skipped.",
    );
    expect(result.output).not.toContain(bad);
    expect(await allPlays()).toHaveLength(0);
  });

  it("fails with the exact message when nothing listens at the address", () => {
    const result = runImport(basic, { SUPABASE_URL: "http://127.0.0.1:1" });

    expect(result.status).toBe(1);
    expect(firstLine(result.stderr)).toBe(
      "The database refused a batch (code none). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: plays already stored are skipped.",
    );
    expect(result.stdout).toBe("");
    expect(result.output).not.toContain("Synthetic");
  });
});

describe("import-export database failures", () => {
  const BATCHES = 1200; // two full batches of 500 and one of 200
  const bigRows = () => [
    ...Array.from({ length: 10 }, (_, i) => play(`d${i}`, { episode_name: "SYNTH-PODCAST-EPISODE-NAME" })),
    ...Array.from({ length: BATCHES }, (_, i) =>
      play(i, { ts: new Date(Date.UTC(2021, 0, 1) + i * 60_000).toISOString() }),
    ),
  ];

  it("prints partial counts to stderr and nothing to stdout when a later batch fails", async () => {
    const path = writeRows("partial", bigRows());
    const proxy = await startProxy((write) => (write === 2 ? { status: 500, body: "{}" } : { pass: true }));
    try {
      const result = await runImportAsync(path, { SUPABASE_URL: proxy.url });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(firstLine(result.stderr)).toBe(
        "The database refused a batch (code none). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again: plays already stored are skipped.",
      );
      expect(result.stderr).toContain("partial: true\n");
      const reported = counts(result.stderr);
      expect(reported).toMatchObject({ read: 1210, imported: 500, duplicate: 0, dropped: 10, podcast: 10 });
      // Every row read is in exactly one count.
      expect(reported.not_attempted).toBe(700);
      expect(
        reported.imported! + reported.duplicate! + reported.dropped! + reported.not_attempted!,
      ).toBe(reported.read);
      expect(await allPlays()).toHaveLength(500);
    } finally {
      await proxy.close();
    }
  });

  it("finishes on a rerun after a later batch failed: the stored set is complete, with no repeats", async () => {
    const path = writeRows("rerun", bigRows());
    const proxy = await startProxy((write) => (write === 2 ? { status: 500, body: "{}" } : { pass: true }));
    try {
      expect((await runImportAsync(path, { SUPABASE_URL: proxy.url })).status).toBe(1);
    } finally {
      await proxy.close();
    }
    expect(await allPlays()).toHaveLength(500);

    const rerun = runImport(path);

    expect(rerun.status).toBe(0);
    expect(counts(rerun.stdout)).toMatchObject({
      read: 1210,
      imported: 700,
      duplicate: 500,
      dropped: 10,
      not_attempted: 0,
    });
    const rows = await allPlays();
    expect(rows).toHaveLength(BATCHES);
    expect(new Set(rows.map((r) => `${r.track_uri}|${r.ended_at}`)).size).toBe(BATCHES);
  });

  it("fails when the database returns no data and no error", async () => {
    const proxy = await startProxy(() => ({ status: 201, body: "null" }));
    try {
      const result = await runImportAsync(basic, { SUPABASE_URL: proxy.url });

      expect(result.status).toBe(1);
      expect(firstLine(result.stderr)).toBe(
        "The database gave no answer for a batch, so nothing can be counted. Run the command again: plays already stored are skipped.",
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("partial: true\n");
    } finally {
      await proxy.close();
    }
  });

  it("prints a database error code only when it is a plain token", async () => {
    const safe = await startProxy(() => ({
      status: 400,
      body: JSON.stringify({ code: "PGRST999", message: "SYNTH-LEAK-CHECK", details: null, hint: null }),
    }));
    const unsafe = await startProxy(() => ({
      status: 400,
      body: JSON.stringify({ code: "bad code: SYNTH-LEAK-CHECK <b>", message: "SYNTH-LEAK-CHECK", details: null, hint: null }),
    }));
    try {
      const a = await runImportAsync(basic, { SUPABASE_URL: safe.url });
      const b = await runImportAsync(basic, { SUPABASE_URL: unsafe.url });

      expect(firstLine(a.stderr)).toContain("(code PGRST999)");
      expect(firstLine(b.stderr)).toContain("(code unknown)");
      expect(a.output).not.toContain("SYNTH-LEAK-CHECK");
      expect(b.output).not.toContain("SYNTH-LEAK-CHECK");
    } finally {
      await safe.close();
      await unsafe.close();
    }
  });
});
