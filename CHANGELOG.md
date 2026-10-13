# Version history

## 0.5.2

- Bundle the searchable guide and CLI/HTTP reference in Studio Settings. Read offline in the selected light or dark appearance; retain browser links to source documents and schema downloads.
- Update current documentation and release examples to 0.5.2. Replace obsolete 0.4.2 screenshots with a link to their archived release record.
- Remove Studio Ask, City agency skills, and their conversation tests and evaluation fixtures. Retain Network, Routes, Route, Analyze, and existing City evidence.
- Keep the Network tool registry focused on service inspection. Remove its duplicate journey, walking-outing, place-search, and general web-search adapters; structured routing interfaces continue to own Route, Reach, and Matrix.
- Move optional model settings and evidence export into the service briefing. Restore previously saved Ask tabs to Network and retain notebook records without migrating City data.
- Save Studio journeys, Reach results, and City comparisons as JSON, GeoJSON, or CSV. Preserve service clocks, source geometry, and request/result records.
- Add readable itinerary downloads, dated route filenames, and a compact Save control with download/error feedback. Save every completed journey alternative together, retaining selection and initial waiting separately from journey duration.
- Show City comparison differences from the first feed at the selected cutoff, with matching JSON/CSV summaries. Keep missing stop counts and incompatible query settings unavailable; reject incomplete geometry and preliminary exports.
- Correct scenario improvement counts at shorter cutoffs and display slower or lost cells alongside gains. Retain raw counts before display rounding and prevent saving preliminary computations. Treat unavailable route timings as unavailable.
- Use an exact monotone queue for reached-street propagation, retaining the existing ordering for equal times and a heap fallback for nonmonotone inputs.
- Parse only the standalone stop fields consumed by routing when opening a prepared City. Preserve legacy null/type checks and all published 0.5 layouts.
- Add service activation and preparation-stage timings to standalone profile/trace output; keep setup, source/realtime, indexing, and kernel construction distinct.
- Consolidate Node timetable readiness reporting for compiled and loaded kernels. Reuse up to 64 exact next-departure diagnostics within the active service context, clearing them on service changes and source replacement; report their lookup time separately in Reach diagnostics.
- Reject strictly later scalar timetable candidates before computing tie-breakers, and skip boarding checks when every reached label is still in the future. Capped point queries omit intermediate predecessor writes while retaining exact final journey certification, transfer rules, and equal-time ties.
- Avoid sending unused search diagnostics through the native formatter for ordinary Node Route responses. Preserve full journeys, geometry, realtime metadata, arrival reserves, and all requested diagnostic levels.
- Expose public or authorized endpoint pedestrian access when importing streets in Studio, including uploads and retries. Retain public access by default and remove stale endpoint overlays when replacing streets.
- Correct endpoint overlays to reproduce the public graph's node restrictions, honor private-path prohibitions and pedestrian directions, and connect unqualified mapped gates only under explicit endpoint authorization.
- Keep journeys to the identical authorized endpoint at zero distance, matching Matrix without charging a street snap twice.
- Include authorized origin and destination connections in street Reach without private through shortcuts. Retain planned comparisons, walking-speed controls and street/node evidence. Accept documented one-to-four-minute point Reach cutoffs in the Node runtime.
- Honor one-to-four-minute and fractional street Reach budgets in Node; exclude later transit stops and walking arrivals. Preserve contour bends and exact-cutoff samples in geographic coordinates with a scale-aware collinearity check. Clarify sampled area and street versus cell-centre reach.

## 0.5.1

- Refine Studio journey cards, stop search, library recovery and responsive controls; display Reach results as nested travel-time bands with a matching legend.

- Move completed journey legs, alternatives, and intermediate stops into response containers without duplicating their JSON trees. Initialize the alternatives cache only for searches that collect alternatives.
- Reuse bounded leg geometry and metadata across Route alternatives and the primary journey within one search; refresh clocks for every output leg.
- Skip provably dominated reboarding searches in the scalar timetable scan. Preserve transfer rules, equal-time closure and journey selection; reuse two bytes of query workspace per stop.
- Correct Node and standalone Rust Reach polygons for nested islands and corner-touching holes; share ring classification with Studio while preserving raster cell boundaries. Close interpolated contours at no-data and extent boundaries.
- Reuse prepared SQL statements during GTFS frequency expansion and ride-leg headsign lookup; remove duplicate Reach cell counting and contour helpers.
- Reduce first-date timetable sorting with trip-block reads, preserving canonical connection order and existing City files.
- Prioritize queued Studio point queries with bounded waiting for analytical jobs; preserve preparation order and existing memory limits.
- Index service calendars once and share equal immutable timetable columns across retained dates. Preserve published 0.5 City compatibility.
- Retain up to eight inactive scheduled timetables within a configurable byte budget; let active scenarios borrow unused collection capacity.
- Reuse Matrix work for repeated endpoints through direct walking and geometry reconstruction in both native and Node runtimes. Cache candidate ranking and duplicate-detection data during alternative selection.
- Reduce preparation copies, reuse Reach raster scratch, and bound Matrix metadata caches. Reclaim canceled or expired queued HTTP requests before dispatch.
- Reuse resident CLI network state across date changes, retain up to four service contexts within its existing byte budget, and advertise per-request dates for Python process reuse.

See [0.5.1 release notes](docs/releases/0.5.1.md) for configuration and diagnostics.

## 0.5.0

Clearer journey comparisons, shared interface styling, compact routing snapshots and Studio responses, and driving preparation on demand. See [release notes](docs/releases/0.5.0.md).

Use the native HTTP service with verified container deployment and slim CLI packages. Validate benchmark responses by endpoint, preserve capacity errors, restore cold-store walking proofs, and recover complete packages after replacement failures. Correct missed Reach grid crossings and walking comparisons; retain raw routing evidence separately from display estimates.

Remove old snapshot readers and the hidden `_route-stream` protocol. Use the documented `stream` command and rebuild prepared Cities for the standalone runtime. Python 0.5 requires Engine 0.5.

Remove the retired JSON timetable compiler and weekday-template routing. Build current Cities from GTFS; legacy template stores now fail admission in both Node and Rust. Live-feed connections require explicit `sources` instead of old `url`/`urls` aliases. Remove unused status UI and duplicate routing-status classifiers, and include grouped-feed and City data interaction checks in the standard suites.

Reject blank GTFS stop IDs in raw and multi-feed builds. Remove test-only production wrappers and obsolete helper tests; check the current geometry and safe-fetch implementations directly.

Keep the Documents City folder while deferring macOS library access until the user opens it. Remove background write probes, reject invalid folder selections and malformed JSON, and retire Intel macOS build and CI targets.

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
