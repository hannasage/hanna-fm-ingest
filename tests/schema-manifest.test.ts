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

  it("hold the plays table from the frozen contract, with its ended_at index", () => {
    const plays = readFileSync(join(migrations, "20261123010000_plays.sql"), "utf8");
    expect(plays.startsWith("create table public.plays (")).toBe(true);
    expect(plays).toContain("create index plays_ended_at_idx on public.plays (ended_at);");
  });
});
