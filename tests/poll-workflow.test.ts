import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const text = readFileSync(join(process.cwd(), ".github", "workflows", "poll.yml"), "utf8");
const lines = text.split("\n");

/** Indent of a line, in spaces. */
const indent = (line: string) => line.length - line.trimStart().length;

/** The lines of every `env:` block, as { owner line number } -> lines. */
function envBlocks(): string[][] {
  const blocks: string[][] = [];
  lines.forEach((line, index) => {
    if (!/^\s*env:\s*$/.test(line)) return;
    const block: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (candidate.trim() === "") continue;
      if (indent(candidate) <= indent(line)) break;
      block.push(candidate);
    }
    blocks.push(block);
  });
  return blocks;
}

describe("poll workflow", () => {
  it("runs every 30 minutes and by hand, and nothing else", () => {
    expect(text).toMatch(/^on:\s*$/m);
    expect(text.match(/^\s*-\s*cron:\s*(.+)$/gm)).toEqual(['    - cron: "*/30 * * * *"']);
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
    expect(text).not.toMatch(/^\s*(push|pull_request|pull_request_target|workflow_run):/m);
  });

  it("asks for read access to contents and nothing more", () => {
    const permissions = text.match(/^permissions:\n((?:[ ]+\S.*\n)+)/m);
    expect(permissions?.[1]?.trim()).toBe("contents: read");
    // No job-level permissions that could widen it.
    expect(text.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it("never overlaps runs", () => {
    expect(text).toMatch(/^concurrency:\n\s+group: \S+\n\s+cancel-in-progress: false$/m);
  });

  it("runs only on the main branch of this repository, not on a fork", () => {
    const condition = lines.find((line) => /^\s*if:/.test(line)) ?? "";
    expect(condition).toContain("github.repository == 'hannasage/hanna-fm-ingest'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
  });

  it("pins every action to a full commit SHA", () => {
    const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const line of uses) expect(line).toMatch(/uses:\s*\S+@[0-9a-f]{40}(\s+#.*)?$/);
  });

  it("does not keep the checkout credentials", () => {
    expect(text).toMatch(/persist-credentials:\s*false/);
  });

  it("installs with npm ci and runs npm run poll", () => {
    expect(text).toMatch(/^\s*-?\s*run:\s*npm ci\s*$/m);
    expect(text).toMatch(/^\s*-?\s*run:\s*npm run poll\s*$/m);
  });

  it("gives every secret to the command through env, from the secrets context", () => {
    const names = [
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
      "SPOTIFY_CLIENT_ID",
      "SPOTIFY_CLIENT_SECRET",
      "SPOTIFY_REFRESH_TOKEN",
    ];
    const blocks = envBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    const assigned = blocks.flat().map((line) => line.trim());
    for (const name of names) expect(assigned).toContain(`${name}: \${{ secrets.${name} }}`);
  });

  it("uses the secrets context only inside env blocks, and holds no secret in plain text", () => {
    const inEnv = new Set(envBlocks().flat());
    for (const line of lines) {
      if (line.includes("${{ secrets.")) {
        expect(inEnv.has(line), `a secret outside an env block: ${line.trim().split(":")[0]}`).toBe(true);
        expect(line.trim()).toMatch(/^[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
      }
      // A name that holds a secret is never given a literal value.
      const assignment = /^\s*([A-Z_]*(?:KEY|SECRET|TOKEN|CLIENT_ID|URL)[A-Z_]*):\s*(\S.*)$/.exec(line);
      if (assignment) expect(assignment[2], `${assignment[1]} has a plain value`).toMatch(/^\$\{\{ secrets\.[A-Z_]+ \}\}$/);
    }
    // Nothing that looks like a token, a key, a JWT or a long random string.
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    // Action pins are 40 hex characters and are checked above, so those lines are left out here.
    const withoutPins = lines.filter((line) => !/^\s*-?\s*uses:/.test(line)).join("\n");
    expect(withoutPins).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
  });
});
