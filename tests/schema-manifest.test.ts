import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrations = join(process.cwd(), "supabase", "migrations");
const manifestPath = join(process.cwd(), "supabase", "vendored-migrations.manifest.json");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("vendored migrations", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    migrations: Record<string, string>;
  };

  it("match the checksum manifest that schema:sync wrote", () => {
    for (const [name, checksum] of Object.entries(manifest.migrations)) {
      expect(sha256(join(migrations, name)), `${name} changed since schema:sync`).toBe(checksum);
    }
  });

  it("are all listed in the manifest, so none was added by hand", () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
    expect(Object.keys(manifest.migrations).sort()).toEqual(files);
  });

  it("are named <14-digit version>_<name>.sql", () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith(".sql"));
    for (const name of files) expect(name, name).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("each carry a version no other vendored migration uses, because Supabase rejects a repeat", () => {
    const versions = readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0]);
    expect(new Set(versions).size, `versions: ${versions.join(", ")}`).toBe(versions.length);
  });

  it("run the items migration after plays", () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
    expect(files.indexOf("20261123010000_plays.sql")).toBeGreaterThanOrEqual(0);
    expect(files.indexOf("20261123040000_items.sql")).toBeGreaterThan(files.indexOf("20261123010000_plays.sql"));
  });

  it("hold the plays table from the frozen contract, with its ended_at index", () => {
    const plays = readFileSync(join(migrations, "20261123010000_plays.sql"), "utf8");
    expect(plays.startsWith("create table public.plays (")).toBe(true);
    expect(plays).toContain("create index plays_ended_at_idx on public.plays (ended_at);");
  });
});
