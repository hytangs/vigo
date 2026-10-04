# VIGO CLI quickstart

Start with **Boston and Cambridge**: download the MBTA timetable and OpenStreetMap streets, prepare them once, then route from **Harvard Square to South Station**. You will save Route, Matrix, and Reach results. A “City” means the compiled data folder, called `boston/` here.

This tutorial uses the **Node CLI**, including its raw-data compiler. For the single Rust executable, follow the [Rust Boston quickstart](rust-standalone.md#1-quickstart); it loads the same prepared Boston directory, with a different request/result interface.

For the desktop workflow, use the [Studio guide](studio.md). Studio imports data into its own project library; it does not open the CLI City directory created below.

## 1. Install

VIGO 0.4.3 requires Node.js 24.18 or newer and npm 11.6 or newer.
Source builds also require the pinned Rust toolchain. Supported targets are macOS Apple Silicon/Intel, Linux ARM64/x64 with glibc, and Windows x64. Use a native build for the target OS and CPU; City data moves between them. See the [platform and City limits](../reference/known-routing-limitations.md).

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

The alias keeps the source checkout path when you change directories. If you have an extracted [CLI-only archive](cli-only.md), skip the source build and set `vigo` to `node "/absolute/path/to/cli-package/vigo.mjs"`. Keep its native kernel beside the script. The commands below use a POSIX shell; on Windows use WSL for these download/extract steps or translate the shell commands to PowerShell.

## 2. Download the Boston inputs and build

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
[Performance](../development/performance.md) for the exact boundaries.

Inspect the finished City before querying it:

```bash
vigo inspect --city ./boston --output ./city-inspect.json
```

Confirm the expected sources and counts. Keep the entire City directory; the inspection JSON identifies it but does not contain the routing data.

## 3. Run a Route

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

## 4. Inspect the Result

Read `status` first, then `result.departMinutes`, `result.arriveMinutes`, and `result.legs`. Clocks are minutes after local service-day midnight; 540 means 09:00. A `ready` result has a journey; `blocked` means no journey under the requested date, walking limit, transfer cap, and time horizon. Check warnings and station/walking qualifications too.

Trip IDs and journey times depend on the downloaded feed. This is scheduled routing; these commands do not fetch live delays. The [offline Result viewer](../guide.html#viewer) opens the exported JSON. [Read and retain a Result](../reference/results.md) explains the full record.

For extra time before an appointment, add `"arrivalBufferMinutes": 5` to an
arrive-by request and optionally `"minimumTransferBufferMinutes": 3`. A 09:00
deadline then searches for arrival by 08:55, with extra time at transit changes.
These are explicit preferences, not measured delay probabilities. The
[uncertainty guide](../reference/travel-time-uncertainty.md) gives a complete
Boston request and explains what the margins cover.

## 5. Run Matrix

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

Inspect every row's `status`. A ready Matrix can contain blocked pairs; missing travel times are not zero. Add more unique origins or destinations to expand the same request.

## 6. Run Reach

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

## 7. Reuse the loaded network

One-off commands load the City each time. For repeated requests, keep one `stream` process running. Save `queries.ndjson` with one object on each line:

```jsonl
{"id":"harvard-south-depart","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"time":"08:00","maxWalkKm":1.2,"maxTransfers":3}
{"id":"harvard-south-arrive","kind":"route","origin":{"coordinate":[-71.11902,42.37334]},"destination":{"coordinate":[-71.05524,42.35227]},"time":"09:00","timePreference":"arrive","maxWalkKm":1.2,"maxTransfers":3}
```

```sh
vigo stream --city ./boston --service-date "$SERVICE_DATE" \
  < queries.ndjson > results.ndjson
```

Check every response status. For an API, use [VIGO Engine](engine-deployment.md) or the [Rust HTTP service](rust-standalone.md#15-http-api-and-server-operation). When timing routing, distinguish the network build, a fresh process's first answer, and requests to a resident process.

## Where next

- [Practical workflows](workflows.md): arrival deadlines, pairwise journeys, and a complete baseline/Scenario comparison.
- [Troubleshooting](troubleshooting.md): build failures, blocked routes, time semantics, and stale observations.
- [Developer Guide](../developer-guide/VIGO-0.4.3-Developer-Guide.tex): CLI, Results, Scenario, compatibility, and full Query reference.
- [VIGO Studio Guide](studio.md): visual exploration, routing, playback, and analysis.
- [Core concepts](concepts.md): City, Scenario, Query, and Result.
