# VIGO 1.0.0 developer guide

The developer chapters of the [VIGO guide](guide.html): how VIGO is built, how to measure it, and how to check that it routes correctly. Edit a chapter, then run `npm run docs:build`.

## Developer resources

Integrate VIGO through its public interfaces: the [engine](guides/rust-standalone.md) command line and HTTP API, the [compiler](guides/cli-only.md), or [VIGO Python](../python/docs/guide.md). Studio's internal API and the [native operations](reference/rust-standalone-native.md) serve other purposes and are not stable integration boundaries.

### Build and understand the engine

- [Contributing and checks](../.github/CONTRIBUTING.md)
- [Architecture](#architecture)
- [How VIGO computes answers](reference/methodology.md)
- [Runtime limits and recovery](#runtime-limits-and-recovery)
- [Local basemap](#local-osm-basemap)

### Validate behavior and performance

- [Routing accuracy checks](#checking-routing-accuracy)
- [Performance measurement](#measuring-performance)
- [Timetable query performance](#timetable-query-performance)
- [Reproduce a service workload](#reproduce-a-service-workload)
- [GTFS support](#gtfs-support-matrix)

A passing public synthetic fixture verifies the behavior it exercises. Use the test results of the exact build and platform when assessing an installation; an old test count is not a current release check.

### Build on a small machine

`npm run build:standalone` and `npm run build:rust-routing-kernel` (and the scripts that call them) select low-memory Cargo settings when the detected physical or container memory is 4 GiB or less: one job, 16 code-generation units, no incremental compilation, no debug information and no LTO. When only available memory is low, they limit compilation to one job and keep the normal release profile. Unknown limits are ignored, and the selection is logged.

`VIGO_BUILD_MEMORY=low` forces low-memory settings and `VIGO_BUILD_MEMORY=full` keeps the release profile; the default is `auto`. Low-memory builds can run differently, so use `full` on a well-provisioned host for comparable benchmarks. A direct `cargo build` bypasses the selection. Changing modes rebuilds affected Cargo artifacts. `node --test test/check-build-memory.mjs` tests the detection. These settings reduce compiler memory; they do not guarantee a fit, and they do not change VIGO's runtime limits.

### Maintain the documentation

Markdown is the source of the offline guide, `docs/guide.html`, which the engine serves at `/`, Studio opens under **Settings → Documentation**, and the engine archive includes.

| File | Role |
| --- | --- |
| `docs/guide.md` | The user guide: overview, install, quickstart, concepts, task guides, Studio, deployment, limits, troubleshooting, glossary |
| `docs/guides/rust-standalone.md` | The engine reference; also the engine archive's `README.md`. Its `json query=…`, `response=…`, `output=…` and `decoder=…` blocks are executed by `npm run check:standalone-docs` |
| `docs/guides/cli-only.md` | The compiler guide; also the compiler archive's `README.md` |
| `docs/guides/*.md` | Monte Carlo, resource limits and the public route planner |
| `docs/reference/*.md` | Public results, methodology, walking evidence, the prepared-data contract and the verification record |
| `docs/reference/api-schema.md`, `rust-standalone-native.md`, `docs/standalone-openapi.json` | Generated from the Rust types by `npm run docs:standalone`; never edit by hand |
| `docs/navigation.json` | Pages, groups and order: each page renders a file, one section of a file, or several sections |

Run `npm run docs:build` after changing a page, then `npm run check:docs` and `npm run check:standalone-docs`. The checks verify links and anchors, generated-file freshness, executable examples, and that every engine command-line flag, request field and environment variable is documented. Add to these files rather than creating a page per topic. Version history is in the [changelog](../CHANGELOG.md).

## Architecture

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

Browser development uses loopback HTTP in place of the desktop memory channel, with the same handlers. The Studio HTTP API is internal; the stable programmatic boundaries are the [engine](guides/rust-standalone.md) and the [compiler](guides/cli-only.md).

### Build and open

Build validates GTFS and OSM in a staging directory, creates timetable and street stores, prepares required native indexes, and publishes a complete City atomically. A failed build preserves the previous City. SQLite owns durable source and build data; production path search does not query SQLite at each routing step.

Store admission accepts current formats. Obsolete source stores require a rebuild; merge, compaction, and index preparation cannot upgrade them in place. Compaction happens before transfer topology and access preparation, and retires indexes tied to the previous database generation.

Open validates identity and loads the data a query needs. Active-service timetable snapshots and directed station-access contexts can be retained with the City. Derived caches can be regenerated from compiled data; missing required street indexes require restoration or a source rebuild. Ride geometry is loaded and aligned only for selected trips. See [performance](#measuring-performance) for cold, reopened, and resident timing boundaries.

New City builds persist the Rust drive hierarchy and both free-flow metrics.
Drive startup maps these artifacts; it does not rebuild the hierarchy. The CLI
prepares only the requested mode, and Matrix streams prepare each mode on its
first use. Missing required drive artifacts cause a rebuild/restore error.
Older Cities marked with an ephemeral drive hierarchy retain their existing
behavior until rebuilt from source.

### Computation ownership

In this guide, **CCH** means Customizable Contraction Hierarchies, the prepared
street index used to accelerate path queries. **CSA** means Connection Scan
Algorithm, which scans timetable connections in time order. A **frontier** keeps
competing feasible options, such as earlier arrival versus less walking. A
**witness** is the path or journey supporting a computed cost. **Materialization**
assembles its stops, legs, and geometry into the returned Result. **Admission**
validates whether input data can be used; **prewarming** prepares it before a
query, and **resident** state stays in memory for reuse.

Rust reads, indexes, aligns, and clips selected GTFS shapes in one native cache.
A reusable 8 KiB output buffer holds the sampled leg; JavaScript copies only its
displayed points into itinerary objects. Both runtimes default to a 64 MiB
shape-cache budget and at most 1,024 shapes. JavaScript handles store lifetime,
orchestration, and public interfaces.

| Operation | Implementation boundary |
| --- | --- |
| Transit Route | Native forward or reverse timetable search, directed street access, then selected-journey reconstruction |
| Walk / Drive Route | Native directed street search, CCH acceleration, and path geometry |
| Bike Route / Matrix | Turn-aware bicycle CCH, shared rank sweeps and verified path geometry |
| Transit Matrix | Shared native forward scans per origin or reverse scans per destination; optional selected witnesses |
| Reach | Native timetable propagation and walk, drive, and bicycle surfaces; JavaScript contours and Result shaping |
| Scenario | JavaScript validation and compilation of supported changes; native routing applies the compiled overlay |

JavaScript owns request validation, identity resolution, orchestration, cancellation, and presentation. Rust owns active-timetable departure/transfer indexing, GTFS-Realtime overlays (trip updates, Service Alerts and timetable reconstruction, shared with the standalone engine), station path compilation, graph search, and timetable propagation; see the [kernel implementation map](../crates/vigo-runtime/README.md). Source-feature omissions remain explicit in results; shared implementation alone does not prove correctness. [Independent checks](#checking-routing-accuracy) validate the declared model.

### Crates

All Rust code builds from the root Cargo workspace.

| Crate | Responsibility |
| --- | --- |
| `vigo-route` | Timetable search: forward, reverse, Matrix and alternatives; scenario and realtime views; transfer and station operators; reusable scratch |
| `vigo-format` | Reading service timetables, validating memory-mapped snapshots and writing the portable City layout |
| `vigo-prepare` | Compiling GTFS `stop_times` into connections, including exact frequency expansion |
| `vigo-gtfs` | GTFS-Realtime decoding |
| `vigo-traffic` | Traffic input, including NDW DATEX II v3 |
| `vigo-model` | The public request and Result types, and the generated OpenAPI document |
| `vigo-runtime` | Street, access and driving kernels, the standalone executable, and the Node adapter |

The routing crate has no Node dependency, filesystem access, environment lookups, thread creation or untyped JSON. The executable and the Node addon share these implementations; Node records are generated from the Rust types. ZIP and CSV admission, source scoping, calendars, City publication and application orchestration remain in JavaScript.

`npm run check:rust-workspace` runs the model and schema tests, algorithm tests, strict Clippy and the dependency boundary. `npm run check:compiler` compares the connection compiler with retained normalized tables from the earlier reference compiler (`test/fixtures/gtfs-connections-052.json`), 80 seeded feeds, malformed-input rollback, City build equivalence, the frozen routing corpus and the permanent reader/writer gate. `npm run profile:compiler -- --runs 3 --output output/compiler-profile.json` profiles GTFS import on a synthetic or supplied feed; keep private inputs and measurements outside the repository.

### Module boundaries

| Area | Ownership |
| --- | --- |
| `src/server/gtfs/` | Store schema, admission and identity; calendars, stop-access indexing and coordinate-access profile lifecycle; walking policy and plans; result assembly, realtime timetables, and network previews. The coordinator retains store lifecycle and native query orchestration. |
| `src/server/runtime/route-worker-pool.mjs` | Routing-worker leases, cancellation, prewarming, and memory pressure. The API entry point supplies the worker URL so source and packaged execution resolve the same worker. |
| `src/map/` | Network, journey, vehicle, and Reach feature builders; layer definitions, paint, and basemaps. `VigoMap.tsx` owns React effects, map events, and selection. |
| `src/state/` | Studio state. Shell, City, service clock, Network, Route and Analyze stores hold state and actions; selectors derive shared values; `runtime.tsx` runs requests, leases and polling without rendering UI. |
| `src/components/studio/` | Sidebar, City library and source controls, and route surface. Workspace panels read their own store slices; `App.tsx` arranges the shell. |

These modules do not import their coordinating entry points. Public GTFS exports remain available through `national-gtfs-store.mjs`. Calendar caches still belong to each admitted store. Walking-anchor profiles remain private to the walking-plan module and are cleared when the coordinator invalidates their store. Realtime query symbols and weak timetable caches belong to the realtime module; decoded street-edge bundles retain one weak cache in the Reach feature module.

Stop projections use weak references to both the timetable and street record,
retaining only the current access profile for each pair. Changing a profile
replaces its projection; returning to an earlier profile recomputes it. Worker
transfer failures reject the affected request and release the queue slot while
preserving the worker for subsequent requests.

The remaining large files have tighter state coupling: GTFS import and query orchestration share store identity and cache lifetime; `national-osm-store.mjs` couples graph admission and native preparation; the Rust coordinate and timetable kernels share search workspaces and snapshot layouts. Split those along explicit state ownership boundaries, with routing, cancellation, and persistence checks, rather than moving arbitrary line ranges. Vendor code is maintained separately.

For current admission budgets, restart behavior, and test coverage, see
[runtime limits and recovery](#runtime-limits-and-recovery).

### Desktop and Network

Studio uses a native City overview reader and native Reach boundaries. Per-route
timetable analysis, vehicle interpolation and local search remain JavaScript.

`public/main.mjs` owns windows, menus, dialogs, and the `vigo://studio` resource scheme. `public/preload.cjs` exposes a small desktop bridge to an isolated renderer without Node access. Engine runs in a utility process; packaged Studio has no TCP listener. Packaging copies the shared `public/` distribution once.

Desktop build tooling overrides `@electron/asar`'s `glob` and `minimatch` with
patched versions for [cancelled traversal](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
and [pattern amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).
These are development-only dependencies. `check:studio` verifies archive contents,
exclusions and unpack patterns through the packaging tool's resolved ASAR library.
Remove the overrides when ASAR's dependency ranges include the patched versions.

Network shares one route/station selection across its tabs, map, and line diagram. Known feed namespaces resolve against the City timetable; ambiguous bare IDs cannot select an agency. Station scope includes platforms, while a platform keeps its own events. Observation refreshes do not move the map.

| Surface | Owner |
| --- | --- |
| Trip times and patterns | `AgencyTripTimetable`, `NetworkTimetable` |
| Map and line | `VigoMap`, `AgencyRouteLine` |
| Station board and evidence | `StopArrivalBoard`, `AgencyEvidence` |
| Network overview and observation exports | `AgencyPanel`, `observationExport.mjs` |
| Route/vehicle timing | `src/agency/routeOperations.mjs` |

The Network service owns observation polling, timetable inspection, route and vehicle
views, station boards and observation exports. Connection state lives in
`network.sqlite`; explicit disconnects persist across restarts. Vehicle matching
preserves service dates, including previous-day overnight trips.

Studio Reach retains packed reached-edge data, lazily reuses decoded coordinates across cutoffs, and serializes large map-source replacement. Changing a displayed cutoff does not require rebuilding the street graph. Runtime fixtures check map updates and rapid cutoff changes.

### Storage and verification

The complete City directory is portable; individual databases and native files
are implementation details. Studio library settings, drafts and feed connections
are separate application state.

Use the [contribution guide](../.github/CONTRIBUTING.md) to choose checks. Routing
fixtures verify feasibility and witnesses; desktop runtime fixtures verify
interaction. Network checks include connection persistence, source replacement,
access control, in-flight invalidation and preservation of legacy data. No fixture
or build proves field accuracy.

### Itinerary geometry and identifiers

Rust reads selected shape rows directly from SQLite into numeric buffers and
builds a distance prefix and a hierarchy of bounds in unit-sphere coordinates.
The bounds skip sections that cannot contain a nearer candidate, including
across the antimeridian and near the poles. The matcher still retains up to 16
points within 1 km per stop, evaluates the original haversine distances and tie
rules, and aligns the complete trip monotonically to disambiguate loops.
JavaScript samples the selected range from a compact coordinate column using
the existing distinct-point stride and 512-point limit. Shapes with consecutive
duplicates also carry an index of distinct source positions. Range clipping
uses two binary searches and visits only sampled positions; shapes without
duplicates use source positions directly. Short ranges use a single bounded
pass. Final duplicate cleanup and distance calculation share one pass over
the newly materialized coordinates. Prepared shapes remain
subject to the store's entry and byte budgets, including the coordinate column,
distinct-position index, spatial index, and bounded native candidate cache.
A read-only source connection has a 2 MiB SQLite page-cache budget and closes when its routing store is disposed
or invalidated. No itinerary answer cache is introduced.

Plan identifiers retain the existing 64-bit hash and Unicode code-point
semantics. Rust performs that arithmetic; identifiers are selection keys, not
security digests. `npm run check:accuracy` includes differential tests against
the previous JavaScript shape matcher and identifier arithmetic.

## Local OSM basemap

`Local OSM` uses cartographic features retained in the City's SQLite street store. It does not query or load the pedestrian or driving accelerator. The `/local-basemap` endpoint returns roads and water in one GeoJSON collection. The former routing-edge renderer and its `/local-streets` endpoint have been removed.

### Import and geometry

The importer first selects water multipolygon members, then includes their node references in the street import's existing selection and geometry passes. Untagged members are joined in either direction, and inner rings remain island holes. These temporary relation tables are dropped before publication. Map tables survive routing-store compaction and travel with the SQLite artifact; no external source file or sidecar is required at runtime.

Only motorway, trunk, primary, secondary, and tertiary roads are drawn. Links enter at zoom 12; lesser road classes never enter the basemap. The routing graph still retains its original walk/drive eligibility rules. Rivers, canals, water polygons, and directed coastlines are independent of routing permissions.

Geometry is rounded to six decimal places and simplified at three detail levels during import. Identical geometries share one stored row across levels; invisible levels are omitted. Line pieces contain at most 128 input vertices, and persisted geometry contains at most 8,000 vertices per feature. Water relations exceeding 200,000 input vertices, containing unsupported nested geometric members, or missing complete rings are skipped and counted in metadata. Oversized source ways are also skipped for display. Display geometry is never used for routing.

Coastal water follows [OSM's land-left, sea-right direction](https://wiki.openstreetmap.org/wiki/Tag:natural%3Dcoastline). The query clips and joins shorelines, closes complete chains along the viewport boundary, and retains coastal islands as holes. A nearby shoreline supplies the side for views wholly on land or sea. Interior breaks suppress ocean fill rather than inventing a coast. The PBF header bounds, or the retained feature extent when the header omits bounds, limit coverage. This does not reconstruct missing ocean geography beyond a regional extract.

### Runtime bounds

- An SQLite R-tree selects the requested area, detail level, feature class, and zoom before loading geometry. Coastline searches do not scan unrelated roads.
- Each request opens a read-only connection with a 4 MiB page-cache target and no memory mapping; it closes the connection after querying. This is a SQLite cache setting, not a total process-memory guarantee.
- Responses contain at most 4,500 features and 80,000 vertices. Water has a separate half-budget so it cannot displace all roads. SQL sorts feature metadata and fetches geometry only after it fits the response budget.
- Coastline assembly separately caps both candidate input and clipped geometry at 4,096 pieces and 80,000 vertices. Boundary joins use sorted crossings instead of scanning all crossings repeatedly. Island assignment has a containment-work budget; exceeding either geometry or work limits keeps bounded shoreline outlines and omits ocean fill.
- The browser requests 18% padding around its viewport, reuses it for small pans, debounces moves, aborts superseded fetches, and discards geometry on City or basemap changes. A fresh OSM import invalidates the loaded geometry.
- Worker updates are serialized with only the newest waiting viewport retained. City changes hide the old layers immediately and wait for active worker work before removing or reusing the source, preventing delayed geometry from the previous City from reappearing.
- One GeoJSON source serves all five map layers. Its tile index stops at zoom 14 with a 32-pixel buffer and 0.75 simplification tolerance. Light/dark changes update paint without fetching geometry.
- Responses report sampling and incomplete geometry. There is no city-wide JavaScript geometry cache or tile-provider fallback.

These limits bound retained feature data, not total Electron, worker, tile-cache, or GPU memory. Viewport queries run synchronously; an R-tree query over many matching features can still take longer than a small-city query. Full-region import and prolonged large-city use require separate memory and responsiveness measurements.

Existing street stores remain usable for routing. A store without `localBasemap` metadata returns `needs-import` with a fresh-import instruction; it cannot recover road classes or water from routing snapshots that omitted them.

### Verification

Run `npm run check:map`, `npm run check:osm-pbf`, `node test/check-city-build-equivalence.mjs`, and `node test/check-map-runtime.mjs`. The basemap fixture checks road selection, lake holes, coastal islands, offshore and inland views, query budgets, pathological coastline clipping, R-tree access, compaction, and independence from routing snapshots. The Electron fixture renders both appearances through the local Studio protocol with all external HTTP requests blocked, overlaps updates with repeated City-source replacement, verifies that only the newest geometry renders, and checks source removal.

For manual visual review, the runtime fixture accepts `VIGO_BASEMAP_PREVIEW_FILE` pointing to a local GeoJSON response and `VIGO_BASEMAP_SCREENSHOT_DIR` for light/dark screenshots. Keep downloaded extracts and generated images outside tracked source files.

## Measuring performance

Measure the operation the caller waits for. Keep source data, City revision, query semantics, output detail, and status counts fixed when comparing runs.

For the shared native timetable workspace and a reproducible component comparison, see [Timetable query performance](#timetable-query-performance).

| Operation | Start | End |
| --- | --- | --- |
| Build from raw files | Invoke `vigo build` with local inputs and a new output City | The complete City is published and the command returns |
| Raw files to first answer | The same Build invocation | The first complete Query Result returns |
| Reopen a prepared City | Start a new runtime on a complete saved City | Its first Query Result returns |
| Resident query | Submit to an already open City | The complete Result returns to the caller |

Report downloads and runtime installation separately. State whether process startup, transport, export, and operating-system file-cache effects are included. A new process does not imply a cold filesystem cache; reading a saved Result is not a new computation.

### What the timers include

- `network.json.timing` describes compiler stages. `totalMs` begins inside the compiler after input/staging checks and ends before writing the manifest. It excludes process startup, shutdown, final City publication, and the first query. Stages may overlap; their durations cannot be summed into wall time. `osmBuildMs` can include waiting until the parent collects the worker result.
- Route `searchStats.queryMs` measures the timed route-search and selected-journey work, including street access. It excludes fare annotation performed by the caller, final CLI decoration, transport and Result serialization. CLI `routeMs` / `computeMs` wraps routing, fare annotation and CLI decoration; it still excludes final serialization and transport.
- `materializationMs` covers selected itinerary assembly. Its components include trip connection loading, metadata lookup, shape extraction, access/egress geometry, leg normalization and identity construction. Components need not sum to the enclosing timer. A geometry improvement is not automatically the same improvement in the complete response.
- `engineQueryMs` measures native timetable work. For arrive-by, this includes reverse feasibility and forward selection; `arriveByNativeQueryMs` and `forwardEngineQueryMs` identify those components. Street access and geometry are outside that timetable total.
- Matrix `computeMs` covers engine execution; `requestPreparationMs` and `resultAssemblyMs` describe caller preparation and row assembly. `openMs` reports mode initialization, including the first request of each mode in a stream. JSON serialization and transport require an external timer. Optional journey timings describe witness rendering, not independent searches or a share of batch time.

Use an external elapsed timer for complete Build and query latency. A small native search time does not establish the same user-perceived response time.

Fare parsing and localized display have separate costs. Whole-unit prices within
the exact-integer fast path need no currency formatter; fractional and large
prices still consult currency precision, and displayed labels still format
currency symbols. Include the first fare-bearing result when measuring a fresh
process. A preceding blocked route does not initialize every successful-route
presentation path.

### Preparation and reuse

Build includes import, required street indexes, stop transfers, station access, and publication. The first query may also compile its active-service timetable and align selected ride geometry. Report this cache-miss preparation separately from resident query time.

Portable binary timetable snapshots and prepared station access can be reused after moving the complete City. Timetable diagnostics distinguish `loaded` from `written`; a loaded snapshot reports `compileMs: 0`. New service patterns, changed walking policies, evicted caches, or older derived formats can require preparation. Missing required street indexes are errors, not permission to use a different graph.

Queries are recomputed. `disableCache: true` on transit Route/Matrix disables access/path caches while retaining the prepared City. Larger walking matrices may build temporary destination indexes; that setup belongs in the measured request.

Node Reach retains up to 64 next-departure schedule diagnostics per opened source store and active service context. This lookup preserves raw SQLite times and the inclusive 24-hour horizon; changing the service context clears it, and replacing the source creates a new lookup. It is immutable schedule metadata and remains available with `disableCache: true`. Reach still recomputes the timetable frontier and pedestrian surface. Measure first or changed departure clocks separately from repeated clocks; `diagnostics.timetable.departureLookupMs` exposes this cost alongside `residentPrepareMs`, search and surface timing. A faster repeated diagnostic lookup does not establish a faster native search or City opening.

#### Native timetable preparation

Standalone profile/trace output includes `timing.timetableActivationMs`, the time spent activating the service timetable during that request. A source preparation also reports `timing.timetablePreparation` with `setupMs`, `sourceAndRealtimeMs`, `indexMs`, and `kernelMs`. Setup includes calendar resolution and retiring the preceding timetable; source includes SQLite loading and realtime application. These scopes belong to execution and exclude public formatting, serialization, transport, and initial City opening. A reused timetable has no new preparation record. Profile scopes can overlap total execution; do not add them to it.

Rust constructs per-stop departure order, deduplicates transfers, expands station fallback links, and packs transfer adjacency. JavaScript resolves source IDs and passes typed arrays to the native preparation operator. This runs on active-timetable cache misses; loading a compatible persisted snapshot bypasses it.

Measure input marshalling and native preparation together when comparing the migration with the previous implementation. Keep SQLite reads, native search-index construction, snapshot loading, and resident query time separate. Preserved transfer ordering and snapshot layout do not by themselves establish a speedup. Filesystem lifecycle, source admission, and Result presentation remain JavaScript responsibilities.

### Compare equivalent work

Record exact date/time, coordinates or stop IDs, walking speed and limits, boarding requirement, transfer cap, horizon, realtime snapshot, and output detail. Allowing a walk-only answer changes the workload. Separate ready, blocked, and error counts; a faster blocked result or a different journey is not an equivalent successful query.

For Build comparisons, hold raw inputs and compiler options fixed and compare compiled content; fresh revision IDs and build timestamps are expected. Performance checks complement [accuracy checks](#checking-routing-accuracy), not replace them.

#### Cold service and street preparation

The native service reader opens the admitted SQLite source read-only and packs
active connections directly into column buffers. JavaScript retains source
admission and memory guards; Rust retains connection permissions, trip ordering,
and discontinuity rules. A missing native reader is an error, not a JavaScript
fallback. `VIGO_ACTIVE_KERNEL_PERSIST=0` disables both reading and writing the
active timetable snapshot when measuring compilation from source.

Prepared street graphs and CCH structures are validated concurrently during
native construction. Validation still scans every required array. Path-query
scratch distances use zero-filled storage with an encoded unreachable value,
so the first path does not need to fill city-wide distance and predecessor
arrays. These changes do not reuse previous route results.

Both persisted and in-memory Drive hierarchy construction use one
33-percent balanced four-axis flow cut per component. New City builds persist
the hierarchy; opening that City loads it instead of repeating construction. Both retain every
node and edge and use the same exact CCH search and distance certification;
ordering can change the chosen witness between equal-cost paths. Arc ordering
uses a shared stable counting sort. Native kernel diagnostics expose the hierarchy's
arc count so preparation time can be evaluated alongside its size.

For a cold comparison, alternate baseline and candidate in separate fresh
processes, include imports, graph opening, timetable compilation and result
serialization, and compare route contents as well as latency. Keep immutable
City inputs and hierarchy preparation policy identical. In particular, an
in-memory drive hierarchy must be rebuilt on both sides; loading a saved
hierarchy only on the candidate is not a cold code speedup. Report operating
system page-cache control separately from application cache isolation.

#### Resident routing and realtime updates

For warm routing, retain the prepared City but disable access and path result
caches. Verify the per-request cache diagnostics, rotate endpoints and departure
times, and report native search separately from geometry materialization and
whole-request time. Shared immutable indexes are preparation, not query answers.

Realtime measurements need two workloads: queries against an already prepared
snapshot, and changed snapshots that force reconstruction and native indexing.
Keep freshness, service date, applied update counts and fallback status in the
retained evidence. Controlled updates on a real timetable measure computation;
they do not establish live prediction accuracy. Compare reconstructed columns
and route results, including cancellation and skipped-stop behavior.

Drive constrained-search buffers and traffic weights are allocated on demand.
Report reserved bytes separately from resident memory: operating systems can
back zero-filled allocations lazily, and allocator retention can obscure RSS
changes after buffers are released. A normal CCH query should not allocate the
constrained-search workspace merely to keep a kernel resident.

#### Compact street indexes and geometry

The v2 hierarchy stores seven aligned query columns. Its size without customization data is `104 + 16 * nodes + 12 * hierarchy_arcs` bytes. Walking indexes use exactly this layout. Driving appends gzip-compressed input mappings for traffic updates; normal queries map the query columns without decoding the mappings. Inverse rank and arc tails are reconstructed only when customization needs them. Serialization uses a fixed 16 KiB buffer.

Transit shape coordinates and their distinct-point index remain native. Each selected Studio leg writes at most 512 points into an 8 KiB worker-local scratch buffer, then copies those points into its owned response. No full shape is exported or retained in JavaScript. The exhaustive clipping checks include loops, duplicate runs, signed zero, endpoint preservation, aliased endpoint views, and repeated buffer reuse. Shared output buffers are rejected at the native boundary.

Measure shape-cache bytes, temporary allocation, and whole-request latency separately. Reducing duplicate coordinates need not reduce timetable search time, and a hierarchy file reduction is not the same percentage reduction in the complete City.

## Timetable query performance

The standalone Rust executable and Node interface use the same timetable kernel. Standalone transit Route requests obtain a journey through the shared Matrix kernel with one origin and one destination. Matrices can request scalar times or full journeys.

Journey construction allocates its scratch workspace lazily and retains it with the immutable timetable. Each source clears only the frontiers it touched; each boarding round visits only reached stops. Run generation tags separate rounds, sources, and requests, including wraparound. The workspace contains no cached answers. Changing direction, endpoint policy, or boarding limits still performs a fresh search. Replacing the timetable also replaces its scratch workspace.

Scalar Matrix queries prepare the common endpoint arrays once per batch and reuse the changing source or destination buffers. Validation and routing objectives are unchanged. Depart-at still shares a forward search per origin; arrive-by shares a reverse search per destination. Journey selection keeps the same dominance rules, run order, transfer rules, time horizon, and tie breaks.

For coordinate batches, journey rounds finish after every reachable target has attained its own exact scalar time bound. The final round completes before stopping, preserving boarding and walking ties. Targets without a route retain their blocked result. Selected-stop requests that permit terminal transfers keep the general round path. Endpoint projection also shares identical directed access searches within one batch, even when persistent endpoint caches are disabled; stop IDs remain part of the standalone endpoint identity. Each input still receives its own output row or column.

Arrive-by Route retains the scalar forward reachability envelope through successive capped and deadline certifications. Reuse requires identical origin and destination seeds, costs, departure, horizon, and terminal-transfer policies. Extending a deadline admits the remaining timetable events; contracting it keeps a conservative superset that exact rounds filter against the requested deadline. A new scalar search or a separately built forward envelope invalidates the retained identity. The reverse latest-departure search and exact deadline/boarding/walking certification still run.

Capped coordinate arrive-by searches first obtain the unrestricted latest
departure and seek a forward witness at that same boundary. They accept the
bound only when the witness reaches the deadline within the boarding cap; an
unrestricted blocked result also proves the capped result blocked. Otherwise
the existing layered reverse scan resolves the cap. A 1×1 Matrix uses this
same certified bound before its unchanged journey rounds. Work counters include
the proof and any fallback; no trip choice or tie criterion is removed.

Retaining scratch trades some resident memory for fewer allocations. Native `workspaceBytes` diagnostics include the journey arrays and their retained capacities. Scalar-only users do not allocate journey scratch.

The scalar point scan rejects strictly later arrivals before computing boarding
and walking tie-breakers; equal arrivals still receive the full comparison.
An epoch-scoped lower bound on stop arrival skips boarding searches when every
label is in the future. It uses eight additional workspace bytes per stop and
does not change prepared data. The preliminary unrestricted scan for a capped
point query retains labels and its forward run envelope but omits predecessor
writes and intermediate chain construction. Exact capped rounds still recover
the final journey with the existing boarding and walking objectives.

For ordinary Node Route responses, the adapter passes only the plan diagnostic
fields consumed by the shared Rust public formatter: realtime metadata, arrival
reserves, and the service clock date. This avoids serializing and parsing unused
search trees. Full journeys, alternatives, and geometry remain present; requested
summary, profile, and trace responses retain their existing diagnostic input.

### Coordinate routes and materialization

For capped fastest depart-at queries, the Node adapter permits the fused Rust call to return the selected access and egress witnesses, including walking geometry. The existing native guard uses this compact result only for certified one- or two-boarding routes. Uncapped queries, balanced preferences, departure-window alternatives, and arrive-by deadline certification retain the full candidate frontier. The change removes candidate conversion and subsequent path calls without limiting the search.

The standalone adapter retains immutable route metadata and trip-to-shape identifiers within each opened City. Journeys still reconstruct their active timetable stop sequence and geometry on every request. The metadata maps are bounded by the City's route/trip counts, are released with that City, and remain separate from endpoint or answer caches.

When opening an access context, the standalone stop projection parses only the normalized fields it consumes and validates JSON in skipped fields. Coordinate type checks and the null-coordinate exception for location types 3/4 remain unchanged. This changes reader allocations, not the portable City layout.

Reached-street propagation uses a monotone queue keyed by exact finite nonnegative floating-point duration bits. Equal-time entries use the existing walking-distance, node, seed, and witness ordering. A nonmonotone insertion falls back to the original heap. This does not round times, change walking budgets, or alter Pareto dominance. Node and standalone use the same operator. Compare full rasters and edge evidence, alongside measured execution and process memory, when evaluating queue changes.

Compiled GTFS shapes and their geometric alignment candidates are retained separately in a City-owned least-recently-used store, limited to 4,096 shapes and 256 MiB of estimated geometry storage, matching the Node interface's shape-cache limits. Lookups examine the most recently used entries first. This avoids the much smaller standalone cache repeatedly evicting geometry on varied city-wide workloads; the larger upper bound can increase resident memory. Sizes are accounted again after alignment grows candidate data. Oversized shapes are used for the current request and released. Timetable paths, realtime stop sequences, and selected shape slices are still reconstructed for each journey; the store does not retain route answers.

The standalone store also retains up to eight exact stop-to-shape alignments per shape within the same byte budget. The complete active stop coordinates, including their floating-point bits, form the key. A changed realtime stop sequence cannot inherit the scheduled alignment. Materialization copies only the selected shape slice. Point endpoint roles use the shared two-worker native executor. Batch endpoint evidence remains typed and is shared for identical request endpoints; it becomes JSON only when a response includes that evidence.

Generic street geometry keeps the original directed snap pairs, raw path distance, and tie rules. CCH path reconstruction shares one forward sweep across the candidate destinations for a source. Every destination still performs its exact backward sweep and shortcut reconstruction. The shared state is scoped to that batch call, so a subsequent source or metric never inherits it.

### Standalone startup and output boundaries

The standalone City reader deserializes the used access-context fields directly into native structures and skips unused projections. Scheduled transit can load the compiler's portable active-service snapshot after checking database identity, access policy, active services, transfer projection, dictionaries, canonical array layout, and native kernel invariants. Missing or invalid optional sidecars fall back to the existing SQLite preparation path. Realtime and modified street-transfer policies use source preparation. `timing.timetableSource` exposes the selected preparation path; `timing.totalMs` still excludes process startup and initial City opening.

Rust Matrix defaults to full display and walking-evidence detail. Node Matrix returns compact timed witnesses. For a comparable analytical workload, request Rust `journeyFormat: "compact"` with `includeJourneys: true`, or request duration-only matrices from both. Compact changes response detail only: the same native journey search runs, with the same trips, boarding sequences, clocks, and transfer count. Full remains the default and the required format for geometry and walking-evidence consumers. The stream uses bounded 64 KiB serialization scratch instead of retaining another complete encoded response.

Forward and reverse batch bounds share one endpoint accumulator. Reverse scans
minimize negated departure times with nonnegative access offsets, and stop once
all nonempty endpoint frontiers have a bound that earlier connections cannot
improve. Empty frontiers remain unreachable; an unreached nonempty frontier
keeps the scan open. Directed terminal transfers and equal-time closure retain
their existing semantics. This removes the former full-horizon scan for bulk
arrive-by queries and the separate per-origin readout. Matrix still shares one
forward scan per origin or one reverse scan per destination, so rectangular
matrices can have different costs in the two directions.

`cargo test -p vigo-route timetable::many::tests` checks reverse batches against
time-mirrored forward queries and scans forced to retain the entire horizon,
including boarding caps, directed transfers, excluded trips, duplicate and empty
endpoints, zero-duration connections, and reuse after a bulk query. The synthetic
cutoff fixture examines fewer than 10 connections rather than at least 1,002.
These are work counts for that fixture, not a production latency guarantee.

Full arrive-by journeys use a shared forward prefix bound before reverse
journey rounds. Each requested origin is seeded at its already proven latest
departure for that destination, including only its permitted initial transfer.
The prefix scan ignores the boarding cap to remain optimistic, retains direct
walking seeds, and permits post-ride transfers. Reverse candidates earlier than
all reachable prefixes are discarded before transfer/frontier comparisons. The
exact rounds still choose boardings, walking, actual arrival, and full witnesses.
A conservative floating-point tolerance retains boundary-equal candidates.

The prefix pass reuses the many-target scan with endpoint-cutoff bookkeeping
disabled: it needs all stops through the horizon. Its work is included in Matrix
search counters. Prefix scratch is recomputed per destination and reused across
requests; it does not cache answers.

Full depart-at journeys use the corresponding reverse suffix bound. Each
destination is seeded at the latest of its exact earliest arrivals across the
requested origins, allowing one conservative pass to serve all rows. It retains
direct egress and the destination's permitted final transfer, ignores boarding
caps, and includes walking into a first ride. The existing reverse scan reads out
first-boarding deadlines for every stop without endpoint maps. A forward label
after that stop's deadline cannot complete an optimal journey; runs departing
after the same bound need not enter the boarding round. The bound is recomputed
for every request, including when endpoints or direction change. Its scan and
transfer work is included in the query counters.

`opposite_bounds_preserve_complete_journeys`
compares complete witnesses with pruning disabled across fractional access costs,
empty/duplicate endpoints, directed terminal transfers, boarding caps, transfer
buffers, zero-time connections, unreachable prefixes and suffixes, and changes of
direction on a reused kernel.

### Reproduce a kernel comparison

Build each version with `npm run build:rust-routing-kernel` using the same toolchain and release settings. Save the earlier `crates/vigo-runtime/vigo-routing-kernel.node` under a separate path before building the changed version. Then run:

```sh
node scripts/benchmark-timetable-queries.mjs --reference /path/to/before.node --samples 51 --output /path/to/comparison.json
```

The script generates deterministic synthetic timetables with 256 and 4,096 served stops. It measures 1×1, 16×16, 1×128, and 128×1 requests in both time directions, with and without journeys and terminal transfers, using a three-boarding cap. Baseline and changed calls alternate execution order. Every call must preserve times, blocked cells, and full journey contents. Reports retain search counters separately because an optimization can reduce the work. They also include individual samples, medians, p95, native timing, and resident workspace bytes.

The outer timing includes Node-API argument/result conversion. Native timing excludes that conversion. Both exclude City loading, endpoint street routing, geometry, fares, JSON serialization, HTTP, and process startup. No answer cache is used; the prepared timetable and scratch memory remain resident. The first request for a workload is measured on the existing kernel and is not a cold-process or cold-filesystem measurement.

### Quality checks

`test/check-timetable-query-reuse.mjs` compares a reused kernel with fresh kernels across changing endpoints, time directions, boarding limits, endpoint transfer policies, empty access, and invalid requests. Rust unit tests exercise generation wraparound and recovery after a journey-bound error. Run the existing native matrix, independent routing-accuracy, transfer, equal-time, and standalone parity checks as well: agreement between two adapters does not independently prove the shared kernel correct.

For workload measurements, use complete caller-visible Route and Matrix requests on representative prepared Cities. Alternate identical requests between resident baseline and candidate processes, exclude a stated warm-up round, retain all responses, and compare complete route semantics. Keep cold loading, street access, timetable search, journey/geometry construction, serialization, and transport separate. The standalone engine already moves request execution into Rust; additional migration should target a measured remaining cost and preserve each interface's supported behavior. Private City inputs and workload evidence belong in the private benchmark repository.

### Standalone query execution

Capped coordinate point queries use the same destination-directed exact certifier as Node Route. Arrive-by first proves the latest departure, then certifies boardings, walking, and actual arrival within the deadline. Unsupported cases retain shared Matrix reconstruction; selected-stop and unbounded queries retain that path. Full geometry and walking evidence remain part of the response. Equal objective values can select different source-valid transfer stops; check source legs and objectives separately from byte equality.

Transit matrices group repeated endpoint identities before timetable search and journey construction, then restore every requested row and column. Coordinates and stop identity must both agree; different co-located stops cannot share permissions. Full and compact output remain explicit choices, and scalar requests retain their original dimensions.

## Checking routing accuracy

VIGO uses one exact Transit Matrix search for every City and OD set. City names, endpoint distance, and matrix dimensions do not select different algorithms. Independent reference implementations live in tests and never supply production answers.

Accuracy has two parts: the search must solve the declared model, and the model must faithfully represent the input data and the intended trip. A fast result or agreement between two VIGO interfaces establishes neither part by itself.

### Reproducible independent checks

```bash
npm run build:rust-routing-kernel
npm run check:accuracy
# Extend the same checks to 100 deterministic generated networks:
VIGO_ACCURACY_SEEDS=100 npm run check:accuracy
```

`test/check-routing-accuracy.mjs` generates its own public synthetic inputs. A failing run retains the input directory and reports its seed and query. It uses:

- **Floyd–Warshall**, implemented independently from VIGO's routing and contraction code, to check every directed walking distance and driving travel time on weighted graphs. Alternating graphs allow only forward edges, so unreachable OD pairs are checked as well. Drive witnesses are checked edge by edge against the input weights.
- **Whole-trip enumeration** from generated raw GTFS, independently of VIGO's compiled connection scan, to check earliest arrival and latest departure. The fixtures exercise pickup/drop-off restrictions, staying aboard restricted stops, dwell, midnight, inactive dates, missed connections, published same-stop minimums and forbidden transfers. Zero-duration trips are deliberately placed in reverse dependency order; all scans resolve same-time connections to a fixed point.
- **Every stop-to-stop OD at each boarding-time boundary** on the generated transit networks. This covers each distinct exact-stop departure interval in those fixtures. Separate queries check Matrix permutations, duplicate endpoints, scalar Route parity and materialized ride times and permissions.

Separate raw GTFS fixtures verify 0-, 30-, 90- and 300-second platform transfer rules, parent-station expansion, and forbidden transfers through Route, Matrix and arrive-by queries.

The normal suite runs eight seeds on every supported CI operating system. Larger runs use the same algorithms and assertions. They do not select easier queries based on a City's identity or on previous outcomes.

### Declare the model before comparing answers

The engine adds no implicit boarding buffer. Same-stop vehicle changes honor published GTFS minimum transfer times and forbidden transfers; staying aboard does not incur a transfer minimum. The minimum affects boarding readiness, not the alighting time or final egress. Explicit transfer edges retain their durations without an added boarding margin or a 60-second floor. Native diagnostics report `transferBoardSlackSeconds: 0`. A published platform-to-platform transfer rule takes precedence over the station walking fallback.

GTFS service dates, after-midnight times, pickup/drop-off permissions and transfer rules must come from the same input snapshot. Their definitions are in the [GTFS Schedule Reference](https://gtfs.org/documentation/schedule/reference/).

Record the exact date, time zone, departure/arrival objective, walking speed, per-endpoint walking limit, direct-walk limit, transfer policy, search horizon and live-state snapshot. Distinguish exact selected stops from arbitrary coordinates. Coordinate snapping and street access are part of the query model and require their own verification.

### Checks required for a real City

1. **Validate compilation.** Check raw GTFS references, calendars, exceptions, permissions and transferred identities against the compiled City. Inspect omitted or unsupported features. Check directed OSM access and connectivity, including isolated components, bridges and one-way streets.
2. **Verify journey witnesses.** Each ride must reference an active raw trip, follow its stop order, use legal boarding/alighting events and preserve published times. Every street segment must follow allowed directed edges. Check endpoint connectors separately so a correct graph path cannot conceal an invalid snap.
3. **Compare independently.** Run the same inputs and query policies through an independent router such as OpenTripPlanner. Its [route-request documentation](https://docs.opentripplanner.org/en/latest/RouteRequest/) describes configurable routing policies. Retain both itineraries and investigate each disagreement; matching durations alone is insufficient, and another engine's answer is not ground truth.
4. **Test changes that should preserve or constrain the answer.** Rename IDs, reorder input rows and Matrix endpoints, move the complete City directory, and repeat after unrelated queries. Answers should remain stable. Under identical horizons and policies, removing service must not improve earliest arrival, and adding service must not make it worse.
5. **Retain failures.** Keep false reachable results, false blocked results, invalid witnesses, timing discrepancies, setup failures and query errors as separate outcomes. Save the smallest reproducing input and add a regression before accepting a fix. Do not change the oracle to match an unexplained engine answer.

For exact graph and timetable comparisons, require zero feasibility disagreements. Use only the documented public timestamp rounding tolerance when comparing numeric results. Equivalent optimal itineraries may differ in geometry or route choice; validate feasibility and the objective before comparing presentation details.

### What passing means

The independent suite validates the generated graph and timetable models under their declared policy. It does not establish correct coordinate snapping on arbitrary OSM extracts, complete GTFS transfer-rule support, live-provider correctness, or real delivered travel times. Those require retained City-specific input and witness checks. A universal algorithmic guarantee comes from the algorithm's invariants and input assumptions; finite testing supports it but cannot prove every possible City or OD.

## Runtime limits and recovery

These limits and recovery rules apply to Studio's routing runtime and the compiler's Node workers. The engine's limits are in [Server limits](guides/rust-standalone.md#server-limits) and [Resource limits](guides/resource-limits.md).

### Memory and request admission

Studio's native runtime admits at most `VIGO_NATIVE_CITY_MAX` Cities (default 2,
range 1–8), with at most `VIGO_NATIVE_CITY_PROCESSES` processes each (default 2,
range 1–8). When all City slots are busy, a new City returns HTTP 503 with
`capacity_exceeded`; idle slots can be reused. These count limits complement
the native memory budgets. Complete and fragmented native response lines share
a 256 MiB limit. Mode preparation uses `street.prepare`, `bike.prepare`,
`drive.prepare` or `timetable.prepare`, without retaining or replaying journeys.

Each native request follows one serving contract:

- **Admission.** A request already cancelled, or for a City whose files are
  being replaced, is refused before any City is opened, evicted or started. An
  admitted request reserves a count and an encoded-byte permit, globally and
  for its City, and returns them however it ends. With no permit left the
  request fails at once with HTTP 503 and `VIGO_NATIVE_OVERLOADED`, marked
  retryable; nothing queues without bound. The
  `VIGO_ROUTE_MAX_PENDING`/`VIGO_ROUTE_MAX_QUEUED` limits below belong to the
  separate preparation pool, not to these requests.
- **One deadline.** `VIGO_NATIVE_QUERY_TIMEOUT_MS` (default 600,000) is the
  request's whole budget from admission: waiting, a process start and one
  automatic retry all spend it. A request that expires while waiting leaves
  the queue without stopping a process; only the request a process is
  computing can stop that process.
- **Dispatch.** Waiting work stays in its City's queue and goes to the first
  ready process that is free, including one that has just started; a request
  already written to a process is never moved. Work waiting behind busy
  processes starts another one, up to the process limit. Point routes go
  before Matrix and Reach analyses, which may be passed over at most four
  times. A request waits up to `VIGO_NATIVE_AFFINITY_WAIT_MS` for a process
  that has its travel mode loaded, then takes any idle process, which loads
  it first.
- **Generations.** Retiring a City's files, or switching library, refuses
  the City's waiting work, stops its running work and starts a new
  generation: no earlier request is retried into it or answered from it.
  Switching library resets the native runtime and the preparation pool; both
  keep serving the new library without a restart.

| Control | Default | Supported range |
| --- | --- | --- |
| `VIGO_NATIVE_MAX_PENDING` | 256 requests waiting or running | 1–100,000 |
| `VIGO_NATIVE_MAX_PENDING_BYTES` | Capacity ÷ 64, between 16 and 256 MiB | 1 MiB–4 GiB |
| `VIGO_NATIVE_CITY_MAX_PENDING` | 128 per City | 1–100,000 |
| `VIGO_NATIVE_CITY_MAX_PENDING_BYTES` | Half the global byte limit | 1 MiB–4 GiB |
| `VIGO_NATIVE_RESPONSE_BUDGET_BYTES` | Capacity ÷ 8, between 256 MiB and 2 GiB | 1 MiB–16 GiB; never below one response line |
| `VIGO_NATIVE_AFFINITY_WAIT_MS` | 500 | 1–60,000 |
| `VIGO_NATIVE_RESTART_BUDGET` | 6 process starts per City in 30 seconds | 1–100 |

The response budget counts native answers being received and decoded across
every process. The first answer being received always finishes; others pause
their output while the total is over budget. `GET /api/health` reports
`nativeRuntime.admission`, `responses` and `counters` (overload refusals,
expiries, retries, process starts and requests refused after a retirement or
reset).

The Node routing-time validator has explicit interface bounds: Studio accepts
whole minutes from 0 through 1799, and GTFS orchestration through 2880. The
native public request schema accepts seconds through 71:59:59. Tests retain
these boundary distinctions. Engine and Python documentation readers ship
independently; their shared Markdown subset is checked for rendering parity.

The runtime uses the smaller of host RAM and Node's reported container limit to
choose its default budgets. Configuration accepts finite positive integers;
invalid values use the default, and valid values are clamped to the supported
range. Zero does not disable the timetable byte guard.

| Control | Default | Supported range |
| --- | --- | --- |
| `VIGO_ACTIVE_KERNEL_MAX_BYTES` | One eighth of capacity, between 64 MiB and 2 GiB | 1 MiB–16 GiB |
| `VIGO_ROUTE_MAX_PENDING` | 128 dispatches and, separately, 128 preparation lifecycles | 1–1,024 |
| `VIGO_ROUTE_MAX_QUEUED` | 32 jobs per worker | 1–256 |
| `VIGO_ROUTE_WORKER_HEAP_MB` | One eighth of capacity, between 128 and 2,048 MiB | 64–8,192 MiB |
| `VIGO_ROUTE_JOB_TIMEOUT_MS` | 900,000 ms | 1,000–3,600,000 ms |
| `VIGO_ROUTE_WORKER_RSS_BUDGET_BYTES` | One eighth of capacity, between 64 MiB and 2 GiB | 64 MiB–reported capacity |

Timetable admission counts the active service slice before allocating native
arrays, estimates its size, and checks retained bytes after construction. Realtime reconstruction estimates the resident scheduled view, rebuilt arrays and replacement calls before native compilation against the same budget.
Default cache budgets scale with capacity.

The pool rejects excess work with status 503. Capacity waits have a deadline,
and a worker watchdog requests termination when an operation exceeds its deadline. Under
memory pressure the pool avoids adding a second City until an unleased idle
worker can be retired. Worker diagnostics expose limits and pending counts.
Shutdown wakes waiting requests and permanently closes the pool.

Within queued query work, Studio prioritizes point Route, departure-window, and street Route requests.
An older analytical job runs after at most four point-query bypasses. Preparation
and unknown operations preserve their queue order, and running native work is
not preempted. Worker diagnostics expose `maximumPointBypasses`.

These are admission and retention safeguards, not a hard whole-process memory
limit. V8's worker heap limit excludes native arrays and mapped street data.
Imports, realtime reconstruction, result assembly, and serialization can still
have temporary allocation peaks. The RSS check cannot interrupt a native
allocation already in progress. A native call must return before thread termination
can complete; operating-system memory exhaustion remains possible. Street and timetable budgets must be considered together for large
Cities.

### Recovery

A routing-thread failure rejects its active and queued work, waits for termination,
and reopens authoritative City data for a subsequent request. Structured-clone
failures reject only the affected job and leave the worker usable. No failed
query is converted into a fabricated journey.

Studio keeps its window when the Engine exits. It allows three starts within a
rolling minute, including the initial start, with increasing restart delays.
Startup has a 30-second deadline. Once the restart budget is exhausted, a later
request can try again after the rolling window permits it. Engine startup
failure does not prevent the window from opening. Pending requests fail rather
than being replayed automatically, because some requests change stored data.
Studio admits at most 128 Engine requests, including those waiting for startup.
When the Engine is unavailable or the restart budget is exhausted, desktop API
requests return a structured 503 response. The interface can show the failure
without waiting for an unresolved protocol request.

Packaged Engine environment filtering lives in `public/engine-environment.mjs`.
Studio supplies its own application-data path after filtering so startup and
recovery use the same configuration directory.

### Tests with real execution

`test/check-national-runtime-isolation.mjs` builds real GTFS and OSM inputs and uses the production worker and native kernel: it verifies exact journeys after thread termination, rejects a 50,000-trip input under a 4 MiB budget, rejects an oversized realtime reconstruction while scheduled routing keeps working, and checks overload and shutdown. `test/check-engine-recovery-runtime.mjs` runs the Electron entry point, kills Engine processes, and checks health, the restart budget and the subsequent 503. These checks do not establish other-platform behavior, live-feed accuracy or immunity to memory exhaustion.

## GTFS support matrix

This matrix is the public boundary of what VIGO's routing uses from GTFS. "Imported" alone is not support: the routing column says whether a feature changes which journeys are feasible. Every import records a feature inventory.

Pickup and drop-off permissions are compiled per connection: a forbidden boarding is absent from the departure index, a forbidden alighting cannot end a ride, and a passenger already aboard stays on through either kind of restricted stop. Transfers are prepared into one stop-level transfer graph before the scan; see [How VIGO computes answers](reference/methodology.md#transfers). When a feed uses features VIGO does not support, the rest is routed as a `supported_scheduled_core`, with the exclusions attached to every Result. Only multiple agency timezones block a whole feed.

| GTFS feature or case | Import | Routing behavior | Classification |
|---|---|---|---|
| `calendar.txt` only | Yes | Weekly service within start/end dates. | Supported. |
| `calendar_dates.txt` only | Yes | Type 1 adds and type 2 removes service on the exact date. | Supported. |
| Calendar plus exceptions | Yes | Exceptions override the weekly calendar for the date. | Supported. |
| Missing both calendar tables | Rejected | No service date can be established. | Rejected malformed input. |
| Times greater than 24 hours | Yes | Preserved as seconds on the originating service day. | Supported within the query horizon. |
| Trips crossing midnight | Yes | Connections retain their originating service date. Native clock-date requests load active adjacent service days, including overnight headway windows. | Supported within the service-day range and query horizon. |
| Trips extending across more than one midnight | Parsed | Same coordinate model; default horizon may exclude them and the public CLI clock is bounded. | Bounded; caller must set a sufficient horizon and service-day coordinate. |
| Invalid minute or second fields | Rejected | Values such as `08:60:00` or `08:00:60` do not normalize silently. | Rejected malformed input. |
| Agency timezone, one timezone | Inventoried | Native service epochs use local noon minus twelve elapsed hours; realtime instants use the same timezone. | Calendar, overnight and DST regression checks cover the native APIs. |
| Multiple agency timezones in one store | Inventoried | Exact routing is blocked. | Unsupported and visible. |
| `frequencies.txt`, `exact_times=1` | Yes, bounded | The template trip is expanded into deterministic fixed departures for each declared frequency window. Generated instances retain route, service, permissions, and shape identity. | Supported for bounded deterministic windows. |
| `frequencies.txt`, `exact_times=0` | Yes | The template departs at each window's start and then every headway, before the exclusive `end_time`, as ordinary trips. | Supported as scheduled estimates; limitation `frequency_based_service`. |
| Overlapping or mixed frequency windows | Rejected | Import requires nonoverlapping windows and a single `exact_times` value per trip. | Invalid feed rejected before publication. |
| Shapes present | Yes | Ordered trip stops are matched to a monotone shape slice. | Supported for rendering; feasibility never depends on shape. |
| Shapes missing or unusable | Yes | Timetable route remains valid. Ordinary network lenses show no inferred route alignment; selected-itinerary and Shape/Risk QA views may show a dashed, explicitly inferred stop sequence. | Timetable supported; published ride geometry unavailable. |
| Duplicate stop names | Yes | Identity is `stop_id`, not name. | Supported. |
| Parent stations and platforms | Yes | Explicit parent transfer rules expand to child service platforms; selected stations expand to service members. Without an explicit rule, service members share a modeled 120-second connection, reported as `parent_station_fallback` with schematic geometry. | Supported for `location_type` 0/1; fallback time is not a measured station pathway. |
| Deeper `location_type` hierarchy | Prepared | Station membership includes descendants. Boarding areas connect to their parent platform for boarding/alighting; a platform cannot create an unproved shortcut between its areas. | Pathway-based access supported; unlocated boarding areas cannot be selected directly. |
| `pathways.txt` direction and traversal time | Yes | Creates directed transfer edges; explicit traversal times take precedence. Stairs with a stair count and fare/exit gates receive labeled estimated costs when time is omitted. Bidirectional rows create the reverse edge. Parallel pathways use the lowest available traversal cost; unpriced paths without enough data remain excluded. | Supported within the prepared pathway graph. |
| Pathway wheelchair/slope/width attributes | Profile dependent | Applied during `build --wheelchair`; ordinary Cities inventory them without filtering. | See [Wheelchair routing](guide.md#wheelchair-routing). |
| Transfer type 0 | Yes | Directed recommended transfer using declared/default duration. | Supported within transfer model. |
| Transfer type 1 timed transfer | Yes | A stop-level rule with no minimum time. The guarantee, holding a vehicle for a late connection, is not represented. | Supported without the guarantee; limitation `timed_transfer_guarantee`. |
| Transfer type 2 minimum time | Yes | Declared minimum traversal time is enforced. | Supported. |
| Transfer type 3 forbidden | Yes | Directed pair, including expanded parent/platform pairs, is forbidden and cannot be regenerated by proximity. A same-stop prohibition blocks reboarding after a ride while preserving an origin's initial boarding. | Supported with permanent SQLite, compact-kernel, and matrix regressions. |
| Transfer type 4/5 in-seat semantics | Retained in optional `trip_links` | Rust compiles explicit type 4 links, including different terminal stops, into through runs; type 5 never grants a continuation. Source trip identities and dwell remain visible. | Route, Matrix and Reach count one boarding; onboard movement and dwell are riding time. |
| Route- or trip-scoped transfer selectors | Not applied | Retained in `transfer_rules`; the stop-level rule governs the transfer. Stop-level rules use parent-station expansion and GTFS specificity: a platform's own rule overrides its station's. | Stop-level semantics only; Flex interchanges still resolve scoped selectors. |
| Nearby stops without explicit transfer | Prepared | One native multi-target street search creates every directed OSM-reachable alight-to-board edge within 500 m. Each edge stores its routed distance; unproved radial pairs remain visible counts. | Supported within the City street model. |
| `pickup_type=1` / `drop_off_type=1` | Yes | The complete scheduled trip is retained. Boarding is prohibited only at a stop with `pickup_type=1`; alighting is prohibited only at a stop with `drop_off_type=1`; through-riding remains legal. | Supported for fixed-stop routing. |
| `pickup_type` / `drop_off_type` value 2 | Conditional | `flex: {}` includes journeys through timed fixed stops with booking requirements; ordinary routing excludes those events and keeps through-riding. | No booking or availability confirmation; see [GTFS Flex](guide.md#gtfs-flex). |
| `pickup_type` / `drop_off_type` value 3 | Yes | Fixed flag stops permit boarding/alighting, assuming the rider signals or notifies the driver. This does not enable continuous stopping or advance-booking service. | Visible `driver_coordinated_stops` condition. Rebuild Cities imported before this fix: compiled permission bits cannot distinguish flag stops from prohibited events. |
| Continuous pickup/drop-off | Conditional | With `flex: {}`, boarding and alighting follow directed GTFS shapes and stop-time permission overrides. Intermediate times are interpolated and labeled as estimates. | Booking and driver-coordination requirements remain visible; ordinary fixed-stop routing is unchanged. |
| GTFS Flex zones, location groups and booking rules | Yes | With `flex: {}`, conditional rides join fixed service in one search. | See [GTFS Flex](guide.md#gtfs-flex). |
| Loop routes | Yes | Sequence, not stop identity, orders a trip; reconstruction can retain repeated locations. | Supported, with adversarial regression coverage required. |
| Repeated stop in one trip | Yes | Distinct `stop_sequence` events remain distinct. | Supported. |
| `block_id` interlining | Partial | Consecutive same-terminal trips with a shared block, service ID and service day use Rust through-runs; explicit links take precedence. | Other block models require explicit links. |
| Duplicate stop, route, trip, or calendar IDs | Rejected | A primary-key conflict aborts the temporary build; no partial store is published. | Rejected malformed input with adversarial atomicity coverage. |
| Missing shape ID referenced by a trip | Yes | Timetable routing remains available, but published alignment is unavailable; any selected/QA stop-sequence line is dashed and marked inferred. | Timetable supported; published ride geometry unavailable. |
| Untimed interior stop-time gaps | Yes | Timed endpoints remain connected and the itinerary reports `interpolated-stop-time-gap`; no exact timestamp is claimed for omitted interior events. | Supported with degraded timing precision. |
| Malformed required table | Rejected | Build does not commit the temporary store. | Supported rejection. |
| Broken core references | Rejected | Unknown trip routes/services, parent stations, transfer endpoints, frequency trips, and stop-time trip/stop references abort the temporary build. Missing shapes remain a supported timetable-only case as declared above. | Rejected malformed input with adversarial atomicity coverage. |

### Explicit linked trips

The optional `trip_links` SQLite table preserves `from_trip_id`, `to_trip_id`, and
`transfer_type` (4 or 5), including feed namespaces. Existing Cities without it
remain readable. A City whose importer discarded these rows must be rebuilt
from the original GTFS; no runtime can recover the missing evidence.

The Rust runtime compiles active, chronological type 4 chains
once per timetable view, after realtime updates. Splitting and coupling produce
bounded through paths. Original trips remain available for partial journeys and
for reconstructing source trip IDs, shapes, headsigns and service dates. No new
search algorithm or JavaScript routing path is introduced. Ordinary Cities have
no extra connection arrays; linked paths add only their own connections. Limits
(512 trips per path, 200,000 paths, and four times the original segment count
with a 100,000-segment floor) fail explicitly rather than truncate results.
Path retention is also capped at one million trip references. Before copying
columns, an estimate including spare vector capacity, physical-part copies and
name tables must fit one eighth of detected memory capacity, capped at 128 MiB.
This bounds estimated additional allocations; it is not a process RSS guarantee.

A public transit leg following an in-seat continuation has
`continuation: { "type": "stay_aboard", "durationSeconds": 300 }`, for example.
The duration is the actual onboard gap before that leg, including zero; it is
part of journey riding time, not waiting for another vehicle. Transfer limits
apply to boardings, not the number of displayed source-trip legs. Boarding or
alighting restrictions at the boundary do not force passengers off the vehicle.
Through-journey fares remain unavailable where the fare catalog cannot describe
the corresponding fare-leg joins; VIGO does not invent an additional or free fare.

Explicit links may connect different terminal stops: the interval between the
first trip's arrival and the next trip's departure is onboard movement or dwell.
It is included in riding time, without inventing a passenger walking leg.
Overlapping clocks, canceled/truncated endpoints and inactive trips do not
establish continuity.

The optional `trip_operations` table retains block identifiers and bicycle
permissions. Rust infers consecutive same-terminal block continuations only
within one service ID and service day. Adjacency comes from the original
schedule, so cancellation cannot skip over a missing middle trip. Explicit
links (including type 5) take precedence. Different-terminal blocks and blocks
spanning different service IDs still need explicit links. Old Cities without
these optional tables retain their existing behavior.

`node test/check-linked-trips.mjs` checks raw-GTFS import, forward/reverse Route,
Matrix, Reach, source identities, dwell, boarding restrictions, realtime,
branching and scenario exclusions. The native unit tests cover service-day
boundaries and invalid continuity.


### Realtime replacement trips

GTFS Realtime `REPLACEMENT` (experimental, enum value 5) replaces a known trip's
complete stop sequence in Rust. Every call must identify an unambiguous existing
City stop and an increasing stop sequence, with absolute arrival/departure clocks
at every call. Changed intermediate stops and realtime pickup/drop-off
restrictions are supported. Incomplete, backwards or unknown-stop replacements are
rejected and reported in realtime diagnostics. `NEW` and `DUPLICATED` still need
new trip identity construction and are not supported by this replacement path.

### Semantic coverage written to store metadata

`blockingRoutingFeatures` has one code for otherwise importable GTFS: `multiple_agency_timezones`. A City with it cannot route.

Nonblocking `routingLimitations` keep the City routable in `supported_scheduled_core` mode. Each records a count and a detail, and an `exactness` of `approximate` or `unsupported`:

| Code | Meaning |
| --- | --- |
| `frequency_based_service` | `exact_times=0` templates, routed as departures every headway from each window's start |
| `repaired_trip_times` | Backward times repaired by delaying events at most 600 seconds |
| `backward_trip_times` | Trips needing larger corrections, excluded whole |
| `on_demand_boarding_or_alighting`, `driver_coordinated_stops`, `restricted_boarding_or_alighting`, `continuous_pickup_or_drop_off` | Pickup and drop-off types that need booking, coordination or Flex |
| `scoped_transfer_rules` | Route- or trip-scoped transfer rules, kept but not applied |
| `timed_transfer_guarantee` | `transfer_type=1` rows; the guarantee to hold a vehicle is not represented |
| `in_seat_transfer_rules`, `block_interlining` | Continuations VIGO cannot represent exactly |
| `pathway_accessibility`, `unpriced_pathways`, `station_entrances`, `station_level_hierarchy` | Station data the walking graph cannot fully use |
| `wheelchair_accessibility`, `bicycle_accessibility` | Trip and stop accessibility attributes outside the active profile |
| `feature_inventory_incomplete` | The import could not inventory every feature |

"Nonblocking" does not mean full-feed support: it means VIGO makes a narrower, explicit claim over the compiled scheduled core instead of disabling unrelated service. A journey in this mode is optimal over that core, and `no_path` means no path exists in the core; an excluded trip or rule could still change full-feed reachability. Holding a vehicle after its scheduled departure is not predicted.

Public comparisons require matching `assumptionsFingerprint` values. Scenario and observation content are interventions excluded from that fingerprint; route constraints, City revision and engine version are included. Equivalent requests with omitted and explicit defaults are treated as different until normalized.

### Required fixture policy

Each row classified supported must have a miniature feed that would fail if the
field were merely parsed. Each visible unsupported row must have a fixture that
imports successfully and records the feature code. Permission fixtures must
prove that the trip remains connected, illegal boarding and alighting events
are rejected, and through-riding remains legal in the resident kernel, shared
matrix path, and merged stores. Quarantined transfer fixtures must prove that
the unsupported row is absent from the generic graph.
Multiple-timezone fixtures must still prove a feed-wide blocked result.
Rebuild an older SQLite store before using it for a published result.

## Reproduce a service workload

Use a retained NDJSON request file containing public Route, Matrix, and Reach requests. Each line includes `kind`, the City or scenario selection supported by your service, the service date, and all routing constraints. Keep the file and prepared City together with their source checksums.

```sh
node scripts/benchmark-service.mjs \
  --url http://127.0.0.1:8080 \
  --requests queries.ndjson --output results.json \
  --rounds 20 --concurrency 4 --warmup 1 --city ./city
```

Set `VIGO_API_TOKEN` if the service requires authentication. The benchmark does not write the token to its report and refuses to overwrite an existing result. It calls the service's `/v1/route`, `/v1/matrix`, and `/v1/reach` endpoints.

The report retains every measured call, warmup calls, request-file hash, runtime capabilities, client platform, and optional unique-file City storage. Latency includes queueing, HTTP, response transfer, and JSON parsing. Quantiles use nearest rank. Successful results, valid no-journey results, HTTP failures, overload, service unavailability, timeouts, invalid responses, and transport failures are reported separately. Errors during warmup also fail the run.

For a cold-start measurement, start a fresh service and use `--warmup 0 --rounds 1`. Measure readiness separately from the first query. For sustained use, retain the same workload and increase rounds; report how much the workload repeats and whether caches are enabled. Compare equivalent inputs, constraints, output detail, hardware limits, and runtime builds.

City storage counts each file identity once, including shared scenario directories. It is logical file size, not physical APFS clone allocation. Server memory must be measured at the service: retain process-tree RSS/PSS or cgroup memory samples at startup, first query, repeated and concurrent queries, scenario switches, and peak large-output requests. Include the full application stack when claiming a deployment budget. The benchmark client's memory is not server memory.

Use public synthetic fixtures for CI and caller-owned Cities for operational acceptance. A short replay establishes behavior for that retained workload; it does not establish production reliability across unobserved traffic. See [upgrading](guide.md#upgrade-and-rollback) for installation and rollback checks.

## Source layout and delivery

All Rust code builds from the root Cargo workspace and `Cargo.lock`; see [Crates](#crates). The vendored CCH dependency stays isolated with its license and notices. `src/` contains Studio, its application services and GTFS and OSM import. Build outputs live in the root `target/`; do not add a nested lockfile or target tree.

CI (`.github/workflows/ci.yml`) runs inside the Release workflow, or when started by hand; pushes and pull requests start no workflows. It runs source, documentation and Rust workspace checks, the Python package checks on Python 3.10–3.13 and three operating systems, and the engine, compiler, Studio and live Python suite on Linux. One Release workflow, started by the `v<VERSION>` engine tag, reuses CI's source and Python checks, then builds and tests the engine, the compiler, Studio and the Python wheels on all four platforms from that commit, packages the tested executable, checks Cities built on other platforms, and verifies the Linux containers before attestation and publication. Release container checks use `deploy/Dockerfile.release` and the verified archive; `deploy/Dockerfile` builds from source.

Within one unchanged CI job, `VIGO_USE_BUILT_RUNTIME=1` reuses the runtime built earlier in that job and fails if a binary is missing. Never use it after editing Rust or embedded documentation; local builds stay source-checked by Cargo.

## Bicycle implementation

VIGO supports an optional bicycle graph in `bike_nodes`, `bike_edges`, `bike_turns`,
and `bike_way_turns` tables inside the existing street database. Existing
readers ignore these tables; no existing field, snapshot or format identifier
changes. CLI builds opt in with `--street-modes=walk,bike` or
`--street-modes=walk,drive,bike`. Studio OSM imports include bike streets.

The bicycle engine customizes one turn-aware contraction hierarchy for the
selected profile, speed and stress limit. Ordinary movements use scalar
shortcuts. Dated entries and endpoint-only permissions narrow the shortcut
choices. When time or metres constrain a path, the same rank sweeps retain
the necessary undominated travel time, preference cost and distance states.
Endpoint projection uses the road segment index, and verified pedestrian
connectors share the pedestrian hierarchy with unrounded distance weights.

A source-bound hierarchy cache can reuse the upward topology and shortcut
witnesses on process start; opening it rebuilds the remaining columns and
weights exactly. It contains graph data only. The original City remains the
source of truth; its prepared files and portable layout do not change.

Bicycle Reach first bounds every cell's walking access with one relaxed
hierarchy sweep from the fixed endpoint: a cell searches only as far as a
bicycle node could still beat its best candidate. Cells whose minimum the
path certificate cannot settle repeat with every walking candidate.

Preference cost is distinct from physical travel seconds. The default
`balanced` and `quiet` profiles penalize traffic exposure; `fast` minimizes
estimated travel time. Mapped surfaces and incline change speed. Dismount
segments use walking time and are materialized as `walk` legs with
`geometrySource: "osm-dismount"`. Off-network coordinate connectors remain
unverified walks. Bicycle Reach supports both departure and arrival queries.
Bikes-on-transit, bike sharing and elevation rasters are outside this model.
Unhandled relation shapes are counted in diagnostics.

All street modes estimate travel duration. A dated bicycle request also uses
the City's time zone to evaluate supported weekly road and turn permissions
at the moment of entry. When the request has no usable service clock, the
engine excludes timed roads and applies conditional turn restrictions
conservatively. Walk uses a static pedestrian graph; Drive can apply an
admitted traffic snapshot to its static road metric.

The importer follows the [OSM access hierarchy](https://wiki.openstreetmap.org/wiki/Key:access).
Trunk roads retain explicit bicycle restrictions and motorroad exclusions;
their classification alone does not make them motorways. Movable gates inherit
the admitted way's access unless private, locked, or time-restricted. Mandatory
separate cycle paths (`bicycle=use_sidepath`) exclude the roadway. These portable
defaults are not a country-specific traffic-law model.

Run `npm run check:bike`, the Rust `bike::tests`, and
`npm run check:format-050`. The latter checks that the published reference
reader can open a newly written City with the optional bike tables.

Valhalla's [bicycle costing documentation](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
and [elevation model](https://valhalla.github.io/valhalla/sif/elevation_costing/)
provide feature references. VIGO's weights are its own documented heuristics.
Passing synthetic regressions does not establish route-quality or performance
parity with Valhalla, GraphHopper, or BRouter. Comparative evidence belongs in
the separate benchmark workspace.
