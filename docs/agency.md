# Use VIGO Agency

VIGO Agency brings the selected City's timetable, live reports and saved investigations into one workspace. Its everyday views are **Overview**, **Routes** and **Ask**. Route, Matrix and Reach use the existing routing platform.

## See what needs attention

Open **Overview** for reporting coverage, route comparisons and the network briefing. A scheduled departure, a feed prediction and an observed vehicle location are different evidence. Missing reports remain unknown. Overnight service is assessed against the timetable's active service window, not daytime expectations.

With a connected model, the briefing can interpret the pattern, propose an explanation and suggest a next check. Hypotheses are not confirmed incidents. The briefing checks extracted route-condition claims against computed evidence and performs a model review, but neither guarantees that all prose is correct. A computed fallback is labeled separately. The timestamp and coverage tell you which observation the briefing describes; the refresh setting is separate from feed polling.

## Inspect a route or station

Open **Routes**, choose a route, then use the map or bidirectional line diagram. Select a stop to see its arrivals board, with scheduled and predicted times kept separate. Expand the timetable for directions and patterns. **All routes** returns to the catalog.

The route and station selection are shared with Ask. “Here” can refer to that station; a named route or vehicle keeps its own identity. Selecting a route does not select a particular bus. Saved answers retain the selection and evidence from the original question.

## Ask a complete question

Use a location, route or vehicle number when it matters. For example:

- “What needs attention across the network?”
- “Compare these two routes' gaps and reporting coverage.”
- “How has vehicle [number]'s predicted delay changed?”
- “When is the next departure from [station], for each route?”
- “Draft an apologetic rider update using the confirmed facts.”

Ask chooses reusable checks, can correct scope or request a missing check, and keeps the evidence with the answer. Its assessment forms preserve computed values. Network interpretation and general replies use the model. Activity and sources are inspectable; private model reasoning is not displayed. **History** reopens saved conversations. An old answer remains an old observation even when the feeds have advanced.

## Connect a model and web search

In Ask's connection settings, choose a provider, enter its API base URL, choose or discover a model, and connect. The connection test checks function calling, not answer quality. Local models can use a keyless endpoint if their server permits it. API keys stay in server memory for the app session.

Web search is configured separately. Connecting an LLM does not grant online search. Network-capable tools may contact their configured services, and model requests include the question, supplied conversation context and selected tool results. Consult the answer's **Model & data** record for captured endpoint and tool activity. A localhost URL does not prove inference hosting, retention or downstream forwarding.

## What this app does not establish

Predicted spacing is not measured headway; retained forecast changes are not actual vehicle progression. Reporting coverage is not service health. Ask has no connected crew roster, maintenance clearance, passenger-demand model or live intervention simulator. It can discuss conditional options and draft rider text; it does not authorize dispatch or publish messages.

See [implementation and measured answer quality](ASK-CHECKED-ASSESSMENTS.md) for the checks and their remaining failures. The [operations ledger](agency-operations.md) and [synthetic replay](operational-replay.md) are research APIs, not hidden everyday workspace panels.
