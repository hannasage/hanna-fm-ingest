import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const raw = readFileSync(join(root, ".github", "workflows", "poll.yml"), "utf8");

type Step = { uses?: string; run?: string; name?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  "runs-on"?: string;
  environment?: unknown;
  if?: unknown;
  permissions?: unknown;
  steps: Step[];
};
type Workflow = {
  name: string;
  on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown; [event: string]: unknown };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

const workflow = parse(raw) as Workflow;
const job = workflow.jobs.poll!;
const steps = job.steps;

const SECRET_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN",
];

describe("poll workflow", () => {
  it("has one job, called poll", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["poll"]);
  });

  it("runs every 30 minutes and by hand, and nothing else", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule).toEqual([{ cron: "*/30 * * * *" }]);
  });

  it("asks for read access to contents and nothing more", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });

  it("never overlaps runs", () => {
    expect(workflow.concurrency?.group).toBeTruthy();
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("holds the secrets through the production environment, and has no job condition that skips with success", () => {
    expect(job.environment).toBe("production");
    expect(job.if).toBeUndefined();
  });

  it("does not restore a cache in the job that holds secrets", () => {
    for (const step of steps) {
      expect(step.with ?? {}, `step ${step.name ?? step.uses ?? step.run} sets a cache`).not.toHaveProperty("cache");
    }
    expect(raw).not.toMatch(/actions\/cache/);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = steps.map((step) => step.uses).filter((value): value is string => value !== undefined);
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const value of uses) expect(value).toMatch(/^\S+@[0-9a-f]{40}$/);
  });

  it("does not keep the checkout credentials", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("installs with npm ci and runs npm run poll", () => {
    const commands = steps.map((step) => step.run).filter((value) => value !== undefined);
    expect(commands).toContain("npm ci");
    expect(commands).toContain("npm run poll");
  });

  it("gives every secret to the poll step through env, from the secrets context", () => {
    const pollStep = steps.find((step) => step.run === "npm run poll");
    expect(pollStep?.env).toEqual(
      Object.fromEntries(SECRET_NAMES.map((name) => [name, `\${{ secrets.${name} }}`])),
    );
  });

  it("uses the secrets context only in that env block, and holds no secret in plain text", () => {
    const outside = steps.filter((step) => step.run !== "npm run poll");
    for (const step of outside) {
      expect(JSON.stringify(step), `a secret outside the poll step`).not.toContain("secrets.");
    }
    expect(JSON.stringify({ ...workflow, jobs: undefined })).not.toContain("secrets.");
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    // Action pins are 40 hex characters and are checked above, so those lines are left out here.
    const withoutPins = raw
      .split("\n")
      .filter((line) => !/^\s*-?\s*uses:/.test(line))
      .join("\n");
    expect(withoutPins).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
  });
});

describe("code ownership", () => {
  it("gives .github/ to the owner, so a workflow change needs her review", () => {
    const path = join(root, ".github", "CODEOWNERS");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines).toContain("/.github/ @hannasage");
  });
});
