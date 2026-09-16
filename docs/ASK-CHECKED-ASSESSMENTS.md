# Checked operational answers and model-written network briefings

This follow-up addresses the 22 failed cases in the [September 15 audit](ASK-AUDIT-2026-09-15.md). The original audit remains intact. The implementation separates selecting a useful investigation, computing service facts, and writing an interpretation. It does not add a dispatch simulator or infer missing crew, maintenance or passenger data.

## Ask

`assess_service` gives the model one operational entry point. It selects named routes, stops, vehicles or trips and up to five checks, normally one to three: conditions, spacing, causes, retained history, occupancy, coverage, outlook, interventions, resources, rider impact, alert coverage, communications, alternatives or data quality. The implementation reuses the existing service inspection and network diagnosis; repeated reads share the same observation within an assessment.

Names must come from the question or a resolved entity. Referring to a selected route or station requires a phrase actually present in the question. A failed selection gets one focused correction attempt. Separate assessment calls retain both sets of results and their sources. The final composition form arranges completed checks and can request one additional inspection or correct the target scope; it cannot change numerical values. A scope correction replaces the previous answer evidence while retaining the earlier call in the activity record. Historical-period and future-period qualifications stay ahead of the results.

Free-form replies get a short model inspection, including replies after a tool result. It may accept a general answer, correct an unsupported capability promise, or request an operational check. This is another model decision, not a guarantee of comprehension. It adds a model call to these replies; computed assessments, complete station boards and journeys keep their direct rendering.

The checks distinguish scheduled exposure from a forecast, occupancy categories from demand, and vehicle reports from available fleet. A maintenance question still needs actual fault and assignment records. A spare-bus allocation still needs a feasible intervention comparison. The app must say what is missing rather than invent the result.

## Network State

The network briefing now has a genuinely model-written path:

1. Calculate coverage, route conditions, departure spacing and shared stop connections.
2. Let the model choose a bounded investigation and candidate explanations; inspect notices, progression and related evidence.
3. Let the model write its own operational interpretation from those results.
4. Review the draft against the evidence and allow one revision. Retain supported paragraphs; preserve excluded paragraphs and review findings in the record.

The model can decide what matters, propose a qualified causal explanation and identify the next useful check. It is not limited to selecting prewritten sentences. The numerical diagnosis remains independently available. If no usable model interpretation survives, the app shows a **computed snapshot**, explicitly without the AI briefing label. Old cached results that merely attached an AI label to a fixed narrative are refreshed.

This review is performed by the same configured model. During development it both missed overclaims and rejected supported claims. It is not independent operational validation. A published hypothesis is still a hypothesis; the presence of a source reference does not establish causation. The retained replay record and regression fixtures are the evidence for this change, not a claim of expert performance on arbitrary networks.

The existing briefing refresh schedule is unchanged. Additional model work runs in the briefing workflow, not the routing or Reach engines. The UI shows the configured model beside an actual AI briefing and keeps coverage and investigation details expandable.

## Provider behavior

For Alibaba Model Studio endpoints, reasoning control uses `enable_thinking`. Mandatory named forms use JSON output and local validation; ordinary tool selection retains native function calling. Applying a JSON action envelope to every call was tested and rejected after it regressed general GTFS and follow-up answers. The local Ollama action form can restore unambiguously flattened tool fields; conflicting values and unknown fields still fail validation. This repairs response structure without guessing route identity or changing tool meaning.

Network writing and review may use bounded thinking on that provider, separately from quick tool choices. The app does not change the saved connection setting. Other providers retain their configured reasoning mode. No model was downloaded or replaced.

Alibaba documents [function calling](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling), [structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) and [thinking controls](https://www.alibabacloud.com/help/en/model-studio/deep-thinking). JSON output constrains syntax, not factual correctness or compliance with every schema field. The server continues to validate arguments before executing tools.

## Evidence and limits

The actual-provider replay uses the same seven-route synthetic fixture and the same 60 questions as the earlier audit, including conversational follow-ups. It deliberately has no passenger counts, fleet readiness, crew assignments, historical incident outcomes or live intervention simulation. It is not live Boston validation, a routing benchmark, or a comparison against another product.

The [follow-up record](evidence/ask-checked-assessments.json) retains answers, selected checks, timing, expected outcomes and case-level review. The coding assistant performed the review. Results must be read at question level: preventing a fabricated answer can still leave an incomplete or unhelpful answer. The final result consists of one complete 60-question replay and one subsequent retest of case 22 after correcting the review form's handling of unused null fields. Both versions of that case are retained. Development retries are listed separately and excluded from the score.

| Review | Original audit | Follow-up |
| --- | ---: | ---: |
| Acceptable | 23 | 36 |
| Partial | 15 | 20 |
| Failed | 22 | 4 |

Of the original 22 failures, 13 are now acceptable, seven remain partial and two still fail. Cases 23 and 114 are new failures compared with the original audit. This is progress on the fixture, not complete resolution or a stable accuracy estimate. The remaining failures involve selected-location scope (9), an unidentified bus in a short-turn question (17), a vehicle-specific maintenance question (23), and selecting terminal timing instead of retained prediction history (114). Historical-period checks currently qualify retained current observations; they do not implement arbitrary dated historical retrieval.

The retained Network State example is also manually rated **failed**, despite being model-written and passing its own model review. It expands reporting trips into “every reported vehicle” and infers increased rider waiting from lateness where spacing was maintained. It also supplies useful hypotheses and follow-up checks, but those do not excuse the unsupported claims. The self-review is an additional inspection, not a factual guarantee. Further work needs independent claim-level evaluation rather than a stronger AI label.

The actual-provider replay used **qwen3.5-flash**. Median end-to-end latency was 2.79 seconds for the 32 operational questions (90th percentile: 6.06 seconds) and 2.69 seconds for the 28 GTFS/general questions (90th percentile: 4.51 seconds). These are single-run cloud timings under uncontrolled load. They do not measure a controlled speedup or local 4B performance.

After that replay, a shared interpretation guide was added to distinguish common timetable offsets from lost frequency, prioritize evidence checks and qualify intervention advice. Additional fact-projection tests cover uniform lateness with preserved spacing and unavailable spacing comparisons. Those final refinements passed software checks but were not included in another actual-provider replay; the counts above describe the retained runs, not a certified score for the final prompt.

To repeat the questions with a configured provider, use `scripts/evaluate-agency-intelligence.mjs` with the default operational corpus, then with `--corpus test/fixtures/intelligence/query-cases.json`. Supply a new `--output` JSONL path for each run. The expected answers remain outside model input. Review the retained answers against the expectations; tool completion alone does not determine the result.

Regression checks cover named-scope protection, multi-entity retention, occupancy and unknown reporting, retained forecast changes, historical-period framing, provider argument validation, actual model authorship and computed fallback. Application and desktop checks validate software and packaging; they do not certify model judgment.

The protected root assessment documents were not edited. The Ask and briefing changes do not modify routing or Reach algorithms. Concurrent journey fixes included in the same delivery preserve live-trip identity after expired updates are removed, reject disconnected saved itineraries and simplify journey presentation; they have separate routing and presentation regression checks.
