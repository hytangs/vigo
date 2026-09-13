# VIGO Agency

VIGO Agency is an agency-facing public-transit intelligence application being developed on VIGO.

This repository was forked from [hytangs/vigo](https://github.com/hytangs/vigo) at [VIGO 0.3.2](https://github.com/hytangs/vigo/tree/v0.3.2) and is being developed independently as VIGO Agency.

VIGO 0.3.2, developed prior to this evaluation, provides scheduled multimodal Route, Matrix, and Reach computation. It is reused here as a past work and was not modified as part of the assessment.

## Assessment

- **Problem:** TODO
- **Interactive artifact:** TODO
- **Public transit data:** TODO
- **Methods:** TODO
- **Results / outputs:** TODO
- **Reproduction:** TODO

See [Assumptions and Scope](ASSUMPTIONS.md) and [AI Use](AI-USE.md).

## VIGO platform

The documentation below describes the inherited VIGO 0.3.2 foundation. VIGO Engine, VIGO Studio, and the separate VIGO Python package are pre-existing upstream components, not work developed as part of this assessment. The linked technical guides also document upstream VIGO.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/vigo-mark-dark.png">
    <img src="public/vigo-mark-transparent.png" width="104" alt="VIGO">
  </picture>
</p>

<p align="center"><strong>Turn city transport data into answers.</strong></p>

VIGO turns GTFS and OSM into a city model for routing, network-wide travel-time analysis, and service-change testing.

VIGO has three components, sharing one routing engine and one Query model:

| Component | Role | Interface |
| --- | --- | --- |
| **VIGO Engine** | Build reusable Cities and compute Route, Matrix, Reach, and Compare. | The `vigo` command and native runtime in this repository. |
| **VIGO Studio** | Explore data, plan journeys, and compare Reach scenarios. | Desktop application; its project library is separate from CLI City directories. |
| **VIGO Python** | Automate the same Engine from Python. | [Separate package and API documentation](https://github.com/hytangs/vigo-py). |

```text
City → Scenario → Query → Result
                   ├─ Route
                   ├─ Matrix
                   └─ Reach
```

0.3.2 is a stabilization release. API 1.0, City format 1, and Result schema 1 remain unchanged.

> VIGO 0.3 is pre-release software. Do not use it for safety-critical, operational, or passenger-information systems without independent validation.

### What VIGO does

#### Build a City

VIGO compiles one or more static GTFS sources and an OSM extract into one portable City directory. The timetable, streets, and required query data move together.

#### Ask three questions

- **Route** finds and explains travel between ordered points.
- **Matrix** computes travel times between sets of origins and destinations.
- **Reach** maps where the network can travel within stated time limits.

Depart-at, arrive-by, departure windows, transport modes, waypoints, and batch work are Query options. Scenario support is limited by interface: planned service changes apply to Reach, supplied traffic to Drive Route/Matrix, and live transit to Studio Route. See the [support boundaries](docs/known-routing-limitations.md).

#### Compare change

A Scenario is an immutable set of changes applied to one City revision. Compare acts on compatible Results from the unchanged City and a Scenario, or from two City revisions.

Reach describes modeled network reach. VIGO reserves the word Accessibility for analyses that also include opportunities such as jobs, population, schools, or healthcare.

### VIGO Studio

VIGO Studio is the visual application:

- **Explore** — map the City and inspect services, stops, stations, schedules, and live state.
- **Route** — plan and explain point-to-point journeys.
- **Analyze** — run Reach and compare service sources or planned changes.
- **City** — manage data and settings.

Matrix is available through Engine and Python. Studio uses the same computation core but does not directly open CLI City directories or provide a Matrix screen.

### Command line

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

### Build from source

The source build requires Node.js 24.18 or newer, npm 11.6 or newer, and the Rust toolchain selected by `rust-toolchain.toml`.

Build and packaged runtime targets are macOS 13.5+ (Apple Silicon and Intel), Linux (ARM64 and x64, glibc; release builds use Ubuntu 24.04), and Windows (x64). Download the matching [upstream VIGO 0.3.2 Studio archive](https://github.com/hytangs/vigo/releases/tag/v0.3.2), or build on the target machine. Linux builds do not target musl/Alpine; 32-bit and native Windows ARM64 builds are not provided.

The runtime binary must match the OS and CPU. A complete City directory can move between these targets without importing its raw inputs again. Retained street, station-access, and timetable preparation is reusable after copying or extraction. New service patterns, changed policies, or incompatible/evicted timetable snapshots can require preparation. Reopening still takes disk reads and memory allocation; see [loading and timing](docs/performance.md).

To build this VIGO Agency checkout with the inherited VIGO tooling:

```bash
git clone https://github.com/vigo-developers/vigo-agency.git
cd vigo-agency
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

### Performance language

VIGO reports four different durations:

- **Build** — source data becomes a City.
- **Open** — a City revision becomes ready for queries.
- **Compute** — the selected Route, Matrix, or Reach runs.
- **End to end** — submission through complete Result.

Repeated Route calls may reuse one open process. VIGO does not present reuse as Query compute time.

### Documentation

- [VIGO 0.3.2 Quickstart](docs/quickstart.md)
- [VIGO 0.3.2 Developer Guide source](docs/developer-guide/VIGO-0.3.2-Developer-Guide.tex) — build the PDF with `npm run docs:developer-guide`
- [Interactive guide and Result viewer](docs/guide.html)
- [Core concepts](docs/concepts.md)
- [VIGO Studio Guide](docs/studio.md)
- [Command line](docs/programmatic.md)
- [Data support](docs/gtfs-support-matrix.md)
- [Known limits](docs/known-routing-limitations.md)
- [Internal architecture](docs/development/architecture.md)
- [Python API documentation](https://github.com/hytangs/vigo-py/tree/main/docs)

### Repository

This repository inherits VIGO Studio, the native computation core, the command line, build tools, tests, and documentation from upstream VIGO.

VIGO is licensed under the [Apache License 2.0](LICENSE).
