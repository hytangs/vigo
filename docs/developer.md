# VIGO 0.5.0 developer guide

Canonical source for the [documentation reader](guide.html). Edit the relevant chapter, then rebuild the reader.

## Developer resources

Use the public CLI, HTTP, or Python interface to integrate VIGO. Studio's internal API and the native field dictionary serve different purposes and are not interchangeable with public application responses.

### Build and understand the engine

- [Contributing and checks](../.github/CONTRIBUTING.md)
- [Architecture](#architecture)
- [Native operation fields](reference/rust-standalone-native.md)
- [Runtime recovery](#runtime-limits-and-recovery)
- [Local basemap](#local-osm-basemap)

### Validate behavior and performance

- [Routing accuracy checks](#checking-routing-accuracy)
- [Performance measurement](#measuring-performance)
- [Timetable query performance](#timetable-query-performance)
- [Reproduce a service workload](#reproduce-a-service-workload)
- [GTFS support](#gtfs-support-matrix)

A passing public synthetic fixture verifies the exercised behavior. Use the exact build and target's test results when assessing an installation; an old test count is not a current release check.

### Maintain the documentation

Markdown is the source for the searchable reader. Run `npm run docs:build` after changing a page, then `npm run check:docs`. The standalone manual and OpenAPI file are generated with `npm run docs:standalone`. Both readers work offline and include print styles. Release artifacts use these generated readers; there is no separately maintained PDF manuscript.

### Research interfaces

These are bounded research tools with their own assumptions and evidence:

- [Network service assessment](#network-service-assessment)
- [LAMP running-time study](#saved-lamp-running-time-studies)
- [Operations ledger](#agency-operations-prototype)
- [Synthetic holding replay](#one-bus-one-control-point)

### Historical records

The [validation archive](history.md#historical-records) retains dated development evidence. It is separate from the current usage instructions. Version history remains in the [changelog](../CHANGELOG.md).

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

Browser development uses loopback HTTP in place of the desktop memory channel, with the same handlers. The Studio HTTP API is internal; the stable programmatic boundary is the [CLI](guide.md#command-line).

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
| Transit Matrix | Shared native forward scans per origin or reverse scans per destination; optional selected witnesses |
| Reach | Native timetable propagation and walking surface; JavaScript contours and Result shaping |
| Scenario | JavaScript validation and compilation of supported changes; native routing applies the compiled overlay |

JavaScript owns request validation, identity resolution, orchestration, cancellation, and presentation. Rust owns active-timetable departure/transfer indexing, realtime timetable reconstruction, station path compilation, graph search, and timetable propagation; see the [kernel implementation map](../native/vigo-routing-kernel/UNIFIED_ROUTING_KERNEL.md). Source-feature omissions remain explicit in results; shared implementation alone does not prove correctness. [Independent checks](#checking-routing-accuracy) validate the declared model.

### Module boundaries

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

For current admission budgets, restart behavior, and test coverage, see
[runtime limits and recovery](#runtime-limits-and-recovery).

### Desktop and Network

`public/main.mjs` owns windows, menus, dialogs, and the `vigo://studio` resource scheme. `public/preload.cjs` exposes a small desktop bridge to an isolated renderer without Node access. Engine runs in a utility process; packaged Studio has no TCP listener. Packaging copies the shared `public/` distribution once.

Network shares one route/station selection across its tabs, map, line diagram, and Ask. Known feed namespaces resolve against the City timetable; ambiguous bare IDs cannot select an agency. Station scope includes platforms, while a platform keeps its own events. Saved answers retain their original selection and observation; background responses do not move the map.

| Surface | Owner |
| --- | --- |
| Trip times and patterns | `AgencyTripTimetable`, `NetworkTimetable` |
| Map and line | `VigoMap`, `AgencyRouteLine` |
| Station board and evidence | `StopArrivalBoard`, `AgencyEvidence` |
| Ask and saved work | `AgencyPanel`, `AgencyAnswer`, notebook |
| Route/vehicle timing | `src/agency/routeOperations.mjs` |

Vehicle matching preserves service dates, including previous-day overnight trips. Network assessments share an immutable observation; method and denominators are documented in [service assessment](#network-service-assessment). Old ledger records remain readable, but new guidance requires current source identity. Model-history compatibility filters protect previously internal context and are not disposable legacy code.

Studio Reach retains packed reached-edge data, lazily reuses decoded coordinates across cutoffs, and serializes large map-source replacement. Changing a displayed cutoff does not require rebuilding the street graph. Runtime fixtures check map updates and rapid cutoff changes.

### Storage and verification

The complete CLI City directory is portable; individual databases and native files are implementation details. Studio library settings, drafts, notebooks, and connections are separate application state. The [operations ledger](#agency-operations-prototype) and [replay](#one-bus-one-control-point) remain active research interfaces with their own tests and storage. The [LAMP reader](#saved-lamp-running-time-studies) can inspect existing City studies.

Use the [contribution guide](../.github/CONTRIBUTING.md) to choose checks. Routing fixtures verify feasibility and witnesses; desktop runtime fixtures verify interaction. Actual-provider evaluations are opt-in and separate from deterministic tests. No fixture or build proves field accuracy or model reliability.

The [0.4.2 architecture audit](history.md#architecture-audit-for-042) records the freeze review,
remaining cost centers, and reasons for retaining compatibility code.

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

#### Native timetable preparation

Since 0.4.1, Rust constructs per-stop departure order, deduplicates transfers, expands station fallback links, and packs transfer adjacency. JavaScript resolves source IDs and passes typed arrays to the native preparation operator. This runs on active-timetable cache misses; loading a compatible persisted snapshot bypasses it.

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

Since 0.4.2, both persisted and in-memory Drive hierarchy construction use one
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

### Coordinate routes and materialization

For capped fastest depart-at queries, the Node adapter permits the fused Rust call to return the selected access and egress witnesses, including walking geometry. The existing native guard uses this compact result only for certified one- or two-boarding routes. Uncapped queries, balanced preferences, departure-window alternatives, and arrive-by deadline certification retain the full candidate frontier. The change removes candidate conversion and subsequent path calls without limiting the search.

The standalone adapter retains immutable route metadata and trip-to-shape identifiers within each opened City. Journeys still reconstruct their active timetable stop sequence and geometry on every request. The metadata maps are bounded by the City's route/trip counts, are released with that City, and remain separate from endpoint or answer caches.

Compiled GTFS shapes and their geometric alignment candidates are retained separately in a City-owned least-recently-used store, limited to 4,096 shapes and 256 MiB of estimated geometry storage, matching the Node interface's shape-cache limits. Lookups examine the most recently used entries first. This avoids the much smaller standalone cache repeatedly evicting geometry on varied city-wide workloads; the larger upper bound can increase resident memory. Sizes are accounted again after alignment grows candidate data. Oversized shapes are used for the current request and released. Timetable paths, realtime stop sequences, and selected shape slices are still reconstructed for each journey; the store does not retain route answers.

The standalone store also retains up to eight exact stop-to-shape alignments per shape within the same byte budget. The complete active stop coordinates, including their floating-point bits, form the key. A changed realtime stop sequence cannot inherit the scheduled alignment. Materialization copies only the selected shape slice. Point endpoint roles use the shared two-worker native executor. Batch endpoint evidence remains typed and is shared for identical request endpoints; it becomes JSON only when a response includes that evidence.

Generic street geometry keeps the original directed snap pairs, raw path distance, and tie rules. CCH path reconstruction shares one forward sweep across the candidate destinations for a source. Every destination still performs its exact backward sweep and shortcut reconstruction. The shared state is scoped to that batch call, so a subsequent source or metric never inherits it.

### Standalone startup and output boundaries

The standalone City reader deserializes the used access-context fields directly into native structures and skips unused projections. Scheduled transit can load the compiler's portable active-service snapshot after checking database identity, access policy, active services, transfer projection, dictionaries, canonical array layout, and native kernel invariants. Missing or invalid optional sidecars fall back to the existing SQLite preparation path. Realtime and modified street-transfer policies use source preparation. `timing.timetableSource` exposes the selected preparation path; `timing.totalMs` still excludes process startup and initial City opening.

Rust Matrix defaults to full display and walking-evidence detail. Node Matrix returns compact timed witnesses. For a comparable analytical workload, request Rust `journeyFormat: "compact"` with `includeJourneys: true`, or request duration-only matrices from both. Compact changes response detail only: the same native journey search runs, with the same trips, boarding sequences, clocks, and transfer count. Full remains the default and the required format for geometry and walking-evidence consumers. The stream uses bounded 64 KiB serialization scratch instead of retaining another complete encoded response.

### Reproduce a kernel comparison

Build each version with `npm run build:rust-routing-kernel` using the same toolchain and release settings. Save the earlier `native/vigo-routing-kernel/vigo-routing-kernel.node` under a separate path before building the changed version. Then run:

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

The following admission limits and recovery behavior apply to VIGO 0.5.0.
See [public results](reference/results.md) for the current result schemas.

### Memory and request admission

The runtime uses the smaller of host RAM and Node's reported container limit to
choose its default budgets. Configuration accepts finite positive integers;
invalid values use the default, and valid values are clamped to the supported
range. Zero no longer disables the timetable byte guard.

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
Default cache budgets now scale with capacity instead of imposing large minimums.
This adds a count query to cold timetable construction. No latency improvement
or large-City performance result is claimed.

The pool rejects excess work with status 503. Capacity waits have a deadline,
and a worker watchdog requests termination when an operation exceeds its deadline. Under
memory pressure the pool avoids adding a second City until an unleased idle
worker can be retired. Worker diagnostics expose limits and pending counts.
Shutdown wakes waiting requests and permanently closes the pool.

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

### Smaller tests with real execution

`test/check-national-runtime-isolation.mjs` builds actual GTFS and OSM inputs,
uses the production worker and native kernel, verifies exact journeys after
thread termination, rejects a 50,000-trip input under a 4 MiB budget, verifies
subsequent small-City routing, and checks overload and shutdown. It also imports
a 5,000-trip timetable that fits the scheduled budget, rejects a realtime
reconstruction above that budget, and verifies scheduled routing still works. It replaces the
simulated worker and several overlapping lifecycle suites.

`test/check-engine-recovery-runtime.mjs` runs the actual Electron entry point,
kills Engine processes, checks health after each restart, checks the retained
window and sandbox settings, and verifies the crash limit and subsequent 503
response. Browser polling uses
real timers. Streaming and provider-deadline checks use real local sockets.
Operations permissions, approval invalidation, SQLite transactions, audit history,
and reopening retained records run against the production operations service.

Canned model replies, substituted providers, worker emulators, global clock
patches, browser-method spies, and injected storage exceptions were removed.
Routing and vehicle-frame calculations accept explicit observation instants;
other browser checks use current timestamps and real timers. Small generated
GTFS/OSM and observation inputs remain test data, and production algorithms
compute their results.

Pruning removes coverage previously supplied by canned model conversations,
specific renderer refresh spies, simulated DNS changes, native-binding substitutions, forced file-deletion and
storage-quota errors, and server-wide clock replacement. Those assertions are not counted as equivalent real integration coverage.
The retained UI suites cover rendering, source updates, navigation, selection,
draft persistence, and damaged-storage handling. Actual model behavior requires
separately configured live evaluation; the release suite makes no model-quality
claim. Frozen replay inputs and saved-study readers remain because runtime and
research consumers still use them.

### Verification on this checkout

The dated 0.4.2 verification record is retained in the [release audit](history.md#architecture-audit-for-042).
Checks cover native routing comparisons, TypeScript, import/request security,
CLI/City portability, operational calculations, actual worker/Engine recovery,
real browser interactions and the macOS ARM64 package. They do not establish
other-platform behavior, live provider quality, or whole-process immunity to
memory exhaustion.

## Agency operations prototype

This backend prototype is outside the main Network / Routes / Ask workspace. Its API, records and service tests remain available for research. The workflow below describes internal API actions, not additional Studio buttons or a supported public integration API.

The [operational replay](#one-bus-one-control-point) adds a synthetic holding decision through procedure selection, alternative comparison, approval, sandbox receipt and evidence-driven withdrawal. It reuses this ledger in separate replay storage. Internal knowledge and staff annotations are excluded from model context by default; approval alone does not authorize model disclosure.

The City operations ledger keeps findings, source evidence, staff decisions and rider guidance together. It works without a model. Ask can read approved public operational context and historical comparisons; mutations require explicit API requests from an authorized principal.

### Handle a finding

1. Call `operations-track` for a current finding. The selected evidence, timetable identity, source references and quality summary are retained. Tracking the same event twice returns the existing record.
2. Use `operations-transition` to acknowledge the finding, investigate, and record action. Each transition requires a note. Link approved, unexpired context relevant to the finding's route or stop when useful.
3. Prepare rider guidance, or transition to monitoring. A missing event or stale feed leaves current availability **unknown**; it never resolves the case automatically.
4. Resolve with an explicit outcome and evidence reference: staff-confirmed recovery, false positive, or unable to confirm. Resolved cases can be reopened for investigation. These labels are staff assessments, not independently verified ground truth.

Evidence remains as captured until `operations-refresh` is used. A changed timetable requires a new finding against the new import. Every edit requires the current version; a stale client must reload before saving. Revision history preserves the preceding evidence and decisions.

### Add shared context

`knowledge-save` accepts SOPs, maintenance records, document excerpts and operating notes. Each record has a source reference, scope and review date. New entries and revisions start as drafts. Approval applies to that exact version. Expired or draft material cannot be linked as approved guidance.

Keep source excerpts concise and identify their document revision or page. The API also supports exact stop scope. Content stays in the City ledger; no document crawler, embedding service or remote knowledge database is introduced. Ask's `operational_context` tool retrieves up to five dated, versioned excerpts and labels their status. Retrieved text is treated as evidence, never executable instructions. If used in Ask, these excerpts enter the configured model's context under the existing provider behavior.

### Prepare and deliver rider guidance

Call `message-draft` with the finding, channel, and audience to create an English template from its evidence. Channels have declared product limits: app and service alert, 2,000 characters; social, 280; signage, 160. These are editable starting templates, not assertions about every downstream platform's limits. Oversized templates require editing before approval; text is never silently truncated.

Audience choices are all riders, riders at a stop and accessible travel. Guidance asks riders to check departures or contact agency staff. It does not invent a disruption cause, recovery time, alternate route or guaranteed accessible connection.

Saving a revision clears approval. A reviewer checks the wording and evidence, approves the saved version, then **releases it to the local outbox**. Approval and release require current unchanged evidence, an action or monitoring state, and unchanged approved knowledge. Drafts initially expire after 15 minutes; the API permits an explicit expiry within 24 hours. A new draft is required when its source evidence changes.

`message-release` creates a durable local handoff containing the text, audience, channel, version, expiry, source evidence, and approval attribution. It does not transmit a message. After using the agency's own channel, staff can record its confirmation or public URL through `message-delivery`. That receipt is explicitly staff-recorded. `message-withdraw` preserves the prior revisions; staff must also remove an external copy in its channel. A repeated release request returns the same handoff rather than creating a duplicate.

### Retain and compare history

The first received observation in each five-minute bucket is retained for up to 90 days, capped at 25,920 samples. Samples include source clocks, coverage, quality flags and route prediction summaries. Repeated UI reads do not increase sample counts. The app must be open and its existing feed refresh active; idle suspension, shutdown and missed intervals do not generate synthetic observations.

The history API compares a route with earlier service dates from the same timetable import, local weekday and hour. It first takes each day's median reported route maximum predicted departure delay, then the median across independent days. At least three earlier days are required. Insufficient coverage or sample counts remain unknown. A different import is excluded from the comparison. This is a descriptive prediction baseline, not actual vehicle performance, passenger waiting time or an anomaly detector.

The history API also reports an expanding-window evaluation: each historical day's target is compared only with earlier days. It returns the number of held-out days and mean absolute error; no current or future day enters its training subset. There is no trained ML predictor. Paginated sample and record endpoints expose retained observations, staff outcomes and revisions for subsequent analysis without claiming that those annotations establish causal effects.

### Access, storage and operation

The shipped application remains a local, single-owner workspace. Its trusted host supplies `local-owner` with the `admin` role. No browser role selector, client-supplied identity or model tool can grant permissions. `createAgencyService` accepts a trusted `access(projectId)` callback for host-managed identity and City authorization; a missing or unauthorized identity fails closed.

| Role | Capabilities |
| --- | --- |
| Viewer | Read records, evidence and history |
| Operator | Viewer access; track findings, record decisions, draft knowledge and messages |
| Reviewer | Operator access; approve another author's knowledge/message, release and record delivery |
| Admin | Reviewer access; configure connections and skills; explicit same-author approval capability for the local owner |

There is no hosted login, SSO, agency directory or multi-user deployment in this change. A hosting integration must authenticate each request and supply its authorized principal through the trusted boundary; exposing the default local-owner service as a shared server would not provide user isolation. Admin approval is attributed in the ledger, not disguised as an independent reviewer.

Each City owns `agency/operations.sqlite`, separate from the read-only timetable and existing notebook. A database records its owner and rejects reuse for a different City ID. Schema version 1 uses SQLite WAL, full synchronous commits, a bounded lock wait, indexed records and transactional audit writes. Newer schemas fail closed. Human records are capped at 10,000; capacity exhaustion reports an error instead of silently deleting decisions. Revision history is retained with human records. These are application-enforced audit records, not cryptographically tamper-proof storage against someone with filesystem access.

The quality summary exposes source freshness failures, unresolved trip reports, timetable coverage and missing comparable departure pairs. Its alignment fraction uses **received reports** as its denominator. It does not claim the percentage of scheduled trips observed. `operations-health` reports database integrity, schema, counts, sample policy, last retained time, refresh activity and refresh/storage errors. History write failures are visible in Agency warnings; previous records are preserved. Live feed failures retain the previous observation while its source clocks continue aging.

For a consistent backup, stop Studio and copy the entire City `agency` directory, including SQLite sidecar files if present. Retain the timetable with it to preserve evidence identity. Restore to the same City identity and verify `operations-health` before resuming. Moving or replacing the timetable invalidates comparisons that depended on its previous local identity. This feature does not add replication, continuous background hosting or a recovery-time guarantee.

### API and verification

Use the existing `POST /api/projects/:projectId/agency` endpoint. Every mutation supplies `id` and `version` after creation. No mutation is in the model tool catalogue.

| Action group | Actions |
| --- | --- |
| Read | `operations-overview`, `operations-list`, `operations-record`, `operations-audit`, `operations-history`, `operations-baseline`, `operations-health` |
| Findings | `operations-track`, `operations-refresh`, `operations-transition` |
| Knowledge | `knowledge-save`, `knowledge-approve` |
| Rider guidance | `message-draft`, `message-edit`, `message-approve`, `message-release`, `message-delivery`, `message-withdraw` |

Lists return 50 records by default, up to 100, and accept `query.before` as the last returned ID (ascending IDs). Audit pages return 50 newest revisions and accept `before` as the last sequence. Observation pages return 100 newest samples and accept `before` as the last bucket. No external publication credentials are required or stored.

`npm run check:agency` includes the operations service fixture, covering workflow notes, message revision, approval, local release, recorded receipt, audit and insufficient history. `node test/check-network-workspace-runtime.mjs` checks the active Network workspace, keyboard tabs and responsive widths. All observations and receipts in these tests are synthetic. Runtime data remain in ignored `temp/` storage.

## Saved LAMP running-time studies

The internal **Running-time prediction review** method and the `historical_runtime` tool read an existing MBTA LAMP study from the selected City's research directory at `lamp/study.json`. VIGO no longer includes the study-generation scripts, Python dependencies, or a retained example result.

The reader reports training and evaluation dates, coverage, matched timetable errors, and route or segment summaries from the saved report. A filtered route view retains an explicitly labeled study-wide comparison. Missing studies are reported as unavailable.

LAMP reconstructed stop events can include final arrival predictions. Saved results describe retrospective running-time comparisons, not independent sensor validation, live delay causes, recovery forecasts, or passenger impacts. MBTA results must not be applied to another agency because route names match.

## Network service assessment

The briefing starts with the distribution of conditions across reporting service. It then identifies shared locations, longer waits relative to the same scheduled departures, and what remains unreported. It is generated from the shared Agency observation and retained with its route and trip evidence.

The computed assessment appears immediately. It leads with the spread of late predictions, then prioritizes shared-area delays separately from longer rider waits. Whole-minute descriptions support the finding; quantiles and route counts remain evidence, not the headline. Ask receives a compact version of the same diagnosis through `network_overview`.

When a provider is configured and late predictions are present, a bounded investigation follows. The model chooses a focus and candidate explanations, then up to two additional evidence checks. Agency notices and upstream predictions are always checked. It assesses the resulting facts as plausible, weakened or unresolved, cites support and counterevidence, and chooses what to observe next. Two schema-constrained model calls have a shared 75-second deadline; no larger model is required. Invalid assessments retain the computed briefing and completed checks.

### Measurements and denominators

- **Service window:** the next 30 minutes, using the existing observation policy. Scheduled trips contribute only the seconds during which their indexed first departure–last arrival span intersects the window. Calendar exceptions and preceding service days with 24:00+ trips are included using the GTFS service clock. Frequency templates are explicitly excluded.
- **Reporting coverage:** scheduled vehicle-minutes belonging to trips with a usable upcoming departure prediction or cancellation report, divided by all scheduled vehicle-minutes in the window. This weights frequent service by its actual scheduled supply. It is neither passenger coverage nor a health percentage.
- **Timetable deviation:** one next departure per reporting trip instance. Median and 90th-percentile absolute deviations use empirical nearest ranks. Early, exactly matching, and late predictions are kept separate. Additional reporting trips outside the scheduled window remain in the timing distribution and are counted separately in coverage.
- **Spacing:** only consecutive scheduled departures with both predictions at the same stop, direction and service date qualify. Equal intervals are retained. The same pair at multiple stops counts as one pair; its largest increase and stop extent are retained. Missing intermediate trips cannot become a measured service gap.
- **History:** repeated late predictions require distinct source timestamps at the same trip and stop. The retained history supplies a measured duration and change, not an incident onset, actual passage history, or recovery forecast.

All indexed routes receive a state. No predictions means unknown; no scheduled trips means no scheduled service in this window. A single late prediction is distinguished from several late predictions. These are descriptive states, not hidden severity thresholds or claims about an agency's on-time standard. Exact matching predictions establish only the checked next departures.

### Spatial interpretation

The geographic unit is an exact directed GTFS connection between stops. Overlapping scheduled-to-predicted departure windows on two or more routes identify a shared-location delay pattern. Adjacent segments connect only when the original segment observations have the same routes, overlapping windows, and a common affected trip. Connected components form the concentrations; an aggregate time envelope cannot create a new connection between otherwise separate observations. Each trip counts once in a concentration. Concentrations are ranked by summed positive departure delay across their distinct reporting trips, not the number of stop records or equal route weights.

This establishes where predicted lateness overlaps. It does not establish that delay originated on that segment, a corridor travel-speed reduction, propagation, a common incident cause, or passenger demand. Reverse-direction segments and non-overlapping time windows remain separate. Stops with similar names or nearby coordinates are not merged. Labels come from the timetable; no Boston neighborhoods are embedded in the method.

The implemented hierarchy is network → shared corridor/location → route → trip. Administrative regions, learned normal-variability ranges, passenger-weighted impact, and forecasts need additional agency data and validation. They are not fabricated to fill a five-layer diagram. Published alerts remain available in the shared observation and route views; the diagnosis does not infer a cause from their titles. The investigation can use an applicable notice as attributed evidence, with its stated route scope. Accessibility-only and no-effect notices are excluded from vehicle-delay explanations, while remaining available in the ordinary alerts views.

### Bounded causal investigation

`briefingInvestigation.mjs` chooses and executes checks through the existing tool registry. `serviceInvestigationEvidence.mjs` uses the same immutable observation as the diagnosis. `briefingInterpretation.mjs` constructs public facts and realizes the model's selected explanation. The model can select hypotheses and evidence IDs; it cannot generate new numerical observations, incident labels, probabilities or unrestricted prose in this briefing path.

The candidate space is deliberately small: a shared corridor disruption, delay carried by individual trips, terminal/dispatch issues, or reporting inconsistency. The model can leave these unresolved. An upstream forecast can challenge a claim that delay began in the selected area, but does not establish an observed onset. Absent notices, missing vehicle positions and unavailable historical studies cannot be cited as support or counterevidence. Model-assessed plausible explanations precede unresolved or weakened ones. These remain working explanations, not calibrated causal classifications.

A retained observation was tested with the configured local `qwen3.5:4b`. Unrestricted prose invented a blockage and confused scheduled intervals with conditions elsewhere; an early constrained version misused escalator notices. Neither behavior was accepted. The revised form separates notice effects, requires upstream evidence, and preserves support and counterevidence. In the retained test, delay already forecast upstream weakened a corridor-origin explanation. This single case does not establish general model reliability.

The card shows the working explanation and next observation. An expandable investigation contains public evidence, not private model reasoning or JSON. Staff still need dispatch records, measured passage/speed data and corroborated incidents to establish a cause. The [LAMP reader](#saved-lamp-running-time-studies) can inspect an existing historical study; it does not confirm current delay causes.

### Refresh and saved evidence

The default is every 15 minutes while the network overview is open. Staff can choose 30 minutes, hourly, or manual. Preferences persist per City. Manual mode preserves the selected expiry interval; it stops automatic updates rather than declaring an old assessment current forever.

The server reuses a current assessment across tabs and coalesces concurrent generation requests. Manual refresh explicitly requests a new assessment. Server responses carry current preferences so a tab with older settings cannot keep refreshing an hourly or paused briefing every render.

Each card displays the assessment time, scheduled window and next refresh/expiry. Whole-minute headlines omit interval differences that would round to identical values; exact comparisons remain in the diagnosis. Expired cards, previous timetable revisions and loss of previously fresh prediction feeds do not retain a current-looking narrative. Saved originals remain readable and explicitly dated. A one-shot expiry timer and window-focus check handle idle tabs; there is no minute-by-minute model polling. Source conditions may change within a briefing interval: the displayed assessment time is the observation it describes, not a claim of continuous verification.

### Implementation and verification

`realtimeIntelligence.mjs` retains complete measurements server-side. `serviceWindow.mjs` caches timetable spans per read-only context. `serviceConcentrations.mjs`, `networkDiagnosis.mjs`, and `networkNarrative.mjs` separate spatial grouping, aggregation and communication. `briefingSchedule.mjs` owns refresh validation and expiry. `NetworkAssessment.tsx` renders both the live card and saved evidence.

Run `node test/check-network-diagnosis.mjs` or `npm run check:agency`. Fixtures cover complete and incomplete coverage, equal intervals, one vote per trip, cancellations, stale and duplicate records, arrival-only updates, spatial overlap and separation, direction, no mutation of the shared observation, repeated source observations, overnight service, DST, caching, expiry, persistence and zero LLM calls for the computed briefing. UI, type, documentation and production build checks accompany the change.

### Public references

[GTFS Trip Updates](https://gtfs.org/documentation/realtime/feed-entities/trip-updates/) explicitly distinguishes absent realtime information from on-time service and specifies trip-instance and stop-update semantics. The implementation preserves that distinction.

[TransitMatters Data Dashboard 3.0](https://transitmatters.org/blog/datadashboard3) illustrates the value of service-level measurements and bus performance analysis. VIGO's current prediction-window assessment is not equivalent to its historical performance dataset; no parity or superiority claim is made.

## One bus, one control point

VIGO Studio's replay API demonstrates a decision from source evidence to a withdrawn rider message. Run `npm run evaluate:replay` to exercise the backend sequence. There is no Replay panel in Studio. This uses a synthetic City X, separate storage, a fixed timetable and a controllable clock. It does not connect to dispatch or publish to riders.

The implementation reuses the operations ledger, finding transitions, knowledge approvals, message revisions and outbox. New modules supply replayable inputs, applicable procedure selection, holding comparisons and a sandbox transport. VIGO's routing engine and live network assessment are unchanged.

### Replay sequence in the evaluation harness

1. Load the uneven-spacing scenario. Successive departures are predicted 3 and 17 minutes apart, against a 10-minute timetable. The selected bus is reported stopped at River control point.
2. Inspect the selected applicable procedure. The synthetic SOP limits holding to 180 seconds, requires a clear berth and completed boarding, protects the following headway and caps downstream delay. An expired section and another stop's procedure are excluded.
3. Compare no intervention, a target-headway baseline and the passenger-time optimizer. Prepare an option and review its rider message.
4. Approve the exact option and message. Send to the sandbox: the first attempt deliberately simulates a temporary transport failure. Retry records one receipt; repeated delivery requests cannot duplicate it.
5. Advance to the next observation. The bus is now reported in transit. The approved hold is no longer feasible, and its delivered sandbox message is withdrawn. Advancing the clock past expiry exercises a separate stale-clock case.

The replay clock pauses between actions. The 90-second decision lifetime uses that clock, not the operator's wall-clock reading time. Restart restores the active run and audit. New runs preserve previous records in the replay ledger; export a run before switching to retain its complete portable review package.

| Synthetic case | No hold: modeled passenger-minutes | Baseline | Optimizer | Decision |
| --- | ---: | --- | --- | --- |
| Even service | 400 | 0 seconds | 0 seconds | No extra hold |
| Uneven spacing | 596 | 180 s → 584 passenger-minutes | 120 s → 580 passenger-minutes | Compare a shorter hold |
| Stale observations | Unknown | Unavailable | Unavailable | Obtain current evidence |
| Conflicting procedures | Not evaluated | Unavailable | Unavailable | Escalate |
| High onboard load | 500 | 180 s → 716 passenger-minutes | 0 s → 500 passenger-minutes | No extra hold |

The high-load example illustrates the trade-off: restoring headways can worsen the modeled passenger outcome. These are simulated outcomes over a small downstream horizon, not measured passenger benefits or whole-route forecasts.

### Data and procedure selection

The [complete input package](../src/agency/replay/holding-v1/manifest.json) contains five cases: three development scenarios and two held-out variants. Expected actions are developer-authored, not expert agency labels, and are excluded from model prompts.

- `timetable.json` contains the exact miniature GTFS tables: agency, route, stops, trips, stop times, dated calendar exceptions and feed version `SYN-HOLD-1`.
- Each case preserves **authored synthetic** VehiclePosition and TripUpdate observations using a GTFS-Realtime JSON field mapping, including source/entity timestamps. These are not captured agency feeds or records reconstructed from the derived headways.
- `procedures.json` preserves source passages, revisions, sections, effective periods, asset scope, prerequisites and authority. Its approval identities are synthetic.
- The manifest fixes clocks, passenger inputs, filenames, expected actions and known unknowns. Raw source contents and versions determine equality; paths, modification times and digests do not identify the evidence. This establishes equality, not authenticity or tamper resistance.

This narrow replay adapter requires its explicit UTC timetable and date exceptions. Duplicate trip/stop matches, inconsistent service dates/directions, skipped stops and missing departures are rejected. It does not replace VIGO's production GTFS importer. A second agency needs real inputs, approved control points and an actual reviewer; changing a label would not establish transferability.

Replay records live in the City's `agency/replay/operations.sqlite`, separate from live operations. Export includes the package, candidate, message, receipt and revisions.

Knowledge records optionally carry structured `procedure` metadata. `knowledge-select` accepts exact route/stop IDs, query text and confirmed prerequisite identifiers; the server supplies the current clock. Selection removes unapproved, future, expired, out-of-scope, superseded and prerequisite-incomplete sections **before** SQLite FTS5/BM25 ranking. Conflicting limits or authority remain a conflict regardless of text rank. Results include the supporting passage and applicability explanation.

`knowledge-save` accepts and preserves structured metadata with revision/section information. Replay imports its versioned example directly. PDF ingestion, semantic retrieval and an expert-labelled retrieval study are not implemented. A lexical miss returns no matching section rather than substituting an unrelated procedure.

### Method and assumptions

At each modeled downstream stop, `a` and `b` are predicted headways ahead and behind the selected bus, `λ` is the assumed passenger arrival rate, `L` is the supplied onboard load and `h` is additional holding in seconds:

```text
J(h) = Σ λ/2 × [(a + h)² + (b − h)²] + Lh
h*   = [Σ λ(b − a) − L] / [2Σ λ]
```

The code evaluates the neighboring integer seconds and feasible endpoints of this convex objective. The interval intersects maximum holding, minimum following headway and maximum downstream delay constraints. Already-breached constraints, missing loads, stale sources or unconfirmed control-point presence return an unavailable result. Computation checks cancellation and a 250 ms deadline, with at most 50 downstream stops; no optimization server is needed.

The baseline is `max(0, scheduled headway − current forward headway)`, clipped to the same constraints. It is a declared toy comparator, not an agency-agreed practice or an implementation of a named research model.

Assumptions: stationary uniform passenger arrivals; fixed running times; no overtaking; unlimited boarding capacity; constant supplied onboard load; no additional boarding during the control-point hold. The objective counts waiting over two headways at listed stops plus onboard holding. Capacity-denied boarding, dwell changes, transfers and network propagation are absent. No observed cause, recovery time, restricted-route alternative or accessible journey is established.

The distinction between headway regularity, schedule adherence and onboard delay is informed by [Xuan, Argote and Daganzo (2011)](https://www.ocf.berkeley.edu/~xuanyg/doc/Xuan_Argote_Daganzo_2011_TR-B.pdf). [Analytic holding with capacity limits](https://ris.utwente.nl/ws/portalfiles/portal/236315329/1_s2.0_S0968090X20307208_main.pdf) illustrates a material omission from this toy model. Neither paper's controller is claimed as integrated code. Vehicle-presence and departure fields follow the [GTFS-Realtime reference](https://gtfs.org/documentation/realtime/reference/).

### AI and privacy

Optional review uses two model calls: choose an evidence check, then select an existing candidate or escalate. The server always supplies both the applicable procedure and computed alternatives. It does not spend a call choosing the only remaining mandatory check. Candidate IDs and evidence references are validated; the model cannot add durations, causes, recovery, approval or delivery. Ask's `compare_holding` tool exposes the same comparison for an already-open synthetic case.

Actual staff context now defaults to **internal**. Internal SOPs, tracked finding notes and notebook annotations are excluded from model retrieval. Legacy answers that consulted internal-context tools without the current data policy are conservatively excluded from subsequent model history/retrieval. New answers produced under the public-context policy remain available. A document must be explicitly marked public, approved and unexpired before its excerpt may reach the model. Legacy approval alone does not authorize disclosure.

The replay model receives only public synthetic data and has no web or publishing tools. User questions and permitted context still go to the configured inference endpoint. Localhost is not proof of local inference, forwarding policy, retention or security. This is a data-selection boundary, not security certification or erasure of material already transmitted by older versions.

### Evaluation and reproduction

```sh
npm run evaluate:replay
node test/check-operational-replay.mjs
# With an explicitly configured VIGO_AGENCY_LLM_* connection:
npm run evaluate:replay -- --ai
```

Each evaluation writes results under `output/replay/evaluations/`. These generated reports are local outputs. The cases use synthetic inputs and developer-authored expectations; they do not establish staff decisions or observed service impact.

Tests cover procedure scope, expiry, conflicts, optimizer calculations, denied approvals, outdated revisions, atomic rollback, cancellation, duplicate delivery, withdrawal and restart.

## GTFS support matrix

This matrix is the public semantic boundary for VIGO routing. “Imported” alone is
not support: the routing column states whether a field changes path feasibility.
New raw imports record a feature inventory. Fixed-stop pickup and drop-off
permissions are compiled per connection: illegal board points are absent from
the departure index, illegal alight points cannot create a reachable state, and
a passenger already aboard may remain on the trip through either kind of
restricted stop. Unsupported transfer semantics are omitted from the generic
stop-pair transfer graph. The remaining network is routed as a
`supported_scheduled_core`, with any exclusions attached to every result. This
is qualified coverage, not an exact claim over the whole feed. Among otherwise
importable GTFS semantics, only multiple agency timezones currently block the
whole store.

| GTFS feature or case | Import | Routing behavior | Classification |
|---|---|---|---|
| `calendar.txt` only | Yes | Weekly service within start/end dates. | Supported. |
| `calendar_dates.txt` only | Yes | Type 1 adds and type 2 removes service on the exact date. | Supported. |
| Calendar plus exceptions | Yes | Exceptions override the weekly calendar for the date. | Supported. |
| Missing both calendar tables | Rejected | No service date can be established. | Rejected malformed input. |
| Times greater than 24 hours | Yes | Preserved as seconds on the originating service day. | Supported within the query horizon. |
| Trips crossing midnight | Yes | Connections remain ordered on the originating service-day coordinate. The caller must query that date with a value above 24 hours; VIGO does not automatically merge yesterday's active trips into a `01:00` civil-date query. | Supported only under explicit service-day coordinates and within the horizon. |
| Trips extending across more than one midnight | Parsed | Same coordinate model; default horizon may exclude them and the public CLI clock is bounded. | Bounded; caller must set a sufficient horizon and service-day coordinate. |
| Invalid minute or second fields | Rejected | Values such as `08:60:00` or `08:00:60` do not normalize silently. | Rejected malformed input. |
| Agency timezone, one timezone | Inventoried | Caller supplies local service date and clock; no zoned-instant conversion. | Partial; DST instant semantics unsupported. |
| Multiple agency timezones in one store | Inventoried | Exact routing is blocked. | Unsupported and visible. |
| `frequencies.txt`, `exact_times=1` | Yes, bounded | The template trip is expanded into deterministic fixed departures for each declared frequency window. Generated instances retain route, service, permissions, and shape identity. | Supported for bounded deterministic windows. |
| `frequencies.txt`, `exact_times=0` | Retained for inspection | No stochastic or deterministic headway waiting model is inferred. The template trip is omitted from compiled connections. | Excluded from the supported scheduled core; visible limitation. |
| Overlapping frequency windows | Yes, bounded | Deterministic windows expand independently and duplicate generated departures collapse by trip/departure identity; inexact headway templates remain excluded. | Supported for bounded `exact_times=1`; visible limitation only for `exact_times=0`. |
| Shapes present | Yes | Ordered trip stops are matched to a monotone shape slice. | Supported for rendering; feasibility never depends on shape. |
| Shapes missing or unusable | Yes | Timetable route remains valid. Ordinary network lenses show no inferred route alignment; selected-itinerary and Shape/Risk QA views may show a dashed, explicitly inferred stop sequence. | Timetable supported; published ride geometry unavailable. |
| Duplicate stop names | Yes | Identity is `stop_id`, not name. | Supported. |
| Parent stations and platforms | Yes | Explicit parent transfer rules expand to child service platforms; selected stations expand to service members. Without an explicit rule, service members share a modeled 120-second connection, reported as `parent_station_fallback` with schematic geometry. | Supported for `location_type` 0/1; fallback time is not a measured station pathway. |
| Deeper `location_type` hierarchy | Parsed as stops | No complete entrance/boarding-area hierarchy model. | Partial. |
| `pathways.txt` direction and traversal time | Yes | Creates directed transfer edges; explicit traversal times take precedence. Stairs with a stair count and fare/exit gates receive labeled estimated costs when time is omitted. Bidirectional rows create the reverse edge. The full hierarchy is not preserved. | Partial. |
| Pathway wheelchair/slope/width attributes | Profile dependent | Applied during `build --wheelchair`; ordinary Cities inventory them without filtering. | See [wheelchair preparation and limits](guides/rust-standalone.md#wheelchair-routing). |
| Transfer type 0 | Yes | Directed recommended transfer using declared/default duration. | Supported within transfer model. |
| Transfer type 1 timed transfer | Inventoried | The guarantee is not represented; the row is omitted from the generic stop-pair transfer graph. Other supported scheduled service remains routable. | Excluded from the supported scheduled core; visible limitation. |
| Transfer type 2 minimum time | Yes | Declared minimum traversal time is enforced. | Supported. |
| Transfer type 3 forbidden | Yes | Directed pair, including expanded parent/platform pairs, is forbidden and cannot be regenerated by proximity. A same-stop prohibition blocks reboarding after a ride while preserving an origin's initial boarding. | Supported with permanent SQLite, compact-kernel, and matrix regressions. |
| Transfer type 4/5 in-seat semantics | Inventoried | Linked-trip continuation is not represented; the row is omitted from the generic stop-pair transfer graph. | Excluded from the supported scheduled core; visible limitation. |
| Route- or trip-scoped transfer selectors | Inventoried | The stop-pair schema cannot preserve the selector, so the entire scoped row is omitted rather than generalized to every trip. | Excluded from the supported scheduled core; visible limitation. |
| Nearby stops without explicit transfer | Prepared | One native multi-target street search creates every directed OSM-reachable alight-to-board edge within 500 m. Each edge stores its routed distance; unproved radial pairs remain visible counts. | Supported within the City street model. |
| `pickup_type=1` / `drop_off_type=1` | Yes | The complete scheduled trip is retained. Boarding is prohibited only at a stop with `pickup_type=1`; alighting is prohibited only at a stop with `drop_off_type=1`; through-riding remains legal. | Supported for fixed-stop routing. |
| `pickup_type` / `drop_off_type` values 2/3 | Inventoried | The complete scheduled trip is retained, but rider-agency coordination is not a request capability, so the affected board or alight event is conservatively unavailable. | Fixed-stop core retained with visible `on_demand_boarding_or_alighting` limitation. |
| Continuous pickup/drop-off | Inventoried | Scheduled fixed-stop service remains routable. Continuous boarding or alighting between scheduled stops is not represented. | Fixed-stop core retained with visible limitation. |
| Loop routes | Yes | Sequence, not stop identity, orders a trip; reconstruction can retain repeated locations. | Supported, with adversarial regression coverage required. |
| Repeated stop in one trip | Yes | Distinct `stop_sequence` events remain distinct. | Supported. |
| `block_id` interlining | Inventoried | Each trip remains routable as ordinary scheduled service, but VIGO does not infer an in-seat continuation between trips sharing a block. | Included scheduled trips with a visible interlining limitation. |
| Duplicate stop, route, trip, or calendar IDs | Rejected | A primary-key conflict aborts the temporary build; no partial store is published. | Rejected malformed input with adversarial atomicity coverage. |
| Missing shape ID referenced by a trip | Yes | Timetable routing remains available, but published alignment is unavailable; any selected/QA stop-sequence line is dashed and marked inferred. | Timetable supported; published ride geometry unavailable. |
| Untimed interior stop-time gaps | Yes | Timed endpoints remain connected and the itinerary reports `interpolated-stop-time-gap`; no exact timestamp is claimed for omitted interior events. | Supported with degraded timing precision. |
| Malformed required table | Rejected | Build does not commit the temporary store. | Supported rejection. |
| Broken core references | Rejected | Unknown trip routes/services, parent stations, transfer endpoints, frequency trips, and stop-time trip/stop references abort the temporary build. Missing shapes remain a supported timetable-only case as declared above. | Rejected malformed input with adversarial atomicity coverage. |

### Semantic coverage written to store metadata

For otherwise importable GTFS, `blockingRoutingFeatures` currently has one
stable code:

- `multiple_agency_timezones`;

The following nonblocking `routingLimitations` codes put results in
`supported_scheduled_core` mode:

- `frequency_based_service` for `exact_times=0` headway windows;
- `on_demand_boarding_or_alighting`;
- `continuous_pickup_or_drop_off`;
- `scoped_transfer_rules`;
- `timed_transfer_guarantee`;
- `in_seat_transfer_rules`;
- `block_interlining`.

The additional nonblocking code `pathway_accessibility` describes constraints
not represented by the retained graph; it does not by itself change the
coverage mode. “Nonblocking” does not mean full-feed support. It means VIGO can
make a narrower, explicit claim over the compiled scheduled core instead of
disabling unrelated service.

A ready result in `supported_scheduled_core` mode is optimal only over that
compiled core. A `no_path` result in the same mode means no path exists in the
core; an excluded trip or transfer rule could still change full-feed
reachability.

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
