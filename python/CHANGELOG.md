# Changelog

## 1.0.0rc1

- Support VIGO V1 release candidates with explicit API and format validation.
- Publish Python metadata as `1.0.0rc1` (PEP 440), corresponding to Engine `1.0.0-rc.1`.

- Add arrive-by Reach: `city.reach(destination=..., arrive_by="08:30", ...)` maps where a destination can be reached from by a deadline. An origin with `arrive_by`, or a destination without it, raises `InvalidQuery`, as the engine does. Older runtimes whose Reach capabilities lack `arrive_by` report `arrive_by_reach` from `supports()`.
- Reach sends one request form in both directions: the origin or destination with `timePreference`. The Engine answers it in its `vigo` executable, which the bundled runtime now includes.
- `Reach.origin` and `Reach.depart_at` now default to `None`; a Reach with neither time still departs at 08:00.
- `vigo.build()` checks that its GTFS and OSM files exist and refuses an existing City without `replace=True` before starting. Progress now defaults to on in notebooks and terminals, and prints plain stage lines when `tqdm` is not installed.
- Add `City.service_period()`, the first and last dates with scheduled service.
- The walkthrough notebook builds its City from `./data` when none exists and picks a service date inside the timetable.

Earlier release records remain in Git history and the archived GitHub releases.
