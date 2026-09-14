# One network workspace

Network owns one route and station selection across **Overview**, **Routes**, and **Ask**. The map, line diagram, arrivals board and conversation use that shared context.

Select a route in the catalog or search, inspect its reports, and expand **Timetable & patterns** for the existing direction browser and dated service bands. Select a station on the line or map to open the shared arrivals board. **Ask about this** keeps that selection; **All network** returns to the catalog. Route totals are labeled separately when a station is selected. Station events include its platforms, while a platform selection excludes another platform's departure deviations.

| View | Reused implementation |
| --- | --- |
| Timetable, directions and patterns | `NetworkTimetable`, moved from `ExploreObjectPanel` |
| Map and bidirectional line | `VigoMap`, `AgencyRouteLine` |
| Scheduled and predicted arrivals | `StopArrivalBoard` |
| Delay evidence and history charts | `AgencyEvidence` |
| Conversation and saved work | `AgencyPanel`, `AgencyAnswer`, existing notebook |
| Rider guidance | `AgencyEvidence` drafts and Ask |

The former Skills, Operations and Replay panels have been removed. Their backend research methods, operations ledger and replay API remain available to programmatic callers and their existing tests; they are not additional workspace views.

The server resolves selected IDs against the existing City timetable. Studio feed prefixes and merged-store prefixes are translated only for known feeds. An ambiguous bare route or pattern ID cannot select an agency. Names and coordinates supplied to Ask come from that lookup. The selected context is retained with the answer, so a saved “here” question does not silently acquire the meaning of the current map. Opening saved work is explicit navigation; a background answer does not move the map.

During testing after midnight, fresh vehicles serving the previous service day were missing from the line diagram's current-day patterns. The diagram now includes the exact service dates of those matched vehicles and displays the dates used. It still leaves vehicles with unresolved or stale stop positions outside the line.

Development previews preserve the browser's Host through the Vite proxy. This allows a second local checkout to pass the existing same-origin check. A foreign browser origin remains rejected.

Operations uses explicit serialized source revisions and evidence contents for equality comparisons. It does not generate cryptographic identifiers. Older ledger records remain readable; work using an earlier opaque timetable identity must be tracked against the current revision before new rider guidance is reviewed. Historical comparisons stay within a matching timetable revision.

## Verification

The network fixture covers feed collisions, pattern identity, station/platform event scope, previous-day vehicles after midnight, server-resolved Ask context, notebook retention and invalid selection rejection before model invocation. The existing Agency, UI, map, documentation and local HTTP security checks pass, along with TypeScript and the production web build.

The workspace runtime fixture checks route search, the three tabs, keyboard navigation, feed settings, recovery from a saved retired tab, and layout from 320 to 1280 pixels wide. Backend operations and replay checks run separately. Earlier browser checks used the local Boston feed for timetable patterns, the Red Line diagram, Park Street's arrivals board and a Qwen3.5 4B reply recognizing the selected route and station. These checks establish the tested interaction and data joins; they are not a general model-quality benchmark.
