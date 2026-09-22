# Network, Routes, and Ask

Open **Network** in VIGO Studio to inspect the selected City's timetable, live reports, and saved investigations. The workspace has **Network**, **Routes**, and **Ask** tabs. Use the separate **Route** view for journey planning and **Analyze** for Reach; Matrix is available through the CLI and Python.

## See what needs attention

Open **Network** for reporting coverage, route comparisons and the network briefing. A scheduled departure, a feed prediction and an observed vehicle location are different evidence. Missing reports remain unknown. Overnight service is assessed against the timetable's active service window, not daytime expectations.

With a connected model, the briefing can interpret the pattern, propose an explanation and suggest a next check. Hypotheses are not confirmed incidents. The briefing checks extracted route-condition claims against computed evidence and performs a model review, but neither guarantees that all prose is correct. A computed fallback is labeled separately. The timestamp and coverage tell you which observation the briefing describes; the refresh setting is separate from feed polling.

## Inspect a route or station

Open **Routes** and choose a route to see **Trip times**. Select a trip and service date to compare its scheduled and predicted arrivals or departures. **Stops** opens directions and patterns; **Updates** opens service evidence. The map and **Line view** show the same selected route. Select a stop to see its arrivals board. **All routes** returns to the catalog. Actual stop-event times are unavailable in the current prediction source.

The route and station selection are shared with Ask. **Network map** clears both; a station board includes its platforms, while a platform selection keeps its own scope. “Here” can refer to that station; a named route or vehicle keeps its own identity. Selecting a route does not select a particular bus. Saved answers retain the selection and evidence from the original question.

## Patterns and scheduled playback

Choose a route's **Stops** view to inspect directions, patterns, ordered stops, service span, and published geometry. The direction chooser labels patterns by their first and last stops; **Full service** restores all patterns. Direction IDs `0` and `1` are feed labels, not compass directions. Repeated visits remain separate. Technical IDs appear under **Source data**.

Feed totals cover the imported calendars. After trip details load, counts and timetable bands use the selected service date. Times such as `25:10` remain on that GTFS service day; empty dates have no service band.

Scheduled playback is labeled **Estimated**. Vehicles dwell at stops and follow their pattern's shape between timed calls. Missing or inconsistent geometry is omitted and reported in diagnostics. The index does not retain `shape_dist_traveled` or every untimed call, so interpolated positions are not exact locations. A timetable band spans the first departure through the last arrival, including gaps in service.

Live positions remain separate from playback. Route-colored vehicle circles show a bearing arrow when available. Map layers do not change query semantics. Vehicle Positions and Alerts are display evidence; only supported Trip Updates can change [realtime Route](../reference/realtime-routing.md).

## Vehicle timing and line view

In VIGO Studio, open **Network → Routes**, select a route, and choose **Line view**. The two tracks show each direction's stops and reported vehicles. Select a vehicle on the map or line to compare scheduled and predicted arrival and departure at its reported stop. Branch selectors retain the actual trip patterns.

Vehicle timing comes from the City's full connection store. The selected vehicle card stays open when its route loads, while the vehicle remains in scope.

### Added service

Trips declared by GTFS-RT `ADDED` or `NEW` appear in the line view and **Trip times** selector even when absent from the static timetable. Their reported stop sequences supply line placement and timing, including vehicle-only trips with a known current stop. Partial sequences are labeled as reported stops. Scheduled times and delay comparisons remain unavailable.

Ambiguous identities, unknown stops, duplicate sequences, and stale predictions are not presented as current timings. Added-service display does not imply that the trip is available to journey routing; see [realtime limits](../reference/known-routing-limitations.md#realtime).

### Data and matching

The map and line views use the same per-City timetable, realtime snapshot, identity resolution, service dates, and freshness policy, without a model call. Pattern metadata is cached; vehicle timing refreshes from the current snapshot. The browser requests only the selected route or vehicle every ten seconds, without overlapping requests.

- Stop placement follows VehiclePosition's stop ID, sequence and status. It does not use the first TripUpdate stop, road snapping, or interpolated vehicle movement. Missing or conflicting identities remain unplaced.
- Arrival comes from the incoming connection; departure comes from the outgoing connection. Predictions use the matching stop's corresponding arrival or departure event. Delay is the difference between those same-stop timestamps.
- The connection store retains terminal arrival, but not terminal departure or its original sequence. A unique terminal ID can resolve an arrival; an unknown terminal sequence cannot disambiguate a repeated stop. Frequency instances without retained start-time identity remain unresolved.
- Opposite directions share a central station list only when their station sequences are exact reverses. Stations use explicit GTFS parent relationships. Bus stops on opposite sides of a street are not paired by proximity or similar names.
- Branches and repeated stops remain distinct. Skipped stops, missing predictions, duplicate reports and stale observations do not become valid current timing. A reported stop without a sequence is shown as a reported stop, without inferring arrival status.

Spacing is schematic: it represents stop order, not distance, elapsed time or headway. Current times are feed predictions, not verified actual arrivals. Vehicle and prediction observation times are shown separately in the agency timezone. This is a live line diagram, not a historical time-distance chart.

The **↔** warning marks both matched vehicles in a compressed departure pair. The comparison uses their predictions at the same stop against their scheduled interval, including when predicted trip order reverses. The vehicle card names the pair and reference stop. Wider-gap warnings require consecutive predictions in scheduled order; missing intermediate reports remain unknown.

### Verification

The City X fixture in `test/check-agency-route-line.mjs` covers both directions, branches, repeated and terminal stops, conflicting sequences, independent arrival/departure times, stale and future positions, skipped/no-data predictions, and duplicate identities. `test/check-added-service-display.mjs` covers added trips absent from the static timetable. Both run with `npm run check:agency`; they verify fixture behavior, not field prediction accuracy.

### References

The interaction references were [TransitMatters Train Tracker](https://traintracker.transitmatters.org/), its [public source repository](https://github.com/transitmatters/new-train-tracker), and [Swiftly's Live Operations overview](https://swiftly.zendesk.com/hc/en-us/articles/360043691571-Live-Operations-Overview). Their stop-oriented presentations informed the compact two-direction view; no implementation or assets were copied. Matching follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/), especially VehiclePosition status and StopTimeUpdate semantics.

## Ask a complete question

Use a location, route or vehicle number when it matters. For example:

- “What needs attention across the network?”
- “Compare these two routes' gaps and reporting coverage.”
- “How has vehicle [number]'s predicted delay changed?”
- “When is the next departure from [station], for each route?”
- “Draft an apologetic rider update using the confirmed facts.”

Ask chooses reusable checks, can correct scope or request a missing check, and keeps the evidence with the answer. Its assessment forms preserve computed values. Network interpretation and general replies use the model. Activity and sources are inspectable; private model reasoning is not displayed. **History** reopens saved conversations. **Clear Ask history** deletes this City’s Ask conversations and attached notes after confirmation, and resets the active conversation. Briefings, research, feed observations, and settings are retained. Clearing history requires configuration permission; answers already running cannot recreate the deleted records. An old answer remains an old observation even when the feeds have advanced.

## Connect a model and web search

In Ask's connection settings, choose a provider, enter its API base URL, choose or discover a model, and connect. The connection test checks function calling, not answer quality. Local models can use a keyless endpoint if their server permits it. API keys stay in server memory for the app session.

Web search is configured separately. Connecting an LLM does not grant online search. Network-capable tools may contact their configured services, and model requests include the question, supplied conversation context and selected tool results. Consult the answer's **Model & data** record for captured endpoint and tool activity. A localhost URL does not prove inference hosting, retention or downstream forwarding.

## What this app does not establish

Predicted spacing is not measured headway; retained forecast changes are not actual vehicle progression. Reporting coverage is not service health. Ask has no connected crew roster, maintenance clearance, passenger-demand model or live intervention simulator. It can discuss conditional options and draft rider text; it does not authorize dispatch or publish messages.

The [operations ledger](../research/agency-operations.md) and [synthetic replay](../research/operational-replay.md) are research APIs, not hidden everyday workspace panels.
