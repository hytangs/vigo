# Matrix

Matrix computes scalar travel time between origin and destination sets.

```json
{
  "origins": [{"id": "home", "point": "A"}],
  "destinations": [{"id": "school", "point": "B"}],
  "mode": "transit"
}
```

Transit Matrix supports fixed departure in VIGO 0.3. Walk and Drive Matrix require coordinate points. Results contain one row per requested pair with status, duration, and distance where applicable. Full journey legs belong to Route, not Matrix.

Coordinate Transit Matrix compares scheduled transit with a direct OSM walk, using the same independent end-to-end walking limit as Route. Both choices must fit the Matrix horizon. Walking distances are computed in one native batch; Matrix does not materialize walking itineraries for each cell.
