import { describe, expect, it } from "vitest";
import { UserError } from "../src/files.ts";
import { emptyPollCounts, pollProblemKind } from "../src/poll.ts";
import { failureKindOf, stoppedRecord } from "../src/run-record.ts";

const KIND_PATTERN = /^[a-z0-9_]{1,64}$/;

describe("failureKindOf", () => {
  it("returns the kind a UserError names", () => {
    expect(failureKindOf(new UserError("fixed text", "spotify_unavailable"))).toBe("spotify_unavailable");
    expect(failureKindOf(new UserError("fixed text", "database_error"))).toBe("database_error");
  });

  it("returns other only for a UserError that names no kind", () => {
    expect(failureKindOf(new UserError("fixed text"))).toBe("other");
  });

  it.each([
    ["a TypeError", new TypeError("x is not a function")],
    ["a RangeError", new RangeError("too deep")],
    ["a plain Error", new Error("boom")],
    ["a thrown string", "boom"],
    ["a thrown null", null],
    ["a thrown undefined", undefined],
    ["a thrown object", { message: "boom" }],
  ])("returns bug for %s, and never reads its text", (_name, error) => {
    expect(failureKindOf(error)).toBe("bug");
  });

  it("gives every kind a word the table accepts", () => {
    const kinds = [
      failureKindOf(new TypeError("x")),
      failureKindOf(new UserError("x")),
      failureKindOf(new UserError("x", "stalled")),
      failureKindOf(new UserError("x", "spotify_unavailable")),
      failureKindOf(new UserError("x", "database_error")),
    ];
    for (const kind of kinds) expect(kind).toMatch(KIND_PATTERN);
  });
});

describe("stoppedRecord", () => {
  it("records a bug as failed, with no counts when no page was read", () => {
    const record = stoppedRecord(new Date(), emptyPollCounts(), new TypeError("secret-looking text"));
    expect(record).toMatchObject({ outcome: "failed", failureKind: "bug", fetched: null, stored: null });
  });
});

describe("pollProblemKind", () => {
  it("names a stalled page walk stalled, not other", () => {
    expect(pollProblemKind({ ...emptyPollCounts(), gap: "stalled" })).toBe("stalled");
  });

  it("keeps page_cap for the page cap, and malformed_items for malformed items", () => {
    expect(pollProblemKind({ ...emptyPollCounts(), gap: "capped" })).toBe("page_cap");
    const counts = emptyPollCounts();
    counts.skipped.malformed = 1;
    expect(pollProblemKind(counts)).toBe("malformed_items");
  });

  it("returns null for a green run", () => {
    expect(pollProblemKind(emptyPollCounts())).toBeNull();
  });
});
