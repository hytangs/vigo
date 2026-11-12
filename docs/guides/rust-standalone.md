# VIGO engine reference

VIGO 1.0.0 · the `vigo` executable · request schema `vigo.standalone.query.v1` · City format `vigo.city.v1`

The engine is one native executable. It builds a City from GTFS and OpenStreetMap, opens it read-only and answers Route, Matrix and Reach from the command line, a resident NDJSON stream, or an HTTP service. The City compiler, the routing kernels, the City loader, the HTTP server and SQLite are compiled in; nothing else is needed to build or to query: no Node, Python, browser or network connection.

This page is the complete reference: every command, flag, request field, endpoint and environment variable. It is also the README of the engine archive. For tutorials and explanations, start with the [VIGO guide](../guide.html), which the engine serves at `http://127.0.0.1:8080/` while `vigo serve` runs. The [public results reference](../reference/results.md) explains every answer, the [API schema](../reference/api-schema.md) lists every typed field, and the [OpenAPI document](../standalone-openapi.json) describes the HTTP API.

- **[Command line](#command-line)** Commands, flags, files and exit codes.
- **[Request basics](#request-basics)** Points, clocks, units and the fields every query shares.
- **[Route](#route-requests)** Journeys, alternatives, via points and departure windows.
- **[Matrix](#matrix-requests)** Travel times for many origins and destinations.
- **[Reach](#reach-requests)** Rasters, polygons, contours and street evidence.
- **[Scenarios](#scenario-requests)** Planned service changes for one request.
- **[Realtime and traffic](#realtime-and-traffic-input)** GTFS-Realtime, Service Alerts and traffic observations.
- **[HTTP API](#http-api)** Endpoints, limits, status codes and authentication.
- **[Environment variables](#environment-variables)** Every variable the engine reads.

Run `vigo capabilities` before integrating: it reports the version, commands, modes and optional features of the executable you have.

## Command line

The guides call the engine `vigo`. Every command accepts `--name value` and `--name=value`. Unknown options, options that do not apply to the command, repeated options and extra positional arguments are rejected. A boolean flag is true when bare (`--pretty`) and accepts `--pretty=true` or `--pretty=false`; `--pretty false` is not boolean syntax.

### Commands

Data commands need a City: `--city DIR` or the `VIGO_CITY` environment variable. This includes `compare`. `build` and `build-scenarios` write to `--output`; `help`, `version`, `capabilities` and `health` need no City.

| Command | Purpose | Main input |
| --- | --- | --- |
| `help`, `--help`, `-h` | Print the command overview | None |
| `version`, `--version`, `-V` | Print the version and runtime | None |
| `build` | Compile GTFS and OSM into a City; see [Build a City](#build-a-city) | GTFS ZIPs, an OSM PBF and an output directory |
| `build-scenarios` | Compile a collection of Cities that share one street network; see [Scenario collections](#scenario-collections) | A source manifest and an output directory |
| `capabilities` | Supported commands, modes and optional features, as JSON | None |
| `info` | Identity, sources, counts, limitations and memory of the City | City |
| `route` | A journey between ordered places | JSON request or endpoint flags |
| `matrix` | Travel times between every origin and destination | JSON request |
| `reach`, `isochrone` | Reachable streets, raster, polygons and contours | JSON request or origin flags |
| `compare` | Changes between two saved Reach Results | JSON with `before` and `after` |
| `native` | One low-level kernel operation | JSON with `operation` and `input` |
| `stream` | Resident NDJSON: one request per input line | City; requests on stdin |
| `serve` | Resident HTTP service | City and server flags |
| `health` | Ask a running service whether it is ready, without loading a City | `--host`, `--port` |
| `traffic-import` | Convert NDW DATEX II v3 travel times into a traffic snapshot | City and XML files |

Commands that start with `_` are internal: the HTTP supervisor and Studio's data preparation run them.

### Build a City

```sh
vigo build --gtfs feed.zip --osm region.osm.pbf --output ./city
vigo build --gtfs rail.zip --gtfs-scope rail --gtfs bus.zip --gtfs-scope bus \
  --osm region.osm.pbf --output ./city --street-modes walk,drive,bike --prepare-date 2026-10-05
```

| Option | Meaning |
| --- | --- |
| `--gtfs PATH` | GTFS ZIP; repeat for several feeds |
| `--gtfs-scope NAME` | A unique, stable scope for each `--gtfs`; defaults to the file name |
| `--osm PATH` | OSM `.pbf` covering the City |
| `--output PATH` | The City directory to write |
| `--street-modes VALUE` | `walk,drive` (default), `walk`, `walk,bike` or `walk,drive,bike` |
| `--prepare-date YYYY-MM-DD` | Compile a service date's timetable now; repeat for other dates |
| `--private-access VALUE` | `public` (default) or `endpoints` |
| `--wheelchair` | Build a strict wheelchair City (walking only, public access) |
| `--wheelchair-streets MODE` | `inferred` (default) or `verified` street evidence for a wheelchair City |
| `--streets-from PATH` | Reuse identical prepared streets from another City |
| `--replace` | Replace an existing City |

`--gtfs`, `--gtfs-scope` and `--prepare-date` may repeat; other options may appear once. Progress goes to standard error as `[gtfs]`, `[osm]`, `[transfers]` and `[city]` lines, and the City manifest (`network.json`) is printed to standard output. Exit 0 means the City was published; exit 2 reports invalid options or a failed build on standard error. The build is staged beside the output and renamed into place when complete: a failure, Ctrl-C or a termination signal leaves an existing City untouched and removes the unfinished one, and the next build cleans up after a crash. GTFS and OSM compile at the same time when installed memory, free memory and load allow it. [Build a City](../guide.md#build-a-city) explains inputs, combined feeds and large regions. Feeds with frequency-based trips are always compiled from source at query time, so `--prepare-date` notes and skips them.

### Query flags

Flags override the matching fields of the JSON request. `stream` applies them to every line, so omit `--service-date` when lines use different dates.

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--city DIR` | Data commands | Prepared City or scenario collection; overrides `VIGO_CITY` |
| `--routing-store FILE` | Data commands except `serve` and `traffic-import` | When `--city` names a Studio project's `.vigo` folder, the timetable store in its `routing/` folder to open, such as `current.sqlite` |
| `--scenario ID` | `info`, `route`, `matrix`, `reach`, `native`, `stream` | Member of a scenario collection; omission selects `defaultScenario`. Sets `scenarioId` |
| `--request FILE` | `route`, `matrix`, `reach`, `compare`, `native` | JSON request; `-` reads standard input |
| `--output FILE` | One-shot commands | Save the JSON instead of printing it; `-` prints |
| `--pretty` | One-shot commands | Indent JSON |
| `--format text\|json` | One-shot commands | `text` prints a short summary; the default is text in a terminal and JSON otherwise |
| `--diagnostics LEVEL` | Query commands | `none` (default), `summary`, `profile` or `trace`; see [public results](../reference/results.md) |
| `--include-geometry` | Query commands | Route geometry is on by default; `--include-geometry=false` omits it. Matrix geometry is opt-in |
| `--include-limitations` | Query commands | Add the City's dataset limitations to the Result |
| `--stream-output public\|detailed` | `stream` | `public` Results (default) or the internal `vigo.stream.detail.v1` envelope |
| `--service-date YYYY-MM-DD` | `route`, `matrix`, `reach`, `native`, `stream` | Service date |
| `--time HH:MM[:SS]` | `route`, `matrix`, `reach`, `stream` | Clock; replaces `timeMinutes` |
| `--mode transit\|walk\|drive\|bike` | `route`, `matrix`, `reach`, `stream` | Travel mode |
| `--from lon,lat` or `--from stop:ID` | `route`, `reach` | Origin |
| `--to lon,lat` or `--to stop:ID` | `route`, `reach` | Destination; arrive-by Reach takes a destination |
| `--arrive-by` | `route`, `matrix`, `reach` | Arrive by `--time`; `--arrive-by=false` restores depart-at |
| `--max-walk KM` | `route`, `matrix`, `reach`, `stream` | `maxWalkKm` |
| `--max-transfers N` | `route`, `matrix`, `reach`, `stream` | `maxTransfers` |
| `--max-street KM` | `route`, `matrix` | `maxStreetKm` |
| `--horizon MINUTES` | `route`, `matrix` | `horizonMinutes` |
| `--alternatives N` | `route` | Additional transit journeys, 0–9 |
| `--alternative-ranking pareto\|ranked` | `route` | How alternatives are chosen |
| `--cutoffs 15,30,45` | `reach` | `cutoffsMinutes` |
| `--raster-size N` | `reach` | `rasterSize` |
| `--radius KM` | `reach` | `extentRadiusKm` |
| `--street-edges` | `reach` | `includeStreetEdges` |
| `--wheelchair` | `route`, `matrix`, `reach`, `stream` | Require the City's strict wheelchair profile; `--wheelchair=false` rejects a wheelchair City |

Other controls, such as transfer buffers, realtime snapshots, scenarios, via points and bicycle preferences, are JSON fields.

### Server flags

`serve` takes `--city` and these flags:

| Flag | Default | Range and meaning |
| --- | --- | --- |
| `--host ADDRESS` | `127.0.0.1` | Literal IPv4 or IPv6 address to bind, not a hostname. A non-loopback address requires `VIGO_API_TOKEN` |
| `--port N` | `PORT`, otherwise 8080 | 0–65535; 0 selects a free port |
| `--max-body-bytes N` | 8388608 | 1024–8388608 |
| `--request-timeout-ms N` | 10000 | 50–60000; deadline for reading a request and writing its response |
| `--query-timeout-ms N` | 30000 | 1–600000; queueing plus computation |
| `--max-connections N` | 32 | 2–256 open connections |
| `--max-queue N` | 8 | 0–128 waiting queries |
| `--realtime-poll FILE` | None | Poll GTFS-Realtime feeds; see [automatic GTFS-RT polling](#automatic-gtfs-rt-polling) |
| `--ndw-poll FILE` | None | Poll NDW traffic; see [automatic NDW polling](#automatic-ndw-polling) |

`health` accepts `--host` and `--port` with the same defaults. It prints `ready` and exits 0 when `GET /readyz` succeeds within two seconds, and exits nonzero otherwise.

`traffic-import` accepts `--city`, `--output`, `--pretty`, `--format`, and:

| Flag | Meaning |
| --- | --- |
| `--configuration FILE` | NDW measurement-site configuration, XML or gzip; required |
| `--measurements FILE` | NDW travel-time measurements, XML or gzip; required |
| `--ttl-seconds N` | Validity of the snapshot; default 300 |

### Input, output and exit codes

A request file or standard input holds one JSON object, optionally preceded by a UTF-8 byte-order mark, up to 8 MiB. `--request -` reads until standard input closes.

Results go to standard output; progress and errors go to standard error. With `--output`, the JSON is written to a temporary file in the same directory and renamed into place, so a reader never sees a partial file; an existing file keeps its permissions. The directory must exist.

| Exit code | Meaning |
| --- | --- |
| 0 | A Result was produced, including `status: "not_found"` |
| 2 | Invalid input or a failure; a `vigo.error.v1` object is written to standard error |

A failed run leaves an existing `--output` file unchanged: check the exit code before reading it. There is no CSV batch interface in the engine; use Matrix or `stream`.

## Request basics

The command line, the stream and the HTTP API take the same JSON request. The [API schema](../reference/api-schema.md#request-schemas) lists every field with its type, range and default, generated from the engine's request types.

### Points

A point is a coordinate, a stop, or both:

```json
{"coordinate": [-77.05, 38.9]}
```

```json
{"stopId": "A"}
```

Coordinates are `[longitude, latitude]` in WGS84 degrees: longitude −180 to 180, latitude −90 to 90. A bare `[longitude, latitude]` array is also a point. A stop can be written `{"stop": {"feed": "mbta", "id": "70067"}}`, the form Results use, or `{"stopId": "70067"}`. Stop IDs are exact and case-sensitive; VIGO does not look up names or geocode.

Point objects also accept `id`, `name`, `label` and `source`, which do not change routing, and the scenario fields `editStatus`, `baselineStopId` and `baselineStopIndex`. A valid stop takes precedence over a coordinate, except with `source: "map"`, which uses the coordinate. Selecting a station includes its prepared platforms; that does not certify a path between every platform.

In a City built from several feeds, an ID can carry its feed scope. Use `timetable.identifiers` (a [native operation](#native-operations)) to list the active IDs; a local ID need not be unique in a combined City.

### Clocks and service dates

Transit queries need `serviceDate` (`YYYY-MM-DD`) and a clock. `time` is `HH:MM` or `HH:MM:SS` with hours 0–71, so `25:10` is 01:10 the next morning on the same service day. `timeMinutes` (0–4319) is the same clock in minutes; never send both. Street-only queries need a clock but can omit the date.

Clocks are local times in the City's timetable timezone. GTFS service days start at "noon minus twelve hours", so a daylight-saving change keeps every clock on its service day. A Result's `journey.clockDate` anchors every clock it prints; each transit leg's `serviceDate` names the day its trip runs. Calendar exceptions apply exactly, and trips from adjacent service days are included where their times overlap the search.

The depart-at timetable search ends at departure plus `horizonMinutes`; arrive-by searches back to the later of midnight and the deadline minus the horizon. A final walk may finish after the horizon. Drive routing has no travel-time horizon; `maxStreetKm` bounds it.

### Units

| Quantity | Requests | Public Results |
| --- | --- | --- |
| Distance limits | Kilometers (`maxWalkKm`, `maxStreetKm`, `extentRadiusKm`) | Meters (`distanceMeters`) |
| Durations | Minutes (`horizonMinutes`, `cutoffsMinutes`, buffers) | Seconds (`durationSeconds`, `valuesSeconds`) |
| Clocks | `HH:MM[:SS]` or minutes | `HH:MM:SS` on the service day |
| Speeds | km/h (`walkSpeedKph`, `bike.speedKph`) | Not reported |

Native operations use seconds and meters unless a field name says otherwise. Internal `trace` output keeps its own units, named in each field.

### Common fields

| Field | Default | Values and meaning |
| --- | --- | --- |
| `serviceDate` | Required for transit | Exact `YYYY-MM-DD`; calendars and exceptions select service |
| `serviceDay` | Derived | `weekday`, `saturday` or `sunday`; must agree with the date |
| `time` | Required unless `timeMinutes` | `HH:MM[:SS]`, hours 0–71 |
| `timeMinutes` | — | 0–4319; never with `time` |
| `timePreference` | `depart_at` | `depart_at` or `arrive_by`; `depart` and `arrive` are accepted |
| `mode` | `transit` | `transit`, `walk`, `drive` or `bike` |
| `maxWalkKm` | 1.2 | 0–100. Transit: each access and egress walk. Reach: the walking budget. Drive and Bike: the walk between a point and its road |
| `maxTransfers` | No cap | Integer 0–31; 0 allows one boarding |
| `horizonMinutes` | 480 | 1–2880; Route and Matrix only |
| `maxStreetKm` | 50 | 0.05–1000; Walk, Drive and Bike distance limit. Smaller values are rejected, never rounded up |
| `allowStreetTransfers` | `true` | `false` keeps changes to the same stop or station |
| `minimumTransferBufferMinutes` | 0 | Integer 0–60, added before each later boarding |
| `arrivalBufferMinutes` | 0 | Integer 0–60; arrive-by transit Route and Matrix plan against an earlier deadline |
| `requireTransitRide` | `false` | Transit Route and Matrix: require at least one boarding |
| `allowLongWalk` | `true` | Transit only: `false` caps a direct walk by `maxWalkKm` instead of `maxStreetKm` |
| `walkSpeedKph` | City policy, normally 4.8 | 1–8. Walk, Drive and Bike Route and Matrix, and Reach. Transit Route and Matrix reject it |
| `disableCache` | `false` | Skip endpoint and walking-path caches for this request; not a cold-start switch |
| `requireCompleteServiceCoverage` | `false` | Reject a date on which an active source of a multi-feed City has no service |
| `sourceScopes` | All sources | Route only on the services of these feed scopes in a multi-feed City |
| `departNow` | `false` | Transit only: leave at the current minute in the City's timezone, rounded up; replaces `serviceDate` and `time`. Needs a City with one agency timezone |
| `routingDataMode` | From the input | `scheduled` or `realtime`; `dataMode` is an alias. Never send both |
| `realtimeSnapshot` | — | GTFS-Realtime input; see [Realtime and traffic](#realtime-and-traffic-input) |
| `traffic` | — | Drive traffic observations |
| `wheelchair` | City profile | `true` requires a wheelchair City, `false` rejects one |
| `bike` | — | Bicycle preferences; see [Walk, drive and bike](#walk-drive-and-bike) |
| `flex` | — | Include conditional GTFS Flex service in Route and Matrix; see [GTFS Flex](../guide.md#gtfs-flex) |
| `monteCarlo` | — | Departure-window distribution; see [Monte Carlo](../guides/monte-carlo.md) |
| `scenarioId` | Collection default | Member of a [scenario collection](#scenario-collections) |
| `diagnostics` | `none` | `summary`, `profile` or `trace` |
| `includeLimitations` | `false` | Add dataset limitations to the Result |
| `id` | — | Caller identifier, echoed by the stream and HTTP |
| `kind` | — | `route`, `matrix`, `reach`, `compare`, `native`, `info` or `capabilities`; required on stream lines |

Access padding and overhead from the City's walking policy apply to boarding access, not to a direct walk. The transfer buffer applies once per change, after the transfer walk and any published minimum; it never delays the first boarding, the final walk or staying aboard. Neither control establishes station accessibility or fare eligibility.

`arrivalBufferMinutes` reserves time before the deadline while keeping the original earliest departure. The deadline must be at least the reserve, and `horizonMinutes` must exceed it by at least one minute. Via points, depart-at, Walk, Drive, Reach and native operations reject a positive reserve. `diagnostics.timeReserves` in the trace records both deadlines and `calibratedProbability: false`. See [Time reserves](../guide.md#travel-time-uncertainty).

## Route requests

Route finds a journey between an `origin` and a `destination`. A valid request with no journey returns `status: "not_found"` and exits 0.

### Reference fixture

The examples on this page use VIGO's small public test network `A → X → B`, with service on **2026-07-15**. They are executed against the engine on every documentation check. The IDs do not exist in other Cities; the [quickstart](../guide.md#quickstart) has a complete Boston walkthrough.

A depart-at request that requires a ride:

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

The Result, with legs and metadata omitted:

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

The journey leaves at 07:55 and arrives at 08:30: 25 minutes riding and 10 minutes waiting. `transfers: 1` means two boardings. The [public results reference](../reference/results.md) explains every field.

### Arrive by

Set `timePreference: "arrive_by"`; `time` becomes the deadline. VIGO finds the latest departure that still arrives by then:

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

### Walk, drive and bike

Street modes need coordinates, a clock and a distance limit:

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

Change `mode` to `drive` to drive. A drive attaches each free point to the nearest point of a drivable road and enters or leaves that road mid-segment, in the road's direction. The straight gap is a walk at `walkSpeedKph`, returned as its own `walk` leg with `geometrySource: "coordinate-snap"`. When that walk would exceed `maxWalkKm`, the Result is `not_found` with reason `no_drivable_road_within_walk`; VIGO never drives across open ground.

Bike needs a City built with bicycle streets. The `bike` object sets preferences:

| Field | Default | Meaning |
| --- | --- | --- |
| `bike.profile` | `balanced` | `balanced`, `quiet` or `fast`. Preferences choose the route; they never inflate the reported duration |
| `bike.speedKph` | 18 | 5–40; cycling speed on flat, smooth road. Surface and mapped incline adjust it |
| `bike.maxLts` | No limit | 1–4; maximum estimated traffic stress. Above it, the rider pushes at 4 km/h where walking is permitted |

See [Bicycle routing](../guide.md#bicycle-routing) for what the bicycle model includes.

### Direct walking

For transit requests between coordinates, a direct walk competes with transit and wins when it arrives sooner. Set `requireTransitRide: true` to require a boarding, or `mode: "walk"` to ask for walking. A blocked request that names a stop gains no direct-walk fallback. A direct walk is limited by `maxStreetKm`, or by `maxWalkKm` when `allowLongWalk` is `false`.

### Geometry and fares

Route returns leg geometry by default; `includeGeometry: false` omits it. A transit leg's line runs from the boarding stop along the aligned GTFS shape to the alighting stop, and its `distanceMeters` is that line's length. Without a usable shape, the line joins the stop coordinates and says so. Transit legs carry the published GTFS fare for a new boarding when the City has fare data; see [Published fares](../guide.md#published-fares-on-itineraries).

### Alternative journeys

`alternatives` (0–9, default 0) asks a depart-at transit Route for more journeys at the requested time. The primary journey stays in `journey`; the others are in `alternatives`, earliest arrival first.

`alternativeRanking` chooses them:

- `pareto` (default) keeps trade-offs. Each alternative must beat every other returned journey on arrival, boardings or walking, using no more boardings than the primary journey. When more trade-offs exist than requested, the fewest boardings and the least walking go first. Remaining places go to journeys within the arrival slack that ride a set of routes no listed journey rides, earliest first.
- `ranked` keeps the earliest distinct arrivals, even when another journey is better in every respect, then prefers less walking and fewer boardings. A candidate with the same arrival and less walking replaces the primary journey. It allows one more boarding than the primary journey, within `maxTransfers`.

Journeys on one vehicle chain are one choice in both rankings. `alternativeSlackMinutes` (0–120, default 15) bounds how much later than the primary journey an alternative may arrive. `alternativeSearch` in the Result records the coverage, ranking, limits and `status`. If a search exceeds its label budget, `status` is `unavailable` with a `reason`, and the primary journey is returned alone. Alternatives cannot be combined with arrive-by, via points or a journey window, except a window with `windowChoices: "supported"`.

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

### Show direct services next to faster journeys

Faster journeys with changes can fill every alternative slot before a slower direct service appears. To offer both, send `alternatives: 9` with `alternativeRanking: "ranked"`, and a second request with the same endpoints, date, time and walking limits plus `maxTransfers: 0`. Merge the successful journeys, sort by arrival, remove equivalent departures, and keep the fastest as the recommendation. This is still bounded by the requested count and slack; it is not a list of every service.

### Shared-leg services

`sharedLegs` (default `false`) on a transit Route lists other services that could replace one leg of the recommended journey. The Result's `journey.sharedLegAlternatives.options` holds, for each option, a zero-based `legIndex` and a complete `journey`. The recommended journey is unchanged.

Services match by route ID, the exact ordered stops with their boarding and alighting permissions, and an equivalent directed path from GTFS shapes or planned geometry (coordinates rounded to six decimals). Route names do not establish identity. A short-turn branch appears only on the part it serves. Missing or mismatched shapes are left out.

Coverage is `single_leg_substitutions`: each option changes one leg, keeps the other rides, and preserves transfer times and the deadline. Departures are considered from the original leg's departure to 30 minutes later, arriving at most 30 minutes after it. VIGO returns the earliest feasible trip per alternate route, keeps at most 256 candidates per leg and 32 options per journey, and sets `truncated: true` when a bound is reached. If a substitution VIGO found cannot be rebuilt from the journey's endpoint evidence, it is left out and counted in `omitted: {count, reason}` (reason `access_evidence_unavailable`); the next departure of that route is still considered. `omitted` is absent when nothing was left out, and the recommended journey is unaffected either way. Do not combine options into a journey VIGO has not verified.

The same object reports `frequency: "active_departures"` and a `frequencies` entry per verified leg. Each entry counts active trips on the same stops, permissions and path within a half-open window from the leg's departure to 30 minutes later (or the timetable horizon, if earlier). `departureCount` counts vehicles; `uniqueDepartureCount` and the sorted `departureSeconds` count distinct times; `departuresPerHour` scales the count to an hour; `meanHeadwaySeconds`, `minHeadwaySeconds` and `maxHeadwaySeconds` describe the gaps between distinct times and are null with fewer than two. The scan examines at most 512 departures per leg; when capped, `status` is `incomplete`, counts are lower bounds and rates are null. Frequencies describe the segment, not onward connections.

Shared legs work with scheduled and realtime timetables, arrive-by and journey windows. Via points and street modes are rejected.

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

`via` (alias `waypoints`; never both) lists up to 16 intermediate points in order. Each segment is routed in turn, carrying the clock forward for depart-at or backward for arrive-by. No dwell is added at a via point. A blocked segment returns reason `via_leg_blocked` with its `legIndex`.

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

Transit via requests require a boarding on every segment. They reject `maxTransfers` and a nonzero transfer buffer, because composing segments cannot certify the change at the via point.

### Journey windows

`windowMinutes` (0–240, default 0) repeats the search every `windowStepMinutes` (1–60, default 1) from the requested time: depart-at moves to later departures, arrive-by to earlier deadlines. Up to five distinct, nondominated journeys are kept, ordered by arrival (depart-at) or departure (arrive-by), then boardings and walking. The first is in `journey`; the rest are in `alternatives`. `alternativeSearch` records `minutes`, `stepMinutes`, `searches` and `direction`.

A window samples whole minutes; it is not a continuous profile of every departure. Via points take precedence and remove window sampling from their segments.

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

### Supported window choices

`windowChoices: "supported"` asks a depart-at window for the choices a person compares instead of the sampled frontier. VIGO searches each minute of the window and keeps the journeys that are best for some balance of elapsed time, ride time, boardings and walking: the earliest arrival, the fewest transfers, the least walking and a balanced choice, each labeled with its role. With `alternatives`, alternatives at the requested time join the choices.

| Field | Meaning |
| --- | --- |
| `expandedWalkKm` | 0.2–5, above `maxWalkKm`: also search with this walking budget and add choices that walk farther but arrive at least one minute earlier than every ordinary choice. They carry `expandedWalkingLimitKm` |
| `includeEarliestTransit` | Add `earliestTransit`: the first boarding and arrival of the earliest transit choice, even when walking wins |

With via points, each segment starts at the exact clock the previous one reaches its point. Arrive-by accepts `windowChoices` only without a window.

The compiler, `vigo-build`, offers a different window: `departureWindowMinutes` (or `--departure-window`), a centered depart-at profile of ±0–30 minutes. It rejects the engine's window fields.

### Journey policy

`journeyPolicy` set to `"alternatives-v1"` on a transit Route returns the journey and its alternatives as one versioned policy for thin clients. Check that `capabilities.route.journeyPolicies` lists it. The policy keeps a direct transit journey and a permitted direct walk, orders by arrival (departure for arrive-by), then walking and boardings, and bundles journeys that share boarding and alighting stations, modes and walking policy. Arrive-by keeps a 15-minute window of earlier arrivals, sampled every five minutes. Do not combine it with `alternatives`, windows or via points.

`expandedWalkKm` is explicit permission to search with more walking; omit it when the user's walking limit is binding. A wider choice must beat every ordinary choice by at least one minute. In supported windows, a final ride (with its wait) is replaced by walking on when the walk fits the wider budget and arrives at least a minute sooner. `requireTransitRide` excludes walking-only choices. A failed wider search keeps the ordinary results.

### Wheelchair and Flex

A City built with `--wheelchair` answers with the strict `wheelchair-strict-v1` profile; `wheelchair: true` requires such a City and `false` rejects it. Wheelchair Cities reject Drive, realtime transit and query-time scenario overlays. See [Wheelchair routing](../guide.md#wheelchair-routing).

`flex: {}` on Route or Matrix includes conditional GTFS Flex service. Optional `durationFactor` (1–10) and `durationOffsetSeconds` (0–7200) apply when the feed omits its own safe-duration values; `bookingConfirmed: true` records the caller's claim. See [GTFS Flex](../guide.md#gtfs-flex).

## Matrix requests

Matrix returns travel times between every origin and destination in one request, for transit, walking, driving or cycling.

### Build a matrix

Supply `origins` and `destinations`, each at least one point. Rows follow origins and columns follow destinations. A request holds up to 65,536 pairs.

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

`durationsSeconds[row][column]` is the time from the shared departure to arrival (depart-at), or from the latest departure to the shared deadline (arrive-by). An arrive-by duration can exceed its journey's duration when the journey arrives early. `null` means unreachable; zero is a real zero-length trip. Walk, Drive and Bike matrices also return `distancesMeters` in the same order.

### Journeys and journey format

| Field | Default | Meaning |
| --- | --- | --- |
| `includeJourneys` | `false` | Transit only. Adds `journeys[row][column]`, with `null` for unreachable pairs |
| `includeGeometry` | `false` | Requires journeys. Adds leg geometry |
| `journeyFormat` | `full` | `compact` returns the same trips, stops, boarding sequences, clocks and totals without display metadata or walking evidence. Requires journeys; excludes geometry |

When a direct walk wins a transit cell, its journey has one timed walking leg. Large journey matrices with geometry can reach the response limit; split them. Output detail never changes the search.

### Repeated endpoints

Repeated origins or destinations are searched once and expanded back to the requested rows and columns. Stops and coordinates keep their own semantics: two co-located stops are not merged. The trace reports `matrixReuse` with `requestedPairs`, `searchPairs`, `uniqueOrigins` and `uniqueDestinations`.

## Reach requests

Reach maps where an origin can reach within time cutoffs, or, arriving by a deadline, where a destination can be reached from. `isochrone` is an alias. Transit Reach combines the timetable with walking on the prepared streets; `mode` can also be `walk`, `drive` or `bike`.

### Depart at

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

Arrive-by Reach takes a `destination` instead of an origin and reads `time` as the deadline. Each value is how long before the deadline a traveler must leave that place, including any wait after an early arrival; a stop's value is how long before the deadline the traveler must be at the stop.

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

Transit searches the timetable backward once, giving every stop its latest boarding. Walking runs backward over directed streets, so one-way paths, escalators and station paths keep their direction. A destination behind authorized private access is entered from its public exits. A deadline earlier than the longest cutoff after midnight searches the previous service day's late trips. Scenario exclusions and planned services apply; a compiled `overlay` and `surfaceReuse` are depart-at only.

### Options

| Field | Default | Meaning |
| --- | --- | --- |
| `origin` | Required for depart-at | Where trips start |
| `destination` | Required for arrive-by | Where trips end |
| `cutoffsMinutes` | `[15, 30, 45, 60]` | 1–16 values, each 1–240; sorted and deduplicated |
| `rasterSize` | 96 | Integer 16–1024; cells per side |
| `extentRadiusKm` | 8 | 1–40; the grid's extent around the point, not a trip-distance limit |
| `bounds` | From the point and radius | `[west, south, east, north]`; fixes the grid explicitly |
| `surfaceSampling` | `street` | `street` samples reached street intervals; `cell-center` routes to every cell center |
| `reachFormat` | `full` | `full`, `map` (areas only) or `surface` (no polygons or contours) |
| `includeStreetEdges` | `false` | Add directed street evidence (`full` only) |
| `includeNodes` | `false` | Add reached-node evidence, up to 30,000 nodes (`full` only) |
| `scenario` | — | Exclusions, planned services or a compiled overlay |
| `surfaceReuse` | — | Street sampling: `baseline` keeps this surface in the running process; a following `scenario` request grows from it when every seed is unchanged or earlier |
| `allDay` | — | Aggregate depart-at samples over a window; see [All-day Reach](#all-day-reach) |
| `arrayEncoding` | `json` | `base64` encodes rasters and street evidence as little-endian arrays; detailed stream output only |

Reach rejects `horizonMinutes`, `maxStreetKm`, `requireTransitRide` and `allowLongWalk`: the largest cutoff bounds the search. Walk-only Reach needs no service date and cannot take a transit scenario.

Drive and Bike Reach route from the point to every cell center, with a 750 km road-distance cap, and return no pedestrian street evidence. The point and each cell center walk straight to their nearest road, and that walk counts toward the cutoff. Dated Bike Reach evaluates timed roads and turns; its cutoffs filter the preferred route's elapsed time.

### Surface sampling

`street` (default) records the earliest reached part of each street in each cell; cells away from reached streets stay empty, and a filled cell does not establish a route to its center. It supports planned service and any walking speed.

`cell-center` routes to the center of every cell with the Matrix walking rules and the requested bounds. It supports walking and scheduled transit without planned service, and transit uses the City's 4.8 km/h walking policy; other speeds are rejected. Use it to compare with tools that evaluate grid points.

### Read the surface

`surface.valuesSeconds` is a flat, row-major array of seconds starting at the **northwest** cell: cell `(x, y)` is index `y * width + x`. `null` means no value was reached; zero is a value. With bounds `[west, south, east, north]`, the center of a cell is:

```text
longitude = west + (x + 0.5) / width  * (east - west)
latitude  = north - (y + 0.5) / height * (north - south)
```

`fullSurface` uses the same dimensions over bounds recomputed from the reached streets, which can be smaller or larger than the requested view; never read its values with the requested bounds. `areas` and `fullAreas` are GeoJSON FeatureCollections of MultiPolygons, and `contours` and `fullContours` of MultiLineStrings; each feature carries its cutoff. Areas keep holes and separate islands; contours interpolate the raster and never draw a hull across unreachable space.

### Map output

`reachFormat: "map"` returns only the full reached-area polygons as `areas`, their `bounds`, and the usual metadata: no raster, stops or contours. The polygons equal `fullAreas` from the default `full` format. Map output cannot be compared; use `full` for analysis.

### Street evidence

`includeStreetEdges: true` (or `--street-edges`) adds `surface.edges` with `schemaVersion: "vigo.standalone.street-edges.v2"` and `encoding: "indexed-json"`: the directed street intervals reached, with times and walking distances. [Decode directed street evidence](#decode-directed-street-evidence) shows how to read them.

### All-day Reach

`allDay` samples scheduled depart-at transit every five minutes over a service-day window, default `[0, 1440)` minutes (288 samples). Omit `time` and `timeMinutes`.

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

Run it with `vigo reach` or on a `stream` line. It supports street sampling, scheduled transit, depart-at and `reachFormat: "surface"` only; scenarios, realtime, arrive-by, cell-center sampling, polygons, caching switches, node and edge evidence and per-sample output are rejected. Studio and the compiler do not offer it.

The Result keeps `schema: "vigo.reach.v1"`. `allDay.sampleCount` is the denominator. The surface holds `reachableSamples`, `meanReachableDurationSeconds` (null when never reached) and `reachableSamplesByCutoff`, one row per entry of `cutoffsSeconds`. Divide a count by the sample count for the share of departures that reach the cell. The mean covers only the reachable samples, so a low mean does not mean reliable access. Memory does not grow with the number of samples.

## Scenario requests

A `scenario` changes the transit service seen by one Reach or transit Route request. It changes nothing in the City or in later requests. See [Scenarios](../guide.md#scenarios) for how to design one.

### Route on a scenario

A Route scenario routes on the scheduled timetable with excluded trips removed and planned services added. Planned stops given as `stopId` are those stops; others are new stops, joined to the network by walks within the City's stop-transfer radius and reachable within `maxWalkKm`. Planned stops, routes and trips belong to the feed `scenario-<hash>`; a planned route's ID is its service `id` and its name is the service `name`. Route scenarios accept `services` and exclusions, not `overlay`, and use scheduled data. Repeating a scenario reuses its timetable view.

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

### Scenario fields

| Field | Meaning |
| --- | --- |
| `id`, `name` | Labels, echoed in Results |
| `cityRevision` | Optional; must equal the loaded City's revision |
| `excludedTripIds`, `excludedRouteIds` | Exact active IDs to remove; exclusions affect matching scheduled trips only |
| `services` | Up to 128 planned services |
| `overlay` | A compiled overlay instead of `services` (Reach only) |
| `flexZones` | Planned on-demand zones for Route and transit Reach; see [GTFS Flex](../guide.md#gtfs-flex) |

Send either nonempty `services` or `overlay`. Editor-only fields are rejected: convert branch edits into explicit schedules first.

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

| Service field | Default | Meaning |
| --- | --- | --- |
| `operation` | `add` | `add`, `augment` or `replace` |
| `stops` | Required | At least two points in service order; at most 256 distinct planned points per request |
| `scheduleMode` | `frequency` (`add`, `augment`); `preserve-trips` (`replace`) | How departures are made |
| `sourceRouteId` | — | Route replaced by a frequency `replace` without explicit trips |
| `bidirectional` | `true` for frequency | Also run the reverse direction. Preserved trips reject `true` |
| `startMinutes`, `endMinutes` | 300, 1500 | 0–4319; end after start. The window includes its end unless `exactTimes` is true |
| `headwayMinutes` | 12 | 0.1–1440 |
| `exactTimes` | — | `true` fixes departures at the start and every headway, excluding the end; otherwise Monte Carlo samples a phase |
| `timeModel` | `estimate-distance` | `estimate-distance`, `preserve-scheduled` or `infer-road` |
| `averageSpeedKph` | 22 | 1–300; with distance estimates |
| `dwellMinutes` | 0.35 | 0–60; dwell after arriving at each intermediate stop |
| `segmentRuntimeMinutes` | — | One value per consecutive stop pair |
| `segmentDistancesKm` | — | One value per consecutive stop pair |
| `addedStopDwellMinutes` | 0 | 0–10; dwell at inserted stops with supplied runtimes |
| `scheduledTrips` | — | Explicit trips for `preserve-trips` |
| `timetables` | — | Up to 32 timetable rows replacing the top-level window; see [Monte Carlo](../guides/monte-carlo.md#planned-timetables-and-coordinated-transfers) |
| `phaseFrom` | — | Coordinate a non-exact service with another; Monte Carlo only |
| `timing` | — | Speed and dwell edits for `preserve-trips`; see [Monte Carlo](../guides/monte-carlo.md#speed-and-dwell-edits) |

A request accepts at most one million planned stop events. `estimate-distance` uses the projected distance between stops, the speed and the dwell; supplying runtimes does not select them. `preserve-scheduled` uses supplied runtimes, falling back to distance estimates. `infer-road` consumes supplied distances or runtimes; the engine does not trace roads itself.

Frequency windows use whole seconds. Every run arrives, dwells, then departs, so riders alight before the dwell; runs do not dwell at their first or last stop. A frequency service runs on every service day: the previous day's runs still running after midnight and the next day's first runs join the timetable wherever the query's clock reaches them, and no departure runs twice.

`augment` keeps existing service. A frequency `replace` with `sourceRouteId` removes the route's active trips; with `scheduledTrips`, their trip IDs define what is removed. Added service can run on a date with no baseline service.

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

Offsets are seconds after the run's `departureSeconds`, one per stop, in chronological order. `canBoard` and `canAlight` are 0 or 1 per stop and default to all allowed. Unknown trip fields are rejected. The replaced `tripId` must be active on its service day. `serviceDayOffset` (−3 to 3, default 0) names the service day a trip runs on: a trip with −1 belongs to the previous day, its `departureSeconds` are on that day's clock, and only its calls after the query date's midnight remain. A replacement removes every instance of its original trip, so include the previous day's trips that run past midnight; Studio and the compiler do. Preserved trips never create reverse runs.

### Compiled overlays

Advanced clients can send `scenario.overlay` with the arrays of `TimetableOverlayManyQueryInput`: stops, `overlayStopCount`, direction offsets, stops and times, service windows and headways, and supplemental transfers. The stop count must match the coordinate-bearing stop list and be at most 256. Direction stops use overlay-local indices; supplemental transfers use the combined resident-plus-overlay domain. The [native field reference](../reference/rust-standalone-native.md#timetableoverlaymanyqueryinput) gives the exact types.

## Compare requests

`compare` reports where travel times improve, worsen, appear or disappear between two saved Reach Results on the same grid.

### Prepare the comparison

Send the two complete Result objects under `before` and `after`; not filenames:

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
vigo compare --city ./city --request comparison.json --output change.json
```

Python is only a convenient way to build the file. The engine requires a City path for `compare` even though it does not route. Both Results must share the City revision, bounds, dimensions and compatible rasters. Engine Compare accepts Reach only; the compiler's `vigo-build compare --before … --after …` also compares Route and Matrix Results.

### Interpret changes

The Result, `vigo.compare.v1`, reports **after minus before**. `counts` splits the cells reachable in both (`comparable`) into `faster`, `slower` and `unchanged`, and counts `newlyReachable` and `noLongerReachable` separately. `meanChangeSeconds` averages comparable cells, is negative when travel got faster, and is null when none are comparable. The trace has the per-cell `deltaMinutes` grid; see [Comparison output](#comparison-output).

Compare checks the grid, not the experiment: keep the origin, date, clock, walking policy and cutoffs identical yourself.

## Scenario collections

A collection serves several transit scenarios over one immutable street graph. Build it from a source manifest, then serve or stream it:

```sh
vigo build-scenarios --spec scenarios.source.json --output ./scenario-set
vigo serve --city ./scenario-set --port 8080
```

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

Source paths are relative to the manifest; optional `sha256` values pin each input. Streets are prepared once and referenced from every member, so move the collection as one directory. `build-scenarios` takes `--spec`, `--output`, `--wheelchair` and `--wheelchair-streets`, prints the same progress as `build` for each member, and prints the collection manifest with its `storageBytes` on standard output. The output directory holds `scenarios.json`, `checksums.json` (a SHA-256 for every file), `cities/<id>` and `streets/<OSM SHA-256>`. It must not exist yet; the collection is staged beside it and renamed into place when complete, and an interrupted build is removed as for `build`. `prepareDates` precompiles up to 32 service dates; other dates still work from the source timetable.

Each request selects a member with `scenarioId` (or `--scenario`); omission selects `defaultScenario`. At most `maximumResidentScenarios` members stay loaded; see [Runtime memory and caching](#runtime-memory-and-caching).

- `"privateAccess": "endpoints"` gives every member the [authorized endpoint access](../guide.md#authorized-endpoint-access) overlay. These members keep separate street directories, because the overlay depends on each member's stops.
- `"wheelchair": true` (or `build-scenarios --wheelchair`) prepares every member with `wheelchair-strict-v1`. Wheelchair collections require `streetModes: "walk"` and public access. Conflicting command-line and manifest values are rejected.

## Realtime and traffic input

A query can carry GTFS-Realtime predictions or traffic observations, and `vigo serve` can poll feeds itself. Without polling, each query uses only what it carries; the next request without it is scheduled again.

`routingDataMode: "scheduled"` rejects observation input; `"realtime"` requires a snapshot, traffic or a polling server. Without an explicit mode, supplied input selects its path.

### Transit snapshot

Transit Route, Matrix and Reach accept `realtimeSnapshot` and all search the same realtime timetable; a Reach scenario applies on top of it. Send a `FULL_DATASET` snapshot with `tripUpdates` and, optionally, `alerts`. Timestamps are POSIX **seconds**. Every record needs a `sourceFeedTimestamp` or the snapshot's `feedTimestamp`, at most 180 seconds old and at most 60 seconds ahead; a record's own `timestamp`, when present, must also be fresh.

To try it on the fixture, add a current synthetic delay to the first route request:

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
vigo route --city ./city --request realtime-route.json
```

In real use, keep the provider's timestamps. Rewriting them to look current changes the input; it does not replay the observation.

| Trip update field | Meaning |
| --- | --- |
| `tripId` | Exact, or unambiguous scoped or local, static trip ID; nested `trip.tripId` is also accepted |
| `sourceScope` | The feed scope the record belongs to in a multi-feed City; omit it in a single-feed City |
| `startDate` | Optional service date check (`YYYYMMDD` or `YYYY-MM-DD`) |
| `routeId`, `directionId` | Optional identity checks |
| `delaySeconds` | Trip delay, propagated forward |
| `scheduleRelationship` | `SCHEDULED`, `CANCELED`, `DELETED` or `REPLACEMENT` |
| `stopTimeUpdates` | Predictions for individual calls |

A stop time update names its call by `stopSequence` or an unambiguous `stopId`; when both are present they must agree, and loops need the sequence. `arrival` and `departure` are separate objects with an integer `delay` or an absolute `time` in seconds. Absolute times need `realtimeSnapshot.timezone` when the City has more than one timezone. `SKIPPED` removes a call; `NO_DATA` resets the propagated delay. A `REPLACEMENT` must give every call with an existing stop, an increasing sequence and absolute times.

Invalid, duplicate, stale, ambiguous and unmatched records keep scheduled service and are counted. A malformed snapshot fails the request. `meta.realtime` reports coverage and the counts of applied, canceled, stale, invalid, duplicate and unmatched records; [Realtime transit](../guide.md#realtime-transit) explains how to read them. A transit leg on an updated trip reports `quality.schedule: "realtime"`.

### Service Alerts

`realtimeSnapshot.alerts` holds Service Alerts, in the form the server's poller produces:

```json
{
  "id": "closure-1",
  "effect": "NO_SERVICE",
  "header": "Park Street closed",
  "activePeriods": [{ "start": 1792764000, "end": 1792778400 }],
  "informedEntities": [{ "stopId": "place-pktrm" }, { "routeId": "Red", "directionId": 0 }]
}
```

An informed entity matches when all of its fields match (`routeId`, `routeType`, `directionId`, `trip.tripId`, `stopId`); an alert applies when any entity matches. A station `stopId` also selects its platforms. Active periods are POSIX seconds with open bounds; no period means always active. `effect` is a name or its GTFS-Realtime code.

| Effect | Routing |
| --- | --- |
| `NO_SERVICE` on a route, trip or route type | Its trips cannot be boarded or left during the period |
| `NO_SERVICE` on a stop | No boarding or alighting there; vehicles pass through |
| `NO_SERVICE` on a route and a stop | That route does not serve that stop |
| Any other effect | None; the alert is reported on the legs it describes |

Every fresh alert active during a ride that selects its trip, route or stops appears in the leg's `alerts` (`id`, `effect`, `cause`, `severity`, `header`, `description`, `url`). `meta.realtime.alerts` counts received, fresh, stale and `NO_SERVICE` alerts, the closed boardings and alightings, and entities VIGO cannot resolve, such as an agency alone or a direction without a route. A City with several timezones reports `status: "timezone_required"` unless the snapshot has a `timezone`. Wheelchair Cities use scheduled service, so `ACCESSIBILITY_ISSUE` is reported, not applied.

### Automatic GTFS-RT polling

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

| Field | Meaning |
| --- | --- |
| `sources[].url` | HTTPS, or loopback HTTP for local mirrors. Redirects are rejected |
| `sources[].kind` | `feed` (default: Trip Updates and Alerts), `tripUpdates` or `alerts`. Vehicle Positions are never polled |
| `sources[].sourceScope` | The static feed the source describes, in a multi-feed City |
| `sources[].headers` | Up to eight request headers, such as an API key. Status output never shows URLs, queries or headers |
| `intervalSeconds` | 5–3600 |
| `timeoutSeconds` | 1–60 per request |

Up to 16 sources. Downloads are limited to 32 MiB, or 128 MiB after gzip, and each feed must be a `FULL_DATASET` FeedMessage within the snapshot limits.

Set `routingDataMode: "realtime"` and omit `realtimeSnapshot` to route on the server's latest snapshot; an inline snapshot takes precedence for its own query. `meta.realtime.snapshot` names the snapshot used (`source: "server"`, its `id`, `generation`, and each source's timestamp and failure). Identical content never publishes a new generation.

One background producer downloads, decodes and merges the sources; routing never waits for a download. While idle, the worker installs each publication and derives the realtime view of the last live query, so the next one normally finds it ready. A failed source keeps its last good records without extending their validity: they still expire after 180 seconds, and `coverage.complete` becomes false. Failures back off exponentially, up to one hour. `GET /v1/realtime` reports status (`fresh`, `stale_fallback` or `unavailable_fallback`), generation, snapshot ID, counts, attempts, failures, the next attempt and each source's state.

Polling serves a single City, not a scenario collection. DIFFERENTIAL feeds, deleted entities, added trips and trip modifications are not applied.

### Drive traffic

Drive Route and Matrix accept a `traffic` object. With `routingDataMode: "realtime"`, it replaces the road costs for that request: one fixed set of costs, not a forecast that changes during the trip.

| Field | Meaning |
| --- | --- |
| `observedAt` | Observation time, RFC 3339 or Unix seconds or milliseconds; aliases `fetchedAt`, `timestamp`. Required |
| `ttlSeconds` | Validity, 1–1800; default 300 |
| `expiresAt` | Optional explicit expiry |
| `source` | Provider label |
| `observations` | The observed roads; aliases `segments`, `edgeUpdates` |

At `now >= expiresAt` the request uses baseline costs and reports `stale_fallback`. Observation times more than 60 seconds in the future and malformed validity are rejected. The admission clock is fixed once per request.

Each observation identifies a directed road by `coordinates` (2–512 points), by `fromCoordinate` and `toCoordinate`, or by `edgeIndices` bound to the City's `streetSourceFingerprint`, and sets exactly one effect:

| Effect | Range |
| --- | --- |
| `closed: true` | Makes the matched directed edges unavailable |
| `travelTimeSeconds` | 0.01–86400 for the whole matched path, spread in proportion to baseline edge times |
| `speedKph` | 1–200 |
| `delayFactor` | 1–100; aliases `factor` and `multiplier` |

At most 100,000 observations and 200,000 affected edges. Geometry is matched to a connected directed path: the matcher checks endpoint proximity, forward progress, shape coverage within a corridor at most 30 m wide, and length, and rejects competing paths within its ambiguity margin. Opposite directions are separate. Unmatched, ambiguous and over-budget observations are reported, never guessed. Overlapping observations keep the largest cost, and no edge becomes faster than baseline.

Raw callers can send `snapshotKey`, `edgeIndices` and `edgeTimeUnits` (hundredths of a second; 2147483647 closes an edge) with the `streetSourceFingerprint`. The actual weights, not the key, decide cache identity. `meta.traffic` reports status, timestamps, the effective key, matching counts and rejections.

### Automatic NDW polling

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

Every field is optional; `{}` selects these defaults. URLs require HTTPS, except loopback HTTP; redirects are rejected. Ranges: `intervalSeconds` 1–3600, `configurationRefreshSeconds` 60–86400, `ttlSeconds` 1–1800, `timeoutSeconds` 1–60. Poll at the source's update cadence, normally 60 seconds. Downloads are limited to 16 MiB and decompressed XML to 256 MiB.

Set `routingDataMode: "realtime"` and omit `traffic` to drive on the latest snapshot; an inline `traffic` takes precedence. Before the first successful poll, realtime Drive reports `meta.traffic.status: "unavailable_fallback"`; after expiry, `stale_fallback`. Both use baseline costs.

One background producer downloads, joins and matches the feed to the City's driving graph. Only sites whose endpoints lie within 120 m of the City bounds are kept. Failures keep the last snapshot without extending its validity and back off up to one hour. `GET /v1/traffic` reports freshness, generation, attempts, failures, the next retry, matching counts and timings. Polling serves a single City, not a collection, and never rewrites City files. A new metric still needs one customization of the driving hierarchy on its first query.

### Import NDW DATEX II v3 traffic

`traffic-import` converts local NDW files into a `traffic` object:

```bash
vigo traffic-import --city ./city \
  --configuration reistijden_configuratie_meetlocaties.xml.gz \
  --measurements reistijden_meetgegevens.xml.gz \
  --ttl-seconds 300 --output traffic.json
```

Download both publications from the [NDW open-data portal](https://opendata.ndw.nu/). Put the output in a request's `traffic` field with `routingDataMode: "realtime"`. The City must include driving. Import again for each feed update; a failed import leaves the previous output file unchanged. `ingestion` in the output reports rejected records, matching results and timings.

The importer targets the [Verkeersdata NL DATEX II 3.6 AVG profile](https://mogin.nl/publicaties/Verkeersinformatie/Verkeersdata/vigerend/index.html). It joins table identity, site identity and version, and measurement index; reads ordered GML geometry; and uses the measurement time, not the publication or download time. Invalid values, forecasts, erroneous measurements and stale records are excluded. The snapshot expires with its earliest retained measurement.

Supported observations are whole-path travel times and speeds with an explicit linear itinerary and unrestricted vehicle scope. Point detectors, lane- or vehicle-class values, OpenLR or ALERT-C locations, incident and closure publications, and time overrides are rejected with reasons. No closure is inferred from a missing or zero measurement. Matching is conservative geometric conflation, not proof that the provider and OpenStreetMap describe the same road; inspect the matched coverage before relying on it.

## Trace output

`diagnostics: "trace"` adds the engine's internal result under `trace`, and `stream --stream-output=detailed` returns it in a `vigo.stream.detail.v1` envelope. This page documents that internal object for debugging and research tools. It is **not** part of the stable public schema: fields, units and sentinels can change between releases. Applications should read the [public results](../reference/results.md).

Read the outcome first, then the journey or analysis values. Keep units, array order and provenance with the values.

### Timing and metadata

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `vigo.standalone.result.v1`; Compare uses `vigo.standalone.comparison.v1`. Identifies the JSON interface, not the executable |
| `runtime` | `rust` |
| `cityRevision` | Revision of the loaded City; IDs and indices depend on it |
| `timing.totalMs` | Milliseconds inside dispatch, including on-demand preparation and result construction. Excludes City loading, process startup, serialization, HTTP queueing and client parsing |
| `timing.timetableSource` | `prepared_snapshot` when a compiled service timetable was reused, `source` when it was prepared from SQLite |
| `id` | Echoed by the stream and HTTP when supplied |
| `warnings` | Source limitations affecting the answer; may be absent, null or an array |

The object is the result itself, without a `data` wrapper. Native results put their object under `result`, next to `operation`. Member order has no meaning; accept unknown fields.

| Trace outcome | Meaning | Handling |
| --- | --- | --- |
| Route `status: "ready"` | A journey was computed | Read `legs` or `segments`; display the returned `mode` |
| Route `status: "blocked"` | No admissible journey | Read `reason`; journey fields may be absent |
| Matrix cell `null` | No finite duration | Keep it null; exclude it from averages |
| Reach cell `null` | No value reached | Never convert to zero |

The public Route uses `ok` and `not_found` for these outcomes.

### Route output

A trace Route describes one journey, a sequence through via points, or sampled window choices. Read `status`, then look for `segments` or `choices`.

#### Journey clocks and totals

For the [reference fixture](#reference-fixture), the following fields are exact; legs, diagnostics and metadata are omitted:

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
| `departureMinutes` | Journey start in minutes after service-day midnight. Depart-at starts at the requested clock; arrive-by at the latest departure |
| `arrivalMinutes` | Journey end on the same clock; arrive-by can finish before the deadline |
| `durationMinutes` | `arrivalMinutes − departureMinutes` |
| `boardings` | Transit boardings |
| `transfers` | `max(boardings − 1, 0)`; zero for a direct walk or drive |
| `walkMinutes` | Time on non-ride legs, including modeled access and transfer allowances |
| `rideMinutes` | Sum of ride legs |
| `waitMinutes` | The rest: gaps before the first boarding and between rides |
| `departure`, `arrival` | Native service-day clocks in seconds |
| `walkingSeconds`, `rideSeconds`, `waitingSeconds` | Native counterparts of the totals |

Here `475` is 07:55, `510` is 08:30, and `35 = 0 + 25 + 10`. Values can be fractional. Clocks can exceed 1440 minutes: `1500` is 25:00 on the selected service day. Keep the date offset; never take the clock modulo 24 hours.

#### Read the leg sequence

`legs` runs from origin to destination. **Waiting is a gap between legs**, not a leg. The fixture route has two zero-length station-selection walks around two rides:

| Step | Clock | Meaning |
| --- | --- | --- |
| Access | 07:55 → 07:55 | Selected stop A; no physical walk requested |
| Gap | 07:55 → 08:00 | Five minutes before the first boarding |
| Ride T1 | 08:00 → 08:10 | A → X |
| Gap | 08:10 → 08:15 | Five minutes before the next ride |
| Ride T2 | 08:15 → 08:30 | X → B |
| Egress | 08:30 → 08:30 | Selected destination B |

The first ride, `legs[1]`, with other properties omitted:

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

| Leg field | Meaning |
| --- | --- |
| `kind` | `ride` or `walk` in transit; `walk` for a direct walk; `drive` between optional `walk` legs for a drive |
| `from`, `to` | Endpoint objects with `coordinate`, plus `stopId` and `name` at a stop. Direct street legs omit them |
| `fromStopId`, `toStopId` | Stop IDs at stop endpoints |
| `fromStop`, `toStop`, `trip` | Indices into the active native timetable, not GTFS IDs |
| `tripId`, `routeId`, `route` | Ride identity and route display data (`shortName`, `longName`, `type`, `color`) |
| `boardSequence`, `alightSequence` | Native connection sequence values; not offsets into `stopIds` or GTFS `stop_sequence` |
| `stopIds` | The ride's stops, including boarding and alighting |
| `stopCount` | `stopIds.length − 1` |
| `coordinates` | `[longitude, latitude]` pairs; plain arrays, not GeoJSON |
| `distanceMeters` | Length of the returned line, not necessarily the operator's distance |

Walk legs keep their access cost. When it includes a station connection, `accessCost.street` and `accessCost.station` separate distances and seconds, and the station part lists directed stop IDs and sources. A published transfer minimum is timing, not a path. `stationAccessStatus: "unverified"` and `streetPathVerified: false` keep that uncertainty; `streetSegmentVerified` describes only the street part; a source-backed pathway reports `stationAccessStatus: "source_path"`. `unverifiedStationAccessLegs` counts unresolved station connections.

#### Geometry and evidence

| `geometrySource` | What the line is |
| --- | --- |
| `gtfs_shape` | The GTFS shape, aligned and cut between the stops |
| `stop_sequence` | A line through stop coordinates; need not follow the street or track |
| `osm` | A walking path in the prepared street graph |
| `osm_and_station_path` | A street path joined to a station path |
| `gtfs_pathway` | A GTFS pathway transfer between located stops |
| `stop_coordinate_fallback` | A transfer priced by a GTFS transfer rule, drawn between the stops |
| `station_selection` | A selected-stop connector; no street path was checked |
| `unverified_transfer` | A transfer without a materialized path, such as between platforms of one station |
| `coordinate-snap` | The straight walk between a free point and its road (drives) |

`streetPathVerified: true` marks a walking leg verified on the graph; the fallback labels set it to `false`. Missing does not mean false; ride legs do not use it. Graph verification does not establish wheelchair access, station-interior access or fare eligibility. Matrix journeys include geometry only with `includeGeometry`.

#### Direct, via, window and blocked variants

Direct Walk Results have one street leg; Drive Results have a drive leg with walk legs where a point lies off its road. Both report `distanceMeters`, clocks and `transfers: 0`, and omit transit totals. A transit request with `requireTransitRide: false` can return `mode: "walk"`: display the returned mode.

Via routes have ordered `segments` and a total duration, without a flattened `legs` array or aggregate totals. Window routes have the selected journey at the top level and up to five choices in `choices`; `window.searches` counts sampled times, not choices.

Reversing the fixture route to B → A gives exactly:

```json output=blocked-route
{"status": "blocked", "mode": "transit", "reason": "no_path"}
```

| Reason | Meaning |
| --- | --- |
| `no_access` | An endpoint has no admissible transit candidate |
| `no_path` | No path under the request's constraints |
| `before_service_day` | A direct street arrive-by would need a negative departure clock |
| `no_drivable_road_within_walk` | No drivable road within `maxWalkKm` of an endpoint |
| `via_leg_blocked` | A via segment failed; see `legIndex` and `leg` |

### Matrix output

A trace Matrix is indexed by the request's `origins` and `destinations`. It returns counts, not the endpoints themselves: keep the request with it.

#### Rows, columns and nulls

The [Matrix example](#build-a-matrix) uses origins `[A, X]` and destinations `[B, A]`:

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

`durationsMinutes[1][0]` is X → B: 20 minutes waiting and 15 riding from 07:55. A → A is null because the request requires a ride and no service returns. Never fill the diagonal with zero, and test `duration !== null`, not truthiness.

#### Depart-at and arrive-by durations

```text
depart-at: duration = (arrival clock - requested departure clock) / 60
arrive-by: duration = (requested deadline - latest departure clock) / 60
```

Clocks are in seconds. For A → B with an **08:40** deadline, the cell is **40 minutes**: from the 08:00 latest departure to the deadline. The journey itself arrives at 08:30 and takes **30 minutes**. Both are intended; the ten minutes are slack before the deadline, not part of the journey.

#### Journey detail

| Request | Returned |
| --- | --- |
| Transit, `includeJourneys: false` | `journeys: null`; durations only |
| Transit, `includeJourneys: true` | `journeys[row][column]`; null where unreachable |
| `includeGeometry: false` | Clocks, legs, IDs and stops without lines |
| `includeGeometry: true` | Lines and provenance on transit legs |
| `journeyFormat: "compact"` | Timed trip and stop witnesses without display metadata |
| A direct walk wins | A `mode: "walk"` journey with one timed leg |
| Walk, Drive or Bike matrix | `distancesMeters` and durations; no journeys |

Journey cells have the [Route journey fields](#journey-clocks-and-totals) but no `status`, `mode` or dispatch metadata. `diagnostics.times` is the native flat array of clocks in seconds, at offset `row * destinationCount + column`; it is not the duration matrix, especially where a direct walk replaced transit. Use the `timetable.matrix` native operation for raw native journeys.

### Reach output

A trace Reach returns reached stops, rasters, GeoJSON and optional street evidence.

#### Main fields

| Field | Meaning |
| --- | --- |
| `kind`, `mode`, `origin`, `serviceDate` | `reach`, the mode, the origin and the date (null for walking without one). Arrive-by has `destination` and `timePreference: "arrive_by"` |
| `cutoffsMinutes` | Sorted, deduplicated cutoffs |
| `stops` | Stops reached within the largest cutoff, with `stopId`, `name`, `coordinate` and `durationMinutes`; empty for walk-only Reach |
| `surface` | Grid dimensions, requested and full rasters, and optional evidence |
| `areas`, `fullAreas` | MultiPolygon features for the requested and full rasters |
| `contours`, `fullContours` | MultiLineString features |
| `diagnostics` | Transit search and street surface evidence |

Stop durations are minutes after the query clock (before the deadline for arrive-by). Stops follow timetable order, not duration; sort them yourself.

#### Decode the raster

`surface.width * surface.height` equals `surface.values.length`; index zero is the northwest cell, x grows east and y grows south. With street sampling a value is the least time on the reached streets in the cell; with cell-center sampling it is the Matrix time to the center. This function reads a cell without confusing zero with null:

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

A cell belongs to a cutoff when its value is not null and at most that cutoff. For the full raster, pass `{...surface, bounds: surface.fullBounds, values: surface.fullValues}`; when no separate surface exists, the full pair repeats the requested one. Changing bounds at fixed dimensions changes cell size, so equal indices need not mean the same place.

#### Areas and contours

| Geometry | Coordinates |
| --- | --- |
| `MultiPolygon` | `coordinates[polygon][ring][vertex]`; ring zero is the exterior, later rings are holes |
| `MultiLineString` | `coordinates[line][vertex]` |

Cutoff areas are cumulative: the 30-minute area includes the 15-minute area, so never add them. A cutoff with no geometry has no feature; match features by `cutoffMinutes`. Areas trace occupied cells; contours interpolate crossings. Both depend on resolution. Measure area with a projected or geodesic method, not in degrees.

#### Decode directed street evidence

With `includeStreetEdges: true`, `surface.edges` has `schemaVersion: "vigo.standalone.street-edges.v2"` and `encoding: "indexed-json"`; otherwise it is null.

| Field | Meaning |
| --- | --- |
| `count` | Number of directed intervals |
| `nodeCount`, `nodes` | Local coordinate table: `nodes.length = 2 * nodeCount`, longitude then latitude |
| `endpoints` | Two local node indices per interval, from then to |
| `edgeIds` | Prepared directed edge IDs; not portable between Cities |
| `durationMinutes`, `fromDurationMinutes` | Minutes at the interval's end and start |
| `startFractions`, `endFractions` | Interval limits along the edge, 0–1 |
| `walkDistanceM` | Walking distance from the seed through this interval, including snapping |
| `transitArrivalMinutes` | Arrival at the transit seed; `-1` marks the direct-origin seed |

Repeated edge IDs are ordered, non-overlapping intervals; opposite directions are separate. For a smaller cutoff, clip an interval at the cutoff instead of dropping it. In arrive-by Reach, times are minutes before the deadline and still grow from `from` to `to`, while the traveler walks the other way; `-1` marks the destination seed. This decoder reads both directions:

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

The decoder turns the `-1` sentinel into null for display; the array keeps `-1`. Check `diagnostics.surface.edgeEvidenceTruncated` before treating the records as complete. `surface.nodes` is a separate list of reached nodes (`longitude`, `latitude`, `durationMinutes`, `walkDistanceM`), empty unless `includeNodes: true`, capped at 30,000 with `diagnostics.surface.nodeEvidenceTruncated`.

### Comparison output

Compare reads the requested `surface.values` of two Reach traces; it ignores full rasters, areas, stops and edges.

#### Signs and reachability

| Before | After | Delta | Counted as |
| --- | --- | --- | --- |
| Number | Number | After minus before | `commonCells` |
| Null | Number | Null | `newlyReachableCells` |
| Number | Null | Null | `noLongerReachableCells` |
| Null | Null | Null | Not counted |

For these illustrative arrays, not network times:

```text
before = [10, null, 20, null]
after  = [ 8,   15, null, null]
```

the comparator returns exactly:

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

`meanChangeMinutes` averages common cells only, and is null when there are none. Never replace null deltas with zero. Cells unreachable in both number `width * height − commonCells − newlyReachableCells − noLongerReachableCells`.

#### Grid and provenance

The result carries `width`, `height` and `bounds`; `deltaMinutes` uses the Reach cell order. Fix `bounds` explicitly when running a baseline and a scenario so cells line up. The outer `cityRevision` is the loaded City's; the comparator checks only that the two inputs agree with each other.

### Diagnostics and native output

| Result | Diagnostics |
| --- | --- |
| Transit Route | `diagnostics.originAccess`, `destinationAccess`, `search`, `native` and `realtime` |
| Walk or Drive Route | The native street or drive result |
| Transit Matrix | The native timetable matrix result |
| Walk or Drive Matrix | The native street or drive matrix result |
| Reach | `diagnostics.transit` (null for walk-only) and `diagnostics.surface` |
| Via Route | Per-segment diagnostics under `segments` |

Transit search diagnostics report `startSeconds`, `endSeconds`, the transfer policy and `horizonScope: "timetable_scan"`. When a direct walk wins a transit request, the native diagnostics still describe the transit search; never overwrite the returned value with a diagnostic clock.

`queryNs / 1_000_000` converts a native query time to milliseconds; it is a kernel scope, not latency. Do not sum nested timings. `scannedDepartures`, `expandedTripRuns` and `relaxedStops` count algorithm work, not distinct trips or stops. `reachedPixels` counts finite cells; `reachedEdgeCount` and `reachedEdgeLengthM` count directed edges, so a two-way street counts twice.

Native responses contain `operation` and a typed `result`. Native fields are always present; unavailable optional values are null. Timetable operations index into the arrays of `timetable.identifiers` for the same service date and policy; never reuse saved indices across preparations. Native `timetable.matrix` returns a flat origin-major `times` array of **service-day clock seconds**: for the fixture's A → B, `[30600]`, an 08:30 arrival.

## Resident streaming

`stream` keeps a City loaded and answers one JSON request per standard-input line, in order:

```ndjson
{"kind":"route","id":"trip-1","origin":{"stopId":"A"},"destination":{"stopId":"B"},"serviceDate":"2026-07-15","time":"07:55","maxWalkKm":0.2}
{"kind":"reach","id":"area-1","origin":{"stopId":"A"},"serviceDate":"2026-07-15","time":"07:55","cutoffsMinutes":[30],"rasterSize":48,"extentRadiusKm":2}
```

```sh
vigo stream --city ./city < requests.ndjson > results.ndjson
```

Every line needs `kind`: `route`, `matrix`, `reach` (or `isochrone`), `compare`, `native`, `info` or `capabilities`. Output is one compact JSON object per line, in input order, echoing `id` and adding a `sequence` number. Blank lines are ignored. Each line may use its own service date; a new date replaces the active timetable, and recently used timetables are retained. An invalid line returns a `vigo.error.v1` object on standard output and the stream continues; a line over 8 MiB ends the stream. Close standard input to finish.

When the stream opens, it prepares modes in the background as `VIGO_PREPARE` selects; a first request waits only for the part it needs. The stream has no query deadline or restart; use `serve` or your own supervisor for those. `--stream-output=detailed` returns `vigo.stream.detail.v1` envelopes holding the internal trace; check that `capabilities.output.streamFormats` lists `detailed` first.

Measure a fresh process's first answer separately from later answers in a resident process.

## HTTP API

`vigo serve` answers the same JSON requests over HTTP. The [OpenAPI document](../standalone-openapi.json) is served at `/openapi.json`; the guide, with an API console at the end of this page, is served at `/`.

### Endpoints

| Method and path | Response | Authentication |
| --- | --- | --- |
| `GET /`, `/docs`, `/docs/` | This guide, offline, with an API console | Public |
| `GET /openapi.json`, `/docs/openapi.json`, `/standalone-openapi.json`, `/docs/standalone-openapi.json` | OpenAPI 3.1 document | Public |
| `GET /healthz` | 200 while the process runs; `status` is `ready` or `recovering` | Public; no City data |
| `GET /readyz` | 200 when a worker is ready, 503 while it recovers | Public; no City data |
| `GET /v1/capabilities` | Features of this executable | Protected |
| `GET /v1/info` | The loaded City or collection | Protected |
| `GET /v1/realtime` | GTFS-RT polling status | Protected |
| `GET /v1/traffic` | NDW polling status | Protected |
| `POST /v1/route` | Route | Protected |
| `POST /v1/matrix` | Matrix | Protected |
| `POST /v1/reach`, `/v1/isochrone` | Reach | Protected |
| `POST /v1/compare` | Compare two saved Reach Results | Protected |
| `POST /v1/native` | A native operation | Protected |
| `DELETE /v1/requests/{id}` | Cancel a named request | Protected |

"Protected" means a bearer token when `VIGO_API_TOKEN` is set, and otherwise a loopback `Host` and same-origin browser requests; see [Authentication](#authentication).

The path selects the query; a body `kind` is overwritten. Send `Content-Type: application/json` with a Content-Length or a bounded chunked HTTP/1.1 body. Conflicting length headers are rejected. Each connection closes after its response: there is no keep-alive, HTTP/2, WebSocket, gzip, streamed response or CORS. Every response carries a restrictive `Content-Security-Policy` that lets the embedded API console call only this service. Query parameters `diagnostics` (or `vigo_diagnostics`), `includeGeometry` and `includeLimitations` set the matching body fields; conflicting values are rejected.

### Server limits

The service runs an HTTP front end and one supervised worker process that keeps the City loaded and answers one query at a time; a query can use several threads. Request bodies are read outside the worker. A worker that times out or fails is stopped and replaced. The service keeps no client sessions.

Server flags set the main limits; see [Server flags](#server-flags). Beyond them:

- Uploads and queued requests share a 64 MiB admission budget, and pending responses a 128 MiB budget. Exhaustion returns 503, before `100 Continue` for uploads.
- Headers are limited to 16 KiB and 64 entries. A worker result is limited to 64 MiB; split large matrices or rasters.
- Writing a response has a 10-second deadline. A worker may take up to 60 seconds to open the City.
- Waiting routes and matrices of up to 1,024 cells get up to 32 turns or 250 ms of worker time before the oldest waiting analytical request, so a batch of Reach jobs cannot starve point queries. The running query always finishes first.

These limits bound transport buffers, not process memory. See [Resource limits](../guides/resource-limits.md).

### Cancel a request

Give a request an `id` of up to 128 letters, digits, hyphens, underscores or periods. `DELETE /v1/requests/{id}` returns 202, and the original request returns 499. Running work is stopped and its worker replaced; queued work is skipped. Reusing an active ID returns 409.

### Status codes

| Status | Meaning |
| --- | --- |
| 200 | A Result, including `not_found` Routes; or metadata and documentation |
| 202 | Cancellation accepted |
| 400 | Invalid query, JSON or HTTP framing |
| 401 | Missing or wrong bearer token |
| 403 | Without a token: a non-loopback `Host`, or a browser `Origin` other than the service's own |
| 404 | Unknown path or method |
| 408 | Request read deadline |
| 409 | The request `id` is already active |
| 413 | Body over the limit |
| 417 | Unsupported `Expect` header |
| 431 | Headers too large |
| 499 | Canceled through `DELETE /v1/requests/{id}` |
| 503 | Connection, queue or buffer capacity exhausted, or worker unavailable; readiness uses it too |
| 504 | Query deadline, worker failure or response failure |

Errors use `schema: "vigo.error.v1"` with `error.code` and `error.message`; handle the code and status, not the message. Retry 503 with backoff. For 504, reduce the work or read the worker log before raising deadlines. A transport error never means a trip is unreachable.

The service logs its address to standard error. If a replacement worker cannot start, the first failure of each streak is logged, `/readyz` and queries return 503, and restarts back off from 250 ms to 10 seconds.

### Authentication

Set `VIGO_API_TOKEN` to protect every `/v1` endpoint, including on loopback, and send `Authorization: Bearer <token>`. A non-loopback `--host` requires a token of at least 16 characters. Set it through your secret store: it is never a command-line argument, and the service does not store tokens or request bodies.

Without a token, a loopback service accepts data requests only when `Host` is `127.0.0.1`, `localhost` or `[::1]` (with an optional port) and any `Origin` is that same `http://` origin; other requests get 403. This blocks DNS rebinding and cross-site requests. A local reverse proxy that sends another `Host` needs a token. The guide, the OpenAPI document and the health endpoints are always public and contain no City data.

```sh
export VIGO_CITY=/srv/vigo/city
# Set VIGO_API_TOKEN through your shell or platform secret store.
vigo serve --host 0.0.0.0 --port 8080 \
  --query-timeout-ms 30000 --max-queue 8 --max-connections 32

curl --fail-with-body http://127.0.0.1:8080/v1/route \
  -H "Authorization: Bearer $VIGO_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @route.json
```

Terminate HTTPS at a reverse proxy, and give its upstream timeout room for the query deadline plus transfer. [Deploy the routing engine](../guide.md#deploy-the-routing-engine) covers containers and process managers.

### Client integration

Any HTTP client works; no VIGO package is needed. A Python standard-library client:

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
if result["status"] == "not_found":
    print("No journey:", result["reason"]["code"])
else:
    print(result["journey"]["arrivalTime"], len(result["journey"]["legs"]), "legs")
```

Read the HTTP status before the body: a 200 body can be a valid `not_found`. Keep bearer tokens on servers; never embed a shared token in public web code. For reproducible work, keep the executable version, `capabilities`, City revision, complete request, observation timestamps and Result together.

## Environment variables

Every variable the engine reads. Command-line flags override the matching variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VIGO_CITY` | — | Default City or collection path; `--city` overrides it |
| `PORT` | 8080 | Default port for `serve` and `health`; `--port` overrides it |
| `VIGO_API_TOKEN` | — | Bearer token for `/v1` endpoints; required, at least 16 characters, for a non-loopback bind |
| `VIGO_PREPARE` | `all` | Modes a single-City `stream` or `serve` worker prepares in the background when it opens: `all`, `none`, or a comma-separated list of `transit`, `walk`, `drive` and `bike`. Transit activates today's timetable in the City's timezone; walk loads the pedestrian hierarchy while no request is waiting; drive and bike open their networks. A request waits only for the part it needs. Collections prepare on first use |
| `RAYON_NUM_THREADS` | Available CPUs | Threads used inside one query |
| `VIGO_MAX_RESIDENT_SCENARIOS` | Collection's `maximumResidentScenarios` | 1–16 collection members kept loaded |
| `VIGO_RESIDENT_HEAP_BYTES` | min(1 GiB, memory ÷ 3) | Retained-heap budget for a collection's resident members; not a process memory limit |
| `VIGO_TIMETABLE_CACHE_BYTES` | 128 MiB, growing; see [Runtime memory](#runtime-memory-and-caching) | Budget for inactive scheduled timetables; `0` disables retention |
| `VIGO_ENDPOINT_CACHE_MAX_BYTES` | 64 MiB per endpoint role, or ÷ 64 of memory | Endpoint-access cache budget |
| `VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES` | 64 MiB, or ÷ 64 of memory | Transit shape cache budget |
| `VIGO_SHAPE_GEOMETRY_CACHE_MAX_ENTRIES` | 1024 | Transit shape cache entries |
| `VIGO_IDLE_RELEASE_MS` | 30000 | After this idle time, a single-City `stream` frees street search scratch; `0` keeps it |
| `VIGO_BIKE_INDEX_DIR` | User cache | Directory for the disposable bicycle hierarchy index |
| `VIGO_MEMORY_ACCOUNTING` | Off | `1` adds result-tree memory accounting to `memory` diagnostics; slows queries |
| `VIGO_BIKE_TRACE` | Off | Any value prints bicycle preparation and search timings to standard error |

The bicycle index lives in the user cache directory (`~/Library/Caches/VIGO` on macOS, `$XDG_CACHE_HOME/vigo` or `~/.cache/vigo` on Linux, `%LOCALAPPDATA%\VIGO\Cache` on Windows). It is derived from the City, holds graph data only, and can be deleted at any time.

`vigo build` also reads these variables. The routing variables change the prepared City and its policy identity; leave them unset for comparable Cities.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VIGO_ROUTING_WALK_SPEED_KPH` | 4.8 | Walking speed, 1.5–8 km/h |
| `VIGO_ROUTING_WALK_PADDING_FACTOR` | 1 | Walking distance multiplier, 0.75–3 |
| `VIGO_ROUTING_WALK_OVERHEAD_SECONDS` | 0 | Seconds added to each walk, 0–900 |
| `VIGO_ROUTING_TRANSFER_RADIUS_M` | 500 | Longest walking transfer between stops, 50–1,200 m |
| `VIGO_ROUTING_TRANSFER_MAX_NEIGHBORS` | 0 (unlimited) | Nearest stops considered for walking transfers, up to 4,096 |
| `VIGO_BUILD_SQLITE_CACHE_KIB` | 32,768 | SQLite page cache of each store `build` writes, 4,096–262,144 KiB |
| `VIGO_READONLY_SQLITE_CACHE_KIB` | 16,384 | Page cache while reading a store for its topology, 4,096–262,144 KiB |
| `VIGO_READONLY_SQLITE_MMAP_BYTES` | 0 | Memory-mapped bytes while reading a store for its topology, up to 2 GiB |
| `VIGO_STREET_ACCELERATOR_MAX_EDGES` | 40,000,000 | Largest pedestrian graph given a snapshot |
| `VIGO_STREET_ACCELERATOR_MAX_STORE_BYTES` | 12,000,000,000 | Largest street store given a pedestrian snapshot |
| `VIGO_DRIVE_ACCELERATOR_MAX_NODES` | 40,000,000 | Largest driving graph given a snapshot, in nodes |
| `VIGO_DRIVE_ACCELERATOR_MAX_EDGES` | 20,000,000 | Largest driving graph given a snapshot, in edges |
| `VIGO_NATIVE_ENDPOINT_WORKSPACE_M` | 1,600 | Walking radius of the endpoint workspaces reserved while preparing access, 100–5,000 m |
| `VIGO_ACTIVE_KERNEL_MAX_BYTES` | Memory ÷ 8, 64 MiB–2 GiB | Largest timetable `--prepare-date` compiles, 1 MiB–16 GiB; a larger date fails the build |
| `VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_BUDGET_BYTES` | min(512 MiB, the limit above ÷ 4) | Prepared timetables kept beside a routing store, 8 MiB–2 GiB; older ones are removed |

Studio and the compiler's runtime read further variables; see [Runtime limits](../developer.md#runtime-limits-and-recovery).

## Runtime memory and caching

A resident `stream` or `serve` process keeps its City, timetables and street indexes ready between requests. This section explains what it keeps and how to account for memory. [Resource limits](../guides/resource-limits.md) explains how to size a deployment.

### Timetables

Opening a City and answering the first transit query for a date prepares that date's timetable, or loads a compiled snapshot (`timing.timetableSource: "prepared_snapshot"`). Prepared timetables cover at least through 06:00 the next day; longer requests extend coverage in six-hour blocks.

Each City retains up to eight inactive scheduled timetables, so switching back to a date or transfer policy reuses its arrays. The default budget is 128 MiB, or 1/32 of a smaller detected memory; without `VIGO_TIMETABLE_CACHE_BYTES`, a single City's budget grows to twice the size of a view it retires, up to 1/16 of memory, so a large City keeps its other service day. Setting the variable fixes the budget; `0` disables retention. Least recently used entries are evicted, and oversized entries are not kept. The two latest realtime views are also kept. Calendar rules load once per City, and equal timetable columns are shared across retained dates. In a collection, a member can borrow unused collection budget without evicting another member's dates.

### Collections

Members share immutable street arrays and hierarchies by path, and equal timetable columns are shared across members. Stop and trip identities, search indexes, endpoint caches and realtime state stay per member. When `maximumResidentScenarios` is reached, the least recently used member is evicted before another opens; the street graph stays. `VIGO_RESIDENT_HEAP_BYTES` also evicts members after a query when the measured retained heap exceeds it; the selected member is always kept, and `residentHeapOverBudget` reports when it alone exceeds the budget. `residency.lastQueryTiming` separates selection, opening, execution and retention.

### Caches and scratch

Endpoint and shape caches have byte budgets shared by all resident members. Street search scratch is allocated only where a query writes; path scratch above 32 MiB and hierarchy workspaces above 64 MiB are dropped after each query. On Linux with glibc, freed pages are returned after timetable preparation, Matrix and Reach, and after `VIGO_IDLE_RELEASE_MS` of idleness. Caches hold prepared data and paths, never answers: every query is computed.

The HTTP supervisor forwards the worker's JSON bytes without rebuilding them. `Server-Timing`'s `serialize` entry measures the supervisor; forwarded results report zero, and serialization in the worker counts in the end-to-end time.

### Memory ledger

`GET /v1/info` (or `vigo info`) reports a `memory` ledger: network allocations, query workspaces, caches, SQLite and mapped file lengths, with shared owners counted once in `trackedHeapBytes`. It also reports `timetablePreparations`, `timetableCoverageEndSeconds`, `memory.timetableCache` (entries, `retainedBytes`, `budgetBytes`, hits, evictions) and `resourcePolicy` (`memoryCapacityBytes`, `swapCountsAsRam`). Vector capacities are counted; hash-table and JSON overheads are estimates; mapped file lengths are not resident memory. Record process RSS or PSS and cgroup memory alongside the ledger. `sourceArrayBytes` counts logical column contents, including shared values; never sum it as exclusive memory.

## Native operations

Native operations call the routing kernels directly with packed arrays. They are diagnostic and research tools outside the public stability policy. Use `vigo native --city ./city --request query.json` or `POST /v1/native` with `operation`, `input` and, for timetable operations, `serviceDate`. Native indices belong to the loaded City and service date. The HTTP API never accepts a file path in a query.

```json query=native
{
  "operation": "timetable.identifiers",
  "serviceDate": "2026-07-15"
}
```

`timetable.identifiers` returns `stopIds`, `tripIds`, `routeIds` (one per active trip) and `accessMemberStopIds`. An index is a position in these arrays. Offset arrays start at zero, end at their packed array's length and have one more entry than their groups; parallel arrays must have equal lengths.

A street path needs coordinates only:

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

Native `departure`, `horizon`, `earliest` and `deadline` are absolute **service-day seconds**: native `horizon` is an end clock, while `horizonMinutes` is a duration. `maximumBoardings` is a transfer cap plus one. Walking times and transfer arrays are seconds; distances are meters; drive traffic weights are hundredths of a second. `queryNs` is nanoseconds.

Native Matrix returns flat **clock times in seconds**: arrivals for depart-at, departures for arrive-by, null where unreachable. `timetable.pareto` exposes the arrival, boarding and walking frontier. `realtime.compile` compiles explicit call times; it does not fetch feeds. `places.describe` labels up to 256 coordinates with nearby street, area or stop names from the City, in parallel `labels` and `kinds` arrays; labels never change routing. `timetable.prepare`, `street.prepare`, `bike.prepare` and `drive.prepare` load a mode without routing.

The [native field reference](../reference/rust-standalone-native.md) lists every operation's input and result type, generated from the Rust definitions.

## Validation and compatibility

`vigo capabilities` describes the executable you run.

### Supported operations

| Operation | Modes and coverage |
| --- | --- |
| Route and Matrix | Transit, walk, drive and bike; depart-at and arrive-by |
| Reach | Transit, walk, drive and bike; depart-at and arrive-by |
| Scenarios | Reach with exclusions, planned services or compiled overlays; transit Route with exclusions and planned services |
| Realtime transit | Route, Matrix and Reach; supplied or polled, with Service Alerts |
| Supplied traffic | Drive Route and Matrix |
| Compare | Reach surfaces |
| Monte Carlo | Scheduled depart-at transit Route, Matrix and Reach |

The engine does not combine planned branch edits into schedules or optimize fares. Prepare those inputs with the compiler or Studio.

### Platform and build records

Release archives are built and tested for Linux x64 and ARM64 (glibc 2.39 or newer, built on Ubuntu 24.04), macOS ARM64 and Windows x64. For an older Linux, build from source on that system. `manifest.json` records the target, source commit, uncommitted-change flag, source digest and file hashes; a `dirty: true` package is a development build. Keep the manifest with a deployment. The [verification record](../reference/rust-standalone-audit.md) lists the checks a release passes.

### Run the checks

From a source checkout:

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

The documentation check builds the fixture City, runs every request on this page against the engine, compares the response excerpts, checks that every command-line flag, request field and environment variable is documented, and serves the guide over HTTP. Passing checks establish the tested model, not field accuracy, station accessibility or deployment capacity.
