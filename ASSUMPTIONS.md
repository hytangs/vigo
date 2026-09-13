# Assumptions and scope

This is a small operations prototype over an existing VIGO City. Boston demonstrates the workflow; City X is a synthetic correctness example. Neither is a field evaluation of operator decisions.

## Data interpretation

- One agency timezone is required per City. Calendar exceptions are applied before using a service date. Every indexed source scope must establish active service for the current date before realtime connection; this conservatively excludes a scope with no service today.
- Place-name lookup groups platforms using the explicit GTFS `parent_station` relation and excludes entrances from general boarding-place search. An exact stop ID retains its original identity. No nearest-place guess is used.
- Trip matching requires an exact trip ID and active service. Provided route, direction, source scope, and start date constrain the match. Missing or ambiguous identities stay unresolved. Frequency-based trip instances are unsupported because the retained connections do not establish their original start-time model.
- VIGO’s connection table is not the original `stop_times.txt`. Terminal departures and unretained intermediate calls are not reconstructed. Stop sequences are not assumed to be consecutive integers.
- Headway comparisons use departure predictions at the same stop, route, direction, and service date. The same adjacent scheduled departures must both report. Missing reports or reordered predictions prevent that comparison. Arrival predictions and vehicle spacing do not stand in for departure predictions.
- Stop-level departure time or delay is used when explicitly reported. Trip-level delay propagation is not added. Positive delays and any unequal interval are numerical comparisons, not calibrated disruption classifications.
- Alert text is agency-published information. Active periods and source freshness are checked. Ambiguous raw route or stop IDs are not assigned across multiple source scopes. Alert selectors are retained for inspection; an alert does not automatically close anything in the routing engine.

## Observation scope

Feeds refresh about every ten seconds. Each feed has its own clock. The 180-second freshness limit, 30-minute comparison window, and 30-minute history are declared prototype settings. Missing timestamps remain unknown. The latest map positions and fresh-position counts describe different scopes: the inherited map can show the latest reported position, while the Agency metric requires a recent vehicle timestamp.

The delay chart follows a trip’s next predicted departure; its reference stop can change as the trip progresses. Points use source observation times, and repeated source timestamps replace the same point. History is in memory and disappears on restart or disconnect. The server keeps at most eight City sessions and stops background refresh after five minutes without a reader. Route and event filters are applied before the Live response limit of 500 matching events; the event list shows 40 at once, and a tool response includes up to 100 events. Route grouping retains the largest requested measure per route after sorting; it is not a route-wide reliability estimate.

## AI and queries

Ask requires an OpenAI-compatible model with function calling. Connection settings are shared by Cities in the same app server. UI-entered keys stay in server memory; reconnect after restarting. A successful connection test confirms a function call, not general analytical competence.

The model plans a bounded investigation: at most eight tool calls and six rounds. A provider request has a 45-second deadline. A failed later request preserves completed evidence. The activity trail shows tool actions and evidence summaries; it does not expose private model reasoning.

SQL is read-only, with approved tables/functions, one statement, 200 rows, 256 KB, two simultaneous query processes, and a 1.5-second execution deadline. These limits protect a small local application. They do not prove that every model-written query expresses the user’s intent correctly. Questions about a particular date still require the appropriate calendar logic in the query, which remains visible for inspection.

The model’s final free text is not treated as operational evidence. Readable answer sentences and numeric displays are assembled from returned tool data. This reduces unsupported claims but limits the range and nuance of answers. The prototype does not claim to answer arbitrary causal, forecasting, or optimization questions.

## Routing and rider information

Route adapts VIGO’s existing engine and reports whether eligible trip updates were applied or scheduled fallback was used. Service alerts are contextual. Reach and the internal small Matrix adapter use scheduled service; Reach requires an indexed OSM walking network. No routing subprocess or replacement routing engine was introduced.

Rider drafts support English and four presentation channels. A model may select and arrange sentences derived from the selected event; it cannot supply a new cause, recovery time, alternative route, or numeric claim. The channel changes presentation, not verified facts. Every output remains a human-review draft and is never published automatically. No agency communications team has approved these drafts.

## What was left out

No trained anomaly detector, causal attribution, historical reliability study, demand model, multilingual generation, dispatch/holding optimizer, arbitrary external plugin loading, vector search, or persistent realtime warehouse was added. The headway-control integration remains unavailable. The prototype was not compared experimentally with TransitGPT or tested by an independent group of agency staff.

This document was drafted by Codex to record the actual implementation choices. It is not presented as unaided human writing.
