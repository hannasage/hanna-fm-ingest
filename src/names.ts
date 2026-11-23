/**
 * How names become keys. Two spellings that differ only in case, spacing, accents, curly or straight
 * quotes, or `&` against `and`, are the same name, so they get one key.
 */

/** Typographic single quotes, primes and accents used as apostrophes: all become a straight apostrophe. */
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u02bc\u2032\u00b4`]/g;
/** Typographic double quotes: all become a straight double quote. */
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g;
/**
 * The Combining Diacritical Marks block, which holds the accents of Latin, Greek and Cyrillic letters.
 * Marks that belong to another script (kana dakuten, Indic vowel signs) are not in it and stay,
 * because removing them would make different names one.
 */
const DIACRITICS = /[\u0300-\u036f]/g;

const foldQuotes = (text: string): string => text.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"');

export function normalizeName(name: string): string {
  return foldQuotes(foldQuotes(name).normalize("NFKC"))
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The identity of an artist as it appears in plays. */
export function artistKey(artist: string): string {
  return normalizeName(artist);
}

/** The identity of an album as it appears in plays: its name and its artist. A JSON array cannot clash on a separator. */
export function albumKey(album: string, artist: string): string {
  return JSON.stringify([normalizeName(album), normalizeName(artist)]);
}

/** Inside a quoted Lucene phrase only the quote and the backslash are special. */
export function escapePhrase(text: string): string {
  return text.replace(/[\\"]/g, "\\$&");
}

/** The database cannot store a NUL character in text, so none is kept anywhere. */
export function stripNul(text: string): string {
  return text.replaceAll("\u0000", "");
}
