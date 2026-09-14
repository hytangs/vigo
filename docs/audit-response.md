# Audit response · 14 September 2026

This pass checked the two supplied audits against the current checkout. It concentrates on scope, service-day semantics, cancellation meaning, request deadlines, and honest presentation of model output. It does not add another workspace or change the routing or accessibility engines.

## Changes and remaining limits

| Finding | Response | Boundary |
| --- | --- | --- |
| F01 · unsupported operational prose | Answers now retain whether they were computed, written by a model with checked sources, or written without a check. Ask and exported notes distinguish model text from checked evidence. Invalid citations remain visible with an explicit warning instead of silently disappearing. | **Partially addressed.** This is provenance and presentation, not claim-level entailment validation. General conversation remains available. A model can still write an unsupported claim, including beside a valid citation. |
| F02 · alert selector cross-products | A shared matcher preserves conjunctions within each selector and alternatives between selectors. Workspace filtering, service inspection and realtime tools use it. Readable scope descriptions retain route, stop, direction, trip and service-date restrictions. | Unknown identity, conflicting source scope, missing agency ownership and unsupported trip-instance constraints stay unresolved. They remain visible in the network overview without acquiring a route assignment. Ambiguous legacy flattened lists cannot reconstruct the original selectors. |
| F03 · deleted trips shown as cancellations | Agency keeps deletion distinct internally, hides deleted trips from station boards, and excludes them from cancellation findings and current service-exposure denominators. Other indexed service remains visible. | This does not reconstruct a realtime-only replacement trip. The protected routing implementation is unchanged, including its combined cancellation/deletion diagnostic counter; both relationships already exclude a trip from routing. |
| F04 · calendar admission | Coverage is evaluated by source: scheduled service, no service today, continuing prior-day service, outside dates, or unknown. A Sunday-inactive feed does not block another feed. Indexed trips continuing after the final calendar date remain eligible while their scheduled span continues. | Trip identity, active service on the trip's own service day, and freshness are still checked independently. A single agency timezone is still required. Calendar coverage is not a claim that vehicles are running. |
| F05 · causal ranking from valid evidence IDs | The briefing presents a model-selected explanation as a possibility to investigate. It no longer says the checked evidence “favors” that explanation, and explicitly records that the ranking is unverified. | **Partially addressed.** Evidence-ID validity does not establish causal relevance or discrimination between hypotheses. The bounded investigation still needs a stronger independent evaluation. |
| F06 · rider draft semantics | Copyable drafts retain observation time, scope and review status. Stale-data and no-established-disruption drafts no longer apologize for an asserted disruption. Minute estimates are rounded for rider copy. | Drafts are unpublished and require review. No cause, recovery time, translation quality or accessibility validation is inferred. The existing accessibility option only changes paragraph spacing. |
| F07 · DNS outside timeout | One deadline covers DNS waiting, connections, redirects and body transfer. Abort stops waiting for a resolver that never settles. Each redirect still resolves and pins its target under the address policy. | The underlying platform resolver itself is not cancellable; its result is ignored after the request stops. |

The selector and deletion behavior follows the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/#message-entityselector) and its [trip relationship definitions](https://gtfs.org/documentation/realtime/reference/#enum-schedulerelationship_1). Route-wide browsing can surface a restricted notice; its restrictions remain attached and do not become a route-wide incident claim.

## Implementation choices

`alertApplicability.mjs` owns selector resolution, applicability and readable scope. Static identity indexes are reused per timetable. GTFS service-clock helpers now live with the other clock helpers, avoiding a circular dependency between timetable context and service-window calculations. Existing imports through `agencyContext.mjs` remain compatible.

These changes add no model call, new model, or online lookup to answering. The existing bounded timetable caches remain in place. One retained Boston snapshot replay measured a median 113 ms for warm network computation and 4.3 ms for a retained briefing request. Those local measurements exclude inference, network transport and UI rendering; concurrent checks were running, so they are not a controlled before/after speed comparison. The station's first lookup still requires its existing timetable scan.

## Validation

Regression cases cover cross-paired route/stop selectors, parent stations, direction, trip/date, route type, agency ownership, ambiguous feeds, deletion without cancellation, preserved remaining service, inactive Sunday sources, calendar removals, final-date overnight service, hanging DNS, abort, shared redirect deadlines, draft scope/time, and missing citation references. Model-response tests use controlled providers; they do not establish real-model answer quality.

Local checks passed: Agency, GTFS, security, TypeScript, UI, CLI, public-file/documentation checks, and the Python LAMP study checks. A separate Ubuntu CI job now installs the pinned research dependencies and runs the LAMP tests. Remote CI success is not inferred from this configuration.

The LAMP result remains a retrospective historical running-time baseline. Replay remains a small synthetic workflow evaluation, not evidence of independent AI dispatch judgment, field impact, or superiority to another product.

## Next evidence milestone

Before describing Ask as verified operational intelligence, test unsupported incident/recovery claims and valid-but-irrelevant citations against an explicit claim-to-evidence representation. A stronger causal evaluation must hide the deterministic recommendation, include contradictory and unavailable observations, and score abstention and operational decisions independently. This pass deliberately does not replace that work with another prompt or another feature surface.

The protected root README, assumptions and AI-use documents were not edited. Their authorship and assessment claims require their owner's review.
