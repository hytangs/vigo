# VIGO Python examples

Runnable examples for the public `vigo` package. They use only the documented API and store no outputs.

| Example | What it shows | Read alongside |
| --- | --- | --- |
| [Walkthrough notebook](walkthrough.ipynb) | One City, end to end: build or open, Route (arrive-by and alternatives), Matrix with blocked pairs, journey and leg tables, Reach and GeoJSON, a Scenario comparison, parallel and outcome-keeping batches, and a reproducible study record | [Workflows](../docs/guide.md#workflows) |
| [`decompose_result.py`](decompose_result.py) | Turn a saved Route or Matrix JSON into journey and leg CSV tables from the command line | [Decompose journeys](../docs/guide.md#decompose-journeys-for-analysis) |

## Run the walkthrough

Install VIGO Python V1 with a VIGO V1 runtime ([installation](../docs/guide.md#your-first-python-query)) and Jupyter in the same environment:

```sh
python -m pip install "/path/to/vigo-1.0.0rc2-py3-none-PLATFORM.whl[speed]" jupyterlab
jupyter lab examples/walkthrough.ipynb
```

Substitute your platform wheel's filename, or use an editable install with `VIGO_RUNTIME` from a source checkout. If the notebook imports a different environment from your terminal, compare `sys.executable` and `vigo.__file__`.

The notebook opens `./boston` if it exists. Otherwise it builds it from `./data/MBTA_GTFS.zip` and `./data/massachusetts-latest.osm.pbf`, downloaded as in the [Engine quickstart](https://github.com/hytangs/vigo/blob/main/docs/guide.md#quickstart), and prints each build stage. Edit the paths in its first cell, or set environment variables before starting Jupyter:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VIGO_CITY` | `./boston` | A complete City directory; built here if it does not exist |
| `VIGO_GTFS`, `VIGO_OSM` | `./data/MBTA_GTFS.zip`, `./data/massachusetts-latest.osm.pbf` | Raw inputs, read only to build a missing City |
| `VIGO_SERVICE_DATE` | First Tuesday of the timetable | A date covered by your feed's calendars |
| `VIGO_PLACES` | Boston points | JSON object with `harvard`, `kendall`, `south-station`, and `copley` as `[longitude, latitude]` |
| `VIGO_OUTPUT` | `./outputs` | Where Results, tables, and the study record are written |

Results are scheduled timetable models, not observed journeys. Keep the City open for the session and close it at the end, as the notebook does.

## Export tables from a saved Result

```sh
python examples/decompose_result.py result.json --kind matrix --output tables
```

The script writes `journeys.csv`, `legs.csv`, and `record.json`. For Matrix legs, the original query needs `include_journeys=True`.

## Contribute an example

Clear outputs and execution counts, then run `python scripts/check-notebooks.py` from `python/`. The check validates notebook structure, compiles every cell, and confirms the walkthrough still covers its documented steps; it does not execute routing. Before changing the walkthrough, run it against a real City, such as the synthetic fixture described in [contributing](../CONTRIBUTING.md#engine-integration).
