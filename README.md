<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/vigo-mark-dark.png">
    <img src="public/vigo-mark-transparent.png" alt="VIGO" width="104">
  </picture>
</p>

<h1 align="center">VIGO</h1>

<p align="center"><strong>Transit routing you can explain.</strong><br>Journeys, travel-time matrices, and reachable-area maps from GTFS and OpenStreetMap, on your own machine.</p>

<p align="center"><a href="docs/guide.md">Guide</a> · <a href="docs/guide.md#quickstart">Quickstart</a> · <a href="docs/guides/rust-standalone.md">Engine &amp; HTTP API</a> · <a href="python/README.md">Python</a> · <a href="https://github.com/hytangs/vigo/releases">Downloads</a></p>

---

VIGO builds a **City** once from GTFS timetables and OpenStreetMap streets, then answers three questions about it, as often as you like:

- **Route**: how do I travel between these places, and what happens on the way?
- **Matrix**: how long does each origin–destination pair take?
- **Reach**: where can I get within 15, 30, or 45 minutes?

A **Scenario** changes the service a query sees, such as a new line or a removed route, so you can measure a proposal against today's network. A Rust routing engine does the work; you reach it from a single executable, an HTTP API, the VIGO Studio desktop app, or Python.

## Why VIGO

- **Answers come with their evidence.** Each journey says whether a walk follows mapped streets or a schematic station link. Unreachable matrix pairs stay `null`, never zero, and every Reach surface records its grid so two runs can be compared cell by cell.
- **Build once, ask many times.** A City is one portable directory. A resident `stream` or `serve` process keeps it ready, and the engine executable needs no Node, Python, or internet connection to answer.
- **Stable by design.** Cities built with VIGO 0.5 stay readable by later releases without rebuilding, and the public `vigo.route.v1`, `vigo.matrix.v1`, and `vigo.reach.v1` schemas only gain optional fields.
- **Honest about limits.** VIGO models the timetable and streets it is given. The guide states plainly what that does and does not establish, from station interiors to live predictions.

## Choose your interface

| Interface | Use it for | Start here |
| --- | --- | --- |
| **Engine** (`vigo`) | Route, Matrix, and Reach from one executable; resident streams and an HTTP API | [Engine manual](docs/guides/rust-standalone.md) |
| **Compiler** (`vigo.mjs`) | Building Cities and scenario collections from GTFS and OSM; it can also run queries | [Quickstart](docs/guide.md#quickstart) |
| **VIGO Studio** | Inspecting networks and live service, planning journeys, and exploring scenarios visually | [Studio guide](docs/guide.md#vigo-studio-desktop-guide) |
| **VIGO Python** | Studies, batches, notebooks, and journey and leg tables | [Python package](python/README.md) |

The engine and the compiler accept the same request JSON and return the same public Result for the same City.

## Quickstart

Build from source with Node.js 24.18+, npm 11.6+, and the repository's pinned Rust toolchain with a native linker. Prebuilt archives are on the [releases page](https://github.com/hytangs/vigo/releases).

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build:cli-runtime   # the compiler, public/vigo.mjs
npm run build:standalone    # the engine, native/target/release/vigo
alias vigo-build="node \"$PWD/public/vigo.mjs\""
alias vigo="\"$PWD/native/target/release/vigo\""
```

Build a City from a GTFS ZIP and an OpenStreetMap extract that covers it:

```bash
vigo-build build --gtfs ./data/transit.zip --osm ./data/streets.osm.pbf --output ./city
```

Save a request as `route.json`. Coordinates are `[longitude, latitude]`; use places and a service date your inputs cover:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "maxWalkKm": 1.2
}
```

Ask the question, or serve it over HTTP:

```bash
vigo route --city ./city --request route.json
vigo serve --city ./city --port 8080
```

Open `http://127.0.0.1:8080/` for the full guide, served by the engine itself, with an API console that sends requests to it. The [Boston quickstart](docs/guide.md#quickstart) walks through downloading real MBTA and OpenStreetMap data, Matrix and Reach, and keeping a City loaded.

## What VIGO computes

| Capability | Details |
| --- | --- |
| Route | Depart-at and arrive-by journeys, walking access, transfer caps and reserves, waypoints, departure windows, and alternative journeys |
| Matrix | Travel times between origin and destination sets, with optional journeys and geometry |
| Reach | Travel-time rasters, areas, and contours for transit and walking, including planned-service Scenarios |
| Compare | Changes between two compatible saved Results, without routing again |
| Live and supplied data | Supported GTFS-Realtime Trip Updates for transit Route; supplied traffic for driving Route and Matrix |
| Fares and access | Published GTFS fares on itineraries, authorized private endpoints, and a [strict wheelchair profile](docs/guides/rust-standalone.md#wheelchair-routing) |

[Supported combinations](docs/guide.md#choose-a-supported-combination) lists exactly which query, mode, and data each runtime accepts.

## Documentation

Everything lives in one searchable, offline guide, [`docs/guide.html`](docs/guide.html): the same page the engine serves at `/` and Studio opens under **Settings → Documentation**. It includes a Result viewer for saved JSON and the API console. Its Markdown sources read well on GitHub too:

- [Guide](docs/guide.md): install, quickstart, concepts, workflows, routing semantics, Studio, deployment, and troubleshooting.
- [Engine manual](docs/guides/rust-standalone.md): command line, request fields, HTTP API, outputs, and native operations.
- [Read a Result](docs/reference/results.md) and [walking evidence](docs/reference/walking-evidence.md): what each answer establishes.
- [VIGO Python](python/README.md), with a [walkthrough notebook](python/examples/walkthrough.ipynb).
- [Developer resources](docs/developer.md#developer-resources): architecture, performance measurement, and routing accuracy.

## VIGO 0.5.2

- **Alternative journeys.** Route can return several journeys at once, ranked by trade-off or by arrival.
- **One Result from both runtimes.** The engine and the compiler share transit geometry, walking connections, fares, and fingerprints.
- **Studio saves its work.** Journeys export to JSON, GeoJSON, CSV, or Markdown; Reach and City comparisons keep their settings.
- **Less redundant work** in point queries, Reach propagation, and response formatting.
- **Authorized endpoint access** for private pedestrian paths at trip origins and destinations.

Published 0.5 Cities remain readable without rebuilding; API 1.0, City format 1, and Result schema 1 are unchanged. [Release notes](docs/releases/0.5.2.md) · [Changelog](CHANGELOG.md) · [Prepared-data contract](docs/reference/format-0.5.0.md)

## Develop and contribute

```bash
npm run build        # Engine kernel, Studio, and the compiler
npm run studio       # Open Studio
npm test             # Public-source and engine checks
```

[Contributing](.github/CONTRIBUTING.md) lists focused checks and packaging, [architecture](docs/developer.md#architecture) explains the implementation, and the [security policy](SECURITY.md) covers reporting vulnerabilities. Python development lives in [`python/`](python/CONTRIBUTING.md) and needs no npm or Rust.

## License

VIGO is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attribution. Data you route over keeps its own terms: retain the [OpenStreetMap attribution](https://www.openstreetmap.org/copyright) and your GTFS providers' notices when you share Cities or results.
