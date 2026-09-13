# Vehicle timing and line view

In Agency, select a route in Live, then choose **Line view** above the map. The two tracks show each direction's stops and reported vehicles. Select a vehicle in either view to compare scheduled and current arrival and departure at its reported stop. Branch selectors retain the actual trip patterns.

The vehicle card previously depended on the map's partial timetable preview and could choose a past stop from the trip update. It now reads the City's full connection store through the shared Agency context. Selecting a vehicle also selected its route, which could immediately clear the card as the map reloaded; the card now survives that change while the vehicle remains in scope.

## Data and matching

`src/agency/routeOperations.mjs` serves both views without a model call. It uses the same per-City timetable, realtime snapshot, identity resolution, service dates and freshness policy as Agency's operational tools. Pattern metadata is cached on that context; vehicle timing is refreshed from its current snapshot. The browser requests only the selected route or vehicle every ten seconds, without overlapping requests.

- Stop placement follows VehiclePosition's stop ID, sequence and status. It does not use the first TripUpdate stop, road snapping, or interpolated vehicle movement. Missing or conflicting identities remain unplaced.
- Arrival comes from the incoming connection; departure comes from the outgoing connection. Predictions use the matching stop's corresponding arrival or departure event. Delay is the difference between those same-stop timestamps.
- The connection store retains terminal arrival, but not terminal departure or its original sequence. A unique terminal ID can resolve an arrival; an unknown terminal sequence cannot disambiguate a repeated stop. Frequency instances without retained start-time identity remain unresolved.
- Opposite directions share a central station list only when their station sequences are exact reverses. Stations use explicit GTFS parent relationships. Bus stops on opposite sides of a street are not paired by proximity or similar names.
- Branches and repeated stops remain distinct. Skipped stops, missing predictions, duplicate reports and stale observations do not become valid current timing. A reported stop without a sequence is shown as a reported stop, without inferring arrival status.

Spacing is schematic: it represents stop order, not distance, elapsed time or headway. Current times are feed predictions, not verified actual arrivals. Vehicle and prediction observation times are shown separately in the agency timezone. This is a live line diagram, not a historical time-distance chart.

## Verification

The City X fixture in `test/check-agency-route-line.mjs` covers both directions, branches, repeated and terminal stops, conflicting sequences, independent arrival/departure times, stale and future positions, skipped/no-data predictions and duplicate identities. The Agency test suite includes this fixture.

Browser checks used Boston's configured MBTA feeds on September 13, 2026, including Red Line vehicle 1960 / trip 77916566, Braintree and Ashmont branch switching, bus route 1, and a 390-pixel viewport. Vehicle 1960's card showed schedule and prediction for the same reported stop as it progressed through the route; this was a live observation, not a frozen benchmark. Map selection and line selection use the same timing component.

## References

The interaction references were [TransitMatters Train Tracker](https://traintracker.transitmatters.org/), its [public source repository](https://github.com/transitmatters/new-train-tracker), and [Swiftly's Live Operations overview](https://swiftly.zendesk.com/hc/en-us/articles/360043691571-Live-Operations-Overview). Their stop-oriented presentations informed the compact two-direction view; no implementation or assets were copied. Matching follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/), especially VehiclePosition status and StopTimeUpdate semantics.
