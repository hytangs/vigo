# Python repository consolidation

The former public `hytangs/vigo-py` repository was imported at commit `0c7752000f99e0e6316bca5af9b27e5588c0f25f` into `python/` using `git subtree add` without squashing. Its original commits remain reachable in the VIGO history. Historical tags and releases remain in the former repository; they are not renamed or republished here.

At import, the `vigo` distribution name, import name, public API and version 0.5.1 were preserved; Engine and Studio were 0.5.2. Subsequent Python versions are recorded in pyproject.toml and the package changelog. Python dependencies, packaging metadata, tests, documentation, examples and notebooks remain within this package. There is no second routing implementation and no runtime change in this migration.

Python CI runs on Python package and engine implementation/build-contract changes. It tests Python 3.10–3.13 on Linux, macOS and Windows and builds bundled wheels on the four existing platform runners. Integration builds the engine from the same checkout, stages a checksum-pinned Node runtime and verifies the installed wheel with no host Node on PATH. Release tags use `python-v<VERSION>` independently of engine `v<VERSION>` tags.

Run package commands from `python/`; engine commands run from the repository root. See CONTRIBUTING.md for exact commands. The former checkout is retained as historical reference; submit all new Python work to the VIGO repository.
