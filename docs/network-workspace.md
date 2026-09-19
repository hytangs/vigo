# One network workspace

Network owns one route and station selection across **Network**, **Routes**, and **Ask**. The map, line diagram, arrivals board and conversation use that shared context.

Select a route in **Routes** to open **Trip times** directly. Use **Stops** for direction patterns and dated service bands, or **Updates** for service evidence. Select a station on the line or map to open its arrivals board. **Ask** keeps that selection; **All routes** returns to the catalog. The map’s **Network map** action clears the route and stop selection and restores the network map. Route totals are labeled separately when a station is selected. Station events include its platforms, while a platform selection excludes another platform's departure deviations.

| View | Implementation |
| --- | --- |
| Trip times | `AgencyTripTimetable` |
| Timetable, directions and patterns | `NetworkTimetable` |
| Map and bidirectional line | `VigoMap`, `AgencyRouteLine` |
| Scheduled and predicted arrivals | `StopArrivalBoard` |
| Delay evidence and history charts | `AgencyEvidence` |
| Conversation and saved work | `AgencyPanel`, `AgencyAnswer`, existing notebook |
| Rider guidance | `AgencyEvidence` drafts and Ask |

The [operations ledger](agency-operations.md) and [replay API](operational-replay.md) are programmatic research interfaces, not additional workspace views.

The server resolves selected IDs against the existing City timetable. Studio feed prefixes and merged-store prefixes are translated only for known feeds. An ambiguous bare route or pattern ID cannot select an agency. Names and coordinates supplied to Ask come from that lookup. The selected context is retained with the answer, so a saved “here” question does not silently acquire the meaning of the current map. Opening saved work is explicit navigation; a background answer does not move the map.

After midnight, the line diagram includes the exact service dates of matched vehicles, including those serving the previous service day, and displays the dates used. Vehicles with unresolved or stale stop positions remain outside the line.

Development previews preserve the browser's Host through the Vite proxy. This allows a second local checkout to pass the existing same-origin check. A foreign browser origin remains rejected.

Operations uses explicit serialized source revisions and evidence contents for equality comparisons. It does not generate cryptographic identifiers. Older ledger records remain readable; work using an earlier opaque timetable identity must be tracked against the current revision before new rider guidance is reviewed. Historical comparisons stay within a matching timetable revision.

The Network page puts counts and routes to review first. Service briefing, updates, and coverage are expandable. Ask puts the question and answer ahead of model settings and completed tool records.

## Verification

`test/check-network-workspace.mjs` covers feed collisions, pattern identity, station/platform event scope, previous-day vehicles after midnight, server-resolved Ask context, notebook retention, and invalid selection rejection before model invocation. It runs with `npm run check:agency`.

`test/check-network-workspace-runtime.mjs` checks route search, the three tabs, keyboard navigation, feed settings, recovery from a saved retired tab, and layout from 320 to 1280 pixels wide. It runs with `npm run check:studio-runtime`. Backend operations and replay checks run separately. These fixtures establish the tested interactions and data joins, not general model quality.
