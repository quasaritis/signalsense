alter table app.reports add column if not exists ip_hash text;
create index if not exists reports_ip on app.reports (ip_hash, created_at desc);

create or replace function app.submit_report(p_kind text, p_lat double precision, p_lon double precision,
  p_note text, p_severity smallint, p_reporter text, p_ip text)
returns table (id uuid, merged boolean)
language plpgsql as $$
declare
  v_existing uuid;
begin
  -- Per device: 6 an hour. Per network (many phones can share one mobile IP): 60 an hour.
  if (select count(*) from app.reports r where r.reporter = p_reporter and r.created_at > now() - interval '1 hour') >= 6
     or (select count(*) from app.reports r where r.ip_hash = p_ip and r.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'rate_limited';
  end if;

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
  insert into app.reports (kind, lat, lon, note, severity, expires_at, reporter, ip_hash)
  values (p_kind, p_lat, p_lon, nullif(trim(p_note), ''), coalesce(p_severity, 2), now() + app.lifetime(p_kind), p_reporter, p_ip)
  returning app.reports.id, false;
end $$;
revoke all on function app.submit_report(text, double precision, double precision, text, smallint, text, text) from public, anon, authenticated;
