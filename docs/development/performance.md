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
- Route `searchStats.queryMs` includes the engine route function, street access, and selected-journey work. It excludes caller transport and final Result serialization.
- `engineQueryMs` measures native timetable work. For arrive-by, this includes reverse feasibility and forward selection; `arriveByNativeQueryMs` and `forwardEngineQueryMs` identify those components. Street access and geometry are outside that timetable total.
- Matrix parent timing covers shared query work. Optional journey timings describe witness rendering, not independent searches or a share of batch time.

Use an external elapsed timer for complete Build and query latency. A small native search time does not establish the same user-perceived response time.

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
