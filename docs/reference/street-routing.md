# Street routing

A City built with OSM supports Walk and Drive variants of Route and Matrix, plus directed walking access for transit.

Walk uses the directed pedestrian graph. Drive uses the directed road graph with free-flow time unless the request supplies traffic weights or closures. VIGO does not replace a missing street path with a straight line.

Street Route requires coordinate endpoints and returns full geometry. Street Matrix returns scalar distance and duration per pair without reconstructing every path.

Street Matrix sweeps from the smaller endpoint set. Many-to-one requests use the
reverse directed CCH metric; origin and destination access permissions retain
their original roles.

## Authorized endpoint access

Build defaults to public pedestrian access. `access=private` without a pedestrian
permission, or `foot=private`, stays outside the public walking graph.
Rebuild older Cities to apply the current street-store v4 permission rules.

For a population authorized to use internal roads at its own homes and destinations,
build with `--private-access=endpoints`.
This City-wide modeling assumption permits mapped private streets only within
the origin or destination's attached internal street region. An exact directed
search follows those streets and interior public islands up to the first public
component containing a transit-access anchor. The public middle of the journey
and stop-to-stop transfers cannot enter private streets. Walking wholly within
one internal region is also supported. All internal walking counts toward the
same walking limit, and returned geometry follows the mapped edges.

The private graph is stored separately; public street CCH queries remain available.
`network.json` records the access model, and transit diagnostics report
`walkingAccessPermission: "authorized_endpoints"`. This option assumes endpoint
authorization; it does not infer parcel ownership, gate opening times, or missing
OSM links. Explicit pedestrian prohibitions remain excluded.

Current limits include incomplete turn modeling, no signal-delay model, and dependence on the supplied OSM coverage. See [Known limits](known-routing-limitations.md).

## Supplied traffic

**No traffic provider is connected by default.** OSM supplies the baseline road graph and free-flow estimates. Live transit feeds do not supply a general road-speed model. Driving results without an applied traffic snapshot must not be described as current traffic estimates.

The public CLI accepts a top-level `traffic` object for Drive Route and Drive Matrix with explicit realtime mode. The internal engine calls this `trafficSnapshot`. A snapshot customizes the prepared directed road graph for one query; it is a fixed set of edge costs, not a forecast that evolves as a vehicle moves through the network.

A minimal input fragment is:

```json
{
  "routingDataMode": "realtime",
  "traffic": {
    "source": "your-provider",
    "observedAt": "2026-09-26T12:00:00Z",
    "ttlSeconds": 300,
    "observations": [
      {
        "fromCoordinate": [-71.0625, 42.3570],
        "toCoordinate": [-71.0615, 42.3575],
        "speedKph": 12
      }
    ]
  }
}
```

Use the actual observation time and coordinates of an observed **directed edge**. This fragment documents the schema; its values are illustrative, not live traffic or a calibrated provider adapter. Full Route requests also need City, mode and endpoint fields; see [Route](routing.md).

| Contract | Behavior |
| --- | --- |
| Time | Required observation time; default validity 300 seconds, maximum 1,800 seconds; future observations beyond 60 seconds are rejected |
| Expiry | Expired observations produce explicit `stale_fallback` and use baseline costs |
| Geometry | Endpoint pairs or a sequence of 2–512 coordinates; directed edge matching within 120 m by default, at most 1,000 m |
| Direct edge indices | Require the exact current `streetSourceFingerprint`; indices are not portable between street builds |
| Costs | Positive travel time, speed, or a slowdown factor; closures are supported; costs cannot become faster than the baseline |
| Overlap | Conflicting observations on one edge use the largest cost, including closures |
| Size | At most 100,000 observations and 250,000 edge references/updates; at most 4,096 direct indices per observation |
| Reuse | The native customized metric can be reused when effective edge updates are unchanged; source age is still evaluated on each query |

Inspect `diagnostics.traffic.status`, matched/unmatched counts and `weightModel`. `applied` establishes that supplied costs changed the model. `no_matches` and `free_flow_equivalent` do not establish current traffic coverage. Route and Matrix use the same customized metric, and closures can leave a pair unreachable.

Coordinate matching is nearest-edge matching, not a validated provider conflation pipeline. Parallel roads, sparse polylines and provider segment definitions need independent checks. VIGO does not yet model all turns, signals, intersection delay, parking, or a future traffic trajectory. A future provider integration needs retained source timestamps, explicit units and direction, graph identity or verified geometry mapping, coverage reporting, and validation against observed travel times.

`test/check-street-routing-modes.mjs` executes actual native Route, Matrix and worker paths for slowdown, closure, expiry, invalid indices and metric reuse. Passing it establishes those model behaviors on its constructed graph; it does not establish real-world ETA accuracy.
