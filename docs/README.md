# VIGO Agency documentation

Start with the [Agency guide](agency.md) for the current **Overview → Routes → Ask** workspace. Agency reuses VIGO's routing platform; the inherited platform guides below describe its City, Scenario and Result model.

```text
City -> Scenario -> Route | Matrix | Reach -> Result
```

## Agency

- [Use Overview, Routes and Ask](agency.md)
- [Shared network workspace and selection](network-workspace.md)
- [Operational checks and model-written briefings](ASK-CHECKED-ASSESSMENTS.md)
- [Line diagrams and station boards](ROUTE-LINE.md)
- [LAMP historical running-time study](lamp-runtime-study.md)

## Routing platform

- [VIGO 0.3.2 Quickstart](quickstart.md)
- [Interactive guide and Result viewer](guide.html)
- [Core concepts](concepts.md)
- [VIGO 0.3.2 Developer Guide source](developer-guide/VIGO-0.3.2-Developer-Guide.tex) — build the PDF with `npm run docs:developer-guide`

## Studio

- [VIGO Studio Guide](studio.md)
- [Inspect GTFS services](gtfs-visualizer.md)

## Programmatic use

- [Command line](programmatic.md)
- [Route](routing.md)
- [Routing accuracy checks](routing-accuracy.md)
- [Matrix](matrix.md)
- [Reach](reach.md)

## Data

- [GTFS support](gtfs-support-matrix.md)
- [OSM street routing](street-routing.md)
- [Known limits](known-routing-limitations.md)

## Advanced

- [Scenario semantics](scenarios.md)
- [Performance](performance.md)
- [Internal architecture](development/architecture.md)

## Research and retained evaluations

These records describe their dated implementation and fixtures, not the current app configuration or a production accuracy guarantee.

- [Operations ledger API prototype](agency-operations.md) and [synthetic replay](operational-replay.md) — outside everyday navigation
- [September 13 delivery archive](DELIVERY.md) and [architecture audit](ARCHITECTURE-AUDIT.md)
- [September 14 local-model evaluation](agency-intelligence-evaluation.md)
- [September 15 broad Ask audit](ASK-AUDIT-2026-09-15.md)
- [Checked-assessment follow-up and limits](ASK-CHECKED-ASSESSMENTS.md#evidence-and-limits)

Product documentation does not require knowledge of internal storage or routing algorithms. Those details belong in the internal architecture pages.
