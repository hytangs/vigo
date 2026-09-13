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
