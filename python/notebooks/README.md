# VIGO Python notebooks

These notebooks use the public `vigo` package and contain no stored output. They are editable examples: use your own City paths, exact points, and a service date covered by your GTFS.

| Notebook | Purpose | Read alongside |
| --- | --- | --- |
| [01 Build a City](01_build_city.ipynb) | Build once from GTFS and OSM | [Runtime and loading](../docs/guide.md#runtime-and-loading) |
| [02 Route](02_route.ipynb) | Run Route and batch Query objects | [Route reference](../docs/reference.md#route) |
| [03 Matrix](03_matrix.ipynb) | Query one or many origins | [Matrix workflow](../docs/guide.md#calculate-travel-times-to-a-common-destination) |
| [04 Reach](04_reach.ipynb) | Export a Reach Result | [Results](../docs/guide.md#reach-1) |

Install VIGO in the notebook kernel's Python environment using the [installation guide](../README.md#install). A platform wheel includes its runtime; a source install needs a compatible Engine. Build a City in notebook 01 or reuse an existing complete City, then run the other notebooks independently. Check `sys.executable` and `vigo.__file__` if the notebook imports a different environment from your terminal.

Keep one City open for repeated work and close it when finished. Inspect Matrix row status before aggregating durations; a ready Matrix can contain blocked pairs. Export full JSON alongside CSV or GeoJSON when retaining an analysis.

Before contributing a notebook, clear its outputs and execution counts, then run `python scripts/check-notebooks.py` from the repository root. That check validates notebook structure and code syntax; it does not execute the examples or validate the chosen data.
