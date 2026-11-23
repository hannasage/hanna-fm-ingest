import type { SupabaseClient } from "@supabase/supabase-js";

/** Made-up IDs. None of them belongs to any real artist, album or recording. */
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export type Row = {
  id: number;
  kind: string;
  mbid: string | null;
  name: string;
  source_key: string;
  spotify_uri: string | null;
  state: string;
  reason: string | null;
  match_score: number | null;
  matched_name: string | null;
  merged_into: number | null;
  attempts: number;
  last_attempt_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

export async function items(db: SupabaseClient): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("items").select("*").order("id").range(from, from + 999);
    if (error) throw new Error(`could not read items: ${error.code}`);
    rows.push(...(data as Row[]));
    if (data.length < 1000) return rows;
  }
}

export function find(rows: Row[], kind: string, name: string): Row {
  const row = rows.find((candidate) => candidate.kind === kind && candidate.name === name);
  if (!row) throw new Error(`no ${kind} item named ${name}`);
  return row;
}

export type PlayInput = { uri: string; track: string; artist: string; album: string | null };

/** Plays are inserted in chunks, so a test can seed thousands. */
export async function seedPlays(db: SupabaseClient, inputs: PlayInput[]): Promise<void> {
  const rows = inputs.map((input, index) => ({
    track_uri: input.uri,
    track_name: input.track,
    artist_name: input.artist,
    album_name: input.album,
    ended_at: new Date(Date.UTC(2024, 0, 1, 0, index)).toISOString(),
    ms_played: 200_000,
    source: "export",
  }));
  for (let start = 0; start < rows.length; start += 500) {
    const { error } = await db.from("plays").insert(rows.slice(start, start + 500));
    if (error) throw new Error(`could not seed plays: ${error.code}`);
  }
}

export const uri = (n: number): string => `spotify:track:SYNTH${String(n).padStart(18, "0")}`;
export const T1: PlayInput = { uri: uri(1), track: "SYNTH Song One", artist: "SYNTH Artist A", album: "SYNTH Album A" };
export const T2: PlayInput = { uri: uri(2), track: "SYNTH Song Two", artist: "SYNTH Artist A", album: "SYNTH Album A" };
export const T3: PlayInput = { uri: uri(3), track: "SYNTH Song Three", artist: "SYNTH Artist B", album: "SYNTH Album B" };

/** Empties every table the resolver reads or writes, so each test starts from nothing. */
export async function clearTables(db: SupabaseClient): Promise<void> {
  for (const [table, column, empty] of [
    ["items", "id", 0],
    ["mb_cache", "request_hash", ""],
    ["plays", "id", 0],
    ["job_locks", "name", ""],
  ] as const) {
    const { error } = await db.from(table).delete().neq(column, empty);
    if (error) throw new Error(`could not clear ${table}: ${error.code}`);
  }
}
