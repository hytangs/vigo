# VIGO 0.3.0 Quickstart

Build one City and run the first Route in about five minutes.

## 1. Install

VIGO 0.3.0 requires Node.js 24.18 or newer and npm 11.6 or newer.

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm link
```

## 2. Build a City

You need a static GTFS ZIP and an OSM PBF covering the same area.

```bash
vigo build \
  --gtfs ./mbta.zip \
  --gtfs-scope mbta \
  --osm ./massachusetts.osm.pbf \
  --output ./boston
```

VIGO writes one complete `./boston` directory. An existing output is left alone unless you supply `--replace`.

## 3. Run a Route

Save `route.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.08337, 42.32978]}
}
```

Run the request with an exact local service date:

```bash
vigo route \
  --city ./boston \
  --request ./route.json \
  --time 11:04 \
  --service-date 2026-09-04 \
  --output ./route-result.json
```

## 4. Inspect the Result

Every computation returns a Result with the answer and its meaning:

```json
{
  "kind": "route",
  "status": "ready",
  "query": {},
  "result": {
    "durationMinutes": 33.517,
    "transfers": 2,
    "legs": []
  },
  "warnings": [],
  "timing": {"computeMs": 3.301}
}
```

These numbers were observed from the Boston City used for the guide. Another City revision can return a different journey.

## 5. Run Matrix

Save `matrix.json`:

```json
{
  "origins": [{"id": "home", "point": {"coordinate": [-71.11902, 42.37334]}}],
  "destinations": [{"id": "work", "point": {"coordinate": [-71.07540, 42.34730]}}]
}
```

```bash
vigo matrix \
  --city ./boston \
  --request ./matrix.json \
  --time 08:00 \
  --service-date 2026-09-04
```

## 6. Run Reach

Save `reach.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48
}
```

```bash
vigo reach \
  --city ./boston \
  --request ./reach.json \
  --time 08:00 \
  --service-date 2026-09-04 \
  --output ./reach-result.json
```

## Where next

- [Developer Guide](developer-guide/VIGO-0.3.0-Developer-Guide.tex): CLI, Python, Results, Scenario, compatibility, and full Query reference.
- [VIGO Studio Guide](studio.md): visual exploration, routing, playback, and analysis.
- [Core concepts](concepts.md): City, Scenario, Query, and Result.
