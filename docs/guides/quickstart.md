# VIGO CLI quickstart

Build one City, then reuse it for Route, Matrix, and Reach. Build and first-query time depend on the size of the supplied network.

You will finish with a compiled City and saved Route, Matrix, and Reach Results. You supply the GTFS ZIP and OSM PBF; the commands do not download the example data.

For the desktop workflow, use the [Studio guide](studio.md). Studio imports data into its own project library; it does not open the CLI City directory created below.

## 1. Install

VIGO 0.4.2 requires Node.js 24.18 or newer and npm 11.6 or newer.
Source builds also require the pinned Rust toolchain. Supported targets are macOS Apple Silicon/Intel, Linux ARM64/x64 with glibc, and Windows x64. Use a native build for the target OS and CPU; City data moves between them. See the [platform and City limits](../reference/known-routing-limitations.md).

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm link
```

Check the installed command before importing data:

```bash
vigo --version
vigo capabilities
```

To avoid a global command link, omit `npm link` and replace `vigo` with `node public/vigo.mjs` from the source checkout in the examples below.

## 2. Build a City

You need a static GTFS ZIP and an OSM PBF covering the same area. The examples below use Boston; replace the filenames and coordinates for your own network.

Choose a service date covered by the feed's `calendar.txt` and `calendar_dates.txt`. Keep the original files and their acquisition dates if you intend to reproduce the build. Check the [GTFS support](../reference/gtfs-support-matrix.md) and [street assumptions](../reference/street-routing.md) for source features that affect your analysis.

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
[Performance](../development/performance.md) for the exact boundaries.

Inspect the finished City before querying it:

```bash
vigo inspect --city ./boston --output ./city-inspect.json
```

Confirm the expected sources and counts. Keep the entire City directory; the inspection JSON identifies it but does not contain the routing data.

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

This abbreviated example illustrates the Result fields, not a measured journey or benchmark. Values depend on the supplied City and request. Inspect `status`, `warnings`, and leg/diagnostic qualifications before using the answer; a blocked Result is not a successful journey. The [offline Result viewer](../guide.html#viewer) can open the exported JSON. [Read and retain a Result](../reference/results.md) explains the fields and reproducibility record.

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
  --service-date YYYY-MM-DD \
  --output ./matrix-result.json
```

Inspect every row's `status`. A ready Matrix can contain blocked pairs; missing travel times are not zero. Add more unique origins or destinations to expand the same request.

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

- [Practical workflows](workflows.md): arrival deadlines, pairwise journeys, and a complete baseline/Scenario comparison.
- [Troubleshooting](troubleshooting.md): build failures, blocked routes, time semantics, and stale observations.
- [Developer Guide](../developer-guide/VIGO-0.4.2-Developer-Guide.tex): CLI, Results, Scenario, compatibility, and full Query reference.
- [VIGO Studio Guide](studio.md): visual exploration, routing, playback, and analysis.
- [Core concepts](concepts.md): City, Scenario, Query, and Result.
