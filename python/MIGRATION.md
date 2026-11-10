# Python repository consolidation

The former public `hytangs/vigo-py` repository was imported at commit `0c7752000f99e0e6316bca5af9b27e5588c0f25f` into `python/` using `git subtree add` without squashing. Its original commits remain reachable in the VIGO history. Historical tags and releases remain in the former repository; they are not renamed or republished here.

The `vigo` distribution name, import name and public API were preserved during consolidation. Current V1 package versions are recorded in pyproject.toml and the package changelog. Python dependencies, packaging metadata, tests, documentation, examples and notebooks remain within this package. There is no second routing implementation and no runtime change in this migration.

Python checks run on Python package changes and test Python 3.10–3.13 on Linux, macOS and Windows. The Release workflow builds bundled wheels on the four platform runners from the same checkout as the engine, stages a checksum-pinned Node runtime and verifies the installed wheel with no host Node on PATH. Engine and Python publish together under the engine `v<VERSION>` tag.

Run package commands from `python/`; engine commands run from the repository root. See CONTRIBUTING.md for exact commands. The former checkout is retained as historical reference; submit all new Python work to the VIGO repository.
