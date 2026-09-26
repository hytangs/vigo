# Architecture

Studio and the CLI share routing code; neither routes through the other. The public model is City → optional Scenario → Query → Result.

```text
Studio renderer                       vigo command / Python wrapper
    │                                         │
Electron preload → utility process     CLI validation and output
    │                                         │
    └──────── shared City / query modules ─────┘
                          │
                 Rust timetable + street kernels
                          │
                   Result and diagnostics
```

Browser development uses loopback HTTP in place of the desktop memory channel, with the same handlers. The Studio HTTP API is internal; the stable programmatic boundary is the [CLI](../reference/programmatic.md).

## Build and open

Build validates GTFS and OSM in a staging directory, creates timetable and street stores, prepares required native indexes, and publishes a complete City atomically. A failed build preserves the previous City. SQLite owns durable source and build data; production path search does not query SQLite at each routing step.

Store admission accepts current formats. Obsolete source stores require a rebuild; merge, compaction, and index preparation cannot upgrade them in place. Compaction happens before transfer topology and access preparation, and retires indexes tied to the previous database generation.

Open validates identity and loads the data a query needs. Active-service timetable snapshots and directed station-access contexts can be retained with the City. Derived caches can be regenerated from compiled data; missing required street indexes require restoration or a source rebuild. Ride geometry is loaded and aligned only for selected trips. See [performance](performance.md) for cold, reopened, and resident timing boundaries.

New City builds persist the Rust drive hierarchy and both free-flow metrics.
Drive startup maps these artifacts; it does not rebuild the hierarchy. The CLI
prepares only the requested mode, and Matrix streams prepare each mode on its
first use. Missing required drive artifacts cause a rebuild/restore error.
Older Cities marked with an ephemeral drive hierarchy retain their existing
behavior until rebuilt from source.

## Computation ownership

In this guide, **CCH** means Customizable Contraction Hierarchies, the prepared
street index used to accelerate path queries. **CSA** means Connection Scan
Algorithm, which scans timetable connections in time order. A **frontier** keeps
competing feasible options, such as earlier arrival versus less walking. A
**witness** is the path or journey supporting a computed cost. **Materialization**
assembles its stops, legs, and geometry into the returned Result. **Admission**
validates whether input data can be used; **prewarming** prepares it before a
query, and **resident** state stays in memory for reuse.

Materialization-critical computation has moved into the Rust kernel, including
shape alignment and plan-identity hashing. JavaScript still loads selected GTFS
source rows, assembles itinerary objects, and handles orchestration and public
interfaces. Itinerary materialization is not fully native.

| Operation | Implementation boundary |
| --- | --- |
| Transit Route | Native forward or reverse timetable search, directed street access, then selected-journey reconstruction |
| Walk / Drive Route | Native directed street search, CCH acceleration, and path geometry |
| Transit Matrix | Shared native forward scans per origin or reverse scans per destination; optional selected witnesses |
| Reach | Native timetable propagation and walking surface; JavaScript contours and Result shaping |
| Scenario | JavaScript validation and compilation of supported changes; native routing applies the compiled overlay |

JavaScript owns request validation, identity resolution, orchestration, cancellation, and presentation. Rust owns active-timetable departure/transfer indexing, realtime timetable reconstruction, station path compilation, graph search, and timetable propagation; see the [kernel implementation map](../../native/vigo-routing-kernel/UNIFIED_ROUTING_KERNEL.md). Source-feature omissions remain explicit in results; shared implementation alone does not prove correctness. [Independent checks](routing-accuracy.md) validate the declared model.

## Module boundaries

| Area | Ownership |
| --- | --- |
| `src/server/gtfs/` | Store schema, admission and identity; calendars, stop-access indexing and coordinate-access profile lifecycle; walking policy and plans; result assembly, realtime timetables, and network previews. The coordinator retains store lifecycle and native query orchestration. |
| `src/server/runtime/route-worker-pool.mjs` | Routing-worker leases, cancellation, prewarming, and memory pressure. The API entry point supplies the worker URL so source and packaged execution resolve the same worker. |
| `src/map/` | Network, journey, vehicle, and Reach feature builders; layer definitions, paint, and basemaps. `VigoMap.tsx` owns React effects, map events, and selection. |
| `src/components/studio/` | Sidebar, City library and source controls, and route surface. `App.tsx` owns application state, requests, and navigation. |

These modules do not import their coordinating entry points. Public GTFS exports remain available through `national-gtfs-store.mjs`. Calendar caches still belong to each admitted store. Walking-anchor profiles remain private to the walking-plan module and are cleared when the coordinator invalidates their store. Realtime query symbols and weak timetable caches belong to the realtime module; decoded street-edge bundles retain one weak cache in the Reach feature module.

Stop projections use weak references to both the timetable and street record,
retaining only the current access profile for each pair. Changing a profile
replaces its projection; returning to an earlier profile recomputes it. Worker
transfer failures reject the affected request and release the queue slot while
preserving the worker for subsequent requests.

The remaining large files have tighter state coupling: GTFS import and query orchestration share store identity and cache lifetime; `national-osm-store.mjs` couples graph admission and native preparation; the Rust coordinate and timetable kernels share search workspaces and snapshot layouts. Split those along explicit state ownership boundaries, with routing, cancellation, and persistence checks, rather than moving arbitrary line ranges. Vendor code is maintained separately.

## Desktop and Network

`public/main.mjs` owns windows, menus, dialogs, and the `vigo://studio` resource scheme. `public/preload.cjs` exposes a small desktop bridge to an isolated renderer without Node access. Engine runs in a utility process; packaged Studio has no TCP listener. Packaging copies the shared `public/` distribution once.

Network shares one route/station selection across its tabs, map, line diagram, and Ask. Known feed namespaces resolve against the City timetable; ambiguous bare IDs cannot select an agency. Station scope includes platforms, while a platform keeps its own events. Saved answers retain their original selection and observation; background responses do not move the map.

| Surface | Owner |
| --- | --- |
| Trip times and patterns | `AgencyTripTimetable`, `NetworkTimetable` |
| Map and line | `VigoMap`, `AgencyRouteLine` |
| Station board and evidence | `StopArrivalBoard`, `AgencyEvidence` |
| Ask and saved work | `AgencyPanel`, `AgencyAnswer`, notebook |
| Route/vehicle timing | `src/agency/routeOperations.mjs` |

Vehicle matching preserves service dates, including previous-day overnight trips. Network assessments share an immutable observation; method and denominators are documented in [service assessment](../research/network-service-assessment.md). Old ledger records remain readable, but new guidance requires current source identity. Model-history compatibility filters protect previously internal context and are not disposable legacy code.

Studio Reach retains packed reached-edge data, lazily reuses decoded coordinates across cutoffs, and serializes large map-source replacement. Changing a displayed cutoff does not require rebuilding the street graph. Runtime fixtures check map updates and rapid cutoff changes.

## Storage and verification

The complete CLI City directory is portable; individual databases and native files are implementation details. Studio library settings, drafts, notebooks, and connections are separate application state. The [operations ledger](../research/agency-operations.md) and [replay](../research/operational-replay.md) remain active research interfaces with their own tests and storage. The [LAMP reader](../research/lamp-runtime-study.md) can inspect existing City studies.

Use the [contribution guide](../../.github/CONTRIBUTING.md) to choose checks. Routing fixtures verify feasibility and witnesses; desktop runtime fixtures verify interaction. Actual-provider evaluations are opt-in and separate from deterministic tests. No fixture or build proves field accuracy or model reliability.

The [0.4.2 architecture audit](audit-0.4.2.md) records the freeze review,
remaining cost centers, and reasons for retaining compatibility code.
