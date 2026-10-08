# Version history

## 0.5.0

Clearer journey comparisons, shared interface styling, compact routing snapshots and Studio responses, and driving preparation on demand. See [release notes](docs/releases/0.5.0.md).

Use the native HTTP service with verified container deployment and slim CLI packages. Validate benchmark responses by endpoint, preserve capacity errors, restore cold-store walking proofs, and recover complete packages after replacement failures. Correct missed Reach grid crossings and walking comparisons; retain raw routing evidence separately from display estimates.

Remove old snapshot readers and the hidden `_route-stream` protocol. Use the documented `stream` command and rebuild prepared Cities for the standalone runtime. Python 0.5 requires Engine 0.5.

## 0.4.4

Correct interior street routing and partial Reach boundaries; add destination-grid and walk-only Reach, prefer faster direct walks by default, and update Studio. See [release notes](docs/history.md#vigo-044).

Exclude bus-platform area outlines from the linear street graph, while retaining mapped platform centre lines. Discover nearby reciprocal street segments even when both endpoints lie outside the vertex search. Street stores now use schema v6; rebuild older Cities from their source inputs to apply the graph correction and regenerate access profiles and street transfers.

Preserve `allowLongWalk` in Node Matrix and legacy streamed Route requests, so an explicit direct-walking cap reaches the routing engine.

Honor `maxTransfers` in Node Reach for coordinate origins, selected stops, and planned service scenarios. Preserve and validate the cap through the desktop HTTP API. Let individual streamed Route and Reach requests override the process transfer limit, as Matrix requests do.

Build Reach surfaces from vehicle arrivals and directed station exits. Charge station pathway time and distance before street expansion, and keep the whole final walk within the endpoint allowance. Apply the same exit handling in Node and standalone Rust. Retain requested standalone node evidence up to its documented diagnostic limit and report truncation.

Retain native library code across routing-worker retirement, update Node bindings for lifecycle safety, and exercise repeated process exits and worker replacement with resident kernels and typed arrays.

Rank departure-window journeys with equal arrival times by fewer transfers, then less walking, before leave-to-arrival duration. Use the same order in Studio, show total time from the requested departure on route cards, and identify zero-margin changes of vehicle in the itinerary.

## 0.4.3 — 2026-10-04

Final release verification includes the walking corrections below. API 1.0, City format 1, and Result schema 1 remain unchanged.

Enforce a distance-based walking-time floor on published stop transfers before Route and Matrix search, including arrive-by and station access. Preserve explicit GTFS pathway traversal times. Invalidate older prepared walking policies, and reject them in standalone Rust.

Read access and barrier tags on both dense and ordinary OSM nodes, correct signed ordinary-node IDs, and exclude restricted pedestrian links, `foot=use_sidepath`, and unresolved conditional access. Preserve driving permissions. Older street stores require a fresh source build. See [walking evidence and migration](docs/reference/walking-evidence.md) for the source contract, conservative exclusions, and public regression checks.

Preserve missing GTFS interior-node coordinates, keep their directed pathway topology, and mark incomplete station geometry in both runtimes instead of drawing a detour through `(0, 0)`. The routing store moves to schema v3; rebuild old Cities from source. Exclude pathways with no usable traversal cost while preserving declared station connectivity; never invent zero-second interior links.

Add explicit arrival reserves for arrive-by Transit Route and Matrix in both runtimes. Preserve the original search start and actual journey clocks, expose both deadlines, and label margins as uncalibrated. Improve capped coordinate arrive-by with a certified unrestricted bound and exact fallback. Reject invalid native run continuity/time ordering and repair standalone stop-sequence materialization for selected bridge alightings. See [travel-time uncertainty](docs/guide.md#travel-time-uncertainty).

Reuse the selected coordinate access/egress path when its query token is still current, and skip impossible transit scans when an endpoint has no access. Preserve full journey detail, directed station evidence, and the exact fallback for expired matrix frontiers. Start the CLI tutorials in Boston with MBTA and OpenStreetMap downloads, Harvard Square–South Station queries, arrive-by, matrices, and resident streaming.

Add a standalone Rust CLI/HTTP runtime and headless Engine and CLI distributions. Keep resident Route, Matrix, and Reach requests behind explicit input, queue, body, response, and worker-deadline bounds; recover after a stalled worker.

Reuse native query workspaces, retain matching forward reachability proofs through arrive-by certification, share duplicate batch endpoint searches, and stop journey rounds after all reachable targets attain their exact time bounds. Retain bounded immutable Rust shape data while reconstructing each active itinerary. Preserve search objectives, transfer caps, directed access, and routing-quality checks.

Use the shared exact point certifiers in standalone Rust and eliminate repeated Matrix search and journey construction for identical endpoints. Restore every requested row and column, preserving distinct stop identities and the selected output detail.

Load validated prepared service timetables in standalone Rust, retain only the access-context fields it uses, and keep endpoint evidence in native structures until response construction. Share street-path source sweeps across candidate destinations, retain bounded exact shape alignments, and reuse stream encoding buffers. Keep full Rust journey detail by default and offer explicit compact timed matrix witnesses for analytical callers.

Correct standalone station-walking evidence to follow the selected entrance/pathway and distinguish verified street segments from unresolved station interiors. Add extracted-package, source-parity, and failure-recovery checks. API 1.0, City format 1, and Result schema 1 remain unchanged; see the [freeze notes](docs/history.md#vigo-043) for scope and release limits.

Keep active GTFS departures when editing an existing Reach branch unless a frequency change is explicitly selected. Return complete-network Reach surfaces and optional directed street-edge evidence. Include a verified direct walk as a point-to-point competitor within the shared walking budget.


Earlier release notes remain available in Git history.
