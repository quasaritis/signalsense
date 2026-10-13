-- Private schema: not exposed through the Supabase REST API. Only the traffic edge function touches it.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;

-- ---------- helpers ----------
create or replace function app.dist_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable parallel safe as $$
  select 111320 * sqrt(power(lat2 - lat1, 2) + power((lon2 - lon1) * cos(radians((lat1 + lat2) / 2)), 2))
$$;

create or replace function app.lifetime(p_kind text)
returns interval language sql immutable as $$
  select case p_kind
    when 'jam' then interval '60 minutes'
    when 'accident' then interval '2 hours'
    when 'breakdown' then interval '90 minutes'
    when 'waterlogging' then interval '6 hours'
    when 'closed' then interval '12 hours'
    when 'construction' then interval '7 days'
    when 'event' then interval '6 hours'
    when 'police' then interval '2 hours'
    when 'signal' then interval '6 hours'
    when 'pothole' then interval '30 days'
    else interval '2 hours' end
$$;

-- ---------- community reports ----------
create table app.reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('jam','accident','breakdown','waterlogging','closed','construction','event','police','signal','pothole','other')),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  note text check (char_length(note) <= 200),
  severity smallint not null default 2 check (severity between 1 and 3),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirms int not null default 0,
  clears int not null default 0,
  status text not null default 'active' check (status in ('active','cleared')),
  reporter text not null
);
create index reports_active_geo on app.reports (lat, lon) where status = 'active';
create index reports_geo_time on app.reports (lat, lon, created_at);
create index reports_reporter on app.reports (reporter, created_at desc);

create table app.report_votes (
  report_id uuid not null references app.reports(id) on delete cascade,
  voter text not null,
  vote text not null check (vote in ('still','cleared')),
  created_at timestamptz not null default now(),
  primary key (report_id, voter)
);
create index report_votes_voter on app.report_votes (voter, created_at desc);

-- ---------- jam history (built from live route checks and area lookups) ----------
create table app.jam_observations (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  bucket timestamptz not null,
  cell text not null,
  lat double precision not null,
  lon double precision not null,
  delay_s int,
  length_m int,
  magnitude smallint,
  category text,
  road text,
  source text not null check (source in ('route','area')),
  unique (cell, bucket)
);
create index jam_obs_geo_time on app.jam_observations (lat, lon, observed_at);
create index jam_obs_time on app.jam_observations (observed_at);

alter table app.reports enable row level security;
alter table app.report_votes enable row level security;
alter table app.jam_observations enable row level security;

-- ---------- report functions ----------
create or replace function app.submit_report(p_kind text, p_lat double precision, p_lon double precision,
  p_note text, p_severity smallint, p_reporter text)
returns table (id uuid, merged boolean)
language plpgsql as $$
declare
  v_existing uuid;
begin
  if (select count(*) from app.reports r where r.reporter = p_reporter and r.created_at > now() - interval '1 hour') >= 6 then
    raise exception 'rate_limited';
  end if;

  -- Same problem already reported within 150 m: count this as a confirmation instead of a duplicate pin.
  select r.id into v_existing from app.reports r
  where r.status = 'active' and r.expires_at > now() and r.kind = p_kind
    and r.lat between p_lat - 0.0015 and p_lat + 0.0015
    and r.lon between p_lon - 0.0016 and p_lon + 0.0016
    and app.dist_m(r.lat, r.lon, p_lat, p_lon) < 150
  order by app.dist_m(r.lat, r.lon, p_lat, p_lon) limit 1;

  if v_existing is not null then
    perform app.vote_report(v_existing, p_reporter, 'still');
    return query select v_existing, true;
    return;
  end if;

  return query
  insert into app.reports (kind, lat, lon, note, severity, expires_at, reporter)
  values (p_kind, p_lat, p_lon, nullif(trim(p_note), ''), coalesce(p_severity, 2), now() + app.lifetime(p_kind), p_reporter)
  returning app.reports.id, false;
end $$;

create or replace function app.vote_report(p_id uuid, p_voter text, p_vote text)
returns table (id uuid, status text, confirms int, clears int, expires_at timestamptz)
language plpgsql as $$
declare
  v app.reports%rowtype;
  v_still int; v_clear int;
begin
  if (select count(*) from app.report_votes rv where rv.voter = p_voter and rv.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'rate_limited';
  end if;

  select * into v from app.reports r where r.id = p_id for update;
  if not found then raise exception 'not_found'; end if;

  if v.reporter = p_voter and p_vote = 'cleared' then
    update app.reports r set status = 'cleared' where r.id = p_id;
  elsif v.reporter <> p_voter then
    insert into app.report_votes (report_id, voter, vote) values (p_id, p_voter, p_vote)
    on conflict (report_id, voter) do update set vote = excluded.vote, created_at = now();

    select count(*) filter (where rv.vote = 'still'), count(*) filter (where rv.vote = 'cleared')
      into v_still, v_clear from app.report_votes rv where rv.report_id = p_id;

    update app.reports r set
      confirms = v_still,
      clears = v_clear,
      expires_at = case when p_vote = 'still' then greatest(r.expires_at, now() + app.lifetime(r.kind) / 2) else r.expires_at end,
      status = case when v_clear >= 2 and v_clear > v_still then 'cleared' else r.status end
    where r.id = p_id;
  end if;

  return query select r.id, r.status, r.confirms, r.clears, r.expires_at from app.reports r where r.id = p_id;
end $$;

create or replace function app.reports_in_bbox(p_minlat double precision, p_minlon double precision,
  p_maxlat double precision, p_maxlon double precision)
returns table (id uuid, kind text, lat double precision, lon double precision, note text, severity smallint,
  created_at timestamptz, expires_at timestamptz, confirms int, clears int)
language sql stable as $$
  select r.id, r.kind, r.lat, r.lon, r.note, r.severity, r.created_at, r.expires_at, r.confirms, r.clears
  from app.reports r
  where r.status = 'active' and r.expires_at > now()
    and r.lat between p_minlat and p_maxlat and r.lon between p_minlon and p_maxlon
  order by r.created_at desc
  limit 300
$$;

-- ---------- jam history functions ----------
-- p_rows: [{lat, lon, delay, len, mag, cat, road, source}]
create or replace function app.record_jams(p_rows jsonb)
returns int language sql as $$
  with ins as (
    insert into app.jam_observations (bucket, cell, lat, lon, delay_s, length_m, magnitude, category, road, source)
    select date_bin('15 minutes', now(), timestamptz '2000-01-01'),
           concat(round((x->>'lat')::float8 * 250)::int, ':', round((x->>'lon')::float8 * 250)::int),
           (x->>'lat')::float8, (x->>'lon')::float8,
           nullif(x->>'delay','')::int, nullif(x->>'len','')::int, nullif(x->>'mag','')::smallint,
           left(x->>'cat', 30), left(x->>'road', 120), x->>'source'
    from jsonb_array_elements(p_rows) x
    where (x->>'lat') is not null and (x->>'lon') is not null
    on conflict (cell, bucket) do nothing
    returning 1
  ) select count(*)::int from ins
$$;

-- Places that keep jamming (replaced by the next migration with a corrected hour filter).
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
    where (p_hour is null or abs(((extract(hour from local_t)::int - p_hour + 36) % 24) - 12) >= 11)
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

-- How jams spread across the day around a point.
create or replace function app.area_hours(p_lat double precision, p_lon double precision, p_radius_m int, p_days int default 56)
returns table (hour int, weekday_obs int, weekend_obs int)
language sql stable as $$
  with o as (
    select (j.observed_at at time zone 'Asia/Kolkata') as t
    from app.jam_observations j
    where j.observed_at > now() - make_interval(days => p_days)
      and j.lat between p_lat - p_radius_m / 111320.0 and p_lat + p_radius_m / 111320.0
      and j.lon between p_lon - p_radius_m / (111320.0 * cos(radians(p_lat))) and p_lon + p_radius_m / (111320.0 * cos(radians(p_lat)))
  )
  select h, count(*) filter (where extract(isodow from t) < 6 and extract(hour from t) = h)::int,
            count(*) filter (where extract(isodow from t) >= 6 and extract(hour from t) = h)::int
  from generate_series(0, 23) h left join o on true
  group by h order by h
$$;

-- What people say causes jams around a point.
create or replace function app.area_causes(p_lat double precision, p_lon double precision, p_radius_m int, p_days int default 30)
returns table (kind text, reports int)
language sql stable as $$
  select r.kind, count(*)::int from app.reports r
  where r.created_at > now() - make_interval(days => p_days)
    and r.lat between p_lat - p_radius_m / 111320.0 and p_lat + p_radius_m / 111320.0
    and r.lon between p_lon - p_radius_m / (111320.0 * cos(radians(p_lat))) and p_lon + p_radius_m / (111320.0 * cos(radians(p_lat)))
    and app.dist_m(r.lat, r.lon, p_lat, p_lon) <= p_radius_m
  group by r.kind order by 2 desc
$$;

revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
