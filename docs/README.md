# VIGO documentation

VIGO has one model across Studio, Python, and the command line:

```text
City -> Scenario -> Route | Matrix | Reach -> Result
```

## Getting started

- [VIGO 0.3.0 Quickstart](quickstart.md)
- [Core concepts](concepts.md)
- [VIGO 0.3.0 Developer Guide source](developer-guide/VIGO-0.3.0-Developer-Guide.tex) — build the PDF with `npm run docs:developer-guide`

## VIGO Studio

- [VIGO Studio Guide](studio.md)
- [Inspect GTFS services](gtfs-visualizer.md)

## Programmatic use

- [Command line and VIGO Python](programmatic.md)
- [Route](routing.md)
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

Product documentation does not require knowledge of internal storage or routing algorithms. Those details belong in the internal architecture pages.
