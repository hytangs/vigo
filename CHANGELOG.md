# Version history

## 1.0.0-rc.4 (unreleased)

- Add optional bicycle Route and Matrix, with balanced, quiet and fast preferences, separate preference cost and ETA, bicycle access/contraflow, surfaces, mapped incline, dismount legs, and node/via-way turn restrictions.
- Load one bicycle graph only on demand. Retain the existing City format and omit bike data from CLI builds unless selected. Studio OSM imports include bike streets.
- Expose Bike in Studio and generated public types; report cycling time separately from transit riding and waiting.
- Add synthetic bicycle regressions and extend the historical-reader gate to a City containing optional bike tables. Leading-engine parity is not established by these checks.
- Retain valid OSM segments longer than 10 km in walking, driving and bicycle imports. Bound road-index duplication without adding graph nodes or changing exact endpoint projections; reject invalid geographic coordinates explicitly.
- Keep the route line view clear of the floating sidebar. Let its header and vehicle labels wrap in smaller windows without covering directions or stops.

## 1.0.0-rc.3

- Departure windows (Studio's Later departures) rank candidate journeys without copying their lines, intermediate stops, endpoint details and descriptive trip fields; only the returned choices carry them. The wider-walking search's shared services are searched only for the choices that survive merging with the preferred walking limit. Answers are unchanged.
- Arrive-by windows reuse a recent identical walking path instead of searching it again at every sampled deadline. Scheduled arrive-by windows, and departure windows whose samples share one timetable, search shared services only for the choices they finally return; other windows, for the choices each sample keeps. `disableCache` still searches every path. Answers are unchanged.
- One-shot CLI commands exit after writing their answer without first freeing the City's memory piece by piece.
- Reach rasterizes large street surfaces on up to four threads; each cell keeps the same minimum duration.
- Without `VIGO_TIMETABLE_CACHE_BYTES`, a standalone City's inactive-timetable budget grows to twice the size of a prepared view it retires, up to 1/16 of detected memory. Large Cities such as New York keep their other service day or clock, so arrive-by windows near the start of the day no longer prepare a timetable on every switch.
- A single-City `vigo stream` frees its street search scratch after 30 seconds without a request (`VIGO_IDLE_RELEASE_MS`); on Linux with glibc the pages return to the system. The next query allocates it again.
- Studio opens the wheelchair City only once wheelchair routing is selected, then keeps it ready while Route stays open. An unselected profile no longer repeats every date's preparation or holds a second City in memory.
- Studio leases the wheelchair City that answers wheelchair routes, and releasing it no longer fails when that profile was rebuilt or removed.
- Depart now and the warmed realtime view use GTFS service time on daylight-saving days, including the repeated fall-back hour.

## 1.0.0-rc.2

- Keep a continuous street-to-station walk in one leg even when station geometry is missing; omit incomplete lines and preserve shared-service leg references after merging.
- Connect planned scenario Flex zones to Route and Reach, including arrive-by, service hours, transit interchanges and walking to a pickup instead of taking an unnecessary short bus ride.
- Share destination bounds in full depart-at searches and prune unreachable prefixes in full arrive-by searches. Reuse equivalent reverse-window samples while preserving service-date boundaries.
- Reuse Reach street surfaces and baseline/scenario work in both directions, with request-specific limits and retained result parity checks.
- Rank Studio's earliest-arrival choices by arrival time, then journey duration. Display time before leaving separately from travel time.
- Take a later connecting service when it catches the same onward departure; remove return-loop detours before onward connections.
- Connect wheelchair station paths through accessible fare gates and dimensioned same-level walkways. Retain stairs, slope, width and explicit-access exclusions, and report the cost assumptions in results.
- Exclude closed elevator footprints from horizontal street snapping; preserve open inclined-elevator ways.
- Refresh generated Flex request schemas, desktop journey accessibility checks and corpus expectations. Run Linux desktop checks with a virtual display and await fixture shutdown before Windows cleanup.
- Apply the wheelchair City's expanded-walking policy even when a request inherits its profile without an explicit wheelchair flag.
- Keep keyboard focus in Studio search while moving through results, and announce an empty search outside the listbox.
- Board looping vehicles on their last pass and drop alternatives that stay aboard through a turnaround only to return to their own corridor. Forward in-seat continuations are unchanged.
- Preserve certified boardings at interchanges with transfer rules or minimum connection times, so waiting for a later pass cannot create an invalid transfer.
- Keep stay-aboard journeys when leaving and reboarding on the return pass would violate the requested transfer buffer or drop-off restrictions.
- Update Studio to Electron 44.9.3 and refresh Undici to 7.30.1 for their security fixes.
- Keep route-distinct Pareto alternatives within the arrival slack, and merge journeys on one vehicle chain in both rankings.
- Keep the native alternatives API's Pareto frontier and ranked limits separate from the expanded candidate pool used by Route.
- Offer wider-walk ("More walking") choices only when they arrive at least a minute before every ordinary choice.
- Replace a short final ride, and its wait, with walking the rest of the way when that arrives at least a minute sooner within the wider-walk budget.
- Stop the one-to-many Matrix scan once no later departure can improve any target, preserving arrival results.
- Studio turns walks between nearby stops on by default.
- Answer long Routes in Cities with transfer rules instead of failing a search budget: the earliest-arrival search compares clocks only and shares labels whose anchor no rule selects. An oversized alternative collection reports `alternativeSearch.status: "unavailable"` and keeps the primary journey, as documented.
- Describe unknown street tags and `wheelchair=yes` overrides accurately in inferred wheelchair City's limitations.
- Search GTFS Flex and fixed service together: Flex access and egress are time-dependent endpoints of one timetable scan, on either or both ends, departing or arriving by.
- Serve deviated routes through their fixed calls on schedule, and price continuous stopping once per shared shape pattern.
- Prepare wheelchair Cities with inferred step-free street evidence by default; `--wheelchair-streets verified` keeps the `wheelchair=yes`-only rule. Results report `accessibility.streetEvidence`.
- Preserve compatible prepared Cities, API 1.0, City format 1 and Result schema 1.

## 1.0.0-rc.1

- Add bounded Node CLI stream workers with ordered output and resource caps.
- Restore lightweight timed-leg Matrix journeys without per-cell Studio metadata; retain full metadata and geometry on request. Reuse unique native Matrix journeys across the internal transport.

- Execute Route, Matrix and Reach in Rust, including all-day accessibility.
- Add the versioned alternatives policy for thin API clients, shared-service information and explicit walking limits.
- The alternatives policy offers the latest departure that still makes the earliest arrival, and ranks equal arrivals by time spent travelling.
- Return one walk leg for each continuous walk. Station pathway and street pieces become `components`; waits, rides and waypoints still separate legs.
- Extend GTFS transfer, headway and station-access handling with capability and limitation reporting.
- Preserve compatible prepared Cities, API 1.0, City format 1 and Result schema 1.
- Align the Python release candidate with the same-commit engine and independent package tags.

Earlier release records remain in Git history and the archived GitHub releases.
