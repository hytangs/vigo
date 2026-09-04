# Known limits

VIGO models the City revision and Query it is given. It does not certify real-world service, demand, safety, or operational feasibility.

## GTFS

- Support is limited to the source features listed in the [GTFS support page](gtfs-support-matrix.md).
- Missing published shapes do not prevent timetable Route but limit map geometry.
- Block-based in-seat continuation is not inferred.
- Unsupported or malformed source features are reported during Build.

## Transit Route and Matrix

- Transit Matrix supports fixed departure in VIGO 0.3.
- Arrive-by is available for point-to-point transit Route.
- Departure windows sample integral minutes; they are not continuous profiles.
- Coordinate transit depends on the supplied OSM walking network and configured walking limit.

## Streets

- Walk and Drive depend on OSM coverage and directionality.
- Drive does not yet model all turn restrictions, signals, or intersection delay.
- Traffic must be supplied by the caller; VIGO does not fetch a provider.

## Realtime

- Realtime transit applies only matched, sufficiently fresh Trip Updates.
- Unsupported or unmatched updates remain visible and do not silently rewrite the schedule.

## Scenario

- Planned transit service changes are supported for Reach in VIGO 0.3.
- Supplied traffic is supported for Drive Route and Drive Matrix.
- Other combinations return `unsupported`.

## Reach

Reach measures modeled travel time, not people, jobs, demand, welfare, observed behavior, or operational feasibility. Add opportunity data and a stated measure before describing an analysis as Accessibility.
