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
