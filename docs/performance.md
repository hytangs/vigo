# Performance

VIGO reports performance with four separate durations.

- Build: GTFS and OSM become a City.
- Open: a City revision becomes ready for queries.
- Compute: Route, Matrix, or Reach runs.
- End to end: caller submission through complete Result.

A first Query may include Open work. Repeated Queries may reuse an already open process. Report both states when they matter. Do not mix Build with Query time, and do not describe a reused saved Result as computation.

Performance comparisons must keep source data, City revision, Query semantics, status counts, and measurement boundary fixed.

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
