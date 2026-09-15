# Routing comparison with VIGO 0.3.2

The tested routing behavior matches 0.3.2, with a demonstrated improvement in realtime transfer correctness. This is a bounded comparison, not evidence that every possible journey or natural-language request is correct.

The baseline is the local `v0.3.2` release tag, resolving to `e74b13a`. Its source was extracted into an isolated directory and its original native kernel was compiled separately. Both versions used the same saved Boston timetable and OpenStreetMap networks. Neither the original VIGO checkout nor the three assessment documents was edited.

Across **51 identical-input queries**, both versions returned the same status, departure, arrival, walking time, selected trips, boarding/alighting stops and ride times. The cases cover morning, evening, overnight, GTFS times after 24:00, arrive-by, walking, driving and three controlled realtime updates. There were **44 successful journeys and seven identical blocked results**. All seven blocked cases use one airport coordinate without pedestrian access in the saved network; separate cases at the indexed Airport station succeed. Matching a blocked result establishes parity, not that the underlying map is complete.

The Chinatown–Allston comparison leaves all boarding stops available. On the saved timetable, the unrestricted 23:05 query selects two transit legs and arrives at 23:47:24 in both versions. This differs from the earlier two-platform Boylston/Park Street experiment, which deliberately restricted boarding to compare walking ties. Neither experiment reconstructs the original screenshot's unretained live feed.

## Repair verified against the baseline

Realtime-updated trips occupy a separate stop index inside the query. That index did not retain the original stop's minimum transfer time or prohibited-transfer rule. As a result, both 0.3.2 and the previous Agency build could offer an impossible connection. With 60 seconds available and a published minimum of 61 seconds, the baseline selected the tight connection and arrived at minute 620; the repaired engine selects the later service and arrives at minute 630.

The adapter now passes explicit stop identities to both the chronological search and the journey-ranking pass. Updated vehicles inherit the same transfer rules as scheduled vehicles. New scenario stops keep their existing behavior. Initial boarding and remaining on the same vehicle remain possible. This follows the [GTFS transfer definitions](https://gtfs.org/documentation/schedule/reference/#transferstxt). A trip-level update with no stop-update array is also accepted without throwing.

Validation passed: the routing and GTFS suites; native kernel, matrix and terminal-access tests; HTTP/desktop/CLI interface parity; 260 independent realtime journey comparisons; 20 store-level transfer cases; and the packaged desktop checks. The 260 comparisons also passed against the native binary inside the application bundle. Rendered refresh tests recorded zero background source uploads in Route and Accessibility, retained pan/zoom, and one viewport fit for a new result.

## Reproduce

Inputs are in [routing-release-boston.json](../test/fixtures/routing-release-boston.json). The [retained comparison](evidence/routing-032-comparison.json) records outputs and limits. Point the following variables at an isolated baseline source directory and the same GTFS/OSM stores for both runs. Build each repository's native kernel first. The replay does not download data or invoke an LLM; routing may prepare derived store sidecars.

```sh
node test/replay-routing-release.mjs "$baseline_repo" "$gtfs_store" "$osm_store" \
  test/fixtures/routing-release-boston.json temp/baseline-results.json
node test/replay-routing-release.mjs . "$gtfs_store" "$osm_store" \
  test/fixtures/routing-release-boston.json temp/current-results.json temp/baseline-results.json
node test/check-realtime-journey-quality.mjs
node test/check-gtfs-realtime-routing.mjs
```

The comparator excludes runtime timings. This run is not a controlled speed benchmark. It does not independently validate coordinate snapping, actual delivered service, live prediction accuracy, or Ask's place resolution. Those remain separate from direct-coordinate routing parity.

## Final timing audit

A second audit preserved the 51-case comparison and repaired additional realtime timing defects. Arrival and departure now remain separate inside the native overlay, allowing riders to transfer during their first vehicle's dwell. A controlled native case previously arrived at second 550 because that transfer was missed; it now arrives at second 300. Store-level tests also cover alighting, boarding during dwell, and arrive-by requests.

Stop-level delay now carries forward to subsequent unreported calls, with a new prediction overriding it and `NO_DATA` clearing it. Clearing a prediction uses scheduled fallback; it does not establish on-time operation. In the sparse-update regression, a two-minute delay at the middle stop previously disappeared downstream, producing an arrival at minute 620; the corrected arrival is minute 622. These rules follow the [GTFS-Realtime trip-update specification](https://gtfs.org/documentation/realtime/reference/#message-tripupdate).

The timing resolver is now a small separate module. Sequence-specific updates apply only to that visit on a loop; ambiguous stop-ID-only updates on repeated stops are rejected. Contradictory timestamps do not create backwards ride segments. Numeric cancellation/deletion values preserve the published enum values, including the unused slot before `REPLACEMENT`.

The final checks include 263 native exhaustive comparisons with dwell and transfer variations, store-level timing regressions, the routing and GTFS suites, interface parity, and desktop package verification. The native comparisons also run against the packaged binary. [Timing audit evidence](evidence/routing-timing-audit.json) records the bounded findings; the earlier 260-case evidence remains the historical first audit.
