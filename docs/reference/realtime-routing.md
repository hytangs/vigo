# Realtime journey routing

## Two modes, one engine

Route exposes `routingDataMode: "realtime" | "scheduled"`. The desktop calls these **Realtime** and **Scheduled · Research**. Journeys through Ask default to realtime; CLI Route defaults to scheduled and accepts `--data-mode realtime|scheduled`. CLI realtime uses a supplied `realtimeSnapshot`; it does not fetch feeds automatically. Internal Studio requests without an explicit mode infer it from snapshot presence; the public CLI requires explicit realtime selection.

Scheduled research requires an explicit service date and departure/arrival time. The server removes realtime and traffic observations before processing the request, enforces the exact date, and disables date substitution. The UI retains the selected date/time and ignores feed polling in this mode. Live refreshes, expiry checks, and mode changes cancel obsolete realtime requests; switching modes never shows the other mode's old result.

Both modes use the same native algorithms, stop identities, walking/transfer policies, and optimized coordinate search. The only difference is the timetable presented to that engine. Matrix and Reach remain scheduled analyses and explicitly reject realtime requests rather than returning scheduled results under a realtime label.

Engine results for an explicit mode include `diagnostics.routingDataMode` and `routingDataProvenance`: source timetable identity, street identity, service date/timezone, query time, walking/search settings, engine contract version, and a reproducibility key. Realtime results also identify the prediction snapshot. Ordered journeys retain component keys and reject changed data identities between legs. To reproduce a research result, retain the same City, VIGO build, and request; the manifest identifies inputs but does not archive them automatically. Retain the returned diagnostics when exporting results so provenance and admission counts remain available. Timing telemetry is not a reproducibility claim.

## Shared timetable

Journey searches compile the complete supplied GTFS-RT TripUpdate snapshot into a separate resident timetable. There is no endpoint-based selection, trip count cap, inspection cap, or duplicate-stop overlay. Each valid matched update replaces its scheduled trip; canceled and deleted trips have no ride segments. Unreported trips retain scheduled times.

Depart-at, arrive-by, transfer limits, and departure-window alternatives use this timetable and the existing native search algorithms. Reverse search and forward journey materialization share the same predictions. A query freezes its observation clock, including recursive verification and window samples. The latest compiled snapshot is cached per immutable service kernel; changes to input or timestamp validity invalidate it. Scheduled queries never inherit predictions from an earlier request.

## Admission and coverage

Updates must identify an active trip in the selected service day and source scope. Ambiguous identities, contradictory duplicate records, invalid timing, unsupported relationships, and stale observations are excluded and counted. Feed and record timestamps are checked independently. Engine admission accepts timestamps at most 180 seconds old and at most 60 seconds ahead of its captured clock. Network tools may apply their own freshness policy before the engine, retaining all rejection counts.

An unreported scheduled prefix may conflict with the first explicit prediction of an early-running trip. The resolver can exclude that prefix only when all its departures and the first explicit prediction precede the frozen feed/record observation boundary, without an earlier explicit update or a trip-level delay. The supplied suffix predictions remain unchanged. `pastPrefixTrips` and `omittedPastPrefixStops` disclose the exclusion; this does not reconstruct past events or claim actual passage. Unreconciled future prefixes and contradictory observations remain rejected.

`diagnostics.realtimeRouting` identifies the snapshot and reports applied, canceled, stale, unmatched, wrong-date, duplicate, invalid, and unsupported records. `coverage` accounts for supplied records, including records rejected by Network tools before routing. `prunedUpdates` is zero. `partial` means some updates were applied while others were excluded. A scheduled fallback is explicitly identified; compile/search failures do not silently retry against scheduled service.

Full snapshot processing is not a claim that every trip has a prediction. The UI distinguishes predicted and scheduled journey times, live cancellations, and excluded records. Added/unscheduled/replacement/duplicated trips without a supported scheduled instance remain unsupported and disclosed. Frequency instances and cross-timezone stores retain the existing routing-contract limits. Vehicle positions and text alerts do not invent stop-time predictions.

Studio's [added-service display](../guides/network.md#added-service) is separate from routing admission. A reported trip can appear in the line view and trip selector without being available to Route.

## Verification

Run `npm run check:gtfs` for the full feed/routing suite. Its engine API regressions include more than 256 updated trips, more than 1,024 input records, more than 4,096 updated stops, interior transfers, both time directions, cancellations, skipped stops, balanced choices, transfer limits, snapshot replacement, and timestamp expiry. Kernel tests exercise real native forward/reverse searches and immutable scheduled arrays. Agency and UI suites verify admission and displayed coverage.

`check-realtime-scheduled-parity.mjs` compares 1,536 paired engine queries against eight independently imported GTFS timetables containing the literal effective predictions. It covers both time directions, multiple origin/destination pairs, internal balanced/fastest preferences, transfer limits, dwell, early/late trips, cancellations, skipped calls, and `NO_DATA`. These establish algorithm parity for the tested cases, not field ETA accuracy. `check-realtime-past-prefix.mjs` adds 16 native/literal comparisons, excluded-prefix boarding checks, and cache invalidation when a future source clock becomes current. `check-routing-data-modes.mjs` proves observation isolation and exact-date research behavior. The desktop runtime test covers mode switching, failed-poll expiry, source clock boundaries, cancellation, and obsolete-response suppression.

The internal preference regressions do not add a public `balanced` objective. The CLI exposes `earliest_arrival`, as described in [Route](routing.md).
