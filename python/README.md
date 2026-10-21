# VIGO Python

**Transit journeys, travel-time matrices, and reachable areas from Python, computed on your own machine.**

VIGO Python is the Python interface to the [VIGO routing engine](https://github.com/hytangs/vigo). Build a City once from GTFS timetables and OpenStreetMap streets, then ask it questions from scripts and notebooks: how to make a journey, how long every trip takes, how far people can get, and what a service change would do. Every answer is a `Result` you can inspect, compare, and export to JSON, GeoJSON, or journey and leg tables.

The package imports as `vigo`. It is versioned separately from the engine: **VIGO Python 0.5.2 requires Engine 0.5** and opens any City built with VIGO 0.5.

[Quickstart](docs/guide.md#your-first-python-query) · [Walkthrough notebook](examples/walkthrough.ipynb) · [Guide](docs/guide.md) · [API reference](docs/reference.md) · [Release notes](docs/releases/0.5.2.md)

## Install

Python 3.10 or newer. Install the platform wheel for your operating system and CPU from the releases, substituting its filename:

```bash
python -m pip install "/path/to/vigo-0.5.2-py3-none-PLATFORM.whl[speed]"
python -c "import vigo; print(vigo.__version__, vigo.resolve_runtime().product_version)"
```

Platform wheels include the headless engine, so they need no Studio, system Node, or Rust. The optional extras are `speed` (faster JSON decoding with orjson) and `progress` (build progress with tqdm). From a source checkout, `python -m pip install -e .` installs the wrapper alone; point `VIGO_RUNTIME` at an Engine 0.5 runtime, or [build a platform wheel](CONTRIBUTING.md#build-a-headless-wheel). [Runtime selection](docs/guide.md#select-a-runtime) covers every option.

## Your first journey

This uses the Boston City from the [Engine quickstart](https://github.com/hytangs/vigo/blob/main/docs/guide.md#quickstart). Coordinates are `[longitude, latitude]`, and the date must be one your feed covers:

```python
import vigo

with vigo.open("./boston") as city:
    result = city.route(
        [-71.11902, 42.37334],   # Harvard Square
        [-71.05524, 42.35227],   # South Station
        depart_at="08:00",
        service_date="2026-10-05",
        require_transit_ride=True,
    )
    if result.status == "ready":
        print(f"{result.duration_minutes:.0f} minutes")
        for leg in result.legs:
            print(leg["type"], leg.get("fromName"), "->", leg.get("toName"))
    else:
        print("No journey under these constraints.")
    result.export("route.json")
```

`blocked` is a valid answer: no journey satisfies the date, walking limit, transfer cap, and horizon you asked for. Invalid requests and failed operations raise `vigo.VigoError`. Transit competes with a direct walk unless you set `require_transit_ride=True`.

## One City, three questions

```python
import vigo

homes = {"harvard": [-71.11902, 42.37334], "kendall": [-71.08618, 42.36249]}
work = {"south-station": [-71.05524, 42.35227]}

with vigo.open("./boston") as city:
    morning = city.matrix(homes, work, arrive_by="09:00", service_date="2026-10-05")
    for row in morning.rows:
        print(row["originId"], row["status"], row["durationMinutes"])

    reach = vigo.Reach(homes["harvard"], depart_at="08:00", service_date="2026-10-05",
                       cutoffs_minutes=(15, 30, 45))
    today = city.run(reach)
    today.export("reach.geojson")

    proposal = city.scenario("Crosstown", services=[{
        "operation": "add",
        "name": "Crosstown",
        "stops": [{"label": "Harvard", "coordinate": homes["harvard"]},
                  {"label": "Copley", "coordinate": [-71.07758, 42.34997]}],
        "headwayMinutes": 10, "startMinutes": 420, "endMinutes": 600, "averageSpeedKph": 20,
    }])
    print(today.compare(proposal.run(reach)).value)
```

| Call | Returns |
| --- | --- |
| `city.route(origin, destination, ...)` | A journey with timed legs; `arrive_by`, waypoints, and `alternatives` are options |
| `city.matrix(origins, destinations, ...)` | One row per pair with its own `ready` or `blocked` status; journeys are optional |
| `city.reach(origin, ...)` | A travel-time surface with GeoJSON contours; `destination=` with `arrive_by=` maps where a place is reached from by a deadline |
| `city.scenario(name, services=...)` | Planned service for Reach, or supplied traffic for driving Route and Matrix |
| `before.compare(after)` | Changes between two compatible Results, without routing again |
| `city.iter_run(queries, workers=2)` | Complete Results in input order with bounded concurrency |
| `result.export_tables(directory)` | `journeys.csv`, `legs.csv`, and a provenance record |

Results use service-day **minutes**; the engine's public CLI and HTTP JSON use seconds and `ok`/`not_found`. A completed Matrix can contain blocked pairs, so check `status` before averaging, and an arrive-by duration runs to the deadline, including any wait. [Reading Results](docs/guide.md#results) explains every field.

## Build a City

```python
import vigo

with vigo.build("./boston", gtfs="./data/MBTA_GTFS.zip", osm="./data/boston.osm.pbf") as city:
    print(city.name, city.revision_id)
```

Build once, then reopen the directory with `vigo.open()` in later sessions; replacing an existing City requires `replace=True`. Keep the whole directory, and keep the original GTFS and OSM files for reproducibility.

## Performance

Keep one City open for repeated work: the first query starts a resident engine and later queries reuse it, across service dates. Request Matrix journeys and geometry only when you need them. For independent batches, start with `workers=2` and measure; each worker is a separate engine process, and the City caps concurrency by CPU and memory, including Linux cgroup limits. See [runtime and loading](docs/guide.md#runtime-and-loading) and [concurrent batches](docs/guide.md#run-independent-queries-concurrently).

## Examples and documentation

- **[Walkthrough notebook](examples/walkthrough.ipynb)**: a complete study, from opening a City to a reproducible record. [How to run it](examples/README.md).
- **[`decompose_result.py`](examples/decompose_result.py)**: journey and leg tables from a saved Result on the command line.
- **[Guide](docs/guide.md)** and **[API reference](docs/reference.md)**, also readable offline in [`docs/index.html`](docs/index.html) and as part of the [VIGO guide](https://github.com/hytangs/vigo/tree/main/docs) that the engine and Studio bundle.
- **[Troubleshooting](docs/guide.md#troubleshooting)** for runtime, City, and date problems.

## Contributing

Python development needs no npm or Rust; engine integration and bundled wheels use the root build. Read [contributing](CONTRIBUTING.md) for checks and wheel builds, the [migration notes](MIGRATION.md) for the repository history, and the [security policy](SECURITY.md) to report a vulnerability. Licensed under [Apache-2.0](LICENSE).
