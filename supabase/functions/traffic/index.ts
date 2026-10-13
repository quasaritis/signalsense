// SignalSense traffic service.
// Keeps the TomTom API key on the server, and stores community reports and jam history.
//
// Routes:
//   GET  /traffic/search?q=Connaught+Place&lat=28.6&lon=77.2
//   GET  /traffic/route?from=28.61,77.20&to=28.63,77.21&mode=car&alts=1&depart=2026-10-13T21:30:00+05:30
//   GET  /traffic/tile/{layer}/{z}/{x}/{y}   layer: base | base-night | flow | flow-dark | inc | inc-night
//   GET  /traffic/area?lat=28.6&lon=77.2&r=3        live incidents, reports, usual jams and busy hours near a point
//   GET  /traffic/reports?bbox=minLat,minLon,maxLat,maxLon
//   GET  /traffic/hotspots?bbox=minLat,minLon,maxLat,maxLon&hour=18&weekend=0
//   POST /traffic/report  {kind, lat, lon, note?, severity?}
//   POST /traffic/vote    {id, vote: "still" | "cleared"}
//
// Secrets (Edge Functions > Secrets):
//   TOMTOM_API_KEY   required
//   ALLOWED_ORIGINS  optional, comma-separated extra sites (the Vercel sites are always allowed)
//   REPORT_SALT      optional, used to hash reporter IPs (falls back to the TomTom key)
// SUPABASE_DB_URL is provided by Supabase automatically.

import postgres from "npm:postgres@3.4.5";

const TT = "https://api.tomtom.com";

const TILE_PATHS: Record<string, string> = {
  "base": "/map/1/tile/basic/main",
  "base-night": "/map/1/tile/basic/night",
  "flow": "/traffic/map/4/tile/flow/relative0",
  "flow-dark": "/traffic/map/4/tile/flow/relative0-dark",
  "inc": "/traffic/map/4/tile/incidents/s3",
  "inc-night": "/traffic/map/4/tile/incidents/night",
};
const TILE_CACHE: Record<string, number> = {
  "base": 86400, "base-night": 86400,
  "flow": 120, "flow-dark": 120, "inc": 120, "inc-night": 120,
};
const MODES = new Set(["car", "motorcycle", "taxi", "bus", "van", "truck"]);
const KINDS = new Set(["jam", "accident", "breakdown", "waterlogging", "closed", "construction", "event", "police", "signal", "pothole", "other"]);

// TomTom incident icon categories we turn into readable labels.
const INC_CAT: Record<number, string> = {
  0: "Incident", 1: "Accident", 2: "Fog", 3: "Dangerous conditions", 4: "Rain", 5: "Ice", 6: "Jam",
  7: "Lane closed", 8: "Road closed", 9: "Road works", 10: "Wind", 11: "Flooding", 14: "Broken-down vehicle",
};
const INC_FIELDS =
  "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers}}}";

const DB_URL = Deno.env.get("SUPABASE_DB_URL");
const sql = DB_URL ? postgres(DB_URL, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 }) : null;

// ---------- small helpers ----------
// Only the SignalSense site (and its Vercel preview builds) may use this service, so nobody else can
// spend the TomTom quota. ALLOWED_ORIGINS (comma-separated) adds more sites, e.g. a custom domain.
const DEFAULT_ORIGINS = ["https://signalsense-six.vercel.app", "https://signalsense-byditors.vercel.app"];
const PREVIEW_RE = /^https:\/\/signalsense-[a-z0-9-]+-byditors\.vercel\.app$/;
function allowedOrigin(req: Request): string | null {
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = [...DEFAULT_ORIGINS, ...extra];
  const origin = req.headers.get("origin") ?? "";
  let refOrigin = "";
  try { refOrigin = new URL(req.headers.get("referer") ?? "").origin; } catch { /* no referer */ }
  const caller = origin || refOrigin;
  return list.includes(caller) || PREVIEW_RE.test(caller) ? caller : null;
}

function cors(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-client-id",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", ...extra },
  });
}

function latLon(v: string | null): [number, number] | null {
  if (!v) return null;
  const parts = v.split(",").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

function bbox(v: string | null, maxSpan = 1): [number, number, number, number] | null {
  if (!v) return null;
  const p = v.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c, d] = p;
  if (c <= a || d <= b || c - a > maxSpan || d - b > maxSpan) return null;
  if (a < -90 || c > 90 || b < -180 || d > 180) return null;
  return [a, b, c, d];
}

function aroundBox(lat: number, lon: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

function distM(a: [number, number], b: [number, number]) {
  const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180), y = b[0] - a[0];
  return 111320 * Math.sqrt(x * x + y * y);
}

async function sha(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Reporter identity without storing anything personal: a salted hash of the network address, and of
// network address + a random id the browser keeps. Lets us limit spam and stop double votes.
async function who(req: Request, key: string) {
  const salt = Deno.env.get("REPORT_SALT") || key;
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "").split(",")[0].trim() || "unknown";
  const cid = (req.headers.get("x-client-id") ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  return { ip: await sha(`ip|${ip}|${salt}`), device: await sha(`dev|${ip}|${cid}|${salt}`) };
}

function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  return { hour: d.getUTCHours(), weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 };
}

function background(p: Promise<unknown>) {
  const safe = p.catch((e) => console.error("background task failed", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe);
}

type Jam = { lat: number; lon: number; delay?: number; len?: number; mag?: number; cat?: string; road?: string; source: "route" | "area" };
async function recordJams(rows: Jam[]) {
  if (!sql || !rows.length) return;
  await sql`select app.record_jams(${sql.json(rows)}::jsonb)`;
}

// deno-lint-ignore no-explicit-any
function jamsFromRoutes(body: any): Jam[] {
  const out: Jam[] = [];
  for (const r of body.routes ?? []) {
    // deno-lint-ignore no-explicit-any
    const pts = (r.legs ?? []).flatMap((l: any) => l.points ?? []);
    for (const s of r.sections ?? []) {
      if (s.sectionType !== "TRAFFIC") continue;
      if ((s.magnitudeOfDelay ?? 0) < 2 && s.simpleCategory !== "JAM" && s.simpleCategory !== "ROAD_CLOSURE") continue;
      const mid = pts[Math.floor((s.startPointIndex + s.endPointIndex) / 2)];
      if (!mid) continue;
      let len = 0;
      for (let i = s.startPointIndex + 1; i <= s.endPointIndex && i < pts.length; i++) {
        len += distM([pts[i - 1].latitude, pts[i - 1].longitude], [pts[i].latitude, pts[i].longitude]);
      }
      out.push({ lat: mid.latitude, lon: mid.longitude, delay: s.delayInSeconds ?? 0, len: Math.round(len),
        mag: s.magnitudeOfDelay ?? 0, cat: s.simpleCategory ?? "JAM", source: "route" });
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function simplifyIncident(f: any) {
  const p = f.properties ?? {};
  const g = f.geometry ?? {};
  let line: [number, number][] = [];
  if (g.type === "LineString") line = (g.coordinates ?? []).map((c: number[]) => [c[1], c[0]]);
  else if (g.type === "Point") line = [[g.coordinates[1], g.coordinates[0]]];
  if (line.length > 60) { const step = Math.ceil(line.length / 60); line = line.filter((_, i) => i % step === 0 || i === line.length - 1); }
  const mid = line[Math.floor(line.length / 2)] ?? [0, 0];
  const desc = (p.events ?? []).map((e: { description?: string }) => e.description).filter(Boolean).join(", ");
  return {
    id: p.id, cat: p.iconCategory ?? 0, label: INC_CAT[p.iconCategory] ?? "Incident", mag: p.magnitudeOfDelay ?? 0,
    desc, from: p.from ?? "", to: p.to ?? "", road: (p.roadNumbers ?? []).join(", "),
    length: Math.round(p.length ?? 0), delay: Math.round(p.delay ?? 0), start: p.startTime ?? null, end: p.endTime ?? null,
    lat: mid[0], lon: mid[1], line,
  };
}

// ---------- server ----------
Deno.serve(async (req: Request) => {
  const origin = allowedOrigin(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: origin ? 204 : 403, headers: origin ? cors(origin) : {} });
  }
  if (!origin) return new Response("This site is not allowed to use the traffic service.", { status: 403 });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not supported." }, 405, origin);

  const key = Deno.env.get("TOMTOM_API_KEY");
  if (!key) return json({ error: "The traffic service is not set up yet: TOMTOM_API_KEY is missing on the server." }, 503, origin);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/traffic/, "") || "/";
  const q = url.searchParams;

  try {
    // ================= writes =================
    if (req.method === "POST") {
      if (!sql) return json({ error: "Reports are not available right now." }, 503, origin);
      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return json({ error: "Send the report as JSON." }, 400, origin); }
      const id = await who(req, key);

      if (path === "/report") {
        const kind = String(body.kind ?? "");
        const lat = Number(body.lat), lon = Number(body.lon);
        if (!KINDS.has(kind)) return json({ error: "Pick what's wrong on the road." }, 400, origin);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return json({ error: "The report needs a location." }, 400, origin);
        }
        const note = typeof body.note === "string" ? body.note.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : null;
        const sev = [1, 2, 3].includes(Number(body.severity)) ? Number(body.severity) : 2;
        try {
          const [row] = await sql`select * from app.submit_report(${kind}, ${lat}, ${lon}, ${note}, ${sev}::smallint, ${id.device}, ${id.ip})`;
          return json({ id: row.id, merged: row.merged }, 201, origin);
        } catch (e) {
          if (String(e).includes("rate_limited")) return json({ error: "You've sent a lot of reports this hour. Try again a little later." }, 429, origin);
          throw e;
        }
      }

      if (path === "/vote") {
        const rid = String(body.id ?? "");
        const vote = String(body.vote ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(rid) || (vote !== "still" && vote !== "cleared")) return json({ error: "Invalid vote." }, 400, origin);
        try {
          const [row] = await sql`select * from app.vote_report(${rid}::uuid, ${id.device}, ${vote})`;
          return json(row, 200, origin);
        } catch (e) {
          const m = String(e);
          if (m.includes("rate_limited")) return json({ error: "Too many votes this hour. Try again later." }, 429, origin);
          if (m.includes("not_found")) return json({ error: "That report no longer exists." }, 404, origin);
          throw e;
        }
      }
      return json({ error: "Not found." }, 404, origin);
    }

    // ================= map and traffic tiles =================
    const tile = path.match(/^\/tile\/([a-z-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/);
    if (tile) {
      const [, layer, z, x, y] = tile;
      const base = TILE_PATHS[layer];
      if (!base || +z > 22) return json({ error: "Unknown tile." }, 404, origin);
      const extra = layer.startsWith("flow") ? "&thickness=6" : "";
      const r = await fetch(`${TT}${base}/${z}/${x}/${y}.png?key=${key}&tileSize=256${extra}`);
      return new Response(r.body, {
        status: r.status,
        headers: {
          ...cors(origin),
          "Content-Type": r.headers.get("content-type") ?? "image/png",
          "Cache-Control": `public, max-age=${TILE_CACHE[layer]}`,
        },
      });
    }

    // ================= place search =================
    if (path === "/search") {
      const text = (q.get("q") ?? "").trim().slice(0, 120);
      if (text.length < 2) return json({ error: "Type at least two letters." }, 400, origin);
      const p = new URLSearchParams({ key, limit: "6", countrySet: "IN", typeahead: "true" });
      const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
      if (Number.isFinite(lat) && Number.isFinite(lon) && q.get("lat") && q.get("lon")) {
        p.set("lat", String(lat)); p.set("lon", String(lon));
      }
      const r = await fetch(`${TT}/search/2/search/${encodeURIComponent(text)}.json?${p}`);
      const body = await r.json();
      if (!r.ok) return json({ error: "Place search failed.", status: r.status }, 502, origin);
      // deno-lint-ignore no-explicit-any
      const results = (body.results ?? []).map((x: any) => ({
        name: x.poi?.name ?? x.address?.streetName ?? x.address?.freeformAddress,
        addr: x.address?.freeformAddress ?? "",
        lat: x.position?.lat,
        lon: x.position?.lon,
      }));
      return json({ results }, 200, origin, { "Cache-Control": "public, max-age=3600" });
    }

    // ================= route with live or predicted traffic =================
    if (path === "/route") {
      const a = latLon(q.get("from")), b = latLon(q.get("to"));
      if (!a || !b) return json({ error: "Start and destination are needed as lat,lon." }, 400, origin);
      const mode = MODES.has(q.get("mode") ?? "") ? q.get("mode")! : "car";
      const p = new URLSearchParams({
        key, traffic: "true", travelMode: mode, routeType: "fastest", sectionType: "traffic",
      });
      if (q.get("alts") === "1") { p.set("maxAlternatives", "2"); p.set("computeTravelTimeFor", "all"); }
      const depart = q.get("depart");
      if (depart) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(depart)) return json({ error: "Departure time is not valid." }, 400, origin);
        p.set("departAt", depart);
      }
      const r = await fetch(`${TT}/routing/1/calculateRoute/${a[0]},${a[1]}:${b[0]},${b[1]}/json?${p}`);
      const body = await r.json();
      if (!r.ok) {
        const msg = body?.detailedError?.message ?? body?.error?.description ?? "Route lookup failed.";
        return json({ error: msg, status: r.status }, r.status === 400 ? 400 : 502, origin);
      }
      // Live checks (not predictions) feed the jam history.
      const departsLater = depart && new Date(depart).getTime() - Date.now() > 10 * 60e3;
      if (!departsLater) background(recordJams(jamsFromRoutes(body)));
      return json(body, 200, origin, { "Cache-Control": "no-store" });
    }

    // ================= everything happening around a point =================
    if (path === "/area") {
      const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json({ error: "A location is needed." }, 400, origin);
      }
      const rKm = Math.min(15, Math.max(1, Number(q.get("r")) || 3));
      const radius = rKm * 1000;
      const [minLat, minLon, maxLat, maxLon] = aroundBox(lat, lon, radius);
      const here: [number, number] = [lat, lon];
      const now = istNow();

      const incP = (async () => {
        const p = new URLSearchParams({
          key, bbox: `${minLon},${minLat},${maxLon},${maxLat}`, fields: INC_FIELDS, language: "en-GB",
          timeValidityFilter: "present",
        });
        const r = await fetch(`${TT}/traffic/services/5/incidentDetails?${p}`);
        if (!r.ok) throw new Error(`incidents ${r.status}`);
        const body = await r.json();
        return (body.incidents ?? []).map(simplifyIncident)
          // deno-lint-ignore no-explicit-any
          .filter((i: any) => distM(here, [i.lat, i.lon]) <= radius * 1.1)
          // deno-lint-ignore no-explicit-any
          .sort((x: any, y: any) => (y.delay - x.delay) || (y.mag - x.mag));
      })();
      const safe = <T>(p: Promise<T>) => p.catch((e) => { console.error(e); return null; });
      const db = <T>(f: () => Promise<T>) => sql ? safe(f()) : Promise.resolve(null);

      const [incidents, reports, hotspots, hours, causes] = await Promise.all([
        safe(incP),
        db(() => sql!`select * from app.reports_in_bbox(${minLat}, ${minLon}, ${maxLat}, ${maxLon})`),
        db(() => sql!`select * from app.hotspots(${minLat}, ${minLon}, ${maxLat}, ${maxLon}, 56, ${now.hour}, ${now.weekend})`),
        db(() => sql!`select * from app.area_hours(${lat}, ${lon}, ${radius}, 56)`),
        db(() => sql!`select * from app.area_causes(${lat}, ${lon}, ${radius}, 30)`),
      ]);

      if (incidents?.length) {
        const jamCats = new Set([1, 6, 7, 8, 11, 14]);
        background(recordJams(incidents
          // deno-lint-ignore no-explicit-any
          .filter((i: any) => jamCats.has(i.cat) && (i.mag >= 2 || i.cat === 8 || i.delay >= 120))
          // deno-lint-ignore no-explicit-any
          .map((i: any) => ({ lat: i.lat, lon: i.lon, delay: i.delay, len: i.length, mag: i.mag, cat: i.label,
            road: i.road || i.from || null, source: "area" as const }))));
      }

      return json({
        center: { lat, lon }, radiusKm: rKm, now,
        incidents, incidentsError: incidents === null,
        // deno-lint-ignore no-explicit-any
        reports: reports?.filter((r: any) => distM(here, [r.lat, r.lon]) <= radius) ?? null,
        // deno-lint-ignore no-explicit-any
        hotspots: hotspots?.filter((h: any) => distM(here, [h.lat, h.lon]) <= radius).slice(0, 10) ?? null,
        hours, causes,
      }, 200, origin, { "Cache-Control": "private, max-age=45" });
    }

    // ================= community reports for the map =================
    if (path === "/reports") {
      const bb = bbox(q.get("bbox"), 1.5);
      if (!bb) return json({ error: "A valid map area is needed (bbox=minLat,minLon,maxLat,maxLon)." }, 400, origin);
      if (!sql) return json({ reports: [] }, 200, origin);
      const rows = await sql`select * from app.reports_in_bbox(${bb[0]}, ${bb[1]}, ${bb[2]}, ${bb[3]})`;
      return json({ reports: rows }, 200, origin, { "Cache-Control": "private, max-age=20" });
    }

    // ================= places that keep jamming =================
    if (path === "/hotspots") {
      const bb = bbox(q.get("bbox"), 1.5);
      if (!bb) return json({ error: "A valid map area is needed (bbox=minLat,minLon,maxLat,maxLon)." }, 400, origin);
      if (!sql) return json({ hotspots: [] }, 200, origin);
      const hourRaw = q.get("hour");
      const hour = hourRaw === "all" ? null : hourRaw != null && /^\d{1,2}$/.test(hourRaw) && +hourRaw < 24 ? +hourRaw : istNow().hour;
      const wk = q.get("weekend");
      const weekend = wk === "1" ? true : wk === "0" ? false : null;
      const rows = await sql`select * from app.hotspots(${bb[0]}, ${bb[1]}, ${bb[2]}, ${bb[3]}, 56, ${hour}, ${weekend})`;
      return json({ hotspots: rows, hour, weekend }, 200, origin, { "Cache-Control": "private, max-age=120" });
    }

    if (path === "/" || path === "/health") return json({ ok: true, db: !!sql }, 200, origin);
    return json({ error: "Not found." }, 404, origin);
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong on the traffic service. Try again in a moment." }, 502, origin);
  }
});
