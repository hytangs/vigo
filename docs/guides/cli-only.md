# VIGO CLI

VIGO CLI packages the complete command-line routing engine in two executable
payload files: `vigo.mjs` and `vigo-routing-kernel.node`. The archive also contains
licenses, this guide, and a SHA-256 manifest. It contains no Studio, Electron,
HTTP server, Python wrapper, `node_modules`, Node runtime, or transport data.
The CLI and native kernel are the same ones used by the full distribution.

## Run the archive

Extract the archive matching your operating system and CPU. Provide Node.js
24.18 or newer, then run from the extracted directory:

```sh
node vigo.mjs --help
node vigo.mjs capabilities
node vigo.mjs help reach
```

No npm install, Rust compiler, or desktop app is needed after extraction. Keep
the two runtime files together; paths containing spaces are supported. On macOS
and Linux, `./vigo.mjs` also works. For a short command in a POSIX shell:

```sh
alias vigo='node "/absolute/path/to/vigo.mjs"'
```

The examples below use that alias. On Windows, use `node .\vigo.mjs` instead of
`vigo`. A native archive works only on its matching OS/CPU; a macOS archive is
not a Linux binary. Node and your City data are additional to the archive size.

## Build once

```sh
vigo build --gtfs feed.zip --osm region.osm.pbf --output ./city
vigo inspect --city ./city
```

Repeat `--gtfs` for multiple feeds, with a unique `--gtfs-scope` per feed. OSM
must cover the query area. `--replace` explicitly replaces an existing City;
otherwise an existing destination is rejected. `--private-access endpoints`
enables the existing authorized-endpoint policy when appropriate.

The following examples use `YYYY-MM-DD` as a placeholder: choose an exact date
covered by your GTFS feed, and replace stop IDs `A` and `B` with real IDs. Times
are local service times in the City timezone and can extend through `29:59`.
Coordinates always use `[longitude, latitude]`.

## Route and Matrix

Save `route.json`:

```json
{"origin":"A","destination":"B","allowStreetTransfers":false,"minimumTransferBufferMinutes":2}
```

```sh
vigo route --city ./city --request route.json --service-date YYYY-MM-DD \
  --time 08:00 --max-walk 1.2 --output route-result.json
vigo route --city ./city --request route.json --service-date YYYY-MM-DD \
  --time 09:00 --time-preference arrive
```

Route retains transit, walk, and drive modes; ordered `waypoints`; alternatives
when returned by the engine; depart-at and arrive-by; departure windows;
walking/transfer/horizon controls; supplied matched realtime transit snapshots;
and supplied traffic for realtime Drive. Select `--mode walk` or `--mode drive`
with coordinate points. Realtime transit uses `routingDataMode: "realtime"`
and `realtimeSnapshot` in the request. Traffic uses `traffic` with realtime Drive.
The package does not fetch live feeds automatically.

For a transit CSV batch, provide columns `id,origin_stop_id,destination_stop_id`,
or `id,origin_lon,origin_lat,destination_lon,destination_lat`:

```sh
vigo route --city ./city --input trips.csv --output trips-result.csv \
  --service-date YYYY-MM-DD --time 08:00
```

Save `matrix.json`:

```json
{"origins":[{"id":"home","point":"A"}],"destinations":[{"id":"work","point":"B"}],"includeJourneys":true}
```

```sh
vigo matrix --city ./city --request matrix.json --service-date YYYY-MM-DD \
  --time 08:00 --output matrix-result.json
```

Matrix retains transit, walk, and drive; one-to-many, many-to-one, and
many-to-many queries; depart-at and arrive-by; optional transit journeys and
geometry; and supplied traffic for realtime Drive. `includeGeometry` requires
`includeJourneys: true`. Transit Matrix uses scheduled service.

## Isochrones and planned service

Save `reach.json`:

```json
{"origin":"A","cutoffsMinutes":[15,30,45,60],"extentRadiusKm":8,"rasterSize":96}
```

```sh
vigo reach --city ./city --request reach.json --service-date YYYY-MM-DD \
  --time 08:00 --street-edges --output reach-result.json
```

The Result contains:

- `stops` and `scenarioStops`: reached scheduled and planned-service stops.
- `surface.values` with `surface.bounds`: the requested grid, with JSON `null`
  for unreached cells; `contours`: GeoJSON isolines; and `areas`: reachable-cell
  Polygon/MultiPolygon GeoJSON for that grid.
- `surface.fullValues` with `surface.fullBounds`, plus `fullContours` and `fullAreas`: the
  complete reached-network envelope when the native engine returns it.
- `surface.edges`: the complete indexed directed-street bundle when
  `--street-edges` or JSON `includeStreetEdges: true` is set. Edges use the
  `vigo.street.edge-bundle.v1` format; they are not a GeoJSON FeatureCollection.
- `diagnostics`: timetable, transit availability, and surface diagnostics.

Cutoffs accept 5–240 minutes; extent accepts 1–40 km; grid sizes are 48, 64, 96,
128, 192, 256, 384, 512, and 1024. The requested extent bounds the comparison
grid; it does not truncate the routing search. `--walk-speed` controls Reach
walking speed. More cells and street output increase result size.

For GIS tools, extract `fullAreas` (or the fixed-grid `areas`) into a GeoJSON
file. Polygons follow reachable raster cells at the chosen resolution. Isolines
can be empty on sparse street rasters; areas and streets retain that reachability.
For example, with jq installed separately:

```sh
jq '.fullAreas // .areas' reach-result.json > isochrones.geojson
```

Supply a `scenario` in a second Reach request to add, replace, or exclude
scheduled service. For example, remove a real GTFS route by its exact ID:

```json
{"origin":"A","cutoffsMinutes":[15,30,45,60],"extentRadiusKm":8,"rasterSize":96,"scenario":{"excludedRouteIds":["ROUTE_ID"]}}
```

Run that request with the same date, time, origin, extent, and grid, saving
`after.json`, then compare it with the baseline:

```sh
vigo compare --before reach-result.json --after after.json --output change.json
```

Compare uses the fixed grid and requires matching bounds and dimensions. Full
network envelopes can differ between scenarios. Planned service changes retain
the engine's add/replace, branch/edge, preserved-trip, and frequency semantics.
The complete request reference is in the
[VIGO Scenario documentation](https://github.com/hytangs/vigo/blob/main/docs/reference/scenarios.md).

Reach supports scheduled transit with walking access and egress, at a fixed
departure. Walk-only, drive, arrive-by, realtime, and traffic Reach are not
implemented. Planned transit scenarios apply to Reach, not Route or Matrix.
Packaging does not change these engine limits. Reach describes modeled travel
time, not access to people/jobs or observed real-world accessibility.

## Keep the engine resident

Use `stream` for repeated queries without reopening the City for every request.
Save `queries.ndjson`, one JSON object per line:

```jsonl
{"id":"journey","kind":"route","origin":"A","destination":"B","time":"08:00"}
{"id":"times","kind":"matrix","origins":["A"],"destinations":["B"],"time":480}
{"id":"area","kind":"reach","origin":"A","timeMinutes":480,"cutoffsMinutes":[15,30],"rasterSize":96,"includeStreetEdges":true}
```

```sh
vigo stream --city ./city --service-date YYYY-MM-DD \
  < queries.ndjson > results.ndjson
```

One process owns one City and service date. Each line requires `kind` and may
override query options using JSON fields such as `mode`, `timePreference`,
`maxWalkKm`, `maxTransfers`, `horizonMinutes`, or `departureWindowMinutes`.
`time` accepts `HH:MM` or integral service-day minutes; `timeMinutes` accepts
integral minutes. A different `serviceDate` or inconsistent `serviceDay` is
rejected. Start another process for another City/date.

Responses preserve input order and carry `id` and `sequence`. Blank lines are
ignored. A bad line returns `status: "error"` and later lines still run. Read
every response status: request errors do not turn a completed stream into a
nonzero process exit. Prepared modes are reused; `timing.openMs` is zero after
preparation. This measures preparation reuse, not total request time. Closing
stdin ends the process; interrupting it cancels the session.

## Output and limits

Single queries print JSON to stdout; `--output` also saves it. `--request -`
reads one JSON object from stdin (16 MiB limit). Diagnostics and build progress
go to stderr. A valid `blocked` result exits 0; invalid command input or an
execution failure exits 2. CSV batches write rows to the output file and print
a JSON summary. Retain City identity, request, warnings, and timings with
results. `capabilities` declares the current feature combinations.

## Build and verify from source

From a VIGO source checkout with npm dependencies and the pinned Rust toolchain:

```sh
npm run package:cli
npm run check:cli-package
```

`build:cli-runtime` builds only the native kernel and minified command.
`package:cli` rebuilds both and writes
`release/cli/VIGO-CLI-VERSION-PLATFORM-ARCH.zip`, its SHA-256 file, and
`release/cli/runtime-PLATFORM-ARCH`. Set `VIGO_CLI_RELEASE_DIR` to use another
output directory. `manifest.json` records payload hashes, platform, Rust target,
source commit, and source dirty state. A dirty build is a development artifact.

`check:cli-package` extracts the ZIP outside the checkout, verifies its exact
file list and hashes, checks capability equality, and runs the canonical CLI
contracts against the copied runtime with an empty PATH and NODE_PATH. The
check covers building Cities, modes, realtime, Matrix, Reach scenarios and
streets, comparisons, CSV, and resident streaming. `VIGO_CLI_TEST_NODE` selects
an alternative Node executable for this check. Source test dependencies are
used only by the test driver; runtime commands have no external npm dependency.
