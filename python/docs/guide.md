# VIGO Python 0.5.2 guide

Canonical source for the [documentation reader](index.html). Edit the relevant chapter, then rebuild the reader.

## Routing from Python, without rebuilding the network.

VIGO Python 0.5.2 gives scripts and notebooks a small set of objects for transport analysis. Build or open a City, run Route, Matrix, or Reach, and retain the Result. Reuse one open City for repeated work.

### Start with a working example

- **[Your first query](#your-first-python-query)** Install the package, select Engine 0.5, and route using a prepared City.
- **[Build a City](reference.md#build-a-city)** Turn local GTFS and OSM inputs into a reusable network.
- **[Calculate a matrix](reference.md#matrix)** Evaluate many origins and destinations together, with optional journeys.
- **[Compare a service change](#compare-a-service-proposal)** Run baseline and Scenario queries on the same City.

### Three questions, one City

```python
import vigo

with vigo.open("./boston") as city:
    result = city.route(
        [-71.11902, 42.37334],
        [-71.05524, 42.35227],
        depart_at="08:00",
        service_date="2026-10-05",
    )
    if result.status == "ready":
        print(result.duration_minutes)
```

This example requires a City covering central Boston and a feed active on the chosen date. Coordinates are `[longitude, latitude]`. Transit may choose a direct walk; set `require_transit_ride=True` when a boarding is required.

| Query | Answer | Reference |
| --- | --- | --- |
| Route | A journey between ordered places | [Route](reference.md#route) |
| Matrix | Travel times for pairs of places | [Matrix](reference.md#matrix) |
| Reach | Reachable streets and areas within a time budget | [Reach](reference.md#reach) |

### Read the result correctly

Python uses `ready` and `blocked` Result statuses and minute-valued travel times. A completed Matrix can contain blocked rows. Invalid inputs and execution failures raise exceptions. [Results and exports](#results) explains each field and the comparison rules.

The [public Engine CLI and HTTP schemas](https://github.com/hytangs/vigo/blob/main/docs/reference/results.md) use seconds and different status names. Use Python's documented Result properties in Python applications.

### Keep repeated work efficient

Use a context manager, retain the open City, and request Matrix journeys or geometry only when needed. Install the optional `speed` extra for accelerated response decoding. Use `result.iter_rows()` to copy only consumed rows. [Runtime and performance](#runtime-and-loading) explains process reuse, timing, and resource lifetime.

### Reference and support

[Read these docs offline](index.html) · [Python API](reference.md) · [Troubleshooting](#troubleshooting) · [Notebooks](../notebooks/README.md) · [0.5.2 release notes](releases/0.5.2.md) · [Contributing](../CONTRIBUTING.md)

## Your first Python query

Install VIGO Python 0.5.2, select Engine 0.5, and open a prepared City. The example below asks for a journey from Harvard Square to South Station.

### 1. Install

For a packaged installation, select the wheel matching your OS and CPU from [VIGO Python releases](https://github.com/hytangs/vigo/tree/main/python/releases). Replace the filename below with the downloaded file:

```sh
python -m pip install "/path/to/vigo-0.5.2-py3-none-PLATFORM.whl[speed]"
```

Platform wheels include Node, the headless CLI bundle, and the Rust kernel. The optional `speed` extra adds accelerated JSON decoding. Omit the extra for the dependency-free Python package; the packaged Engine is still included. Python 3.10 or newer is required.

From a source checkout, install the wrapper and select a separately built Engine:

```sh
python -m pip install -e ".[speed]"
export VIGO_RUNTIME=/path/to/headless-runtime
```

`VIGO_RUNTIME` can name a complete headless directory or a built `vigo.mjs` file. A source `.mjs` needs system Node and its matching native kernel. See [runtime selection](#select-a-runtime) for complete layouts and Windows usage.

### 2. Prepare the City

Use a complete City built with Engine 0.5. Keep the entire directory, including its timetable and street files. If starting with raw inputs, follow the [Engine Boston tutorial](https://github.com/hytangs/vigo/blob/main/docs/guide.md#vigo-cli-quickstart), or build from local files in Python:

```python
import vigo

with vigo.build(
    "./boston",
    gtfs="./data/MBTA_GTFS.zip",
    osm="./data/boston.osm.pbf",
) as city:
    print(city.name, city.revision_id)
```

Build once; reopen the saved City in later sessions. Do not call Build inside a query loop. Rebuild pre-0.5.0 prepared Cities from their original inputs.

### 3. Run a journey query

Save this as `route.py`. The example requires Boston street coverage and a timetable active on October 5, 2026. Change the date to one covered by your own feed.

```python
import vigo

with vigo.open("./boston") as city:
    result = city.route(
        [-71.11902, 42.37334],
        [-71.05524, 42.35227],
        depart_at="08:00",
        service_date="2026-10-05",
        max_walk_km=1.2,
        require_transit_ride=True,
    )
    if result.status == "ready":
        print(f"Journey: {result.duration_minutes:.1f} minutes")
        for leg in result.legs:
            print(leg["type"])
    else:
        print("No journey under the supplied constraints.")
    result.export("route-result.json")
```

Run it with the same interpreter used for installation:

```sh
python route.py
```

The first query starts the resident process and opens the required data. Further queries in the same `with` block reuse that process. Exiting the block releases it; returned Results remain usable.

### 4. Read and reuse the answer

`duration_minutes` is the selected journey duration. `legs` contains its timed steps and available geometry. Inspect `warnings` before using a path in a passenger-facing application. A `blocked` Result is a valid no-journey outcome; `VigoError` reports a failed operation.

Next, try [arrive-by routing](reference.md#route), [a travel-time matrix](reference.md#matrix), or [walking and transit Reach](reference.md#reach). The [batch workflow](#retain-every-batch-outcome) keeps failures separate from valid blocked results.

## VIGO concepts

VIGO has four first-class concepts and three Query families. Build or open a City, optionally apply a Scenario, then retain the Result of a Query.

```text
City -> Route | Matrix | Reach -> Result
  ^
optional Scenario
```

### City

A City is a compiled mobility model built from GTFS and OSM. Its directory is one atomic unit containing the timetable, street model, and the data needed to open them quickly.

A named City may be rebuilt over time. Each build is an immutable revision. A Result records the revision it used.

`city.revision_id` identifies the build. `city.built_at` records when it was created. `city.sources` records its GTFS and OSM inputs. Moving the complete City directory does not change that identity.

### Scenario

A Scenario is an immutable set of changes applied to exactly one City revision.

The shared VIGO model can describe:

- proposed transit service changes;
- one live transit state;
- one supplied traffic state.

Query choices such as a walking limit, departure time, or time cutoff are not Scenario changes. A complete alternative GTFS source is another City revision, not a Scenario. Map geometry used to draw an edit is presentation data, not a transport change by itself.

VIGO checks a selected combination before running it. It never drops an unsupported change and quietly returns the unchanged City.

Python supports planned service changes in Reach and supplied traffic in Drive Route/Matrix. Python live-transit Scenarios, realtime transit Matrix, and realtime Reach are unsupported. Supplied traffic uses the shared native driving kernel and requires an engine that advertises that capability.

`city.supports(query)` and `scenario.supports(query)` return a `Support` value with a reason and available alternative when the selected context cannot execute a combination. This is not a complete data-validation pass; execution still checks points, dates, and runtime inputs. See the [Python support table](reference.md#scenario).

### Query

VIGO has exactly three Query families.

#### Route

Find and explain travel between ordered points. Transport mode, depart-at, arrive-by, departure windows, waypoints, and batch requests are Route options.

Depart-at minimizes arrival time, then boardings, then walking. Arrive-by maximizes departure time, then minimizes boardings and walking among journeys arriving by the deadline, then actual arrival.

#### Matrix

Compute scalar travel time between one or more origins and destinations.

Both depart-at and arrive-by accept up to 100,000 pairs. Fixed departures share
one forward scan per unique origin; fixed arrival deadlines share one reverse
scan per unique destination. Arrive-by duration runs from the latest departure
to the deadline, including destination waiting.

#### Reach

Compute where the represented network can travel within stated time limits. A Reach Result may be viewed as contours or reached streets.

Reach is not Accessibility. Accessibility requires opportunities such as jobs, population, schools, or healthcare in addition to travel impedance.

### Result

A Result is the immutable answer to one Query. Every Result exposes:

- status;
- Query inputs;
- warnings;
- timing;
- City revision and Scenario name;
- export methods.

Compare is an action on two compatible Results. It is not a fourth Query family.

Result status is only `ready` or `blocked`. A completed Matrix is ready even when individual rows are blocked. Python-side query validation raises `InvalidQuery`; unsupported combinations raise `UnsupportedQuery`; runtime validation and execution failures raise `VigoError`. Background work separately reports `queued`, `running`, `ready`, `cancelled`, or `error` through `Job.status`.

Compare uses retained values and checks family-specific structure; the caller must align dates, points, modes, and other study assumptions. A valid numerical difference does not establish that two Results answer the same question. See [Results](#results) for comparison and evidence boundaries.

### Time

VIGO keeps these durations separate:

- Build: GTFS and OSM become a City.
- Open: a City revision becomes ready for queries.
- Compute: the selected Query runs.
- End to end: caller submission through complete Result.

Repeated Route calls may reuse one open process. The answer is still computed for every call.

The wrapper's `timing["endToEndMs"]` ends before Result construction and export. Use an outer timer for the complete Python operation; see [runtime measurement](#measure-the-complete-operation).

### Python

```python
import vigo

with vigo.open("./city") as city:
    route = city.route("A", "B", depart_at="08:00", service_date="2026-09-04")
    matrix = city.matrix({"a": "A"}, {"b": "B"}, depart_at="08:00", service_date="2026-09-04")
    reach = city.reach("A", depart_at="08:00", service_date="2026-09-04")
```

The VIGO command line uses the same nouns: `vigo build`, `vigo inspect`, `vigo route`, `vigo matrix`, `vigo reach`, and `vigo compare`.

`vigo capabilities` reports the public API version and supported combinations. Python requires Engine 0.5.x with API 1.0, capability schema v3, and trace output. Runtime selection rejects other API versions and capability schemas.

`Route` and `Matrix` accept `max_transfers=0` for at most one boarding,
`max_transfers=1` for at most two, and so on through 31. Omit the option
(or use `None`) for no additional cap. It applies to both `depart_at` and
`arrive_by` and all Matrix shapes. A finite cap with ordered transit
waypoints is currently unsupported.

[Documentation](#routing-from-python-without-rebuilding-the-network) · [Workflows](#workflows) · [Reference](reference.md)

## Workflows

These examples use the public `vigo` package and a complete City at `./boston`. Replace the paths, points, and service date with values covered by your data. They describe scheduled model outputs, not observed journeys. See the [reference](reference.md) for all arguments and the [notebooks](../notebooks/README.md) for interactive versions.

### Find a journey

Use Route when you need departure and arrival times, transfers, and legs. An arrive-by request searches for the latest feasible departure. Waypoints are visited in their supplied order.

```python
import vigo

with vigo.open("./boston") as city:
    journey = city.route(
        [-71.062, 42.356],
        [-71.071, 42.361],
        waypoints=[[-71.058, 42.349]],
        arrive_by="09:00",
        service_date="2026-09-04",
        max_walk_km=1.2,
    )
    if journey.status == "ready":
        print(journey.duration_minutes)
        for leg in journey.legs:
            print(leg)
    else:
        print("No journey satisfies this request.")
    journey.export("outputs/journey.json")
    journey.export("outputs/journey.geojson")
```

Transit compares a feasible direct walk by default. Set `require_transit_ride=True` to require a boarding. Use `mode="walk"` or `mode="drive"` for street routing. A finite `max_transfers` is currently unsupported with ordered transit waypoints. Changing a constraint changes the question; retain it in the study record.

### Calculate travel times to a common destination

Use Matrix for an assignment table, travel-time screen, or repeated origin–destination analysis. Give points stable caller IDs so rows remain joinable when their input order changes.

```python
import vigo

homes = {
    "home-west": [-71.080, 42.356],
    "home-south": [-71.062, 42.340],
}
schools = {"school": [-71.058, 42.349]}

with vigo.open("./boston") as city:
    morning = city.matrix(
        homes,
        schools,
        arrive_by="08:30",
        service_date="2026-09-04",
        max_walk_km=1.2,
        max_transfers=1,
        require_transit_ride=True,
    )
    rows = morning.rows
    ready = [row for row in rows if row["status"] == "ready"]
    blocked = [row for row in rows if row["status"] == "blocked"]
    print("ready", len(ready), "blocked", len(blocked))
    morning.export("outputs/morning.json")
    morning.export("outputs/morning.csv")

    afternoon = city.matrix(
        schools,
        homes,
        depart_at="15:00",
        service_date="2026-09-04",
        max_walk_km=1.2,
        max_transfers=1,
        require_transit_ride=True,
    )
    afternoon.export("outputs/afternoon.json")
```

A shared destination and deadline share one reverse timetable scan. A shared origin and departure share one forward scan. Keep the City open while changing endpoint groups. A request accepts up to 100,000 pairs; the product of origin and destination counts is the relevant size.

For arrive-by Matrix, `durationMinutes` runs from the latest departure to the requested deadline, including waiting after early arrival. Use `include_journeys=True` when actual arrival and timed legs matter; `include_geometry=True` additionally materializes their paths. These options increase output and assembly work. The [results guide](#matrix-1) explains row status, missing durations, and nested journeys.

### Compare a service proposal

Use the same Reach Query for the baseline and proposed service. Here the proposal adds a modeled service between two coordinates: both directions, a 05:00–25:00 service span, ten-minute headways, estimated travel at 22 km/h, and 0.35 minutes of dwell. These are authored assumptions, not observed operations. Use the Engine's [Scenario reference](https://github.com/hytangs/vigo/blob/main/docs/guide.md#scenario-semantics) for adding, augmenting, replacing, or excluding service.

```python
import vigo

service_changes = [{
    "operation": "add",
    "name": "Crosstown",
    "stops": [
        {"label": "West", "coordinate": [-71.08, 42.35]},
        {"label": "East", "coordinate": [-71.04, 42.36]},
    ],
    "headwayMinutes": 10,
    "startMinutes": 300,
    "endMinutes": 1500,
    "bidirectional": True,
    "timeModel": "estimate-distance",
    "averageSpeedKph": 22,
    "dwellMinutes": 0.35,
}]
query = vigo.Reach(
    [-71.062, 42.356],
    service_date="2026-09-04",
    depart_at="08:00",
    cutoffs_minutes=(15, 30, 45, 60),
    extent_radius_km=8,
    raster_size=96,
)

with vigo.open("./boston") as city:
    proposal = city.scenario("Ten-minute service", services=service_changes)
    before = city.run(query)
    after = proposal.run(query)
    before.export("outputs/before.json")
    after.export("outputs/after.json")
    after.export("outputs/after.geojson")
    difference = before.compare(after)
    difference.export("outputs/change.json")
    print(difference.value)
```

Reach's radius bounds the computed area; increasing it changes the analysis, not just the map zoom. Keep the grid, date, time, walking assumptions, and origin aligned. Compare checks grid compatibility but does not establish that all study assumptions match. Report newly reachable and no-longer-reachable cells beside duration changes among comparable cells. Reach alone does not measure jobs, people, or other opportunities.

### Run independent queries concurrently

For independent school matrices or other batches, use bounded concurrency while keeping complete Results in input order:

```python
from contextlib import closing

# queries is an iterable of vigo.Route, vigo.Matrix, or vigo.Reach objects.
with closing(city.iter_run(queries, workers=2)) as results:
    for index, result in enumerate(results):
        result.export(f"outputs/query-{index}.json")
```

The iterator limits pending queries and retained responses. It avoids accumulating the entire batch; `city.run(queries, workers=2)` can instead return a list when `queries` is a sequence and all Results fit in memory. The same methods work on a Scenario. No itinerary fields are removed or approximated.

Start with two workers and measure your own workload. Each worker owns a resident Engine process and prepared City. Effective concurrency is capped by CPU/memory capacity (at most four); startup and additional memory can outweigh gains for small batches. Errors surface in input order and stop iteration; already submitted queries may complete. Closing waits for active queries. The default `workers=1` preserves serial execution. See the [execution reference](reference.md) for the full contract.

### Retain every batch outcome

`city.run([query, ...])` executes sequentially and stops at the first exception. Use an explicit loop when a study must preserve each success, blocked outcome, and query failure. Opening the City happens outside this loop: a setup failure is a failure of the batch setup, not one blocked journey per request.

```python
import json
from collections import Counter
from pathlib import Path
import vigo

requests = {
    "morning": vigo.Route(
        [-71.062, 42.356], [-71.058, 42.349],
        depart_at="08:00", service_date="2026-09-04",
    ),
    "evening": vigo.Route(
        [-71.058, 42.349], [-71.062, 42.356],
        depart_at="17:00", service_date="2026-09-04",
    ),
}
output = Path("outputs/batch")
output.mkdir(parents=True, exist_ok=True)
outcomes = []

with vigo.open("./boston") as city:
    for request_id, query in requests.items():
        try:
            result = city.run(query)
        except vigo.VigoError as error:
            outcomes.append({
                "id": request_id,
                "outcome": "query_error",
                "errorType": type(error).__name__,
                "message": str(error),
            })
            continue
        result.export(output / f"{request_id}.json")
        outcomes.append({"id": request_id, "outcome": result.status})

(output / "outcomes.json").write_text(
    json.dumps(outcomes, indent=2) + "\n", encoding="utf-8"
)
print(Counter(row["outcome"] for row in outcomes))
```

Keep the authored requests with this output, including failed requests that have no Result. An export failure remains an exception rather than becoming a routing outcome. Do not replace blocked durations with zero or drop failed requests from the denominator.

For background work, use [`city.submit(query)`](reference.md#job). A background job can finish successfully with a blocked Result; `Job.status` describes execution, while `Result.status` describes the modeled answer.

[Documentation](#routing-from-python-without-rebuilding-the-network) · [Results](#results) · [Python reference](reference.md)

## Results

A Result is the retained answer to one Query. Read its outcome before interpreting its numbers, and keep the query and City revision with any exported table or map.

### Outcomes

| Outcome | Meaning | How to retain it |
| --- | --- | --- |
| Route or Reach `ready` | A journey or surface was produced under the request | Keep values, assumptions, warnings, and timing |
| Route or Reach `blocked` | The computation completed without a usable journey or surface | Keep the outcome; do not turn missing values into zero |
| Matrix row `ready` | This pair has a modeled travel time | Analyze the row's duration |
| Matrix row `blocked` | This pair has no usable answer under the request | Keep the pair in outcome counts |
| Exception | Setup, validation, support, timeout, or execution failed | Keep the exception separately from blocked outcomes |

A completed Matrix's top-level status is `ready` even when some or all pairs are blocked. Inspect `matrix.rows`. A ready Result may still carry warnings; it does not establish that the source data represent every real route, restriction, or operational condition.

Background `Job.status` is separate. `ready` means the job returned without an exception; the returned Result can be blocked. See [errors and jobs](reference.md#job).

### Shared fields

| Python property | Meaning |
| --- | --- |
| `kind` | `route`, `matrix`, `reach`, or `comparison` |
| `status` | `ready` or `blocked` |
| `query` | Normalized runtime request, using Engine field names such as `serviceDate` |
| `warnings` | Warnings returned by the runtime |
| `timing` | Runtime and wrapper timing fields, where reported |
| `city_revision_id` | City build used by the Query |
| `scenario_name` | Selected Scenario name, or `None` |
| `record` | Compact record with City revision, Scenario name, query, outcome, warnings, and timing |
| `value` | Journey, Matrix rows, Reach surface, or comparison change |

Properties such as `query`, `rows`, `legs`, and `timing` return copies. Editing them does not change the retained Result. `to_dict()` returns the complete Engine payload; `record` is a compact Python record, not an alias for that payload. Comparison Results have a different envelope and do not include the two full source Results.

### Route

Use `duration_minutes` for the selected journey and `legs` for its detail. A blocked Route normally has no duration and no legs. Export JSON for the complete journey; GeoJSON contains only legs with line geometry and a small set of properties.

Depart-at minimizes arrival time, then boardings and walking. Arrive-by maximizes departure time and then resolves secondary objectives within the arrival deadline. A departure-window query is a different question from an exact departure; retain the window with the answer. See the [Route reference](reference.md#route) for constraints.

### Matrix

Rows contain caller IDs (`originId`, `destinationId`), endpoint indexes, `status`, and `durationMinutes`, with other fields depending on the mode and requested detail. Output uses origin-major order. Prefer IDs to row position when joining analysis tables. Use unique IDs and keep their associated coordinates or stop IDs stable across runs.

For arrive-by transit Matrix, `departMinutes` is the latest feasible departure and `arriveMinutes` is the requested deadline. `durationMinutes` includes destination waiting after an early arrival. With `include_journeys=True`, each ready row's `journey` supplies actual arrival, transfers, walking, waiting, ride time, and timed legs. With `include_geometry=True`, that journey also includes selected path geometry. Blocked rows have no journey.

Equal-objective Matrix journeys can differ from Route in which tied path they choose, and therefore in ride/wait splits. The parent Matrix timing covers the shared computation. A nested journey's timing does not represent an independent timetable search or an allocated share of batch time.

### Reach

`value` contains the travel-time surface; `to_geojson()` returns contours. The grid size and bounds belong to the computation. `extent_radius_km` limits the area computed around the origin, and `raster_size` controls its resolution. A contour is a representation of this model, not a guarantee that every location inside a polygon has identical access.

Reach measures travel impedance. An accessibility measure additionally needs opportunity data and an aggregation rule, such as counting jobs below a travel-time threshold. Keep those external inputs and assumptions separate from the Reach Result.

### Compare completed Results

`vigo.compare(before, after)` and `before.compare(after)` compute differences without running either Query again. The sign is **after minus before**: a negative duration change is faster.

| Family | Comparison behavior |
| --- | --- |
| Route | Duration and transfer change when both Results are ready; otherwise the corresponding change is `None` |
| Matrix | Match rows by origin/destination IDs, falling back to indexes; count faster, slower, unchanged, newly reachable, and no-longer-reachable pairs |
| Reach | Require equal grid dimensions, bounds, and value counts; count the same changes across cells |

For Matrix and Reach, `meanChangeMinutes` uses only matched pairs or cells with finite values on both sides. It is `None` when none are comparable. Newly reachable and no-longer-reachable outcomes are reported separately; they do not enter this mean.

The caller must align the study. Compare does not require equal City revisions, dates, times, modes, walking limits, or other Query settings. Route can compare unrelated endpoints unless the caller prevents it. Matrix silently skips unmatched pairs; repeated IDs can collapse the before-side lookup. Keep unique, stable IDs, check the complete pair sets, and report coverage as well as speed changes. The Reach grid check alone does not establish matching inputs.

### Export

| Extension | Supported Results | Contents |
| --- | --- | --- |
| `.json` | All | Complete Engine payload |
| `.geojson` | Route, Reach | Route leg lines or Reach contours |
| `.csv` | Matrix | Row fields |

`result.export(path)` creates parent directories, writes the selected representation, and returns its absolute `Path`. It overwrites an existing destination. Python exports write directly; use distinct run directories when preserving earlier evidence. `to_json(indent=None)` returns compact JSON.

Keep JSON as the complete record. GeoJSON omits most query and runtime detail. CSV does not preserve the Result envelope; nested journey objects become text in cells, so JSON is preferable when journeys are requested. Matrix does not expose `to_geojson()`, even when its nested journeys include geometry.

### Retain a reproducible record

Alongside the full Result JSON, retain the authored request or script, complete City revision, Scenario inputs, selected runtime version, and wrapper version. The normalized query is useful but is not a promise to echo every input: for example, a supplied traffic snapshot is not fully reproduced in every query envelope. A Scenario name alone does not reproduce the change.

```python
import json
from pathlib import Path
import vigo

with vigo.open("./boston") as city:
    result = city.route(
        [-71.062, 42.356], [-71.058, 42.349],
        depart_at="08:00", service_date="2026-09-04",
    )
    result.export("outputs/route.json")
    record = {
        **result.record,
        "wrapperVersion": vigo.__version__,
        "engineVersion": city.runtime.product_version,
        "apiVersion": city.runtime.api_version,
        "sources": city.sources,
    }
    Path("outputs/record.json").write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )
```

Timing describes execution, not accuracy. Synthetic integration tests check contracts and controlled routing behavior; they do not establish field prediction accuracy. Interpret results within the Engine's [data and routing limits](https://github.com/hytangs/vigo/blob/main/docs/guide.md#known-limits).

[Documentation](#routing-from-python-without-rebuilding-the-network) · [Workflows](#workflows) · [Runtime measurement](#measure-the-complete-operation)

## Runtime and loading

`vigo.open(path)` reads the City manifest, checks its required files, and resolves a runtime. It does not load the complete routing network. The first Query starts its runtime process and opens the required native data.

### Installation choices

| Install | Engine requirement | Use it for |
| --- | --- | --- |
| Platform wheel with bundled runtime | Included Node, headless bundle, and native kernel | A self-contained Python environment |
| Source checkout or universal development wheel | Select a compatible external Engine | Wrapper development or an independently managed Engine |
| Python with a complete Studio installation | Select the app or extracted distribution | Reusing the Engine shipped with Studio |

Python requires version 3.10 or newer. Install a local platform wheel with `python -m pip install /path/to/vigo-0.5.2-py3-none-PLATFORM.whl`, substituting its real filename. The package has no mandatory Python dependencies. `tqdm` is optional for Build progress.

For a source install, run `python -m pip install -e .` from the wrapper checkout, then select a compatible runtime explicitly. An adjacent Engine checkout is not automatically selected. Maintainers can [stage and build a headless platform wheel](../CONTRIBUTING.md#build-a-headless-wheel).

The self-contained wheel still communicates with a Node process. Rust performs routing kernels; JavaScript handles GTFS row loading, orchestration, and itinerary assembly. It is not a direct Python/Rust extension.

### From GTFS and OSM to the first answer

Measure `vigo.build()` from just before the call until it returns a City. Use
local raw files and a new output directory: this includes import, required
street indexes, transfers, station-access preparation, and publication of the
saved City. It does not include a Query for a particular service date.

Measure the first `city.route()` separately, and report their combined time
when answering "how long until a new city can answer?" The first Query can
prepare its active-service timetable and selected ride geometry.

```python
from time import perf_counter
import vigo

runtime = vigo.resolve_runtime()  # Runtime discovery is outside these timers.
started = perf_counter()
with vigo.build(
    "./boston", gtfs="./mbta.zip", osm="./massachusetts.osm.pbf", runtime=runtime
) as city:
    built = perf_counter()
    result = city.route(
        [-71.062, 42.356], [-71.058, 42.349],
        depart_at="08:00", service_date="2026-09-04",
    )
    answered = perf_counter()
    print("raw_build_seconds", built - started)
    print("first_query_seconds", answered - built)
    print("raw_to_first_answer_seconds", answered - started)
    print("status", result.status)
```

Choose a date covered by the feed. These timers exclude downloads, installation,
runtime discovery, printing, export, and closing the City. Record those costs
separately when they belong to the intended workflow. The compiler's
`city.details["timing"]["totalMs"]` ends before final publication and is not the
complete elapsed time of `vigo.build()`. Its component stages can overlap.

### Build progress

Install `tqdm` or install this checkout with
`python -m pip install ".[progress]"`, then call:

```python
with vigo.build("./boston", gtfs="./mbta.zip", osm="./massachusetts.osm.pbf", progress=True) as city:
    print(city.name)
```

The optional display uses `tqdm.auto` and shows the latest stage reported by
Engine and the elapsed Build time. The timer continues during long stages,
including street-index preparation. It does not invent a percentage or remaining
time when Engine has not reported a total. Build errors retain Engine's explanation; timeout or interruption stops
the build processes and closes the display. Progress defaults to `False` and
does not add work to Route or Matrix calls.

### Reopen a built City

Call `vigo.build()` once for the GTFS and OSM inputs, then use `vigo.open()` on
the saved directory in later sessions. Raw inputs are not needed for querying.
Keep the whole City directory when moving or packaging it: it contains the
street indexes, prepared station-access state, and retained timetable snapshots.

The current VIGO runtime restores these prepared files instead of repeating
their compilation. Node and the packaged runtime share the same portable
timetable format. A new set of active services may need one timetable
preparation; dates with identical active services share it. The timetable disk
cache is bounded, so an evicted pattern needs preparation again. Missing or
outdated timetable/access caches are rebuilt from the compiled City. Missing or
corrupt required street files need a complete City restored or rebuilt; changing
the raw network data requires a new build.

Reopening still reads files and allocates working memory. Reusing one open City
also avoids those costs. `Result.timing["openMs"]` measures runtime preparation
the first time each mode is prepared in a resident process, and is zero when that mode is reused.

### Select a runtime

```python
import vigo

runtime = vigo.resolve_runtime()
print(runtime.product_version, runtime.api_version, runtime.source)

with vigo.open("./boston", runtime=runtime) as city:
    print(city.sources)
```

Selection follows this order:

1. The explicit `runtime=` argument.
2. `VIGO_RUNTIME`, then `VIGO_APP`.
3. The bundled headless runtime.
4. Installed `VIGO Studio.app` locations on macOS.
5. `vigo` on `PATH`.

An invalid explicit setting fails rather than selecting another engine. Once a complete bundled layout is selected, a failed capability check also ends discovery. Sibling source checkouts are not discovered implicitly. Python requires Engine 0.5.x, API 1.0, capability schema v3, City format 1, Result schema 1, the public commands, and advertised trace output. Other API versions and capability schemas are rejected at runtime selection.

Use a path for a complete runtime directory or executable. Use an argument sequence for a custom command; a shell command string is not split into executable and arguments:

```python
runtime = vigo.resolve_runtime("./headless")
with vigo.open("./boston", runtime=runtime) as city:
    print(city.runtime.source, city.runtime.product_version)
```

Selecting a source `vigo.mjs` file uses system Node. Build its compatible native kernel and CLI together; the [maintainer build steps](../CONTRIBUTING.md#build-a-headless-wheel) show the required Engine commands.

Platform wheels include a private Node 24.18.0 executable, `vigo.mjs`, the native kernel, license notices, and a checksum manifest. Supported build targets are macOS 14+ ARM64/x64, Linux ARM64/x64 with glibc 2.39+ (Ubuntu 24.04 builders), and Windows x64. A wheel must match the target OS and CPU. Source installs and universal development wheels need an external runtime. No import-time or query-time downloads occur.

A headless runtime directory can also be passed to `runtime=`. Keep its files together. To use Studio as the runtime, select a complete macOS `.app`, extracted Studio distribution, or packaged executable with its `resources` directory. Bundled/headless child processes inherit only OS paths and locale settings; provider secrets, Node injection options, and foreign kernel overrides are excluded. Explicit external commands retain the caller's environment.

Successful capability checks are retained for up to eight runtime identities. Each lookup checks the command files' and explicitly selected native kernel's metadata, so replacing or rebuilding the runtime triggers a new check. Failed checks are not cached. Returned capability dictionaries are independent copies. Pass a previously resolved `RuntimeInfo` to reuse that selection explicitly.

Matrix requires advertised resident execution. Supplied traffic for Drive Route/Matrix requires the corresponding advertised capability; traffic is sent in explicit realtime mode. Transfer caps, arrive-by Matrix, journey output, and transit cache controls also require their advertised capabilities. Unsupported combinations raise `UnsupportedQuery`; Python validates these options before sending each query to the resident stream.

### Keep a City open

With the bundled engine, all Route modes (including waypoints and supplied traffic), Matrix, and Reach share resident processes by service date. A City keeps one to four processes according to CPU and resident memory capacity. On Linux, affinity and cgroup CPU quotas limit concurrency, while cgroup memory limits and `memory.high` cap the host RAM budget. Limits are read when sizing the executor/City; recreate the City after changing resource limits. Swap is not counted as RAM. Changing dates reclaims the least recently used idle process. Active queries finish before eviction or `City.close()` releases their process.

VIGO Python 0.5 requires Engine 0.5. All queries use the documented `stream` protocol. Detailed Python Results request its explicit trace output. Opening several City objects does not share their routing processes.

For repeated work, reuse one City in a context manager. Route answers are recomputed for every call. `disable_cache=True` on transit Route or Matrix disables street-access and reconstructed walking-path caches while leaving the prepared network resident.

Requests for the same service date share and serialize access to its process. Different dates can use separate processes within the pool limit. `submit()` moves work to a background thread; it does not create an independent process per request. Await submitted jobs before leaving the City's context.

### Timeouts and failures

`vigo.open(..., timeout=120)` sets the Query timeout in seconds. Waiting for an available resident process and waiting for its response each use that limit. A timed-out resident process is stopped; a later Query can start a fresh one. `City.close()` waits for active resident queries before closing their processes.

`vigo.build(..., timeout=1800)` bounds the build command. The City it returns has the default 120-second Query timeout; reopen with a different timeout if needed. Runtime discovery uses a separate 30-second capability-check timeout per candidate. Invalid or unavailable runtimes raise `VigoError`; Query timeouts raise `VigoTimeoutError`. These are per-operation limits, not a single end-to-end deadline.

If importing the package exposes none of the documented functions, inspect `vigo.__file__` and the active interpreter. A local directory named `vigo` can shadow the installed package. Install into the intended interpreter and restart the Python session after correcting its import path.

### Reduce Python overhead

Install `python -m pip install ".[speed]"` from this checkout to enable optional
`orjson` decoding directly from resident UTF-8 response bytes, avoiding an intermediate Python string. Without it, Python uses the standard
JSON decoder. Request encoding and exports retain strict finite-number checks
and existing formatting. Decoding acceleration does not change routing or
cache policy. The detailed trace is still requested to preserve Result fields.

Result access copies JSON containers while reusing immutable scalar values.
For large matrices, consume `result.iter_rows()` to avoid copying rows you do
not need. CSV export writes stored rows without first copying the full matrix.
Use `include_journeys=False` and `include_geometry=False` when only travel
times are needed; these remain the Matrix defaults. Reuse an open City.

Run `python scripts/benchmark-wrapper.py` from the checkout to compare the old
generic row-copy operation with current Result access and compare standard
JSON decoding with the installed decoder. This synthetic benchmark excludes
Engine computation, process communication, and City loading. It is not a
routing speedup claim.

### Measure the complete operation

Record `vigo.open()` separately from the first Query: most native loading occurs during that Query. `Result.timing` distinguishes runtime opening and computation where available. For Route, Matrix, and Reach, `endToEndMs` includes Python request preparation and the runtime response, through payload decoding; Result construction and export occur afterwards. Use an outer wall-clock measurement when including those stages.

Compare first-query and repeated-query durations on the same City, service date, query options, and output detail. Native `engineQueryMs` excludes parts of access, geometry, communication, and Python work; it is not full-route throughput. Count ready Results, blocked Results, setup failures, and query exceptions separately.

Keep `require_transit_ride` explicit when comparing results: the current
default is `False`, which allows a direct walk to compete with transit. Set `True` to require a boarding. Match
`disable_cache`, date, walking budget, coordinates, and output detail before
attributing a latency difference to a version change. A sub-millisecond native
timetable measurement is distinct from a complete Python Route call.

[Documentation](#routing-from-python-without-rebuilding-the-network) · [Troubleshooting](#troubleshooting) · [Results](#results)

## Troubleshooting

Start with the failing layer: importing Python, selecting a runtime, opening a City, executing a Query, or interpreting a completed Result. Keep the original error and request before changing inputs.

### Check the Python environment

```python
import sys
import vigo

print("interpreter", sys.executable)
print("package", vigo.__file__)
print("wrapper version", getattr(vigo, "__version__", "unavailable"))
```

If the import has no documented functions, a local `vigo.py` or directory named `vigo` may shadow the installed package. Use `python -m pip` with the intended interpreter, then restart the Python or notebook session. A notebook kernel can use a different interpreter from the terminal.

### Check the selected runtime

```python
import vigo

try:
    runtime = vigo.resolve_runtime()
except vigo.VigoError as error:
    print(error)
else:
    print(runtime.source, runtime.path)
    print(runtime.product_version, runtime.api_version)
    print(runtime.capabilities)
```

Explicit `runtime=`, `VIGO_RUNTIME`, and `VIGO_APP` take precedence over a bundled engine. An invalid explicit choice fails instead of trying another engine. Check old environment settings when a platform wheel appears to select the wrong runtime. See [runtime selection](#select-a-runtime) for the full order.

| Symptom | Check and next action |
| --- | --- |
| No compatible VIGO runtime | Confirm that the install includes a platform runtime, or select a complete external runtime. Source installs require an external Engine. |
| Native library cannot load | Check OS, CPU, and platform requirements; keep the Node executable, bundle, and native kernel from the same runtime together. |
| External `.mjs` cannot run | A source bundle needs compatible system Node and its native kernel. Prefer a complete headless runtime directory or follow Engine's source-build guide. |
| Studio installation cannot run as a runtime | Select a complete app or extracted distribution, including its `resources` directory. |
| API compatibility succeeds but a feature is unsupported | API compatibility and optional Query capabilities are separate. Inspect `city.supports(query)` and the runtime's advertised capabilities. |

### Check the City

`vigo.open()` needs a complete City directory, not a raw GTFS ZIP or one SQLite file. Move or restore the whole build. Its initial checks cover the manifest and required entry files; later native loading can still detect missing or corrupt data.

If the build destination already exists, use a new directory or intentionally pass `replace=True`. If inputs changed, build a new revision. An incomplete required street model needs restoration or rebuilding; increasing a query timeout cannot repair it.

### Distinguish unsupported from blocked

`UnsupportedQuery` means a requested combination cannot run. Inspect `error.support.reason` and `error.support.available`. Planned service changes support Reach; supplied traffic supports Drive Route/Matrix with the advertised capability; Python live transit is unsupported. `supports()` checks combinations, not every endpoint, date, or data-dependent constraint.

`InvalidQuery` covers Python-side request checks. Additional invalid requests can fail in Engine and surface as `VigoError`; catch that base class at a batch boundary when every query failure must be retained. See the [batch workflow](#retain-every-batch-outcome).

A blocked journey is a completed model answer. Check, in this order:

1. The exact service date and feed coverage, including the correct service day for an after-midnight time.
2. Exact stop IDs or `[longitude, latitude]` coordinate order and City coverage.
3. Departure versus arrival semantics, horizon, walking budget, and transfer cap.
4. Whether a vehicle boarding is required. The default is `require_transit_ride=False`; a feasible direct walk can win.
5. Warnings and the Engine's [routing limits](https://github.com/hytangs/vigo/blob/main/docs/guide.md#known-limits).

For Matrix, inspect each row even when the Result itself is ready. Do not retry blocked queries as if the runtime crashed. Only relax constraints when that matches the intended question.

### Diagnose time and comparison surprises

| Symptom | Explanation |
| --- | --- |
| First query is slower than repeats | `vigo.open()` does not prepare the complete network; the first query pays runtime and mode preparation costs. |
| `disable_cache=True` still gives fast repeats | It disables specific transit street caches, while keeping the network and resident process prepared. |
| A query times out | Use `vigo.open(..., timeout=...)` for query limits. Build timeout and `Job.wait(timeout=...)` control different operations. |
| `job.wait()` times out but work continues | The wait timed out; it did not cancel the running Query. `cancel()` only cancels queued work. |
| Arrive-by Matrix duration is longer than the journey | The row measures to the deadline; the nested journey can arrive earlier. |
| Reach comparisons reject two maps | Their computation grids must have identical bounds and dimensions. Match origin, extent, and raster size. |
| A comparison reports fewer pairs than expected | Matrix comparison includes matched IDs only. Check unique IDs, stable endpoint meanings, and pair coverage. |

Keep runtime preparation, computation, Python call duration, and export time separate. The [runtime guide](#measure-the-complete-operation) describes these boundaries.

### Report a reproducible issue

Include the wrapper and Engine versions, OS/CPU, runtime selection method, smallest failing Python request, exact exception or Result status, and whether the failure occurs on the first or a repeated query. Include a shareable synthetic fixture when possible. Describe City inputs and build options without uploading licensed feeds, credentials, private paths, or private study results.

Report Python packaging, argument conversion, process lifetime, and Python exports in [VIGO Python issues](https://github.com/hytangs/vigo/issues). Shared transport computation belongs in [VIGO Engine issues](https://github.com/hytangs/vigo/issues).

[Documentation](#routing-from-python-without-rebuilding-the-network) · [Reference](reference.md) · [Runtime](#runtime-and-loading)



## Decompose journeys for analysis

Route and Matrix Results can be separated into journey summaries and individual legs. For Matrix, request `include_journeys=True` when computing the Result. The helpers use only the Python standard library; pandas is optional for analysis:

```python
import pandas as pd

journeys = pd.json_normalize(result.iter_journeys())
legs = pd.json_normalize(result.iter_legs())
if not legs.empty and "durationMinutes" in legs:
    minutes_by_type = (
        legs.groupby(["journeyIndex", "type"], dropna=False)["durationMinutes"]
        .sum(min_count=1)
        .unstack("type")
    )
    analysis = journeys.join(minutes_by_type.add_prefix("leg_minutes_"), on="journeyIndex")
else:
    analysis = journeys
```

This retains blocked journeys and missing itinerary detail in the summary table. Missing component durations stay missing; journey duration remains the Engine value because elapsed waiting and leg durations need not sum to the same total. Leg types and time units retain their Engine meanings. Request `include_geometry=True` on `iter_legs()` to copy available geometry.

For dependency-free CSV export, use [decompose_result.py](../examples/decompose_result.py):

```bash
python examples/decompose_result.py result.json --kind matrix --output tables
```

The input is a saved `result.export("result.json")` file. The script writes `journeys.csv`, `legs.csv`, and `record.json` with query, warnings and timing. Nested fields are JSON encoded in CSV. Supply `--scenario` and `--city-revision` if that provenance is absent from the exported payload. An empty leg table contains no itinerary records. `result.export_tables("tables")` discovers columns in one pass and writes records in a second, keeping only one record at a time. The Engine response itself is already resident. Serialization completes before existing files are replaced; use a separate output directory per Result when readers need a consistent set of tables.


### Reuse processes across dates

With an Engine advertising per-request service dates, one idle process can serve weekday and weekend queries. The pool grows only when requests overlap, within its existing process limit. Older compatible engines retain date-specific processes. Reuse one open City and close it after the study; no process management is required in analysis code.
