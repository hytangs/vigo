# Public results

The CLI, resident stream, and HTTP services use one public result contract. Read `status` first: `ok` contains the result, `not_found` means no journey satisfies this request, and `error` means the request failed. A valid no-journey response exits 0 and uses HTTP 200.

Route returns `schema: "vigo.route.v1"`, `query`, `journey`, and `meta`. Matrix and Reach use `vigo.matrix.v1` and `vigo.reach.v1`. The schema version and `meta.engineVersion` are separate identities.

Interactive Route commands show a short itinerary. Pipes, `--output`, and `--format json` produce structured JSON; `--format text` explicitly selects the terminal view. Diagnostic details are available in JSON.

## Journey

`journey` contains `departureTime`, `arrivalTime`, `durationSeconds`, `walkingSeconds`, `waitingSeconds`, `ridingSeconds`, `boardings`, `transfers`, and `legs`. Drive journeys also have `drivingSeconds`. Clocks are local service-day `HH:MM:SS`, including hours above 23. Durations are integer seconds, rounded at the public boundary; routing retains its original precision. Waiting includes the gaps before and between legs. It is not inferred to be a reliability margin.

Legs have `type: "walk" | "transit" | "drive"`, `from`, `to`, clocks, duration, and available distance. Transit legs identify the route and trip. Stop, route, and trip references use `{ "feed": "mbta", "id": "70067" }`; an unscoped feed is `null`. You can send an endpoint as `{ "stop": { "feed": "mbta", "id": "70067" } }`. Older string `stopId` requests remain accepted.

Route includes available GeoJSON `geometry` on each leg by default, preserving the full source coordinate precision and vertex sequence. Send `includeGeometry: false` or use `--include-geometry=false` for a smaller response without coordinate arrays. Matrix journey geometry remains opt-in with `includeGeometry: true`. Geometry describes the modeled path, not an observed vehicle trajectory or a guarantee of surveyed station interiors. Ordered journeys have a single ordered leg list; departure-window alternatives appear in `alternatives`.

`quality.streetGeometry` distinguishes verified street evidence from unverified geometry. `quality.stationPath` is `source_path` or `inferred` when station access is present. A verified street segment does not certify a complete entrance-to-platform path. `components` separates street and station access costs and identifies their source types. Transit `quality.schedule: "timetable"` means modeled timetable times, not observed punctuality or a guarantee that every source timestamp was measured.

Route warnings describe qualifications that affect the returned journey. Dataset/model limitations live in `vigo info` (Rust), `vigo inspect` (Node), or `GET /v1/info`; send `includeLimitations: true` when needed alongside a query. No warnings does not certify complete source coverage. Unsupported GTFS semantics remain documented in [known limits](known-routing-limitations.md).

## Diagnostics

| Level | Added output |
| --- | --- |
| `none` (default) | Journey or analysis result only |
| `summary` | Available integer search counters and candidate counts |
| `profile` | Summary plus measured timings in integer microseconds |
| `trace` | Profile plus the full original internal result under `trace` |

Use `--diagnostics summary`, a JSON `diagnostics` field, or `?diagnostics=summary`. HTTP also accepts `?vigo_diagnostics=summary`. Conflicting body and URL settings are rejected. `trace` is an unstable research/debug ABI: internal indices, sentinels, duplicate units, and raw candidate arrays intentionally remain there. Production clients should consume the public fields.

`scannedDepartures` is the engine's departure scan count; `expandedTripRuns` and `relaxedStops` are its reported expansion/relaxation counts. They are not interchangeable with network size or unique visited stops. Candidate counts count the returned endpoint candidate entries. Fields without instrumentation are omitted rather than fabricated.

`meta.computeUs` retains the runtime's measured compute boundary, identified by `computeScope`. Rust measures dispatch including materialization; Node measures its routing call. Neither includes public formatting, final JSON serialization, HTTP queueing, or network transit. Profile scopes can overlap and must not be summed. `Server-Timing` reports measured serialization and compute; the Rust supervisor also reports queue time. Client wall time remains a separate measurement.

`meta.requestId` identifies a result; caller-supplied `id` is echoed. `meta.queryFingerprint` hashes the runtime's query representation and City revision with output switches excluded. It is not a promise that equivalent aliases or different runtimes produce identical hashes. Supplied scenario and realtime content get separate fingerprints; retain the original inputs for reproducibility. Realtime admission/application evidence is retained when the runtime supplies it.

## Matrix and Reach

Matrix returns `durationsSeconds[origin][destination]`, with ordered endpoints in `query`. Unreachable cells are `null`, never zero. Optional `journeys` follows the same ordering. Arrive-by duration is the requested deadline minus latest departure; a nested journey can arrive earlier and have a shorter elapsed duration.

Reach returns `surface.valuesSeconds`, grid bounds and dimensions, `cutoffsSeconds`, GeoJSON contours/areas, and `fullSurface` when available. Cell order is unchanged: row-major, northwest first. Unreachable cells remain `null`. GeoJSON cutoff properties and explicitly requested street/node evidence retain their documented unit-labelled fields; these analytical evidence formats are separate from journey durations. Raw search chains are only in trace.

## Compare and migrate

Public saved results can be compared without rerunning routing. Changes are after minus before, in seconds. Route reports duration and transfer changes; Matrix and Reach report common, faster, slower, unchanged, newly reachable and no-longer-reachable counts. Means use only mutually reachable entries and are `null` when none exist. Matrix requires identical ordered endpoints; Reach requires the same grid. Callers must align other experimental assumptions.

Existing consumers of `result`, `plan`, top-level `legs`, `durationMinutes`, or `surface.values` must migrate to the public fields. For research tools that still require the original witness, explicitly request `diagnostics: "trace"` and read `trace`. The private Node worker protocol remains unchanged. Low-level `native` operations retain their separately documented contracts.

Errors use `schema: "vigo.error.v1"`, `status: "error"`, and `error.code` / `error.message`. Handle stable codes and HTTP status, not OS error text. Keep the City, original query, executable version, supplied observations/scenario, and result together when retaining a reproducible run.

Untimed GTFS stairs and gates using routing estimates expose `quality.stationTime: "estimated"` on the walk. Their diagnostic provenance is `gtfs_pathway_estimated`; these costs are not published or measured traversal times.
