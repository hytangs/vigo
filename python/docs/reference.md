# Python reference

Install the package and runtime using the [README](../README.md). Examples use a complete City; substitute its exact stop IDs, coordinates, and covered service dates. For complete scripts, use [Workflows](guide.md#workflows).

[Open](#open-a-city) · [Build](#build-a-city) · [Points and time](#points-and-time) · [Route](#route) · [Matrix](#matrix) · [Reach](#reach) · [Scenario](#scenario) · [Result](#result) · [Job](#job) · [Errors](#errors)

## Open a City

A City is one complete directory built from GTFS and OSM. It moves as one unit. `vigo.open(city, *, runtime=None, timeout=120.0)` returns a `City`; paths may be strings or path-like objects. `timeout` controls Query execution in seconds, not total context-manager lifetime.

```python
import vigo

city = vigo.open("./boston")
```

Use a context manager when you want VIGO to release resident runtime resources immediately:

```python
with vigo.open("./boston") as city:
    result = city.route(
        "place-pktrm",
        "place-dwnxg",
        depart_at="08:00",
        service_date="2026-09-04",
    )

print(result.status, result.duration_minutes)
```

Coordinates always use `[longitude, latitude]`:

```python
with vigo.open("./boston") as city:
    result = city.route(
        [-71.062, 42.356],
        [-71.058, 42.349],
        mode="walk",
        depart_at="08:00",
        service_date="2026-09-04",
    )
```

`city.path`, `name`, `revision_id`, `built_at`, and `sources` identify the opened model. `details` returns its manifest; `capabilities` returns the selected runtime's advertised capabilities. `city.runtime` is the resolved `RuntimeInfo`. `close()` releases resident processes; already returned Results remain usable.

## Build a City

`vigo.build(output, *, gtfs, osm, private_access="public", street_modes="walk,drive", replace=False, runtime=None, timeout=1800.0, progress=False)` writes one complete City and returns it opened for queries. `gtfs` accepts one ZIP path or a sequence of paths; `osm` accepts one OSM PBF path.

```python
with vigo.build(
    "./boston",
    gtfs=["./mbta.zip"],
    osm="./massachusetts.osm.pbf",
) as city:
    print(city.name, city.revision_id, city.built_at)
    print(city.sources)
```

Use `street_modes="walk"` for a walking/transit-only City; the default `"walk,drive"` also prepares driving data.

Pass `replace=True` only when you intend to replace an existing City.
Pass `progress=True` to show Build stages and elapsed time with the optional
`tqdm` dependency. It defaults to `False`; see [Runtime and loading](guide.md#runtime-and-loading)
for installation and separate raw-build, first-query, and reopening timings.

For travelers authorized to use internal roads at their own origin and destination,
pass `private_access="endpoints"` to `vigo.build()`. The default is `"public"`.
The endpoint model includes mapped private access walks within the walking budget;
the public middle of a journey and transit transfers cannot use private shortcuts.
It assumes endpoint authorization and does not infer ownership or gate hours.
The runtime must advertise endpoint access before Build.

`timeout` here bounds the build command. The returned City uses the default 120-second Query timeout; reopen it with `vigo.open(..., timeout=...)` when longer Query limits are needed. Runtime discovery and capability checks have their own limits. See [Runtime and loading](guide.md#runtime-and-loading).

## Points and time

| Input | Example | Meaning |
| --- | --- | --- |
| Stop ID | `"A"` or `{"stopId": "A"}` | Exact ID in this City; no name lookup or geocoding |
| Structured stop | `{"stop": {"id": "A", "feed": "feed-id"}}` | Public Engine stop reference; omit `feed` for an unambiguous stop |
| Coordinate pair | `[-71.062, 42.356]` | Longitude, then latitude |
| Coordinate mapping | `{"coordinate": [-71.062, 42.356]}` | Explicit point object |
| Matrix point set | `{"home": [-71.062, 42.356]}` | Caller ID mapped to a point |
| Matrix point sequence | `["A", "B"]` | Auto-generated IDs such as `origin_1` and `origin_2` |

Point mappings use the Engine fields `stop`, `stopId`, or `coordinate`. Use `[longitude, latitude]` or a `coordinate` mapping for coordinates. Python does not interpret `stop_id`, `lat`, `lon`, or `lng` as point aliases.

A numeric pair is one coordinate point, not two Matrix endpoints. A mapping with a point key such as `stop`, `stopId`, or `coordinate` is one point, not an ID-to-point set. Use descriptive, unique caller IDs for Matrix sets. The complete [Engine point contract](https://github.com/hytangs/vigo/blob/main/docs/guide.md#route-1) describes stop access semantics.

Time arguments accept `HH:MM`, `datetime.time`, or `datetime.datetime`. A datetime supplies its date unless an explicit `service_date` overrides it. Datetime timezone information is not converted; seconds are omitted. Pass a clock already expressed in the feed's local service time.

String clocks support service-day hours through `29:59`. For example, `depart_at="25:15", service_date="2026-09-04"` means 01:15 on the following civil day within the September 4 service day. Changing the date to September 5 changes which service calendar is selected. `service_date` accepts an ISO date string or `datetime.date` and remains required for all modes unless supplied by a datetime.

## Route

Transit Route and Matrix compare a feasible direct walk by default. Use `require_transit_ride=True` to require a vehicle boarding, or `mode="walk"` for a walking journey. `horizon_minutes` sets the transit search horizon (1–2880 minutes; default 480).

Route includes point-to-point, depart-at, arrive-by, departure-window, walking, driving, and batch use.

| Argument | Default | Meaning |
| --- | --- | --- |
| `origin`, `destination` | Required | Exact stop IDs, coordinate pairs, or point mappings |
| `waypoints` | Empty | Intermediate points in the given order |
| `mode` | `"transit"` | `"transit"`, `"walk"`, or `"drive"` |
| `depart_at` / `arrive_by` | One required | `HH:MM`, `datetime.time`, or `datetime.datetime` |
| `service_date` | Required unless time is a datetime | ISO date string or `datetime.date`; interpreted on the feed's local service day |
| `max_walk_km` | `1.2` | Each transit access and egress walking budget |
| `departure_window_minutes` | `0` | Depart-at window of plus or minus 0–30 whole minutes |
| `objective` | `"earliest_arrival"` | The supported objective |
| `max_transfers` | `None` | Optional cap, 0–31 changes |
| `require_transit_ride` | `False` | Require at least one vehicle boarding |
| `horizon_minutes` | `480` | Timetable search horizon, 1–2880 minutes |
| `disable_cache` | `False` | Disable transit street-access and walking-path caches |

Choose departure or arrival time, never both. A nonzero departure window applies to depart-at only.

```python
route = city.route(
    "A",
    "B",
    arrive_by="09:00",
    service_date="2026-09-04",
    objective="earliest_arrival",
)

requests = [
    vigo.Route("A", "B", depart_at="08:00", service_date="2026-09-04"),
    vigo.Route("C", "D", depart_at="08:15", service_date="2026-09-04"),
]
results = city.run(requests)
```

`City.run(query)` and `Scenario.run(query)` are the execution primitives. `city.route(...)`, `city.matrix(...)`, and `city.reach(...)` are convenience constructors with exactly the same behavior. A sequence executes in input order and returns a list; it stops at the first exception. Use an explicit [batch loop](guide.md#retain-every-batch-outcome) to retain failures individually.

Depart-at minimizes arrival time, then boardings, then walking. Arrive-by maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, then walking, then actual arrival.

`Route` and `Matrix` accept `max_transfers=0` for at most one boarding,
`max_transfers=1` for at most two, and so on through 31. Omit the option
(or use `None`) for no additional cap. It applies to both `depart_at` and
`arrive_by` and all Matrix shapes. A finite cap with ordered transit
waypoints is currently unsupported. The runtime must advertise transfer-cap
support; Python rejects this option when its capability is absent.

With the bundled engine, Route, Matrix, and Reach reuse resident processes by service date. Route answers themselves are recomputed. See [process lifetime](guide.md#keep-a-city-open) for concurrency and resource lifetime.

For transit Route and Matrix measurements, `disable_cache=True` disables
street-access frontier and reconstructed walking-path caches. It keeps the
prepared City resident. Python requires the runtime to advertise this control;
a missing capability raises `UnsupportedQuery`. `Result.to_json(indent=None)`
returns compact JSON, including the complete itinerary and geometry.

## Matrix

One origin and many origins use the same method:

```python
matrix = city.matrix(
    {"home": [-71.062, 42.356]},
    {
        "school": [-71.058, 42.349],
        "hospital": [-71.071, 42.361],
    },
    depart_at="08:00",
    service_date="2026-09-04",
)

for row in matrix.rows:
    print(row["originId"], row["destinationId"], row["status"], row["durationMinutes"])
```

Use `mode="walk"` or `mode="drive"` for street matrices.

The Matrix Result is `ready` when the computation completes; some or all of its rows may still be blocked. Count row outcomes before aggregating durations. See [Matrix results](guide.md#matrix-1).

`origins` and `destinations` accept a point, a mapping of caller IDs to points, or a sequence of points. Matrix shares Route's mode, date, time constraint, walking budget, objective, transfer cap, transit requirement, horizon, and cache control. It defaults to an `08:00` departure when neither time constraint is supplied. Matrix has no waypoints or departure window.

| Additional argument | Default | Meaning |
| --- | --- | --- |
| `walk_speed_kph` | `4.8` | Walking Matrix speed |
| `max_distance_km` | `None` | Optional street distance limit |
| `include_journeys` | `False` | Add timed transit journeys to ready rows |
| `include_geometry` | `False` | Add geometry; requires `include_journeys=True` |

Transit supports both `depart_at` and `arrive_by` with one-to-many, many-to-one,
or many-to-many endpoint sets, up to 100,000 pairs per request. For a morning
school trip, use `city.matrix(assigned_homes, {"school": school},
arrive_by="08:30", service_date="2026-07-15")`; for dismissal, reverse the
endpoint sets and use `depart_at="15:00"`. A common origin and departure share one forward scan; a common destination and arrival deadline share one reverse scan. Other shapes use one scan per unique origin or destination, respectively.
Arrive-by rows report the latest `departMinutes` and the deadline as
`arriveMinutes`; `durationMinutes` includes waiting after early arrival.
Use Route to obtain actual itinerary arrival and legs. This requires a VIGO
runtime whose Matrix capabilities include `arrive_by`.
Successive Matrix and transit Route queries on the same City and service date
reuse one resident process. Keep the City open while iterating over schools so
the network is loaded once. Closing the City releases those processes. Matrix
requires a runtime that advertises resident Matrix support; a missing capability
raises `UnsupportedQuery` before execution.

For transit matrices, `include_journeys=True` adds actual arrival, walking,
waiting, ride time, transfers, and timed trip/stop legs to each ready row's
`journey`. Add `include_geometry=True` to materialize those selected paths with
the same renderer as Route, without repeating timetable searches. The runtime
must advertise journey support. Equal-objective paths can differ from Route's
stable traversal order. The outer arrive-by row still reports the deadline;
the nested journey reports actual arrival.

## Reach

Reach answers where the modeled network can travel within stated time limits. It does not count people, jobs, schools, or other opportunities.

Reach accepts `origin`, `service_date`, and `depart_at` (default `"08:00"`). It supports scheduled transit with walking and walking-only Reach. Driving Reach is unavailable.

| Argument | Default | Meaning |
| --- | --- | --- |
| `mode` | `"transit"` | `"transit"` or `"walk"`; walking requires advertised runtime support |
| `surface_sampling` | `"street"` | `"street"` for reachable network edges, or `"cell-center"` for coordinate cell centers |
| `include_street_edges` | `False` | Include reached street edges in the surface; adds output size |
| `cutoffs_minutes` | `(15, 30, 45, 60)` | Increasing cutoffs, each 1–240 minutes |
| `max_walk_km` | `1.2` | Transit access and terminal walking budget |
| `walk_speed_kph` | `4.8` | Walking speed, 1–8 kph |
| `extent_radius_km` | `8` | Computation radius, 1–40 km |
| `raster_size` | `96` | Grid side length: 48, 64, 96, 128, 192, 256, 384, 512, or 1024 |

```python
reach = city.reach(
    [-71.062, 42.356],
    depart_at="08:00",
    service_date="2026-09-04",
    cutoffs_minutes=[15, 30, 45, 60],
    extent_radius_km=8,
)

reach.export("reach.geojson")
```

Use the word Accessibility only when a separate analysis combines travel impedance with opportunities.

`extent_radius_km` bounds the computed area, not just the display. `raster_size` changes the grid resolution. Keep both fixed, together with the origin and other assumptions, when comparing a baseline and a Scenario.

## Scenario

`city.scenario(name, *, services=(), without_routes=(), live=None, traffic=None, expires_at=None)` returns an immutable Scenario tied to that City revision. It exposes the same `run`, `route`, `matrix`, `reach`, `supports`, and `submit` methods. Query options such as walking limits remain Query parameters.

| Scenario state | Supported Python Queries |
| --- | --- |
| No changes | The City's supported Queries |
| `services` and/or `without_routes` | Transit Reach; walking-only Reach rejects planned transit changes |
| `traffic` | Drive Route and Matrix, with advertised supplied-traffic capability |
| `live` | Unavailable through Python |
| Combined planned, live, or traffic states | Unsupported |

`services` accepts mappings following the Engine's [service change contract](https://github.com/hytangs/vigo/blob/main/docs/guide.md#scenario-semantics). `without_routes` accepts exact route IDs. `traffic` is a supplied snapshot; constructing a Scenario does not fetch observations or establish their validity. The runtime validates the snapshot when executing a supported query. Python sends traffic in explicit realtime mode for Drive Route and Matrix; scheduled transit remains separate.

Nested Scenario inputs are copied and frozen. `expires_at` is an optional datetime checked before execution; expired Scenarios raise `VigoError`. A Scenario does not alter the City's baseline. Follow the [service proposal workflow](guide.md#compare-a-service-proposal) for a complete example.

Inspect support before running a context-dependent Query:

```python
with vigo.open("./boston") as city:
    proposal = city.scenario("Route removed", without_routes=["route-to-remove"])
    query = vigo.Reach([-71.062, 42.356], service_date="2026-09-04")
    support = proposal.supports(query)
    print(support.supported, support.reason, support.available)
```

`Support` contains `supported`, `reason`, and `available`. The check reports supported combinations and selected option constraints; it does not fully validate endpoints, service coverage, Scenario expiry, or all runtime inputs. A supported Query can still fail during execution or return a blocked Result.

## Result

Every Query returns `Result` with the same basic shape. Result properties return independent copies; `to_json(indent=None)` avoids an intermediate full-result copy:

```python
result.kind
result.status
result.query
result.warnings
result.timing
result.record
result.export("result.json")
```

Route Results add `duration_minutes` and `legs`. Matrix Results add `rows` and `iter_rows()`. Iteration copies only the rows consumed and yields independently mutable dictionaries. The complete Engine response is already in memory; this is not streaming computation. CSV export reads stored rows directly without creating a second matrix. Both Route and Reach support `to_geojson()`. `value` exposes the family-specific answer; `to_dict()` returns the complete Engine payload.

`iter_journeys()` yields one summary per Route or Matrix row, including blocked rows, without legs or geometry. `hasJourney` and `legCount` distinguish omitted itineraries from empty ones. `iter_legs(include_geometry=False)` yields one record per supplied leg; Matrix queries need `include_journeys=True`. Both retain native field names and units, add `journeyIndex`, `cityRevisionId`, `scenario`, and `resultStatus`, and return independent records. Leg records also carry `legIndex`, row status, and available origin/destination IDs and indices. `journeyIndex` is local to one Result; add a study ID when combining Results. Reach and comparison Results raise `TypeError` for these methods.

See [Results](guide.md#results) for fields, export formats, row outcomes, and comparison limits. `vigo.compare(before, after)` and `before.compare(after)` return a comparison Result without rerunning the Queries. Matrix comparisons require `originId` and `destinationId` on every row and match those IDs rather than row positions. The caller must align the study inputs; comparison does not validate all Query assumptions.

`result.export_tables(directory, include_geometry=False)` writes `journeys.csv`, `legs.csv` and `record.json`. It discovers optional columns in one pass and writes them in a second without materializing an extra table. Nested fields are JSON encoded; missing values are blank. Empty tables retain their respective journey and leg headers. Serialization finishes before existing export files are replaced, so serialization errors leave an earlier export intact. Use a separate directory per Result when concurrent readers need a consistent multi-file snapshot.

`Result.status` is only `ready` or `blocked`. A blocked Result is a valid computation with no usable journey or surface. Cancellation and execution failures belong to `Job.status` or exceptions, not Result status.

## Job

`city.submit(query)` or `scenario.submit(query)` returns a `Job`. Pass one Query or a sequence; `wait()` returns one Result or a list respectively. Background submission keeps the calling Python thread available; it does not promise parallel queries for the same service date.

Keep the City open until its submitted work finishes:

```python
with vigo.open("./boston") as city:
    query = vigo.Matrix(
        {"home": [-71.062, 42.356]}, {"school": [-71.058, 42.349]},
        depart_at="08:00", service_date="2026-09-04",
    )
    job = city.submit(query)
    result = job.wait()
```

`Job.status` is `queued`, `running`, `ready`, `cancelled`, or `error`. A ready job may contain a blocked Result.

`Job.cancel()` cancels queued work only. A running Query finishes normally.
`Job.wait(timeout=...)` bounds the wait for the background result; it does not cancel the Query.
See [Runtime and loading](guide.md#runtime-and-loading) for process reuse and timing boundaries.

## Errors

| Exception | Meaning |
| --- | --- |
| `InvalidQuery` | Python-side query validation failed; also a `ValueError` |
| `UnsupportedQuery` | A combination or option is unsupported; `.support` contains the reason and alternatives |
| `VigoTimeoutError` | A runtime operation exceeded its timeout; also a `TimeoutError` |
| `VigoError` | Base class for VIGO failures, including runtime validation, incomplete Cities, execution failures, and the subclasses above |

Python constructor misuse can also raise ordinary `TypeError` or `ValueError`; export can raise filesystem errors. `Job.wait()` re-raises the background exception. Its own wait timeout raises `TimeoutError` without cancelling the Query. No exception is converted into a blocked Result.

## Runtime information

`vigo.resolve_runtime(runtime=None, *, verify=True)` returns `RuntimeInfo` with `product_version`, `api_version`, `source`, `path`, `command`, and `capabilities`. Use the default verification for Query execution. `verify=False` only resolves a candidate command and returns no verified capabilities; it is not a compatibility check.

A runtime argument can be a `RuntimeInfo`, a path to a supported runtime layout or executable, or a sequence of command arguments. See [Runtime and loading](guide.md#select-a-runtime) for selection, compatibility, and platform requirements.

[Documentation](guide.md#routing-from-python-without-rebuilding-the-network) · [Workflows](guide.md#workflows) · [Troubleshooting](guide.md#troubleshooting)

The Python wrapper negotiates the resident CLI’s detailed stream format when advertised. It preserves the same complete `Result` while avoiding a second public projection. Earlier compatible 0.5 runtimes continue to use `--diagnostics=trace`.

## Concurrent jobs and resource limits

`City.submit` and `Scenario.submit` share a process-wide limit of 32 running or pending jobs. When capacity is full, submission raises `VigoError`; retry after work finishes. A canceled queued job keeps its capacity slot until the executor dequeues it, so repeated submit/cancel cannot accumulate an unbounded queue. Canceling a running job remains unsupported.

A resident stream serializes requests for its service date. Different dates can use the bounded City process pool. The query timeout covers writing to the engine pipe and waiting for its response; a stalled pipe terminates the child and releases its buffers. Waiting for a free stream has its own timeout using the City's timeout value.

The Python stream accepts requests up to 8 MiB of UTF-8 JSON and responses up to 64 MiB. Oversized requests raise `VigoError` before dispatch; oversized responses discard the worker. Split larger matrices or omit optional journey geometry. Response queues and stderr retention are bounded, and idle reader/writer threads release completed response/request buffers.
