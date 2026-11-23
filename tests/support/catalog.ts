import { answer, type Reply, type Seen } from "./fake-mb.ts";
import { id, T1 } from "./data.ts";

type Credit = { id: string; name: string };
type TrackHit = { id: string; score: number; title: string; artists: Credit[] };
type AlbumHit = { id: string; score: number; title: string; artists?: Credit[] };
type ArtistHit = { id: string; score: number; name: string; aliases?: string[] };
const many = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** A table of synthetic hits by the searched name. A value may be one hit or several, best first. */
export type Catalog = {
  tracks?: Record<string, TrackHit | TrackHit[]>;
  albums?: Record<string, AlbumHit | AlbumHit[]>;
  artists?: Record<string, ArtistHit | ArtistHit[]>;
};

/** Answers a search from a table of synthetic hits. Anything not in the table gets an empty list. */
export function fromCatalog(catalog: Catalog): (request: Seen) => Reply {
  return (request) => {
    if (request.path.endsWith("/recording")) {
      const hits = many(catalog.tracks?.[request.fields.recording ?? ""]);
      return { status: 200, body: hits.length > 0 ? answer.recording(...hits) : answer.empty("recordings") };
    }
    if (request.path.endsWith("/release-group")) {
      const hits = many(catalog.albums?.[request.fields.releasegroup ?? ""]);
      return { status: 200, body: hits.length > 0 ? answer.releaseGroup(...hits) : answer.empty("release-groups") };
    }
    if (request.path.endsWith("/artist")) {
      const hits = many(catalog.artists?.[request.fields.artist ?? ""]);
      return { status: 200, body: hits.length > 0 ? answer.artist(...hits) : answer.empty("artists") };
    }
    return { status: 404 };
  };
}

export const artistA = { id: id(11), name: "SYNTH Artist A" };
export const artistB = { id: id(12), name: "SYNTH Artist B" };

/** Three tracks, two albums, two artists. Both artists are settled from a track's credit, so no artist search is needed. */
export const FULL: Catalog = {
  tracks: {
    "SYNTH Song One": { id: id(21), score: 100, title: "SYNTH Song One", artists: [artistA] },
    "SYNTH Song Two": { id: id(22), score: 97, title: "SYNTH Song Two", artists: [artistA] },
    "SYNTH Song Three": { id: id(23), score: 95, title: "SYNTH Song Three", artists: [artistB] },
  },
  albums: {
    "SYNTH Album A": { id: id(31), score: 100, title: "SYNTH Album A", artists: [artistA] },
    "SYNTH Album B": { id: id(32), score: 92, title: "SYNTH Album B", artists: [artistB] },
  },
};

/** One track and its album, for the tests that need few requests. */
export const SMALL: Catalog = {
  tracks: { [T1.track]: FULL.tracks![T1.track]! },
  albums: { [T1.album!]: FULL.albums![T1.album!]! },
};
