# Tutorial 4: Compute matrices and isochrones

One-to-many and isochrone requests reuse the same stores and service date.

## One-to-many

Create a destination file containing stop IDs or coordinates:

```bash
cat > "$VIGO_DATA_HOME/input/destinations.csv" <<'EOF'
id,stop_id
destination-a,STOP_A
destination-b,STOP_B
EOF

"$VIGO_NODE" "$VIGO_CLI" matrix \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --origin="$VIGO_ORIGIN_STOP" \
  --destinations="$VIGO_DATA_HOME/input/destinations.csv" \
  --time=08:00 \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2 \
  --matrix-strategy=shared \
  > "$VIGO_OUTPUT/one-to-many-result.json"

jq '{query, rows, diagnostics, timing}' "$VIGO_OUTPUT/one-to-many-result.json"
```

## Accessibility surface

The accessibility request starts from one coordinate and returns reachable
network evidence. It never fills disconnected streets with straight lines:

```bash
cat > "$VIGO_DATA_HOME/input/isochrone.json" <<'EOF'
{
  "origin": {"coordinate": [-73.9857, 40.7484], "label": "origin"},
  "cutoffsMinutes": [15, 30, 45],
  "radiusKm": 8,
  "rasterSize": 48
}
EOF

"$VIGO_NODE" "$VIGO_CLI" isochrone \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --request="$VIGO_DATA_HOME/input/isochrone.json" \
  --time=08:00 \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2 \
  --walk-speed=4.8 \
  > "$VIGO_OUTPUT/isochrone-result.json"

jq '{query, summary, timing}' "$VIGO_OUTPUT/isochrone-result.json"
```

The desktop Evidence page offers the same result as an accessible area or
reached street paths. Area and street metrics describe the stored network;
they do not imply population, jobs, or ridership without an additional data
layer.

Next: [Tutorial 5: Automate and diagnose runs](05-automate-and-diagnose.md).

