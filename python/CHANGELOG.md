# Changelog

## 0.5.2

- Prefer the most recently used matching resident worker after parallel batches, avoiding repeated mode preparation in subsequent serial queries.
- Add ordered `City.iter_run` and `Scenario.iter_run` batches with bounded resident-process concurrency; `run(sequence, workers=2)` also supports parallel batches. Serial execution remains the default.

- Maintain Python in the shared VIGO repository with independent package builds and same-commit engine integration.
- Support opt-in Route alternatives, ranking and arrival slack; retain choice details and alternative-search metadata.
- Decode resident UTF-8 response bytes directly with the optional accelerated decoder, avoiding an intermediate Python string. Standard-library fallback, request validation and full itinerary detail remain unchanged.


## 0.5.1

- Reuse idle Engine processes across dates when per-request dates are advertised; retain legacy date-specific streams for older compatible engines.
- Add `Result.export_tables()` with bounded additional memory, JSON-encoded nested CSV fields and headers for empty outputs. Stage serialization before replacing existing files.
- Add `Result.iter_journeys()` and `Result.iter_legs()` for analysis tables, retaining blocked outcomes, Matrix identifiers and scenario provenance. Geometry is optional in leg records.
- Add a runnable Result-to-CSV example and pandas decomposition recipe.
- Align the Python package version with VIGO 0.5.1; Engine API and City/Result schemas remain unchanged.

### Additional changes

- Remove the unused production one-shot query helper and use one query stream for Route, Matrix, and Reach.
- Require the current Engine API and trace capabilities; remove obsolete point-shape handling, index-only Matrix comparison, and non-JSON Result-copy fallback.
- Align with Engine 0.5 walking Reach, surface sampling, reached street edges, and structured Matrix stop references.
- Reduce Result copy overhead, add incremental `iter_rows()`, and export CSV without duplicating the matrix.
- Add optional `speed` installation extra for accelerated resident-response JSON decoding and a reproducible wrapper benchmark.
- Compare direct walking by default in Route and Matrix; `require_transit_ride=True` retains a boarding requirement.
- Isolate packaged Studio runtime launches from host Node options, module paths, and library injection settings, as for bundled headless runtimes.
- Preserve detailed journey results consistently in resident and one-shot calls to engines that use the compact public result format.
- Add optional `vigo.build(..., progress=True)` stage and elapsed-time display through `tqdm`, including timeout and interruption cleanup.
- Define raw Build, raw files to first answer, prepared-City reopening, and full Python query timing separately.

## 0.3.1 — 2026-09-11

Stabilization release; public API and data schema versions remain unchanged.

- Discover complete packaged runtimes on macOS, Linux, and Windows.
- Test supported Python versions on all three operating systems and run public integration fixtures against packaged VIGO.

- Explain reusable City packages, portable prepared state, and the distinction between reopening and rebuilding.
- Reuse successful runtime capability checks until the executable or command file changes.
- Require resident Matrix support and remove the old one-shot Matrix path.
- Read current City metadata fields directly and remove automatic discovery of the retired VIGO.app name.
- Keep installation and examples in this repository; expand the Python and runtime references.

- Preserve native plan JSON for compact Result export, avoiding repeated geometry encoding while keeping independently mutable Python exports and compatibility with older runtimes.

## 0.3.0

VIGO 0.3 unifies the product around one model:

```text
City -> Scenario -> Route | Matrix | Reach -> Result
```

- Renamed the Python package to `vigo`.
- Replaced store-pair objects with one complete City.
- Added immutable Scenario objects tied to one City revision.
- Replaced separate batch and one-origin analysis functions with Route and Matrix.
- Renamed network range analysis to Reach.
- Added one Result shape, local comparison, export, and background jobs.
- Removed the Python pass-through command and runtime installer. VIGO Studio and the VIGO command line are installed independently.
- Bound the per-City resident Route process pool and reclaim idle dates automatically. Queries retain their process until completion; closing a City waits for active Route calls.
- Add transit requirements, search horizons, transfer caps, and optional Matrix journeys, including arrive-by and shared many-to-one queries.
- Add `disable_cache` to Route and Matrix for transit street-access and path measurements. Keep result accessors independent while avoiding redundant copies during result construction and JSON/GeoJSON export.
