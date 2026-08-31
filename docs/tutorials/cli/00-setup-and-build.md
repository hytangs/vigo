# Document 0: Set up and build a network

This is the first command-line tutorial. It builds the source CLI, accepts one
GTFS ZIP and one OSM PBF, and compiles reusable timetable and directed street
stores. VIGO does not ship a city-specific feed or map extract.

## 1. Build the CLI

From a clean VIGO checkout:

```bash
set -euo pipefail

export VIGO_REPO="${VIGO_REPO:-$HOME/Documents/vigo}"
cd "$VIGO_REPO"
npm ci
npm run build:rust-routing-kernel
npm run build:cli

export VIGO_NODE="${VIGO_NODE:-$(command -v node)}"
export VIGO_CLI="$VIGO_REPO/dist-cli/vigo.mjs"
"$VIGO_NODE" "$VIGO_CLI" --version
```

The packaged desktop app includes its native runtime. Building from source
requires Node.js, npm, and Rust/Cargo.

## 2. Choose local inputs

Set paths to files that cover the stops and coordinates you will query:

```bash
export VIGO_DATA_HOME="${VIGO_DATA_HOME:-$HOME/Documents/vigo-data}"
export VIGO_INPUT="$VIGO_DATA_HOME/input"
export VIGO_NETWORK="$VIGO_DATA_HOME/network"
export VIGO_OUTPUT="$VIGO_DATA_HOME/output"
export VIGO_GTFS="${VIGO_GTFS:-$VIGO_INPUT/network.gtfs.zip}"
export VIGO_OSM="${VIGO_OSM:-$VIGO_INPUT/network.osm.pbf}"

test -s "$VIGO_GTFS"
test -s "$VIGO_OSM"
mkdir -p "$VIGO_NETWORK" "$VIGO_OUTPUT"
```

Use the original provider download or a local file transfer to obtain the
inputs. Keep the GTFS and OSM sources from the same geographic service area.

## 3. Select an active service date

A service date must be present in the feed calendar. The CLI can report the
available dates while building; use the returned date in later requests. Never
silently substitute today's date when the feed has no service.

Set the selected date explicitly for the rest of the tutorials:

```bash
export VIGO_SERVICE_DATE="${VIGO_SERVICE_DATE:?set an exact date covered by the GTFS calendar}"
export VIGO_SERVICE_DAY="${VIGO_SERVICE_DAY:?set the matching service-day class}"
```

These values belong to the active data environment, not to the VIGO source
checkout.

## 4. Build the stores

```bash
"$VIGO_NODE" "$VIGO_CLI" build-network \
  --gtfs="$VIGO_GTFS" \
  --osm-pbf="$VIGO_OSM" \
  --output-dir="$VIGO_NETWORK" \
  --sequential-raw-build \
  > "$VIGO_OUTPUT/build-summary.json"

jq '{schemaVersion, inputs, routingStore, streetStore, timing}' \
  "$VIGO_OUTPUT/build-summary.json"
```

The output directory contains the routing SQLite store, the indexed OSM street
store, and a source-bound build receipt. Keep those files together.

Next: [Tutorial 1: Inspect and prepare the network](01-build-network.md).
