import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const raw = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

type Step = { uses?: string; run?: string; name?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Workflow = {
  on: { pull_request?: unknown; push?: { branches?: string[] }; [event: string]: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
};
const workflow = parse(raw) as Workflow;
const steps = workflow.jobs.gates!.steps;
const drift = steps.find((step) => /schema:check/.test(step.run ?? ""));
const indexOf = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);

describe("the schema drift guard in the gates workflow", () => {
  it("runs on pull requests and on pushes to main, and on nothing else", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
  });

  it("has a step that runs schema:check", () => {
    expect(drift).toBeDefined();
  });

  it("clones hanna-fm main shallowly and anonymously, into a temp folder", () => {
    const script = drift?.run ?? "";
    expect(script).toMatch(/git clone --depth 1 https:\/\/github\.com\/hannasage\/hanna-fm\.git "\$SITE_DIR"/);
    expect(script).not.toMatch(/--branch|-b /);
    expect(drift?.env?.SITE_DIR).toBe("${{ runner.temp }}/hanna-fm");
  });

  it("gives the step no token and no secret", () => {
    const text = JSON.stringify(drift);
    expect(text).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|x-access-token/i);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("points schema:check at the clone with HANNA_FM_PATH", () => {
    expect(drift?.run).toMatch(/HANNA_FM_PATH="\$SITE_DIR" npm run schema:check/);
  });

  it("fails the job with the plain message when the copies differ", () => {
    const script = drift?.run ?? "";
    expect(script).toContain("::error::the vendored migrations differ from hanna-fm main; run schema:sync");
    expect(script).toMatch(/exit 1/);
  });

  it("runs after npm ci, so the command is installed", () => {
    expect(indexOf((step) => step.run === "npm ci")).toBeGreaterThanOrEqual(0);
    expect(indexOf((step) => step === drift)).toBeGreaterThan(indexOf((step) => step.run === "npm ci"));
  });

  it("has no condition that could skip it", () => {
    expect(drift?.if).toBeUndefined();
  });
});

describe("the schema drift step, run with a stand-in for git", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hanna-fm-ingest-drift-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const script = drift?.run ?? "";

  /**
   * Runs the step's script here. The fake `git clone` fills the target folder with `site`,
   * or fails when `site` is null. Everything else is the real `npm run schema:check`.
   */
  function run(name: string, site: ((migrations: string) => void) | null) {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    const siteDir = join(dir, "site");
    writeFileSync(
      join(dir, "git"),
      [
        "#!/bin/bash",
        'echo "$*" >> "$FAKE_LOG"',
        '[ "$FAKE_CLONE" = "ok" ] || { echo "fatal: unable to access" >&2; exit 128; }',
        'mkdir -p "${@: -1}/supabase"',
        'cp -R "$FAKE_SITE/supabase/migrations" "${@: -1}/supabase/migrations"',
      ].join("\n"),
    );
    chmodSync(join(dir, "git"), 0o755);
    if (site) {
      const migrations = join(siteDir, "supabase", "migrations");
      mkdirSync(migrations, { recursive: true });
      site(migrations);
    }
    writeFileSync(join(dir, "step.sh"), script);
    const result = spawnSync("bash", ["-e", join(dir, "step.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        SITE_DIR: join(dir, "clone"),
        FAKE_SITE: siteDir,
        FAKE_LOG: join(dir, "calls.log"),
        FAKE_CLONE: site ? "ok" : "fail",
        HANNA_FM_PATH: undefined,
      },
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  const vendored = join(root, "supabase", "migrations");
  const copyVendored = (target: string) => cpSync(vendored, target, { recursive: true });

  it("is the only thing that decides: passes when the clone matches the vendored copy", () => {
    const result = run("same", (migrations) => {
      copyVendored(migrations);
    });
    // The vendored copy must itself match the manifest, which the other tests prove.
    expect(result.output).not.toContain("::error::");
    expect(result.status).toBe(0);
  });

  it("fails with the plain message when a vendored file differs", () => {
    const result = run("differs", (migrations) => {
      copyVendored(migrations);
      const first = readdirSyncSql(migrations)[0]!;
      writeFileSync(join(migrations, first), "-- changed on site main\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("::error::the vendored migrations differ from hanna-fm main; run schema:sync");
  });

  it("fails when the site has a migration the vendored copy lacks", () => {
    const result = run("site-ahead", (migrations) => {
      copyVendored(migrations);
      writeFileSync(join(migrations, "29990101000000_new.sql"), "-- new on site\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("run schema:sync");
  });

  it("fails when the vendored copy has a migration the site lacks (the site pull request must merge first)", () => {
    const result = run("ingest-ahead", (migrations) => {
      copyVendored(migrations);
      rmSync(join(migrations, readdirSyncSql(migrations).at(-1)!));
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("run schema:sync");
  });

  it("fails with a plain message when the clone itself fails", () => {
    const result = run("no-clone", null);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("::error::");
  });
});

function readdirSyncSql(folder: string): string[] {
  return readdirSync(folder).filter((name) => name.endsWith(".sql")).sort();
}

describe("the README on the schema drift guard", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");

  it("no longer says CI cannot compare against the site", () => {
    expect(readme).not.toMatch(/CI cannot do the site comparison/);
    expect(readme).not.toMatch(/becomes possible once the site repository is public/);
  });

  it("says the site pull request merges first, and what only CI can prove", () => {
    expect(readme).toMatch(/site pull request merges first/i);
    expect(readme).toMatch(/hanna-fm main/);
  });
});
