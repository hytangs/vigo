# Monte Carlo routing and accessibility

RC.4 adds opt-in departure-window distributions to the native Route, Matrix and
Reach endpoints. Studio exposes the controls under Analyze → Departure window.
The ordinary single-time result contract stays unchanged. No City rebuild or new
package dependency is required for simulation. RC.4 also corrects an extra
end-boundary departure in newly built exact-frequency GTFS service. Existing
Cities retain their stored expanded trips; rebuild from source to apply that
separate compiler correction.

```json
{
  "kind": "matrix",
  "serviceDate": "2026-07-15",
  "origins": [{"stop": {"id": "A"}}],
  "destinations": [{"stop": {"id": "B"}}],
  "maxWalkKm": 1.2,
  "horizonMinutes": 120,
  "monteCarlo": {
    "startMinutes": 420,
    "endMinutes": 540,
    "draws": 200,
    "seed": 42,
    "percentiles": [5, 25, 50, 75, 95]
  }
}
```

Send this with `vigo matrix --city city --request request.json`, the resident
stream, or `POST /v1/matrix`. The native executable, Node CLI and Python
`monte_carlo` option use the same resident Rust sampler. A Route request uses `origin` and `destination` and
returns a distribution for that pair, rather than a representative itinerary.
Reach uses its existing origin, bounds, raster size, cutoffs and sampling mode.

Every minute in `[startMinutes, endMinutes)` receives equal weight. If frequency
service can affect the departure window and travel horizon, requested draws are
rounded upward to an equal integer
number per minute: 200 requested over 120 minutes yields 240 samples. Exact-only
service, including windows outside frequency operation, uses one sample per
minute regardless of the requested draws. Seeds are
unsigned 32-bit integers. Percentiles must be increasing integers in 0–100.

For each sample, each GTFS `exact_times=0` entry receives one uniform
integer-second phase in `[0, headway)`. Its vehicles then repeat at that headway
within the end-exclusive service window. All stops, transfers, origins and
destinations in that sample see the same realization. Published trips and
`exact_times=1` service remain fixed. The implementation changes phases on the
resident native timetable instead of expanding a new network for every draw.

This models unknown schedules and variation in passenger departure times. It
assumes on-time operations, passenger knowledge of the realized timetable and
no capacity denial. It does not estimate observed delays or operational
reliability. The distinction follows the public
[frequency-routing methodology](https://docs.conveyal.com/analysis/methodology).

## Reading the result

`vigo.distribution.v1` records the full request, City revision, engine version,
request fingerprint, seed, method version, requested draws and actual sample
count. `durationsSeconds[p][i]` contains the destination-wise nearest-rank
percentile. Matrix cells are flattened in origin-major order; Reach cells use
the returned grid layout. `reachableSamples[i]` counts finite outcomes.

Unreachable samples participate as positive infinity; their selected quantile
is JSON `null`. Zero remains a valid travel time. No-itinerary outcomes are not
removed before computing percentiles. Query errors abort the analysis instead
of entering the distribution as unreachable observations. The inverse empirical
CDF uses index `max(0, ceil(percentile * sampleCount / 100) - 1)`.

A seed reproduces results for the same engine, City, scenario, query selectors
and sample plan. Changing the number of draws or the timetable can change the
sample plan. This is not a guarantee of identical random phases across unrelated
City builds or differently ordered service entries.

Observation storage is limited to 64 MiB per request and percentile output to
one million values. Repeated Matrix endpoints share observations; the final
results preserve every requested pair and its order. Reduce the number of distinct pairs,
raster size or draws if the request exceeds it. This limit covers observations,
not total process RSS, resident networks, result serialization or City loading.
Studio uses a 96×96 simulation grid. Matrix resolves endpoint walks once per
request. Reach limits street propagation to paths that can enter the requested
grid, using displacement bounds derived from the actual stored edge lengths.
This adds only four cached numbers, without another per-node index.
Queries reuse resident street data and
restore ordinary routing semantics on both success and error.

## Planned timetables and coordinated transfers

A `scenario` may add, replace or remove service using the existing portable
scenario contract. Frequency services default to sampled schedules during Monte
Carlo analysis. Set `exactTimes: true` to use fixed departures beginning at the
service start, repeating at the headway, excluding the service end. Explicit
`preserve-trips` schedules also stay fixed. Existing implicit single-time
scenario timetable behavior is retained for compatibility.

Studio's line editor can add, copy and remove timetable rows, with individual
weekday and exact-departure controls. The native contract accepts the same
`timetables` array on a service:

```json
"timetables": [
  {"id": "weekday-peak", "startMinutes": 420, "endMinutes": 540,
   "headwayMinutes": 6, "daysOfWeek": [1, 2, 3, 4, 5]},
  {"id": "weekend", "startMinutes": 480, "endMinutes": 1200,
   "headwayMinutes": 20, "daysOfWeek": [6, 7], "exactTimes": true}
]
```

Rows replace the top-level frequency window. ISO weekdays use 1 for Monday
through 7 for Sunday; omitting them means every day. Times after midnight remain
on their own service date, so a weekday row's runs after midnight continue into
the next day's clock, as scheduled service does. Every row is end-exclusive. Overlapping rows add
independent service, with independent random phases in simulation. IDs must be
unique within a service; a service accepts at most 32 rows. A missing row-level
`exactTimes` inherits the service's setting. Rows cannot be combined with
`preserve-trips` schedules.

A unidirectional, non-exact service can coordinate with another service:

```json
"phaseFrom": {
  "serviceId": "trunk",
  "atStopIndex": 0,
  "fromStopIndex": 5,
  "offsetMinutes": 2
}
```

The child departs its selected stop two minutes after the parent's selected
stop. At a terminal the arrival offset is used. References must identify one
frequency service; cyclic dependencies, exact services, ambiguous bidirectional
services, multiple active timetable rows and invalid stop indexes are rejected.
Phasing is available in native
Monte Carlo requests; Studio currently exposes the exact-times switch.
Phasing relates runs on the service date; a service's runs on adjacent service
days keep independent phases.
Unequal headways align only when their cycles coincide; phasing does not change
headways or guarantee every vehicle a transfer. Transfer buffers still apply.

## Speed and dwell edits

With `scheduleMode: "preserve-trips"`, an optional service `timing` object changes
running and standing time separately while keeping every trip's first departure:

```json
"timing": {
  "speedFactor": 1.2,
  "segmentIndexes": [0, 1],
  "dwellScale": 0.5,
  "stopIndexes": [1, 2]
}
```

Segment indexes start at zero; stop indexes refer to the edited stop order and
must be after the first stop. Omitted selections cover the entire pattern.
Moving times are divided by `speedFactor`; 1.2 means 20% faster travel, not 20%
less time. Dwell times can be multiplied by `dwellScale` or replaced with
`dwellMinutes`, but not both. Downstream times accumulate the changes; boarding
permissions, trip identities and baseline data are preserved. Invalid indexes,
non-monotone input times and excessive adjusted times are rejected.

Studio exposes whole-pattern speed and dwell controls when keeping scheduled
departures. Segment and stop selections are available through the native API.
These edits also work for ordinary single-time scenario routing.

## Opportunity counts and decay

An optional `monteCarlo.accessibility` computes indicators from each destination's
travel-time percentile. This is not the mean of accessibility computed separately
for every draw. Matrix counts follow destination order and are reused for every
origin; Reach counts follow the returned grid's row-major order.

```json
"accessibility": {
  "layers": [{"id": "jobs", "counts": [1200]}],
  "cutoffsMinutes": [30, 45, 60],
  "decayFunction": {"type": "logistic", "standardDeviationMinutes": 5},
  "dualThresholds": [100, 1000]
}
```

Counts may be fractional and must be finite and nonnegative. Results contain
`layers[].access[percentile][origin][cutoff]`, in weighted opportunities, and
`dualSeconds[percentile][origin][threshold]`, the minimum time to accumulate the
specified number of opportunities. Insufficient reachable opportunities produce
`null`, including when routing's horizon truncates the search.

Available decay functions are:

| Type | Parameters and interpretation |
|---|---|
| `step` (default) | Weight 1 strictly below the cutoff, otherwise 0. |
| `exponential` | Cutoff is the half-life. |
| `fixed-exponential` | Positive `decayConstant` in inverse seconds, at most 1; ignores cutoff. |
| `logistic` | Positive `standardDeviationMinutes`; cutoff has weight 0.5. |
| `linear` | Positive `widthMinutes`; tapers from 1 to 0 symmetrically around cutoff. |

Unreachable destinations receive zero weight. The routing horizon remains a
hard limit even for decay functions with long tails: choose a horizon sufficient
for the intended analysis and retain it with results. At most 16 layers, 16
cutoffs and 16 dual thresholds are accepted; aggregate output is bounded to one
million indicators. Spatial uploads and polygon-to-grid conversion are separate
from this engine request.

## Current boundaries

The mode is scheduled depart-at transit with walking access/egress. Realtime,
Flex, traffic, via points, per-draw itineraries and arrival windows are rejected.
Street-sampled Reach measures reachable street portions; cell-center Reach
routes to the cell coordinates. Keep that choice and the grid fixed when
comparing opportunities. Studio saves the simulation settings in JSON, CSV and
GeoJSON exports, and retains native distributions in its JSON result. Its
simulated surfaces do not report per-stop percentile counts.

Validation uses synthetic scheduled/frequency feeds, independently enumerated
vehicle departures, minute-by-minute exact results, coherent duplicate origins,
phased transfers, unreachable mass, repeatability and resident-state cleanup.
Run `npm run check:monte-carlo`; native decay and rank checks run with the Rust
unit tests. These are correctness checks, not evidence of worldwide routing
quality or feature parity with another product.
