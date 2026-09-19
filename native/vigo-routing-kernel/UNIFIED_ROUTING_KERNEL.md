# Native routing kernel

The resident Rust kernel owns timetable and directed street search. JavaScript validates requests, prepares inputs, and presents results; it does not supply a second routing implementation. Start with the [application architecture](../../docs/development/architecture.md) for process and storage boundaries.

## Source map

| Source | Responsibility |
| --- | --- |
| [lib.rs](src/lib.rs) | Node-API boundary, coordinate kernel, street access and matrix integration |
| [timetable.rs](src/timetable.rs) | Chronological timetable propagation, transfer constraints, range and matrix queries |
| [timetable/journeys.rs](src/timetable/journeys.rs) | Selected matrix journey witnesses |
| [timetable/overlay_quality.rs](src/timetable/overlay_quality.rs) | Overlay quality and timetable regressions |
| [terminal_access.rs](src/terminal_access.rs) | Directed endpoint and station access |
| [street_analysis.rs](src/street_analysis.rs) | Reach surfaces and timed connectors |
| [exact_routing.rs](src/exact_routing.rs) | Drive search and distance-constrained fallback |
| [street_snapshot.rs](src/street_snapshot.rs) | Retained street data |
| [snapshot_validation.rs](src/snapshot_validation.rs), [timetable_validation.rs](src/timetable_validation.rs) | Input bounds and snapshot admission |

## Timetable and overlays

Transit uses native connection scans over immutable prepared timetable data. Forward scans solve depart-at requests; reverse scans establish arrive-by feasibility. Matrix shares scans by unique origin or destination and optionally materializes selected journeys.

Planned Reach changes compile bounded overlay services into chronological connections. Resident and overlay events share stop/run state and directed transfer adjacency. Exclusions apply to the requested overlay; the baseline remains immutable. Equal-time events must preserve legal boarding independent of input ordering.

There is **no implicit boarding slack**. Published minimums and forbidden transfers govern changing vehicles; staying aboard retains its trip state. A zero-time overlay identity edge requires the same declared GTFS stop identity. Other connectors need a directed OSM path. Identity links do not waive explicit transfer restrictions. See the [Route contract](../../docs/routing.md) and [GTFS support matrix](../../docs/gtfs-support-matrix.md).

## Reach and street access

Reach prepares directed access from the origin, propagates through the timetable and any scenario overlay, then seeds a native walking surface from the origin and reached stops. A preliminary walking preview is separate from the final answer.

Timed connectors with one origin and a common distance policy can use CCH scalar searches. Multiple seeds with different arrival times or remaining walking budgets require a nondominated resource frontier. A later seed may still reach farther; retaining only the earliest label is insufficient.

No straight-line substitute creates a missing street connection. Directed geometry, walking budgets, and source identities remain part of the result. Studio uses the complete reached-edge envelope; CLI raster bounds and time cutoffs are explained in [Reach](../../docs/reach.md).

## Drive

Drive uses a CCH structure customized for time and distance. A minimum-time witness within the distance cap establishes the optimum under the declared metric. A minimum-distance witness outside the cap establishes infeasibility. Otherwise the kernel performs an exact `(time, distance)` label search under the same fixed-point weights.

The constrained fallback retains nondominated labels and enforces an eight-million-label safety cap. Exhaustion reports a typed budget outcome rather than silently relaxing the distance constraint. Persistent CCH structure and metric files must form a complete identity-matched set; partial artifacts are rejected.

These algorithms operate on the supplied graph. Unmodeled turns, station paths, permissions, or source features remain [model limitations](../../docs/known-routing-limitations.md), even when graph search is exact.

## Verification

`npm run check:rust-routing-kernel` builds and checks the native interface, matrices, and terminal access. `npm run check:accuracy` uses independently implemented synthetic graph/timetable oracles. `npm run check:reach-scenarios` covers overlays, directed connectors, surfaces, and scenario boundaries.

Retain regressions for same-time connections, legal pickup/alighting, through-riding, explicit transfer rules, caps, source identity, directed barriers, baseline–scenario–baseline reuse, and blocked results. Drive checks cover both CCH certificates, constrained fallback, parallel edges, multiple snap candidates, and artifact reload/rejection.

Native execution time excludes preparation, access work outside that operator, geometry, transport, and serialization. Use the [performance boundaries](../../docs/performance.md) when reporting latency. Passing finite fixtures supports the tested model; it is not proof of arbitrary-source correctness or observed travel-time accuracy.
