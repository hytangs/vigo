# Timetable query performance

The standalone Rust executable and Node interface use the same timetable kernel. Standalone transit Route requests obtain a journey through the shared Matrix kernel with one origin and one destination. Matrices can request scalar times or full journeys.

Journey construction allocates its scratch workspace lazily and retains it with the immutable timetable. Each source clears only the frontiers it touched; each boarding round visits only reached stops. Run generation tags separate rounds, sources, and requests, including wraparound. The workspace contains no cached answers. Changing direction, endpoint policy, or boarding limits still performs a fresh search. Replacing the timetable also replaces its scratch workspace.

Scalar Matrix queries prepare the common endpoint arrays once per batch and reuse the changing source or destination buffers. Validation and routing objectives are unchanged. Depart-at still shares a forward search per origin; arrive-by shares a reverse search per destination. Journey selection keeps the same dominance rules, run order, transfer rules, time horizon, and tie breaks.

For coordinate batches, journey rounds finish after every reachable target has attained its own exact scalar time bound. The final round completes before stopping, preserving boarding and walking ties. Targets without a route retain their blocked result. Selected-stop requests that permit terminal transfers keep the general round path. Endpoint projection also shares identical directed access searches within one batch, even when persistent endpoint caches are disabled; stop IDs remain part of the standalone endpoint identity. Each input still receives its own output row or column.

Arrive-by Route retains the scalar forward reachability envelope through successive capped and deadline certifications. Reuse requires identical origin and destination seeds, costs, departure, horizon, and terminal-transfer policies. Extending a deadline admits the remaining timetable events; contracting it keeps a conservative superset that exact rounds filter against the requested deadline. A new scalar search or a separately built forward envelope invalidates the retained identity. The reverse latest-departure search and exact deadline/boarding/walking certification still run.

Capped coordinate arrive-by searches first obtain the unrestricted latest
departure and seek a forward witness at that same boundary. They accept the
bound only when the witness reaches the deadline within the boarding cap; an
unrestricted blocked result also proves the capped result blocked. Otherwise
the existing layered reverse scan resolves the cap. A 1×1 Matrix uses this
same certified bound before its unchanged journey rounds. Work counters include
the proof and any fallback; no trip choice or tie criterion is removed.

Retaining scratch trades some resident memory for fewer allocations. Native `workspaceBytes` diagnostics include the journey arrays and their retained capacities. Scalar-only users do not allocate journey scratch.

## Coordinate routes and materialization

For capped fastest depart-at queries, the Node adapter permits the fused Rust call to return the selected access and egress witnesses, including walking geometry. The existing native guard uses this compact result only for certified one- or two-boarding routes. Uncapped queries, balanced preferences, departure-window alternatives, and arrive-by deadline certification retain the full candidate frontier. The change removes candidate conversion and subsequent path calls without limiting the search.

The standalone adapter retains immutable route metadata and trip-to-shape identifiers within each opened City. Journeys still reconstruct their active timetable stop sequence and geometry on every request. The metadata maps are bounded by the City's route/trip counts, are released with that City, and remain separate from endpoint or answer caches.

Compiled GTFS shapes and their geometric alignment candidates are retained separately in a City-owned least-recently-used store, limited to 4,096 shapes and 256 MiB of estimated geometry storage, matching the Node interface's shape-cache limits. Lookups examine the most recently used entries first. This avoids the much smaller standalone cache repeatedly evicting geometry on varied city-wide workloads; the larger upper bound can increase resident memory. Sizes are accounted again after alignment grows candidate data. Oversized shapes are used for the current request and released. Timetable paths, realtime stop sequences, and selected shape slices are still reconstructed for each journey; the store does not retain route answers.

The standalone store also retains up to eight exact stop-to-shape alignments per shape within the same byte budget. The complete active stop coordinates, including their floating-point bits, form the key. A changed realtime stop sequence cannot inherit the scheduled alignment. Materialization copies only the selected shape slice. Point endpoint roles use the shared two-worker native executor. Batch endpoint evidence remains typed and is shared for identical request endpoints; it becomes JSON only when a response includes that evidence.

Generic street geometry keeps the original directed snap pairs, raw path distance, and tie rules. CCH path reconstruction shares one forward sweep across the candidate destinations for a source. Every destination still performs its exact backward sweep and shortcut reconstruction. The shared state is scoped to that batch call, so a subsequent source or metric never inherits it.

## Standalone startup and output boundaries

The standalone City reader deserializes the used access-context fields directly into native structures and skips unused projections. Scheduled transit can load the compiler's portable active-service snapshot after checking database identity, access policy, active services, transfer projection, dictionaries, canonical array layout, and native kernel invariants. Missing or invalid optional sidecars fall back to the existing SQLite preparation path. Realtime and modified street-transfer policies use source preparation. `timing.timetableSource` exposes the selected preparation path; `timing.totalMs` still excludes process startup and initial City opening.

Rust Matrix defaults to full display and walking-evidence detail. Node Matrix returns compact timed witnesses. For a comparable analytical workload, request Rust `journeyFormat: "compact"` with `includeJourneys: true`, or request duration-only matrices from both. Compact changes response detail only: the same native journey search runs, with the same trips, boarding sequences, clocks, and transfer count. Full remains the default and the required format for geometry and walking-evidence consumers. The stream uses bounded 64 KiB serialization scratch instead of retaining another complete encoded response.

## Reproduce a kernel comparison

Build each version with `npm run build:rust-routing-kernel` using the same toolchain and release settings. Save the earlier `native/vigo-routing-kernel/vigo-routing-kernel.node` under a separate path before building the changed version. Then run:

```sh
node scripts/benchmark-timetable-queries.mjs --reference /path/to/before.node --samples 51 --output /path/to/comparison.json
```

The script generates deterministic synthetic timetables with 256 and 4,096 served stops. It measures 1×1, 16×16, 1×128, and 128×1 requests in both time directions, with and without journeys and terminal transfers, using a three-boarding cap. Baseline and changed calls alternate execution order. Every call must preserve times, blocked cells, and full journey contents. Reports retain search counters separately because an optimization can reduce the work. They also include individual samples, medians, p95, native timing, and resident workspace bytes.

The outer timing includes Node-API argument/result conversion. Native timing excludes that conversion. Both exclude City loading, endpoint street routing, geometry, fares, JSON serialization, HTTP, and process startup. No answer cache is used; the prepared timetable and scratch memory remain resident. The first request for a workload is measured on the existing kernel and is not a cold-process or cold-filesystem measurement.

## Quality checks

`test/check-timetable-query-reuse.mjs` compares a reused kernel with fresh kernels across changing endpoints, time directions, boarding limits, endpoint transfer policies, empty access, and invalid requests. Rust unit tests exercise generation wraparound and recovery after a journey-bound error. Run the existing native matrix, independent routing-accuracy, transfer, equal-time, and standalone parity checks as well: agreement between two adapters does not independently prove the shared kernel correct.

For workload measurements, use complete caller-visible Route and Matrix requests on representative prepared Cities. Alternate identical requests between resident baseline and candidate processes, exclude a stated warm-up round, retain all responses, and compare complete route semantics. Keep cold loading, street access, timetable search, journey/geometry construction, serialization, and transport separate. The standalone engine already moves request execution into Rust; additional migration should target a measured remaining cost and preserve each interface's supported behavior. Private City inputs and workload evidence belong in the private benchmark repository.

## Standalone query execution

Capped coordinate point queries use the same destination-directed exact certifier as Node Route. Arrive-by first proves the latest departure, then certifies boardings, walking, and actual arrival within the deadline. Unsupported cases retain shared Matrix reconstruction; selected-stop and unbounded queries retain that path. Full geometry and walking evidence remain part of the response. Equal objective values can select different source-valid transfer stops; check source legs and objectives separately from byte equality.

Transit matrices group repeated endpoint identities before timetable search and journey construction, then restore every requested row and column. Coordinates and stop identity must both agree; different co-located stops cannot share permissions. Full and compact output remain explicit choices, and scalar requests retain their original dimensions.
