import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../src/settings.ts";
import { assertReadable } from "../src/files.ts";

const scratch = mkdtempSync(join(tmpdir(), "hanna-fm-ingest-files-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("assertReadable", () => {
  it("allows a file of exactly the size cap and rejects one byte more", () => {
    const path = join(scratch, "edge.fixture.json");
    writeFileSync(path, "");
    truncateSync(path, MAX_FILE_BYTES); // a sparse file: it takes no disk space
    expect(() => assertReadable(path)).not.toThrow();
    truncateSync(path, MAX_FILE_BYTES + 1);
    expect(() => assertReadable(path)).toThrow("edge.fixture.json is larger than the 500 MB limit.");
  });

  it("caps files at 500 MB", () => {
    expect(MAX_FILE_BYTES).toBe(500 * 1024 * 1024);
  });
});
