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

VIGO compiles a public transit timetable (GTFS) and an OpenStreetMap street map into a **City**, once. Then it answers, exactly and offline, how people move through it.

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

Then choose the journey with fewer boardings and less walking. Leave at 08:00 or arrive by 09:00; add stops on the way, ask for alternatives, and get every walk, wait and ride with its clocks, stops, map geometry and published fare.

## 02 — Reach

**One origin. Every possibility.**

Where can you get in 15, 30 or 45 minutes? Reach maps every place you can get to within a time budget; its boundary is an isochrone. It stretches along transit lines, as faster connections bring distant places within reach. Add a **Scenario**, such as a new line or a removed route, and measure the proposal against today's network.

## 03 — Matrix

**Ask more. Repeat less.**

A thousand destinations shouldn't mean a thousand separate searches. Matrix shares the work across compatible requests, returning travel times or journeys for each pair. An unreachable pair stays `null`, never zero.

## The performance

**Six cities. Milliseconds in every one.**

The median time for a complete coordinate-to-coordinate request, with walking access, journey selection and output included:

| Anchorage | Las Vegas | Denver | Washington, DC | Boston | New York |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **0.67 ms** | **0.94 ms** | **1.32 ms** | **1.64 ms** | **1.69 ms** | **2.11 ms** |

The lowest median end-to-end latency among all nine interfaces in the VIGO paper's matched-request benchmark. The paper, the benchmark code and the measurement method are linked from [vigo.city](https://vigo.city/).

## Put VIGO to work

Explore interactively, connect a web application, or run an analysis in Python. Every interface opens the same City and runs the same engine.

| | | |
| :--- | :--- | :--- |
| **01** | **[Studio](docs/guide.md#vigo-studio-desktop-guide)** | Interactive desktop software for exploring networks, planning journeys and mapping accessibility. No coding required. |
| **02** | **[Engine & CLI](docs/guides/rust-standalone.md)** | Millisecond-scale routing for your web apps and services, through the command line or a self-hosted [HTTP API](docs/guides/rust-standalone.md#15-http-api-and-server-operation). |
| **03** | **[Python](python/README.md)** | Routing and accessibility analysis alongside pandas, Jupyter notebooks and your existing Python tools. |
| **04** | **Public API** | Routing and accessibility for your applications, through a public API. *Coming soon.* |

## Get started

Build from source with Node.js 24.18+, npm 11.6+ and the Rust toolchain pinned in `rust-toolchain.toml`, or [download](https://github.com/hytangs/vigo/releases) a build for your platform.

```bash
git clone https://github.com/hytangs/vigo.git && cd vigo
npm ci
npm run build:cli-runtime   # the City compiler, public/vigo.mjs
npm run build:standalone    # the engine, native/target/release/vigo
alias vigo-build="node \"$PWD/public/vigo.mjs\""
alias vigo="\"$PWD/native/target/release/vigo\""
```

Build a City from a GTFS ZIP and an OpenStreetMap extract that covers it:

```bash
vigo-build build --gtfs ./data/transit.zip --osm ./data/streets.osm.pbf --output ./city
```

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

The service also serves the complete documentation at `http://127.0.0.1:8080/`, with an API console. The [Boston quickstart](docs/guide.md#quickstart) uses real MBTA and OpenStreetMap data and walks through Route, Matrix, Reach and a resident process.

## Built to be trusted

- **Exact.** VIGO searches the published timetable and the mapped streets. It does not sample departures or draw a straight line where no path is mapped.
- **Explained.** Every answer carries its evidence: whether a walk follows mapped streets or an assumed station link, and where each geometry came from. [Known limits](docs/guide.md#known-limits) say plainly what the model does not establish.
- **Offline.** A City is one portable directory. The engine is one executable that needs no Node, Python or internet connection to answer.
- **Stable.** Cities stay readable by later releases without rebuilding ([City format contract](docs/reference/format-0.5.0.md)), and the public `vigo.route.v1`, `vigo.matrix.v1` and `vigo.reach.v1` schemas only gain optional fields.

## Documentation

One searchable, offline guide, [`docs/guide.html`](docs/guide.html): the page the engine serves at `/` and Studio opens under **Settings → Documentation**.

- [Guide](docs/guide.md): install, quickstart, concepts, routing, Studio, deployment and troubleshooting.
- [Engine reference](docs/guides/rust-standalone.md): command line, request fields, HTTP API, outputs and native operations.
- [Read a Result](docs/reference/results.md) and [walking evidence](docs/reference/walking-evidence.md): what each answer establishes.
- [VIGO Python](python/README.md), with a [walkthrough notebook](python/examples/walkthrough.ipynb).
- [Developer resources](docs/developer.md#developer-resources): architecture, performance measurement and routing accuracy.

## VIGO V1

**A faster engine. From build to route.**

VIGO's next chapter brings City compilation, scenario computation and routing into one shared Rust-native engine, built for faster network preparation, larger analyses and the applications you want to create. Follow it at [vigo.city](https://vigo.city/).

The current release is VIGO 0.5.2: [release notes](docs/releases/0.5.2.md) · [changelog](CHANGELOG.md).

## Contribute

```bash
npm run build        # Engine kernel, Studio and the compiler
npm run studio       # Open Studio
npm test             # Public-source and engine checks
```

[Contributing](.github/CONTRIBUTING.md) lists focused checks and packaging, [architecture](docs/developer.md#architecture) explains the implementation, and the [security policy](SECURITY.md) covers reporting vulnerabilities. Python development lives in [`python/`](python/CONTRIBUTING.md) and needs no npm or Rust.

---

<p align="center"><sub>Developed by Hanyang Tang · <a href="LICENSE">Apache-2.0</a> · <a href="https://github.com/hytangs/vigo/issues">Report an issue</a><br>Routed data keeps its own terms: retain the <a href="https://www.openstreetmap.org/copyright">OpenStreetMap attribution</a> and your GTFS providers' notices when you share Cities or results.</sub></p>
