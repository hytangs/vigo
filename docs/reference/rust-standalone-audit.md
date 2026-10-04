# Standalone Rust audit — 2026-10-03

The standalone adapter uses VIGO's existing Rust timetable, street, driving, shape-alignment, and surface kernels. This audit corrected differences in the surrounding request handling, result materialization, realtime preparation, and deployment behavior. The supported operations now pass the public-fixture checks below. This is a development build, not a claim of complete Studio compatibility or production capacity.

## Corrected behavior

| Area | Correction and retained regression evidence |
| --- | --- |
| Station selection | Selecting a station or child platform includes prepared station members. Map selections use coordinates. Differential routes cover parent and sibling platforms in both time directions. |
| Walking | Direct walking uses physical distance/speed. Transit access retains configured padding/overhead. Query walking speed reaches both Reach access and its surface. Tests use two City access policies and three walking speeds. |
| Route evidence | Results retain active stop sequences, route metadata, source-aligned GTFS shapes, and ride/walk/wait totals. Missing shapes and unverified walking geometry carry explicit provenance. Tests compare selected trips, stops, and geometry with the existing CLI. |
| Realtime | Freshness, trip identity, duplicates, cancellations, inferred terminal sequences, skipped calls, NO_DATA, and invalid predictions follow scheduled fallback semantics with diagnostics. Cached predictions expire; a source-clock crossing invalidates omitted-prefix fallback. A separate Rust test verifies removal of past-prefix boarding opportunities. |
| Traffic | Cache identities bind actual raw edge weights, even when a caller reuses its snapshot key. A two-query regression changes weights without changing the caller key. |
| Scenarios | Frequency timing follows the selected time model, defaults match the public interface, and reverse directions charge added-stop dwell at the correct stop. Tests cover exclusions, distance estimates, supplied runtimes, and frequency replacement. Explicit scheduled-trip offsets and permissions are exercised separately. |
| Input and output | Conflicting clocks, malformed fields, irrelevant CLI flags, invalid grids, unsafe CCH members, and oversized inputs are rejected. Saved JSON replaces its target atomically and preserves existing permissions. |
| HTTP lifecycle | Connections, headers, bodies, query queue, and responses are bounded. Header/body deadlines cannot be extended by sending small chunks. Slow bodies do not occupy the query worker. A deadline kills and reaps the worker, including when a full input pipe blocks dispatch. Idle crashes restart without needing a query. |
| Packaging | A fresh allowlisted directory prevents old output files from entering archives. The manifest hashes every payload file and the Rust source inputs; prior output is retained separately. The archive gate validates paths, member types, hashes, and the extracted executable. |

## Public validation

Observed locally on macOS ARM64 with Rust 1.97.1 and Node 24.18. Node builds synthetic Cities and runs the comparison interface; standalone queries run with an empty PATH and no Node runtime access.

| Check | Observed result |
| --- | --- |
| `test/check-standalone-parity.mjs` | 276 cases passed against the existing public CLI |
| `test/check-standalone.mjs` | 64 queries/checks passed, including immutable City contents and authenticated HTTP |
| `test/check-standalone-http.mjs` | 18 checks passed, including malformed framing, slow-body timeout, capacity, SIGSTOP, full stdin pipe, worker reaping, and idle-crash recovery |
| Standalone Cargo unit tests | 19 passed, including raster holes/disconnected components and realtime past-prefix behavior |
| Default Node-feature Cargo unit tests | 17 passed |
| Clippy | Both default and standalone features passed with warnings denied |
| Existing kernel suites | Native routing, native matrices, and Reach engine checks passed |
| `test/check-routing-accuracy.mjs` | Passed the existing synthetic independent-oracle checks for streets, driving, timetable queries, matrices, witnesses, and calendars |

The differential suite covers two walking-access policies, both time directions, stop and coordinate endpoints, zero/one-transfer constraints, parent stations, sibling platforms, direct-walk policy, calendar additions/removals, matrices, scenario surfaces, realtime fallback, and source geometry. Route/Matrix time comparisons allow the existing interface's 0.001-minute presentation precision. Reach cells allow 0.00051 minutes because the existing adapter rounds transit seeds before surface construction; null/reachable classification must match exactly.

Agreement between adapters does not independently validate their shared kernels. The existing accuracy suite has separate graph and raw-GTFS enumeration oracles, but those remain synthetic tests. No real-world ETA, source-feed completeness, physical station connectivity, fare eligibility, throughput, or memory-capacity claim follows from these results.

To reproduce in a development checkout, build the existing public CLI and native addon, build the standalone executable, and run `npm run check:standalone` with `VIGO_STANDALONE_PATH` set to it. Package with `python3 scripts/package-standalone.py`; then run `python3 test/check-standalone-package.py ARCHIVE.tar.gz`. That gate reruns all three adapter suites against the extracted binary. Node and Python are development tools; neither ships in the runtime payload. POSIX worker-stop/crash injection is skipped on Windows.

## October 4 follow-up

The table above records the original October 3 audit. An October 4 macOS ARM64 follow-up (Rust 1.97.1, Node 26.7.0 as the fixture/compiler host) passed 69 standalone checks, 63 prepared-data checks, 332 differential/regression cases, 18 HTTP lifecycle checks, 42 documentation/HTTP checks, and 23 standalone Cargo tests. Standalone Clippy passed with warnings denied. The additional cases compare current and expired access witnesses in both time directions, repeated matrix endpoints, cached/uncached requests, and two City access policies. They also verify that missing transit access skips the timetable scan without suppressing a requested direct-walk result. Public fixtures remain synthetic; these counts do not establish production capacity or field accuracy.

## Remaining compatibility boundaries

- City preparation from raw GTFS/OSM remains the existing compiler. The executable consumes an immutable prepared City.
- JSON uses the documented standalone schema. Studio/Python envelope compatibility, fare annotations, and Studio route-preference presentation are not implemented.
- Scenario editor branch selection and automatic retiming remain preparation steps. Supply explicit scheduled trips or compiled overlays for those changes.
- Realtime transit applies to Route; current public CLI and standalone Matrix/Reach do not provide realtime transit queries.
- Saved-result comparison currently accepts Reach surfaces. It verifies City revision and grid compatibility, not every experimental setting.
- The executable and container recipe are generic, but this local audit did not execute Linux containers or Windows binaries. Release CI is configured to check the corresponding targets. Public hosting and capacity testing remain deployment work.

The package manifest reports source dirty state. A dirty checkout artifact remains a development artifact even when its local checks pass. Nothing in this audit publishes or releases it.
