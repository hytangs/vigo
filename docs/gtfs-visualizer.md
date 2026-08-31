# Network workspace: GTFS visualizer

## Overview

The **Network** workspace answers:

> What service and network structure did VIGO actually load from this GTFS
> dataset?

It is the visual inspection surface for routes, stops, scheduled patterns,
transfer relationships, geometry, service coverage, and data-quality signals.
It does not change the source feed or the routing objective.

In the desktop rail, open **Network** or press `1`.

## What you can inspect

- every active public route identity in the persisted catalog;
- route names, modes, colors, and source identifiers;
- reconstructed directional stop-sequence patterns;
- stops, parent stations, platform codes, and route membership;
- scheduled trip counts, service span, and derived median headway;
- published GTFS shapes and explicitly marked stop-sequence geometry;
- explicit and inferred transfer relationships;
- weekday, Saturday, and Sunday temporal views;
- complete selected-time scheduled vehicle projections and positioned GTFS-RT
  fleets;
- validation, shape, service, transfer, and scenario-risk signals; and
- normalized GTFS lineage for the selected route or stop.

## Typical workflow

1. Import a GTFS ZIP and wait for the SQLite index.
2. Choose the active feed or combined project scope.
3. Use search, the service list, or the map to select a route or stop.
4. Change the service-day/time controls and inspect the temporal view.
5. Switch lenses to isolate shape, service, transfer, or risk questions.
6. Open source tables when the displayed interpretation needs confirmation.
7. Continue to **Route** for a traveler query or **Evidence** for a network
   accessibility question.

## Network representation

VIGO keeps four evidence layers separate:

1. **GTFS facts** are imported identifiers, rows, timestamps, coordinates, and
   published shapes.
2. **Derived network structure** includes route-pattern families, service
   summaries, stop-sequence relationships, and transfer candidates.
3. **Review state** records how a user classifies a finding.
4. **Visualization geometry** is either a published shape or an explicitly
   inferred ordered-stop line.

Published shape coordinates retain their source order and point set. Inferred
stop-sequence lines are not presented as agency-published geometry: ordinary
network lenses hide them, while selected-route and Shape/Risk views distinguish
them visually.

The imported ZIP remains the byte-preserving source artifact. The SQLite model
exposes normalized source identifiers, but it does not guarantee an original
CSV line number for every displayed relation.

## Route identity and patterns

The service identity is the feed-scoped GTFS `route_id`. Public names are
labels, not keys. Two agencies—or two records in one large feed—may reuse the
same short name without being merged.

When a long name is absent, VIGO uses scheduled endpoints to distinguish route
records. If the public name and endpoint label still collide, the interface
adds a compact route-ID discriminator. Multiple directional or stop-sequence
patterns under one route ID remain grouped as one service in the inspector.

Selecting a route opens a read-only focused analysis from the local SQLite
store. It reports all observed stop-sequence patterns, associated stops and
stop pairs, trip counts, service span, median headway, and available published
geometry. **Full service** is the default: every pattern belonging to the
feed-scoped `route_id` is drawn as its own feature. VIGO never joins one
pattern's endpoint to another. **Patterns** is an optional diagnostic view that
isolates one stop sequence without redefining the public service.

## Map interactions and lenses

The map and object panel share selection. Search or list selection focuses the
same network object shown on the map; clearing the object returns to the network
overview.

| Lens | Use it to inspect |
| --- | --- |
| Network | Overall routes and stops |
| Shape | Published versus inferred geometry |
| Service | Scheduled span, patterns, and service intensity |
| Transfer | Encoded and derived interchange relationships |
| Risk | Blocking data, weak geometry/service evidence, and scenario deltas |

The route list may use a bounded rendering view for responsiveness, but the
persisted catalog and focused analysis retain the complete route identity set.
Published route coordinates are not simplified to create a top-N service view.

## Vehicle playback and live operation

The **Schedule** source renders every exact trip active at the selected minute
when the trip has timed stop events and usable route geometry. It does not
manufacture headway vehicles when exact trips are absent. The **Live** source
renders only valid Vehicle Positions; switching sources is explicit.

GTFS-RT commonly arrives as three feeds with different jobs: **Vehicle
Positions** supplies map coordinates, **Trip Updates** changes expected stop
times, and **Service Alerts** supplies rider-facing advisories. Paste the three
URLs one per line in **Live data**; a standard MBTA URL also expands to the
documented three-feed set server-side.

Once a live snapshot is connected, select **Live** to render every valid
vehicle position. A snapshot with zero valid Vehicle Positions stays visibly
at **Live · 0 vehicles**; a failed refresh retains the last live frame and never
substitutes scheduled dots. Select **Schedule** deliberately to return to the
exact timetable projection. The routing overlay's separate trip-update safety
bound does not cap map vehicles.

The network view retains the complete positioned fleet. Route focus defaults
to every static pattern in the selected public service and shows and hit-tests
only that service's live vehicles; its counter is therefore route-specific.
Vehicle cards join Vehicle Positions to Trip Updates and static stop names.
Absolute GTFS-RT arrival events and the update's final stop remain usable for
`ADDED` trips that have no matching static trip row.

Static and live vehicles are normalized into one service frame and use one
GeoJSON source, layer stack, hit-test path, and detail card. Rendering stays
bounded without hiding service: the app retains only the current frame, gives
vehicle features stable IDs, and applies one incremental source update per
animation frame. Every vehicle keeps a visible point; heading, halo, and
route-label detail is reserved for the selected route to reduce overdraw.
Route-list virtualization limits DOM work only and does not prune the map or
persisted catalog.

## Common use cases

### Understand an unfamiliar feed

Start at the network overview, inspect route types and coverage, then select
representative services and stops. The calculation-lineage panel shows which
parts are source facts and which are derived.

### Check a service change

Inspect route identity, patterns, trip totals, service span, and stop membership
before moving to the Evidence workspace for a controlled baseline/case
comparison.

### Diagnose geometry or hierarchy problems

Use Shape and Risk to find missing shapes, inferred alignments, isolated stops,
or incomplete station relationships. Treat a warning as an investigation cue,
not automatic proof that the agency feed is wrong.

### Prepare a routing experiment

Confirm service-date coverage, route/stop identity, geometry source, and OSM
availability before generating OD queries or comparing engines.

## Limitations

- Network inspection is not a full GTFS validator or editing environment.
- Static schedules do not establish reliability, ridership, passenger behavior,
  equity, or causal effects.
- GTFS-Realtime can be inspected as a live map overlay. Every valid vehicle
  position is rendered directly; trip updates may adjust exact-date depart-at
  routing, but alerts and positions never become invented routing edges.
- Frequency-based service is retained for inspection but excluded from the
  supported scheduled-routing core.
- Source-row offsets and a complete byte-level replay ledger are not exported
  for every normalized relation.

See the [GTFS support matrix](gtfs-support-matrix.md),
[development architecture](development/architecture.md), and [known routing
limitations](known-routing-limitations.md) for the technical boundary.
