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
create index plays_ended_at_idx on public.plays (ended_at);
