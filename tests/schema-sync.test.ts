import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "hanna-fm-ingest-sync-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Builds a fake site clone and a fake ingest clone, runs the script in the ingest one. */
function setup(name: string) {
  const site = join(scratch, name, "site");
  const ingest = join(scratch, name, "ingest");
  mkdirSync(join(site, "supabase", "migrations"), { recursive: true });
  mkdirSync(join(ingest, "supabase", "migrations"), { recursive: true });
  return { site, ingest };
}

function sync(cwd: string, env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HANNA_FM_PATH: undefined, ...env };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const result = spawnSync(
    join(root, "node_modules", ".bin", "tsx"),
    [join(root, "src", "schema-sync.ts")],
    { cwd, env: childEnv, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("schema:sync", () => {
  it("copies the site's migrations over the vendored ones and leaves other files alone", () => {
    const { site, ingest } = setup("copy");
    const migrations = join(site, "supabase", "migrations");
    writeFileSync(join(migrations, "20260101000000_a.sql"), "-- site a\n");
    writeFileSync(join(migrations, "20260102000000_b.sql"), "-- site b\n");
    writeFileSync(join(migrations, "notes.txt"), "not a migration");
    writeFileSync(join(ingest, "supabase", "migrations", "20260101000000_a.sql"), "-- stale\n");
    writeFileSync(join(ingest, "supabase", "migrations", "20260103000000_local.sql"), "-- keep\n");

    const result = sync(ingest, { HANNA_FM_PATH: site });

    expect(result.status).toBe(0);
    const target = join(ingest, "supabase", "migrations");
    expect(readFileSync(join(target, "20260101000000_a.sql"), "utf8")).toBe("-- site a\n");
    expect(readFileSync(join(target, "20260102000000_b.sql"), "utf8")).toBe("-- site b\n");
    expect(readdirSync(target).sort()).toEqual([
      "20260101000000_a.sql",
      "20260102000000_b.sql",
      "20260103000000_local.sql",
    ]);
    expect(result.stdout).toMatch(/2/);
  });

  it("fails and names HANNA_FM_PATH when it is not set", () => {
    const { ingest } = setup("unset");
    const result = sync(ingest, {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HANNA_FM_PATH");
  });

  it("fails and copies nothing when the path holds no migrations folder", () => {
    const { ingest } = setup("missing");
    const result = sync(ingest, { HANNA_FM_PATH: join(scratch, "missing", "nowhere") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/supabase\/migrations/);
    expect(readdirSync(join(ingest, "supabase", "migrations"))).toEqual([]);
  });

  it("fails when the site's migrations folder has no .sql files", () => {
    const { site, ingest } = setup("empty");
    const result = sync(ingest, { HANNA_FM_PATH: site });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no .*\.sql/i);
  });
});
