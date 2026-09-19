# VIGO CLI quickstart

Build one City, then reuse it for Route, Matrix, and Reach. Build and first-query time depend on the size of the supplied network.

For the desktop workflow, use the [Studio guide](studio.md). Studio imports data into its own project library; it does not open the CLI City directory created below.

## 1. Install

VIGO 0.4.0 requires Node.js 24.18 or newer and npm 11.6 or newer.
Source builds also require the pinned Rust toolchain. Supported targets are macOS Apple Silicon/Intel, Linux ARM64/x64 with glibc, and Windows x64. Use a native build for the target OS and CPU; City data moves between them. See the [platform and City limits](known-routing-limitations.md).

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm link
```

## 2. Build a City

You need a static GTFS ZIP and an OSM PBF covering the same area. The examples below use Boston; replace the filenames and coordinates for your own network.

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

Save `route.json`. Coordinates are **[longitude, latitude]**:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.08337, 42.32978]}
}
```

Replace `YYYY-MM-DD` in every command below with an exact local service date covered by your GTFS feed. Then run:

```bash
vigo route \
  --city ./boston \
  --request ./route.json \
  --time 11:04 \
  --service-date YYYY-MM-DD \
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

This abbreviated example illustrates the Result fields, not a measured journey or benchmark. Values depend on the supplied City and request. Inspect `status` and `warnings` before using the answer; a blocked Result is not a successful journey. The [offline Result viewer](guide.html#viewer) can open the exported JSON.

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
  --service-date YYYY-MM-DD
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
  --service-date YYYY-MM-DD \
  --output ./reach-result.json
```

## Where next

- [Developer Guide](developer-guide/VIGO-0.4.0-Developer-Guide.tex): CLI, Results, Scenario, compatibility, and full Query reference.
- [VIGO Studio Guide](studio.md): visual exploration, routing, playback, and analysis.
- [Core concepts](concepts.md): City, Scenario, Query, and Result.
