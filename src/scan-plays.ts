import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "./files.ts";
import type { Context, Kind } from "./matching.ts";
import { albumKey, artistKey, stripNul } from "./names.ts";
import { PAGE_SIZE } from "./settings.ts";
import { printableCode } from "./store.ts";

/** The map key for an item: its kind and its source key. */
export const itemId = (kind: Kind, key: string): string => `${kind}|${key}`;

type PlayRow = {
  id: number;
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
};

/**
 * Reads the stored plays, a page at a time, and returns each distinct track, artist and album once.
 * The first play seen (lowest id) decides the name an item is searched under.
 * An album with no name, or a blank one, is not an item.
 */
export async function scanPlays(client: SupabaseClient): Promise<Map<string, Context>> {
  const found = new Map<string, Context>();
  const add = (context: Context): void => {
    const id = itemId(context.kind, context.key);
    if (!found.has(id)) found.set(id, context);
  };

  let after = 0;
  for (;;) {
    const { data, error } = await client
      .from("plays")
      .select("id, track_uri, track_name, artist_name, album_name")
      .gt("id", after)
      .order("id")
      .limit(PAGE_SIZE);
    if (error) {
      throw new UserError(`The database refused a read of the plays (code ${printableCode(error.code)}). Check SUPABASE_URL and SUPABASE_SECRET_KEY, then run the command again.`);
    }
    const rows = data as PlayRow[];
    for (const row of rows) {
      const artist = stripNul(row.artist_name).trim();
      const album = stripNul(row.album_name ?? "").trim();
      add({ kind: "track", key: row.track_uri, name: stripNul(row.track_name).trim(), uri: row.track_uri, artist, ...(album ? { album } : {}) });
      add({ kind: "artist", key: artistKey(artist), name: artist });
      if (album) add({ kind: "album", key: albumKey(album, artist), name: album, artist });
    }
    const last = rows.at(-1);
    if (rows.length < PAGE_SIZE || !last) return found;
    after = last.id;
  }
}
