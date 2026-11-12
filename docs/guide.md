# VIGO 1.0.0 guide

The source of the [VIGO guide](guide.html), one offline page that also contains the [engine reference](guides/rust-standalone.md), the [public results reference](reference/results.md), [how VIGO computes answers](reference/methodology.md), [VIGO Python](../python/docs/guide.md) and the [developer guide](developer.md). `docs/navigation.json` arranges the chapters into pages. Edit a chapter, then run `npm run docs:build`.

## Build a network. Answer a transport question.

VIGO 1.0.0 turns GTFS timetables and OpenStreetMap streets into a reusable City, then answers three questions about it: how to make a journey, how long every trip takes, and how far people can get. It runs on your own machine, explains each answer, and never needs an internet connection to route.

### Start here

- **[Build your first City](#quickstart)** Download Boston's public timetable and streets, build a City, and plan a trip from Harvard Square to South Station.
- **[Install VIGO](#install-vigo)** Pick the engine, the compiler, the desktop Studio or the Python package.
- **[Serve an HTTP API](guides/rust-standalone.md#http-api)** Answer Route, Matrix and Reach from one executable with no runtime dependencies.
- **[Analyze in Python](../python/docs/guide.md)** Run batches and notebooks against a City, and export journey and leg tables.

### Three questions, one City

| Query | It answers | Read more |
| --- | --- | --- |
| **Route** | How do I travel between these places, and what happens on the way? | [Route](#route) |
| **Matrix** | How long does each origin–destination pair take? | [Matrix](#matrix) |
| **Reach** | Where can I get within 15, 30 or 45 minutes? | [Reach](#reach-and-isochrones) |

A **Scenario** changes the service one query sees, such as a new line or a removed route, so you can measure a proposal against today's network. **Compare** sets two saved Results side by side without routing again.

### Choose your interface

| Interface | Best for | What it needs |
| --- | --- | --- |
| **Engine** (`vigo`) | Queries, resident streams and the HTTP API | One native executable; no Node, Python or network access |
| **Compiler** (`vigo.mjs`) | Building Cities and scenario collections; it can also query them | Node.js 24.18 or newer, with its bundled native kernel |
| **Studio** | Inspecting service, planning journeys, and exploring Reach and scenarios | The desktop application |
| **Python** (`import vigo`) | Studies, batches, notebooks and journey tables | A platform wheel with a headless engine |

The engine, the compiler and Python open the same City directories, and for the same City and request the engine and the compiler return the same public JSON Result.

### Built to be explained

Every answer carries its evidence. A Route Result says whether each walk follows mapped streets or an assumed station link. A Matrix keeps unreachable pairs `null`, never zero. A Reach surface records its grid so two runs can be compared cell by cell. [Known limits](#known-limits) state plainly what the model does not establish.

- **Exact search.** Transit is one exact connection scan over the prepared timetable, with published transfer rules and frequencies. See [how VIGO computes answers](reference/methodology.md).
- **Stable data.** Published Cities stay readable by later releases without rebuilding. See the [prepared-data contract](reference/city-format.md).
- **Stable results.** The public `vigo.route.v1`, `vigo.matrix.v1` and `vigo.reach.v1` schemas only gain optional fields. See [public results](reference/results.md).
- **Offline.** Queries never fetch anything. This guide works offline too: press `/` to search, and open saved Results in the [Result viewer](#inspect-a-saved-result).

### How this guide is organized

| Section | Read it to |
| --- | --- |
| **Get started** | Install VIGO, build a City and learn the four core ideas |
| **Guides** | Do one task: build a City, plan journeys, compute matrices, map Reach, test a scenario, use live data |
| **Studio** | Use the desktop application |
| **Deploy and operate** | Run the HTTP service, size it, upgrade it |
| **Reference** | Look up every command, flag, request field, Result field, endpoint and environment variable |
| **How VIGO works** | Understand the algorithms, what is exact, and what the model leaves out |
| **Help** | Fix a problem or look up a term in the [glossary](#glossary) |

### Get help

Search this guide with `/`. Check [Troubleshooting](#troubleshooting) and [Known limits](#known-limits) first. Report reproducible problems on [GitHub issues](https://github.com/hytangs/vigo/issues), following [Report a reproducible issue](#report-a-reproducible-issue), and report vulnerabilities through the [security policy](../SECURITY.md). Release history is in the [release notes](releases/1.0.0.md) and the [changelog](../CHANGELOG.md).

## Install VIGO

VIGO has four entry points. Most projects use two: the **compiler** builds a City once from raw data, and the **engine** answers queries from it for as long as you like.

| You want to | Install | Requirements |
| --- | --- | --- |
| Query a prepared City or serve HTTP | Engine archive (`VIGO-Rust-…`) | Nothing else at query time |
| Build Cities from GTFS and OSM | Compiler archive (`VIGO-CLI-…`) | Node.js 24.18 or newer |
| Explore networks visually | VIGO Studio (`VIGO-Studio-…`) | The desktop application |
| Script analyses and notebooks | VIGO Python (`VIGO-Python-…`) | Python 3.10 or newer and the wheel for your platform |

Download archives from [VIGO releases](https://github.com/hytangs/vigo/releases). Each archive targets one operating system and CPU; City data moves freely between the supported 64-bit platforms. Each archive has a `.sha256` checksum, and the engine and compiler archives hold a `manifest.json` that hashes every file.

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

The executable contains the routing kernels, the City loader, the JSON interface, the HTTP server and SQLite. The archive also holds this guide (`guide.html`), the OpenAPI document, the [engine reference](guides/rust-standalone.md) as `README.md`, the native field reference, a verification record and licenses.

### Compiler

The compiler archive contains `vigo.mjs`, its matching native kernel (`vigo-routing-kernel.node`), the `vigo` executable it uses for Reach, license notices and a checksum manifest. Keep the files together and check them with Node.js 24.18 or newer:

```sh
node vigo.mjs --version
node vigo.mjs capabilities
```

The compiler builds Cities and scenario collections and runs Route, Matrix, Reach, Stream and Compare against them. It bundles neither Node nor City data. Its reference is the [compiler guide](guides/cli-only.md), which ships in the archive as `README.md`.

### Build from source

Use Node.js 24.18 or newer, npm 11.6 or newer, the Rust toolchain pinned in `rust-toolchain.toml`, and a C toolchain for the bundled SQLite. Build on the operating system and CPU that will run VIGO:

```sh
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build:cli-runtime
npm run build:standalone
```

`build:cli-runtime` produces the compiler, `public/vigo.mjs`, and its native kernel. `build:standalone` produces the engine at `target/release/vigo`. `npm run build` also compiles Studio, and `npm run studio` opens it. On a machine with 4 GiB of memory or less, the build selects low-memory compiler settings automatically; see [build from source on a small machine](developer.md#build-on-a-small-machine).

### Name the commands

The guides call the engine `vigo` and the compiler `vigo-build`. In a POSIX shell:

```sh
alias vigo="/absolute/path/to/vigo"
alias vigo-build='node "/absolute/path/to/vigo.mjs"'
```

From a source checkout, point them at `target/release/vigo` and `public/vigo.mjs`. On Windows, use `.\vigo.exe` and `node .\vigo.mjs`, or define your own functions. Both accept `--name value` and `--name=value` and reject unknown options.

### Studio and Python

**VIGO Studio** is the desktop workspace. It imports GTFS and OSM into its own project library and opens this guide offline under **Settings → Documentation**. See [VIGO Studio](#vigo-studio). macOS Studio builds are ad hoc signed, not notarized: if macOS blocks the first launch, verify the download's checksum, then choose **Open Anyway** under **System Settings → Privacy & Security**.

**VIGO Python** is versioned separately and its platform wheels include a headless engine. Follow [your first Python query](../python/docs/guide.md#your-first-python-query).

### Supported platforms

- macOS 13.5 or newer on Apple Silicon (Python wheels need macOS 14), Linux with glibc 2.39 or newer on x64 and ARM64 (built on Ubuntu 24.04), and Windows x64. There are no 32-bit or Windows ARM64 binaries. For an older Linux, build from source there.
- The engine container image runs on Debian with glibc; see [Deploy the routing engine](#deploy-the-routing-engine).
- Studio maps need WebGL 2. The engine, the compiler and Python need no graphics device.

## Quickstart

In about ten minutes you will build a City for **Boston and Cambridge** from public data, plan a journey from **Harvard Square to South Station**, compute a small matrix, and map where you can reach in 45 minutes. A **City** is the prepared data directory, here `./boston`.

You need the [engine and the compiler](#install-vigo), named `vigo` and `vigo-build`, plus `curl`, `unzip` and [Osmium Tool](https://osmcode.org/osmium-tool/manual.html). The commands use a POSIX shell; on Windows, use WSL for the download and extract steps.

> [!TIP]
> Every request below works with either runtime. Replace `vigo` with `vigo-build` to run a query through the compiler; the Result is the same.

### 1. Download the Boston inputs

Two files supply different parts of a journey:

| Data | Official source | What VIGO uses it for |
| --- | --- | --- |
| MBTA static GTFS ZIP | [MBTA GTFS documentation](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md), [download ZIP](https://cdn.mbta.com/MBTA_GTFS.zip) | Stops, trips, calendars, transfers, fares and shapes |
| Massachusetts OpenStreetMap PBF | [Geofabrik Massachusetts](https://download.geofabrik.de/north-america/us/massachusetts.html), [download PBF](https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf) | Streets for walking to, from and between stops, and for walking, driving and cycling |

No API key is needed. Choose the **static GTFS ZIP**, not GTFS-Realtime, and the **`.osm.pbf`**, not a shapefile or GeoPackage.

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

`feed_start_date` and `feed_end_date` give the published interval. The feed used to check this tutorial covers **2026-09-25 through 2026-12-12**, and the examples use Monday **2026-10-05**. With a later download, pick a date inside its interval and check `calendar.txt` and `calendar_dates.txt`: a date inside the interval does not mean every route runs that day. Times are local MBTA service times in `America/New_York`.

### 2. Build the City

Cut a smaller street extract around central Boston and Cambridge, then build:

```sh
osmium extract --bbox=-71.20,42.25,-70.95,42.45 --strategy=complete_ways \
  data/massachusetts-latest.osm.pbf --output=data/boston.osm.pbf
vigo-build build --gtfs ./data/MBTA_GTFS.zip --osm ./data/boston.osm.pbf \
  --output ./boston --prepare-date 2026-10-05
vigo info --city ./boston --pretty
```

The [complete-ways strategy](https://docs.osmcode.org/osmium/latest/osmium-extract.html) keeps every node of the ways crossing the rectangle. This extract covers the tutorial's places, **not street access for the whole MBTA network**; for a wider study, enlarge it or use the full Massachusetts PBF. `--prepare-date` compiles that day's timetable now, so a fresh engine process does not have to. Keep the providers' notices when you share data; see [OpenStreetMap attribution](https://www.openstreetmap.org/copyright).

VIGO writes one complete `./boston` directory and leaves an existing output alone unless you pass `--replace`. `vigo info` shows the City's name, revision, sources, counts and limitations. Keep the whole directory: the inspection output identifies the City but contains no routing data.

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

In a terminal, the first command prints a short itinerary; the second saves the full JSON Result. To ask when to leave to **arrive by 09:00**, override the clock and the time direction:

```sh tab="Engine"
vigo route --city ./boston --request route.json --time 09:00 --arrive-by
```

```sh tab="Compiler"
vigo-build route --city ./boston --request route.json --time 09:00 --time-preference arrive
```

Flags override fields in the request file. In JSON, the same choice is `"time": "09:00", "timePreference": "arrive_by"`, which both runtimes accept.

### 4. Read the Result

Read `status` first. `ok` comes with a `journey`; `not_found` is a valid answer meaning no journey meets the date, walking limit, transfer cap and horizon you asked for. Then read `journey.departureTime`, `journey.arrivalTime` and the ordered `journey.legs`. Clocks are local service-day `HH:MM:SS`; durations are whole seconds.

Trip IDs and times depend on the feed you downloaded, and this is scheduled routing without live delays. Check `warnings` and each walk's `quality` before treating a path as passenger guidance; [walking evidence](reference/walking-evidence.md) explains station costs and assumed links. Open `route-result.json` in the [Result viewer](#inspect-a-saved-result) to see it as a timeline.

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

Read `durationsSeconds[origin][destination]` in request order, and the matching `journeys` entry. An unreachable pair is `null`, never zero.

### 6. Map where you can go

Save `reach.json` to find the streets and areas reachable from Harvard Square within 15, 30 and 45 minutes:

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

`surface.valuesSeconds` is a row-major raster starting at the northwest corner, and `areas` holds a GeoJSON polygon for each cutoff. A Reach surface is modeled travel time; it is not a count of jobs or people. See [Reach](#reach-and-isochrones).

### 7. Keep the City loaded

A one-off command opens the City every time. For repeated work, keep one process resident. Save `queries.ndjson` with one request per line:

```jsonl
{"id":"harvard-south-depart","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"serviceDate":"2026-10-05","time":"08:00","maxWalkKm":1.2,"maxTransfers":3}
{"id":"harvard-south-arrive","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"serviceDate":"2026-10-05","time":"09:00","timePreference":"arrive_by","maxWalkKm":1.2,"maxTransfers":3}
```

```sh
vigo stream --city ./boston < queries.ndjson > results.ndjson
```

Each output line echoes its `id`; check every `status`, because one failed line does not end the stream. To serve applications over HTTP, start the service and call it from a second terminal:

```sh
vigo serve --city ./boston --port 8080
curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H 'Content-Type: application/json' --data-binary @route.json
```

Open `http://127.0.0.1:8080/` to read this guide from the running service and send requests from the API console on the [HTTP API](guides/rust-standalone.md#http-api) page. When you measure speed, keep the City build, a fresh process's first answer, and answers from a resident process separate.

### Where next

- **[Core concepts](#core-concepts)** City, Scenario, Query, Result, outcomes and time.
- **[Route](#route)**, **[Matrix](#matrix)** and **[Reach](#reach-and-isochrones)** Every option, with worked examples.
- **[Scenarios](#scenarios)** Test a planned service change against today's network.
- **[Deploy the routing engine](#deploy-the-routing-engine)** Run the HTTP service in a container.

## Core concepts

VIGO has four nouns and three questions. Once these are clear, every interface behaves the way you expect.

```text
GTFS + OSM ──build──▶ City ──(optional Scenario)──▶ Route | Matrix | Reach ──▶ Result
```

### City

A City is a compiled model of a transport network, built from GTFS and OSM. It is one complete directory, so its timetable, streets and prepared indexes cannot drift apart. Each build is a new, immutable **revision**; Scenarios and Results stay tied to the revision that produced them.

A City reopens without its raw GTFS or OSM. Building prepares the street indexes and station access. The first query for a new set of active services prepares a timetable, which `--prepare-date` can do ahead of time; dates with the same active services share it. A resident process keeps everything ready between queries. Changing the underlying data needs a new build.

### Scenario

A Scenario is an immutable set of changes applied to one City revision: planned service changes, one live transit state, or one supplied traffic state. Requests carry them as `scenario`, `realtimeSnapshot` and `traffic`. Walking limits, departure times and cutoffs remain query options, and a complete alternative GTFS feed is a new City revision, not a Scenario.

VIGO rejects an unsupported combination before computing. It never silently drops a change or moves a Scenario to another City revision. See [Scenarios](#scenarios).

### Query

| Query | What it computes | Notes |
| --- | --- | --- |
| Route | Travel between ordered places, with legs, transfers and walking | Depart-at or arrive-by; via points, alternatives and departure windows are options |
| Matrix | Travel time between sets of origins and destinations | A single origin is a one-row Matrix; journeys are optional |
| Reach | Where the network can take you within stated time limits | As reached streets, areas or contours |

Depart-at minimizes arrival time, then boardings, then walking. Arrive-by maximizes departure time; among journeys leaving at that time and arriving by the deadline, it minimizes boardings, walking and actual arrival.

Reach is not accessibility. An accessibility measure also needs opportunities, such as jobs, people, schools or clinics, and a stated way to combine them.

### Result

A Result is the immutable answer to one Query: status, values, warnings, the City revision, the Scenario if any, and metadata to reproduce it. Compare is an action on two compatible Results, not a fourth query. Keep the original request and the full Result together; the `query` echo is useful but does not archive every input. See [public results](reference/results.md).

### Choose a supported combination

| Query | Travel mode | Time | Supplied changes or observations |
| --- | --- | --- | --- |
| Route | Transit | Depart-at or arrive-by; via points and windows have their own rules | Realtime Trip Updates and Alerts; a planned-service Scenario in the engine |
| Route | Walk, Drive or Bike | Either direction; a dated Bike route checks timed roads and turns | Traffic for Drive |
| Matrix | Transit | A shared departure or deadline | Realtime Trip Updates in the engine |
| Matrix | Walk, Drive or Bike | Street travel times; a dated Bike matrix checks timed roads and turns | Traffic for Drive |
| Reach | Transit with walking, Walk, Drive or Bike | Depart-at from an origin or arrive-by at a destination | A planned-service Scenario and realtime Trip Updates for transit in the engine |

"In the engine" means the `vigo` executable and its HTTP API; the compiler and Python reject that combination. `vigo capabilities` describes the build you run. Queries default to scheduled data. Traffic needs both the `traffic` object and `routingDataMode: "realtime"`; VIGO never fetches a traffic provider unless `vigo serve` is told to poll one. A visible vehicle, an alert or an added trip is not by itself a routing update.

### Outcomes

- Route and Reach Results use `ok` or `not_found`. A completed Matrix is `ok`, with `null` for unreachable cells.
- An invalid or unsupported request fails with an error: exit code 2, or HTTP 4xx. A failure during computation is an error too, never a Result.
- Python Results use `ready` and `blocked`; those names belong to the Python API.
- Studio background tasks report `queued`, `running`, `ready`, `cancelled` or `error`.

### Time

Service dates use the City's timetable timezone. A GTFS event at `25:10` belongs to the service date it was published on, even though it happens after midnight. Request clocks may exceed 24 hours, so always give the exact service date with the clock. Realtime observation timestamps are a separate clock, used only to admit or reject predictions.

VIGO keeps four durations separate: Build, Open, Compute and End-to-end. Reusing an open process saves opening work; it never reuses an answer.

## Build a City

A City is built once by `vigo-build` and then opened read-only by any number of engine processes, Python sessions or compiler queries. The [quickstart](#quickstart) shows a complete Boston build; the [compiler guide](guides/cli-only.md) lists every option.

### Choose inputs

| Input | Requirement |
| --- | --- |
| GTFS | One or more **static GTFS ZIP** files |
| OSM | One **`.osm.pbf`** covering every origin, destination, stop and transfer location you will query |

Keep the original files, their checksums and their download date: URLs such as `latest` are not frozen datasets. [GTFS support](developer.md#gtfs-support-matrix) lists the GTFS features VIGO uses and those it reports as unsupported.

### Build options

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf --output ./city
vigo-build inspect --city ./city
```

| Option | Effect |
| --- | --- |
| `--gtfs PATH` | A GTFS ZIP; repeat for several feeds |
| `--gtfs-scope NAME` | A unique, stable scope for each `--gtfs`; see [combine several feeds](#combine-several-gtfs-feeds) |
| `--prepare-date YYYY-MM-DD` | Compile a service date's timetable now; repeat for other dates |
| `--street-modes walk,drive` | The default: walking and driving |
| `--street-modes walk` | Walking only; omits driving and bicycle data |
| `--street-modes walk,bike` or `walk,drive,bike` | Adds bicycle streets; see [Bicycle routing](#bicycle-routing) |
| `--private-access endpoints` | Allow mapped private paths at trip ends; see [authorized endpoint access](#authorized-endpoint-access) |
| `--wheelchair` | Build a strict wheelchair City; see [Wheelchair routing](#wheelchair-routing) |
| `--wheelchair-streets inferred\|verified` | Street evidence for a wheelchair City |
| `--streets-from ./other-city` | Reuse identical prepared streets from another City |
| `--replace` | Replace an existing output |

A build is staged: a failed build leaves the previous City in place. `--replace` writes and flushes the new City first, then swaps it in; if a crash interrupts the swap, the next `vigo-build build` or compiler query of that path finishes or reverts it. A successful replacement removes its backup, so use a separate output directory when you need a rollback copy.

Import and street preparation happen at build time and are separate from query time.

### Combine several GTFS feeds

Repeat `--gtfs` and give each feed a stable, unique scope:

```sh
vigo-build build \
  --gtfs ./rail.zip --gtfs-scope rail \
  --gtfs ./bus.zip --gtfs-scope bus \
  --osm ./region.osm.pbf \
  --output ./city
```

A scope names a **source feed**, not a route. The combined City namespaces stops, routes, trips, services and transfers by scope, so equal IDs in different feeds never collide. Use the same scopes when you rebuild the same sources. In Studio, add each ZIP under **City → Data sources**; removing a feed rebuilds the combined timetable from the rest.

Before combining feeds:

- Use compatible service dates: a trip runs only on days its own calendar activates.
- Keep all agencies in one timezone. A City with several agency timezones cannot route.
- Avoid importing two editions of one agency's timetable unless you mean to.
- Keep declared transfers and check street coverage between the feeds. Nearby stops alone do not prove a usable connection.

### Large regions and low memory

Builds use disk-backed SQLite temporary storage and compact node lookups, report progress during long phases, and respect container memory limits when deciding whether GTFS and OSM work can overlap. Import and street preparation run in separate processes, so each releases its memory before the next. Keep the output and temporary directory on a local filesystem (inside WSL, the Linux filesystem rather than `/mnt/c`), with room for the source database, temporary sorts and the finished City.

Regional street preprocessing can still exceed 2 GiB. Add disk-backed swap on the build machine, or build on a larger machine and copy the complete City to the server: build memory and query memory are separate requirements.

Driving preparation accepts up to 40 million vertices (`VIGO_DRIVE_ACCELERATOR_MAX_NODES`) and 20 million edges (`VIGO_DRIVE_ACCELERATOR_MAX_EDGES`), which fits national extracts such as Switzerland's. A larger network fails with its counts; raise the limits, or omit driving with `--street-modes walk` or `walk,bike`. Street preparation must write the walking index before the City is sealed, so a City that could not open is never published.

### Timetable repairs

A build repairs small backward arrival or departure times by delaying an event to the one before it, by at most ten minutes per event. Stops, trips and permissions are kept, and the GTFS file is unchanged. Trips that need a larger correction are excluded whole. Repairs (`repaired_trip_times`, marked `approximate`) and exclusions (`backward_trip_times`) appear as build warnings and in the City's limitations, with up to 32 example trip IDs. Published times such as `24:10:00` are valid; a reset to `00:10:00` is not read as the next day. Broken references and duplicate stop sequences still fail the build.

### Copy and load a City

A City contains `network.json`, `routing/project.sqlite`, prepared access files, and an `osm` directory with street snapshots, access profiles and hierarchy indexes. Member names vary with the preparation version. Copy the **whole directory**, never single files.

The engine checks source identities, formats, station and access profiles, and required index files. It rejects missing or stale preparations and an unexpected SQLite WAL. Complete a City through its compiler; never delete WAL files to get past validation. The engine reports `timing.timetableSource: "prepared_snapshot"` in the trace when it reuses a prepared timetable, and `"source"` when it prepared one from SQLite; both give the same schedule.

### Update a network

Treat a published City as immutable while any process has it open. Build updates into a new directory, start a service on it, check readiness and a known query, switch traffic, then stop the old service. The engine has no upload endpoint, downloader or hot reload. See [Upgrade and rollback](#upgrade-and-rollback).

Older Cities may lack optional street names for map points. The [prepared-data contract](reference/city-format.md#add-street-names-to-an-existing-city) shows how to add them without rebuilding.

### Scenario collections

To compare several timetables over one street network, build a scenario collection: one shared street graph, several transit scenarios and a default. Each request picks a member with `scenarioId`. See [Scenario collections](guides/rust-standalone.md#scenario-collections) for the manifest.

## Route

Route finds and explains travel between ordered places. This chapter shows how Route behaves; the [Route reference](guides/rust-standalone.md#route-requests) lists every field.

### Plan a journey

A Route request names:

- an origin, optional ordered via points, and a destination;
- transit, walk, drive or bike;
- an exact service date and local time, and depart-at or arrive-by;
- a walking limit, an optional transfer cap, and optional alternatives or a departure window.

Stop IDs are exact GTFS identifiers. Coordinates are `[longitude, latitude]` and need streets in the City. Save `journey.json`:

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

Check `status`, then the chronological `journey.legs`. A `not_found` Result can reflect the date, the timetable, street access or your constraints; it does not mean the places are disconnected. [When no journey is found](#when-no-journey-is-found) lists the checks.

### Walking and transit

Transit Route and Matrix compare a direct OSM walk by default, so a short trip between coordinates can return walking when it arrives sooner. Set `requireTransitRide: true` to require a boarding, or `"mode": "walk"` to ask for walking alone.

- `maxWalkKm` (default 1.2) limits each walk to and from transit.
- A direct walk is limited by `maxStreetKm` (default 50), or by `maxWalkKm` when `allowLongWalk` is `false`. Walk mode always uses `maxStreetKm`, which accepts 0.05–1000 km.
- `horizonMinutes` (default 480, 1–2880) bounds the timetable search. For depart-at transit, every boarding and alighting must happen within it, but the final walk can finish after it: the horizon is not a door-to-door limit.
- `allowStreetTransfers: false` keeps changes to the same stop or to members of one station. Walking to the first stop and from the last stays allowed. Studio calls this **Allow walks between stations or stops**.

### Transfers and time reserves

`maxTransfers` accepts 0–31: `0` allows one boarding, `1` two. Staying aboard the same vehicle is not a transfer. The cap constrains the search itself, so a slower route is found when the fastest one has too many changes. A finite cap cannot be combined with transit via points.

`minimumTransferBufferMinutes` (0–60, default 0) adds time before each later boarding, after the transfer walk and the feed's own minimum transfer time. It never delays the first boarding, the final walk or staying aboard. `arrivalBufferMinutes` plans an arrive-by request against an earlier deadline. Both are planning margins, not delay predictions; see [Time reserves](#travel-time-uncertainty).

The engine adds no buffer of its own. Same-stop changes honor published GTFS minimum transfer times and forbidden transfers, and a published platform-to-platform rule takes precedence over the station walking fallback. Studio starts with a one-minute buffer, which Preferences can change.

### How a journey is chosen

VIGO's objective is earliest arrival. Equal arrivals prefer fewer boardings, then less walking, then a stable order. Arrive-by first finds the latest departure; among journeys leaving then and arriving by the deadline, it prefers fewer boardings, less walking, then earlier actual arrival, so a slightly later on-time arrival can avoid a needless change.

Via-point routes compare complete journeys, so walking a segment can replace a short ride when both catch the same onward vehicle. Up to eight partial journeys are kept at each via point and up to five complete choices are returned; this bounded search does not list every itinerary. [How VIGO computes answers](reference/methodology.md#transit) explains the algorithm and its guarantees.

### Several journeys

- **Alternatives.** `"alternatives": 3` asks a depart-at transit Route for more journeys at the requested time. The default `pareto` ranking keeps genuine trade-offs between arrival, boardings and walking; `"alternativeRanking": "ranked"` lists the earliest distinct journeys, even when one beats another in every respect. See [alternative journeys](guides/rust-standalone.md#alternative-journeys).
- **Departure windows.** The engine's `windowMinutes` repeats the search every minute toward later departures (or earlier deadlines) and keeps up to five distinct choices. The compiler's `departureWindowMinutes` is a centered depart-at window of ±0–30 minutes. Windows sample whole minutes; they are not continuous timetable profiles. See [journey windows](guides/rust-standalone.md#journey-windows).
- **Services on the same leg.** `sharedLegs: true` lists other trips that could replace one leg, with their observed frequency. See [shared-leg services](guides/rust-standalone.md#shared-leg-services).

### Read the Result

The public `vigo.route.v1` Result contains `status`, a `journey` with chronological legs and durations in seconds, `warnings`, and `meta`. Every leg has a `quality` that says where its line came from and whether its street path was verified. [Public results](reference/results.md#route) defines every field.

### When no journey is found

A `not_found` Result has `journey: null`, a `reason` (`code` and `message`) and an `access` report for each end. Each report gives the `maximumWalkMeters` searched, the `candidateCount` of stops found, and a `code`:

| `access.*.code` | Meaning |
| --- | --- |
| `available` | Stops were reached; the failure lies in the timetable or the limits |
| `outside_selected_budget` | No stop within `maxWalkKm`, but one within the wider `probeWalkMeters`; `suggestedWalkMeters` is its distance. A wider limit is a new question, and still may not give a journey |
| `street_access_unverified` | A stop is near in a straight line (`nearestStop`), but no walking path reaches it |
| `none_within_walk_budget` | The point attaches to the streets, but no stop is within the limit or the probe |
| `no_street_attachment`, `disconnected_street_attachment` | The point cannot attach to a usable street |
| `outside_coverage` | The point lies outside the City's streets; `coverageBounds` gives their extent |
| `station_access_unavailable` | A named stop has no usable access in this City |

VIGO never raises your walking limit by itself. `no_path` means no scheduled itinerary under the request's limits on that date; changing a limit is a new question, so save it as a new request. `diagnostics: "trace"` adds the search limits and candidate details.

### Stations, access and geometry

Free coordinates and GTFS stops attach to the nearest street the same way in Route and Matrix. A parent station does not give free movement between its platforms: declared station paths keep their direction and time. When GTFS omits a pathway's `traversal_time`, VIGO prices its length at walking speed; stairs and fare gates without times use labeled estimates. A missing time never becomes a zero-time link. [Walking evidence](reference/walking-evidence.md) explains station costs in detail.

The walking limit covers each continuous walk to or from transit; a transfer walk cannot extend the final walk past it. A point that snaps to the street carries an `endpointConnector` on its first or last walk: the straight hop already included in the cost, with `streetPathVerified: false`. A connector is not evidence of a mapped or legal path.

## Matrix

Matrix calculates travel times between sets of origins and destinations in one request, from a shared departure or to a shared deadline. The [Matrix reference](guides/rust-standalone.md#matrix-requests) lists every field.

### Send a matrix request

To find when people must leave several places to reach one destination by 09:00, save `arrival-matrix.json`:

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

Use exact stop IDs (`{"stopId": "..."}`) or coordinates. Walk, Drive and Bike matrices need coordinates.

### Read the result

`durationsSeconds[originIndex][destinationIndex]` gives each pair's time, in request order. `null` means unreachable, never a zero-minute trip, and a completed matrix can contain both. With `includeJourneys: true`, `journeys` has the same shape; `includeGeometry: true` adds lines to them without another search.

For arrive-by, every pair shares the deadline, and a duration runs from the latest departure to the deadline, so it includes any wait at the destination. The matching journey gives the actual arrival. Use `includeJourneys: false` when only times matter.

### Choose constraints

The Route rules apply: a direct walk competes unless `requireTransitRide: true`; `maxWalkKm` bounds each walk to and from transit; `maxTransfers` accepts 0–31; `horizonMinutes` bounds the timetable search, not the trip. `allowStreetTransfers`, `minimumTransferBufferMinutes` and `arrivalBufferMinutes` behave as in [Route](#transfers-and-time-reserves).

Transit Matrix uses the scheduled timetable, or a realtime snapshot in the engine. Drive Matrix can use supplied traffic; see [Streets and traffic](#streets-and-traffic).

### Share work across pairs

Results keep input order, including repeated endpoints. The engine accepts up to 65,536 pairs in an 8 MiB request; the compiler accepts up to 100,000 pairs in 16 MiB. Pairs share timetable searches:

| Workload | Timetable searches |
| --- | --- |
| Depart-at, one origin, many destinations | One forward scan |
| Depart-at, many origins | One forward scan per distinct origin |
| Arrive-by, many origins, one destination | One reverse scan |
| Arrive-by, many destinations | One reverse scan per distinct destination |

So group work by shared endpoint, date, clock and constraints, and request times only when that is all you need. Matrix journeys can pick a different equally good journey than Route when ties exist. `disableCache: true` skips endpoint caches but keeps same-request sharing and the loaded City.

## Reach and isochrones

Reach finds the streets and areas reachable from one origin within a time budget, by transit with walking, or by walking, driving or cycling alone. Arrive-by Reach asks the reverse: from where a destination can be reached by a deadline. The [Reach reference](guides/rust-standalone.md#reach-requests) lists every field.

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

`mode: "walk"` maps walking alone and needs no service date. `mode: "drive"` routes to each cell center over the directed road network with free-flow speeds; it takes no traffic or transit scenario. `mode: "bike"` needs a City with bicycle streets. The engine can also run transit Reach on a realtime snapshot; the compiler and Python keep Reach scheduled.

For arrive-by Reach, send a `destination` instead of an origin, with `"timePreference": "arrive_by"` and the deadline as `time`. Each value is how long before the deadline a traveler must leave that place, including any wait after an early arrival. Walking keeps each street's permitted direction toward the destination.

### Set the analysis resolution

| Option | Meaning |
| --- | --- |
| `cutoffsMinutes` | Time budgets, 1–240 minutes; fractions allowed |
| `maxWalkKm` | Walking budget for transit Reach |
| `walkSpeedKph` | Walking speed, 1–8 km/h |
| `extentRadiusKm` | Extent of the grid, 1–40 km |
| `rasterSize` | Cells per side: the engine accepts 16–1024; the compiler 48, 64, 96, 128, 192, 256, 384, 512 or 1024 |
| `surfaceSampling` | `street` samples reached streets; `cell-center` routes to each cell's center |

The extent sets the analysis grid; it is not a trip-distance limit. Cutoffs, walking limits and the network decide what is reachable. Keep extent, resolution, sampling and constraints identical when comparing Results.

### Choose the output

The default `reachFormat: "full"` returns the requested grid and the full reached extent. `surface.valuesSeconds` is row-major from the northwest corner, with `null` for unreached cells; read it with its bounds and dimensions. `fullSurface` covers the full reached extent when it differs.

`areas` are GeoJSON polygons around reachable cells, with holes and islands kept. `contours` interpolate the sampled times. The raster stays the reference for numbers. For a map, `reachFormat: "map"` returns only the full reached-area polygons and their bounds; map output cannot be compared. `includeStreetEdges: true` (`--street-edges`) adds the directed street intervals reached; see [street evidence](guides/rust-standalone.md#street-evidence).

### Compare with R5 and OTP

Street sampling records the earliest reached part of each street in a cell and leaves cells away from reached streets empty; a filled cell does not establish a route to its center, and area totals count sampled cells, not walkable land. Use `surfaceSampling: "cell-center"` for a surface of travel times to grid points.

When comparing tools, match the origin, date, departure time, modes, walking and transfer rules, cutoff, extent and grid before comparing polygons. VIGO Reach evaluates one departure time. Conveyal's R5 can summarize a departure window at a chosen percentile, and OTP's Travel Time API uses a departure-time snapshot, so match the time statistic first; VIGO's [Monte Carlo](guides/monte-carlo.md) option computes window percentiles. VIGO rasters are in seconds, while requests use `cutoffsMinutes`.

For a numerical comparison, compute travel times to the same coordinates with Matrix, then classify them at the same cutoff. A longitude/latitude grid and a Web Mercator grid do not share cell centers. Check station entrance costs, boarding slack and GTFS transfer minimums in representative journeys. For a transit Matrix that matches Reach's walking budget, set `requireTransitRide: false` and `allowLongWalk: false`. See [Conveyal's methodology](https://docs.conveyal.com/analysis/methodology), [OTP's Travel Time API](https://docs.opentripplanner.org/en/v2.2.0/sandbox/TravelTime/) and the GTFS [transfer rules](https://gtfs.org/documentation/schedule/reference/#transferstxt).

### All-day Reach

The engine's `allDay` option repeats depart-at transit Reach every five minutes over a service-day window and reports, for each cell, how many departures reach it within each cutoff. It is a measure of how often a place is reachable, not of jobs or people. See [All-day Reach](guides/rust-standalone.md#all-day-reach).

## Scenarios

A Scenario is an immutable set of planned changes tied to exactly one City revision. Scenarios never edit the imported GTFS or OSM. Several compatible changes can coexist; conflicts need an explicit resolution. Drawing a line in an editor changes nothing until it is attached to a valid service.

In VIGO 1.0.0, planned service changes apply to transit Reach in every runtime, and to transit Route in the engine and in Studio. The [Scenario reference](guides/rust-standalone.md#scenario-requests) lists every field.

### Planned service

A planned service states what changes and enough to run it: ordered stops, travel times, and a departure schedule. A Reach request can include this `scenario`:

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

`operation` is `add`, `augment` or `replace`. `excludedRouteIds` and `excludedTripIds` remove scheduled service.

### Replace a branch and keep its trips

`replace` defaults to `scheduleMode: "preserve-trips"` and needs `sourceRouteId`, `sourcePatternId` and the selected-branch scope. Studio and the compiler load the trips active on the query's service date, including calendar exceptions, and the previous day's trips still running after midnight. Each affected trip gets exactly one replacement, keeping irregular gaps, per-trip running times, dwell, and pickup and drop-off restrictions. Editing stops never adds departures or reverse service.

When a branch keeps its trips, the road path divides each trip's original running time among the edited gaps. Retained stops keep their dwell; `addedStopDwellMinutes` (default 0.35) adds dwell at inserted stops. The first retained stop anchors the timing: an extension before it departs earlier, and later edits shift downstream times. At least one original stop must remain. These are modeled times, not a vehicle or crew schedule.

### Set a frequency instead

To change the timetable deliberately, use `scheduleMode: "frequency"` with `headwayMinutes`, `startMinutes` and `endMinutes`; Studio calls this **Departures → Set frequency and hours**. It can replace a whole route, and `add` and `augment` use it by default. New lines take road timing from `segmentDistancesKm` and `averageSpeedKph`, plus `dwellMinutes`. Reverse service is an explicit choice. A run arrives, dwells, then departs, and does not dwell at either end. A frequency service runs every service day, including runs that continue past midnight.

### Edit a shared edge in Studio

**Selected branch only** keeps a change on the chosen pattern. **All branches serving this exact A → B edge** applies one inserted gap to every occurrence of that ordered stop pair on the same feed and route, but not to B → A. The editor lists the affected branches before running. Use selected-branch scope for moved stops, extensions or several gaps. Studio requires a completed road path before running a road-following Scenario.

### Test a planned service change

Run a baseline Reach and a Scenario Reach with the same origin, date, time, walking assumptions, sampling and grid. Save `baseline-reach.json`:

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

and `alternative-reach.json`, identical plus a Scenario:

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

The speed, headway and hours are illustrative; the defaults add service in both directions with 0.35 minutes of dwell. This does not establish a drivable alignment, an achievable running time or a vehicle requirement.

Run both and compare the saved Results with the compiler:

```sh
vigo reach --city ./boston --request baseline-reach.json --output baseline-result.json
vigo reach --city ./boston --request alternative-reach.json --output alternative-result.json
vigo-build compare --before ./baseline-result.json --after ./alternative-result.json \
  --output ./reach-change.json
```

Compare reports **after minus before**. `counts` splits cells reachable in both into faster, slower and unchanged, and counts newly and no-longer-reachable cells separately; a negative `meanChangeSeconds` means faster modeled travel among the comparable cells. Read all counts together. Compare checks the grid but not every setting, so keep the requests identical apart from the Scenario. A larger area is not a population benefit: an accessibility study also needs opportunity data and an explicit measure. The engine's `vigo compare` takes both Results in one request; see [Compare requests](guides/rust-standalone.md#compare-requests).

## Realtime transit

Transit Route can use GTFS-Realtime Trip Updates and Service Alerts, and in the engine so can transit Matrix and Reach. This chapter explains how predictions are admitted and how to read the outcome; the [realtime input reference](guides/rust-standalone.md#transit-snapshot) lists every field.

### Connect live feeds in Studio

1. Open **City → Data sources → GTFS-RT live feeds**, or feed settings in **Network**.
2. Paste an endpoint URL and choose what it contains. A combined endpoint may contain several entity types.
3. In a City with several timetables, select the endpoint's **Timetable**.
4. Choose **Add feed** for each endpoint, then **Connect live**.
5. Expand **Feed status** for individual failures and freshness.

| Data | What VIGO uses it for |
| --- | --- |
| Trip Updates | Predictions and cancellations for routing; trip and station inspection |
| Vehicle Positions | Map locations, vehicle details and service observations; never routing |
| Alerts | Notices on legs; `NO_SERVICE` alerts close service in the engine |

Studio allows up to **16 endpoints**. A refresh has a 30-second deadline, 20 MB per feed and 40 MB in total, and rejects more than 200,000 entities or 500,000 stop predictions; at most four downloads run at once. A failed endpoint does not discard the others. Reimporting a timetable discards the retained observation until a fresh fetch binds to the new City.

### Supply observations to the engine

One-off commands never open feed URLs. A request carries a `realtimeSnapshot` with `routingDataMode: "realtime"`, or `vigo serve --realtime-poll` [polls the feeds](guides/rust-standalone.md#automatic-gtfs-rt-polling) and routes on its latest snapshot. In a multi-feed City, each record can carry `sourceScope`, the feed's build scope; a single-feed City uses raw GTFS IDs.

Keep source timestamps intact. Rewriting them to look current changes the input and is not a replay of the observation.

### Scheduled and realtime modes

`routingDataMode` is `scheduled` or `realtime`; Studio shows **Realtime** and **Scheduled · Research**. The command-line runtimes default to scheduled. Scheduled research needs an explicit date and time, removes realtime and traffic observations, and never substitutes another date. Both modes use the same algorithms, stops, walking and transfer rules; only the timetable differs.

### How predictions are applied

A request compiles the complete snapshot into a separate realtime timetable. Nothing is selected by endpoint or truncated: an oversized snapshot is rejected whole. Each valid matched update replaces its scheduled trip; canceled and deleted trips lose their rides; unreported trips keep scheduled times. Depart-at, arrive-by, transfer caps and windows all search this timetable. A query fixes its observation clock once, and the compiled view is cached until the input or its freshness changes.

A trip delay propagates forward until a stop-specific prediction replaces it, and a prediction never moves earlier calls. An absolute time takes precedence over a delay; arrival and departure stay separate. `NO_DATA` resets the delay, and `SKIPPED` removes boarding and alighting at that call. Repeated stops need an unambiguous sequence.

### Admission and coverage

An update must identify an active trip on the selected service day and feed. Ambiguous, contradictory, invalid, unsupported and stale records are excluded and counted. Feed and record timestamps are checked separately: at most 180 seconds old and at most 60 seconds ahead of the captured clock.

An unreported scheduled prefix can conflict with the first prediction of an early-running trip. VIGO removes that prefix only when all its departures and the first prediction are before the observation time, and reports `pastPrefixTrips` and `omittedPastPrefixStops`. It does not reconstruct past events.

Added, duplicated and unscheduled trips are unsupported for routing, although Studio can [display added service](#added-service). Vehicle Positions and alert text never create predictions. VIGO does not compare the GTFS-Realtime `feed_version` with the static feed's, so connect the matching timetable edition yourself.

### Read the realtime status

Read `meta.realtime.status` with its counts. `routingDataMode: "realtime"` records the request; it does not mean predictions changed anything.

| Status | Meaning |
| --- | --- |
| `applied` | Updates were applied and none was rejected |
| `partial` | At least one update was applied and at least one was rejected |
| `stale_fallback` | Nothing was applied and freshness checks failed |
| `no_matches` | Nothing was applied for other reasons; see the unmatched, date, duplicate and invalid counts |

Studio also reports `cancellations_only` (only cancellations applied) and `scheduled_fallback` (no realtime timetable was available; read `fallbackReason`).

`coverage.complete` is about the **supplied updates**, not the share of scheduled trips that report. A fully admitted cancellation snapshot can legitimately return no journey. Keep these fields with the answer.

### Investigate live service in Studio

Start in **Network**: check the observation time and reporting coverage, then choose a route in **Routes**. Compare scheduled and predicted events at the same stop, and read a vehicle's position separately from its predictions. Use **Route → Realtime** for journeys on admitted predictions. For a reproducible analysis, use Scheduled mode with an exact date and time; for an incident review, keep the observation, its identity, coverage and the Result. See [Network and Routes](#network-and-routes).

### Verification

The runtime's Rust tests (`crates/vigo-runtime/src/realtime/tests.rs`) cover delay propagation through dwell, skipped and no-data calls, early predictions that omit a past prefix, trip replacement and the classification of every update in feed order. `npm run check:standalone` runs `test/check-realtime-polling.mjs` and `test/check-realtime-alerts.mjs`, which poll real protobuf feeds through `vigo serve` and check snapshot publication, inline snapshots overriding the server's feeds, failed and malformed reads, and Service Alerts, and `npm run check:gtfs` checks the decoder and journey quality with live updates. These checks establish that the algorithm applies predictions correctly in the tested cases, not that predictions are accurate.

## Streets and traffic

A City built with OSM answers Walk, Drive and Bike Route and Matrix, and gives transit its walking access. Walk uses the directed pedestrian graph; Drive uses the directed road graph at free-flow speed unless the request supplies traffic. VIGO never replaces a missing street path with a straight line. Street Route needs coordinates and returns full geometry; street Matrix returns distance and duration per pair without building every path.

### Coordinate network attachment

A free coordinate attaches to its nearest pedestrian vertex or two-way edge. If that attachment belongs to a fragment with no transit access, VIGO can recover to the nearest connected component within 80 m. The connector counts toward walking time and limits, and the returned line includes it. Reach origins use the same rule.

Drive attaches a free coordinate to the nearest drivable road and enters or leaves it mid-segment, in its own direction. The straight gap is a walk at walking speed, returned as its own leg and counted against `maxWalkKm`; with no road within that limit the Result is `not_found`. Roads within 25 m of the nearest stay as alternatives, which keeps both carriageways of a divided road available. A traffic closure makes a road impassable; it does not move the point.

Stops keep their prepared positions. Recovery never adds a street edge or a transfer, and a connector is an assumption, not evidence of a surveyed entrance or a safe crossing. A point with no eligible street within the radius stays unreachable.

### Authorized endpoint access

Builds default to public pedestrian access: private paths stay outside the walking graph. Movable gates without restrictions inherit the path's permission; private, locked and time-restricted gates stay excluded. An explicitly walkable platform area connects the paths that share its nodes.

For people authorized to use internal roads at their own homes and destinations, such as a campus or gated community, build with `--private-access=endpoints`. In Studio, choose **City → Street network → Pedestrian access → Authorized endpoints** before importing the OSM PBF. Mapped private streets are then usable only within the origin's or destination's own internal area, up to the first public street with transit access. The public middle of the journey and transfers never use them, all internal walking counts toward the limit, and `access=destination` gates are allowed. Transit diagnostics report `walkingAccessPermission: "authorized_endpoints"`. This assumes the traveler is authorized; it does not infer ownership, gate hours or missing links.

### Names for map points

Studio labels map clicks with local street names, intersections, named areas or nearby stops. Names describe a point; they never move it or change routing. They come from optional tables written during OSM import; Cities without them fall back to stop names. The native operation `places.describe` exposes the same lookup.

### Supplied traffic

**No traffic provider is connected by default.** OSM supplies the road graph and free-flow estimates; transit feeds are not a road-speed model. Never describe a drive without applied traffic as a current traffic estimate.

Drive Route and Matrix accept a `traffic` object with `routingDataMode: "realtime"`. It customizes the road graph for that request: a fixed set of costs, not a forecast that evolves during the trip.

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

This fragment shows the schema with illustrative values; a full request also needs the mode and endpoints. Use the actual observation time and the geometry of the observed **directed road**.

| Contract | Behavior |
| --- | --- |
| Time | `observedAt` is required; validity defaults to 300 seconds, at most 1800; times more than 60 seconds ahead are rejected |
| Expiry | Expired traffic reports `stale_fallback` and uses baseline costs |
| Geometry | Endpoint pairs or 2–512 coordinates, matched to a connected directed path; ambiguous paths are rejected |
| Edge indices | Need the City's exact `streetSourceFingerprint`; indices are not portable between builds |
| Costs | Travel time, speed, slowdown factor or closure; never faster than baseline |
| Overlap | The largest cost wins, including closures |

Read `meta.traffic.status` with its matched and unmatched counts. Only `applied` means supplied costs changed the model. VIGO does not model every turn penalty, signal or intersection delay, parking, or traffic changing during the trip. `vigo serve --ndw-poll` polls Dutch NDW travel times, and `vigo traffic-import` converts NDW files; see [Drive traffic](guides/rust-standalone.md#drive-traffic).

## Bicycle routing

Bike Route, Matrix and Reach use a directed bicycle network with access rules, contraflow, surfaces, mapped incline, dismount sections and turn restrictions, including restrictions that apply only at certain times.

### Prepare a City for cycling

Build with bicycle streets:

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf --output ./city \
  --street-modes walk,drive,bike
```

Bicycle permissions cannot be recovered from an older City's walking or driving graph; rebuild from OSM to add them. Studio prepares bicycle streets on new OSM imports. Bicycle data is optional: Cities without it keep their other modes.

### Request a bike route

```json
{
  "mode": "bike",
  "origin": [-77.05, 38.9],
  "destination": [-77.03, 38.91],
  "time": "08:00",
  "maxStreetKm": 50,
  "bike": { "profile": "balanced", "speedKph": 18 }
}
```

Use the same `bike` object for Matrix and Reach. Depart-at, arrive-by and via points are supported. `maxStreetKm` bounds each routed segment, including walks at its ends; `maxWalkKm` bounds each endpoint's walk. Public journeys report `bike` legs and `cyclingSeconds`, separately from walking and waiting.

### Preferences and traffic stress

`profile` is `balanced` (default), `quiet` or `fast`. `balanced` and `quiet` avoid traffic exposure; `fast` minimizes estimated travel time. Preferences choose the route; the reported duration is always the estimated physical travel time at `speedKph` (5–40, default 18), adjusted for surface and mapped incline.

`maxLts` (1–4) sets the highest estimated level of traffic stress the rider will cycle. On busier links the rider pushes the bike at 4 km/h where walking is allowed, shown as walking legs with `geometrySource: "osm-low-stress"`; otherwise the link is excluded. The estimate follows the road-class, speed and lane rules of [Conveyal's published LTS implementation](https://github.com/conveyal/analysis-backend/blob/v5.9.0/src/main/java/com/conveyal/r5/labeling/LevelOfTrafficStressLabeler.java), with valid `lts`, `lts:forward` and `lts:backward` OSM tags taking precedence, plus a few VIGO refinements for directional lanes, high speeds and wide roads. It is an OSM estimate, not observed safety. A stress limit needs a City built with `bikeStressVersion: 1`; older Cities answer ordinary bike requests.

### Timed roads and turns

With a `serviceDate` and a known City timezone, depart-at and arrive-by routes evaluate weekly road access, one-way directions, dismount periods and turn restrictions at the moment the bicycle enters each segment. The search can wait for a road or turn to open, or take a detour; waiting appears as a gap between legs, and reported duration includes it. Weekday lists and ranges, time windows and overnight windows are supported. Holidays, seasons, weather and opening-hours rules with semicolons are treated conservatively. Without a usable date and timezone, timed roads are excluded and conditional turn restrictions apply all day. Diagnostics report the `timingPolicy` used.

### Walking to and from the bike network

New Cities walk to the bicycle network along the public pedestrian graph, with verified geometry; coincident roads or bridges never become a junction. Short straight snaps from a coordinate stay unverified and are limited to 80 m. A `bicycle=dismount` section is a walking leg. Older Cities without this join keep straight connectors; rebuild to enable network walks.

### What the model does not include

Bike has no live traffic, wheelchair profile, bike sharing, or bicycles aboard transit. Hills come from OSM `incline` tags, not terrain data. Ordered bike via points are routed segment by segment, which does not guarantee the best route over all of them. Missing OSM access or condition data cannot establish that a route is safe to ride. [How VIGO computes answers](reference/methodology.md#bicycle) explains the search.

## Wheelchair routing

A wheelchair City applies the strict `wheelchair-strict-v1` profile to Route, Matrix and Reach: unknown accessibility is excluded, and a no-route answer is never replaced by an unrestricted route.

### Prepare a wheelchair City

Build a separate City from the same inputs:

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf \
  --output ./wheelchair-city --wheelchair
```

Serve and query it like any City. Requests inherit its profile; `"wheelchair": true` (or `--wheelchair`) requires a wheelchair City and `false` rejects one. Wheelchair Cities reject Drive, realtime transit and query-time scenario overlays. Rebuild the City when the inputs change.

### What the profile requires

- **Vehicles and stops.** GTFS `wheelchair_accessible=1` for trips and `wheelchair_boarding=1` for boarding and alighting, including inheritance from the parent station. An accessible vehicle can pass an inaccessible stop. The search finds accessible journeys directly, including later vehicles; it does not filter an unrestricted journey.
- **Station paths.** A pathway needs a positive `wheelchair_traversal_time`, or step-free mode with width at least 0.9 m, slope at most 8.3% and a traversal cost. Elevators need no slope. Stairs and escalators are always excluded. A station that declares entrances is entered only through accessible entrances and paths; a platform of a station without entrances is reached from the street when its own or inherited `wheelchair_boarding` is 1. Optional `wheelchair_length` gives a distance priced at 4.8 km/h; a published wheelchair time takes precedence. Fare gates between accessible nodes use their published time or a five-second estimate.
- **Streets.** Chosen at build time with `--wheelchair-streets` and reported as `accessibility.streetEvidence`:

| Value | Build option | OSM ways used |
| --- | --- | --- |
| `inferred-step-free-v1` | Default, or `--wheelchair-streets inferred` | Ordinary pedestrian ways, including ways without wheelchair or surface tags, after the filters below |
| `wheelchair-yes-only` | `--wheelchair-streets verified` | Only ways tagged `wheelchair=yes` |

Both exclude steps, escalators, inaccessible or limited nodes, raised kerbs, conditional access, widths below 0.9 m and inclines above 8.3%. Inferred evidence also excludes rough surfaces, poor smoothness, mountain trails, and unpaved paths, tracks and bridleways; `wheelchair=yes` overrides those filters, and an `incline` of `up`, `down` or `yes` needs it. A mapped kerb must be lowered or flush. Few cities tag every sidewalk, so verified evidence alone usually leaves little network.

### In Studio

Studio prepares wheelchair routing with every single-timetable City: once its GTFS ZIP and OSM PBF are imported, it builds the profile from those original files in the background, with progress in Tasks. If VIGO stops before preparation finishes, it starts again the next time the City is opened. Source fingerprints are checked, and importing a new timetable or OSM file prepares the profile again; **Prepare wheelchair routing** in Route's journey settings rebuilds it on request. While Route is open, the prepared profile stays loaded beside the ordinary City, so switching wheelchair routing on or off answers at once. Studio supports this for single-feed, scheduled Route without via points or scenarios; use the engine for wheelchair Matrix and Reach. From a source checkout, `node scripts/attach-studio-wheelchair.mjs /path/to/Studio-City /path/to/wheelchair-city` attaches a City built with the compiler.

### Limits

Every Result carries `accessibility` with the profile, its street evidence and its limitations. Attachments from a coordinate to the network are geometric; door-to-street access is not verified. Live elevator outages, temporary barriers and individual chair dimensions are not modeled. Strict requirements can leave sparse coverage, and a no-route answer is not evidence that no accessible trip exists. Sources: [GTFS Schedule](https://gtfs.org/documentation/schedule/reference/), [MBTA pathways](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md#pathwaystxt) and [OSM wheelchair tags](https://wiki.openstreetmap.org/wiki/Key:wheelchair). `npm run check:wheelchair` runs the public regression.

## GTFS Flex

Route and Matrix can include conditional service from GTFS Flex: on-demand zones, location groups, booking rules and continuous pickup and drop-off. Add `"flex": {}` to the request; rebuild older Cities to import Flex records.

```json
{
  "origin": { "coordinate": [-77.05, 38.90] },
  "destination": { "coordinate": [-77.03, 38.91] },
  "serviceDate": "2026-07-15",
  "time": "08:00",
  "flex": { "durationFactor": 1.5, "durationOffsetSeconds": 300 }
}
```

### How Flex journeys are timed

VIGO checks zone containment (including holes), calendars, pickup and drop-off windows, walking limits and driving reachability over OSM. On-demand travel time uses the feed's `safe_duration_factor` and `safe_duration_offset`, falling back to `durationFactor` (default 1.5) and `durationOffsetSeconds` (default 300). Timed fixed-stop booking service keeps its published times. Continuous stopping follows the directed GTFS shape, with intermediate times interpolated and labeled `interpolated_shape`. A deviated route keeps its fixed calls: a rider is picked up in time for the vehicle to reach the next fixed stop on schedule, with assumption `deviated_route`.

### How Flex joins fixed service

Flex and fixed service share one timetable search. A Flex ride ending at a stop becomes access to the scan, and one starting at a stop becomes egress, so a journey can use Flex at either or both ends, departing or arriving by. Each Flex ride counts as a boarding; transfer restrictions, minimum times and the buffer apply. A combined journey is returned only when it is strictly better than the scheduled one.

The search first scans with optimistic Flex values. When its winner uses Flex, VIGO prices the walks on the street graph and the clocks exactly; if the priced walks lengthen the winner by more than 60 seconds, it searches again. A winner within that margin is returned and can be up to 60 seconds later than the best conditional journey. The optimistic scan ignores transfer rules, so it can miss a Flex journey that depends on a transfer that exists only through a rule; when a rule at a Flex interchange contradicts it, VIGO composes the conditional and scheduled parts separately.

### Booking

`journey.legs[].quality.flex` carries the timing assumption and the feed's booking rules: messages, phone numbers, URLs and notice. `bookingStatus: "required"` means the journey is conditional: VIGO has neither booked it nor checked the deadline or capacity. `bookingConfirmed: true` records only the caller's claim.

### Planned zones

A Route or transit Reach `scenario` can include `flexZones`: `id`, `name`, a GeoJSON Polygon `geometry`, `startMinutes`, `endMinutes`, `averageSpeedKph` and `waitMinutes`. Travel time is the wait plus straight-line distance at the speed. Both ends of a zone ride must lie in the zone, and fixed-transit interchanges must be stops inside it. Reach evaluates zone egress at the raster resolution, so it has discretization error that point Route does not.

### Limits

Flex rejects realtime, scenario overlays, journey windows and alternative policies; Matrix is limited to 4,096 cells, and Reach does not accept imported Flex. Wheelchair Flex requires a wheelchair City and an explicitly accessible vehicle. Work is bounded without failing: after 4,096 walkable pickup and drop-off pairs, 65,536 rides to or from stops, or 65,536 priced drives, the search returns what it found with a `flex_search_truncated` warning. Each feed's Flex catalog is limited to 32 MiB; past it, the build omits continuous-stopping and booking trips first, then on-demand trips, and reports `flex_catalog_limit`. Vehicle availability is not modeled. Never present Flex estimates as guaranteed departures. `test/check-flex*.mjs` hold the public regressions.

## Travel-time uncertainty

VIGO supports explicit time reserves that change which journey is chosen. It does not estimate an on-time probability, a travel-time distribution from delays, or a calibrated confidence interval: scheduled and admitted realtime times are point estimates. For variation due to departure time and planned frequencies, see [Monte Carlo](guides/monte-carlo.md).

### Use reserves in a routing request

| Control | Applies to | Meaning |
| --- | --- | --- |
| `minimumTransferBufferMinutes` | Transit Route and Matrix, either direction | Extra minutes before each later boarding, after walking and published minimums |
| `arrivalBufferMinutes` | Arrive-by transit Route and Matrix | Plan against a deadline this many minutes earlier |

Both are integers 0–60, default 0. A positive arrival reserve needs a deadline at least as large as the reserve and a horizon exceeding it by at least one minute; the earliest departure stays the one implied by the original deadline and horizon. Via points reject a positive reserve, because composing segments would apply it repeatedly; Walk, Drive, Reach and native operations reject an arrival reserve.

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

VIGO plans arrival by **08:55**, allows departure no earlier than **07:00**, and requires three extra minutes at each change. These are illustrative preferences, not an MBTA delay estimate, and a tighter request can legitimately find no journey.

Route clocks still describe the chosen timetable journey, and a Matrix duration keeps its deadline-minus-departure definition. `diagnostics.timeReserves` in the trace records both deadlines, both margins and `calibratedProbability: false`. A transfer reserve can absorb some lateness, but it does not model early departures, missed-connection recovery, crowding, cancellations, correlated delays or uncertain walking.

### Calibrate probabilities before offering them

GTFS-Realtime `StopTimeEvent.uncertainty` has no defined statistical meaning, and an omitted value means unknown. It must not become a standard deviation or a 90% interval without a validated, provider-specific model. See the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent).

A calibration study would keep historical forecasts and outcomes, match the exact feed revision and trip, estimate errors by route, direction, time of day and lead time, and validate on later dates. For Boston, the [MBTA LAMP exports](https://github.com/mbta/lamp/blob/main/Data_Dictionary.md) are a possible input; VIGO does not download or fit them. Delays on one vehicle or corridor are correlated, so multiplying transfer probabilities does not give a journey probability.

### Reproduce the implemented contract

`npm run check:standalone` (`test/check-standalone-parity.mjs`, `test/check-standalone-http.mjs` and `test/check-service-calendar-boundaries.mjs`) and the recorded corpus case `route-arrive-by-reserve` (`npm run check:corpus`) cover the reserve on Route and Matrix, invalid values, HTTP requests and service-date boundaries. They establish modeled feasibility, not on-time performance.

## Published fares on itineraries

Route shows boarding prices from the imported GTFS feed. In Studio, expand a leg's fare for product names, payment methods and the agency's fare link; JSON Results carry the same data in each transit leg's `fare`.

These are prices for a **new boarding**, not an optimized journey fare. Multi-leg journeys deliberately have no total, because transfers, discounts, passes and existing tickets change what a rider pays. A missing price does not mean free travel, and price never affects route choice.

### Data and matching

The importer keeps fare tables and their references in an optional `fare_catalogs` table that travels with the City. Cities built before fares were added need their GTFS reimported.

- **Fares v2 takes precedence** when `fare_products.txt` exists. Matching uses networks, areas, rule priorities, timeframes and the default rider category. MBTA's `transfer_only` extension is honored, so a free-transfer product never becomes a free new boarding.
- **Fares v1** supports flat, route and origin–destination zone prices. Zone-traversal (`contains_id`) rules stay unpriced.
- Timeframes use the local date and time at the validation stop, including daylight-saving changes and times after midnight.
- Ambiguous networks, conflicting products, missing references and unsupported conditions stay unpriced. An unreadable fare catalog never discards a route.
- Transfer totals, joined fare legs, passes, non-default rider categories and fare-based routing are not implemented.

Matching follows the [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/#fare_leg_rulestxt). No agency prices are built into VIGO. Fares are looked up only after the route is chosen, so they never slow a search. `node test/check-gtfs-fares.mjs` holds the public regressions.

## Inspect a saved Result

Open a JSON Result from the engine, the compiler or the HTTP API. The viewer shows its status and main answer, draws a journey timeline, a matrix table or a Reach raster, and keeps the source JSON beside it. Files are read on your device and never uploaded; the viewer accepts up to 25 MiB.

Route uses `journey`, Matrix uses `durationsSeconds`, and Reach uses `surface.valuesSeconds` or map-only `areas`. Durations are seconds, and `null` means unreachable. Keep geometry qualifications and warnings with the answer.

Python's `Result.to_dict()` keeps its own minute-valued payload; read it with the [Python Results guide](../python/docs/guide.md#results). The viewer accepts public engine schemas only.

## VIGO Studio

VIGO Studio puts Network, Route, Analyze and City views over the same routing engine. It keeps its own project library and works offline once a City is imported.

### Settings and documentation

Open **Settings → Documentation** from the City library or the sidebar to read this guide offline. Press `/` to search; links to external pages open in your browser. Reading documentation does not open a City.

### Open a City

Select a project in the Studio library and import GTFS and OSM. Rebuild when the feed or street extract changes. Studio stores projects in its own library format and cannot open City directories built by the compiler in this release. Opening a City prepares walking; driving opens when you select Drive. **Background tasks** shows preparation progress.

### Network

Use **Network** for reporting coverage and service events, and **Routes** for trip times, station boards and line views. [Network and Routes](#network-and-routes) explains playback, live timing and added service.

### Route

#### Plan

Pick an origin and destination on the map. **Add point** inserts a via point before the destination, up to eight points in total; click a row to pick it again, use the arrows to reorder it, or remove it. **Reverse** flips the order. You can also type a coordinate command in **Search VIGO**, such as `route 38.90, -77.05 to 38.91, -77.03 at 08:00`, then choose **Plan this journey**. The route form does not search place or station names.

Choose a travel mode. Realtime transit departs now; Scheduled shows the date, time and depart-at or arrive-by controls. Transfer caps are disabled while via points are present. **Rerun route** submits the same points again, and **New route** clears them.

#### Choose a network

**Network** chooses what a transit route runs on: the City timetable, one imported timetable, or a saved scenario. Selecting one feed uses its own prepared store and mixes in no other feed. A scenario route uses its timetable group's schedule with removed routes canceled and planned lines added; planned lines run on their stated headway and hours, and new planned stops are reached on foot. Rides on planned service are labeled **Planned**. Realtime is unavailable while a scenario is chosen. A project may set `defaultRoutingFeedId` in its Studio metadata to choose the default network.

#### Journey choices

Sort journeys by **Earliest**, **Fewer transfers** or **Less walking**. Each card shows arrival, total time from your requested departure, transfers, walking, and its trade-off against the earliest arrival. Sorting keeps the selected journey and does not search again; arrow keys, Home and End select another, and **Details** opens its itinerary.

Later departures add the engine's ranked search at the requested time to the window: up to 64 candidate vehicle chains within fifteen minutes of the earliest arrival, of which at most ten are shown, distinct lines and stops first. A journey is removed when another leaves no earlier, arrives no later, walks no more and boards no more, in the whole minutes Studio shows. Services are grouped only when their stops, ride geometry and access paths match. This is a bounded search, not every possible itinerary.

With **Arrive by**, Route options offers **Exact time** or **Earlier arrivals**. Earlier arrivals searches each deadline in the 20 minutes before the requested arrival and lists up to five distinct journeys, the latest departure first, plus a walk when possible. A deadline close to midnight searches the previous service day.

#### Save a journey

Choose a format beside **Save** in the journey details. **JSON** keeps the plan, diagnostics and a summary separating initial wait, journey duration and total elapsed time. **Markdown** is a readable itinerary whose clocks can exceed 23 hours. **GeoJSON** keeps leg geometry and its source. **CSV** records each leg's trip and service-clock times; `clock_service_date` names the midnight those minutes count from. Saving never reruns the query. **Save all** keeps every completed alternative, including those beyond the five visible cards.

#### Recent

Reopen recent Route Results for the current City revision, with their request, status, warnings and timing.

### Analyze

#### Reach

Choose an origin on the map, or use **Choose origin** to search imported stops by name or ID or to enter coordinates. Run Reach, then switch between **Reachable area**, **Reached streets** and cutoffs; changing the displayed cutoff reuses the Result. **Arrive by** maps where a destination can be reached from by a deadline; the clock becomes the **Deadline**.

With street sampling, the map also shades land between reached streets: each enclosed cell takes its fastest nearby street plus a straight walk of up to 100 m, never across mapped water. The inspector labels these values as off-street estimates. Shading is display only; area metrics and the saved raster keep the street samples.

Click a destination to see its estimate and request a journey there; with the map focused, Enter inspects its center. The journey keeps the analysis origin, date, time, timetable and limits. Planned service changes affect the scenario map but are not rebuilt in the destination journey; the panel labels the difference.

**Save** offers the full JSON, the selected cutoff's area geometry, or a CSV summary. `total_processing_ms` measures the whole analysis; `area_source` distinguishes an exact-cutoff area from a display-raster calculation.

#### Scenarios

Studio saves scenarios and timetable groups in the City folder, in `.vigo/scenarios.json`, shortly after each edit. They survive restarts and reimports and travel with the City; a scenario naming a route a reimport removed reports it when run. A copy saved from another window is never overwritten. Road tracing follows the City's streets between the ordered stops; a disconnected segment is explained, never drawn as a straight "road". Use the engine, the compiler or Python for Matrix.

### City

#### Data sources

**City → Data sources** lists GTFS feeds, OSM coverage, counts and warnings. To remove a source, select the trash button, check the name and confirm **Delete source**. Removing a GTFS feed rebuilds the combined timetable from the rest; removing OSM removes street routing until another import. Your original files are kept, and deletion is unavailable during import or preparation.

#### Preferences

Choose appearance, storage location and map preferences. The default City folder is `~/Documents/Vigo Projects`. On macOS, Studio does not scan the library until you choose **Open library folder**, when macOS may ask for permission.

**Local OSM** is the default basemap: main roads, rivers, lakes and coast from the City's own PBF, with no tile service, API key or network connection. Cities imported before the local map index need one fresh OSM import. Online OpenStreetMap and CARTO styles are optional.

### Studio troubleshooting

#### Playback shows no trips

Check the exact service date, `calendar.txt`, `calendar_dates.txt`, the selected direction and pattern, and whether the playback time falls between a trip's first departure and last arrival.

#### An access path crosses a block

Access lines come from OSM streets. Rebuild from current OSM, confirm the point lies within coverage, and inspect the street leg. Studio never replaces a missing street path with a straight jump.

#### A date is rejected

Use an exact `YYYY-MM-DD` date inside the feed's service range. Studio applies the same calendar rules as the command line.

#### A loading indicator is not advancing

Background tasks show measured progress for steps with a known total; the percentage belongs to that step, not the whole import. Steps without a total show elapsed time and the age of the last update. If updates pause, use **Reconnect to task**: the task may still be running. Confirm that the City folder is readable and writable and that macOS has granted access.

## Network and Routes

Open **Network** in VIGO Studio to inspect the City's timetable, live reports and service events. It has **Network** and **Routes** tabs; use **Route** for journeys and **Analyze** for Reach.

### Read the evidence

| What you see | What it represents | How to use it |
| --- | --- | --- |
| Scheduled time | A GTFS arrival or departure on the selected date | The published plan |
| Predicted time | A matched, admitted Trip Update for that trip and stop | Compare with the same scheduled event |
| Vehicle position | A reported location at its own observation time | Locate the vehicle; check its age separately |
| **Estimated** playback | A position interpolated along the scheduled trip | Explore the timetable and geometry |
| Service event | A computed delay, spacing change or source alert, with timestamps | Inspect its evidence and age |

None of these is a verified history of arrivals, and a missing prediction stays unknown. A vehicle marker or an added trip does not mean Route can use that trip; routing has its own [admission rules](#admission-and-coverage).

### Investigate a condition

1. **Start with coverage.** Check the snapshot time, feed freshness and reporting counts in **Network**. Reporting counts routes with current trip reports; it is not the share of passengers covered.
2. **Follow the route.** Open **Routes**, select the route and read **Trip times** on the relevant date. Use **Stops** to confirm direction and pattern, then **Updates** for service evidence.
3. **Compare the same event.** Open the station board or select a vehicle in **Line view**. Compare arrival with arrival, or departure with departure, at the same stop, with both observation times visible.
4. **Keep the observation.** **Export observations** or **Export report** keeps the evidence and its timestamps.

### Inspect a route or station

Choose a route in **Routes** to see **Trip times**; select a trip and date to compare scheduled and predicted times. **Stops** opens directions and patterns, and **Updates** opens service evidence. Select a stop for its arrivals board; **All routes** returns to the catalog. Selection is shared across Network, Routes, the map and the line view; **Network map** clears it.

### Patterns and scheduled playback

A route's **Stops** view shows directions, patterns, ordered stops, service span and published geometry. Patterns are labeled by their first and last stops. Direction IDs `0` and `1` are feed labels, not compass directions. Times such as `25:10` stay on their GTFS service day.

Scheduled playback is labeled **Estimated**: vehicles dwell at stops and follow their shape between timed calls, so positions are approximate. Live positions are drawn separately, with a bearing arrow when reported.

### Vehicle timing and line view

In **Routes**, select a route and choose **Line view**: two tracks show each direction's stops and reported vehicles. Select a vehicle to compare scheduled and predicted arrival and departure at its reported stop. If that stop has no usable timing, **Next prediction** names a later stop without substituting its time. The browser requests only the selected route or vehicle, every ten seconds.

- Stop placement follows the Vehicle Position's stop ID, sequence and status; it never snaps to roads or interpolates. Missing or conflicting identities stay unplaced.
- Arrival comes from the incoming connection and departure from the outgoing one; delay compares the same event at the same stop.
- Opposite directions share a station list only when their sequences are exact reverses.
- Branches and repeated stops stay distinct. Skipped stops, missing predictions, duplicates and stale observations never become current timing.

Spacing is schematic: it shows stop order, not distance or headway. The **↔** warning marks both vehicles of a compressed pair.

#### Added service

Trips declared `ADDED` or `NEW` in GTFS-Realtime appear in the line view and **Trip times** even when absent from the static timetable. Their reported stops supply placement and timing; scheduled times and delays are unavailable. Added-service display does not make a trip available to journey routing.

### Evidence limits

Predicted spacing is not measured headway, and forecast changes are not actual vehicle progress. Reporting coverage is not service health. Network inspection does not establish delay causes, recovery forecasts or passenger impacts, and VIGO does not dispatch vehicles or publish messages. `npm run check:agency` holds the public regressions; matching follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/).

## Deploy the routing engine

Run the engine as the HTTP service. It opens a prepared City or scenario collection without Node, Python, Studio or an internet connection. Prepare data separately with the compiler and mount the complete directory read-only.

### Build and check the image

From the repository root with Docker installed:

```sh
docker build -f deploy/Dockerfile -t vigo:1.0.0 .
```

The image contains the engine with this guide embedded, license notices and a Debian glibc runtime, and runs as UID/GID 65532. Its compiler matches `rust-toolchain.toml`; City data, JavaScript dependencies, desktop bundles and build caches are excluded. Check the image before using it:

```sh
npm ci
npm run build:cli-runtime
npm run check:deployment -- --image vigo:1.0.0
```

The check builds public synthetic inputs and exercises the real Compose service: a read-only City, authentication, Route, Matrix, Reach, scenario switching, readiness, restart and resource limits, and it confirms that queries never change City files. CI runs it on Linux x64 and ARM64. The small fixture is not a metropolitan memory or latency result: measure your own City and requests before choosing production limits.

### Start the service

Make the City directory readable by UID 65532, and keep every referenced directory inside the mounted City or collection.

```sh
export VIGO_IMAGE=vigo:1.0.0
export VIGO_CITY=/absolute/path/to/prepared-city
# Set VIGO_API_TOKEN through your shell or deployment secret store (16+ characters).
docker compose -f deploy/compose.yml up -d --wait
```

The service binds to `127.0.0.1:8080` on the host; put an HTTPS reverse proxy in front of it for remote clients. Query endpoints require `Authorization: Bearer ...`; readiness and this guide are public.

```sh
curl --fail-with-body http://127.0.0.1:8080/readyz
curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H "Authorization: Bearer $VIGO_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @route.json
docker compose -f deploy/compose.yml logs --tail 50
```

`GET /v1/info` reports the City, memory and scenario residency. For a [scenario collection](guides/rust-standalone.md#scenario-collections), pass `scenarioId` with each query. The [HTTP API](guides/rust-standalone.md#http-api) lists every endpoint and status code.

### Resource controls

Compose defaults to 2 CPUs, 2 GiB of memory and no swap, two native threads, two resident scenarios, and one query worker with a bounded queue. It uses a read-only root filesystem and City mount, drops Linux capabilities, limits processes, and keeps two 5 MB log files.

| Compose variable | Default | Meaning |
| --- | --- | --- |
| `VIGO_IMAGE` | Required | The image you built and checked |
| `VIGO_CITY` | Required | Absolute path to the City or collection on the host |
| `VIGO_API_TOKEN` | Required | Bearer token, at least 16 characters |
| `VIGO_LOCAL_PORT` | `8080` | Loopback port on the host |
| `VIGO_CPUS` / `VIGO_MEMORY` | `2` / `2g` | Container CPU and memory limits |
| `VIGO_MEMORY_SWAP` | Equal to `VIGO_MEMORY` | Memory plus swap; equal values disable swap |
| `VIGO_THREADS` | `2` | Threads per query (`RAYON_NUM_THREADS`) |
| `VIGO_MAX_RESIDENT_SCENARIOS` | `2` | Collection members kept loaded |
| `VIGO_ENDPOINT_CACHE_MAX_BYTES` | `8388608` | Endpoint cache budget |
| `VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES` | `8388608` | Shape cache budget |
| `VIGO_MAX_QUEUE` | `8` | Waiting queries |
| `VIGO_MAX_CONNECTIONS` | `16` | Open HTTP connections |
| `VIGO_MAX_BODY_BYTES` | `8388608` | Largest request body |
| `VIGO_REQUEST_TIMEOUT_MS` | `10000` | Request and response I/O deadline |
| `VIGO_QUERY_TIMEOUT_MS` | `30000` | Queue plus computation deadline |

Other engine variables, such as `VIGO_RESIDENT_HEAP_BYTES` and `VIGO_PREPARE`, keep their [defaults](guides/rust-standalone.md#environment-variables) unless you add them to the Compose file. Before raising limits, read [Resource limits](guides/resource-limits.md): extra processes are not a free speedup, and swap is never counted as RAM.

The worker keeps its City and workspaces, puts short queries first, and gives waiting analytical work a bounded turn. A deadline or cancellation stops running work and restarts the worker, and readiness is unavailable meanwhile. A full queue returns 503 instead of accepting unbounded work. Responses are limited to 64 MiB; split large matrices or omit geometry.

`GET /healthz` checks the HTTP process and `GET /readyz` the worker. The container runs `vigo health` against `/readyz`; the probe loads no City and needs no shell or curl. The restart policy restarts exited containers, not merely unhealthy ones.

### Run without Docker

The engine archive runs directly: `vigo serve --city ./city --host 127.0.0.1 --port 8080`, checked with `vigo health --port 8080`. For a Linux host, install the matching binary, create an unprivileged account, make the City readable, and keep the token in a protected environment file. A systemd unit:

```ini
[Unit]
Description=VIGO routing service
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

Set `VIGO_CITY` and `VIGO_API_TOKEN` in the environment file. Stop the service through systemd so its worker stops too. Scale out with several service processes, each with its own City and queue; there is no shared queue, distributed cache or tenant management. The Docker and systemd recipes are deployment examples; the container check above is the tested configuration.

### Operate and upgrade

Prepare a new City in a separate directory, check saved requests against it, and switch the image and City together. Never replace files a running service has mapped, and keep the previous image and City for rollback; see [Upgrade and rollback](#upgrade-and-rollback). [Service benchmarking](developer.md#reproduce-a-service-workload) records startup, first-query and sustained latency, memory and disk use. Stop the service with `docker compose -f deploy/compose.yml down`; the City stays on the host.

To offer a public journey planner on top of a service, see the [public route planner](guides/public-routing.md).

## Upgrade and rollback

Keep a running application and its City together until the replacement passes your saved requests. A new release does not by itself make an older City compatible or incompatible; the prepared-data contract decides.

### Before changing versions

1. Save the runtime version, package checksum, `capabilities` output and City inspection (`vigo info --city ./city`).
2. Keep the original GTFS and OSM inputs, their checksums, build options and scenario definitions. A prepared City is not a substitute for its sources.
3. Keep representative Route, Matrix and Reach requests and their Results, including your transfer, walking and arrive-by settings.

### Prepared City policy

VIGO keeps a permanent prepared-data baseline: later readers open published Cities without rebuilding, and standard writers produce Cities the published reference runtime can read. The [prepared-data contract](reference/city-format.md) defines this promise and its release gate.

Cities older than the supported format are not converted. Rebuild them from the original sources into a **different directory**:

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf --output ./city-next
vigo info --city ./city-next
vigo route --city ./city-next --request route.json
```

The runtime checks timetable, transfer, street, access and index formats separately, so the outer `vigo.city.v1` manifest is not enough, and editing a format marker cannot migrate contents. Some fixes, such as improved station or wheelchair preparation, apply only to Cities built after them; the [release notes](releases/1.0.0.md) say when to rebuild.

### Validate, switch and recover

Run the saved requests against the candidate through the interface your application uses. Check schemas, no-journey outcomes, walking geometry, times, boardings and resource use, and test a cold start as well as repeated requests. Start a second service on `city-next`, check readiness and replay the requests before switching. Roll back by restoring the previous binary and City together; never overwrite a City a service has open.

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

These use public synthetic inputs and cover independent verification of the algorithms, difficult routing cases, public schemas, moving a City between machines, and running from the extracted package. They need no private data. A local pass does not show that other platforms pass; release CI runs all four.

## Known limits

VIGO models the City revision and query it is given. It does not certify real-world service, demand, safety or operations. [How VIGO computes answers](reference/methodology.md#exactness-and-its-boundaries) separates what is exact from what is bounded or estimated.

### GTFS

- VIGO uses the GTFS features listed in [GTFS support](developer.md#gtfs-support-matrix). Unsupported or malformed features are reported during the build.
- Frequency templates with `exact_times=0` are read as a departure at the start of each window and then every headway. GTFS gives no exact times for them, so these are scheduled estimates.
- Route- and trip-scoped transfer rules are kept but not applied; the stop-level rule governs those transfers. Timed-transfer guarantees are not represented.
- Missing shapes do not prevent routing but limit map geometry.
- Explicit GTFS in-seat links keep passengers aboard across trip changes and count one boarding. Block-based continuation is inferred only for consecutive same-terminal trips on one block, service and day; other continuations need explicit links.
- Staying aboard must move the rider onward. A journey boards a looping vehicle at its last pass, and alternatives that stay aboard through a turnaround only to return to a stop the rider could already reach are dropped.

### Transit Route and Matrix

- Arrive-by Matrix durations include any wait between arrival and the deadline; use journeys for the actual arrival.
- [Time reserves](#travel-time-uncertainty) change route choice, but VIGO computes no arrival probabilities.
- A finite `maxTransfers` cap cannot be combined with transit via points.
- Returning to a station already visited can be valid in the timetable; it is flagged, not excluded.
- Without an explicit rule or declared pathways, platforms of one parent station use a transfer time of at least 120 seconds, or their distance at walking speed. These legs report `transferSource: "parent_station_fallback"` and a schematic line.
- A street route to a platform coordinate does not establish an entrance-to-platform connection. Walks touching subway platforms report `stationAccessStatus: "unverified"` unless a declared pathway covers them. Untimed stairs and gates use explicit estimates (one second per step, five seconds per gate). Scalar Matrix results do not carry this per-leg evidence.
- Departure windows sample whole minutes; they are not continuous profiles.

### Streets

- Walk, Drive and Bike depend on OSM coverage and directions.
- Pedestrian attachment searches vertices within 160 m and edges within 80 m. A missing attachment is not proof that no path exists.
- Platform polygons describe an area, not a path; routing across their interiors is not modeled.
- A free coordinate keeps its nearest attachment even when that street connects poorly, such as a ramp or bridge above the point. Attaching to several streets would let a connector cross barriers. Place points on the street or path the traveler will use.
- [Authorized endpoint access](#authorized-endpoint-access) is an opt-in assumption; it does not establish permissions, gate hours or missing links.
- Drive does not model every turn restriction, signal or intersection delay, and traffic must be supplied.

### Realtime

- Realtime transit needs explicit realtime selection and a snapshot, supplied or polled. It applies to Route in every runtime and to transit Matrix and Reach only in the engine. Vehicle Positions never change routing. In the engine, a fresh `NO_SERVICE` [Service Alert](guides/rust-standalone.md#service-alerts) closes what it selects; other alerts are reported on legs.
- Only `FULL_DATASET` feeds are decoded. Added, duplicated and unscheduled trips are unsupported for routing.
- Feed and record timestamps must be at most 180 seconds old and 60 seconds ahead. Missing timestamps do not establish freshness.

### City reuse and platforms

- Copy the entire City directory. Executables are specific to an operating system and CPU; City data is portable across the supported 64-bit platforms.
- Older Cities without a persisted driving hierarchy rebuild it when a process opens them; rebuilding the City from source persists it.
- A new active-service pattern, a changed walking policy or an evicted timetable needs preparation. Missing or corrupt required street files are errors.
- Studio's settings, drafts and live connections are local and do not travel inside a City. Studio cannot open compiler City directories in this release.

### Scenarios and Reach

- Planned service changes apply to transit Reach, and in the engine and Studio to transit Route. Traffic applies to Drive Route and Matrix. Drive Reach uses free-flow speeds without traffic or scenarios.
- `maxTransfers` limits changes in baseline and scenario Reach; walking never counts as a boarding.
- Reach rasterizes reached streets while Matrix evaluates coordinates, so their cells can differ under matching settings.
- Reach measures modeled travel time, not people, jobs, demand, welfare, behavior or operational feasibility.

## Troubleshooting

Find the stage that failed: installation, City build or open, request validation, computation, or interpretation. Keep the failing command and its output before changing inputs. For a version change, follow [Upgrade and rollback](#upgrade-and-rollback) first.

### Check the runtime and City

```sh
vigo --version
vigo capabilities --pretty
vigo info --city ./boston --pretty
vigo-build help route
```

`capabilities` describes the running binary and `info` the City. Neither proves that a date has service or that a route exists. Source changes take effect only after rebuilding.

### Build or open fails

| Symptom | Check | Next step |
| --- | --- | --- |
| Node version error | `node --version` | Install Node.js 24.18 or newer |
| Executable cannot run | Operating system, CPU and file permissions | Use the archive for your platform, or build from source on it |
| Native build or load failure | The pinned Rust toolchain and linker | Build on the machine type that will run VIGO |
| Output City already exists | Is this a new revision or a replacement? | Prefer a new directory; use `--replace` only to replace |
| `--city or VIGO_CITY is required` | The command line | Give a City path, also for `compare` |
| `Expected a prepared vigo.city.v1 City` | The `--city` path | Point to the compiler's complete output, which contains `network.json` |
| Missing or stale access or index file | Were files copied from different builds? | Recopy the whole City or rebuild it |
| Unexpected SQLite WAL | Did the build finish? | Finish the build and copy a consistent City |
| Driving preparation fails with counts | Network size | Raise `VIGO_DRIVE_ACCELERATOR_MAX_NODES` or `_EDGES`, or omit driving |
| First query slower than later ones | Timetable or access preparation | Use `--prepare-date`, and keep a process resident |
| City absent from Studio's library | Which tool built it? | Studio imports its own projects |

### A request is rejected

| Symptom | Check |
| --- | --- |
| Invalid or uncovered date | Use an exact local `YYYY-MM-DD`; inspect `calendar.txt` and `calendar_dates.txt` |
| A flag seems to ignore the JSON | Flags override request fields; remove one of them |
| Point cannot be resolved | Use an exact, case-sensitive stop ID or `[longitude, latitude]`; names are not geocoded |
| `Unknown point field` | Write points as `{"coordinate": [...]}` or `{"stopId": "..."}`, with optional `id` and `name`; the engine rejects the compiler's older `{"id", "point"}` matrix form |
| `Unknown route option` | Check the field name in the [engine reference](guides/rust-standalone.md#common-fields); Studio's internal fields are not accepted |
| `walkSpeedKph applies to …` | Transit Route and Matrix use the City's walking policy; send `walkSpeedKph` only to Walk, Drive, Bike or Reach |
| Transfer cap with transit via points | Unsupported; omit the cap |
| Realtime or Scenario rejected by Matrix or Reach | See [supported combinations](#choose-a-supported-combination) |
| Matrix too large | The engine allows 65,536 pairs in 8 MiB, the compiler 100,000 in 16 MiB |
| A piped request seems to wait | `--request -` waits for standard input to close |

Invalid requests exit with status 2 and explain the failure on standard error. A failed run leaves an old `--output` file unchanged; do not mistake it for a fresh Result.

### When a Route returns no journey

1. Confirm the City revision, date, time and mode. GTFS `25:10` belongs to the previous calendar day's service date.
2. Check whether transit is required. A direct walk competes by default; `requireTransitRide: true` requires a boarding.
3. Check each end's walking access. A stop close in a straight line may lack a street path; `outside_selected_budget` only suggests a wider check.
4. Check the horizon, transfer cap and timetable. The horizon bounds boarding and alighting, not the trip.
5. If a changed constraint is justified, save it as a new request and keep the blocked Result.

Never silently raise walking limits, substitute dates, or turn blocked durations into zero. See [When no journey is found](#when-no-journey-is-found).

### HTTP service

| Symptom | Next step |
| --- | --- |
| 401 | Send exactly one `Authorization: Bearer` header matching `VIGO_API_TOKEN` |
| 403 without a token | Use a loopback `Host`, or set a token for proxies and remote clients |
| 503 | Read `/readyz`; reduce concurrent work or add measured capacity; retry with backoff |
| 504 | Read the worker log; reduce matrix size, geometry or raster detail before raising deadlines |
| A browser request fails | The service does not implement CORS; serve your app from the same origin or a proxy |
| High memory | City size, worker count, threads, request bodies and detailed results all add up; see [Resource limits](guides/resource-limits.md) |

### Live reports and routes disagree

| Observation | Explanation |
| --- | --- |
| A vehicle is visible but its trip is unavailable to Route | Vehicle Positions create no timetable service |
| Realtime times equal the schedule | Unreported trips keep scheduled times; read the counts and status |
| A saved snapshot stops applying | Freshness is checked against the clock; a saved observation expires |
| An alert describes a disruption but the route is unchanged | Only `NO_SERVICE` closes service, and only in the engine |
| Playback shows a vehicle that is not reporting | Playback is labeled Estimated and interpolates the timetable |

### Results or comparisons look unexpected

A Matrix `ok` can contain `null` cells, and arrive-by durations include waiting at the destination. Matrix comparison needs identical ordered endpoints, and Reach comparison identical grids; means exclude unreachable cells. A path that appears to jump to a platform is a connector or assumed station link: read its `quality`. When comparing speed, keep the City, request, output detail, cache settings, worker count and threads identical, and never compare a cached repeat with a cold start.

### Concurrent stream queries

The compiler's `vigo-build stream --workers 2` runs up to four resident workers, capped by CPU and memory (two CPUs and 6 GiB per worker), and keeps results in input order. Each worker loads its own City. `RAYON_NUM_THREADS` sets threads within each process, separately from the number of concurrent requests. The engine's `vigo stream` answers one request at a time; run several processes for parallel work.

### Report a reproducible issue

Include the VIGO version, operating system and CPU, the failing command, the request, the City inspection summary, standard error, and the full Result if one was returned. Say what you expected and whether it reproduces with the same inputs, and share a small redistributable fixture when you can. Review paths, coordinates, credentials and data licenses before attaching files to a public issue, and use the [security policy](../SECURITY.md) for vulnerabilities. [Keep a reproducible run](reference/results.md#keep-a-reproducible-run) lists what to keep.

## Glossary

| Term | Meaning |
| --- | --- |
| **Access, egress** | The walk from an origin to the first stop, and from the last stop to the destination |
| **Admission** | Checking whether input data, such as a realtime record, may be used |
| **Areas, contours** | Reach output: GeoJSON polygons around reachable cells, and lines interpolated at each cutoff |
| **Arrive-by** | Find the latest departure that still arrives by a deadline |
| **Boarding, transfer** | Boarding a vehicle; a transfer is every boarding after the first (`transfers = boardings − 1`) |
| **Capabilities** | `vigo capabilities`: what the executable you run supports |
| **CCH** | Customizable Contraction Hierarchy: the prepared street index used for exact, fast street paths |
| **City** | A prepared directory built from GTFS and OSM; the unit every runtime opens |
| **City revision** | The identity of one build of a City; Results record it |
| **Compare** | Differences between two saved Results, after minus before |
| **Compiler** | `vigo.mjs` (`vigo-build`): builds Cities from raw GTFS and OSM |
| **Connection scan** | The timetable algorithm VIGO uses for transit: departures scanned in time order |
| **Cutoff** | A Reach time budget, in minutes |
| **Depart-at** | Find the earliest arrival after a departure time |
| **Direct walk** | A walking-only answer to a transit request, used when it arrives sooner |
| **Endpoint connector** | The straight hop between a free coordinate and its street attachment, included in cost but not verified |
| **Engine** | The `vigo` executable: queries, streams and the HTTP API |
| **Feed scope** | The name given to one GTFS feed in a multi-feed City |
| **Full surface** | Reach raster over the bounds actually reached, beside the requested grid |
| **Horizon** | How far the timetable search looks from the requested time; not a trip-length limit |
| **Isochrone** | A line or area of equal travel time; VIGO calls the query Reach |
| **LTS** | Level of traffic stress, 1–4, estimated from OSM for cycling |
| **Matrix** | Travel times between every origin and destination |
| **Monte Carlo** | Repeating a query over a departure window and sampled schedules to get percentiles |
| **Native operation** | A low-level kernel call with packed arrays; diagnostic, outside the stable API |
| **Parent-station fallback** | The assumed transfer time between platforms of one station when the feed declares none |
| **Prepared snapshot** | A compiled service-day timetable stored in the City and reused by fresh processes |
| **Reach** | Where an origin can reach (or a destination can be reached from) within cutoffs |
| **Realtime snapshot** | GTFS-Realtime Trip Updates and Alerts for one request |
| **Resident process** | A `stream` or `serve` process that keeps a City loaded between queries |
| **Result** | The immutable answer to one query, with its status and evidence |
| **Route** | A journey between ordered places |
| **Scenario** | An immutable set of planned changes tied to one City revision |
| **Scenario collection** | Several transit scenarios sharing one street graph, selected with `scenarioId` |
| **Service date** | The GTFS day a trip belongs to; its clock can run past 24:00 |
| **Street sampling, cell-center sampling** | Reach rasters from reached streets, or from routes to every cell's center |
| **Supported scheduled core** | The part of a feed VIGO routes exactly when some features are unsupported |
| **Trace** | The internal result added by `diagnostics: "trace"`; unstable, for debugging |
| **Transfer buffer** | Extra minutes required before each later boarding |
| **Via point** | An intermediate place a Route must pass, in order |
| **Witness** | The journey or path that proves a computed time |
