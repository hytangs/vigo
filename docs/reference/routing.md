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
`requireTransitRide: false`. Transit
Matrix uses the same default. `maxWalkKm` limits each access and egress walk;
it is not a limit on an explicitly requested complete walking journey.
`--horizon` / `horizonMinutes` sets the timetable
search horizon in minutes (default 480, range 1–2880).
For depart-at transit, boarding and alighting must occur at or before this
boundary, including in alternative journeys. Final walking can finish after
it. Arrival slack for alternatives does not extend the timetable horizon.
The horizon is not a hard limit on door-to-door journey duration.
Comparisons using a total-duration cap must check the final arrival separately.

Transit JSON requests accept `disableCache: true` to disable street-access
frontier and walking-path caches while keeping the prepared City resident.
Route answers are recomputed regardless of this option.
The same flag applies to the wider access probes used to explain a blocked
Route; each returned probe records `cacheDisabled` and `cacheHit`.

## Result

A Route Result contains status, chronological legs, departure and arrival, duration, transfers, warnings, timing, and a run record. A blocked Result remains a valid answer and explains why no journey was returned.

Access failures include endpoint-specific `diagnostics.accessAvailability`:

- `outside_selected_budget`: an access candidate exists at a larger walking
  limit. Its suggested limit does not guarantee a complete transit itinerary;
  `streetPathVerified` records whether the candidate's path is verified.
- `street_access_unverified`: nearby stops exist, but the bounded street search
  did not verify access. `nearestStop.distanceKind: "straight_line"` describes
  proximity, not walking distance or time. Longer paths can still exist.
- `none_within_probe`: no access candidate was found within `probeWalkKm`.
  This is a bounded result, not proof of disconnection at every distance.
- `diagnostic_unavailable`: the explanatory probe failed. The result reports
  `access_diagnostic_unavailable`, distinct from a completed negative search.

The diagnostic never increases the request's walking allowance automatically.
Blocked plans retain `diagnostics.searchLimits` for walking, horizon, transfers,
and the transit-ride requirement, including `horizonScope: "timetable_scan"`.
`no_path` means no scheduled itinerary under
those constraints and the selected service date; changing a constraint requires
a separate query.

The engine adds no implicit boarding buffer. Same-stop vehicle changes honor published GTFS minimum transfer times and forbidden transfers; staying aboard does not incur a transfer minimum. Explicit transfer edges retain their durations without an added boarding margin or a 60-second floor. Native diagnostics report `transferBoardSlackSeconds: 0`. A published platform-to-platform transfer rule takes precedence over the station walking fallback.

VIGO 0.4.2 exposes `earliest_arrival`. Equal-arrival journeys prefer fewer boardings, then less walking, then a stable final order. VIGO does not expose an undefined “balanced” preference. Arrive-by first maximizes departure time; among journeys leaving at that boundary and arriving by the deadline, it minimizes boardings, then walking, then actual arrival. A slightly later on-time arrival can therefore avoid unnecessary transfers.

Departure-window queries also return up to five distinct journey choices in
`choices`, including slower services that reduce transfers or walking. For each
searched departure, the scheduled search retains arrival/boarding/walking
trade-offs arriving within 15 minutes of the earliest journey, with no more
boardings than that journey. Duplicate and dominated choices are removed;
the list is never padded to five. The earliest-arrival result stays first.
Studio's supported realtime Route queries retain their departure-window choices without applying the
scheduled alternative search to an adjusted timetable.

Depart-at transit, arrive-by transit, walking, driving, waypoints, and batch requests remain Route variants. Desktop and CLI Route support realtime transit. CLI callers supply `realtimeSnapshot` and select `--data-mode realtime`; scheduled mode remains the CLI default. See [data modes and provenance](realtime-routing.md). See the [realtime limits](known-routing-limitations.md#realtime).

## Transfer and access rules

Use `maxTransfers` in a JSON request or `--max-transfers=N` in the CLI. Studio exposes Maximum transfers under Route options.
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
Endpoint walks using a prepared station path expose `accessCost.street` and
`accessCost.station`, each with distance and seconds. The station component
also retains directed `stopIds` and source types. Published station traversal
times can differ from distance divided by street walking speed. The component
witness supports a source-data audit; it does not certify physical station access.
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

## Itinerary geometry and identifiers

Rust reads selected shape rows directly from SQLite into numeric buffers and
builds a distance prefix and a hierarchy of bounds in unit-sphere coordinates.
The bounds skip sections that cannot contain a nearer candidate, including
across the antimeridian and near the poles. The matcher still retains up to 16
points within 1 km per stop, evaluates the original haversine distances and tie
rules, and aligns the complete trip monotonically to disambiguate loops.
JavaScript samples the selected range from a compact coordinate column using
the existing distinct-point stride and 512-point limit. Shapes with consecutive
duplicates also carry an index of distinct source positions. Range clipping
uses two binary searches and visits only sampled positions; shapes without
duplicates use source positions directly. Short ranges use a single bounded
pass. Final duplicate cleanup and distance calculation share one pass over
the newly materialized coordinates. Prepared shapes remain
subject to the store's entry and byte budgets, including the coordinate column,
distinct-position index, spatial index, and bounded native candidate cache.
A read-only source connection has a 2 MiB SQLite page-cache budget and closes when its routing store is disposed
or invalidated. No itinerary answer cache is introduced.

Plan identifiers retain the existing 64-bit hash and Unicode code-point
semantics. Rust performs that arithmetic; identifiers are selection keys, not
security digests. `npm run check:accuracy` includes differential tests against
the previous JavaScript shape matcher and identifier arithmetic.
