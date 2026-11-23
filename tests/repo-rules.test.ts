import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/leaks.ts";

function isIgnored(path: string, cwd: string = process.cwd()): boolean {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", path], { cwd, stdio: "ignore" });
    return true;
  } catch (error) {
    // `git check-ignore` exits 1 when the path is not ignored. Any other exit is a real failure.
    if ((error as { status?: number | null }).status === 1) return false;
    throw error;
  }
}

describe("git ignore rules", () => {
  it.each([
    ".env",
    ".env.local",
    "data/anything.txt",
    "exports/anything.txt",
    "StreamingHistory_music_0.json",
    "Streaming_History_Audio_2020_0.json",
    "tests/fixtures/Streaming_History_Audio_2020_0.json",
    "tests/fixtures/real.export.json",
    "tests/fixtures/endsong_0.json",
    "my_spotify_data.zip",
    "history.csv",
    "events.ndjson",
    "library-export.json",
    "full.export.json",
    "backup.dump",
    "supabase/.temp/project-ref",
    "supabase/.env",
    "node_modules/pkg/index.js",
    "dist/cli.js",
    "scratch.sql",
    "supabase/dump.sql",
  ])("ignores %s", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([
    ".env.example",
    "package.json",
    "supabase/config.toml",
    "supabase/seed.sql",
    "supabase/migrations/20261123010000_plays.sql",
    "tests/fixtures/basic.fixture.json",
    "tests/fixtures/Streaming_History_Audio_x.fixture.json",
  ])("does not ignore %s", (path) => {
    expect(isIgnored(path)).toBe(false);
  });

  it("rethrows when git fails for a reason other than 'not ignored'", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "hanna-fm-ingest-not-a-repo-"));
    try {
      expect(() => isIgnored(".env", notARepo)).toThrow();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("fixtures", () => {
  const fixtures = filesUnder(join(process.cwd(), "tests", "fixtures"));

  it("has fixtures to check, all named *.fixture.json", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const file of fixtures) expect(file).toMatch(/\.fixture\.json$/);
  });
});

describe("tracked JSON files", () => {
  // Tracked and not-yet-committed files, minus anything ignored.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.json"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "");

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("hold only the synthetic markers: 203.0.113.x IPs, SYNTH ids, country ZZ", () => {
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        expect(ip, `${file} holds a non-documentation IP address`).toMatch(/^203\.0\.113\.\d{1,3}$/);
      }
      for (const uri of text.match(/spotify:(?:track|episode):[A-Za-z0-9]+/g) ?? []) {
        expect(uri, `${file} holds a track or episode ID that is not synthetic`).toMatch(
          /^spotify:(?:track|episode):SYNTH/,
        );
      }
      for (const match of text.matchAll(/"conn_country"\s*:\s*"([^"]*)"/g)) {
        expect(match[1], `${file} holds a country that is not ZZ`).toBe("ZZ");
      }
    }
  });
});

describe("local Supabase ports", () => {
  it("keeps every port in this repository's own range, 56330 to 56339", () => {
    const config = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");
    // Commented lines are skipped, except the two sample mail ports this file moved into range.
    const ports = [...config.matchAll(/^\s*(?:#\s*(?=smtp_port|pop3_port))?\w*port\w*\s*=\s*(\d+)/gm)].map((m) =>
      Number(m[1]),
    );
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      expect(port, `port ${port} is outside 56330-56339`).toBeGreaterThanOrEqual(56330);
      expect(port, `port ${port} is outside 56330-56339`).toBeLessThanOrEqual(56339);
    }
  });

  it("names its own project, so it never touches another stack's containers", () => {
    const config = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");
    expect(config).toMatch(/^project_id = "hanna-fm-ingest"$/m);
  });
});
