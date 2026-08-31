# Route workspace

## Overview

The **Route** workspace computes scheduled public-transport itineraries and
directed street paths between ordered locations. It answers:

> How can a traveler make this trip under the selected date, time, street
> network, and routing assumptions?

Transit combines OSM access, the exact represented timetable, transfers, and
OSM egress. Walk and Drive operate directly on their local directed OSM
profiles. Open **Route** or press `2`.

## Requirements

- A ready GTFS SQLite store is required for Transit.
- An OSM street store is required for coordinate-based Transit, Walk, and
  Drive.
- Exact stop-to-stop Transit can run without OSM.
- The selected service date must fall inside complete indexed timetable
  coverage. Representative-date substitution is not automatic.

When a required store or accelerator is missing, stale, or source-mismatched,
VIGO blocks the request with a preparation or rebuild reason.

## Query model

| Input | Current behavior |
| --- | --- |
| Locations | Origin, destination, and up to six ordered intermediate stops; eight points total |
| Location type | Exact stop/station identity or map coordinate |
| Mode | Transit, Walk, or Drive |
| Time | Depart-at for all modes; arrive-by for one-to-one Transit |
| Date | Explicit local GTFS service date for Transit |
| Departure search | Exact departure or a finite 20-minute forward profile in the desktop |
| Walking assumption | Maximum access/egress distance; routing uses the declared global walking speed |
| Long walk-only comparison | Optional; when disabled, walk-only fallbacks stay within the endpoint access/egress limit |
| Transit policy | Desktop requests the bounded balanced choice policy and preserves the fastest objective as a separate contract |

Place text is matched against the selected workspace. If a name maps to more
than one stop or station, VIGO asks for confirmation before routing. Map points
retain their coordinate identity rather than being silently converted to the
nearest GTFS stop.

## Typical workflow

1. Choose Transit, Walk, or Drive.
2. Enter the ordered locations or select them on the map.
3. For Transit, choose Depart or Arrive, date, and time.
4. Choose exact departure or **Later departures**, set the access/egress
   limit, and decide whether to allow longer walk-only fallbacks.
5. Select **Directions**.
6. Compare the bounded choice set, including the reported earliest transit
   boarding, and open one itinerary for full detail.
7. Inspect any warning, support classification, or rebuild requirement before
   using the result as evidence.

The command palette also accepts phrases such as:

```text
transit from Stop A to Stop B at 08:00
walk from Place A to Place B
drive from Place A -> Via C -> Place B at 17:30
arrive by 09:00 from Stop A to Stop B
```

Bike terms are rejected because Bicycle is not a supported routing mode.

## Routing modes

### Transit

Transit finds temporally feasible scheduled journeys. Coordinate queries use
the directed pedestrian graph for access and egress, then enter the resident
service-date timetable. Exact-stop queries start or finish at the selected
stop/station identity.

The fastest production objective is lexicographic earliest arrival followed by
fewest boardings at that arrival. The desktop's balanced choices evaluate a
bounded nondominated frontier under a disclosed elapsed-time, transfer, and
walking policy; they are useful alternatives, not a redefinition of the
fastest theorem.

### Walk

Walk returns the shortest path on the stored directed pedestrian graph. It
respects admitted pedestrian access and directionality. A visually short chord
across water, a barrier, or disconnected components is not substituted for a
missing graph path.

### Drive

Drive returns the fastest path on the stored directed road graph, subject to
the configured distance ceiling. It respects admitted motor access, one-way
edges, roundabout direction, and parsed/default speed values. Free-flow time is
the default metric. A fresh normalized traffic snapshot may slow or close
directed edges and customize the resident CCH time metric without rebuilding
its topology.

Traffic-aware Drive is exact for the admitted graph and that normalized
snapshot. It still does not model signals, turn costs, or OSM turn-restriction
relations, and the quality of coordinate-matched observations remains bounded
by the caller's traffic adapter.

## Depart-at, arrive-by, and later departures

- **Depart-at** evaluates one fixed departure.
- **Arrive-by** finds a latest feasible departure for one-to-one Transit and
  forward-verifies the returned itinerary.
- **Later departures** samples a finite forward window in one-minute steps and
  retains at most five choices. It is not a continuous-time profile or a
  stochastic headway model.

Arrive-by matrices are unsupported. Walk and Drive use depart-at presentation;
their graph weights are not schedule-dependent.

## What VIGO returns

A ready plan includes:

- displayed departure and arrival;
- leave-to-arrival journey time, with any wait after the requested time shown
  separately;
- total elapsed time from the requested time for arrival-oriented ordering;
- access and egress walks;
- initial and transfer waiting;
- scheduled ride legs with route, trip, and stop identity;
- intermediate ordered points;
- transfer and boarding counts;
- selected geometry and its source;
- algorithm, objective, preparation, search, and cache diagnostics; and
- explicit data-semantics warnings or limitations.

The desktop may defer the initial access walk so it ends at the first boarding,
reducing unnecessary curbside waiting in the instructions. The underlying
vehicle events, arrival time, and post-departure waits do not change.

## Reading an itinerary

Read a plan in this order:

1. Confirm the requested and displayed departure times.
2. Check that the service date and route identities match the intended trip.
3. Review access distance and whether the origin/destination were exact stops or
   street coordinates.
4. Follow each walk, ride, wait, and transfer in chronological order.
5. Inspect the geometry source: a published GTFS shape is different evidence
   from an inferred stop sequence.
6. Open diagnostics when a result is blocked, degraded, cached, or marked with
   unsupported feed semantics.

A route result is not merely one travel-time number: its itinerary and source
identity are part of the evidence.

## Important semantics

- Boarding slack and transfer time are applied before the next boarding.
- Pickup and drop-off permissions are represented per scheduled connection.
- Calendar exceptions override weekly service for the explicit date.
- Times beyond 24:00 stay on the originating service-day coordinate.
- Query time is not a timezone-aware instant.
- Direct walking competes with transit when the OSM graph can certify it.
- A cache hit reuses an identity-bound result; cached latency is reported
  separately from new-query search latency.
- A blocked result remains blocked. VIGO does not use a straight-line or
  frequency fallback to manufacture a journey.

## CLI and integrations

The built CLI is `dist-cli/vigo.mjs`. Long-running callers can use
`route-ndjson`, so repeated requests with the same service date and day pay
process and preparation cost once while preserving per-request timing.
`one-to-many` uses one resident forward matrix scan for one origin instead of
looping over point requests.

See the [CLI process contract](vigo-cli.md) for command schemas, timing, and
failure behavior. External language bindings should wrap those versioned JSON
or NDJSON schemas and obtain VIGO as a separately verified runtime; they are
not part of this Rust-engine repository.

## Reproducibility

A routing result depends on the exact GTFS and OSM source identities, compiled
store and accelerator versions, VIGO source/runtime version, service date,
departure/arrival constraint, ordered endpoints, access policy, transfer
policy, search horizon, and routing objective. Retain those fields and the
returned diagnostics with any result used outside an interactive session.

Performance observations must separate source build, preparation, graph
loading, new-query latency, and exact-repeat cache latency. Retain the source
and derived-artifact identities described in the [cache and provenance policy](cache-provenance.md).

## Limitations

The current scheduled core does not model frequency-based service, `block_id`
interlining, guaranteed timed transfers, fares, reliability, full pathway
accessibility, or GTFS-Realtime changes. Continuous departure profiles,
arrive-by matrices, and Bicycle are unsupported.

See the [normative routing contract](routing-contract.md),
[street-routing contract](street-routing.md), [GTFS support matrix](gtfs-support-matrix.md),
and [known limitations](known-routing-limitations.md).
