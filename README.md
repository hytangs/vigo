<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/vigo-mark-dark.png">
    <img src="public/vigo-mark-transparent.png" width="104" alt="VIGO">
  </picture>
</p>

<h1 align="center">VIGO</h1>

<p align="center">
  <strong>Visual Intelligence for GTFS Operations.</strong>
</p>

<p align="center">
  <a href="#build-from-source">Build from source</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

VIGO—Visual Intelligence for GTFS Operations—is an experimental platform for
inspecting, compiling, routing, and analyzing scheduled public-transit
networks. This repository is the public home of the VIGO project. The codebase
is currently being prepared for public release.

The workbench brings feed inspection, network visualization, routing,
accessibility, and service-scenario analysis together over one set of compiled
network stores. A native Rust kernel owns timetable and street-network
computation; the local API, command-line interface, and workbench use that same
kernel rather than separate routing implementations.

> [!IMPORTANT]
> VIGO is pre-release software. Interfaces, file formats, supported platforms,
> and routing behavior may change before the first supported public release.
> Do not use it for safety-critical, operational, or passenger-information
> systems without independent validation.

## Capabilities

- Compile static GTFS schedules into local SQLite routing stores.
- Inspect routes, stops, service patterns, and schedule coverage in a local
  workbench.
- Build directed walking and driving graphs from OpenStreetMap PBF extracts.
- Route fixed-departure and arrive-by scheduled journeys.
- Produce one-to-many matrices and accessibility ranges.
- Apply query-scoped service scenarios without mutating the source timetable.
- Use VIGO through a local CLI, loopback HTTP API, or web workbench.

The [public smoke benchmark](benchmarks/README.md) provides a deterministic,
cache-disabled measurement path with input hashes, preparation time, warm
p50/p95, memory, disk, and path checksums. It is intentionally a small pipeline
check rather than a city-scale performance claim.

VIGO models the data it is given. It does not predict ridership, certify an
agency schedule, or establish operational feasibility. See the
[GTFS support matrix](docs/gtfs-support-matrix.md) and
[known limitations](docs/known-routing-limitations.md) before interpreting a
result.

## Repository scope

This public repository contains the VIGO workbench, native Rust computation
kernel, JavaScript integration, build and packaging tools, focused tests, and
current technical documentation. It intentionally excludes:

- publication sources, identities, and generated validation output;
- private datasets, agency-specific projects, local paths, and generated
  experiment output;
- internal performance suites, experimental harnesses, debug scripts, and one-off repair
  tools;
- release archives, generated binaries, notebooks, and language bindings.

Python bindings are a separate project. They may invoke a packaged VIGO
runtime, but no Python package or second routing implementation belongs in this
repository.

## Build from source

The currently configured source targets are Apple-silicon macOS 13.5 or newer,
Linux x64, and Windows x64. You need Git, Node.js 24.18.0 or newer, npm 11.6.2,
and rustup; `rust-toolchain.toml` pins Rust, Clippy, and rustfmt. The repository's
`.nvmrc`, package metadata, install preflight, and CI use the Node 24 baseline.
Linux requires a GNU C toolchain; Windows requires the MSVC build tools. The
packaged desktop artifact remains Apple-silicon macOS-only.

```bash
git clone https://github.com/hytangs/vigo.git
cd vigo
npm ci
npm run build
npm test
npm run dev
```

The workbench opens at <http://127.0.0.1:5178> and the loopback API listens at
<http://127.0.0.1:5179>. Python is not required.

For a slower, explicit walkthrough, including raw GTFS and OSM inputs, read the
[Quick Start](docs/quickstart.md). The [CLI tutorials](docs/tutorials/cli/README.md)
cover network compilation, routing, matrices, and NDJSON streaming.

## Interfaces

| Interface | Entry point | Reference |
| --- | --- | --- |
| CLI | `npm run cli -- --help` after `npm run build` | [CLI contract](docs/vigo-cli.md) |
| HTTP | `npm run api` | [Local HTTP API](docs/local-http-api.md) |
| Workbench | `npm run dev` | [Quick Start](docs/quickstart.md) |
| Native kernel | `native/vigo-routing-kernel/` | [Architecture](docs/development/architecture.md) |

The HTTP service is designed for loopback use. It is not a hardened public
network service.

## Verification

The public tree has three useful gates:

```bash
npm test                 # public-boundary and development checks
npm run check:release    # extended portable release checks
npm run release:macos    # build and verify the standalone macOS archive
```

`npm run check:public` rejects excluded publication material, archives,
notebooks, private paths, experimental harnesses, and common secret
formats. Tests validate the declared software contract; they are not evidence
of real-world service quality or universal GTFS support.

## Project layout

| Path | Purpose |
| --- | --- |
| `native/vigo-routing-kernel/` | Rust timetable, street, and accessibility kernel |
| `server/` | Local API, workers, stores, and response shaping |
| `src/` | React workbench |
| `scripts/` | Supported builds, packaging, and focused verification |
| `docs/` | Current user and technical documentation |

Generated output belongs in ignored directories such as `dist/`, `dist-cli/`,
`release/`, and Cargo `target/`; it must not be committed.

## Contributing

VIGO is still being prepared for public collaboration. Small, focused issues
and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
changing routing behavior or data formats.

## License

VIGO is licensed under the [Apache License 2.0](LICENSE). Third-party
attributions are retained in [NOTICE](NOTICE) and beside vendored dependencies.
