# Known limits

VIGO models the City revision and Query it is given. It does not certify real-world service, demand, safety, or operational feasibility.

## GTFS

- Support is limited to the source features listed in the [GTFS support page](gtfs-support-matrix.md).
- Missing published shapes do not prevent timetable Route but limit map geometry.
- Block-based in-seat continuation is not inferred.
- Unsupported or malformed source features are reported during Build.

## Transit Route and Matrix

- Transit Matrix supports depart-at and arrive-by. Arrive-by duration includes any wait between actual arrival and the deadline; use Route for itinerary legs and actual arrival.
- Arrive-by is available for point-to-point transit Route.
- `maxTransfers` accepts integers 0–31; omit it for no additional cap. Combining a finite cap with ordered transit waypoints is currently unsupported.
- Station returns may be valid in the supplied timetable. They are flagged for inspection, not automatically excluded.
- Without an explicit rule, service platforms sharing a parent station use the existing 120-second transfer assumption. These legs report `transferSource: 'parent_station_fallback'` and schematic geometry, not a verified station pathway. Only generated OSM transfers claim a corresponding street-path witness.
- A street route to a platform coordinate does not establish an entrance/platform connection. Selected walks touching subway stops or station platforms report `stationAccessStatus: 'unverified'` unless they carry a declared pathway; `streetPathVerified` is false for these walks, while `streetSegmentVerified` preserves the narrower OSM result. `source_path` means a declared station path, not field-verified traversal. Exact platform endpoints need no entrance walk. Missing interior paths remain a routing-model limitation, including possible street shortcuts where a station has declared pathways; VIGO adds no inferred station-time penalty. Route diagnostics and the displayed detail expose this limitation. Scalar Matrix results do not provide this per-leg audit.
- Departure windows sample integral minutes; they are not continuous profiles.
- Coordinate transit depends on the supplied OSM walking network and configured walking limit.

## Streets

- Walk and Drive depend on OSM coverage and directionality.
- Authorized private endpoint access is an opt-in City build model; see [Street routing](street-routing.md). It does not establish individual permissions, gate hours, or missing connections.
- Drive does not yet model all turn restrictions, signals, or intersection delay.
- Traffic must be supplied by the caller; VIGO does not fetch a provider.

## Realtime

- Live transit routing is available only through Studio Route. Public CLI/Python live Scenarios, realtime Matrix, and realtime Reach are unsupported. Vehicle Positions and Alerts are inspection/display data; they do not change route costs or close services.
- Only FULL_DATASET feeds are decoded. Routing matches existing scheduled trips and the supplied service date, applies supported trip/stop delays or times, and removes matched CANCELED/DELETED trips. Added, duplicated, replacement, unscheduled trips and skipped-stop changes are unsupported.
- A feed timestamp older than 180 seconds falls back to the static schedule. A missing timestamp cannot establish freshness; there is no guarantee of feed completeness, delivery latency, or observed operations. Inspect the Result's realtime diagnostics and schedule mode.
- The overlay considers at most 1,024 updates and retains at most 256 adjusted trips, subject to an additional stop limit. Unmatched, unsupported, invalid, and pruned records do not provide network-wide realtime coverage. A route is computed against this bounded overlay and the remaining static schedule.

## City reuse and platforms

- Copy the entire City directory; street indexes and prepared files are part of it. The native runtime executable is specific to OS/CPU, while City data is portable across the supported 64-bit targets.
- An older timetable cache may require one preparation in 0.3.1. New active-service patterns, changed walking policy, or evicted snapshots also require preparation. Missing/corrupt required street indexes are errors, not permission to query a different graph; restore the complete City or rebuild it from source.
- Studio project-library settings, drafts, and live connections are local application state and do not travel inside a CLI City. Studio cannot directly open CLI City directories in 0.3.1.

## Scenario

- Planned transit service changes are supported for Reach in VIGO 0.3.
- Supplied traffic is supported for Drive Route and Drive Matrix.
- Other combinations return `unsupported`.

## Reach

Reach measures modeled travel time, not people, jobs, demand, welfare, observed behavior, or operational feasibility. Add opportunity data and a stated measure before describing an analysis as Accessibility.
