# Accessibility workspace and scenario-analysis architecture

## What the workspace does

VIGO 0.3.0 presents isochrone analysis and service planning in one
**Accessibility** workspace. A user selects one origin, a service date and
departure time, then compares the existing network with as many as six retained
cases. Each case may combine as many as eight line or policy interventions:

- add a new line by drawing its ordered stops on the map;
- enhance an existing line with a frequency or speed overlay;
- change an existing line by removing its baseline service and inserting a
  replacement service;
- remove an existing line; and
- change the walking budget or assumed walking speed.

The baseline remains visible beside the active case. The map can show the
baseline, the active case, or their difference. A case is an in-memory analysis
draft: it does not edit the imported GTFS feed, its persisted routing store, or
the canonical point-routing endpoint.

This page answers a single, explicit question:

> From this coordinate, at this date and departure time, which parts of the
> pedestrian network are reachable within the selected time?

It is not an opportunity-weighted regional accessibility model, a demand
assignment model, or a stochastic departure-window analysis.

## Shared routing ownership

Surface analysis uses a scalar one-to-many operator and returns a
`vigo.scenario-analysis.v1` envelope. Pathfinder asks for one reconstructed
itinerary, whereas Accessibility asks for earliest arrivals at many stops, but
both enter the same service-date-specific resident Rust `TimetableKernel` and
the same Rust `CoordinateKernel`. No second timetable image, regional compiler,
matrix fallback, or JavaScript transit search exists. Scenario requests do not
write temporary GTFS feeds or create a second routing runtime.

The analysis request contains:

```text
baseline:
  origin coordinate
  service date and departure time
  maximum walking distance
  walking speed
  raster resolution; display extent is derived from reached edges
  time cutoffs

case:
  excluded baseline route IDs
  zero or more added/replacement/overlay services
  optional walking-policy overrides
```

`radiusKm` initializes the diagnostic raster sampling envelope. It does not
select timetable targets or bound the desktop's reached-edge display; the
native result expands to the complete reached network.

## End-to-end computation

The production path requires both a ready persisted transit store and a ready
OSM pedestrian street index.

```text
origin coordinate
       |
       v
directed OSM access + optional scenario connectors
       |
       v
resident connections + query-scoped scenario connections
       |
       v
one generation-tagged merged one-to-many CSA
       |
       v
origin + reached resident and scenario stop seeds
       |
       v
directed OSM multi-source surface
       |
       v
complete reached-edge evidence + edge-envelope raster, area polygons, and contours
```

The raster is therefore **total-elapsed access walk + transit + terminal walk**.
Access, waiting, transit, transfers, and terminal walking share one cutoff.
Every selected stop can expand only through its remaining time and declared
maximum walking distance on the directed OSM pedestrian graph. A zero-minute
origin seed is always included, so walking-only reach remains visible when
transit is unavailable. Raster and edge values are total elapsed arrival times.

The system does not draw circles around the origin or reached stops. Buildings,
water, disconnected components, one-way pedestrian edges, and the topology of
the admitted OSM graph can prevent a cell from receiving a travel time.

## Resident one-to-many timetable range

Raster pixels are not routed as independent transit destinations. VIGO sends
every active timetable stop to the resident one-to-many query; no display-radius
or great-circle destination preselection is applied. The time horizon and the
declared OSM walking policy determine which stops and edges are actually
reachable.

The analysis:

1. reuses the resident active-service `TimetableKernel` already used by point
   and matrix routing;
2. computes the complete directed OSM access frontier for the coordinate;
3. projects access members and output stops into resident timetable indices;
4. marks any route-excluded trips with the current query generation; and
5. scans the resident national connection array once, returning an earliest
   arrival or blocked status for every selected output stop.

The free-coordinate path fuses access projection and timetable propagation into
one Node-API call. Stop labels, run state, and exclusions use generation tags,
so an ordinary query starts in constant reset time and stale state cannot leak
into the next request. The scan retains the point router's
event order, pickup and alighting permissions, same-run continuation, transfer
rules, and horizon semantics. It omits predecessors because a raster needs
scalar arrivals rather than itineraries.

The operation has no matrix destination cap, nearest-stop shortcut, sampled
transit destination set, geographic display crop, or request-local timetable
compilation. Journeys can leave the initial raster envelope and return because
the complete resident timetable is scanned; the final display envelope follows
the complete reached-edge geometry.

## OSM pedestrian surface

The unified Accessibility range operation invokes one native raster call that
performs the complete multi-source label search over the memory-mapped directed
walking graph. Scenario analysis consumes that returned surface; it does not
dispatch a separate final-raster operation. The worker does not hydrate a
JavaScript graph, run a JavaScript queue, or fall back to SQLite edge relaxation.

Each seed is `(coordinate, transit-arrival-minutes)`. After a bounded graph
snap, each internal street label retains:

```text
(absolute travel time, distance walked since this seed)
```

Both fields are required. An earlier label that has nearly exhausted its walk
budget does not dominate a later label that has more walking distance
remaining. A label dominates another label at the same graph vertex only when
it is no worse in both fields.

For an edge of length \(d_e\), the propagation rule is

\[
t(v)=t(u)+\frac{60d_e}{1000v_w},
\qquad
d(v)=d(u)+d_e,
\]

where \(v_w\) is the selected walking speed in kilometres per hour. Expansion
stops when either

\[
d(v)>D_{\max}
\quad\text{or}\quad
t(v)>T_{\max}.
\]

The engine interpolates the minimum settled travel time along reached directed
OSM edges into raster cells. Empty cells stay unreachable; they are not filled
by radial interpolation. Raster resolution changes spatial sampling and
display detail, while walking distance, walking speed, and time cutoff change
the underlying graph search.

Returned diagnostics include seed and snapped-seed counts, settled labels,
relaxed street edges, retained non-dominated labels, reached cells, the Rust
kernel identity, native query time, and worker-facing wall time.

### Edge evidence is the desktop authority; edge-envelope raster is the area view

The final surface search returns every reached directed OSM edge with endpoint
geometry, walk distance, the supporting transit-arrival time, and its exact
directed graph edge ID. The native result is already an indexed binary bundle,
and the scenario layer forwards it directly. Baseline/scenario comparison uses
the sorted edge IDs for a linear merge, while the desktop decodes the geometry
into batched `MultiLineString` features for **Street paths**. If both surfaces
are identical, the result uses an explicit baseline reference instead of
duplicating the bundle. After the same search, native code replays the retained
edge records into a compact raster whose bounds are the exact seed-and-edge
envelope; the server polygonizes that raster for **Accessible area**. This replay is not a
second routing search. The desktop renders vector polygons and contours
directly, without a rectangular raster image or a browser PNG canvas.
It does not serialize settled nodes or render an accessibility point cloud.

The native search still uses non-dominated `(absolute time, walk distance)`
labels internally, and the low-level `accessibility-range`/CLI contract may
include settled-node diagnostics when explicitly requested. That diagnostic
option is separate from the desktop scenario contract, which sets
`includeNodes=false` and `includeEdges=true`. No second node-routing or
raster-only executor is retained.

## Physical service edges are a separate evidence product

Accessibility answers reachability from an origin. A separate two-feed
service-edge comparison answers whether scheduled bus service is maintained on
the same physical road segment. VIGO reads published GTFS shapes, matches them
to local directed OSM `drive_edges`, and returns route-ID-independent edge
indicators for added, maintained, and removed service. It excludes patterns
without shape geometry or a complete match and never treats a pedestrian edge
as a bus alignment.

This supports physical-network comparison without maintaining a second transit
decomposition pipeline. VIGO's current unit is a directed local OSM edge; it
does not produce unverified stop-split map-matching records.

## OSM scenario connectors

Scenario-line access and transfers use the same persisted directed pedestrian
graph as the baseline and scenario rasters. They never infer a connection from
a short coordinate chord.

Before scenario service is propagated, the Accessibility owner builds three
directed connector sets in the resident Rust street kernel:

1. one scalar origin-to-scenario-stop row at time zero;
2. resident-stop-to-scenario-stop and scenario-stop-to-resident-stop endpoint
   frontiers; and
3. the full scenario-stop-to-scenario-stop matrix.

The production origin row has one seed and one scalar distance metric, so it
uses a directed CCH one-to-many query. The generic timed-connector API also
accepts multiple seeds, each with its own start time and walking-distance
budget. In that richer case, a street-vertex label is represented by

\[
L=(t,r),
\]

where \(t\) is absolute elapsed time and \(r\) is the seed's remaining walking
budget. Label \(L_1\) dominates \(L_2\) only if

\[
t_1\le t_2
\quad\text{and}\quad
r_1\ge r_2.
\]

This preserves a later transit seed when it can walk farther than an earlier
seed whose egress budget is nearly exhausted. Origin, edge, and destination
snap distances all consume the same seed budget.

For at most 256 declared scenario stops, the worker also computes the full
directed stop-to-stop OSM time and distance matrix. Scenario propagation uses
only finite matrix entries. Thus a one-way footpath may permit \(i\rightarrow
j\) while blocking \(j\rightarrow i\), and two visually adjacent stops remain
disconnected when no admitted OSM path joins them.

The ordinary single-seed origin row and scalar scenario stop-to-stop matrix use
directed CCH one-to-many/many-to-many queries over the same exact distance
weights; duration is distance divided by the query walking speed. The Rust
Pareto label engine remains only for a true multi-seed timed-budget request,
where start times and remaining walking resources cannot be represented by one
scalar CCH metric, and as the exact diagnostic-fixture fallback when no CCH is
admitted. The resulting sparse transfers are passed directly to the merged
timetable scan inside the same Accessibility request. JavaScript validates,
projects, checks cancellation, and shapes the response; no shadow graph
executor is retained.

The production API requires the unified Accessibility operation and its
resident street/timetable dependencies. It fails closed when the directed OSM
graph is unavailable and never substitutes planar distance for a street path.

Declared scenario services are flattened into immutable stop-index and offset
arrays and compiled as finite query-scoped events inside the same resident Rust
`TimetableKernel`. The kernel merges baseline and overlay events in chronological
order and relaxes finite directed OSM transfer edges across their combined stop
domain. There is no separate scenario router, JavaScript relaxation loop, capped
round count, or sampled transfer neighborhood.

An overlay stop that explicitly names the same GTFS stop receives a pair of
zero-second identity edges. Every non-identity connector uses its finite
directed OSM time, which is itself the explicit interchange duration. A
zero-second identity edge does not bypass the generic timetable transfer rule:
after a ride, the next boarding must be at least 180 seconds later, with exact
equality allowed. Origin-side pre-ride transfers are relaxed before scanning.
The required regression therefore exercises
baseline -> zero-second identity -> overlay -> zero-second identity -> baseline
at the exact ready-time boundary, one second before it, and after the resident
tail has been missed.

## Scenario semantics

### Add line

An added line is an ordered list of map-sketched stops with an operating
window, headway, average speed, dwell, and optional reverse direction. It is
relaxed on top of baseline arrivals.

### Enhance line

An enhancement takes the ordered stops of an existing route and overlays a
declared frequency/speed service. Baseline service remains available. The
desktop searches the complete compact route catalog; the API derives the
selected route's ordered representative stop pattern directly from the
persisted timetable, so the operation is not limited to routes drawn in the
initial map preview.

### Change line

A change excludes the selected baseline route from a second range search and
adds the declared replacement service. This is a route-level counterfactual,
not an edit of individual scheduled trips. When one public line identity has
multiple stored GTFS route variants, all variants in the same feed scope are
excluded. The replacement overlay follows the stored representative ordered
stop pattern.

### Remove line

A removal excludes the selected route from the case range search. Other routes,
transfers, service calendars, and pedestrian access remain unchanged.
Public-line selections expand to all matching stored route variants within the
same feed scope.

### Policy

A policy intervention changes the active case's maximum walking distance
and/or walking speed. Because these parameters affect transit access as well as
egress, the case runs its own unified Accessibility one-to-many query.

A case can mix these operations. Route exclusions are deduplicated before
dispatch, and changed lines are represented by both an exclusion and a
replacement service.

## Baseline and case execution

A request first runs the baseline unified Accessibility range. When the active
case changes service or walking policy, it then runs a second Accessibility
range against the same resident kernels with the case's exclusions, policy,
and query-scoped service overlay. The overlay scan can transfer from baseline
to scenario service, between scenario services, and back to baseline service.

Each range returns its own final OSM surface. This avoids representing a service
cut as visual subtraction and prevents scenario analysis from maintaining
separate connector or raster execution paths. A request with no case changes
reuses the baseline surface bytes as the case surface.

Progress is monotone across fixed windows:

```text
0.00–0.08  optional preliminary walking preview
0.08–0.52  baseline Accessibility range, including final surface
0.52–0.98  case Accessibility range, including connectors and final surface
1.00       complete
```

Cancellation is checked around resident native timetable and street calls and
during asynchronous surface assembly. Large timetable and OSM arrays remain in
the isolated route worker and never enter React.

## HTTP example

`POST /api/projects/:projectId/scenario-analysis`

```json
{
  "feedId": "__project__",
  "origin": {
    "coordinate": [-77.0365, 38.8977],
    "label": "Origin",
    "source": "map"
  },
  "departMinutes": 480,
  "serviceDate": "2026-07-20",
  "serviceDay": "weekday",
  "maxWalkKm": 1.2,
  "walkSpeedKph": 4.8,
  "rasterSize": 96,
  "cutoffsMinutes": [15, 30, 45, 60],
  "scenario": {
    "id": "case-b",
    "name": "Frequent line with wider walking access",
    "excludedRouteIds": ["route-to-replace"],
    "policy": {
      "maxWalkKm": 1.6,
      "walkSpeedKph": 4.8
    },
    "services": [
      {
        "id": "replacement",
        "name": "Replacement line",
        "operation": "replace",
        "bidirectional": true,
        "headwayMinutes": 10,
        "startMinutes": 360,
        "endMinutes": 1320,
        "averageSpeedKph": 24,
        "dwellMinutes": 0.35,
        "stops": [
          {
            "id": "a",
            "label": "A",
            "coordinate": [-77.07, 38.90]
          },
          {
            "id": "b",
            "label": "B",
            "coordinate": [-77.00, 38.90]
          }
        ]
      }
    ]
  }
}
```

## Declared limitation

The response retains `street_network_cell_sampling`: each raster cell is
supported by a reached directed OSM edge, and the engine does not infer times
for empty space between disconnected street edges. Baseline-to-scenario,
scenario-to-baseline, and scenario-to-scenario timetable transfers are
supported; the former
`no_baseline_transit_after_scenario` limitation no longer applies.

## Verification gates

The retained checks require:

1. directed OSM edges prevent a reverse or across-barrier circular halo;
2. a short coordinate chord remains blocked when the OSM graph has no path;
3. the scenario-stop matrix preserves one-way directionality;
4. per-seed walking budgets preserve a later seed with more remaining range;
5. walking-distance and walking-speed controls change graph travel times;
6. additive cases never worsen an already reachable baseline cell;
7. destructive and policy cases issue a separate range request with the exact
   route exclusions and walking parameters;
8. a mixed fixture completes a baseline-to-scenario-to-baseline journey and a
   new service expands the reachable surface;
9. raster bytes and contour ordering are deterministic;
10. cutoff membership is monotone;
11. progress never moves backwards and cancellation remains cooperative;
12. cached results repeat no transit or street dispatch, while an uncached case
    uses no separate connector or final-surface worker dispatch;
13. TypeScript, UI contracts, unified Accessibility routing, and production
    builds pass;
14. source ownership checks prove that former regional timetable/topology
    kernels and their worker operation are absent.
15. the overlay CSA agrees with a finite reference implementation at the
    zero-second identity and 180-second ready-time boundaries; and
16. the native module rebuilds cleanly and reports deterministic result
    identities for repeated fixtures.

## Storage and reproducibility

Canonical and temporary GTFS databases are never copied or modified by the
workspace. Results are held in a bounded in-memory analysis cache keyed by
immutable transit/street artifact identity and the complete request. The active
workspace holds a residency lease for the selected service-date timetable and
coordinate-access profile; leaving it permits normal memory-pressure eviction.

For a large retained test, pass an explicit `--output-dir` outside the source
tree. Persist the raw request, result, artifact identities, application
version, and returned diagnostics when an analysis must be reproduced outside
the desktop session.
