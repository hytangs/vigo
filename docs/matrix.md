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

Coordinate Transit Matrix compares scheduled transit with a direct OSM walk, using the same independent end-to-end walking limit as Route. The horizon bounds the timetable search and the direct walk; a final transit egress walk can extend beyond the timetable horizon. Walking distances are computed in one native batch.

Every City and OD set uses the same exact scalar timetable scan. Matrix size and endpoint distance do not select a different search algorithm. Full-itinerary materialization is used only as a test reference.
