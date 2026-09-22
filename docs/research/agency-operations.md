# Agency operations prototype

This backend prototype is outside the main Network / Routes / Ask workspace. Its API, records and service tests remain available for research. The workflow below describes internal API actions, not additional Studio buttons or a supported public integration API.

The [operational replay](operational-replay.md) adds a synthetic holding decision through procedure selection, alternative comparison, approval, sandbox receipt and evidence-driven withdrawal. It reuses this ledger in separate replay storage. Internal knowledge and staff annotations are excluded from model context by default; approval alone does not authorize model disclosure.

The City operations ledger keeps findings, source evidence, staff decisions and rider guidance together. It works without a model. Ask can read approved public operational context and historical comparisons; mutations require explicit API requests from an authorized principal.

## Handle a finding

1. Call `operations-track` for a current finding. The selected evidence, timetable identity, source references and quality summary are retained. Tracking the same event twice returns the existing record.
2. Use `operations-transition` to acknowledge the finding, investigate, and record action. Each transition requires a note. Link approved, unexpired context relevant to the finding's route or stop when useful.
3. Prepare rider guidance, or transition to monitoring. A missing event or stale feed leaves current availability **unknown**; it never resolves the case automatically.
4. Resolve with an explicit outcome and evidence reference: staff-confirmed recovery, false positive, or unable to confirm. Resolved cases can be reopened for investigation. These labels are staff assessments, not independently verified ground truth.

Evidence remains as captured until `operations-refresh` is used. A changed timetable requires a new finding against the new import. Every edit requires the current version; a stale client must reload before saving. Revision history preserves the preceding evidence and decisions.

## Add shared context

`knowledge-save` accepts SOPs, maintenance records, document excerpts and operating notes. Each record has a source reference, scope and review date. New entries and revisions start as drafts. Approval applies to that exact version. Expired or draft material cannot be linked as approved guidance.

Keep source excerpts concise and identify their document revision or page. The API also supports exact stop scope. Content stays in the City ledger; no document crawler, embedding service or remote knowledge database is introduced. Ask's `operational_context` tool retrieves up to five dated, versioned excerpts and labels their status. Retrieved text is treated as evidence, never executable instructions. If used in Ask, these excerpts enter the configured model's context under the existing provider behavior.

## Prepare and deliver rider guidance

Call `message-draft` with the finding, channel, and audience to create an English template from its evidence. Channels have declared product limits: app and service alert, 2,000 characters; social, 280; signage, 160. These are editable starting templates, not assertions about every downstream platform's limits. Oversized templates require editing before approval; text is never silently truncated.

Audience choices are all riders, riders at a stop and accessible travel. Guidance asks riders to check departures or contact agency staff. It does not invent a disruption cause, recovery time, alternate route or guaranteed accessible connection.

Saving a revision clears approval. A reviewer checks the wording and evidence, approves the saved version, then **releases it to the local outbox**. Approval and release require current unchanged evidence, an action or monitoring state, and unchanged approved knowledge. Drafts initially expire after 15 minutes; the API permits an explicit expiry within 24 hours. A new draft is required when its source evidence changes.

`message-release` creates a durable local handoff containing the text, audience, channel, version, expiry, source evidence, and approval attribution. It does not transmit a message. After using the agency's own channel, staff can record its confirmation or public URL through `message-delivery`. That receipt is explicitly staff-recorded. `message-withdraw` preserves the prior revisions; staff must also remove an external copy in its channel. A repeated release request returns the same handoff rather than creating a duplicate.

## Retain and compare history

The first received observation in each five-minute bucket is retained for up to 90 days, capped at 25,920 samples. Samples include source clocks, coverage, quality flags and route prediction summaries. Repeated UI reads do not increase sample counts. The app must be open and its existing feed refresh active; idle suspension, shutdown and missed intervals do not generate synthetic observations.

The history API compares a route with earlier service dates from the same timetable import, local weekday and hour. It first takes each day's median reported route maximum predicted departure delay, then the median across independent days. At least three earlier days are required. Insufficient coverage or sample counts remain unknown. A different import is excluded from the comparison. This is a descriptive prediction baseline, not actual vehicle performance, passenger waiting time or an anomaly detector.

The history API also reports an expanding-window evaluation: each historical day's target is compared only with earlier days. It returns the number of held-out days and mean absolute error; no current or future day enters its training subset. There is no trained ML predictor. Paginated sample and record endpoints expose retained observations, staff outcomes and revisions for subsequent analysis without claiming that those annotations establish causal effects.

## Access, storage and operation

The shipped application remains a local, single-owner workspace. Its trusted host supplies `local-owner` with the `admin` role. No browser role selector, client-supplied identity or model tool can grant permissions. `createAgencyService` accepts a trusted `access(projectId)` callback for host-managed identity and City authorization; a missing or unauthorized identity fails closed.

| Role | Capabilities |
| --- | --- |
| Viewer | Read records, evidence and history |
| Operator | Viewer access; track findings, record decisions, draft knowledge and messages |
| Reviewer | Operator access; approve another author's knowledge/message, release and record delivery |
| Admin | Reviewer access; configure connections and skills; explicit same-author approval capability for the local owner |

There is no hosted login, SSO, agency directory or multi-user deployment in this change. A hosting integration must authenticate each request and supply its authorized principal through the trusted boundary; exposing the default local-owner service as a shared server would not provide user isolation. Admin approval is attributed in the ledger, not disguised as an independent reviewer.

Each City owns `agency/operations.sqlite`, separate from the read-only timetable and existing notebook. A database records its owner and rejects reuse for a different City ID. Schema version 1 uses SQLite WAL, full synchronous commits, a bounded lock wait, indexed records and transactional audit writes. Newer schemas fail closed. Human records are capped at 10,000; capacity exhaustion reports an error instead of silently deleting decisions. Revision history is retained with human records. These are application-enforced audit records, not cryptographically tamper-proof storage against someone with filesystem access.

The quality summary exposes source freshness failures, unresolved trip reports, timetable coverage and missing comparable departure pairs. Its alignment fraction uses **received reports** as its denominator. It does not claim the percentage of scheduled trips observed. `operations-health` reports database integrity, schema, counts, sample policy, last retained time, refresh activity and refresh/storage errors. History write failures are visible in Agency warnings; previous records are preserved. Live feed failures retain the previous observation while its source clocks continue aging.

For a consistent backup, stop Studio and copy the entire City `agency` directory, including SQLite sidecar files if present. Retain the timetable with it to preserve evidence identity. Restore to the same City identity and verify `operations-health` before resuming. Moving or replacing the timetable invalidates comparisons that depended on its previous local identity. This feature does not add replication, continuous background hosting or a recovery-time guarantee.

## API and verification

Use the existing `POST /api/projects/:projectId/agency` endpoint. Every mutation supplies `id` and `version` after creation. No mutation is in the model tool catalogue.

| Action group | Actions |
| --- | --- |
| Read | `operations-overview`, `operations-list`, `operations-record`, `operations-audit`, `operations-history`, `operations-baseline`, `operations-health` |
| Findings | `operations-track`, `operations-refresh`, `operations-transition` |
| Knowledge | `knowledge-save`, `knowledge-approve` |
| Rider guidance | `message-draft`, `message-edit`, `message-approve`, `message-release`, `message-delivery`, `message-withdraw` |

Lists return 50 records by default, up to 100, and accept `query.before` as the last returned ID (ascending IDs). Audit pages return 50 newest revisions and accept `before` as the last sequence. Observation pages return 100 newest samples and accept `before` as the last bucket. No external publication credentials are required or stored.

`npm run check:agency` includes the operations service fixture, covering workflow notes, message revision, approval, local release, recorded receipt, audit and insufficient history. `node test/check-network-workspace-runtime.mjs` checks the active Network workspace, keyboard tabs and responsive widths. All observations and receipts in these tests are synthetic. Runtime data remain in ignored `temp/` storage.
