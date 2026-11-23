import { COLUMN_KEYS, SIGNAL_KEYS } from "./mapping.ts";

/** One play, as stored in the plays table. */
export type Play = {
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  ended_at: string;
  ms_played: number;
  source: "export";
};

export const DROP_REASONS = ["podcast", "private_session", "malformed"] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type Classified = { play: Play } | { dropped: DropReason };

const MAX_MS_PLAYED = 2_147_483_647; // the largest value of the integer column

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Text the database can store: a string with no NUL character. */
function storableText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\u0000");
}

/** Returns the time as an ISO string, or null when it is not a real moment. */
function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Date accepts 31 February and rolls it forward. Check the calendar day by hand.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/**
 * Decides what one row of an export becomes: a play to store, or a drop with one reason.
 * A row that is both private and a podcast counts as private.
 */
export function classifyRow(raw: unknown): Classified {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { dropped: "malformed" };
  }
  const row = raw as Record<string, unknown>;

  // Fail safe: anything but a plain false or an absent flag is treated as private.
  const flag = row[SIGNAL_KEYS.private_session];
  if (flag !== undefined && flag !== null && flag !== false) {
    return { dropped: "private_session" };
  }

  const trackUri = row[COLUMN_KEYS.track_uri];
  if (
    !isBlank(row[SIGNAL_KEYS.episode_name]) ||
    !isBlank(row[SIGNAL_KEYS.episode_uri]) ||
    isBlank(trackUri)
  ) {
    return { dropped: "podcast" };
  }

  const trackName = row[COLUMN_KEYS.track_name];
  const artistName = row[COLUMN_KEYS.artist_name];
  const albumName = row[COLUMN_KEYS.album_name];
  const msPlayed = row[COLUMN_KEYS.ms_played];
  const endedAt = parseTimestamp(row[COLUMN_KEYS.ended_at]);

  if (
    !storableText(trackUri) ||
    !storableText(trackName) ||
    !storableText(artistName) ||
    trackUri.trim() === "" ||
    trackName.trim() === "" ||
    artistName.trim() === "" ||
    (!isBlank(albumName) && !storableText(albumName)) ||
    endedAt === null ||
    typeof msPlayed !== "number" ||
    !Number.isInteger(msPlayed) ||
    msPlayed < 0 ||
    msPlayed > MAX_MS_PLAYED
  ) {
    return { dropped: "malformed" };
  }

  return {
    play: {
      track_uri: trackUri,
      track_name: trackName,
      artist_name: artistName,
      album_name: isBlank(albumName) ? null : (albumName as string),
      ended_at: endedAt,
      ms_played: msPlayed,
      source: "export",
    },
  };
}
