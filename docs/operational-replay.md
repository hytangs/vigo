# One bus, one control point

VIGO Studio's replay API demonstrates a decision from source evidence to a withdrawn rider message. Run `npm run evaluate:replay` to exercise the backend sequence. There is no Replay panel in Studio. This uses a synthetic City X, separate storage, a fixed timetable and a controllable clock. It does not connect to dispatch or publish to riders.

The implementation reuses the operations ledger, finding transitions, knowledge approvals, message revisions and outbox. New modules supply replayable inputs, applicable procedure selection, holding comparisons and a sandbox transport. VIGO's routing engine and live network assessment are unchanged.

## Replay sequence in the evaluation harness

1. Load the uneven-spacing scenario. Successive departures are predicted 3 and 17 minutes apart, against a 10-minute timetable. The selected bus is reported stopped at River control point.
2. Inspect the selected applicable procedure. The synthetic SOP limits holding to 180 seconds, requires a clear berth and completed boarding, protects the following headway and caps downstream delay. An expired section and another stop's procedure are excluded.
3. Compare no intervention, a target-headway baseline and the passenger-time optimizer. Prepare an option and review its rider message.
4. Approve the exact option and message. Send to the sandbox: the first attempt deliberately simulates a temporary transport failure. Retry records one receipt; repeated delivery requests cannot duplicate it.
5. Advance to the next observation. The bus is now reported in transit. The approved hold is no longer feasible, and its delivered sandbox message is withdrawn. Advancing the clock past expiry exercises a separate stale-clock case.

The replay clock pauses between actions. The 90-second decision lifetime uses that clock, not the operator's wall-clock reading time. Restart restores the active run and audit. New runs preserve previous records in the replay ledger; export a run before switching to retain its complete portable review package.

| Synthetic case | No hold: modeled passenger-minutes | Baseline | Optimizer | Decision |
| --- | ---: | --- | --- | --- |
| Even service | 400 | 0 seconds | 0 seconds | No extra hold |
| Uneven spacing | 596 | 180 s → 584 passenger-minutes | 120 s → 580 passenger-minutes | Compare a shorter hold |
| Stale observations | Unknown | Unavailable | Unavailable | Obtain current evidence |
| Conflicting procedures | Not evaluated | Unavailable | Unavailable | Escalate |
| High onboard load | 500 | 180 s → 716 passenger-minutes | 0 s → 500 passenger-minutes | No extra hold |

The high-load example illustrates the trade-off: restoring headways can worsen the modeled passenger outcome. These are simulated outcomes over a small downstream horizon, not measured passenger benefits or whole-route forecasts.

## Data and procedure selection

The [complete input package](../artifacts/replay/holding-v1/manifest.json) contains five cases: three development scenarios and two held-out variants. Expected actions are developer-authored, not expert agency labels, and are excluded from model prompts.

- `timetable.json` contains the exact miniature GTFS tables: agency, route, stops, trips, stop times, dated calendar exceptions and feed version `SYN-HOLD-1`.
- Each case preserves **authored synthetic** VehiclePosition and TripUpdate observations using a GTFS-Realtime JSON field mapping, including source/entity timestamps. These are not captured agency feeds or records reconstructed from the derived headways.
- `procedures.json` preserves source passages, revisions, sections, effective periods, asset scope, prerequisites and authority. Its approval identities are synthetic.
- The manifest fixes clocks, passenger inputs, filenames, expected actions and known unknowns. Raw source contents and versions determine equality; paths, modification times and digests do not identify the evidence. This establishes equality, not authenticity or tamper resistance.

This narrow replay adapter requires its explicit UTC timetable and date exceptions. Duplicate trip/stop matches, inconsistent service dates/directions, skipped stops and missing departures are rejected. It does not replace VIGO's production GTFS importer. A second agency needs real inputs, approved control points and an actual reviewer; changing a label would not establish transferability.

Replay records live in the City's `agency/replay/operations.sqlite`, separate from live operations. Export includes the package, candidate, message, receipt and revisions.

Knowledge records optionally carry structured `procedure` metadata. `knowledge-select` accepts exact route/stop IDs, query text and confirmed prerequisite identifiers; the server supplies the current clock. Selection removes unapproved, future, expired, out-of-scope, superseded and prerequisite-incomplete sections **before** SQLite FTS5/BM25 ranking. Conflicting limits or authority remain a conflict regardless of text rank. Results include the supporting passage and applicability explanation.

`knowledge-save` accepts and preserves structured metadata with revision/section information. Replay imports its versioned example directly. PDF ingestion, semantic retrieval and an expert-labelled retrieval study are not implemented. A lexical miss returns no matching section rather than substituting an unrelated procedure.

## Method and assumptions

At each modeled downstream stop, `a` and `b` are predicted headways ahead and behind the selected bus, `λ` is the assumed passenger arrival rate, `L` is the supplied onboard load and `h` is additional holding in seconds:

```text
J(h) = Σ λ/2 × [(a + h)² + (b − h)²] + Lh
h*   = [Σ λ(b − a) − L] / [2Σ λ]
```

The code evaluates the neighboring integer seconds and feasible endpoints of this convex objective. The interval intersects maximum holding, minimum following headway and maximum downstream delay constraints. Already-breached constraints, missing loads, stale sources or unconfirmed control-point presence return an unavailable result. Computation checks cancellation and a 250 ms deadline, with at most 50 downstream stops; no optimization server is needed.

The baseline is `max(0, scheduled headway − current forward headway)`, clipped to the same constraints. It is a declared toy comparator, not an agency-agreed practice or an implementation of a named research model.

Assumptions: stationary uniform passenger arrivals; fixed running times; no overtaking; unlimited boarding capacity; constant supplied onboard load; no additional boarding during the control-point hold. The objective counts waiting over two headways at listed stops plus onboard holding. Capacity-denied boarding, dwell changes, transfers and network propagation are absent. No observed cause, recovery time, restricted-route alternative or accessible journey is established.

The distinction between headway regularity, schedule adherence and onboard delay is informed by [Xuan, Argote and Daganzo (2011)](https://www.ocf.berkeley.edu/~xuanyg/doc/Xuan_Argote_Daganzo_2011_TR-B.pdf). [Analytic holding with capacity limits](https://ris.utwente.nl/ws/portalfiles/portal/236315329/1_s2.0_S0968090X20307208_main.pdf) illustrates a material omission from this toy model. Neither paper's controller is claimed as integrated code. Vehicle-presence and departure fields follow the [GTFS-Realtime reference](https://gtfs.org/documentation/realtime/reference/).

## AI and privacy

Optional review uses two model calls: choose an evidence check, then select an existing candidate or escalate. The server always supplies both the applicable procedure and computed alternatives. It does not spend a call choosing the only remaining mandatory check. Candidate IDs and evidence references are validated; the model cannot add durations, causes, recovery, approval or delivery. Ask's `compare_holding` tool exposes the same comparison for an already-open synthetic case.

Actual staff context now defaults to **internal**. Internal SOPs, tracked finding notes and notebook annotations are excluded from model retrieval. Legacy answers that consulted internal-context tools without the current data policy are conservatively excluded from subsequent model history/retrieval. New answers produced under the public-context policy remain available. A document must be explicitly marked public, approved and unexpired before its excerpt may reach the model. Legacy approval alone does not authorize disclosure.

The replay model receives only public synthetic data and has no web or publishing tools. User questions and permitted context still go to the configured inference endpoint. Localhost is not proof of local inference, forwarding policy, retention or security. This is a data-selection boundary, not security certification or erasure of material already transmitted by older versions.

## Evaluation and reproduction

```sh
npm run evaluate:replay
node test/check-operational-replay.mjs
# With an explicitly configured VIGO_AGENCY_LLM_* connection:
npm run evaluate:replay -- --ai
```

Each evaluation writes results under `artifacts/replay/evaluations/`. These generated reports are local outputs. The cases use synthetic inputs and developer-authored expectations; they do not establish staff decisions or observed service impact.

Tests cover procedure scope, expiry, conflicts, optimizer calculations, denied approvals, outdated revisions, atomic rollback, cancellation, duplicate delivery, withdrawal and restart.
