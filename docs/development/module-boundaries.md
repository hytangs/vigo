# Module decomposition boundaries

VIGO's routing ownership and data lifecycle are stable, but several
implementation files remain too large for comfortable external contribution.
Refactoring should follow existing runtime boundaries and preserve behavior;
it should not introduce a second router or change persisted formats casually.

Two extractions are complete:

- local bind, peer-address, Host, Origin, and CORS policy lives in
  `server/local-http-security.mjs` with a focused contract check; and
- deterministic GTFS/OSM fixture generation lives in
  `scripts/lib/cli-fixture-inputs.mjs` and is shared by CLI tests and the public
  smoke benchmark.

The remaining extraction order is:

| Current unit | Next boundary |
| --- | --- |
| `server/national-gtfs-store.mjs` | Separate import schema and compilation, service-date activation, artifact lifecycle, and result materialization. |
| `src/App.tsx` | Separate project hydration, workspace orchestration, and top-level shell composition. |
| `native/vigo-routing-kernel/src/lib.rs` | Continue moving snapshot parsing, street query kernels, CCH access, and Node-API conversion into owned Rust modules. |
| `native/vigo-routing-kernel/src/timetable.rs` | Separate packed-input validation, active-service construction, scalar scans, Pareto scans, and reconstruction. |
| `server/vigo-api.mjs` | Separate route registration by project, import, routing, analysis, and maintenance domains. |
| `src/VigoMap.tsx` | Separate source/layer construction, interaction state, and map lifecycle adapters. |

`npm run check:maintainability` freezes the current byte ceilings for these
units. It is a stop-growth guard, not evidence that decomposition is finished.
Lower a ceiling after each extraction; do not raise it to accommodate features.
