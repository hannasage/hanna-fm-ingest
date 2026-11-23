create table public.poller_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  outcome      text        not null check (outcome in ('ok', 'failed')),
  fetched      integer              check (fetched >= 0),
  stored       integer              check (stored >= 0),
  failure_kind text                 check (failure_kind ~ '^[a-z0-9_]{1,64}$'),
  created_at   timestamptz not null default now(),
  check (finished_at >= started_at),
  check ((outcome = 'ok' and failure_kind is null) or (outcome = 'failed' and failure_kind is not null))
);
create index poller_runs_finished_at_idx on public.poller_runs (finished_at desc);
create table public.poller_state (
  key        text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  value      text        not null check (length(value) <= 200),
  updated_at timestamptz not null default now()
);
alter table public.poller_runs enable row level security;
alter table public.poller_runs force row level security;
alter table public.poller_state enable row level security;
alter table public.poller_state force row level security;
revoke all on public.poller_runs from anon, authenticated, public;
revoke all on public.poller_state from anon, authenticated, public;
revoke all on sequence public.poller_runs_id_seq from anon, authenticated, public;
