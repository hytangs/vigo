# VIGO 0.5.0 guide

Canonical source for the [documentation reader](guide.html). Edit the relevant chapter, then rebuild the reader.

## Build a network. Answer a transport question.

VIGO 0.5.0 turns GTFS timetables and OpenStreetMap streets into a reusable City. Find journeys, calculate travel-time matrices, and measure the reach of a network from the command line, an HTTP service, or Studio.

### Start with your workflow

- **[Build your first City](#vigo-cli-quickstart)** Download public Boston inputs, prepare the network, and run a complete request.
- **[Run a routing service](guides/rust-standalone.md)** Open a prepared City with the standalone Rust executable and serve JSON over HTTP.
- **[Explore in Studio](#vigo-studio-desktop-guide)** Manage sources, inspect service, plan journeys, and compare reachable areas.
- **[Work in Python](https://github.com/hytangs/vigo-py/tree/main/docs)** Build and reuse a City in scripts and notebooks with VIGO Python 0.5.0.

### Choose the right interface

| Interface | Start here | Runtime |
| --- | --- | --- |
| Node CLI | [Installation and packaging](guides/cli-only.md) | Builds Cities from GTFS and OSM; queries through the shared Rust kernel |
| Rust executable | [HTTP and standalone manual](standalone.html) | Queries a prepared City; includes an HTTP server and needs no Node or Python |
| Studio | [Desktop guide](#vigo-studio-desktop-guide) | Desktop application with its own project library |
| Python | [Python documentation](https://github.com/hytangs/vigo-py/tree/main/docs) | Python objects backed by a resident Engine process |

A City is the complete prepared data directory. Build it once and keep it intact. For repeated queries, keep a process resident with `stream`, `serve`, or an open Python City.

### Ask a question

| Query | What it answers | Continue |
| --- | --- | --- |
| Route | How do I travel between these places? | [Route options](#route-1) |
| Matrix | How long does each origin–destination pair take? | [Matrix shapes and journeys](#matrix-1) |
| Reach | What can I reach within a time budget? | [Reach, areas, and rasters](#reach-and-isochrones) |

Apply a [Scenario](#scenario-semantics) to compare supported service changes. A Scenario modifies the City for a query; it is not a fourth query family.

Start by reading the result status. Public Engine responses use `ok`, `not_found`, or `error`; journey and matrix durations are in seconds. Python Results expose their own documented properties and minute-valued fields. Use the reference for the interface you call.

### Work with confidence

Rebuild pre-0.5.0 Cities from their original sources. The [upgrade guide](#upgrade-and-rollback) covers prepared data, verification, and rollback. [Results](reference/results.md) explains schemas, units, geometry, and diagnostics. [Walking evidence](reference/walking-evidence.md) and [routing limits](#known-limits) explain what the data establishes.

Use the [offline documentation reader](guide.html) to search these pages, copy examples, or print a chapter. The [Result viewer](guide.html#viewer) reads public Engine JSON locally. The [standalone manual](standalone.html) includes the [OpenAPI specification](standalone-openapi.json).

### Development and release

[What's new in 0.5.0](releases/0.5.0.md) · [Developer resources](developer.md#developer-resources) · [Changelog](../CHANGELOG.md) · [Security](../SECURITY.md)

## VIGO CLI quickstart

Start with **Boston and Cambridge**: download the MBTA timetable and OpenStreetMap streets, prepare them once, then route from **Harvard Square to South Station**. You will save Route, Matrix, and Reach results. A “City” means the compiled data folder, called `boston/` here.

This tutorial uses the **Node CLI**, including its raw-data compiler. For the single Rust executable, follow the [Rust Boston quickstart](guides/rust-standalone.md#1-quickstart); it loads the same prepared Boston directory, with the same public result schemas and its own CLI options.

For the desktop workflow, use the [Studio guide](#vigo-studio-desktop-guide). Studio imports data into its own project library; it does not open the CLI City directory created below.

### 1. Install

VIGO 0.5.0 requires Node.js 24.18 or newer and npm 11.6 or newer.
Source builds also require the pinned Rust toolchain. Supported targets are macOS Apple Silicon/Intel, Linux ARM64/x64 with glibc, and Windows x64. Use a native build for the target OS and CPU; City data moves between them. See the [platform and City limits](#known-limits).

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build:rust-routing-kernel
npm run build:cli
alias vigo="node \"$PWD/public/vigo.mjs\""
```

Check the installed command before importing data:

```bash
vigo --version
vigo capabilities
```

The alias keeps the source checkout path when you change directories. If you have an extracted [CLI-only archive](guides/cli-only.md), skip the source build and set `vigo` to `node "/absolute/path/to/cli-package/vigo.mjs"`. Keep its native kernel beside the script. The commands below use a POSIX shell; on Windows use WSL for these download/extract steps or translate the shell commands to PowerShell.

### 2. Download the Boston inputs and build

Two files supply different parts of the journey:

| Data | Official source | Purpose |
| --- | --- | --- |
| MBTA static GTFS ZIP | [MBTA GTFS documentation](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md), [download ZIP](https://cdn.mbta.com/MBTA_GTFS.zip) | Stops, trips, calendars, transfers, and transit shapes |
| Massachusetts OpenStreetMap PBF | [Geofabrik Massachusetts](https://download.geofabrik.de/north-america/us/massachusetts.html), [download PBF](https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf) | Streets for access, egress, transfers, walking, and driving |

No API key is needed for these downloads. Choose **static GTFS ZIP**, not GTFS-realtime, and **`.osm.pbf`**, not a shapefile or GeoPackage. Keep the original files and acquisition date: `latest` is not a frozen dataset.

With `curl`, `unzip`, and [Osmium Tool](https://osmcode.org/osmium-tool/manual.html) available, create a separate working directory:

```sh
mkdir -p boston-tutorial/data
cd boston-tutorial
curl --fail --location --retry 3 --output data/MBTA_GTFS.zip \
  https://cdn.mbta.com/MBTA_GTFS.zip
curl --fail --location --retry 3 --output data/massachusetts-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf
unzip -p data/MBTA_GTFS.zip feed_info.txt
unzip -p data/MBTA_GTFS.zip calendar.txt
unzip -p data/MBTA_GTFS.zip calendar_dates.txt
```

The feed checked for this tutorial covers **2026-09-25 through 2026-12-12**. We use Monday **2026-10-05**. For a later download, choose a date covered by both the feed interval and its weekday calendars/dated exceptions. Times below are local MBTA service times in `America/New_York`.

```sh
SERVICE_DATE=2026-10-05
osmium extract --bbox=-71.20,42.25,-70.95,42.45 --strategy=complete_ways \
  data/massachusetts-latest.osm.pbf --output=data/boston.osm.pbf
vigo build --gtfs ./data/MBTA_GTFS.zip \
  --osm ./data/boston.osm.pbf --output ./boston
```

The [complete-ways extract](https://docs.osmcode.org/osmium/latest/osmium-extract.html) retains the nodes of ways crossing the rectangle. It covers this tutorial's central Boston/Cambridge locations, **not the full MBTA network's street access**. For a wider study, enlarge the extract to cover every endpoint and transfer location. To skip Osmium, pass the complete Massachusetts PBF to `--osm`; expect more preparation work, and use additional coverage for Rhode Island trips. Keep the providers' notices when distributing data; see [OpenStreetMap attribution](https://www.openstreetmap.org/copyright).

VIGO writes one complete `./boston` directory. An existing output is left alone unless you supply `--replace`.
Time this command from invocation through successful return to measure Build
from GTFS and OSM. Include the first Route as well when measuring time to the
first answer. Reopening `./boston` measures a different operation; see
[Performance](developer.md#measuring-performance) for the exact boundaries.

Inspect the finished City before querying it:

```bash
vigo inspect --city ./boston --output ./city-inspect.json
```

Confirm the expected sources and counts. Keep the entire City directory; the inspection JSON identifies it but does not contain the routing data.

### 3. Run a Route

Save `route.json` for **Harvard Square → South Station**. Coordinates are **[longitude, latitude]**:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "maxWalkKm": 1.2,
  "maxTransfers": 3,
  "requireTransitRide": true
}
```

Use the `SERVICE_DATE` selected above. First depart at 08:00, then ask for arrival by 09:00:

```bash
vigo route \
  --city ./boston \
  --request ./route.json \
  --time 08:00 \
  --service-date "$SERVICE_DATE" \
  --output ./route-result.json
vigo route --city ./boston --request ./route.json \
  --service-date "$SERVICE_DATE" --time 09:00 --time-preference arrive \
  --output ./arrive-by-result.json
```

### 4. Inspect the Result

Read `status` first, then `journey.departureTime`, `journey.arrivalTime`, and `journey.legs`. Clocks use local service-day `HH:MM:SS`; durations use seconds. An `ok` result has a journey; `not_found` means no journey under the requested date, walking limit, transfer cap, and time horizon. Check warnings and station/walking qualifications too.

Trip IDs and journey times depend on the downloaded feed. This is scheduled routing; these commands do not fetch live delays. The [offline Result viewer](guide.html#viewer) opens the exported JSON. [Read and retain a Result](reference/results.md) explains the full record.

For extra time before an appointment, add `"arrivalBufferMinutes": 5` to an
arrive-by request and optionally `"minimumTransferBufferMinutes": 3`. A 09:00
deadline then searches for arrival by 08:55, with extra time at transit changes.
These are explicit preferences, not measured delay probabilities. The
[uncertainty guide](#travel-time-uncertainty) gives a complete
Boston request and explains what the margins cover.

### 5. Run Matrix

Save `matrix.json`: rows are **Harvard Square and Kendall Square**, columns are **South Station and Copley Square**. This asks for four journeys:

```json
{
  "origins": [
    {"id": "harvard", "point": {"coordinate": [-71.11902, 42.37334]}},
    {"id": "kendall", "point": {"coordinate": [-71.08618, 42.36249]}}
  ],
  "destinations": [
    {"id": "south-station", "point": {"coordinate": [-71.05524, 42.35227]}},
    {"id": "copley", "point": {"coordinate": [-71.07758, 42.34997]}}
  ],
  "maxWalkKm": 1.2,
  "maxTransfers": 3,
  "includeJourneys": true
}
```

```bash
vigo matrix \
  --city ./boston \
  --request ./matrix.json \
  --time 08:00 \
  --service-date "$SERVICE_DATE" \
  --output ./matrix-result.json
```

Read `durationsSeconds[originIndex][destinationIndex]` and, when requested, the corresponding `journeys` entry. Unreachable pairs are `null`; missing travel times are not zero. Add more unique origins or destinations to expand the same request.

### 6. Run Reach

Save `reach.json` to find streets and stops reachable from **Harvard Square** within 15, 30, and 45 minutes:

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
  --service-date "$SERVICE_DATE" \
  --output ./reach-result.json
```

Untimed stairs with a stair count and fare/exit gates use labeled routing estimates; other station pathways without usable time or length are excluded. Source-timed interior links without a known distance report a distance lower bound; neither those links nor free-coordinate connectors establish complete physical walking feasibility. Inspect the [walking evidence](reference/walking-evidence.md) on a returned journey before treating it as a passenger-facing guarantee.

### 7. Reuse the loaded network

One-off commands load the City each time. For repeated requests, keep one `stream` process running. Save `queries.ndjson` with one object on each line:

```jsonl
{"id":"harvard-south-depart","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"time":"08:00","maxWalkKm":1.2,"maxTransfers":3}
{"id":"harvard-south-arrive","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"time":"09:00","timePreference":"arrive","maxWalkKm":1.2,"maxTransfers":3}
```

```sh
vigo stream --city ./boston --service-date "$SERVICE_DATE" \
  < queries.ndjson > results.ndjson
```

Check every response status. For an API, use [VIGO Engine](#deploy-the-routing-engine) or the [Rust HTTP service](guides/rust-standalone.md#15-http-api-and-server-operation). When timing routing, distinguish the network build, a fresh process's first answer, and requests to a resident process.

### Where next

- [Practical workflows](#work-with-a-city): arrival deadlines, pairwise journeys, and a complete baseline/Scenario comparison.
- [Troubleshooting](#troubleshooting-1): build failures, blocked routes, time semantics, and stale observations.
- [Documentation reader](guide.html): searchable CLI, Results, Scenario, and Query reference.
- [VIGO Studio Guide](#vigo-studio-desktop-guide): visual exploration, routing, playback, and analysis.
- [Core concepts](#core-concepts): City, Scenario, Query, and Result.

## Core concepts

A new VIGO user needs four nouns and three Query names.

```text
City -> optional Scenario -> Route | Matrix | Reach -> Result
```

### City

A City is a compiled mobility model built from GTFS and OSM. It is stored as one complete directory so its timetable, streets, and query data cannot drift apart.

A named City may have several immutable revisions. Rebuilding source data creates a new revision. Existing Scenarios and Results remain tied to the revision that produced them.

Revision identity and build time are separate: `revisionId` identifies the immutable build, while `builtAt` records when it was created. `sources` records the GTFS and OSM inputs.

A built City can be reopened without its raw GTFS or OSM files. Keep or copy the
whole directory, including its prepared files. Building prepares the street
indexes and station-access state. The first query for a new set of active
services prepares a timetable snapshot; subsequent processes can reload it.
Dates with the same active services share that snapshot. A new process still
loads the files into memory, while an open process keeps them ready.

Prepared files are tied to the source revision, routing policy, and format.
Missing, stale, or incompatible timetable/access caches are rebuilt from the compiled
City, without importing raw sources again. Required street files must remain complete;
restore or rebuild a City with missing/corrupt street indexes. Timetable snapshots use a bounded
disk cache, so an evicted service pattern must be prepared again. Updating the
underlying GTFS or OSM data requires a new City build.

### Scenario

A Scenario is an immutable set of changes applied to one City revision.

Planned changes apply to Reach. Supplied traffic applies to Drive Route and Matrix, while a supplied realtime snapshot applies to transit Route. The CLI carries these as `scenario`, `traffic`, and `realtimeSnapshot` respectively; see [Scenario support](#scenario-semantics). Walking limits, departure times, and time cutoffs remain Query options. A complete alternative GTFS source creates a new City revision.

VIGO rejects unsupported combinations before computation. It does not silently drop changes or move a Scenario to a newer City revision.

### Query

#### Route

Find and explain travel between ordered points. Mode, depart-at, arrive-by, departure windows, waypoints, and batching are Route options.

Depart-at minimizes arrival time, then boardings, then walking. Arrive-by maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, walking, and actual arrival.

#### Matrix

Compute scalar travel time between origin and destination sets. A single origin is simply a Matrix with one origin.

#### Reach

Compute where the represented network can travel within stated time limits. A Reach Result can be shown as contours or reached streets.

Reach is not Accessibility. Accessibility requires an additional opportunity measure such as jobs, people, schools, or healthcare.

### Result

A Result is the immutable answer to one Query. It contains status, values, warnings, timing, the City revision, the Scenario if any, and query output.

Compare is an action on compatible Results. It is not a fourth Query.

Keep the original request and full Result together. The normalized `query` is useful for inspection but is not a complete archive of every option or supplied observation. See [Read and retain a Result](reference/results.md).

### Choose a supported combination

| Query | Travel mode | Time constraint | Supplied changes or observations |
| --- | --- | --- | --- |
| Route | Transit | Depart-at or arrive-by; ordered waypoints and departure windows have their own limits | Matched GTFS-RT Trip Updates when realtime is explicitly selected |
| Route | Walk or Drive | Street routing with the chosen time direction | Supplied traffic for Drive in realtime mode |
| Matrix | Transit | Fixed departure or arrival deadline | Scheduled timetable; no planned-service or live-transit overlay |
| Matrix | Walk or Drive | Static street metric; an arrive-by flag does not introduce time-varying traffic | Supplied traffic for Drive in realtime mode |
| Reach | Transit with walking, or Walk | Fixed departure and time cutoffs | Planned service Scenario; scheduled analysis |

Use `vigo capabilities` for the running build and the [query references](#ask-a-question) for request-specific limits. The capability catalog's `scenario.support.liveTransit` describes the live Scenario interface; CLI `realtimeSnapshot` admission is a separate [Route contract](#realtime-journey-routing). A visible vehicle, alert, or added trip is not itself a routing update.

CLI queries default to scheduled mode. Drive traffic requires explicit realtime selection as well as the supplied `traffic` object; for Matrix, set `routingDataMode: "realtime"` in the request JSON. The public Matrix command does not accept a `--data-mode` flag. No traffic provider is fetched automatically.

### Outcomes

- Public Route and Reach Results use `ok` or `not_found`. A completed Matrix uses `ok`, with `null` for unreachable cells.
- Python Results expose `ready` or `blocked`; those names belong to the wrapper API.
- Malformed or unsupported CLI requests exit nonzero with an explanation on standard error.
- Background work reports `queued`, `running`, `ready`, `cancelled`, or `error`.
- Execution failure raises an error; it is not an analysis Result.

Use `vigo capabilities` to inspect support before execution.

### Time

Service dates use the City's timetable timezone. A GTFS event at `25:10` belongs to that service date even though it occurs after calendar midnight. CLI clocks accept `00:00` through `29:59`; supply the exact service date with the clock. Realtime observation timestamps are a separate clock used to admit or reject predictions.

VIGO keeps Build, Open, Compute, and End-to-end durations separate. Reusing an open process is useful runtime behavior, but it does not replace or hide Query computation.

Continue with [practical workflows](#work-with-a-city), [Result semantics](reference/results.md), or [troubleshooting](#troubleshooting-1).

## Work with a City

Start with a built City from the [quickstart](#vigo-cli-quickstart). Choose the output your question needs, keep the inputs explicit, and inspect the resulting evidence before drawing a conclusion.

The commands below use `./boston` and the quickstart's coordinates. Replace `YYYY-MM-DD` with a covered local service date. Each JSON block is a complete request to save under the filename shown.

### Choose a query

| Question | Use | Read |
| --- | --- | --- |
| How can someone make this journey? | Route | Timed legs, transfers, walking, and access qualifications |
| When must people leave to reach one destination by a deadline? | Arrive-by Matrix | Per-pair status and departure; optional actual journey arrival |
| Where can someone travel within a time budget? | Reach | Grid values and contours at the chosen cutoffs |
| How would a proposed service change that reach? | Baseline Reach, Scenario Reach, then Compare | Time changes and newly/lost reachable cells |
| What are the feeds reporting now? | Studio Network | Observation time, coverage, predictions, and source identity |

The [support table](#choose-a-supported-combination) shows which modes and supplied states each query accepts. A full alternative GTFS dataset needs its own City revision; planned service edits currently apply to Reach.

### Explain one journey

Save `journey.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.08337, 42.32978]},
  "mode": "transit"
}
```

```bash
vigo route --city ./boston --request ./journey.json \
  --service-date YYYY-MM-DD --time 08:00 --max-walk 1.2 \
  --output ./journey-result.json
```

Check `status`, then the chronological `journey.legs`. Walking competes with transit; set `requireTransitRide: true` to require a boarding. A `not_found` result can reflect the date, timetable, access network, or constraints; it does not automatically mean the physical locations are disconnected. Use [blocked-Route diagnostics](#result-1) to identify the next check.

For a walking journey, use `"mode": "walk"` with coordinate endpoints. For an arrive-by transit journey, add `--time-preference arrive` and set `--time` to the deadline. For alternatives around a departure, use `--departure-window 10` to sample within ten minutes either side of the requested time; inspect `alternatives` and the [Route contract](#route-1) before treating that list as a continuous timetable profile.

### Reach one destination by a deadline

Save `arrival-matrix.json`:

```json
{
  "origins": [
    {"id": "harvard", "point": {"coordinate": [-71.11902, 42.37334]}},
    {"id": "central", "point": {"coordinate": [-71.1035, 42.3654]}}
  ],
  "destinations": [
    {"id": "destination", "point": {"coordinate": [-71.08337, 42.32978]}}
  ],
  "includeJourneys": true
}
```

```bash
vigo matrix --city ./boston --request ./arrival-matrix.json \
  --service-date YYYY-MM-DD --time 09:00 --time-preference arrive \
  --output ./arrival-matrix-result.json
```

Every pair shares the deadline. Read `durationsSeconds[origin][destination]`; `null` means unreachable. Use the matching `journeys` entry for actual modeled departure, arrival, walking, waiting, and transfers. The scalar duration runs to the deadline and can include destination waiting. Set `includeJourneys` to `false` when only scalar times are needed. Geometry is a separate opt-in that requires journeys.

A shared destination and deadline share the scalar reverse search; a shared origin and departure share the scalar forward search. Including journeys adds shared journey rounds. Keep IDs unique and stable across requests. Split larger jobs into requests with at most 100,000 pairs and within the CLI's 16 MiB JSON limit, grouping by shared time and options. See [Matrix](#matrix-1) for execution and output details.

### Test a planned service change

Save `baseline-reach.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48
}
```

Save `alternative-reach.json` with the same origin and surface settings:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
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

The speed, headway, and operating span are illustrative assumptions. This example uses the defaults of bidirectional service, distance-estimated timing, and 0.35-minute dwell. It does not establish a drivable alignment, achievable running time, vehicle requirement, or service plan. Use [Scenario semantics](#scenario-semantics) to specify supported branch edits and timing assumptions for a real proposal.

```bash
vigo reach --city ./boston --request ./baseline-reach.json \
  --service-date YYYY-MM-DD --time 08:00 --max-walk 1.2 \
  --output ./baseline-result.json

vigo reach --city ./boston --request ./alternative-reach.json \
  --service-date YYYY-MM-DD --time 08:00 --max-walk 1.2 \
  --output ./alternative-result.json

vigo compare --before ./baseline-result.json --after ./alternative-result.json \
  --output ./reach-change.json
```

Compare uses the retained surfaces. Negative `meanChangeMinutes` means faster modeled travel among cells reachable in both; newly reachable cells are counted separately. Check all counts together. A larger contour is not a population benefit estimate. An accessibility study also needs opportunity data, a spatial assignment method, and an explicit measure.

### Investigate live service

In Studio, start in **Network**, check the observation time and reporting coverage, then choose a route in **Routes**. Compare scheduled and predicted events at the same stop. Inspect a vehicle's position separately from its stop-time predictions. Ask can help interpret the retained evidence once a model is connected; its explanation remains subject to review.

Use **Route → Realtime** to query supported matched predictions. A vehicle visible on the map, an alert, or an added trip displayed in Trip times does not by itself make that service available to routing. See the [Network guide](#network-routes-and-ask) and [realtime admission](#realtime-journey-routing).

For a reproducible scheduled analysis, use an exact date/time in Scheduled mode. For an incident review, retain the observation, identity, coverage, and result from the original investigation. See [reading and retaining Results](reference/results.md) for both workflows.

## Route

Route finds and explains travel between ordered points.

### Inputs

A Route Query selects:

- origin, optional ordered waypoints, and destination;
- transit, walk, or drive;
- exact service date and local time;
- depart-at or arrive-by;
- walking limit, optional maximum transfers, and objective;
- optional departure window;
- optional Scenario state supported by the selected mode.

Stop IDs are exact GTFS identifiers. Coordinate points are [longitude, latitude] and require streets in the City.

Transit Route and Matrix compare a direct OSM walk by default. This lets short
coordinate trips return walking when it reaches the destination sooner. Set
`requireTransitRide: true` to require at least one vehicle boarding, or select
Walk mode to request walking alone. `maxWalkKm` limits each access and egress
walk. Set `allowLongWalk: false` to apply that same limit to a direct walking
alternative; otherwise `maxStreetKm` bounds the complete walk.
`--horizon` / `horizonMinutes` sets the timetable
search horizon in minutes (default 480, range 1–2880).
For depart-at transit, boarding and alighting must occur at or before this
boundary, including in alternative journeys. Final walking can finish after
it. Arrival slack for alternatives does not extend the timetable horizon.
The horizon is not a hard limit on door-to-door journey duration.
Comparisons using a total-duration cap must check the final arrival separately.

Studio's **Route options → Allow walks between stations or stops** controls
walking connections between separate stops or stations. It is enabled by
default. Turn it off to change services only at the same stop or between members
of one station, as identified by the GTFS station hierarchy. The engine removes
cross-station walking edges before searching again, including for arrive-by,
realtime and departure-window alternatives. Access to the first stop and egress
from the last stop remain available.

Transit Route requests accept the boolean `allowStreetTransfers` (default
`true`); Transit Matrix uses the same choice. This option does not certify
station-interior paths or free-transfer eligibility. Existing station-access
warnings still apply, including to assumed connections within one station.

**Minimum transfer buffer** adds extra time before boarding each subsequent
service, after any transfer walk and source-defined minimum transfer time. It
is charged once per transfer, including a change at the same stop. It does not
change first boarding, final egress, or remaining on the same vehicle. The
selector defaults to 0 minutes; Route and Matrix requests accept
`minimumTransferBufferMinutes`, an integer from 0 to 60, with the same default.
The buffer is available for routes without via points and constrains departure,
arrive-by, realtime, and departure-window searches. Ordered transit requests
with via points reject a nonzero buffer because independently composed legs
cannot certify the transfer at their boundary. It is a timetable feasibility
constraint, not a prediction of delays.

**Arrival reserve** (`arrivalBufferMinutes`, integer 0–60, default 0) plans an
arrive-by Transit Route or Matrix against an earlier destination deadline while
preserving the original earliest departure. Use it with the transfer buffer
when the traveler wants extra time. Results retain the actual timetable clocks
and report both deadlines in `diagnostics.timeReserves`. It is a user-selected
margin with no calibrated probability; see [Travel-time uncertainty](#travel-time-uncertainty)
for a Boston example, restrictions, and the calibration requirements.

Transit JSON requests accept `disableCache: true` to disable street-access
frontier and walking-path caches while keeping the prepared City resident.
Route answers are recomputed regardless of this option.
The same flag applies to the wider access probes used to explain a blocked
Route; each returned probe records `cacheDisabled` and `cacheHit`.

### Result

The public `vigo.route.v1` Result contains `status`, a `journey` with chronological legs and duration in seconds, `warnings`, `quality`, and `meta`. A `not_found` Result is a completed answer with `journey: null`. See [Result fields](reference/results.md) for the public schema.

The diagnostics below describe the one-shot Node Route debug trace. Request `diagnostics: "trace"` and read them under `trace.result.diagnostics`; they are not top-level public fields.

Access failures include endpoint-specific `diagnostics.accessAvailability`:

- `outside_selected_budget`: an access candidate exists at a larger walking
  limit. Its suggested limit does not guarantee a complete transit itinerary;
  `streetPathVerified` records whether the candidate's path is verified.
- `street_access_unverified`: nearby stops exist, but the bounded street search
  did not verify access. `nearestStop.distanceKind: "straight_line"` describes
  proximity, not walking distance or time. Longer paths can still exist.
- `none_within_probe`: no access candidate was found within `probeWalkKm`.
  This is a bounded result, not proof of disconnection at every distance.
- `diagnostic_unavailable`: the explanatory probe failed. The result reports
  `access_diagnostic_unavailable`, distinct from a completed negative search.

The diagnostic never increases the request's walking allowance automatically.
Blocked plans retain `diagnostics.searchLimits` for walking, horizon, transfers,
and the transit-ride requirement, including `horizonScope: "timetable_scan"`.
`no_path` means no scheduled itinerary under
those constraints and the selected service date; changing a constraint requires
a separate query.

The engine adds no implicit boarding buffer. Same-stop vehicle changes honor published GTFS minimum transfer times and forbidden transfers; staying aboard does not incur a transfer minimum. Explicit transfer edges retain their durations without an added boarding margin or a 60-second floor. Native diagnostics report `transferBoardSlackSeconds: 0`. A published platform-to-platform transfer rule takes precedence over the station walking fallback.

VIGO exposes `earliest_arrival`. Equal-arrival journeys prefer fewer boardings, then less walking, then a stable final order. VIGO does not expose an undefined “balanced” preference. Arrive-by first maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, then walking, then actual arrival. A slightly later on-time arrival can therefore avoid unnecessary transfers. If the reverse boundary cannot initially be materialized, the engine reconstructs a forward witness at that same departure using the complete access frontier. A remaining mismatch is a query error; an earlier feasible transit departure is not certified as latest. An independently verified direct walk may dominate the reverse transit bound.

Departure-window queries also return up to five distinct journey choices in the Node trace
`choices`, including slower services that reduce transfers or walking. For each
searched departure, the scheduled search retains arrival/boarding/walking
trade-offs arriving within 15 minutes of the earliest journey, with no more
boardings than that journey. Duplicate and dominated choices are removed;
the list is never padded to five. The earliest-arrival result stays first.
Studio's supported realtime Route queries retain their departure-window choices without applying the
scheduled alternative search to an adjusted timetable.

Depart-at transit, arrive-by transit, walking, driving, waypoints, and batch requests remain Route variants. Desktop and CLI Route support realtime transit. CLI callers supply `realtimeSnapshot` and select `--data-mode realtime`; scheduled mode remains the CLI default. See [data modes and provenance](#realtime-journey-routing). See the [realtime limits](#realtime).

Ordered Transit routes can walk any segment, including the whole journey.
Selection compares complete journeys by arrival time (or latest departure),
then boardings and walking. A later walk to a waypoint can replace a short
ride when both catch the same onward vehicle. Up to eight partial journeys
are retained at each waypoint and up to five complete choices are returned;
this bounded alternative search does not enumerate every possible itinerary.
Equal continuation clocks reuse a segment query, and waypoint clocks retain
seconds. `requireTransitRide: true` explicitly requires a ride on each segment.

### Transfer and access rules

Use `maxTransfers` in a JSON request or `--max-transfers=N` in the CLI. Studio exposes Maximum transfers under Route options.
`0` permits at most one boarding; `1` permits at most two. Values must be
integers from 0 through 31. Omit the option for no additional limit. Staying
aboard the same trip is not a transfer. Walking competes unless `requireTransitRide: true` is supplied.
The cap constrains the native search, including alternatives and arrive-by;
a slower feasible route is searched when the unrestricted winner exceeds it.
A finite cap with ordered transit waypoints is currently unsupported.

Anonymous coordinate endpoints use the same nearest street attachment in Route
and Matrix. Physical GTFS stops use that same attachment rule; a parent station
does not provide free movement to every platform. Declared station paths retain
their direction and time. Their complete time/distance frontier is prepared once,
then filtered against the endpoint's remaining walking budget in Rust. Interior
pathway nodes do not create additional street entrances. Station links with
schematic geometry report `streetPathVerified: false` and `stationPathSources`.
When GTFS omits `traversal_time`, the configured walking policy prices the
declared pathway length, or the stop-coordinate distance if length is also
absent. Stairs with a stair count and fare/exit gates use the labeled estimates described in [walking evidence](reference/walking-evidence.md), floored by any available walking distance. A missing time is not a zero-time link. For endpoint access and transfers, declared
pathway graphs suppress generic platform shortcuts. Fallback station links
include their walking time in both endpoint and timetable preparation.
Endpoint walks using a prepared station path expose `accessCost.street` and
`accessCost.station`, each with distance and seconds. The station component
also retains directed `stopIds` and source types. Published station traversal
times can differ from distance divided by street walking speed. The component
witness supports a source-data audit; it does not certify physical station access.
Cities built with transfer semantics v2 must be rebuilt to retain pathway lengths.
The walking
limit covers each complete continuous access or egress walk; a transfer walk
cannot extend the final egress beyond that budget. Generated transfer legs
are reconstructed from the same physical-stop profiles used to price them.
Street transfers use declared entrances and directed station pathways. Preparation
composes the station paths around at most one external transfer edge; returned
journeys retain each original walking segment and its source time.

A repeated station is reported from the complete ride stop sequence. It does
not automatically invalidate a path: a scheduled loop or a forbidden direct
platform change can require it. Alternatives are filtered by objective
dominance, not by a geometric cycle rule.

A coordinate that snaps to the street graph can have an `endpointConnector` on
the first or last walking leg. Its coordinates and distance describe the snap
already included in that leg's cost. It has `source: "coordinate-snap"` and
`streetPathVerified: false`; the leg's `coordinates` retain the routed street
path. A connector is not evidence of a mapped or legally traversable street.

### Implementation reference

For geometry materialization and identifier internals, see [the architecture reference](developer.md#itinerary-geometry-and-identifiers).

## Matrix

Calculate travel time between sets of origins and destinations in one request. Use a shared departure time or a common arrival deadline, and request journeys only when you need their steps.

### Send a matrix request

```json
{
  "origins": [{"id": "home", "point": "A"}],
  "destinations": [{"id": "work", "point": "B"}],
  "mode": "transit",
  "requireTransitRide": false,
  "includeJourneys": false,
  "includeGeometry": false
}
```

Replace `A` and `B` with exact stop IDs in your City. Walk and Drive Matrix require coordinate endpoints. The [Boston quickstart](#5-run-matrix) contains a complete four-pair example.

```sh
vigo matrix --city ./city --request matrix.json \
  --service-date 2026-10-05 --time 08:30 --time-preference arrive
```

The Node CLI uses `arrive`; the Rust interface also accepts its documented `arrive_by` form. Use the [standalone Matrix reference](standalone.html#matrix) for Rust-specific request shapes and flags.

### Read the result

`durationsSeconds[originIndex][destinationIndex]` gives each pair's elapsed time. The ordered endpoints are retained in `query`. A `null` cell means unreachable, never a zero-minute journey. A completed matrix can contain both reachable and unreachable pairs.

With `includeJourneys: true`, `journeys` has the same ordering and contains a journey or `null` for each pair. Add `includeGeometry: true` for path geometry; it requires journeys and performs no additional timetable search. Both options default to false.

For arrive-by analysis, a scalar duration is the requested deadline minus the latest feasible departure. A nested journey reports its actual arrival and may have a shorter duration if it arrives early. Use the journey when distinguishing travel from waiting at the destination.

Public durations and journey components use seconds. Internal `rows`, `durationMinutes`, and search counters are available only through explicitly requested trace output. See [Results](reference/results.md).

### Choose constraints

Transit compares a feasible direct OSM walk by default. Set `requireTransitRide: true` to require a boarding. `maxWalkKm` bounds transit endpoint walking; direct walking has its own end-to-end policy. `maxTransfers` accepts 0–31 changes or can be omitted. `horizonMinutes` bounds the timetable search, not necessarily the final door-to-door duration.

Transit Matrix is scheduled. Drive Matrix can use a supplied traffic snapshot with `routingDataMode: "realtime"`; it does not fetch a provider or model time-varying traffic during the journey. See [streets and traffic](#street-routing).

Use `allowStreetTransfers: false` to exclude cross-station walking connections. `minimumTransferBufferMinutes` adds time before subsequent boardings. An arrive-by `arrivalBufferMinutes` searches against an earlier arrival deadline. See [travel-time uncertainty](#travel-time-uncertainty) for the meanings and restrictions.

### Share work across pairs

One request supports up to 100,000 pairs, subject also to the CLI's 16 MiB request limit. Results retain input ordering, including repeated endpoints.

| Workload | Shared timetable search |
| --- | --- |
| Depart-at, one origin and many destinations | One forward scan |
| Depart-at, many origins | One forward scan per unique origin |
| Arrive-by, many origins and one destination | One reverse scan |
| Arrive-by, many destinations | One reverse scan per unique destination |

Group work by common endpoint, date, clock, and constraints. Request scalar output when only travel times are needed. Journey queries additionally share boarding rounds within each endpoint group; tied journeys can differ from Route's stable traversal order while satisfying the same objectives.

`disableCache: true` bypasses the supported endpoint-frontier caches while preserving same-request sharing, loaded City data, and immutable street indexes. It does not clear the operating system page cache. Measure full caller wall time separately from native counters; [service benchmarking](developer.md#reproduce-a-service-workload) records that distinction.

## Reach and isochrones

Find streets and areas reachable from one origin within a time budget. Reach supports scheduled transit with walking, or walking alone. It does not measure access to jobs or people unless your analysis supplies those opportunities separately.

### Send a Reach request

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "mode": "transit",
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 96,
  "surfaceSampling": "street"
}
```

```sh
vigo reach --city ./boston --request reach.json \
  --service-date 2026-10-05 --time 08:00 --output reach-result.json
```

Use a City and date covering the origin. `mode: "walk"` requests walking-only Reach. Drive, arrive-by, and realtime Reach are unavailable. Planned transit changes use transit with street sampling.

### Set the analysis resolution

| Option | Meaning |
| --- | --- |
| `cutoffsMinutes` | Time budgets from 1 to 240 minutes; fractional values are accepted |
| `maxWalkKm` | Transit walking budget |
| `walkSpeedKph` | Walking speed from 1 to 8 km/h |
| `extentRadiusKm` | Requested raster extent from 1 to 40 km |
| `rasterSize` | 48, 64, 96, 128, 192, 256, 384, 512, or 1024 cells per side |
| `surfaceSampling` | `street` for network sampling, or `cell-center` for coordinate destinations |

The requested extent sets the analytical grid; it is not a maximum trip distance. Time budgets, walking limits, and the network govern reachability. Preserve extent, resolution, sampling, and constraints when comparing results.

### Choose the output

The default `reachFormat: "full"` includes the requested grid and available full-extent output. `surface.valuesSeconds` is row-major from the northwest corner; `null` means unreached. Read its bounds and dimensions together with the values. `fullSurface` describes the separate full reached extent when available.

`areas` are GeoJSON polygons around reachable cells. `contours` are isolines. For a map, request `reachFormat: "map"` to return the full reached-area polygons and their bounds without raster values, stop lists, or duplicate contour representations. Map output cannot be used for raster comparison.

For detailed network evidence, use `includeStreetEdges: true` or `--street-edges` with full output. Returned directed intervals retain their explicitly named units. Keep this evidence separate from the public second-valued raster. See [the output dictionary](standalone.html#reach-output) for raster ordering and edge decoding.

### Inspect a destination in Studio

Route and Accessibility start with the same clear map. Background transit lines and stop markers stay hidden; chosen points, journeys, and reachable areas appear as you work.

After running Accessibility, click a destination to see its map estimate and request a journey there. With the map focused, press Enter to inspect its center. The journey keeps the analysis origin, date, departure time, timetable selection, and walking and ride limits. Expand **Show journey** for the walking and transit legs. When comparing timetables, select one in the destination panel. A missing raster sample does not by itself mean no journey exists.

Destination journeys use scheduled service and the City's routing walking speed. Planned service changes affect the scenario map estimate; they are not reconstructed in the destination journey. The panel labels these differences when applicable.

### Compare service changes

Run a baseline, then a planned Scenario with the same origin, clock, date, walking assumptions, sampling, and grid. Retain both results. [Scenario](#scenario-semantics) explains exclusions and added service; [Results](reference/results.md#compare-saved-results) explains changes and newly or no-longer-reachable cells.

A polygon describes modeled network reach. It does not certify entrance access, wheelchair connectivity, pedestrian permissions, or observed service reliability. Keep the [walking evidence](reference/walking-evidence.md) and [routing limitations](#known-limits) with the analysis.

## Scenario semantics

A Scenario is an immutable set of changes tied to exactly one City revision.

A Scenario may contain planned transit service changes, one live transit state, or one supplied traffic state. Walking limits, speeds, departure times, and cutoffs are Query options.

Scenarios do not edit imported GTFS or OSM. A complete alternative feed creates another City revision. Drawing geometry in an editor does not create a computational change until it is attached to a valid service edit.

Multiple nonconflicting planned changes may coexist. Conflicts require an explicit resolution. A Scenario never moves automatically to another City revision, and expired live state cannot be queried.

VIGO 0.4.2 supports planned service changes in Reach, supplied traffic in Drive Route and Drive Matrix, and realtime Route from supported Trip Updates. CLI Route accepts a top-level `realtimeSnapshot` with `--data-mode realtime`; this is separate from the planned-service `scenario` object. Transit Matrix and Reach remain scheduled. Drive traffic requires a top-level `traffic` object and explicit realtime mode; Matrix selects that mode with `routingDataMode: "realtime"` in JSON. See the [support table](#choose-a-supported-combination) and [realtime limits](#realtime). Inspect supported combinations with `vigo capabilities`. Unsupported CLI requests exit nonzero with an explanation.

### Planned service

A planned service change states what changes and supplies enough information to run it: ordered stops and travel-time assumptions, plus a departure schedule. Existing branch edits retain their GTFS trips by default; new service specifies frequency and operating hours. A Scenario never contains a precomputed network surface.

A Reach request can include this `scenario` object:

```json
{
  "origin": [-77.05, 38.90],
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

`operation` is `add`, `augment`, or `replace`. `excludedRouteIds` removes selected scheduled route variants for the Scenario. These changes remain tied to the City revision used to create the Scenario.

`replace` defaults to `scheduleMode: "preserve-trips"` and requires `sourceRouteId`, `sourcePatternId`, and selected-branch scope (`routeScope: "pattern"`, or omitted when a pattern is supplied). Studio and the CLI load the actual trips active on the query's service date, including calendar exceptions and departures after midnight. Each affected trip produces exactly one replacement; irregular gaps, per-trip running times, dwell, and pickup/drop-off restrictions are retained. Editing stops never adds departures or reverse service. Legacy replacement requests also use this default: old headway/hour fields are ignored unless frequency mode is explicitly selected.

To change the timetable deliberately, use `scheduleMode: "frequency"` with `headwayMinutes`, `startMinutes`, and `endMinutes`. Studio exposes this as **Departures → Set frequency and hours**. This mode can replace a whole route; `add` and `augment` use frequency mode by default. **Keep scheduled departures** requires a specific branch so one edited stop sequence cannot silently replace unrelated branches.

In Studio, **Selected branch only** keeps the change on the chosen pattern. **All branches serving this exact A → B edge** applies one inserted gap to every occurrence of that ordered stop pair within the same feed and public route. It does not include the reverse B → A edge. The editor shows the affected branches and occurrences before running. This scope requires complete branch analysis and one inserted gap; use selected-branch scope for moved stops, extensions, or edits to multiple gaps. Repeated stop visits retain their own position in the sequence and their published runtimes. Overlapping replacement services are rejected.

Editing an existing GTFS branch follows its published direction. Creating reverse service is available in frequency mode as an explicit scenario choice; it is not inferred from a shared route name.

For a branch retaining its trips, road geometry distributes each trip's original A → B running time among the edited gaps. Original dwell remains at retained stops; `addedStopDwellMinutes` (default 0.35) adds dwell at inserted stops. Removing an intermediate stop removes its dwell. The first retained GTFS stop anchors departure timing; a preceding extension departs earlier, while later stop edits shift downstream times. At least one original stop must remain, with `baselineStopId`/`baselineStopIndex` identifying moved stops and repeated visits. An extension requiring a departure before the service date is rejected. Straight-line estimates use the supplied speed for changed gaps; untouched gaps keep their trip-specific times. These are modeled timing changes, not a vehicle or crew scheduling feasibility check.

New lines use `segmentDistancesKm` and `averageSpeedKph` for road timing, plus `dwellMinutes`. Frequency-mode edits use the supplied segment runtime estimates. Segment distance and runtime arrays must contain one value per stop pair. Studio requires a completed road path before running a road-following Scenario.

### Compare the change

Run a baseline Reach and a Scenario Reach against the same City, origin, date/time, walking policy, cutoffs, and grid. Save both Results before using `vigo compare`. The [workflow guide](#test-a-planned-service-change) provides complete paired requests.

Compare reports after-minus-before time changes for cells reachable in both surfaces, and counts newly reachable and no-longer-reachable cells separately. It checks grid compatibility, but does not verify every experiment setting. Read [Compare semantics](reference/results.md#compare-saved-results) before interpreting a mean change as the effect of the Scenario.

## Inspect a saved Result

Open a JSON response from VIGO 0.5.0's public Engine CLI or HTTP API. This viewer shows its status and main answer, followed by the complete source JSON.

### Read the public fields

Route uses `journey`, Matrix uses `durationsSeconds`, and Reach uses `surface.valuesSeconds` or map-only `areas`. Durations are seconds; a `null` analytical value is unreachable. Keep geometry qualifications and warnings with the answer.

Choose a file below in the [interactive reader](guide.html#viewer). Files are read on your device and are never uploaded. The viewer accepts up to 25 MiB; use your analysis tools for larger responses.

### Python exports

Python's `Result.to_dict()` retains its detailed, minute-valued payload. Use the [Python Result reference](https://github.com/hytangs/vigo-py/blob/main/docs/guide.md#results) to interpret those exports. This viewer accepts public Engine schemas only.

## Combine timetables and live feeds

A City can contain several static GTFS feeds and several GTFS-Realtime endpoints. Static feeds supply the scheduled network. Live feeds supply observations and predictions for that network; they do not replace the timetable.

### Build a City from multiple GTFS files

In Studio, open **City → Data sources** and add each GTFS ZIP. VIGO imports each source, then builds the combined routing store. Add an overlapping OSM PBF for walking, driving, and coordinate-based transit access. Wait for preparation to finish before querying.

For Engine, repeat `--gtfs` and give each input a stable, unique scope:

```bash
node public/vigo.mjs build \
  --gtfs ./rail.zip --gtfs-scope rail \
  --gtfs ./bus.zip --gtfs-scope bus \
  --osm ./region.osm.pbf \
  --out ./city
```

A scope identifies a **source feed**, not a route number. The merged store namespaces stops, routes, trips, services, and transfer references so identical IDs in different feeds cannot overwrite one another. Use the same scope names when rebuilding the same sources. Removing a source in Studio rebuilds the surviving combined store.

Before combining feeds:

- Use compatible service dates. A trip is usable only when its source calendar and exceptions activate it for the requested service day.
- Keep agencies in one timezone. Cross-timezone routing stores are currently rejected.
- Avoid importing two editions of the same agency timetable as separate networks unless that duplication is intentional.
- Retain declared transfers and verify street coverage. Close coordinates alone do not prove a usable station connection.

### Connect multiple GTFS-RT endpoints

1. Open **City → Data sources → GTFS-RT live feeds**, or feed settings in **Network**.
2. Paste an endpoint URL and choose what it contains. A combined endpoint may contain multiple entity types.
3. Select its matching **Timetable** when the City has multiple static sources.
4. Choose **Add feed** for each additional endpoint, then **Connect live**.
5. Expand **Feed status** to inspect individual failures and freshness.

Trip Updates can be connected without Vehicle Positions. The MBTA preset fills three public endpoints; select the MBTA timetable when using it in a combined City. A failed endpoint does not discard successful endpoints. Reimporting or merging a timetable invalidates the active retained observation until a fresh fetch binds to the new City. Old records from a failed endpoint are not carried into a newly received snapshot.

| Data | What VIGO uses it for |
| --- | --- |
| Trip Updates | Supported predictions and cancellations in transit Route; trip and station inspection |
| Vehicle Positions | Reported map locations, vehicle details and qualified service observations |
| Alerts | Scoped notices and evidence; text does not automatically close a route |

Studio allows up to **16 distinct endpoints**. Repeated URLs with the same timetable are fetched once. Assigning one URL to conflicting timetables is rejected. A refresh has a 30-second overall deadline, a 20 MB per-feed limit, and a 40 MB combined limit. Batches also reject more than 200,000 entities or 500,000 stop predictions. At most four feed downloads run concurrently across inspections. Oversized or failed sources are disclosed individually.

The declared type is descriptive: all supported entities present in the protobuf are decoded. A source timestamp and timetable identity travel with each record. Unscoped IDs can match only when unambiguous; a bare trip ID never resolves by selecting the first agency.

### Supply observations to Engine

The public CLI accepts a retained normalized `realtimeSnapshot` in a Route request with `--data-mode realtime`. It does not open feed URLs. For a combined City, each record can carry `sourceScope` equal to its build scope, alongside the original `tripId`, `sourceFeedTimestamp`, service date and stop predictions. A single-source City uses raw GTFS IDs; omit `sourceScope` there.

Keep source timestamps intact. Changing a capture's timestamps to make it look current changes the input and is not a replay of that observation. A repeated snapshot ages out of the routing cache.

Continue with [realtime routing and admission](#realtime-journey-routing), [GTFS feature support](developer.md#gtfs-support-matrix), and [traffic input](#supplied-traffic).

## Realtime journey routing

### Two modes, one engine

Route exposes `routingDataMode: "realtime" | "scheduled"`. The desktop calls these **Realtime** and **Scheduled · Research**. Journeys through Ask default to realtime; CLI Route defaults to scheduled and accepts `--data-mode realtime|scheduled`. CLI realtime uses a supplied `realtimeSnapshot`; it does not fetch feeds automatically. Internal Studio requests without an explicit mode infer it from snapshot presence; the public CLI requires explicit realtime selection.

Scheduled research requires an explicit service date and departure/arrival time. The server removes realtime and traffic observations before processing the request, enforces the exact date, and disables date substitution. The UI retains the selected date/time and ignores feed polling in this mode. Live refreshes, expiry checks, and mode changes cancel obsolete realtime requests; switching modes never shows the other mode's old result.

Both transit modes use the same native algorithms, stop identities, walking/transfer policies, and optimized coordinate search. The only difference is the timetable presented to that engine. Transit Matrix and Reach remain scheduled analyses and explicitly reject realtime requests. Drive Matrix has a separate supplied-traffic path; see the [support table](#choose-a-supported-combination).

Engine results for an explicit mode include `diagnostics.routingDataMode` and `routingDataProvenance`: source timetable identity, street identity, service date/timezone, query time, walking/search settings, engine contract version, and a reproducibility key. Realtime results also identify the prediction snapshot. Ordered journeys retain component keys and reject changed data identities between legs. To reproduce a research result, retain the same City, VIGO build, and request; the manifest identifies inputs but does not archive them automatically. Retain the returned diagnostics when exporting results so provenance and admission counts remain available. Timing telemetry is not a reproducibility claim.

For setup, see [multiple GTFS and GTFS-RT feeds](#combine-timetables-and-live-feeds). The [0.4.2 method audit](history.md#realtime-and-traffic-method-audit--042) records correctness repairs and remaining boundaries.

### Shared timetable

Journey searches compile the complete supplied GTFS-RT TripUpdate snapshot into a separate resident timetable. Within the explicit resource admission limits, there is no endpoint-based selection, inspection pruning, or duplicate-stop overlay. Oversized snapshots are rejected as a whole; they are not silently truncated. Each valid matched update replaces its scheduled trip; canceled and deleted trips have no ride segments. Unreported trips retain scheduled times.

Depart-at, arrive-by, transfer limits, and departure-window alternatives use this timetable and the existing native search algorithms. Reverse search and forward journey materialization share the same predictions. A query freezes its observation clock, including recursive verification and window samples. The latest compiled snapshot is cached per immutable service kernel; changes to input or timestamp validity invalidate it. Scheduled queries never inherit predictions from an earlier request.

### Admission and coverage

Updates must identify an active trip in the selected service day and source scope. Ambiguous identities, contradictory duplicate records, invalid timing, unsupported relationships, and stale observations are excluded and counted. Feed and record timestamps are checked independently. Engine admission accepts timestamps at most 180 seconds old and at most 60 seconds ahead of its captured clock. Network tools may apply their own freshness policy before the engine, retaining all rejection counts.

An unreported scheduled prefix may conflict with the first explicit prediction of an early-running trip. The resolver can exclude that prefix only when all its departures and the first explicit prediction precede the frozen feed/record observation boundary, without an earlier explicit update or a trip-level delay. The supplied suffix predictions remain unchanged. `pastPrefixTrips` and `omittedPastPrefixStops` disclose the exclusion; this does not reconstruct past events or claim actual passage. Unreconciled future prefixes and contradictory observations remain rejected.

`diagnostics.realtimeRouting` identifies the snapshot and reports applied, canceled, stale, unmatched, wrong-date, duplicate, invalid, and unsupported records. `coverage` accounts for supplied records, including records rejected by Network tools before routing. `prunedUpdates` is zero. `partial` means some updates were applied while others were excluded. `failedFeeds` reports unavailable endpoints, and prevents complete coverage even when all received records were admitted. A scheduled fallback is explicitly identified; compile/search failures do not silently retry against scheduled service.

Full snapshot processing is not a claim that every trip has a prediction. The UI distinguishes predicted and scheduled journey times, live cancellations, and excluded records. Added/unscheduled/replacement/duplicated trips without a supported scheduled instance remain unsupported and disclosed. Frequency instances and cross-timezone stores retain the existing routing-contract limits. Vehicle positions and text alerts do not invent stop-time predictions.

Studio's [added-service display](#added-service) is separate from routing admission. A reported trip can appear in the line view and trip selector without being available to Route.

### Read the realtime status

For CLI transit Route, inspect `result.diagnostics.realtimeRouting.status` together with its counts. `routingDataMode: "realtime"` records the requested mode; it does not by itself mean that predictions changed the timetable.

| Status | Meaning |
| --- | --- |
| `applied` | Matched trip replacements were applied, possibly with cancellations, with no rejected supplied updates |
| `cancellations_only` | Only trip removals were applied, with no rejected supplied updates |
| `partial` | At least one replacement or cancellation was applied and at least one supplied update was rejected |
| `stale_fallback` | No update was applied and feed or record timestamp checks failed |
| `no_matches` | No update was applied for other reasons; check unmatched, wrong-date, duplicate, invalid, and unsupported counts |
| `scheduled_fallback` | No realtime search diagnostics were available; read `fallbackReason`, such as a missing snapshot or a realtime search that did not run |

`coverage.complete` concerns admission of the **supplied updates**, including upstream exclusions. It does not measure the share of all scheduled trips reporting. A fully admitted cancellation snapshot can legitimately return a blocked journey. `routingDataProvenance.realtimeApplied` includes both replacements and cancellations. Retain these fields with the answer; see [Result interpretation](reference/results.md#keep-uncertainty-with-the-answer).

### Verification

Run `npm run check:gtfs` for the full feed/routing suite. Its engine API regressions include more than 256 updated trips, more than 1,024 input records, more than 4,096 updated stops, interior transfers, both time directions, cancellations, skipped stops, balanced choices, transfer limits, snapshot replacement, and timestamp expiry. Kernel tests exercise real native forward/reverse searches and immutable scheduled arrays. Agency and UI suites verify admission and displayed coverage.

`check-realtime-scheduled-parity.mjs` compares 1,536 paired engine queries against eight independently imported GTFS timetables containing the literal effective predictions. It covers both time directions, multiple origin/destination pairs, internal balanced/fastest preferences, transfer limits, dwell, early/late trips, cancellations, skipped calls, and `NO_DATA`. These establish algorithm parity for the tested cases, not field ETA accuracy. `check-realtime-past-prefix.mjs` adds 16 native/literal comparisons, excluded-prefix boarding checks, and cache invalidation when a future source clock becomes current. `check-routing-data-modes.mjs` proves observation isolation and exact-date research behavior. Real browser checks cover current controls, polling, navigation, and source replacement. Earlier renderer spies for mode switching and forced refresh failures were removed; those checks are not claimed as equivalent integration coverage.

The internal preference regressions do not add a public `balanced` objective. The CLI exposes `earliest_arrival`, as described in [Route](#route-1).


### Stop predictions and source versions

Trip-level delay propagates forward until a stop-specific prediction replaces it. A prediction at an intermediate stop never becomes a delay for earlier calls. Absolute time takes precedence over delay; arrival and departure remain separate. `NO_DATA` resets propagated delay. `SKIPPED` removes boarding and alighting while retaining through travel. Repeated stops require an unambiguous sequence, and out-of-order supplied sequences are rejected.

Each decoded record retains its endpoint, source timestamp and selected static-feed scope. Per-feed version metadata is retained for inspection; VIGO does not currently compare GTFS-RT `feed_version` with static `feed_info.feed_version`. The operator must connect the matching timetable edition. Missing Trip Updates mean no reported prediction, not verified on-time operation.

Resource admission is separate from semantic coverage: downloads are bounded, the decoder rejects feeds above 100,000 entities or 500,000 stop predictions, and native reconstruction checks its estimated memory against the configured timetable budget. Over-limit data is rejected, never silently truncated. These safeguards do not establish immunity to operating-system memory exhaustion.

## Street routing

A City built with OSM supports Walk and Drive variants of Route and Matrix, plus directed walking access for transit.

Walk uses the directed pedestrian graph. Drive uses the directed road graph with free-flow time unless the request supplies traffic weights or closures. VIGO does not replace a missing street path with a straight line.

Street Route requires coordinate endpoints and returns full geometry. Street Matrix returns scalar distance and duration per pair without reconstructing every path.

Street Matrix sweeps from the smaller endpoint set. Many-to-one requests use the
reverse directed CCH metric; origin and destination access permissions retain
their original roles.

### Coordinate network attachment

A free coordinate first attaches to its nearest pedestrian vertex or reciprocal
edge. If that attachment belongs to a component with no public transit-access
anchor, the query can recover to the nearest anchored component within 80 m.
This applies to arbitrary coordinates without place-name exceptions. The
connector and partial-edge distance count toward walking time and limits;
point and transit-access geometry include the charged connector. Anonymous
reach seeds use the same recovery and retain that cost.

Stops retain their prepared physical anchors. Query recovery never adds a
street edge or a stop-to-stop transfer between disconnected components. A
mapped authorized terminal path takes precedence, and a restricted endpoint
cannot use recovery to bypass its directed exit. Recovery requires a prepared
transit access profile; a bare street kernel retains nearest-street attachment.

An off-network connector is a modeling assumption, not evidence of a surveyed
entrance or a barrier-free crossing. Recovery is bounded; an isolated place
with no eligible street inside the radius remains unreachable. Components with
anchors can still have direction or timetable constraints that prevent a trip.

### Authorized endpoint access

Build defaults to public pedestrian access. `access=private` without a pedestrian
permission, or `foot=private`, stays outside the public walking graph.
Rebuild older Cities to apply street-store schema v6. It retains pedestrian
permissions and excludes platform area outlines from the linear walking graph.

For a population authorized to use internal roads at its own homes and destinations,
build with `--private-access=endpoints`.
This City-wide modeling assumption permits mapped private streets only within
the origin or destination's attached internal street region. An exact directed
search follows those streets and interior public islands up to the first public
component containing a transit-access anchor. The public middle of the journey
and stop-to-stop transfers cannot enter private streets. Walking wholly within
one internal region is also supported. All internal walking counts toward the
same walking limit, and returned geometry follows the mapped edges.

The private graph is stored separately; public street CCH queries remain available.
`network.json` records the access model, and transit diagnostics report
`walkingAccessPermission: "authorized_endpoints"`. This option assumes endpoint
authorization; it does not infer parcel ownership, gate opening times, or missing
OSM links. Explicit pedestrian prohibitions remain excluded.

Current limits include incomplete turn modeling, no signal-delay model, and dependence on the supplied OSM coverage. See [Known limits](#known-limits).

### Supplied traffic

**No traffic provider is connected by default.** OSM supplies the baseline road graph and free-flow estimates. Live transit feeds do not supply a general road-speed model. Driving results without an applied traffic snapshot must not be described as current traffic estimates.

The public CLI accepts a top-level `traffic` object for Drive Route and Drive Matrix with explicit realtime mode. The internal engine calls this `trafficSnapshot`. A snapshot customizes the prepared directed road graph for one query; it is a fixed set of edge costs, not a forecast that evolves as a vehicle moves through the network.

A minimal input fragment is:

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

Use the actual observation time and coordinates of an observed **directed edge**. This fragment documents the schema; its values are illustrative, not live traffic or a calibrated provider adapter. Full Route requests also need City, mode and endpoint fields; see [Route](#route-1).

| Contract | Behavior |
| --- | --- |
| Time | Required observation time; default validity 300 seconds, maximum 1,800 seconds; future observations beyond 60 seconds are rejected |
| Expiry | Expired observations produce explicit `stale_fallback` and use baseline costs |
| Geometry | Endpoint pairs or a sequence of 2–512 coordinates; directed edge matching within 120 m by default, at most 1,000 m |
| Direct edge indices | Require the exact current `streetSourceFingerprint`; indices are not portable between street builds |
| Costs | Positive travel time, speed, or a slowdown factor; closures are supported; costs cannot become faster than the baseline |
| Overlap | Conflicting observations on one edge use the largest cost, including closures |
| Size | At most 100,000 observations and 250,000 edge references/updates; at most 4,096 direct indices per observation |
| Reuse | The native customized metric can be reused when effective edge updates are unchanged; source age is still evaluated on each query |

Inspect `diagnostics.traffic.status`, matched/unmatched counts and `weightModel`. `applied` establishes that supplied costs changed the model. `no_matches` and `free_flow_equivalent` do not establish current traffic coverage. Route and Matrix use the same customized metric, and closures can leave a pair unreachable.

Coordinate matching is nearest-edge matching, not a validated provider conflation pipeline. Parallel roads, sparse polylines and provider segment definitions need independent checks. VIGO does not yet model all turns, signals, intersection delay, parking, or a future traffic trajectory. A future provider integration needs retained source timestamps, explicit units and direction, graph identity or verified geometry mapping, coverage reporting, and validation against observed travel times.

`test/check-street-routing-modes.mjs` executes actual native Route, Matrix and worker paths for slowdown, closure, expiry, invalid indices and metric reuse. Passing it establishes those model behaviors on its constructed graph; it does not establish real-world ETA accuracy.

## Travel-time uncertainty

VIGO supports explicit time reserves that affect route selection. It does
not yet estimate an on-time arrival probability, travel-time distribution, or
calibrated confidence interval. Scheduled and admitted realtime event times
remain point estimates.

### Use reserves in a routing request

Both the Node Engine and standalone Rust accept these JSON controls:

| Control | Applies to | Meaning |
| --- | --- | --- |
| `minimumTransferBufferMinutes` | Transit Route and Matrix, depart-at or arrive-by | Extra minutes before each subsequent boarding, after walking and published transfer minima. Does not change first boarding or staying aboard. |
| `arrivalBufferMinutes` | Arrive-by Transit Route and Matrix | Reserve the final minutes before the requested arrival deadline. Search for the latest departure that reaches the destination before the earlier planning deadline. |

Both are integers from 0 to 60 and default to zero. Positive arrival reserves
require an arrival deadline at least as large as the reserve and a horizon
exceeding it by at least one minute. The earliest departure remains the one
implied by the original deadline and horizon. Transit via points reject a
positive reserve: independently composing segments would apply it repeatedly.
Walk, Drive, Reach, and native operations reject a positive arrival reserve.

For Harvard Square to South Station, save this as `reserved-arrival.json` for
the Node CLI. Choose a service date covered by your downloaded MBTA feed:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "serviceDate": "2026-10-05",
  "time": "09:00",
  "timePreference": "arrive",
  "maxTransfers": 3,
  "horizonMinutes": 120,
  "minimumTransferBufferMinutes": 3,
  "arrivalBufferMinutes": 5
}
```

```sh
vigo route --city ./boston --request reserved-arrival.json
```

The standalone Rust CLI accepts the same request (`arrive_by` is also accepted).
VIGO plans arrival by **08:55**, allows departure no earlier than **07:00**, and
requires three additional minutes at each transit change. These numbers are
illustrative user preferences, not an MBTA delay estimate or recommended
reliability threshold. A tighter request can legitimately become blocked.

Route clocks and leg durations still describe the selected timetable journey.
Matrix scalar duration keeps its deadline-minus-departure definition, including
the final reserve; nested journeys report their actual modeled arrival. Keep
`diagnostics.timeReserves` with the answer: it records the requested and planning
deadlines, both margins, and `calibratedProbability: false`. Node Route places
it inside `trace.result.diagnostics` when a one-shot Node Route request selects `diagnostics: "trace"`. Public Results summarize qualifications in `quality`; the debug trace is runtime-specific.
Defaults produce the existing deterministic result.

The reserve combines with supplied realtime Transit Route predictions. Transit
Matrix remains scheduled-only. A transfer reserve can absorb some lateness;
it does not model a departing vehicle leaving early, missed-connection recovery,
capacity denial, cancellations, correlated delays, or uncertain walking and
station access. The final reserve alone does not protect intermediate transfers.

### Calibrate probabilities before offering them

GTFS realtime `StopTimeEvent.uncertainty` has no defined statistical meaning;
an omitted value means unknown. It must not be converted into a standard
deviation or a 90% interval without a provider-specific validated model.
See the [GTFS realtime reference](https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent).

For a Boston calibration study, start with [MBTA LAMP exports and their data
dictionary](https://github.com/mbta/lamp/blob/main/Data_Dictionary.md). They
describe trip/stop/date identifiers, observed movement and stop timestamps,
travel times, and matched scheduled clocks. [TransitMatters Gobble](https://github.com/transitmatters/gobble)
also documents its collection of MBTA V3 streaming events. These are potential
inputs; the current engine does not download or fit them automatically.

A proposed next stage is to retain historical forecast snapshots and outcomes,
match the exact feed revision and trip instance, and estimate errors by route,
direction, time of day, and forecast lead time. Validate on later service dates
with missing-data and coverage reporting. Keep same-vehicle and shared-corridor
delays correlated; multiplying marginal transfer probabilities is not a
justified journey probability. Evaluate missed connections and recovery choices
as well as final arrival. Probability-driven routing requires a separate search
and calibration contract, rather than interpreting the current deterministic
optimum as the most reliable path.

### Reproduce the implemented contract

Run `node test/check-arrive-by-boundary.mjs` after building the native kernel and
`npm run check:standalone` after building the Node CLI. Public fixtures cover a
changed selected departure, exact reserve boundary, blocked outcomes, unchanged
earliest departure, transfer-reserve combinations, matrices, invalid values,
and repeated requests through both interfaces. These checks establish modeled
feasibility, not measured on-time performance.

## Published fares on itineraries

Route and Ask show boarding prices from the imported GTFS feed. Expand the fare line to see ticket names, payment methods and the agency's fare link. JSON routing results carry the same information in `plan.legs[].fare`.

These are prices for a **new boarding**, not an optimized journey fare. Multi-leg results deliberately have no total: joining legs, transfer discounts, passes and existing tickets can change what a rider pays. A missing quote does not mean free travel. Path selection continues to use the existing routing engine and does not consider price.

### Data and matching

The importer retains fare tables and their route, station, agency and calendar references in an optional `fare_catalogs` SQLite table. Catalogs travel with a City and stay separate when feeds are merged, including feeds that reuse the same route IDs. Existing Cities built before this addition need their original GTFS reimported to retain fare data.

- **Fares v2 takes precedence** when `fare_products.txt` is present. Matching uses route networks, station areas, rule priorities, fare timeframes and the default rider category. Product names and media come from the feed. MBTA's `transfer_only` extension is honored so a free-transfer product never becomes a free new boarding.
- **Fares v1** supports flat, route and origin/destination-zone boarding prices. Zone-traversal (`contains_id`) rules are left unquoted.
- Fare timeframes use the civil date and time at the validation stop, including its timezone, daylight-saving changes, times beyond midnight, and calendar exceptions. The conversion starts from GTFS's local-noon-minus-twelve-hours service clock. For a realtime-adjusted leg, the original scheduled stop sequence must be uniquely recoverable before applying timed rules.
- Explicit platform fare areas override inherited station areas. Ambiguous network assignments, conflicting products, missing references and unsupported conditions are left unquoted. An unreadable optional fare catalog never discards an already-computed route.
- The fare layer does not implement transfer totals, effective joined fare legs, pass selection, non-default rider eligibility or fare-based route optimization. Separate boarding options remain visible even when those products would change the journey total.

The matching rules follow the [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/#fare_leg_rulestxt). No agency prices or route-name lookup rules are embedded in code. Prices reflect the saved feed, rather than a separate live fare service.

### Verification

`node test/check-gtfs-fares.mjs` covers exact matching, missing data, published zero fares, invalid prices, transfer-only products, default rider categories, area inheritance, empty-rule semantics, priority rules, after-midnight date changes, time-window boundaries, scoped multi-feed import and merge, and non-mutating itinerary annotation. Existing import safety, ordered routing and Ask journey checks remain applicable.

### Performance

Fare lookup happens only after route selection. No fare code runs in the routing search, matrix or accessibility calculations. Catalogs are loaded by feed scope, then indexed once. Products, calendars and currency formatters are reused. Quote, candidate, catalog and scheduled-trip caches have explicit entry or memory bounds and are released with their database/catalog. Replacing a catalog invalidates its caches.

Fare annotations with cached catalogs and trip sequences perform no SQL. A live-adjusted ride reads the timetable only if its matching fare depends on time; alternative plans reuse that trip's scheduled sequence. Loop matching takes linear time and rejects ambiguous sequences. The UI mounts ticket details only when expanded and imports only the small currency-formatting module.

This does **not** mean zero end-to-end cost: first-use catalog parsing/indexing, response serialization and rendering still take time. Measure separately from routing:

```sh
node scripts/benchmark-fares.mjs FEED.zip STORE.sqlite YYYY-MM-DD report.json
```

Use the original, unscoped SQLite store for the supplied feed. The script reports cold, first-pass and warm fare lookup times over representative trip spans; it neither runs a routing benchmark nor proves that the selected trips are active on that date. SQL-count assertions in the fare test protect the warm path independently of machine-speed fluctuations.

## Known limits

VIGO models the City revision and Query it is given. It does not certify real-world service, demand, safety, or operational feasibility.

### GTFS

- Support is limited to the source features listed in the [GTFS support page](developer.md#gtfs-support-matrix).
- Missing published shapes do not prevent timetable Route but limit map geometry.
- Block-based in-seat continuation is not inferred.
- Unsupported or malformed source features are reported during Build.

### Transit Route and Matrix

- Transit Matrix supports depart-at and arrive-by. Arrive-by duration includes any wait between actual arrival and the deadline; use Route for itinerary legs and actual arrival.
- Arrive-by is available for point-to-point transit Route.
- [Explicit transfer and arrival reserves](#travel-time-uncertainty) can change route selection, but VIGO does not yet compute calibrated arrival probabilities or delay distributions. Realtime uncertainty fields do not supply such a model.
- `maxTransfers` accepts integers 0–31; omit it for no additional cap. Combining a finite cap with ordered transit waypoints is currently unsupported.
- Station returns may be valid in the supplied timetable. They are flagged for inspection, not automatically excluded.
- Without an explicit rule or declared pathway topology, service platforms sharing a parent station use a transfer assumption of at least 120 seconds, floored by their coordinate distance at the walking speed. These legs report `transferSource: 'parent_station_fallback'` and schematic geometry, not a verified station pathway. Only generated OSM transfers claim a corresponding street-path witness.
- A street route to a platform coordinate does not establish an entrance/platform connection. Selected walks touching subway stops or station platforms report `stationAccessStatus: 'unverified'` unless they carry a declared pathway with no estimated-cost segments; `streetPathVerified` is false for these walks, while `streetSegmentVerified` preserves the narrower OSM result. `source_path` means a declared station path, not field-verified traversal. Exact platform endpoints need no entrance walk. Stations with declared pathways and entrances use those entrances for street access and transfers. Missing interior paths remain a routing-model limitation; Untimed stairs with a stair count and fare/exit gates use explicit routing estimates (one second per step and five seconds per gate), marked `gtfs_pathway_estimated`; these are not observed traversal times. Route diagnostics and the displayed detail expose this limitation. Scalar Matrix results do not provide this per-leg audit.
- Departure windows sample integral minutes; they are not continuous profiles.
- Coordinate transit depends on the supplied OSM walking network and configured walking limit.

### Streets

- Walk and Drive depend on OSM coverage and directionality.
- Pedestrian coordinate attachment searches vertices within 160 m and projects
  onto reciprocal edges within 80 m, including long segments whose endpoints
  lie outside the vertex search. A missing attachment is not proof that no
  physical pedestrian path exists.
- Platform polygons describe an area, not a walking centre line. Street-store
  schema v6 excludes their outlines from the linear walking graph; mapped
  footways and GTFS station pathways provide access. Routing freely across
  polygon interiors is not modeled. Older Cities require a source rebuild.
- Stops keep one physical street attachment. An anonymous endpoint on an
  unanchored fragment can recover to the nearest transit-connected component
  within 80 m, including the full connector cost. This does not add graph links
  or prove access through intervening buildings, fences, water, or different
  levels. Mapped restricted endpoint paths retain their directed permissions.
  See [coordinate attachment](#coordinate-network-attachment).

- Authorized private endpoint access is an opt-in City build model; see [Street routing](#street-routing). It does not establish individual permissions, gate hours, or missing connections.
- Drive does not yet model all turn restrictions, signals, or intersection delay.
- Traffic must be supplied by the caller; VIGO does not fetch a provider.

### Realtime

- Realtime transit Route is available in the desktop and CLI. CLI Route requires a supplied `realtimeSnapshot` and explicit realtime selection, such as `--data-mode realtime`; it does not fetch feeds. Transit Matrix and Reach reject realtime requests. Drive Matrix separately accepts supplied traffic in realtime mode. Vehicle Positions and Alerts do not change route costs or close services.
- Only FULL_DATASET feeds are decoded. Routing updates modify matched scheduled trips, remove CANCELED/DELETED trips, and omit SKIPPED calls. Added, duplicated, replacement, and unscheduled trips without a supported scheduled instance remain unsupported for routing. Studio can still [display reported added service](#added-service) in line views and the trip selector.
- Feed and record timestamps must pass freshness checks. Engine admission accepts observations up to 180 seconds old and 60 seconds ahead of its captured clock; the Network workspace may apply its own admission policy. Missing timestamps do not establish freshness. Inspect diagnostics for exclusions and scheduled fallback.
- The complete admitted snapshot is processed without the former endpoint-based pruning. Oversized input is rejected by explicit resource limits, not silently truncated. Unreported trips retain scheduled times; rejected updates do not establish coverage or actual operations. See [realtime routing](#realtime-journey-routing) for admission rules, diagnostics and verification.

### City reuse and platforms

- Studio maps require WebGL 2. Engine and Python queries do not require a graphics device.
- Supported native targets are macOS 13.5+ on Apple Silicon/Intel, Linux glibc on ARM64/x64, and Windows x64. Linux release builds use Ubuntu 24.04. The Node native packages require glibc on Linux; the [standalone Rust container](guides/rust-standalone.md#container) uses musl. Neither distribution provides 32-bit or native Windows ARM64 binaries.
- Copy the entire City directory; street indexes and prepared files are part of it. The native runtime executable is specific to OS/CPU, while City data is portable across the supported 64-bit targets.
- Older Cities with ephemeral Drive CCH still rebuild that hierarchy on fresh-process startup; rebuilding the City from source enables persisted Drive CCH.
- An incompatible timetable cache requires preparation. New active-service patterns, changed walking policy, or evicted snapshots also require preparation. Missing/corrupt required street indexes are errors, not permission to query a different graph; restore the complete City or rebuild it from source.
- Studio project-library settings, drafts, and live connections are local application state and do not travel inside a CLI City. Studio cannot directly open CLI City directories in this release.

### Scenario

- Planned transit service changes are supported for Reach in VIGO 0.5.0.
- Supplied traffic is supported for Drive Route and Drive Matrix.
- Other combinations are rejected. The capability catalog describes their availability; the CLI exits nonzero for unsupported requests.

### Reach

`maxTransfers` limits changes between transit vehicles in both the baseline and scenario searches. Zero permits one ride; omitting the field adds no transfer cap. Walking does not count as a boarding.

After the last ride, Reach follows the same declared station exits used for coordinate egress. Pathway time counts toward elapsed travel time, and pathway distance counts toward the final walking allowance. A stop reached only by a transfer walk does not restart that allowance. Native Reach rasterizes reached street edges; Matrix evaluates destination coordinates, so their cells can differ even under matching routing settings. Standalone `includeNodes` retains at most 30,000 reached nodes and reports `nodeEvidenceTruncated` when this diagnostic sample is truncated; it does not limit the searched surface.

Reach measures modeled travel time, not people, jobs, demand, welfare, observed behavior, or operational feasibility. Add opportunity data and a stated measure before describing an analysis as Accessibility.

## VIGO Studio desktop guide

VIGO Studio provides Network, Route, Analyze and City views over the VIGO routing engine. See the [Network guide](#network-routes-and-ask) for Network, Routes and Ask.

See the [visual tour](history.md#studio-in-use) for real application captures and [multiple-feed setup](#combine-timetables-and-live-feeds) for combined timetables and live endpoints.

### Open a City

Select a project from the Studio library and import GTFS and OSM. Rebuild when the source feed or street extract changes. Studio currently stores its projects in a library format; it cannot directly open the movable City directories built by the CLI.

Opening a City prepares walking for transit access and walking routes. The driving network opens when you select Drive or run a driving operation. Background tasks shows preparation progress.

### Network

Use **Network** for reporting coverage and briefings, **Routes** for trip times, station boards and line views, and **Ask** for evidence-backed questions. Route and station selection is shared across the tabs. The [Network guide](#network-routes-and-ask) explains playback, live timing, added service, and model connections.

### Route

#### Plan

Pick an origin and destination on the map. **Add point** inserts a via point before the destination; a route supports up to eight points total. Each row shows latitude and longitude. Click the row to repick its location, use the arrows to reorder it, or remove it. **Reverse** reverses the complete sequence. You can also enter a coordinate command in Search VIGO, such as `route 38.90, -77.05 to 38.91, -77.03 at 08:00`, then choose **Plan this journey**. An explicit transit time selects Scheduled mode. Use points and a date covered by your City. The route form does not search place or station names.

Choose a travel mode. Realtime transit departs now; Scheduled exposes the service date, time, and depart-at or arrive-by controls. Transfer caps are disabled while via points are present. Point and option changes update the route; **Rerun route** submits the same coordinates again, and **New route** clears them. Coordinate access and egress follow the OSM street graph. Inspect every returned leg before using its geometry.

Use **Earliest**, **Fewer transfers**, or **Less walking** to sort the returned journeys. Each card shows arrival, total time from your requested departure, transfers, walking, and its tradeoff against the earliest arrival. Sorting keeps the selected journey and does not rerun the search. Arrow keys, Home, and End select another journey; **Details** opens its itinerary.

#### Recent

Reopen recent Route Results for the current City revision. A Result keeps its normalized request, status, warnings, and timing beside the journey.

### Analyze

#### Reach

Choose an origin on the map or use **Choose origin** to search imported stops by name/ID or enter coordinates. Run Reach, then switch between **Reachable area**, **Reached streets**, and time cutoffs. Displayed cutoffs reuse the retained result. See [Reach](#reach-and-isochrones) for query limits and surface bounds. Reach measures modeled travel time; it does not add jobs, population, or other opportunities.

#### Compare

Studio's feed comparison runs a Reach Query for each selected GTFS feed and displays the resulting surfaces. To compare completed Results without rerunning their Queries, use `vigo compare`.

Scenario drafts and the selected case are saved in Studio's local profile when edited, and restored when reopening the same project and source revision. They do not travel with a City directory. Reimporting GTFS or rebuilding the project or street store starts a separate draft set. If local storage is unavailable, Studio shows a save error; keep the window open until saving succeeds.

For a stop inserted on an A → B edge shared by several branches, the road path is applied to each affected branch. Each branch retains its untouched published shape and its own A → B runtime, with dwell added at the inserted stop. Load complete branch shapes before building the path.

Use the CLI or Python API for Matrix queries.

### City

#### Data sources

Open **City → Data sources** to review GTFS feeds, OSM coverage, counts, and warnings.

To remove one source, select the trash button beside its row, check the source name, and confirm **Delete source**. You can import it again later.

- **GTFS:** removes that feed's timetable and refreshes the combined timetable from the remaining feeds. Deleting the last feed leaves the City available for a new import.
- **OSM:** removes street routing and the walking transfers derived from OSM. GTFS timetables remain, but queries that need the street network require another OSM import.

The City, other sources, saved notebooks, and your original input files are retained. Deletion is unavailable during import or preparation. If Studio reports that a source is busy, let the active work finish and retry.

#### Preferences

Choose appearance, storage location, and map preferences. Runtime detail appears only when it helps diagnose a problem.

**Local OSM** is the default for new settings. It draws main roads, rivers, lakes, and coastal water from the City's imported PBF in light or dark appearance, with no tile service, API key, or network connection. Residential streets, service lanes, paths, buildings, and labels are omitted to keep routes and analysis clear. Your saved basemap preference is retained.

Cities imported before the local map index was introduced need one fresh OSM import. The map reports this when the geometry is missing. Coastlines must be complete within the visible area to fill the sea correctly; an incomplete shoreline remains a line. Water outside the imported coverage is unavailable. Online OpenStreetMap and CARTO styles remain optional.

### Troubleshooting

#### Playback shows no trips

Check the exact service date, `calendar.txt`, `calendar_dates.txt`, the selected direction and pattern, and whether the playback time falls between a trip's first departure and last arrival.

A route-wide total is not the number of vehicles active at one time. If Studio has not loaded trip-level detail, it reports that the detail is unavailable instead of claiming that no trip exists.

#### An access path crosses a block

The visible access or egress line must come from OSM street geometry. Rebuild the City from current OSM data, confirm the point lies within coverage, and inspect the selected street leg. Studio does not replace a missing street path with a straight jump.

#### A date is rejected

Use an exact `YYYY-MM-DD` date inside the feed's active service range. Studio applies the same calendar rules as the CLI.

#### A Result differs after rebuilding

Confirm the City revision and source data shown with each Result. A new feed or OSM extract creates a new City revision.

## Network, Routes, and Ask

Open **Network** in VIGO Studio to inspect the selected City's timetable, live reports, and saved investigations. The workspace has **Network**, **Routes**, and **Ask** tabs. Use the separate **Route** view for journey planning and **Analyze** for Reach; Matrix is available through the CLI and Python.

### Read the evidence

The same map can show several kinds of evidence. Read the source and observation time before interpreting a change.

| What you see | What it represents | How to use it |
| --- | --- | --- |
| Scheduled time | An indexed GTFS arrival or departure on the selected service date | Establish the published plan; check the date and pattern. |
| Predicted time | A matched, admitted TripUpdate for that trip and stop | Compare the corresponding arrival or departure with its schedule. |
| Vehicle position | A reported location and stop status at its own observation time | Locate the reported vehicle; check its age separately from the prediction. |
| **Estimated** playback | A position interpolated along the scheduled trip | Explore the timetable and geometry. |
| Network assessment | Computed conditions among reporting service during its stated window | Read coverage alongside delay and spacing. |
| Model explanation | An interpretation of the supplied evidence | Inspect sources, uncertainty, and the proposed next check. |

None of these supplies a verified history of actual stop arrivals. A missing prediction remains unknown. A vehicle marker or an added trip in **Trip times** also does not establish that Route can use that trip; routing has its own [admission rules](#realtime-journey-routing).

### Investigate a condition

1. **Start with coverage.** Check the assessment time, service window, and reporting coverage in **Network**. Coverage weights the scheduled vehicle-minutes with usable predictions or cancellation reports; it is not the percentage of passengers covered or service running on time.
2. **Follow the route.** Open **Routes**, select the route, and inspect **Trip times** on the relevant service date. Use **Stops** to confirm direction and pattern, then **Updates** to inspect the service evidence.
3. **Inspect the same event.** Open the station board or select a vehicle in **Line view**. Compare arrival with arrival or departure with departure at the same stop. Keep the vehicle observation time and prediction time visible.
4. **Ask within that scope.** Ask for the selected route or station, the time window, and the comparison you need. Open the answer's activity and sources to check which tools ran and which observations support it.
5. **Keep the observation attached.** Reopen the answer through **History** when reviewing the finding later. Its original selection and evidence remain attached; a fresh answer may describe a different feed state.

For a journey, use **Route** and read its [Result and diagnostics](reference/results.md). For an empty board, unresolved vehicle, or missing live timing, use [Troubleshooting](#troubleshooting-1). The [service assessment method](developer.md#network-service-assessment) defines the reporting denominator and spacing comparisons in detail.

### See what needs attention

Open **Network** for reporting coverage, route comparisons and the network briefing. A scheduled departure, a feed prediction and an observed vehicle location are different evidence. Missing reports remain unknown. Overnight service is assessed against the timetable's active service window, not daytime expectations.

With a connected model, the briefing can interpret the pattern, propose an explanation and suggest a next check. Hypotheses are not confirmed incidents. The briefing checks extracted route-condition claims against computed evidence and performs a model review, but neither guarantees that all prose is correct. A computed fallback is labeled separately. The timestamp and coverage tell you which observation the briefing describes; the refresh setting is separate from feed polling.

### Inspect a route or station

Open **Routes** and choose a route to see **Trip times**. Select a trip and service date to compare its scheduled and predicted arrivals or departures. **Stops** opens directions and patterns; **Updates** opens service evidence. The map and **Line view** show the same selected route. Select a stop to see its arrivals board. **All routes** returns to the catalog. Actual stop-event times are unavailable in the current prediction source.

The route and station selection are shared with Ask. **Network map** clears both; a station board includes its platforms, while a platform selection keeps its own scope. “Here” can refer to that station; a named route or vehicle keeps its own identity. Selecting a route does not select a particular bus. Saved answers retain the selection and evidence from the original question.

### Patterns and scheduled playback

Choose a route's **Stops** view to inspect directions, patterns, ordered stops, service span, and published geometry. The direction chooser labels patterns by their first and last stops; **Full service** restores all patterns. Direction IDs `0` and `1` are feed labels, not compass directions. Repeated visits remain separate. Technical IDs appear under **Source data**.

Feed totals cover the imported calendars. After trip details load, counts and timetable bands use the selected service date. Times such as `25:10` remain on that GTFS service day; empty dates have no service band.

Scheduled playback is labeled **Estimated**. Vehicles dwell at stops and follow their pattern's shape between timed calls. Missing or inconsistent geometry is omitted and reported in diagnostics. The index does not retain `shape_dist_traveled` or every untimed call, so interpolated positions are not exact locations. A timetable band spans the first departure through the last arrival, including gaps in service.

Live positions remain separate from playback. Route-colored vehicle circles show a bearing arrow when available. Map layers do not change query semantics. Vehicle Positions and Alerts are display evidence; only supported Trip Updates can change [realtime Route](#realtime-journey-routing).

### Vehicle timing and line view

In VIGO Studio, open **Network → Routes**, select a route, and choose **Line view**. The two tracks show each direction's stops and reported vehicles. Select a vehicle on the map or line to compare scheduled and predicted arrival and departure at its reported stop. Branch selectors retain the actual trip patterns.

Vehicle timing comes from the City's full connection store. The selected vehicle card stays open when its route loads, while the vehicle remains in scope.

If the reported stop has no usable timing, its prediction remains unavailable. **Next prediction** names a later stop with a usable prediction; it does not substitute that time for the vehicle's reported stop.

#### Added service

Trips declared by GTFS-RT `ADDED` or `NEW` appear in the line view and **Trip times** selector even when absent from the static timetable. Their reported stop sequences supply line placement and timing, including vehicle-only trips with a known current stop. Partial sequences are labeled as reported stops. Scheduled times and delay comparisons remain unavailable.

Ambiguous identities, unknown stops, duplicate sequences, and stale predictions are not presented as current timings. Added-service display does not imply that the trip is available to journey routing; see [realtime limits](#realtime).

#### Data and matching

The map and line views use the same per-City timetable, realtime snapshot, identity resolution, service dates, and freshness policy, without a model call. Pattern metadata is cached; vehicle timing refreshes from the current snapshot. The browser requests only the selected route or vehicle every ten seconds, without overlapping requests.

- Stop placement follows VehiclePosition's stop ID, sequence and status. It does not use the first TripUpdate stop, road snapping, or interpolated vehicle movement. Missing or conflicting identities remain unplaced.
- Arrival comes from the incoming connection; departure comes from the outgoing connection. Predictions use the matching stop's corresponding arrival or departure event. Delay is the difference between those same-stop timestamps.
- The connection store retains terminal arrival, but not terminal departure or its original sequence. A unique terminal ID can resolve an arrival; an unknown terminal sequence cannot disambiguate a repeated stop. Frequency instances without retained start-time identity remain unresolved.
- Opposite directions share a central station list only when their station sequences are exact reverses. Stations use explicit GTFS parent relationships. Bus stops on opposite sides of a street are not paired by proximity or similar names.
- Branches and repeated stops remain distinct. Skipped stops, missing predictions, duplicate reports and stale observations do not become valid current timing. A reported stop without a sequence is shown as a reported stop, without inferring arrival status.

Spacing is schematic: it represents stop order, not distance, elapsed time or headway. Current times are feed predictions, not verified actual arrivals. Vehicle and prediction observation times are shown separately in the agency timezone. This is a live line diagram, not a historical time-distance chart.

The **↔** warning marks both matched vehicles in a compressed departure pair. The comparison uses their predictions at the same stop against their scheduled interval, including when predicted trip order reverses. The vehicle card names the pair and reference stop. Wider-gap warnings require consecutive predictions in scheduled order; missing intermediate reports remain unknown.

#### Verification

The City X fixture in `test/check-agency-route-line.mjs` covers both directions, branches, repeated and terminal stops, conflicting sequences, independent arrival/departure times, stale and future positions, skipped/no-data predictions, and duplicate identities. `test/check-added-service-display.mjs` covers added trips absent from the static timetable. Both run with `npm run check:agency`; they verify fixture behavior, not field prediction accuracy.

#### References

The interaction references were [TransitMatters Train Tracker](https://traintracker.transitmatters.org/), its [public source repository](https://github.com/transitmatters/new-train-tracker), and [Swiftly's Live Operations overview](https://swiftly.zendesk.com/hc/en-us/articles/360043691571-Live-Operations-Overview). Their stop-oriented presentations informed the compact two-direction view; no implementation or assets were copied. Matching follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/), especially VehiclePosition status and StopTimeUpdate semantics.

### Ask a complete question

Use a location, route or vehicle number when it matters. For example:

- “What needs attention across the network?”
- “Compare these two routes' gaps and reporting coverage.”
- “How has vehicle [number]'s predicted delay changed?”
- “When is the next departure from [station], for each route?”
- “Draft an apologetic rider update using the confirmed facts.”

Ask chooses reusable checks, can correct scope or request a missing check, and keeps the evidence with the answer. Its assessment forms preserve computed values. Network interpretation and general replies use the model. Activity and sources are inspectable; private model reasoning is not displayed. **History** reopens saved conversations. **Clear Ask history** deletes this City’s Ask conversations and attached notes after confirmation, and resets the active conversation. Briefings, research, feed observations, and settings are retained. Clearing history requires configuration permission; answers already running cannot recreate the deleted records. An old answer remains an old observation even when the feeds have advanced.

### Connect a model and web search

In Ask's connection settings, choose a provider, enter its API base URL, choose or discover a model, and connect. The connection test checks function calling, not answer quality. Local models can use a keyless endpoint if their server permits it. API keys stay in server memory for the app session.

Web search is configured separately. Connecting an LLM does not grant online search. Network-capable tools may contact their configured services, and model requests include the question, supplied conversation context and selected tool results. Consult the answer's **Model & data** record for captured endpoint and tool activity. A localhost URL does not prove inference hosting, retention or downstream forwarding.

### What this app does not establish

Predicted spacing is not measured headway; retained forecast changes are not actual vehicle progression. Reporting coverage is not service health. Ask has no connected crew roster, maintenance clearance, passenger-demand model or live intervention simulator. It can discuss conditional options and draft rider text; it does not authorize dispatch or publish messages.

The [operations ledger](developer.md#agency-operations-prototype) and [synthetic replay](developer.md#one-bus-one-control-point) are research APIs, not hidden everyday workspace panels.

## Command line

The Node CLI builds Cities and runs Route, Matrix, Reach, and Compare through VIGO's shared native routing kernel. The Rust executable has its own command options; use the [standalone reference](standalone.html#cli) for that interface.

### Commands

| Command | Input | Output |
| --- | --- | --- |
| `build` | GTFS, OSM, output directory | A complete prepared City |
| `build-scenarios` | Baseline inputs and a scenario definition | A prepared collection of Cities |
| `capabilities` | None | Versions and advertised features |
| `inspect` | City directory | Identity, sources, counts, and limitations |
| `route` | City, JSON request, date | A public journey response |
| `matrix` | City, JSON request, date | An origin-by-destination travel-time array |
| `reach` | City, JSON request, date | Reachable areas and optional analytical output |
| `stream` | City and NDJSON on stdin | One response per query in a resident process |
| `compare` | Two saved Results | Changes without rerunning routing |

Run `vigo help route` or `vigo route -h` for options. `vigo --version` prints the product version. Both `--name value` and `--name=value` work. Unknown options, extra positional arguments, and repeated single-value options are rejected. `--gtfs` and `--gtfs-scope` may repeat.

### Send a request

```sh
vigo route --city ./boston --request route.json \
  --time 08:00 --service-date 2026-10-05 --output route-result.json
```

Choose a service date covered by the City. [Build your first City](#vigo-cli-quickstart) provides the complete Boston request and data preparation steps.

Route, Matrix, and Reach also accept one JSON object from stdin:

```sh
cat route.json | vigo route --city ./boston --request - \
  --time 08:00 --service-date 2026-10-05 > route-result.json
```

Request files and stdin share a 16 MiB limit. `--request -` reads until the producer closes stdin. Progress and errors use stderr; JSON uses stdout. Omit `--output` or use `--output -` for a pipeline. Saved output is staged and renamed after a complete write; a failed operation can leave an earlier output file in place, so inspect the exit code.

CSV Route batches use `--input` and an output file, support transit only, and cannot be combined with `--request`. Their row format is separate from public JSON. Use JSON requests for Walk and Drive.

### Keep the engine resident

Save one query per line in `queries.ndjson`. Every line has an explicit `kind`:

```jsonl
{"id":"outbound","kind":"route","origin":"A","destination":"B","time":"08:00"}
{"id":"times","kind":"matrix","origins":[{"id":"a","point":"A"}],"destinations":[{"id":"b","point":"B"}],"time":"08:00"}
```

`A` and `B` must be exact stop IDs in your City. Run:

```sh
vigo stream --city ./city --service-date 2026-10-05 < queries.ndjson > results.ndjson
```

The process retains prepared network state. Responses echo `id` and add `sequence`. Inspect every response: a per-query error does not terminate the stream. First-use preparation, subsequent queries, and serialization are different timing boundaries.

### Read a response

Public responses identify `schema`, `status`, and query metadata. A successful Route uses `journey`; Matrix uses `durationsSeconds`; Reach uses `surface.valuesSeconds` or map-only `areas`. Durations are seconds. No journey is `not_found`, and unreachable analytical cells are `null`.

`diagnostics: "trace"` adds the internal evidence under `trace`. Raw `result`, `rows`, and minute-valued fields belong there. Applications should use the [public result reference](reference/results.md).

An invalid one-shot request or failed operation exits nonzero. Streaming errors have `schema: "vigo.error.v1"`, `status: "error"`, and `error.code` / `error.message`. Distinguish invalid input and execution failures from valid no-journey outcomes.

### Python and services

[VIGO Python](https://github.com/hytangs/vigo-py/tree/main/docs) runs the same resident query protocol and exposes its own detailed Result properties. It requires Engine 0.5.0's current API; it is not a direct Python/Rust binding.

Use [Engine deployment](#deploy-the-routing-engine) for the Node service or the [Rust HTTP manual](standalone.html#http-api) for a standalone deployment. Studio's internal application API is not a public integration boundary.

## Deploy the routing engine

Use the native `vigo` executable for HTTP, resident streaming, and command-line queries. It opens a prepared City or scenario collection without Node, Python, Studio, or an internet connection. Prepare data separately with the [Node CLI](guides/cli-only.md), then mount the complete output directory read-only.

### Build and check the image

From the repository root with Docker installed:

```sh
docker build -f deploy/Dockerfile -t vigo:0.5.0 .
```

The image contains the Rust executable, embedded API documentation, license notices, and a Debian glibc runtime. It runs as UID/GID 65532. The compiler version matches `rust-toolchain.toml`; City data, JavaScript dependencies, desktop bundles, and local build caches are excluded from the build context.

Run the container checks before using the image:

```sh
npm ci
npm run build:cli-runtime
npm run check:deployment -- --image vigo:0.5.0
```

These checks build public synthetic inputs and exercise the actual Compose service: a read-only City, authentication, Route, Matrix, Reach, scenario switching, readiness, and restart. They also check resource limits and confirm that queries do not change City files. CI runs them on Linux x64 and ARM64. Measure your own City and request mix before choosing production limits; the small fixture does not establish a metropolitan memory or latency result.

### Start the service

Make the City directory and its files readable by UID 65532. Keep every referenced directory inside the mounted City or scenario collection; mounting a collection preserves its shared street data.

```sh
export VIGO_IMAGE=vigo:0.5.0
export VIGO_CITY=/absolute/path/to/prepared-city
# Set VIGO_API_TOKEN through your shell or deployment secret store (16+ characters).
docker compose -f deploy/compose.yml up -d --wait
```

The service binds to `127.0.0.1:8080` on the host. Put an HTTPS reverse proxy in front of it for remote clients. Query endpoints require `Authorization: Bearer ...`; readiness and static documentation are public.

```sh
curl --fail-with-body http://127.0.0.1:8080/readyz
curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H "Authorization: Bearer $VIGO_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @route.json
docker compose -f deploy/compose.yml logs --tail 50
```

Use the [HTTP request reference](standalone.html#http-api) for Route, Matrix, Reach, and Compare. `GET /v1/info` reports network, query-workspace, cache, and scenario-residency accounting. For scheduled comparisons, pass `scenarioId` with each query. A [scenario collection](guides/rust-standalone.md#shared-scenario-collections) stores shared regional data once and keeps only a bounded number of scenario views resident.

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
| `VIGO_REQUEST_TIMEOUT_MS` | `10000` | Request/response I/O timeout |
| `VIGO_QUERY_TIMEOUT_MS` | `30000` | Queue and execution deadline |

The native worker reuses its network and workspaces. It prioritizes short queries while giving queued analytical work a bounded turn. A deadline or cancellation terminates running native work and reloads the worker; readiness remains unavailable during recovery. A full queue returns an error instead of accepting unbounded work. Responses are limited to 64 MiB; split large matrices or omit geometry when appropriate.

`GET /healthz` checks the HTTP process. `GET /readyz` checks worker availability. The container runs `vigo health` against `/readyz`; this probe loads no City and needs no shell, curl, or Node process. A Docker health status reports readiness; the restart policy restarts exited containers, not merely unhealthy ones.

### Upgrade and operate

Prepare a new City in a separate directory, verify saved requests against the candidate image, and switch the image and City together. Do not replace files that a running service has mapped. Retain the previous accepted image and City when rollback is needed. See [upgrade and rollback](#upgrade-and-rollback).

Use [service benchmarking](developer.md#reproduce-a-service-workload) to record cold startup, first-query and sustained latency, memory, and disk costs. Run the same workload after a change, including concurrent queries and scenario switches. Stop this service with `docker compose -f deploy/compose.yml down`; its prepared City remains on the host.

The standalone archive is also usable without Docker. Run `vigo serve --city ./city --host 127.0.0.1 --port 8080`, and check it with `vigo health --port 8080`. The [native runtime guide](guides/rust-standalone.md) includes process-manager configuration and CLI examples.

## Upgrade and rollback

Keep the running application and its prepared City together until the replacement passes your saved requests. A new application version does not imply that an older prepared City is compatible.

### Before changing versions

1. Save the runtime version, package checksum, `capabilities` output, and City inspection output. The Node CLI uses `inspect --city ./city`; the Rust runtime uses `info --city ./city`.
2. Retain the original GTFS and OSM inputs, their checksums, preparation options, and any scenario definitions. Prepared data is not a substitute for those sources.
3. Keep representative Route, Matrix, and Reach requests and their expected results. Include your transfer, walking, and arrive-by constraints.

### Prepared City policy

VIGO 0.5.0 accepts only the prepared artifact formats advertised or admitted by its runtime. The outer `vigo.city.v1` manifest is not sufficient: timetable, transfer, street, access, and accelerator formats are checked separately. Older incompatible artifacts are rejected. Editing a format marker cannot migrate their contents.

There is no backward-compatibility or in-place conversion requirement for pre-0.5.0 Cities. Rebuild from the original sources into a **different output directory**:

```sh
node vigo.mjs build --gtfs feed.zip --osm region.osm.pbf --output ./city-next
node vigo.mjs inspect --city ./city-next
node vigo.mjs route --city ./city-next --request route.json --service-date 2026-07-15
```

Use a service date covered by your feed. The Rust query runtime consumes prepared Cities; raw-data preparation is a separate CLI step. See [multiple feeds](#combine-timetables-and-live-feeds) for scoped sources and [standalone operation](guides/rust-standalone.md) for scenario collections.

Optional query caches may be regenerated from an admitted City. Incompatible source artifacts require a rebuild. Query execution does not silently convert an old City. Treat published City files as immutable while a service has them open.

### Validate, switch, and recover

Run the saved requests against the candidate through the interface your application actually uses. Check result schemas, no-journey outcomes, walking geometry, arrival/departure times, boardings, and resource use. Test a cold start and repeated requests as well as a single successful query.

Start a second local service with `city-next`, check readiness, and replay the requests before switching the application endpoint. Preserve the previous binary and City until acceptance is complete. Roll back by restoring both together. Do not overwrite a live mmap-backed City.

`build --replace` validates staging before replacing the destination and restores the previous directory if publication fails. A successful replacement removes its temporary backup; it is not a retained rollback copy. Use a separate output directory when rollback matters.

### Checks available without the maintainer

Use the [service benchmark](developer.md#reproduce-a-service-workload) to retain comparable latency and storage measurements for your own workload.

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

These use public synthetic inputs. They cover independent objective verification, difficult routing cases, public schemas, City relocation, and operation from the extracted package. They do not require private benchmark files or a running maintainer service. Platform CI runs the broader release checks; a local pass does not establish that unrun platforms passed.

For an operational issue, retain the request, schema and engine versions, City/source checksums, logs, and the smallest shareable input that reproduces it. [Troubleshooting](#troubleshooting-1) explains the diagnostics. See [public results](reference/results.md) for the API stability policy.

## Troubleshooting

For a version change, follow the [upgrade and rollback procedure](#upgrade-and-rollback) before replacing a working City.

Identify which stage failed: installation, City build/open, request validation, computation, or interpretation. Preserve the failing command and its output before changing inputs.

### Check the runtime and City

```bash
vigo --version
vigo capabilities
vigo inspect --city ./boston
vigo help route
```

`capabilities` describes the running binary, while `inspect` identifies the compiled City. Neither command proves that a given date has service or that a route is reachable. Source checkout changes take effect only after rebuilding the CLI. If `vigo` is unavailable after a source build, run `node public/vigo.mjs` from that checkout, or complete the `npm link` step in the [quickstart](#vigo-cli-quickstart).

### Build or open fails

| Symptom | Check | Next step |
| --- | --- | --- |
| Node/runtime version error | Compare `node --version` with the declared package requirement | Install a supported runtime, then follow the source-build steps |
| Native build or load failure | OS/CPU, pinned Rust toolchain, and native linker | Build for the machine that will run VIGO; an executable from another target is not portable City data |
| Output City already exists | Whether this is a new source revision or an intentional replacement | Prefer a new output directory when retaining a baseline; use `--replace` only for an intended replacement |
| Missing or corrupt required street files | Whether the entire City was copied | Restore a complete City or rebuild from GTFS and OSM; do not copy individual databases into another City |
| First query is slower than later queries | Whether timetable/access preparation ran | Retain diagnostics and distinguish preparation from resident query time |
| CLI City is absent from Studio's library | Which interface created it | Studio imports its own projects; it does not open CLI City directories in this release |

Build uses staged publication; a failed build preserves the previous City. Preserve the original GTFS/OSM and build log if import fails. See [City reuse](#city-reuse-and-platforms) and [architecture](developer.md#build-and-open).

### A request is rejected

| Symptom | Check |
| --- | --- |
| Invalid or uncovered date | Use an exact local `YYYY-MM-DD`; inspect the source `calendar.txt` and `calendar_dates.txt` |
| Date/time in JSON has no effect | Public JSON commands take date and clock from `--service-date` and `--time`; flags also override supported JSON options |
| Point cannot be resolved | Use an exact source stop ID or a `[longitude, latitude]` coordinate; place names are not geocoded by the CLI |
| Transfer cap with transit waypoints | This combination is unsupported; omit the cap or change the experiment explicitly |
| Realtime or Scenario rejected by Matrix/Reach | Check the [support table](#choose-a-supported-combination); planned service applies to Reach, live transit to Route, supplied traffic to Drive Route/Matrix |
| Matrix request is too large | Both the 100,000-pair limit and the 16 MiB JSON limit apply |
| Piped request appears to wait | `--request -` waits for one complete object and the producer to close stdin |

Invalid requests exit `2` and explain the failure on stderr. If an old `--output` file already exists, a failed invocation can leave it unchanged; do not mistake that file for a fresh Result. See [CLI I/O](#send-a-request).

### Route returns no journey

A public Route returns `status: "not_found"` when no journey satisfies the request. Read `warnings` and `quality`. For a detailed one-shot Node Route diagnosis, request `diagnostics: "trace"` and inspect `trace.result.detail`, `trace.result.diagnostics.searchLimits`, and `trace.result.diagnostics.accessAvailability` when present.

1. Confirm the requested City revision, date, time, and mode. GTFS time `25:10` belongs to the previous calendar day's service date, not a new service-day request at `01:10`.
2. Check whether transit is required. Transit compares a feasible direct walk by default. `requireTransitRide: true` requires at least one boarding; use Walk mode to request only walking.
3. Check each endpoint's walking access. A nearby stop by straight-line distance may lack a verified street path. An `outside_selected_budget` diagnosis only proposes a wider access check, not a guaranteed complete journey.
4. Check the horizon, transfer cap, and timetable. For depart-at, the horizon bounds transit boarding and alighting; it is not a door-to-door duration cap.
5. If a changed constraint is justified, save it as a new request and compare the outcomes. Preserve the blocked Result as part of the analysis.

Do not silently raise walking limits, substitute service dates, or convert blocked durations to zero. [Route diagnostics](#result-1) explain the bounded failure categories.

### Live reports and routes disagree

| Observation | Interpretation |
| --- | --- |
| A vehicle is visible but its trip is unavailable to Route | Vehicle Positions do not create timetable service; added-service display and routing admission are separate |
| Realtime times equal the schedule | Unreported trips retain scheduled times; inspect admitted/excluded update counts and fallback |
| The same saved snapshot stops applying later | Freshness is checked against the captured current clock; a saved observation is not perpetually live |
| An alert describes disruption but the route is unchanged | Text alerts are display evidence and do not close services automatically |
| Playback appears to show a vehicle that is not reporting | Scheduled playback is labeled Estimated and interpolates the timetable |

Keep service date, source scope, trip identity, feed timestamp, and record timestamp together. Ambiguous matches remain unresolved. See [Network evidence](#network-routes-and-ask) and [realtime routing](#realtime-journey-routing).

### Results or comparisons look unexpected

Matrix's `ok` status can include unreachable cells, represented by `null`. Arrive-by Matrix duration includes destination waiting. Public Matrix comparison requires identical ordered endpoints; Reach comparison requires identical grids. Means exclude unreachable cells. The [Result guide](reference/results.md) explains the output fields.

### A loading indicator is not advancing

Background tasks show measured bytes or records for steps with a known total. The percentage belongs to that step, not the entire import. Native indexing and other work without a total use an indeterminate bar, elapsed time, and the age of the last progress update. A time estimate describes the current step and disappears when its rate is stale or previous runs vary too much. Local step history is bounded to 32 entries with eight samples each; it contains timings, not routing results.

If updates pause, use **Reconnect to task**. The task may still be running, so check its status before importing the same source again. Errors opening the City library or settings time out instead of leaving an indefinite loading screen. Confirm that the City folder is readable and writable and that macOS has granted the requested folder access.

For a path that appears to jump to a platform, inspect its station-path and coordinate-snap qualifications. A visible line is not sufficient evidence of a physical entrance connection. See [station and street limits](#known-limits).

### Report a reproducible issue

Include the VIGO version, OS/CPU, failing command, request, City inspection summary, stderr, and full Result if one was returned. State what you expected and whether it reproduces with the same inputs. Share a minimal redistributable fixture when possible. Review paths, coordinates, credentials, and source licensing before attaching files to a public issue; use the [security policy](../SECURITY.md) for a vulnerability.

Retain the complete original run locally. Instructions for preserving it are in [Read and retain a Result](reference/results.md#keep-a-reproducible-run).
