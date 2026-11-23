import { describe, expect, it } from "vitest";
import { endedAtToCursorMs, mapItem, playedAtMs, toEndedAt } from "../src/poll-mapping.ts";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");

const raw = (playedAt: string, track: Record<string, unknown> = {}) => ({
  played_at: playedAt,
  track: {
    uri: "spotify:track:SYNTH000000000001",
    name: "Synthetic Track",
    type: "track",
    is_local: false,
    duration_ms: 215_000,
    artists: [{ name: "Synthetic Artist" }],
    album: { name: "Synthetic Album" },
    ...track,
  },
});

describe("toEndedAt and endedAtToCursorMs", () => {
  it("cuts a time down to whole seconds, never up", () => {
    expect(toEndedAt("2026-11-20T10:00:05.999Z")).toBe("2026-11-20T10:00:05.000Z");
    expect(toEndedAt("2026-11-20T10:00:05.000Z")).toBe("2026-11-20T10:00:05.000Z");
    expect(toEndedAt("2026-11-20T12:00:05.999+02:00")).toBe("2026-11-20T10:00:05.000Z");
  });

  it("turns a stored end time into the milliseconds Spotify takes, or null", () => {
    expect(endedAtToCursorMs("2026-11-20T10:00:05+00:00")).toBe(Date.parse("2026-11-20T10:00:05Z"));
    expect(endedAtToCursorMs("not a time")).toBeNull();
  });

  it("round trips: the cursor of a stored time is the stored time", () => {
    const stored = toEndedAt("2026-11-20T10:04:09.001Z");
    expect(endedAtToCursorMs(stored)).toBe(Date.parse("2026-11-20T10:04:09.000Z"));
  });
});

describe("playedAtMs", () => {
  it("reads played_at in milliseconds, keeping the fraction", () => {
    expect(playedAtMs(raw("2026-11-20T10:00:05.678Z"))).toBe(Date.parse("2026-11-20T10:00:05.678Z"));
  });

  it.each([null, undefined, "x", 5, [], {}, { played_at: 5 }, { played_at: "nope" }])("is null for %j", (value) => {
    expect(playedAtMs(value)).toBeNull();
  });
});

describe("mapItem", () => {
  it("maps a track, stores no play length, and keeps Spotify's track length beside it", () => {
    const mapped = mapItem(raw("2026-11-20T10:00:05.678Z"), NOW);
    expect(mapped).toEqual({
      play: {
        track_uri: "spotify:track:SYNTH000000000001",
        track_name: "Synthetic Track",
        artist_name: "Synthetic Artist",
        album_name: "Synthetic Album",
        ended_at: "2026-11-20T10:00:05.000Z",
        ms_played: null,
        source: "poll",
      },
      durationMs: 215_000,
    });
    // The length is not a column of the play.
    expect("play" in mapped && Object.keys(mapped.play)).not.toContain("duration_ms");
  });

  it.each([undefined, null, "215", -1, 1.5])("holds a track length of %j as null", (duration) => {
    const mapped = mapItem(raw("2026-11-20T10:00:00Z", { duration_ms: duration }), NOW);
    expect(mapped).toMatchObject({ durationMs: null });
  });

  it("treats the future by 60 seconds: 60 is fine, 61 is malformed", () => {
    const at = (secondsAhead: number) => new Date(NOW + secondsAhead * 1000).toISOString();
    expect(mapItem(raw(at(60)), NOW)).toHaveProperty("play");
    expect(mapItem(raw(at(61)), NOW)).toEqual({ skipped: "malformed" });
  });

  it("holds the 500 character limit at the edge", () => {
    expect(mapItem(raw("2026-11-20T10:00:00Z", { name: "x".repeat(500) }), NOW)).toHaveProperty("play");
    expect(mapItem(raw("2026-11-20T10:00:00Z", { name: "x".repeat(501) }), NOW)).toEqual({ skipped: "malformed" });
  });
});
