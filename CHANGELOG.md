# Version history

## 1.0.0 — 2026-11-09

- A single-City `stream` or `serve` worker opens its bicycle network and prepares the default hierarchy in the background as soon as it opens a City with bicycle data, so the first bicycle request no longer waits for it. A request that arrives earlier waits only for what remains, and answers are unchanged. The worker then holds the bicycle network and hierarchy in memory even if no bicycle request arrives (about 0.7 GB more in DC); set `VIGO_PREPARE_BIKE=0` to prepare on the first bicycle request instead. Bicycle caches remove temporary files that an interrupted process left for over an hour.
- Express-to-local journeys stay on the express to a later shared platform also where the feed publishes a minimum connection time, when that platform's rule, minimum and the requested buffer still catch the same local train. Previously any published minimum kept the earlier interchange: in New York, MetroTech to Columbia changed from the 2 or 3 to the 1 at 72 St instead of 96 St, whose 3-minute minimum the connection meets. Arrival, boardings and walking are unchanged.
- Bicycle Route and Reach no longer fail with "Temporal contraction exceeded its path workspace" around timed roads and turns. One cell whose only access is timed, such as a parkway that is one-way during the morning rush, previously raised the price ceiling of every cell to the whole cutoff, so hundreds of dated movements entered the exact search. Such cells are now bounded by a legal earliest arrival, or for arrival queries a legal latest departure, or proved unreachable when no legal movement reaches them in time. A second legal path search keyed on price tightens these ceilings for preferences such as Quiet. Point routes bound a relaxed path that must wait for a road to reopen the same way. Corridors too wide to customize, or profiles that outgrow their workspace, resolve dated movements by searching the movement graph directly instead of failing. Answers are unchanged.
- Bicycle walking connectors keep one walking metric for both directions plus the few arcs where one-way links make them differ, instead of a second full copy. A DC worker's bicycle hierarchy holds 535 MB instead of 644 MB; answers are bit-identical.
- Remove the scoped timing-window helpers left from the previous bicycle router.
- Route, Matrix and Reach share a bicycle contraction hierarchy that enforces timed roads, turns and endpoint access. Walking connectors use the pedestrian hierarchy. Source-bound local indexes keep only the upward hierarchy and shortcut witnesses and rebuild exact weights on open; existing Cities remain readable. Reach bounds each cell's walking search with one relaxed hierarchy sweep.
- Release the engine and the Python package from one workflow and one `v<VERSION>` tag.
- Load bicycle walking identities without an external SQLite sort, retaining coordinate and duplicate-identity validation for dense and sparse links.
- Constrain Studio address suggestions to the selected City’s prepared street or timetable coverage, including after switching Cities and replacing data.
- Clarify the README’s historical transit benchmark boundary and link the live route planner.

- Update the dependency sets together and replace the unmaintained bincode crate with its maintained GroveDB fork, preserving the prepared-profile encoding.

- Wheelchair Cities reach accessible platforms of stations without declared entrances from the street. Their platforms' own or inherited `wheelchair_boarding=1` is GTFS evidence of an accessible path from outside. Previously every platform with a parent station needed a declared entrance, which cut off accessible stations in feeds that publish no entrances for them, such as many MBTA commuter rail stations and surface Green Line stops. Stations that declare entrances still use only accessible entrances and paths. The City format and access policy identity are unchanged; prepare wheelchair Cities again to apply this.
- Wheelchair streets keep ways tagged `wheelchair=yes` whose `incline` is `up`, `down` or `yes`, such as mapped ramps and accessible footbridges. These values give a direction without a grade, and the explicit tag vouches for the slope; previously such ways were dropped, which could force long detours. Without `wheelchair=yes` they remain excluded, as do steep or malformed inclines and inclines above 8.3%. Prepare wheelchair Cities again to apply this.
- Planned frequency trips follow GTFS stop times: a vehicle arrives, dwells, then departs, so riders alight before the dwell, and it no longer dwells at its last stop. Boarding times are unchanged; alighting is earlier by up to one dwell (0.35 minutes by default).
- Planned frequency service runs on every service day, as scheduled service does. The previous day's runs that are still running after midnight (a 05:00–25:00 line still runs at 00:30, and its 23:50 run still serves its later stops) and the next day's first runs are part of a query's timetable wherever its clock reaches them. Adjacent days never run one departure twice. Route and Reach expand the same whole-second windows.
- A `replace` service with `scheduledTrips` removes every instance of its original trips from the active timetable and names only trips active on the service date. Previously it removed only the first matching trip, which a timetable holding an adjacent service day could make the wrong instance. A trip or route replaced by two services is rejected.
- A kept trip in `scheduledTrips` can name its service day with `serviceDayOffset`. Studio and the compiler now also keep the previous day's trips that run past midnight when a branch is edited with its departures kept; previously the edit removed that branch's after-midnight service from early-morning queries.
- Studio: when a branch that keeps its departures is extended past its last stop or before its first, riders can board or alight at the former terminus. Previously the extension could not be reached from it.
- Scenario exclusions are resolved in one pass over the timetable rather than once per excluded ID; arrive-by Reach now rejects a non-array exclusion as depart-at Reach does. Deriving a scenario timetable reads each trip's canceled spans directly instead of scanning every span for every trip.
- Transit matrices with many destinations from one origin, or many origins to one arrive-by destination, look up their endpoints through a per-stop index and update the scan's stopping time only when the latest endpoint improves. Answers are unchanged; such matrices compute faster.
- Reach's street walk drops a walking label as soon as an earlier label at the same street node can walk at least as far as the later one has time left, even if the earlier one has walked farther. Every continuation adds the same time and distance to both, so the later label can never improve the surface. Surfaces are unchanged; Reach computes faster, most where walk and time limits are both tight.
- `scheduledTrips` entries reject unknown fields, as every other scenario object does, so a misspelled field no longer runs a trip on the wrong day.
- Studio: an edit that keeps a branch's departures divides each trip's running time between kept stops along the published shape or traced road path, as its supplied runtimes describe, rather than by straight-line distance.


- Start constrained drives from the feasible shortest path with exact remaining bounds. Long limits no longer search for seconds and report a false `not_found`; short limits keep their earlier speed.
- Load the bicycle graph without an on-disk sort, about halving cold load time with identical answers.
- Add a new stop to the end of a journey (A, B, then C) instead of before the destination.
- Flush a finished City before publishing it and keep the old City until the new one is on disk. The next build or Node CLI query restores or finishes an interrupted replacement; signals remove unpublished builds.
- Run only the head query against a City's process, so a cancelled queued query never runs.
- Public route planner: local SQLite address index on a worker thread, an offline edge page, immutable hashed assets with ETag revalidation, a security-policy header and per-IP read limits.
- Studio restores the offline default basemap, contacts a geocoder only once online maps are chosen, and loads secondary views on first use.
- API 1.0, City format 1 and Result schema 1 are unchanged.


- Add optional bicycle Route and Matrix, with balanced, quiet and fast preferences, separate preference cost and ETA, bicycle access/contraflow, surfaces, mapped incline, dismount legs, and node/via-way turn restrictions.
- Load one bicycle graph only on demand. Retain the existing City format and omit bike data from CLI builds unless selected. Studio OSM imports include bike streets.
- Expose Bike in Studio and generated public types; report cycling time separately from transit riding and waiting.
- Add synthetic bicycle regressions and extend the historical-reader gate to a City containing optional bike tables. Leading-engine parity is not established by these checks.
- Retain valid OSM segments longer than 10 km in walking, driving and bicycle imports. Bound road-index duplication without adding graph nodes or changing exact endpoint projections; reject invalid geographic coordinates explicitly.
- Keep the route line view clear of the floating sidebar. Let its header and vehicle labels wrap in smaller windows without covering directions or stops.
- Add opt-in Monte Carlo Route, Matrix and Reach through the native engine, Node CLI and Python, with seeded frequency schedules, unreachable-inclusive percentiles, planned timetables and optional accessibility indicators.
- Complete Python Bike Route, Matrix and Reach, bike-enabled builds, distribution exports and marginal-percentile comparisons. Preserve existing defaults and require runtime capabilities for new features.
- Allocate sampling, phasing and fixed-grid bounds only when used, and keep sampling work outside the ordinary transit scan.


- Departure windows (Studio's Later departures) rank candidate journeys without copying their lines, intermediate stops, endpoint details and descriptive trip fields; only the returned choices carry them. The wider-walking search's shared services are searched only for the choices that survive merging with the preferred walking limit. Answers are unchanged.
- Arrive-by windows reuse a recent identical walking path instead of searching it again at every sampled deadline. Scheduled arrive-by windows, and departure windows whose samples share one timetable, search shared services only for the choices they finally return; other windows, for the choices each sample keeps. `disableCache` still searches every path. Answers are unchanged.
- One-shot CLI commands exit after writing their answer without first freeing the City's memory piece by piece.
- Reach rasterizes large street surfaces on up to four threads; each cell keeps the same minimum duration.
- Without `VIGO_TIMETABLE_CACHE_BYTES`, a standalone City's inactive-timetable budget grows to twice the size of a prepared view it retires, up to 1/16 of detected memory. Large Cities such as New York keep their other service day or clock, so arrive-by windows near the start of the day no longer prepare a timetable on every switch.
- A single-City `vigo stream` frees its street search scratch after 30 seconds without a request (`VIGO_IDLE_RELEASE_MS`); on Linux with glibc the pages return to the system. The next query allocates it again.
- Studio opens the wheelchair City only once wheelchair routing is selected, then keeps it ready while Route stays open. An unselected profile no longer repeats every date's preparation or holds a second City in memory.
- Studio leases the wheelchair City that answers wheelchair routes, and releasing it no longer fails when that profile was rebuilt or removed.
- Depart now and the warmed realtime view use GTFS service time on daylight-saving days, including the repeated fall-back hour.


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


- Add bounded Node CLI stream workers with ordered output and resource caps.
- Restore lightweight timed-leg Matrix journeys without per-cell Studio metadata; retain full metadata and geometry on request. Reuse unique native Matrix journeys across the internal transport.

- Execute Route, Matrix and Reach in Rust, including all-day accessibility.
- Add the versioned alternatives policy for thin API clients, shared-service information and explicit walking limits.
- The alternatives policy offers the latest departure that still makes the earliest arrival, and ranks equal arrivals by time spent travelling.
- Return one walk leg for each continuous walk. Station pathway and street pieces become `components`; waits, rides and waypoints still separate legs.
- Extend GTFS transfer, headway and station-access handling with capability and limitation reporting.
- Preserve compatible prepared Cities, API 1.0, City format 1 and Result schema 1.
- Align the Python release with the same-commit engine and independent package tags.

Earlier release records remain in Git history and the archived GitHub releases.
