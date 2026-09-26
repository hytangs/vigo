# Realtime journey routing

## Two modes, one engine

Route exposes `routingDataMode: "realtime" | "scheduled"`. The desktop calls these **Realtime** and **Scheduled · Research**. Journeys through Ask default to realtime; CLI Route defaults to scheduled and accepts `--data-mode realtime|scheduled`. CLI realtime uses a supplied `realtimeSnapshot`; it does not fetch feeds automatically. Internal Studio requests without an explicit mode infer it from snapshot presence; the public CLI requires explicit realtime selection.

Scheduled research requires an explicit service date and departure/arrival time. The server removes realtime and traffic observations before processing the request, enforces the exact date, and disables date substitution. The UI retains the selected date/time and ignores feed polling in this mode. Live refreshes, expiry checks, and mode changes cancel obsolete realtime requests; switching modes never shows the other mode's old result.

Both transit modes use the same native algorithms, stop identities, walking/transfer policies, and optimized coordinate search. The only difference is the timetable presented to that engine. Transit Matrix and Reach remain scheduled analyses and explicitly reject realtime requests. Drive Matrix has a separate supplied-traffic path; see the [support table](../guides/concepts.md#choose-a-supported-combination).

Engine results for an explicit mode include `diagnostics.routingDataMode` and `routingDataProvenance`: source timetable identity, street identity, service date/timezone, query time, walking/search settings, engine contract version, and a reproducibility key. Realtime results also identify the prediction snapshot. Ordered journeys retain component keys and reject changed data identities between legs. To reproduce a research result, retain the same City, VIGO build, and request; the manifest identifies inputs but does not archive them automatically. Retain the returned diagnostics when exporting results so provenance and admission counts remain available. Timing telemetry is not a reproducibility claim.

For setup, see [multiple GTFS and GTFS-RT feeds](../guides/multiple-feeds.md). The [0.4.2 method audit](../development/realtime-audit-0.4.2.md) records correctness repairs and remaining boundaries.

## Shared timetable

Journey searches compile the complete supplied GTFS-RT TripUpdate snapshot into a separate resident timetable. Within the explicit resource admission limits, there is no endpoint-based selection, inspection pruning, or duplicate-stop overlay. Oversized snapshots are rejected as a whole; they are not silently truncated. Each valid matched update replaces its scheduled trip; canceled and deleted trips have no ride segments. Unreported trips retain scheduled times.

Depart-at, arrive-by, transfer limits, and departure-window alternatives use this timetable and the existing native search algorithms. Reverse search and forward journey materialization share the same predictions. A query freezes its observation clock, including recursive verification and window samples. The latest compiled snapshot is cached per immutable service kernel; changes to input or timestamp validity invalidate it. Scheduled queries never inherit predictions from an earlier request.

## Admission and coverage

Updates must identify an active trip in the selected service day and source scope. Ambiguous identities, contradictory duplicate records, invalid timing, unsupported relationships, and stale observations are excluded and counted. Feed and record timestamps are checked independently. Engine admission accepts timestamps at most 180 seconds old and at most 60 seconds ahead of its captured clock. Network tools may apply their own freshness policy before the engine, retaining all rejection counts.

An unreported scheduled prefix may conflict with the first explicit prediction of an early-running trip. The resolver can exclude that prefix only when all its departures and the first explicit prediction precede the frozen feed/record observation boundary, without an earlier explicit update or a trip-level delay. The supplied suffix predictions remain unchanged. `pastPrefixTrips` and `omittedPastPrefixStops` disclose the exclusion; this does not reconstruct past events or claim actual passage. Unreconciled future prefixes and contradictory observations remain rejected.

`diagnostics.realtimeRouting` identifies the snapshot and reports applied, canceled, stale, unmatched, wrong-date, duplicate, invalid, and unsupported records. `coverage` accounts for supplied records, including records rejected by Network tools before routing. `prunedUpdates` is zero. `partial` means some updates were applied while others were excluded. `failedFeeds` reports unavailable endpoints, and prevents complete coverage even when all received records were admitted. A scheduled fallback is explicitly identified; compile/search failures do not silently retry against scheduled service.

Full snapshot processing is not a claim that every trip has a prediction. The UI distinguishes predicted and scheduled journey times, live cancellations, and excluded records. Added/unscheduled/replacement/duplicated trips without a supported scheduled instance remain unsupported and disclosed. Frequency instances and cross-timezone stores retain the existing routing-contract limits. Vehicle positions and text alerts do not invent stop-time predictions.

Studio's [added-service display](../guides/network.md#added-service) is separate from routing admission. A reported trip can appear in the line view and trip selector without being available to Route.

## Read the realtime status

For CLI transit Route, inspect `result.diagnostics.realtimeRouting.status` together with its counts. `routingDataMode: "realtime"` records the requested mode; it does not by itself mean that predictions changed the timetable.

| Status | Meaning |
| --- | --- |
| `applied` | Matched trip replacements were applied, possibly with cancellations, with no rejected supplied updates |
| `cancellations_only` | Only trip removals were applied, with no rejected supplied updates |
| `partial` | At least one replacement or cancellation was applied and at least one supplied update was rejected |
| `stale_fallback` | No update was applied and feed or record timestamp checks failed |
| `no_matches` | No update was applied for other reasons; check unmatched, wrong-date, duplicate, invalid, and unsupported counts |
| `scheduled_fallback` | No realtime search diagnostics were available; read `fallbackReason`, such as a missing snapshot or a realtime search that did not run |

`coverage.complete` concerns admission of the **supplied updates**, including upstream exclusions. It does not measure the share of all scheduled trips reporting. A fully admitted cancellation snapshot can legitimately return a blocked journey. `routingDataProvenance.realtimeApplied` includes both replacements and cancellations. Retain these fields with the answer; see [Result interpretation](results.md#keep-uncertainty-with-the-answer).

## Verification

Run `npm run check:gtfs` for the full feed/routing suite. Its engine API regressions include more than 256 updated trips, more than 1,024 input records, more than 4,096 updated stops, interior transfers, both time directions, cancellations, skipped stops, balanced choices, transfer limits, snapshot replacement, and timestamp expiry. Kernel tests exercise real native forward/reverse searches and immutable scheduled arrays. Agency and UI suites verify admission and displayed coverage.

`check-realtime-scheduled-parity.mjs` compares 1,536 paired engine queries against eight independently imported GTFS timetables containing the literal effective predictions. It covers both time directions, multiple origin/destination pairs, internal balanced/fastest preferences, transfer limits, dwell, early/late trips, cancellations, skipped calls, and `NO_DATA`. These establish algorithm parity for the tested cases, not field ETA accuracy. `check-realtime-past-prefix.mjs` adds 16 native/literal comparisons, excluded-prefix boarding checks, and cache invalidation when a future source clock becomes current. `check-routing-data-modes.mjs` proves observation isolation and exact-date research behavior. Real browser checks cover current controls, polling, navigation, and source replacement. Earlier renderer spies for mode switching and forced refresh failures were removed; those checks are not claimed as equivalent integration coverage.

The internal preference regressions do not add a public `balanced` objective. The CLI exposes `earliest_arrival`, as described in [Route](routing.md).


## Stop predictions and source versions

Trip-level delay propagates forward until a stop-specific prediction replaces it. A prediction at an intermediate stop never becomes a delay for earlier calls. Absolute time takes precedence over delay; arrival and departure remain separate. `NO_DATA` resets propagated delay. `SKIPPED` removes boarding and alighting while retaining through travel. Repeated stops require an unambiguous sequence, and out-of-order supplied sequences are rejected.

Each decoded record retains its endpoint, source timestamp and selected static-feed scope. Per-feed version metadata is retained for inspection; VIGO does not currently compare GTFS-RT `feed_version` with static `feed_info.feed_version`. The operator must connect the matching timetable edition. Missing Trip Updates mean no reported prediction, not verified on-time operation.

Resource admission is separate from semantic coverage: downloads are bounded, the decoder rejects feeds above 100,000 entities or 500,000 stop predictions, and native reconstruction checks its estimated memory against the configured timetable budget. Over-limit data is rejected, never silently truncated. These safeguards do not establish immunity to operating-system memory exhaustion.
