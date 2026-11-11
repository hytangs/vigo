# API schema

Generated for VIGO 1.0.0 from `crates/vigo-model`, the types that read every public request and write every public Result. Regenerate with `npm run docs:standalone`; the documentation check fails when this page is stale.

Use it to look up a field. The [engine reference](../guides/rust-standalone.md) explains how requests behave, and [public results](results.md) explains how to read answers. The same definitions are in the [OpenAPI document](../standalone-openapi.json). The engine also validates what a schema cannot express, such as combinations of fields, and accepts a few fields the typed model does not list yet; the engine reference documents every accepted field.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /v1/capabilities` | — | [Capabilities](#capabilities) |
| `POST /v1/compare` | [CompareRequest](#comparerequest) | [CompareResult](#compareresult) |
| `GET /v1/info` | — | [InfoResult](#inforesult) or [CollectionInfoResult](#collectioninforesult) |
| `POST /v1/isochrone` | [ReachRequest](#reachrequest) | [ReachResult](#reachresult) or [DistributionResult](#distributionresult) |
| `POST /v1/matrix` | [MatrixRequest](#matrixrequest) | [MatrixResult](#matrixresult) or [DistributionResult](#distributionresult) |
| `POST /v1/reach` | [ReachRequest](#reachrequest) | [ReachResult](#reachresult) or [DistributionResult](#distributionresult) |
| `POST /v1/route` | [RouteRequest](#routerequest) | [RouteResult](#routeresult) or [DistributionResult](#distributionresult) |

## Request schemas

Request bodies for `POST /v1/route`, `/v1/matrix`, `/v1/reach` (and `/v1/isochrone`) and `/v1/compare`, the same objects the command line and the resident stream accept, and the types they use.

### RouteRequest

`POST /v1/route`: journeys between two places.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `allowLongWalk` | boolean |  | `true` |  |
| `allowStreetTransfers` | boolean |  | `true` | Default `true`. |
| `alternativeRanking` | [AlternativeRanking](#alternativeranking) |  | `"pareto"` |  |
| `alternativeSlackMinutes` | number |  | `15` | 0–120. Latest admitted arrival, in minutes after the primary arrival. Default 15. |
| `alternatives` | integer |  | `0` | 0–9. Additional depart-at transit journeys; 0 turns alternatives off. |
| `arrivalBufferMinutes` | integer |  | `0` | 0–60. Arrival reserve for arrive-by transit without via points. |
| `bike` | [BikeOptions](#bikeoptions) |  |  |  |
| `dataMode` | [DataMode](#datamode) |  |  | Alias of `routingDataMode`. |
| `destination` | [Point](#point) | Yes |  |  |
| `diagnostics` | [DiagnosticsLevel](#diagnosticslevel) |  | `"none"` | Added detail: `summary` counters, `profile` timings, or the unstable internal `trace`. Default `none`. |
| `disableCache` | boolean |  | `false` |  |
| `expandedWalkKm` | number |  |  | 0.2–5. Explicit permission to search for faster alternatives with more walking. |
| `flex` | [FlexOptions](#flexoptions) |  |  | Include conditional direct Flex journeys with explicit booking and timing assumptions. |
| `horizonMinutes` | number |  | `480` | 1–2880. Default 480. |
| `id` | any |  |  | Caller's identifier, echoed as `id` and `meta.requestId`. |
| `includeGeometry` | boolean |  | `true` | Include GeoJSON on legs. |
| `includeLimitations` | boolean |  | `false` | Add the City's dataset limitations to the Result. Default `false`. |
| `journeyPolicy` | [JourneyPolicy](#journeypolicy) |  |  | Versioned native alternatives selection; transit only. |
| `kind` | string |  |  | Query kind on a resident stream. |
| `maxStreetKm` | number |  | `50` | 0.05–1000. Default 50. |
| `maxTransfers` | integer |  |  | 0–31 |
| `maxWalkKm` | number |  | `1.2` | 0–100. Default 1.2. |
| `minimumTransferBufferMinutes` | integer |  | `0` | 0–60. Default 0. |
| `mode` | [Mode](#mode) |  | `"transit"` | Default `transit`. |
| `monteCarlo` | [MonteCarloOptions](#montecarlooptions) |  |  | Seeded departure-window and frequency-schedule distribution. |
| `origin` | [Point](#point) | Yes |  |  |
| `realtimeSnapshot` | [RealtimeSnapshot](#realtimesnapshot) |  |  |  |
| `requireCompleteServiceCoverage` | boolean |  | `false` |  |
| `requireTransitRide` | boolean |  | `false` | Default `false`: a direct walk may answer the query. |
| `routingDataMode` | [DataMode](#datamode) |  |  |  |
| `scenario` | [Scenario](#scenario) |  |  |  |
| `scenarioId` | string |  |  | Member of the loaded scenario collection; omitted selects its default. |
| `serviceDate` | string |  |  | date. `YYYY-MM-DD`. Required for transit. |
| `serviceDay` | [ServiceDay](#serviceday) |  |  |  |
| `time` | [Clock](#clock) |  |  |  |
| `timeMinutes` | number |  |  | 0–4319 |
| `timePreference` | [TimePreferenceInput](#timepreferenceinput) |  | `"depart_at"` | Default `depart_at`. |
| `traffic` | [Traffic](#traffic) |  |  |  |
| `via` | array of [Point](#point) |  |  | 0–16 items. Ordered intermediate places. |
| `walkSpeedKph` | number |  |  | 1–8. Default from the City. Walking Route and Matrix, and Reach. |
| `waypoints` | array of [Point](#point) |  |  | 0–16 items. Alias of `via`. |
| `wheelchair` | boolean |  |  | Require a City prepared with the wheelchair-strict-v1 profile. Omitted inherits the City's profile; `false` rejects a wheelchair City. |
| `windowMinutes` | number |  | `0` | 0–240. Sample later departures (or earlier deadlines) over this many minutes. |
| `windowStepMinutes` | number |  | `1` | 1–60 |

### MatrixRequest

`POST /v1/matrix`: travel times between every origin and destination.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `allowLongWalk` | boolean |  | `true` |  |
| `allowStreetTransfers` | boolean |  | `true` | Default `true`. |
| `arrivalBufferMinutes` | integer |  | `0` | 0–60 |
| `bike` | [BikeOptions](#bikeoptions) |  |  |  |
| `dataMode` | [DataMode](#datamode) |  |  | Alias of `routingDataMode`. |
| `destinations` | array of [Point](#point) | Yes |  | 1–65536 items |
| `diagnostics` | [DiagnosticsLevel](#diagnosticslevel) |  | `"none"` | Added detail: `summary` counters, `profile` timings, or the unstable internal `trace`. Default `none`. |
| `disableCache` | boolean |  | `false` |  |
| `flex` | [FlexOptions](#flexoptions) |  |  | Include conditional direct Flex journeys with explicit booking and timing assumptions. |
| `horizonMinutes` | number |  | `480` | 1–2880 |
| `id` | any |  |  | Caller's identifier, echoed as `id` and `meta.requestId`. |
| `includeGeometry` | boolean |  | `false` | Include GeoJSON on legs. |
| `includeJourneys` | boolean |  | `false` |  |
| `includeLimitations` | boolean |  | `false` | Add the City's dataset limitations to the Result. Default `false`. |
| `journeyFormat` | [JourneyFormat](#journeyformat) |  | `"full"` |  |
| `kind` | string |  |  | Query kind on a resident stream. |
| `maxStreetKm` | number |  | `50` | 0.05–1000 |
| `maxTransfers` | integer |  |  | 0–31 |
| `maxWalkKm` | number |  | `1.2` | 0–100. Default 1.2. |
| `minimumTransferBufferMinutes` | integer |  | `0` | 0–60. Default 0. |
| `mode` | [Mode](#mode) |  | `"transit"` |  |
| `monteCarlo` | [MonteCarloOptions](#montecarlooptions) |  |  | Seeded departure-window and frequency-schedule distribution. |
| `origins` | array of [Point](#point) | Yes |  | 1–65536 items |
| `realtimeSnapshot` | [RealtimeSnapshot](#realtimesnapshot) |  |  | Transit Matrix searches the same realtime view as Route. |
| `requireCompleteServiceCoverage` | boolean |  | `false` |  |
| `requireTransitRide` | boolean |  | `false` |  |
| `routingDataMode` | [DataMode](#datamode) |  |  |  |
| `scenario` | [Scenario](#scenario) |  |  | Planned service for Monte Carlo analysis. |
| `scenarioId` | string |  |  | Member of the loaded scenario collection; omitted selects its default. |
| `serviceDate` | string |  |  | date. `YYYY-MM-DD`. Required for transit. |
| `serviceDay` | [ServiceDay](#serviceday) |  |  |  |
| `time` | [Clock](#clock) |  |  |  |
| `timeMinutes` | number |  |  | 0–4319 |
| `timePreference` | [TimePreferenceInput](#timepreferenceinput) |  | `"depart_at"` |  |
| `traffic` | [Traffic](#traffic) |  |  |  |
| `walkSpeedKph` | number |  |  | 1–8. Default from the City. Walking Route and Matrix, and Reach. |
| `wheelchair` | boolean |  |  | Require a City prepared with the wheelchair-strict-v1 profile. Omitted inherits the City's profile; `false` rejects a wheelchair City. |

### ReachRequest

`POST /v1/reach` (and `/v1/isochrone`): where an origin reaches within cutoffs or, arriving by the requested time, where a destination is reached from.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `allDay` | [AllDayWindow](#alldaywindow) |  |  | Five-minute streaming aggregation over a service-day window. |
| `allowStreetTransfers` | boolean |  | `true` | Default `true`. |
| `bike` | [BikeOptions](#bikeoptions) |  |  |  |
| `bounds` | [Bounds](#bounds) |  |  |  |
| `cutoffsMinutes` | array of number |  | `[15, 30, 45, 60]` | 1–16 items. Default `[15, 30, 45, 60]`. |
| `dataMode` | [DataMode](#datamode) |  |  | Alias of `routingDataMode`. |
| `destination` | [Point](#point) |  |  | Where arrive-by trips end. Required for arrive-by Reach, which takes no origin. |
| `diagnostics` | [DiagnosticsLevel](#diagnosticslevel) |  | `"none"` | Added detail: `summary` counters, `profile` timings, or the unstable internal `trace`. Default `none`. |
| `disableCache` | boolean |  | `false` |  |
| `extentRadiusKm` | number |  | `8` | 1–40. Default 8. |
| `id` | any |  |  | Caller's identifier, echoed as `id` and `meta.requestId`. |
| `includeGeometry` | boolean |  | `false` | Include GeoJSON on legs. |
| `includeLimitations` | boolean |  | `false` | Add the City's dataset limitations to the Result. Default `false`. |
| `includeNodes` | boolean |  | `false` |  |
| `includeStreetEdges` | boolean |  | `false` |  |
| `kind` | string |  |  | Query kind on a resident stream. |
| `maxTransfers` | integer |  |  | 0–31 |
| `maxWalkKm` | number |  | `1.2` | 0–100. Default 1.2. |
| `minimumTransferBufferMinutes` | integer |  | `0` | 0–60. Default 0. |
| `mode` | [ReachMode](#reachmode) |  | `"transit"` |  |
| `monteCarlo` | [MonteCarloOptions](#montecarlooptions) |  |  | Seeded departure-window and frequency-schedule distribution. |
| `origin` | [Point](#point) |  |  | Where depart-at trips start. Required for depart-at Reach. |
| `rasterSize` | integer |  | `96` | 16–1024. Cells per side. Default 96. |
| `reachFormat` | [ReachFormat](#reachformat) |  | `"full"` |  |
| `realtimeSnapshot` | [RealtimeSnapshot](#realtimesnapshot) |  |  | Transit Reach searches the same realtime view as Route; a scenario applies on top of it. |
| `requireCompleteServiceCoverage` | boolean |  | `false` |  |
| `routingDataMode` | [DataMode](#datamode) |  |  |  |
| `scenario` | [Scenario](#scenario) |  |  |  |
| `scenarioId` | string |  |  | Member of the loaded scenario collection; omitted selects its default. |
| `serviceDate` | string |  |  | date. `YYYY-MM-DD`. Required for transit. |
| `serviceDay` | [ServiceDay](#serviceday) |  |  |  |
| `surfaceSampling` | [SurfaceSampling](#surfacesampling) |  | `"street"` |  |
| `time` | [Clock](#clock) |  |  |  |
| `timeMinutes` | number |  |  | 0–4319 |
| `timePreference` | [TimePreferenceInput](#timepreferenceinput) |  | `"depart_at"` |  |
| `walkSpeedKph` | number |  |  | 1–8. Default from the City. Walking Route and Matrix, and Reach. |
| `wheelchair` | boolean |  |  | Require a City prepared with the wheelchair-strict-v1 profile. Omitted inherits the City's profile; `false` rejects a wheelchair City. |

### CompareRequest

`POST /v1/compare`: two saved Results of the same query family.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `after` | [RouteResult](#routeresult) or [MatrixResult](#matrixresult) or [ReachResult](#reachresult) or object | Yes |  | A Result of the same family as `before`. |
| `before` | [RouteResult](#routeresult) or [MatrixResult](#matrixresult) or [ReachResult](#reachresult) or object | Yes |  | A saved `vigo.route.v1`, `vigo.matrix.v1` or `vigo.reach.v1` Result. Internal trace results are also accepted, without stability guarantees. |
| `diagnostics` | [DiagnosticsLevel](#diagnosticslevel) |  |  | `trace` adds the internal comparison. |
| `id` | any |  |  |  |

### AlternativeRanking

| Value | Meaning |
| --- | --- |
| `"pareto"` | Nondominated arrival, boarding and walking trade-offs. |
| `"ranked"` | The earliest distinct vehicle sequences, dominated ones included. |

### BikeOptions

Bicycle route preferences; costs affect selection, never the reported ETA.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `maxLts` | integer |  |  | 1–4. Maximum estimated traffic stress for cycling; higher levels require legal pushing. |
| `profile` | [BikeProfile](#bikeprofile) |  |  |  |
| `speedKph` | number |  |  | 5–40 |

### DataMode

Type: `"scheduled"`, `"realtime"`.

### Point

A place: a bare `[longitude, latitude]`, or an object naming a stop and/or coordinate. A selected stop overrides the coordinate unless `source` is `map`.

Type: [Coordinate](#coordinate) or [Place](#place).

### DiagnosticsLevel

Type: `"none"`, `"summary"`, `"profile"`, `"trace"`.

### FlexOptions

Include conditional GTFS Flex journeys. Booking is never performed by VIGO.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `bookingConfirmed` | boolean |  |  |  |
| `durationFactor` | number |  |  | 1–10. Fallback multiplier when the feed omits safe_duration_factor. Default 1.5. |
| `durationOffsetSeconds` | number |  |  | 0–7200. Fallback addition when safe_duration_offset is absent. Default 300 seconds. |

### JourneyPolicy

Type: `"alternatives-v1"`.

### Mode

Type: `"transit"`, `"walk"`, `"drive"`, `"bike"`.

### MonteCarloOptions

End-exclusive civil-day departure window, evaluated at every minute.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `accessibility` | [AccessibilityOptions](#accessibilityoptions) |  |  |  |
| `draws` | integer |  | `200` | 1–10000. Rounded up to equal samples per minute; exact-only service uses one. |
| `endMinutes` | integer | Yes |  | 1–1440 |
| `percentiles` | array of integer |  |  | 1–21 items. Nearest-rank percentiles, including unreachable samples as infinity. |
| `seed` | integer |  | `0` | ≥ 0 |
| `startMinutes` | integer | Yes |  | 0–1439 |

### RealtimeSnapshot

Trip Updates and Service Alerts applied to one transit Route, Matrix or Reach request. Freshness is checked against the current time. With `realtime` mode and no snapshot, `vigo serve --realtime-poll` uses its own.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `alerts` | array of [ServiceAlert](#servicealert) |  |  | 0–10000 items. `NO_SERVICE` removes the selected service or closes the selected stops during the active periods. Every fresh alert is reported on the legs it describes. |
| `feedTimestamp` | integer |  |  | ≥ 1. POSIX seconds. |
| `incrementality` | [Enumerated](#enumerated) |  |  | `FULL_DATASET` or `0`. |
| `timezone` | string |  |  |  |
| `tripUpdates` | array of [TripUpdate](#tripupdate) | Yes |  | 0–100000 items |

### Scenario

A request-scoped service change. Use `services` or a compiled `overlay`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cityRevision` | string |  |  |  |
| `excludedRouteIds` | array of string |  |  |  |
| `excludedTripIds` | array of string |  |  |  |
| `flexZones` | array of [PlannedFlexZone](#plannedflexzone) |  |  | Query-local on-demand zones with an explicit planning time model. |
| `id` | string |  |  |  |
| `name` | string |  |  |  |
| `overlay` | any |  |  | A compiled native overlay; see the native field reference. |
| `services` | array of [ScenarioService](#scenarioservice) |  |  | 0–128 items |

### ServiceDay

Type: `"weekday"`, `"saturday"`, `"sunday"`.

### Clock

A service-day clock: `HH:MM` or `HH:MM:SS` (hours may exceed 23), or minutes after the start of the service day.

Type: string or number.

### TimePreferenceInput

`depart` and `arrive` are accepted aliases.

Type: `"depart_at"`, `"arrive_by"`, `"depart"`, `"arrive"`.

### Traffic

Supplied traffic for driving: prepared edge times, or observations.

Type: [PreparedTraffic](#preparedtraffic) or [ObservedTraffic](#observedtraffic).

### JourneyFormat

| Value | Meaning |
| --- | --- |
| `"full"` |  |
| `"compact"` | The exact timed trip, stop and boarding witness, without display metadata or walking evidence. |

### AllDayWindow

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `endMinutes` | integer |  |  | 1–1440 |
| `startMinutes` | integer |  |  | 0–1439 |

### Bounds

`[west, south, east, north]` in WGS84 degrees.

Type: array of any (4–4 items).

### ReachMode

Reach covers transit, walking, driving, and bicycle travel times.

Type: `"transit"`, `"walk"`, `"drive"`, `"bike"`.

### ReachFormat

| Value | Meaning |
| --- | --- |
| `"full"` |  |
| `"surface"` | Raster only, without polygon construction. |
| `"map"` | Areas for the full reached extent, without rasters or stop lists. |

### SurfaceSampling

Type: `"street"`, `"cell-center"`.

### RouteResult

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `access` | [RouteAccess](#routeaccess) |  |  |  |
| `accessibility` | [Accessibility](#accessibility) |  |  |  |
| `alternativeSearch` | [AlternativeSearch](#alternativesearch) |  |  |  |
| `alternatives` | array of [Journey](#journey) |  |  | Further distinct journeys; omitted when there are none. |
| `datasetLimitations` | array of [DatasetLimitation](#datasetlimitation) |  |  |  |
| `diagnostics` | [SearchSummary](#searchsummary) |  |  |  |
| `id` | any |  |  | The caller's `id`. |
| `journey` | [Journey](#journey) or null | Yes |  | `null` when `status` is `not_found`. |
| `meta` | [Meta](#meta) | Yes |  |  |
| `mode` | [Mode](#mode) | Yes |  |  |
| `profile` | [Profile](#profile) |  |  |  |
| `query` | [RouteQuery](#routequery) | Yes |  |  |
| `reason` | [Notice](#notice) |  |  | Why no journey was found. |
| `scenarioId` | string |  |  |  |
| `schema` | `"vigo.route.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0. Line number on a resident stream. |
| `status` | [QueryStatus](#querystatus) | Yes |  |  |
| `trace` | any |  |  | The unstable internal result, with `diagnostics: "trace"`. |
| `warnings` | array of [Notice](#notice) |  |  | Qualifications of the returned journey. |

### MatrixResult

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `access` | [MatrixAccess](#matrixaccess) |  |  |  |
| `accessibility` | [Accessibility](#accessibility) |  |  |  |
| `datasetLimitations` | array of [DatasetLimitation](#datasetlimitation) |  |  |  |
| `diagnostics` | [SearchSummary](#searchsummary) |  |  |  |
| `distancesMeters` | array of array of number or null |  |  | Driving distances, `[origin][destination]`. |
| `durationsSeconds` | array of array of integer or null | Yes |  | `[origin][destination]` seconds; `null` when unreachable, never zero. |
| `id` | any |  |  |  |
| `journeys` | array of array of [Journey](#journey) or null |  |  | Same order as `durationsSeconds`, with `includeJourneys`. |
| `meta` | [Meta](#meta) | Yes |  |  |
| `mode` | [Mode](#mode) | Yes |  |  |
| `profile` | [Profile](#profile) |  |  |  |
| `query` | [MatrixQuery](#matrixquery) | Yes |  |  |
| `scenarioId` | string |  |  |  |
| `schema` | `"vigo.matrix.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0 |
| `status` | [QueryStatus](#querystatus) | Yes |  |  |
| `trace` | any |  |  |  |

### ReachResult

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `accessibility` | [Accessibility](#accessibility) |  |  |  |
| `allDay` | [AllDaySummary](#alldaysummary) |  |  |  |
| `areas` | [CutoffFeatures](#cutofffeatures) |  |  | Areas within each cutoff. With `reachFormat: "map"`, these cover the full reached extent. |
| `bounds` | [Bounds](#bounds) |  |  | Full reached extent, with `reachFormat: "map"`. |
| `contours` | [CutoffFeatures](#cutofffeatures) |  |  |  |
| `cutoffsSeconds` | array of integer | Yes |  |  |
| `datasetLimitations` | array of [DatasetLimitation](#datasetlimitation) |  |  |  |
| `diagnostics` | [SearchSummary](#searchsummary) |  |  |  |
| `fullAreas` | [CutoffFeatures](#cutofffeatures) |  |  |  |
| `fullContours` | [CutoffFeatures](#cutofffeatures) |  |  |  |
| `fullSurface` | [ReachSurface](#reachsurface) |  |  | The same grid over the complete reached extent. |
| `id` | any |  |  |  |
| `meta` | [Meta](#meta) | Yes |  |  |
| `mode` | [Mode](#mode) | Yes |  |  |
| `profile` | [Profile](#profile) |  |  |  |
| `query` | [ReachQuery](#reachquery) | Yes |  |  |
| `scenarioId` | string |  |  |  |
| `scenarioStops` | array of [ReachStop](#reachstop) |  |  | Stops added by a scenario. |
| `schema` | `"vigo.reach.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0 |
| `status` | [QueryStatus](#querystatus) | Yes |  |  |
| `stops` | array of [ReachStop](#reachstop) |  |  |  |
| `surface` | [ReachSurface](#reachsurface) |  |  |  |
| `trace` | any |  |  |  |

### BikeProfile

Type: `"balanced"`, `"fast"`, `"quiet"`.

### Coordinate

`[longitude, latitude]` in WGS84 degrees.

Type: array of any (2–2 items).

### Place

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `baselineStopId` | string |  |  |  |
| `baselineStopIndex` | integer |  |  | ≥ 0 |
| `coordinate` | [Coordinate](#coordinate) |  |  |  |
| `editStatus` | string |  |  |  |
| `id` | any |  |  | Caller's label for a Matrix endpoint, echoed in `query`. |
| `label` | string |  |  |  |
| `name` | string |  |  |  |
| `source` | string |  |  |  |
| `stop` | [StopInput](#stopinput) |  |  |  |
| `stopId` | string |  |  | Older form of `stop`: an ID, scoped as `feed` + U+001F + `id`. |

### AccessibilityOptions

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cutoffsMinutes` | array of number | Yes |  |  |
| `decayFunction` | [DecayFunction](#decayfunction) |  |  |  |
| `dualThresholds` | array of number |  |  |  |
| `layers` | array of [OpportunityLayer](#opportunitylayer) | Yes |  |  |

### ServiceAlert

A GTFS-Realtime Service Alert, as the server's poller records it.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `activePeriods` | array of [ActivePeriod](#activeperiod) |  | `[]` | No periods means always active. |
| `cause` | [Enumerated](#enumerated) |  |  |  |
| `description` | string |  |  |  |
| `effect` | [Enumerated](#enumerated) |  |  | Such as `NO_SERVICE`, `DETOUR` or `SIGNIFICANT_DELAYS`, or its code. |
| `header` | string |  |  |  |
| `id` | string |  |  |  |
| `informedEntities` | array of [InformedEntity](#informedentity) |  | `[]` | Each entity matches when all of its fields match; any entity applies. |
| `severity` | [Enumerated](#enumerated) |  |  |  |
| `sourceFeedTimestamp` | integer |  |  | ≥ 1 |
| `sourceScope` | string |  |  |  |
| `url` | string |  |  |  |

### Enumerated

A GTFS-Realtime enumeration, by name or by numeric code.

Type: string or integer.

### TripUpdate

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `delaySeconds` | integer |  |  |  |
| `directionId` | any |  |  |  |
| `routeId` | string |  |  |  |
| `scheduleRelationship` | [Enumerated](#enumerated) |  |  | `SCHEDULED`, `CANCELED` or `DELETED`, or their codes 0, 3 and 7. |
| `sourceFeedTimestamp` | integer |  |  | ≥ 1 |
| `sourceScope` | string |  |  |  |
| `startDate` | string |  |  |  |
| `stopTimeUpdates` | array of [StopTimeUpdate](#stoptimeupdate) |  |  |  |
| `timestamp` | integer |  |  | ≥ 1 |
| `trip` | [TripDescriptor](#tripdescriptor) |  |  |  |
| `tripId` | string |  |  |  |

### PlannedFlexZone

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `averageSpeedKph` | number | Yes |  |  |
| `endMinutes` | number | Yes |  |  |
| `geometry` | any | Yes |  |  |
| `id` | string | Yes |  |  |
| `name` | string | Yes |  |  |
| `startMinutes` | number | Yes |  |  |
| `waitMinutes` | number | Yes |  |  |

### ScenarioService

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `addedStopDwellMinutes` | number |  | `0` | 0–10. Default 0. |
| `averageSpeedKph` | number |  | `22` | 1–300. Default 22. |
| `bidirectional` | boolean |  |  |  |
| `dwellMinutes` | number |  | `0.35` | 0–60. Default 0.35. |
| `endMinutes` | number |  | `1500` | 0–4319. Default 1500. |
| `exactTimes` | boolean |  |  | A fixed timetable when true; otherwise simulation samples its phase. |
| `headwayMinutes` | number |  | `12` | 0.1–1440. Default 12. |
| `id` | string |  |  |  |
| `name` | string |  |  |  |
| `operation` | [ServiceOperation](#serviceoperation) |  | `"add"` | Default `add`. |
| `phaseFrom` | [FrequencyPhasing](#frequencyphasing) |  |  |  |
| `scheduleMode` | [ScheduleMode](#schedulemode) |  |  |  |
| `scheduledTrips` | array of [ScheduledTrip](#scheduledtrip) |  |  |  |
| `segmentDistancesKm` | array of number |  |  |  |
| `segmentRuntimeMinutes` | array of number |  |  |  |
| `sourceRouteId` | string |  |  |  |
| `startMinutes` | number |  | `300` | 0–4319. Default 300. |
| `stops` | array of [Point](#point) | Yes |  | ≥ 2 items. At least two places, in service order. |
| `timeModel` | [TimeModel](#timemodel) |  | `"estimate-distance"` | Default `estimate-distance`. |
| `timetables` | array of [ScenarioTimetable](#scenariotimetable) |  |  | 1–32 items. Optional independent timetable rows. Replaces the top-level frequency window; weekdays refer to serviceDate, including times after midnight. |
| `timing` | [ServiceTiming](#servicetiming) |  |  | Adjust ride and dwell times while retaining original trip departures. Requires preserve-trips. Selection indexes refer to the edited pattern. |

### PreparedTraffic

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `edgeIndices` | array of integer | Yes |  |  |
| `edgeTimeUnits` | array of integer | Yes |  |  |
| `expiresAt` | [Timestamp](#timestamp) |  |  |  |
| `ingestion` | any |  |  | Provider import diagnostics, outside the stable routing contract. |
| `observedAt` | [Timestamp](#timestamp) | Yes |  | Required freshness for prepared traffic; edge costs never remain live indefinitely. |
| `snapshotKey` | string | Yes |  |  |
| `source` | string |  |  |  |
| `streetSourceFingerprint` | string | Yes |  |  |
| `ttlSeconds` | number |  |  |  |

### ObservedTraffic

Observed traffic. One of `observedAt`, `fetchedAt` or `timestamp` is required, and one of `observations`, `segments` or `edgeUpdates`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `edgeUpdates` | array of [TrafficObservation](#trafficobservation) |  |  |  |
| `expiresAt` | [Timestamp](#timestamp) |  |  |  |
| `fetchedAt` | [Timestamp](#timestamp) |  |  |  |
| `observations` | array of [TrafficObservation](#trafficobservation) |  |  |  |
| `observedAt` | [Timestamp](#timestamp) |  |  |  |
| `segments` | array of [TrafficObservation](#trafficobservation) |  |  |  |
| `snapRadiusMeters` | number |  |  |  |
| `snapshotId` | string |  |  |  |
| `source` | string |  |  |  |
| `streetSourceFingerprint` | string |  |  |  |
| `timestamp` | [Timestamp](#timestamp) |  |  |  |
| `ttlSeconds` | number |  |  | Default 300. |

### RouteAccess

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `destination` | [AccessReport](#accessreport) | Yes |  |  |
| `origin` | [AccessReport](#accessreport) | Yes |  |  |

### Accessibility

The wheelchair profile a Result was computed under.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `fareGates` | string |  |  | Gate-cost policy; absent in older compatible Cities. |
| `limitations` | array of string | Yes |  |  |
| `maximumSlope` | number | Yes |  |  |
| `minimumWidthMeters` | number | Yes |  |  |
| `profile` | string | Yes |  | `wheelchair-strict-v1`. |
| `sameLevelWalkways` | string |  |  | Same-level walkway policy; absent in older compatible Cities. |
| `stationPaths` | string | Yes |  |  |
| `streetEvidence` | string |  |  | The prepared street policy; absent in older compatible Cities. |
| `unknownData` | string | Yes |  | `exclude`: unknown vehicle and boarding accessibility is excluded. Street inference is described separately by `streetEvidence`. |

### AlternativeSearch

How alternatives were found: requested alternatives, or a journey window.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalSlackMinutes` | number | Yes |  |  |
| `coverage` | string | Yes |  | `requested_time` for requested alternatives, `sampled` for a window. |
| `direction` | string |  |  | Window sampling direction. |
| `maximumJourneys` | integer | Yes |  | ≥ 0. Includes the primary journey. |
| `minutes` | number |  |  |  |
| `ranking` | string |  |  |  |
| `reason` | string |  |  |  |
| `reusedSamples` | integer |  |  | ≥ 0. Window samples answered by a previously certified search. |
| `searches` | integer |  |  | ≥ 0 |
| `status` | string |  |  | `complete` or `unavailable`. |
| `stepMinutes` | number |  |  |  |

### Journey

One way to make the trip. Clocks are service-day `HH:MM:SS` (hours may exceed 23); durations are integer seconds.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalTime` | string | Yes |  |  |
| `boardings` | integer | Yes |  | ≥ 0 |
| `clockDate` | string or null |  |  | Date anchoring every clock in this journey. Route only; `null` for a walking or driving journey without a service date. |
| `cyclingSeconds` | integer |  |  |  |
| `departureTime` | string | Yes |  |  |
| `drivingSeconds` | integer |  |  |  |
| `durationSeconds` | integer | Yes |  |  |
| `expandedWalkingLimitKm` | number |  |  |  |
| `legs` | array of [Leg](#leg) | Yes |  |  |
| `ridingSeconds` | integer or null | Yes |  |  |
| `transfers` | integer or null | Yes |  | ≥ 0 |
| `waitingSeconds` | integer or null | Yes |  | Gaps before and between legs. Not a reliability margin. |
| `walkingSeconds` | integer or null | Yes |  |  |

### DatasetLimitation

A dataset or model limitation of the City.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `code` | string | Yes |  |  |
| `count` | integer |  |  | ≥ 0. Affected source records. |
| `detail` | string |  |  |  |
| `exactness` | string |  |  | Such as `unsupported` or `unknown`. |

### SearchSummary

Search counters, with `diagnostics: "summary"` or more. Counters without instrumentation are omitted.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `algorithm` | string |  |  |  |
| `cchAccelerated` | boolean |  |  |  |
| `destinationCandidates` | integer |  |  | ≥ 0 |
| `dominatedTripBoardings` | integer |  |  | ≥ 0 |
| `expandedTripRuns` | integer |  |  | ≥ 0 |
| `explicitTransferChecks` | integer |  |  | ≥ 0 |
| `forwardSearches` | integer |  |  | ≥ 0 |
| `originCandidates` | integer |  |  | ≥ 0 |
| `relaxedStops` | integer |  |  | ≥ 0 |
| `reverseSearches` | integer |  |  | ≥ 0 |
| `scannedDepartures` | integer |  |  | ≥ 0 |

### Meta

How this Result was computed and how to reproduce it.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `assumptionsFingerprint` | string |  |  |  |
| `cityRevision` | string or null | Yes |  |  |
| `computeScope` | string | Yes |  | `query_dispatch_including_materialization`. |
| `computeUs` | integer or null | Yes |  | ≥ 0. Service-date activation, search and materialization, in microseconds. |
| `engineVersion` | string | Yes |  |  |
| `queryFingerprint` | string | Yes |  | Hash of the request (stop references canonicalized, output switches excluded) and the City revision. |
| `realtime` | [RealtimeReport](#realtimereport) |  |  |  |
| `realtimeSnapshotFingerprint` | string |  |  |  |
| `requestId` | any | Yes |  | The caller's `id` when given; otherwise generated. |
| `scenarioFingerprint` | string |  |  |  |
| `traffic` | any |  |  | Admission and road matching evidence for supplied traffic. |

### Profile

Measured timings, with `diagnostics: "profile"` or `"trace"`. Scopes can overlap; do not add them.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `note` | string | Yes |  |  |
| `timingsUs` | object | Yes |  | Dotted scope names to integer microseconds. |

### RouteQuery

The request as the engine understood it. Endpoints echo the caller's places.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalReserveSeconds` | integer |  |  |  |
| `dataMode` | [DataMode](#datamode) | Yes |  |  |
| `destination` | [QueryPlace](#queryplace) | Yes |  |  |
| `origin` | [QueryPlace](#queryplace) | Yes |  |  |
| `planningArrivalTime` | string |  |  |  |
| `requestedTime` | string or null | Yes |  |  |
| `serviceDate` | string or null | Yes |  |  |
| `timePreference` | [TimePreference](#timepreference) | Yes |  |  |

### Notice

A code for programs and a message for people.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `code` | string | Yes |  |  |
| `message` | string | Yes |  |  |

### QueryStatus

| Value | Meaning |
| --- | --- |
| `"ok"` |  |
| `"not_found"` | A valid outcome: nothing satisfies the request. |

### MatrixAccess

Matrix access reports, keyed by endpoint index.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `destinations` | object | Yes |  |  |
| `origins` | object | Yes |  |  |

### MatrixQuery

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalReserveSeconds` | integer |  |  |  |
| `dataMode` | [DataMode](#datamode) | Yes |  |  |
| `destinations` | array of [QueryPlace](#queryplace) | Yes |  |  |
| `origins` | array of [QueryPlace](#queryplace) | Yes |  |  |
| `planningArrivalTime` | string |  |  |  |
| `requestedTime` | string or null | Yes |  |  |
| `serviceDate` | string or null | Yes |  |  |
| `timePreference` | [TimePreference](#timepreference) | Yes |  |  |

### AllDaySummary

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `aggregation` | string | Yes |  |  |
| `endExclusive` | boolean | Yes |  |  |
| `meanCondition` | string | Yes |  |  |
| `sampleCount` | integer | Yes |  | ≥ 0 |
| `stepMinutes` | integer | Yes |  | ≥ 0 |
| `walkingPreparation` | string | Yes |  |  |

### CutoffFeatures

A GeoJSON `FeatureCollection` of cutoff areas or contours.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `features` | array of [CutoffFeature](#cutofffeature) | Yes |  |  |
| `type` | `"FeatureCollection"` | Yes |  |  |

### ReachSurface

Reached time on a regular grid, row-major from the northwest corner.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `bounds` | [Bounds](#bounds) | Yes |  |  |
| `edges` | [StreetEdges](#streetedges) |  |  | Reached street intervals, with `includeStreetEdges`. |
| `height` | integer | Yes |  | ≥ 0 |
| `meanReachableDurationSeconds` | array of number or null |  |  |  |
| `nodes` | array of [SurfaceNode](#surfacenode) |  |  | Reached street nodes, with `includeNodes`. |
| `reachableSamples` | array of integer |  |  |  |
| `reachableSamplesByCutoff` | array of array of integer |  |  |  |
| `valuesSeconds` | array of integer or null |  |  | Seconds per cell; `null` when unreachable. |
| `width` | integer | Yes |  | ≥ 0 |

### ReachQuery

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `allDay` | [AllDayQuery](#alldayquery) |  |  |  |
| `dataMode` | [DataMode](#datamode) | Yes |  |  |
| `destination` | [QueryPlace](#queryplace) |  |  | Arrive-by Reach. |
| `origin` | [QueryPlace](#queryplace) |  |  | Depart-at Reach. |
| `requestedTime` | string or null |  |  |  |
| `serviceDate` | string or null | Yes |  |  |
| `timePreference` | [TimePreference](#timepreference) | Yes |  |  |

### ReachStop

A stop reached by Reach, and when.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `coordinate` | [Coordinate](#coordinate) |  |  |  |
| `durationSeconds` | integer or null | Yes |  | ≥ 0 |
| `name` | string |  |  |  |
| `stop` | [Identifier](#identifier) |  |  |  |

### StopInput

A stop reference. Omit `feed`, or send `null`, for an unscoped feed.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `feed` | string or null |  |  |  |
| `id` | string | Yes |  |  |

### DecayFunction

Type: object with `type` or object with `standardDeviationMinutes`, `type` or object with `type`, `widthMinutes` or object with `decayConstant`, `type`.

### OpportunityLayer

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `counts` | array of number | Yes |  | Nonnegative weights in destination order (row-major cells for Reach). |
| `id` | string | Yes |  |  |

### ActivePeriod

POSIX seconds; a missing bound is open.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `end` | integer |  |  |  |
| `start` | integer |  |  |  |

### InformedEntity

An alert's GTFS-Realtime EntitySelector. A stop that is a station also selects its platforms. Agency-only entities are not applied.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `agencyId` | string |  |  |  |
| `directionId` | any |  |  |  |
| `routeId` | string |  |  |  |
| `routeType` | integer |  |  |  |
| `stopId` | string |  |  |  |
| `trip` | [AlertTrip](#alerttrip) |  |  |  |

### StopTimeUpdate

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrival` | [StopTimeEvent](#stoptimeevent) |  |  |  |
| `departure` | [StopTimeEvent](#stoptimeevent) |  |  |  |
| `scheduleRelationship` | [Enumerated](#enumerated) |  |  | `SCHEDULED`, `SKIPPED` or `NO_DATA`, or their codes 0 to 2. |
| `stopId` | string |  |  |  |
| `stopSequence` | integer |  |  | 0–4294967295 |

### TripDescriptor

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `startDate` | string |  |  |  |
| `tripId` | string |  |  |  |

### ServiceOperation

Type: `"add"`, `"augment"`, `"replace"`.

### FrequencyPhasing

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `atStopIndex` | integer | Yes |  | ≥ 0 |
| `fromStopIndex` | integer | Yes |  | ≥ 0 |
| `offsetMinutes` | number |  |  |  |
| `serviceId` | string | Yes |  |  |

### ScheduleMode

Type: `"frequency"`, `"preserve-trips"`.

### ScheduledTrip

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalOffsetsSeconds` | array of number | Yes |  |  |
| `canAlight` | array of integer |  |  |  |
| `canBoard` | array of integer |  |  | One 0/1 flag per stop. |
| `departureOffsetsSeconds` | array of number | Yes |  |  |
| `departureSeconds` | number | Yes |  | 0–1048575 |
| `serviceDayOffset` | integer |  |  | -3–3. Days from the query's service date to the service date this trip runs on; -1 keeps the previous day's trips that run past midnight. `departureSeconds` is on that day's clock. Omitted means 0. |
| `tripId` | string |  |  |  |

### TimeModel

Type: `"estimate-distance"`, `"preserve-scheduled"`, `"infer-road"`.

### ScenarioTimetable

One independent, end-exclusive planned-service frequency window.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `daysOfWeek` | array of integer |  |  | 1–7 items. ISO weekdays: 1 = Monday, 7 = Sunday. Omitted means every day. |
| `endMinutes` | number | Yes |  | 0–4319 |
| `exactTimes` | boolean |  |  |  |
| `headwayMinutes` | number | Yes |  | 0.1–1440 |
| `id` | string | Yes |  |  |
| `startMinutes` | number | Yes |  | 0–4319 |

### ServiceTiming

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `dwellMinutes` | number |  |  | 0–60. Set dwell at selected stops; mutually exclusive with dwellScale. |
| `dwellScale` | number |  |  | 0–10 |
| `segmentIndexes` | array of integer |  |  | Zero-based segment indexes; omitted selects all segments. |
| `speedFactor` | number |  |  | 0.1–10. Divide moving time by this factor; 2 means twice as fast. |
| `stopIndexes` | array of integer |  |  | Stop indexes after the fixed first departure; omitted selects all. |

### Timestamp

POSIX milliseconds, or an RFC 3339 date-time.

Type: number or string.

### TrafficObservation

Directed geometry or edge indices, and exactly one cost effect.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `closed` | boolean |  |  |  |
| `coordinates` | array of [Coordinate](#coordinate) |  |  |  |
| `delayFactor` | number |  |  |  |
| `edgeIndex` | integer |  |  | ≥ 0 |
| `edgeIndices` | array of integer |  |  |  |
| `factor` | number |  |  |  |
| `fromCoordinate` | [Coordinate](#coordinate) |  |  |  |
| `multiplier` | number |  |  |  |
| `speedKph` | number |  |  |  |
| `toCoordinate` | [Coordinate](#coordinate) |  |  |  |
| `travelTimeSeconds` | number |  |  |  |

### AccessReport

How a place attached to the street network, reported when access fails.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `candidateCount` | integer | Yes |  | ≥ 0 |
| `code` | string | Yes |  | Such as `available` or `no_access`. |
| `coordinate` | [Coordinate](#coordinate) | Yes |  |  |
| `maximumWalkMeters` | integer | Yes |  |  |
| `nearestStop` | [NearestStop](#neareststop) |  |  | With `street_access_unverified`: the nearest stop serving the role. |
| `probeWalkMeters` | integer |  |  |  |
| `role` | string | Yes |  | `origin` or `destination`. |
| `suggestedWalkMeters` | number |  |  |  |

### Leg

Type: [StreetLeg](#streetleg) or [TransitLeg](#transitleg).

Selected by `type`: `bike` → [StreetLeg](#streetleg), `drive` → [StreetLeg](#streetleg), `transit` → [TransitLeg](#transitleg), `walk` → [StreetLeg](#streetleg).

### RealtimeReport

How a supplied realtime snapshot was admitted and applied.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `alerts` | [AlertReport](#alertreport) |  |  | Present when the snapshot carries Service Alerts. |
| `appliedTrips` | integer | Yes |  | ≥ 0 |
| `canceledTrips` | integer | Yes |  | ≥ 0 |
| `coverage` | [RealtimeCoverage](#realtimecoverage) | Yes |  |  |
| `dateMismatches` | integer | Yes |  | ≥ 0 |
| `duplicateTrips` | integer | Yes |  | ≥ 0 |
| `feedTripUpdates` | integer | Yes |  | ≥ 0 |
| `invalidTrips` | integer | Yes |  | ≥ 0 |
| `mode` | string | Yes |  |  |
| `omittedPastPrefixStops` | integer | Yes |  | ≥ 0 |
| `pastPrefixTrips` | integer | Yes |  | ≥ 0 |
| `snapshot` | [LiveSnapshotReport](#livesnapshotreport) |  |  | Present when the server's live snapshot was used. |
| `staleTrips` | integer | Yes |  | ≥ 0 |
| `status` | string | Yes |  | Such as `applied` or `stale_fallback`. |
| `unmatchedTrips` | integer | Yes |  | ≥ 0 |

### QueryPlace

A requested place, in public form.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `coordinate` | [Coordinate](#coordinate) |  |  |  |
| `id` | any |  |  | The caller's Matrix endpoint `id`. |
| `name` | string |  |  |  |
| `stop` | [Identifier](#identifier) |  |  |  |

### TimePreference

The time preference a Result reports, after aliases are resolved.

Type: `"depart_at"`, `"arrive_by"`.

### CutoffFeature

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `geometry` | [CutoffGeometry](#cutoffgeometry) | Yes |  |  |
| `properties` | [CutoffProperties](#cutoffproperties) | Yes |  |  |
| `type` | `"Feature"` | Yes |  |  |

### StreetEdges

Reached street intervals in indexed form. Every per-interval array has `count` entries.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `count` | integer | Yes |  | ≥ 0 |
| `durationMinutes` | array of number | Yes |  | Elapsed minutes at each interval end. |
| `edgeIds` | array of integer | Yes |  |  |
| `encoding` | string | Yes |  | `indexed-json`. |
| `endFractions` | array of number | Yes |  |  |
| `endpoints` | array of integer | Yes |  | From/to local node indices, `2 * count` long. |
| `fromDurationMinutes` | array of number | Yes |  | Elapsed minutes at each interval start. |
| `nodeCount` | integer | Yes |  | ≥ 0 |
| `nodes` | array of number | Yes |  | Flat longitude/latitude pairs, `2 * nodeCount` long. |
| `schemaVersion` | string | Yes |  | `vigo.standalone.street-edges.v2`. |
| `startFractions` | array of number | Yes |  |  |
| `transitArrivalMinutes` | array of number | Yes |  | Elapsed minutes at the transit seed; −1 for the direct-origin seed. |
| `walkDistanceM` | array of number | Yes |  |  |

### SurfaceNode

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `durationMinutes` | number or null | Yes |  |  |
| `latitude` | number or null | Yes |  |  |
| `longitude` | number or null | Yes |  |  |
| `walkDistanceM` | number or null | Yes |  |  |

### AllDayQuery

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `endMinutes` | integer | Yes |  | ≥ 0 |
| `startMinutes` | integer | Yes |  | ≥ 0 |
| `stepMinutes` | integer | Yes |  | ≥ 0 |

### Identifier

A feed-scoped GTFS identifier, such as a stop, route, trip or service. `feed` is `null` in a City built from a single unscoped feed.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `feed` | string or null | Yes |  |  |
| `id` | string | Yes |  |  |

### AlertTrip

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `directionId` | any |  |  |  |
| `routeId` | string |  |  |  |
| `startDate` | string |  |  |  |
| `startTime` | string |  |  |  |
| `tripId` | string |  |  |  |

### StopTimeEvent

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `delay` | integer |  |  |  |
| `time` | integer |  |  | ≥ 0. POSIX seconds. |
| `uncertainty` | number |  |  | ≥ 0 |

### NearestStop

A stop near an endpoint whose street access was not verified.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `distanceKind` | string | Yes |  | `straight_line`: proximity, not walking distance. |
| `distanceKm` | number | Yes |  |  |
| `id` | string | Yes |  |  |
| `name` | string | Yes |  |  |

### StreetLeg

A walking or driving leg.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalTime` | string or null | Yes |  |  |
| `components` | array of [AccessComponent](#accesscomponent) |  |  | Street and station costs and their sources, when station access applies. |
| `departureTime` | string or null | Yes |  |  |
| `distanceMeters` | integer |  |  |  |
| `durationSeconds` | integer or null | Yes |  |  |
| `endpointConnector` | [EndpointConnector](#endpointconnector) |  |  |  |
| `from` | [Endpoint](#endpoint) | Yes |  |  |
| `geometry` | [LineString](#linestring) |  |  |  |
| `quality` | [StreetQuality](#streetquality) | Yes |  |  |
| `to` | [Endpoint](#endpoint) | Yes |  |  |
| `type` | `"walk"`, `"drive"`, `"bike"` | Yes |  |  |

### TransitLeg

A ride on one scheduled trip.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `alerts` | array of [LegAlert](#legalert) |  |  | Service Alerts active during the ride for its trip, route or stops. |
| `arrivalTime` | string or null | Yes |  |  |
| `continuation` | [InSeatContinuation](#inseatcontinuation) |  |  |  |
| `departureTime` | string or null | Yes |  |  |
| `directionId` | string or null | Yes |  |  |
| `distanceMeters` | integer |  |  | Length of the returned line, boarding to alighting stop. |
| `durationSeconds` | integer or null | Yes |  |  |
| `endpointConnector` | [EndpointConnector](#endpointconnector) |  |  |  |
| `fare` | [Fare](#fare) |  |  |  |
| `from` | [Endpoint](#endpoint) | Yes |  |  |
| `geometry` | [LineString](#linestring) |  |  |  |
| `headsign` | string or null | Yes |  |  |
| `intermediateStops` | array of [IntermediateStop](#intermediatestop) |  |  |  |
| `quality` | [TransitQuality](#transitquality) | Yes |  |  |
| `route` | [TransitRoute](#transitroute) | Yes |  |  |
| `service` | [Identifier](#identifier) or null | Yes |  |  |
| `serviceDate` | string or null | Yes |  |  |
| `to` | [Endpoint](#endpoint) | Yes |  |  |
| `trip` | [Identifier](#identifier) or null | Yes |  |  |
| `tripShortName` | string or null | Yes |  |  |
| `type` | `"transit"` | Yes |  |  |

### AlertReport

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `closedAlightings` | integer |  |  | ≥ 0 |
| `closedBoardings` | integer |  |  | ≥ 0. Ride segments that lost boarding or alighting. |
| `fresh` | integer |  |  | ≥ 0 |
| `noService` | integer |  |  | ≥ 0. Fresh `NO_SERVICE` alerts. |
| `received` | integer | Yes |  | ≥ 0 |
| `stale` | integer |  |  | ≥ 0 |
| `status` | string |  |  | `timezone_required` when the City clock is ambiguous. |
| `unsupportedEntities` | integer |  |  | ≥ 0. Entities that select nothing VIGO can resolve, such as an agency alone. |

### RealtimeCoverage

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `appliedUpdates` | integer | Yes |  | ≥ 0 |
| `complete` | boolean | Yes |  |  |
| `rejectedUpdates` | integer | Yes |  | ≥ 0 |

### LiveSnapshotReport

The live publication a query used: `vigo serve --realtime-poll`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `feeds` | any |  |  | Each configured source's kind, scope, feed timestamp and failure. |
| `generation` | integer | Yes |  | ≥ 0 |
| `id` | string | Yes |  | Content identifier; equal snapshots have equal identifiers. |
| `source` | string | Yes |  | `server`. |

### CutoffGeometry

Type: object with `coordinates`, `type`.

### CutoffProperties

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cutoffMinutes` | number | Yes |  |  |

### AccessComponent

One part of an access walk's cost.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `distanceMeters` | integer or null | Yes |  |  |
| `durationSeconds` | integer or null | Yes |  |  |
| `sources` | array of string |  |  | Evidence types, sorted and unique, such as `osm` or `gtfs_pathway`. |
| `type` | [AccessComponentType](#accesscomponenttype) | Yes |  |  |

### EndpointConnector

The straight hop between a free coordinate and its street attachment.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `coordinates` | array of [Coordinate](#coordinate) |  |  | 2–2 items |
| `distanceKm` | number | Yes |  |  |
| `source` | string | Yes |  | `coordinate-snap`. |
| `streetPathVerified` | boolean | Yes |  |  |

### Endpoint

A place on a journey. A free coordinate has no `stop` or `name`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `coordinate` | [Coordinate](#coordinate) |  |  |  |
| `name` | string |  |  |  |
| `stop` | [Identifier](#identifier) |  |  |  |

### LineString

A GeoJSON `LineString`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `coordinates` | array of [Coordinate](#coordinate) | Yes |  |  |
| `type` | `"LineString"` | Yes |  |  |

### StreetQuality

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `geometrySource` | string | Yes |  | Where the line came from: `osm`, `osm_and_station_path`, `gtfs_pathway`, `station_selection`, `unverified_transfer` or `unknown`. Treat other values as unverified. |
| `stationPath` | [StationPath](#stationpath) |  |  |  |
| `stationTime` | [StationTime](#stationtime) |  |  |  |
| `streetGeometry` | [StreetVerification](#streetverification) | Yes |  |  |

### LegAlert

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cause` | any |  |  |  |
| `description` | string |  |  |  |
| `effect` | string | Yes |  |  |
| `header` | string |  |  |  |
| `id` | string |  |  |  |
| `severity` | any |  |  |  |
| `url` | string |  |  |  |

### InSeatContinuation

An explicit GTFS continuation from the preceding transit leg.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `durationSeconds` | number | Yes |  |  |
| `type` | [InSeatContinuationType](#inseatcontinuationtype) | Yes |  |  |

### Fare

The published fare for a ride, or why there is none.

Type: [PublishedFare](#publishedfare) or [UnavailableFare](#unavailablefare).

Selected by `status`: `published` → [PublishedFare](#publishedfare), `unavailable` → [UnavailableFare](#unavailablefare).

### IntermediateStop

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `arrivalTime` | string or null | Yes |  |  |
| `coordinate` | [Coordinate](#coordinate) |  |  |  |
| `departureTime` | string or null | Yes |  |  |
| `name` | string |  |  |  |
| `stop` | [Identifier](#identifier) |  |  |  |

### TransitQuality

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `flex` | any |  |  |  |
| `geometry` | string | Yes |  | Where the line came from: `gtfs_shape` (aligned to the feed's shape), `stop_sequence` (straight lines between stops) or `unknown`. |
| `schedule` | [ScheduleQuality](#schedulequality) | Yes |  |  |

### TransitRoute

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `color` | string or null | Yes |  | GTFS `route_color`, without `#`; empty when the feed gives none. |
| `id` | [Identifier](#identifier) or null | Yes |  |  |
| `longName` | string or null | Yes |  |  |
| `name` | string or null | Yes |  | Short name, else long name. |
| `shortName` | string or null | Yes |  |  |
| `type` | integer or null | Yes |  | GTFS `route_type`. |

### AccessComponentType

Type: `"street"`, `"station"`.

### StationPath

| Value | Meaning |
| --- | --- |
| `"inferred"` |  |
| `"source_path"` | A published GTFS pathway. |

### StationTime

| Value | Meaning |
| --- | --- |
| `"estimated"` | Untimed stairs or gates priced by routing estimates. |

### StreetVerification

Type: `"verified"`, `"unverified"`.

### InSeatContinuationType

Type: `"stay_aboard"`.

### PublishedFare

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `agencyUrl` | string |  |  |  |
| `options` | array of [FareOption](#fareoption) | Yes |  |  |
| `source` | string |  |  | The feed the fare came from. |
| `standard` | string | Yes |  | `GTFS Fares v1` or `GTFS Fares v2`. |
| `status` | `"published"` | Yes |  |  |

### UnavailableFare

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `code` | string | Yes |  | Such as `missing_catalog`, `no_rule` or `invalid_data`. |
| `reason` | string | Yes |  |  |
| `status` | `"unavailable"` | Yes |  |  |

### ScheduleQuality

| Value | Meaning |
| --- | --- |
| `"timetable"` | Modeled timetable times, not observed punctuality. |
| `"source_time_limitations"` | The source repeats times or bridges untimed stops. |
| `"realtime"` | Realtime predictions for this trip were applied. |
| `"flex_estimate"` | On-demand timing estimated from OSM driving and explicit duration factors. |

### FareOption

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `amount` | number or null | Yes |  |  |
| `currency` | string |  |  |  |
| `media` | string | Yes |  | Fare media name; empty when unspecified. |
| `name` | string | Yes |  |  |
| `productId` | string | Yes |  |  |
| `riderCategory` | string |  |  | Fares v2 only; empty when unspecified. |

## Result schemas

Documents the engine writes for a query, keyed by their `schema` field, and the types they use. A required field is always present, although its value can be `null`.

### Response

Any document the engine writes for a query, keyed by its `schema`.

Type: [RouteResult](#routeresult) or [MatrixResult](#matrixresult) or [ReachResult](#reachresult) or [DistributionResult](#distributionresult) or [CompareResult](#compareresult) or [InfoResult](#inforesult) or [CollectionInfoResult](#collectioninforesult) or [StreamDetail](#streamdetail) or [ErrorResult](#errorresult).

Selected by `schema`: `vigo.compare.v1` → [CompareResult](#compareresult), `vigo.distribution.v1` → [DistributionResult](#distributionresult), `vigo.error.v1` → [ErrorResult](#errorresult), `vigo.info.v1` → [InfoResult](#inforesult), `vigo.matrix.v1` → [MatrixResult](#matrixresult), `vigo.reach.v1` → [ReachResult](#reachresult), `vigo.route.v1` → [RouteResult](#routeresult), `vigo.scenarios.info.v1` → [CollectionInfoResult](#collectioninforesult), `vigo.stream.detail.v1` → [StreamDetail](#streamdetail).

### CompareResult

Changes between two saved Results, after minus before, in seconds.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `afterStatus` | [QueryStatus](#querystatus) or null |  |  |  |
| `beforeStatus` | [QueryStatus](#querystatus) or null |  |  |  |
| `cityRevisions` | [CityRevisions](#cityrevisions) |  |  |  |
| `counts` | [CompareCounts](#comparecounts) |  |  | Matrix and Reach: cell and pair counts. |
| `durationChangeSeconds` | integer or null |  |  | Route: change in journey duration. |
| `id` | any |  |  |  |
| `meanChangeSeconds` | number or null |  |  | Matrix and Reach: mean over mutually reachable entries; `null` when none. |
| `schema` | `"vigo.compare.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0 |
| `status` | [OkStatus](#okstatus) | Yes |  |  |
| `trace` | any |  |  |  |
| `transferChange` | integer or null |  |  | Route: change in transfers. |

### DistributionResult

Travel-time percentiles over a departure window and sampled schedules.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `accessibility` | [AccessibilityResult](#accessibilityresult) |  |  |  |
| `assumptions` | array of string | Yes |  |  |
| `durationsSeconds` | array of array of number or null | Yes |  | One flattened destination array per percentile. Null means infinity; finite zero is a valid travel time. Matrix arrays use row-major order. |
| `id` | any |  |  | The caller's `id`. |
| `kind` | string | Yes |  |  |
| `layout` | [DistributionLayout](#distributionlayout) | Yes |  |  |
| `meta` | [Meta](#meta) | Yes |  |  |
| `percentiles` | array of integer | Yes |  |  |
| `query` | any | Yes |  | Complete request selectors, retained for reproducibility. |
| `reachableSamples` | array of integer | Yes |  |  |
| `sampling` | [DistributionSampling](#distributionsampling) | Yes |  |  |
| `schema` | `"vigo.distribution.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0. Line number on a resident stream. |
| `status` | [OkStatus](#okstatus) | Yes |  |  |
| `timing` | any | Yes |  |  |
| `warnings` | any | Yes |  |  |

### ErrorResult

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `error` | [ErrorDetail](#errordetail) | Yes |  |  |
| `id` | any |  |  |  |
| `schema` | `"vigo.error.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0 |
| `status` | [ErrorStatus](#errorstatus) | Yes |  |  |

### StreamDetail

`stream --stream-output=detailed`: the internal result without a public projection. `trace` is the unstable internal ABI.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | any | Yes |  |  |
| `schema` | `"vigo.stream.detail.v1"` | Yes |  |  |
| `status` | [OkStatus](#okstatus) | Yes |  |  |
| `trace` | any | Yes |  |  |

### InfoResult

A loaded City: identity, sources, size and limits.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `counts` | [CityCounts](#citycounts) | Yes |  |  |
| `datasetLimitations` | array of [DatasetLimitation](#datasetlimitation) | Yes |  |  |
| `engineVersion` | string | Yes |  |  |
| `id` | any |  |  |  |
| `memory` | any | Yes |  | Process memory accounting. Diagnostic; its fields may change. |
| `name` | string or null | Yes |  |  |
| `resourcePolicy` | [ResourcePolicy](#resourcepolicy) |  |  |  |
| `revision` | string or null | Yes |  |  |
| `schema` | `"vigo.info.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0 |
| `sources` | [CitySources](#citysources) | Yes |  |  |
| `status` | [OkStatus](#okstatus) | Yes |  |  |

### CollectionInfoResult

A loaded scenario collection.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `allocator` | any | Yes |  | Allocator statistics when available. Diagnostic. |
| `defaultScenario` | string | Yes |  |  |
| `engineVersion` | string | Yes |  |  |
| `id` | any |  |  |  |
| `memory` | any | Yes |  | Diagnostic; its fields may change. |
| `name` | string or null | Yes |  |  |
| `residency` | any | Yes |  | Resident scenarios and shared timetable accounting. Diagnostic. |
| `resourcePolicy` | [ResourcePolicy](#resourcepolicy) |  |  |  |
| `scenarios` | array of [CollectionScenario](#collectionscenario) | Yes |  |  |
| `schema` | `"vigo.scenarios.info.v1"` | Yes |  |  |
| `sequence` | integer |  |  | ≥ 0 |
| `status` | [OkStatus](#okstatus) | Yes |  |  |

### CityRevisions

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `after` | string or null | Yes |  |  |
| `before` | string or null | Yes |  |  |

### CompareCounts

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `comparable` | integer | Yes |  | ≥ 0 |
| `faster` | integer |  |  | ≥ 0. Omitted when comparing internal trace results. |
| `newlyReachable` | integer | Yes |  | ≥ 0 |
| `noLongerReachable` | integer | Yes |  | ≥ 0 |
| `slower` | integer |  |  | ≥ 0 |
| `unchanged` | integer |  |  | ≥ 0 |

### OkStatus

Type: `"ok"`.

### AccessibilityResult

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cutoffsMinutes` | array of number | Yes |  |  |
| `decayFunction` | [DecayFunction](#decayfunction) | Yes |  |  |
| `dualThresholds` | array of number | Yes |  |  |
| `layers` | array of [AccessibilityLayerResult](#accessibilitylayerresult) | Yes |  |  |
| `method` | string | Yes |  |  |

### DistributionLayout

Type: object with `bounds`, `height`, `sampling`, `width` or object with `columns`, `destinations`, `order`, `origins`, `rows`.

### DistributionSampling

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `departureMinutes` | integer | Yes |  | ≥ 0 |
| `method` | string | Yes |  |  |
| `observationBytes` | integer | Yes |  | ≥ 0 |
| `quantileMethod` | string | Yes |  |  |
| `requestedDraws` | integer | Yes |  | ≥ 0 |
| `sampleCount` | integer | Yes |  | ≥ 0 |
| `samplesPerMinute` | integer | Yes |  | ≥ 0 |
| `seed` | integer | Yes |  | ≥ 0 |
| `stepMinutes` | integer | Yes |  | ≥ 0 |
| `stochastic` | boolean | Yes |  |  |
| `unreachable` | string | Yes |  |  |

### ErrorDetail

Handle `code` and the HTTP status, not message text.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `code` | string | Yes |  | Such as `invalid_request`, `stop_not_found`, `scenario_not_found`, `unsupported_mode`, `file_not_found`, `permission_denied` or `city_unavailable`. |
| `message` | string | Yes |  |  |

### ErrorStatus

Type: `"error"`.

### CityCounts

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `connections` | integer or null | Yes |  | ≥ 0 |
| `routes` | integer or null | Yes |  | ≥ 0 |
| `stops` | integer or null | Yes |  | ≥ 0 |
| `streetEdges` | integer or null | Yes |  | ≥ 0 |
| `streetNodes` | integer or null | Yes |  | ≥ 0 |
| `trips` | integer or null | Yes |  | ≥ 0 |

### ResourcePolicy

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `memoryCapacityBytes` | integer or null | Yes |  | ≥ 0. Detected memory capacity; `null` when unknown. |
| `swapCountsAsRam` | boolean | Yes |  |  |

### CitySources

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `gtfs` | array of [GtfsSource](#gtfssource) | Yes |  |  |
| `osm` | [OsmSource](#osmsource) or null | Yes |  |  |

### CollectionScenario

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | Yes |  |  |
| `name` | string or null | Yes |  |  |

### AccessibilityLayerResult

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `access` | array of array of array of number | Yes |  | [percentile][origin][cutoff], weighted opportunity counts. |
| `dualSeconds` | array of array of array of number or null | Yes |  | [percentile][origin][threshold], null when insufficient opportunities are reachable within the routing horizon; valid zero stays zero. |
| `id` | string | Yes |  |  |

### GtfsSource

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `feed` | string or null | Yes |  | The feed's scope. |
| `name` | string or null | Yes |  |  |

### OsmSource

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `name` | string or null | Yes |  |  |

## Service schemas

`GET /v1/capabilities` and `GET /v1/info`.

### Capabilities

Check these before relying on an optional feature.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cityFormat` | string | Yes |  |  |
| `commands` | array of string | Yes |  |  |
| `compare` | [CompareCapabilities](#comparecapabilities) | Yes |  |  |
| `compatibility` | [CompatibilityCapabilities](#compatibilitycapabilities) | Yes |  |  |
| `dataPreparation` | string | Yes |  |  |
| `flex` | [FlexCapabilities](#flexcapabilities) |  |  |  |
| `http` | [HttpCapabilities](#httpcapabilities) | Yes |  |  |
| `matrix` | [MatrixCapabilities](#matrixcapabilities) | Yes |  |  |
| `modes` | array of string | Yes |  |  |
| `monteCarlo` | [MonteCarloCapabilities](#montecarlocapabilities) |  |  |  |
| `nativeOperations` | array of string | Yes |  |  |
| `output` | [OutputCapabilities](#outputcapabilities) | Yes |  |  |
| `reach` | [ReachCapabilities](#reachcapabilities) | Yes |  |  |
| `requestSchema` | string | Yes |  |  |
| `route` | [RouteCapabilities](#routecapabilities) | Yes |  |  |
| `routingStoreFormat` | string | Yes |  |  |
| `runtime` | string | Yes |  | `rust`. |
| `scenarioCollections` | [CollectionCapabilities](#collectioncapabilities) | Yes |  |  |
| `schemaVersion` | string | Yes |  | `vigo.standalone.capabilities.v1`. |
| `standalone` | boolean | Yes |  |  |
| `timePreferences` | array of string | Yes |  |  |
| `version` | string | Yes |  | Executable version. |
| `wheelchair` | [WheelchairCapabilities](#wheelchaircapabilities) | Yes |  |  |

### CompareCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `kinds` | array of string | Yes |  |  |

### CompatibilityCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `automaticEditorBranchRetiming` | boolean | Yes |  |  |
| `studioResultEnvelope` | boolean | Yes |  |  |

### FlexCapabilities

Conditional GTFS service supported by this executable. Absent on older runtimes.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `commands` | array of string | Yes |  |  |
| `conditionalBooking` | boolean | Yes |  |  |
| `confirmsAvailability` | boolean | Yes |  |  |
| `continuousStopping` | boolean |  |  |  |
| `directOnly` | boolean | Yes |  |  |
| `maximumMatrixCells` | integer | Yes |  | ≥ 0 |
| `optIn` | boolean | Yes |  |  |
| `transitTransfers` | boolean |  |  |  |
| `wheelchair` | boolean |  |  |  |

### HttpCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `boundedConnections` | boolean | Yes |  |  |
| `boundedQueue` | boolean | Yes |  |  |
| `maxRequestBytes` | integer | Yes |  | ≥ 0 |
| `maxWorkerResponseBytes` | integer | Yes |  | ≥ 0 |
| `workerTerminationOnDeadline` | boolean | Yes |  |  |

### MatrixCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `journeyGeometry` | boolean | Yes |  |  |
| `journeys` | boolean | Yes |  |  |
| `realtimeTransit` | boolean | Yes |  |  |
| `traffic` | boolean | Yes |  |  |

### MonteCarloCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `accessibility` | boolean | Yes |  |  |
| `commands` | array of string | Yes |  |  |
| `maximumDraws` | integer | Yes |  | ≥ 0 |
| `maximumObservationBytes` | integer | Yes |  | ≥ 0 |
| `method` | string | Yes |  |  |
| `phasing` | boolean | Yes |  |  |
| `plannedServices` | boolean | Yes |  |  |
| `scheduledOnly` | boolean | Yes |  |  |

### OutputCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `clock` | string | Yes |  |  |
| `diagnostics` | array of string | Yes |  |  |
| `durationUnit` | string | Yes |  |  |
| `geometry` | string | Yes |  |  |
| `schemas` | array of string | Yes |  |  |
| `streamFormats` | array of string | Yes |  |  |
| `trace` | string | Yes |  |  |

### ReachCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `geojson` | boolean | Yes |  |  |
| `modes` | array of string | Yes |  |  |
| `raster` | boolean | Yes |  |  |
| `realtimeTransit` | boolean | Yes |  |  |
| `scenarios` | array of string | Yes |  |  |
| `streets` | boolean | Yes |  |  |
| `timePreferences` | array of string | Yes |  |  |

### RouteCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `alternatives` | [SampledAlternatives](#sampledalternatives) | Yes |  |  |
| `arrivalWindows` | boolean | Yes |  |  |
| `departureWindows` | boolean | Yes |  |  |
| `fareAnnotations` | boolean | Yes |  |  |
| `journeyPolicies` | array of string |  |  |  |
| `realtime` | boolean | Yes |  |  |
| `requestedAlternatives` | [RequestedAlternatives](#requestedalternatives) | Yes |  |  |
| `transferControls` | boolean | Yes |  |  |
| `transitShapes` | boolean | Yes |  |  |
| `waypoints` | boolean | Yes |  |  |

### CollectionCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `boundedResidency` | boolean | Yes |  |  |
| `format` | string | Yes |  |  |
| `selector` | string | Yes |  |  |
| `sharedStreets` | boolean | Yes |  |  |

### WheelchairCapabilities

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `dataMode` | string | Yes |  |  |
| `modes` | array of string | Yes |  |  |
| `requiresCityProfile` | string | Yes |  |  |
| `supported` | boolean | Yes |  |  |
| `unknownData` | string | Yes |  |  |

### SampledAlternatives

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `coverage` | string | Yes |  |  |
| `maximum` | integer | Yes |  | ≥ 0 |

### RequestedAlternatives

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `maximum` | integer | Yes |  | ≥ 0 |
| `rankings` | array of string | Yes |  |  |
| `timePreferences` | array of string | Yes |  |  |
