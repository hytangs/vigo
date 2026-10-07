# Reach

Reach computes travel time from one origin using scheduled transit and walking, or walking alone. Planned service scenarios use transit with street sampling. Drive, arrive-by, and realtime Reach are unavailable.

## Request

Supply an exact service date and departure time, an origin, walking limits, and time cutoffs. CLI coordinates use a point object:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 96
}
```

```sh
vigo reach --city=./city --request=reach.json --service-date=YYYY-MM-DD --time=08:00 --output=reach-result.json
```

Choose a date covered by the feed. Cutoffs accept 5–240 minutes; `extentRadiusKm` accepts 1–40 km; walking speed accepts 1–8 kph. Supported grid sizes are 48, 64, 96, 128, 192, 256, 384, 512, and 1024. See the [CLI reference](programmatic.md) for shared flags and the [Scenario guide](scenarios.md) for planned changes.

## Surface and display

The Result includes reached stops, a travel-time raster, and GeoJSON contours. The CLI extent defines the requested raster bounds; it is not a maximum trip distance. Travel-time cutoffs, walking budgets, and the supplied network govern reachability. Retain bounds and resolution when comparing raster results.

The CLI also returns `surface.fullValues` and `surface.fullBounds` with `fullContours` for the complete reached-network envelope when available. Both raster arrays use JSON `null` for unreached cells. The original `surface.values`, `surface.bounds`, and `contours` retain the requested grid for comparison. `areas` and `fullAreas` are GeoJSON Polygon/MultiPolygon features around reachable cells in the respective grids; `contours` and `fullContours` are isolines. Add `--street-edges` or JSON `includeStreetEdges: true` to retain every reached directed OSM edge in `surface.edges` (the indexed `vigo.street.edge-bundle.v2` format). `diagnostics` retains the engine's transit and surface diagnostics. The [CLI-only guide](../guides/cli-only.md#isochrones-and-planned-service) shows GeoJSON export and resident Reach requests.

`surfaceSampling` selects how travel times are sampled:

- `"street"` (default) follows the directed walking graph, retaining reachable portions of edges even when their endpoints lie beyond the time or walking limit. Each cell records the earliest sampled street arrival within it.
- `"cell-center"` routes to the coordinate at each cell center using the same Route/Matrix model. Its requested and full grids share fixed bounds. This is the mode for comparing destination travel times on a common grid. Transit uses the City's 4.8 km/h walking speed and supports the baseline timetable; use street sampling for planned changes.

Set `mode: "walk"` for walking alone in either sampling mode. Missing raster values remain `null`; they do not establish that a destination is geographically off-network. A connected destination can be unreachable within the requested time or walking budget.

Street bundle v2 adds `fromDurationMinutes`, `startFractions`, and `endFractions` as packed Float64 arrays. Fractions locate a reached interval on the directed edge identified by `edgeIds` and `endpoints`. An edge can have multiple non-overlapping intervals when different journeys reach different portions. `count` counts intervals; `reachedEdgeCount` counts distinct directed edges. The viewer clips each interval at the selected time cutoff. Existing v1 results remain readable.

Studio's **Analyze** view displays **Reachable area** or **Reached streets**. Its surface expands to the complete reached-network envelope. Choose an origin on the map, search imported stops, or enter coordinates. **Analysis settings → Area calculation** selects reachable streets or routes to grid points. Switching a displayed cutoff filters the retained result; changing query inputs requires a new computation.

Reach does not count people, jobs, schools, or other opportunities. An accessibility measure needs those data and an explicit method. A reachable street in the model does not establish safe access, observed travel time, demand, or operational feasibility. See [known limits](known-routing-limitations.md).

For a complete baseline and proposed-service experiment, follow [Test a planned service change](../guides/workflows.md#test-a-planned-service-change). Compare numerical surfaces on the same grid, preserve missing cells, and read the [comparison rules](results.md#compare-saved-results) alongside the resulting contours.
