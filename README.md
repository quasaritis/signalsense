# SignalSense

See traffic jams and road blocks in your area, report problems on the road, and check a route before you leave. Built for Indian cities.

Live site: https://signalsense-six.vercel.app

## What it does

- **My area**: live jams, closures and accidents within 2, 5 or 10 km of you or of the map centre, plus problems people have reported.
- **Report a problem**: anyone can drop a pin for a jam, accident, broken-down vehicle, waterlogging, closure, construction, rally/event, police barricade, broken signal or pothole. No account needed.
- **Crowd checking**: other people tap "Still there" or "It's cleared". Reports expire on their own (a jam after 1 hour, construction after 7 days), and two "cleared" votes remove one early. A second report of the same problem nearby counts as a confirmation.
- **Jam history**: every live check saves where the jams were. Over time this shows spots that jam at the same hour every day, when an area is busiest, and what people say causes jams there.
- **Route check**: every route with live or predicted traffic, jams along the way, reports on your route, and the best time to leave in the next two hours.

## How it's built

| Part | Where | What |
|---|---|---|
| `index.html` | Vercel (static) | The whole app: one page, Leaflet map, no build step |
| `supabase/functions/traffic` | Supabase Edge Function | Hides the TomTom key; serves map tiles, search, routing, area summaries, reports, votes and hotspots |
| `supabase/migrations` | Supabase Postgres | Private `app` schema: `reports`, `report_votes`, `jam_observations`, plus SQL functions. Only the edge function can reach it |

Traffic data comes from TomTom. Reporters are identified only by a salted hash, so no personal data is stored.

## Edge function settings

Set these in Supabase under Edge Functions > Secrets:

- `TOMTOM_API_KEY` (required)
- `ALLOWED_ORIGINS` (optional): extra sites allowed to use the service. `signalsense-six.vercel.app`, `signalsense-byditors.vercel.app` and preview builds are always allowed.
- `REPORT_SALT` (optional): salt for hashing reporters

## Deploying

- **Site**: pushing to `main` deploys to Vercel.
- **Edge function**: `supabase functions deploy traffic --no-verify-jwt`
- **Database**: `supabase db push`
