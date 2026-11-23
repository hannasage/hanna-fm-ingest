import { describe, expect, it } from "vitest";
import {
  albumQuery,
  artistQuery,
  decide,
  parseCandidates,
  readCandidates,
  trackQuery,
  type Candidate,
  type Context,
} from "../src/matching.ts";
import { UserError } from "../src/files.ts";
import { MATCH_MIN_SCORE } from "../src/settings.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ARTIST_ID = "00000000-0000-4000-8000-000000000011";

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

  it("can leave the album out of a track query, for the retry", () => {
    const context: Context = { kind: "track", key: "k", name: "t", artist: "SYNTH A", album: "SYNTH B" };
    expect(trackQuery(context, { withAlbum: false })).toBe('recording:"t" AND artistname:"SYNTH A"');
  });
});

describe("parseCandidates", () => {
  it("reads every hit, with a score given as text or as a number, and lower-cases the IDs", () => {
    const upper = ID.toUpperCase();
    const asText = parseCandidates({ artists: [{ id: upper, score: "95", name: "SYNTH A" }] }, "artists", "name");
    const asNumber = parseCandidates({ artists: [{ id: ID, score: 95, name: "SYNTH A" }] }, "artists", "name");
    expect(asText).toEqual([{ mbid: ID, score: 95, name: "SYNTH A", aliases: [], credits: [] }]);
    expect(asNumber).toEqual(asText);
    const two = parseCandidates(
      { artists: [{ id: ID, score: "100", name: "A" }, { id: OTHER, score: "61", name: "B" }] },
      "artists",
      "name",
    );
    expect(two.map((hit) => hit.mbid)).toEqual([ID, OTHER]);
  });

  it("keeps the raw score, with no rounding", () => {
    const [hit] = parseCandidates({ artists: [{ id: ID, score: "89.6", name: "A" }] }, "artists", "name");
    expect(hit?.score).toBe(89.6);
  });

  it("reads artist credits from the artist, and from the credited name when it differs, and skips a credit that has no usable ID", () => {
    const body = {
      recordings: [
        {
          id: ID,
          score: "100",
          title: "SYNTH T",
          "artist-credit": [
            { artist: { id: ARTIST_ID, name: "SYNTH A" } },
            { name: "SYNTH A (credited)", artist: { id: OTHER, name: "SYNTH A2" } },
            { artist: { id: "x", name: "bad" } },
            "odd",
            {},
          ],
        },
      ],
    };
    expect(parseCandidates(body, "recordings", "title")[0]?.credits).toEqual([
      { mbid: ARTIST_ID, name: "SYNTH A" },
      { mbid: OTHER, name: "SYNTH A2" },
      { mbid: OTHER, name: "SYNTH A (credited)" },
    ]);
  });

  it("reads the aliases an artist hit carries, as the search page shows them, and ignores an alias it cannot read", () => {
    const body = {
      artists: [
        {
          id: ID,
          score: "100",
          name: "SYNTH A",
          "sort-name": "A, SYNTH",
          aliases: [
            { "sort-name": "SYNTH Alias One", name: "SYNTH Alias One", locale: "en", type: "Artist name", primary: true },
            { name: "SYNTH Alias\u0000 Two" },
            { "sort-name": "no name here" },
            "odd",
            { name: 5 },
          ],
        },
        { id: OTHER, score: "50", name: "SYNTH B" },
      ],
    };
    const [first, second] = parseCandidates(body, "artists", "name");
    expect(first?.aliases).toEqual(["SYNTH Alias One", "SYNTH Alias Two"]);
    expect(second?.aliases).toEqual([]);
  });

  it("keeps the credits in order, so the first one is the primary artist", () => {
    const body = {
      recordings: [
        {
          id: ID,
          score: "100",
          title: "SYNTH T",
          "artist-credit": [{ artist: { id: OTHER, name: "SYNTH Main" } }, { artist: { id: ARTIST_ID, name: "SYNTH Guest" } }],
        },
      ],
    };
    expect(parseCandidates(body, "recordings", "title")[0]?.credits.map((credit) => credit.mbid)).toEqual([OTHER, ARTIST_ID]);
  });

  it("keeps no credits when the first credit cannot be read, so a later one is never taken for the primary", () => {
    const body = {
      recordings: [
        {
          id: ID,
          score: "100",
          title: "SYNTH T",
          "artist-credit": [{ artist: { id: "x", name: "bad" } }, { artist: { id: ARTIST_ID, name: "SYNTH Guest" } }],
        },
      ],
    };
    expect(parseCandidates(body, "recordings", "title")[0]?.credits).toEqual([]);
  });

  it("strips NUL characters from every name", () => {
    const body = {
      recordings: [
        { id: ID, score: "100", title: "SYNTH\u0000 T", "artist-credit": [{ artist: { id: ARTIST_ID, name: "SYNTH\u0000 A" } }] },
      ],
    };
    const [hit] = parseCandidates(body, "recordings", "title");
    expect(hit?.name).toBe("SYNTH T");
    expect(hit?.credits[0]?.name).toBe("SYNTH A");
  });

  it("returns an empty list for an empty list", () => {
    expect(parseCandidates({ artists: [] }, "artists", "name")).toEqual([]);
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
    ["a later hit that is malformed", { artists: [{ id: ID, score: "100", name: "n" }, { id: "x", score: "1", name: "m" }] }],
  ])("throws on %s", (_name, body) => {
    expect(() => parseCandidates(body, "artists", "name")).toThrow(UserError);
  });
});

describe("readCandidates (a cached answer)", () => {
  const good: Candidate = { mbid: ID, score: 100, name: "SYNTH A", aliases: ["SYNTH Alias"], credits: [{ mbid: ARTIST_ID, name: "SYNTH A" }] };

  it("reads what parseCandidates produced", () => {
    expect(readCandidates([good])).toEqual([good]);
    expect(readCandidates([])).toEqual([]);
  });

  it.each([
    ["not a list", { mbid: ID }],
    ["a hit with a bad ID", [{ ...good, mbid: "x" }]],
    ["a hit with a score out of range", [{ ...good, score: 101 }]],
    ["a hit with no name", [{ ...good, name: undefined }]],
    ["credits that are not a list", [{ ...good, credits: "x" }]],
    ["a credit with a bad ID", [{ ...good, credits: [{ mbid: "x", name: "n" }] }]],
    ["an old whole-body cache entry", { recordings: [] }],
    ["a hit cached before aliases were kept", [{ mbid: ID, score: 100, name: "SYNTH A", credits: [] }]],
    ["aliases that are not a list", [{ ...good, aliases: "x" }]],
    ["an alias that is not text", [{ ...good, aliases: [5] }]],
  ])("throws on %s", (_name, value) => {
    expect(() => readCandidates(value)).toThrow(UserError);
  });
});

describe("decide", () => {
  const track: Context = { kind: "track", key: "k", name: "SYNTH T", artist: "SYNTH  Artist A", album: "SYNTH B" };
  const hit = (score: number, overrides: Partial<Candidate> = {}): Candidate => ({
    mbid: ID,
    score,
    name: "SYNTH T",
    aliases: [],
    credits: [{ mbid: ARTIST_ID, name: "synth artist a" }],
    ...overrides,
  });

  it("accepts a score at the threshold and refuses one just under it", () => {
    expect(decide([hit(MATCH_MIN_SCORE)], track)).toMatchObject({ state: "resolved", mbid: ID, score: MATCH_MIN_SCORE });
    expect(decide([hit(MATCH_MIN_SCORE - 1)], track)).toEqual({
      state: "unresolved",
      reason: "below_threshold",
      score: MATCH_MIN_SCORE - 1,
      name: "SYNTH T",
    });
  });

  it("compares the raw score with the threshold, so 89.6 is under 90", () => {
    expect(decide([hit(89.6)], track)).toMatchObject({ state: "unresolved", reason: "below_threshold" });
    expect(decide([hit(90)], track)).toMatchObject({ state: "resolved" });
  });

  it("calls an empty list no_match", () => {
    expect(decide([], track)).toEqual({ state: "unresolved", reason: "no_match", score: null, name: null });
  });

  it("accepts a hit only when its primary artist credit, normalized like a source key, equals the play's artist", () => {
    expect(decide([hit(100)], track)).toMatchObject({ state: "resolved" });
    const wrong = hit(100, { credits: [{ mbid: OTHER, name: "SYNTH Someone Else" }] });
    expect(decide([wrong], track)).toMatchObject({ state: "unresolved", reason: "no_match", score: 100, name: "SYNTH T" });
    const none = hit(100, { credits: [] });
    expect(decide([none], track)).toMatchObject({ state: "unresolved", reason: "no_match" });
  });

  it("accepts a hit whose primary credit is the artist already matched, whatever name it carries", () => {
    const renamed = hit(100, { credits: [{ mbid: ARTIST_ID, name: "SYNTH Artist A (stylized)" }] });
    expect(decide([renamed], track)).toMatchObject({ state: "unresolved", reason: "no_match" });
    expect(decide([renamed], track, ARTIST_ID)).toMatchObject({ state: "resolved", mbid: ID });
  });

  it("does not accept a hit that credits the played artist only as a featured artist", () => {
    const featured = hit(100, {
      credits: [
        { mbid: OTHER, name: "SYNTH Main Act" },
        { mbid: ARTIST_ID, name: "SYNTH Artist A" },
      ],
    });
    expect(decide([featured], track)).toEqual({ state: "unresolved", reason: "no_match", score: 100, name: "SYNTH T" });
    expect(decide([featured], track, ARTIST_ID)).toMatchObject({ state: "unresolved", reason: "no_match" });
  });

  it("accepts a hit whose primary credit is the played artist, with a guest credited after", () => {
    const withGuest = hit(97, {
      credits: [
        { mbid: ARTIST_ID, name: "SYNTH Artist A" },
        { mbid: OTHER, name: "SYNTH Guest" },
      ],
    });
    expect(decide([withGuest], track)).toMatchObject({ state: "resolved", score: 97 });
  });

  it("accepts the primary artist under the name it was credited as", () => {
    const credited = hit(100, {
      credits: [
        { mbid: ARTIST_ID, name: "SYNTH Legal Name" },
        { mbid: ARTIST_ID, name: "SYNTH  ARTIST A" },
      ],
    });
    expect(decide([credited], track)).toMatchObject({ state: "resolved" });
  });

  it("accepts a hit only when its title equals the title played, after normalization", () => {
    const cases = ["SYNTH T (Remix)", "SYNTH T - Live", "SYNTH T Pt. 2", "SYNTH"];
    for (const title of cases) {
      expect(decide([hit(95, { name: title })], track), title).toEqual({ state: "unresolved", reason: "no_match", score: 95, name: title });
    }
    expect(decide([hit(95, { name: "  synth   t " })], track)).toMatchObject({ state: "resolved" });
    expect(decide([hit(95, { name: "SYNTH T" })], track)).toMatchObject({ state: "resolved" });
  });

  it("does not take a remix or a featuring credit that scores 90 or more, and keeps its score and name for audit", () => {
    const remix = hit(96, { name: "SYNTH T (SYNTH Other Remix)", credits: [{ mbid: OTHER, name: "SYNTH Other" }] });
    expect(decide([remix], track)).toEqual({ state: "unresolved", reason: "no_match", score: 96, name: "SYNTH T (SYNTH Other Remix)" });
  });

  it("treats an album the same way: the title and the primary credit must both match", () => {
    const album: Context = { kind: "album", key: "k", name: "SYNTH B", artist: "SYNTH Artist A" };
    const right = hit(100, { name: "SYNTH B" });
    expect(decide([right], album)).toMatchObject({ state: "resolved" });
    expect(decide([hit(100, { name: "SYNTH B (Deluxe)" })], album)).toMatchObject({ state: "unresolved", reason: "no_match" });
    const featured = hit(100, { name: "SYNTH B", credits: [{ mbid: OTHER, name: "SYNTH Main" }, { mbid: ARTIST_ID, name: "SYNTH Artist A" }] });
    expect(decide([featured], album)).toMatchObject({ state: "unresolved", reason: "no_match" });
  });

  it("matches a title and an artist across accents, curly quotes and &", () => {
    const context: Context = { kind: "track", key: "k", name: "SYNTH Don\u2019t Stop & Go", artist: "SYNTH Beyonc\u00e9" };
    const found = hit(100, { name: "SYNTH Don't Stop and Go", credits: [{ mbid: ARTIST_ID, name: "SYNTH Beyonce" }] });
    expect(decide([found], context)).toMatchObject({ state: "resolved" });
  });

  it("skips a wrong-artist hit and takes the right one behind it", () => {
    const wrong = hit(100, { mbid: OTHER, credits: [{ mbid: OTHER, name: "SYNTH Someone Else" }] });
    expect(decide([wrong, hit(95)], track)).toMatchObject({ state: "resolved", mbid: ID, score: 95 });
  });

  it("is ambiguous when two different MusicBrainz IDs both score at or above the threshold", () => {
    const decision = decide([hit(100), hit(MATCH_MIN_SCORE, { mbid: OTHER })], track);
    expect(decision).toEqual({ state: "unresolved", reason: "ambiguous", score: 100, name: "SYNTH T" });
  });

  it("is not ambiguous when the second hit is under the threshold, or is the same ID again", () => {
    expect(decide([hit(100), hit(MATCH_MIN_SCORE - 1, { mbid: OTHER })], track)).toMatchObject({ state: "resolved" });
    expect(decide([hit(100), hit(100)], track)).toMatchObject({ state: "resolved" });
  });

  it("can be ambiguous for an artist search, which has no credits to check", () => {
    const artist: Context = { kind: "artist", key: "fred", name: "Fred" };
    const fred = (mbid: string, score: number): Candidate => ({ mbid, score, name: "Fred", aliases: [], credits: [] });
    expect(decide([fred(ID, 100)], artist)).toMatchObject({ state: "resolved" });
    expect(decide([fred(ID, 100), fred(OTHER, 100)], artist)).toMatchObject({ state: "unresolved", reason: "ambiguous" });
  });

  describe("an artist hit", () => {
    const artist: Context = { kind: "artist", key: "synth artist a", name: "SYNTH Artist A" };
    const named = (name: string, score: number, aliases: string[] = [], mbid = ID): Candidate => ({ mbid, score, name, aliases, credits: [] });

    it("must carry the played name: a different name is no_match, with its score and name kept for audit", () => {
      expect(decide([named("SYNTH Artist A and the Band", 100)], artist)).toEqual({
        state: "unresolved",
        reason: "no_match",
        score: 100,
        name: "SYNTH Artist A and the Band",
      });
    });

    it("accepts the name after normalization", () => {
      expect(decide([named("  synth  ARTIST a ", 95)], artist)).toMatchObject({ state: "resolved", mbid: ID });
    });

    it("accepts a hit when one of the aliases it returned is the played name", () => {
      expect(decide([named("SYNTH Real Name", 92, ["SYNTH Other", "synth artist a"])], artist)).toMatchObject({ state: "resolved", mbid: ID });
    });

    it("does not accept a hit by an alias it did not return", () => {
      expect(decide([named("SYNTH Real Name", 100, ["SYNTH Other"])], artist)).toMatchObject({ state: "unresolved", reason: "no_match" });
    });

    it("skips a wrong-name hit and takes the right one behind it, and is below_threshold when the right one scores low", () => {
      const wrong = named("SYNTH Someone Else", 100, [], OTHER);
      expect(decide([wrong, named("SYNTH Artist A", 95)], artist)).toMatchObject({ state: "resolved", mbid: ID, score: 95 });
      expect(decide([wrong, named("SYNTH Artist A", 70)], artist)).toMatchObject({ state: "unresolved", reason: "below_threshold", score: 70 });
    });
  });

  it("carries the credits of the accepted hit, so an artist can be settled from them", () => {
    const decision = decide([hit(100)], track);
    expect(decision.state === "resolved" && decision.credits).toEqual([{ mbid: ARTIST_ID, name: "synth artist a" }]);
  });
});
