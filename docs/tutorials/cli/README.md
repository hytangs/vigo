# VIGO CLI tutorials (0.3.0)

These tutorials use any local GTFS feed and OSM PBF. They build one SQLite
network, route exact stops and coordinates, keep a resident process open, and
render accessibility from the directed OSM graph.

The [CLI process contract](../../vigo-cli.md) is authoritative for flags and
schemas. Start with Document 0, then reuse the same variables in the later
documents. Document 0 uses `npm ci` so the checkout follows its lockfile.

## What you will build

1. Prepare a local GTFS and OSM source pair.
2. Compile the timetable and street stores.
3. Route stops, coordinates, batches, and rolling windows.
4. Produce one-to-many and edge-supported accessibility results.

## Learning path

| Document | Outcome |
| --- | --- |
| [0. Set up and build a network](00-setup-and-build.md) | Build the CLI and compile local GTFS and OSM inputs. |
| [1. Inspect and prepare the network](01-build-network.md) | Validate the build receipt and service date. |
| [2. Route a batch](02-route-a-batch.md) | Route exact stops and coordinate pairs with retained geometry. |
| [3. Keep a routing process open](03-stream-requests.md) | Send multiple requests through one resident process. |
| [4. Compute matrices and isochrones](04-matrices-and-isochrones.md) | Run one-to-many analysis and export accessibility results. |
| [5. Automate and diagnose runs](05-automate-and-diagnose.md) | Capture receipts, statuses, and reproducible outputs. |
| Map presentation recipe | [Accessibility maps](../../guides/accessibility-maps.md) |

All examples use paths outside the source checkout for imported data and
generated outputs. Replace placeholder stop IDs and coordinates with values
covered by your own inputs.
