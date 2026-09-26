# Realtime and traffic method audit · 0.4.2

This audit covers supported routing behavior in Engine and Studio. It is software verification, not a paper result, a live ETA calibration, or a claim about dispatch outcomes. No traffic provider was configured for this release.

## What a realtime answer means

A transit query resolves records against an active static trip and service day, applies accepted predictions to a separate timetable, then runs native search and journey reconstruction. Unreported trips retain scheduled times. The answer can therefore contain a mixture of predictions and schedule-based legs. `routingDataMode: "realtime"` alone does not establish that a prediction was used.

The audit follows the primary [GTFS-Realtime reference](https://gtfs.org/documentation/realtime/reference/) and [producer best practices](https://gtfs.org/documentation/realtime/realtime-best-practices/). These specifications define feed semantics; they do not certify VIGO's implementation or an individual producer's accuracy.

## Findings and repairs

| Finding | Repair | Verification |
| --- | --- | --- |
| Studio accepted one group of URLs and omitted static source identity during normalization | Explicit endpoint list, timetable selection, source metadata on every record, and one shared URL normalization boundary | Two imported GTFS feeds with identical trip IDs, actual protobuf over HTTP, native forward/reverse queries |
| A first stop-level delay could be copied into the trip-wide delay | Preserve only the actual TripUpdate delay at trip level; stop predictions propagate forward from their own calls | A downstream prediction leaves origin boarding unchanged; separate literal-timetable comparisons |
| Unknown enum values could disappear and become the default scheduled relationship | Retain `UNKNOWN` and reject unsupported routing relationships | Decoder/normalization and routing admission checks |
| Unordered stop sequences were accepted through lookup maps | Reject non-increasing reported sequences | Timing admission regression |
| Successful records could appear fully admitted while another endpoint failed | Preserve individual feed errors and expose `failedFeeds`; complete coverage remains false | Combined successful and rejected FULL_DATASET/DIFFERENTIAL input |
| Retained observations could outlive their timetable revision | Save the timetable identity and discard obsolete active snapshots when it changes; retain the connection for a fresh fetch | City lifecycle and operational persistence checks |
| Vehicle cards indexed raw trip IDs across feeds | Match source scope and trip instance; duplicate prediction reports remain unresolved | Two source scopes sharing route/trip IDs in the actual vehicle-frame builder |
| More endpoints could multiply retained payloads | Bound sockets, refresh duration, bytes, entities and stop predictions; reject excess input explicitly | Production bounded-reader/security tests and multi-feed integration |
| Native realtime reconstruction could allocate beside an already resident scheduled view | Check a conservative reconstruction estimate against the same finite timetable budget before native compilation | Native reconstruction regressions and low-budget runtime admission checks |

The existing separate worker and Engine recovery checks use actual thread/process termination and subsequent real routing. They do not claim recovery from every native hang or operating-system out-of-memory condition. See [runtime limits](runtime-recovery.md).

## Semantic checks retained

| Question | Implemented rule |
| --- | --- |
| Can one agency's `trip_id` change another? | Only an exact or uniquely resolved source identity can match; contradictory scope, route and direction are excluded |
| Can a missing report establish on-time service? | No. Scheduled fallback is disclosed; supplied-update coverage is separate from all-service reporting coverage |
| Can an old cached snapshot stay live? | No. Feed and record clocks are rechecked; expiry changes cache identity |
| Can predictions travel backward along the trip? | No. Stop-specific delay propagates downstream; absolute time wins over delay; arrival/departure remain separate |
| Can an update make a journey run backward in time? | Contradictory event order and native numeric overflow are rejected |
| Can a canceled or deleted trip reappear through fallback? | Removed trips stay removed in both search directions; cancellation does not authorize a different service date |
| Can skipped stops still be boarded? | No. Through travel remains possible; boarding and alighting are removed |
| Does `NO_DATA` continue a prior delay? | No. It resets propagated delay |
| Do route endpoints restrict which predictions get applied? | No. All admitted supplied updates participate in the rebuilt timetable |
| Are prediction uncertainty fields confidence intervals? | No. Routing uses point predictions; it does not infer a calibrated probability or arrival interval |

FULL_DATASET is supported. Entity deletion markers that require a differential stream are rejected; trip cancellations remain distinct. DIFFERENTIAL and unknown incrementality are rejected. NEW/ADDED, replacement, duplicated and frequency-instance routing remain outside the supported contract; some added service can be displayed separately. A feed header's `feed_version` is retained but not automatically checked against static `feed_info`. One timezone per combined routing store remains required. Vehicle Positions and Alerts do not generate arbitrary travel-time costs or transit closures.

## Traffic boundary

Drive Route and Matrix accept caller-supplied observed edge costs and closures. They customize the same native graph and reuse unchanged effective metrics. Expired snapshots disclose baseline fallback; invalid direct indices require the correct graph fingerprint. Regressions check slowdown, alternative paths, blocked closures, expiry and Route/Matrix agreement through actual native and worker execution.

This is a static snapshot of road costs. It does not model future traffic evolution, all turn restrictions, signals, or parking. Nearest-edge geometry matching is not a provider-calibrated mapping. No public performance or ETA-quality claim follows from these checks. See the [traffic contract and input example](../reference/street-routing.md#supplied-traffic).

## Efficiency and evidence

Static GTFS import and native index preparation occur at City build/open. Queries reuse prepared graphs, endpoint mappings and the latest compiled realtime view where identities and timestamp validity agree. Duplicate feed URLs are fetched once. Decoded feeds are normalized as they arrive, so a batch need not retain every raw protobuf. Native traffic customization reuses the effective edge metric.

Costs remain in feed decoding, full-snapshot hashing and reconstruction, source matching, selected-journey assembly and map updates. Increasing worker count can multiply graph memory. These mechanisms explain where work occurs; they are not a ranked production profile or a measured speedup.

The retained independent transit oracle compares **1,536 pairs** of realtime queries with separately imported literal predicted timetables, plus **16** past-prefix comparisons and **263** exhaustive journey checks. Multi-source integration adds two directions over independently imported duplicate-ID feeds. Constructed inputs test declared semantics; real MBTA/OpenStreetMap application captures test the working integration on those downloaded sources. Neither establishes field ETA accuracy.

Run `npm run check:release`, `npm run check:studio-runtime`, and `npm run release:studio`. The [release audit](audit-0.4.2.md) records final platform verification and cleanup. Test inputs are actual GTFS/OSM/protobuf documents; production routing, storage, browser and process code computes the outcomes. No model responses or route-worker implementations are substituted.
