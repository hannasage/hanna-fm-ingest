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
-- `reason` says why an item is unresolved:
--   no_match         MusicBrainz had no hit for this artist
--   below_threshold  the best hit scored under the match threshold
--   ambiguous        two different MusicBrainz entities both scored at or above the threshold
--   empty_name       the plays hold a blank name
--   no_artist        a track or album with no artist is never searched by its title alone
--   bad_query        MusicBrainz refused the question for this item (a 4xx other than 401 and 403)
--   name_too_long    the name is longer than the search limit, so no request was made
-- `credit` is the one reason a resolved row may hold: an artist settled from the credit of a
-- matched track, with no search of its own and no score.
-- `match_score` and `matched_name` keep the best hit MusicBrainz offered, even when it was
-- refused, so a wrong match can be audited.
-- `attempts` and `last_attempt_at` count the tries that ended with MusicBrainz unavailable.
-- Two Spotify items can name one MusicBrainz entity (a song on an album and on a single).
-- The first keeps `mbid`. Each later one keeps its own row, mbid null, and `merged_into` points
-- at the row that holds the mbid, so no alias is lost and (kind, mbid) stays unique.
--
-- mb_cache: the parsed candidates of every MusicBrainz answer, keyed by the SHA-256 of the
-- request URL, so a repeat lookup sends nothing and a long name cannot overflow an index row.
-- A row older than 90 days is read as a miss. The code sets that age.
--
-- job_locks: one row per job that must run once at a time. A run takes the lock with one
-- update and holds it for a lease (30 minutes), refreshing it as it works.
--
-- No foreign key into plays. The plays table is not changed.
-- Same rule as every table: row-level security on and forced, nothing for the browser roles.

create table public.items (
  id              bigint generated always as identity primary key,
  kind            text        not null check (kind in ('artist', 'album', 'track')),
  mbid            uuid,
  name            text        not null,
  source_key      text        not null,
  spotify_uri     text,
  state           text        not null default 'pending' check (state in ('pending', 'resolved', 'unresolved')),
  reason          text        check (reason in (
                    'no_match', 'below_threshold', 'empty_name', 'ambiguous', 'no_artist',
                    'bad_query', 'name_too_long', 'credit'
                  )),
  match_score     smallint    check (match_score between 0 and 100),
  matched_name    text,
  merged_into     bigint,
  attempts        integer     not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (kind, source_key),
  -- The pair (id, kind) is what merged_into points at, so a row can only merge into its own kind.
  unique (id, kind),
  foreign key (merged_into, kind) references public.items (id, kind),
  check (merged_into is null or merged_into <> id),
  check (mbid is null or merged_into is null),
  check ((state = 'resolved') = (mbid is not null or merged_into is not null)),
  check ((state = 'pending') = (resolved_at is null)),
  -- A reason belongs to an unresolved row. The one exception is `credit` on a resolved artist.
  check (reason is null or state = 'unresolved' or (state = 'resolved' and reason = 'credit' and kind = 'artist'))
);
create unique index items_kind_mbid_key on public.items (kind, mbid) where mbid is not null;
create index items_pending_idx on public.items (id) where state = 'pending';
alter table public.items enable row level security;
alter table public.items force row level security;
revoke all on public.items from anon, authenticated, public;
revoke all on sequence public.items_id_seq from anon, authenticated, public;

create table public.mb_cache (
  request_hash text        primary key check (request_hash ~ '^[0-9a-f]{64}$'),
  candidates   jsonb       not null,
  fetched_at   timestamptz not null default now()
);
alter table public.mb_cache enable row level security;
alter table public.mb_cache force row level security;
revoke all on public.mb_cache from anon, authenticated, public;

create table public.job_locks (
  name         text        primary key,
  locked_until timestamptz
);
alter table public.job_locks enable row level security;
alter table public.job_locks force row level security;
revoke all on public.job_locks from anon, authenticated, public;
