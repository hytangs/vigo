# How VIGO computes answers

VIGO answers each question with an exact search over a declared model: the prepared timetable, the directed street graphs and the request's rules. "Exact" means the returned time is optimal for that model, not that the model matches the real world. This page explains the model and the searches, and marks where VIGO bounds, samples or estimates instead.

Every runtime uses the same Rust kernels. The engine, the compiler, Studio and Python differ in how they are called, not in how they route.

## Transit

### The timetable

A City's timetable is a list of **connections**: one vehicle moving from one stop to the next, with a departure and an arrival time, its trip, and whether boarding and alighting are allowed. For a service date, VIGO activates the trips whose calendars and exceptions run that day, plus trips from adjacent days that overlap the search. Times are seconds on the service day, so a trip at `25:10` stays on the day it was published.

GTFS frequencies become ordinary connections. `exact_times=1` windows are expanded when the City is built; `exact_times=0` templates are read as a departure at the start of each window and then every headway, before the window's exclusive end. Because GTFS gives no exact times for the second kind, those departures are scheduled estimates and the City records the limitation `frequency_based_service`.

Explicit in-seat links (`transfer_type=4`) and consecutive same-terminal trips on one block become through-runs: the rider stays aboard and the change counts as one boarding.

### The search

Transit uses one **connection scan** for every City and every request size. Connections are scanned in departure order, and each stop keeps its earliest arrival; a connection can be used when the rider is at its stop in time, or already aboard its trip. Arrive-by runs the same scan backward from the deadline.

| Question | Objective, in order |
| --- | --- |
| Depart-at | Earliest arrival, then fewer boardings, then less walking |
| Arrive-by | Latest departure; among those, fewer boardings, less walking, then earlier arrival |

A transfer cap (`maxTransfers`) constrains the search itself, by tracking the best arrival for each number of boardings, so a slower route is found when the fastest needs too many changes. A Matrix shares one forward scan per distinct origin, or one reverse scan per distinct destination; every requested cell is still answered.

### Transfers

Transfer permissions are prepared into the timetable before the scan. No query keeps per-trip transfer state.

- **Physical transfers.** Preparation finds the walking connections between stops: directed OSM paths up to 500 m, declared GTFS pathways, and station membership. A rule cannot restore a connection removed by `allowStreetTransfers: false` or the wheelchair profile.
- **Stop-level GTFS rules.** `transfers.txt` rows without route or trip selectors apply at their stops, expanded through parent stations; a platform's own rule overrides the one it inherits. `transfer_type=3` forbids the transfer; `transfer_type=2` sets the minimum time; recommended and timed rules set no minimum, and the guarantee of a timed transfer is not represented.
- **Minimum walking time.** Each transfer takes at least the published minimum and at least its distance at walking speed.
- **Station fallback.** Platforms of one parent station with no rule or declared pathway use at least 120 seconds, or their distance at walking speed, reported as `parent_station_fallback`.
- **The request.** `minimumTransferBufferMinutes` is added after walking and the published minimum. It never delays the first boarding, the final walk or staying aboard.

Route- and trip-scoped transfer selectors are kept in the City's `transfer_rules` table but are not applied: the stop-level rule governs. Flex interchanges still resolve the most specific rule for their conditional legs.

### Walking to and from transit

Each origin and destination searches the directed pedestrian graph for stops within `maxWalkKm`. The walking time includes the City's access padding and any station pathway. A direct walk is computed separately and wins when it arrives sooner, unless `requireTransitRide` is set.

### Realtime

A realtime request compiles its Trip Updates into a separate timetable: matched trips get their predicted times, canceled trips lose their connections, and unreported trips keep their schedule. The same scan then runs on that timetable. Realtime is a different input, not a different algorithm.

### Several journeys

Alternatives, journey windows and shared legs build on the exact search but are bounded:

| Feature | What is exact | What is bounded |
| --- | --- | --- |
| Alternatives | Each returned journey is feasible and correctly timed | The candidate set is limited by count, arrival slack and a label budget |
| Journey windows | Each sampled minute is answered exactly | Only whole-minute samples; not a continuous profile |
| Via points | Each segment is exact for its start time | Up to eight partial journeys per point; not every itinerary |
| Shared legs | Each option is a complete, feasible journey | One leg changed at a time, within 30 minutes and fixed counts |
| Flex | The returned journey is feasible | Can be up to 60 seconds later than the best conditional journey |

## Walking

The pedestrian graph is built from OSM ways with pedestrian permission, in both directions unless a way says otherwise. Explicit `foot=no`, private access, `foot=use_sidepath`, impassable barriers and unresolved conditions are excluded; a motor-vehicle one-way restriction alone does not restrict walking. [Walking evidence](walking-evidence.md) describes the rules and station costs in detail.

Paths use a **customizable contraction hierarchy** (CCH): a prepared index that answers shortest-path queries exactly and quickly. The hierarchy is built once per City and never removes streets or changes their lengths.

A free coordinate attaches to its nearest vertex or two-way edge; the short straight connector is part of the cost and is reported as unverified. VIGO never draws a straight line where a street path is missing.

## Driving

Drive uses a directed road graph from OSM with free-flow speeds by road class and maximum speed. Its hierarchy is built with the City and persisted. A supplied traffic snapshot customizes the hierarchy's weights for one request: a fixed set of costs, never faster than free flow, and not a forecast that changes during the trip. Turn penalties, signals and intersection delays are not modeled.

A free coordinate attaches to the nearest drivable road and enters it mid-segment in its own direction; the gap is a walk.

## Bicycle

Bike uses a directed graph with bicycle access, contraflow, surfaces, mapped incline, dismount sections and turn restrictions, including restrictions through intermediate ways. Its hierarchy keeps the incoming road in every state, so turn restrictions are exact.

- **Preference and time are separate.** The profile (`balanced`, `quiet` or `fast`) and traffic-stress limit choose the route by a preference cost. The reported duration is the physical travel time at the chosen speed, adjusted for surface and incline.
- **Time-dependent rules.** With a date and a known timezone, access, one-way directions, dismount periods and turn restrictions are evaluated when the bicycle enters each segment, and the search can wait for a road or turn to open. A segment entered while open can be finished. An arrive-by route is anchored at the deadline and replayed forward to check every movement; it is proved optimal when no move must wait, and otherwise searched backward through the hierarchy.
- **Many-to-many.** Matrix and Reach share rank sweeps across endpoints, and check each witness's distance and time before reporting it.
- **Stress.** Traffic stress (LTS 1–4) is estimated from road class, speed and lanes, after Conveyal's published labeler; OSM `lts` tags take precedence.

The bicycle hierarchy can keep part of its structure in the user cache, bound to the City's source; opening rebuilds the rest exactly. The cache holds graph data only.

## Reach

Transit Reach runs the connection scan once from the origin (or backward from the destination), then spreads walking from every reached stop and from the origin itself over the directed streets, within the walking budget and the largest cutoff. The result is the earliest time at every reached part of every street.

The raster is drawn from that result:

- **Street sampling** (default) gives each cell the least time on the reached streets inside it. Cells with no reached street stay empty, and a filled cell does not prove a route to its center.
- **Cell-center sampling** routes to the center of every cell with the Matrix rules.

Areas are polygons around reachable cells, with holes and islands kept; contours interpolate the raster at each cutoff. Both depend on the grid's resolution. Drive and Bike Reach route to every cell center.

Arrive-by Reach reverses the whole process: the timetable is scanned backward, and walking runs backward over directed streets so one-way paths keep their direction.

## Monte Carlo

A Monte Carlo request repeats a query at every minute of a departure window. Planned frequency services without exact times receive a random phase per sample, shared by every stop and endpoint in that sample. VIGO reports nearest-rank percentiles that include unreachable samples as infinitely long. It assumes on-time operation and riders who know the timetable. See [Monte Carlo routing and accessibility](../guides/monte-carlo.md).

## Exactness and its boundaries

| Claim | Holds when |
| --- | --- |
| A transit time is optimal | For the prepared timetable, transfer rules, walking policy and request limits |
| A street path is shortest | For the prepared graph, its permissions and the attachment of each endpoint |
| A blocked answer means no journey | Under the request's date, horizon, walking limit and transfer cap, within the City's coverage |
| A Matrix cell equals the Route | For the same endpoints and settings; ties can choose a different equally good journey |
| Two runtimes agree | For the same City, request and version |

VIGO does not establish:

- that the timetable or map matches reality, or that a station path, entrance or crossing exists beyond what the data declares;
- delays, crowding, missed connections or reliability, beyond supplied realtime predictions;
- turn penalties or intersection delays for driving;
- opportunities, demand or welfare: Reach is travel time, not accessibility.

## How the algorithms are verified

Public tests compare VIGO with independent reference implementations that never supply production answers: Floyd–Warshall shortest paths for walking and driving, whole-trip enumeration from raw GTFS for transit, and every stop-to-stop pair at each boarding boundary. A permanent fixture checks that new Cities stay readable by the published reference runtime. See [Checking routing accuracy](../developer.md#checking-routing-accuracy) to run them and to validate your own City.
