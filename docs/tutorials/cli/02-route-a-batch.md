# Tutorial 2: Route a batch

This tutorial routes an exact stop pair and a coordinate pair. Replace the
placeholder stop IDs and coordinates with values in your compiled stores.

```bash
set -euo pipefail

export VIGO_DATA_HOME="${VIGO_DATA_HOME:-$HOME/Documents/vigo-data}"
export VIGO_NETWORK="$VIGO_DATA_HOME/network"
export VIGO_OUTPUT="$VIGO_DATA_HOME/output"
export VIGO_STORE="$VIGO_NETWORK/routing/project.sqlite"
export VIGO_STREET_STORE="$VIGO_NETWORK/osm/street-index.sqlite"
export VIGO_REPO="${VIGO_REPO:-$HOME/Documents/vigo}"
export VIGO_NODE="${VIGO_NODE:-$(command -v node)}"
export VIGO_CLI="$VIGO_REPO/dist-cli/vigo.mjs"
export VIGO_SERVICE_DATE="${VIGO_SERVICE_DATE:?set a valid service date}"
export VIGO_SERVICE_DAY="${VIGO_SERVICE_DAY:?set the matching service-day class}"
export VIGO_ORIGIN_STOP="${VIGO_ORIGIN_STOP:?set an origin stop ID}"
export VIGO_DESTINATION_STOP="${VIGO_DESTINATION_STOP:?set a destination stop ID}"
mkdir -p "$VIGO_DATA_HOME/input" "$VIGO_OUTPUT"

cat > "$VIGO_DATA_HOME/input/stop-ods.csv" <<EOF
id,origin_stop_id,destination_stop_id
stop-a-to-stop-b,$VIGO_ORIGIN_STOP,$VIGO_DESTINATION_STOP
EOF

"$VIGO_NODE" "$VIGO_CLI" route \
  --store="$VIGO_STORE" \
  --od="$VIGO_DATA_HOME/input/stop-ods.csv" \
  --out="$VIGO_OUTPUT/stop-routes.csv" \
  --json-out="$VIGO_OUTPUT/stop-routes.json" \
  --time=08:00 \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2 \
  > "$VIGO_OUTPUT/stop-run-summary.json"
```

For coordinates, use `longitude,latitude` and attach the street store:

```bash
cat > "$VIGO_DATA_HOME/input/coordinate-ods.csv" <<'EOF'
id,origin_lon,origin_lat,destination_lon,destination_lat
coordinate-a-to-b,-73.9857,40.7484,-73.9772,40.7527
EOF

"$VIGO_NODE" "$VIGO_CLI" route \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --od="$VIGO_DATA_HOME/input/coordinate-ods.csv" \
  --out="$VIGO_OUTPUT/coordinate-routes.csv" \
  --json-out="$VIGO_OUTPUT/coordinate-routes.json" \
  --time=08:00 \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2 \
  > "$VIGO_OUTPUT/coordinate-run-summary.json"
```

Read `status`, `route_sequence`, the walking-network diagnostics, and the
full JSON legs. A blocked row is a valid routing outcome; inspect its failure
code rather than replacing the OSM path with a straight-line estimate.

Next: [Tutorial 3: Keep a routing process open](03-stream-requests.md).

