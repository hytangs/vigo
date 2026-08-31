# VIGO resident routing CLI

New command-line users should start with the
[task-based CLI tutorials](tutorials/cli/README.md). This page is the process
and schema reference used after the first workflow is working.

VIGO exposes one public command-line routing interface. The desktop app and
packaged CLI use the same resident active-service routing kernel compiled from
a persisted SQLite project store.
The exact algorithm used for each result is reported from the plan diagnostics;
the CLI does not replace it with a generic engine label. Routing subcommands
accept persisted VIGO SQLite stores, not an in-memory table set or a
project-scale JSON network. The separate `build-network` subcommand compiles
one or more GTFS ZIPs and one OSM PBF through the same production importers
used by the desktop app.

Every routing command requires `--service-date=YYYY-MM-DD`. VIGO does not
silently substitute today, a representative weekday, or an arbitrary feed
snapshot, because those choices can change both the itinerary and the active
service slice.

## Use a real path before copying commands

The string `/absolute/path/to/file` is documentation shorthand for a path on
your own computer. On macOS, the source checkout used by the tutorials is
`$HOME/Documents/vigo`, while generated data can live under
`$HOME/Documents/vigo-data`. For example, a compiled store is
`$HOME/Documents/vigo-data/network/routing/project.sqlite`. Do not paste
`/absolute/path/to/...` literally. Start with [CLI Document 0](tutorials/cli/00-setup-and-build.md)
for source intake, valid service-date selection, and runtime setup.

After Document 0, these variables point at the same compiled network:

```bash
export VIGO_HOME="${VIGO_HOME:-$HOME/Documents/vigo}"
export VIGO_DATA_HOME="${VIGO_DATA_HOME:-$HOME/Documents/vigo-data}"
export VIGO_STORE="$VIGO_DATA_HOME/network/routing/project.sqlite"
export VIGO_STREET_STORE="$VIGO_DATA_HOME/network/osm/street-index.sqlite"
export VIGO_SERVICE_DATE="${VIGO_SERVICE_DATE:?export an exact date covered by this GTFS feed}"
export VIGO_SERVICE_DAY="${VIGO_SERVICE_DAY:?export the matching service-day class}"
export VIGO_REPO="$VIGO_HOME"
export VIGO_NODE="$(command -v node)"
export VIGO_CLI="$VIGO_REPO/dist-cli/vigo.mjs"
test -x "$VIGO_CLI"
vigo() { "$VIGO_NODE" "$VIGO_CLI" "$@"; }
```

The repository does not ship a fixed `service-date.env`: a committed date can
silently become invalid as a feed changes. Set the exact date and matching
service-day class for the active GTFS feed, or source an equivalent file from
your private data directory.

## Build a network from GTFS and OSM

`build-network` is the raw-data compilation boundary. It writes inspectable
SQLite inputs and does not introduce a CLI-specific route algorithm.

```bash
vigo build-network \
  --osm-pbf="$VIGO_DATA_HOME/input/network.osm.pbf" \
  --gtfs="$VIGO_DATA_HOME/input/network.gtfs.zip" \
  --output-dir="$VIGO_DATA_HOME/network"
```

The output directory contains `routing/project.sqlite`,
`osm/street-index.sqlite`, and `network.json`. The manifest records raw source
fingerprints, store identities, and GTFS-build, merge, OSM-build, and total
wall times. Repeated GTFS inputs are merged with unique feed scopes. Pass a
matching repeated `--gtfs-scope` when file stems are not unique. Existing
compiled outputs are never replaced unless `--force` is explicit.

## Prepare a store

`prepare` applies the same production readiness operation used by desktop
imports: it validates the strict SQLite contracts, builds every directed
OSM-certified stop transfer with no production neighbor cap, refreshes
fingerprint-bound derived artifacts, and loads the selected service-date
kernel.

```bash
vigo prepare \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY"
```

This is an explicit preprocessing command, not a query fallback. `route` and
`route-ndjson`, `one-to-many`, and `isochrone` enforce the same readiness
contract automatically, so a store cannot produce different transfers merely
because it was opened through the CLI rather than the desktop.

## Route one origin to many destinations

`one-to-many` calls the canonical `vigo.routing.matrix.v1` operator with one
origin. Its default `shared` strategy performs one resident Rust forward scan;
it does not loop over point-routing calls. Put labeled endpoints in a
JSON request:

```json
{
  "origin": "place-pktrm",
  "destinations": [
    {"id": "downtown-crossing", "point": "place-dwnxg"},
    {"id": "harvard-square", "point": {"coordinate": [-71.1189, 42.3736]}}
  ]
}
```

Then run:

```bash
vigo one-to-many \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --request="$VIGO_DATA_HOME/input/one-to-many.json" \
  --time=08:00 \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --matrix-strategy=shared \
  --horizon=120
```

The output schema is `vigo.cli.one-to-many.v1`. Each row retains the supplied
destination ID, status, departure, arrival, and duration. Diagnostics identify
the actual matrix strategy, forward-search count, resident kernel, and native
query time. Arrive-by sharing is not silently simulated; this operator accepts
fixed departures only.

## Generate an isochrone

`isochrone` calls the unified Rust accessibility-range timetable operator, then
the Rust directed-OSM surface kernel. JavaScript only validates the request and
materializes contour lines from the returned raster.

```json
{
  "origin": {"coordinate": [-71.0636, 42.3551]},
  "cutoffsMinutes": [15, 30, 45, 60],
  "radiusKm": 8,
  "rasterSize": 96
}
```

```bash
vigo isochrone \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --request="$VIGO_DATA_HOME/input/isochrone.json" \
  --time=08:00 \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2 \
  --walk-speed=4.8
```

The `vigo.cli.isochrone.v1` result contains reached timetable stops, the full
`vigo.street.network-raster.v1` values, GeoJSON `MultiLineString` contours, and
separate preparation, timetable, surface, contour, and process timings. It is
a walk-transit-walk travel-time surface, not an opportunity-weighted score or
a stochastic departure profile.

## Build the CLI from the fetched checkout

The supported first-time path is the source checkout used by the tutorials.
Start with [CLI Document 0](tutorials/cli/00-setup-and-build.md), which clones
or fetches `https://github.com/hytangs/vigo.git`, refuses to overwrite a
dirty checkout, builds the Rust kernel, and writes the source CLI environment.
For an existing clean checkout, the essential build commands are:

```bash
cd "$VIGO_REPO"
npm ci
npm run build:rust-routing-kernel
npm run build:cli
export VIGO_NODE="$(command -v node)"
export VIGO_CLI="$VIGO_REPO/dist-cli/vigo.mjs"
"$VIGO_NODE" "$VIGO_CLI" --help
```

`vigo.mjs` is a command-line entry point, not a stable importable JavaScript
library. A Node.js application should invoke it as a child process. Importing
internal files under `server/` is unsupported because those module boundaries
may change between source revisions.

If a verified release artifact is available, it is an optional distribution
of this same interface; it is not required for the tutorials or source build.
The source checkout remains the reproducible starting point.

## Route a batch

The OD input is a CSV file. An endpoint may be a GTFS stop ID:

```csv
id,origin_stop_id,destination_stop_id
south-harvard,70079,70068
```

or a longitude-latitude coordinate:

```csv
id,origin_lon,origin_lat,destination_lon,destination_lat
coordinate-example,-71.0551,42.3523,-71.1189,42.3734
```

Run the batch against a VIGO routing store. An OSM street store is optional
only when both endpoints are exact stop IDs. If either endpoint is a
coordinate, the CLI requires the street store for network-accurate access and
egress:

```bash
vigo route \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --od="$VIGO_DATA_HOME/input/coordinate-ods.csv" \
  --out="$VIGO_DATA_HOME/output/routes.csv" \
  --json-out="$VIGO_DATA_HOME/output/routes.json" \
  --time=08:00 \
  --time-preference=depart \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2
```

The start and end walks in a coordinate route follow the directed OSM street
store. They are not straight-line estimates.

`vigo.mjs` can also be run directly through the source checkout's Node.js:

```bash
"$VIGO_NODE" "$VIGO_CLI" --help
```

The CSV output contains one summary row per input ID. `--json-out` writes the
full `vigo.cli.route-results.v1` result, including itinerary legs, geometry,
route and trip identity, diagnostics, and blocked reasons. Standard output is
a separate `vigo.cli.route.v2` execution summary.

### Production-scale batch recipe

Use one process for all ODs sharing a service date. Do not launch one Node
process per CSV row:

```bash
export NODE_OPTIONS=--max-old-space-size=12288
export VIGO_RUN_DIR="$VIGO_DATA_HOME/output/production-run"
mkdir -p "$VIGO_RUN_DIR"

/usr/bin/time -l "${VIGO_COMMAND[@]}" route \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --od="$VIGO_DATA_HOME/input/coordinate-ods.csv" \
  --out="$VIGO_RUN_DIR/route-summary.csv" \
  --json-out="$VIGO_RUN_DIR/route-detail.json" \
  --time=07:30 \
  --time-preference=depart \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.6 \
  > "$VIGO_RUN_DIR/execution-summary.json"
```

The input order is preserved. Blocked and failed ODs receive output rows; they
are never silently omitted. Keep the execution summary, `/usr/bin/time -l`
resource output, input CSV, and store identities with the result.

The batch command deduplicates identical routing keys and copies the first
result, including its route-time field, to duplicate rows. Duplicate rows are
therefore repeated logical requests, not independent latency samples. Use
unique OD/time/policy keys, or the formal harness, for timing distributions.

For a stream whose departure time changes by row, keep one resident context:

```bash
"${VIGO_COMMAND[@]}" route-ndjson \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  < "$VIGO_DATA_HOME/input/requests.ndjson" \
  > "$VIGO_DATA_HOME/output/results.ndjson"
```

One NDJSON request:

```json
{"id":"sample-0001","origin":{"coordinate":[-71.0603,42.3571]},"destination":{"stopId":"DESTINATION_STOP_ID"},"time":"07:42","maxWalkKm":1.6}
```

Run independent service dates in separate processes. Parallel service-date
workers duplicate resident timetable and street contexts, so choose worker
count from measured resident memory instead of CPU count alone. For a
reproducible batch, retain the source identities, request file, preparation
receipt, and per-request output described in the [CLI tutorials](tutorials/cli/README.md).

## Call the CLI from JavaScript

Use `execFile` or `spawn` with an argument array. Do not construct a shell
command from user input.

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const home = process.env.HOME
const vigoHome = process.env.VIGO_HOME || `${home}/Documents/vigo`
const vigoDataHome = process.env.VIGO_DATA_HOME || `${home}/Documents/vigo-data`
const repo = process.env.VIGO_REPO || vigoHome
const node = process.env.VIGO_NODE || process.execPath
const cli = process.env.VIGO_CLI || `${repo}/dist-cli/vigo.mjs`
const { stdout } = await run(node, [cli,
  'route',
  `--store=${vigoDataHome}/network/routing/project.sqlite`,
  `--street-store=${vigoDataHome}/network/osm/street-index.sqlite`,
  `--od=${vigoDataHome}/input/coordinate-ods.csv`,
  `--out=${vigoDataHome}/output/routes.csv`,
  `--json-out=${vigoDataHome}/output/routes.json`,
  '--time=08:00',
  `--service-date=${process.env.VIGO_SERVICE_DATE}`,
  `--service-day=${process.env.VIGO_SERVICE_DAY}`,
])

const summary = JSON.parse(stdout)
```

For a different source checkout or data environment, set `VIGO_HOME` or
`VIGO_DATA_HOME` (and, if needed, `VIGO_REPO`, `VIGO_NODE`, or `VIGO_CLI`)
before running the script. The argument array keeps paths and user input out of
a shell command.

## Timing model

Each CLI process reports separate preparation and routing regions:

- `preparation.elapsedMs` covers opening the stores and preparing the active
  service and optional street context.
- `elapsedMs` covers the OD routing loop and result materialization.

Process startup and JSON/CSV serialization remain outside those two fields.
Put multiple ODs in one input CSV to pay process startup and preparation once
per CLI batch. Interactive applications can use the resident `route-ndjson`
contract to reuse a prepared process across multiple requests for the same
service date and day.

For an interactive Node.js process, `route-ndjson` keeps the prepared routing
context alive and returns one result line for each request line:

```bash
"${VIGO_COMMAND[@]}" route-ndjson \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" <<'EOF'
{"id":"short","origin":"place-pktrm","destination":"place-dwnxg","time":"08:00"}
{"id":"coordinates","origin":{"coordinate":[-71.0636,42.3551]},"destination":{"coordinate":[-71.1189,42.3736]},"timeMinutes":485}
EOF
```

Each response uses `vigo.cli.route-result.v1` and includes the full plan,
actual algorithm and method diagnostics, route wall time, core engine time, and
`timing.serializationMs` for the response JSON.
Malformed lines produce an error response for that line without terminating
the session. Service date and day are fixed for the process; time, preference,
walking budget, and departure-window profile may vary per request.

The batch summary separates:

- `preparation.elapsedMs`: store opening and reusable routing/street context;
- `timing.routingMs`: routing and plan materialization;
- `timing.outputMs`: CSV/JSON serialization (`route`) or summed response JSON
  serialization for a resident stream;
- `timing.processToSummaryMs`: CLI work after module loading through summary.

## Timing boundary

The CLI reports preparation, routing, materialization, serialization, and
process timing separately. A resident NDJSON process amortizes startup and
preparation across requests; it does not change the routing semantics. Retain
the source identities, service date, request policy, and returned diagnostics
with any timing observation.

## External binding boundary

Language bindings are separate distributions. They may invoke `build-network`,
`route`, `route-ndjson`, `one-to-many`, or `isochrone`, but must validate the
versioned response schemas and must not reimplement GTFS parsing, timetable
search, street search, or accessibility algorithms. A binding should install or
discover a checksum-verified VIGO runtime and test it from an empty working
directory. VIGO core verifies the CLI and standalone runtime; each binding owns
its language-specific API and packaging checks.
