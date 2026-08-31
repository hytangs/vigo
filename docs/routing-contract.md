# VIGO routing contract

Status: public pre-release contract for VIGO 0.3.0.

This document defines the behavior expected from the scheduled-routing engine.
The native Rust kernel owns timetable and street search. The desktop, local
HTTP API, and CLI validate requests and shape results; they must not implement
an alternate router.

## 1. Scope of a result

A VIGO result is evaluated over a compiled model, not over every possibility in
the physical transit system. The model is fixed by:

- the selected static GTFS source and service date;
- the supported GTFS features admitted during compilation;
- the optional OpenStreetMap street source;
- endpoint, walking, transfer, horizon, and objective settings; and
- any query-scoped exclusions or scenario additions.

`ready` means that the engine found a path in that model. `no_path` means that
it did not find one in the compiled supported model. Neither status certifies
observed operations, accessibility in the field, or future service.

## 2. Time and service dates

The caller provides a service-local date and a clock time. GTFS times greater
than 24 hours remain attached to the service day on which the trip begins.
VIGO combines `calendar.txt` and `calendar_dates.txt` for the requested date;
an added exception activates service and a removed exception deactivates it.

VIGO does not currently accept a zoned instant and does not resolve ambiguous
or nonexistent daylight-saving times. A compiled store with incompatible
agency time zones is blocked instead of silently combining service-day clocks.

The default fixed-time routing horizon is 480 minutes and is never shorter than
180 minutes unless a supported analytical operator explicitly allows a smaller
bound. A ride that alights inside the horizon may complete its final egress
after the bound, but it may not use that extension to board another service.

## 3. Network compilation

Static GTFS is normalized into a local SQLite store. Routing preparation reads
that store and creates source-identified native artifacts for the requested
service date. SQLite is construction and durable storage; an interactive route
search is not silently moved into a JavaScript or SQL fallback.

OpenStreetMap input is compiled into directed walking and driving graphs.
Native snapshots and contraction-hierarchy customizations are admitted only
when their schema, source identity, profile, and counts match the durable
store. Missing or stale artifacts produce an explicit rebuild state.

Generated stores and accelerators are derived output. The original GTFS ZIP and
OSM PBF remain the source inputs and should be retained separately.

## 4. Endpoints, walking, and transfers

An exact stop or parent-station endpoint can be routed without an OSM store.
A coordinate endpoint requires a ready OSM street store. VIGO does not replace
a missing pedestrian path with straight-line access.

For coordinate transit routing, the engine attaches the point to compatible
directed street edges, enumerates eligible stop anchors within the requested
walking limit, and verifies each retained connector on the street graph.
Walking limits apply independently to access and egress.

The default walking policy uses 4.8 km/h, a factor of 1, and no fixed endpoint
overhead. Advanced local deployments may set the documented walking environment
variables before starting a worker. The selected values and policy identity are
included in diagnostics so two configurations cannot share an incompatible
prepared artifact.

Explicit GTFS and pathway transfer edges are directed. `transfer_type=3`
forbids the represented transfer. Parent-station transfer rules are expanded
to eligible service platforms. Optional OSM-derived stop transfers are retained
only when a directed pedestrian path is available and the artifact identity is
current.

The current model does not interpret an arbitrary chain of pathway fragments as
a standalone pedestrian subnetwork. See the [support matrix](gtfs-support-matrix.md)
for feature-level behavior.

## 5. Scheduled-routing objective

The strict point-routing objective is lexicographic:

1. earliest destination arrival; then
2. fewer vehicle boardings at equal arrival.

Access, initial waiting, transfers, rides, and egress all contribute to elapsed
time. Remaining on one GTFS trip does not add a boarding. A new boarded trip
does, and public `transfers` is `max(0, boardings - 1)`.

The public one-to-one interface also exposes a `balanced` objective. It begins
from the strict fastest witness, retains a bounded nondominated set over
arrival, boardings, and walking, and minimizes the declared generalized cost
inside that set. The response records the selected objective and relevant
bounds. `balanced` is not a claim about an individual traveler's preferences.

A graph-verified direct walk may compete with transit. It can bypass the
timetable only when the engine has a valid lower-bound proof that transit
cannot match it; otherwise both options are evaluated before selection.

## 6. Supported operators

| Operator | Time rule | Output |
| --- | --- | --- |
| Depart-at point route | Search begins no earlier than the requested time | Replayable itinerary and bounded choices |
| Arrive-by point route | Maximize a feasible origin departure before the deadline | Forward-replayable itinerary |
| Departure profile | Evaluate a finite series of fixed departure times | Samples and selected choices |
| Forward matrix | Earliest arrival for each supplied pair | Origin-major scalar rows |
| Accessibility range | One origin to all represented destinations within a cutoff | Stop fields and a directed street surface |
| Drive point route | Minimize the configured street travel-time metric within a distance cap | Street path and diagnostics |
| Drive matrix | Apply the same active street metric to each pair | Scalar rows |

An arrive-by matrix is not part of the current matrix schema. Unsupported
operators are rejected rather than reinterpreted as a different query.

Arrive-by candidate generation may run in reverse, but the returned itinerary
must be reconstructed and checked in forward chronological order. A candidate
that cannot be replayed forward is not returned as ready.

## 7. Itinerary and choice output

A ready itinerary contains ordered walk and ride state transitions with
nondecreasing times, concrete boarding and alighting stops, route and trip
identities, and a final arrival equal to the plan arrival. Published GTFS shape
coordinates retain their source order. Inferred geometry is marked as inferred
and does not change timetable feasibility.

The desktop may display a later leave time when access walking can be deferred
to end at the first boarding. That presentation change must preserve the
selected trip identities, ride times, arrival, and requested-time diagnostics.

Choice lists are bounded and deduplicated by concrete routing identity. Fewer
than the maximum number of choices is valid; the engine does not duplicate one
journey to fill a list.

## 8. Failure contract

Core route failures include:

- `access_unreachable`;
- `street_access_unverified`;
- `access_budget_exceeded`;
- `service_inactive`;
- `coverage_incomplete`;
- `no_path`; and
- `unsupported_gtfs_feature`.

Every serialized plan carries `diagnostics.routingStatus` using the shared
states `ready`, `blocked`, `unsupported`, `stale`, `cancelled`, and `error`.
Local HTTP failures repeat the state in a machine-readable error envelope and
may add retry and remediation information.

Cached and uncached answers must have the same routing meaning. Cache status,
preparation time, and query time are reported separately.

## 9. GTFS compilation boundary

The compiler inventories source features before routing:

- `frequencies.txt` rows with `exact_times=1` can be expanded into fixed
  departures; non-exact headway templates are not interpreted as a stochastic
  waiting model;
- pickup and drop-off restrictions are applied to boarding and alighting;
- continuous pickup and drop-off between fixed stops are not represented;
- route- and trip-scoped transfer rules outside the current generic transfer
  model are recorded as limitations;
- trips with `block_id` remain scheduled trips, but VIGO does not infer an
  in-seat continuation between separate trips; and
- incompatible agency time zones block compilation.

When an unsupported feature can be isolated, the result identifies the store as
a supported scheduled core with incomplete coverage. When the time coordinate
or another feed-wide prerequisite is unsafe, routing is blocked.

## 10. Isolation and determinism

Requests are bound to source, service-date, street-profile, and policy
identities. Scenario overlays, exclusions, cancellation state, and temporary
labels are request-local and must not leak to a later query. Repeating the same
request against the same admitted artifacts should preserve its semantic result
even when preparation or cache state differs.

This is a pre-release contract. Any change to an objective, supported GTFS
feature, failure code, or process schema must update the relevant reference and
focused test in the same change.
