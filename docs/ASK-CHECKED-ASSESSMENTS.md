# Checked operational answers and model-written network briefings

This follow-up addresses the 22 failed cases in the [September 15 audit](ASK-AUDIT-2026-09-15.md). The original audit remains intact. The implementation separates selecting a useful investigation, computing service facts, and writing an interpretation. It does not add a dispatch simulator or infer missing crew, maintenance or passenger data.

## Ask

`assess_service` gives the model one operational entry point. It selects named routes, stops, vehicles or trips and up to five checks, normally one to three: conditions, spacing, causes, retained history, occupancy, coverage, outlook, interventions, resources, rider impact, alert coverage, communications, alternatives or data quality. The implementation reuses the existing service inspection and network diagnosis; repeated reads share the same observation within an assessment.

Names must come from the question or a resolved entity. Referring to a selected route or station requires a phrase actually present in the question. A failed selection gets one focused correction attempt. Separate assessment calls retain both sets of results and their sources. The final composition form arranges completed checks and can request one additional inspection or correct the target scope; it cannot change numerical values. A scope correction replaces the previous answer evidence while retaining the earlier call in the activity record. Historical-period and future-period qualifications stay ahead of the results.

Free-form replies get a short model inspection, including replies after a tool result. It may accept a general answer, correct an unsupported capability promise, or request an operational check. This is another model decision, not a guarantee of comprehension. It adds a model call to these replies; computed assessments, complete station boards and journeys keep their direct rendering.

The checks distinguish scheduled exposure from a forecast, occupancy categories from demand, and vehicle reports from available fleet. A maintenance question still needs actual fault and assignment records. A spare-bus allocation still needs a feasible intervention comparison. The app must say what is missing rather than invent the result.

Vehicle prediction history is also available through `service_timing` with `view=prediction_history`. It delegates to the same retained-history check instead of asking the model to infer changes from terminal departures. When the model marks that result complete, it renders directly without another generation. A vehicle with neither a matched report nor a fresh location is identified as unresolved; this does not imply that it is out of service. Cancellation reports remain reports even when they contain no location or departure prediction.

## Network State

The network briefing now has a genuinely model-written path:

1. Calculate coverage, route conditions, departure spacing and shared stop connections.
2. Let the model choose a bounded investigation and candidate explanations; inspect notices, progression and related evidence.
3. Let the model write its own operational interpretation from those results.
4. Ask the reviewer to select source sentence IDs and classify their route-condition assertions. Reconstruct quotations from the original text, then check the extracted predicates against computed route totals, cancellations and departure pairs, alongside the model's paragraph review.
5. Allow one revision. Retain paragraphs accepted by these checks and preserve exclusions in the record. A surviving observation is required; hypotheses or proposed actions alone cannot become the network overview.

The model can decide what matters, propose a qualified causal explanation and identify the next useful check. It is not limited to selecting prewritten sentences. The numerical diagnosis remains independently available. If no usable model interpretation survives, the app shows a **computed snapshot**, explicitly without the AI briefing label. Old cached results that merely attached an AI label to a fixed narrative are refreshed.

Claim extraction and paragraph review use the same configured model as the writer. The computed checks can reject a contradictory assertion even when that reviewer approves it. They distinguish reported cancellations from lateness, possible waiting from measured rider waits, and agreement among reporting trips from normal service across a route. The model can still omit or misclassify a claim; the checks do not establish completeness of the extraction. The paragraph review is performed by the same configured model. During development it both missed overclaims and rejected supported claims. It is not independent operational validation. A published hypothesis is still a hypothesis; the presence of a source reference does not establish causation. The retained replay record and regression fixtures are the evidence for this change, not a claim of expert performance on arbitrary networks.

The existing briefing refresh schedule is unchanged. Additional model work runs in the briefing workflow, not the routing or Reach engines. The UI shows the configured model beside an actual AI briefing and keeps coverage and investigation details expandable.

## Provider behavior

For Alibaba Model Studio endpoints, reasoning control uses `enable_thinking`. Mandatory named forms use JSON output and local validation; ordinary tool selection retains native function calling. Applying a JSON action envelope to every call was tested and rejected after it regressed general GTFS and follow-up answers. The local Ollama action form can restore unambiguously flattened tool fields; conflicting values and unknown fields still fail validation. This repairs response structure without guessing route identity or changing tool meaning.

Network writing may use bounded thinking on that provider. The review uses a required structured form with thinking off, separately from the prose writer. The app does not change the saved connection setting. Other providers retain their configured reasoning mode. No model was downloaded or replaced.

Alibaba documents [function calling](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling), [structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) and [thinking controls](https://www.alibabacloud.com/help/en/model-studio/deep-thinking). JSON output constrains syntax, not factual correctness or compliance with every schema field. The server continues to validate arguments before executing tools.

## Evidence and limits

The actual-provider replay uses the same seven-route synthetic fixture and the same 60 questions as the earlier audit, including conversational follow-ups. It deliberately has no passenger counts, fleet readiness, crew assignments, historical incident outcomes or live intervention simulation. It is not live Boston validation, a routing benchmark, or a comparison against another product.

The [follow-up record](evidence/ask-checked-assessments.json) retains answers, selected checks, timing, expected outcomes and case-level review. The coding assistant performed the review. Results must be read at question level: preventing a fabricated answer can still leave an incomplete or unhelpful answer. That earlier result consists of one complete 60-question replay and one subsequent retest of case 22 after correcting the review form's handling of unused null fields. Both versions of that case are retained. Development retries are listed separately and excluded from the score.

| Review | Original audit | Follow-up |
| --- | ---: | ---: |
| Acceptable | 23 | 36 |
| Partial | 15 | 20 |
| Failed | 22 | 4 |

Of the original 22 failures, 13 are now acceptable, seven remain partial and two still fail. Cases 23 and 114 are new failures compared with the original audit. This is progress on the fixture, not complete resolution or a stable accuracy estimate. Failures in that run involved selected-location scope (9), an unidentified bus in a short-turn question (17), a vehicle-specific maintenance question (23), and selecting terminal timing instead of retained prediction history (114). Historical-period checks currently qualify retained current observations; they do not implement arbitrary dated historical retrieval.

The retained Network State example is also manually rated **failed**, despite being model-written and passing its own model review. It expands reporting trips into “every reported vehicle” and infers increased rider waiting from lateness where spacing was maintained. It also supplies useful hypotheses and follow-up checks, but those do not excuse the unsupported claims. The self-review is an additional inspection, not a factual guarantee. Further work needs independent claim-level evaluation rather than a stronger AI label.

That actual-provider replay used **qwen3.5-flash**. Median end-to-end latency was 2.79 seconds for the 32 operational questions (90th percentile: 6.06 seconds) and 2.69 seconds for the 28 GTFS/general questions (90th percentile: 4.51 seconds). These are single-run cloud timings under uncontrolled load. They do not measure a controlled speedup or local 4B performance.

After that earlier replay, a shared interpretation guide was added to distinguish common timetable offsets from lost frequency, prioritize evidence checks and qualify intervention advice. Additional fact-projection tests cover uniform lateness with preserved spacing and unavailable spacing comparisons. Those interpretation refinements were outside that run. The counts above describe the earlier retained answers, not a certified score for the current prompt.

## Further refinement

The [subsequent replay record](evidence/ask-refinement-2026-09-15.json) separates the retained implementation from rejected scope-form and message-order experiments. It also retains fresh and stale network briefings. It is another coding-assistant review of synthetic cases, not an operator assessment or a live accuracy estimate. Read its case-level findings before interpreting aggregate counts.

This replay produced **34 acceptable, 23 partial and three failed answers**. The three failures concerned an unidentified trip's downstream effects (6), spare allocation (18), and unmatched reports over a 90-minute window (117). In the last case, the model incorrectly chose the clock tool. The earlier four failed cases improved to partial answers or, for vehicle history, an acceptable answer; other answers regressed. This does not establish an overall quality gain. Scope selection and concise completion remain unfinished work.

The vehicle-history answer used one model call. Across the full run, operational questions had a 2.96-second median and 6.26-second 90th percentile; the GTFS/general corpus had a 2.89-second median and 4.39-second 90th percentile. These uncontrolled runs do not establish a speedup.

Network review now receives explicit feed freshness. An earlier stale-data draft inferred likely normal service from missing reports; that failure is retained. The final fresh-data example gave a useful Route 66 priority based on cancellation and spacing, but incorrectly rejected a valid paragraph during claim classification. It took 32.73 seconds. Both missed overclaims and false rejections remain possible. Sentence IDs prevent quotation drift; they do not make semantic classification reliable by themselves.

Scope correction still depends on model understanding. Additional forced scope classifications were tested and removed when they misclassified location questions or caused previously useful replies to regress. The implementation retains the existing selection form and clarifies its correction instructions; it does not add a keyword router or a second general-purpose intent classifier.

To repeat the questions with a configured provider, use `scripts/evaluate-agency-intelligence.mjs` with the default operational corpus, then with `--corpus test/fixtures/intelligence/query-cases.json`. Supply a new `--output` JSONL path for each run. The expected answers remain outside model input. Review the retained answers against the expectations; tool completion alone does not determine the result.

To replay the network writer and its review, use `scripts/evaluate-network-briefing.mjs --output <new-file.json>`, optionally with `--variant stale`. It requires an actual configured provider and never substitutes model prose in a software test.

Regression checks cover named-scope protection, multi-entity retention, occupancy and unknown reporting, retained forecast changes, historical-period framing, provider argument validation, actual model authorship and computed fallback. Application and desktop checks validate software and packaging; they do not certify model judgment.

The protected root assessment documents were not edited. The Ask and briefing changes do not modify routing or Reach algorithms. Concurrent journey fixes included in the same delivery preserve live-trip identity after expired updates are removed, reject disconnected saved itineraries and simplify journey presentation; they have separate routing and presentation regression checks.
