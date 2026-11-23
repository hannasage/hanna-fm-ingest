-- Frozen contract for ticket 2. Same file goes into the site repo as a migration and into the ingest repo as a vendored copy.
create table public.plays (
  id          bigint generated always as identity primary key,
  track_uri   text        not null,
  track_name  text        not null,
  artist_name text        not null,
  album_name  text,
  ended_at    timestamptz not null,
  ms_played   integer     not null check (ms_played >= 0),
  source      text        not null check (source in ('export', 'poll')),
  created_at  timestamptz not null default now(),
  unique (track_uri, ended_at)
);
alter table public.plays enable row level security;
alter table public.plays force row level security;
revoke all on public.plays from anon, authenticated, public;
