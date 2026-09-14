# Agency question evaluation

September 14, 2026. Implementation and answer review by the coding assistant. This is a development evaluation, not an agency acceptance test.

## Result: not ready for the requested standard

The complete recheck produced **2 acceptable, 3 partial and 27 failed answers**. The adequate answers were the three-channel rider drafts and the combined Route 39 investigation; even those need editorial refinement. They do not establish that the remaining operational questions are supported. [All recheck answers](evidence/agency-intelligence-qwen-recheck.json) and the [individual review](evidence/agency-intelligence-recheck-review.json) are retained, including failures.

| Complete 32-question run | Acceptable | Partial | Failed | Median agent time | Model calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| First shared-investigation run | 0 | 4 | 28 | 63.8 s | 129 |
| Recheck with scope and repetition fixes | 2 | 3 | 27 | 48.0 s | 100 |

The recheck took 33.3 minutes of accumulated agent time. Machine load, prompt caches and concurrent development work were not controlled, so these figures are not a speedup claim. The recheck process predates the final timestamp/notice boundary refinements, composition-history retention, typed route-label aliases and prompt simplifications. Those later edits must not be counted as model-tested by this cohort.

The remaining failures are not cosmetic. They include excluding a shared cause because no alert confirms one, confusing forecast history with actual delay onset, treating missing crew records as evidence that no reliefs are endangered, inventing mechanical diagnostic capability, and interpreting fresh feeds as proof of prediction accuracy. The current model must not be described as an expert operational decision system based on these results.

After the final code refinements, a three-question ordinary-mode spot check gave **0 acceptable, 1 partial and 2 failed answers**. “Route 66” resolved in one inspection, and the headway concept question used no live tools. The resulting prose still contained unsupported causal exclusions and incorrect wait arithmetic; the three-channel draft needed editing. [Exact final spot-check answers](evidence/agency-intelligence-final-spot.json) and [review](evidence/agency-intelligence-final-spot-review.json) distinguish successful orchestration from unsuccessful interpretation. The delivered implementation has not passed the entire 32-question corpus.

## First complete run

The 32-question run with `qwen3.5:4b` produced **0 acceptable, 4 partial and 28 failed answers** under the stated review criteria. All questions ran; this is not a claim that all were answered successfully. Median agent time was **63.8 seconds**, with **40.0 minutes** spent across the questions. These are single-run development timings, not a controlled latency comparison.

The main failures were consequential: assigning one route's cause to other routes, inventing delay onset from forecast history, treating absent alerts as counterevidence, treating future non-reporting as failed service, and calculating passenger waits without the required assumptions. Several questions timed out or omitted requested deliverables. Fluent wording did not make these answers suitable for operations.

[Exact answers and tool records](evidence/agency-intelligence-qwen-32.json) and the [individual review](evidence/agency-intelligence-review.json) include every result. This run predates the final fixes for repeated inspections, scoped model context, query-parameter retention and conversation evidence retention. Those changes have deterministic regression coverage; their existence must not be counted as passing model answers. The older runner did not write a completion footer: all 32 IDs and successful process exit were checked separately.

The [earlier 30-question baseline](evidence/agency-intelligence-baseline.json) used the previous Ask pipeline. It invoked the timetable profile 19 times and never used a service investigation. Returning a timetable quickly was not a useful answer to network diagnosis, fleet readiness or intervention questions. The new investigation addresses that tool-selection gap, but this completed run still fails the requested answer-quality standard.

## Question coverage

The corpus preserves the supplied 30 questions and adds the two combined examples: “What is going on with the 39?” and “Anything I should worry about for the evening peak?” They cover current state, diagnosis, consequences, forecasting, operational choices, rider communication and retrospective learning. They are evaluation inputs, never production question-matching rules.

The test uses a real SQLite timetable, the production real-time derivation, the production tool registry and the actual configured model. It does not substitute mock model replies. Each question starts a separate conversation with Route 39 and Harvard Square selected, deliberately testing whether map selection improperly narrows a whole-network question. The fixture is frozen at 08:00 EDT on September 14, 2026. Its familiar route and stop labels are synthetic: its geometry, timetables, vehicle reports and notices are not Boston observations.

The scene contains both reassuring and concerning evidence: three routes whose reporting trips match their schedules; four with late predictions; one cancellation; a full-occupancy report; a construction notice scoped to one route; a separate elevator outage; missing reports; and changing forecasts at the same stop. Crew rosters, fleet readiness, fault telemetry, passenger counts, dispatch actions and historical outcomes are deliberately absent. A good answer must still do useful work without inventing those records.

[Questions](../test/fixtures/intelligence/questions.json), [scenario](../test/fixtures/intelligence/scenario.mjs) and [review criteria](../test/fixtures/intelligence/review-criteria.json) are separate. The answering model never sees the review criteria. Each result needs a factual and operational review; successful tool execution is not an answer-quality pass. A single synthetic scene does not cover city transfer, paraphrases, multilingual questions, real incidents or repeated-run reliability.

## Shared investigation

`inspect_service` now supplies one reusable investigation across network, route, station, trip and vehicle scopes. It reuses the existing network diagnosis, timetable windows, prediction history and alert logic. Its output contains route patterns, shared stop connections, both close and wide departure spacing, relevant notices and occupancy categories. Scheduled 30/60/90-minute exposure is available as an outlook; it is not a future-state or recovery model.

The local model selects a typed scope instead of copying vehicle numbers into route fields. Named entities resolve against the loaded City. A whole-network request does not inherit the selected route; alerts on non-reporting routes remain included. Ambiguous vehicle labels across feed sources require a distinct identity. Vehicle history stays restricted to that vehicle's trip. Station children follow declared GTFS parent relationships.

Exact route labels include the indexed short name, full name and their `Route …` display forms. This fixes unnecessary retries for a supplied name such as “Route 66” when the short name is “66”; no names are guessed or stripped. Duplicate labels remain ambiguous. Conceptual questions can use the user's givens directly; current operational claims still require current evidence. The prompt has no word quota.

Workspace selection is read on demand. The initial prompt says whether a route or station is selected; it does not repeatedly put that route's name beside unrelated questions. A question about “here” can retrieve the verified selection, while an explicit network, route or vehicle request keeps its own scope. Saved answers still retain the selection that applied when they were asked.

After retrieving operational evidence, Ask uses a smaller composition context. It retains the question, dated conversation, available integrations and checked evidence, with a way to request another specialist. A timetable profile no longer automatically ends an unrelated operational investigation. The computed station board still returns directly for a next-departure question. No question-specific answer templates, route-name rules, additional router or package dependency were introduced.

An identical successful inspection against the same frozen observation is reused once, then the assistant must compose from the evidence already obtained. It does not create another check or citation. Historical study reads are exempt because an explicitly invoked study tool can change their saved output. This bounds an observed repetition failure; it does not prove the resulting interpretation is correct.

The evidence keeps qualification beside each value: maximum versus average, departure versus arrival, reporting coverage versus service health, forecast history versus actual progression, and notice validity versus recovery. Query parameters stay attached during composition: an empty keyword search is not an empty alert feed. Scoped investigations do not inherit unrelated network totals, and dated inspection results are retained for follow-up drafts. This improves the input; it does not validate arbitrary prose generated from it.

The final boundary audit also checks that explicit network alert reads include non-reporting routes, repeated records at one stop do not inflate the spatial extent of a departure pair, and future or expired timestamps do not enter retained prediction comparisons. A broader route notice retains its actual stop scope; it does not become a fault at the selected station. Follow-up composition retains earlier dated evidence and its query filters, not only previous model prose.

## Operational breadth and remaining integrations

The question types are not separate chat modes. They share the same context and reusable tools. The missing records below are material limits, not facts the model can fill in from general transit knowledge.

| Work the question requires | Evidence available to Ask | What remains unestablished |
| --- | --- | --- |
| Observe service | Timetable, matched predictions, positions, notices and station boards | Actual operation on unreported trips |
| Detect a pattern | Distinct departure pairs, cancellations, shared directed stop connections | A calibrated definition of unusual service without a relevant baseline |
| Explain a condition | Scoped notices and retained forecast comparisons | Actual onset, dwell, road speed or a shared cause from overlap alone |
| Connect consequences | Route, stop, trip and vehicle identity; scheduled exposure | Block, crew, relief and protected-connection dependencies |
| Predict what follows | Scheduled horizons; optional historical LAMP running-time study | A calibrated network recovery or passenger-demand forecast |
| Compare actions | Explicitly opened synthetic holding replay; conditional operational discussion | Field-valid short-turn, express, spare or hold benefits |
| Communicate | Checked findings, alerts and saved conversation evidence | Unverified cause, restoration deadline, publishing or dispatch |
| Learn from an event | Retained notes and historical evidence when present | Effects of an intervention without dated actions and comparable outcomes |

## Model experiments

All candidates stayed below the requested approximately 6B ceiling. The retained configuration is `qwen3.5:4b` with an 8,192-token context. A separate eight-question pilot of [Phi-4-mini](https://huggingface.co/microsoft/Phi-4-mini-instruct), served as `phi4-mini:3.8b`, produced **0 acceptable, 2 partial and 6 failed answers**. [Pilot answers](evidence/agency-intelligence-phi-pilot.json) and [review](evidence/agency-intelligence-phi-review.json) are retained. That pilot predates on-demand workspace selection, so it is not a matched comparison with the final implementation.

The [Qwen3 4B instruction model](https://ollama.com/library/qwen3%3A4b-instruct-2507-q4_K_M) was also tried on one diagnostic question; it confused a maximum with an average and suggested stairs as an accessible alternative. That one failure was enough to reject it for this setup, not to rank the model generally. Both comparison models were unloaded and removed from disk. Shorter writing prompts and a separate factual-editing pass also failed to remove unsupported claims; neither experiment became another production stage.

A six-question pilot enabled reasoning on the same `qwen3.5:4b` model, still at 8,192 context tokens. **Five questions timed out and one incorrectly denied that Route 66 existed after a failed literal lookup.** [Exact pilot answers](evidence/agency-intelligence-reasoning-pilot.json) and [review](evidence/agency-intelligence-reasoning-review.json) record the 120-second provider timeout and the tested implementation. The route-label fix came afterward. Reasoning mode was not promoted to the live configuration; these results do not show that more reasoning time supplies the missing operational reliability.

## What an adequate answer should say

For the Route 66 question in this fixture, a supported answer is:

> Route 66 needs attention for disrupted spacing: one trip is reported cancelled, one of four comparable departures is predicted 15 minutes late, and a pair of departures is 25 minutes apart against a 10-minute timetable interval. One vehicle also reports full occupancy. Three comparable departures match the timetable, but that does not remove the gap. Check the cancelled trip's replacement and actual vehicle progression first. There is no dwell, traffic or dispatch record establishing why this happened; the Route 39 construction notice does not explain Route 66.

For vehicle 1827, an adequate explanation preserves a different limit:

> Its next compared departure is predicted 20 minutes late. Retained forecasts for Harvard Square changed from 10 to 15 to 20 minutes late over eight minutes. That shows the forecast deteriorating at one stop; it does not locate where the bus actually lost time. The Route 39 notice reports construction near Huntington Avenue, but attributing this vehicle's delay requires actual passages or position history through that segment. Inspect those records before assigning an onset or cause.

These examples describe only the fixture. They are reviewer examples, not canned replies used by Ask.

## Reproduce

Run from the repository root with an installed model and a new output path:

```sh
VIGO_AGENCY_LLM_BASE_URL=http://localhost:11434 \
VIGO_AGENCY_LLM_PROTOCOL=ollama \
VIGO_AGENCY_LLM_MODEL=qwen3.5:4b \
VIGO_AGENCY_LLM_CONTEXT_TOKENS=8192 \
VIGO_AGENCY_LLM_REASONING_EFFORT=none \
VIGO_AGENCY_LLM_TEMPERATURE=0 \
VIGO_AGENCY_LLM_TIMEOUT_MS=120000 \
npm run evaluate:intelligence -- --output /tmp/vigo-intelligence-new.jsonl
```

Public answer records are standard JSON arrays converted losslessly from the runner’s JSONL output. Record order, answers, evidence, timings and review scores are unchanged.

`--ids 1,4,5` selects a diagnostic subset. Output files are created exclusively, never overwritten. The record contains the model configuration, starting Git revision and dirty state, exact answers, tool arguments/results, warnings and timings. A missing completion record or missing question IDs indicates a partial run. Total time includes the agent's model and tool work; it excludes fixture construction. These sequential development runs do not control machine load or serving caches.

`npm run check:agency` separately tests deterministic boundaries, including multi-route scope, vehicle identity, history isolation, cancellation, occupancy, unreported-route notices, missing data, stale feeds and further tool discovery. Those tests use stubbed replies only to exercise orchestration. They do not establish that the real model answers the 32 questions correctly.

## Delivery verification

The final implementation passed `npm run check:agency`, `npm run check:security`, `npm run check:docs` and `npm run build`. In the running browser at port 5180, a Park Street next-departure question made one check and displayed B, C, D, E and Red Line service across ten direction/destination rows, despite Red Line being selected on the map. Scheduled times and recorded predictions were separate and displayed in EDT. After starting a new chat and reopening the saved answer, the same board and timestamp remained, marked “Saved with this answer · not updating.” This is a focused live workflow check, not a substitute for the operational-question evaluation above.

The root `README.md`, `ASSUMPTIONS.md` and `AI-USE.md` were left unchanged.
