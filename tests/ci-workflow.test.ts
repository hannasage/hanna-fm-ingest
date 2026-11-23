import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/leaks.ts";

const workflows = filesUnder(join(process.cwd(), ".github", "workflows")).filter((f) =>
  /\.ya?ml$/.test(f),
);

describe("GitHub Actions workflows", () => {
  it("has at least one workflow to check", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it("pins every action to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const file of workflows) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
        if (!match || match[1]!.startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/.test(match[1]!)) unpinned.push(match[1]!);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it("never throws away the output of `supabase start`", () => {
    for (const file of workflows) {
      const text = readFileSync(file, "utf8");
      expect(/supabase start[^\n]*\/dev\/null/.test(text)).toBe(false);
    }
  });

  it("prints a filtered tail of the `supabase start` log when it fails", () => {
    const text = workflows.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(text).toMatch(/supabase start[^\n]*>[^\n]*supabase-start\.log/);
    expect(text).toMatch(/tail -n 50[^\n]*supabase-start\.log/);
    expect(text).toMatch(/grep -v[iE]*\s[^\n]*(key|token|secret)/i);
  });
});
