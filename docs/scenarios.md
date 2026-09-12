# Scenario semantics

A Scenario is an immutable set of changes tied to exactly one City revision.

A Scenario may contain planned transit service changes, one live transit state, or one supplied traffic state. Walking limits, speeds, departure times, and cutoffs are Query options.

Scenarios do not edit imported GTFS or OSM. A complete alternative feed creates another City revision. Drawing geometry in an editor does not create a computational change until it is attached to a valid service edit.

Multiple nonconflicting planned changes may coexist. Conflicts require an explicit resolution. A Scenario never moves automatically to another City revision, and expired live state cannot be queried.

VIGO 0.3 supports planned service changes in Reach, supplied traffic in Drive Route and Drive Matrix, and live transit routing in Studio. Inspect supported combinations with `vigo capabilities`. Unsupported CLI requests exit nonzero with an explanation.

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

For an edited GTFS line, road geometry distributes the original A → B runtime among the edited gaps. `addedStopDwellMinutes` adds dwell at inserted stops in each direction. New lines use `segmentDistancesKm` and `averageSpeedKph` for road timing, plus `dwellMinutes`. Segment distance and runtime arrays must contain one value per stop pair. Studio requires a completed road path before running a road-following Scenario.
