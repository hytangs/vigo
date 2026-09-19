# VIGO documentation

VIGO Engine, Studio, and the [separate Python interface](https://github.com/hytangs/vigo-py/tree/main/docs) share the **City → Scenario → Query → Result** model. Start with the interface you use.

| Task | Start here |
| --- | --- |
| Build a City and run your first queries | [CLI quickstart](quickstart.md) |
| Import data and work on the map | [Studio guide](studio.md) |
| Inspect live service or ask about a route | [Network, Routes, and Ask](agency.md) |
| Learn the model | [Core concepts](concepts.md) |
| Inspect an exported Result offline | [Interactive guide and Result viewer](guide.html) |
| Review this release | [VIGO 0.4.0](releases/0.4.0.md) · [Version history](../CHANGELOG.md) |

## Queries and data

- [Command-line reference](programmatic.md)
- [Route](routing.md), [Matrix](matrix.md), and [Reach](reach.md)
- [Scenarios and comparison](scenarios.md)
- [Realtime and scheduled routing](REALTIME-ROUTING.md)
- [GTFS support](gtfs-support-matrix.md), [street routing](street-routing.md), and [fares](fares.md)
- [Known limits](known-routing-limitations.md), [routing accuracy checks](routing-accuracy.md), and [performance](performance.md)

## Studio

- [Manage City sources](studio.md#data-sources)
- [Inspect GTFS services and playback](gtfs-visualizer.md)
- [Line diagrams and vehicle timing](ROUTE-LINE.md)
- [Shared network selection](network-workspace.md)

## Development and research

- [Contributing and verification](../.github/CONTRIBUTING.md)
- [Developer Guide source](developer-guide/VIGO-0.4.0-Developer-Guide.tex) — build the PDF with `npm run docs:developer-guide`
- [Architecture](development/architecture.md) and [algorithms](guides/algorithms.md)
- [Use cases](guides/use-cases.md)
- [Network service assessment](network-service-assessment.md)
- [Operations ledger](agency-operations.md) and [synthetic replay](operational-replay.md)
- [LAMP historical running-time study](lamp-runtime-study.md)

The research APIs and studies have their own evidence limits; they do not establish field prediction accuracy or operational suitability.
