# VIGO

**Transit routing, travel-time matrices, and accessibility maps from GTFS and OpenStreetMap.**

Build a reusable **City**, then query transit, walking, or driving journeys, calculate origin–destination matrices, and map reachable areas. VIGO combines a Rust routing engine with a command-line compiler, an HTTP service, a desktop workspace, and a separate Python package.

[Documentation](docs/guide.md) · [Rust CLI & HTTP](docs/guides/rust-standalone.md) · [Python](https://github.com/hytangs/vigo/tree/main/python) · [Downloads](https://github.com/hytangs/vigo/releases)

## Choose your interface

| Interface | Use it for | Start here |
| --- | --- | --- |
| **Native engine** | Route, Matrix, and Reach queries from one executable; resident streams and HTTP services | [Rust guide](docs/guides/rust-standalone.md) |
| **Command-line compiler** | Build Cities from GTFS ZIPs and OSM PBFs; prepare scenarios and run queries | [CLI quickstart](docs/guide.md#vigo-cli-quickstart) |
| **VIGO Studio** | Inspect networks and live service, plan journeys, and explore scenarios visually | [Desktop guide](docs/guide.md#vigo-studio-desktop-guide) |
| **VIGO Python** | Automate studies, run batches, and export journey and leg tables | [Python package](https://github.com/hytangs/vigo/tree/main/python) |

The native executable queries prepared Cities without Node.js. The compiler imports source data. Studio includes its runtime; Python platform wheels include a headless runtime.

## Build a City and find a journey

For a source installation, use Node.js 24.18 or newer, npm 11.6 or newer, and the repository's pinned Rust toolchain with a native linker:

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build:cli-runtime

node public/vigo.mjs build \
  --gtfs ./data/transit.zip \
  --osm ./data/streets.osm.pbf \
  --output ./city
```

Save this as `route.json`. Replace the coordinates and date with locations and service coverage from your inputs:

```json
{
  "origin": {"coordinate": [-71.062, 42.356]},
  "destination": {"coordinate": [-71.058, 42.349]},
  "serviceDate": "2026-07-15",
  "time": "08:00",
  "mode": "transit"
}
```

```bash
node public/vigo.mjs route --city ./city --request route.json
```

Keep a resident `stream` or `serve` process open for repeated queries. The native executable accepts the same prepared City and its [documented query contract](docs/guides/rust-standalone.md). See the [Boston tutorial](docs/guides/rust-standalone.md#3-prepare-and-manage-city-data) for source downloads and a complete deployment workflow.

## What VIGO computes

- **Route:** departure-time and arrive-by journeys, walking access, transfer controls, and sampled alternatives.
- **Matrix:** travel times between origin and destination sets, with optional journeys and geometry.
- **Reach:** travel-time surfaces and isochrones for walking and transit, including supported planned-service scenarios.
- **Compare:** changes between compatible Reach results.

Scheduled transit supports Route, Matrix, and Reach. Supported realtime Trip Updates apply to transit Route; supplied traffic applies to driving Route and Matrix. [Query support](docs/guide.md#choose-a-supported-combination) describes the available combinations. Wheelchair routing uses a [separately prepared strict profile](docs/guides/rust-standalone.md#wheelchair-routing).

## VIGO 0.5.2

This version streamlines Studio and routing:

- Searchable offline documentation inside **Settings → Documentation**.
- Journey downloads and clearer City/scenario comparisons.
- Less redundant point-query, Reach propagation, and response-formatting work.
- Explicit authorized endpoint access for private pedestrian paths.
- A focused Network workspace, with the former Ask interface and City skills removed.

Published 0.5 Cities remain readable without rebuilding. API 1.0, City format 1, and Result schema 1 are unchanged. [Release notes](docs/releases/0.5.2.md) · [Prepared-data compatibility](docs/reference/format-0.5.0.md)

## Develop and contribute

```bash
npm run build        # Build the engine, CLI, and Studio assets
npm run studio       # Open Studio
npm test             # Run public-source and engine checks
```

See [contributing](.github/CONTRIBUTING.md) for focused checks and packaging, [architecture](docs/developer.md#architecture) for implementation, and the [security policy](SECURITY.md) for reporting vulnerabilities. The [offline guide](docs/guide.html) includes search and a Result viewer.

VIGO is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
