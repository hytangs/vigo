# VIGO Rust standalone manual

VIGO 1.0.0-rc.1 · CLI and HTTP reference · Prepared City format 1

VIGO runs routing and isochrone queries from a single Rust executable. The executable contains the routing kernels, City loader, JSON interface, and HTTP server. It needs no Node, Python, browser, external routing service, or internet connection at query time. SQLite is compiled in. City data is supplied separately and opened read-only.

This manual describes the **standalone Rust interface**. Requests retain `vigo.standalone.query.v1`; public results share `vigo.route.v1`, `vigo.matrix.v1`, and `vigo.reach.v1` with the Node CLI. Studio and the private Python worker protocol remain separate. Run `vigo capabilities` to identify the executable before integrating it.

- **[Command line](#4-cli-command-reference)** Commands, flags, files, and standard input.
- **[Requests and fields](#5-points-clocks-units-and-common-fields)** Points, clocks, units, and the fields every query shares.
- **[Route](#6-route)** Journeys, alternatives, via points, and departure windows.
- **[Matrix](#8-matrix)** Travel times for many origins and destinations in one request.
- **[Reach](#9-reach-and-isochrones)** Rasters, polygons, contours, and street evidence.
- **[HTTP API](#15-http-api-and-server-operation)** Endpoints, limits, status codes, and authentication.
- **[Output and errors](#13-public-results-and-diagnostics)** Public results, trace output, and diagnostics.
- **[Native operations](#18-native-operation-reference)** Packed-array kernel calls and their field reference.

This manual is also part of the searchable, offline [VIGO guide](../guide.html), which the engine serves at `/`. The [OpenAPI specification](../standalone-openapi.json) contains the HTTP request contracts and native input/output types. The [audit record](../reference/rust-standalone-audit.md) describes tested coverage and remaining boundaries.

## Shared scenario collections

A collection serves several transit scenarios against one immutable street graph. Prepare it with `node public/vigo.mjs build-scenarios --spec scenarios.source.json --output scenario-set`, then point `vigo serve --city scenario-set` or `vigo stream --city scenario-set` at the result. Each request selects a `scenarioId`; omission selects `defaultScenario`. The one-shot CLI also accepts `--scenario ID`.

For populations authorized to enter their own homes and destinations on mapped private roads, set `"privateAccess": "endpoints"` in the scenario source specification. Every member then receives an endpoint-only access overlay; private streets cannot become public through shortcuts. Endpoint overlays use each member's transit anchors, so these collections currently retain separate street directories. The default `"public"` policy keeps the shared street directory. This does not enlarge coordinate snapping or invent paths for unmapped endpoints. Wheelchair collections require public access.

For wheelchair routing, add `"wheelchair": true` to the source specification or pass `build-scenarios --wheelchair`. Every member and the shared street graph then use `wheelchair-strict-v1`; unknown accessibility is excluded. Wheelchair collections require `streetModes: "walk"`. Conflicting CLI/spec values and non-boolean specification values are rejected before compilation. Use a separate regular collection when both profiles are needed.

```json
{
  "schemaVersion": "vigo.scenarios.source.v1",
  "name": "Regional alternatives",
  "osm": { "path": "region.osm.pbf" },
  "streetModes": "walk",
  "prepareDates": ["2026-10-05"],
  "defaultScenario": "baseline",
  "maximumResidentScenarios": 2,
  "scenarios": [
    { "id": "baseline", "name": "Baseline", "feeds": [{ "path": "baseline.zip", "scope": "agency" }] },
    { "id": "proposal", "name": "Proposal", "feeds": [{ "path": "proposal.zip", "scope": "agency" }] }
  ]
}
```

Source paths are relative to the manifest. Optional `sha256` values pin each input. The compiler prepares street data once and creates relative references to it. Move the collection as one directory. Its checksum inventory records physical files once. `prepareDates` precompiles up to 32 service dates, reusing identical service sets; other dates remain queryable through the source timetable. A single-City build accepts repeated `--prepare-date` options.

## Runtime memory and caching

A resident `stream` or `serve` process keeps its City, timetable, and street indexes ready between requests. This chapter describes what it shares, what it retains, and how to account for memory.

### Shared data across scenarios

Resident Cities share immutable street arrays and CCH indexes by canonical path. Timetable source columns share equal immutable blocks across resident scenarios. A hash selects candidates, and every reuse checks all values; changes occupy independent blocks without an overlay chain. The collection holds weak references to shared blocks, so evicting their last timetable view releases the data. Stop and trip identities, search indexes, endpoint caches and realtime state remain scenario-specific. The collection still stores separate transit databases and prepared access profiles.

### Timetable preparation and retention

Scheduled timetables retain a service-clock prefix through at least 06:00 the next day. Longer requests extend that prefix in six-hour blocks; narrower requests reuse it. Future days are read only through the loaded departure bound. Realtime uses the unfiltered source so an update can move a later trip into the query window. That source read is retained (up to two service-day windows), so a new snapshot derives its view from memory instead of reading the City database again; trip, stop and transfer inputs are shared rather than rebuilt. `GET /v1/info` reports `timetablePreparations` and `timetableCoverageEndSeconds` for each resident scenario.

Cold startup opens the City and prepares the first requested service date. Timetable preparation reads trip-sized groups and restores the canonical date order in native arrays; it does not require a new City format or extra disk index. Keep `stream` or `serve` resident to reuse this work across requests.

Each standalone City also retains up to eight inactive scheduled timetables, with a default 128 MiB budget set by `VIGO_TIMETABLE_CACHE_BYTES`. Returning to a retained date and transfer policy reuses its prepared arrays and indexes. Entries use exact dates and sufficient time coverage, preserving calendar exceptions, overnight service and timezone offsets. Least recently used entries are evicted, and oversized entries are not retained. The latest two realtime views are also retained, so alternating scheduled and realtime queries do not rebuild them; a realtime view only uses space no scheduled timetable or retained source needs, because it rebuilds from its source in a fraction of a source read. Set the budget to `0` to disable date retention. This is an additional budget, separate from the active timetable, street data and preparation temporaries. A standalone City receives the full budget. In a scenario collection, retained entries keep their byte allocation and the selected scenario can borrow unused capacity from the collection budget. This avoids a fixed per-scenario share; it does not evict another resident's retained dates to make room. Separate workers each have their own budget. Shared blocks are charged in full for cache admission. `memory.timetableCache` reports entries, charged `retainedBytes`, `budgetBytes`, hits and evictions. Collection residency reports aggregate `inactiveTimetableBudgetBytes` and `inactiveTimetableRetainedBytes`. Retained-date activation does not trigger Linux preparation-memory trimming unless retention evicts another timetable. Matrix and Reach still reclaim their temporary allocations after completion. The owner-level memory ledger includes inactive timetables and counts shared blocks once. Calendar rules load once per City as weekday masks plus dated exceptions. Standalone Cities also share equal immutable source-column blocks across retained dates; date-specific scan indexes remain separate. The first-date layout stays contiguous until another date is retained. `memory.calendarIndexBytes` and `memory.timetableSharedColumns` expose the index and shared storage.

### Query workspaces and residency

One timetable query workspace belongs to the sequential worker and is lent to the selected scenario. Boarding layers, predecessors and generation tags are rebound to its stop and run dimensions; results never cross scenarios. Reusable street-search buffers move with the active request. Exact street attachments for Reach are shared only after scenario-specific station exits are resolved, with a limit of 16,384 coordinates per street graph.

The least recently used City is evicted before opening another when `maximumResidentScenarios` is reached, retaining the street graph even with a one-City budget. `VIGO_MAX_RESIDENT_SCENARIOS` overrides this count from 1 to 16; this bounds resident scenarios. `VIGO_RESIDENT_HEAP_BYTES` additionally bounds collection retention using tracked heap ownership (default: the smaller of 1 GiB and one third of the detected memory capacity). Least-recently-used Cities leave before an estimated replacement allocation and after queries when measured retained heap exceeds the budget. The selected City is always retained; `residentHeapOverBudget` reports when that City alone exceeds the budget. This is not an RSS limit: mapped pages, allocator overhead and temporary preparation allocations require additional capacity. `residency.lastQueryTiming` separates scenario selection, City opening, execution and post-query retention; eviction time is a subphase of selection/retention, not an extra additive duration. Profile/trace queries separately report timetable activation and preparation inside execution. `GET /v1/info` reports current residency, unique timetable block bytes, column-view bytes and query-workspace bytes without opening every scenario. Timetable `sourceArrayBytes` measures logical column contents, including shared values; do not sum it as exclusive memory.

### Memory ledger

The collection's `memory` ledger separates network allocations, query workspaces, caches, SQLite allocations and mapped file lengths. Its `trackedHeapBytes` counts shared street and timetable owners once. Each City's `memory.ledger` provides the component breakdown. Vector capacities are counted; hash-table and JSON-container overheads are estimates. Mapped file lengths are not resident memory. Record process-tree PSS/anonymous memory and cgroup file cache alongside the ledger; active-query temporaries, serialized responses and the application UI have separate lifetimes.

Set `VIGO_MEMORY_ACCOUNTING=1` for a diagnostic run to include the last query's raw/public result-tree capacities and their overlap. This walks result objects and is disabled by default; use a separate run for latency measurements.

Node routing workers in one process share admitted immutable street snapshots and CCH files, while keeping mutable query state separate. Admission uses canonical paths and file identities. Weak references release retired networks; replacing a prepared file gives new readers a new owner. Prepared files must remain immutable while mapped. Studio GTFS/OSM import and merge run in disposable child processes. Completion reaches the serving process only after the compiler exits, so compiler allocator arenas cannot remain in the server. Preparation job records retain the compiler process count, largest process RSS peak and last process exit snapshot.

The Node driving kernel retains typed views of its immutable integer road arrays; callers must not mutate them while the kernel exists. The standalone constructor moves owned arrays. Traffic updates use separate mutable weights and leave the base graph intact. `sourceArrayBytes` is logical array storage, shared with JavaScript when `zeroCopyArrays` is true, and must not be added twice.

### Caches and responses

The HTTP supervisor forwards the worker's validated JSON bytes without constructing another journey or raster object tree. The 64 MiB response limit still applies. `Server-Timing`'s `serialize` entry measures supervisor serialization; forwarded results report zero there, and serialization in the query worker remains part of end-to-end HTTP time.

The endpoint and shape cache byte budgets apply to the whole collection: each resident receives a share of the configured budget. The defaults allow 64 MiB for each endpoint role and 64 MiB for shape geometry across all residents. Set `VIGO_ENDPOINT_CACHE_MAX_BYTES` and `VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES` to change those totals. Street search and isochrone lookup pages are allocated only where a query writes. Path scratch above 32 MiB and each dynamic CCH workspace above 64 MiB are discarded before the next query; the inverse street order is retained separately. Access-profile format 6 uses bitmap ranks and offsets for nonempty buckets, and requires rebuilding earlier prepared profiles. On Linux with glibc, freed temporary pages are returned after timetable preparation, Matrix, and Reach. Measure the working set for your region and workload; timetable data and mapped street pages remain outside the result-cache budgets.

## 1. Quickstart

Start in **Boston**: route from **Harvard Square in Cambridge to South Station in Boston**, then ask when to leave to arrive by 09:00. A “City” is simply the prepared data directory that VIGO opens; here it is `./boston`.

You need a matching [Rust executable](#2-installation-and-build) and the Boston directory. If you have only downloaded the executable, follow [the Boston data instructions](#3-prepare-and-manage-city-data) first: they give the MBTA timetable and OpenStreetMap download links and the exact build commands. Raw ZIP/PBF files are inputs to the separate compiler, not to `./vigo route`.

Run the following from a working directory containing the executable and `boston/`. On Windows use `vigo.exe`.

```sh
./vigo --version
./vigo capabilities --pretty
./vigo info --city ./boston --pretty
```

### Harvard Square to South Station

Save `route.json`. Coordinates are **[longitude, latitude]**. The service date below is Monday **2026-10-05**, covered by the MBTA feed used to check this tutorial. For a newer download, choose a date inside its calendar coverage; see the feed inspection step below. These are scheduled journeys, without live delays.

```json tutorial=route
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "maxWalkKm": 1.2,
  "maxTransfers": 3,
  "requireTransitRide": true
}
```

```sh
./vigo route --city ./boston --request route.json --pretty
./vigo route --city ./boston --request route.json --time 09:00 --arrive-by --pretty
```

The second command overrides the departure time with a 09:00 arrival deadline. Read `status` first: `ok` contains `journey`; `not_found` is a valid no-journey result. `journey.departureTime` and `arrivalTime` are service-day clocks. Durations use integer seconds. Read `journey.legs` and any route-specific warnings. Timetables and street data change; do not expect a permanently fixed trip ID or travel time.

### Several origins and destinations

Save `matrix.json`. The rows are Harvard Square and Kendall Square; the columns are South Station and Copley Square. This requests all four pairs with their journeys:

```json tutorial=matrix
{
  "origins": [
    {"coordinate": [-71.11902, 42.37334]},
    {"coordinate": [-71.08618, 42.36249]}
  ],
  "destinations": [
    {"coordinate": [-71.05524, 42.35227]},
    {"coordinate": [-71.07758, 42.34997]}
  ],
  "serviceDate": "2026-10-05",
  "time": "09:00",
  "timePreference": "arrive_by",
  "maxWalkKm": 1.2,
  "maxTransfers": 3,
  "includeJourneys": true
}
```

```sh
./vigo matrix --city ./boston --request matrix.json --output matrix-result.json
```

`durationsSeconds[row][column]` follows the input order; `null` means no journey. For arrive-by matrices, duration is the arrival deadline minus latest departure; a journey can arrive before the deadline. Full journey detail is the default. For large analytical batches, `journeyFormat: "compact"` retains timed trip/stop witnesses with less display metadata; `includeJourneys: false` requests times only. Neither setting changes the routing search. Repeated rows or columns are shared internally, but every requested cell is returned. Compare full point responses and equivalent Matrix formats when timing the Node and Rust interfaces; full Rust matrices carry more metadata than Node's compact witnesses.

### Keep Boston loaded for repeated requests

For a one-off answer, use `route`. For a school, accessibility study, or web application, keep Boston resident and send Route, Matrix, and Reach requests through the same process. Starting a new process for each route repeats City loading. For an application, use `stream` or `serve` and keep that process running. Save `queries.ndjson`, one object per line:

```jsonl tutorial=stream
{"id":"harvard-south-depart","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"serviceDate":"2026-10-05","time":"08:00","maxWalkKm":1.2,"maxTransfers":3}
{"id":"harvard-south-arrive","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"serviceDate":"2026-10-05","time":"09:00","timePreference":"arrive_by","maxWalkKm":1.2,"maxTransfers":3}
```

```sh
./vigo stream --city ./boston < queries.ndjson > results.ndjson
./vigo serve --city ./boston --port 8080
```

The service stays in the foreground. In a second terminal in the same directory:

```sh
curl --fail-with-body http://127.0.0.1:8080/readyz
curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H 'Content-Type: application/json' --data-binary @route.json
```

The default listener is `127.0.0.1:8080`. Open `http://127.0.0.1:8080/` to read the VIGO guide from the running service and send requests from its API console. For production settings, see [Deployment](#16-authentication-and-generic-deployment). Separate network-build time, fresh-process time to first answer, and resident request latency when measuring performance.

## 2. Installation and build

VIGO runs as one executable. Choose a package for your operating system and CPU, extract it, and point it at a prepared City.

### Use a package

From the extracted directory, check the executable and inspect its supported operations:

```sh platform=unix
./vigo --version
./vigo capabilities --pretty
```

```powershell platform=windows
.\vigo.exe --version
.\vigo.exe capabilities --pretty
```

The runtime includes SQLite and the routing kernels. A compiler, Node, and Python are not needed to run queries. City data is supplied separately; see [City data](#3-prepare-and-manage-city-data), then continue with the [quickstart](#1-quickstart).

The published Linux x64 and ARM64 executables are built on Ubuntu 24.04 and require glibc 2.39 or later. Use Ubuntu 24.04 for their container runtime as well. For an older Linux distribution, build from source on that distribution; copying a published executable into a Debian 12 image will fail before startup.

### Build from source

To build from this source checkout, install the pinned Rust toolchain in `rust-toolchain.toml` and a C toolchain for bundled SQLite. From the repository root:

```sh
cargo build --locked --release \
  --manifest-path crates/vigo-runtime/Cargo.toml \
  --no-default-features --features standalone --bin vigo

./target/release/vigo --version
python3 scripts/package-standalone.py
```

Keep `--no-default-features --features standalone` to select the standalone executable. The default Cargo configuration builds the Node integration. Python is used by the packaging script.

For a different target, add `--target RUST-TARGET-TRIPLE` and provide its Rust standard library, linker, and C toolchain. City directories can be shared between compatible builds; the executable must match the destination operating system and CPU.

### Package contents

The packaging script writes an archive to `release/rust`. It includes the executable, Markdown and HTML documentation, OpenAPI specification, test record, licenses, and `manifest.json`. The adjacent `.sha256` file records the archive checksum.

The manifest identifies the build and hashes each file. Previous packages are saved under `.previous`. Platform test results and build provenance are described in [Compatibility](#20-validation-and-compatibility).

## 3. Prepare and manage City data

A City is a compiled network containing the transit timetable, street graph, and access data. Build it once with the VIGO compiler, then copy the complete directory to the machine running the Rust executable.

### Download Boston's timetable and streets

You need two different inputs:

| Input | Where to get it | What VIGO uses it for |
| --- | --- | --- |
| MBTA **static GTFS ZIP** | [MBTA's official GTFS documentation](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md), [direct ZIP](https://cdn.mbta.com/MBTA_GTFS.zip) | Stops, trips, service calendars, transfer rules, and route shapes |
| Massachusetts **OpenStreetMap `.osm.pbf`** | [Geofabrik Massachusetts downloads](https://download.geofabrik.de/north-america/us/massachusetts.html), [direct PBF](https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf) | Street paths for walking access, egress, transfers, and direct street routing |

Use the static GTFS ZIP, not the GTFS-realtime protobuf. Use the OSM PBF, not the shapefile or GeoPackage. No MBTA API key is needed for these public file downloads. Preserve the source files and acquisition date for reproducibility; the `latest` URLs can change.

In a new working directory, using `curl`, `unzip`, and [Osmium Tool](https://osmcode.org/osmium-tool/manual.html):

```sh
mkdir -p data
curl --fail --location --retry 3 --output data/MBTA_GTFS.zip \
  https://cdn.mbta.com/MBTA_GTFS.zip
curl --fail --location --retry 3 --output data/massachusetts-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf
unzip -p data/MBTA_GTFS.zip feed_info.txt
unzip -p data/MBTA_GTFS.zip calendar.txt
unzip -p data/MBTA_GTFS.zip calendar_dates.txt
```

`feed_start_date` and `feed_end_date` give the published feed interval. Check the weekday calendars and dated exceptions too: being inside that interval does not make every route run every day. The feed used for this tutorial spans **2026-09-25 through 2026-12-12**; its example date is **2026-10-05**, in `America/New_York` local service time.

For a smaller first build, extract central Boston, Cambridge, and nearby streets. Osmium's [complete-ways strategy](https://docs.osmcode.org/osmium/latest/osmium-extract.html) retains the nodes needed by ways crossing the boundary:

```sh
osmium extract --bbox=-71.20,42.25,-70.95,42.45 --strategy=complete_ways \
  data/massachusetts-latest.osm.pbf --output=data/boston.osm.pbf
```

This rectangle supports the tutorial's four places; it is **not full MBTA street coverage**. For broader trips, use a larger extract covering every access, egress, and transfer location. You can skip Osmium and build with the full Massachusetts PBF instead; that is a larger preparation job and still does not cover the Rhode Island portion of MBTA service. Retain the source providers' required notices when distributing data; see [OpenStreetMap attribution](https://www.openstreetmap.org/copyright).

### Compile Boston once

Use the **Node CLI compiler**, which imports raw data. The standalone Rust executable currently opens prepared data only. With an extracted CLI package, keep `vigo.mjs` and `vigo-routing-kernel.node` together and define:

```sh
alias vigo-build='node "/absolute/path/to/cli-package/vigo.mjs"'
vigo-build build --gtfs ./data/MBTA_GTFS.zip \
  --osm ./data/boston.osm.pbf --output ./boston
vigo-build inspect --city ./boston
```

Alternatively, build the compiler from a source checkout with Node 24.18+, npm, and the pinned Rust toolchain:

```sh
npm ci
npm run build:rust-routing-kernel
npm run build:cli
```

Then set `vigo-build` to `node "/absolute/path/to/vigo/public/vigo.mjs"` and run the same build from your Boston working directory. This avoids compiling Studio. Raw import and street preparation happen at build time; they are separate from query latency. Service timetables depend on the date and routing policy. Before distributing a City for repeated fresh-process use, prepare each service date you intend to use by running the compiler CLI once with the `route.json` from the quickstart:

```sh
vigo-build route --city ./boston --service-date 2026-10-05 \
  --time 08:00 --request route.json > preparation-check.json
```

Choose a date covered by your downloaded feed. Copy the complete City after this step. Rust reports `timing.timetableSource: "prepared_snapshot"` when it can reuse the matching timetable; otherwise it prepares from SQLite for that process and reports `"source"`. Both paths use the same source schedule. A resident `stream` or `serve` process retains its active timetable. Compare startup only with identical date-specific prepared files; repeated Node invocations can write a missing snapshot, while Rust keeps the City read-only.

An existing output is rejected unless you explicitly pass `--replace`. Keep the completed `boston/` directory beside your Rust executable, or pass its absolute path with `--city`. Continue with [Harvard Square to South Station](#1-quickstart). No Node, Python, Osmium, or internet connection is needed for those Rust queries.

Build the City with VIGO V1; the runtime requires VIGORS02 snapshots and access-context v2. See [walking evidence](../reference/walking-evidence.md) for missing station costs, conservative access exclusions, and distance lower bounds. Preserve the runtime version and package checksum with the data.

### Copy and load the City

The City includes `network.json`, `routing/project.sqlite`, prepared access artifacts, and an `osm` directory with street snapshots, access profiles, and CCH indexes. Exact member filenames can vary by preparation version. Copy the whole City, not just the SQLite files or manifest.

The loader checks source identities, snapshot formats, station/access profiles, and required CCH members. It rejects blocking source features, missing/stale preparations, and an unexpected routing SQLite WAL. Complete and checkpoint a City through its compiler; do not delete WAL files to bypass a validation error.

### Update a network

Keep the directory immutable while processes use it. Compile updates into a new directory, start another service against it, verify readiness and a known query, switch traffic, then stop the old service. The runtime has no upload endpoint, source downloader, or hot-reload command.

`vigo info` reports `name`, `revisionId`, routing/street summaries, and warnings. A City revision identifies a dataset, not a guarantee of complete service or accurate realtime predictions. The runtime also needs prepared transit/access artifacts for walk-only queries; a bare street database is not a City.

## 4. CLI command reference

Use the command line to inspect a City, run a query, or start a service.

### Commands

All paths are local filesystem paths. Every data command requires `--city DIR` or `VIGO_CITY`; this includes `compare`. Help, version, and capabilities need no City.

| Command | Purpose | Main input |
| --- | --- | --- |
| `help`, `--help`, `-h` | Print the command overview | None |
| `version`, `--version`, `-V` | Print version and runtime | None |
| `capabilities` | Supported operations and compatibility flags | None |
| `info` | Loaded City identity and summaries | City |
| `route` | One origin–destination route, optionally via/window | JSON or endpoint flags |
| `matrix` | All origin–destination travel times | JSON arrays |
| `reach`, `isochrone` | Reachable streets, raster, polygons, isolines | JSON or origin flags |
| `compare` | Changes between two saved Reach results | JSON with `before` and `after` |
| `native` | Low-level Rust operations | `operation` and typed `input` |
| `stream` | Resident NDJSON request/response process | One JSON object per stdin line |
| `serve` | Resident HTTP service | City and server flags |
| `health` | Check a running service's readiness without loading a City | `--host`, `--port` |

Use `vigo route --help` for the general command overview. `--name value` and `--name=value` both work. Unknown options, irrelevant options, repeated options, and extra positional arguments fail. Boolean flags are bare for true or use `--pretty=false`; `--pretty false` is not the boolean syntax. The internal `_worker` command is reserved for the HTTP supervisor.

### Query flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--city DIR` | Data commands | Prepared City; overrides `VIGO_CITY` |
| `--routing-store FILE` | Data commands | With `--city` naming a Studio project's `.vigo` folder, the timetable store in its `routing/` folder to open (such as `current.sqlite`) |
| `--request FILE` | Route, Matrix, Reach, Compare, Native | JSON file; `-` reads stdin |
| `--output FILE` | One-shot JSON commands | Save result; `-` means stdout |
| `--pretty` | One-shot JSON commands | Indent JSON |
| `--stream-output public\|detailed` | Stream | Public results by default; detailed internal wrapper envelope when explicitly selected |
| `--service-date YYYY-MM-DD` | Route, Matrix, Reach, Native, Stream | Set or override service date |
| `--time HH:MM[:SS]` | Route, Matrix, Reach, Stream | Set clock; replaces JSON `timeMinutes` |
| `--mode transit\|walk\|drive` | Route, Matrix, Reach, Stream | Reach supports all three modes |
| `--from lon,lat` or `--from stop:ID` | Route, Reach | Origin |
| `--to lon,lat` or `--to stop:ID` | Route, Reach | Destination; an arrive-by Reach takes a destination |
| `--max-walk KM` | Route, Matrix, Reach, Stream | Walking endpoint budget |
| `--max-transfers N` | Route, Matrix, Reach, Stream | Transit transfer cap |
| `--max-street KM` | Route, Matrix | Independent street-route distance cap |
| `--horizon MINUTES` | Route, Matrix | Search horizon |
| `--arrive-by` | Route, Matrix, Reach | Arrive-by time direction; false restores depart-at |
| `--alternatives N` | Route | Additional transit journeys, 0–9 |
| `--alternative-ranking pareto\|ranked` | Route | How alternatives are chosen |
| `--cutoffs 15,30,45` | Reach | Travel-time cutoffs |
| `--raster-size N` | Reach | Square grid width and height |
| `--radius KM` | Reach | Reporting extent radius |
| `--street-edges` | Reach | Include directed street evidence |
| `--scenario ID` | Data commands on a collection | Select a scenario; omission uses `defaultScenario` |
| `--wheelchair` | Route, Matrix, Reach | Require the City's strict wheelchair profile |
| `--format text\|json` | One-shot JSON commands | Terminal text or JSON; pipes and files use JSON |
| `--diagnostics LEVEL` | Query commands | `none`, `summary`, `profile`, or `trace` |
| `--include-geometry`, `--include-limitations` | Query commands | Route geometry is on by default; Matrix geometry and limitations are opt-in |

Server flags are listed in the [HTTP API reference](#15-http-api-and-server-operation). Other controls, including transfer buffers, realtime, scenarios, via points, and journey geometry, belong in JSON. CLI query flags override fields from the request file. Stream flags override every line, so omit a stream-level service date when sending different dates.

### Files and standard input

Input files/stdin accept one JSON object and an optional UTF-8 BOM, up to 8 MiB. A request read from stdin completes when stdin closes. JSON goes to stdout; logs/errors go to stderr. With a file output, the result is saved instead of printed. Writes are staged and renamed atomically, preserving an existing file's permissions. The output directory must already exist. No CSV batch interface is provided; use Matrix or Stream.

## 5. Points, clocks, units, and common fields

Queries accept map coordinates or stop IDs. Transit queries also need a service date and a clock time.

### Coordinates and stop IDs

Use `[longitude, latitude]` in WGS84 decimal degrees. Longitude must be −180…180, latitude −90…90. Kilometers are used for high-level walking/street limits; output geometry distances are meters; high-level times are minutes. Native operations use seconds/meters unless a field explicitly names another unit.

```json
{"coordinate": [-77.05, 38.9]}
```

```json
{"stopId": "A"}
```

A point may also be a bare coordinate array. Point objects accept `id`, `name`, `label`, `source`, and scenario metadata `editStatus`, `baselineStopId`, `baselineStopIndex`. These labels do not change routing. A valid `stopId` takes precedence over a coordinate, except `source: "map"`, which deliberately uses the coordinate. Selected stations/platforms include their prepared station members. This selection does not certify a physical path between every platform.

Exact identifiers are case-sensitive. Multi-feed IDs may contain a feed scope and the JSON separator `\u001f`. Obtain active IDs with `timetable.identifiers`; do not assume a local ID is unique in a combined City.

### Common query fields

| Field | Default / requirement | Accepted values and meaning |
| --- | --- | --- |
| `serviceDate` | Required for transit/timetable operations | Exact `YYYY-MM-DD`; calendar plus date exceptions select service |
| `serviceDay` | Derived | Optional `weekday`, `saturday`, or `sunday`; must agree with the date |
| `time` | Required unless `timeMinutes` is supplied | `HH:MM[:SS]`, hours 0–71; numeric minutes are also accepted |
| `timeMinutes` | Alternative clock | Number 0–4319; never combine with `time` |
| `timePreference` | `depart_at` | `depart_at` or `arrive_by`; aliases `depart` and `arrive` accepted |
| `mode` | `transit` | `transit`, `walk`, `drive` |
| `maxWalkKm` | 1.2 | Number 0–100; per transit access/egress endpoint, Reach terminal-walk budget, or Drive walk between a point and its road |
| `maxTransfers` | No explicit cap | Integer 0–31; zero means at most one boarding |
| `horizonMinutes` | 480 | Number 1–2880; Route/Matrix only |
| `maxStreetKm` | 50 | Number 0.05–1000; Walk/Drive Route/Matrix limit. Zero and values below 0.05 are rejected, never rounded up or treated as unlimited. |
| `allowStreetTransfers` | true | Keep or filter walking transfers between separate stops/stations |
| `minimumTransferBufferMinutes` | 0 | Integer 0–60; extra time per subsequent transit transfer |
| `requireTransitRide` | false | Transit Route/Matrix boarding policy |
| `allowLongWalk` | true | Transit only: when false, cap direct walking alternatives by `maxWalkKm` instead of `maxStreetKm`. Explicit Walk mode always uses `maxStreetKm` |
| `walkSpeedKph` | City's walking policy, normally 4.8 | Number 1–8; walking legs, including a drive's walk to and from its road |
| `disableCache` | false | Disable street endpoint caches; not a complete cold-run switch |
| `requireCompleteServiceCoverage` | false | Reject missing active source scopes in a multi-feed service slice |
| `sourceScopes` | All sources | Array of source scope names; route only on the services of those sources in a multi-feed City |
| `departNow` | false | Transit Route only: leave at the current minute in the agency's timezone (rounded up), on its service date; replaces `serviceDate` and `time` |
| `routingDataMode` | Inferred from supplied observation input | `scheduled` or `realtime`; `dataMode` is an alias; do not supply both |
| `id` | Optional | Caller correlation value; echoed by Stream and HTTP |

### Service time and walking policy

Transit times are service-day clocks, including after-midnight GTFS hours. Calendar queries include services on adjacent dates when their trips overlap the search interval. GTFS clocks use local noon minus twelve elapsed hours, including daylight-saving changes. `journey.clockDate` anchors every journey and leg clock; a transit leg's `serviceDate` identifies its actual operating date, and hours can exceed 23. Street-only queries still require a clock but can omit `serviceDate`.

The depart-at timetable search ends at departure plus horizon; arrive-by searches back to the later of midnight and arrival minus horizon. A transit egress walk may extend beyond the depart-at scan horizon. Direct walking is bounded by physical walking duration as well as its distance cap. Drive routing uses its street-distance limit and supplied static metric; `horizonMinutes` does not add a drive travel-time cutoff.

City access padding/overhead apply to boarding access, not physical direct-walk duration. The transfer buffer applies once after walking and source-defined transfer minima; it does not delay first boarding, final egress, or staying aboard. `allowStreetTransfers: false` retains endpoint access and egress. Neither control establishes station accessibility or fare-transfer eligibility.

`arrivalBufferMinutes` is an optional integer 0–60 (default 0) for arrive-by
Transit Route and Matrix. A positive value reserves time before the final
deadline while retaining the original earliest departure. The deadline must
be at least the reserve, and `horizonMinutes` must exceed it by at least one
minute. Positive reserves reject via points, depart-at, Walk, Drive, Reach,
and native operations. `diagnostics.timeReserves` records both deadlines and
`calibratedProbability: false`. Route and journey clocks retain their actual
modeled times; Matrix scalar durations include the reserve. Combine with
`minimumTransferBufferMinutes` for time at intermediate changes. See
[Travel-time uncertainty](../guide.md#travel-time-uncertainty) for the Boston
example and calibration requirements; a margin is not a probability guarantee.

## 6. Route

Route finds a journey between an `origin` and a `destination` at a chosen time. Transit queries also require a service date. A valid query with no journey returns `status: "not_found"`.

### Reference fixture

The remaining reference examples use the small public test network `A → X → B`, with service on **2026-07-15**. It is also used by the localhost demonstration on port 8787. These IDs do not belong to Boston; use the coordinates and data above for your own first queries.

A depart-at request requiring transit, so the fixture illustrates ride and transfer clocks:

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "maxWalkKm": 0.2,
  "requireTransitRide": true
}
```

Its response excerpt (legs, metadata, and diagnostics omitted):

```json response=quickstart
{
  "schema": "vigo.route.v1",
  "status": "ok",
  "mode": "transit",
  "journey": {
    "departureTime": "07:55:00",
    "arrivalTime": "08:30:00",
    "durationSeconds": 2100,
    "transfers": 1,
    "walkingSeconds": 0,
    "ridingSeconds": 1500,
    "waitingSeconds": 600
  }
}
```

The journey departs at `07:55` and arrives at `08:30`, with 25 minutes riding and 10 minutes waiting. `transfers: 1` means two boardings. Public journey durations are integer seconds, and journey clocks are local service-day `HH:MM:SS`. See [Results and errors](#13-public-results-and-diagnostics) for the full response structure.

### Transit

An arrive-by request for the fixture:

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "time": "08:30",
  "timePreference": "arrive_by",
  "maxWalkKm": 0.2,
  "maxTransfers": 1,
  "requireTransitRide": true,
  "allowStreetTransfers": false,
  "minimumTransferBufferMinutes": 5
}
```

### Walking and driving

For a walk query, specify coordinates, walking speed, and a street-distance limit:

```json query=route
{
  "origin": {"coordinate": [-77.05, 38.9]},
  "destination": {"coordinate": [-77.03, 38.91]},
  "time": "07:55",
  "mode": "walk",
  "walkSpeedKph": 4.8,
  "maxStreetKm": 5
}
```

Change `mode` to `drive` for a drive query. Street paths follow directed OSM routing. A drive attaches each free endpoint to the nearest point of a drivable road segment and enters or leaves that road mid-segment, in the road's own direction. The straight gap between the point and its road is a walk at `walkSpeedKph`, published as its own `walk` leg with `geometrySource: "coordinate-snap"`. A drive whose walk to a road would exceed `maxWalkKm` is blocked with `no_drivable_road_within_walk`; it is not driven across open ground. Drive geometry runs from the road point through the routed node sequence to the destination's road point.

### Direct walking policy

For transit coordinate requests, a direct OSM walk competes with transit by default. Set `requireTransitRide: true` to require a vehicle boarding. A blocked request containing an explicitly selected stop does not gain a direct-walk fallback. A ready selected-stop route can still be replaced by a winning direct walk when that policy is false. Set `mode: "walk"` when walking is the intended operation.

### Journey geometry

Route includes its materialized leg geometry by default. Set `includeGeometry: false` to omit coordinate arrays from the public response. Matrix geometry remains opt-in. A transit leg's line runs from the boarding stop through the aligned source-shape vertices to the alighting stop; `distanceMeters` is the length of that line. Missing source shapes fall back to a labeled stop sequence. Transit legs carry GTFS fare annotations when the City publishes fares. Studio's balanced/preference presentation is not part of this interface.

## 7. Alternatives, via points, and departure windows

Ask for several journeys at one time, plan through intermediate points, or compare departures over a time window.

### Alternative journeys

`alternatives` (0–9, default 0) asks a depart-at transit Route for additional transit journeys at the requested time. The primary journey stays in `journey`; the others appear in `alternatives`, earliest arrival first. Both runtimes return the same alternatives for the same request.

`alternativeRanking` chooses them:

- `pareto` (default) keeps trade-offs first: an alternative must beat every other returned journey on arrival, boardings, or walking. It uses no more boardings than the primary journey. When more trade-offs exist than requested, the fewest boardings and the least walking are kept first. Remaining places go to journeys within the arrival slack that ride a set of routes no listed journey rides, earliest first, even when the primary journey is better in every respect. A primary journey with little walking therefore still lists distinct routes.
- `ranked` keeps the earliest arrivals even when another journey is better in every respect, then prefers less walking and fewer boardings. A returned candidate with the same arrival and less walking replaces the primary journey, preserving any genuinely earlier arrival. This tie policy applies to ranked alternatives; scalar queries without alternatives retain their boarding-first tie policy. It admits one more boarding than the primary journey, within `maxTransfers`.

In both rankings, journeys on one vehicle chain are one choice: the same vehicles, whatever stops they use to change or leave, or the same vehicles followed by further rides. The earliest arrival, then less walking and fewer boardings, represents the chain.

`alternativeSlackMinutes` (0–120, default 15) bounds how much later than the primary journey an alternative may arrive. `alternativeSearch` records `coverage: "requested_time"`, `ranking`, `maximumJourneys` (including the primary), `arrivalSlackMinutes`, and `status`. A search that exceeds the kernel's label budget reports `status: "unavailable"` with a `reason` and returns the primary journey alone. Alternatives are transit journeys; a faster direct walk remains the primary journey. Requests that combine alternatives with arrive-by, via points, or a journey window are rejected, except a window with `windowChoices: "supported"` (see [Supported window choices](#supported-window-choices)).

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "time": "07:50",
  "alternatives": 3,
  "alternativeRanking": "ranked",
  "maxWalkKm": 0.2,
  "requireTransitRide": true
}
```

### Displaying direct-service choices

A journey window samples optimal departures; it does not guarantee that a slower
parallel service appears. For a depart-at transit interface that offers both fast
journeys and direct services, request `alternatives: 9` with
`alternativeRanking: "ranked"`, then make a second request with the same endpoints,
date, time and walking limits and `maxTransfers: 0`. Merge the successful journeys,
sort by arrival, and deduplicate equivalent departures for presentation. Keep the
fastest journey as the recommendation. The second search prevents faster transfer
combinations from occupying every slot before a useful direct service is returned.

Remove `windowMinutes` when requesting alternatives. Retain the existing window
or single-journey request for arrive-by searches, which do not support ranked
alternatives. Preserve the source boarding/alighting restrictions and station
access costs in both requests. This policy adds a second query and remains bounded
by the requested count and arrival slack; it is not an exhaustive list of services.

### Shared-leg services

Set `sharedLegs: true` on a transit Route request to expose other services on the
same leg, including services pruned by the optimal search. It is off by default.
Both the Node and standalone Rust runtimes return
`journey.sharedLegAlternatives.options`: each item has a zero-based `legIndex`
and a complete `journey` with the replacement trip, times, transfers, and geometry.
The recommended journey stays unchanged. Studio enables this for routes without
via points and offers the services in the leg's details.

Matching uses route IDs, the exact ordered stop IDs and boarding/alighting
permissions, and an equivalent directed path. Route names do not establish
identity: two services may share a name or have different names. A short-turn
branch appears only on the segment it serves; express/local patterns and
different paths remain separate. Path matching requires GTFS shapes or planned
scenario geometry. It compares coordinates rounded to six decimals, ignoring
consecutive duplicates and straight-line resampling. Missing shapes or
independently digitized paths that do not match are conservatively omitted.

Coverage is explicitly `single_leg_substitutions`. Each option changes one leg
of the recommended journey, keeps the other rides fixed, and preserves feasible
transfer times and the query deadline. It considers departures from the original
leg's departure through 30 minutes later, with arrivals at most 30 minutes later
than that leg. It returns the earliest-arriving feasible trip per alternate route
ID, retains at most 256 replacement candidates per leg, and returns at most 32 options
per journey. `truncated: true` indicates that a bound was reached. These bounds
are independent of the top-level journey limit. Options are complete witnesses;
do not combine replacements from different options into an unverified journey.

The feature supports active scheduled and supplied realtime timetables,
arrive-by requests, and journey windows. Earlier departures and combinations of
several replacement legs are outside this initial coverage. Via points and
street modes are rejected. No City rebuild is needed.

`frequency: "active_departures"` adds a `frequencies` entry per verified leg.
Each entry counts actual active trip instances on the same ordered stops,
permissions and directed path, including the selected route's repeat trips.
Canceled, inactive, excluded and path-mismatched trips do not contribute;
supplied realtime delays move departures before gaps are calculated. Non-exact
GTFS frequency templates (`exact_times=0`) are not actual departures and remain
excluded by the timetable importer.

The half-open observation window starts at that leg's departure and ends 30
minutes later, or at the query's timetable horizon if earlier. Window timestamps
and `departureSeconds` use elapsed seconds on the journey's `clockDate`, including
overnight service clocks. `departureCount` counts vehicles;
`uniqueDepartureCount` and sorted `departureSeconds` count distinct times.
`departuresPerHour` scales the observed count by the window duration.
`meanHeadwaySeconds`, `minHeadwaySeconds`, and `maxHeadwaySeconds` summarize gaps
between consecutive **distinct** departure times. Simultaneous vehicles add
capacity, not shorter gaps. Fewer than two distinct times produce null headways.
These are finite-window estimates, not a promise of regular service or expected
waiting time; no per-route headways are averaged.

Frequency has `scope: "shared_segment"`: onward connections do not filter the
segment's departures. Only the separate journey options promise a feasible
end-to-end substitution. The scan examines at most 512 segment departures per
leg; if capped, frequency `status` is `incomplete`, counts are lower bounds, and
all rate/headway estimates are null. Missing or unproven paths are conservatively
excluded, so completeness applies only to path-verified services. The 32-option
display limit never limits the departure count.

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "time": "07:50",
  "sharedLegs": true,
  "requireTransitRide": true
}
```

### Via points

Supply `via` (alias `waypoints`) as an ordered array of at most 16 points. Do not supply both aliases. Each segment is routed in order, carrying time forward for depart-at or backward for arrive-by. Results contain `segments`, not one flattened journey. A blocked segment reports `reason: "via_leg_blocked"` and `legIndex`.

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "via": [{"stopId": "X"}],
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "maxWalkKm": 0.2
}
```

Transit via requests require a boarding on every segment. They reject an explicit `maxTransfers` or a nonzero transfer buffer because independent segment composition cannot certify the transfer boundary. No dwell/visit duration is added at a via point.

### Journey windows

`windowMinutes` accepts 0–240 (default 0). A positive value samples searches at `windowStepMinutes` intervals (1–60, default 1), including the requested time. Depart-at searches move toward later departures; arrive-by searches move toward earlier arrival deadlines. Results retain up to five distinct, nondominated journeys, sorted by earliest arrival for depart-at or latest departure for arrive-by, then fewer boardings and less walking. The primary journey is in `journey`, with the remaining choices in `alternatives`.

`alternativeSearch` records `minutes`, `stepMinutes`, `searches`, and `direction` (`later_departures` or `earlier_arrival_deadlines`). Transit alternatives at each sample use a 15-minute slack; the direct-walking comparison can lie outside that envelope. This is a sampled search, not a continuous all-departures guarantee. A nonempty via list takes precedence and removes window sampling from its segments; do not combine the two when you need window alternatives.

### Supported window choices

`windowChoices: "supported"` asks a depart-at Route for the choices a person compares rather than the sampled frontier. The window searches each minute from the requested time through `windowMinutes`, certifies every sample's best journey, and keeps the journeys that are best for some balance of elapsed time, ride time, boardings and walking: the earliest arrival, the fewest transfers, the least walking and a balanced choice, each labelled with its role. With `alternatives` (and optionally `alternativeRanking: "ranked"`), alternatives at the requested time join the choices. Optional additions:

| Field | Meaning |
| --- | --- |
| `expandedWalkKm` | Above `maxWalkKm` (default 2.4): also search with this walking budget and add choices that walk farther but arrive at least a minute earlier |
| `includeEarliestTransit` | Add `earliestTransit`, the first boarding and arrival of the earliest transit choice, even when walking wins |

With `via` points, supported choices compose each segment at the exact clock the previous segment reaches its point. Arrive-by requests accept `windowChoices` only without a window.

These fields are supported by the standalone Rust CLI and its HTTP service. The Node CLI instead supports `--departure-window` or JSON `departureWindowMinutes` for a centered depart-at profile of ±0–30 minutes. It rejects the standalone window fields, and rejects positive centered profiles with arrive-by, rather than silently running a point query.

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "time": "07:50",
  "windowMinutes": 15,
  "windowStepMinutes": 1,
  "maxWalkKm": 0.2,
  "requireTransitRide": true
}
```

## 8. Matrix

Matrix calculates travel times between every origin and destination in a request. It supports transit, walking, and driving.

### Build a matrix

Supply `origins` and `destinations` arrays with at least one point each. Use point objects or coordinate pairs as entries. A request can contain up to 65,536 origin–destination pairs. Row order follows origins; column order follows destinations.

```json query=matrix
{
  "origins": [{"stopId": "A"}, {"stopId": "X"}],
  "destinations": [{"stopId": "B"}, {"stopId": "A"}],
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "maxWalkKm": 0.2,
  "requireTransitRide": true,
  "includeJourneys": true,
  "includeGeometry": true
}
```

### Read the matrix

`durationsSeconds[row][column]` gives seconds from the shared departure to arrival for depart-at, or from the latest departure to the shared deadline for arrive-by. In the latter case, it can exceed the accompanying journey's duration when the journey arrives before the deadline. JSON `null` means unreachable. See [Matrix output](#matrix-output) for indexing, examples, and journey details.

### Include journeys

`includeJourneys` defaults to false and is supported for transit only. With true, `journeys` has the same dimensions and nulls for unreachable pairs. `includeGeometry` defaults to false and requires journeys. When direct walking wins, its journey contains a timed walking leg, with geometry if requested. Large journey/geometry matrices can reach the HTTP response limit; split them into smaller requests.

`journeyFormat` defaults to `"full"`, retaining stop names, route details, stop sequences, and walking evidence. Analytical callers can explicitly request `"compact"` with `includeJourneys: true`: it returns the same selected trips, stops, boarding sequences, leg clocks, transfers, and walking/riding/waiting durations without display metadata or walking-evidence annotations. Compact does not accept `includeGeometry: true`. For duration-only workloads, leave `includeJourneys` false. Compare performance at the same output detail; the Node Matrix interface returns compact witnesses.

### Repeated endpoints

Transit Matrix keeps repeated endpoints grouped through transit search, direct walking and journey geometry, then expands completed answers into the requested row and column order. Exact-stop and coordinate endpoints retain their respective routing semantics. Trace diagnostics expose `matrixReuse.requestedPairs`, `searchPairs`, `uniqueOrigins` and `uniqueDestinations`. The 65,536-pair response limit still applies; this reuse does not approximate or merge distinct endpoints.

Run `node scripts/benchmark-service-reuse.mjs --reference /path/to/baseline-vigo --samples 31 --output comparison.json` to compare two executables on a generated public fixture. The check compares complete answers and reports date preparation, retained-date switches, repeated and distinct Matrix pairs. Engine execution time and the detailed-output round trip are recorded separately. This small fixture tests reuse and regressions; metropolitan scaling needs a separate workload.

## 9. Reach and isochrones

Reach finds the streets and areas accessible from an origin within a set of travel-time limits or, arriving by a deadline, the streets and areas a destination can be reached from. Transit queries combine timetable travel with walking over the prepared street network. Use `mode: "walk"` for walking only, or call `isochrone` as an alias of `reach`.

Reach supports depart-at and arrive-by queries, including realtime transit. Driving Reach uses `mode: "drive"` and routes to cell centers through the prepared directed driving network. It uses road-speed estimates without live traffic and does not apply transit scenarios. As in Drive Route, the origin and every cell center walk straight to their nearest drivable road; a cell center farther than `maxWalkKm` from any road is unreachable, and its walk counts toward the cutoff. The raster has a fixed extent (`extentRadiusKm`, default 8, maximum 40); points outside that extent are not evaluated. Driving uses a 750 km road-distance search cap and does not return pedestrian edge or node evidence. Studio offers Driving under Analyze → Reach and uses a 40 km extent.

### Request

```json query=reach
{
  "origin": {"stopId": "A"},
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "cutoffsMinutes": [15, 30, 45],
  "maxWalkKm": 0.5,
  "walkSpeedKph": 4.8,
  "extentRadiusKm": 2,
  "rasterSize": 48,
  "includeStreetEdges": true
}
```

### Arrive by

An arrive-by Reach (`timePreference: "arrive_by"`) takes a `destination` instead of an origin and reads `time` as the arrival deadline. It outlines where a traveler can start and still arrive by then. Each value is how long before the deadline the traveler must leave that place; a stop's duration is how long before the deadline they must be at the stop to board.

```json query=reach
{
  "destination": {"stopId": "B"},
  "timePreference": "arrive_by",
  "serviceDate": "2026-07-15",
  "time": "08:30",
  "cutoffsMinutes": [15, 30, 45],
  "maxWalkKm": 0.5,
  "extentRadiusKm": 2,
  "rasterSize": 48
}
```

Transit searches the timetable backwards once from the stops that reach the destination, giving every stop its latest boarding. Walking runs over the streets backwards, so one-way footpaths, escalators and station paths keep their direction; a destination behind authorized private access is entered from its public exits, and the surface covers public streets. Cell-center sampling and Driving route from every cell center to the destination. A deadline earlier than the longest cutoff after midnight searches the preceding service date's late trips, as arrive-by Route does. Exclusions and planned services apply, routed on the scenario's timetable view with scheduled data; a compiled `overlay` and `surfaceReuse` are depart-at only.

### Options

| Reach field | Default | Contract |
| --- | --- | --- |
| `origin` | Required for depart-at | Point where trips start |
| `destination` | Required for arrive-by | Point where trips end; arrive-by Reach takes no origin |
| `cutoffsMinutes` | `[15,30,45,60]` | 1–16 numbers, each 1–240; sorted and deduplicated |
| `rasterSize` | 96 | Integer 16–1024; output width and height |
| `extentRadiusKm` | 8 | Number 1–40; reporting extent, not a trip-distance cap |
| `bounds` | Derived from the origin or destination and radius | `[west,south,east,north]`, finite and ordered geographic limits |
| `includeStreetEdges` | false | Include indexed directed street evidence |
| `includeNodes` | false | Include native node evidence |
| `surfaceSampling` | `street` | `street` samples reached street intervals; `cell-center` routes to every grid center |
| `scenario` | None | Exclusions, planned services, or compiled overlay |
| `surfaceReuse` | None | Street sampling: `baseline` keeps this surface in the running process; a following `scenario` request grows from it when every seed is unchanged or earlier, otherwise it searches afresh |

Do not supply `horizonMinutes`, `maxStreetKm`, `requireTransitRide`, or `allowLongWalk` to Reach. The largest cutoff bounds the analysis. Walk-only Reach accepts a clock without a service date and cannot apply a transit scenario.

Cell-center sampling uses the Matrix walking allowance and fixed requested bounds. It supports walking or scheduled transit, without planned service changes. Transit uses the City's prepared 4.8 km/h walking policy; other speeds are rejected. Street sampling supports planned service changes and adjustable walking speed.

### Read the surface

`surface.valuesSeconds` is a flat row-major array of elapsed seconds starting at the **northwest** corner. For width `w`, cell index is `y*w+x`. Null means no finite value was retained; numeric zero is valid. Given bounds `[west,south,east,north]`, cell centers are:

```text
longitude = west + (x + 0.5) / width  * (east - west)
latitude  = north - (y + 0.5) / height * (north - south)
```

`fullSurface.valuesSeconds` uses `fullSurface.bounds` and the same dimensions, with bounds recomputed from reached street evidence when available. Those bounds can be smaller or larger than the requested view. Never interpret full values using the requested bounds. `areas`/`fullAreas` are GeoJSON FeatureCollections of MultiPolygons; `contours`/`fullContours` contain MultiLineStrings. Features carry `cutoffMinutes`. Areas preserve holes and disconnected components; isolines interpolate the raster rather than inventing a convex hull through unreachable space. Raster resolution affects presentation and area estimates. See [Reach output](#reach-output) for decoding and interpretation.

### Map output

For map display, Reach accepts `reachFormat: "map"`. It returns the full reached-area polygons as `areas`, their `bounds`, and the usual query metadata, without stop lists, duplicate contour representations or raster values. The polygons match `fullAreas` from `reachFormat: "full"`, which remains the default for analysis and raster comparisons. Output selection does not change the search.

### Street evidence

Street evidence is `surface.edges` with schema `vigo.standalone.street-edges.v2`, encoding `indexed-json`. It retains partial directed intervals, with coordinates and times decoded as shown under [Reach output](#decode-directed-street-evidence). This encoding differs from Studio's binary edge bundles.

### All-day Reach

The Rust CLI and native HTTP Reach endpoint accept `allDay` as a temporal extension of the existing query. It samples scheduled depart-at transit every **five minutes**. The default window is `[0, 1440)` service-day minutes (288 samples); a shorter window can be supplied. No separate engine or job service is required.

```json
{
  "kind": "reach",
  "origin": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "allDay": {"startMinutes": 0, "endMinutes": 1440},
  "cutoffsMinutes": [15, 30, 45],
  "maxWalkKm": 0.5,
  "rasterSize": 48,
  "extentRadiusKm": 2,
  "reachFormat": "surface"
}
```

Save this request and run `vigo reach --city city --request all-day.json`, or send it as a line to the native `stream` command. Do not specify `time` or `timeMinutes`. This initial mode supports street sampling, scheduled transit and depart-at queries only; scenarios, live state, arrive-by, cell-center sampling, polygons and per-sample output are excluded. It is not yet exposed in Studio or the Node compiler CLI.

The result keeps `schema: "vigo.reach.v1"`. `allDay.sampleCount` is the denominator; the row-major `surface` contains `reachableSamples`, `meanReachableDurationSeconds` (null when never reachable), and `reachableSamplesByCutoff` (one row per `cutoffsSeconds` entry). Divide a cutoff count by the sample count for the fraction of sampled departures reaching that cell within that cutoff. Means include only samples reachable within the maximum cutoff: unreachable samples are **not zero**, and a low conditional mean does not imply reliable all-day access. There is no single `valuesSeconds` raster or requested departure time for the aggregate.

Walking indexes and cached origin access are shared in one resident City. Each sample runs the existing Reach search and street propagation; only one sample raster and online accumulators are retained, so aggregation memory does not grow with the number of times sampled. Changed transit seeds are not assumed safe for cross-time street-label reuse. Five-minute sampling estimates service-day reachability, not continuous-time guarantees or counts of jobs/population. Opportunity-weighted accessibility remains a separate downstream calculation.

## 10. Scenarios

Test service changes by applying a scenario to a Reach or transit Route query. Each scenario lasts for that request; it leaves the City and later requests unchanged.

A Route scenario routes on a view of the scheduled timetable with the excluded trips removed and the planned services added as trips. Planned stops on City stops (`stopId`) are those stops; other planned stops are new, joined to the network by walks within the City's stop-transfer radius and reachable from endpoints within `maxWalkKm`. Planned stops, routes and trips belong to the feed `scenario-<hash>` of that scenario: a planned route's ID is its service `id`, and its name is the service `name`. The detailed trace also marks planned rides with `scenarioService` and names the `scenario`. A Route scenario accepts `services` and the exclusions, not `overlay`, and uses scheduled data. Repeated requests with the same scenario reuse its view.

```json query=route
{
  "origin": {"stopId": "A"},
  "destination": {"stopId": "B"},
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "maxWalkKm": 0.2,
  "requireTransitRide": true,
  "scenario": {
    "id": "express",
    "name": "Express",
    "services": [{
      "id": "express",
      "name": "Express",
      "operation": "add",
      "scheduleMode": "frequency",
      "stops": [{"stopId": "A"}, {"stopId": "B"}],
      "bidirectional": false,
      "startMinutes": 475,
      "endMinutes": 600,
      "headwayMinutes": 5,
      "timeModel": "preserve-scheduled",
      "segmentRuntimeMinutes": [5]
    }]
  }
}
```

A scenario object accepts `id`, `name`, optional matching `cityRevision`, `excludedTripIds`, `excludedRouteIds`, `services`, or `overlay`. Use exact active City identifiers. An exclusion only affects matching scheduled trips.

A supplied `cityRevision` must match the loaded City. Choose either nonempty `services` or `overlay`. Editor-only IDs/fields are rejected; hydrate branch edits into explicit schedules before using this interface.

### Frequency service

```json query=reach
{
  "origin": {"stopId": "A"},
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 2,
  "rasterSize": 48,
  "maxWalkKm": 0.2,
  "scenario": {
    "services": [{
      "id": "express",
      "operation": "add",
      "scheduleMode": "frequency",
      "stops": [{"stopId": "A"}, {"stopId": "B"}],
      "bidirectional": false,
      "startMinutes": 475,
      "endMinutes": 600,
      "headwayMinutes": 5,
      "timeModel": "preserve-scheduled",
      "segmentRuntimeMinutes": [5]
    }]
  }
}
```

| Service field | Default / contract |
| --- | --- |
| `operation` | `add`; also `augment` and `replace` |
| `stops` | At least two ordered points; maximum 256 unique planned points across a query |
| `scheduleMode` | `frequency` for add/augment; `preserve-trips` for replace |
| `sourceRouteId` | Required for route-wide frequency replacement when explicit trip IDs are absent |
| `bidirectional` | true for frequency; false for preserved trips, where true is rejected |
| `startMinutes`, `endMinutes` | 300 and 1500; 0–4319; end must not precede start |
| `headwayMinutes` | 12; 0.1–1440 |
| `timeModel` | `estimate-distance`, `preserve-scheduled`, or `infer-road` |
| `averageSpeedKph` | 22; 1–300 |
| `dwellMinutes` | 0.35; 0–60, used with distance estimates |
| `segmentRuntimeMinutes` | One nonnegative number per consecutive stop pair |
| `segmentDistancesKm` | One nonnegative number per consecutive stop pair |
| `addedStopDwellMinutes` | 0; 0–10, applies to inserted/added destination stops with supplied runtimes |
| `scheduledTrips` | Explicit trip list for preserve-trips mode |

At most 128 services and one million planned stop events are accepted. The default `estimate-distance` model uses projected stop distance, speed, and dwell; merely supplying runtime arrays does not select them. `preserve-scheduled` uses supplied runtimes, falling back to distance estimates where no runtime array exists. `infer-road` consumes supplied distances/runtimes; the standalone service does not infer them from a road route. Use a documented preparation method for those inputs.

`augment` retains existing service. Frequency replacement uses `operation: "replace"`, `scheduleMode: "frequency"`, and `sourceRouteId`; matching active trips are removed. If `scheduledTrips` is provided on a replacement service, its original trip IDs define the removal set. Added service can operate on a date with no active baseline service.

### Preserve explicit departures and dwell

```json query=reach
{
  "origin": {"stopId": "A"},
  "serviceDate": "2026-07-15",
  "time": "07:55",
  "cutoffsMinutes": [30, 45],
  "extentRadiusKm": 2,
  "rasterSize": 48,
  "maxWalkKm": 0.2,
  "scenario": {
    "services": [{
      "operation": "replace",
      "scheduleMode": "preserve-trips",
      "stops": [{"stopId": "X"}, {"stopId": "B"}],
      "scheduledTrips": [{
        "tripId": "T2",
        "departureSeconds": 29700,
        "arrivalOffsetsSeconds": [0, 600],
        "departureOffsetsSeconds": [0, 600],
        "canBoard": [1, 0],
        "canAlight": [0, 1]
      }]
    }]
  }
}
```

Offsets are **seconds** relative to that run's `departureSeconds`; every array matches the stop count. Permissions are zero/one; omitted permission arrays default to all allowed. Times must preserve chronological arrivals/departures. Replacement `tripId` must be active. Preserve-trips mode does not manufacture reverse runs or automatically recover the original timetable.

### Compiled overlays

Advanced clients can supply `scenario.overlay`: `stops`, `overlayStopCount`, direction offsets/stops/times, service windows/headways, and supplemental transfer arrays from `TimetableOverlayManyQueryInput`. The stop count must equal the coordinate-bearing stop list and be at most 256. The adapter creates endpoint seeds and destinations; the overlay cannot override those base query fields. Direction stop indices use the overlay-local domain; supplemental transfers use the combined resident-plus-overlay domain. Use the native reference for the exact array types and offset conventions.

## 11. Compare saved Reach results

Compare two Reach results on the same grid to find where travel times improve, worsen, or become unavailable.

### Prepare the comparison

Save baseline and scenario Reach responses, then construct a JSON object with those complete objects under `before` and `after`. Do not pass filenames as the two values.

```sh
python3 - <<'PY'
import json
with open('baseline.json') as f:
    before = json.load(f)
with open('scenario.json') as f:
    after = json.load(f)
with open('comparison.json', 'w') as f:
    json.dump({'before': before, 'after': after}, f)
PY
./vigo compare --city ./city --request comparison.json --output change.json
```

Python here is an optional client utility. The Rust command still requires a City path in this version, even though comparison itself uses saved grids. Both results must declare the same nonempty City revision, bounds, dimensions, and compatible numeric/null raster arrays. Compare does not rerun routing and does not currently compare Route or Matrix results.

### Interpret changes

The public result, `vigo.compare.v1`, reports changes **after minus before**. `counts` splits the `comparable` cells, reachable in both, into `faster`, `slower`, and `unchanged`, and counts `newlyReachable` and `noLongerReachable` cells separately. `meanChangeSeconds` averages comparable cells only, is negative when travel got faster, and is null when no cell is comparable. Request `diagnostics: "trace"` for the per-cell `deltaMinutes` grid described in [Comparison output](#comparison-output); a null delta is not a zero change.

Hold origin, clock/date, walking policy, cutoffs, and grid fixed when interpreting a scenario effect. The comparator does not certify all those experiment settings or compare City revisions.

## 12. Realtime transit and supplied traffic

Supply transit predictions or traffic observations with a query to use them in routing. Your application can supply decoded feeds; the Rust HTTP server can also poll GTFS-Realtime feeds and NDW traffic itself, as described below.

Without automatic polling, each query uses only the snapshot supplied with it. Omission restores scheduled/baseline routing on the next request. Explicit `routingDataMode: "scheduled"` rejects observation input; `"realtime"` requires a snapshot or traffic. Without an explicit mode, supplied input selects its corresponding observation path.

### Transit snapshot

Transit realtime supports Route, Matrix and Reach; all three search the same realtime view, and a Reach scenario applies on top of it. Use a `FULL_DATASET` snapshot with `tripUpdates` and, optionally, `alerts`. Feed timestamps are Unix **seconds**, not milliseconds. A record needs `sourceFeedTimestamp` or the enclosing `feedTimestamp`, no older than 180 seconds and at most 60 seconds in the future. If present, its own `timestamp` must also be fresh.

Create a current synthetic delayed-trip request from `route.json`:

```sh
python3 - <<'PY'
import json, time
with open('route.json') as f:
    query = json.load(f)
query['routingDataMode'] = 'realtime'
query['realtimeSnapshot'] = {
    'incrementality': 'FULL_DATASET',
    'feedTimestamp': int(time.time()),
    'tripUpdates': [{'tripId': 'T2', 'delaySeconds': 600}]
}
with open('realtime-route.json', 'w') as f:
    json.dump(query, f)
PY
./vigo route --city ./city --request realtime-route.json
```

For real use, preserve the source's timestamp; do not replace stale provider time with the current clock. The example refreshes time only to make a synthetic test record.

| Record field | Meaning |
| --- | --- |
| `tripId` | Exact or unambiguous scoped/local static trip ID; nested `trip.tripId` also accepted |
| `sourceScope` | Optional source identity constraint |
| `startDate` | Optional matching service date (`YYYYMMDD` or dashed form); nested trip field accepted |
| `routeId`, `directionId` | Optional static identity checks |
| `delaySeconds` | Integer propagated trip delay |
| `scheduleRelationship` | Scheduled or cancellation; canceled/deleted trips are removed |
| `stopTimeUpdates` | Ordered prediction records identifying one actual call |

A stop update uses integer `stopSequence` or an unambiguous `stopId`; both, if present, must agree. Loop calls need a sequence. `arrival` and `departure` are separate objects containing integer `delay` seconds or absolute `time` epoch seconds. Absolute timestamps require `realtimeSnapshot.timezone` (IANA name) when the City has no single timezone. `SKIPPED` removes a call; `NO_DATA` resets propagated delay. Terminal sequence inference is limited to an identified terminal stop; unknown intermediate calls are not guessed.

Invalid, duplicate, stale, ambiguous, or mismatched records preserve scheduled service and increment diagnostics. A malformed enclosing snapshot fails the request. Omitted past prefixes can be removed only when source clocks establish that the omitted calls are past; their boarding opportunities are removed with them. Cached snapshot validity changes at freshness/source-clock boundaries.

Read `diagnostics.realtime` (public `meta.realtime`) for coverage and the numbers of applied, canceled, stale, invalid, duplicate, and unmatched records. A successful route may use scheduled fallback. A fresh prediction is not a verified arrival or a completeness guarantee. A transit leg on a trip with applied predictions reports `quality.schedule: "realtime"`.

### Service Alerts

`realtimeSnapshot.alerts` holds GTFS-Realtime Service Alerts in the record form the server's poller produces:

```json
{
  "id": "closure-1",
  "effect": "NO_SERVICE",
  "header": "Park Street closed",
  "activePeriods": [{ "start": 1792764000, "end": 1792778400 }],
  "informedEntities": [{ "stopId": "place-pktrm" }, { "routeId": "Red", "directionId": 0 }]
}
```

An informed entity matches when all of its fields match (`routeId`, `routeType`, `directionId`, `trip.tripId`, `stopId`); an alert applies when any entity matches. A station `stopId` also selects its platforms. Active periods are POSIX seconds with open bounds; no period means always active. `effect` accepts a name or its GTFS-RT code.

| Effect | Routing |
| --- | --- |
| `NO_SERVICE` on a route, trip or route type | Its trips cannot be boarded or left during the period |
| `NO_SERVICE` on a stop | No boarding or alighting there during the period; vehicles pass through |
| `NO_SERVICE` on a route and a stop | That route does not serve that stop |
| Any other effect | None; the alert is reported on the legs it describes |

Every fresh alert active during a ride and selecting its trip, route or any of its stops appears in the leg's `alerts` list (`id`, `effect`, `cause`, `severity`, `header`, `description`, `url`). Alert freshness follows the record rule above. `meta.realtime.alerts` counts received, fresh, stale and `NO_SERVICE` alerts, the boardings and alightings closed, and entities VIGO cannot resolve: an agency alone, because a City does not record each route's agency, or a direction without a route. Alerts need the City's clock; a City with several agency timezones reports `status: "timezone_required"` unless the snapshot gives `timezone`. Wheelchair Cities still require scheduled service, so `ACCESSIBILITY_ISSUE` is reported but not applied.

### Automatic GTFS-RT polling

Start the Rust HTTP server with the feeds it should poll:

```sh
vigo serve --city ./city --realtime-poll ./realtime.json
```

```json
{
  "sources": [
    { "url": "https://cdn.mbta.com/realtime/TripUpdates.pb", "kind": "tripUpdates", "sourceScope": "mbta" },
    { "url": "https://cdn.mbta.com/realtime/Alerts.pb", "kind": "alerts", "sourceScope": "mbta" }
  ],
  "intervalSeconds": 30,
  "timeoutSeconds": 10
}
```

`kind` is `feed` (default: trip updates and alerts), `tripUpdates` or `alerts`; Vehicle Positions never change a route and are not polled. `sourceScope` names the static feed a source describes in a City built from several. `headers` sends up to eight request headers, such as an API key; status output never shows URLs, query strings or headers. URLs require HTTPS, except loopback HTTP for local mirrors and tests, and redirects are rejected. Up to 16 sources, intervals of 5–3600 seconds and HTTP deadlines of 1–60 seconds are accepted. Downloads are bounded to 32 MiB (128 MiB after gzip), and each feed must be a `FULL_DATASET` FeedMessage within the snapshot limits above.

For transit Route, Matrix or Reach, set `routingDataMode: "realtime"` and omit `realtimeSnapshot` to use the server's latest snapshot; an inline snapshot takes precedence for its own query. Every query admitted after a publication sees it in full, and `meta.realtime.snapshot` names it (`source: "server"`, content `id`, `generation`, and each source's feed timestamp and failure). Equal content never publishes a new generation.

One background producer downloads, decodes and merges the sources; decoding never runs in the routing worker. When the server is idle, the worker installs each new publication and derives the realtime view of the last live query (or, before the first one, a departure now in the City's timezone), so the next live query normally finds its view ready. A failed or invalid read keeps that source's last good records without extending their validity: record freshness still expires them after 180 seconds, and `coverage.complete` becomes false. Failures back off exponentially, capped at one hour. `GET /v1/realtime` reports status (`fresh`, `stale_fallback` or `unavailable_fallback`), generation, snapshot id, counts, attempts, failures, the next attempt, poll time and each source's state, under the same authentication policy as other `/v1` endpoints.

Polling currently supports a single City per Rust HTTP server, not scenario collections or the legacy Node server. DIFFERENTIAL feeds, deleted entities, added trips and trip modifications are not applied.

### Drive traffic

Drive Route and Matrix accept `traffic.observations` (aliases `segments`, `edgeUpdates`). Supply `observedAt` (aliases `fetchedAt`, `timestamp`), optional `ttlSeconds` (default 300; range 1–1800), and optional `expiresAt`. Traffic timestamps accept RFC3339 or numeric Unix seconds/milliseconds. Expiry is inclusive: at `now >= expiresAt`, both Node and Rust return `stale_fallback` and use baseline costs. Observation times more than 60 seconds in the future and malformed validity intervals are rejected. The admission clock is pinned once per route or matrix.

Each observation identifies directed `coordinates` (2–512 points), `fromCoordinate`/`toCoordinate`, or fingerprint-bound `edgeIndices`. Choose exactly one effect:

| Effect | Domain |
| --- | --- |
| `closed: true` | Make selected directed edges unavailable |
| `travelTimeSeconds` | 0.01–86400 for the entire matched path; distributed in proportion to baseline edge times |
| `speedKph` | 1–200 |
| `delayFactor` | 1–100; aliases `factor` and `multiplier` |

At most 100,000 observations and 200,000 affected edges are accepted. Geometry is matched to a connected, directed path in the prepared drive graph. The matcher checks endpoint proximity, forward progress, shape coverage in both directions (a corridor at most 30 m wide, tightened for short paths), and path length, and rejects competing paths within its ambiguity margin. Opposite directions are separate. It reports unmatched, ambiguous and search-budget failures rather than guessing. Overlapping observations retain the largest cost; the adapter does not reduce an edge below baseline travel time. This is one supplied static metric snapshot, not time-varying congestion prediction during the trip.

Raw callers may provide `snapshotKey`, `edgeIndices`, and `edgeTimeUnits` (hundredths of seconds), plus the City drive `streetSourceFingerprint` in the high-level traffic object. A closed edge has weight 2147483647. Actual weights, not just the caller key, determine cache identity. Prepared snapshots must also carry `observedAt` and optional `expiresAt` or `ttlSeconds`; missing freshness is an error. The standalone native drive endpoint applies the same admission rules. `meta.traffic` discloses status, timestamps, effective snapshot key, matching counts and rejection reasons, even without trace output. The low-level in-process kernel accepts only already admitted weights.

### Automatic NDW polling

Start the Rust HTTP server with an optional JSON configuration:

```sh
vigo serve --city ./city --ndw-poll ./ndw.json
```

```json
{
  "configurationUrl": "https://opendata.ndw.nu/reistijden_configuratie_meetlocaties.xml.gz",
  "measurementsUrl": "https://opendata.ndw.nu/reistijden_meetgegevens.xml.gz",
  "intervalSeconds": 60,
  "configurationRefreshSeconds": 3600,
  "ttlSeconds": 300,
  "timeoutSeconds": 20
}
```

Every field is optional; `{}` selects these defaults. URLs require HTTPS, except loopback HTTP for local mirrors and tests. Redirects are rejected. Poll intervals allow 1–3600 seconds, configuration refresh 60–86400 seconds, validity 1–1800 seconds, and HTTP deadlines 1–60 seconds. Poll at the source's update cadence (normally 60 seconds), not at query cadence. Downloads are bounded to 16 MiB and decompressed XML to 256 MiB.

For Drive Route or Matrix, set `routingDataMode: "realtime"` (alias `dataMode`) and omit `traffic` to use the server's latest snapshot. Scheduled requests and requests without an explicit realtime mode retain baseline costs. An inline `traffic` snapshot takes precedence. Before the first successful poll, realtime Drive returns `meta.traffic.status: "unavailable_fallback"`; after expiry it returns `stale_fallback`. Both use baseline costs.

One background producer downloads and joins the feed, matches it to the City's drive CSR, and publishes completed snapshots. It retains the CSR and a bounded geometry cache, without duplicating a CCH routing kernel. Configuration is restricted to sites whose endpoints fall within 120 m of the City bounds; off-City measurements cannot shorten local validity. Their IDs are retained for `out_of_city_site` diagnostics, rather than retaining their geometry and observations. The routing worker receives a changed snapshot once and pins its admission for the whole Route or Matrix. Download and XML parsing never block the routing worker. A new metric still requires CCH customization on its first query.

Failed downloads or invalid XML retain the last completed snapshot without extending its validity. Failures back off exponentially, capped at one hour. Site-version/table mismatches trigger one metadata refresh and rejoin; older publication timestamps cannot replace newer publications (observation timestamps still determine expiry). `GET /v1/traffic` exposes freshness, generation, attempts, failures, next retry, matching counts and timings under the same authentication policy as other `/v1` endpoints. A successful download alone does not imply fresh or matched traffic. City files are never rewritten.

Polling currently supports a single City per Rust HTTP server, not scenario collections or the legacy Node server. It uses NDW's v3 linear travel-time profile; it does not ingest point detectors as road speeds, infer closures from missing data, or predict future traffic. See the [NDW open-data directory](https://opendata.ndw.nu/) for the upstream feeds.

### Import NDW DATEX II v3 traffic

The standalone Rust executable imports local XML or gzip files. Download the configuration and measurement publications from the [NDW open-data portal](https://opendata.ndw.nu/), using the `reistijden_configuratie_meetlocaties.xml.gz` and `reistijden_meetgegevens.xml.gz` v3 feeds. No provider is polled automatically.

```bash
vigo traffic-import --city ./city \
  --configuration reistijden_configuratie_meetlocaties.xml.gz \
  --measurements reistijden_meetgegevens.xml.gz \
  --ttl-seconds 300 --output traffic.json
```

Set the routing request's `traffic` field to the contents of `traffic.json` and `routingDataMode` to `"realtime"` (required by the legacy Node CLI). The City must have prepared driving. Import again for each new feed update; expired output does not acquire a new observation time when loaded. A failed import does not overwrite the prior output file. `ingestion` in the output reports rejected records, matching results and parsing/matching timings.

The adapter targets the [Verkeersdata NL DATEX II 3.6 AVG profile](https://mogin.nl/publicaties/Verkeersinformatie/Verkeersdata/vigerend/index.html). It joins table identity, site identity/version and measurement index, reads ordered GML latitude/longitude geometry, and uses the measurement time rather than publication or download time. Invalid values, forecasts, erroneous measurements and stale records are excluded. Snapshot validity ends at the earliest expiry of the retained measurements.

Supported observations are whole-path travel times and speed quantities with an explicit linear itinerary and unrestricted vehicle scope. Point-detector speeds, lane-specific or vehicle-class values, OpenLR/ALERT-C-only locations, incident/closure publications, and time overrides are rejected with reasons. No closure is inferred from a missing or zero measurement. These are profile limits, not a claim to support every DATEX II publication.

Matching is conservative geometric conflation, not proof that a provider and OSM encode the same road. Parallel roads and forks within the ambiguity margin are rejected; grade, road-class and provider road identifiers are not yet available in the prepared drive graph. Sparse geometry can leave ambiguous coverage. Partial-edge offsets and turn-specific restrictions are not modeled. Inspect matched coverage before operational use; this remains a fixed-cost snapshot, not future traffic prediction.

## 13. Public results and diagnostics

Default output is a compact journey or analysis result. See the [public result contract](../reference/results.md) for every field, unit, evidence boundary, and migration rule.

- `--format text|json` selects terminal text or JSON; pipes and saved files use JSON by default.
- `--diagnostics none|summary|profile|trace` selects optional detail. Default is `none`.
- Route includes available leg GeoJSON by default; `--include-geometry=false` omits it. Matrix geometry remains opt-in with `--include-geometry`. `--include-limitations` adds dataset limitations.
- HTTP accepts the equivalent body fields or `?diagnostics=summary`, `?includeGeometry=true`, and `?includeLimitations=true`.
- Route uses `journey`; Matrix uses `durationsSeconds`; Reach uses `surface.valuesSeconds` and `fullSurface`.
- `status: "ok"` means a result, `not_found` means no admissible journey, and `error` means failure.
- `meta` separates engine version, City revision, request identity, query fingerprint, and measured compute time.

Stream consumers may select `--stream-output=detailed` after checking that `capabilities.output.streamFormats` includes `detailed`. This returns the internal `vigo.stream.detail.v1` envelope without constructing the public projection; its `trace` contains the routing outcome. This format is an unstable wrapper interface. See the public result reference for envelope and error semantics.

The [public result contract](../reference/results.md) defines the default output. The rest of this chapter documents the internal trace.

### Trace reference (debug only)

The rest of this section documents the **internal object under `trace`**, obtained with `diagnostics: "trace"` or `stream --stream-output=detailed`. These raw fields are retained for debugging and old research tooling, not the default public schema. All old response excerpts below refer to `trace`. For native operations the raw result remains the direct response. CLI examples in earlier sections use the clean default; old exact field excerpts are trace excerpts.


Read the outcome first, then the journey or analysis data. Keep units, array ordering, and evidence provenance alongside the values when storing or displaying a result.

### Timing and metadata

Successful dispatch of Route, Matrix, Reach, and Native adds these fields. A computed blocked Route also receives them. Error objects use a separate envelope.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `vigo.standalone.result.v1` for these query families. Compare uses `vigo.standalone.comparison.v1`. It identifies the JSON interface, not the executable version. |
| `runtime` | `rust`. Use `capabilities` or `--version` for the executable version. |
| `cityRevision` | Revision of the City loaded by the process. Keep it with saved results; IDs and graph indices depend on the dataset. |
| `timing.totalMs` | Milliseconds inside query dispatch, including on-demand preparation and result construction. Excludes initial City load, process startup, final JSON serialization, HTTP queue/network time, and client parsing. |
| `timing.timetableSource` | Transit preparation path: `prepared_snapshot` for a matching compiled service timetable, or `source` for SQLite preparation. Retained on later requests that reuse that timetable. |
| `id` | Echoed by Stream and worker-dispatched HTTP queries when supplied. One-shot CLI results do not echo it; transport failures can omit it. |
| `warnings` | Source-provided routing limitations on some families. May be absent, null, or an array; an empty array does not certify the source dataset. |

The successful response is the result object itself, without a surrounding `data` property. Native is the exception in structure: its low-level object is inside `result`, alongside `operation`. JSON member order has no meaning. Accept additional fields; inspect the requested family before requiring fields that only exist on particular variants.

`serviceDate` and `dataMode` are included on transit Route results; they are not universal metadata. Reach echoes `serviceDate` (null for a walk-only query without one). Matrix does not echo the date, points, or requested clock. Store the request beside the response when you need reproducible interpretation.

### Response fields

| Family | Read next |
| --- | --- |
| Route, via, and windows | [Route output](#route-output): clocks, legs, waits, geometry, and variants |
| Matrix | [Matrix output](#matrix-output): row/column mapping, nulls, deadlines, and journeys |
| Reach / isochrone | [Reach output](#reach-output): raster cells, GeoJSON, nodes, and directed street arrays |
| Compare | [Comparison output](#comparison-output): signed differences and reachability changes |
| Diagnostics and Native | [Diagnostics and native output](#diagnostics-and-native-output): timing boundaries, raw clocks, and index domains |

### Computed outcomes and errors

| Response | Interpretation | Client handling |
| --- | --- | --- |
| Route `status: "ready"` | A journey was computed under the requested data and policy | Read `legs` or `segments`; display the returned `mode` |
| Route `status: "blocked"` | No admissible journey for that request | Read `reason`; journey fields can be absent |
| Matrix cell `null` | That pair has no finite duration under the request | Keep it null; exclude it from numeric averages |
| Reach cell `null` or empty evidence | No value was retained there in this computation | Do not convert to zero or infer a transport failure |
| An `error` object | The request or transport failed | Handle the error before reading result fields |

Do not require `kind` or `status` on every family. Route has `status` but does not uniformly carry `kind`; Matrix, Reach, and Compare have `kind` and no top-level Route status. Native has `operation`. HTTP `/v1/info` returns the startup City summary without per-query timing.

CLI failures exit 2 and write a JSON error on stderr:

```json
{"error":{"code":"invalid_request","message":"serviceDate (YYYY-MM-DD) is required for transit"}}
```

Public errors use `schema: "vigo.error.v1"` and `status: "error"`. Transport failures use codes such as `unauthorized`, `request_timeout`, `query_timeout`, and `service_unavailable`; read the code together with HTTP status. A public `not_found` Route exits 0 and uses HTTP 200. Stream puts per-line errors on stdout and can continue; errors have no normal result timing or City wrapper. See [HTTP status codes](#status-codes) for 400, 503, and 504 handling.

### Route output

A Route result describes one journey, a sequence through via points, or a sampled set of departure choices. Start with `status`, then select the variant by the presence of `segments` or `choices`.

#### Journey clocks and totals

For the [reference fixture route](#reference-fixture), the following is an exact selection of fields. Legs, diagnostics, and metadata are omitted:

```json output=route-summary
{
  "status": "ready",
  "mode": "transit",
  "departureMinutes": 475,
  "arrivalMinutes": 510,
  "durationMinutes": 35,
  "boardings": 2,
  "transfers": 1,
  "walkMinutes": 0,
  "rideMinutes": 25,
  "waitMinutes": 10
}
```

| Field | Meaning |
| --- | --- |
| `departureMinutes` | Journey start as minutes since the service-day midnight. Depart-at transit starts at the requested clock; arrive-by starts at the selected latest departure. |
| `arrivalMinutes` | Journey end on the same service-day clock. An arrive-by transit journey can finish before its deadline. |
| `durationMinutes` | `arrivalMinutes - departureMinutes`; an elapsed duration, not a clock. |
| `boardings` | Number of transit boardings in a materialized transit journey. |
| `transfers` | `max(boardings - 1, 0)` for transit; zero for a direct walk/drive. |
| `walkMinutes` | Time assigned to non-ride legs, including modeled access/transfer allowances; not a measurement of physical walking alone. |
| `rideMinutes` | Sum of ride-leg durations. |
| `waitMinutes` | Remaining journey time after walking and riding. Includes gaps before first boarding and between rides. |
| `departure`, `arrival` | Retained native service-day clocks in seconds on transit journeys. |
| `walkingSeconds`, `rideSeconds`, `waitingSeconds` | Native counterparts of the three minute totals. |

Here `475` is `07:55`, `510` is `08:30`, and `35 = 0 + 25 + 10`. Values can be fractional. Service-day clocks can exceed 1440 minutes: `1500` is `25:00` on the selected service day, not a Unix timestamp. Do not apply modulo 24 hours before retaining the date offset.

#### Read the leg sequence

Geometric walk legs retain the selected access cost. When that cost includes a
station connection, `accessCost.street` and `accessCost.station` separate their
distances and seconds; the station component includes directed stop IDs and
source names. A published transfer minimum is timing evidence, not an interior
walking-path witness. `stationAccessStatus: "unverified"` and
`streetPathVerified: false` retain that uncertainty. `streetSegmentVerified`
describes only the street portion. A source-backed pathway can report
`stationAccessStatus: "source_path"`. A fallback line between stops is never
labelled a verified OSM walk. `unverifiedStationAccessLegs` counts unresolved
station connections in the returned journey.

`legs` is ordered from origin to destination. The fixture route contains two zero-duration station-selection walk legs around two rides. **Waiting is represented by gaps between legs**, not separate wait legs:

| Step | Clock | Meaning |
| --- | --- | --- |
| Access | 07:55 → 07:55 | Selected stop A; no physical access walk was requested |
| Gap | 07:55 → 08:00 | Five minutes before first boarding |
| Ride T1 | 08:00 → 08:10 | A → X, ten minutes |
| Gap | 08:10 → 08:15 | Five minutes before the next ride |
| Ride T2 | 08:15 → 08:30 | X → B, fifteen minutes |
| Egress | 08:30 → 08:30 | Selected destination B |

This excerpt is the first ride, `legs[1]`. Other properties are omitted:

```json output=ride-leg
{
  "kind": "ride",
  "tripId": "T1",
  "routeId": "R1",
  "fromStopId": "A",
  "toStopId": "X",
  "departureMinutes": 480,
  "arrivalMinutes": 490,
  "durationMinutes": 10,
  "stopIds": ["A", "X"],
  "stopCount": 1,
  "geometrySource": "stop_sequence",
  "coordinates": [[-77.05, 38.9], [-77.04, 38.905]]
}
```

| Leg field | Meaning and presence |
| --- | --- |
| `kind` | `ride` or `walk` within transit; `walk` for a direct walk; `drive`, between optional `walk` legs to and from its roads, for a drive. |
| `from`, `to` | Materialized transit endpoint objects: `coordinate`, plus `stopId` and `name` when tied to a stop. Direct street legs omit these objects. |
| `fromStopId`, `toStopId` | String identifiers when an endpoint is a transit stop. Coordinate endpoints omit these fields. |
| `fromStop`, `toStop`, `trip` | Nullable indices into the active native timetable. They are not GTFS string IDs. |
| `tripId`, `routeId`, `route` | Ride identity and source route display metadata. `route` contains nullable `shortName`, `longName`, `type`, and `color`; it can itself be null. |
| `boardSequence`, `alightSequence` | Native connection-sequence values for reconstructing the ride. Do not treat them as offsets into `stopIds` or GTFS `stop_sequence`. |
| `stopIds` | Ride's stop sequence including boarding and alighting stops. |
| `stopCount` | Number of stop-to-stop segments: `stopIds.length - 1`. |
| `coordinates` | Ordered `[longitude, latitude]` pairs. These are JSON arrays, not an encoded polyline or a GeoJSON object. |
| `distanceMeters` | Geometry/path length when supplied. Ride distance is derived from the returned shape or stop sequence; it is not necessarily the operator's scheduled distance. |

To draw one leg as GeoJSON, use `{type: "LineString", coordinates: leg.coordinates}` when coordinates are available. Preserve separate legs and their provenance. Zero-length station-selection lines can be hidden in a map without removing their role from the itinerary.

#### Geometry and evidence

| `geometrySource` | What was returned |
| --- | --- |
| `gtfs_shape` | A source shape aligned and sliced between the selected stops |
| `stop_sequence` | A fallback line through stop coordinates, which need not follow the street or track |
| `osm` | A walking path found in the prepared street graph |
| `osm_and_station_path` | A street path joined to the selected station path |
| `gtfs_pathway` | A GTFS pathway transfer, drawn between the located stops |
| `stop_coordinate_fallback` | A transfer priced by a GTFS transfer rule, drawn between the stops |
| `station_selection` | Selected-stop endpoint connector; no street path was checked for that leg |
| `unverified_transfer` | A transfer line with no materialized path, including a link between platforms of one parent station |

Only transfers certified from OSM follow a street path; a parent-station link keeps its modeled time and a straight line. These labels apply to materialized transit legs. `streetPathVerified: true` identifies a graph-verified walking leg; false is explicit for the fallback labels. A drive's walk to or from its road is a straight `coordinate-snap` line with `streetPathVerified: false`. Ride legs do not use that flag in this version. Missing does not mean false. Graph verification does not establish wheelchair access, station-interior access, or fare eligibility.

Route always materializes geometry. Matrix journeys only add `coordinates`, `geometrySource`, and geometry-derived distances when `includeGeometry` is true. This changes detail, not whether the duration cell is reachable.

#### Direct, via, window, and blocked variants

Direct Walk results have a single street leg; Drive results have a drive leg, preceded or followed by a walk leg whenever an endpoint lies off its road. Both have `distanceMeters`, clocks, and `transfers: 0`. They omit transit totals such as `boardings` and `waitMinutes`. A transit request with `requireTransitRide: false` can return `mode: "walk"`; display the returned mode rather than the requested preference.

Via routes have ordered `segments` and a top-level duration spanning them. They do not have one flattened `legs` array or aggregate transfer/walk/ride totals. Segment objects omit the outer dispatch metadata. No visit duration is added at a via point.

Window routes have the selected journey at the top level and up to five retained alternatives in `choices`, ordered by arrival. `window.searches` counts sampled departure times, including unsuccessful and deduplicated searches; it is not the number of choices. Retained choices are not a continuous enumeration of every departure.

Reversing A → B to B → A in the fixture route produces this exact field selection:

```json output=blocked-route
{"status": "blocked", "mode": "transit", "reason": "no_path"}
```

`no_access` means one endpoint has no admissible transit candidates; `no_path` means no path was found under the query. Direct street arrive-by can return `before_service_day` if it would require a negative departure clock. Drive returns `no_drivable_road_within_walk` when an endpoint has no drivable road within `maxWalkKm`, and may return its native reason. A failed via route returns `via_leg_blocked`, a zero-based `legIndex`, and the blocked segment under `leg`. Do not read duration or geometry without a ready outcome.

### Matrix output

A Matrix result is indexed by the request's `origins` and `destinations`. Keep those arrays with the result: the response includes counts but does not repeat their labels or coordinates.

#### Rows, columns, and nulls

The [Matrix request](#8-matrix) uses origins `[A, X]` and destinations `[B, A]`. Its exact summary is:

```json output=matrix-summary
{
  "kind": "matrix",
  "mode": "transit",
  "originCount": 2,
  "destinationCount": 2,
  "durationsMinutes": [[35, null], [35, null]]
}
```

| | Destination B | Destination A |
| --- | --- | --- |
| Origin A | 35 minutes | Unreachable |
| Origin X | 35 minutes | Unreachable |

`durationsMinutes[1][0]` is X → B. Starting at X at 07:55 includes 20 minutes waiting and 15 minutes riding. The A → A cell is null because this transit query requires a ride and the fixture has no returning service. Do not fill the diagonal with zero by assumption.

Rows follow origins and columns follow destinations even for arrive-by. No symmetry is implied. `null` is an unavailable pair under these inputs, while numeric zero is a valid zero duration. Avoid truthiness checks such as `if (duration)`; use `duration !== null` and retain the count of excluded pairs when aggregating.

#### Depart-at and arrive-by durations

For transit, the high-level matrix converts native clocks as follows:

```text
depart-at: duration = (arrival clock - requested departure clock) / 60
arrive-by: duration = (requested deadline - latest departure clock) / 60
```

The clocks in these formulas are seconds. With A → B and an **08:40 arrive-by deadline**, the result cell is **40 minutes**: latest departure 08:00 to deadline 08:40. The included journey actually arrives at 08:30 and has **30 minutes** of elapsed journey time. Both values are intentional. The extra ten minutes are slack before the deadline, not another ride or a `waitMinutes` entry in the journey.

Walk/Drive matrices use their street travel durations. `distancesMeters` is a second two-dimensional array in the identical order. Transit matrices omit this distance array.

#### Journey detail

| Field / request | Returned detail |
| --- | --- |
| Transit `includeJourneys: false` | `journeys: null`; durations remain available |
| Transit `includeJourneys: true` | Two-dimensional `journeys[row][column]`; unreachable entries are null |
| `includeGeometry: false` | Transit clocks, legs, IDs, endpoints, and stop sequences without line geometry |
| `includeGeometry: true` | Geometry and provenance added to materialized transit legs |
| `journeyFormat: "compact"` | Exact timed trip/stop witness without full display or walking-evidence metadata; requires journeys and excludes geometry |
| Direct walking wins in a transit matrix | A `mode: "walk"` journey with a timed walking leg and walking totals; full journeys include geometry when requested |
| Walk/Drive matrix | Distances and durations; no `journeys` property. Journey flags are unsupported. |

Materialized transit journey cells have the [Route journey fields](#journey-clocks-and-totals), but no outer `status`, `mode`, or dispatch metadata. Read reachability from the duration cell and null journey entry. Do not parse every cell as a complete Route response.

`diagnostics.times` remains the native flat array of clocks in seconds. For the same cell, its native offset is `row * destinationCount + column`. It is not interchangeable with the high-level duration matrix, especially when a direct walk replaces a transit result.

High-level Route and Matrix diagnostics retain native clocks and search counters but set the nested native `journeys` to null. The complete materialized journeys are returned once in the high-level result. Use the explicit `native` operation `timetable.matrix` when raw native journey records are required.

### Reach output

Reach returns transit stop arrivals, a raster, area/contour GeoJSON, and optional street evidence. `surface.sampling` distinguishes reached street samples from routes to grid centers.

#### Main fields

| Field | Interpretation |
| --- | --- |
| `kind`, `mode`, `origin`, `serviceDate` | `reach`, transit/walk, the requested origin, and the requested date or null. Arrive-by Reach has `destination` and `timePreference: "arrive_by"` instead of `origin` |
| `cutoffsMinutes` | Sorted, deduplicated elapsed-time thresholds |
| `stops` | Transit-reached stops within the largest cutoff, with `stopId`, `name`, `coordinate`, and `durationMinutes`. Walk-only Reach returns an empty stop array even when streets are reachable. |
| `surface` | Grid dimensions, requested/full rasters, and optional street evidence |
| `areas`, `fullAreas` | GeoJSON MultiPolygon features for the requested/full raster respectively |
| `contours`, `fullContours` | GeoJSON MultiLineString features for the requested/full raster respectively |
| `diagnostics` | Separate transit-search and street-surface evidence |

Stop durations are elapsed minutes from the query clock. They are not clock minutes or final egress times. In arrive-by Reach they are minutes before the deadline, and raster values are the time a traveler must leave each place before it. Stop order follows the active timetable/planned-stop order, not increasing duration. Sort explicitly for a ranked list. Transit stops and raster cells need not have one-to-one coverage because the raster also depends on the prepared street graph.

#### Decode the raster

`surface.width * surface.height` equals `surface.values.length`. Index zero is at the northwest. X grows east and Y grows south. In street sampling, each finite value is the least elapsed time retained from sampled reached street intervals. In cell-center sampling, it is the Matrix travel time to the cell center. Neither promises a path to every point in the cell. Null means no finite value was retained under the query limits.

This client function reads a cell without confusing zero with null:

```js decoder=raster
function readCell(surface, x, y) {
  const { width, height, bounds, values } = surface;
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= width || y < 0 || y >= height) {
    throw new RangeError('Cell is outside the raster');
  }
  const [west, south, east, north] = bounds;
  return {
    index: y * width + x,
    coordinate: [
      west + (x + 0.5) / width * (east - west),
      north - (y + 0.5) / height * (north - south)
    ],
    durationMinutes: values[y * width + x]
  };
}
```

The coordinate is the cell center: a display location for street sampling and the queried destination for cell-center sampling. A cell belongs to a cutoff when its value is not null and is at most that cutoff. Keep the original floating-point value for analysis; round only for display.

For the full raster, pass `{...surface, bounds: surface.fullBounds, values: surface.fullValues}`. The full pair always exists in the high-level output; it falls back to the requested pair when no separate surface is produced. Both use the same dimensions. Recomputed bounds can be smaller or larger, so equal array indices need not refer to the same place. Changing bounds at fixed dimensions also changes cell size.

#### Areas and contours

Each collection has `type: "FeatureCollection"` and a `features` array. Each feature has `properties.cutoffMinutes` and one of these geometries:

| Geometry | Coordinate nesting |
| --- | --- |
| `MultiPolygon` | `coordinates[polygon][ring][vertex]` is `[longitude, latitude]`; ring zero is the exterior and later rings are holes |
| `MultiLineString` | `coordinates[line][vertex]` is `[longitude, latitude]` |

Area thresholds are cumulative, not disjoint bands. A 30-minute feature includes cells also reachable in 15 minutes; do not add their areas together. A cutoff with no generated geometry has no feature, so match features by `cutoffMinutes`, not by array position. An empty collection is valid.

Areas trace occupied raster cells; contours interpolate threshold crossings. They can differ along boundaries. Both are resolution-dependent representations, not surveyed travel boundaries. Reproject or use geodesic methods for area measurements rather than treating longitude/latitude degrees as meters. Preserve holes and disconnected components when rendering.

#### Decode directed street evidence

With `includeStreetEdges: true`, `surface.edges` uses `schemaVersion: "vigo.standalone.street-edges.v2"` and `encoding: "indexed-json"`. Without it, `edges` is null. An included but empty bundle has count zero and empty arrays.

| Bundle field | Domain and meaning |
| --- | --- |
| `count` | Number of retained directed interval records |
| `nodeCount`, `nodes` | Local coordinate table; `nodes.length = 2 * nodeCount` with longitude then latitude |
| `endpoints` | Two local node indices per edge: from, then to; length `2 * count` |
| `edgeIds` | Prepared directed graph edge IDs; length `count`. These are not local node indices or portable IDs across Cities. |
| `durationMinutes`, `fromDurationMinutes` | Elapsed times at the retained interval end and start |
| `startFractions`, `endFractions` | Interval limits along the directed edge, between zero and one |
| `walkDistanceM` | Walking distance accumulated from that label's seed through this edge, including snapping; not the full journey's walking distance or the edge length |
| `transitArrivalMinutes` | Elapsed arrival at the transit seed, measured from the query clock. `-1` identifies the direct-origin seed; it is not a negative arrival time. |

All measurement arrays have length `count`. Repeated edge IDs describe ordered, non-overlapping intervals; opposite directions are separate records. Interpolate coordinates between the referenced graph vertices using the interval fractions. For a smaller cutoff, clip an interval between its start and end times instead of dropping the whole interval.

In arrive-by Reach, times are minutes before the deadline and each interval runs from its end nearer the destination, so they still grow from `from` to `to` while the traveler walks the other way. `edgeIds` name the prepared edge walked, `transitArrivalMinutes` is the time before the deadline at the boarding stop, and `-1` identifies the destination seed. The decoder below reads both directions unchanged.

```js decoder=edge
function readEdge(bundle, i, cutoffMinutes = Infinity) {
  if (!Number.isInteger(i) || i < 0 || i >= bundle.count) {
    throw new RangeError('Edge is outside the bundle');
  }
  const point = node => bundle.nodes.slice(2 * node, 2 * node + 2);
  const from = point(bundle.endpoints[2 * i]);
  const to = point(bundle.endpoints[2 * i + 1]);
  const start = bundle.startFractions?.[i] ?? 0;
  const end = bundle.endFractions?.[i] ?? 1;
  const startTime = bundle.fromDurationMinutes?.[i] ?? bundle.durationMinutes[i];
  const endTime = bundle.durationMinutes[i];
  if (cutoffMinutes < startTime) return null;
  const clippedEnd = endTime <= cutoffMinutes ? end
    : start + (end - start) * (cutoffMinutes - startTime) / (endTime - startTime);
  if (clippedEnd <= start) return null;
  const coordinate = fraction => from.map((v, axis) => v + fraction * (to[axis] - v));
  const seed = bundle.transitArrivalMinutes[i];
  return {
    edgeId: bundle.edgeIds[i],
    coordinates: [coordinate(start), coordinate(clippedEnd)],
    durationMinutes: Math.min(endTime, cutoffMinutes),
    walkDistanceM: bundle.walkDistanceM[i],
    transitArrivalMinutes: seed === -1 ? null : seed
  };
}
```

Here the client deliberately converts the `-1` sentinel to null for display. The API array still contains `-1`. Retain `edgeIds` when comparing bundles from the same graph; local `endpoints` indices can change from one bundle to another. Check `diagnostics.surface.edgeEvidenceTruncated` before treating the records as exhaustive.

`surface.nodes` is a separate array of objects with `longitude`, `latitude`, `durationMinutes`, and `walkDistanceM`; it is not the coordinate table inside `edges`. With `includeNodes: false` it is empty. `includeNodes: true` retains up to 30,000 reached nodes and reports `diagnostics.surface.nodeEvidenceTruncated`. This diagnostic limit does not truncate the raster or street intervals.

### Comparison output

Compare operates on the requested `surface.values` grids from two saved Reach responses. It does not compare `fullValues`, GeoJSON areas, stop arrays, or individual street edges.

#### Signs and reachability

For a cell present in both grids, `deltaMinutes = after - before`. Negative means faster; positive means slower. The interpretation of null depends on both input cells:

| Before | After | Delta | Counted as |
| --- | --- | --- | --- |
| Number | Number | After minus before | `commonCells` |
| Null | Number | Null | `newlyReachableCells` |
| Number | Null | Null | `noLongerReachableCells` |
| Null | Null | Null | Neither reachable; no separate returned count |

An illustrative two-by-two grid makes the distinction concrete. These values are arithmetic examples, not measured network travel times:

```text
before = [10, null, 20, null]
after  = [ 8,   15, null, null]
```

The comparator returns these exact selected fields for those arrays:

```json output=comparison
{
  "kind": "compare",
  "schemaVersion": "vigo.standalone.comparison.v1",
  "sign": "after-minus-before",
  "commonCells": 1,
  "newlyReachableCells": 1,
  "noLongerReachableCells": 1,
  "meanChangeMinutes": -2,
  "deltaMinutes": [-2, null, null, null]
}
```

`meanChangeMinutes` averages common cells only; it is null if there are no common cells. It excludes both new and lost reachability. Never replace delta nulls with zero before averaging. The count unreachable in both is `width * height - commonCells - newlyReachableCells - noLongerReachableCells`.

#### Grid and provenance

The response carries `width`, `height`, and `bounds`; `deltaMinutes` uses the same northwest-first flat order as Reach. Input City revisions and requested grids must match. Fix `bounds` explicitly when running a baseline and scenario so cell positions stay comparable.

Keep both original requests and responses. The comparator verifies revision/grid/value compatibility but does not verify matching origins, dates, clocks, modes, cutoffs, or walking policies. Its outer `cityRevision` comes from the City loaded by the process; the input revision check only compares the two saved inputs. Verify those inputs also belong to the loaded City if you rely on the outer revision as provenance.

### Diagnostics and native output

Diagnostics explain the computation that ran. They are useful for troubleshooting and profiling, but the high-level result fields remain the values to show to clients.

#### Where diagnostics live

| Result | Diagnostic location |
| --- | --- |
| Transit Route | `diagnostics.originAccess`, `destinationAccess`, `search`, `native`, and `realtime` |
| Direct Walk/Drive Route | `diagnostics` is the corresponding native street/drive result |
| Transit Matrix | `diagnostics` is the native timetable matrix result |
| Walk/Drive Matrix | `diagnostics` is the native street/drive matrix result |
| Reach | `diagnostics.transit` and `diagnostics.surface`; transit is null in walk-only mode |
| Via Route | Per-segment diagnostics under `segments`; no aggregate top-level search diagnostic |

Transit Route search diagnostics report `startSeconds`, `endSeconds`, transfer policy, and `horizonScope: "timetable_scan"`. Endpoint access diagnostics explain selected-stop or coordinate candidate construction. `diagnostics.realtime` describes an applied supplied snapshot when present; a `dataMode` label is not an independent prediction-accuracy guarantee.

When a direct walk wins inside a transit request, the top-level route or matrix cell reflects walking while the native diagnostics still describe the transit search. Do not overwrite the returned high-level value with a diagnostic clock or duration.

#### Timing and counters

`queryNs / 1_000_000` converts a native query time to milliseconds. It measures a kernel scope inside dispatch; it is not network latency. Native searches, preparation, geometry materialization, and JSON construction can have different boundaries. Do not sum nested timings or subtract them to infer an isolated cost without checking their scope.

Timetable counters such as `scannedDepartures`, `expandedTripRuns`, and `relaxedStops` count algorithm work, not necessarily distinct trips or stops. Matrix `forwardSearches` and `reverseSearches` show execution orientation without changing row/column order. Reach `reachedPixels` counts finite cells on the requested grid; `reachedEdgeCount` and `reachedEdgeLengthM` count directed street edges, so two directions can represent the same physical road. They are not a geographic area measurement or a count of unique road centerlines.

#### Native result envelope and indices

Native responses contain `operation` and a typed object under `result`, plus outer dispatch metadata. The [native field reference](../reference/rust-standalone-native.md) lists every operation's input and output type. Native result fields are present even when their optional values are null; high-level variant fields can instead be absent.

Timetable operations use indices from `timetable.identifiers` for the same active service date and policy. `stopIds[index]` resolves a stop index; `tripIds[index]` and `routeIds[index]` resolve a trip and its route. `routeIds` is parallel to trips, not a deduplicated route catalog. `accessMemberStopIds` belongs to prepared endpoint-access members, a separate domain. Do not reuse saved numeric indices across changed preparations or timetable activations.

Native `timetable.matrix` returns a flat origin-major `times` array of **service-day clock seconds**. For one A → B pair, the fixture route's departure gives `[30600]`, an 08:30 arrival. Arrive-by gives latest departure clocks instead. `journeys` is null when not requested; an unreachable numeric slot serializes as null. Street and drive native matrices use flat distances in meters and, for drive, durations in seconds. Read the operation-specific type before interpreting an array named `times`, `values`, or `distancesM`.

## 14. Resident NDJSON streaming

Keep a City loaded while sending a sequence of JSON queries through standard input. Streaming returns one result for each request, in order.

One-shot commands open a City for each invocation. `stream` keeps a City resident and reads one object per line. Every line requires `kind`; an optional `id` is echoed even for query errors. Output is one compact JSON object per line, in input order, carrying the request `id` and a `sequence` number like the compiler's stream. Blank lines are ignored, and there is no startup handshake.

Transit can reuse a prepared service snapshot only when its source database, access policy, active services, transfer projection, dictionaries, and array layout validate. Missing or invalid optional timetable snapshots fall back to source preparation without writing City files. Realtime and disabled street transfers use source preparation. For repeated calls, keep `stream` or `serve` resident; measure fresh-process startup separately from warm query time. The runtime retains immutable shape/alignment data in a bounded cache (1,024 shapes and 64 MiB by default; configurable through `VIGO_SHAPE_GEOMETRY_CACHE_MAX_ENTRIES` and `VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES`) and shares same-request endpoint evidence even when answer caches are disabled. The shape limit is an upper bound, not reserved memory; it trades a larger possible resident footprint for less repeated geometry preparation.

Full Matrix journeys also share immutable ride and walking evidence within the request, bounded to 4,096 entries and 16 MiB of estimated storage. The key retains the selected endpoint candidates, stop/sequence identities and walking cost; each occurrence keeps its own service clocks. Geometry is unchanged. This storage is discarded after the matrix, including when the query fails. Disabling request caches does not disable this sharing inside one batch.

```ndjson
{"kind":"route","id":"trip-1","origin":{"stopId":"A"},"destination":{"stopId":"B"},"serviceDate":"2026-07-15","time":"07:55","maxWalkKm":0.2}
{"kind":"reach","id":"area-1","origin":{"stopId":"A"},"serviceDate":"2026-07-15","time":"07:55","cutoffsMinutes":[30],"rasterSize":48,"extentRadiusKm":2}
```

```sh
./vigo stream --city ./city < requests.ndjson > results.ndjson
```

Route, Matrix, Reach/isochrone, Compare, Native, Info, and Capabilities use the same dispatcher. The process retains the latest active timetable; a different service date is allowed and replaces that timetable. This differs from the older Node stream's fixed-date process. Malformed JSON/invalid queries produce per-line errors and the next line can run. A line exceeding 8 MiB terminates the stream. Stream has no query deadline or supervised restart; use HTTP or your own process supervisor for those guarantees. Close stdin to end it.

## 15. HTTP API and server operation

Start the HTTP service with `vigo serve` and send query JSON to the endpoints below. The command line and HTTP API use the same request fields.

### Endpoints

| Method/path | Response | Authentication |
| --- | --- | --- |
| `GET /`, `/docs`, `/docs/` | The offline VIGO guide, including this manual and an API console | Public static content |
| `GET /openapi.json`, `/docs/openapi.json` | OpenAPI specification | Public static content |
| `GET /healthz` | 200 liveness, status ready/recovering | Public, no City data |
| `GET /readyz` | 200 ready, 503 while recovering | Public, no City data |
| `GET /v1/capabilities` | Runtime features and compatibility | Bearer when configured; otherwise local Host/Origin |
| `GET /v1/info` | Loaded City summary | Bearer when configured; otherwise local Host/Origin |
| `GET /v1/realtime` | GTFS-RT polling status | Bearer when configured; otherwise local Host/Origin |
| `POST /v1/route` | Route request/result | Bearer when configured; otherwise local Host/Origin |
| `POST /v1/matrix` | Matrix request/result | Bearer when configured; otherwise local Host/Origin |
| `POST /v1/reach`, `/v1/isochrone` | Reach request/result | Bearer when configured; otherwise local Host/Origin |
| `POST /v1/compare` | Saved Reach comparison | Bearer when configured; otherwise local Host/Origin |
| `POST /v1/native` | Typed native operation | Bearer when configured; otherwise local Host/Origin |
| `DELETE /v1/requests/{id}` | Cancel a named request | Bearer when configured; otherwise local Host/Origin |

The path selects the command; a body `kind` is overwritten accordingly. Send JSON with `Content-Type: application/json`. Content-Length and bounded chunked HTTP/1.1 bodies are supported. Duplicate/conflicting length headers are rejected. Connections close after a response; there is no keep-alive, WebSocket, HTTP/2, gzip, streaming response, or browser CORS policy in the service. Other methods/paths return 404 after authentication. A same-origin application or reverse proxy can provide a browser integration policy. Every response carries a restrictive `Content-Security-Policy`; it allows the embedded guide's API console to call this service's own endpoints (`connect-src 'self'`) and nothing else.

### Server limits

The executable runs an HTTP front end and a supervised child worker. The worker keeps one City loaded and processes one query at a time; individual queries can use native parallel kernels. Slow request bodies are read outside that worker. Queue deadlines include waiting and writing to the child. A timed-out or failed worker is stopped and replaced. The service holds no per-client session.

| Server option | Default | Allowed range |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Literal IPv4/IPv6 address; not a hostname |
| `--port` | `PORT`, otherwise 8080 | 0–65535; zero selects an ephemeral port |
| `--max-body-bytes` | 8388608 | 1024–8388608 |
| `--request-timeout-ms` | 10000 | 50–60000; absolute request read deadline |
| `--query-timeout-ms` | 30000 | 1–600000; queued/dispatched computation |
| `--max-connections` | 32 | 2–256 |
| `--max-queue` | 8 | 0–128 waiting jobs |
| `--realtime-poll` | None | GTFS-RT polling settings file; see [Automatic GTFS-RT polling](#automatic-gtfs-rt-polling) |

Queued HTTP requests retain encoded JSON; only the worker expands nested query fields. Across connections, uploads and queued requests share a 64 MiB encoded-byte admission budget (including normalization headroom). Chunked uploads reserve their configured maximum before reading. Pending response buffers share a 128 MiB budget until socket writes finish. Capacity exhaustion returns 503, including before `100 Continue` for rejected uploads. These bounds cover transport buffers, not total process RSS or the City working set; response reading can additionally hold one worker result of up to 64 MiB. Closing, canceling, or expiring a request releases its reservation when its retained work is discarded.

Waiting routes and matrices of at most 1,024 cells receive up to 32 turns or 250 ms of worker time before the oldest waiting analytical request. FIFO order is preserved within each group, and one admission limit covers both groups. This prevents a submitted batch of Reach jobs from monopolizing the waiting queue. The worker completes its current query before switching; a long running query still contributes to latency.

Headers are limited to 16 KiB and 64 header entries. Worker output is limited to 64 MiB per result. Response writing has a 10-second deadline; startup allows up to 60 seconds for a City worker. Oversized responses or worker exits can appear as 504, so split high-detail matrices/rasters rather than retrying the same oversized query indefinitely.

### Cancel a request

A named HTTP request (`id` containing up to 128 letters, digits, hyphens, underscores or periods) can be canceled through `DELETE /v1/requests/{id}`. The cancellation returns 202; the original request returns 499. Running work is terminated and its worker replaced; queued work is skipped. Retrying an ID while it is active returns 409.

### Status codes

| HTTP status | Meaning |
| --- | --- |
| 200 | Computed result, including blocked Route; or successful metadata/documentation |
| 400 | Invalid query, JSON, or HTTP framing |
| 401 | Missing/incorrect bearer token |
| 403 | Without a token: request not addressed to a loopback name, or a browser `Origin` other than the service's own |
| 404 | Unsupported path or method |
| 408 | Request read deadline |
| 409 | A request with the same `id` is still active |
| 413 | Request body over limit |
| 417 | Unsupported Expect header |
| 431 | Header byte limit |
| 499 | The request was canceled through `DELETE /v1/requests/{id}` |
| 503 | Connection/queue/buffer capacity or worker unavailable; readiness also uses this |
| 504 | Query deadline, worker failure, or response-channel failure |

The service logs its listening address to stderr. Health routes avoid the computation queue but still share the connection limit. A failed accept or connection setup, such as descriptor exhaustion, drops that connection and the service keeps listening; accept failures pause briefly before the next attempt. If a replacement City worker fails to start, the first failure of each streak is logged with its reason, `/readyz` returns 503 and queries return 503 while restarts back off exponentially from 250 ms to at most 10 seconds. Use bounded retries with backoff for 503; for 504 first reduce the workload or inspect worker logs. Do not treat a transport error as an unreachable trip.

## 16. Authentication and generic deployment

Start locally with a prepared City directory. For remote access, configure an API token and put the service behind an HTTPS proxy.

### Environment and authentication

The environment variables for the Rust runtime are:

| Variable | Purpose |
| --- | --- |
| `VIGO_CITY` | Default prepared City path; overridden by `--city` |
| `PORT` | Default HTTP port; overridden by `--port` |
| `VIGO_API_TOKEN` | Bearer token; nonempty values protect data endpoints, including loopback |
| `RAYON_NUM_THREADS` | Optional native parallel thread count |
| `VIGO_MAX_RESIDENT_SCENARIOS` | Maximum resident scenario views |
| `VIGO_RESIDENT_HEAP_BYTES` | Collection retained-heap budget; default min(1 GiB, detected memory / 3), positive integer |
| `VIGO_TIMETABLE_CACHE_BYTES` | Inactive scheduled-timetable budget per City or collection; default 134217728 bytes, `0` disables retention |
| `VIGO_ENDPOINT_CACHE_MAX_BYTES` | Shared endpoint-cache budget |
| `VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES` | Shared geometry-cache budget |

A non-loopback bind requires a token at least 16 characters long. Set it through your deployment secret mechanism and send `Authorization: Bearer ...`. Without a token, a loopback service accepts data requests only when `Host` is `127.0.0.1`, `localhost` or `[::1]` (with an optional port) and any `Origin` header is that same `http://` origin; other requests return 403 `forbidden`. This blocks DNS-rebinding and cross-site browser requests, as in Studio. Clients that send a different `Host`, such as a local reverse proxy, should set `VIGO_API_TOKEN`. The static manual/specification and health endpoints remain public; they contain no query or City data. The token is not a CLI argument and the service does not persist tokens or query bodies.

```sh
export VIGO_CITY=/srv/vigo/city
# Set VIGO_API_TOKEN through your shell or platform secret store.
./vigo serve --host 0.0.0.0 --port 8080 \
  --query-timeout-ms 30000 --max-queue 8 --max-connections 32

curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H "Authorization: Bearer $VIGO_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @route.json
```

Terminate HTTPS at a reverse proxy or hosting platform. Give its upstream timeout room for the chosen query deadline plus request/response transfer. Mount City data read-only and set process/container memory and CPU limits according to measured workloads. Scale with multiple service processes/containers, each with its own resident collection and bounded query queue. There is no globally shared queue, distributed cache, tenant management, or server-side request persistence.

### Container

Build the native service image from the repository root:

```sh
docker build -f deploy/Dockerfile -t vigo:1.0.0-rc.1 .
export VIGO_IMAGE=vigo:1.0.0-rc.1
export VIGO_CITY=/absolute/path/to/prepared-city
# Set VIGO_API_TOKEN through your deployment secret store.
docker compose -f deploy/compose.yml up -d --wait
```

The image runs as UID/GID 65532 on Debian glibc, with the native executable and its embedded documentation. Compose mounts the City read-only and defaults to 2 CPUs, 2 GiB, a bounded query queue, bounded caches, and limited log storage. The built-in `vigo health` command checks worker readiness without loading a City or requiring an external runtime. Give UID 65532 read and traversal access to the City.

See [Deploy the routing engine](../guide.md#deploy-the-routing-engine) for the complete configuration and container acceptance check.

### Process manager

For a generic Linux host, install the matching binary and configure an unprivileged service account, readable City directory, and protected environment file. A systemd unit can use:

```ini
[Unit]
Description=VIGO Rust routing service
After=network.target

[Service]
User=vigo
Group=vigo
EnvironmentFile=/etc/vigo/runtime.env
ExecStart=/opt/vigo/vigo serve --host 127.0.0.1 --port 8080
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

Set `VIGO_CITY` and, when desired, `VIGO_API_TOKEN` in the environment file. Stop the service through the process manager so its worker is also cleaned up. Allow active requests to finish before stopping; queued requests may be interrupted during shutdown.

## 17. Client integration

Send query JSON from your application through HTTP or the command line. An HTTP client needs no VIGO language package.

Use the standalone response fields described in [Results and errors](#13-public-results-and-diagnostics). The public Node and Rust result schemas are shared; old internal envelopes are retained only in trace. For reproducible jobs, keep the build identity, `capabilities`, City revision, complete request, observation timestamps, and output.

A Python standard-library HTTP client needs no VIGO Python package:

```python
import json
import os
import urllib.error
import urllib.request

query = {
    "origin": {"stopId": "A"},
    "destination": {"stopId": "B"},
    "serviceDate": "2026-07-15",
    "time": "07:55",
    "maxWalkKm": 0.2,
}
headers = {"Content-Type": "application/json"}
if os.environ.get("VIGO_API_TOKEN"):
    headers["Authorization"] = "Bearer " + os.environ["VIGO_API_TOKEN"]
request = urllib.request.Request(
    "http://127.0.0.1:8080/v1/route",
    data=json.dumps(query).encode(), headers=headers,
)
try:
    with urllib.request.urlopen(request, timeout=45) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    raise RuntimeError(error.read().decode()) from error
if result.get("status") == "not_found":
    print("No journey:", result.get("reason"))
else:
    print(result["journey"]["arrivalTime"], result["journey"]["legs"])
```

A JavaScript client can use `fetch` with an AbortSignal timeout. Read the HTTP status before interpreting JSON; its successful body can still be a blocked result. Keep bearer tokens in server-side integrations or an appropriate authenticated same-origin service. Do not embed a shared deployment token into publicly served application code.

## 18. Native operation reference

Call the routing kernels directly when you need packed arrays or controls exposed by a native operation.

Use `vigo native --city ./city --request kernel-query.json` or `POST /v1/native`. Supply `operation`, `input`, and a service date for timetable operations. Native indices must belong to the loaded City and active service date. The HTTP API never accepts a filesystem path inside a query.

```json query=native
{
  "operation": "timetable.identifiers",
  "serviceDate": "2026-07-15"
}
```

`timetable.identifiers` returns `stopIds`, `tripIds`, `routeIds` (one per active trip), and `accessMemberStopIds`. An index is its position in the corresponding array. Resolve each active timetable's IDs before building numeric requests. Cumulative offset arrays start at zero, end at the associated packed-array length, and have one more entry than their group count. Parallel arrays must have equal compatible lengths; indices and times are validated by the kernels.

An ordinary street path uses coordinates and needs no numeric timetable IDs:

```json query=native
{
  "operation": "street.path",
  "input": {
    "originLon": -77.05,
    "originLat": 38.9,
    "destinationLon": -77.03,
    "destinationLat": 38.91,
    "maximumDistanceM": 5000,
    "maximumPoints": 512
  }
}
```

Native timetable `departure`, `horizon`, `earliest`, and `deadline` are absolute **service-day seconds**. High-level `horizonMinutes` is a duration; native `horizon` is an end clock. `maximumBoardings` counts vehicle boardings, so it equals a high-level transfer cap plus one. Access walk times and transfer arrays are seconds, distances are meters. Drive traffic weights use hundredths of seconds. Native output suffixes such as `queryNs` retain nanoseconds and must not be relabeled milliseconds.

Native Matrix returns a flat array of **clock times in seconds**: arrival clocks for depart-at, departure clocks for arrive-by. High-level Matrix returns a two-dimensional array of **travel durations in minutes**. Both use origin row order and destination column order. Unreachable native times are serialized as null.

`timetable.pareto` exposes native arrival/boarding/walking trade-offs; it is distinct from sampled departure windows. Native overlays operate on packed caller-supplied arrays. `realtime.compile` compiles explicit effective call times; it does not fetch/decode a provider feed. The native field reference lists every public operation and nested input/result type from the Rust definitions. Optional request fields may be omitted or set to null. Native result objects include every declared field; unavailable optional values are null. The runtime also enforces semantic limits and compatible array domains.

The complete generated dictionary is in [Native Rust field reference](../reference/rust-standalone-native.md). It is also part of the offline guide and the engine archive.

## 19. Troubleshooting

| Symptom | Check and next action |
| --- | --- |
| Executable cannot run | Match OS/CPU target; on macOS/Linux retain executable permissions |
| `--city or VIGO_CITY is required` | Set a prepared City directory, including for Compare |
| `Expected a prepared vigo.city.v1 City` | Point to the compiler's complete output with `network.json` |
| Missing/stale access or CCH artifact | Rebuild/copy the whole City using a compatible compiler; do not mix artifacts from different builds |
| Unexpected SQLite WAL | Complete/checkpoint the source build and copy a consistent immutable City |
| Unknown stop ID | Use exact scoped IDs from the active City; do not use display names |
| Route blocked | Check service date/clock, active calendar, direction, endpoint access, transfer cap/buffer, and walk limit |
| Empty or small Reach | Check largest cutoff, service availability, walk budget, raster extent, and street coverage; distinguish null from zero |
| Bad comparison grid | Recompute both queries with identical explicit bounds and raster size; preserve other experimental settings |
| Realtime not changing the route | Inspect diagnostic rejection counts, source time, static trip identity/date, and effective predictions |
| HTTP 401 | Set matching `VIGO_API_TOKEN`; send exactly one Bearer header |
| HTTP 503 | Read readiness; reduce concurrent work/queue pressure or add measured capacity |
| HTTP 504 | Inspect worker logs; reduce matrix size, geometry, raster detail, or split jobs before increasing deadlines |
| Browser request fails | Check same-origin/proxy configuration; native service does not implement CORS |
| Unsupported request field | Check this manual or the OpenAPI document; Studio's internal fields and compiler-only flags are not interchangeable |
| High memory | City size, worker replication, Rayon threads, concurrent request bodies, and detailed results all contribute |

Do not use repeated cached-query timing as a cold-start measurement. `disableCache` leaves loaded City data, prepared artifacts, OS page cache, and other resident state in place. Measure invocation-to-result or client request-to-response explicitly when reporting those boundaries.

## 20. Validation and compatibility

Use `vigo capabilities` to inspect the executable you are running. The standalone interface has its own request and response schemas; the table below describes its supported operations.

### Supported operations

| Operation | Modes and coverage |
| --- | --- |
| Route and Matrix | Transit, walk, and drive; depart-at and arrive-by |
| Reach | Transit, walk, and drive; driving uses a fixed grid with polygons and contours, without pedestrian street evidence |
| Scenarios | Reach with exclusions, explicit schedules, or compiled overlays |
| Realtime transit | Route, Matrix and Reach; supplied or polled, with Service Alerts |
| Supplied traffic | Drive Route and Matrix |
| Saved comparison | Reach surfaces |

City compilation, Studio/Python response envelopes, fare annotations, fare optimization, and Studio route-preference presentation are outside the standalone interface. Prepare editor branches and automatic retiming as explicit schedules or overlays before querying. Native Pareto operations are available separately.

### Platform and build records

The packaged [test record](../reference/rust-standalone-audit.md) reports the macOS ARM64 run. CI defines runtime checks for Linux x64/ARM64, macOS ARM64, and Windows x64; use the completed results for the exact build and target you deploy. Linux containers and Windows binaries were not executed in the recorded local audit. The Docker and systemd examples are deployment recipes, not additional test results.

`manifest.json` records the target, source commit, uncommitted-change flag, source digest, and file hashes. Packages built from uncommitted source are marked `dirty: true` and remain development artifacts. Keep the manifest with deployments so a result can be traced to its executable and source.

### Run the checks

The adapter tests use public synthetic GTFS/OSM fixtures and compare outputs with the existing public CLI. Separate graph and timetable oracles check the shared kernels. These tests cover modeled routing behavior; source-feed completeness, field arrival accuracy, station accessibility, and deployment capacity require their own validation.

```sh
cargo test --manifest-path crates/vigo-runtime/Cargo.toml \
  --no-default-features --features standalone
cargo clippy --manifest-path crates/vigo-runtime/Cargo.toml \
  --no-default-features --features standalone --all-targets -- -D warnings
VIGO_STANDALONE_PATH=/absolute/path/to/vigo npm run check:standalone
python3 test/check-standalone-package.py /absolute/path/to/package.tar.gz
npm run docs:standalone
npm run check:standalone-docs
```

The documentation check verifies the generated guide and specification, links and contracts, and the executable JSON examples. Packaging validates every archive member and payload hash and reruns the adapter suites against the extracted binary. Node/Python are used for development validation only.

### Update the documentation

For maintenance, edit this Markdown source. `npm run docs:standalone` regenerates the OpenAPI document and the native field reference from the Rust public structs, and `npm run docs:build` rebuilds the guide that the executable embeds. Check generated files before packaging so the embedded documentation describes the same executable.


## Wheelchair routing

Prepare a separate wheelchair City with the preparation CLI:

```sh
vigo build --gtfs feed.zip --osm region.osm.pbf --output wheelchair-city --wheelchair
```

The Engine CLI and HTTP service use that City for Route, Matrix and Reach. Add
`"wheelchair": true` to the request, or `--wheelchair` to an Engine CLI query.
Omitting the option inherits the City's profile. Ordinary Cities reject a true
request; wheelchair Cities reject false, Drive, realtime transit and query-time
scenario overlays. Expanded-walking choices are suppressed for this profile,
including when the wheelchair flag is omitted. Compile changed inputs into a
new wheelchair City.
Serve the prepared wheelchair City using the same `serve --city wheelchair-city`
command and authenticated `/v1/route`, `/v1/matrix` and `/v1/reach` endpoints.

Studio's Route settings also expose **Wheelchair routing**. Prepare a separate
wheelchair City from the exact GTFS ZIP and OSM PBF imported into your Studio City,
then attach it from the source checkout:

```sh
node scripts/attach-studio-wheelchair.mjs /path/to/Studio-City /path/to/wheelchair-city
```

Restart Studio after attaching or replacing the network. Attachment checks the
source fingerprints and profile, preserves the ordinary City, and retains any
previous wheelchair network as a backup. Studio currently supports this profile
for single-feed, scheduled Route queries without via points or scenario overlays;
use the Engine CLI for wheelchair Matrix and Reach. Unknown accessibility is
excluded. A missing, incomplete or source-mismatched wheelchair network returns
an error; it never silently substitutes an unrestricted route. The option does
not certify elevator operation or access between a building and the street.

The `wheelchair-strict-v1` profile requires GTFS `wheelchair_accessible=1` for
vehicles and `wheelchair_boarding=1` for boarding/alighting, including published
parent inheritance. An accessible vehicle can pass an inaccessible stop without
boarding or alighting. Unknown values are excluded. Search considers accessible
alternatives directly, including later vehicles; it does not filter a completed
unrestricted journey.

OSM ways require `wheelchair=yes` and ordinary pedestrian permission. Steps,
escalators, mapped inaccessible or limited nodes, raised kerbs, unverified
barriers and conditional accessibility are excluded. Published widths below
0.9 m and inclines above 8.3% are excluded. Untagged shape vertices inherit the
way's accessibility. These are fixed profile limits, not a personalized chair
model.

Station paths require either a positive published `wheelchair_traversal_time`
(the MBTA extension) or step-free mode with published width at least 0.9 m,
slope at most 0.083 in magnitude and a traversal cost. Elevator paths do not
require slope. Explicit stairs and escalators remain excluded even if a
contradictory wheelchair time is present. Direction is preserved. Missing paths
do not generate parent-station shortcuts. Generic transfer recommendations do
not establish accessible paths. For transit access, station platforms are reached from declared
accessible entrances and paths, rather than snapped directly from the street.

Every successful or no-route response carries `accessibility`, including the
profile and its limitations. Coordinate-to-network attachments are geometric;
door-to-street access is not verified. Live elevator outages, temporary barriers
and individual chair dimensions are not modeled. Strict source requirements
can leave sparse coverage or no route. A no-route result is not evidence that
no accessible real-world trip exists.

Source semantics: [GTFS Schedule](https://gtfs.org/documentation/schedule/reference/),
[MBTA pathways](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md#pathwaystxt),
and [OSM wheelchair tags](https://wiki.openstreetmap.org/wiki/Key:wheelchair).
The public synthetic regression is `npm run check:wheelchair`; it checks
accessible alternatives through both CLIs and authenticated HTTP, as well as
Matrix, Reach, reverse routing and profile mismatch rejection.

### Native planner integration

Clients can request `journeyPolicy: "alternatives-v1"` on transit Route. Capabilities
exposes `route.journeyPolicies`; deployment checks should require this value before
switching an adapter. The policy returns the ordinary `vigo.route.v1` journey and
alternatives, preserving direct transit and a permitted direct walk. It orders by
arrival (departure for arrive-by), then walking and boardings. Journeys sharing the same boarding/alighting stations, modes and walking policy
are bundled; GTFS parent-station identifiers determine station membership. Do not combine it with explicit alternatives, windows or via
points. Arrive-by retains a 15-minute earlier-arrival window sampled every five minutes.

`expandedWalkKm` is explicit permission for a wider transit-access search; omit it
when the user sets a binding walking limit. A wider choice must beat every
ordinary choice on the time objective by at least one minute (earlier arrival,
or later departure for arrive-by); walking farther for a shorter but later
journey is not offered. In supported windows, a choice whose final ride, with
its wait, reaches the destination later than walking on from where the
previous ride ends is replaced by that walk, when the walk fits the wider
budget and arrives at least a minute sooner. Wider choices carry
`expandedWalkingLimitKm`. A whole-trip walk uses at most
`maxWalkKm` unless `allowLongWalk` explicitly permits `maxStreetKm`. Limits below
50 metres do not trigger a widened street query. `requireTransitRide` excludes
walking-only choices. Optional wider-search failures preserve ordinary results.

Use `sharedLegs: true` for native single-leg substitutions and observed departure
frequency. Missing or truncated frequency evidence must remain unknown; it is not
a zero headway or a complete route-wide schedule. The client remains responsible
for labels, rendering, authentication, cancellation, deadlines and bounded caching.
The policy consolidates HTTP requests; it still performs bounded searches inside
the resident Rust engine and is not a claim of one algorithm traversal.

### Batched place names

`POST /v1/native` accepts `{"operation":"places.describe","input":{"longitudes":[-71.06],"latitudes":[42.36]}}`. The result contains parallel `labels` and `kinds` arrays in input order, with null entries when no nearby label is available. Batches are limited to 256 coordinates. This uses the same native place index as Studio: optional prepared OSM naming tables and GTFS stops, without an external geocoder. A label is descriptive and does not change the routing coordinate or establish accessibility.
