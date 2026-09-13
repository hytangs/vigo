# Agency architecture audit

September 13, 2026. Scope: a small cleanup after the initial delivery. The three protected project documents were not edited.

## Decision

Use one **City-owned operational context**, with separate timetable, observation, and notebook lifecycles. Live, Ask, research methods, and rider drafts should consume that context through the same typed tools. Routing and future specialized models belong behind those tools. A shared context does not mean copying every record into an LLM prompt or treating an old note as a current observation.

The existing service already takes one observation for an investigation and shares the timetable identity rules across its tools. That is worth retaining. The gaps were narrower: the notebook was absent from tool access, staff annotations were absent from follow-up context, output formatting lived inside the planner, and the visible activity trail still exposed raw response objects.

## Changes made

- Added `recall_notebook` to the existing tool registry. It searches literal text in questions, answers, and staff notes, or retrieves an exact entry. Results contain at most five dated excerpts, with a link back to each original. Retrieval uses the selected City's notebook and does not poll feeds or invoke another model.
- Included bounded staff annotations in follow-up context, labeled separately from operational evidence. Retrieval retains source timestamps; it cannot turn a saved result into a fresh measurement.
- Separated factual answer wording from the planner, activity rendering from answer rendering, and browser downloads from the notebook component. No new dependency or service was added.
- Replaced expandable JSON in the activity panel with check names, completion status, and readable failures. The complete technical record remains downloadable. Summary citations now show only cited sources. Research methods that return journeys or Reach results can display those outputs without an empty evidence table hiding them.
- Fixed failed stop lookups crashing result projection. Failed checks now return to the planner and remain in the saved record.
- Bound inference to the provider selected when an investigation starts. Changing or disconnecting that connection stops subsequent model calls in that investigation; its context cannot silently move to another endpoint. Tool source-URL fields are omitted from model messages because feed URLs can carry credentials. Original references remain in the local evidence record.

## Choosing the right source

| Need | Smallest sufficient action |
| --- | --- |
| View a result already saved | Open the original directly; no model call. |
| Find earlier work or a staff annotation | Retrieve dated notebook excerpts, then open or cite the original. |
| Establish City scope, identities, or calendar | Use indexed context and exact lookup. Preserve ambiguity. |
| Ask what is happening now | Use the shared observation and its independent feed clocks. Recheck current evidence rather than repeating a saved answer. |
| Calculate supply, a journey, or accessibility | Invoke the typed supply, Route, or Reach tool. The specialized implementation computes the result. |
| Ask a timetable question outside those tools | Use bounded read-only SQL with explicit service-date rules. |
| Request an unavailable model or unsupported data | State the missing capability or evidence; keep any completed checks. |

Ask's model chooses among these tools. The application supplies scope and limits; it does not route questions using a keyword classifier. Operational numbers come from tool results. This remains a bounded assistant, not an arbitrary code-execution environment.

## Messy data and transfer between agencies

GTFS identifiers need source scope, service date, timezone, and exact stop sequence. Agency names and coordinates are useful for display and lookup, but do not establish a reliable identity crosswalk. Missing reports, unmatched trips, and invalid calendar coverage remain visible. The native connection index is a derived timetable representation; it is not a lossless copy of every original `stop_times` row.

For non-standard incident logs or agency spreadsheets, retain the original text and source record, then attach explicit mapped fields such as affected route, stop, event time, units, and author-provided interpretation. Keep unresolved mappings and the distinction between observed, predicted, and annotated information. This audit does not add a generic importer or claim to implement an incident-extraction model. A future adapter needs examples from the actual agency schema and tests of its mappings. Staff notes are the current small extension point.

## Research and implementation patterns reviewed

| Primary source | What it contributes to this decision |
| --- | --- |
| Noursalehi, Koutsopoulos & Zhao, [textual data and transit disruption management](https://bpb-us-e1.wpmucdn.com/sites.mit.edu/dist/8/1640/files/2020/11/IEEE_Text_Mining.pdf), 2020 | JTL's study analyzes 23,728 London Underground incident records and identifies information lost when raw reports are reduced to standard forms. The application here is to preserve staff text alongside structured evidence. Its extraction models are not reproduced or claimed as part of Agency. |
| Noursalehi, Koutsopoulos & Zhao, [predictive decision support](https://mobility.mit.edu/biblio/noursalehi-predictive-decision-support-platform-and-its-application-crowding/), 2021 | Connects operations control and passenger information through a common predictive platform. This supports a shared context with specialized models. Agency has no passenger-demand or crowding model and makes no crowding claim. |
| Devunuri & Lehe, [TransitGPT paper](https://arxiv.org/abs/2412.06831) and [implementation](https://github.com/UTEL-UIUC/TransitGPT) | Demonstrates natural-language GTFS analysis, code execution, and visual output. Agency retains its existing native computations and bounded SQL. No comparative accuracy claim follows from this review. |
| [OpenTripPlanner architecture](https://github.com/opentripplanner/OpenTripPlanner/blob/dev-2.x/ARCHITECTURE.md) | Separates use-case services, maintained domain models, and routing adapters. This supports keeping the routing engine independent while sharing its results across agency functions. |
| [MobilityData GTFS validator](https://github.com/MobilityData/gtfs-validator) | Offers explicit standards checks and readable validation notices. It is a useful upstream diagnostic; an LLM should not silently repair malformed identities or reinterpret missing data. No new validator runtime was installed. |
| Lewis et al., [retrieval-augmented generation](https://arxiv.org/abs/2005.11401), 2020; Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 2024 | Separate retrievable knowledge from model parameters and favor composable workflows. For this small notebook, bounded literal retrieval is sufficient to test usefulness without adding embeddings, a vector database, or a second agent. |
| [Ollama FAQ](https://docs.ollama.com/faq), [vLLM serving documentation](https://docs.vllm.ai/en/latest/serving/online_serving/) | Support local or self-hosted model serving through an API boundary. Protocol compatibility still requires testing function calling with the selected model. |

These are architectural inferences from the cited work, not claims that its empirical findings have been replicated here.

## Privacy and validation

Agency uses the configured server endpoint and has no automatic cloud fallback. Local inference was checked with the existing Qwen3.5 4B model. For deployments that require local-only Ollama, its documented `OLLAMA_NO_CLOUD=1` setting disables cloud features; this audit did not change the user's Ollama installation. A privately hosted endpoint still needs agency-managed TLS, access control, and logging policy. Local inference alone does not make the entire map-and-live-feed application offline, nor does it encrypt the notebook.

Regression checks cover retrieval after restart, City isolation, literal search, excerpt limits, source preservation, failed lookups, and provider changes during an investigation. The existing Agency checks, type checking, CSS checks, build, and browser interaction checks are used to verify the changed path. In the actual local-model check, Ask found the retained service profile and its staff note; Open original restored the chart, evidence, and conversation. The [browser capture](images/agency-recall.png) records the result. The original VIGO checkout and native routing core remain unchanged.

## Follow-up: interrupted investigations

The second pass reproduced two failures: a later skill step could throw away earlier completed results, and a model response containing a null tool call could crash Ask. Skills now retain completed checks and the failed step, stop the remaining steps, and save a clearly marked incomplete study. Cancellation also preserves evidence when it happens during summary generation. Ask validates the structure of a model's tool-call batch before execution and checks cancellation between calls. Both paths use the same small failure-result function.

The interface directs a stopped investigation to Saved work and restores a stopped Ask question for retry. A browser check ran the actual Boston network briefing, stopped it during summarization, and reopened all three completed checks and their evidence table. A stopped summary uses the existing deterministic fallback; it does not promote the last alert to a network assessment. Fixture checks cover later-step failures, returned failures, cancellation before execution, between steps, and during summarization, plus malformed and duplicate model calls.

This change follows the tool-response pattern in Anthropic's [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): communicate useful failures and preserve relevant context. The source does not establish reliability for this application; the reproductions and regression checks do. Re-reading [OpenTripPlanner's architecture](https://github.com/opentripplanner/OpenTripPlanner/blob/dev-2.x/ARCHITECTURE.md) also supports keeping workflow handling outside the routing engine. No dependencies, inference framework, or additional data store were introduced.

Retention here covers handled failures and cancellation. It does not checkpoint an investigation after every step or promise recovery from a process crash. A deployment with concurrent timetable replacement or heavy multi-City use would also need explicit active-session lifecycle tests; this small single-user audit does not certify those cases.

## Service briefing and route comparisons

The route table now shows the longest supported predicted gap beside the scheduled gap for those same two trips. The reference stop is retained, and missing intermediate reports produce no comparison. “Trip reports” distinguishes that count from vehicles. Live delay findings use the same configured time window as departure comparisons.

The briefing leads with service findings rather than repeating feed counts and healthy timestamps already visible on the page. Its interval tool sorts by the arithmetic increase over schedule before selecting one comparison per route; the model selects up to two distinct findings. Displayed numbers and source statements still come from tool evidence. Coverage has a separate short note, and the saved investigation retains citations. This is an AI-assisted selection of checked findings, not unrestricted model-written operational advice. Fixture tests distinguish a long scheduled gap from a larger departure change, and cover missing reports, future departures, citations, and fallback behavior.

## Conversation and tool use

Ask previously discarded every model-written response and always substituted a tool-result template. With no tool calls, even “Hello” became a failed investigation. Ask now keeps the public model response: the same agent can answer from general knowledge or conversation, ask for clarification, retrieve saved work, or invoke transit tools. There is no keyword router or list of canned replies. Tools remain bounded, and a final response is allowed after the tool budget is used.

Model-written explanations and the original computed evidence are separate. Tool responses carry numbered source references, retain their original values and timestamps, and supply the evidence panels. The model is instructed to cite operational claims, distinguish suggestions from observations, and recheck current conditions; this is grounding guidance, not a guarantee that every sentence is correct. Briefings and installed deterministic workflows retain their existing evidence-based outputs. Provider failure still leaves completed evidence readable through the deterministic fallback.

Public replies and follow-ups use the existing City notebook. Provider reasoning fields and marked reasoning blocks are excluded. A successful conversation without tools has no empty check counter or source drawer. Regression fixtures cover direct replies, clarification, conversation reuse, tool explanations, empty responses, final synthesis at the tool limit, cancellation, and retained source data.

Local inference checks exposed a serving limit: the installed model was running with a 4,096-token context window. Ask now projects compact route measurements and a bounded number of event records, including their IDs and total counts, instead of passing large per-trip comparison records into the model. The full tool results remain in the notebook. Empty alert results explicitly retain their route scope and explain that no alert does not imply normal service. The optional server variable `VIGO_AGENCY_LLM_TEMPERATURE` allows deployments to set sampling temperature; it is omitted from requests when unset. Local verification used the existing model with temperature 0, without installing or changing model weights.
