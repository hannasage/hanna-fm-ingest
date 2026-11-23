import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/leaks.ts";

const workflows = filesUnder(join(process.cwd(), ".github", "workflows")).filter((f) =>
  /\.ya?ml$/.test(f),
);

describe("GitHub Actions workflows", () => {
  it("pins every action to a full commit SHA", () => {
    // An empty list would pass with nothing checked.
    expect(workflows.length).toBeGreaterThan(0);
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
});
