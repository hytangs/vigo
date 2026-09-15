# Routing, Reach and CLI audit

This audit compares the original `v0.3.2` release with the current Agency routing engine on the same saved Boston GTFS and OpenStreetMap data. The original VIGO checkout is untouched. This is a local performance comparison, not a claim about every city, live service accuracy or a production server under load.

## Results

The final comparison uses **`v0.3.2` (`e74b13a`) versus `784c539`**, including the transfer repair below. Machine: Apple M2, 16 GiB RAM, macOS arm64, Node 26.7.0. Both source trees use the same installed JavaScript dependencies and Node runtime; this compares source releases under a common environment, rather than historical application distributions. Data: 399 routes, 10,311 stops and 3,736,047 indexed connections, plus the saved pedestrian and driving networks. No LLM or online lookup is used.

Four alternating batches provide **32 warm samples per case per release** and four fresh-process CLI samples per case per release. All 15 workloads produce equivalent outputs across releases; seven are also checked through the public CLI and five through its resident stream. The harness retains 1,512 records, including warm-ups and process totals. [Raw samples, p50/p95 and validation](evidence/routing-speed-032.json) accompany the [exact requests](../test/fixtures/routing-speed-boston.json).

| Workload | 0.3.2 median | Current median |
| --- | ---: | ---: |
| Scheduled point routes, seven cases | 0.74–1.31 ms | 0.74–1.31 ms |
| Departure window with alternatives | 11.85 ms | 11.26 ms |
| Realtime point route, one controlled update | 3.27 ms | 6.25 ms |
| Walk, warm | 0.52 ms | 0.52 ms |
| Drive, warm | 1.69 ms | 1.71 ms |
| Reach including contours, four cases at 96–256 pixels per side | 839–1,191 ms | 727–1,070 ms |
| Resident CLI, five route cases | 0.88–1.34 ms | 0.88–1.39 ms |
| Fresh-process CLI, transit including departure window | 357–395 ms | 352–393 ms |
| Fresh-process CLI, Reach | 1,458–1,488 ms | 1,453–1,478 ms |
| Fresh-process CLI, Walk | 357 ms | 357 ms |
| Fresh-process CLI, Drive | 10.68 s | 10.67 s |

Ranges are the minimum and maximum **case medians**, not confidence intervals. Ordinary routing, Reach and CLI show no material slowdown in this run. Reach was faster in these measurements; this audit does not establish a causal speedup. The realtime case is explicitly more expensive: approximately **3 ms additional time**, including the journey-quality pass absent from 0.3.2 and transfer preservation. Correctness has a measured cost here. First-use driving preparation remains substantial in both versions; warm timings must not be presented as startup performance.

The full CLI, routing, native-kernel and GTFS checks pass. The separate 51-query scheduled/street/realtime release replay also matches. Sixteen new transfer cases and the existing 263 exhaustive realtime comparisons pass, including against the packaged native binary. The desktop build passes packaged-runtime and strict signature checks; its CLI and native binary exactly match the tested build.

## Harvard transfer in the reported journey

The supplied coordinates are `[-71.13460, 42.37992]` to `[-71.04681, 42.28093]`, departing at 08:00 on September 15, 2026. Both releases choose the same scheduled journey: 75 → Red Line → 215, arriving at approximately 09:04.

The indexed trip `78476155` serves both Waterhouse Street and Harvard. Its timetable explains why the fastest result alights before Harvard:

| Event | Local time / rule |
| --- | --- |
| 75 at Waterhouse St @ Massachusetts Ave (`12614`) | 08:09:00 |
| 75 at Harvard bus stop (`76129`) | 08:13:00 |
| Published transfer minimum from `76129` to Red Line platform `70067` | 181 seconds |
| Earliest platform boarding after that transfer | 08:16:01 |
| Selected Red Line departure (`77871060`) | 08:16:00 |

Remaining on the bus misses that train by **one second under the published minimum**. Alighting at Waterhouse gives a computed 297-second street walk, reaching the platform coordinate at 08:13:57. The engine therefore retains that option. The street route does not verify the full station entrance-to-platform path; the displayed warning remains appropriate. Neither arrival is a promise of actual service.

A nearest-stop preference should not override a minimum transfer time. The existing fastest and less-walking alternatives express the useful choice. The regression fixture varies the minimum between zero, 180 seconds, 181 seconds and prohibited: staying aboard wins when legal and shorter to walk; otherwise the preceding stop remains eligible. Sixteen combinations cover neither vehicle updated, the feeder updated, the connecting vehicle updated and both updated.

## Defect found and repaired

That boundary test exposed a separate realtime defect. Updated vehicles use a second set of stop indices. The adapter connected each updated stop to its original stop with an internal zero-time link, but the search permits one physical transfer after alighting. The internal link consumed that step; a subsequent published cross-stop transfer could disappear. In the controlled case, the scheduled journey was available but updating its feeder produced a blocked result.

The adapter now carries the existing directed transfer edges across resident and updated stop indices. It preserves durations and prohibited pairs from the prepared timetable. A reverse index is cached per service kernel, so each query copies only edges incident to updated stops. The native search also distinguishes an internal identity link from a genuine zero-minimum transfer between different stops. Otherwise it could apply an unrelated same-stop buffer and choose unnecessary walking. The chronological search and journey-ranking pass use the same identity test. Scenario overlays retain their existing behavior.

These are generic transfer repairs. They introduce no Harvard-specific selection rule, change to a published minimum, or dashboard dependency.

## Measurement boundaries

- Route: public store adapter through a complete materialized itinerary, including walking and ride geometry. Departure-window cases include the displayed alternatives.
- Reach: one-to-many transit search, pedestrian expansion, complete travel-time raster and contour generation. This does not measure only the timetable kernel.
- Fresh-process CLI: process launch through process exit with all JSON received. Includes startup, data preparation, computation and serialization. The OS disk cache is **not** cleared.
- Resident CLI: one request at a time through receipt of its complete JSON line, before the benchmark parses it. Includes computation, materialization, serialization and pipe transport.
- Warm measurements follow one unmeasured warm-up per case in each process. Normal engine/access/geometry caches remain enabled in both releases. There is no LLM in these measurements.

The test uses an isolated clone of the prepared City, preserving the original data and derived sidecars. Release order alternates between batches. Tests and builds finish before timed runs; the ordinary desktop environment remains uncontrolled. Exact itinerary fields and geometry, reached-stop records, every raster cell and contour coordinates are compared across releases. Timing and diagnostic metadata are excluded from semantic comparisons.

## Reproduce

Build the original release in an isolated archive and build each release's native kernel and CLI. Supply a prepared CLI City (`network.json`, `routing/project.sqlite`, `osm/street-index.sqlite`, and their native sidecars). Then run the opt-in harness without other builds or tests:

```sh
node scripts/benchmark-routing-release.mjs "$baseline_repo" . "$prepared_city" \
  test/fixtures/routing-speed-boston.json temp/routing-speed-results.json
```

The harness runs releases sequentially, checks output equivalence, and retains raw samples. It does not download or rebuild source data. Prepared-store loaders may update derived sidecars, which is why a separate City copy is used.
