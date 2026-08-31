# Tutorial 1: Inspect and prepare the network

[Document 0](00-setup-and-build.md) created the two local stores. This tutorial
shows the minimum checks before routing.

```bash
set -euo pipefail

export VIGO_DATA_HOME="${VIGO_DATA_HOME:-$HOME/Documents/vigo-data}"
export VIGO_NETWORK="$VIGO_DATA_HOME/network"
export VIGO_OUTPUT="$VIGO_DATA_HOME/output"
export VIGO_STORE="$VIGO_NETWORK/routing/project.sqlite"
export VIGO_STREET_STORE="$VIGO_NETWORK/osm/street-index.sqlite"
export VIGO_SERVICE_DATE="${VIGO_SERVICE_DATE:?set a date covered by the GTFS calendar}"
export VIGO_SERVICE_DAY="${VIGO_SERVICE_DAY:?set the matching service-day class}"
export VIGO_REPO="${VIGO_REPO:-$HOME/Documents/vigo}"
export VIGO_NODE="${VIGO_NODE:-$(command -v node)}"
export VIGO_CLI="$VIGO_REPO/dist-cli/vigo.mjs"

test -s "$VIGO_NETWORK/network.json"
test -s "$VIGO_STORE"
test -s "$VIGO_STREET_STORE"

jq '{schemaVersion, inputs, routingStore, streetStore, timing}' \
  "$VIGO_NETWORK/network.json"

"$VIGO_NODE" "$VIGO_CLI" prepare \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  > "$VIGO_OUTPUT/prepare-summary.json"

jq '{schemaVersion, preparation, routing, street}' \
  "$VIGO_OUTPUT/prepare-summary.json"
```

Preparation is safe to repeat. If the date is outside the feed's calendar,
choose another date from the source instead of changing the request clock.

To rebuild after replacing the raw inputs, use a new output directory or pass
`--force` only after checking the source paths.

Next: [Tutorial 2: Route a batch](02-route-a-batch.md).

