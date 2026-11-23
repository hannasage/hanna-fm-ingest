/**
 * How names become keys. Two spellings that differ only in case, spacing or accent encoding
 * are the same artist, so they get one key.
 */

export function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
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
