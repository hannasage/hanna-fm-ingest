-- Walking skeleton schema.
--
-- Rule: only server code reads or writes the database. The browser holds no
-- database key. Every table turns row-level security on, forces it, and gives
-- the browser roles (anon, authenticated) no privilege and no policy.
-- The server uses the service role key, which bypasses row-level security.

-- New tables in public never grant anything to the browser roles.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- Postgres lets PUBLIC (every role) run a new function unless told otherwise.
-- The built-in default that grants it is global, so the schema-scoped line alone
-- cannot remove it. The line without a schema can. It covers functions this role
-- creates in any schema, so a future function that must be public needs its own grant.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges revoke execute on functions from public;

-- Rule for future views: a view runs with its owner's rights, so it can read a
-- table that row-level security protects. Every view in public must be created
-- `with (security_invoker = true)` so it runs with the caller's rights instead.

create table public.health_check (
  id bigint generated always as identity primary key,
  label text not null,
  created_at timestamptz not null default now()
);

alter table public.health_check enable row level security;
alter table public.health_check force row level security;

-- Defense in depth: no policy exists, and no privilege either.
revoke all on table public.health_check from anon, authenticated;
