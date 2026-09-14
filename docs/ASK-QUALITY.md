# Ask: query composition and local inference

September 13, 2026. This is an implementation and verification note, written with AI assistance. The three protected project documents are unchanged.

## What changed

A worker should be able to ask “get me there by four, with at most one transfer,” then change the deadline without restating the trip. The model interprets that request; the existing VIGO tools resolve the places and calculate the journey. This pass adds named endpoints, arrival deadlines, ordered intermediate stops, transfer limits, and comparisons of named routes to those tools. It does not add another routing engine.

The design follows the useful part of [NGRP](https://github.com/hytangs/NGRP): retain the user's constraints, resolve real entities, calculate with specialized tools, and carry the original request into replanning. The inspected local sources were `workflow_form.py` and `workflow_runtime.py`. This is not an integration of NGRP's activity scheduler or its synthetic opportunity provider. Business hours, activity duration, prices, capacity and accessibility require verified data before they can become routing constraints.

| Request | Implemented behavior |
| --- | --- |
| Walk between named stations or addresses | Resolve names inside the tool, then use the saved pedestrian network. Return distance, estimated time and geometry. |
| Arrive by a deadline | Pass the exact service date and arrival clock to VIGO's arrival search. |
| Limit transfers | Preserve the limit, including zero, in the routing request. |
| Visit intermediate places | Preserve the supplied order. Travel is calculated; time spent at activities is not. |
| Change a previous journey | Include the latest successful routing inputs in the conversation, alongside dated answers and staff notes. Recompute the changed request. |
| Compare named routes now | Resolve each name against the loaded City and inspect the same operational snapshot. |
| Ambiguous place or unsupported combination | Return candidates or the precise unsupported requirement. Do not silently choose another endpoint or remove a constraint. |

The native engine currently cannot combine intermediate stops with a whole-journey transfer limit. Ask reports that limitation. Unknown arguments are rejected by the existing tool validation. Tests use City X fixtures; Boston is the live verification dataset, not an application rule.

## Less work for the model

`journeyInputs.mjs` supplies one endpoint resolver to Route, walking and Reach. Independent lookups run together. The model can submit a named journey in one tool call instead of spending several rounds copying identifiers or coordinates. Independent read tools also run concurrently; communication drafting and place-search batches that may populate the routing cache retain sequential execution. Results and source numbers retain request order.

The model receives a compact projection while the notebook retains the full tool result. Journey clocks are formatted as HH:MM before inference. Interval differences, delay minutes and walking distance unit conversions are computed in code. Alert route and stop associations remain attached to the alert, separate from the stop used to measure a departure interval. These changes address observed errors in clock conversion, arithmetic and location association. They do not certify every model-written sentence.

Ask records model-call count, elapsed model time, elapsed tool-batch time, total time, and provider token usage when supplied. Missing usage stays unknown. Activity text describes the current task. The existing journey card shows the engine's departure and arrival clocks; no new dashboard or technical output panel was added.

## Local and private models

OpenAI-compatible endpoints remain supported. The Ollama option uses its [native chat API](https://docs.ollama.com/api/chat), which accepts a per-request context window. The installed model had been serving 4,096 tokens: larger tool responses could displace useful context. The Ollama preset now requests 8,192 tokens and turns optional reasoning off for faster calls. Both settings are configurable in the existing connection form. More context uses more memory; selecting a larger number does not establish that a model can use it effectively. See [Ollama's context documentation](https://docs.ollama.com/context-length).

For a server configured through environment variables:

```sh
VIGO_AGENCY_LLM_BASE_URL=http://localhost:11434
VIGO_AGENCY_LLM_PROTOCOL=ollama
VIGO_AGENCY_LLM_CONTEXT_TOKENS=8192
VIGO_AGENCY_LLM_MODEL='your-installed-model'
VIGO_AGENCY_LLM_REASONING_EFFORT=none
```

The default protocol is `openai`; existing compatible-provider deployments keep that behavior. UI connections remain session-scoped. Keys stay in server memory, and an investigation remains bound to its selected provider. Private reasoning is excluded from saved answers. Online place lookup is a separate configurable service: local LLM inference alone does not make public Photon requests private. A privately hosted Photon endpoint or disabled search remains available through `VIGO_AGENCY_PLACE_SEARCH_URL`.

## Verification and limits

The local diagnostic used macOS 26.5.1, Apple M2, 16 GiB memory, the existing Ollama `qwen3.5:4b` model, temperature 0 and reasoning disabled. No model weights were installed or changed. The question was “How far is the walk from Back Bay station to Copley station?” The agent timer included model calls and HTTP tool calls; each configuration ran three times in sequence. The initial invocation was not a controlled cold start. Repeated invocations benefit from serving and application caches. This is one diagnostic workload, not a general performance benchmark.

| Configuration | Initial invocation | Repeat 1 | Repeat 2 | LLM calls per answer |
| --- | ---: | ---: | ---: | ---: |
| baseline · openai · 4,096 context | 41.89 s | 25.44 s | 25.50 s | 4 |
| revised · ollama · 8,192 context | 6.05 s | 7.18 s | 7.99 s | 2 |

[Retained measurements and tool arguments](evidence/agency-query-timing.json).

The earlier implementation failed literal station lookups, searched online, then selected North Station as the destination. The revised tool resolved `place-bbsta` to `place-coecl` and returned 357.43 m, about 4.47 minutes at the configured walking speed of 4.8 km/h. Endpoint connections and geometry remain in the original tool output. Walking time is an estimate from the saved street graph, not a current sidewalk or entrance-access measurement.

Live arrival and follow-up checks retained Back Bay, Harvard, the requested service date and a maximum of one transfer. The 16:00 deadline produced 15:38–15:57; the 17:00 follow-up produced 16:38–16:58. These are retained results for September 13, not promises about future service. Browser checks confirmed the journey cards and follow-up navigation.

Intermediate tests exposed model errors even with correct tool results: an alert was associated with the wrong route, a vehicle ID was called a trip ID, old minute figures were copied into a follow-up answer, and a correct metric distance was given an incorrect conversion to yards. Affected development notebook entries were annotated. The final model summary attaches written units to each distance; all three subsequent responses used consistent metric and imperial values. The final projection removes raw clock arithmetic and retains semantic associations; regression fixtures verify those data boundaries. A small model can still misinterpret evidence, omit citations, or overstate operational implications. The full evidence and computed journey stay available for inspection. No superiority claim over [TransitGPT](https://github.com/UTEL-UIUC/TransitGPT) follows from these checks; its [published research](https://arxiv.org/abs/2412.06831) is a useful comparison for broader evaluation, not a benchmark run performed here.

Automated checks: the full Agency fixture suite, TypeScript, existing UI/routing normalization checks, production build, desktop packaging and packaged-runtime checks. New fixtures cover ambiguous endpoints, ordered stops, exact arrival clocks, zero transfers, rejected combinations, scoped comparisons, alert-location associations, concurrent execution, request memory and native Ollama message conversion. No dependency was added.

## Rider communication and public sources

Ask now treats drafting as writing from evidence, independently of publication. A missing cause does not block an apologetic message, and accepting an earlier offer should produce the draft. The latest successful operational scope and a compact, dated result travel with the conversation, alongside journey inputs. Current-turn instructions state which checks actually ran; old assistant claims do not establish that a search happened. Revisions can use the existing text without another data or model-planning stage.

`draft_rider_message` accepts a route scope as well as an event ID. If an event has expired, a supplied route scope produces a starting draft from the current observation. The starting template no longer makes a nested model request merely to select sentences. The main model can write and revise directly. Agency alert descriptions, cause/effect fields, active periods and public links are retained for it, with literal text filtering and paging through additional alerts. A related alert alone does not prove the cause of a delay.

Public-page reading, reference lookup and broader search have separate coverage. Wikipedia reference lookup is available without a key by default; it identifies named subjects but is not a news or resale-market index. In **Ask → Edit AI connection → Web sources**, connect [Brave Search](https://api-dashboard.search.brave.com/api-reference/web/search/get) with a search API key, or a private [SearXNG endpoint](https://docs.searxng.org/dev/search_api.html). SearXNG must enable JSON results. The connection check sends the query `public transit`; later searches send only their explicit query. Keys stay in server memory, do not enter model context, and are not carried to a different endpoint. No broader web search provider was configured on this workstation during verification; no paid search or incident cause was claimed as verified from a live search API. Selecting Off disables both reference lookup and broader search.

Environment configuration is also supported:

- `VIGO_AGENCY_WEB_SEARCH_PROVIDER`: `wikipedia` (default), `brave`, `searxng`, or `off`.
- `VIGO_AGENCY_WEB_SEARCH_URL`: the SearXNG search endpoint. Supplying it selects SearXNG when no provider is set.
- `VIGO_AGENCY_WEB_SEARCH_KEY`: the search key; selects Brave when no endpoint or provider is set.
- `VIGO_AGENCY_WEB_READ=off`: disables public-page reading. Otherwise it is available without a search key.

Page reads use the existing DNS-pinned HTTP transport, with public-address checks on every redirect, a 20-second request deadline and a 512 KB response limit. They read HTML/text without executing scripts or logging into websites. Search results are capped at five and cached for one minute. Retrieved text remains evidence, not instructions; retrieval time is distinct from the incident or publication date. A blocked page or failed search is reported as such and does not prevent a draft using known facts.

Regression fixtures cover full alert explanations, expired-event recovery, operational memory across revisions, failed search, separate credentials, cancellation, response limits and redirects to private addresses. Local Qwen checks replayed the earlier refusal followed by “Yes. Generate that draft,” a shorter revision, and a fixture with an explicit construction cause. [Retained diagnostic replies](evidence/agency-rider-dialogue.json) are examples, not a model-quality benchmark. Browser checks covered Route 1, the search controls and saved follow-ups; a public GTFS reference page was read through the new transport.

The local 4B model can still add unsupported boilerplate or overgeneralize observations. Development checks exposed invented wait estimates, false claims of online searching and an unsupported recovery promise; those saved development replies were annotated, and response instructions now explicitly separate executed checks, predicted intervals, individual arrivals and agency commitments. The evidence tools enforce their own data boundaries; free-form model text still requires review before publication. This work does not establish GPT-level equivalence or authorize broadcasting.

## General knowledge and correcting an interpretation

The local City is optional context for local questions. Ask should recognize a complete name before trying to resolve it as a stop, business or neighborhood. Its conversation policy is now separate from the tool loop in `queryPrompt.mjs`. The policy distinguishes stable knowledge, checked facts, public research and exact journey calculations. A challenge to a previous reply calls for revisiting the user's original wording, rather than repeating the assistant's interpretation. No brand, City or collectible answer is embedded in production code.

The linked [AdbGPT paper](https://arxiv.org/abs/2306.01987) and its [implementation](https://github.com/sidongfeng/AdbGPT) concern Android bug replay. The useful connection here is explicit entity interpretation before action, supported by current observations and feedback. This is an application of that principle, not a reproduction of their method or results. Private model reasoning is neither shown nor retained.

The [MediaWiki search API](https://www.mediawiki.org/wiki/API:Search) provides the public reference lookup. The tool accepts a subject name; broader search accepts a query. This distinction matters: adding every requested attribute to an encyclopedia search can hide the page that identifies the subject. Wikipedia supplies reference leads, while authoritative sources and current market evidence are still needed for claims beyond those references. [KLM's own collection page](https://www.klm.nl/en/information/travel-class-extra-options/houses) confirms the Delft Blue miniatures are passenger gifts based on real Dutch buildings; it does not establish a rarity ranking.

## Business lookup and arrival deadlines

The Si Cara investigation exposed a geographic error before any language-model interpretation: internal GTFS pathway nodes with `(0, 0)` coordinates expanded the search bounds across the Atlantic. Search bounds now use declared stops and stations (`location_type` 0 or 1). This follows GTFS semantics rather than discarding every zero coordinate. A fixture includes a pathway node and verifies the resulting bounds.

An empty Photon response is a missing map-index match, not evidence that a business does not exist. The tool explains this limit and directs an address lookup through an available public source. Ask can read source pages and their links; the reader uses the publisher's `<main>` region when present so navigation text does not crowd out the actual listing. Resolved coordinate endpoints can retain their supplied names in journey cards. There is no City-specific business directory or hardcoded restaurant answer.

The [Cambridge tourism listing](https://cambridgeusa.org/listings/si-cara/) identifies Si Cara at 425 Massachusetts Avenue and publishes its map location. [MIT's Site 4 page](https://site4.mit.edu/about-site-4/) gives 45 Hayward Street, Building E37. Photon resolved the latter address. A replay using these verified locations and `arriveBy: 18:00` produced a 17:48 departure, a 17:50 Kendall/MIT–Central train and arrival around 17:58 on September 13, 2026. The engine reported scheduled fallback, with no applied live prediction overlay. [Retained endpoint and journey evidence](evidence/agency-place-resolution.json) distinguishes this manually sourced replay from autonomous search. The map directories tested did not resolve Si Cara by business name; full web discovery still needs a connected broader search provider.

Longer local inference requests can set `VIGO_AGENCY_LLM_TIMEOUT_MS` (1,000–300,000 ms; default 45,000). This controls the server deadline, independently of model selection and context size. Cancellation remains available. Changing the timeout does not establish answer quality.

## Local model and server follow-up

The prototype now selects Ollama `qwen3.5:4b`, 8,192 context tokens, thinking disabled, temperature 0.6, and a 120-second deadline per model call. The workstation is an Apple M2 with 16 GiB of memory. The user set a roughly 6B maximum; the [installed 4B-tagged model](https://ollama.com/library/qwen3.5:4b) reports 4.66B parameters. The 9B, 14B and 20B downloads were unloaded and removed at the user's request. Earlier diagnostics below retain their original configurations and are not benchmarks of the selected model. The provider remains configurable; no model name is an application default. Set `VIGO_AGENCY_LLM_MODEL`, `VIGO_AGENCY_LLM_CONTEXT_TOKENS`, `VIGO_AGENCY_LLM_REASONING_EFFORT=none`, `VIGO_AGENCY_LLM_TEMPERATURE`, and `VIGO_AGENCY_LLM_TIMEOUT_MS` for a later server launch. Thinking remains adjustable in AI settings.

The 14B reasoning check recognized the complete KLM collection name and retrieved it. Its suggestion that irregular issue dates imply rarity remains unsupported. Separate non-reasoning checks produced and shortened an apologetic rider draft; the initial reply also offered an unavailable publication action. These are improvements on the reported failures, not a general accuracy guarantee. [Retained replies, settings and limitations](evidence/agency-model-checks.json) distinguish these runs.

Stable instructions now precede changing observations and conversation metadata. Execution status is appended to the newest tool result, keeping earlier source text eligible for prefix reuse. The policy was shortened from 7,025 to 4,354 characters while retaining the entity, evidence, journey, drafting and privacy rules. A compact tool index now lets the model request specific specialist schemas. Public research remains directly available, and tools used in saved follow-up context remain loaded. The initial tool definitions with the configured reference provider shrink from 11,795 to 2,515 characters; loaded tools retain their complete validated schemas. Tool preparation is not counted as a data check or citation. These changes have not been isolated in a latency benchmark. Ollama logged full prompt reprocessing for the hybrid model, so ordering alone does not establish actual cache reuse. The page reader retains a separate footer because MIT's published Site 4 address is there. The HTTP transport can try every DNS address already checked as public, without relaxing redirect or address checks.

Profiling the live API also found synchronous timetable queries delaying unrelated searches. Interval lookup now reads the existing covering index and obtains route/direction from the loaded GTFS trips. It adds no index and leaves the routing store read-only. Three sequential replays of one fixed observation took 2.91/2.89/1.83 seconds before and 1.69/1.41/1.31 seconds after; all derived output was deeply equal, including 2,258 events. These timings exclude context creation and remote fetches, and did not flush caches. Afterward, a live Site 4 address lookup completed in 1.21 seconds while feeds were fresh. This diagnoses a server bottleneck; it does not guarantee external search availability.


## Runtime facts and privacy statements

Ask captures the model connection and enabled network tools at the start of each answer. The server saves these facts with the answer. Deployment details are obtained through the runtime action rather than being included as ordinary chat context. A compact **Runtime & data · server record** disclosure renders the stored facts directly, independently of generated prose. For a question solely about runtime/privacy, the model is instructed to select `runtime_status`; VIGO then renders a factual answer directly, with no second model paraphrase. Preparing transit tools remains separate from this directly available action. Changing the model later does not rewrite old records.

The record reports the configured model identifier, endpoint host/port, HTTP or HTTPS transport, and whether the URL uses a loopback address. A loopback connection is not evidence of local inference: a proxy or model server may forward requests. Inference hosting, downstream forwarding, retention, training use and security remain unverified. The model is instructed to explain these limits instead of claiming that everything stays local or secure. The initial 4B privacy test still inferred local execution despite being given the contrary limit. That failure motivated the direct runtime response. Free-form answers to mixed questions still require review; the server record is the authority.

Enabled tools and attempted calls are distinct. Reference lookup, public-page reading and place search may access a network; journey tools can also invoke the place resolver. Failed calls remain recorded. These records do not prove that an HTTP request occurred, since a cache hit or input validation can avoid one. Background feed refresh and other application traffic are outside the answer record. No request arguments, provider keys, URL paths or query strings are copied into the runtime panel. The question, supplied conversation context and tool results do go to the configured model endpoint.

Regression checks cover immutable request metadata, local/remote endpoint configuration without hosting claims, credential redaction, enabled versus attempted tools, failed calls and notebook persistence. Existing notes without a runtime snapshot are not retroactively assigned the current configuration.

The final 4B runtime replay selected `runtime_status` in one model call (15 output tokens) and returned the server-rendered facts in 15.59 seconds. This is one warm-session diagnostic, not a general speed benchmark. A separate collection question recognized and retrieved the KLM subject but reached the client deadline before a final answer. Reducing model size and prompt overhead does not establish general answer reliability.
