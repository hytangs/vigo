# Scenario semantics

A Scenario is an immutable set of changes tied to exactly one City revision.

A Scenario may contain planned transit service changes, one live transit state, or one supplied traffic state. Walking limits, speeds, departure times, and cutoffs are Query options.

Scenarios do not edit imported GTFS or OSM. A complete alternative feed creates another City revision. Drawing geometry in an editor does not create a computational change until it is attached to a valid service edit.

Multiple nonconflicting planned changes may coexist. Conflicts require an explicit resolution. A Scenario never moves automatically to another City revision, and expired live state cannot be queried.

VIGO 0.4.2 supports planned service changes in Reach, supplied traffic in Drive Route and Drive Matrix, and realtime Route from supported Trip Updates. CLI Route accepts a top-level `realtimeSnapshot` with `--data-mode realtime`; this is separate from the planned-service `scenario` object. Transit Matrix and Reach remain scheduled. Drive traffic requires a top-level `traffic` object and explicit realtime mode; Matrix selects that mode with `routingDataMode: "realtime"` in JSON. See the [support table](../guides/concepts.md#choose-a-supported-combination) and [realtime limits](known-routing-limitations.md#realtime). Inspect supported combinations with `vigo capabilities`. Unsupported CLI requests exit nonzero with an explanation.

## Planned service

A planned service change states what changes and supplies enough information to run it: ordered stops, operating span, frequency, and travel-time assumptions. It never contains a precomputed network surface.

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

`replace` requires `sourceRouteId` and removes that scheduled route before applying the new service. Supply `sourcePatternId` and `routeScope: "pattern"` to replace just one branch. Studio and the CLI resolve these references through the same code.

In Studio, **Selected branch only** keeps the change on the chosen pattern. **All branches serving this exact A → B edge** applies one inserted gap to every occurrence of that ordered stop pair within the same feed and public route. It does not include the reverse B → A edge. The editor shows the affected branches and occurrences before running. This scope requires complete branch analysis and one inserted gap; use selected-branch scope for moved stops, extensions, or edits to multiple gaps. Repeated stop visits retain their own position in the sequence and their published runtimes. Overlapping replacement services are rejected.

Editing an existing GTFS branch follows its published direction by default. Creating reverse service is an explicit scenario choice; it is not inferred from a shared route name.

For an edited GTFS line, road geometry distributes the original A → B runtime among the edited gaps. `addedStopDwellMinutes` adds dwell at inserted stops in each direction. New lines use `segmentDistancesKm` and `averageSpeedKph` for road timing, plus `dwellMinutes`. Segment distance and runtime arrays must contain one value per stop pair. Studio requires a completed road path before running a road-following Scenario.

## Compare the change

Run a baseline Reach and a Scenario Reach against the same City, origin, date/time, walking policy, cutoffs, and grid. Save both Results before using `vigo compare`. The [workflow guide](../guides/workflows.md#test-a-planned-service-change) provides complete paired requests.

Compare reports after-minus-before time changes for cells reachable in both surfaces, and counts newly reachable and no-longer-reachable cells separately. It checks grid compatibility, but does not verify every experiment setting. Read [Compare semantics](results.md#compare-saved-results) before interpreting a mean change as the effect of the Scenario.
