# VIGO 1 Poros readiness

Audit date: 2026-10-19. Status: development preview. The Studio redesign and
native routing capability are assessed against the maintained [developer guide](../developer.md).
The completed architecture proposals have been retired; the limitations below remain explicit.

## Fixed in this audit

- Complete City overview construction now runs in Rust on the native worker
  pool. Read-only SQLite traversal, shapes, representative-trip recovery and
  service statistics no longer block Node during that pass. The compatibility
  catalog/preview and per-route timetable detail still use Node SQLite.
- Reach display and cell geometry now run in Rust with explicit raster/work/
  vertex budgets. Indexed ring containment avoids an all-pairs scan on fragmented
  rasters. Fill/outline agreement, holes, diagonals and sample classification
  remain covered. Travel-time rasters and published prepared-data layouts are
  unchanged.
- Removed obsolete JS overview queries and boundary algorithms. Retained
  overview fixtures record their pre-removal semantics. Import completion is
  consolidated across paths, uploads and retries.
- Background City refreshes no longer navigate to an old City, overwrite a
  newer refresh, resurrect a removed City or survive a Studio reset. Late
  imports cannot replace another City's feed/messages/job flags. Polling is
  scoped to City plus job and stops on reset.
- About identifies Poros as a development preview. Package versions remain
  independently controlled; the UI name is not a 1.0 release receipt.

## Remaining architecture gates

| Gate | Current gap | Evidence required before closing |
| --- | --- | --- |
| M1: pure workspace | All Rust packages now share one workspace and lockfile. The runtime crate still owns street/access/drive kernels, orchestration and transports. The public model is not the whole internal executable request model. | Extract ownership into the planned crates; retain addon/standalone parity, corpus and pure routing dependency checks. |
| M2: packed City | The planned pack reader/writer and executable pack/inspect workflow have not passed their exit. | Identical results with/without packs; old City compatibility; matched open/first-query timings, memory and pack size. |
| M3: native build | Rust compiles GTFS connections, but ZIP/CSV admission, calendars, source scoping, OSM construction, publication and build orchestration still depend on JS. The standalone executable does not build a City from raw inputs. | Native raw-data build; stage-by-stage admitted-row and routed-result equivalence; crash/rollback tests; matched time, RSS and temporary storage; permanent 0.5 bidirectional gate. |
| M4/M5: unified runtime | Studio uses the Node internal API around native operators. It is not yet a client of the planned unified Rust server. | One authoritative request/validation/job model; client parity; cancellation, progress and restart acceptance through Studio and public interfaces. |
| M6: final removal | Active build/runtime owners cannot be deleted until their replacements are integrated. | Remove superseded paths and selectors only after retained fixtures and public interfaces prove replacement. Preserve historical artifacts. |

React/TypeScript interaction, localization, native dialogs and presentation are
intentional application responsibilities. A file's language or age does not
make it obsolete. The active source import graph was inspected; deletion in
this audit targets replaced algorithms, not arbitrary JS/TS files.

## Remaining Studio computation

Scheduled-day preparation and trajectory work still crosses the Node/browser
boundary; full-day schedule loading merges route patterns into renderer state.
Per-route SQLite analysis still runs synchronously. Search ranking still scans
local TypeScript catalogs, including the stop list. Reach block-interior display
estimates remain JS. These are the next measured migration targets. Theme token
aliases also remain, although they are a maintenance task rather than a routing
correctness blocker.

## Real-world acceptance still required

- **Sustained operation:** exercise several large Cities for hours, with City/date
  switches, repeated analysis, feed replacement, sleep/wake and engine failures.
  Record memory growth, first-map/first-journey time and latency distributions.
  Passing finite runtime fixtures is not a soak test.
- **Resource bounds:** measure full-day schedules, overview/catalog copies,
  per-route caches, concurrent analysis and City builds under limited memory and
  disk space. Existing entry/vertex limits do not establish a process RSS bound.
- **Traffic:** retain independent directed-road matches across additional Dutch
  regions and junction types. The existing Amsterdam sample is bounded; it does
  not establish national coverage, grade-separated road conflation, partial-edge
  assignment or turn-specific restrictions. NDW automatic polling currently
  serves a single City through the standalone server. Studio feed controls and
  multi-City integration are separate work.
- **Capability exits:** evaluate C1–C6 individually. Existing scenarios, street
  modes and polling do not imply completion of unified overlays, the full street
  mode set, Flex, regional accessibility/equity or every scenario modification.
  Preserve explicit limitations on unsupported data.
- **Desktop delivery:** test the final packaged build on supported operating
  systems, including folder permission recovery, offline maps, upgrades,
  save/reopen and clean-machine installation. Align versions and obtain release
  signing/notarization and published artifact checks when preparing a release.

## Reproducible checks

`node test/check-gtfs-analysis-store.mjs` compares sync/async native overview
results with retained JS outputs, including scoped and missing stores.
`node test/check-reach-geometry.mjs` checks mathematical topology and admission.
`npm run check:studio-runtime` covers ownership races and the connected UI.
`npm run check:reach-scenarios`, `check:traffic`, `check:corpus`,
`check:format-050` and standalone parity protect existing behavior.

The public synthetic geometry profile is
`node scripts/profile-reach-boundaries.mjs`. An optional first argument points
to a retained historical boundary module for comparison; this is a measurement
input, never a production fallback. Keep real-City inputs and local measurement
outputs outside the public repository. Report timing boundaries and source
revisions with every performance comparison.
