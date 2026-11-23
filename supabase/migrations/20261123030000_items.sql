-- Item identity: one canonical MusicBrainz ID for every artist, album and track in the plays.
--
-- items: one row per thing as it appears in plays. `source_key` is that identity:
--   track  the Spotify track URI
--   artist the artist name, normalized (Unicode NFKC, lower case, spaces collapsed)
--   album  a JSON array of the normalized album name and artist name
-- `mbid` is the canonical ID. `spotify_uri` is an alias that sits beside it, so another
-- music service can be added later without touching this table's identity.
-- `state`: pending (not settled, or MusicBrainz was unavailable), resolved, unresolved
-- (MusicBrainz cannot match it). An unmatched item is stored, never dropped.
-- `match_score` and `matched_name` keep what MusicBrainz said, so a wrong match can be audited.
-- Two Spotify items can name one MusicBrainz entity (a song on an album and on a single).
-- The first keeps `mbid`. Each later one keeps its own row, mbid null, and `merged_into` points
-- at the row that holds the mbid, so no alias is lost and (kind, mbid) stays unique.
--
-- mb_cache: every MusicBrainz answer, keyed by the request, so a repeat lookup sends nothing.
--
-- No foreign key into plays. The plays table is not changed.
-- Same rule as every table: row-level security on and forced, nothing for the browser roles.

create table public.items (
  id           bigint generated always as identity primary key,
  kind         text        not null check (kind in ('artist', 'album', 'track')),
  mbid         uuid,
  name         text        not null,
  source_key   text        not null,
  spotify_uri  text,
  state        text        not null default 'pending' check (state in ('pending', 'resolved', 'unresolved')),
  reason       text        check (reason in ('no_match', 'below_threshold', 'empty_name')),
  match_score  smallint    check (match_score between 0 and 100),
  matched_name text,
  merged_into  bigint      references public.items (id),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (kind, source_key),
  check (mbid is null or merged_into is null),
  check ((state = 'resolved') = (mbid is not null or merged_into is not null)),
  check ((state = 'pending') = (resolved_at is null))
);
create unique index items_kind_mbid_key on public.items (kind, mbid) where mbid is not null;
create index items_pending_idx on public.items (id) where state = 'pending';
alter table public.items enable row level security;
alter table public.items force row level security;
revoke all on public.items from anon, authenticated, public;
revoke all on sequence public.items_id_seq from anon, authenticated, public;

create table public.mb_cache (
  query      text        primary key,
  response   jsonb       not null,
  fetched_at timestamptz not null default now()
);
alter table public.mb_cache enable row level security;
alter table public.mb_cache force row level security;
revoke all on public.mb_cache from anon, authenticated, public;
