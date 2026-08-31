# Walking and driving routing

VIGO exposes three Pathfinder modes through one local route boundary:

- **Transit** uses the compiled GTFS timetable, with an optional matched
  GTFS-Realtime trip-update overlay, and directed OSM walking for access,
  egress, and direct-walk competition.
- **Walk** finds the shortest directed pedestrian path between two coordinates.
- **Drive** finds the fastest directed motor-vehicle path between two
  coordinates under the configured distance ceiling, using free-flow weights
  or a fresh caller-supplied traffic snapshot.

No mode projects a coordinate to a GTFS stop before street routing. Transit and
standalone street routing use different declared attachment policies, and every
mode charges the complete connector distance. A genuine directed no-path result
is never replaced with a straight-line route.

## Street-store profiles

Coordinate Transit, standalone Walk, and Drive require the current street-store
schema, the sealed `runtime-snapshots-v1` layout, and the corresponding
immutable accelerator. A stale, source-layout, or incomplete store returns an
explicit rebuild requirement rather than selecting a compatibility path.

OSM imports persist separate walking and driving profiles:

- walking respects pedestrian access and directionality and optimizes distance;
- driving respects motor-vehicle access, one-way direction, roundabouts, and
  parsed or default speed values. Those values form the reusable free-flow
  metric.

The base driving profile does not model signals, turn costs, or
turn-restriction relations. A traffic snapshot can replace its edge times for
one query metric, but it does not invent those missing semantics.

## Live road traffic metric

Drive requests may include a bounded `trafficSnapshot`. A provider adapter
normalizes its source data into directed edge observations, each with exactly
one of `speedKph`, `travelTimeSeconds`, `delayFactor`, or `closed`. An
observation can identify an internal `edgeIndex`, an endpoint pair through
`fromCoordinate` / `toCoordinate`, or a short `coordinates` sequence. The
coordinate form is matched to directed edges within the declared
`snapRadiusMeters`; observations with no in-radius edge are disclosed and
ignored. Direct indices require the current street store's
`streetSourceFingerprint`, preventing an adapter from reusing indices after an
OSM graph rebuild.

VIGO keeps the road topology and contraction order immutable. The first query
for a new normalized snapshot lazily customizes only the resident CCH time
metric. Queries with the same normalized weights reuse that metric, while a
request without traffic continues to read the existing free-flow mmap metric.
The traffic metric never reduces an edge below its stored free-flow time, and
`closed` assigns the CCH unreachable weight. No second graph or traffic
runtime is retained.

Snapshots require `observedAt` plus `ttlSeconds` or `expiresAt`. Expired input
falls back explicitly to free flow. Requests are capped at 100,000 observations
and 250,000 matched edge updates. Diagnostics report freshness, matching,
closures, customization time, metric reuse, and the effective weight model.
The HTTP response cache is bypassed whenever a traffic snapshot is supplied.

This boundary is provider-neutral. API keys, proprietary traffic formats, and
vendor SDKs belong in thin adapters outside the routing core; adding a provider
does not add another route engine to VIGO.

## Live transit overlay

The local static GTFS store remains authoritative for stop order, service
identity, geometry, and the set of routable trips. When a current GTFS-RT
snapshot is supplied, the resident Rust timetable scan temporarily replaces
matched scheduled trips with their reported stop times, removes canceled or
deleted trips, and keeps every unmatched or unsupported trip on the scheduled
path. This means a feed refresh changes the temporal query without rebuilding
the SQLite store or the street snapshot.

Only an exact-date, depart-at trip-update overlay is currently exposed. The
overlay handles trip-level and stop-level delay/time events, refuses skipped or
unscheduled stop updates, and falls back explicitly when a feed is stale or
cannot be matched. Vehicle positions render directly on the map, while service
alerts remain visualization signals; neither is converted into invented
routing edges. A live plan is marked `realtime-adjusted` and reports its
applied/replaced/canceled counts in `diagnostics.realtimeRouting`.

## Runtime boundary

Pathfinder sends Transit, Walk, and Drive through the same
`POST /api/projects/:id/national-route` action. Street searches execute in the
resident route worker, outside the UI thread. The pedestrian and driving
snapshots are memory-mapped by the bundled Rust Node-API kernel; JavaScript
does not hydrate a second graph.

For coordinate Transit, one native call:

1. attaches both coordinates through the declared connector frontier;
2. selects every role-compatible stop or station anchor inside the walk cap;
3. runs the origin forward one-to-many expansion;
4. runs destination egress on the reverse directed graph; and
5. retains predecessor data only until selected access and egress paths are
   materialized.

Walking and driving use identity-bound binary accelerator artifacts beside the
authoritative SQLite store. The snapshot is admitted only when its source,
profile, version, and counts match the store. Partial artifacts fail closed;
there is no per-node SQLite fallback for standalone Walk or Drive.

For batch work, `POST /api/projects/:id/national-street-matrix` provides one
uniform scalar many-to-one or many-to-many contract for Walk and Drive. The
worker boundary and response rows are shared, while Rust keeps the correct
mode-specific objective: directed pedestrian distance for Walk and the active
free-flow or traffic-customized time metric for Drive. The matrix path returns
no geometry; use the normal
point route only for cells whose polyline is needed. Duplicate coordinates are
deduplicated before native search and expanded back to the requested row order.
The batch endpoint requires the current sealed pedestrian CCH artifact; a
missing or stale matrix accelerator is an explicit rebuild condition, not a
silent per-pair fallback.

Returned diagnostics separate complete route construction from graph search,
cache reuse, settled nodes, relaxed edges, profile, weight model, connector
distances, and any bounded snap recovery. Repeated-query latency is reported as
cache behavior rather than as new graph-search latency.

## Geometry and accessibility

The native polyline is the rendering source for Walk and Drive. Transit route
geometry remains the published GTFS shape when available; inferred geometry is
shown with its source and confidence. The renderer does not bridge unsupported
gaps across water, barriers, or disconnected graph components.

Accessibility uses the same directed pedestrian graph. It reports an area view
from finite edge-supported arrivals and a Street paths view containing the
directed edges reachable from the origin and from every transit stop reached
before the cutoff. Terminal walking consumes the time remaining before the
shared elapsed-time cutoff and remains capped by the selected walking distance.

## Rebuild and compatibility

Existing stores must be rebuilt when their schema or accelerator identity is
stale. Exact-stop transit remains independent of the street store. Rebuilding
the OSM street index does not require a GTFS reimport, and a raw PBF is never
parsed in the browser.

The current production path is intentionally one implementation: the bundled
Rust kernel owns graph search and path reconstruction, the local API owns
store admission and worker lifecycle, and the desktop only presents the
declared result.
