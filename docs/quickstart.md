# VIGO 0.3.2 Quickstart

Build one City, then reuse it for Route, Matrix, and Reach. Build and first-query time depend on the size of the supplied network.

## 1. Install

VIGO 0.3.2 requires Node.js 24.18 or newer and npm 11.6 or newer.
Source builds also require the pinned Rust toolchain. Supported targets are macOS Apple Silicon/Intel, Linux ARM64/x64 with glibc, and Windows x64. Use a native build for the target OS and CPU; City data moves between them. See the [platform and City limits](known-routing-limitations.md).

```bash
git clone --branch v0.3.2 https://github.com/hytangs/vigo.git
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
Time this command from invocation through successful return to measure Build
from GTFS and OSM. Include the first Route as well when measuring time to the
first answer. Reopening `./boston` measures a different operation; see
[Performance](performance.md) for the exact boundaries.

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

This abbreviated example illustrates the Result fields. Values depend on the supplied City and request.

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

- [Developer Guide](developer-guide/VIGO-0.3.2-Developer-Guide.tex): CLI, Results, Scenario, compatibility, and full Query reference.
- [VIGO Studio Guide](studio.md): visual exploration, routing, playback, and analysis.
- [Core concepts](concepts.md): City, Scenario, Query, and Result.
