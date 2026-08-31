# VIGO documentation

[← Project overview](../README.md)

These pages document the current public source tree. VIGO—Visual Intelligence
for GTFS Operations—is an experimental platform for inspecting, compiling,
routing, and analyzing scheduled transit networks. It is still being prepared
for public release, so interfaces and file formats may change. The
documentation describes implemented behavior; it does not claim universal GTFS
support or real-world operational validity.

## Start here

| Goal | Read |
| --- | --- |
| Build VIGO and create a first workspace | [Quick Start](quickstart.md) |
| Learn the CLI from raw data to routing output | [CLI tutorials](tutorials/cli/README.md) |
| Integrate through versioned process schemas | [CLI contract](vigo-cli.md) |
| Use the loopback service | [Local HTTP API](local-http-api.md) |
| Check supported source semantics | [GTFS support matrix](gtfs-support-matrix.md) |
| Understand known boundaries | [Known routing limitations](known-routing-limitations.md) |

## User guides

- [Network and GTFS visualizer](gtfs-visualizer.md)
- [Routing](routing.md)
- [Accessibility and scenarios](accessibility.md)
- [Street routing](street-routing.md)
- [Accessibility-map export](guides/accessibility-maps.md)
- [Use cases](guides/use-cases.md)
- [All tutorials](tutorials/README.md)

## Engine and integration references

- [Algorithms](guides/algorithms.md)
- [Development architecture](development/architecture.md)
- [Module decomposition boundaries](development/module-boundaries.md)
- [Routing contract](routing-contract.md)
- [Scenario-analysis architecture](scenario-analysis-architecture.md)
- [Cache and provenance](cache-provenance.md)
- [macOS source packaging](development/macos-release.md)
- [Release history](../CHANGELOG.md)

## Reading the contracts

The support matrix defines which source semantics enter the compiled routing
model. The routing and street contracts define behavior within that model. The
limitations page records what is incomplete, approximate, platform-specific,
or intentionally unsupported. Guides are explanatory and must not override
those boundaries.

Public documentation must not include private datasets, agency-specific
projects, local filesystem paths, experiment output, credentials, or generated
archives. The changelog records public pre-releases; these pages document the
current implementation.
