<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/vigo-mark-dark.png">
    <img src="public/vigo-mark-transparent.png" width="104" alt="VIGO">
  </picture>
</p>

<h1 align="center">VIGO</h1>
<p align="center"><strong>Understand a transport network. Test what could change.</strong></p>

VIGO turns GTFS timetables and OpenStreetMap streets into a reusable city model. Inspect live service, plan journeys, calculate travel-time matrices, and compare the reach of proposed service changes. Each computed Result retains its request, City identity, warnings, and timing.

**VIGO 0.4.2** prepares Drive hierarchies at City build time, shares native Matrix endpoint work, and moves shape alignment into Rust. See the [release notes](docs/releases/0.4.2.md).

## Why VIGO

Timetables, vehicle reports, and street networks describe different parts of a journey. VIGO brings them together so you can move from a network overview to a particular trip, inspect the evidence, and test a transport change against the same baseline.

The goal is a reproducible workflow from source data to a reviewable answer. Native routing performs the computation; optional AI tools help ask questions and interpret evidence. Model explanations remain hypotheses for review.

## What you can do

| Task | Where to start |
| --- | --- |
| Inspect reporting coverage, alerts, and service briefings | Studio **Network** |
| Follow a route, trip, vehicle, or station board | Studio **Network → Routes**, map and line views |
| Investigate service with a configured model and saved sources | Studio **Network → Ask** |
| Plan a transit, walking, or driving journey | Studio **Route** or `vigo route` |
| Calculate travel times between sets of locations | `vigo matrix` |
| Map travel time from an origin and test planned service | Studio **Analyze** or `vigo reach` |
| Import or remove GTFS and OSM sources | Studio **City → Data sources** |

## Choose an interface

- **VIGO Engine:** the `vigo` command and shared native runtime in this repository. Build a City once, then run Route, Matrix, or Reach.
- **VIGO Studio:** a desktop workspace for network inspection, journeys, and scenario analysis. Its project library is separate from CLI City directories.
- **VIGO Python:** automate Engine through the [separate Python package](https://github.com/hytangs/vigo-py).

```text
GTFS + OSM → City → optional Scenario → Route | Matrix | Reach → Result
```

Compare operates on compatible Results. Planned transit changes apply to Reach; supplied traffic applies to Drive Route and Matrix. Realtime transit Route processes supported, matched Trip Updates. Transit Matrix and Reach remain scheduled. See [query support](docs/guides/concepts.md#choose-a-supported-combination) and [routing limits](docs/reference/known-routing-limitations.md).

## Get started

Download a matching desktop archive from [GitHub Releases](https://github.com/hytangs/vigo/releases), or build from source. Packaged Studio includes its runtime; source builds require Node.js 24.18+, npm 11.6+, and the pinned Rust toolchain with a native linker.

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm run studio
```

In Studio, create a City and import a static GTFS ZIP and an overlapping OSM PBF. Add GTFS-Realtime connections for live inspection. A model connection is optional. For a complete command-line example, follow the [quickstart](docs/guides/quickstart.md).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Browser development with the local engine |
| `npm run build:studio` | Build and package the desktop application |
| `npm test` | Public-repository and engine checks |

Native targets are macOS 13.5+ on ARM64/x64, Linux glibc on ARM64/x64, and Windows x64. Linux release builds use Ubuntu 24.04. Studio requires WebGL 2; Engine does not need a graphics device. Packaged Studio communicates with Engine in memory without a local TCP listener.

## Evidence and limits

VIGO is pre-release software. A computed journey is a result within the supplied timetable and street model; a prediction is not an observed passage. Missing reports remain unknown. Reach measures travel time; measuring access to jobs or people requires opportunity data and a stated measure.

Ask sends questions and selected evidence to the configured inference endpoint. Model and web connections are separate. Inspect the answer's sources and **Model & data** record. Ask does not authorize dispatch or publish rider messages. See the [Network guide](docs/guides/network.md) and [security policy](SECURITY.md).

## Documentation

| Start | Understand | Go deeper |
| --- | --- | --- |
| [CLI quickstart](docs/guides/quickstart.md) · [Studio](docs/guides/studio.md) | [Practical workflows](docs/guides/workflows.md) · [Read a Result](docs/reference/results.md) | [CLI reference](docs/reference/programmatic.md) · [Architecture](docs/development/architecture.md) |
| [Documentation index](docs/README.md) | [Network evidence](docs/guides/network.md) · [Troubleshooting](docs/guides/troubleshooting.md) | [Contributing and checks](.github/CONTRIBUTING.md) |

The [offline guide](docs/guide.html) includes a local Result viewer; the [Developer Guide source](docs/developer-guide/VIGO-0.4.2-Developer-Guide.tex) builds the release PDF.

API 1.0, City format 1, and Result schema 1 are unchanged in 0.4.2. VIGO is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attribution.
