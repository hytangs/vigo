# Street routing

A City built with OSM supports Walk and Drive variants of Route and Matrix, plus directed walking access for transit.

Walk uses the directed pedestrian graph. Drive uses the directed road graph with free-flow time unless a Scenario supplies traffic weights or closures. VIGO does not replace a missing street path with a straight line.

Street Route requires coordinate endpoints and returns full geometry. Street Matrix returns scalar distance and duration per pair without reconstructing every path.

Current limits include incomplete turn modeling, no signal-delay model, and dependence on the supplied OSM coverage. See [Known limits](known-routing-limitations.md).
