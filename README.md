<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/vigo-mark-dark.png">
    <img src="public/vigo-mark-transparent.png" width="104" alt="VIGO">
  </picture>
</p>

<h1 align="center">VIGO</h1>

<p align="center"><strong>Turn city transport data into answers.</strong></p>

VIGO turns GTFS and OSM into a city model for routing, network-wide travel-time analysis, and service-change testing.

Explore the City in VIGO Studio, automate it with the VIGO command, or install VIGO Python separately.

```text
City → Scenario → Query → Result
                   ├─ Route
                   ├─ Matrix
                   └─ Reach
```

That is the complete product model.

> VIGO 0.3 is pre-release software. Do not use it for safety-critical, operational, or passenger-information systems without independent validation.

## What VIGO does

### Build a City

VIGO compiles one or more static GTFS sources and an OSM extract into one portable City directory. The timetable, streets, and required query data move together.

### Ask three questions

- **Route** finds and explains travel between ordered points.
- **Matrix** computes travel times between sets of origins and destinations.
- **Reach** maps where the network can travel within stated time limits.

Depart-at, arrive-by, departure windows, transport modes, waypoints, batch work, realtime state, and supplied traffic are options or Scenario state. They are not separate products.

### Compare change

A Scenario is an immutable set of changes applied to one City revision. Compare acts on compatible Results from the unchanged City and a Scenario, or from two City revisions.

Reach describes modeled network reach. VIGO reserves the word Accessibility for analyses that also include opportunities such as jobs, population, schools, or healthcare.

## VIGO Studio

VIGO Studio is the visual application:

- **Explore** — map the City and inspect services, stops, stations, schedules, and live state.
- **Route** — plan and explain point-to-point journeys.
- **Analyze** — run Reach and compare service sources or planned changes.
- **City** — manage data and settings.

Matrix is available through the command line and VIGO Python in VIGO 0.3. Technical details appear with the Result that needs them, not as separate work areas.

## VIGO Python

VIGO Python is the separately installed Python interface. It uses the same nouns as Studio and the command line.

```python
import vigo

with vigo.open("./washington-dc") as city:
    route = city.route(
        "A",
        "B",
        depart_at="08:00",
        service_date="2026-09-04",
    )
    matrix = city.matrix(
        {"home": "A"},
        {"school": "B", "hospital": "C"},
        depart_at="08:00",
        service_date="2026-09-04",
    )
    reach = city.reach(
        [-77.0365, 38.8977],
        depart_at="08:00",
        service_date="2026-09-04",
    )
```

VIGO Python installs and imports as `vigo`.

## Command line

```text
vigo build
vigo capabilities
vigo inspect
vigo route
vigo matrix
vigo reach
vigo compare
```

Example:

```bash
vigo build \
  --gtfs ./feed.zip \
  --osm ./region.osm.pbf \
  --output ./city

vigo route \
  --city ./city \
  --request ./route.json \
  --service-date 2026-09-04
```

VIGO opens the selected City and manages query readiness automatically.

## Build from source

The source build requires Node.js 24.18 or newer, npm 11.6 or newer, and the Rust toolchain selected by `rust-toolchain.toml`.

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm test
npm run dev
```

`npm run dev` starts the browser development view. To run the desktop application
against the built files, use `npm run studio`.

Build the standalone desktop application with:

```bash
npm run build:studio
```

The packaged VIGO Studio uses an internal memory channel between its interface
and VIGO Engine. It does not open a local server port.

## Performance language

VIGO reports four different durations:

- **Build** — source data becomes a City.
- **Open** — a City revision becomes ready for queries.
- **Compute** — the selected Route, Matrix, or Reach runs.
- **End to end** — submission through complete Result.

Repeated Route calls may reuse one open process. VIGO does not present reuse as Query compute time.

## Documentation

- [VIGO 0.3.0 Quickstart](docs/quickstart.md)
- [VIGO 0.3.0 Developer Guide source](docs/developer-guide/VIGO-0.3.0-Developer-Guide.tex) — build the PDF with `npm run docs:developer-guide`
- [Core concepts](docs/concepts.md)
- [VIGO Studio Guide](docs/studio.md)
- [Command line and VIGO Python](docs/programmatic.md)
- [Data support](docs/gtfs-support-matrix.md)
- [Known limits](docs/known-routing-limitations.md)
- [Internal architecture](docs/development/architecture.md)

## Repository

This repository contains VIGO Studio, the native computation core, the command line, build tools, tests, and documentation. It does not contain private data, unpublished comparisons, or the Python binding.

VIGO is licensed under the [Apache License 2.0](LICENSE).
