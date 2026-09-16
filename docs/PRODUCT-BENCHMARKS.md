# Product benchmarks and design direction

Reviewed September 15, 2026 against the current VIGO Agency source and the official sources linked below. This is a workflow and capability review, not a usability study or a claim of comparative accuracy, performance, adoption or superiority. Vendor product descriptions establish what those vendors document; their outcome claims were not independently evaluated here.

## A coherent direction for Agency

VIGO Agency should make it easy to identify a reported condition, inspect its route or stop, understand its evidence, retain the investigation and compare a bounded service scenario. A useful first screen establishes the City, service date, timezone, observation time and reporting limits before interpreting network conditions. The next action should remain clear as a staff member moves from a route to evidence, the map, a saved answer or a scenario.

The existing foundation includes City-scoped timetable and realtime observations, route and stop inspection, computed network assessments, inspectable Ask activity, saved conversations and notes, CSV evidence and JSON records, and inherited Route, Matrix and Reach tools. Reach already supports baseline/scenario views, travel-time differences, service edits and feed comparisons. These capabilities should be made coherent and discoverable rather than described as missing.

## What the named platforms establish

| Platform | Documented workflow or capability | Relevant design standard for Agency |
| --- | --- | --- |
| Swiftly | Issues in Live Operations prioritizes route and direction issues, supports issue filters and connects inspection with operational map context. Service Adjustments and playback carry disruption context into action and review. | Show an inspectable list of conditions with transparent ordering, useful filters and direct route/stop context. Do not confuse a predicted deviation with confirmed missing service. |
| Conveyal | Single-point analysis exposes scenario selection, time cutoffs, travel-time percentiles, opportunity layers and detailed itineraries. Regional analysis has a single-origin preflight, running-job progress, comparison and downloadable outputs. | Keep inputs and result meaning visible; provide a small verification step before a larger run, reproducible comparison and practical exports. |
| OpenTripPlanner | OTP2 is multimodal passenger-information infrastructure using GTFS/OSM and realtime updates. Its documentation explicitly leaves planning analytics to projects such as R5. | Compare routing correctness and supported semantics on matched workloads. A visual dashboard comparison would misrepresent OTP's purpose. |
| Replica | Transit products include modeled trip records with schemas and demand/equity scores with documented inputs, assumptions and region-dependent evaluation. | Explain what is observed, modeled or inferred, what each metric measures, and what data supports it. A feed observation cannot substitute for a demand or population model. |

Sources: [Swiftly Issues in Live Operations](https://www.goswift.ly/blog/issues-in-live-operations), [Swiftly platform](https://www.goswift.ly/platform), [Conveyal single-point analysis](https://docs.conveyal.com/analysis), [Conveyal regional analysis](https://docs.conveyal.com/analysis/regional), [OTP2 overview](https://docs.opentripplanner.org/en/latest/), [OTP analysis scope](https://docs.opentripplanner.org/en/latest/Analysis/), [Replica transit trip schema](https://documentation.replicahq.com/docs/transit), [Replica demand and equity methodology](https://documentation.replicahq.com/docs/transit-equity-and-demand).

## Priorities identified by the audit

1. Make observed conditions visible before a user reads an extended briefing. The audited Overview put service updates and detailed route conditions inside collapsed disclosures. City-wide facts, selection scope, timing and missing coverage should be immediately understandable without introducing an unsupported health score.
2. Connect route discovery to evidence. The audited route catalog offered name search and alphabetical order. Transparent condition filters and sorting can help users find a route while preserving the distinction between unknown reporting and known service conditions.
3. Make lists and return actions complete. The audited event view stopped after 40 records without continuation. The evidence return label promised all observations while preserving the selection and event filter. A return action should name and restore its actual destination.
4. Make an observation useful outside the app. Preserve structured JSON and provide a readable report with exact scope, timestamps, timetable identity, count definitions, feed freshness, selected evidence, sources and truncation limits. A report must not infer a reporting percentage from trip-update counts with no matching scheduled-trip denominator.
5. Keep presentation consistent across normal and difficult states. Verify keyboard navigation, focus, mobile route/map interaction, empty results, failed refreshes, stale evidence and saved answers. Remove obsolete product labels and update documentation when navigation changes.

These findings record the audited starting point. Implementation and verification of subsequent changes belong in the delivery record; this document does not imply that every identified issue remains open.

## Capability and evidence boundaries

Predicted spacing is not measured headway or actual passage. Retained forecast changes do not establish vehicle progression. Missing reports remain unknown; reporting coverage is not service reliability. Active alert counts do not measure riders affected. A functioning UI, passing fixtures or a linked citation does not establish operational impact or validate every sentence written by a model.

Agency's operations ledger and synthetic operational replay are research APIs, as documented in [the workspace guide](agency.md) and [operations documentation](agency-operations.md). Their existence is distinct from a connected dispatch workflow. The current workspace does not establish a connected crew roster, maintenance clearance, passenger-demand model, live intervention simulator or trained arrival/run-time predictor. It can retain investigations and draft rider information; that is not proof of field authorization, delivery or intervention effectiveness.

## What would support a stronger comparison

Use the same agency, timetable, realtime snapshots and tasks across candidate systems where their scopes overlap. Record task completion, errors, time to find the relevant evidence, accessibility problems and export reproducibility. Include missing, stale, ambiguous and disrupted data. Have transit staff assess whether the result supports their actual decision. Compare routing results and runtime only with aligned modes, date/time, transfer and walking assumptions. Evaluate an operational intervention separately from a synthetic scenario and retain its data provenance, staff decision and observed outcome.
