import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { counts, runImport, runImportAsync } from "./support/cli.ts";
import { adminClient, localStack } from "./support/env.ts";

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

async function allPlays() {
  const { data, error } = await db.from("plays").select("*").order("id");
  if (error) throw new Error(`Could not read plays: ${error.code}`);
  return data ?? [];
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
      read: 10,
      imported: 5,
      duplicate: 1,
      dropped: 4,
      podcast: 3,
      private_session: 1,
      malformed: 0,
    });

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
    expect(new Date(first.ended_at).toISOString()).toBe("2024-01-01T10:00:00.000Z");
    // Boundaries: zero is kept, the largest integer column value is kept, a missing album stays null.
    expect(rows[1]).toMatchObject({ ms_played: 0, album_name: null });
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
      read: 10,
      imported: 0,
      duplicate: 6,
      dropped: 4,
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
      read: 13,
      imported: 7,
      duplicate: 2,
      dropped: 4,
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
      malformed: 15,
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
          ms_played: 1234,
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
      ms_played: 1000 + i,
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

describe("import-export connection failures", () => {
  it("names a missing SUPABASE_URL", () => {
    const result = runImport(basic, { SUPABASE_URL: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPABASE_URL");
  });

  it("names a missing SUPABASE_SECRET_KEY", () => {
    const result = runImport(basic, { SUPABASE_SECRET_KEY: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPABASE_SECRET_KEY");
  });

  it("fails clearly, without echoing the key, when the database rejects the key", async () => {
    const bad = "not-a-real-key-0123456789";
    const result = runImport(basic, { SUPABASE_SECRET_KEY: bad });

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(result.output).not.toContain(bad);
    expect(await allPlays()).toHaveLength(0);
  });

  it("fails clearly when nothing listens at the address", () => {
    const result = runImport(basic, { SUPABASE_URL: "http://127.0.0.1:1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(result.output).not.toContain("Synthetic");
  });
});
