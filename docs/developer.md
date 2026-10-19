# VIGO 0.5.2 developer guide

Canonical source for the developer chapters of the [VIGO guide](guide.html). Edit the relevant chapter, then run `npm run docs:build`.

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

Markdown is the source for the single offline guide, `docs/guide.html`. `docs/navigation.json` lists its pages: each one renders a Markdown file, a section of one, or several sections composed in order, and `aliases` keep links to retired anchors working. Run `npm run docs:build` after changing a page, then `npm run check:docs`. `npm run docs:standalone` regenerates the OpenAPI document and native field reference from the Rust structs. The same guide is embedded by the engine at `/`, bundled by Studio, and shipped in engine archives; it works offline and includes print styles. There is no separately maintained PDF manuscript.

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

### Rust-native compiler migration (1.0 development)

The `vigo-v1-dev` branch evolves toward a Rust-native mobility computation
engine with language-specific application layers. Rust should own computation
and canonical data semantics; TypeScript owns interaction, and Python owns
research integration. The migration follows RFC 0001 in verified stages,
preserving public query behavior and the permanent prepared-data contract.

The starting point already has native service-timetable reads, departure and
transfer indexes, selected-journey geometry, scenario routing, and binary
snapshot readers and writers. The remaining compiler work must be measured
rather than inferred from implementation language.

The timetable migration now has three native crate boundaries:

| Crate | Current responsibility |
| --- | --- |
| `vigo-route` | Timetable search, forward/reverse/Matrix/alternative queries, scenario and realtime views, transfer and station operators, reusable scratch and shared columns |
| `vigo-format` | Read service timetables, validate memory-mapped snapshots, and encode the permanent portable City layout |
| `vigo-prepare` | Transactional `stop_times → connections` compilation |

Both the executable and Node addon use these same implementations. The routing
crate has no Node dependency, filesystem access, environment lookups, thread
creation or untyped JSON. Its numeric buffers own a Rust vector or retain a
caller-supplied owner; the addon can retain a typed-array allocation without
copying it. Queries borrow slice views before entering hot loops, avoiding
per-element foreign-owner lookups. Writes to shared external buffers detach first. Node records and
conversions are generated at build time from the canonical Rust records, and
only the adapter translates typed errors into Node errors. The permanent
prepared layouts and public Result contracts are unchanged. Portable snapshot
encoding now calls the Rust writer by default: Rust validates the metadata,
assigns checked aligned offsets, compresses the header and copies exact numeric
payload bytes. The JavaScript reader stays in place during migration. Tests
compare decompressed headers and every payload byte with the retained published
writer, including subarray views, empty arrays and non-finite float payloads.
Compressed streams need not be byte-identical; the frozen 0.5 readers must still
open the resulting Cities. Missing native encoding support fails explicitly.

Run `npm run check:rust-workspace` for model/schema tests, algorithm tests,
strict Clippy and the routing dependency boundary. CI and release workflows
also replay `check:corpus`. Native interface checks include worker teardown
with retained timetable buffers. The root workspace and the remaining native
crate retain separate lockfiles during migration; packaging fingerprints and
container inputs cover both.

M1 is still in progress: street/access/drive kernels and transports remain in
the original crate, and the public model is not yet the executable's internal
request representation. Crate extraction does not complete the packed City,
full native build, or unified Studio server milestones.

The first compiler operator is `vigo_prepare::compile_gtfs_connections`. It streams admitted `stop_times` rows from SQLite, expands exact
frequency trips, and writes connections, permissions, trip details and shape
references using the published 0.5 schema. ZIP/CSV admission, source scoping,
calendars, accessibility policy, City publication, and application orchestration
remain in JavaScript. The Rust operator is available to the addon and native
library; the standalone executable does **not** yet build a City from raw data.

The Rust connection compiler is the only backend. The superseded JavaScript
implementation and its environment selector have been removed. Native errors
fail the build.
The coordinator closes its staging and routing SQLite handles before handing
ownership to Rust, then reopens the routing database for the remaining stages.
Rust writes in a transaction and rolls back on an operator error. These are
private, unpublished build files, never a runtime City's writable interface.
The operator emits start/completion progress rather than row-level callbacks.

The migration preserves current semantics, including the existing inclusive
exact-frequency endpoint, untimed-gap behavior, exclusions, and pickup/drop-off
permissions. A change to these semantics needs its own correctness review.
Neither a new language nor a passing differential test makes the reference
algorithm correct for every source feed.

Run `npm run check:compiler` for retained connection-table hashes from the removed
0.5.2 JavaScript compiler, 80 seeded feed cases, malformed-input rollback,
City build equivalence, the 100-case frozen routing corpus, and the permanent
0.5 reader/writer gate. `test/fixtures/gtfs-connections-052.json` records the
pre-removal source revision and expected normalized tables; it is an independent
regression baseline, not a second executable compiler. The original frozen City
archive and hashes remain unchanged. The published 0.5 runtime must read new
Cities. Public Result meanings, units and clocks remain unchanged; see the
[permanent format contract](reference/format-0.5.0.md).

Use `npm run profile:compiler -- --runs 3 --output output/compiler-profile.json`
after creating the output directory. The default fixture has 10,000 trips and
200,000 stop-time rows; `--gtfs /path/to/feed.zip` measures a supplied feed locally.
Each sample builds a new routing store in a fresh process. The report records
input, source-tree and native-library hashes, phase wall times, connection-stage
time, total build time, runner wall time, and process peak RSS. OS cache state and competing host workloads are uncontrolled;
phase intervals are not CPU profiles, and process RSS is not a stage-specific
peak. This covers GTFS import and static topology, not OSM preprocessing or
complete City preparation. Private inputs and measurements stay outside the
public repository.

The subsequent migration gates are:

| Stage | Scope and acceptance evidence |
| --- | --- |
| GTFS compiler | Port remaining admission and preparation stages with their tests; compare retained admitted rows, calendars, exclusions, geometry and routed results. Measure build time, memory and temporary storage on matched workloads. |
| OSM graph construction | Profile parsing, filtering, graph building and index preparation independently. Migrate the measured stage while preserving directed access, restrictions, station evidence and geometry. |
| Scenario representation | Move canonical validation and incremental compilation behind a shared Rust representation; preserve stable identities, immutable shared streets, isolation and schedule semantics. |
| City storage | Consolidate ownership of existing layouts and validation in Rust without requiring valid published 0.5 Cities to rebuild. New indexes remain optional to old readers and unnecessary to old Cities. |
| Command and binding interfaces | Add native build orchestration after the operators compose independently; make Rust authoritative for shared validation, then generate or wrap language interfaces while retaining the public request/result contract. |

Further migration requires semantic regression checks and bidirectional historical-format
compatibility. Synthetic checks do not establish a cross-city performance claim
or complete the 1.0 migration; resource measurements need matched workloads.

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

`public/main.mjs` owns windows, menus, dialogs, and the `vigo://studio` resource scheme. `public/preload.cjs` exposes a small desktop bridge to an isolated renderer without Node access. Engine runs in a utility process; packaged Studio has no TCP listener. Packaging copies the shared `public/` distribution once.

Network shares one route/station selection across its tabs, map, and line diagram. Known feed namespaces resolve against the City timetable; ambiguous bare IDs cannot select an agency. Station scope includes platforms, while a platform keeps its own events. Observation refreshes do not move the map.

| Surface | Owner |
| --- | --- |
| Trip times and patterns | `AgencyTripTimetable`, `NetworkTimetable` |
| Map and line | `VigoMap`, `AgencyRouteLine` |
| Station board and evidence | `StopArrivalBoard`, `AgencyEvidence` |
| Network overview and observation exports | `AgencyPanel`, `observationExport.mjs` |
| Route/vehicle timing | `src/agency/routeOperations.mjs` |

The Network service owns observation polling, timetable inspection, route/vehicle
views, station boards and observation exports. Research briefings, model
providers, rider drafts, notebooks, the operations ledger, holding replay and
LAMP study readers are removed. Their stored files are left untouched. Network
connection state now lives in `network.sqlite`; on first use it can read the old
notebook observation without modifying that database. Explicit disconnects
persist across restarts. Vehicle matching preserves service dates, including
previous-day overnight trips.

Studio Reach retains packed reached-edge data, lazily reuses decoded coordinates across cutoffs, and serializes large map-source replacement. Changing a displayed cutoff does not require rebuilding the street graph. Runtime fixtures check map updates and rapid cutoff changes.

### Storage and verification

The complete CLI City directory is portable; individual databases and native files
are implementation details. Studio library settings, drafts and feed connections
are separate application state. Retired research data stays on disk and is no
longer exposed through the Studio API.

Use the [contribution guide](../.github/CONTRIBUTING.md) to choose checks. Routing
fixtures verify feasibility and witnesses; desktop runtime fixtures verify
interaction. Network checks include connection persistence, source replacement,
access control, in-flight invalidation and preservation of legacy data. No fixture
or build proves field accuracy.

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

Node Reach retains up to 64 next-departure schedule diagnostics per opened source store and active service context. This lookup preserves raw SQLite times and the inclusive 24-hour horizon; changing the service context clears it, and replacing the source creates a new lookup. It is immutable schedule metadata and remains available with `disableCache: true`. Reach still recomputes the timetable frontier and pedestrian surface. Measure first or changed departure clocks separately from repeated clocks; `diagnostics.timetable.departureLookupMs` exposes this cost alongside `residentPrepareMs`, search and surface timing. A faster repeated diagnostic lookup does not establish a faster native search or City opening.

#### Native timetable preparation

Standalone profile/trace output includes `timing.timetableActivationMs`, the time spent activating the service timetable during that request. A source preparation also reports `timing.timetablePreparation` with `setupMs`, `sourceAndRealtimeMs`, `indexMs`, and `kernelMs`. Setup includes calendar resolution and retiring the preceding timetable; source includes SQLite loading and realtime application. These scopes belong to execution and exclude public formatting, serialization, transport, and initial City opening. A reused timetable has no new preparation record. Profile scopes can overlap total execution; do not add them to it.

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

The following admission limits and recovery behavior apply to VIGO 0.5.2.
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
real timers. Streaming checks use real local sockets. Network persistence and
access checks exercise the production service and real SQLite files.

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
draft persistence, and damaged-storage handling. Research model evaluations,
synthetic holding inputs and saved-study readers have been removed with their
retired runtime surfaces. User-owned research files remain untouched.

### Verification on this checkout

The dated 0.4.2 verification record is retained in the [release audit](history.md#architecture-audit-for-042).
Checks cover native routing comparisons, TypeScript, import/request security,
CLI/City portability, operational calculations, actual worker/Engine recovery,
real browser interactions and the macOS ARM64 package. They do not establish
other-platform behavior, live feed accuracy, or whole-process immunity to
memory exhaustion.

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
