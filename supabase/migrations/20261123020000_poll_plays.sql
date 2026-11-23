alter table public.plays alter column ms_played drop not null;
alter table public.plays add constraint plays_export_needs_ms check (source <> 'export' or ms_played is not null);
