# VIGO 0.3.0 local HTTP API

VIGO's HTTP surface is a private implementation API between the web-rendered
desktop interface and the bundled local runtime. It is useful for local
automation and release tests, but it is not a hosted service or a stable public
SDK. Bind it to loopback only; 0.3.0 accepts requests addressed to `localhost`,
`127.0.0.1`, or `::1` and rejects non-local socket addresses, Host values, and
browser Origin values.

`VIGO_HOST` cannot select a non-loopback address unless
`VIGO_UNSAFE_ALLOW_NON_LOOPBACK=1` is also set. That override only permits the
listener to start; remote socket addresses are still rejected. VIGO does not
provide authentication for operation as a network service.

The server is started by `VIGO.app` on an available loopback port. A source
checkout can run it at `http://127.0.0.1:5179` with `npm run api`. Scripts that
need a stable cross-release interface should prefer the
[SQLite CLI](vigo-cli.md).

## Endpoint inventory

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Version, storage/config state, offline posture, and routing-worker diagnostics. |
| `GET`, `POST`, `PATCH` | `/api/config` | Read or update the local runtime configuration. |
| `GET`, `POST` | `/api/projects` | List compact project records or create `{ "name", "region" }`. |
| `GET`, `PATCH`, `DELETE` | `/api/projects/:id` | Hydrate, update, or remove one local workspace. `DELETE` removes its full isolated workspace folder. |
| `GET` | `/api/projects/:id/local-streets?west=...&south=...&east=...&north=...&zoom=...` | Return a bounded GeoJSON view of the sealed local OSM pedestrian snapshot for the map canvas. |
| `GET` | `/api/projects/:id/reproducibility` | Export source fingerprints, routing-store identities, preparation timings, job states, and contract versions as a JSON manifest. |
| `POST` | `/api/projects/:id/gtfs-route-analysis` | Read complete route-pattern, stop, timetable, and geometry analysis from the project's persisted SQLite GTFS store. |
| `POST` | `/api/projects/:id/national-gtfs-import` | Start a local-path GTFS ZIP to SQLite build. Native shell use only. |
| `POST` | `/api/projects/:id/national-gtfs-upload?fileName=feed.zip` | Stream raw ZIP bytes to bounded local staging, then start the same SQLite builder. |
| `GET` | `/api/projects/:id/national-gtfs-job?jobId=...` | Poll GTFS or OSM import status. |
| `POST` | `/api/projects/:id/national-osm-import` | Start a local-path OSM PBF to SQLite street-index build. Native shell use only. |
| `POST` | `/api/projects/:id/national-osm-upload?fileName=area.osm.pbf` | Stream raw PBF bytes to bounded local staging, then start the same SQLite builder. |
| `POST` | `/api/projects/:id/national-ready` | Admit the selected timetable store, start coalesced exact preparation, and return service coverage/readiness state. |
| `POST` | `/api/projects/:id/national-route` | Return one final plan plus the bounded choice set. |
| `POST` | `/api/projects/:id/national-matrix` | Return depart-at scalar travel-time rows. Internal/HTTP only; not a direct CLI endpoint. |
| `POST` | `/api/projects/:id/national-street-matrix` | Return directed Walk or Drive scalar distance/time rows through the resident Rust street kernel. |
| `POST` | `/api/projects/:id/scenario-analysis` | Return baseline/case total-elapsed access-walk + transit + terminal-walk surfaces for mixed line and walking-policy interventions. |
| `POST` | `/api/projects/:id/service-edge-decomposition` | Compare scheduled bus service from two feeds on the project's local directed OSM driving edges. |
| `POST` | `/api/projects/:id/routing-residency` | Acquire or release a lease that prevents ordinary idle expiry of the selected routing worker. |
| `POST` | `/api/projects/:id/national-search` | Search stops, or resolve exactly two paired query strings. |
| `POST` | `/api/realtime/inspect` | Inspect a caller-supplied GTFS-RT source. This is the remote-feed URL surface. |

Project artifacts and completed local jobs also have internal POST endpoints.
They are presentation persistence, not routing interfaces.

`gtfs-route-analysis` is a read-only visualization endpoint introduced in
0.1.6. A request supplies `{ "feedId": "feed_...", "routeId": "..." }`.
The response keeps every distinct stop-sequence pattern for that public
service and reports exact indexed trip/stop counts, timetable span, median
headway, stop-pair summaries, and either published-shape or ordered-stop
geometry. It never dispatches or modifies the routing engine.
In a merged store, the canonical `routeId` is globally scoped. Its embedded
source scope is authoritative for focused analysis even when the project UI
also supplies an outer feed container ID; the outer ID cannot filter a valid
inner bus or rail route out of the analysis.

`national-search` groups platforms, entrances, and pathways under their parent
station. Exact canonical names rank ahead of longer prefix matches; alias hits
return the canonical parent name and coordinate. A valid service-platform
coordinate is used only when the parent location is absent or a `(0, 0)`
placeholder, and pathway nodes never contribute to the returned coordinate.

## Static import lifecycle

Static feeds are local files, not URLs. A native path request sends
`{ "sourcePath": "/absolute/path/feed.zip" }`; a browser upload sends raw file
bytes. Both routes reach `national-gtfs-worker.mjs`, which writes a temporary
SQLite database and commits it only after indexing succeeds. OSM follows the
same lifecycle for `.osm.pbf` or `.pbf`. Uploaded staging files are deleted on
success and retained after failure or cancellation when a retry is possible.
The default source-upload ceiling is 8 GB and can be changed only by the local
runtime configuration.

The job response is asynchronous:

```json
{ "job": { "id": "national_gtfs_...", "status": "running" } }
```

Poll the job endpoint until `status` is `complete`, `failed`, or `cancelled`; then
refresh the project record to obtain the new feed ID and SQLite routing-store
metadata. Failed or cancelled jobs retain their uploaded source and may be
retried with `POST /api/projects/:id/national-job-retry` using the old `jobId`.
An in-flight job that is discovered after a server restart is marked
`preparation_interrupted` and follows the same retry path.

`GET /api/projects/:id/reproducibility` returns a portable manifest with
`schemaVersion: "vigo.reproducibility.v1"`. It intentionally excludes local
source paths while retaining content fingerprints, store build identities,
preparation phase timings, and the `vigo.routing.status.v1` contract version.

`local-streets` is deliberately a viewport-sized rendering surface, not a raw
PBF download or a second routing engine. It reads the immutable pedestrian
snapshot beside the authoritative SQLite metadata, removes reverse duplicates
for display, caps the response at 16,000 line features, and fails closed when
the workspace has no sealed OSM street index.

## Readiness and one-to-one routing

Admit the timetable store and request the service context before an interactive
query:

```json
{
  "feedId": "feed_...",
  "serviceDate": "2026-07-16",
  "serviceDay": "weekday",
  "allowServiceDateFallback": false
}
```

`national-ready` returns after date-independent SQLite store admission. It does
not wait for the active-date kernel, complete transfer validation, street
accelerator, OSM stop transfers, native coordinate-access profile, route
geometry, or pipeline prewarm. A cold response makes the distinction explicit:

```json
{
  "routing": {
    "ready": true,
    "activeServiceKernel": {
      "ready": false,
      "reason": "background_preparation"
    },
    "accessPreparation": {
      "state": "warming",
      "background": true
    }
  }
}
```

The server starts that exact preparation as one coalesced
`prepare-routing-access` operation in the same worker. Concurrent readiness
requests share it. A `national-route` request submitted before it completes
joins and waits for it, then uses the normal exact native routing path; the API
does not substitute a second executor or a geometric fallback.

Readiness callers wait up to 180 seconds for the shared preparation by default
(`VIGO_ROUTE_PREWARM_WAIT_TIMEOUT_MS`). The shared cold build
has a separate 300-second safety limit (`VIGO_ROUTE_PREWARM_HARD_TIMEOUT_MS`).
A waiter timeout does not cancel work shared with other callers.

While the desktop routing workspace is open, it posts a unique lease:

```json
{
  "feedId": "feed_...",
  "resident": true,
  "leaseId": "desktop-workspace-..."
}
```

Posting the same `leaseId` with `resident: false` releases that ownership. More
than one workspace may hold the worker, so callers must release the same lease
they acquired. Residency prevents ordinary idle and capacity eviction; explicit
project retirement or runtime shutdown still terminates the worker.

A routing point has `[longitude, latitude]`, a label, a source, and an optional
GTFS stop ID:

```json
{
  "feedId": "feed_...",
  "origin": {
    "coordinate": [-71.0551, 42.3523],
    "label": "South Station",
    "source": "stop",
    "stopId": "70079"
  },
  "destination": {
    "coordinate": [-71.1189, 42.3734],
    "label": "Harvard",
    "source": "stop",
    "stopId": "70068"
  },
  "departMinutes": 480,
  "timePreference": "depart",
  "serviceDate": "2026-06-10",
  "serviceDay": "weekday",
  "allowServiceDateFallback": false,
  "maxWalkKm": 1.2,
  "allowLongWalk": true,
  "includeEarliestTransit": true,
  "departureWindowMinutes": 0
}
```

The response is atomic: `{ "plan": ..., "choices": [...] }`. A departure
window of 1--30 minutes is depart-at only and returns the final normalized
choice set in that same response. The UI cancels superseded HTTP work and uses
a latest-request token before committing a result, so an older response cannot
rewrite a newer one. Readiness, preparation, route search, access, and
materialization timings remain distinct in diagnostics. When requested,
`earliestTransit` reports the earliest first boarding among all sampled
scheduled options in the bounded window, or a bounded no-option diagnostic
when the visible result is walk-only.

Each returned choice keeps `durationMinutes` as the displayed leave-to-arrival
journey duration. For a later departure, the initial wait from the request is
reported through the departure-window diagnostics and is not folded into the
journey duration shown by the desktop card. The choice filter can therefore
retain a shorter later journey as an explicit alternative even when it arrives
slightly later than the top result.

For a resident interactive worker, preparation is paid once and each response
still reports its own routing and materialization timing. The complete-result
cache is an implementation cache, not a semantic fallback: a cache hit is
identified explicitly and a new query remains bound to the same source and
policy identities. Timing observations must keep preparation, first-touch, and
repeat-query behavior separate rather than turning one into a release gate.

`alternativeMaxWalkKm` is an explicit expanded-walking diagnostic
envelope. When it is greater than `maxWalkKm`, the same worker may run a
bounded set of additional station-access and egress searches before returning
the atomic response. Ordinary desktop requests do not send this field, so they
do not pay that work. Returned alternatives are deduplicated by concrete
route/boarding/alighting identity; two cards may share public line labels only
when they use different boarding chains.

Desktop and lower-level map points require a ready, identity-current OSM street
index and native snapshot. Explicit stop-to-stop requests can run without one;
coordinate requests without OSM fail closed rather than using a geometric
route approximation.
Coordinate Transit uses costed virtual connectors, never zero-cost
same-component snaps. The endpoint frontier admits every reciprocal-edge
projection no farther than 80 m whose endpoints lie within 160 m and the
nearest vertex of every weak pedestrian component intersecting that
neighborhood, but only after a street node or reciprocal projection establishes
a primary attachment within 80 m. Full connector distance counts against the
walk budget; only bidirectionally dominated connectors are removed. The generic
point-to-point street API retains its narrower anonymous-coordinate attachment
rule.

## GTFS-Realtime trip updates

`POST /api/realtime/inspect` accepts either a direct GTFS-Realtime protobuf URL
or a `viz.rt.gtfs.zone` viewer URL:

```json
{
  "url": "https://viz.rt.gtfs.zone/#static=...&rt_vp=...&rt_tu=...&rt_al=..."
}
```

Viewer links are resolved server-side into their `rt_vp`, `rt_tu`, and `rt_al`
feeds. The linked static GTFS URL is not imported by this endpoint; it remains
the local routing store's source of truth and must already match the selected
project feed. The response combines vehicle positions, trip updates, and
alerts into one snapshot.

The MBTA standard feed URLs are treated as one documented feed set. Supplying
any one of `VehiclePositions.pb`, `TripUpdates.pb`, or `Alerts.pb` on
`cdn.mbta.com/realtime/` fetches all three standard protobuf feeds and combines
them into the snapshot. This is feed expansion, not routing inference: the
static timetable and street graph are unchanged.

Callers can also name the three feeds explicitly:

```json
{
  "urls": {
    "vehicles": "https://cdn.mbta.com/realtime/VehiclePositions.pb",
    "tripUpdates": "https://cdn.mbta.com/realtime/TripUpdates.pb",
    "alerts": "https://cdn.mbta.com/realtime/Alerts.pb"
  }
}
```

Only Vehicle Positions provides map coordinates. Trip Updates and Alerts enrich
the same snapshot but never act as a visual fallback for missing vehicles.

Remote feeds must use HTTP or HTTPS, resolve only to public addresses, contain
no embedded credentials, and return directly without redirects. VIGO streams
each response under a 20 MB limit. `DIFFERENTIAL` incrementality is rejected;
configure a `FULL_DATASET` feed because VIGO does not retain the entity state
required to apply differential updates. Local development against a private
feed requires the explicit `VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME=1` override.

Pass that snapshot back on a transit `national-route` request as
`realtimeSnapshot`. VIGO applies matched `SCHEDULED` trip updates to the
resident Rust connection scan and supports both per-stop delay/time events and
trip-level delays. `CANCELED` and `DELETED` trips are removed from that query.
The normal scheduled scan remains the explicit fallback when a full-dataset feed is stale,
the trip is not present in the local static feed, the update is an unsupported
added/replacement/unscheduled trip, or the overlay cannot be queried. Live
requests bypass both the HTTP response cache and the route-result cache.

The routing overlay is intentionally bounded to 256 matched trip updates and
4,096 stops per query. Diagnostics report `realtimeRouting.status` as `applied`,
`cancellations_only`, or a named scheduled fallback, together with the matched,
replaced, canceled, unsupported, and unmatched counts. That query bound does
not cap the map: every vehicle with a valid finite position in the returned
snapshot is rendered, and the simulated fleet pauses while positioned live
vehicles are active. In the current UI, Live and Schedule are explicit sources:
an empty or failed live refresh never activates Schedule, and both sources use
the same normalized map-frame contract. Vehicle positions and alerts remain displayed context;
none invent travel times or override the static timetable. Arrive-by requests
and new unscheduled trips remain on the scheduled contract until they have an
explicit temporal model.

## Live road traffic

A Drive `national-route` or `national-street-matrix` request may carry a
provider-neutral `trafficSnapshot`:

```json
{
  "mode": "drive",
  "origin": { "coordinate": [-77.0502, 38.8895], "label": "Origin", "source": "map" },
  "destination": { "coordinate": [-77.0365, 38.8977], "label": "Destination", "source": "map" },
  "departMinutes": 510,
  "trafficSnapshot": {
    "source": "provider-adapter",
    "streetSourceFingerprint": "current OSM source fingerprint",
    "observedAt": "2026-08-23T12:29:00Z",
    "ttlSeconds": 300,
    "snapRadiusMeters": 120,
    "observations": [
      {
        "fromCoordinate": [-77.0502, 38.8895],
        "toCoordinate": [-77.0491, 38.8901],
        "speedKph": 18
      },
      { "edgeIndex": 12345, "delayFactor": 2.4 },
      { "edgeIndex": 23456, "closed": true }
    ]
  }
}
```

Each observation declares exactly one of `speedKph`, per-edge
`travelTimeSeconds`, `delayFactor`, or `closed`. It identifies directed edges
with an internal `edgeIndex`, one `fromCoordinate` / `toCoordinate` pair, or a
short `coordinates` sequence whose consecutive pairs are matched separately.
The edge-index form is the efficient normalized boundary for a provider
adapter and requires the current street store's `streetSourceFingerprint`, so
indices from a rebuilt graph cannot be applied accidentally. Coordinate
matching is convenient for sparse feeds and diagnostics. Pairs with no edge
inside the snap radius are ignored and counted.

`observedAt` is required. `ttlSeconds` defaults to 300 and is capped at 1,800;
an explicit `expiresAt` may replace the derived expiry. Stale snapshots return
a free-flow route with `diagnostics.traffic.status = "stale_fallback"`.
Fresh snapshots are capped at 100,000 observations and 250,000 matched edge
updates. Adjusted weights cannot be faster than VIGO's stored free-flow time,
and a closure receives the CCH unreachable weight.

The OSM graph and CCH order remain immutable. VIGO hashes the normalized edge
weights, lazily customizes the resident time metric for a new hash, and reuses
that metric across subsequent routes and matrices. Supplying a snapshot
bypasses the HTTP response cache; diagnostics disclose match counts, closures,
customization time, reuse, and the effective `weightModel`. Provider fetching,
credentials, and proprietary decoding stay outside the core runtime.

## Matrix routing

`national-matrix` is a 0.3.0 HTTP/internal surface; it is not exposed as a
direct CLI command. Its request adds `origins`, `destinations`, and optional
`matrixStrategy: "auto" | "shared" | "pairwise"` to the same service context.
It is depart-at only, accepts at most 256 origins, 256 destinations, and 50,000
pairs, and clamps an explicit horizon to 1--2,880 minutes. `auto` selects shared
execution from 4 unique destinations when an active kernel is available.
The horizon bounds connection departures and ride alightings; a terminal
destination egress may finish after it but cannot expand or board another run.

The response contains `{ "matrix": { "schemaVersion":
"vigo.routing.matrix.v1", "rows": [...], "diagnostics": ... } }`. Rows are
scalar status/departure/arrival/duration values, not itineraries or polygons.
Shared and pairwise rows are parity-tested only under the same prepared
endpoint-candidate policy; the modes do not perform equal output work. Both
matrix strategies expose the represented-graph cycle policy and the
earliest-arrival `fastest` objective. Pairwise reference execution forces that
objective even when an ordinary point caller requests `balanced`. Lower-level
point replay can request `returnedStationCyclePolicy: "represented"` for exact
scalar parity; ordinary point routing defaults to `"suppress"` as a post-search
product presentation policy and may therefore hide a returned-station itinerary.

## Street matrix routing

`national-street-matrix` is the batch Walk/Drive surface. Its request requires
`mode: "walk" | "drive"`, `origins`, and `destinations`; each point is either a
`[lon, lat]` pair or an object with `coordinate: [lon, lat]`. It accepts at most
256 unique-side inputs and 50,000 origin-destination pairs. Duplicate points
are snapped and searched once, then expanded back to the caller's original row
order. The selected project must have the current sealed street CCH artifact;
if it is absent or stale, rebuild the OSM street index instead of accepting a
hidden per-pair fallback.

Both modes use the same scalar response and resident-worker boundary, while
retaining their correct Rust weight models: Walk minimizes directed pedestrian
distance and derives duration from `walkingSpeedKph`; Drive minimizes the
active free-flow or traffic-customized time metric and reports its
corresponding distance. The batch path
does not reconstruct a polyline per pair, so it is the appropriate many-to-one
or many-to-many operator. Point-to-point `national-route` remains the geometry
surface.

The response is `{ "matrix": { "schemaVersion":
"vigo.routing.street-matrix.v1", "mode": ..., "rows": [...],
"diagnostics": ... } }`. A ready row has `distanceKm` and
`durationMinutes`; a directed no-path row is `blocked` with null scalar values.
The diagnostics identify the Rust matrix engine, CCH acceleration, candidate
counts, duplicate reduction, and native query time.

## Accessibility and scenario analysis

`scenario-analysis` calls the unified native Accessibility range operation. It
reuses the national active-service `TimetableKernel` and coordinate-access
profile prepared by the workspace residency lease; it does not use the matrix
destination cap or compile a second regional timetable. The single
Accessibility workspace submits one active case,
which may combine an added line, an enhancement overlay, a route-level
replacement, a route removal, and walking-policy changes. Empty services and
exclusions return the baseline surface. Destructive or walking-policy changes
run an independent case range; they are not visual subtraction from an
unchanged result.

Every active timetable stop is considered by one generation-tagged scan of the
resident connection array, and a direct-walk seed guarantees that the surface
does not disappear when transit is unavailable. There is no geographic target
selection. Baseline egress, case egress,
proposed-stop access, and proposed stop-to-stop transfers use the persisted
directed OSM pedestrian graph. Query-scoped scenario connections are merged
chronologically with the resident timetable, so journeys may cross baseline
and scenario service in either direction. The same Accessibility operation
owns those connectors and returns the final surface; scenario analysis has no
separate connector or raster executor. Its scalar origin connector row and
directed scenario-stop matrix share the resident street CCH, while the native
Pareto street operator is retained only for genuinely multi-seed timed-budget
semantics. Production rejects the request when the graph is unavailable; it
does not paint Euclidean circles or connect nearby
stops across barriers. The response
contract, raster encoding, bounds, exact output-envelope proof, performance
guards, and explicit modeling limitations are defined in
[`scenario-analysis-architecture.md`](scenario-analysis-architecture.md).

The endpoint reads canonical SQLite stores but never modifies or copies them.
It does not enter point-routing responses or CLI routing.

Clients may send `Accept: application/x-ndjson`. The response then emits
newline-delimited events:

- `preliminary` contains the immediate direct-walk surface;
- `progress` reports monotone access, target selection, timetable, search, and raster
  phases;
- `complete` contains the refined `analysis`; and
- `error` contains a terminal message.

Disconnecting cancels the range operation. The worker uses a shared
cancellation flag and keeps the valid resident service-date kernel instead of
restarting after an ordinary cancellation.

`POST /api/projects/:id/scenario-analysis-residency` accepts
`{ "feedId": "...", "resident": true | false, "serviceDate": "YYYY-MM-DD",
"serviceDay": "weekday" | "saturday" | "sunday" }`. On acquisition, the
desktop prepares the matching active-service kernel and coordinate-access
profile before the first clicked analysis. It releases the lease on exit.

## Physical service-edge comparison

`POST /api/projects/:id/service-edge-decomposition` accepts exactly two ready
feed IDs:

```json
{
  "baselineFeedId": "feed_baseline",
  "comparisonFeedId": "feed_comparison"
}
```

The endpoint reads published GTFS shape geometry from each feed, samples it
against the project's sealed driving snapshot, and returns a
`vigo.service-edge-decomposition.v1` GeoJSON collection. Each directed runtime
edge has `serviceIndicator` `0` (baseline only), `1` (comparison only), or `2`
(maintained), plus route names, pattern counts, and trip counts for each side.
The diagnostics include match coverage and explicitly report the local OSM
source fingerprint. Runtime edge IDs are immutable snapshot ordinals; source
OSM way-ID tables are not retained in the published store.

This is the VIGO contract for physical scheduled-service comparison, not a
replacement for accessibility analysis. It is route-ID independent, uses the
driving graph rather than the pedestrian graph, and fails closed for patterns
without published shapes or with partial/unmatched geometry. It does not infer
missing roads from straight stop-to-stop chords or split an edge at every stop;
the current geometry unit is one directed local OSM edge.

## Errors, cancellation, and compatibility

- JSON bodies above the local project-body limit and uploads above the source
  limit return `413`.
- Missing projects return `404`; a missing or unready routing store returns
  `409`; unsupported matrix modes return `400`.
- Route, matrix, and Accessibility-analysis connections propagate client
  disconnects as abort signals.
  A superseded result is discarded without immediately destroying a prepared
  worker; bounded cancellation policy protects the resident kernel.
- Routing-level blocked results use the stable failure codes documented in the
  [routing contract](routing-contract.md). Transport errors use
  `{ "error": "..." }`; a universal versioned HTTP error envelope is still
  future work.
- A previously unseen service set may require a one-time active-kernel build.
  `national-ready` starts that work after store admission; the first route waits
  for the same coalesced preparation if it is still running. Readiness latency,
  first-route latency including preparation, and warm route latency are separate
  measurements.
- Broad out-of-range date choices use returned `serviceCoverage` metadata. For
  an in-range date whose merged-feed service is incomplete, exact date
  suggestions may be returned with the blocked route result after the active
  calendar is inspected. Selecting a suggestion remains explicit and never
  issues an implicit fallback route request.
- Endpoint paths and payload shapes may change within the desktop product.
  Check `/api/health` for `version` and pin automation to the intended VIGO
  release, or use the CLI for a documented process boundary.
