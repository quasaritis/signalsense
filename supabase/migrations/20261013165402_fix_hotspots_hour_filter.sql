create or replace function app.hotspots(p_minlat double precision, p_minlon double precision,
  p_maxlat double precision, p_maxlon double precision,
  p_days int default 56, p_hour int default null, p_weekend boolean default null)
returns table (cell text, lat double precision, lon double precision, days int, obs int,
  avg_delay int, road text, peak_hour int)
language sql stable as $$
  with o as (
    select j.*, (j.observed_at at time zone 'Asia/Kolkata') as local_t
    from app.jam_observations j
    where j.observed_at > now() - make_interval(days => p_days)
      and j.lat between p_minlat and p_maxlat and j.lon between p_minlon and p_maxlon
  ), f as (
    select * from o
    where (p_hour is null or least(abs(extract(hour from local_t)::int - p_hour), 24 - abs(extract(hour from local_t)::int - p_hour)) <= 1)
      and (p_weekend is null or (extract(isodow from local_t) >= 6) = p_weekend)
  )
  select f.cell, avg(f.lat), avg(f.lon), count(distinct f.local_t::date)::int, count(*)::int,
         round(avg(f.delay_s))::int,
         mode() within group (order by f.road),
         mode() within group (order by extract(hour from f.local_t)::int)
  from f group by f.cell
  order by 4 desc, 6 desc nulls last
  limit 60
$$;
revoke all on function app.hotspots(double precision,double precision,double precision,double precision,int,int,boolean) from public, anon, authenticated;
