# Verification record

This record lists the checks every VIGO release passes and what they establish. It ships in the engine archive as `AUDIT.md`. Test results for a particular build are in its release workflow run; the archive's `manifest.json` names the source commit they ran on.

## What a release runs

The release workflow builds the engine, the compiler, Studio and the Python wheels from one tagged commit, on Linux x64 and ARM64, macOS ARM64 and Windows x64, and runs on each platform:

| Check | What it covers |
| --- | --- |
| `npm run check:release` | Public-source and release-file rules, the documentation, the native kernels, Studio, security, the routing runtime and the transport atlas |
| `npm run check:rust-workspace` | Model and schema tests, algorithm tests, strict Clippy and the routing crate's dependency boundary |
| `cargo test` and `cargo clippy -D warnings` (standalone features) | Engine unit tests and lints |
| `npm run check:corpus` | A frozen corpus of routing cases with expected answers |
| `npm run check:standalone` | The engine on public synthetic Cities: Route, Matrix, Reach, scenarios, Flex, realtime, wheelchair, bicycle, HTTP lifecycle, Monte Carlo, documentation examples, and the permanent [prepared-data gate](city-format.md#release-gate) |
| `scripts/package-standalone.py`, `test/check-standalone-package.py` | Builds the archive from an allowlist, hashes every file, and reruns the engine suites against the extracted executable with an empty `PATH` |
| `npm run check:cli-package` | The compiler archive, extracted |
| `npm run check:studio-runtime` | Studio's packaged runtime |
| Python wheel checks | Unit, lint, documentation and live integration against the bundled engine, without host Node |
| Container checks (Linux) | The release image and Compose file, as in [Deploy the routing engine](../guide.md#deploy-the-routing-engine) |

## What the engine suites check

- **Routing parity.** The engine and the compiler return the same public Results across both time directions, stop and coordinate endpoints, transfer caps, parent stations, sibling platforms, direct-walk policy, calendar exceptions, matrices, scenario surfaces, realtime fallback and source geometry.
- **Independent algorithms.** Separate graph and timetable implementations, which never supply production answers, check walking and driving shortest paths, earliest arrival and latest departure, every stop pair at each boarding boundary, transfer rules and forbidden transfers. See [Checking routing accuracy](../developer.md#checking-routing-accuracy).
- **Inputs and outputs.** Conflicting clocks, malformed fields, unknown or irrelevant options, invalid grids, unsafe index members and oversized inputs are rejected. Saved output replaces its target atomically.
- **HTTP lifecycle.** Bounded connections, headers, bodies, queue and responses; read deadlines that small chunks cannot extend; slow bodies outside the worker; deadlines that stop and replace the worker, even when its input pipe is full; recovery after an idle crash. POSIX stop and crash injection is skipped on Windows.
- **Realtime.** Freshness, trip identity, duplicates, cancellations, skipped calls, `NO_DATA`, invalid predictions, expiry, past-prefix removal and alerts, each with its diagnostics.
- **Traffic.** Cache identity follows the actual edge weights, even when a caller reuses its snapshot key.
- **Documentation.** Every request on the [engine reference](../guides/rust-standalone.md) runs against the engine; response excerpts, flags, request fields and environment variables are checked against the executable and its source.

## What passing does not establish

The checks use small public synthetic inputs. Passing them supports the tested model and interfaces. It does not establish:

- real-world arrival accuracy, completeness of a source feed, or physical station accessibility;
- fare eligibility beyond the published GTFS rules;
- throughput, latency or memory on a particular City and machine;
- behavior on platforms the release did not test.

Agreement between the engine and the compiler does not by itself prove their shared kernels correct; the independent checks address that, within their synthetic fixtures.

## Reproduce locally

From a source checkout with the documented toolchain:

```sh
npm ci
npm run build:cli-runtime
npm run build:standalone
npm run check:standalone
npm run package:standalone
python3 test/check-standalone-package.py
```

Node and Python are development tools here; neither ships in the engine archive. A package built from uncommitted source is marked `dirty: true` in its manifest and is a development build.
