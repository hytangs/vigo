# Public route planner

The public gateway serves Studio's route planner to the public for a fixed set of prepared Cities: a City selector, typed address search, journey planning and a light or dark appearance, on phones and desktops. It exposes routing only. Management and import APIs, live-feed settings and realtime snapshots are unavailable, so every public journey uses the published timetable. [app.vigo.city](https://app.vigo.city/) runs this gateway.

## Run the gateway

Build the frontend, run Studio's local API on a loopback address, then start the gateway with a private configuration file:

```sh
npm run build:studio-assets
node src/server/public-routing-gateway.mjs /path/to/private-config.json
```

To run the gateway outside this checkout, deploy `public-routing-gateway.mjs` with its siblings `address-search.mjs`, `address-index.mjs` and `address-index-worker.mjs`. The static root holds the built `index.html`, `assets/` and brand images; it must not expose the CLI or server bundles.

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

| City field | Meaning |
| --- | --- |
| `cityId`, `name` | A prepared City in the upstream instance, and its display name |
| `timeZone` | IANA timezone; **Depart now** uses the current time there |
| `bounds` | Requests outside these bounds are rejected |
| `searchCenter` | Breaks address-search ties toward the City center |
| `addressIndexPath` | Local address index; see [Address search](#address-search) |
| `geocoderEndpoint` | Optional HTTPS Photon-compatible geocoder for searches the index cannot answer |
| `coverage` | A label disclosing partial networks or modeled data |
| `warmupRequests` | Up to four route requests run at startup; configure one per offered mode |

Up to eight Cities can be listed. Startup loads their catalogs, keeps them resident, and runs the warm-up requests before accepting visitors. A blocked warm-up result still prepares its mode, but does not prove that journeys exist: check representative journeys separately. Restart the gateway after updating prepared data. On the upstream API, set `VIGO_NATIVE_CITY_MAX` to fit the list and `VIGO_NATIVE_CITY_PROCESSES` for the host's memory and concurrency. Links can select a City with `?city=boston`.

## Limits and security

Limits apply across all Cities, per IP address and minute: 30 route and readiness requests, 60 searches and 600 other reads. Keep the gateway on loopback behind a proxy that sets `CF-Connecting-IP`. Built assets are served as immutable; the page revalidates by `ETag` and carries a content security policy. Every Result reports scheduled routing provenance.

For app.vigo.city, `src/server/public-routing-edge.mjs` runs at the edge in front of the gateway. When the routing host cannot be reached, it serves a self-contained offline page with HTTP 503 and `no-store`, which offers **Go to vigo.city** and **Stay here**; `/offline` shows that page without contacting the host. API failures stay JSON with `X-Vigo-Offline: 1`. Rate limits and geocoder errors do not trigger the offline page.

## Address search

Search suggests places after three characters and a 150 ms pause, through `POST /api/projects/:id/address-search`, within the selected City's bounds. It supports exact names and house numbers, street abbreviations, place initials and single-letter typos; nearby duplicates collapse, and stations stay distinct from landmarks with the same name. Arrow keys and Enter select a suggestion, and map picking still works if search fails.

Build a City's local index with `osmium` installed:

```sh
node scripts/build-address-index.mjs --osm city.osm.pbf \
  --output addresses.sqlite --name Boston --bounds '[-72.5,41,-70,43.5]'
```

Use a complete OSM extract for named landmarks; `--places places.json` can add an Overpass JSON export made with `out center`. The builder records source hashes, writes a new file and never changes routing Cities. Keep the index outside the public static directory, and restart the gateway after replacing it. Each City's lookups run on their own worker thread, so a broad search cannot delay routes; a lookup over two seconds counts as no match.

A City with an index answers from it alone, so what people type stays on your host. Set `geocoderEndpoint` to also ask a [Photon](https://github.com/komoot/photon)-compatible service when the index has no match. A City without an index uses Photon's public demo, which permits reasonable use without an availability guarantee; production volume needs your own geocoder. Remote lookups have an eight-second timeout, two concurrent requests and a one-hour bounded cache, and are canceled when the text changes. Clients cannot choose the geocoder.

## Check a deployment

Run `npm run typecheck`, `npm run check:css` and `npm run check:security`. Then, on the deployed site, check City switching, both appearances, address selection, and the route controls and itinerary at phone and desktop widths. The gateway checks cover startup readiness, redaction, allowlists, bounds, shared limits and geocoder failures.
