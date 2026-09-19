# Network, Routes, and Ask

Open **Network** in VIGO Studio to inspect the selected City's timetable, live reports, and saved investigations. The workspace has **Network**, **Routes**, and **Ask** tabs. Use the separate **Route** view for journey planning and **Analyze** for Reach; Matrix is available through the CLI and Python.

## See what needs attention

Open **Network** for reporting coverage, route comparisons and the network briefing. A scheduled departure, a feed prediction and an observed vehicle location are different evidence. Missing reports remain unknown. Overnight service is assessed against the timetable's active service window, not daytime expectations.

With a connected model, the briefing can interpret the pattern, propose an explanation and suggest a next check. Hypotheses are not confirmed incidents. The briefing checks extracted route-condition claims against computed evidence and performs a model review, but neither guarantees that all prose is correct. A computed fallback is labeled separately. The timestamp and coverage tell you which observation the briefing describes; the refresh setting is separate from feed polling.

## Inspect a route or station

Open **Routes** and choose a route to see **Trip times**. Select a trip and service date to compare its scheduled and predicted arrivals or departures. **Stops** opens directions and patterns; **Updates** opens service evidence. The map and **Line view** show the same selected route. Select a stop to see its arrivals board. **All routes** returns to the catalog. Actual stop-event times are unavailable in the current prediction source.

The route and station selection are shared with Ask. “Here” can refer to that station; a named route or vehicle keeps its own identity. Selecting a route does not select a particular bus. Saved answers retain the selection and evidence from the original question.

Trips reported as added service appear in the trip selector and line view even when absent from the static timetable. Their display contains only reported stops and absolute predictions; scheduled times and delay comparisons are unavailable. This display support does not make added trips available to the routing engine. See [vehicle timing](ROUTE-LINE.md) and [realtime routing limits](known-routing-limitations.md#realtime).

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

The [operations ledger](agency-operations.md) and [synthetic replay](operational-replay.md) are research APIs, not hidden everyday workspace panels.
