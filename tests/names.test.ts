import { describe, expect, it } from "vitest";
import { albumKey, artistKey, escapePhrase, normalizeName } from "../src/names.ts";

describe("normalizeName", () => {
  it("ignores case and extra spaces", () => {
    expect(normalizeName("  SYNTH   Artist  A ")).toBe("synth artist a");
  });

  it("treats a composed and a decomposed accent as the same name", () => {
    expect(normalizeName("SYNTH Café")).toBe(normalizeName("SYNTH Café"));
  });

  it("keeps emoji and non-Latin letters", () => {
    expect(normalizeName("SYNTH \u{1F3B5} テスト")).toBe("synth \u{1F3B5} テスト");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeName("   \t ")).toBe("");
  });
});

describe("keys", () => {
  it("builds the artist key from the normalized name", () => {
    expect(artistKey("SYNTH  Artist")).toBe("synth artist");
  });

  it("builds an album key that cannot clash when names hold separators", () => {
    expect(albumKey("a / b", "c")).not.toBe(albumKey("a", "b / c"));
    expect(albumKey("SYNTH Album", "SYNTH Artist")).toBe(JSON.stringify(["synth album", "synth artist"]));
  });
});

describe("escapePhrase", () => {
  it("escapes the quote and the backslash, the only characters special inside a quoted phrase", () => {
    expect(escapePhrase('say "hi" \\ now')).toBe('say \\"hi\\" \\\\ now');
  });

  it("leaves other characters alone", () => {
    expect(escapePhrase("AC/DC: (live) + more*")).toBe("AC/DC: (live) + more*");
  });
});
