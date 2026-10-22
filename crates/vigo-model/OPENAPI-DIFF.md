# Generated OpenAPI compared with `docs/standalone-openapi.json`

`generated/openapi.json` is produced from the vigo-model types. `docs/standalone-openapi.json` is the published 1.0.0-rc.1 document, built by `scripts/build-standalone-docs.py` from hand-written definitions plus `pub struct` blocks found in the kernel source. This report lists every difference between them.

The published document is not replaced yet. Its native schemas still need a home (see [Open items](#open-items)).

Every Result recorded in the golden corpus, every Result harvested from the standalone checks, and every request the engine accepted in either set validates against the generated document (`tests/schema.rs`, 539 documents). The published document types most Result fields as bare `object`, so it could not support that check.

## Summary

| Area | Result |
| --- | --- |
| Paths and operations | Same 18 paths, operations and response codes. One query parameter added. |
| Request schemas | Same fields, types, required fields, ranges, lengths, defaults and `additionalProperties: false`. Enum values now live in named schemas. |
| Result schemas | Tightened: typed throughout, every field the engine always writes is required, and fields observed in the corpus but missing from the old document are added. |
| Native operation schemas | Not generated (45 schemas). Deliberate for M0. |

Status values below: **Fixed** means the published document was wrong or incomplete and the generated one corrects it. **Tightened** means the old document was looser than the engine's behavior. **Deliberate** means a chosen difference.

## Paths

| Path | Difference | Status |
| --- | --- | --- |
| `POST /v1/route`, `/matrix`, `/reach`, `/isochrone`, `/compare`, `/native` | Adds the `vigo_diagnostics` query parameter. The engine accepts it, as `docs/reference/results.md` says. | Fixed |
| `GET /v1/info` | `object` becomes `InfoResult` or `CollectionInfoResult`. | Tightened |
| `GET /v1/capabilities` | `object` becomes `Capabilities`. | Tightened |
| `POST /v1/native` | `NativeRequest` and `NativeResult` become untyped objects marked diagnostic. | Deliberate |
| Every error response | `Error` (only `error` and `id` described) becomes `ErrorResult`, with required `schema`, `status` and `error`. | Tightened |
| `GET /healthz`, `/readyz`, document routes | Unchanged. | — |

## Request schemas

`RouteRequest`, `MatrixRequest` and `ReachRequest` carry the same properties, types, required fields, ranges, array lengths, defaults, `format: date` and `additionalProperties: false` (169 constraints). Enumerations that were inline now reference named schemas with the same values: `DiagnosticsLevel`, `Mode`, `ReachMode`, `DataMode`, `ServiceDay`, `TimePreferenceInput`, `AlternativeRanking`, `JourneyFormat`, `ReachFormat`, `SurfaceSampling`.

| Schema | Difference | Status |
| --- | --- | --- |
| `Point`, `Place` | The object form is named `Place`. Unknown fields are rejected, as by the engine (`Unknown point field`). | — |
| `Coordinate`, `Bounds` | Named tuple schemas; `Coordinate` keeps the longitude and latitude ranges. | — |
| `Scenario` | `services` items are the named `ScenarioService` and `ScheduledTrip`, with the same constraints. `overlay` is untyped: it is a native compiled overlay. | Deliberate |
| `RealtimeSnapshot` | Trip updates, stop time updates and time events are named schemas with the same fields and constraints. Enumerations accept a name or a code, as before. | — |
| `Traffic` | The two forms are named `PreparedTraffic` and `ObservedTraffic`. | — |
| `CompareRequest` | Adds `diagnostics` and `id`, which the engine reads. `before` and `after` also accept an internal trace result: `vigo compare` takes those, and the standalone checks send them. | Fixed |

## Result schemas

| Schema | Difference | Status |
| --- | --- | --- |
| `RouteResult`, `MatrixResult`, `ReachResult` | `query`, `meta`, `diagnostics`, `profile`, `access`, `reason`, `warnings`, `alternativeSearch` and `accessibility` change from bare `object` to typed schemas. `mode` is required. | Tightened |
| `RouteResult`, `MatrixResult`, `ReachResult` | Add `scenarioId` (scenario collections) and `sequence` (resident stream). | Fixed |
| `MatrixResult` | Adds `access` and `distancesMeters`. Removes `warnings`, which the engine writes only for Route. | Fixed |
| `ReachResult` | Adds `stops` and `scenarioStops`. Removes `warnings`. Requires `areas`. | Fixed |
| `CompareResult` | Adds `beforeStatus`, `afterStatus`, `cityRevisions`, `transferChange`, `trace`, `id` and `sequence`. Types `counts`; `faster`, `slower` and `unchanged` are optional, because a comparison of internal results omits them. | Fixed |
| `datasetLimitations` | Untyped becomes `DatasetLimitation`: `code`, `count`, `exactness`, `detail`. | Fixed |
| `trace`, `memory`, `residency`, `allocator` | Any JSON. | Deliberate |

### Renamed

| Published name | Generated name |
| --- | --- |
| `Error` | `ErrorResult` |
| `PublicJourney` | `Journey` |
| `PublicLeg` | `Leg`: `StreetLeg` for `walk` and `drive`, `TransitLeg` for `transit` |
| `PublicEndpoint` | `Endpoint` |
| `PublicIdentifier` | `Identifier` |
| `RouteDisplay` | `TransitRoute`, which adds the `id` and `name` the engine writes |
| `ReachAreas`, `ReachContours` | `CutoffFeatures` |
| `StreetEdgeBundle` | `StreetEdges` |
| `StreetSurfaceNode` | `SurfaceNode` |

`Journey`, `ReachStop` and `ReachSurface` exist in both documents with different meanings. In the published document they describe native structures, with times in minutes; in the generated document they are the public ones, with times in seconds.

### Leg details

The published `PublicLeg` is one schema for every leg type. The generated `Leg` splits by `type`, so each kind lists only the fields the engine writes for it:

- `TransitLeg` requires `route`, `trip`, `service`, `serviceDate`, `directionId`, `headsign` and `tripShortName` (each may be `null`). It adds `fare` and `quality` `{ geometry, schedule }`.
- `StreetLeg` adds `components` and `endpointConnector`, with `quality` `{ streetGeometry, geometrySource, stationPath?, stationTime? }`.
- Both can have `null` clocks and duration when the source lacks them, so `departureTime`, `arrivalTime` and `durationSeconds` are nullable.
- `Journey.drivingSeconds` is omitted rather than `null`. `Journey.transfers` may be `null`.

### Facts the corpus established

These were not in the published document and are now part of the model:

- `geometrySource` is an open vocabulary. It includes `osm_and_station_path` and `gtfs_pathway`, and the Node runtime can write other values. It is a documented string, not an enum.
- A fare is `{ status: "published", standard, source?, options, agencyUrl? }` or `{ status: "unavailable", code, reason }`. Fares v2 options add `riderCategory`.
- Feed scopes are `null` for a City built from one feed, even with `--gtfs-scope`. Two or more scoped feeds give string scopes.
- `clockDate` and `query.serviceDate` are `null` for a walking or driving query without a service date.
- The standalone engine rejects `serviceDay` for transit; transit needs `serviceDate`.
- Matrix `access` reports are keyed by endpoint index.

## Not generated

Of the 55 schema names found only in the published document, 10 are the renamed public schemas above. The other 45 describe `/v1/native` operations and the internal trace ABI. They are outside the public stability policy and remain documented in `docs/reference/rust-standalone-native.md`:

- **Timetable:** `TimetableQueryInput`, `TimetableQueryResult`, `TimetableArriveByQueryInput`, `TimetableArriveByQueryResult`, `TimetableMatrixQueryInput`, `TimetableMatrixQueryResult`, `TimetableMatrixJourney`, `TimetableMatrixLeg`, `TimetableManyQueryInput`, `TimetableManyQueryResult`, `TimetableArriveByManyQueryInput`, `TimetableArriveByManyQueryResult`, `TimetableParetoQueryInput`, `TimetableParetoQueryResult`, `TimetableParetoAlternative`, `TimetableOverlayManyQueryInput`, `TimetableOverlayManyQueryResult`.
- **Access and street:** `EndpointRoleInput`, `EndpointRoleResult`, `EndpointRouteInput`, `EndpointRouteResult`, `StreetPathInput`, `StreetPathResult`, `StreetMatrixInput`, `StreetMatrixResult`, `StreetSurfaceInput`, `StreetSurfaceResult`, `StreetSurfaceEdge`, `TimedConnectorInput`, `TimedConnectorResult`.
- **Drive:** `DriveQueryInput`, `DriveTrafficInput`, `DriveQueryResult`, `DriveMatrixInput`, `DriveMatrixResult`.
- **Realtime:** `RealtimeTimetableInput`, `RealtimeTripInput`, `RealtimeCallInput`, `RealtimeTimetableResult`.
- **Other:** `ReachOverlay`, `NativeRequest`, `NativeResult`, `QueryMetadata`, `JourneyEndpoint`, `RouteLeg`.

## Open items

1. **Native schemas.** In M1, derive `JsonSchema` on the kernel's native input and result structs where they live, and include them from there. This replaces the regular-expression scan in `scripts/build-standalone-docs.py`. Until then the published document stays the reference for `/v1/native`.
2. **Replacing the published document.** Once native schemas are generated, `npm run docs:standalone` can write `docs/standalone-openapi.json` from `vigo-model-gen`, and `check:standalone-docs` can compare against it.
3. **Continuous integration.** CI and release checks run `check:rust-workspace` (including model, schema and generated-file checks) and `check:corpus`.
