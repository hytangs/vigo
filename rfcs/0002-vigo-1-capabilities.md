# RFC 0002: VIGO 1.0 capabilities

| | |
| --- | --- |
| Status | Draft |
| Branch | `vigo-v1-dev` |
| Opened | 2026-10-18 |
| Builds on | [RFC 0001](0001-vigo-1-architecture.md): one Rust engine, `vigo-model`, the optional pack |

## Summary

VIGO 1.0 adds three capabilities to the engine:

1. **Live multimodal routing.** GTFS schedules, GTFS-Realtime trip updates, service alerts and live road traffic feed one routing model. Walking, cycling, driving and transit combine in one journey.
2. **GTFS-Flex and demand-responsive service.** Zone-based on-demand trips, deviated routes, stop groups, booking rules and continuous stops are routed through the same API as fixed routes.
3. **Regional analysis and scenario planning.** Accessibility to opportunities from every cell of a region, over a departure window. Results come with matrices, isochrones, scenario comparisons and equity breakdowns by population group.

All three follow RFC 0001's rules:
- One implementation, in Rust.
- Every request and Result typed in `vigo-model`.
- New data in optional pack sections that the published 0.5.0 runtime ignores.
- No change to an existing answer unless the request asks for a new capability.

## Where VIGO 0.5.2 stands

| Area | Today |
| --- | --- |
| Realtime | GTFS-RT Trip Updates, sent with each Route request. Matrix and Reach run on the schedule only. Stale snapshots fall back to the schedule and say so. |
| Service alerts | Decoded for Studio's Network view. They never affect routing. |
| Road traffic | Supplied traffic snapshots for driving Route and Matrix. |
| Modes | Walk, drive, and walking access to transit. No cycling. Trip `bikes_allowed` values are counted and reported as a limitation. |
| Flexible service | Not imported. `pickup_type` and `drop_off_type` 2 and 3 are treated as unavailable; continuous pickup and drop-off are excluded; inexact frequencies are excluded. Each is reported as a dataset limitation. |
| Analysis | Point Reach with rasters, contours and comparison; Matrix up to 100,000 pairs. No departure windows, opportunity data or population weighting. |
| Scenarios | Add, augment or replace services and exclude trips or routes, for Reach requests and as prebuilt scenario collections. |

## Shared foundations

The three capabilities need four things in common. They are built once, in this order.

### 1. One overlay model for scenarios and live conditions

A scenario and a realtime snapshot are both changes to the service a query sees. Today they are two mechanisms: compiled Reach overlays and per-request realtime reconstruction. In 1.0 they share one:

```text
query view = base timetable ⊕ scenario overlay ⊕ live overlay
```

- **Base.** The immutable pack timetable, covering every service date.
- **Overlay.** An immutable, compiled set of changes: added trips, removed trips, changed times, closed stops, changed street costs. It is keyed by its own fingerprint.
- **Composition.** A scenario applies before live state, so "the proposal under today's disruptions" is one query. Every query kind accepts both: Route, Matrix, Reach and regional analysis.

The kernel searches the view without copying the base. Overlays are small next to the base and are cached by fingerprint.

### 2. Pluggable access and egress

A journey is access, then transit, then egress, or a direct leg with no transit. Today access and egress are walking only. In 1.0 they are producers of timed stop labels:

| Producer | Gives |
| --- | --- |
| Walk | Street walk to stops (today's behavior) |
| Bike | Ride to stops with bicycle parking, or onto trips that carry bicycles |
| Park and ride | Drive to a parking facility, then walk to stops |
| Kiss and ride | Drive to a drop-off point at a station |
| Flex | An on-demand or deviated trip to fixed-route stops (part 2) |

The transit search consumes labels and does not care where they came from. Each leg reports how it was produced. Direct journeys use the same producers without transit.

### 3. Street modes

The street graph gains a bicycle mode beside walk and drive:
- Permissions from OSM: highway class, `bicycle=*`, `cycleway*`, `oneway:bicycle`, dismount.
- Speed by class.
- A Level of Traffic Stress (LTS 1–4) per edge, so a request can cap stress.

Each mode keeps its own CCH metric. Closures and speed changes from scenarios or live traffic re-customize a metric. Customization keeps the CCH structure, so a full rebuild is not needed.

### 4. An evaluation clock

Feed freshness, booking deadlines and "depart now" all depend on the current time. In 0.5.2 the engine reads system time directly, so the golden corpus has to stamp realtime and traffic requests at run time. In 1.0:
- Every time-dependent decision reads an evaluation time passed in the engine configuration.
- Results report it as `meta.evaluatedAt`.
- Tests and replays fix it, so live and booking behavior is deterministic and recordable.

## Part 1: Live multimodal routing

### Modes and combinations

A request names which producers may serve each part of the journey. The existing `mode` field keeps its meaning.

```json
{
  "origin": { "coordinate": [-71.09, 42.36] },
  "destination": { "stop": { "feed": "mbta", "id": "70067" } },
  "serviceDate": "2026-11-10",
  "time": "08:00",
  "modes": {
    "access": ["walk", "bike"],
    "egress": ["walk"],
    "direct": ["walk", "bike"],
    "transit": { "bikeOnBoard": false }
  },
  "bike": { "maxLts": 3 }
}
```

| Combination | Rules |
| --- | --- |
| Bike and ride | Bicycle parking at or near the station, from OSM `amenity=bicycle_parking` |
| Bike on board | Only trips with `bikes_allowed=1`; egress may then be by bicycle |
| Park and ride | Drive access to parking tagged `park_ride=yes` or listed in a supplied facility file, then walk |
| Kiss and ride | Drive access to a station drop-off point; no parking needed |
| Direct | Walk, bike or drive alone, compared with transit options |

Legs add `type: "bike"`. Parking and drop-off appear as zero-length legs with `facility` evidence. A request that names no new modes gets exactly the 0.5.2 behavior.

Shared bikes from GBFS are deferred to 1.1. They need station and vehicle availability as another live source.

### Live conditions

`vigo serve` can poll feeds itself, configured in a live sources file. An inline `realtimeSnapshot` or `traffic` in a request still overrides the server's feeds for that request.

| Source | Effect on routing |
| --- | --- |
| GTFS-RT Trip Updates | Delays, cancellations, added and skipped stops. Today Route only; in 1.0 every query kind. |
| GTFS-RT Service Alerts | `NO_SERVICE` on an agency, route, trip or stop removes that service, or closes the stop to boarding and alighting, for the alert's active periods. `ACCESSIBILITY_ISSUE` closes the stop for wheelchair queries. Every other effect becomes a warning on the affected legs. |
| GTFS-RT Trip Modifications | Detours and replacement stops, when a feed publishes them |
| GTFS-RT Vehicle Positions | Inspection and Studio display only. Positions are not predictions, so they never change a route. |
| Road traffic | Edge speed factors and closures for driving and park and ride; the existing supplied-traffic format, also pollable |

Each poll builds an immutable live snapshot with its own identifier, feed timestamps, ages and admission counts. A query uses the snapshot that is current when it is admitted, so all of its legs see one consistent state.

Evidence stays with the answer:
- Every transit leg reports `quality.schedule` as `timetable`, `realtime` or `source_time_limitations`.
- Every Result carries `meta.live` with the snapshot identifier and feed ages.
- Alerts appear on the legs they affect, with their effect and text.
- A stale or failed feed falls back to the schedule and is reported, as today.

Planned disruptions, such as weekend closures known in advance, are scenarios, not live data. They use the same overlay and can be saved and compared.

## Part 2: GTFS-Flex and demand-responsive service

### Data model

VIGO imports GTFS-Flex as adopted into the GTFS Schedule reference:

| Source | Meaning |
| --- | --- |
| `locations.geojson` | Zones (Polygon or MultiPolygon) where riders may be picked up or dropped off |
| `location_groups.txt`, `location_group_stops.txt` | Groups of stops served on request |
| `stop_times.txt` `location_id`, `location_group_id` | A trip event at a zone or stop group instead of a stop |
| `start_pickup_drop_off_window`, `end_pickup_drop_off_window` | When that event can happen; these replace `arrival_time` and `departure_time` |
| `pickup_type`, `drop_off_type` 2 and 3 | Phone the agency, or coordinate with the driver |
| `pickup_booking_rule_id`, `drop_off_booking_rule_id`, `booking_rules.txt` | Real-time, same-day or prior-day booking, with prior-notice limits and contact details |
| `continuous_pickup`, `continuous_drop_off` | Pickup and drop-off anywhere along part of a route |
| `trips.txt` `safe_duration_factor`, `safe_duration_offset` | A 95% travel-time estimate: factor × driving duration + offset |

These cover five service shapes:
- Zone-to-zone dial-a-ride.
- Stop-group on-demand.
- Deviated fixed routes.
- Booked stops on fixed routes.
- Continuous stopping along a route.

`vigo build` compiles them into a Flex pack section:
- Zones with a spatial index.
- Stop groups.
- Flex trip patterns: sequences of stops, zones and groups with their windows.
- Booking rules and the calendars they use.

The fixed-route part of every trip stays in the 0.5 layout. Trips that are flexible throughout live only in the Flex section. The published 0.5.0 runtime therefore opens the City as fixed-route only, with a `flex_service` dataset limitation recorded at build time.

### Routing

Flex trips enter the search through the access and egress producers (shared foundation 2):

- **Flex access.** Walk from the origin to a pickup point, ride the flex trip, alight at a fixed-route stop.
  - The pickup point is the origin itself when it lies inside the pickup zone; otherwise the nearest reachable zone point or group stop.
- **Flex egress.** The same in reverse.
- **Flex direct.** One flex trip covers both origin and destination.
- **Flex between fixed routes.** Deferred to 1.1. It needs flex legs inside the transit search, not only at its ends.

Travel time on a flex leg:
- **Ride time.** The driving time between pickup and drop-off on the drive CCH, multiplied by `safe_duration_factor` plus `safe_duration_offset`. When a feed gives neither, a configured default applies and the Result reports which was used.
- **Pickup.** The later of the request time and the window start.
- **Feasibility.** The drop-off must fall inside its window.
- **Continuous stopping.** Uses the trip's shape between its timed stops.

Booking rules are checked against a booking time: the request's `bookingTime`, or the evaluation time. A leg is `bookable`, `too_late` or `not_evaluated`. A `too_late` leg is excluded unless the request sets `ignoreBookingDeadlines`.

### What a flex leg says

Flex answers are less certain than timetabled ones, and the Result says so. A flex leg is `type: "flex"` with:
- **Window:** `earliestDeparture`, `latestArrival` and `estimatedDurationSeconds`, and which estimate was used.
- **`booking`:** the type, notice limits, phone, URL and message from the feed, plus the evaluated status.
- **`quality.schedule: "flexible_window"`.**
- **Pickup and drop-off:** the zone or group, and the point used.

Matrix and Reach accept `flex` as an access or egress mode, so flex coverage shows up in reachable areas and travel times.

## Part 3: Regional analysis and scenario planning

### Concepts

| Concept | Is |
| --- | --- |
| Opportunity dataset | Values per cell on a web Mercator grid at a chosen zoom, with one or more attributes (jobs by sector, residents by group). Imported from point CSV or polygon GeoJSON (areal weighting), with source hashes. |
| Study | A directory that names one City revision and holds opportunity datasets, scenario documents and analysis results |
| Regional analysis | For every origin cell, travel times over a departure window, reduced to accessibility indicators |
| Scenario document | `vigo.scenario.v1`: a versioned list of modifications, compiled to an overlay |

Grid cells align across datasets and Cities because the grid is defined by zoom and extent, not by the City.

### A regional request

```json
{
  "origins": { "grid": { "zoom": 10, "bounds": [-71.2, 42.2, -70.9, 42.5] } },
  "serviceDate": "2026-11-10",
  "departureWindow": { "from": "07:00", "to": "09:00", "stepMinutes": 1 },
  "modes": { "access": ["walk"], "egress": ["walk"], "direct": ["walk"] },
  "maxTripMinutes": 90,
  "percentiles": [5, 25, 50, 75, 95],
  "opportunities": { "dataset": "jobs-2026", "attributes": ["total", "low_wage"] },
  "indicators": [
    { "type": "cumulative", "cutoffsMinutes": [30, 45, 60] },
    { "type": "decay", "function": "logistic", "halfLifeMinutes": 30, "widthMinutes": 10 },
    { "type": "dual", "opportunities": 10000 }
  ],
  "population": { "dataset": "residents-2026", "groups": ["all", "low_income", "no_car"] },
  "scenarios": ["baseline", "bus-network-redesign"]
}
```

The Result, `vigo.regional.v1`, holds:
- Per origin and scenario: each indicator at each percentile, as compact binary grids with a JSON summary. GeoTIFF and CSV are exports.
- Per population group: the population-weighted distribution of each indicator (mean, percentiles, share above thresholds) and its change between scenarios.
- Coverage: unreachable origins, origins outside the City, and the live snapshot or schedule used.

`dual` is the time needed to reach a number of opportunities. `cumulative` counts opportunities within each cutoff; `decay` weights them by travel time.

### Algorithm

| Step | Method |
| --- | --- |
| Origin access | Street search from each origin cell to nearby stops: CCH buckets, as Matrix uses today |
| Transit over the window | Range RAPTOR: one sweep from the latest departure to the earliest gives arrival times at every stop for every minute, reusing labels between minutes |
| Stops to cells | Egress trees: for each stop, street times to the grid cells within the egress limit. Built once per City, grid, mode and limit, then stored as a derived pack section and memory-mapped. |
| Cell times | Per minute, the minimum over stops of arrival plus egress, and the direct street time. Computed over minutes in vectorized loops. |
| Reduction | Percentiles over the window, then indicators against opportunity grids |

Range RAPTOR is new to the kernel. It is chosen over the existing CSA for this job because its round structure reuses work across departure minutes and bounds transfers naturally. Point queries keep CSA. Correctness is checked by comparing sampled origins and minutes with point Reach on the same view.

Regional analyses run as server jobs:
- Origins are processed in parallel chunks.
- Progress is streamed.
- Results are written as each chunk finishes, so an interrupted job resumes.
- The output is deterministic for the same request, City, scenarios and live snapshot.

### Scenario modifications

`vigo.scenario.v1` extends today's operations to the set planners use:

| Modification | Effect |
| --- | --- |
| Add trips | New route by frequency or explicit timetable (exists) |
| Adjust frequency | New headways on an existing route for a time range |
| Remove trips | By route, direction, time range or explicit list (exists, extended) |
| Remove stops | Skip stops on a pattern, with dwell removed |
| Add stops | Insert stops on a pattern, with dwell and segment times |
| Reroute | Replace a section of a pattern between two stops |
| Adjust speed | Scale segment running times along a pattern section |
| Adjust dwell | Change dwell at chosen stops |
| Street closure or speed change | Re-customize the walk, bike or drive metric |

New street links change the CCH structure, so they are deferred to 1.1.

Scenarios apply to every query kind through the shared overlay. Two scenario documents can be compared on any query, with deltas on shared scales.

## Contract additions

Everything is added to `vigo-model`, optional, and appears only when the request asks for it. A client that sends 0.5 requests receives 0.5 Results.

| Where | Addition |
| --- | --- |
| Route, Matrix, Reach requests | `modes`, `bike`, `bookingTime`, `ignoreBookingDeadlines`, `scenario` on every kind, `live` (`server`, `none`, or inline) |
| Legs | `type: "bike"` and `type: "flex"`, both only when requested; `alerts`; `booking`; `facility` |
| `meta` | `evaluatedAt`, `live` (snapshot identifier, feed ages, counts) |
| New schemas | `vigo.scenario.v1`, `vigo.regional.v1`, `vigo.opportunities.v1`, `vigo.live.v1` |
| HTTP | `POST /v1/analyses`, `GET /v1/analyses/{id}`, `DELETE /v1/analyses/{id}`, `POST /v1/opportunities`, `GET /v1/live` |
| CLI | `vigo analyze`, `vigo opportunities import`, `vigo live status` |

## Data and compatibility

New City data goes into pack sections, of two kinds:

- **Derived sections** can be rebuilt from the 0.5 layout alone: timetable, indexes, egress trees.
- **Extension sections** need the original sources: the bicycle graph and stress, parking facilities, Flex. `vigo build` writes them. `vigo pack` can rebuild derived sections only.

`network.json` gains an optional `extensions` list. The published 0.5.0 runtime ignores it.

If a listed extension is missing or invalid:
- The City still opens.
- Requests that do not use the extension are unaffected.
- Requests that do use it fail with a typed error, for example `extension_unavailable: flex`. They never fall back silently to an answer without it.

Opportunity datasets, studies and analysis results live outside Cities. A study records the City revision it used.

## Sequencing

These milestones sit on RFC 0001's foundations. Each lands behind opt-in request fields, so none blocks the platform work.

```text
RFC 0001:  M1 ──► M2 ──► M3 ──► M4
            │      │      │      │
C1 overlay ─┘      │      │      │
C2 street modes ───┼──────┘      │
C3 live ───────────┼─────────────┤ (needs C1)
C4 flex ───────────┼─────────────┘ (needs M3 compiler, C2 producers)
C5 regional ───────┘ (needs M2 pack, M4 jobs, C1)
C6 scenario set (needs C1)
```

| Milestone | Delivers | Exit |
| --- | --- | --- |
| C1 Overlay | Scenarios and realtime as one overlay on every query kind; the evaluation clock | Corpus unchanged; scenario and realtime on Matrix and Reach; deterministic replays without stamping |
| C2 Street modes | Bicycle graph and stress, access/egress producers, bike and ride, park and ride, kiss and ride | Synthetic permission and stress fixtures; corpus unchanged for walk-only requests |
| C3 Live | Feed polling, live snapshots, alerts in routing, trip modifications, pollable traffic | Recorded protobuf fixtures replayed at a fixed clock; alert effects by entity type |
| C4 Flex | Flex import, Flex section, flex access, egress and direct, booking evaluation | Synthetic fixtures for every service shape and booking type; a public flex feed compared with OpenTripPlanner in the private benchmark workspace |
| C5 Regional | Opportunity import, egress trees, Range RAPTOR, regional jobs, equity reduction | Sampled agreement with point Reach; deterministic outputs; stage timing and memory reported |
| C6 Scenario set | The full modification list | Each modification against hand-checked fixtures; comparisons across query kinds |

Studio gains matching surfaces:
- The Reach workspace becomes **Accessibility**: point Reach, Matrix, regional analysis and equity.
- **Scenarios** gains the modification editor.
- **Network** shows live state and alerts.

## Deferred to 1.1

- Flex legs between fixed routes.
- GBFS shared bikes and scooters.
- New street links in scenarios.
- Elevation-aware cycling.
- Monte Carlo draws for frequency-only services. Scenario frequencies stay exact departures.

## Risks

- **Flex feeds vary widely and many are incomplete.** Mitigation: implement the adopted spec only, report every unusable record as a limitation, and always state which travel-time estimate a leg used.
- **Regional scale.** Egress trees and per-minute times can be large. Mitigation: memory-mapped sections, tiled origins, and memory measured per stage before targets are set.
- **Live feeds fail and go stale.** Mitigation: immutable snapshots, explicit ages, schedule fallback that is always reported, and a fixed evaluation clock in tests.
- **Scope.** Three capabilities on top of a platform migration. Mitigation: each is opt-in and gated by its own fixtures, so the platform milestones ship independently.

## Open questions

1. Should regional grids reuse an existing grid format for interchange with other analysis tools, or define `vigo.grid.v1` and export only?
2. Which LTS classification should cycling use, and should requests be able to supply their own?
3. Should flex ride times also offer a statistical estimate from realtime history, once available?
4. Where should parking and drop-off facility data come from when OSM is incomplete: a supplied file, a GTFS extension, or both?
