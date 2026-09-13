# Agency code and commit audit

Reviewed on September 13, 2026, in `vigo-developers/vigo-agency`. The starting checkout was clean on `main`. The review covers the 17 commits after `ea65ae6` (`[START OF VIGO AGENCY]`), through `4ea670b`, and their combined changes across 82 files. The original VIGO checkout and native routing implementation were outside this change.

The useful boundaries are already present: one timetable context and observation session per City; reusable transit tools; a provider adapter; a City notebook; and separate Live, Ask, evidence, and research views. Replacing them with another agent framework would add work without correcting the failures found here. This pass strengthens ownership, request cancellation, exact identities, and reuse within those boundaries.

## Findings and corrections

| Finding | Correction | Evidence |
| --- | --- | --- |
| Reloading a timetable or evicting a City closed the SQLite connection while an investigation still used it. | A request holds its session until it finishes. Retirement stops polling and invalidates old refreshes immediately; database connections close after the last active request releases them. Failed initialization also closes opened connections. | A paused-provider fixture reproduced `database is not open` before the fix. Reload, eviction, and orderly shutdown now retain the completed answer. |
| Refresh derived and updated observation history twice. | Persist the history already returned by the shared observation calculation. | Existing snapshot and history checks pass. |
| Trip delay history used only the trip ID, merging repeated daily trips. | Include the GTFS service date in the history key and in evidence lookup. | The same trip on two dates retains separate delay series. Old undated series are not guessed into a date; normal retention ages them out. Saved investigations remain intact. |
| A timestamp far in the future was clamped to zero age and presented as fresh. | Preserve signed age and classify timestamps beyond the existing clock tolerance as unknown. | A feed timestamp 181 seconds ahead is unknown; existing independent-feed-clock tests pass. |
| Entity lookup rebuilt every station group and route object on every request, including route-only requests. | Build station aliases, route entities, and exact stop-ID indexes once per timetable context. | Parent-station and explicit platform lookup checks pass. The resident lookup measurement is below. |
| One malformed installed skill prevented the entire City session from loading; duplicate IDs could silently replace an earlier method. | Isolate each method load, retain valid methods, report a readable warning, and reject duplicate IDs. Validate manifest input and step shapes before exposing them to the interface. | Invalid JSON, duplicate input keys, invalid versions, valid-method retention, and installation/restart tests pass. |
| Tool argument validation ignored declared string limits and consulted inherited property names. | Honor each string limit and accept only declared own properties. | Overlength place queries and prototype-property argument names are rejected. |
| An old observation failure or notebook request could overwrite a newer selection. Pagination could append an old search to a new one. | Apply the existing request-generation rule to failures and completion; cancel superseded entry/search/page requests. | Type checking and the browser saved-work/search flow pass. Controlled network-reordering tests are not part of the current UI harness. |
| A completed answer disappeared if its notebook readback failed. | Keep the computed answer visible until saved-entry restoration succeeds. Ignore results from cancelled investigations before updating the map. | Source-path review, type checking, and actual answer retention/reload verification. |
| Agency route, Reach, and location overlays survived a City change; All routes did not clear the location overlay. | Use one small map-reset function for City transitions, closing a City, and returning to all routes. | Map checks and browser navigation pass; cross-City identity is also reviewed at the reset call sites. |

## Commit coverage

The history was reviewed as a sequence of changes, with the surviving implementation inspected together. Earlier fixes were retained; commits were not rewritten.

| Commit | Scope reviewed |
| --- | --- |
| `9c01121` | Operational evidence types, workflow definitions, and City assumptions. |
| `ccccda8` | Calendar and timezone alignment, scoped GTFS identities, departure comparisons, freshness, and history. |
| `61527b1` | Read-only SQL worker, execution/size limits, tool validation, native route and Reach handoff, and agent evidence. |
| `3beb2c5` | Server-owned observations, provider configuration, streamed public activity, and request lifecycle. |
| `ba9c605` | Agency UI, map integration, existing style tokens, desktop naming, and packaging. |
| `913ee0c` | Documentation and its data/method claims; the three submission documents were left unchanged. |
| `dd8c0ed` | Notebook persistence, search, follow-ups, skill installation, and research exports. |
| `0572c63` | Conversation restoration, map restoration, and journey presentation. |
| `e51528f` | Delivery artifacts, build configuration, release checks, and retained evidence. |
| `151869f` | Notebook retrieval and readable activity/evidence presentation. |
| `b0d6146` | Architecture rationale, literature pointers, and stated limitations. |
| `876c605` | Interrupted studies, partial evidence, cancellation, and malformed model tool calls. |
| `654be08` | Service-first briefing, supported gap comparisons, and route scope. |
| `ac5d9f7` | Complete route geometry, partial route previews, and reported vehicle locations. |
| `bf9032e` | Direct conversation, model-written explanations, compact evidence, and provider behavior. |
| `2b32f40` | Online place lookup, endpoint isolation, caching, ambiguity, and native walking routes. |
| `4ea670b` | Named endpoints, ordered waypoints, deadlines, transfer constraints, follow-up requests, parallel read tools, and timing. |

Coverage includes Agency modules and components, their tests and fixtures, the changed App/map/server adapters, styles, build and packaging scripts, public skill files, documentation checks, and artifact generation. Historical screenshots and exported observations were treated as retained examples, not evidence of current service or a fresh production test. No package dependencies were added.

## Lookup measurement

On the unchanged local Boston timetable, three consecutive batches each alternated 100 lookups between route `1` and stop `Back Bay`. The timer surrounds `AgencyContext.resolve`, after constructing the context. There was no separate warmup. Both implementations returned 100 total matches in every batch.

| Batch | Before, milliseconds | After, milliseconds |
| --- | ---: | ---: |
| 1 | 650.12 | 61.18 |
| 2 | 604.52 | 46.17 |
| 3 | 570.75 | 46.19 |

The mechanism is removal of repeated station grouping and object construction. This is a small resident-lookup measurement, not an end-to-end Ask benchmark. Startup cost, model inference, geocoding, and native routing are excluded. Raw values, query inputs, runtime, and limitations are retained in [agency-lookup-timing.json](evidence/agency-lookup-timing.json).

To repeat the same timing boundary against an available indexed timetable, run from the repository root with its path as the final argument:

```sh
node --input-type=module - /path/to/timetable.sqlite <<'JS'
import { AgencyContext } from './src/agency/agencyContext.mjs'
const context = new AgencyContext(process.argv[2], 'Audit City')
const queries = [{ kind: 'route', query: '1' }, { kind: 'stop', query: 'Back Bay' }]
try {
  for (let batch = 0; batch < 3; batch++) {
    const start = performance.now()
    let matches = 0
    for (let i = 0; i < 100; i++) matches += context.resolve(queries[i % 2]).total
    console.log({ milliseconds: performance.now() - start, queries: 100, matches })
  }
} finally { context.close() }
JS
```

Use names from the same unchanged timetable when comparing another City. Compare revisions with the same runtime and timer boundary.

## Verification and limits

The Agency suite passes, including lifecycle, provider, SQL, journey constraints, places, notebook, realtime, installed methods, and briefing cases. TypeScript, UI/CSS, map, local HTTP and realtime URL security, GTFS-Realtime decoder and routing checks pass. The production build, desktop packaging, and packaged-runtime checks also pass.

The browser check uses the actual running Boston City and configured local model. It checks saved-work search during pagination, restoration of an existing walking answer and map, clearing that map for a new conversation, and saving/reopening a new answer. The local `qwen3.5:4b` capability reply still exposed tool names and incorrectly suggested a predicted-versus-actual performance comparison. That wording is a recorded model limitation; the successful persistence check does not certify answer quality. These are focused interaction checks, not an automated browser matrix or a model-accuracy benchmark.

Orderly session retirement is covered; abrupt process termination still has no per-step investigation checkpoint. The full retained observation/history payload is still returned by the state endpoint. Large multi-user deployments would need a measured load test before changing that API. Model-written operational prose still requires evidence review: bounded tools do not guarantee every generated interpretation is correct.

`README.md`, `ASSUMPTIONS.md`, and `AI-USE.md` were preserved byte for byte. This engineering audit and its fixes were produced with the coding assistant; they do not replace those protected documents.
