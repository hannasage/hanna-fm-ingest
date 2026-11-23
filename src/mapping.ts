/**
 * The one place that names keys in Spotify's Extended Streaming History JSON.
 *
 * These names are the commonly documented ones. They are NOT yet checked against a real
 * export: ticket 7 verifies this table against one. If a real file uses other names, change
 * this file and nothing else.
 *
 * The importer reads only the keys listed here. Every other key in a row, including the
 * private ones (ip_addr, conn_country, platform, user_agent_decrypted), is never read,
 * stored, or logged.
 */

/** Stored column -> key in an export row. */
export const COLUMN_KEYS = {
  track_uri: "spotify_track_uri",
  track_name: "master_metadata_track_name",
  artist_name: "master_metadata_album_artist_name",
  album_name: "master_metadata_album_album_name",
  ended_at: "ts",
  ms_played: "ms_played",
} as const;

/** Keys that decide whether a row is dropped. Their values are never stored. */
export const SIGNAL_KEYS = {
  /** A value here means the row is a podcast episode. */
  episode_name: "episode_name",
  episode_uri: "spotify_episode_uri",
  /** true means the play happened in a private session. */
  private_session: "incognito_mode",
} as const;
