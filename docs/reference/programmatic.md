# Command line

The VIGO command builds Cities and runs Route, Matrix, Reach, and Compare from scripts and terminals. See the [Quickstart](../guides/quickstart.md) for installation and complete examples.

This is the public VIGO Engine interface. Studio uses the same core through an internal application channel; its local HTTP endpoints are not a supported external API. Python wraps the command's contracts in the [separate Python package](https://github.com/hytangs/vigo-py). API 1.0, City format 1, and Result schema 1 remain unchanged in 0.4.2; query support is declared by `capabilities` and the [Scenario support table](scenarios.md).

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
  --time 08:00 --service-date YYYY-MM-DD --output ./result.json
```

Use `vigo` for a short command overview, then `vigo help route` or `vigo route -h` for that command’s options and request examples. `--version` and `-V` print the version. Both `--name value` and `--name=value` are accepted. Unknown options, extra positional arguments, and repeated single-value options are rejected. Only `--gtfs` and `--gtfs-scope` repeat.

Query commands print JSON; `--output` also saves the Result. `inspect` can save its JSON with the same option. CSV Route batches write rows to `--output` and print their JSON summary to stdout. Coordinates use `[longitude, latitude]`; stop IDs are exact GTFS identifiers.

## Shell pipelines

Route, Matrix, and Reach accept a single JSON object from stdin:

```bash
cat route.json | vigo route --city ./city --request - \
  --time 08:00 --service-date YYYY-MM-DD > result.json
```

Request files and stdin share the 16 MiB limit. A UTF-8 byte-order mark is accepted. `--request -` reads until the producer closes stdin; in an interactive terminal, provide a file or pipe instead. It does not infer the service date or read questions in natural language.

For JSON results, omit `--output` or use `--output -` to write only to stdout. Progress and errors go to stderr, so they do not corrupt redirected JSON. Closing a pipe early, as with `vigo capabilities | head`, does not print a stack trace.

Saved JSON and CSV files are staged beside their destination and renamed after a complete write. Existing Unix permission bits are preserved; a failed write leaves the previous file in place. This applies to result files; City builds retain their existing staged publication process.

CSV batches require `--input` and an output file, support transit only, and cannot be combined with `--request`. Use a JSON request for walking or driving. Reach uses `--cutoffs` to bound the surface; `--horizon` applies to Route and Matrix.

## Results and errors

Route uses `result`, Matrix uses `rows`, Reach uses `surface` and `contours`, and Compare uses `change`. Query Results also carry `kind`, `status`, `query`, `warnings`, `timing`, and City identity.

A `blocked` Result is a valid computation without a usable journey or surface and exits zero. Invalid input, unsupported combinations, incomplete Cities, and execution failures exit 2 with a short explanation and a command-help hint on stderr. Failed commands do not print a JSON result. Keep these failures separate from blocked Results in batch analysis.

See [Route](routing.md), [Matrix](matrix.md), [Reach](reach.md), and [Scenario semantics](scenarios.md) for request fields. [Read and retain a Result](results.md) covers per-row outcomes, diagnostics, reproducibility, and the exact limits of `compare`. [Practical workflows](../guides/workflows.md) shows complete request files and commands.

## Headless Python distribution

VIGO-py platform wheels can package Node, the CLI bundle, and the shared Rust kernel without Studio. The resident protocol advertises support per query family. Explicit `kind: "route"` and `kind: "reach"` messages call the same validation and computation functions as their one-shot commands; Matrix retains its shared executor. Processes prepare each requested mode lazily for one City and service date. `openMs` is zero after that mode has been prepared. The legacy transit stream response remains compatible with older clients.

Supplied traffic for Drive Route and Drive Matrix requires explicit realtime mode and the advertised `suppliedTraffic` capability. Scheduled analysis continues to ignore observation state. The Python interface selects realtime mode when a traffic Scenario is supplied. This distribution still uses Node for orchestration and itinerary object assembly; it is not a direct Python/Rust binding.
