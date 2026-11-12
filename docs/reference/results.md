# Public results

The engine, the compiler, the resident stream and the HTTP API return one public Result format. This page explains how to read it. The [API schema](api-schema.md#result-schemas) lists every field with its type, generated from the engine's result types.

## Version policy

Each Result names its `schema`: `vigo.route.v1`, `vigo.matrix.v1`, `vigo.reach.v1`, `vigo.compare.v1`, `vigo.distribution.v1` or `vigo.error.v1`. Within a `v1` schema, required fields keep their names, types, units and meanings; new optional fields may appear. Removing or renaming a field, changing a unit, or changing a status meaning requires a new schema version. Clients should ignore fields they do not know.

`trace`, native operations and Studio's internal messages are outside this policy. Result schema versions are independent of the [City format](city-format.md) and of the executable version, which `meta.engineVersion` reports.

## Read a Result

Read `status` first:

| `status` | Meaning | Exit code / HTTP |
| --- | --- | --- |
| `ok` | The query completed with an answer | 0 / 200 |
| `not_found` | A valid outcome: nothing satisfies the request (Route) | 0 / 200 |
| `error` | The request was invalid or failed; see `error` | 2 / 4xx or 5xx |

Every Route, Matrix and Reach Result also carries:

| Field | Meaning |
| --- | --- |
| `schema` | The schema name and version |
| `mode` | `transit`, `walk`, `drive` or `bike`; for transit, the mode actually returned can be `walk` |
| `query` | The normalized request: places in public form, `serviceDate`, `requestedTime`, `timePreference`, `dataMode` |
| `meta` | How the Result was computed; see [Metadata and reproducibility](#metadata-and-reproducibility) |
| `warnings` | Qualifications of the answer, each with a `code` and a `message`; absent when none |
| `id`, `sequence` | The caller's `id`, and the line number on a stream |
| `scenarioId` | The collection member used, when the City is a collection |
| `accessibility` | The wheelchair profile, its street evidence and limitations, in a wheelchair City |
| `datasetLimitations` | The City's limitations, with `includeLimitations: true` |

In a terminal, Route prints a short itinerary. Pipes, `--output` and `--format json` produce JSON; `--format text` asks for the terminal view.

## Route

`vigo.route.v1` holds one `journey`, or `null` when `status` is `not_found`.

### Journey

| Field | Meaning |
| --- | --- |
| `departureTime`, `arrivalTime` | Service-day clocks, `HH:MM:SS`; hours can exceed 23 |
| `clockDate` | The date those clocks count from; `null` for a walk or drive without a service date |
| `durationSeconds` | Arrival minus departure |
| `walkingSeconds`, `ridingSeconds`, `waitingSeconds` | Time walking, on vehicles, and in the gaps before and between legs |
| `drivingSeconds`, `cyclingSeconds` | Time driving or cycling, in those modes |
| `boardings`, `transfers` | Vehicles boarded; `transfers` is `boardings − 1` |
| `legs` | The chronological legs |
| `expandedWalkingLimitKm` | Present on a choice found with a wider walking limit |

Durations are whole seconds, rounded at the public boundary; the search keeps full precision. Waiting is the gaps between legs, not a reliability margin. An arrive-by journey can arrive before the deadline.

`alternatives` holds further distinct journeys, without the primary or duplicates, and is omitted when there are none. `alternativeSearch` records how they were found: requested alternatives (`coverage: "requested_time"`) or a journey window (with its sampling direction). See [alternative journeys](../guides/rust-standalone.md#alternative-journeys) and [journey windows](../guides/rust-standalone.md#journey-windows).

### Legs

Every leg has `type`, `from`, `to`, `departureTime`, `arrivalTime`, `durationSeconds`, an optional `distanceMeters`, optional GeoJSON `geometry`, and a `quality`.

| `type` | Leg |
| --- | --- |
| `walk` | A continuous walk; street and station pieces are listed in `components` |
| `transit` | One ride on one trip |
| `drive`, `bike` | Driving or cycling |

`from` and `to` are places: a `coordinate`, plus `stop` and `name` at a stop. Stops, routes, trips and services are identifiers of the form `{"feed": "mbta", "id": "70067"}`; `feed` is `null` in a single-feed City. Requests accept the same form, `{"stop": {"feed": "mbta", "id": "70067"}}`, or the plain `{"stopId": "70067"}`.

A transit leg adds `route` (with `id`, `shortName`, `longName`, `type` and `color`), `trip`, `service`, `serviceDate`, `headsign`, `tripShortName`, `directionId` and `intermediateStops` with their times. It can also carry:

- `fare`: the published fare for a new boarding (`status: "published"`, with the fare `standard`, `options` and `source`), or why there is none (`status: "unavailable"`, with a `code` such as `missing_catalog` or `no_rule`, and a `reason`). See [Published fares](../guide.md#published-fares-on-itineraries).
- `alerts`: Service Alerts active during the ride, from a realtime snapshot.
- `continuation`: `{"type": "stay_aboard", "durationSeconds": 300}` when an explicit GTFS link keeps the rider aboard from the previous leg. That time is riding, not waiting.
- `quality.flex`: the assumptions and booking rules of a GTFS Flex ride.

Geometry is included by default for Route (`includeGeometry: false` omits it) and is opt-in for Matrix journeys. A transit line runs from the boarding stop along the aligned GTFS shape to the alighting stop, and its `distanceMeters` is that line's length. Geometry is the modeled path, not a vehicle trace or a surveyed station interior. If any piece of a walk lacks geometry, the leg omits its line rather than drawing across the gap.

`journey.sharedLegAlternatives` appears with `sharedLegs: true`; its options and frequencies are described in [shared-leg services](../guides/rust-standalone.md#shared-leg-services). Their `legIndex` values refer to this leg list.

### No journey

A `not_found` Route has `journey: null`, a `reason` with `code` and `message`, and an `access` report for each end that explains how far walking reached. [When no journey is found](../guide.md#when-no-journey-is-found) lists the codes. A `not_found` Result is a complete answer: keep it, and never replace it with zero.

## Keep uncertainty with the answer

Each leg's `quality` says what its evidence is:

| Field | Values |
| --- | --- |
| Transit `quality.geometry` | `gtfs_shape` (aligned to the feed's shape), `stop_sequence` (straight lines between stops) or `unknown` |
| Transit `quality.schedule` | `timetable` (scheduled times), `source_time_limitations` (the feed repeats times or bridges untimed stops), `realtime` (an applied prediction) or `flex_estimate` |
| Walk `quality.geometrySource` | `osm`, `osm_and_station_path`, `gtfs_pathway`, `station_selection`, `unverified_transfer` or `unknown` |
| Walk `quality.streetGeometry` | `verified` when the street part is a path in the prepared graph, otherwise `unverified` |
| Walk `quality.stationPath` | `source_path` (declared pathways) or `inferred` (an assumed station link) |
| Walk `quality.stationTime` | `estimated` when untimed stairs or gates use VIGO's estimates |

A verified street path does not certify a complete entrance-to-platform path, and `timetable` means scheduled, not observed, times. A walk that starts or ends off the street network reports the straight hop as `endpointConnector`, with `streetPathVerified: false`. `components` separates street and station costs and names their sources. [Walking evidence](walking-evidence.md) explains station costs.

No warnings does not certify complete source coverage. City-level limitations are in `vigo info` and `GET /v1/info`, or in a Result with `includeLimitations: true`; unsupported GTFS features are in [Known limits](../guide.md#known-limits).

## Matrix

`vigo.matrix.v1` returns `durationsSeconds[origin][destination]` in request order, with the endpoints echoed in `query`. Unreachable cells are `null`, never zero, and a completed matrix can contain both.

- Depart-at: seconds from the shared departure to arrival.
- Arrive-by: seconds from the latest departure to the shared deadline, including any wait after an early arrival. The nested journey shows the actual arrival.
- `journeys[origin][destination]`: with `includeJourneys: true`, a journey or `null` per cell.
- `distancesMeters`: for Walk, Drive and Bike, distances in the same order.
- `access`: access reports keyed by endpoint index, when an endpoint could not reach the network.

## Reach

`vigo.reach.v1` returns:

| Field | Meaning |
| --- | --- |
| `cutoffsSeconds` | The cutoffs, sorted |
| `surface` | `width`, `height`, `bounds` and `valuesSeconds`, row-major from the northwest cell; `null` where unreached |
| `fullSurface` | The same grid over the full reached extent, when it differs |
| `areas`, `contours` | GeoJSON FeatureCollections for the requested grid; each feature names its cutoff |
| `fullAreas`, `fullContours` | The same for the full extent |
| `stops` | Reached stops and when; `scenarioStops` lists stops a scenario added |
| `surface.edges`, `surface.nodes` | Street evidence with `includeStreetEdges` and `includeNodes` |
| `allDay` | The sample count and window of an [all-day Reach](../guides/rust-standalone.md#all-day-reach) |

Cell order is row-major from the northwest; [Read the surface](../guides/rust-standalone.md#read-the-surface) gives the cell-center formula. Areas are cumulative: the 30-minute area includes the 15-minute area.

With `reachFormat: "map"`, the Result contains only `areas` and `bounds` for the full reached extent; its polygons equal `fullAreas` of the default format. With `reachFormat: "surface"`, polygons and contours are not built. Use the full format for comparisons.

## Compare saved results

`vigo.compare.v1` reports changes between two saved Results without routing again. Changes are **after minus before**, in seconds.

| Family | Fields |
| --- | --- |
| Route | `durationChangeSeconds` and `transferChange`; `null` when either Result has no journey |
| Matrix, Reach | `counts` (`comparable`, `faster`, `slower`, `unchanged`, `newlyReachable`, `noLongerReachable`) and `meanChangeSeconds` |

`beforeStatus`, `afterStatus` and `cityRevisions` identify the inputs. `meanChangeSeconds` averages only entries reachable in both, and is `null` when there are none; new and lost reachability are counted separately. Matrix comparison requires identical ordered endpoints, and Reach comparison the same grid. Compare does not check that dates, times, modes or walking limits match: align them yourself. The engine compares Reach only; the compiler also compares Route and Matrix.

## Distributions

`vigo.distribution.v1` is returned by a Route, Matrix or Reach request with `monteCarlo`. `durationsSeconds[p]` holds the `p`-th requested percentile for every destination or cell, with `null` meaning unreachable in that share of samples. `reachableSamples` counts finite outcomes. `sampling` and `assumptions` record the method. See [Monte Carlo](../guides/monte-carlo.md#reading-the-result).

## Errors

`vigo.error.v1` has `status: "error"` and `error` with a `code` and a `message`. Handle the code and the HTTP status, never the message text. Codes include `invalid_request`, `stop_not_found`, `scenario_not_found`, `unsupported_mode`, `file_not_found`, `permission_denied` and `city_unavailable`, and transport codes such as `unauthorized`, `request_timeout`, `query_timeout`, `query_canceled`, `request_id_conflict` and `service_unavailable`. On a stream, an error is one output line and later lines still run.

## Diagnostics

| Level | Adds |
| --- | --- |
| `none` (default) | Nothing |
| `summary` | `diagnostics`: search counters and candidate counts |
| `profile` | Also `profile.timingsUs`: measured timings in microseconds |
| `trace` | Also `trace`: the full internal result |

Set the level with `--diagnostics`, a `diagnostics` field, or the `?diagnostics=` (also `?vigo_diagnostics=`) query parameter; conflicting values are rejected. Counters without instrumentation are omitted, never invented. `scannedDepartures`, `expandedTripRuns` and `relaxedStops` count algorithm work, not network size or distinct stops. Profile scopes can overlap; never add them. `summary` and `profile` describe each runtime's own instrumentation and are not comparable across runtimes.

`trace` is an unstable debugging interface: internal indices, sentinels and duplicate units stay there. The [trace reference](../guides/rust-standalone.md#trace-output) documents it. `stream --stream-output=detailed` returns the same trace in a `vigo.stream.detail.v1` envelope without building the public Result; its `status: "ok"` means execution completed, so read the trace's own routing status. Clients must check that `capabilities.output.streamFormats` lists `detailed`; VIGO Python does this automatically.

## Metadata and reproducibility

`meta` records how a Result was computed:

| Field | Meaning |
| --- | --- |
| `engineVersion` | The executable's version |
| `cityRevision` | The City build used |
| `requestId` | The caller's `id`, or a generated identifier |
| `queryFingerprint` | Hash of the complete request (stop references canonicalized, output switches excluded), the City revision and the engine version |
| `assumptionsFingerprint` | Hash of the routing assumptions, without scenario and observation content |
| `scenarioFingerprint`, `realtimeSnapshotFingerprint` | Hashes of supplied scenario and realtime content |
| `computeUs`, `computeScope` | Microseconds for service-date activation, search and Result construction (`query_dispatch_including_materialization`); excludes formatting, serialization, queueing and the network |
| `realtime`, `traffic` | Admission and coverage of supplied observations |

The query fingerprint includes scenario content, via points, alternative settings and the identity of an admitted live snapshot, and excludes `id`, `diagnostics`, `includeGeometry`, `includeLimitations` and `reachFormat`. Equivalent requests written differently, such as `time` and `timeMinutes`, can hash differently. Compare Results only when their `assumptionsFingerprint` values match, or when you have checked the differing assumptions yourself. `Server-Timing` headers report serialization, compute and, on the engine, queue time; measure client wall time separately.

## Keep a reproducible run

Keep together: the City (or its revision and sources), the original request, the executable version and `capabilities`, any supplied scenario, realtime snapshot or traffic, and the complete Result. The `query` echo and the fingerprints identify these inputs but do not archive them. For a source-data audit, also keep a `diagnostics: "trace"` Result.

Python Results use `ready` and `blocked`, minutes, and their own properties; see the [Python Results guide](../../python/docs/guide.md#results).
