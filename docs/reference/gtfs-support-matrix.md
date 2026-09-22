# GTFS support matrix

This matrix is the public semantic boundary for VIGO routing. “Imported” alone is
not support: the routing column states whether a field changes path feasibility.
New raw imports record a feature inventory. Fixed-stop pickup and drop-off
permissions are compiled per connection: illegal board points are absent from
the departure index, illegal alight points cannot create a reachable state, and
a passenger already aboard may remain on the trip through either kind of
restricted stop. Unsupported transfer semantics are omitted from the generic
stop-pair transfer graph. The remaining network is routed as a
`supported_scheduled_core`, with any exclusions attached to every result. This
is qualified coverage, not an exact claim over the whole feed. Among otherwise
importable GTFS semantics, only multiple agency timezones currently block the
whole store.

| GTFS feature or case | Import | Routing behavior | Classification |
|---|---|---|---|
| `calendar.txt` only | Yes | Weekly service within start/end dates. | Supported. |
| `calendar_dates.txt` only | Yes | Type 1 adds and type 2 removes service on the exact date. | Supported. |
| Calendar plus exceptions | Yes | Exceptions override the weekly calendar for the date. | Supported. |
| Missing both calendar tables | Rejected | No service date can be established. | Rejected malformed input. |
| Times greater than 24 hours | Yes | Preserved as seconds on the originating service day. | Supported within the query horizon. |
| Trips crossing midnight | Yes | Connections remain ordered on the originating service-day coordinate. The caller must query that date with a value above 24 hours; VIGO does not automatically merge yesterday's active trips into a `01:00` civil-date query. | Supported only under explicit service-day coordinates and within the horizon. |
| Trips extending across more than one midnight | Parsed | Same coordinate model; default horizon may exclude them and the public CLI clock is bounded. | Bounded; caller must set a sufficient horizon and service-day coordinate. |
| Invalid minute or second fields | Rejected | Values such as `08:60:00` or `08:00:60` do not normalize silently. | Rejected malformed input. |
| Agency timezone, one timezone | Inventoried | Caller supplies local service date and clock; no zoned-instant conversion. | Partial; DST instant semantics unsupported. |
| Multiple agency timezones in one store | Inventoried | Exact routing is blocked. | Unsupported and visible. |
| `frequencies.txt`, `exact_times=1` | Yes, bounded | The template trip is expanded into deterministic fixed departures for each declared frequency window. Generated instances retain route, service, permissions, and shape identity. | Supported for bounded deterministic windows. |
| `frequencies.txt`, `exact_times=0` | Retained for inspection | No stochastic or deterministic headway waiting model is inferred. The template trip is omitted from compiled connections. | Excluded from the supported scheduled core; visible limitation. |
| Overlapping frequency windows | Yes, bounded | Deterministic windows expand independently and duplicate generated departures collapse by trip/departure identity; inexact headway templates remain excluded. | Supported for bounded `exact_times=1`; visible limitation only for `exact_times=0`. |
| Shapes present | Yes | Ordered trip stops are matched to a monotone shape slice. | Supported for rendering; feasibility never depends on shape. |
| Shapes missing or unusable | Yes | Timetable route remains valid. Ordinary network lenses show no inferred route alignment; selected-itinerary and Shape/Risk QA views may show a dashed, explicitly inferred stop sequence. | Timetable supported; published ride geometry unavailable. |
| Duplicate stop names | Yes | Identity is `stop_id`, not name. | Supported. |
| Parent stations and platforms | Yes | Explicit parent transfer rules expand to child service platforms; selected stations expand to service members. Without an explicit rule, service members share a modeled 120-second connection, reported as `parent_station_fallback` with schematic geometry. | Supported for `location_type` 0/1; fallback time is not a measured station pathway. |
| Deeper `location_type` hierarchy | Parsed as stops | No complete entrance/boarding-area hierarchy model. | Partial. |
| `pathways.txt` direction and traversal time | Yes | Creates directed transfer edges with their declared traversal times; bidirectional rows create the reverse edge. The full pathway mode/hierarchy is not preserved. | Partial. |
| Pathway wheelchair/stair/slope/width attributes | Inventoried | Not applied as query constraints. | Unsupported and visible limitation. |
| Transfer type 0 | Yes | Directed recommended transfer using declared/default duration. | Supported within transfer model. |
| Transfer type 1 timed transfer | Inventoried | The guarantee is not represented; the row is omitted from the generic stop-pair transfer graph. Other supported scheduled service remains routable. | Excluded from the supported scheduled core; visible limitation. |
| Transfer type 2 minimum time | Yes | Declared minimum traversal time is enforced. | Supported. |
| Transfer type 3 forbidden | Yes | Directed pair, including expanded parent/platform pairs, is forbidden and cannot be regenerated by proximity. A same-stop prohibition blocks reboarding after a ride while preserving an origin's initial boarding. | Supported with permanent SQLite, compact-kernel, and matrix regressions. |
| Transfer type 4/5 in-seat semantics | Inventoried | Linked-trip continuation is not represented; the row is omitted from the generic stop-pair transfer graph. | Excluded from the supported scheduled core; visible limitation. |
| Route- or trip-scoped transfer selectors | Inventoried | The stop-pair schema cannot preserve the selector, so the entire scoped row is omitted rather than generalized to every trip. | Excluded from the supported scheduled core; visible limitation. |
| Nearby stops without explicit transfer | Prepared | One native multi-target street search creates every directed OSM-reachable alight-to-board edge within 500 m. Each edge stores its routed distance; unproved radial pairs remain visible counts. | Supported within the City street model. |
| `pickup_type=1` / `drop_off_type=1` | Yes | The complete scheduled trip is retained. Boarding is prohibited only at a stop with `pickup_type=1`; alighting is prohibited only at a stop with `drop_off_type=1`; through-riding remains legal. | Supported for fixed-stop routing. |
| `pickup_type` / `drop_off_type` values 2/3 | Inventoried | The complete scheduled trip is retained, but rider-agency coordination is not a request capability, so the affected board or alight event is conservatively unavailable. | Fixed-stop core retained with visible `on_demand_boarding_or_alighting` limitation. |
| Continuous pickup/drop-off | Inventoried | Scheduled fixed-stop service remains routable. Continuous boarding or alighting between scheduled stops is not represented. | Fixed-stop core retained with visible limitation. |
| Loop routes | Yes | Sequence, not stop identity, orders a trip; reconstruction can retain repeated locations. | Supported, with adversarial regression coverage required. |
| Repeated stop in one trip | Yes | Distinct `stop_sequence` events remain distinct. | Supported. |
| `block_id` interlining | Inventoried | Each trip remains routable as ordinary scheduled service, but VIGO does not infer an in-seat continuation between trips sharing a block. | Included scheduled trips with a visible interlining limitation. |
| Duplicate stop, route, trip, or calendar IDs | Rejected | A primary-key conflict aborts the temporary build; no partial store is published. | Rejected malformed input with adversarial atomicity coverage. |
| Missing shape ID referenced by a trip | Yes | Timetable routing remains available, but published alignment is unavailable; any selected/QA stop-sequence line is dashed and marked inferred. | Timetable supported; published ride geometry unavailable. |
| Untimed interior stop-time gaps | Yes | Timed endpoints remain connected and the itinerary reports `interpolated-stop-time-gap`; no exact timestamp is claimed for omitted interior events. | Supported with degraded timing precision. |
| Malformed required table | Rejected | Build does not commit the temporary store. | Supported rejection. |
| Broken core references | Rejected | Unknown trip routes/services, parent stations, transfer endpoints, frequency trips, and stop-time trip/stop references abort the temporary build. Missing shapes remain a supported timetable-only case as declared above. | Rejected malformed input with adversarial atomicity coverage. |

## Semantic coverage written to store metadata

For otherwise importable GTFS, `blockingRoutingFeatures` currently has one
stable code:

- `multiple_agency_timezones`;

The following nonblocking `routingLimitations` codes put results in
`supported_scheduled_core` mode:

- `frequency_based_service` for `exact_times=0` headway windows;
- `on_demand_boarding_or_alighting`;
- `continuous_pickup_or_drop_off`;
- `scoped_transfer_rules`;
- `timed_transfer_guarantee`;
- `in_seat_transfer_rules`;
- `block_interlining`.

The additional nonblocking code `pathway_accessibility` describes constraints
not represented by the retained graph; it does not by itself change the
coverage mode. “Nonblocking” does not mean full-feed support. It means VIGO can
make a narrower, explicit claim over the compiled scheduled core instead of
disabling unrelated service.

A ready result in `supported_scheduled_core` mode is optimal only over that
compiled core. A `no_path` result in the same mode means no path exists in the
core; an excluded trip or transfer rule could still change full-feed
reachability.

## Required fixture policy

Each row classified supported must have a miniature feed that would fail if the
field were merely parsed. Each visible unsupported row must have a fixture that
imports successfully and records the feature code. Permission fixtures must
prove that the trip remains connected, illegal boarding and alighting events
are rejected, and through-riding remains legal in the resident kernel, shared
matrix path, and merged stores. Quarantined transfer fixtures must prove that
the unsupported row is absent from the generic graph.
Multiple-timezone fixtures must still prove a feed-wide blocked result.
Rebuild an older SQLite store before using it for a published result.
