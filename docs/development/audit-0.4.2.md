# Architecture audit for 0.4.2

This records the final local VIGO 0.4.2 freeze, including the runtime hardening
and multi-feed follow-up. The user-authorized retag replaces the earlier local
freeze. [Realtime and traffic methods](realtime-audit-0.4.2.md) and
[runtime limits and recovery](runtime-recovery.md) document current behavior.

This review covers the Engine and Studio repository: import and City storage,
native adapters and kernels, worker scheduling, CLI and HTTP boundaries, React
and map surfaces, agency research interfaces, documentation, and release checks.
The Python wrapper, private comparisons, and manuscript are separate repositories
and are outside this freeze. API 1.0, City format 1, and Result schema 1 remain
unchanged.

The audit combines source inspection, repository-wide export/reference and
duplicate-block scans, and the repository's regression suites. Static scans are
candidates for investigation, not proof that every runtime path is reachable or
that all defects have been found. The initial architecture review did not run a
comparative benchmark. Follow-up performance changes preserve the routing
contract; [performance measurement](performance.md) defines the evidence needed
for a workload-specific speed claim.

## Repairs included in the freeze

| Finding | Consequence | Repair and regression |
| --- | --- | --- |
| Worker message transfer could throw after setting the active job | An immediately rejected request left the worker busy; a queued failure could escape from the completion handler | Catch transfer failure, clean cancellation listeners, reject that job, and continue the queue without restarting the prepared worker. `check-national-runtime-isolation.mjs` uses actual workers to check clone failure, capacity, shutdown and recovery. |
| A timetable retained a string-keyed map of every street identity/access-profile projection used with it | Repeated policy changes could accumulate full stop-mapping arrays for the timetable's lifetime | Weak keys for both owners, with one current profile per pair. `check-stop-projection.mjs` covers reuse, 100 replacements, return to an earlier profile, unknown stops, and distinct owners. |
| Release checks verified package versions but not the CI tag name | A differently named tag could package and publish the wrong declared version | Tagged CI runs require `v` followed by the package version. |
| Engine failures could reject a desktop protocol handler without an explicit response | Unavailable-engine requests depended on Electron's rejection handling | Return a structured 503; the actual-process recovery check verifies this response after exhausting the restart budget. |
| Matrix reference used implementation vocabulary for returned journeys | Readers needed algorithm context to interpret ordinary output | Replace witness/materialization wording with journey/assembly where equivalent; define necessary algorithm terms in the architecture guide. |
| Selected-journey geometry copied or traversed more shape data than the returned segment needed | Assembly could dominate the native timetable query | Load numeric shape buffers natively, prune exact alignment candidates, bound range sampling and combine geometry cleanup/distance work. Native materialization and route-geometry checks preserve sampling and route outputs. |
| Numeric whole-unit fare parsing initialized localized currency formatting | The first fare-bearing response paid a presentation setup cost after the inner route timer ended | Use a conservative exact-integer fast path; retain currency-specific validation for fractional and large amounts. The fare suite checks every runtime-supported currency and integration with imported catalogs. |

Runtime and projection regressions run in `check:national-runtime`, included in
`check:release`. Existing Route/Matrix and lifecycle suites check the integrated
behavior. Cache eviction changes preparation reuse, not routing objectives.

## Remaining cost centers

These are mechanisms visible in code, not ranked measurements of production
latency. Use the [timing boundaries](performance.md) before making speed claims.

| Layer and source | Cost or constraint | Decision for this freeze |
| --- | --- | --- |
| City compilation and GTFS coordinator: `src/server/national-gtfs-store.mjs` | Import, source validation, transfer construction, and active-service preparation remain substantial first-use work | Preserve atomic publication and identity checks; separate Build, reopen, and resident measurements. |
| Street preparation: `src/server/national-osm-store.mjs`, `native-routing-kernel.mjs` | Opening validates graph arrays and required indexes; older ephemeral Drive Cities rebuild the hierarchy | Retain validation; new City builds already persist Drive structures. Rebuild older Cities when persisted preparation is needed. |
| Worker pool: `src/server/runtime/route-worker-pool.mjs` | Synchronous native work serializes jobs within a worker; cancellation can eventually require a restart and renewed preparation | Preserve bounded cancellation and memory-pressure behavior. Increasing worker count can multiply graph/timetable memory. |
| Timetable kernel: `native/vigo-routing-kernel/src/timetable.rs` | Shared scans reduce repeated search, but boarding-cap states and optional journey reconstruction still consume work and memory | Preserve exact objectives and directed access. Large shared forward/reverse fixtures validate semantics, not universal throughput. |
| Matrix output: `src/server/national-gtfs-store.mjs`, `src/cli/vigo.ts` | Dense results require one row per pair; optional geometry adds work even when search is shared | Prefer scalar output when legs/geometry are unnecessary. Serialization belongs in caller latency measurements. |
| Selected-journey assembly: `src/server/national-gtfs-store.mjs`, `src/server/gtfs/route-results.mjs` | Native shape loading and alignment still leave selected-row lookup, range sampling and itinerary-object assembly | Retain the explicit boundary; native search timing alone excludes this work. Fare annotation also occurs outside the inner route timer. |
| Realtime: `src/server/gtfs/realtime-timetable.mjs` | A changed or newly invalid snapshot requires reconstruction and indexing | Preserve captured-clock validity and scheduled isolation; measure unchanged and changed snapshots separately. |
| Renderer and map: `src/App.tsx`, `src/VigoMap.tsx`, `src/map/` | Large feature replacement, geometry decoding, and render effects can dominate visible response | Retain lazy decoding and serialized source updates; interaction checks cover refresh isolation and small layouts. |

## Follow-up repairs

Studio now connects multiple GTFS-RT endpoints and retains the selected static
source on every record. Stop-specific delay no longer propagates backward.
Unknown relationships, unordered stop sequences and oversized snapshots are
rejected. Individual source failures remain visible through routing coverage.
The [method audit](realtime-audit-0.4.2.md) records the complete findings.

Downloads, decoding, reconstructed timetables, worker queues and restart attempts
have finite limits. The actual-process recovery checks replace substituted
workers and clocks. No native search or provider response is fabricated.

## Cleanup decisions

The initial exported-symbol scan found no single-occurrence exported function, class,
or constant candidates across tracked source, tests, scripts, and public entry
points. The initial exact normalized 12-line block scan found no cross-file duplicate
blocks above its 380-character threshold in source. These limited checks do not
detect every unused path or semantic duplicate. TypeScript already enforces
unused locals and parameters.

Do not remove the LAMP saved-study reader, replay inputs, model-history filters,
or old City compatibility solely because their names look historical. They have
retained readers, runtime consumers, or explicit format behavior. Vendored CCH
code and its notices remain a separately maintained dependency.

The large GTFS coordinator, API entry point, App component, and native kernels
remain maintenance risks. Extract future modules by ownership of store identity,
cache lifetime, request state, or search workspace. A line-count-driven split at
the freeze would move complexity without proving a behavior improvement.

The follow-up removed 26 redundant test/fixture files and over 6,000 net lines
of simulated infrastructure before this final pass. This pass also removes the
duplicate URL parser and an enum test loop that mirrored the lookup itself,
while extending real multi-source integration and vehicle identity checks.
Scratch imports, captures, temporary profiles, logs and superseded archives are
removed after verification. Final screenshots and their public source provenance
remain in documentation; the final distributable remains under `release/`.

## Freeze verification

Run `npm run check:release`, `npm run check:studio-runtime`, Rust tests and
Clippy, then `npm run release:studio` on the target host. Build the printable
guide with `npm run docs:developer-guide`. The release check also verifies source
publication boundaries and version consistency. Generated binaries, test logs,
and archives stay outside tracked source.

A local tag identifies the reviewed source revision. It does not establish
foreign-platform validation, remote publication, signed provenance, live feed
accuracy, or performance on an untested City. The release workflow performs the
supported-platform builds and attestation when dispatched or triggered remotely.

The initial local freeze on 26 September 2026 on macOS ARM64 passed the full release suite, Studio
interaction suite, all 16 Rust tests, Clippy with warnings denied, and the
Studio build/package/isolated-runtime/archive checks. The printable guide
compiled to 10 pages. Source checks ran on Node 26.7.0, which satisfies the
declared minimum; the CI configuration pins Node 24.18.0 and was not rerun
remotely in this audit. Matching-tag acceptance and mismatched-tag rejection
were both exercised. Other operating systems and CPU targets remain unverified
by this local run.

The itinerary and fare follow-up reran the full release suite, Studio interaction
suite, production build, all 16 Rust tests, and Clippy with warnings denied.
Recovery verification now consumes each health response before deliberately
killing its Engine. After initial recovery-test timeouts, the complete Studio
suite and three further fresh-process recovery checks passed with that cleanup;
production recovery behavior was not changed. The initial timeout cause was
not independently isolated.
