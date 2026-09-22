# VIGO documentation

VIGO 0.4.2 combines a reusable routing engine with Studio network inspection and scenario analysis. Begin with the workflow you need; the reference pages describe the supported data and query contracts.

```text
Build a City → ask a routing question → read the Result → retain the evidence
```

New to Engine? Follow the [quickstart](guides/quickstart.md), choose a [workflow](guides/workflows.md), then learn to [read the Result](reference/results.md). For visual network work, start in [Studio](guides/studio.md) and continue to [Network](guides/network.md).

## Start here

| Goal | Guide |
| --- | --- |
| Install, build a City, and run the first query | [Quickstart](guides/quickstart.md) |
| Use the desktop and manage City sources | [Studio](guides/studio.md) |
| Inspect trips, live reports, and Ask evidence | [Network, Routes, and Ask](guides/network.md) |
| Understand City, Scenario, Query, and Result | [Core concepts](guides/concepts.md) |
| Plan an arrival, compute a matrix, or test service change | [Practical workflows](guides/workflows.md) |
| Understand status, uncertainty, and comparison | [Read and retain a Result](reference/results.md) |
| Diagnose installation, data, or unexpected results | [Troubleshooting](guides/troubleshooting.md) |
| Automate VIGO | [CLI reference](reference/programmatic.md) · [Python package](https://github.com/hytangs/vigo-py) |
| Read offline and inspect an exported Result | [Offline guide](guide.html) |

## Query and data reference

| Topic | Reference |
| --- | --- |
| Journeys, travel-time tables, and reachable places | [Route](reference/routing.md) · [Matrix](reference/matrix.md) · [Reach](reference/reach.md) |
| Planned changes and comparing results | [Scenario](reference/scenarios.md) · [Compare semantics](reference/results.md#compare-saved-results) |
| Scheduled and supplied realtime state | [Realtime routing](reference/realtime-routing.md) |
| Source semantics and prices | [GTFS support](reference/gtfs-support-matrix.md) · [Streets](reference/street-routing.md) · [Fares](reference/fares.md) |
| Interpreting an answer | [Known limits](reference/known-routing-limitations.md) · [Accuracy checks](development/routing-accuracy.md) · [Performance measurement](development/performance.md) |

## Development

[Contributing and checks](../.github/CONTRIBUTING.md) · [Architecture](development/architecture.md) · [Security](../SECURITY.md)

The [Developer Guide](developer-guide/VIGO-0.4.2-Developer-Guide.tex) is the printable engine reference. Build it with `npm run docs:developer-guide`; the PDF is also a release artifact. Current behavior belongs in the guides above. [Release notes](releases/0.4.2.md) and the [changelog](../CHANGELOG.md) preserve version history.

Engine commands, City data, and routing contracts belong here. Python installation and API details live in the [VIGO-py documentation](https://github.com/hytangs/vigo-py/tree/main/docs). Studio's internal application API is not the public integration boundary.

## Research interfaces and retained evidence

These pages describe bounded methods and prototypes, not additional everyday Studio panels or validated operational outcomes:

- [Network service assessment](research/network-service-assessment.md): measurements, reporting denominators, and model investigation.
- [LAMP running-time study](research/lamp-runtime-study.md): reading existing City reports and interpreting their limitations.
- [Operations ledger](research/agency-operations.md) and [synthetic holding replay](research/operational-replay.md): internal research APIs, approval records, and sandbox delivery.
