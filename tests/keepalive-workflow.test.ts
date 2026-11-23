import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const path = join(root, ".github", "workflows", "keepalive.yml");

type Step = { uses?: string; run?: string; name?: string; env?: Record<string, string> };
type Workflow = {
  name: string;
  on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown; [event: string]: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, { permissions?: unknown; "timeout-minutes"?: number; steps: Step[] }>;
};

describe("keepalive workflow", () => {
  it("exists next to the poll workflow", () => {
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, ".github", "workflows", "poll.yml"))).toBe(true);
  });

  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const workflow = (raw === "" ? { jobs: {}, on: {} } : parse(raw)) as Workflow;
  const job = Object.values(workflow.jobs)[0];
  const steps = job?.steps ?? [];

  it("has one job", () => {
    expect(Object.keys(workflow.jobs)).toHaveLength(1);
  });

  it("runs once a month and by hand, and nothing else", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule).toHaveLength(1);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = workflow.on.schedule![0]!.cron.split(" ");
    // A fixed day of the month and every month: once a month. Not at the start of an hour, when Actions is busy.
    expect(dayOfMonth).toMatch(/^\d{1,2}$/);
    expect(month).toBe("*");
    expect(dayOfWeek).toBe("*");
    expect(hour).toMatch(/^\d{1,2}$/);
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(minute).not.toBe("0");
  });

  it("asks for the actions write permission and nothing else", () => {
    expect(workflow.permissions).toEqual({ actions: "write" });
    expect(job?.permissions).toBeUndefined();
  });

  it("uses no secret and does not check out the code", () => {
    expect(raw).not.toContain("secrets.");
    expect(raw).not.toMatch(/actions\/checkout/);
  });

  it("pins any action it uses to a full commit SHA", () => {
    for (const step of steps) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/^\S+@[0-9a-f]{40}$/);
    }
  });

  it("has a time limit", () => {
    expect(job?.["timeout-minutes"]).toBeLessThanOrEqual(10);
  });

  it("re-enables poll.yml through the documented endpoint, with the job's own token", () => {
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}", REPO: "${{ github.repository }}" });
    const script = step.run ?? "";
    expect(script).toMatch(/gh api --method PUT "repos\/\$REPO\/actions\/workflows\/poll\.yml\/enable"/);
  });

  it("fails loudly: stops on the first error and checks that the workflow is active afterwards", () => {
    const script = steps[0]?.run ?? "";
    expect(script).toMatch(/set -euo pipefail/);
    expect(script).toMatch(/gh api "repos\/\$REPO\/actions\/workflows\/poll\.yml" --jq \.state/);
    expect(script).toMatch(/!= "active"/);
    expect(script).toMatch(/::error::/);
    expect(script).toMatch(/exit 1/);
  });

  it("holds no token in plain text", () => {
    expect(raw).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
  });
});

describe("keepalive script, run with a stand-in for gh", () => {
  const script = (() => {
    if (!existsSync(path)) return "";
    const workflow = parse(readFileSync(path, "utf8")) as Workflow;
    return Object.values(workflow.jobs)[0]?.steps[0]?.run ?? "";
  })();

  /** Runs the step's script with a fake `gh`. `put` and `state` say what the fake does. */
  function run(put: "ok" | "fail", state: string): { status: number | null; output: string; calls: string } {
    const dir = mkdtempSync(join(tmpdir(), "keepalive-"));
    try {
      const log = join(dir, "calls.log");
      const fake = [
        "#!/bin/bash",
        'echo "$*" >> "$FAKE_LOG"',
        'if [ "$1" = "api" ] && [ "$2" = "--method" ]; then',
        '  [ "$FAKE_PUT" = "ok" ] && exit 0',
        '  echo "HTTP 404" >&2; exit 1',
        "fi",
        'echo "$FAKE_STATE"',
      ].join("\n");
      writeFileSync(join(dir, "gh"), fake);
      chmodSync(join(dir, "gh"), 0o755);
      writeFileSync(join(dir, "step.sh"), script);
      const result = spawnSync("bash", [join(dir, "step.sh")], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          REPO: "owner/repo",
          GH_TOKEN: "not-a-real-token",
          FAKE_LOG: log,
          FAKE_PUT: put,
          FAKE_STATE: state,
        },
      });
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      return { status: result.status, output: `${result.stdout}\n${result.stderr}`, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("succeeds when the enable call works and the workflow is active", () => {
    const result = run("ok", "active");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("api --method PUT repos/owner/repo/actions/workflows/poll.yml/enable");
    expect(result.calls).toContain("api repos/owner/repo/actions/workflows/poll.yml --jq .state");
  });

  it("fails with an error annotation when the enable call fails", () => {
    const result = run("fail", "active");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("::error::");
  });

  it.each(["disabled_inactivity", "disabled_manually", ""])("fails with an error annotation when the state is %j", (state) => {
    const result = run("ok", state);
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::");
  });
});

describe("keepalive in the README", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");

  it("names the workflow, and says what is unverified and what the fallback is", () => {
    expect(readme).toContain("keepalive.yml");
    expect(readme).toMatch(/60 days/);
    expect(readme).toMatch(/unverified/i);
    expect(readme).toMatch(/poller-health/);
    expect(readme).toMatch(/by hand/);
  });
});
