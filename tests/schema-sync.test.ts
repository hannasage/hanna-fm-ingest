import { createHash } from "node:crypto";
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

function run(script: string, cwd: string, env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HANNA_FM_PATH: undefined, ...env };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const result = spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(root, "src", script)], {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const sync = (cwd: string, env: Record<string, string | undefined>) => run("schema-sync.ts", cwd, env);
const check = (cwd: string, env: Record<string, string | undefined> = {}) =>
  run("schema-check.ts", cwd, env);

const MANIFEST = "vendored-migrations.manifest.json";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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

describe("schema:sync manifest", () => {
  it("writes a checksum manifest of every vendored migration", () => {
    const { site, ingest } = setup("manifest");
    const migrations = join(site, "supabase", "migrations");
    writeFileSync(join(migrations, "20260101000000_a.sql"), "-- site a\n");
    writeFileSync(join(migrations, "20260102000000_b.sql"), "-- site b\n");
    writeFileSync(join(ingest, "supabase", "migrations", "20260103000000_local.sql"), "-- keep\n");

    expect(sync(ingest, { HANNA_FM_PATH: site }).status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(ingest, "supabase", MANIFEST), "utf8"));
    expect(manifest).toEqual({
      migrations: {
        "20260101000000_a.sql": sha("-- site a\n"),
        "20260102000000_b.sql": sha("-- site b\n"),
        "20260103000000_local.sql": sha("-- keep\n"),
      },
    });
  });

  it("writes no manifest when it fails", () => {
    const { ingest } = setup("manifest-fail");
    expect(sync(ingest, {}).status).not.toBe(0);
    expect(readdirSync(join(ingest, "supabase"))).not.toContain(MANIFEST);
  });
});

describe("schema:check", () => {
  /** A site clone and an ingest clone that were just synced. */
  function synced(name: string) {
    const { site, ingest } = setup(name);
    const migrations = join(site, "supabase", "migrations");
    writeFileSync(join(migrations, "20260101000000_a.sql"), "-- site a\n");
    writeFileSync(join(migrations, "20260102000000_b.sql"), "-- site b\n");
    expect(sync(ingest, { HANNA_FM_PATH: site }).status).toBe(0);
    return { site, ingest, vendored: join(ingest, "supabase", "migrations") };
  }

  it("passes and says it did not compare with a site clone when HANNA_FM_PATH is not set", () => {
    const { ingest } = synced("check-unset");
    const result = check(ingest);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "The vendored migrations match the manifest.\nHANNA_FM_PATH is not set, so they were not compared with a site clone.\n",
    );
  });

  it("passes when the vendored copy matches the manifest and the site clone", () => {
    const { site, ingest } = synced("check-match");
    const result = check(ingest, { HANNA_FM_PATH: site });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "The vendored migrations match the manifest.\nThe vendored migrations match the site clone.\n",
    );
  });

  it("fails and names a migration that differs from the site's", () => {
    const { site, ingest } = synced("check-changed-site");
    writeFileSync(join(site, "supabase", "migrations", "20260102000000_b.sql"), "-- site b, changed\n");
    const result = check(ingest, { HANNA_FM_PATH: site });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("differs from the site clone: 20260102000000_b.sql\n");
  });

  it("fails and names a site migration the vendored copy lacks, and the reverse", () => {
    const { site, ingest, vendored } = synced("check-extra");
    writeFileSync(join(site, "supabase", "migrations", "20260105000000_new.sql"), "-- new\n");
    rmSync(join(vendored, "20260101000000_a.sql"));
    writeFileSync(join(vendored, "20260106000000_only_here.sql"), "-- local\n");
    const result = check(ingest, { HANNA_FM_PATH: site });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing from the vendored copy: 20260101000000_a.sql\n");
    expect(result.stderr).toContain("missing from the vendored copy: 20260105000000_new.sql\n");
    expect(result.stderr).toContain("not in the site clone: 20260106000000_only_here.sql\n");
  });

  it("fails and names a vendored migration that was edited after the manifest was written", () => {
    const { ingest, vendored } = synced("check-edited");
    writeFileSync(join(vendored, "20260101000000_a.sql"), "-- edited by hand\n");
    const result = check(ingest);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("differs from the manifest: 20260101000000_a.sql\n");
  });

  it("fails and names a migration added by hand, and a listed one that is gone", () => {
    const { ingest, vendored } = synced("check-added");
    writeFileSync(join(vendored, "20260107000000_by_hand.sql"), "-- by hand\n");
    rmSync(join(vendored, "20260102000000_b.sql"));
    const result = check(ingest);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not in the manifest: 20260107000000_by_hand.sql\n");
    expect(result.stderr).toContain("listed in the manifest but missing: 20260102000000_b.sql\n");
  });

  it("fails when there is no manifest", () => {
    const { ingest } = setup("check-no-manifest");
    const result = check(ingest);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("The manifest supabase/vendored-migrations.manifest.json is missing. Run schema:sync.\n");
  });

  it("fails when HANNA_FM_PATH has no migrations folder", () => {
    const { ingest } = synced("check-bad-path");
    const result = check(ingest, { HANNA_FM_PATH: join(scratch, "check-bad-path", "nowhere") });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/supabase\/migrations/);
  });
});
