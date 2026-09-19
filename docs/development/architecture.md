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

Browser development uses loopback HTTP in place of the desktop memory channel, with the same handlers. The Studio HTTP API is internal; the stable programmatic boundary is the [CLI](../programmatic.md).

## Build and open

Build validates GTFS and OSM in a staging directory, creates timetable and street stores, prepares required native indexes, and publishes a complete City atomically. A failed build preserves the previous City. SQLite owns durable source and build data; production path search does not query SQLite at each routing step.

Store admission accepts current formats. Obsolete source stores require a rebuild; merge, compaction, and index preparation cannot upgrade them in place. Compaction happens before transfer topology and access preparation, and retires indexes tied to the previous database generation.

Open validates identity and loads the data a query needs. Active-service timetable snapshots and directed station-access contexts can be retained with the City. Derived caches can be regenerated from compiled data; missing required street indexes require restoration or a source rebuild. Ride geometry is loaded and aligned only for selected trips. See [performance](../performance.md) for cold, reopened, and resident timing boundaries.

## Computation ownership

| Operation | Implementation boundary |
| --- | --- |
| Transit Route | Native forward or reverse timetable search, directed street access, then selected-journey reconstruction |
| Walk / Drive Route | Native directed street search, CCH acceleration, and path geometry |
| Transit Matrix | Shared native forward scans per origin or reverse scans per destination; optional selected witnesses |
| Reach | Native timetable propagation and walking surface; JavaScript contours and Result shaping |
| Scenario | JavaScript validation and compilation of supported changes; native routing applies the compiled overlay |

JavaScript owns request validation, identity resolution, orchestration, cancellation, and presentation. Rust owns graph search and timetable propagation; see the [kernel implementation map](../../native/vigo-routing-kernel/UNIFIED_ROUTING_KERNEL.md). Source-feature omissions remain explicit in results; shared implementation alone does not prove correctness. [Independent checks](../routing-accuracy.md) validate the declared model.

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

Vehicle matching preserves service dates, including previous-day overnight trips. Network assessments share an immutable observation; method and denominators are documented in [service assessment](../network-service-assessment.md). Old ledger records remain readable, but new guidance requires current source identity. Model-history compatibility filters protect previously internal context and are not disposable legacy code.

Studio Reach retains packed reached-edge data, lazily reuses decoded coordinates across cutoffs, and serializes large map-source replacement. Changing a displayed cutoff does not require rebuilding the street graph. Runtime fixtures check map updates and rapid cutoff changes.

## Storage and verification

The complete CLI City directory is portable; individual databases and native files are implementation details. Studio library settings, drafts, notebooks, and connections are separate application state. The [operations ledger](../agency-operations.md), [replay](../operational-replay.md), and [LAMP study](../lamp-runtime-study.md) remain active research interfaces with their own tests and storage.

Use the [contribution guide](../../.github/CONTRIBUTING.md) to choose checks. Routing fixtures verify feasibility and witnesses; desktop runtime fixtures verify interaction. Actual-provider evaluations are opt-in and separate from deterministic tests. No fixture or build proves field accuracy or model reliability.
