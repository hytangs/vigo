# VIGO 0.5.2 guide

The canonical source for the [VIGO guide](guide.html), a single offline page that also includes the [engine reference](guides/rust-standalone.md), [Results](reference/results.md), [VIGO Python](../python/docs/guide.md), and [developer resources](developer.md#developer-resources). Edit a chapter here, then run `npm run docs:build`.

## Build a network. Answer a transport question.

VIGO 0.5.2 turns GTFS timetables and OpenStreetMap streets into a reusable City, then answers three questions about it: how to make a journey, how long every trip takes, and how far people can get. It runs on your own machine, explains each answer, and never needs an internet connection to route.

### Start here

- **[Build your first City](#quickstart)** Download Boston's public timetable and streets, build a City, and plan a trip from Harvard Square to South Station.
- **[Install VIGO](#install-vigo)** Pick the engine, the City compiler, the desktop Studio, or the Python package.
- **[Serve an HTTP API](guides/rust-standalone.md#15-http-api-and-server-operation)** Answer Route, Matrix, and Reach requests from one executable with no runtime dependencies.
- **[Analyze in Python](../python/docs/guide.md)** Run batches and notebooks against a City, then export journey and leg tables.

### Three questions, one City

| Query | It answers | Read more |
| --- | --- | --- |
| **Route** | How do I travel between these places, and what happens on the way? | [Route](#route) |
| **Matrix** | How long does each origin–destination pair take? | [Matrix](#matrix) |
| **Reach** | Where can I get within 15, 30, or 45 minutes? | [Reach](#reach-and-isochrones) |

A **Scenario** changes the service one query sees, such as a new line or a removed route, so you can measure a proposal against today's network. **Compare** sets two saved Results side by side without routing again.

### Choose your interface

| Interface | Best for | What it needs |
| --- | --- | --- |
| **Engine** (`vigo`) | Queries, resident streams, and the HTTP API | One native executable; no Node, Python, or network access |
| **Compiler** (`vigo.mjs`) | Building Cities and scenario collections; it can also query them | Node.js 24.18 or newer and its bundled native kernel |
| **Studio** | Inspecting service, planning journeys, and exploring Reach and scenarios | The desktop application and its own project library |
| **Python** (`import vigo`) | Studies, batches, notebooks, and journey tables | A platform wheel with a headless engine |

The engine, the compiler, and Python open the same City directories. For the same City and request, the engine and the compiler return the same public JSON Result.

### Built to be explained

Every answer carries its evidence. A Route Result says whether each walk follows mapped streets or a schematic station link. A Matrix keeps unreachable pairs `null`, never zero. A Reach surface records its grid so that two runs can be compared cell by cell. [Known limits](#known-limits) state plainly what the model does not establish.

- **Stable data.** Cities built with VIGO 0.5 stay readable by later releases without rebuilding. See the [prepared-data contract](reference/format-0.5.0.md).
- **Stable results.** The public `vigo.route.v1`, `vigo.matrix.v1`, and `vigo.reach.v1` schemas only gain optional fields. See [Read a Result](reference/results.md).
- **Offline by default.** Queries never fetch anything. This guide works offline too: press `/` to search, and open saved Results in the [Result viewer](#inspect-a-saved-result).

### What's new in 0.5.2

Route can return several journeys at once with `alternatives`. The engine and the compiler now return the same Result for the same request, including fares and walking connections. Studio saves journeys and comparisons as JSON, GeoJSON, CSV, or Markdown. Read the [release notes](releases/0.5.2.md) and the [changelog](../CHANGELOG.md).

## Install VIGO

VIGO has four entry points. Most projects use two of them together: the **compiler** builds a City once from raw data, and the **engine** answers queries from that City for as long as you like.

| You want to | Install | Requirements |
| --- | --- | --- |
| Query a prepared City or serve HTTP | Engine archive (`VIGO-Rust-…`) | Nothing else at query time |
| Build Cities from GTFS and OSM | Compiler archive (CLI) | Node.js 24.18 or newer |
| Explore networks visually | VIGO Studio | The desktop application |
| Script analyses and notebooks | VIGO Python | Python and the wheel for your platform |

Download archives from [VIGO releases](https://github.com/hytangs/vigo/releases). Each archive targets one operating system and CPU; City data moves freely between the supported 64-bit targets.

### Engine

Extract the engine archive and check the executable:

```sh platform=unix
./vigo --version
./vigo capabilities --pretty
```

```powershell platform=windows
.\vigo.exe --version
.\vigo.exe capabilities --pretty
```

The executable contains the routing kernels, the City loader, the JSON interface, the HTTP server, and SQLite. It needs no compiler, Node, Python, browser, or internet connection to answer a query. The archive also contains this guide, the OpenAPI document, the [engine manual](guides/rust-standalone.md), an audit record, licenses, and a `manifest.json` that hashes every file.

### Compiler

The compiler archive contains `vigo.mjs`, its matching native routing kernel, license notices, and a checksum manifest. Keep `vigo.mjs` and `vigo-routing-kernel.node` in the same directory, then check it with Node.js 24.18 or newer:

```sh
node vigo.mjs --version
node vigo.mjs capabilities
```

The compiler builds Cities and scenario collections, and runs Route, Matrix, Reach, Stream, and Compare against them. It does not bundle Node or City data. The same steps ship inside the archive as its [README](guides/cli-only.md).

### Build from source

Use Node.js 24.18 or newer, npm 11.6 or newer, the Rust toolchain pinned in `rust-toolchain.toml`, and a C toolchain for the bundled SQLite. Build natively on the operating system and CPU that will run VIGO:

```sh
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build:cli-runtime
npm run build:standalone
```

`build:cli-runtime` produces the compiler, `public/vigo.mjs`, and its native kernel. `build:standalone` produces the engine at `native/vigo-routing-kernel/target/release/vigo`. `npm run build` additionally compiles Studio, and `npm run studio` opens it.

### Name the commands

The guides call the engine `vigo` and the compiler `vigo-build`. In a POSIX shell:

```sh
alias vigo="/absolute/path/to/vigo"
alias vigo-build='node "/absolute/path/to/vigo.mjs"'
```

From a source checkout, point them at `native/vigo-routing-kernel/target/release/vigo` and `public/vigo.mjs`. On Windows, use `.\vigo.exe` and `node .\vigo.mjs`, or define your own functions. Both commands accept `--name value` and `--name=value` and reject unknown options.

### Studio and Python

**VIGO Studio** is the desktop workspace. It imports GTFS and OSM into its own project library and opens this guide offline under **Settings → Documentation**. See the [Studio guide](#vigo-studio-desktop-guide).

**VIGO Python** is versioned separately. Install the wheel for your platform, then follow [your first Python query](../python/docs/guide.md#your-first-python-query).

### Supported platforms

- macOS 13.5 or newer on Apple Silicon, Linux with glibc on ARM64 and x64, and Windows x64. Linux release builds use Ubuntu 24.04. There are no 32-bit or native Windows ARM64 binaries.
- The engine container image runs on Debian with glibc. See [Deploy the routing engine](#deploy-the-routing-engine).
- Studio maps require WebGL 2. The engine, the compiler, and Python need no graphics device.

## Quickstart

In about ten minutes you will build a City for **Boston and Cambridge** from public data, then plan a journey from **Harvard Square to South Station**, compute a small matrix, and map where you can reach in 45 minutes. A **City** is the prepared data directory, here `./boston`.

You need the [engine and the compiler](#install-vigo), named `vigo` and `vigo-build`, plus `curl`, `unzip`, and [Osmium Tool](https://osmcode.org/osmium-tool/manual.html). The commands use a POSIX shell; on Windows, use WSL for the download and extract steps.

> [!TIP]
> Every request below works with either runtime. Replace `vigo` with `vigo-build` to run a query through the compiler instead; the Result is the same.

### 1. Download the Boston inputs

Two files supply different parts of a journey:

| Data | Official source | What VIGO uses it for |
| --- | --- | --- |
| MBTA static GTFS ZIP | [MBTA GTFS documentation](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md), [download ZIP](https://cdn.mbta.com/MBTA_GTFS.zip) | Stops, trips, calendars, transfers, fares, and transit shapes |
| Massachusetts OpenStreetMap PBF | [Geofabrik Massachusetts](https://download.geofabrik.de/north-america/us/massachusetts.html), [download PBF](https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf) | Streets for walking access, egress, transfers, walking, and driving |

No API key is needed. Choose the **static GTFS ZIP**, not GTFS-realtime, and the **`.osm.pbf`**, not a shapefile or GeoPackage.

```sh
mkdir -p boston-tutorial/data
cd boston-tutorial
curl --fail --location --retry 3 --output data/MBTA_GTFS.zip \
  https://cdn.mbta.com/MBTA_GTFS.zip
curl --fail --location --retry 3 --output data/massachusetts-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf
unzip -p data/MBTA_GTFS.zip feed_info.txt
unzip -p data/MBTA_GTFS.zip calendar.txt
```

`feed_start_date` and `feed_end_date` give the published interval. The feed checked for this tutorial covers **2026-09-25 through 2026-12-12**, and the examples use Monday **2026-10-05**. With a later download, choose a date inside its interval and check `calendar.txt` and `calendar_dates.txt`: a date inside the interval does not mean every route runs that day. Times are local MBTA service times in `America/New_York`.

### 2. Build the City

Cut a smaller street extract around central Boston and Cambridge, then build:

```sh
osmium extract --bbox=-71.20,42.25,-70.95,42.45 --strategy=complete_ways \
  data/massachusetts-latest.osm.pbf --output=data/boston.osm.pbf
vigo-build build --gtfs ./data/MBTA_GTFS.zip --osm ./data/boston.osm.pbf \
  --output ./boston --prepare-date 2026-10-05
vigo info --city ./boston --pretty
```

The [complete-ways strategy](https://docs.osmcode.org/osmium/latest/osmium-extract.html) keeps every node of the ways crossing the rectangle. This extract covers the tutorial's places, **not street access for the whole MBTA network**; for a wider study, enlarge it or pass the full Massachusetts PBF. `--prepare-date` precompiles that day's timetable so that a fresh engine process can reuse it. Keep the providers' notices when you share data; see [OpenStreetMap attribution](https://www.openstreetmap.org/copyright).

VIGO writes one complete `./boston` directory and leaves an existing output alone unless you pass `--replace`. `vigo info` confirms the City's name, revision, sources, and warnings. Keep the whole directory: the inspection output identifies the City but contains no routing data.

### 3. Plan a journey

Save `route.json`. Coordinates are **[longitude, latitude]**:

```json
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
vigo route --city ./boston --request route.json
vigo route --city ./boston --request route.json --output route-result.json
```

In a terminal, the first command prints a short itinerary. The second saves the full JSON Result. To ask when to leave to **arrive by 09:00**, override the clock and time direction:

```sh tab="Engine"
vigo route --city ./boston --request route.json --time 09:00 --arrive-by
```

```sh tab="Compiler"
vigo-build route --city ./boston --request route.json --time 09:00 --time-preference arrive
```

Command-line flags override fields in the request file. In JSON, the same choice is `"time": "09:00", "timePreference": "arrive_by"`, which both runtimes accept.

### 4. Read the Result

Read `status` first. `ok` contains a `journey`; `not_found` is a valid answer meaning no journey satisfies the date, walking limit, transfer cap, and time horizon you asked for. Then read `journey.departureTime`, `journey.arrivalTime`, and the ordered `journey.legs`. Clocks are local service-day `HH:MM:SS`; durations are integer seconds.

Trip IDs and times depend on the feed you downloaded, and this is scheduled routing without live delays. Check `warnings` and each walk's `quality` before treating a path as a passenger-facing guarantee; [walking evidence](reference/walking-evidence.md) explains station costs and schematic links. Open `route-result.json` in the [Result viewer](#inspect-a-saved-result) to see the journey as a timeline.

### 5. Compute a matrix

Save `matrix.json`. The rows are **Harvard Square** and **Kendall Square**; the columns are **South Station** and **Copley Square**:

```json
{
  "origins": [
    {"id": "harvard", "coordinate": [-71.11902, 42.37334]},
    {"id": "kendall", "coordinate": [-71.08618, 42.36249]}
  ],
  "destinations": [
    {"id": "south-station", "coordinate": [-71.05524, 42.35227]},
    {"id": "copley", "coordinate": [-71.07758, 42.34997]}
  ],
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "maxWalkKm": 1.2,
  "maxTransfers": 3,
  "includeJourneys": true
}
```

```sh
vigo matrix --city ./boston --request matrix.json --output matrix-result.json
```

Read `durationsSeconds[origin][destination]` in request order, and the matching `journeys` entry when requested. An unreachable pair is `null`, never zero. Repeated origins or destinations share work internally, and every requested cell is still returned.

### 6. Map where you can go

Save `reach.json` to find the streets and areas reachable from Harvard Square within 15, 30, and 45 minutes:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48
}
```

```sh
vigo reach --city ./boston --request reach.json --output reach-result.json
```

`surface.valuesSeconds` is a row-major raster from the northwest corner, and `areas` holds GeoJSON polygons for each cutoff. A Reach surface describes modeled travel time; it is not a count of jobs or people. See [Reach](#reach-and-isochrones) for resolution, sampling, and comparison rules.

### 7. Keep the City loaded

One-off commands open the City every time. For repeated work, keep one process resident. Save `queries.ndjson` with one request per line:

```jsonl
{"id":"harvard-south-depart","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"serviceDate":"2026-10-05","time":"08:00","maxWalkKm":1.2,"maxTransfers":3}
{"id":"harvard-south-arrive","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"serviceDate":"2026-10-05","time":"09:00","timePreference":"arrive_by","maxWalkKm":1.2,"maxTransfers":3}
```

```sh
vigo stream --city ./boston < queries.ndjson > results.ndjson
```

Each output line echoes its `id`; check every `status`, because one failed line does not end the stream. To serve applications over HTTP, start the engine's service and call it from a second terminal:

```sh
vigo serve --city ./boston --port 8080
curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H 'Content-Type: application/json' --data-binary @route.json
```

Open `http://127.0.0.1:8080/` to read this guide from the running service, and send requests from the [API console](guides/rust-standalone.md#15-http-api-and-server-operation) at the end of the HTTP API page. When you measure performance, keep the City build, a fresh process's first answer, and requests to a resident process separate.

### Where next

- **[Practical workflows](#work-with-a-city)** Arrival deadlines, pairwise journeys, and a complete baseline-versus-Scenario comparison.
- **[Core concepts](#core-concepts)** City, Scenario, Query, Result, outcomes, and time.
- **[HTTP API](guides/rust-standalone.md#15-http-api-and-server-operation)** Endpoints, limits, status codes, and authentication.
- **[Troubleshooting](#troubleshooting)** Build failures, blocked routes, time semantics, and stale observations.

## Core concepts

VIGO has four nouns and three questions. Once these are clear, every interface behaves the way you expect.

```text
GTFS + OSM ──build──▶ City ──(optional Scenario)──▶ Route | Matrix | Reach ──▶ Result
```

### City

A City is a compiled mobility model built from GTFS and OSM. It is one complete directory, so its timetable, streets, and prepared query data cannot drift apart. Rebuilding from new source data creates a new City revision; existing Scenarios and Results stay tied to the revision that produced them. `revisionId` identifies the immutable build, `builtAt` records when it was made, and `sources` records the GTFS and OSM inputs.

A built City reopens without its raw GTFS or OSM files. Building prepares the street indexes and station-access state. The first query for a new set of active services prepares a timetable snapshot that later processes can reload; dates with the same active services share it, and `--prepare-date` creates it ahead of time. A new process still loads the files into memory, while a resident process keeps them ready.

Prepared files are tied to the source revision, routing policy, and format. Missing, stale, or incompatible timetable and access caches are rebuilt from the compiled City without importing raw sources again. Required street files must remain complete: restore or rebuild a City with missing or corrupt street indexes. Updating the underlying GTFS or OSM data requires a new build.

### Scenario

A Scenario is an immutable set of changes applied to one City revision. Planned service changes apply to Reach. Supplied traffic applies to Drive Route and Drive Matrix, and a supplied realtime snapshot applies to transit Route; requests carry these as `scenario`, `traffic`, and `realtimeSnapshot`. Walking limits, departure times, and cutoffs remain query options. A complete alternative GTFS source is a new City revision, not a Scenario.

VIGO rejects unsupported combinations before computing. It never silently drops a change or moves a Scenario to a newer City revision. See [Scenarios](#scenario-semantics).

### Query

| Query | What it computes | Notes |
| --- | --- | --- |
| Route | Travel between ordered points, with legs, transfers, and walking | Depart-at or arrive-by; waypoints, alternatives, and departure windows are Route options |
| Matrix | Scalar travel time between sets of origins and destinations | A single origin is a one-row Matrix; journeys are optional |
| Reach | Where the network can take you within stated time limits | Shown as reached streets, areas, or contours |

Depart-at minimizes arrival time, then boardings, then walking. Arrive-by maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, walking, and actual arrival.

Reach is not accessibility. An accessibility measure also needs opportunities such as jobs, people, schools, or health care, and a stated way to combine them.

### Result

A Result is the immutable answer to one Query: status, values, warnings, timing, the City revision, the Scenario if any, and the query output. Compare is an action on two compatible Results, not a fourth query. Keep the original request and the full Result together; the normalized `query` echo is useful for inspection but is not a complete archive of every option or supplied observation. See [Read a Result](reference/results.md).

### Choose a supported combination

| Query | Travel mode | Time constraint | Supplied changes or observations |
| --- | --- | --- | --- |
| Route | Transit | Depart-at or arrive-by; waypoints and departure windows have their own limits | Matched GTFS-RT Trip Updates when realtime is explicitly selected |
| Route | Walk or Drive | Street routing with the chosen time direction | Supplied traffic for Drive in realtime mode |
| Matrix | Transit | Fixed departure or arrival deadline | Scheduled timetable only |
| Matrix | Walk or Drive | Static street metric; arrive-by does not introduce time-varying traffic | Supplied traffic for Drive in realtime mode |
| Reach | Transit with walking, or Walk | Fixed departure and time cutoffs | Planned-service Scenario; scheduled analysis |

`vigo capabilities` describes the running build. Queries default to scheduled mode. Drive traffic needs both the `traffic` object and an explicit `routingDataMode: "realtime"`; VIGO never fetches a traffic provider. A visible vehicle, alert, or added trip is not itself a routing update.

### Outcomes

- Public Route and Reach Results use `ok` or `not_found`. A completed Matrix is `ok`, with `null` for unreachable cells.
- Invalid or unsupported requests fail with an error and a nonzero exit code, or HTTP 4xx. Execution failures are errors too, never analysis Results.
- Python Results use `ready` and `blocked`; those names belong to the Python API.
- Studio background tasks report `queued`, `running`, `ready`, `cancelled`, or `error`.

### Time

Service dates use the City's timetable timezone. A GTFS event at `25:10` belongs to the service date it was published on, even though it happens after midnight. Request clocks may exceed 24 hours, so always supply the exact service date with the clock. Realtime observation timestamps are a separate clock used only to admit or reject predictions.

VIGO keeps Build, Open, Compute, and End-to-end durations separate. Reusing an open process is useful runtime behavior; it does not hide or replace query computation.

## Work with a City

These recipes start from the [quickstart](#quickstart) City, `./boston`, and its coordinates. Each JSON block is a complete request to save under the filename shown. Replace the date with one your feed covers.

### Choose a query

| Question | Use | Read |
| --- | --- | --- |
| How can someone make this journey? | Route | Timed legs, transfers, walking, and access qualifications |
| When must people leave to reach one place by a deadline? | Arrive-by Matrix | Per-pair duration and departure; optional actual journey arrival |
| Where can someone travel within a time budget? | Reach | Grid values and areas at the chosen cutoffs |
| How would a proposed service change that reach? | Baseline Reach, Scenario Reach, then Compare | Time changes and newly or no-longer-reachable cells |
| What are the live feeds reporting now? | Studio Network | Observation time, coverage, predictions, and source identity |

The [support table](#choose-a-supported-combination) shows which modes and supplied states each query accepts.

### Explain one journey

Save `journey.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.08337, 42.32978]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "mode": "transit",
  "maxWalkKm": 1.2
}
```

```sh
vigo route --city ./boston --request journey.json --output journey-result.json
```

Check `status`, then the chronological `journey.legs`. Walking competes with transit, so a short trip can return a walk; set `requireTransitRide: true` to require a boarding, or `"mode": "walk"` to request walking alone. A `not_found` Result can reflect the date, timetable, access network, or constraints. It does not mean the places are physically disconnected; [Troubleshooting](#route-returns-no-journey) lists the checks in order.

For several journeys at the requested time, add `"alternatives": 3`. The default `pareto` ranking keeps only genuine trade-offs between arrival, boardings, and walking; `"alternativeRanking": "ranked"` lists the earliest distinct journeys even when one beats another in every respect. See [alternative journeys](guides/rust-standalone.md#alternative-journeys) and [journey windows](guides/rust-standalone.md#journey-windows).

### Reach one destination by a deadline

Save `arrival-matrix.json`:

```json
{
  "origins": [
    {"id": "harvard", "coordinate": [-71.11902, 42.37334]},
    {"id": "central", "coordinate": [-71.1035, 42.3654]}
  ],
  "destinations": [
    {"id": "destination", "coordinate": [-71.08337, 42.32978]}
  ],
  "serviceDate": "2026-10-05",
  "time": "09:00",
  "timePreference": "arrive_by",
  "includeJourneys": true
}
```

```sh
vigo matrix --city ./boston --request arrival-matrix.json --output arrival-matrix-result.json
```

Every pair shares the deadline. `durationsSeconds[origin][destination]` runs from the latest feasible departure to the deadline, so it can include waiting at the destination; the matching `journeys` entry gives the actual modeled departure, arrival, walking, waiting, and transfers. Set `includeJourneys` to `false` when only times are needed. A shared destination and deadline share one reverse search, and a shared origin and departure share one forward search. Split larger jobs by shared time and options; see [Matrix](#matrix) for limits.

### Test a planned service change

Save `baseline-reach.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "maxWalkKm": 1.2,
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48
}
```

Save `alternative-reach.json` with the same origin and surface settings plus a Scenario:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "maxWalkKm": 1.2,
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48,
  "scenario": {
    "id": "direct-service",
    "name": "Illustrative direct service",
    "services": [{
      "operation": "add",
      "name": "Direct service",
      "stops": [
        {"label": "Origin", "coordinate": [-71.11902, 42.37334]},
        {"label": "Destination", "coordinate": [-71.08337, 42.32978]}
      ],
      "headwayMinutes": 10,
      "startMinutes": 420,
      "endMinutes": 600,
      "averageSpeedKph": 20
    }]
  }
}
```

The speed, headway, and operating span are illustrative. The example uses the defaults of bidirectional service, distance-estimated timing, and 0.35-minute dwell. It does not establish a drivable alignment, achievable running time, vehicle requirement, or service plan; [Scenarios](#scenario-semantics) explains how to specify a real proposal.

Run both, then compare the saved Results with the compiler:

```sh
vigo reach --city ./boston --request baseline-reach.json --output baseline-result.json
vigo reach --city ./boston --request alternative-reach.json --output alternative-result.json
vigo-build compare --before ./baseline-result.json --after ./alternative-result.json \
  --output ./reach-change.json
```

Compare uses the retained surfaces. `counts` splits cells reachable in both into faster, slower, and unchanged, and counts newly and no-longer-reachable cells separately; a negative `meanChangeSeconds` means faster modeled travel among the comparable cells. Read all the counts together. A larger area is not a population benefit: an accessibility study also needs opportunity data, a spatial assignment method, and an explicit measure. The engine's `vigo compare` takes both Results in one request; see [Compare saved Reach results](guides/rust-standalone.md#11-compare-saved-reach-results).

### Investigate live service

In Studio, start in **Network**: check the observation time and reporting coverage, then choose a route in **Routes**. Compare scheduled and predicted events at the same stop, and inspect a vehicle's position separately from its stop-time predictions. With a connected model, the service briefing can interpret the retained evidence; its explanation remains subject to review.

Use **Route → Realtime** to query supported, matched predictions. A vehicle on the map, an alert, or an added trip in **Trip times** does not by itself make that service available to routing. See [Network and Routes](#network-and-routes) and [realtime admission](#realtime-journey-routing).

For a reproducible analysis, use an exact date and time in Scheduled mode. For an incident review, retain the observation, identity, coverage, and Result from the original investigation. [Read a Result](reference/results.md#keep-a-reproducible-run) covers both.

## Build a City

A City is compiled once by `vigo-build` and then opened read-only by any number of engine processes, Python sessions, or compiler queries. This chapter covers inputs, build options, and the life cycle of a City. The [quickstart](#quickstart) shows a complete Boston build.

### Choose inputs

| Input | Requirement |
| --- | --- |
| GTFS | One or more **static GTFS ZIP** files. Repeat `--gtfs` for several feeds and give each a stable `--gtfs-scope`; see [multiple feeds](#combine-timetables-and-live-feeds). |
| OSM | One **`.osm.pbf`** covering every origin, destination, stop access, and transfer location you will query. |

Keep the original files, their checksums, and their acquisition date. Download URLs such as `latest` are not frozen datasets. [GTFS support](developer.md#gtfs-support-matrix) lists the source features VIGO reads and the ones it reports as unsupported.

### Build options

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf --output ./city
vigo-build inspect --city ./city
```

| Option | Effect |
| --- | --- |
| `--prepare-date YYYY-MM-DD` | Precompile a service date's timetable; repeat for other dates |
| `--street-modes walk` | Build walking only and omit all driving data |
| `--private-access endpoints` | Allow mapped private paths at trip endpoints; see [authorized endpoint access](#authorized-endpoint-access) |
| `--wheelchair` | Build a strict wheelchair City; see [wheelchair routing](guides/rust-standalone.md#wheelchair-routing) |
| `--streets-from ./other-city` | Reuse identical immutable streets from a prepared City |
| `--replace` | Replace an existing output; without it, an existing City is left alone |

Build is staged: a failed build preserves the previous City, and `--replace` restores the previous directory if publication fails. A successful replacement removes its temporary backup, so use a separate output directory when you need a rollback copy.

Raw import and street preparation happen at build time and are separate from query latency.

### Large regions and low memory

Builds use disk-backed SQLite temporary work and compact numeric node lookups, report progress during long import phases, and respect container memory limits when deciding whether GTFS and OSM compilation may overlap. Import and native street preparation run in separate processes, so each stage releases its working memory before the next. Keep the output and temporary directory on a local filesystem (inside WSL, prefer the Linux filesystem to `/mnt/c`), and leave space for the source database, temporary sorts, and the finished City.

Regional native CCH preprocessing can still exceed 2 GiB without swap. Configure disk-backed swap for the build machine, or build on a larger machine and copy the complete City to the server: build memory and query memory are separate requirements. Street preparation must write the walking accelerator before the graph is sealed, so a City that could not open is never published.

### Copy and load a City

A City contains `network.json`, `routing/project.sqlite`, prepared access artifacts, and an `osm` directory with street snapshots, access profiles, and CCH indexes. Exact member names can vary with the preparation version. Copy the **whole directory**, never just the SQLite files or the manifest.

The engine checks source identities, snapshot formats, station and access profiles, and required CCH members. It rejects blocking source features, missing or stale preparations, and an unexpected SQLite WAL. Complete a City through its compiler; do not delete WAL files to bypass validation. The engine reports `timing.timetableSource: "prepared_snapshot"` when it reuses a prepared timetable and `"source"` when it prepared one from SQLite for that process. Both use the same schedule.

### Update a network

Treat a published City as immutable while any process has it open. Compile updates into a new directory, start another service against it, verify readiness and a known query, switch traffic, and then stop the old service. The engine has no upload endpoint, source downloader, or hot reload. See [Upgrade and rollback](#upgrade-and-rollback) for version changes.

### Scenario collections

When you compare several timetables over one street network, build a scenario collection: one shared street graph, several transit scenarios, and a default. See [Shared scenario collections](guides/rust-standalone.md#shared-scenario-collections) for the source manifest and residency rules.

## Combine timetables and live feeds

A City can contain several static GTFS feeds and several GTFS-Realtime endpoints. Static feeds supply the scheduled network; live feeds supply observations and predictions for it and never replace the timetable.

### Build a City from multiple GTFS files

In Studio, open **City → Data sources** and add each GTFS ZIP. VIGO imports each source, then builds the combined routing store. Add an overlapping OSM PBF for walking, driving, and coordinate-based transit access, and wait for preparation to finish before querying.

With the compiler, repeat `--gtfs` and give each input a stable, unique scope:

```sh
vigo-build build \
  --gtfs ./rail.zip --gtfs-scope rail \
  --gtfs ./bus.zip --gtfs-scope bus \
  --osm ./region.osm.pbf \
  --output ./city
```

A scope identifies a **source feed**, not a route number. The merged store namespaces stops, routes, trips, services, and transfer references so identical IDs in different feeds cannot overwrite one another. Use the same scope names when you rebuild the same sources. Removing a source in Studio rebuilds the surviving combined store.

Before combining feeds:

- Use compatible service dates. A trip is usable only when its own calendar and exceptions activate it for the requested service day.
- Keep agencies in one timezone. Cross-timezone routing stores are rejected.
- Avoid importing two editions of the same agency timetable as separate networks unless that duplication is intentional.
- Retain declared transfers and verify street coverage. Close coordinates alone do not prove a usable station connection.

### Connect multiple GTFS-RT endpoints

1. Open **City → Data sources → GTFS-RT live feeds**, or feed settings in **Network**.
2. Paste an endpoint URL and choose what it contains. A combined endpoint may contain several entity types.
3. Select its matching **Timetable** when the City has several static sources.
4. Choose **Add feed** for each additional endpoint, then **Connect live**.
5. Expand **Feed status** to inspect individual failures and freshness.

Live-feed requests use `{ "sources": [{ "url": "https://operator.example/trip-updates.pb", "kind": "tripUpdates" }] }`. The old top-level `url` and `urls` formats are rejected; reconnect those saved connections through the feed editor. A single MBTA endpoint no longer implicitly enables the other two.

Trip Updates can be connected without Vehicle Positions. The MBTA preset fills three public endpoints; select the MBTA timetable when you use it in a combined City. A failed endpoint does not discard successful ones. Reimporting or merging a timetable invalidates the retained observation until a fresh fetch binds to the new City, and old records from a failed endpoint are not carried into a new snapshot.

| Data | What VIGO uses it for |
| --- | --- |
| Trip Updates | Supported predictions and cancellations in transit Route; trip and station inspection |
| Vehicle Positions | Reported map locations, vehicle details, and qualified service observations |
| Alerts | Scoped notices and evidence; text does not automatically close a route |

Studio allows up to **16 distinct endpoints**. Repeated URLs for the same timetable are fetched once, and assigning one URL to conflicting timetables is rejected. A refresh has a 30-second overall deadline, a 20 MB per-feed limit, and a 40 MB combined limit. Batches also reject more than 200,000 entities or 500,000 stop predictions. At most four downloads run concurrently, and oversized or failed sources are disclosed individually.

The declared type is descriptive: every supported entity present in the protobuf is decoded. A source timestamp and timetable identity travel with each record. Unscoped IDs match only when unambiguous; a bare trip ID never resolves by choosing the first agency.

### Supply observations to the engine

Neither command-line runtime opens feed URLs. A Route request can carry a retained, normalized `realtimeSnapshot` with `routingDataMode: "realtime"`. In a combined City, each record can carry `sourceScope` equal to its build scope, alongside the original `tripId`, `sourceFeedTimestamp`, service date, and stop predictions. A single-source City uses raw GTFS IDs; omit `sourceScope` there. The [realtime input reference](guides/rust-standalone.md#12-realtime-transit-and-supplied-traffic) lists every record field.

Keep source timestamps intact. Changing a capture's timestamps to make it look current changes the input and is not a replay of that observation. A repeated snapshot ages out of the routing cache.

## Route

Route finds and explains travel between ordered points. This chapter describes how Route behaves; the [Route request reference](guides/rust-standalone.md#6-route) lists every field and default.

### Inputs

A Route query selects:

- an origin, optional ordered waypoints, and a destination;
- transit, walk, or drive;
- an exact service date and local time;
- depart-at or arrive-by;
- a walking limit, an optional maximum number of transfers, and the objective;
- optional alternatives or a departure window;
- optional supplied observations supported by the selected mode.

Stop IDs are exact GTFS identifiers. Coordinate points are `[longitude, latitude]` and need streets in the City.

### Walking and transit

Transit Route and Matrix compare a direct OSM walk by default, so a short coordinate trip can return walking when it arrives sooner. Set `requireTransitRide: true` to require at least one boarding, or select Walk mode to request walking alone. `maxWalkKm` limits each access and egress walk. Set `allowLongWalk: false` to apply the same limit to a direct walking alternative; otherwise `maxStreetKm` bounds the complete walk.

`horizonMinutes` sets the timetable search horizon (default 480, range 1–2880). For depart-at transit, boarding and alighting must happen at or before this boundary, including in alternative journeys; the final walk can finish after it. The horizon is therefore not a hard limit on door-to-door duration: comparisons with a total-duration cap must check the final arrival separately.

`allowStreetTransfers` (default `true`) controls walking connections between separate stops or stations. Turn it off to change vehicles only at the same stop or between members of one station, as identified by the GTFS station hierarchy. The engine removes cross-station walking edges before searching, including for arrive-by, realtime, and departure-window searches; access to the first stop and egress from the last remain available. Studio exposes this as **Route options → Allow walks between stations or stops**. It does not certify station-interior paths or free-transfer eligibility.

`disableCache: true` disables street-access frontier and walking-path caches while keeping the prepared City resident. Route answers are recomputed either way. The same flag applies to the wider access probes used to explain a blocked Route.

### Transfers and time reserves

`maxTransfers` accepts integers from 0 to 31: `0` permits one boarding and `1` permits two. Omit it for no additional cap. Staying aboard the same trip is not a transfer. The cap constrains the native search, including alternatives and arrive-by, so a slower feasible route is found when the unrestricted winner exceeds it. A finite cap with ordered transit waypoints is unsupported.

`minimumTransferBufferMinutes` (integer 0–60, default 0) adds time before each subsequent boarding, after any transfer walk and the feed's own minimum transfer time. It is charged once per transfer, including a change at the same stop, and never delays the first boarding, the final egress, or staying aboard. `arrivalBufferMinutes` plans an arrive-by query against an earlier deadline. Both are timetable feasibility constraints, not delay predictions; see [Time reserves](#travel-time-uncertainty).

The engine adds no implicit boarding buffer. Same-stop changes honor published GTFS minimum transfer times and forbidden transfers. Explicit transfer edges keep their durations without an added margin or a 60-second floor, and a published platform-to-platform transfer rule takes precedence over the station walking fallback.

### How a journey is chosen

VIGO's objective is `earliest_arrival`. Equal-arrival journeys prefer fewer boardings, then less walking, then a stable final order; there is no undefined "balanced" preference. Arrive-by first maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, then walking, then actual arrival. A slightly later on-time arrival can therefore avoid unnecessary transfers.

If the reverse boundary cannot be materialized at first, the engine reconstructs a forward witness at the same departure from the complete access frontier. A remaining mismatch is a query error; an earlier feasible departure is never reported as the latest. An independently verified direct walk may dominate the reverse transit bound.

Ordered transit routes can walk any segment, including the whole journey. Selection compares complete journeys by arrival (or latest departure), then boardings and walking, so a later walk to a waypoint can replace a short ride when both catch the same onward vehicle. Up to eight partial journeys are retained at each waypoint and up to five complete choices are returned; this bounded search does not enumerate every itinerary. `requireTransitRide: true` requires a ride on every segment.

### Alternatives and windows

`alternatives` (0–9) asks a depart-at transit Route for more journeys at the requested time; both runtimes return the same list. A departure window instead samples nearby departures: the engine's `windowMinutes` searches later departures or earlier deadlines, while the compiler's `departureWindowMinutes` (±0–30) is a centered depart-at profile. Sampled windows are not continuous timetable profiles. See [Alternatives, via points, and departure windows](guides/rust-standalone.md#7-alternatives-via-points-and-departure-windows).

### Result and diagnostics

The public `vigo.route.v1` Result contains `status`, a `journey` with chronological legs and durations in seconds, `warnings`, `quality`, and `meta`. A `not_found` Result is a completed answer with `journey: null` and an access reason when one is known. [Read a Result](reference/results.md) defines every public field.

For a detailed diagnosis, request `diagnostics: "trace"` and read the internal result under `trace`. Access failures carry endpoint-specific `accessAvailability`:

- `outside_selected_budget`: an access candidate exists at a larger walking limit. The suggested limit does not guarantee a complete itinerary; `streetPathVerified` records whether its path was verified.
- `street_access_unverified`: nearby stops exist, but the bounded street search did not verify access. `nearestStop.distanceKind: "straight_line"` describes proximity, not walking distance.
- `none_within_probe`: no access candidate was found within `probeWalkKm`. This is a bounded result, not proof of disconnection at every distance.
- `diagnostic_unavailable`: the explanatory probe failed, reported as `access_diagnostic_unavailable`.

The diagnosis never raises the walking allowance by itself. Blocked plans keep `searchLimits` for walking, horizon, transfers, and the transit-ride requirement, including `horizonScope: "timetable_scan"`. `no_path` means no scheduled itinerary under those constraints on the selected date; changing a constraint requires a new query.

### Stations, access, and geometry

Anonymous coordinate endpoints and physical GTFS stops use the same nearest-street attachment in Route and Matrix. A parent station does not provide free movement between all its platforms. Declared station paths keep their direction and time; their complete time and distance frontier is prepared once and then filtered against each endpoint's remaining walking budget. Interior pathway nodes do not create extra street entrances.

When GTFS omits `traversal_time`, the walking policy prices the declared pathway length, or the distance between stop coordinates if length is also absent. Stairs with a stair count and fare or exit gates use labeled estimates described in [walking evidence](reference/walking-evidence.md), floored by any available walking distance. A missing time is never a zero-time link. Endpoint walks that use a station path expose `accessCost.street` and `accessCost.station` separately, including directed `stopIds` and source types; this supports a source-data audit, not certification of physical station access.

The walking limit covers each complete, continuous access or egress walk; a transfer walk cannot extend the final egress beyond that budget. Street transfers use declared entrances and directed station pathways, composed around at most one external transfer edge. A repeated station in a ride sequence is reported but not rejected, because a scheduled loop or a forbidden platform change can require it.

A coordinate that snaps to the street graph can carry an `endpointConnector` on its first or last walking leg. Its coordinates and distance describe the snap already included in the leg's cost, with `source: "coordinate-snap"` and `streetPathVerified: false`. A connector is not evidence of a mapped or legally traversable street. For geometry materialization and identifier internals, see [itinerary geometry](developer.md#itinerary-geometry-and-identifiers).

## Matrix

Matrix calculates travel time between sets of origins and destinations in one request, from a shared departure time or to a common arrival deadline. Request journeys only when you need their steps. The [Matrix request reference](guides/rust-standalone.md#8-matrix) lists every field.

### Send a matrix request

```json
{
  "origins": [{"id": "home", "stopId": "A"}],
  "destinations": [{"id": "work", "stopId": "B"}],
  "serviceDate": "2026-10-05",
  "time": "08:30",
  "timePreference": "arrive_by",
  "mode": "transit",
  "includeJourneys": false
}
```

Replace `A` and `B` with exact stop IDs in your City, or use `"coordinate": [lon, lat]` points; Walk and Drive matrices require coordinates. The [quickstart](#5-compute-a-matrix) has a complete four-pair Boston example.

### Read the result

`durationsSeconds[originIndex][destinationIndex]` gives each pair's elapsed time, and the ordered endpoints are echoed in `query`. A `null` cell means unreachable, never a zero-minute journey; a completed matrix can contain both. With `includeJourneys: true`, `journeys` has the same shape with a journey or `null` per pair. Add `includeGeometry: true` for path geometry; it requires journeys and performs no extra timetable search.

For arrive-by, a scalar duration is the deadline minus the latest feasible departure. A nested journey reports its actual arrival and may be shorter if it arrives early. Use the journey to separate travel from waiting at the destination. Public durations are seconds; minute-valued `rows` and search counters appear only in explicitly requested trace output.

### Choose constraints

The Route rules apply: a feasible direct walk competes unless `requireTransitRide: true`, `maxWalkKm` bounds endpoint walking, `maxTransfers` accepts 0–31, and `horizonMinutes` bounds the timetable search rather than the door-to-door duration. `allowStreetTransfers`, `minimumTransferBufferMinutes`, and `arrivalBufferMinutes` behave as described under [Route](#transfers-and-time-reserves).

Transit Matrix is scheduled. Drive Matrix can use a supplied traffic snapshot with `routingDataMode: "realtime"`; it never fetches a provider or models traffic changing during a journey. See [Street routing](#street-routing).

### Share work across pairs

Results keep input order, including repeated endpoints. The compiler accepts up to 100,000 pairs in a 16 MiB request; the engine accepts up to 65,536 pairs in an 8 MiB request. Group work by shared endpoint, date, clock, and constraints:

| Workload | Shared timetable search |
| --- | --- |
| Depart-at, one origin and many destinations | One forward scan |
| Depart-at, many origins | One forward scan per unique origin |
| Arrive-by, many origins and one destination | One reverse scan |
| Arrive-by, many destinations | One reverse scan per unique destination |

Request scalar output when only times are needed. Journey queries also share boarding rounds within each endpoint group, so tied journeys can differ from Route's stable order while satisfying the same objectives. `disableCache: true` bypasses endpoint-frontier caches while keeping same-request sharing, loaded City data, and immutable street indexes; it does not clear the operating system's page cache. [Service benchmarking](developer.md#reproduce-a-service-workload) shows how to measure full caller wall time.

## Reach and isochrones

Reach finds the streets and areas reachable from one origin within a time budget, by scheduled transit with walking or by walking alone. It does not measure access to jobs or people unless your analysis adds those opportunities. The [Reach request reference](guides/rust-standalone.md#9-reach-and-isochrones) lists every field.

### Send a Reach request

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "mode": "transit",
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 96,
  "surfaceSampling": "street"
}
```

```sh
vigo reach --city ./boston --request reach.json --output reach-result.json
```

`mode: "walk"` requests walking-only Reach and needs no service date. Drive, arrive-by, and realtime Reach are unavailable. Planned transit changes use transit with street sampling.

### Set the analysis resolution

| Option | Meaning |
| --- | --- |
| `cutoffsMinutes` | Time budgets from 1 to 240 minutes; fractional values are accepted |
| `maxWalkKm` | Transit walking budget |
| `walkSpeedKph` | Walking speed from 1 to 8 km/h |
| `extentRadiusKm` | Requested raster extent from 1 to 40 km |
| `rasterSize` | Cells per side; the compiler accepts 48, 64, 96, 128, 192, 256, 384, 512, or 1024, and the engine any integer from 16 to 1024 |
| `surfaceSampling` | `street` samples reached street intervals; `cell-center` routes to each cell's center |

The extent sets the analytical grid; it is not a maximum trip distance. Time budgets, walking limits, and the network decide what is reachable. Keep extent, resolution, sampling, and constraints identical when comparing results.

### Choose the output

The default `reachFormat: "full"` returns the requested grid and the full reached extent. `surface.valuesSeconds` is row-major from the northwest corner, and `null` means unreached; read its bounds and dimensions with the values. `fullSurface` describes the separate full extent when available.

`areas` are GeoJSON polygons around reachable cells, preserving holes and islands. `contours` interpolate the sampled times and close at the grid edge and no-data boundaries; diagonal-only cells remain disconnected. The raw raster stays the reference for numerical analysis. For a map, request `reachFormat: "map"` to receive only the full reached-area polygons and their bounds, without raster values, stop lists, or duplicate contours; map output cannot be compared.

For network evidence, add `includeStreetEdges: true` (`--street-edges` on the command line) to the full output. Returned directed intervals keep their explicitly named units. See [Reach output](guides/rust-standalone.md#reach-output) for raster ordering and edge decoding.

### Compare with R5 and OTP

Use `surfaceSampling: "cell-center"` for a coordinate-destination surface. The default `street` mode records the earliest reached street portion in each cell and leaves cells away from reached edges empty; a filled street cell does not establish a route to its center. Area metrics sum sampled cells and do not measure physically walkable land.

When comparing engines, match the origin, service date, departure time, modes, walking and transfer rules, cutoff, extent, and grid resolution before drawing polygons. VIGO Reach evaluates a fixed departure. Conveyal's R5 can aggregate a departure window at a chosen percentile, and OTP's Travel Time API provides a departure-time snapshot; match the temporal statistic first. VIGO raster values are seconds, while requests use `cutoffsMinutes`.

For quantitative agreement, compute travel times at the same coordinates with Matrix, then classify them at the same cutoff. A longitude/latitude grid and a Web Mercator grid do not share cell centers. Compare contours separately from cell polygons, and check station entrance costs, boarding slack, and GTFS transfer minimums in representative journeys. For a Transit Matrix control that matches Reach's walking budget, set `requireTransitRide: false` and `allowLongWalk: false`. See [Conveyal's isochrone methodology](https://docs.conveyal.com/analysis), [OTP's Travel Time API](https://docs.opentripplanner.org/en/v2.2.0/sandbox/TravelTime/), and the GTFS [minimum-transfer rules](https://gtfs.org/documentation/schedule/reference/#transferstxt).

### Inspect a destination in Studio

After running Reach in **Analyze**, click a destination to see its map estimate and request a journey there; with the map focused, press Enter to inspect its center. The journey keeps the analysis origin, date, departure time, timetable selection, and walking and ride limits. Expand **Show journey** for the walking and transit legs. A missing raster sample does not by itself mean no journey exists.

Destination journeys use scheduled service and the City's routing walking speed. Planned service changes affect the scenario map estimate but are not reconstructed in the destination journey; the panel labels the difference.

### Compare service changes

Run a baseline, then a planned Scenario with the same origin, clock, date, walking assumptions, sampling, and grid, and retain both Results. [Scenarios](#scenario-semantics) explains exclusions and added service; [Compare saved results](reference/results.md#compare-saved-results) explains the counts. A polygon describes modeled network reach. It does not certify entrance access, wheelchair connectivity, pedestrian permissions, or observed reliability; keep the [walking evidence](reference/walking-evidence.md) and [known limits](#known-limits) with the analysis.

## Scenario semantics

A Scenario is an immutable set of changes tied to exactly one City revision. It may contain planned transit service changes, one live transit state, or one supplied traffic state. Walking limits, speeds, departure times, and cutoffs stay query options.

Scenarios never edit the imported GTFS or OSM, and a complete alternative feed is another City revision. Drawing geometry in an editor creates no computational change until it is attached to a valid service edit. Several nonconflicting planned changes may coexist; conflicts need an explicit resolution. A Scenario never moves to another City revision, and expired live state cannot be queried.

In VIGO 0.5.2, planned service changes apply to Reach, supplied traffic to Drive Route and Drive Matrix, and supplied realtime predictions to transit Route. Transit Matrix and Reach remain scheduled. Studio can also route transit journeys on a saved scenario, on the scheduled timetable. Unsupported combinations are rejected with an explanation. The [Scenario request reference](guides/rust-standalone.md#10-scenarios) lists every field.

### Planned service

A planned service change states what changes and supplies enough to run it: ordered stops, travel-time assumptions, and a departure schedule. Edits to existing branches keep their GTFS trips by default; new service specifies frequency and operating hours. A Reach request can include this `scenario`:

```json
{
  "origin": {"coordinate": [-77.05, 38.90]},
  "serviceDate": "2026-07-15",
  "time": "08:00",
  "scenario": {
    "id": "crosstown",
    "name": "Crosstown service",
    "services": [{
      "operation": "add",
      "name": "Crosstown",
      "stops": [
        {"label": "West", "coordinate": [-77.05, 38.90]},
        {"label": "East", "coordinate": [-77.03, 38.91]}
      ],
      "headwayMinutes": 10,
      "startMinutes": 300,
      "endMinutes": 1500,
      "averageSpeedKph": 22
    }],
    "excludedRouteIds": ["route-to-remove"]
  }
}
```

`operation` is `add`, `augment`, or `replace`. `excludedRouteIds` removes selected scheduled route variants for the Scenario.

### Replace a branch and keep its trips

`replace` defaults to `scheduleMode: "preserve-trips"` and needs `sourceRouteId`, `sourcePatternId`, and selected-branch scope (`routeScope: "pattern"`, or omitted when a pattern is supplied). Studio and the compiler load the trips active on the query's service date, including calendar exceptions and departures after midnight. Each affected trip produces exactly one replacement, keeping irregular gaps, per-trip running times, dwell, and pickup and drop-off restrictions. Editing stops never adds departures or reverse service. Older replacement requests use the same default: headway and hour fields are ignored unless frequency mode is selected explicitly.

For a branch that keeps its trips, road geometry distributes each trip's original A → B running time among the edited gaps. Original dwell remains at retained stops, and `addedStopDwellMinutes` (default 0.35) adds dwell at inserted stops; removing an intermediate stop removes its dwell. The first retained GTFS stop anchors departure timing: a preceding extension departs earlier, and later edits shift downstream times. At least one original stop must remain, with `baselineStopId` or `baselineStopIndex` identifying moved stops and repeated visits. An extension requiring a departure before the service date is rejected. These are modeled timing changes, not a vehicle or crew scheduling check.

### Set a frequency instead

To change the timetable deliberately, use `scheduleMode: "frequency"` with `headwayMinutes`, `startMinutes`, and `endMinutes`; Studio calls this **Departures → Set frequency and hours**. This mode can replace a whole route, and `add` and `augment` use it by default. New lines use `segmentDistancesKm` and `averageSpeedKph` for road timing, plus `dwellMinutes`; segment arrays have one value per stop pair. Reverse service is an explicit choice in frequency mode and is never inferred from a shared route name.

### Edit a shared edge in Studio

**Selected branch only** keeps a change on the chosen pattern. **All branches serving this exact A → B edge** applies one inserted gap to every occurrence of that ordered stop pair within the same feed and public route, but not to the reverse B → A edge. The editor lists the affected branches before running. This scope needs complete branch analysis and one inserted gap; use selected-branch scope for moved stops, extensions, or several gaps. Repeated stop visits keep their own positions and published runtimes, and overlapping replacement services are rejected. Studio requires a completed road path before running a road-following Scenario.

### Compare the change

Run a baseline Reach and a Scenario Reach against the same City, origin, date and time, walking policy, cutoffs, and grid, save both, and compare them. [Test a planned service change](#test-a-planned-service-change) has complete paired requests. Compare reports after-minus-before changes for cells reachable in both surfaces and counts newly and no-longer-reachable cells separately. It checks grid compatibility but not every experiment setting, so read [Compare semantics](reference/results.md#compare-saved-results) before attributing a mean change to the Scenario.

## Inspect a saved Result

Open a JSON response from the VIGO engine, compiler, or HTTP API. The viewer shows its status and main answer, draws a journey timeline, a matrix table, or a Reach raster, and keeps the complete source JSON alongside.

### Read the public fields

Route uses `journey`, Matrix uses `durationsSeconds`, and Reach uses `surface.valuesSeconds` or map-only `areas`. Durations are seconds and a `null` analytical value is unreachable. Keep geometry qualifications and warnings with the answer.

Choose or drop a file in the [interactive viewer](guide.html#viewer). Files are read on your device and never uploaded; the viewer accepts up to 25 MiB.

### Python exports

Python's `Result.to_dict()` keeps its detailed, minute-valued payload. Use the [Python Result reference](../python/docs/guide.md#results) to interpret those exports; this viewer accepts public engine schemas only.

## Realtime journey routing

Route can use supplied GTFS-Realtime Trip Updates. This chapter explains how predictions are admitted and how to read the outcome; the [realtime input reference](guides/rust-standalone.md#12-realtime-transit-and-supplied-traffic) lists the snapshot fields.

### Two modes, one engine

Route exposes `routingDataMode: "realtime" | "scheduled"`, shown in Studio as **Realtime** and **Scheduled · Research**. The command-line runtimes default to scheduled and use a supplied `realtimeSnapshot`; they never fetch feeds. The compiler also accepts `--data-mode realtime|scheduled`.

Scheduled research requires an explicit service date and time. The server removes realtime and traffic observations before processing, enforces the exact date, and disables date substitution. Studio keeps the selected date and time and ignores feed polling in this mode; live refreshes, expiry checks, and mode changes cancel obsolete realtime requests, and switching modes never shows the other mode's old result.

Both transit modes use the same native algorithms, stop identities, walking and transfer policies, and coordinate search; only the timetable presented to the engine differs. Transit Matrix and Reach remain scheduled and reject realtime requests.

Results for an explicit mode include `diagnostics.routingDataMode` and `routingDataProvenance`: source timetable and street identity, service date and timezone, query time, walking and search settings, engine contract version, and a reproducibility key. Realtime results also identify the prediction snapshot, and ordered journeys reject changed data identities between legs. The manifest identifies inputs but does not archive them; retain the City, the VIGO build, the request, and the returned diagnostics to reproduce a result. The [0.4.2 method audit](history.md#realtime-and-traffic-method-audit--042) records earlier correctness repairs.

### Shared timetable

A journey search compiles the complete supplied TripUpdate snapshot into a separate resident timetable. Within the explicit resource limits there is no endpoint-based selection, inspection pruning, or duplicate-stop overlay, and an oversized snapshot is rejected as a whole rather than truncated. Each valid matched update replaces its scheduled trip; canceled and deleted trips lose their ride segments; unreported trips keep scheduled times.

Depart-at, arrive-by, transfer limits, and departure-window alternatives all use this timetable with the existing native algorithms. A query freezes its observation clock, including recursive verification and window samples. The latest compiled snapshot is cached per immutable service kernel and invalidated when input or timestamp validity changes; scheduled queries never inherit predictions from an earlier request.

### Admission and coverage

An update must identify an active trip on the selected service day and source scope. Ambiguous identities, contradictory duplicates, invalid timing, unsupported relationships, and stale observations are excluded and counted. Feed and record timestamps are checked independently: admission accepts timestamps at most 180 seconds old and at most 60 seconds ahead of the captured clock. Network tools may apply their own freshness policy first, keeping all rejection counts.

An unreported scheduled prefix may conflict with the first explicit prediction of an early-running trip. The resolver excludes that prefix only when all its departures and the first explicit prediction precede the frozen observation boundary, with no earlier explicit update or trip-level delay. `pastPrefixTrips` and `omittedPastPrefixStops` disclose the exclusion; it does not reconstruct past events or claim actual passage.

`diagnostics.realtimeRouting` identifies the snapshot and counts applied, canceled, stale, unmatched, wrong-date, duplicate, invalid, and unsupported records. `coverage` accounts for every supplied record, including those rejected before routing. `partial` means some updates were applied while others were excluded, and `failedFeeds` reports unavailable endpoints. A scheduled fallback is identified explicitly; compile or search failures never silently retry against scheduled service.

Processing a full snapshot is not a claim that every trip has a prediction. Added, unscheduled, replacement, and duplicated trips without a supported scheduled instance remain unsupported and disclosed. Vehicle positions and text alerts never invent stop-time predictions. Studio's [added-service display](#added-service) is separate from routing admission.

### Read the realtime status

For transit Route, read `diagnostics.realtimeRouting.status` together with its counts. `routingDataMode: "realtime"` records the requested mode; it does not mean that predictions changed the timetable.

| Status | Meaning |
| --- | --- |
| `applied` | Matched trip replacements were applied, possibly with cancellations, and no supplied update was rejected |
| `cancellations_only` | Only trip removals were applied, and no supplied update was rejected |
| `partial` | At least one replacement or cancellation was applied and at least one supplied update was rejected |
| `stale_fallback` | No update was applied and feed or record timestamp checks failed |
| `no_matches` | No update was applied for other reasons; check unmatched, wrong-date, duplicate, invalid, and unsupported counts |
| `scheduled_fallback` | No realtime search diagnostics were available; read `fallbackReason` |

`coverage.complete` concerns admission of the **supplied updates**; it does not measure the share of scheduled trips that report. A fully admitted cancellation snapshot can legitimately return no journey. `routingDataProvenance.realtimeApplied` counts both replacements and cancellations. Keep these fields with the answer; see [Keep uncertainty with the answer](reference/results.md#keep-uncertainty-with-the-answer).

### Stop predictions and source versions

A trip-level delay propagates forward until a stop-specific prediction replaces it, and a prediction at an intermediate stop never becomes a delay for earlier calls. Absolute time takes precedence over delay; arrival and departure remain separate. `NO_DATA` resets propagated delay, and `SKIPPED` removes boarding and alighting while keeping through travel. Repeated stops need an unambiguous sequence, and out-of-order sequences are rejected.

Each decoded record keeps its endpoint, source timestamp, and static-feed scope. VIGO does not compare GTFS-RT `feed_version` with static `feed_info.feed_version`, so connect the matching timetable edition yourself. A missing Trip Update means no reported prediction, not verified on-time operation.

Resource admission is separate from semantic coverage. Downloads are bounded, the decoder rejects feeds above 100,000 entities or 500,000 stop predictions, and native reconstruction checks its estimated memory against the timetable budget. Over-limit data is rejected, never silently truncated.

### Verification

`npm run check:gtfs` runs the full feed and routing suite, including more than 256 updated trips, 1,024 input records, and 4,096 updated stops, interior transfers, both time directions, cancellations, skipped stops, transfer limits, snapshot replacement, and timestamp expiry. `check-realtime-scheduled-parity.mjs` compares 1,536 paired engine queries against eight independently imported GTFS timetables containing the literal effective predictions. `check-realtime-past-prefix.mjs` and `check-routing-data-modes.mjs` cover excluded prefixes and observation isolation. These establish algorithm parity for the tested cases, not field ETA accuracy.

## Street routing

A City built with OSM supports Walk and Drive variants of Route and Matrix, plus directed walking access for transit. Walk uses the directed pedestrian graph; Drive uses the directed road graph with free-flow time unless the request supplies traffic weights or closures. VIGO never replaces a missing street path with a straight line.

Street Route needs coordinate endpoints and returns full geometry. Street Matrix returns scalar distance and duration per pair without reconstructing every path; it sweeps from the smaller endpoint set, and many-to-one requests use the reverse directed CCH metric while keeping each endpoint's access permissions.

### Coordinate network attachment

A free coordinate first attaches to its nearest pedestrian vertex or reciprocal edge. If that attachment belongs to a component with no public transit-access anchor, the query can recover to the nearest anchored component within 80 m. This applies to arbitrary coordinates without place-name exceptions. The connector and partial-edge distance count toward walking time and limits, and returned geometry includes the charged connector. Anonymous Reach seeds use the same recovery.

Stops keep their prepared physical anchors. Recovery never adds a street edge or a stop-to-stop transfer between disconnected components, a mapped authorized terminal path takes precedence, and a restricted endpoint cannot use recovery to bypass its directed exit. An off-network connector is a modeling assumption, not evidence of a surveyed entrance or a barrier-free crossing; an isolated place with no eligible street inside the radius stays unreachable.

### Authorized endpoint access

Builds default to public pedestrian access: `access=private` without a pedestrian permission, or `foot=private`, stays outside the public walking graph. For a population authorized to use internal roads at its own homes and destinations, build with `--private-access=endpoints`. In Studio, choose **City → Street network → Pedestrian access → Authorized endpoints** before adding or replacing the OSM PBF; choosing **Public paths only** and replacing the streets removes the overlay.

This City-wide modeling assumption permits mapped private streets only within the origin's or destination's attached internal street region. An exact directed search follows those streets and interior public islands up to the first public component with a transit-access anchor. The public middle of the journey and stop-to-stop transfers never enter private streets, all internal walking counts toward the same walking limit, and geometry follows the mapped edges. Walking wholly within one internal region is supported.

The private graph is stored separately, so public street queries are unaffected. `network.json` records the access model, and transit diagnostics report `walkingAccessPermission: "authorized_endpoints"`. The option assumes endpoint authorization; it does not infer parcel ownership, gate hours, or missing OSM links. Explicit pedestrian prohibitions stay excluded, gates marked prohibited, locked, or with unresolved opening times gain no connections, and Street Reach follows the same rules at the origin and at reached destinations. Rebuild older Cities to apply street-store schema v6, which also excludes platform area outlines from the linear walking graph.

### Supplied traffic

**No traffic provider is connected by default.** OSM supplies the baseline road graph and free-flow estimates, and live transit feeds are not a road-speed model. Driving results without an applied traffic snapshot must not be described as current traffic estimates.

Drive Route and Drive Matrix accept a top-level `traffic` object with `routingDataMode: "realtime"`. A snapshot customizes the prepared directed road graph for one query: a fixed set of edge costs, not a forecast that evolves as a vehicle moves.

```json
{
  "routingDataMode": "realtime",
  "traffic": {
    "source": "your-provider",
    "observedAt": "2026-09-26T12:00:00Z",
    "ttlSeconds": 300,
    "observations": [
      {
        "fromCoordinate": [-71.0625, 42.3570],
        "toCoordinate": [-71.0615, 42.3575],
        "speedKph": 12
      }
    ]
  }
}
```

Use the actual observation time and the coordinates of an observed **directed edge**. This fragment shows the schema; its values are illustrative. A full request also needs the mode and endpoints.

| Contract | Behavior |
| --- | --- |
| Time | Required observation time; validity defaults to 300 seconds and is at most 1,800; observations more than 60 seconds in the future are rejected |
| Expiry | Expired observations produce an explicit `stale_fallback` and use baseline costs |
| Geometry | Endpoint pairs or 2–512 coordinates; directed edge matching within 120 m by default, at most 1,000 m |
| Edge indices | Require the exact current `streetSourceFingerprint`; indices are not portable between street builds |
| Costs | Travel time, speed, or a slowdown factor, plus closures; costs never become faster than the baseline |
| Overlap | Conflicting observations on one edge use the largest cost, including closures |
| Reuse | The customized metric is reused while effective edge updates are unchanged; source age is checked on every query |

Read `diagnostics.traffic.status`, the matched and unmatched counts, and `weightModel`. Only `applied` establishes that supplied costs changed the model; `no_matches` and `free_flow_equivalent` do not establish current coverage. Coordinate matching is nearest-edge matching, not a validated provider conflation pipeline, and VIGO does not yet model every turn, signal, intersection delay, parking, or a future traffic trajectory. The [traffic input reference](guides/rust-standalone.md#drive-traffic) lists every effect and limit.

## Travel-time uncertainty

VIGO supports explicit time reserves that change which journey is chosen. It does not yet estimate an on-time probability, a travel-time distribution, or a calibrated confidence interval: scheduled and admitted realtime event times are point estimates.

### Use reserves in a routing request

| Control | Applies to | Meaning |
| --- | --- | --- |
| `minimumTransferBufferMinutes` | Transit Route and Matrix, depart-at or arrive-by | Extra minutes before each subsequent boarding, after walking and published transfer minimums |
| `arrivalBufferMinutes` | Arrive-by transit Route and Matrix | Reserve the final minutes before the deadline and search for the latest departure that still arrives before the earlier planning deadline |

Both are integers from 0 to 60 and default to zero. A positive arrival reserve needs a deadline at least as large as the reserve and a horizon exceeding it by at least one minute; the earliest departure stays the one implied by the original deadline and horizon. Transit via points reject a positive reserve because composing segments would apply it repeatedly, and Walk, Drive, Reach, and native operations reject a positive arrival reserve.

For Harvard Square to South Station, save `reserved-arrival.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "serviceDate": "2026-10-05",
  "time": "09:00",
  "timePreference": "arrive_by",
  "maxTransfers": 3,
  "horizonMinutes": 120,
  "minimumTransferBufferMinutes": 3,
  "arrivalBufferMinutes": 5
}
```

```sh
vigo route --city ./boston --request reserved-arrival.json
```

VIGO plans arrival by **08:55**, allows departure no earlier than **07:00**, and requires three extra minutes at each change. These numbers are illustrative preferences, not an MBTA delay estimate or a recommended threshold, and a tighter request can legitimately find no journey.

Route clocks and leg durations still describe the chosen timetable journey, and a Matrix scalar duration keeps its deadline-minus-departure definition, including the reserve. Keep `diagnostics.timeReserves` with the answer: it records the requested and planning deadlines, both margins, and `calibratedProbability: false`. Request `diagnostics: "trace"` to see it. A transfer reserve can absorb some lateness, but it does not model early departures, missed-connection recovery, capacity denial, cancellations, correlated delays, or uncertain walking and station access, and the final reserve alone does not protect intermediate transfers.

### Calibrate probabilities before offering them

GTFS-realtime `StopTimeEvent.uncertainty` has no defined statistical meaning, and an omitted value means unknown. It must not become a standard deviation or a 90% interval without a validated, provider-specific model. See the [GTFS realtime reference](https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent).

For a Boston calibration study, start with the [MBTA LAMP exports and their data dictionary](https://github.com/mbta/lamp/blob/main/Data_Dictionary.md) and [TransitMatters Gobble](https://github.com/transitmatters/gobble). These are potential inputs; VIGO does not download or fit them. A credible next stage would retain historical forecasts and outcomes, match the exact feed revision and trip instance, estimate errors by route, direction, time of day, and lead time, and validate on later dates with coverage reporting. Same-vehicle and shared-corridor delays are correlated, so multiplying marginal transfer probabilities is not a journey probability. Probability-driven routing would need its own search and calibration contract.

### Reproduce the implemented contract

Run `node test/check-arrive-by-boundary.mjs` after building the native kernel and `npm run check:standalone` after building the compiler. The public fixtures cover a changed selected departure, the exact reserve boundary, blocked outcomes, unchanged earliest departure, transfer-reserve combinations, matrices, invalid values, and repeated requests through both runtimes. They establish modeled feasibility, not measured on-time performance.

## Published fares on itineraries

Route shows boarding prices from the imported GTFS feed. In Studio, expand the fare line for ticket names, payment methods, and the agency's fare link; JSON Results carry the same data in each transit leg's `fare`.

These are prices for a **new boarding**, not an optimized journey fare. Multi-leg results deliberately have no total, because joining legs, transfer discounts, passes, and existing tickets can change what a rider pays. A missing quote does not mean free travel, and path selection does not consider price.

### Data and matching

The importer keeps fare tables and their route, station, agency, and calendar references in an optional `fare_catalogs` SQLite table. Catalogs travel with a City and stay separate when feeds are merged. Cities built before fares were added need their original GTFS reimported to keep fare data.

- **Fares v2 takes precedence** when `fare_products.txt` is present. Matching uses route networks, station areas, rule priorities, fare timeframes, and the default rider category; product names and media come from the feed. MBTA's `transfer_only` extension is honored, so a free-transfer product never becomes a free new boarding.
- **Fares v1** supports flat, route, and origin/destination-zone boarding prices. Zone-traversal (`contains_id`) rules stay unquoted.
- Fare timeframes use the civil date and time at the validation stop, including its timezone, daylight-saving changes, times after midnight, and calendar exceptions. For a realtime-adjusted leg, the original scheduled stop sequence must be uniquely recoverable before timed rules apply.
- Explicit platform fare areas override inherited station areas. Ambiguous network assignments, conflicting products, missing references, and unsupported conditions stay unquoted, and an unreadable fare catalog never discards a computed route.
- Transfer totals, joined fare legs, pass selection, non-default rider eligibility, and fare-based optimization are not implemented.

Matching follows the [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/#fare_leg_rulestxt). No agency prices or route-name rules are embedded in code; prices reflect the saved feed.

### Performance

Fare lookup happens only after route selection, so no fare code runs inside routing, matrix, or Reach searches. Catalogs load by feed scope and are indexed once; quote, candidate, catalog, and scheduled-trip caches have explicit bounds and are released with their catalog. With cached catalogs, annotation performs no SQL. First-use parsing, serialization, and rendering still take time; measure them separately with `node scripts/benchmark-fares.mjs FEED.zip STORE.sqlite YYYY-MM-DD report.json`.

### Verification

`node test/check-gtfs-fares.mjs` covers exact matching, missing data, published zero fares, invalid prices, transfer-only products, default rider categories, area inheritance, empty-rule semantics, priority rules, after-midnight date changes, time-window boundaries, scoped multi-feed import and merge, and non-mutating itinerary annotation.

## Known limits

VIGO models the City revision and query it is given. It does not certify real-world service, demand, safety, or operational feasibility.

### GTFS

- Support is limited to the source features listed in [GTFS support](developer.md#gtfs-support-matrix). Unsupported or malformed features are reported during the build.
- Missing published shapes do not prevent timetable routing but limit map geometry.
- Block-based in-seat continuation is not inferred.

### Transit Route and Matrix

- Arrive-by Matrix durations include any wait between actual arrival and the deadline; use Route or Matrix journeys for actual arrival.
- [Transfer and arrival reserves](#travel-time-uncertainty) can change route selection, but VIGO does not compute calibrated arrival probabilities or delay distributions.
- A finite `maxTransfers` cap with ordered transit waypoints is unsupported.
- Station returns may be valid in the supplied timetable; they are flagged, not excluded.
- Without an explicit rule or declared pathway topology, platforms sharing a parent station use a transfer assumption of at least 120 seconds, floored by their coordinate distance at walking speed. These legs report `transferSource: 'parent_station_fallback'` and schematic geometry, not a verified station pathway.
- A street route to a platform coordinate does not establish an entrance-to-platform connection. Walks touching subway stops or platforms report `stationAccessStatus: 'unverified'` unless they carry a declared pathway with no estimated segments; `streetSegmentVerified` keeps the narrower OSM result. Untimed stairs and gates use explicit routing estimates (one second per step, five seconds per gate), marked `gtfs_pathway_estimated`. Scalar Matrix results do not carry this per-leg audit.
- Departure windows sample integral minutes; they are not continuous profiles.

### Streets

- Walk and Drive depend on OSM coverage and directionality.
- Pedestrian attachment searches vertices within 160 m and projects onto reciprocal edges within 80 m. A missing attachment is not proof that no physical path exists.
- Platform polygons describe an area, not a walking line. Street-store schema v6 excludes their outlines from the walking graph; routing across polygon interiors is not modeled, and older Cities need a source rebuild.
- An anonymous endpoint on an unanchored fragment can recover to the nearest transit-connected component within 80 m, including the full connector cost. This adds no graph links and proves nothing about buildings, fences, water, or levels in between. See [coordinate attachment](#coordinate-network-attachment).
- [Authorized endpoint access](#authorized-endpoint-access) is an opt-in build model; it does not establish individual permissions, gate hours, or missing connections.
- Drive does not yet model every turn restriction, signal, or intersection delay. Traffic must be supplied by the caller.

### Realtime

- Realtime transit applies to Route only, and only with a supplied `realtimeSnapshot` and explicit realtime selection. Transit Matrix and Reach reject realtime requests. Vehicle Positions and Alerts do not change route costs or close services.
- Only `FULL_DATASET` feeds are decoded. Updates modify matched scheduled trips, remove `CANCELED` and `DELETED` trips, and omit `SKIPPED` calls. Added, duplicated, replacement, and unscheduled trips without a supported scheduled instance are unsupported for routing, though Studio can [display them](#added-service).
- Feed and record timestamps must pass freshness checks: up to 180 seconds old and 60 seconds ahead of the captured clock. Missing timestamps do not establish freshness. See [realtime routing](#realtime-journey-routing).

### City reuse and platforms

- Copy the entire City directory; street indexes and prepared files are part of it. Executables are specific to an OS and CPU, while City data is portable across the supported 64-bit targets.
- Older Cities with ephemeral Drive CCH rebuild that hierarchy on fresh-process startup; rebuilding the City from source enables persisted Drive CCH.
- An incompatible timetable cache, a new active-service pattern, a changed walking policy, or an evicted snapshot requires preparation. Missing or corrupt required street indexes are errors; restore the complete City or rebuild it.
- Studio project settings, drafts, and live connections are local application state and do not travel inside a City. Studio cannot open compiler City directories in this release.

### Scenario and Reach

- Planned transit service changes apply to Reach; supplied traffic applies to Drive Route and Drive Matrix. Other combinations are rejected.
- `maxTransfers` limits changes between vehicles in both baseline and scenario Reach; zero permits one ride, and walking never counts as a boarding.
- After the last ride, Reach follows the same declared station exits as coordinate egress, and a stop reached only by a transfer walk does not restart the walking allowance. Reach rasterizes reached street edges while Matrix evaluates destination coordinates, so their cells can differ under matching settings.
- Reach measures modeled travel time, not people, jobs, demand, welfare, observed behavior, or operational feasibility.

## VIGO Studio desktop guide

VIGO Studio puts Network, Route, Analyze, and City views over the same routing engine. It keeps its own project library and works offline once a City is imported.

### Documentation and settings

Open **Settings → Documentation** from the City library or the sidebar to read this guide offline, in Studio's light or dark appearance. Press `/` to search; links to source files and external references open in your browser. Reading documentation does not open a City or prepare routing data, and the API schema download is bundled locally.

### Open a City

Select a project from the Studio library and import GTFS and OSM. Rebuild when the source feed or street extract changes. Studio stores projects in its library format and cannot open the movable City directories built by the compiler in this release. Opening a City prepares walking for transit access and walking routes; the driving network opens when you select Drive. **Background tasks** shows preparation progress.

### Network

Use **Network** for reporting coverage and briefings, and **Routes** for trip times, station boards, and line views. Route and station selection is shared across the tabs. [Network and Routes](#network-and-routes) explains playback, live timing, added service, and model connections.

### Route

#### Plan

Pick an origin and destination on the map. **Add point** inserts a via point before the destination, up to eight points in total; click a row to repick it, use the arrows to reorder it, or remove it, and **Reverse** flips the sequence. You can also type a coordinate command in **Search VIGO**, such as `route 38.90, -77.05 to 38.91, -77.03 at 08:00`, then choose **Plan this journey**. The route form does not search place or station names.

Choose a travel mode. Realtime transit departs now; Scheduled exposes the date, time, and depart-at or arrive-by controls. Transfer caps are disabled while via points are present. Changing points or options updates the route, **Rerun route** submits the same coordinates again, and **New route** clears them.

**Network** chooses what a transit route runs on: the City timetable or one of the City's saved scenarios. A scenario route uses the scheduled timetable of the scenario's timetable group, with its removed routes canceled and its planned lines added. Planned lines run on their stated headway and hours on every service date, and new planned stops are reached on foot over the City's streets. Rides on planned service are labeled **Planned** and drawn along the scenario's path. Realtime is unavailable while a scenario is chosen.

Sort journeys by **Earliest**, **Fewer transfers**, or **Less walking**. Each card shows arrival, total time from your requested departure, transfers, walking, and its trade-off against the earliest arrival. Sorting keeps the selected journey and does not rerun the search; arrow keys, Home, and End select another journey, and **Details** opens its itinerary.

#### Save a journey

Choose a format beside **Save** in the journey details. **JSON** keeps the selected plan, diagnostics, and a summary separating the initial wait, journey duration, and total elapsed time. **Markdown** is a readable itinerary whose clocks can exceed 23 hours after service-day midnight. **GeoJSON** keeps leg geometry and its source when the complete path is retained. **CSV** records each leg's trip and service-clock times; `clock_service_date` names the midnight those minutes count from, and minutes can exceed 1440. Saving never reruns the query.

**Save all** beneath the journey choices keeps every completed alternative, including those beyond the five visible cards. Filenames include the service date, places, and export time.

#### Recent

Reopen recent Route Results for the current City revision. Each keeps its normalized request, status, warnings, and timing beside the journey.

### Analyze

#### Reach

Choose an origin on the map, or use **Choose origin** to search imported stops by name or ID or enter coordinates. Run Reach, then switch between **Reachable area**, **Reached streets**, and cutoffs; changing the displayed cutoff reuses the retained result. See [Reach](#reach-and-isochrones) for limits and bounds.

#### Compare

**Compare** measures saved scenarios, timetable groups, or single timetables against one reference, by default the City's **Baseline** group, from the same origin and departure. Every variant is computed on the reference's grid, and the reference surface is computed once and reused. Variants are ranked by reached area gained at the time budget; each row also counts newly reached and no-longer-reached cells, the mean minutes saved over cells both networks reach, and the change in reached stops. Choose a variant to map its travel-time change from the reference. Cell counts are never subtracted across independent grids. To compare completed Results without rerunning them, use the compiler's `compare`.

Use **Save** beside Reach or comparison results for the full JSON, the selected cutoff's area geometry, or a CSV summary; Compare saves its ranking as CSV, the run with the mapped variant as JSON, and the mapped pair's areas as GeoJSON. `total_processing_ms` measures complete analysis processing, separate from native query timings; `area_source` distinguishes an exact-cutoff area metric from a display-raster calculation; `reference_surface` and `reference_feed_id` identify the baseline. Saving becomes available when the computation finishes.

Studio saves scenarios and timetable groups in the City folder, in `.vigo/scenarios.json`, shortly after each edit. They survive restarts and reimports and travel with the City directory; a scenario that names a route a reimport removed reports it when you run it. A copy saved from another window is never overwritten: Studio shows the newer copy instead. Drafts that earlier versions kept in the browser profile move into the City folder the first time you open it. For a stop inserted on an A → B edge shared by several branches, the road path applies to each affected branch, and each branch keeps its own untouched shape and runtime. Use the engine, the compiler, or Python for Matrix queries.

### City

#### Data sources

Open **City → Data sources** to review GTFS feeds, OSM coverage, counts, and warnings. To remove a source, select the trash button beside its row, check the name, and confirm **Delete source**. Removing a GTFS feed refreshes the combined timetable from the remaining feeds; removing OSM removes street routing and OSM-derived walking transfers until another import. The City, other sources, saved notebooks, and your original files are kept, and deletion is unavailable during import or preparation.

#### Preferences

Choose appearance, storage location, and map preferences. The default City folder is `~/Documents/Vigo Projects`. On macOS, Studio does not scan or test-write the library until you choose **Open library folder**, when macOS may ask for permission. Locally rebuilt apps use ad-hoc signatures, so an updated build can need authorization again.

**Local OSM** is the default basemap. It draws main roads, rivers, lakes, and coastal water from the City's imported PBF in light or dark appearance, with no tile service, API key, or network connection; residential streets, paths, buildings, and labels are omitted to keep routes and analysis clear. Cities imported before the local map index need one fresh OSM import. Online OpenStreetMap and CARTO styles remain optional.

### Studio troubleshooting

#### Playback shows no trips

Check the exact service date, `calendar.txt`, `calendar_dates.txt`, the selected direction and pattern, and whether the playback time falls between a trip's first departure and last arrival. A route-wide total is not the number of vehicles active at once.

#### An access path crosses a block

The access or egress line must come from OSM street geometry. Rebuild from current OSM data, confirm the point lies within coverage, and inspect the selected street leg. Studio never replaces a missing street path with a straight jump.

#### A date is rejected

Use an exact `YYYY-MM-DD` date inside the feed's active service range. Studio applies the same calendar rules as the command line.

#### A loading indicator is not advancing

Background tasks show measured bytes or records for steps with a known total; the percentage belongs to that step, not the whole import. Work without a total shows an indeterminate bar, elapsed time, and the age of the last update. If updates pause, use **Reconnect to task**: the task may still be running, so check its status before importing the same source again. Confirm that the City folder is readable and writable and that macOS has granted access.

## Network and Routes

Open **Network** in VIGO Studio to inspect the selected City's timetable, live reports, and retained briefings. The workspace has **Network** and **Routes** tabs; use **Route** for journey planning and **Analyze** for Reach.

### Read the evidence

The same map can show several kinds of evidence. Read the source and observation time before interpreting a change.

| What you see | What it represents | How to use it |
| --- | --- | --- |
| Scheduled time | An indexed GTFS arrival or departure on the selected service date | Establish the published plan; check the date and pattern |
| Predicted time | A matched, admitted TripUpdate for that trip and stop | Compare the same arrival or departure with its schedule |
| Vehicle position | A reported location and stop status at its own observation time | Locate the vehicle; check its age separately from the prediction |
| **Estimated** playback | A position interpolated along the scheduled trip | Explore the timetable and geometry |
| Network assessment | Computed conditions among reporting service in a stated window | Read coverage alongside delay and spacing |
| Model explanation | An interpretation of the supplied evidence | Inspect sources, uncertainty, and the proposed next check |

None of these is a verified history of actual stop arrivals, and a missing prediction stays unknown. A vehicle marker or an added trip in **Trip times** does not mean Route can use that trip; routing has its own [admission rules](#realtime-journey-routing).

### Investigate a condition

1. **Start with coverage.** Check the assessment time, service window, and reporting coverage in **Network**. Coverage weights scheduled vehicle-minutes with usable predictions or cancellation reports; it is not the share of passengers covered or service running on time.
2. **Follow the route.** Open **Routes**, select the route, and inspect **Trip times** on the relevant date. Use **Stops** to confirm direction and pattern, then **Updates** for service evidence.
3. **Inspect the same event.** Open the station board or select a vehicle in **Line view**. Compare arrival with arrival, or departure with departure, at the same stop, keeping both observation times visible.
4. **Keep the observation attached.** **Export observations** or **Export report** retains the current evidence, and **Export evidence** in the service briefing saves its assessment and source checks.

For a journey, use **Route** and read its [Result and diagnostics](reference/results.md). The [service assessment method](developer.md#network-service-assessment) defines the reporting denominator and spacing comparisons.

### See what needs attention

**Network** shows reporting coverage, route comparisons, and the network briefing. A scheduled departure, a feed prediction, and an observed vehicle location are different evidence, and missing reports remain unknown. Overnight service is assessed against the timetable's active window.

With a connected model, the briefing can interpret a pattern, propose an explanation, and suggest a next check. Hypotheses are not confirmed incidents. The briefing checks extracted route-condition claims against computed evidence and performs a model review, but neither guarantees that all prose is correct; a computed fallback is labeled separately.

### Inspect a route or station

Open **Routes** and choose a route to see **Trip times**; select a trip and date to compare scheduled and predicted arrivals or departures. **Stops** opens directions and patterns, and **Updates** opens service evidence. The map and **Line view** show the same route. Select a stop for its arrivals board, and **All routes** returns to the catalog. Route and station selection is shared across Network, Routes, the map, and the line view; **Network map** clears both.

### Patterns and scheduled playback

A route's **Stops** view shows directions, patterns, ordered stops, service span, and published geometry. Patterns are labeled by first and last stops, and **Full service** restores them all. Direction IDs `0` and `1` are feed labels, not compass directions. Technical IDs appear under **Source data**. Times such as `25:10` stay on their GTFS service day.

Scheduled playback is labeled **Estimated**: vehicles dwell at stops and follow their pattern's shape between timed calls. The index does not keep `shape_dist_traveled` or every untimed call, so interpolated positions are not exact. Live positions stay separate from playback, and route-colored vehicle circles show a bearing arrow when available.

### Vehicle timing and line view

In **Network → Routes**, select a route and choose **Line view**. The two tracks show each direction's stops and reported vehicles. Select a vehicle on the map or the line to compare scheduled and predicted arrival and departure at its reported stop. If that stop has no usable timing, its prediction stays unavailable; **Next prediction** names a later stop with one without substituting its time.

Vehicle timing comes from the City's connection store and the current realtime snapshot. The browser requests only the selected route or vehicle every ten seconds, without overlapping requests.

- Stop placement follows the VehiclePosition stop ID, sequence, and status; it never uses road snapping or interpolated movement. Missing or conflicting identities stay unplaced.
- Arrival comes from the incoming connection and departure from the outgoing one, and delay compares the same event at the same stop.
- Opposite directions share a central station list only when their station sequences are exact reverses. Bus stops on opposite sides of a street are not paired by proximity or name.
- Branches and repeated stops stay distinct. Skipped stops, missing predictions, duplicates, and stale observations never become valid current timing.

Spacing is schematic: it shows stop order, not distance, time, or headway. The **↔** warning marks both vehicles in a compressed departure pair, comparing their predictions at the same stop against their scheduled interval.

#### Added service

Trips declared by GTFS-RT `ADDED` or `NEW` appear in the line view and the **Trip times** selector even when absent from the static timetable. Their reported stop sequences supply placement and timing; partial sequences are labeled as reported stops, and scheduled times and delay comparisons are unavailable. Added-service display does not make a trip available to journey routing; see [realtime limits](#realtime).

#### Verification and references

`test/check-agency-route-line.mjs` and `test/check-added-service-display.mjs` run with `npm run check:agency`. They cover both directions, branches, repeated and terminal stops, conflicting sequences, stale and future positions, skipped and no-data predictions, and added trips; they verify fixture behavior, not field accuracy. The interaction design drew on [TransitMatters Train Tracker](https://traintracker.transitmatters.org/) and [Swiftly's Live Operations overview](https://swiftly.zendesk.com/hc/en-us/articles/360043691571-Live-Operations-Overview); no implementation or assets were copied. Matching follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/).

### Connect a model

Open **Network → Service briefing → Connect AI**, choose a provider, enter its API base URL, choose or discover a model, and connect. The connection test checks function calling, not answer quality. Local models can use a keyless endpoint if their server allows it, and API keys stay in server memory for the session. Briefing requests include the computed assessment and selected source checks; the briefing does not search the web. A localhost URL does not prove where inference runs or whether data is retained.

### What this app does not establish

Predicted spacing is not measured headway, and retained forecast changes are not actual vehicle progression. Reporting coverage is not service health. The briefing has no crew roster, maintenance clearance, demand model, or intervention simulator, and rider drafts require staff review; VIGO does not dispatch or publish messages. The [operations ledger](developer.md#agency-operations-prototype) and [synthetic replay](developer.md#one-bus-one-control-point) are research interfaces.

## Command line

The compiler, `vigo-build`, builds Cities and runs Route, Matrix, Reach, Stream, and Compare through VIGO's shared native routing kernel. The engine has its own command set; see the [engine CLI reference](guides/rust-standalone.md#4-cli-command-reference).

### Commands

| Command | Input | Output |
| --- | --- | --- |
| `build` | GTFS, OSM, output directory | A complete prepared City |
| `build-scenarios` | A scenario source manifest | A prepared scenario collection |
| `capabilities` | None | Versions and supported query combinations |
| `inspect` | City directory | Identity, sources, counts, and limitations |
| `route` | City and JSON request | A public journey Result, or a CSV batch |
| `matrix` | City and JSON request | An origin-by-destination travel-time Result |
| `reach` | City and JSON request | Reachable areas and optional analytical output |
| `stream` | City and NDJSON on stdin | One Result per request from a resident process |
| `compare` | Two saved Results | Changes without rerunning routing |

Run `vigo-build help route` or `vigo-build route -h` for options, and `vigo-build --version` for the version. Unknown options, extra positional arguments, and repeated single-value options are rejected; `--gtfs`, `--gtfs-scope`, and `--prepare-date` may repeat.

### Send a request

Requests carry `serviceDate` and `time` in JSON, and flags override request fields exactly as in the engine:

```sh
vigo-build route --city ./boston --request route.json --output route-result.json
cat route.json | vigo-build route --city ./boston --request - --time 08:30 > route-result.json
```

| Flag | Meaning |
| --- | --- |
| `--service-date`, `--time` | Override the request's date and clock (`00:00`–`29:59`) |
| `--time-preference depart\|arrive` | Time direction; JSON also accepts `depart_at` and `arrive_by` |
| `--mode transit\|walk\|drive` | Travel mode |
| `--max-walk`, `--max-transfers`, `--horizon` | Walking budget (km), transfer cap, timetable horizon (minutes) |
| `--departure-window MIN` | Centered depart-at profile of ±0–30 minutes; Route only |
| `--alternatives N`, `--alternative-ranking` | Additional transit journeys; Route only |
| `--data-mode scheduled\|realtime` | Route data mode; realtime needs a supplied snapshot |
| `--cutoffs`, `--raster-size`, `--extent-radius`, `--walk-speed`, `--street-edges` | Reach options |
| `--diagnostics`, `--format`, `--include-geometry`, `--include-limitations` | Output detail |

Request files and stdin share a 16 MiB limit, and `--request -` reads until the producer closes stdin. Progress and errors go to stderr; JSON goes to stdout. Saved output is staged and renamed after a complete write, so a failed run can leave an earlier output file in place: check the exit code. CSV Route batches use `--input` with an output file, support transit only, and cannot be combined with `--request`.

### Keep the compiler resident

`stream` reads one request per line, each with an explicit `kind`, and keeps prepared network state between lines. Each line may choose its own `serviceDate`; a `--service-date` flag only sets the default.

```jsonl
{"id":"outbound","kind":"route","origin":{"stopId":"A"},"destination":{"stopId":"B"},"serviceDate":"2026-10-05","time":"08:00"}
{"id":"times","kind":"matrix","origins":[{"stopId":"A"}],"destinations":[{"stopId":"B"}],"serviceDate":"2026-10-05","time":"08:00"}
```

```sh
vigo-build stream --city ./city < queries.ndjson > results.ndjson
```

Responses echo `id` and add `sequence`. A per-line error does not end the stream. First-use preparation, later queries, and serialization are different timing boundaries.

### Read a response

Public Results identify `schema`, `status`, and query metadata: Route uses `journey`, Matrix `durationsSeconds`, and Reach `surface.valuesSeconds` or map-only `areas`, all in seconds. `diagnostics: "trace"` adds internal evidence under `trace`; applications should use the [public result reference](reference/results.md). An invalid one-shot request exits nonzero, and stream errors use `schema: "vigo.error.v1"` with `error.code` and `error.message`.

[VIGO Python](../python/docs/guide.md) runs the same resident protocol with its own Result properties. Studio's internal application API is not a public integration boundary.

## Deploy the routing engine

Run the engine executable as the HTTP service. It opens a prepared City or scenario collection without Node, Python, Studio, or an internet connection. Prepare data separately with the compiler, then mount the complete output directory read-only.

### Build and check the image

From the repository root with Docker installed:

```sh
docker build -f deploy/Dockerfile -t vigo:0.5.2 .
```

The image contains the engine with this guide embedded, license notices, and a Debian glibc runtime, and runs as UID/GID 65532. Its compiler matches `rust-toolchain.toml`; City data, JavaScript dependencies, desktop bundles, and build caches are excluded from the build context. Check the image before using it:

```sh
npm ci
npm run build:cli-runtime
npm run check:deployment -- --image vigo:0.5.2
```

The check builds public synthetic inputs and exercises the real Compose service: a read-only City, authentication, Route, Matrix, Reach, scenario switching, readiness, restart, and resource limits, and it confirms that queries never change City files. CI runs it on Linux x64 and ARM64. Measure your own City and request mix before choosing production limits; the small fixture is not a metropolitan memory or latency result.

### Start the service

Make the City directory and its files readable by UID 65532, and keep every referenced directory inside the mounted City or collection.

```sh
export VIGO_IMAGE=vigo:0.5.2
export VIGO_CITY=/absolute/path/to/prepared-city
# Set VIGO_API_TOKEN through your shell or deployment secret store (16+ characters).
docker compose -f deploy/compose.yml up -d --wait
```

The service binds to `127.0.0.1:8080` on the host; put an HTTPS reverse proxy in front of it for remote clients. Query endpoints require `Authorization: Bearer ...`, while readiness and this guide are public.

```sh
curl --fail-with-body http://127.0.0.1:8080/readyz
curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H "Authorization: Bearer $VIGO_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @route.json
docker compose -f deploy/compose.yml logs --tail 50
```

`GET /v1/info` reports network, query-workspace, cache, and scenario-residency accounting. For scheduled comparisons, pass `scenarioId` with each query; a [scenario collection](guides/rust-standalone.md#shared-scenario-collections) stores shared regional data once and keeps a bounded number of scenarios resident. The [HTTP API](guides/rust-standalone.md#15-http-api-and-server-operation) lists every endpoint and status code.

### Resource controls

Compose defaults to 2 CPUs, 2 GiB of memory, two native threads, two resident scenarios, and one native query worker with a bounded queue. It uses a read-only root filesystem and City mount, drops Linux capabilities, and caps logs at two 5 MB files.

| Environment setting | Default | Meaning |
| --- | --- | --- |
| `VIGO_LOCAL_PORT` | `8080` | Loopback port on the host |
| `VIGO_CPUS` / `VIGO_MEMORY` | `2` / `2g` | Container CPU and memory limits |
| `VIGO_THREADS` | `2` | Native parallel threads |
| `VIGO_MAX_RESIDENT_SCENARIOS` | `2` | Maximum resident scenario views |
| `VIGO_ENDPOINT_CACHE_MAX_BYTES` | `8388608` | Shared endpoint-cache budget |
| `VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES` | `8388608` | Shared geometry-cache budget |
| `VIGO_MAX_QUEUE` | `8` | Waiting queries |
| `VIGO_MAX_CONNECTIONS` | `16` | Active HTTP connections |
| `VIGO_MAX_BODY_BYTES` | `8388608` | Maximum request body |
| `VIGO_REQUEST_TIMEOUT_MS` | `10000` | Request and response I/O timeout |
| `VIGO_QUERY_TIMEOUT_MS` | `30000` | Queue and execution deadline |

Before raising these limits, read [Resource limits and constrained serving](guides/resource-limits.md): extra processes are not a free speedup, and swap is never counted as RAM.

The worker reuses its network and workspaces, prioritizes short queries, and gives queued analytical work a bounded turn. A deadline or cancellation terminates running work and reloads the worker, and readiness is unavailable during recovery. A full queue returns an error instead of accepting unbounded work. Responses are limited to 64 MiB; split large matrices or omit geometry when appropriate.

`GET /healthz` checks the HTTP process and `GET /readyz` checks worker availability. The container runs `vigo health` against `/readyz`; the probe loads no City and needs no shell, curl, or Node. The restart policy restarts exited containers, not merely unhealthy ones.

### Run without Docker

The engine archive runs directly: `vigo serve --city ./city --host 127.0.0.1 --port 8080`, checked with `vigo health --port 8080`. [Authentication and hosting](guides/rust-standalone.md#16-authentication-and-generic-deployment) covers tokens, reverse proxies, and a systemd unit.

### Operate and upgrade

Prepare a new City in a separate directory, verify saved requests against the candidate, and switch the image and City together. Never replace files that a running service has mapped, and keep the previous accepted image and City for rollback; see [Upgrade and rollback](#upgrade-and-rollback). [Service benchmarking](developer.md#reproduce-a-service-workload) records cold start, first-query and sustained latency, memory, and disk costs. Stop the service with `docker compose -f deploy/compose.yml down`; the City stays on the host.

## Upgrade and rollback

Keep a running application and its prepared City together until the replacement passes your saved requests. A new release does not by itself make an older City compatible or incompatible; the prepared-data contract decides.

### Before changing versions

1. Save the runtime version, package checksum, `capabilities` output, and City inspection (`vigo info --city ./city`, or `vigo-build inspect --city ./city`).
2. Keep the original GTFS and OSM inputs, their checksums, build options, and any scenario definitions. Prepared data is not a substitute for sources.
3. Keep representative Route, Matrix, and Reach requests and their expected Results, including your transfer, walking, and arrive-by constraints.

### Prepared City policy

Cities built with VIGO 0.5.0 or later are a permanent baseline: later readers open them without rebuilding, and standard writers keep producing Cities the published 0.5.0 runtime can read. The [prepared-data contract](reference/format-0.5.0.md) defines that promise and its release gate.

Cities from before 0.5.0 are not converted. Rebuild them from the original sources into a **different output directory**:

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf --output ./city-next
vigo info --city ./city-next
vigo route --city ./city-next --request route.json
```

The runtime checks timetable, transfer, street, access, and accelerator formats separately, so the outer `vigo.city.v1` manifest alone is not enough, and editing a format marker cannot migrate contents. Optional query caches may be regenerated from an admitted City. Treat published City files as immutable while a service has them open.

### Validate, switch, and recover

Run the saved requests against the candidate through the interface your application actually uses. Check schemas, no-journey outcomes, walking geometry, arrival and departure times, boardings, and resource use, and test a cold start as well as repeated requests. Start a second service with `city-next`, check readiness, and replay the requests before switching the application endpoint. Roll back by restoring the previous binary and City together, and never overwrite a live memory-mapped City.

### Checks you can run yourself

From a source checkout with the documented toolchain:

```sh
npm ci
npm run build:cli-runtime
npm run build:standalone
npm run check:correctness
npm run check:public-results
npm run check:portability
npm run package:standalone
python3 test/check-standalone-package.py
```

These use public synthetic inputs and cover independent objective verification, difficult routing cases, public schemas, City relocation, and operation from the extracted package. They need no private benchmark files or maintainer service. Platform CI runs the broader release checks; a local pass does not establish that unrun platforms passed. Use the [service benchmark](developer.md#reproduce-a-service-workload) to keep comparable latency and storage measurements for your workload.

## Troubleshooting

Identify which stage failed: installation, City build or open, request validation, computation, or interpretation. Keep the failing command and its output before changing inputs. For a version change, follow [Upgrade and rollback](#upgrade-and-rollback) first.

### Check the runtime and City

```sh
vigo --version
vigo capabilities --pretty
vigo info --city ./boston --pretty
vigo-build help route
```

`capabilities` describes the running binary and `info` identifies the City. Neither proves that a date has service or that a route is reachable. Source changes take effect only after rebuilding.

### Build or open fails

| Symptom | Check | Next step |
| --- | --- | --- |
| Node version error | `node --version` against the declared requirement | Install Node.js 24.18 or newer |
| Native build or load failure | OS and CPU, the pinned Rust toolchain, and the native linker | Build on the machine type that will run VIGO; executables are not portable, City data is |
| Output City already exists | Whether this is a new revision or a replacement | Prefer a new output directory; use `--replace` only for an intended replacement |
| Missing or corrupt street files | Whether the entire City was copied | Restore a complete City or rebuild; never copy individual databases between Cities |
| `Expected a prepared vigo.city.v1 City` | The `--city` path | Point to the compiler's complete output containing `network.json` |
| Missing or stale access or CCH artifact | Whether files came from different builds | Rebuild or recopy the whole City with a compatible compiler |
| Unexpected SQLite WAL | Whether the build completed | Complete the build and copy a consistent, immutable City |
| First query slower than later ones | Whether timetable or access preparation ran | Use `--prepare-date`, and separate preparation from resident query time |
| City absent from Studio's library | Which interface created it | Studio imports its own projects and cannot open compiler City directories |

### A request is rejected

| Symptom | Check |
| --- | --- |
| Invalid or uncovered date | Use an exact local `YYYY-MM-DD`; inspect `calendar.txt` and `calendar_dates.txt` |
| A flag seems to ignore the JSON | Flags override request fields; remove the flag or the field |
| Point cannot be resolved | Use an exact, case-sensitive stop ID or `[longitude, latitude]`; place names are not geocoded |
| `Unknown point field` | Write points as `{"coordinate": [...]}` or `{"stopId": "..."}`, with optional `id` and `name`; the compiler's older `{"id", "point"}` matrix form is not accepted by the engine |
| Transfer cap with transit waypoints | Unsupported; omit the cap or change the experiment |
| Realtime or Scenario rejected by Matrix or Reach | See the [support table](#choose-a-supported-combination) |
| Matrix request too large | The compiler allows 100,000 pairs in 16 MiB, the engine 65,536 pairs in 8 MiB |
| Piped request appears to wait | `--request -` waits for one complete object and for stdin to close |

Invalid requests exit with status `2` and explain the failure on stderr. If an old `--output` file exists, a failed run can leave it unchanged; do not mistake it for a fresh Result.

### Route returns no journey

A public Route returns `status: "not_found"` when no journey satisfies the request. Read `warnings` and `quality`, then request `diagnostics: "trace"` for `searchLimits` and `accessAvailability`.

1. Confirm the City revision, date, time, and mode. GTFS time `25:10` belongs to the previous calendar day's service date, not to a new day at `01:10`.
2. Check whether transit is required. A direct walk competes by default; `requireTransitRide: true` requires a boarding.
3. Check each endpoint's walking access. A stop that is close in a straight line may lack a verified street path, and `outside_selected_budget` only proposes a wider check.
4. Check the horizon, transfer cap, and timetable. For depart-at, the horizon bounds boarding and alighting, not door-to-door duration.
5. If a changed constraint is justified, save it as a new request and keep the blocked Result as part of the analysis.

Never silently raise walking limits, substitute service dates, or turn blocked durations into zero. [Route diagnostics](#result-and-diagnostics) explain the bounded failure categories.

### Live reports and routes disagree

| Observation | Interpretation |
| --- | --- |
| A vehicle is visible but its trip is unavailable to Route | Vehicle Positions do not create timetable service; added-service display and routing admission are separate |
| Realtime times equal the schedule | Unreported trips keep scheduled times; read admitted and excluded counts and any fallback |
| A saved snapshot stops applying later | Freshness is checked against the captured clock; a saved observation is not live forever |
| An alert describes a disruption but the route is unchanged | Text alerts are display evidence and close nothing automatically |
| Playback shows a vehicle that is not reporting | Scheduled playback is labeled Estimated and interpolates the timetable |

Keep the service date, source scope, trip identity, feed timestamp, and record timestamp together. See [Network and Routes](#network-and-routes) and [realtime routing](#realtime-journey-routing).

### Results or comparisons look unexpected

A Matrix `ok` status can include unreachable `null` cells, and arrive-by Matrix durations include destination waiting. Matrix comparison requires identical ordered endpoints and Reach comparison identical grids; means exclude unreachable cells. For a path that appears to jump to a platform, inspect its station-path and coordinate-snap qualifications: a visible line is not evidence of an entrance connection.

### Report a reproducible issue

Include the VIGO version, OS and CPU, the failing command, the request, the City inspection summary, stderr, and the full Result if one was returned. Say what you expected and whether it reproduces with the same inputs, and share a minimal redistributable fixture when possible. Review paths, coordinates, credentials, and source licenses before attaching files to a public issue, and use the [security policy](../SECURITY.md) for vulnerabilities. [Keep a reproducible run](reference/results.md#keep-a-reproducible-run) explains what to retain.
