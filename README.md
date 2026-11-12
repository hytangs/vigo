<br>

<p align="center">
  <a href="https://vigo.city/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/vigo-logo-dark.png">
      <img src="docs/assets/vigo-logo-light.png" alt="VIGO" width="380">
    </picture>
  </a>
</p>

<h3 align="center">Transit routing. In milliseconds.</h3>

<p align="center">From a single journey to a city's worth of possibilities.<br>Open-source routing, powered by Rust.</p>

<p align="center">
  <a href="https://vigo.city/"><b>vigo.city</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/guide.md#quickstart">Quickstart</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/guide.md">Documentation</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/guides/rust-standalone.md">Engine &amp; HTTP API</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="python/README.md">Python</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://github.com/hytangs/vigo/releases">Download</a>
</p>

<br>

VIGO compiles a public transit timetable (GTFS) and an OpenStreetMap street map into a **City**, once. Then it answers, exactly and offline, how people move through it: by transit, on foot, by car or by bike.

```text
$ vigo route --city ./boston --request route.json
08:00:00 → 08:18:36 · 18.6 min · 0 transfer(s)
  08:00:00  walk  Origin → Harvard (2.3 min)
  08:03:00  Red Line  Harvard → South Station (13.0 min)
  08:16:00  walk  South Station → Destination (2.6 min)
Note: Part of this journey uses inferred station access; physical passage is not fully verified.
```

<sub>Harvard Square to South Station on a weekday morning, from the MBTA timetable and OpenStreetMap.</sub>

## 01 — Route

**From A to B. Find the earliest arrival.**

Then choose the journey with fewer boardings and less walking. Leave at 08:00 or arrive by 09:00, add stops on the way, ask for alternatives, and get every walk, wait and ride with its clocks, stops, map geometry and published fare.

## 02 — Reach

**One origin. Every possibility.**

Where can you get in 15, 30 or 45 minutes? Reach maps everywhere you can get within a time budget; its boundary is an isochrone. It stretches along transit lines, as faster connections bring distant places within reach. Turn it around to see where people can set out and still arrive by a deadline. Add a **Scenario**, such as a new line or a removed route, and measure the proposal against today's network.

## 03 — Matrix

**Ask more. Repeat less.**

A thousand destinations shouldn't mean a thousand separate searches. Matrix shares the work across compatible requests and returns a travel time, or a full journey, for every pair. An unreachable pair stays `null`, never zero.

## Travel modes

Route, Matrix and Reach answer for each mode, leaving at a time or arriving by one.

| Mode | What VIGO models |
| :--- | :--- |
| **Transit** | The published timetable with walking access, transfers and station paths. Opt in to GTFS-Realtime trip updates, GTFS Flex or Monte Carlo departure windows. |
| **Walk** | Mapped streets and station paths, with evidence for every assumed link. |
| **Drive** | The directed road network. Route and Matrix can apply a traffic snapshot you supply. |
| **Bike** | Balanced, quiet or fast preferences, with timed roads and turns enforced. |
| **Wheelchair** | Scheduled transit and walking in a strict wheelchair City, built with `--wheelchair`. |

**Bike** runs on a turn-aware customizable contraction hierarchy (CCH) shared by Route, Matrix and Reach. It models bicycle access, contraflow, surfaces, mapped incline, dismount sections and turn restrictions; on a dated request, it checks timed roads and turns at the moment you reach them. The preference chooses the path, while the Result reports actual cycling, walking and waiting time. Bike Reach covers departure and arrival isochrones. Bike data is optional in a City, and a worker can reopen the hierarchy from a local, source-checked cache without changing the City.

## Choose your interface

The engine, the compiler and Python open the same City directory and run the same engine. Studio builds its own Cities from the same inputs.

| Interface | Use it to | Release asset |
| :--- | :--- | :--- |
| **[Engine](docs/guides/rust-standalone.md)** (`vigo`) | Build Cities from GTFS and OpenStreetMap, then answer from the command line, a resident stream or a self-hosted [HTTP API](docs/guides/rust-standalone.md#http-api). One executable; no Node, Python or network access needed. | `VIGO-Rust-…` |
| **[Compiler](docs/guides/cli-only.md)** (`vigo.mjs`) | Build Cities and scenario collections with the engine's compiler, and query them from Node.js 24.18 or newer. | `VIGO-CLI-…` |
| **[Studio](docs/guide.md#vigo-studio)** | Explore networks, plan journeys, map Reach and edit scenarios on the desktop. No coding required. | `VIGO-Studio-…` |
| **[Python](python/README.md)** (`import vigo`) | Run studies, batches and notebooks, and export journey and leg tables. Needs Python 3.10 or newer. | `VIGO-Python-…` |

Each [release](https://github.com/hytangs/vigo/releases) packages all four, built from one commit, for Linux x64 and ARM64, macOS on Apple Silicon and Windows x64. Every archive has a `.sha256` checksum, and each release also publishes the offline guide, the OpenAPI document and a release manifest.

To plan a journey in your browser, open the [route planner](https://app.vigo.city/). To offer one for your own Cities, see the [public route planner guide](docs/guides/public-routing.md).

## Get started

[Download](https://github.com/hytangs/vigo/releases) the engine for your platform, or build it and the compiler from source with Node.js 24.18+, npm 11.6+, a C toolchain and the Rust toolchain pinned in `rust-toolchain.toml`. On a build host with 4 GiB of memory or less, the build selects [low-memory settings](docs/developer.md#build-on-a-small-machine) automatically.

```bash
git clone https://github.com/hytangs/vigo.git && cd vigo
npm ci
npm run build:cli-runtime   # the City compiler, public/vigo.mjs
npm run build:standalone    # the engine, target/release/vigo
alias vigo-build="node \"$PWD/public/vigo.mjs\""
alias vigo="\"$PWD/target/release/vigo\""
```

Build a City from a GTFS ZIP and an OpenStreetMap extract that covers it:

```bash
vigo build --gtfs ./data/transit.zip --osm ./data/streets.osm.pbf --output ./city
```

A City prepares walking and driving streets by default. Add `--street-modes walk` for a walk-and-transit City without driving data, or `--street-modes walk,bike` or `walk,drive,bike` to add cycling.

Describe a journey. Coordinates are `[longitude, latitude]`; use places and a date your data covers:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "serviceDate": "2026-10-05",
  "time": "08:00",
  "maxWalkKm": 1.2
}
```

Ask the question, or keep the City loaded and serve it:

```bash
vigo route --city ./city --request route.json
vigo serve --city ./city --port 8080
```

The service also serves the documentation, with an API console, at `http://127.0.0.1:8080/`. The [Boston quickstart](docs/guide.md#quickstart) builds a City from real MBTA and OpenStreetMap data and walks through Route, Matrix, Reach and a resident process.

## Built to be trusted

- **Exact.** VIGO searches the published timetable and the mapped streets. It samples departures only when you ask for a Monte Carlo distribution.
- **Explained.** Every answer carries its evidence: whether a walk follows mapped streets or an assumed station link, and where each geometry came from. [Known limits](docs/guide.md#known-limits) say plainly what the model does not establish.
- **Offline.** A City is one portable directory. The engine needs no Node, Python or internet connection to answer.
- **Stable.** Later releases read published Cities without rebuilding ([City format contract](docs/reference/city-format.md)), and the public `vigo.route.v1`, `vigo.matrix.v1` and `vigo.reach.v1` schemas only gain optional fields.

The VIGO paper's six-city transit benchmark, with its data and method, is published at [vigo.city](https://vigo.city/). To time your own build, see [measuring performance](docs/developer.md#measuring-performance).

## Documentation

One searchable, offline guide, [`docs/guide.html`](docs/guide.html): the page the engine serves at `/` and Studio opens under **Settings → Documentation**.

- [Guide](docs/guide.md): install, quickstart, concepts, task guides (including [bicycle](docs/guide.md#bicycle-routing) and [wheelchair](docs/guide.md#wheelchair-routing) routing), Studio, deployment, troubleshooting and a glossary.
- [Engine reference](docs/guides/rust-standalone.md): every command, flag, request field, endpoint and environment variable, with the generated [API schema](docs/reference/api-schema.md).
- [Public results](docs/reference/results.md) and [walking evidence](docs/reference/walking-evidence.md): how to read each answer and what it establishes.
- [How VIGO computes answers](docs/reference/methodology.md): the algorithms, what is exact, and what the model leaves out.
- [Monte Carlo and accessibility](docs/guides/monte-carlo.md): departure-window distributions for Route, Matrix and Reach.
- [VIGO Python](python/README.md), with a [walkthrough notebook](python/examples/walkthrough.ipynb).
- [Public route planner](docs/guides/public-routing.md): serve routing-only access to prepared Cities through a restricted gateway.
- [Developer resources](docs/developer.md#developer-resources): architecture, performance measurement and routing accuracy.

## VIGO 1.0.0

Route, Matrix and Reach run in the Rust engine for every mode, now including Bike. The engine, compiler, Studio and Python package are built and released together from one commit. API 1.0, City format 1 and Result schema 1 keep their meanings, and published Cities open without rebuilding.

[Release notes](docs/releases/1.0.0.md) · [Changelog](CHANGELOG.md) · [Prepared-data contract](docs/reference/city-format.md)

## Contribute

```bash
npm run build        # Engine kernel, Studio and the compiler
npm run studio       # Open Studio
npm test             # Public-source and engine checks
```

[Contributing](.github/CONTRIBUTING.md) lists focused checks and packaging, [architecture](docs/developer.md#architecture) explains the implementation, and the [security policy](SECURITY.md) covers reporting vulnerabilities. Python development lives in [`python/`](python/CONTRIBUTING.md) and needs no npm or Rust.

---

<p align="center"><sub>Developed by Hanyang Tang · <a href="LICENSE">Apache-2.0</a> · <a href="https://github.com/hytangs/vigo/issues">Report an issue</a><br>Routed data keeps its own terms: retain the <a href="https://www.openstreetmap.org/copyright">OpenStreetMap attribution</a> and your GTFS providers' notices when you share Cities or results.</sub></p>
