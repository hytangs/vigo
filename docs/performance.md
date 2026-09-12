# Performance

VIGO reports performance with four separate durations.

- Build: GTFS and OSM become a City.
- Open: a City revision becomes ready for queries.
- Compute: Route, Matrix, or Reach runs.
- End to end: caller submission through complete Result.

A first Query may include Open work. Repeated Queries may reuse an already open process. Report both states when they matter. Do not mix Build with Query time, and do not describe a reused saved Result as computation.

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

For Route, `searchStats.queryMs` covers the complete call. On arrive-by
queries, `engineQueryMs` includes reverse feasibility and forward selection;
`arriveByNativeQueryMs` and `forwardEngineQueryMs` expose those components.
Street access and geometry are outside the timetable total. Cache reads and
result serialization still contribute to caller wall time.

Transfer-capped single-origin reverse queries stop when the remaining event
times cannot improve their best departure. Driving queries compare CCH
candidate costs together before unpacking primary-optimal paths, retaining
secondary ties and the distance-constrained fallback. These optimizations do
not change the transfer or distance limits.


Larger walking matrices build a temporary destination-distance index for reuse
across rows. Its setup belongs in each matrix timing. This trades temporary
memory for less repeated graph traversal. In-memory driving kernels retain their
path-search buffers across queries.
