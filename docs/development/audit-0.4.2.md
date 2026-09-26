# Architecture audit for 0.4.2

This is the historical audit of the frozen `v0.4.2` tag. Subsequent test pruning
and runtime changes are recorded in [runtime limits and recovery](runtime-recovery.md);
test filenames below refer to the tagged revision.

This review covers the Engine and Studio repository: import and City storage,
native adapters and kernels, worker scheduling, CLI and HTTP boundaries, React
and map surfaces, agency research interfaces, documentation, and release checks.
The Python wrapper, private comparisons, and manuscript are separate repositories
and are outside this freeze. API 1.0, City format 1, and Result schema 1 remain
unchanged.

The audit combines source inspection, repository-wide export/reference and
duplicate-block scans, and the repository's regression suites. Static scans are
candidates for investigation, not proof that every runtime path is reachable or
that all defects have been found. No new comparative benchmark was run.

## Repairs included in the freeze

| Finding | Consequence | Repair and regression |
| --- | --- | --- |
| Worker message transfer could throw after setting the active job | An immediately rejected request left the worker busy; a queued failure could escape from the completion handler | Catch transfer failure, clean cancellation listeners, reject that job, and continue the queue without restarting the prepared worker. `check-route-worker-recovery.mjs` covers immediate and queued failures and subsequent success. |
| A timetable retained a string-keyed map of every street identity/access-profile projection used with it | Repeated policy changes could accumulate full stop-mapping arrays for the timetable's lifetime | Weak keys for both owners, with one current profile per pair. `check-stop-projection.mjs` covers reuse, 100 replacements, return to an earlier profile, unknown stops, and distinct owners. |
| The mock worker added ArrayBuffer memory to external memory | Test diagnostics double-counted a subset of external memory and differed from production | Match production's heap-plus-external estimate; retain separate ArrayBuffer reporting. |
| Release checks verified package versions but not the CI tag name | A differently named tag could package and publish the wrong declared version | Tagged CI runs require `v` followed by the package version. |
| Matrix reference used implementation vocabulary for returned journeys | Readers needed algorithm context to interpret ordinary output | Replace witness/materialization wording with journey/assembly where equivalent; define necessary algorithm terms in the architecture guide. |

Both new regression fixtures run in `check:national-runtime`, included in
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
| Selected-journey assembly: `src/server/gtfs/route-results.mjs` | JavaScript still reads selected source rows and assembles output after native search | Retain the explicit boundary; native search timing alone excludes this work. |
| Realtime: `src/server/gtfs/realtime-timetable.mjs` | A changed or newly invalid snapshot requires reconstruction and indexing | Preserve captured-clock validity and scheduled isolation; measure unchanged and changed snapshots separately. |
| Renderer and map: `src/App.tsx`, `src/VigoMap.tsx`, `src/map/` | Large feature replacement, geometry decoding, and render effects can dominate visible response | Retain lazy decoding and serialized source updates; interaction checks cover refresh isolation and small layouts. |

## Cleanup decisions

The exported-symbol scan found no single-occurrence exported function, class,
or constant candidates across tracked source, tests, scripts, and public entry
points. The exact normalized 12-line block scan found no cross-file duplicate
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

The local freeze run on macOS ARM64 passed the full release suite, Studio
interaction suite, all 16 Rust tests, Clippy with warnings denied, and the
Studio build/package/isolated-runtime/archive checks. The printable guide
compiled to 10 pages. Source checks ran on Node 26.7.0, which satisfies the
declared minimum; the CI configuration pins Node 24.18.0 and was not rerun
remotely in this audit. Matching-tag acceptance and mismatched-tag rejection
were both exercised. Other operating systems and CPU targets remain unverified
by this local run.
