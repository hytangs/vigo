# Route

Route finds and explains travel between ordered points.

## Inputs

A Route Query selects:

- origin, optional ordered waypoints, and destination;
- transit, walk, or drive;
- exact service date and local time;
- depart-at or arrive-by;
- walking limit, optional maximum transfers, and objective;
- optional departure window;
- optional Scenario state supported by the selected mode.

Stop IDs are exact GTFS identifiers. Coordinate points are [longitude, latitude] and require streets in the City.

Transit Route requires at least one vehicle boarding by default. Missing transit
remains a blocked transit result; it is not replaced by a long walk. Use Walk
mode for a walking journey. A JSON request can opt into walking comparisons with
`requireTransitRide: false` (`require_transit_ride=False` in Python). Transit
Matrix uses the same default. `maxWalkKm` limits each access and egress walk;
it is not a limit on an explicitly requested complete walking journey.
`--horizon` / `horizonMinutes` / Python `horizon_minutes` sets the timetable
search horizon in minutes (default 480, range 1–2880).

Transit JSON requests accept `disableCache: true` to disable street-access
frontier and walking-path caches while keeping the prepared City resident.
Python exposes this as `disable_cache=True` on Route and Matrix. Route answers
are recomputed regardless of this option.

## Result

A Route Result contains status, chronological legs, departure and arrival, duration, transfers, warnings, timing, and a run record. A blocked Result remains a valid answer and explains why no journey was returned.

The engine adds no implicit boarding buffer. Same-stop vehicle changes honor published GTFS minimum transfer times and forbidden transfers; staying aboard does not incur a transfer minimum. Explicit transfer edges retain their durations without an added boarding margin or a 60-second floor. Native diagnostics report `transferBoardSlackSeconds: 0`. A published platform-to-platform transfer rule takes precedence over the station walking fallback.

VIGO 0.3.0 exposes `earliest_arrival`. Equal-arrival journeys prefer fewer boardings, then less walking, then a stable final order. VIGO does not expose an undefined “balanced” preference. Arrive-by first maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, then walking, then actual arrival. A slightly later on-time arrival can therefore avoid unnecessary transfers.

Departure-window queries also return up to five distinct journey choices in
`choices`, including slower services that reduce transfers or walking. For each
searched departure, the scheduled search retains arrival/boarding/walking
trade-offs arriving within 15 minutes of the earliest journey, with no more
boardings than that journey. Duplicate and dominated choices are removed;
the list is never padded to five. The earliest-arrival result stays first.
Realtime queries retain their departure-window choices without applying the
scheduled alternative search to an adjusted timetable.
The window shares endpoint-access preparation and reuses a walking result only
through departures where the timetable proves it still wins. The proof respects
the original search horizon, so newly admitted services can trigger a fresh search.
The native search reuses reverse bounds across transfer rounds with a shared
forward envelope. When reusing an earliest-arrival scan, it resumes at the
actual scan boundary, including departures skipped because of final egress.
It prunes prefixes whose best possible completion is strictly
dominated by an existing journey. A verified walk that already beats the exact
earliest transit arrival bypasses the bounded transit pass.

Depart-at transit, arrive-by transit, walking, driving, realtime-adjusted transit, waypoints, and batch requests remain Route variants. VIGO does not expose them as separate products.

## Maximum transfers

Use `maxTransfers` in a JSON request, `--max-transfers=N` in the CLI, or
`max_transfers=N` in Python. Studio exposes Maximum transfers under Route options.
`0` permits at most one boarding; `1` permits at most two. Values must be
integers from 0 through 31. Omit the option for no additional limit. Staying
aboard the same trip is not a transfer. Walk-only results require an explicit opt-in.
The cap constrains the native search, including alternatives and arrive-by;
a slower feasible route is searched when the unrestricted winner exceeds it.
A finite cap with ordered transit waypoints is currently unsupported.

Anonymous coordinate endpoints use the same nearest street attachment in Route
and Matrix. Physical GTFS stops use that same attachment rule; a parent station
does not provide free movement to every platform. Declared station paths retain
their direction and time. Their complete time/distance frontier is prepared once,
then filtered against the endpoint's remaining walking budget in Rust. Interior
pathway nodes do not create additional street entrances. Station links with
schematic geometry report `streetPathVerified: false` and `stationPathSources`.
When GTFS omits `traversal_time`, the configured walking policy prices the
declared pathway length, or the stop-coordinate distance if length is also
absent. A missing time is not a zero-time link. For endpoint access, declared
pathway graphs suppress generic platform shortcuts. Fallback station links
include their walking time in both endpoint and timetable preparation.
Cities built with transfer semantics v2 must be rebuilt to retain pathway lengths.
The walking
limit covers each complete continuous access or egress walk; a transfer walk
cannot extend the final egress beyond that budget. Generated transfer legs
are reconstructed from the same physical-stop profiles used to price them.

A repeated station is reported from the complete ride stop sequence. It does
not automatically invalidate a path: a scheduled loop or a forbidden direct
platform change can require it. Alternatives are filtered by objective
dominance, not by a geometric cycle rule.

A coordinate that snaps to the street graph can have an `endpointConnector` on
the first or last walking leg. Its coordinates and distance describe the snap
already included in that leg's cost. It has `source: "coordinate-snap"` and
`streetPathVerified: false`; the leg's `coordinates` retain the routed street
path. A connector is not evidence of a mapped or legally traversable street.
