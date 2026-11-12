# VIGO compiler

The compiler, `vigo.mjs`, builds Cities and scenario collections from GTFS and OpenStreetMap, and runs Route, Matrix, Reach, Stream and Compare against them. Its `build` and `build-scenarios` run the [engine](rust-standalone.md)'s `vigo build` and `vigo build-scenarios` with the same arguments, so they write the same Cities; the engine, the compiler and Python open them.

The compiler archive (`VIGO-CLI-…`) contains `vigo.mjs`, its native routing kernel `vigo-routing-kernel.node`, the `vigo` executable it uses to build Cities and answer queries, license notices and a checksum manifest. It needs Node.js 24.18 or newer on the matching operating system and CPU, and bundles neither Node nor City data.

## Install

Extract the archive from [VIGO releases](https://github.com/hytangs/vigo/releases), keep its files together, and run:

```sh
node vigo.mjs --version
node vigo.mjs capabilities
node vigo.mjs help route
```

No npm installation, Rust compiler or Studio is needed. The guides call the compiler `vigo-build`. In a POSIX shell:

```sh
alias vigo-build='node "/absolute/path/to/vigo.mjs"'
```

On Windows, use `node .\vigo.mjs`, or define your own function. From a source checkout, `npm run build:cli-runtime` builds `public/vigo.mjs` and its kernel.

## Commands

| Command | Input | Output |
| --- | --- | --- |
| `build` | GTFS, OSM and an output directory | A complete City; its manifest on standard output |
| `build-scenarios` | A scenario source manifest | A [scenario collection](rust-standalone.md#scenario-collections) |
| `capabilities` | None | Versions and supported combinations, as JSON |
| `inspect` | A City | Identity, sources, counts and limitations |
| `route` | A City and a JSON request, or a CSV batch | A Route Result |
| `matrix` | A City and a JSON request | A Matrix Result |
| `reach` | A City and a JSON request | A Reach Result, computed by the `vigo` executable |
| `stream` | A City, and NDJSON on standard input | One Result per line from a resident process |
| `compare` | Two saved Results | Changes, without routing again |

`vigo-build help COMMAND` or `vigo-build COMMAND -h` prints every option with its default. Options accept `--name value` and `--name=value`. Unknown options, extra arguments and repeated single-value options are rejected; `--gtfs`, `--gtfs-scope` and `--prepare-date` may repeat.

## Build a City

```sh
vigo-build build --gtfs feed.zip --osm region.osm.pbf --output ./city
vigo-build inspect --city ./city
```

| Option | Meaning |
| --- | --- |
| `--gtfs PATH` | GTFS ZIP; repeat for several feeds |
| `--gtfs-scope NAME` | A unique, stable scope for each `--gtfs` |
| `--osm PATH` | OSM `.pbf` covering the City |
| `--output PATH` | The City directory to write |
| `--street-modes VALUE` | `walk,drive` (default), `walk`, `walk,bike` or `walk,drive,bike` |
| `--prepare-date YYYY-MM-DD` | Compile a service date's timetable now; repeat for other dates |
| `--private-access VALUE` | `public` (default) or `endpoints` |
| `--wheelchair` | Build a strict wheelchair City |
| `--wheelchair-streets MODE` | `inferred` (default) or `verified` street evidence for a wheelchair City |
| `--streets-from PATH` | Reuse identical prepared streets from another City |
| `--replace` | Replace an existing City |

[Build a City](../guide.md#build-a-city) explains each option, combining feeds, large regions and low-memory builds. The [quickstart](../guide.md#quickstart) has a complete Boston example. Progress goes to standard error. `vigo.mjs` runs the `vigo` executable beside it, which stages and publishes the City; set `VIGO_STANDALONE_PATH` to use another one. A signal sent to `vigo.mjs` reaches the build, and the build stops if `vigo.mjs` is killed.

## Run a query

Requests carry `serviceDate` and `time` in JSON; flags override request fields.

```sh
vigo-build route --city ./city --request route.json --output result.json
cat route.json | vigo-build route --city ./city --request - --time 08:30 > result.json
```

| Option | Commands | Meaning |
| --- | --- | --- |
| `--city PATH` | Query commands | The City |
| `--request PATH` | `route`, `matrix`, `reach` | JSON request; `-` reads standard input |
| `--output PATH` | Most commands | Save the JSON; it is also printed. `-` prints only |
| `--service-date YYYY-MM-DD` | Query commands | Service date |
| `--service-day VALUE` | Query commands | `weekday`, `saturday` or `sunday`; must agree with the date |
| `--time HH:MM` | Query commands | Clock, `00:00`–`29:59` (default `08:00`) |
| `--time-preference depart\|arrive` | `route`, `matrix`, `reach` | Time direction; JSON also accepts `depart_at` and `arrive_by` |
| `--mode VALUE` | `route`, `matrix`, `reach` | `transit` (default), `walk`, `drive` or `bike` |
| `--objective earliest_arrival` | `route`, `matrix`, `reach` | The only objective |
| `--max-walk KM` | Query commands | Walking budget (default 1.2) |
| `--max-transfers N` | `route`, `matrix`, `reach` | Transfer cap, 0–31 |
| `--horizon MIN` | `route`, `matrix` | Timetable horizon, 1–2880 (default 480) |
| `--departure-window MIN` | `route` | Centered depart-at window, ±0–30 whole minutes |
| `--alternatives N`, `--alternative-ranking` | `route` | Additional transit journeys and their ranking |
| `--data-mode scheduled\|realtime` | `route` | Realtime needs a `realtimeSnapshot` in the request |
| `--cutoffs`, `--extent-radius`, `--raster-size`, `--walk-speed`, `--street-edges` | `reach` | Reach options |
| `--input PATH` | `route` | A CSV batch of transit journeys; needs `--output` |
| `--wheelchair` | Query commands | Require a wheelchair City |
| `--diagnostics LEVEL` | Query commands | `none`, `summary`, `profile` or `trace` |
| `--format text\|json` | `route`, `matrix`, `reach` | Terminal text or JSON |
| `--include-geometry`, `--include-limitations` | Query commands | Output detail |

Request files and standard input share a 16 MiB limit, and `--request -` reads until the producer closes standard input. Results go to standard output; progress and errors to standard error. Saved output is written to a temporary file and renamed, so a failed run can leave an older file in place: check the exit code. Exit 0 means a Result, including `not_found`; exit 2 means invalid input or a failure.

The request format is the engine's, documented in the [engine reference](rust-standalone.md#request-basics), with these differences:

| Feature | Compiler | Engine |
| --- | --- | --- |
| Matrix size | 100,000 pairs in 16 MiB | 65,536 pairs in 8 MiB |
| Departure windows | `departureWindowMinutes`, centered ±0–30 | `windowMinutes`, later departures or earlier deadlines |
| Realtime | Route only | Route, Matrix and Reach |
| Planned scenarios | Reach | Reach and transit Route |
| Reach raster sizes | 48, 64, 96, 128, 192, 256, 384, 512 or 1024 | Any integer 16–1024 |
| Compare | Route, Matrix and Reach | Reach |
| CSV route batches | `--input` | Not available |

Matrix points may also use the older `{"id": "a", "point": "A"}` form, which the engine rejects. CSV batches take columns `id`, `origin_lon`, `origin_lat`, `destination_lon`, `destination_lat`, or `origin_stop_id` and `destination_stop_id`, with optional `origin_name` and `destination_name`.

## Keep the compiler resident

`stream` reads one request per line, each with a `kind` (`route`, `matrix` or `reach`) and an optional `id`, and keeps the City prepared between lines. Each line may choose its own `serviceDate`; `--service-date` only sets the default.

```jsonl
{"id":"outbound","kind":"route","origin":{"stopId":"A"},"destination":{"stopId":"B"},"serviceDate":"2026-10-05","time":"08:00"}
{"id":"times","kind":"matrix","origins":[{"stopId":"A"}],"destinations":[{"stopId":"B"}],"serviceDate":"2026-10-05","time":"08:00"}
```

```sh
vigo-build stream --city ./city < queries.ndjson > results.ndjson
```

Responses echo `id`, add `sequence`, and keep input order. A failed line returns `status: "error"` and later lines still run; read every status, even on exit 0. `--workers N` (1–4, default 1) runs several resident workers, capped by CPU and memory (two CPUs and 6 GiB each); each loads its own City. `--stream-output detailed` returns the internal trace envelope.

## Compare saved Results

```sh
vigo-build compare --before before.json --after after.json --output change.json
```

Both Results must be from the same query family; Reach Results must share a grid. Changes are after minus before. See [Compare saved results](../reference/results.md#compare-saved-results).

## Package and verify

From a source checkout, `npm run package:cli` builds the archive and `npm run check:cli-package` tests the extracted copy. Archives are specific to their platform; keep the manifest when reporting a problem.

For an HTTP service, use [the engine](../guide.md#deploy-the-routing-engine). For notebooks and batches, use [VIGO Python](https://github.com/hytangs/vigo/tree/main/python/docs).
