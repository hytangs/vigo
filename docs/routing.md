# Route

Route finds and explains travel between ordered points.

## Inputs

A Route Query selects:

- origin, optional ordered waypoints, and destination;
- transit, walk, or drive;
- exact service date and local time;
- depart-at or arrive-by;
- walking limit and objective;
- optional departure window;
- optional Scenario state supported by the selected mode.

Stop IDs are exact GTFS identifiers. Coordinate points are [longitude, latitude] and require streets in the City.

## Result

A Route Result contains status, chronological legs, departure and arrival, duration, transfers, warnings, timing, and a run record. A blocked Result remains a valid answer and explains why no journey was returned.

VIGO 0.3.0 exposes `earliest_arrival`. Equal-arrival journeys prefer fewer boardings, then less walking, then a stable final order. VIGO does not expose an undefined “balanced” preference.

Depart-at transit, arrive-by transit, walking, driving, realtime-adjusted transit, waypoints, and batch requests remain Route variants. VIGO does not expose them as separate products.
