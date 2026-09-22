# Reach

Reach computes travel time from one origin through scheduled transit and walking. It supports planned service scenarios. Walk-only, Drive, arrive-by, and realtime Reach are unavailable in 0.4.2.

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

Studio's **Analyze** view displays **Reachable area** or **Reached streets**. Its surface expands to the complete reached-network envelope. Choose an origin on the map, search imported stops, or enter coordinates. Switching a displayed cutoff filters the retained result; changing query inputs requires a new computation.

Reach does not count people, jobs, schools, or other opportunities. An accessibility measure needs those data and an explicit method. A reachable street in the model does not establish safe access, observed travel time, demand, or operational feasibility. See [known limits](known-routing-limitations.md).
