# Measuring performance

Measure the operation the caller waits for. Keep source data, City revision, query semantics, output detail, and status counts fixed when comparing runs.

| Operation | Start | End |
| --- | --- | --- |
| Build from raw files | Invoke `vigo build` with local inputs and a new output City | The complete City is published and the command returns |
| Raw files to first answer | The same Build invocation | The first complete Query Result returns |
| Reopen a prepared City | Start a new runtime on a complete saved City | Its first Query Result returns |
| Resident query | Submit to an already open City | The complete Result returns to the caller |

Report downloads and runtime installation separately. State whether process startup, transport, export, and operating-system file-cache effects are included. A new process does not imply a cold filesystem cache; reading a saved Result is not a new computation.

## What the timers include

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

## Preparation and reuse

Build includes import, required street indexes, stop transfers, station access, and publication. The first query may also compile its active-service timetable and align selected ride geometry. Report this cache-miss preparation separately from resident query time.

Portable binary timetable snapshots and prepared station access can be reused after moving the complete City. Timetable diagnostics distinguish `loaded` from `written`; a loaded snapshot reports `compileMs: 0`. New service patterns, changed walking policies, evicted caches, or older derived formats can require preparation. Missing required street indexes are errors, not permission to use a different graph.

Queries are recomputed. `disableCache: true` on transit Route/Matrix disables access/path caches while retaining the prepared City. Larger walking matrices may build temporary destination indexes; that setup belongs in the measured request.

### Native timetable preparation

Since 0.4.1, Rust constructs per-stop departure order, deduplicates transfers, expands station fallback links, and packs transfer adjacency. JavaScript resolves source IDs and passes typed arrays to the native preparation operator. This runs on active-timetable cache misses; loading a compatible persisted snapshot bypasses it.

Measure input marshalling and native preparation together when comparing the migration with the previous implementation. Keep SQLite reads, native search-index construction, snapshot loading, and resident query time separate. Preserved transfer ordering and snapshot layout do not by themselves establish a speedup. Filesystem lifecycle, source admission, and Result presentation remain JavaScript responsibilities.

## Compare equivalent work

Record exact date/time, coordinates or stop IDs, walking speed and limits, boarding requirement, transfer cap, horizon, realtime snapshot, and output detail. Allowing a walk-only answer changes the workload. Separate ready, blocked, and error counts; a faster blocked result or a different journey is not an equivalent successful query.

For Build comparisons, hold raw inputs and compiler options fixed and compare compiled content; fresh revision IDs and build timestamps are expected. Performance checks complement [accuracy checks](routing-accuracy.md), not replace them.

### Cold service and street preparation

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

### Resident routing and realtime updates

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
