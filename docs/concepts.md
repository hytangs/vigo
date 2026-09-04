# Core concepts

A new VIGO user needs four nouns and three Query names.

```text
City -> Scenario -> Route | Matrix | Reach -> Result
```

## City

A City is a compiled mobility model built from GTFS and OSM. It is stored as one complete directory so its timetable, streets, and query data cannot drift apart.

A named City may have several immutable revisions. Rebuilding source data creates a new revision. Existing Scenarios and Results remain tied to the revision that produced them.

Revision identity and build time are separate: `revisionId` identifies the immutable build, while `builtAt` records when it was created. `sources` records the GTFS and OSM inputs.

## Scenario

A Scenario is an immutable set of changes applied to one City revision.

It may change planned transit service, add one live transit state, or add one supplied traffic state. Walking limits, departure times, and time cutoffs remain Query options. A complete alternative GTFS source creates a new City revision.

VIGO rejects unsupported combinations before computation. It does not silently drop changes or move a Scenario to a newer City revision.

## Query

### Route

Find and explain travel between ordered points. Mode, depart-at, arrive-by, departure windows, waypoints, and batching are Route options.

VIGO 0.3.0 exposes one objective: earliest arrival. Ties prefer fewer boardings, then less walking, then a stable final order.

### Matrix

Compute scalar travel time between origin and destination sets. A single origin is simply a Matrix with one origin.

### Reach

Compute where the represented network can travel within stated time limits. A Reach Result can be shown as contours or reached streets.

Reach is not Accessibility. Accessibility requires an additional opportunity measure such as jobs, people, schools, or healthcare.

## Result

A Result is the immutable answer to one Query. It contains status, values, warnings, timing, the City revision, the Scenario if any, and export methods.

Compare is an action on compatible Results. It is not a fourth Query.

## Outcomes

- A Result is `ready` or `blocked`.
- A malformed Query raises `InvalidQuery`.
- A valid Query that the selected context cannot execute raises `UnsupportedQuery`.
- Background work reports `queued`, `running`, `ready`, `cancelled`, or `error`.
- Execution failure raises an error; it is not an analysis Result.

Use `vigo capabilities`, `city.supports(query)`, or `scenario.supports(query)` to inspect support before execution.

## Time

VIGO keeps Build, Open, Compute, and End-to-end durations separate. Reusing an open process is useful runtime behavior, but it does not replace or hide Query computation.
