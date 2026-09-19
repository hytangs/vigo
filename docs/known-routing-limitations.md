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

- Realtime transit Route is available in the desktop and CLI. CLI Route requires a supplied `realtimeSnapshot` and `--data-mode realtime`; it does not fetch feeds. Matrix and Reach reject realtime requests. Vehicle Positions and Alerts do not change route costs or close services.
- Only FULL_DATASET feeds are decoded. Routing updates modify matched scheduled trips, remove CANCELED/DELETED trips, and omit SKIPPED calls. Added, duplicated, replacement, and unscheduled trips without a supported scheduled instance remain unsupported for routing. Studio can still [display reported added service](network.md#added-service) in line views and the trip selector.
- Feed and record timestamps must pass freshness checks. Engine admission accepts observations up to 180 seconds old and 60 seconds ahead of its captured clock; the Network workspace may apply its own admission policy. Missing timestamps do not establish freshness. Inspect diagnostics for exclusions and scheduled fallback.
- The complete supplied snapshot is processed without the former trip/update caps. Unreported trips retain scheduled times; rejected updates do not establish coverage or actual operations. See [realtime routing](realtime-routing.md) for admission rules, diagnostics and verification.

## City reuse and platforms

- Studio maps require WebGL 2. Engine and Python queries do not require a graphics device.
- Supported native targets are macOS 13.5+ on Apple Silicon/Intel, Linux glibc on ARM64/x64, and Windows x64. Linux release builds use Ubuntu 24.04. Alpine/musl, 32-bit, and native Windows ARM64 builds are not provided.
- Copy the entire City directory; street indexes and prepared files are part of it. The native runtime executable is specific to OS/CPU, while City data is portable across the supported 64-bit targets.
- An older timetable cache may require one preparation in 0.4.0. New active-service patterns, changed walking policy, or evicted snapshots also require preparation. Missing/corrupt required street indexes are errors, not permission to query a different graph; restore the complete City or rebuild it from source.
- Studio project-library settings, drafts, and live connections are local application state and do not travel inside a CLI City. Studio cannot directly open CLI City directories in 0.4.0.

## Scenario

- Planned transit service changes are supported for Reach in VIGO 0.4.0.
- Supplied traffic is supported for Drive Route and Drive Matrix.
- Other combinations return `unsupported`.

## Reach

Reach measures modeled travel time, not people, jobs, demand, welfare, observed behavior, or operational feasibility. Add opportunity data and a stated measure before describing an analysis as Accessibility.
