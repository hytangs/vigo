# Public route planner

The public gateway serves the Studio route planner with a City selector, typed
address search, and a day/night preference saved in the browser. On phones the
map occupies its own row above the controls or itinerary. The itinerary can be
closed to the route choices. The mobile planner always stays partially expanded; map picking keeps the controls visible. The header
uses icons for appearance and the link to the VIGO website, without subtitles.

Build the frontend with `npm run build:studio-assets`. Run the local API on a
loopback address, then start the gateway:

```sh
node src/server/public-routing-gateway.mjs /path/to/private-config.json
```

Deploy `public-routing-gateway.mjs` and its siblings `address-search.mjs`,
`address-index.mjs` and `address-index-worker.mjs` if
copying the gateway outside this checkout. The static root contains the built
`index.html`, `assets/`, and brand images. It must not expose the CLI or server
bundles. Public routing uses published timetables only; live-feed settings and
client-supplied realtime snapshots cannot enable live routing.

For app.vigo.city, `src/server/public-routing-edge.mjs` runs in the existing
Cloudflare Worker with its `ROUTING` VPC binding. It serves a self-contained
temporary-offline page if the routing host cannot be reached. The page returns
HTTP 503 with `no-store`, shows an eight-second countdown to https://vigo.city/,
and offers **Go to vigo.city** and **Stay here**. `/offline` serves the same page
without contacting the host, allowing verification without taking routing down.
API failures remain JSON and carry `X-Vigo-Offline: 1`; the public app then opens
the edge page. Rate limits and geocoder errors do not trigger the redirect.

```json
{
  "upstream": "http://127.0.0.1:8787",
  "publicOrigin": "https://routes.example.org",
  "staticRoot": "/srv/vigo/public",
  "port": 8788,
  "maxActive": 2,
  "cities": [
    {
      "cityId": "boston",
      "name": "Boston",
      "timeZone": "America/New_York",
      "bounds": [-72.5, 41, -70, 43.5],
      "searchCenter": [-71.0589, 42.3601],
      "addressIndexPath": "/srv/vigo/search/boston.sqlite",
      "coverage": "Selected transit feeds · Scheduled",
      "warmupRequests": [
        {
          "mode": "bike",
          "origin": { "coordinate": [-71.0589, 42.3601] },
          "destination": { "coordinate": [-71.0754, 42.3473] },
          "bike": { "profile": "balanced", "speedKph": 18 }
        }
      ]
    }
  ]
}
```

The IDs must identify existing, prepared Cities in the upstream instance. Up to
eight Cities can be allowlisted, each with its own bounds, coverage label,
IANA timezone, and up to four startup route requests. Configure one
startup request per supported mode. Startup loads the catalogs, retains the
Cities, and runs those requests before accepting visitors. The public catalog is
a startup snapshot; restart the gateway after updating prepared City data. A valid blocked
startup result prepares its mode but does not prove that an itinerary exists.
Check representative journeys separately. Set `VIGO_NATIVE_CITY_MAX` on the API
to fit the allowlist and choose `VIGO_NATIVE_CITY_PROCESSES` for the host's memory
and concurrency budget. These controls do not keep a sleeping host online.

Rate and concurrency limits apply across the allowlist: per IP, 30 route and
readiness requests, 60 searches and 600 other reads a minute. Keep the gateway on
loopback behind the edge, which sets `CF-Connecting-IP`. Built assets are served as
immutable; the document revalidates by `ETag` and carries the page's security policy.
Requests outside a
City's bounds are rejected, and management/import APIs remain unavailable.
Every City returns scheduled routing provenance. **Depart now** uses the
current clock in the City's timezone against its published timetable. The public
gateway does not fetch live feeds or forward realtime snapshots.
Use coverage labels to disclose partial networks or modeled timetable data.
Links can select a City with `?city=boston`.

Address search suggests places as the person types, after at least three
characters and a 150 ms typing pause, using
`POST /api/projects/:id/address-search`. The public gateway restricts results to
the selected City's bounds. Configure `addressIndexPath` for local SQLite FTS5
lookup over OSM addresses, streets, and named places. `searchCenter` biases ties
toward the City center. Lookups run on one worker thread per City, so a broad
search cannot delay routes or other Cities; one that exceeds two seconds counts
as no local match. Exact names and house numbers, street abbreviations,
place initials, and single-letter typos are supported. Nearby duplicates collapse;
stations remain distinct from the landmarks they share a name with. A bounded
browser cache restores recent searches immediately.

Build the separate geocoder artifact with `osmium` installed:

```sh
node scripts/build-address-index.mjs --osm city.osm.pbf \
  --output addresses.sqlite --name Boston --bounds '[-72.5,41,-70,43.5]'
```

Use a complete OSM extract for named landmarks. A routing extract may omit
non-street relations; `--places places.json` can add a retained Overpass JSON
export made with `out center`. This is an offline preparation step, never a
visitor request. The builder records source hashes, builds to a new file, and
does not modify routing Cities. Keep the resulting index outside the public
static directory. Restart the gateway after replacing its configured index.

A City with an index answers from it alone, so what people type stays on this
host. To look further when the index has no match, set `geocoderEndpoint` on the
City to the HTTPS address of a [Photon](https://github.com/komoot/photon)-compatible
service. A City with no index uses Photon's public demo by default. Remote lookups
have an eight-second timeout, two concurrent requests, and a bounded one-hour
memory cache. Uncached remote lookups can still take seconds. Editing, clearing, selecting a place, changing City, or pressing
Escape cancels obsolete lookups, including the upstream geocoder request.
Search has its own 60-request-per-minute budget per IP across all Cities, so
typing cannot consume the route engine's query or concurrency allowance.
Arrow keys and Enter select a suggestion; map picking remains available if
the geocoder fails. Photon's public demo permits
reasonable usage but offers no availability guarantee; production volume
requires a suitable geocoding service. Its URL cannot be supplied by clients.

Run `npm run typecheck`, `npm run check:css`, and `npm run check:security`, then
verify City switching, both appearances, typed address selection, and the
route controls and itinerary at phone and desktop widths against the deployed
site. Gateway checks cover startup readiness, metadata redaction, allowlists,
regional bounds, shared request limits, and geocoder failures.
