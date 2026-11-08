# Changelog

## 1.0.0 — 2026-11-08

- Publish Python metadata as `1.0.0` (PEP 440), corresponding to Engine `1.0.0`. Bundled wheels include the engine's faster bounded bicycle and driving searches and crash-safe City replacement.
- The Python API and defaults are unchanged.


- Add opt-in Bike Route, Matrix and Reach, with profile, speed and stress options, and bike-enabled City builds. Existing build defaults stay unchanged.
- Add Monte Carlo Route, Matrix and Reach through the resident Rust engine, including planned services and accessibility indicators.
- Preserve distribution provenance and unreachable outcomes; add row-wise CSV export and marginal-percentile comparisons without constructing a second result table.
- Fail before starting a query when an older runtime lacks the requested feature.


- Publish Python metadata as `1.0.0` (PEP 440), corresponding to Engine `1.0.0`.


- Publish Python metadata as `1.0.0` (PEP 440), corresponding to Engine `1.0.0`.


- Support VIGO 1.0 with explicit API and format validation.
- Publish Python metadata as `1.0.0` (PEP 440), corresponding to Engine `1.0.0`.

- Add arrive-by Reach: `city.reach(destination=..., arrive_by="08:30", ...)` maps where a destination can be reached from by a deadline. An origin with `arrive_by`, or a destination without it, raises `InvalidQuery`, as the engine does. Older runtimes whose Reach capabilities lack `arrive_by` report `arrive_by_reach` from `supports()`.
- Reach sends one request form in both directions: the origin or destination with `timePreference`. The Engine answers it in its `vigo` executable, which the bundled runtime now includes.
- `Reach.origin` and `Reach.depart_at` now default to `None`; a Reach with neither time still departs at 08:00.
- `vigo.build()` checks that its GTFS and OSM files exist and refuses an existing City without `replace=True` before starting. Progress now defaults to on in notebooks and terminals, and prints plain stage lines when `tqdm` is not installed.
- Add `City.service_period()`, the first and last dates with scheduled service.
- The walkthrough notebook builds its City from `./data` when none exists and picks a service date inside the timetable.

Earlier release records remain in Git history and the archived GitHub releases.
