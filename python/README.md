# VIGO Python

**Build transport networks and query journeys, travel-time matrices, and reachable areas from Python.**

The independently versioned Python package is maintained in `python/` in the VIGO repository. Its source installation and unit tests do not require npm or Rust. See [contributing](CONTRIBUTING.md) for package and integration workflows.

VIGO Python wraps the [VIGO engine](https://github.com/hytangs/vigo). Keep a City open, run queries against its prepared network, and export results for analysis. The package imports as `vigo`.

[Quickstart](docs/guide.md#your-first-python-query) · [API reference](docs/reference.md) · [Guide](docs/guide.md) · [Examples](examples/decompose_result.py) · [Notebooks](notebooks/README.md)

## Install

Requires Python 3.10 or newer. Install the VIGO platform wheel matching your operating system and CPU, substituting its actual filename:

```bash
python -m pip install /path/to/vigo-0.5.2-py3-none-PLATFORM.whl
```

Platform wheels include the headless engine, Node, and the Rust kernel. They need no Studio installation or system Node. [Build a platform wheel](CONTRIBUTING.md#build-a-headless-wheel) from the public repositories, or use a source installation with an existing Engine through `runtime=`, `VIGO_RUNTIME`, or `VIGO_APP`.

VIGO Python **0.5.2 requires Engine 0.5**. Existing 0.5 Cities remain compatible. See [runtime selection](docs/guide.md#runtime-and-loading) and [release notes](docs/releases/0.5.2.md).

## Open a City and query

Use a complete prepared City. Coordinates are `[longitude, latitude]`; choose locations and a service date covered by your inputs.

```python
import vigo

with vigo.open("./city") as city:
    result = city.route(
        [-71.062, 42.356],
        [-71.058, 42.349],
        depart_at="08:00",
        service_date="2026-07-15",
    )
    if result.status == "ready":
        print(result.duration_minutes)
    result.export("route.json")
    result.export_tables("route-tables")
```

A `blocked` result means no usable journey under the supplied inputs and constraints. Invalid requests and execution failures raise exceptions. Transit compares direct walking by default; set `require_transit_ride=True` to require a boarding.

Keep the City open for repeated queries. With a compatible 0.5.2 engine, idle resident processes are reused across service dates; the context manager releases them when finished.

## Build once

```python
with vigo.build("./city", gtfs="./data/transit.zip", osm="./data/streets.osm.pbf") as city:
    print(city.name, city.revision_id)
```

Reopen the complete directory with `vigo.open("./city")`. Replacing an existing City requires `replace=True`. Optional `tqdm` support adds build progress; optional `orjson` support accelerates decoding. See [installation options](docs/guide.md#runtime-and-loading).

## Analyze and export

| Method | Output |
| --- | --- |
| `city.route(...)` | A journey with timed legs |
| `city.matrix(origins, destinations, ...)` | Travel times and per-pair outcomes; optional journeys and geometry |
| `city.reach(origin, ...)` | A travel-time surface and contours |
| `result.iter_journeys()` | Journey summaries, including blocked Matrix rows |
| `result.iter_legs()` | Individual legs with journey and OD identifiers; geometry is optional |
| `result.export_tables(directory)` | Journey and leg CSVs plus query provenance |

For Matrix leg analysis, request `include_journeys=True`. Iterators copy only consumed records; table exports write one record at a time and finish serialization before replacing existing files. The complete engine response is already resident in the Result. [Analysis recipe](docs/guide.md#decompose-journeys-for-analysis) · [CSV example](examples/decompose_result.py)

Planned-service scenarios support Reach, and supplied traffic supports driving Route and Matrix. Live transit is not exposed through this Python API. See [supported workflows](docs/guide.md#workflows) and the [API reference](docs/reference.md).

## Documentation and development

The [offline reader](docs/index.html) includes search and printable documentation. See [contributing](CONTRIBUTING.md) for tests, engine integration, and wheel builds, or [troubleshooting](docs/guide.md#troubleshooting) for runtime problems.

Licensed under [Apache-2.0](LICENSE).

For independent batches, `city.iter_run(queries, workers=2)` yields complete Results in input order while bounding pending work and retained responses. The default remains serial. See [concurrent batches](docs/guide.md#run-independent-queries-concurrently) for resource limits and early-exit cleanup.
