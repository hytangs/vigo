# Street routing

A City built with OSM supports Walk and Drive variants of Route and Matrix, plus directed walking access for transit.

Walk uses the directed pedestrian graph. Drive uses the directed road graph with free-flow time unless a Scenario supplies traffic weights or closures. VIGO does not replace a missing street path with a straight line.

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
