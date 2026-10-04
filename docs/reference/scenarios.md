# Scenario semantics

A Scenario is an immutable set of changes tied to exactly one City revision.

A Scenario may contain planned transit service changes, one live transit state, or one supplied traffic state. Walking limits, speeds, departure times, and cutoffs are Query options.

Scenarios do not edit imported GTFS or OSM. A complete alternative feed creates another City revision. Drawing geometry in an editor does not create a computational change until it is attached to a valid service edit.

Multiple nonconflicting planned changes may coexist. Conflicts require an explicit resolution. A Scenario never moves automatically to another City revision, and expired live state cannot be queried.

VIGO 0.4.2 supports planned service changes in Reach, supplied traffic in Drive Route and Drive Matrix, and realtime Route from supported Trip Updates. CLI Route accepts a top-level `realtimeSnapshot` with `--data-mode realtime`; this is separate from the planned-service `scenario` object. Transit Matrix and Reach remain scheduled. Drive traffic requires a top-level `traffic` object and explicit realtime mode; Matrix selects that mode with `routingDataMode: "realtime"` in JSON. See the [support table](../guides/concepts.md#choose-a-supported-combination) and [realtime limits](known-routing-limitations.md#realtime). Inspect supported combinations with `vigo capabilities`. Unsupported CLI requests exit nonzero with an explanation.

## Planned service

A planned service change states what changes and supplies enough information to run it: ordered stops and travel-time assumptions, plus a departure schedule. Existing branch edits retain their GTFS trips by default; new service specifies frequency and operating hours. A Scenario never contains a precomputed network surface.

A Reach request can include this `scenario` object:

```json
{
  "origin": [-77.05, 38.90],
  "scenario": {
    "id": "crosstown",
    "name": "Crosstown service",
    "services": [{
      "operation": "add",
      "name": "Crosstown",
      "stops": [
        {"label": "West", "coordinate": [-77.05, 38.90]},
        {"label": "East", "coordinate": [-77.03, 38.91]}
      ],
      "headwayMinutes": 10,
      "startMinutes": 300,
      "endMinutes": 1500,
      "averageSpeedKph": 22
    }],
    "excludedRouteIds": ["route-to-remove"]
  }
}
```

`operation` is `add`, `augment`, or `replace`. `excludedRouteIds` removes selected scheduled route variants for the Scenario. These changes remain tied to the City revision used to create the Scenario.

`replace` defaults to `scheduleMode: "preserve-trips"` and requires `sourceRouteId`, `sourcePatternId`, and selected-branch scope (`routeScope: "pattern"`, or omitted when a pattern is supplied). Studio and the CLI load the actual trips active on the query's service date, including calendar exceptions and departures after midnight. Each affected trip produces exactly one replacement; irregular gaps, per-trip running times, dwell, and pickup/drop-off restrictions are retained. Editing stops never adds departures or reverse service. Legacy replacement requests also use this default: old headway/hour fields are ignored unless frequency mode is explicitly selected.

To change the timetable deliberately, use `scheduleMode: "frequency"` with `headwayMinutes`, `startMinutes`, and `endMinutes`. Studio exposes this as **Departures → Set frequency and hours**. This mode can replace a whole route; `add` and `augment` use frequency mode by default. **Keep scheduled departures** requires a specific branch so one edited stop sequence cannot silently replace unrelated branches.

In Studio, **Selected branch only** keeps the change on the chosen pattern. **All branches serving this exact A → B edge** applies one inserted gap to every occurrence of that ordered stop pair within the same feed and public route. It does not include the reverse B → A edge. The editor shows the affected branches and occurrences before running. This scope requires complete branch analysis and one inserted gap; use selected-branch scope for moved stops, extensions, or edits to multiple gaps. Repeated stop visits retain their own position in the sequence and their published runtimes. Overlapping replacement services are rejected.

Editing an existing GTFS branch follows its published direction. Creating reverse service is available in frequency mode as an explicit scenario choice; it is not inferred from a shared route name.

For a branch retaining its trips, road geometry distributes each trip's original A → B running time among the edited gaps. Original dwell remains at retained stops; `addedStopDwellMinutes` (default 0.35) adds dwell at inserted stops. Removing an intermediate stop removes its dwell. The first retained GTFS stop anchors departure timing; a preceding extension departs earlier, while later stop edits shift downstream times. At least one original stop must remain, with `baselineStopId`/`baselineStopIndex` identifying moved stops and repeated visits. An extension requiring a departure before the service date is rejected. Straight-line estimates use the supplied speed for changed gaps; untouched gaps keep their trip-specific times. These are modeled timing changes, not a vehicle or crew scheduling feasibility check.

New lines use `segmentDistancesKm` and `averageSpeedKph` for road timing, plus `dwellMinutes`. Frequency-mode edits use the supplied segment runtime estimates. Segment distance and runtime arrays must contain one value per stop pair. Studio requires a completed road path before running a road-following Scenario.

## Compare the change

Run a baseline Reach and a Scenario Reach against the same City, origin, date/time, walking policy, cutoffs, and grid. Save both Results before using `vigo compare`. The [workflow guide](../guides/workflows.md#test-a-planned-service-change) provides complete paired requests.

Compare reports after-minus-before time changes for cells reachable in both surfaces, and counts newly reachable and no-longer-reachable cells separately. It checks grid compatibility, but does not verify every experiment setting. Read [Compare semantics](results.md#compare-saved-results) before interpreting a mean change as the effect of the Scenario.
