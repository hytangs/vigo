<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/vigo-mark-dark.png">
    <img src="public/vigo-mark-transparent.png" width="104" alt="VIGO">
  </picture>
</p>

<h1 align="center">VIGO</h1>

<p align="center"><strong>Turn city transport data into answers.</strong></p>

VIGO turns GTFS and OSM into a city model for routing, network-wide travel-time analysis, and service-change testing.

Build a reusable City, inspect its network, and run Route, Matrix, or Reach. Each Result keeps the request, warnings, and timing alongside the answer.

## Choose an interface

| Component | Role | Interface |
| --- | --- | --- |
| **VIGO Engine** | Build reusable Cities and compute Route, Matrix, Reach, and Compare. | The `vigo` command and native runtime in this repository. |
| **VIGO Studio** | Inspect live service, plan journeys, and compare Reach scenarios. | Desktop application; its project library is separate from CLI City directories. |
| **VIGO Python** | Automate the same Engine from Python. | [Separate package and API documentation](https://github.com/hytangs/vigo-py). |

```text
City → Scenario → Query → Result
                   ├─ Route
                   ├─ Matrix
                   └─ Reach
```

[VIGO 0.4.0](docs/releases/0.4.0.md) adds live network inspection, line diagrams, trip predictions, and experimental Ask to Studio. API 1.0, City format 1, and Result schema 1 remain unchanged.

> VIGO 0.4 is pre-release software. Do not use it for safety-critical, operational, or passenger-information systems without independent validation.

## Vision

Bring network inspection, journey planning, and service-change analysis into one reproducible city model. VIGO connects each answer to its data, time, and computation so people can investigate a result and compare changes. Natural-language tools are an optional interface to those computations; their model-generated interpretations remain experimental.

## The product model

The Engine compiles one or more static GTFS sources and an OSM extract into a portable City directory. The timetable, streets, and required query data move together.

- **Route** finds and explains travel between ordered points.
- **Matrix** computes travel times between sets of origins and destinations.
- **Reach** maps where the network can travel within stated time limits.

A Scenario is an immutable set of changes applied to one City revision. **Compare** compares compatible saved Results. Planned service changes apply to Reach, supplied traffic to Drive Route/Matrix, and supplied realtime snapshots to Transit Route in Studio and the CLI. Matrix and Reach remain scheduled. See the [Query and Scenario limits](docs/known-routing-limitations.md).

Reach describes modeled network reach. VIGO reserves the word Accessibility for analyses that also include opportunities such as jobs, population, schools, or healthcare.

## VIGO Studio

Studio has four main views:

- **Network** — inspect reporting coverage, service briefings, vehicles, and alerts. Its **Routes** tab provides trip times, station boards, and line diagrams, including reported added service. **Ask** is an experimental model interface to network evidence, journeys, and Reach; review its sources and activity trail.
- **Route** — plan ordered journeys using an explicit scheduled date/time or a frozen realtime snapshot. Transfer limits are available for journeys without via points.
- **Analyze** — run Reach and compare service sources or planned changes.
- **City** — manage data and settings, including deleting an individual GTFS feed or the OSM source while keeping the City.

Matrix is available through Engine and Python. Studio uses the same computation core but does not directly open CLI City directories or provide a Matrix screen.

## Get started

Use the [CLI quickstart](docs/quickstart.md) to build a City and run your first queries, or the [Studio guide](docs/studio.md) for the visual workflow. Published desktop binaries are listed on the [releases page](https://github.com/hytangs/vigo/releases).

### Build from source

The source build requires Node.js 24.18 or newer, npm 11.6 or newer, and the Rust toolchain selected by `rust-toolchain.toml`.

Supported targets are macOS 13.5+ (Apple Silicon and Intel), Linux (ARM64 and x64, glibc; release builds use Ubuntu 24.04), and Windows x64. Match the runtime to the OS and CPU. A complete CLI City directory can move between these targets; see [platform and City reuse limits](docs/known-routing-limitations.md#city-reuse-and-platforms).

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm test
```

Run `npm run studio` for the desktop application or `npm run dev` for the browser development view.

Build the standalone desktop application with:

```bash
npm run build:studio
```

The packaged VIGO Studio uses an internal memory channel between its interface
and VIGO Engine. It does not open a local server port.

Build, opening a City, Query compute, and complete caller elapsed time are separate measurements. See [performance](docs/performance.md) before comparing timings.

## Documentation

- [Documentation index](docs/README.md)
- [VIGO 0.4.0 release notes](docs/releases/0.4.0.md)
- [Interactive guide and Result viewer](docs/guide.html)
- [Network, Routes, and Ask](docs/agency.md)
- [Command-line reference](docs/programmatic.md)
- [VIGO 0.4.0 Developer Guide source](docs/developer-guide/VIGO-0.4.0-Developer-Guide.tex) — build the PDF with `npm run docs:developer-guide`
- [Python API documentation](https://github.com/hytangs/vigo-py/tree/main/docs)

## Repository

This repository contains VIGO Studio, the native computation core, the command line, build tools, tests, and documentation. See [contributing](.github/CONTRIBUTING.md) for development and validation.

VIGO is licensed under the [Apache License 2.0](LICENSE).
