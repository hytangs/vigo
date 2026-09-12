# Command line

The VIGO command builds Cities and runs Route, Matrix, Reach, and Compare from scripts and terminals. See the [Quickstart](quickstart.md) for installation and complete examples.

This is the public VIGO Engine interface. Studio uses the same core through an internal application channel; its local HTTP endpoints are not a supported external API. Python wraps the command's contracts in the [separate Python package](https://github.com/hytangs/vigo-py). API 1.0, City format 1, and Result schema 1 remain unchanged in 0.3.1; query support is declared by `capabilities` and the [Scenario support table](scenarios.md).

| Command | Input | Output |
| --- | --- | --- |
| `build` | GTFS, OSM, output directory | A complete City |
| `capabilities` | None | Versions and supported combinations |
| `inspect` | City directory | Identity, sources, and counts |
| `route` | City, JSON request or CSV, date | Journey or batch rows |
| `matrix` | City, JSON request, date | One row per pair |
| `reach` | City, JSON request, date | Surface and contours |
| `compare` | Two saved Results | Changes without recomputation |

```bash
vigo route --city ./city --request ./route.json \
  --time 08:00 --service-date 2026-09-04 --output ./result.json
```

Use `vigo --help` for options. Query commands print JSON; `--output` also saves the Result. CSV Route batches write rows and an adjacent summary. Coordinates use `[longitude, latitude]`; stop IDs are exact GTFS identifiers.

## Results and errors

Route uses `result`, Matrix uses `rows`, Reach uses `surface` and `contours`, and Compare uses `change`. Query Results also carry `kind`, `status`, `query`, `warnings`, `timing`, and City identity.

A `blocked` Result is a valid computation without a usable journey or surface and exits zero. Invalid input, unsupported combinations, incomplete Cities, and execution failures exit nonzero with an explanation on standard error. Keep these failures separate from blocked Results in batch analysis.

See [Route](routing.md), [Matrix](matrix.md), [Reach](reach.md), and [Scenario semantics](scenarios.md) for request fields and interpretation.
