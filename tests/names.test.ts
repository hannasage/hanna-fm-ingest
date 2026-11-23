import { describe, expect, it } from "vitest";
import { albumKey, artistKey, escapePhrase, normalizeName } from "../src/names.ts";

describe("normalizeName", () => {
  it("ignores case and extra spaces", () => {
    expect(normalizeName("  SYNTH   Artist  A ")).toBe("synth artist a");
  });

  it("treats a composed and a decomposed accent as the same name", () => {
    expect(normalizeName("SYNTH Caf\u00e9")).toBe(normalizeName("SYNTH Cafe\u0301"));
  });

  it("strips diacritics, so an accented and a plain spelling are the same name", () => {
    expect(normalizeName("SYNTH Beyonc\u00e9")).toBe("synth beyonce");
    expect(normalizeName("SYNTH Motley Cr\u00fce")).toBe(normalizeName("SYNTH Motley Crue"));
    expect(normalizeName("\u00celes")).toBe("iles");
  });

  it("keeps a letter whose marks belong to its script: kana with a dakuten stays distinct", () => {
    expect(normalizeName("\u304c")).not.toBe(normalizeName("\u304b"));
    expect(normalizeName("\u304c")).toBe("\u304c");
  });

  it("folds curly quotes and apostrophes to straight ones", () => {
    expect(normalizeName("SYNTH Don\u2019t")).toBe("synth don't");
    expect(normalizeName("SYNTH Don\u2018t")).toBe("synth don't");
    expect(normalizeName("SYNTH Don\u00b4t")).toBe("synth don't");
    expect(normalizeName("SYNTH \u201cQuoted\u201d")).toBe('synth "quoted"');
    expect(normalizeName("SYNTH Don\u2019t")).toBe(normalizeName("SYNTH Don't"));
  });

  it("treats & as and, with or without spaces around it", () => {
    expect(normalizeName("SYNTH A & B")).toBe("synth a and b");
    expect(normalizeName("SYNTH A&B")).toBe("synth a and b");
    expect(normalizeName("SYNTH A & B")).toBe(normalizeName("SYNTH A and B"));
    expect(normalizeName("SYNTH A \uff06 B")).toBe("synth a and b");
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

  it("gives one key to spellings that differ only in accents, quotes or &", () => {
    expect(artistKey("SYNTH Sigur R\u00f3s & Co")).toBe(artistKey("SYNTH Sigur Ros and Co"));
    expect(albumKey("SYNTH It\u2019s", "SYNTH B\u00e9")).toBe(albumKey("SYNTH It's", "SYNTH Be"));
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
