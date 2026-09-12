# Performance

Measure the operation the caller actually waits for. "City loading" alone does
not identify a timing boundary.

| Operation | Start | End |
| --- | --- | --- |
| Build from raw files | Invoke `vigo build` with local GTFS ZIPs, an OSM PBF, and no existing output City | The command returns successfully after publishing the complete City directory |
| Raw files to first answer | The same Build invocation | The first Query returns a complete Result for a specified service date and request |
| Reopen a prepared City | Start a new runtime process for an existing complete City | Its first Query returns a complete Result |
| Resident Query | Submit a request to an already open City | The complete Result returns to the caller |

Downloading inputs and installing the runtime are separate operations. State
whether runtime discovery, caller-process startup, Result export, and operating
system file-cache effects are included. A fresh process does not imply an empty
operating-system file cache. Reading a saved Result is not a new computation.

Build includes GTFS import, OSM graph construction, required street indexes,
stop transfers, station-access preparation, and saving the complete City. The
first Query can additionally prepare the timetable for its active services and
align the ride geometry it selects. That work belongs in raw-files-to-first-answer
time even though the City has already been published.

The durations in `network.json.timing` describe compiler stages. In 0.3.2,
`totalMs` starts inside the compiler after input and staging checks and ends
before writing `network.json`. It excludes caller/runtime startup, compiler
shutdown, City publication, and the first Query. Use an external elapsed timer
for the complete Build operation. GTFS and OSM stages can overlap; do not add
their durations to estimate wall time. In the parallel path, `osmBuildMs` runs
from OSM worker launch until the parent collects its result after GTFS import,
so it can include waiting and is not an isolated OSM processing duration.

Performance comparisons must keep source data, City revision, Query semantics, status counts, and measurement boundary fixed.
For Build comparisons, keep raw inputs and compiler options fixed and compare
the compiled content; new build timestamps and revision IDs are expected.

City compilation imports multiple GTFS feeds into one staged database, with
the same scoped identifiers as separately imported and merged feeds. It builds
the combined indexes once and prepares the final topology after adding OSM
transfers. Standalone GTFS imports still prepare their own topology. The City
is published only after its required routing artifacts are ready.
Topology preparation calculates minimum stop-pair durations and consecutive
connection gaps inside SQLite, returning the reduced edges to JavaScript.
It retains the same gap, route, service, and time-order conditions.

The street importer first identifies every node referenced by a supported
walking or driving way, then stores only those coordinates in its temporary
lookup. Both passes must read identical PBF bytes. The second pass retains
source validation and the complete source-node count; the resulting street
graph uses the same access, direction, and distance rules.

GTFS parsing uses an unquoted-record fast path and the runtime's incremental
CRC32 implementation. Quoted and multiline records use the existing parser,
and every table still receives the same size, row, encoding, and checksum
checks. City-build equivalence and import-safety tests cover these paths.

Opening a City prepares its timetable and street access without running
calibration journeys. Ride geometry is aligned only for selected trips, against
each trip's complete ordered stop sequence so partial rides and loops retain
their shape alignment. Alignments belong to the active service kernel; retained
shape coordinates remain subject to the existing byte budget.

City builds also save the expanded stop-transfer index and directed station
paths in `routing/project.sqlite.access-context.bin`. Reopening restores this
state instead of expanding station transfers and finding their paths again.
Only station paths selected for a journey become coordinate objects. The
prepared context uses the City source identity and walking policy, is replaced
atomically, and has a 512 MiB size limit. If it cannot be saved, the prepared
state remains usable for the current process.

Timetable snapshots store JSON metadata and typed arrays in a portable binary
format shared by Node and the packaged runtime. They do not depend on a V8
serialization version. Loading retains array bounds, source identity, and
native graph validation. Older derived formats are prepared once from the
compiled City. Open diagnostics distinguish `loaded` from `written`; a loaded
timetable reports `compileMs: 0`.

For transit Route, `searchStats.queryMs` covers the engine's route function,
including its access and selected-journey work. It excludes caller transport
and final Result serialization. `engineQueryMs` measures the native timetable
search; a sub-millisecond value here does not establish a sub-millisecond
complete Route call. Use an external caller timer for the latter. On arrive-by
queries, `engineQueryMs` includes reverse feasibility and forward selection;
`arriveByNativeQueryMs` and `forwardEngineQueryMs` expose those components.
Street access and geometry are outside the timetable total. Cache reads and
result serialization still contribute to caller wall time.

Keep service date, origin/destination coordinates, walking budget, vehicle-ride
requirement, output detail, and access/path-cache settings fixed when comparing
versions. Allowing a walk-only answer changes the workload. Report ready,
blocked, and error counts separately; do not interpret a faster blocked answer
or a different journey as an equivalent successful query.

Transfer-capped single-origin reverse queries stop when the remaining event
times cannot improve their best departure. Driving queries compare CCH
candidate costs together before unpacking primary-optimal paths, retaining
secondary ties and the distance-constrained fallback. These optimizations do
not change the transfer or distance limits.


Larger walking matrices build a temporary destination-distance index for reuse
across rows. Its setup belongs in each matrix timing. This trades temporary
memory for less repeated graph traversal. In-memory driving kernels retain their
path-search buffers across queries.
