# Vehicle timing and line view

In VIGO Studio, open **Network → Routes**, select a route, and choose **Line view**. The two tracks show each direction's stops and reported vehicles. Select a vehicle on the map or line to compare scheduled and predicted arrival and departure at its reported stop. Branch selectors retain the actual trip patterns.

Vehicle timing comes from the City's full connection store. The selected vehicle card stays open when its route loads, while the vehicle remains in scope.

## Added service

Trips declared by GTFS-RT `ADDED` or `NEW` appear in the line view and **Trip times** selector even when absent from the static timetable. Their reported stop sequences supply line placement and timing, including vehicle-only trips with a known current stop. Partial sequences are labeled as reported stops. Scheduled times and delay comparisons remain unavailable.

Ambiguous identities, unknown stops, duplicate sequences, and stale predictions are not presented as current timings. Added-service display does not imply that the trip is available to journey routing; see [realtime limits](known-routing-limitations.md#realtime).

## Data and matching

Both views use the same per-City timetable, realtime snapshot, identity resolution, service dates, and freshness policy, without a model call. Pattern metadata is cached; vehicle timing refreshes from the current snapshot. The browser requests only the selected route or vehicle every ten seconds, without overlapping requests. The implementation is in `src/agency/routeOperations.mjs`.

- Stop placement follows VehiclePosition's stop ID, sequence and status. It does not use the first TripUpdate stop, road snapping, or interpolated vehicle movement. Missing or conflicting identities remain unplaced.
- Arrival comes from the incoming connection; departure comes from the outgoing connection. Predictions use the matching stop's corresponding arrival or departure event. Delay is the difference between those same-stop timestamps.
- The connection store retains terminal arrival, but not terminal departure or its original sequence. A unique terminal ID can resolve an arrival; an unknown terminal sequence cannot disambiguate a repeated stop. Frequency instances without retained start-time identity remain unresolved.
- Opposite directions share a central station list only when their station sequences are exact reverses. Stations use explicit GTFS parent relationships. Bus stops on opposite sides of a street are not paired by proximity or similar names.
- Branches and repeated stops remain distinct. Skipped stops, missing predictions, duplicate reports and stale observations do not become valid current timing. A reported stop without a sequence is shown as a reported stop, without inferring arrival status.

Spacing is schematic: it represents stop order, not distance, elapsed time or headway. Current times are feed predictions, not verified actual arrivals. Vehicle and prediction observation times are shown separately in the agency timezone. This is a live line diagram, not a historical time-distance chart.

The **↔** warning marks both matched vehicles in a compressed departure pair. The comparison uses their predictions at the same stop against their scheduled interval, including when predicted trip order reverses. The vehicle card names the pair and reference stop. Wider-gap warnings require consecutive predictions in scheduled order; missing intermediate reports remain unknown.

## Verification

The City X fixture in `test/check-agency-route-line.mjs` covers both directions, branches, repeated and terminal stops, conflicting sequences, independent arrival/departure times, stale and future positions, skipped/no-data predictions, and duplicate identities. `test/check-added-service-display.mjs` covers added trips absent from the static timetable. Both run with `npm run check:agency`; they verify fixture behavior, not field prediction accuracy.

## References

The interaction references were [TransitMatters Train Tracker](https://traintracker.transitmatters.org/), its [public source repository](https://github.com/transitmatters/new-train-tracker), and [Swiftly's Live Operations overview](https://swiftly.zendesk.com/hc/en-us/articles/360043691571-Live-Operations-Overview). Their stop-oriented presentations informed the compact two-direction view; no implementation or assets were copied. Matching follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/), especially VehiclePosition status and StopTimeUpdate semantics.
