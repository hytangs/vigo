# Tutorial 3: Keep a routing process open

`route-ndjson` starts one prepared VIGO process and accepts one JSON request
per input line. It is useful when the time, policy, or endpoint changes by row.

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

cat > "$VIGO_DATA_HOME/input/requests.ndjson" <<EOF
{"id":"stop-departure","origin":"$VIGO_ORIGIN_STOP","destination":"$VIGO_DESTINATION_STOP","time":"08:00"}
{"id":"coordinate-window","origin":{"coordinate":[-73.9857,40.7484]},"destination":{"coordinate":[-73.9772,40.7527]},"time":"08:00","departureWindowMinutes":10,"maxWalkKm":1.2}
{"id":"stop-arrive-by","origin":"$VIGO_ORIGIN_STOP","destination":"$VIGO_DESTINATION_STOP","time":"09:00","timePreference":"arrive"}
EOF

"$VIGO_NODE" "$VIGO_CLI" route-ndjson \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --time=08:00 \
  --max-walk=1.2 \
  < "$VIGO_DATA_HOME/input/requests.ndjson" \
  > "$VIGO_OUTPUT/results.ndjson"

sed -n '1,3p' "$VIGO_OUTPUT/results.ndjson"
```

Each response separates a parsed envelope from the journey result. One
malformed line returns one error response without terminating the stream.

Next: [Tutorial 4: Compute matrices and isochrones](04-matrices-and-isochrones.md).

