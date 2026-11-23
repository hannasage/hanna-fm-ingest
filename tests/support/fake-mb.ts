import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One request the fake MusicBrainz server saw. `at` is when it arrived, in milliseconds, read from
 * the monotonic clock `performance.now()` with its fraction. Every gap is measured on that one clock.
 */
export type Seen = {
  at: number;
  /** The path without the query, for example "/ws/2/recording". */
  path: string;
  /** The search fields, for example { recording: "SYNTH Song", artistname: "SYNTH Artist" }. */
  fields: Record<string, string>;
  params: URLSearchParams;
  userAgent: string | undefined;
  accept: string | undefined;
};

export type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type FakeMb = {
  /** The address to give the command as MB_API_BASE. */
  base: string;
  seen: Seen[];
  /** Gaps between the arrival of each request and the one before, in milliseconds, with their fraction. */
  gaps: () => number[];
  close: () => Promise<void>;
};

/**
 * Splits a Lucene query such as `recording:"A" AND artistname:"B"` into its fields.
 * The command quotes every value and escapes a quote or a backslash inside it.
 */
export function parseFields(query: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of query.matchAll(/(\w+):"((?:[^"\\]|\\.)*)"/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) fields[name] = value.replace(/\\(.)/g, "$1");
  }
  return fields;
}

/**
 * A small fake MusicBrainz web service on this computer. `respond` gets each request and
 * the number of requests so far (1 is the first), and says what to answer.
 */
export async function startFakeMb(respond: (request: Seen, count: number) => Reply): Promise<FakeMb> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const entry: Seen = {
      at: performance.now(),
      path: url.pathname,
      fields: parseFields(url.searchParams.get("query") ?? ""),
      params: url.searchParams,
      userAgent: request.headers["user-agent"],
      accept: request.headers.accept,
    };
    seen.push(entry);
    const reply = respond(entry, seen.length);
    response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    response.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/ws/2`,
    seen,
    gaps: () => seen.slice(1).map((entry, index) => entry.at - (seen[index]?.at ?? 0)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A synthetic MusicBrainz answer for each search type. Every ID here is made up.
 * The shape is the one on the MusicBrainz search page: an artist credit is `{ artist: { id, name, sort-name } }`.
 * `hits` may hold several results, best first, so a test can ask for an ambiguous answer.
 */
type Credit = { id: string; name: string };
export const answer = {
  recording: (...hits: { id: string; score: number; title: string; artists: Credit[] }[]) => ({
    created: "2026-01-01T00:00:00.000Z",
    count: hits.length,
    offset: 0,
    recordings: hits.map((hit) => ({
      id: hit.id,
      score: String(hit.score),
      title: hit.title,
      "artist-credit": hit.artists.map((artist) => ({ artist: { id: artist.id, name: artist.name, "sort-name": artist.name } })),
    })),
  }),
  releaseGroup: (...hits: { id: string; score: number; title: string; artists?: Credit[] }[]) => ({
    created: "2026-01-01T00:00:00.000Z",
    count: hits.length,
    offset: 0,
    "release-groups": hits.map((hit) => ({
      id: hit.id,
      score: String(hit.score),
      title: hit.title,
      "artist-credit": (hit.artists ?? []).map((artist) => ({ artist: { id: artist.id, name: artist.name, "sort-name": artist.name } })),
    })),
  }),
  artist: (...hits: { id: string; score: number; name: string }[]) => ({
    created: "2026-01-01T00:00:00.000Z",
    count: hits.length,
    offset: 0,
    artists: hits.map((hit) => ({ id: hit.id, score: String(hit.score), name: hit.name, "sort-name": hit.name })),
  }),
  /** No match: MusicBrainz answers 200 with an empty list. */
  empty: (listName: "recordings" | "release-groups" | "artists") => ({ count: 0, offset: 0, [listName]: [] }),
};
