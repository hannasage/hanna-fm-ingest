-- The weekly chart gains an artist name on each row.
--
-- chart_weekly now returns an extra column, artist, after name:
--   * a track row: the artist name of that track
--   * an album row: the artist name of that album. The album key already hashes the album and the
--     artist apart, so one album row always has exactly one artist.
--   * an artist row: null. The name of the row is the artist.
--
-- A track key (the track URI) can be played under more than one artist name over time. The rule that
-- picks one is fixed and does not depend on the order the plays were stored in:
--   1. Count the plays the chart counts for that key, from the first play up to and including the
--      week asked for. The counted plays are the ones the chart counts: not newer than the public
--      cutoff, and 30 seconds or longer or with no ms_played. Nothing newer than the asked week
--      takes part, so a later week never changes an earlier chart.
--   2. The artist name with the most counted plays wins.
--   3. A tie goes to the artist name that sorts first in byte order (collation "C") after the name is
--      normalised to Unicode form NFKC, so a letter and the same letter written as a base plus an accent
--      sort alike. A capital letter sorts before a lower case one. Two names that differ only in form
--      still count apart, and a tie between them goes to the first in plain byte order.
--
-- Nothing else changes. Every rule of 20261123030000_chart_weekly.sql stays: the public delay snapped to
-- Eastern midnight, whole minutes, the 5 second statement timeout, search_path = '', stable and
-- not security definer. A new return column cannot be added with create or replace, so the function is
-- dropped and made again, and its grants are set again below: no browser role may run it.
--
-- chart_bounds is not changed. It already returns first_week and latest_week, which the route now sends.

drop function public.chart_weekly(date, text, integer, integer, timestamptz);

create function public.chart_weekly(
  p_week       date,
  p_kind       text,
  p_limit      integer,
  p_delay_days integer,
  p_now        timestamptz default now()
)
returns table (
  rank           integer,
  key            text,
  name           text,
  artist         text,
  plays          integer,
  minutes        integer,
  last_week_rank integer,
  peak_rank      integer,
  weeks_on_chart integer
)
language plpgsql
stable
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz := public.chart_cutoff(p_now, p_delay_days);
  v_end    timestamptz := ((p_week + 7)::timestamp at time zone 'America/New_York');
begin
  return query
  with weekly as (
    select date_trunc('week', p.ended_at at time zone 'America/New_York')::date as week,
           -- An album key hashes the album and the artist apart, so no pair of names can make
           -- the same key as another pair. The name shown is Album - Artist.
           case p_kind
             when 'track'  then p.track_uri
             when 'artist' then p.artist_name
             else md5(p.album_name) || '.' || md5(p.artist_name)
           end as item_key,
           max(case p_kind
                 when 'track'  then p.track_name
                 when 'artist' then p.artist_name
                 else p.album_name || ' - ' || p.artist_name
               end) as item_name,
           -- One album key has one artist, so max() only picks that one name. A track gets its artist below.
           max(case when p_kind = 'album' then p.artist_name end) as album_artist,
           count(*)::integer as plays,
           coalesce(sum(p.ms_played), 0) as ms
      from public.plays p
     where p.ended_at <= v_cutoff
       and p.ended_at <  v_end
       -- A poll row has a null ms_played. The 30 second rule cannot be applied to it, because the
       -- poller never learns the length of a play. It counts as a play and adds no minutes.
       and (p.ms_played is null or p.ms_played >= 30000)
       and (p_kind <> 'album' or p.album_name is not null)
     group by 1, 2
  ),
  ranked as (
    select w.*,
           (row_number() over (
              partition by w.week
              order by w.plays desc,
                       w.ms desc,
                       lower(w.item_name) collate "C",
                       w.item_name collate "C",
                       w.item_key collate "C"
           ))::integer as rnk
      from weekly w
  ),
  history as (
    select r.*,
           (min(r.rnk) over (partition by r.item_key))::integer as peak,
           (count(*) over (partition by r.item_key))::integer as weeks,
           (max(r.rnk) filter (where r.week = p_week - 7)
              over (partition by r.item_key))::integer as last_rnk
      from ranked r
  ),
  top as (
    select h.*
      from history h
     where h.week = p_week
     order by h.rnk
     limit p_limit
  ),
  -- Only a track chart needs this, and only for the rows that are shown. It reads the plays the chart
  -- counts, the same filter as above, and ends at the same week, so no later play takes part.
  track_artist as (
    select distinct on (c.track_uri) c.track_uri, c.artist_name
      from (
        select p.track_uri, p.artist_name, count(*) as n
          from public.plays p
         where p_kind = 'track'
           and p.track_uri in (select t.item_key from top t)
           and p.ended_at <= v_cutoff
           and p.ended_at <  v_end
           and (p.ms_played is null or p.ms_played >= 30000)
         group by p.track_uri, p.artist_name
      ) c
     order by c.track_uri, c.n desc, normalize(c.artist_name, nfkc) collate "C", c.artist_name collate "C"
  )
  select t.rnk, t.item_key, t.item_name,
         case p_kind
           when 'track'  then ta.artist_name
           when 'artist' then null
           else t.album_artist
         end,
         t.plays,
         round(t.ms / 60000.0)::integer, t.last_rnk, t.peak, t.weeks
    from top t
    left join track_artist ta on ta.track_uri = t.item_key
   order by t.rnk;
end
$$;

revoke all on function public.chart_weekly(date, text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.chart_weekly(date, text, integer, integer, timestamptz) to service_role;
