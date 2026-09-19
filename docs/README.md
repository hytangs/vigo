# VIGO documentation

VIGO 0.4.0 combines a reusable routing engine with Studio network inspection and scenario analysis. Begin with the workflow you need; the reference pages describe the supported data and query contracts.

## Start here

| Goal | Guide |
| --- | --- |
| Install, build a City, and run the first query | [Quickstart](quickstart.md) |
| Use the desktop and manage City sources | [Studio](studio.md) |
| Inspect trips, live reports, and Ask evidence | [Network, Routes, and Ask](network.md) |
| Understand City, Scenario, Query, and Result | [Core concepts](concepts.md) |
| Automate VIGO | [CLI reference](programmatic.md) · [Python package](https://github.com/hytangs/vigo-py) |
| Read offline and inspect an exported Result | [Offline guide](guide.html) |

## Query and data reference

| Topic | Reference |
| --- | --- |
| Journeys, travel-time tables, and reachable places | [Route](routing.md) · [Matrix](matrix.md) · [Reach](reach.md) |
| Planned changes and comparing results | [Scenario and Compare](scenarios.md) |
| Scheduled and supplied realtime state | [Realtime routing](realtime-routing.md) |
| Source semantics and prices | [GTFS support](gtfs-support-matrix.md) · [Streets](street-routing.md) · [Fares](fares.md) |
| Interpreting an answer | [Known limits](known-routing-limitations.md) · [Accuracy checks](routing-accuracy.md) · [Performance measurement](performance.md) |

## Development

[Contributing and checks](../.github/CONTRIBUTING.md) · [Architecture](development/architecture.md) · [Security](../SECURITY.md)

The [Developer Guide](developer-guide/VIGO-0.4.0-Developer-Guide.tex) is the printable engine reference. Build it with `npm run docs:developer-guide`; the PDF is also a release artifact. Current behavior belongs in the guides above. [Release notes](releases/0.4.0.md) and the [changelog](../CHANGELOG.md) preserve version history.

## Research interfaces and retained evidence

These pages describe bounded methods and prototypes, not additional everyday Studio panels or validated operational outcomes:

- [Network service assessment](network-service-assessment.md): measurements, reporting denominators, and model investigation.
- [LAMP running-time study](lamp-runtime-study.md): a retrospective holdout against reconstructed events, with retained sources and exclusions.
- [Operations ledger](agency-operations.md) and [synthetic holding replay](operational-replay.md): internal research APIs, approval records, and sandbox delivery.
