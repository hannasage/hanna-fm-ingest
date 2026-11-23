import { describe, expect, it } from "vitest";
import { albumQuery, artistQuery, decide, parseCandidate, trackQuery } from "../src/matching.ts";
import { UserError } from "../src/files.ts";
import { MATCH_MIN_SCORE } from "../src/settings.ts";

const ID = "00000000-0000-4000-8000-000000000001";

describe("queries", () => {
  it("quotes and escapes each value, and leaves out an empty artist or album", () => {
    expect(trackQuery({ kind: "track", key: "k", name: 'a "b"', artist: "SYNTH A", album: "SYNTH B" })).toBe(
      'recording:"a \\"b\\"" AND artistname:"SYNTH A" AND release:"SYNTH B"',
    );
    expect(trackQuery({ kind: "track", key: "k", name: "t", artist: "" })).toBe('recording:"t"');
    expect(albumQuery({ kind: "album", key: "k", name: "SYNTH B", artist: "SYNTH A" })).toBe(
      'releasegroup:"SYNTH B" AND artistname:"SYNTH A"',
    );
    expect(albumQuery({ kind: "album", key: "k", name: "SYNTH B", artist: "" })).toBe('releasegroup:"SYNTH B"');
    expect(artistQuery({ kind: "artist", key: "k", name: "SYNTH A" })).toBe('artist:"SYNTH A"');
  });
});

describe("parseCandidate", () => {
  it("reads the top hit, with a score given as text or as a number, and lower-cases the IDs", () => {
    const upper = ID.toUpperCase();
    const asText = parseCandidate({ artists: [{ id: upper, score: "95", name: "SYNTH A" }] }, "artists", "name");
    const asNumber = parseCandidate({ artists: [{ id: ID, score: 95, name: "SYNTH A" }] }, "artists", "name");
    expect(asText).toEqual({ mbid: ID, score: 95, name: "SYNTH A", credits: [] });
    expect(asNumber).toEqual(asText);
  });

  it("reads artist credits and skips a credit that has no usable ID", () => {
    const body = {
      recordings: [
        {
          id: ID,
          score: "100",
          title: "SYNTH T",
          "artist-credit": [{ artist: { id: ID, name: "SYNTH A" } }, { artist: { id: "x", name: "bad" } }, "odd", {}],
        },
      ],
    };
    expect(parseCandidate(body, "recordings", "title")?.credits).toEqual([{ mbid: ID, name: "SYNTH A" }]);
  });

  it("returns null for an empty list", () => {
    expect(parseCandidate({ artists: [] }, "artists", "name")).toBeNull();
  });

  it.each([
    ["not an object", "text"],
    ["an array", []],
    ["no list", {}],
    ["a list that is not a list", { artists: "x" }],
    ["a hit that is not an object", { artists: ["x"] }],
    ["no ID", { artists: [{ score: "100", name: "n" }] }],
    ["an ID that is not a UUID", { artists: [{ id: "123", score: "100", name: "n" }] }],
    ["no name", { artists: [{ id: ID, score: "100" }] }],
    ["no score", { artists: [{ id: ID, name: "n" }] }],
    ["a blank score", { artists: [{ id: ID, score: " ", name: "n" }] }],
    ["a score over 100", { artists: [{ id: ID, score: "101", name: "n" }] }],
    ["a negative score", { artists: [{ id: ID, score: -1, name: "n" }] }],
    ["a score that is not a number", { artists: [{ id: ID, score: "high", name: "n" }] }],
  ])("throws on %s", (_name, body) => {
    expect(() => parseCandidate(body, "artists", "name")).toThrow(UserError);
  });
});

describe("decide", () => {
  const candidate = (score: number) => ({ mbid: ID, score, name: "SYNTH A", credits: [] });

  it("accepts a score at the threshold and refuses one just under it", () => {
    expect(decide(candidate(MATCH_MIN_SCORE))).toMatchObject({ state: "resolved", mbid: ID });
    expect(decide(candidate(MATCH_MIN_SCORE - 1))).toEqual({
      state: "unresolved",
      reason: "below_threshold",
      score: MATCH_MIN_SCORE - 1,
      name: "SYNTH A",
    });
  });

  it("calls no hit no_match", () => {
    expect(decide(null)).toEqual({ state: "unresolved", reason: "no_match", score: null, name: null });
  });
});
