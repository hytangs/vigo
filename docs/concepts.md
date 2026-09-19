# Core concepts

A new VIGO user needs four nouns and three Query names.

```text
City -> optional Scenario -> Route | Matrix | Reach -> Result
```

## City

A City is a compiled mobility model built from GTFS and OSM. It is stored as one complete directory so its timetable, streets, and query data cannot drift apart.

A named City may have several immutable revisions. Rebuilding source data creates a new revision. Existing Scenarios and Results remain tied to the revision that produced them.

Revision identity and build time are separate: `revisionId` identifies the immutable build, while `builtAt` records when it was created. `sources` records the GTFS and OSM inputs.

A built City can be reopened without its raw GTFS or OSM files. Keep or copy the
whole directory, including its prepared files. Building prepares the street
indexes and station-access state. The first query for a new set of active
services prepares a timetable snapshot; subsequent processes can reload it.
Dates with the same active services share that snapshot. A new process still
loads the files into memory, while an open process keeps them ready.

Prepared files are tied to the source revision, routing policy, and format.
Missing, stale, or incompatible timetable/access caches are rebuilt from the compiled
City, without importing raw sources again. Required street files must remain complete;
restore or rebuild a City with missing/corrupt street indexes. Timetable snapshots use a bounded
disk cache, so an evicted service pattern must be prepared again. Updating the
underlying GTFS or OSM data requires a new City build.

## Scenario

A Scenario is an immutable set of changes applied to one City revision.

In 0.4.0, planned changes apply to Reach. Supplied traffic applies to Drive Route and Matrix, while a supplied realtime snapshot applies to transit Route. The CLI carries these as `scenario`, `traffic`, and `realtimeSnapshot` respectively; see [Scenario support](scenarios.md). Walking limits, departure times, and time cutoffs remain Query options. A complete alternative GTFS source creates a new City revision.

VIGO rejects unsupported combinations before computation. It does not silently drop changes or move a Scenario to a newer City revision.

## Query

### Route

Find and explain travel between ordered points. Mode, depart-at, arrive-by, departure windows, waypoints, and batching are Route options.

Depart-at minimizes arrival time, then boardings, then walking. Arrive-by maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, walking, and actual arrival.

### Matrix

Compute scalar travel time between origin and destination sets. A single origin is simply a Matrix with one origin.

### Reach

Compute where the represented network can travel within stated time limits. A Reach Result can be shown as contours or reached streets.

Reach is not Accessibility. Accessibility requires an additional opportunity measure such as jobs, people, schools, or healthcare.

## Result

A Result is the immutable answer to one Query. It contains status, values, warnings, timing, the City revision, the Scenario if any, and query output.

Compare is an action on compatible Results. It is not a fourth Query.

## Outcomes

- A Result is `ready` or `blocked`.
- Malformed or unsupported CLI requests exit nonzero with an explanation on standard error.
- Background work reports `queued`, `running`, `ready`, `cancelled`, or `error`.
- Execution failure raises an error; it is not an analysis Result.

Use `vigo capabilities` to inspect support before execution.

## Time

VIGO keeps Build, Open, Compute, and End-to-end durations separate. Reusing an open process is useful runtime behavior, but it does not replace or hide Query computation.
