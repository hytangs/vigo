# Changelog

## 1.0.0 — 2026-11-08

VIGO Python 1.0.0 supports Engine 1.0 (API 1.0, City format 1, Result schema 1) and publishes its metadata as `1.0.0` (PEP 440). Existing API defaults are unchanged.

### Building Cities

- `vigo.build()` runs the engine executable shipped with the runtime, which compiles the City in Rust without starting Node. Runtimes whose engine cannot build, such as Engine 0.5, still build through the runtime.
- `vigo.build(..., prepare_dates=[...])` compiles those service dates' timetables into the City, so their first queries need no preparation.
- `vigo.build()` checks that its GTFS and OSM files exist and refuses an existing City without `replace=True` before starting. Progress defaults to on in notebooks and terminals, and prints plain stage lines when `tqdm` is not installed.
- Bike-enabled builds: `street_modes="walk,bike"` or `"walk,drive,bike"`. Existing build defaults stay unchanged.

### Queries

- Opt-in Bike Route, Matrix and Reach, with profile, speed and stress options.
- Monte Carlo Route, Matrix and Reach through the resident Rust engine, including planned services and accessibility indicators. Distributions keep provenance and unreachable outcomes, export row-wise CSV, and compare marginal percentiles without constructing a second result table.
- Arrive-by Reach: `city.reach(destination=..., arrive_by="08:30", ...)` maps where a destination can be reached from by a deadline. An origin with `arrive_by`, or a destination without it, raises `InvalidQuery`, as the engine does. Older runtimes whose Reach capabilities lack `arrive_by` report `arrive_by_reach` from `supports()`. `Reach.origin` and `Reach.depart_at` default to `None`; a Reach with neither time still departs at 08:00.
- Transit uses one exact connection scan. GTFS frequency entries (`exact_times=0`) are fixed departures every headway, so Monte Carlo takes one sample per departure minute for them; only planned Scenario frequency services are randomly phased.
- `City.service_period()` returns the first and last dates with scheduled service.
- A query that needs a feature an older runtime lacks fails before it starts.

### Errors

- Clearer messages for a missing City directory, a scenario collection opened as a City, an incomplete City, a runtime path that does not exist, and a Route without `depart_at=` or `arrive_by=`.

### Packaging

- Platform wheels bundle Engine 1.0.0 from the same source commit: private Node, `vigo.mjs`, the native kernel and the `vigo` engine executable, which answers Reach and builds Cities. The engine includes bounded bicycle and driving searches and crash-safe City replacement.
- The walkthrough notebook builds its City from `./data` when none exists and picks a service date inside the timetable.

Earlier release records remain in Git history and the archived GitHub releases.
