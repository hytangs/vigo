# Read and retain a Result

Read the outcome first, then the answer, then the evidence behind it. A successful command means VIGO completed the requested computation; it does not mean every destination is reachable or every displayed time is observed.

## Start with the outcome

| Outcome | Meaning | What to do |
| --- | --- | --- |
| Route `status: "ready"` | A journey satisfies the modeled request | Read its legs, date, data mode, and access qualifications |
| Route `status: "blocked"` | No usable journey was returned under those inputs and constraints | Keep the Result and inspect `result.detail` and `result.diagnostics` |
| Matrix `status: "ready"` | The pairwise computation completed | Classify every `rows[].status`; some or all pairs can be blocked |
| Reach `status: "ready"` | A surface was computed | Inspect finite cells, grid bounds, cutoffs, and source assumptions |
| CLI exit `2` | Invalid input, unsupported request, incomplete City, or execution failure | Retain stderr; no valid Result was produced by this invocation |

A blocked Result exits `0`. Do not use exit status alone to count successful journeys. CSV Route batches contain per-row outcomes and a JSON summary; inspect the rows, not just the batch status. Missing values stay missing: `null` is not a zero-minute journey.

## Find the answer

| Family | Answer | Interpretation |
| --- | --- | --- |
| Route | `result`, with optional top-level `choices` | Chronological legs, actual modeled departure/arrival, duration, and transfers |
| Matrix | `rows` | One row per origin/destination pair, in origin-major order; optional transit `journey` |
| Reach | `surface`, `contours`, `stops` | Numerical travel-time grid, display contours, and reached stops |
| Comparison | `queryKind`, `cities`, `change` | Differences between saved Results; no query is rerun |

Query Results also carry `schemaVersion`, product/API versions, `city`, `query`, `warnings`, and `timing`. The exact payload varies by family. Route's detailed diagnostics sit inside `result.diagnostics`; Matrix has top-level `diagnostics`. Compare has its own envelope and does not reproduce both input Results.

For **arrive-by Matrix**, scalar `arriveMinutes` is the requested deadline. `durationMinutes` is deadline minus latest departure, including waiting after an early arrival. A nested `journey` reports actual modeled arrival. Route reports the selected itinerary's arrival. Comparing those duration fields without accounting for this difference changes the measure.

For **Reach**, `surface.values` is the numerical output; contours are its display representation. Unreachable cells must remain missing in averages and maps. Counts of reached cells do not count people or opportunities. Retain bounds, dimensions, and cutoffs alongside values.

## Keep uncertainty with the answer

An empty `warnings` array is not a certificate of complete source coverage. Important qualifications also live in diagnostics and individual legs.

| Evidence to inspect | Why it matters |
| --- | --- |
| Transit Route `result.diagnostics.routingDataMode` and `routingDataProvenance`, when present | Identify requested mode and source identities; check `realtimeApplied` to establish whether predictions or cancellations were applied |
| Transit Route `result.diagnostics.realtimeRouting`, when present | Read applied/excluded update counts and scheduled fallback; an unreported trip can retain scheduled times |
| Route leg `stationAccessStatus`, `streetPathVerified`, `streetSegmentVerified`, and `stationPathSources` when present | A routed street segment does not establish a complete entrance-to-platform path |
| Route leg `endpointConnector` when present | A coordinate snap is part of the modeled access cost, not a mapped pedestrian connection |
| Route `result.diagnostics.accessAvailability` and `searchLimits` | Explain a bounded access failure without claiming universal disconnection |
| Drive traffic diagnostics | Separate applied supplied traffic, unmatched observations, expiry, and free-flow fallback |

Show the journey or travel-time summary prominently and put search counters in a detail view. Keep fallback and access qualifications visible beside the answer. See [Route](routing.md), [realtime admission](realtime-routing.md), and [known limits](known-routing-limitations.md) for their exact meanings.

## Compare saved Results

```bash
vigo compare --before ./before.json --after ./after.json \
  --output ./comparison.json
```

Changes are **after minus before**. A negative duration change is faster. For Matrix and Reach, `meanChangeMinutes` uses only pairs or cells with finite values in both Results. `newlyReachablePairs` / `newlyReachableCells` and `noLongerReachablePairs` / `noLongerReachableCells` are separate counts. With no comparable values, the mean is `null`.

| Family | What Compare checks or matches | What the caller must align |
| --- | --- | --- |
| Route | Reads one journey from each Result and reports status, duration, and transfer change | Same endpoints and comparable request semantics; this is not a batch-wide Route comparison |
| Matrix | Joins by origin and destination IDs, falling back to indexes when IDs are absent | Unique, stable IDs representing the same locations; unmatched rows are omitted from the change summary |
| Reach | Requires identical bounds, width, height, and value-array length | Same origin, time, cutoffs, walking assumptions, and intended scenario contrast |

Compare enforces the same query family and Reach grid compatibility. It does **not** verify all City, service-date, endpoint, or query-option identities. A successful comparison is arithmetic over the supplied Results, not evidence of a controlled experiment. Hand-edited Matrix files with duplicate IDs can collapse matches; retain the original Results and validate IDs before comparing.

Use the same City revision to isolate a planned Scenario. Comparing different source revisions is useful for a source-change study, but the source change is then part of the experiment. For a practical baseline/alternative sequence, see [workflows](../guides/workflows.md#test-a-planned-service-change).

## Keep a reproducible run

Retain these together in your own analysis directory:

| Item | Purpose |
| --- | --- |
| Complete City directory and `vigo inspect` output | Preserve compiled data and identify its revision; an inspection summary alone cannot restore a City |
| `vigo --version` and `vigo capabilities` output | Record the runtime and supported interfaces |
| Original request JSON and exact command/options | Keep options and supplied state that may not be copied fully into the Result's normalized `query` |
| Full Result, stderr, and any comparison inputs | Preserve outcomes, exclusions, timings, and the evidence needed to review a difference |
| Source archives and acquisition notes, where permitted | Allow a new build from the original GTFS/OSM and distinguish it from reopening a compiled City |
| Supplied realtime or traffic snapshot, when used | Identify the observation that changed the query; the provenance key does not archive the feed |

Realtime admission uses a captured current clock. Saving a snapshot does not make it eligible for a later live query after it expires; the public CLI does not provide a historical replay clock. Keep the original Result for review and distinguish research replay from fresh live routing.

`timing.computeMs` and native search counters describe different work. Use [performance measurement](../development/performance.md) before comparing latency, and [troubleshooting](../guides/troubleshooting.md) when the result is unexpected.
