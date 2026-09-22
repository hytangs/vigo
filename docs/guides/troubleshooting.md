# Troubleshooting

Identify which stage failed: installation, City build/open, request validation, computation, or interpretation. Preserve the failing command and its output before changing inputs.

## Check the runtime and City

```bash
vigo --version
vigo capabilities
vigo inspect --city ./boston
vigo help route
```

`capabilities` describes the running binary, while `inspect` identifies the compiled City. Neither command proves that a given date has service or that a route is reachable. Source checkout changes take effect only after rebuilding the CLI. If `vigo` is unavailable after a source build, run `node public/vigo.mjs` from that checkout, or complete the `npm link` step in the [quickstart](quickstart.md).

## Build or open fails

| Symptom | Check | Next step |
| --- | --- | --- |
| Node/runtime version error | Compare `node --version` with the declared package requirement | Install a supported runtime, then follow the source-build steps |
| Native build or load failure | OS/CPU, pinned Rust toolchain, and native linker | Build for the machine that will run VIGO; an executable from another target is not portable City data |
| Output City already exists | Whether this is a new source revision or an intentional replacement | Prefer a new output directory when retaining a baseline; use `--replace` only for an intended replacement |
| Missing or corrupt required street files | Whether the entire City was copied | Restore a complete City or rebuild from GTFS and OSM; do not copy individual databases into another City |
| First query is slower than later queries | Whether timetable/access preparation ran | Retain diagnostics and distinguish preparation from resident query time |
| CLI City is absent from Studio's library | Which interface created it | Studio imports its own projects; it does not open CLI City directories in 0.4.2 |

Build uses staged publication; a failed build preserves the previous City. Preserve the original GTFS/OSM and build log if import fails. See [City reuse](../reference/known-routing-limitations.md#city-reuse-and-platforms) and [architecture](../development/architecture.md#build-and-open).

## A request is rejected

| Symptom | Check |
| --- | --- |
| Invalid or uncovered date | Use an exact local `YYYY-MM-DD`; inspect the source `calendar.txt` and `calendar_dates.txt` |
| Date/time in JSON has no effect | Public JSON commands take date and clock from `--service-date` and `--time`; flags also override supported JSON options |
| Point cannot be resolved | Use an exact source stop ID or a `[longitude, latitude]` coordinate; place names are not geocoded by the CLI |
| Transfer cap with transit waypoints | This combination is unsupported; omit the cap or change the experiment explicitly |
| Realtime or Scenario rejected by Matrix/Reach | Check the [support table](concepts.md#choose-a-supported-combination); planned service applies to Reach, live transit to Route, supplied traffic to Drive Route/Matrix |
| Matrix request is too large | Both the 100,000-pair limit and the 16 MiB JSON limit apply |
| Piped request appears to wait | `--request -` waits for one complete object and the producer to close stdin |

Invalid requests exit `2` and explain the failure on stderr. If an old `--output` file already exists, a failed invocation can leave it unchanged; do not mistake that file for a fresh Result. See [CLI I/O](../reference/programmatic.md#shell-pipelines).

## Route is blocked

Start with `result.detail`, `result.diagnostics.searchLimits`, and `result.diagnostics.accessAvailability` when present.

1. Confirm the requested City revision, date, time, and mode. GTFS time `25:10` belongs to the previous calendar day's service date, not a new service-day request at `01:10`.
2. Check whether transit is required. Transit defaults to at least one boarding; walking-only feasibility requires `requireTransitRide: false` or a separate Walk query.
3. Check each endpoint's walking access. A nearby stop by straight-line distance may lack a verified street path. An `outside_selected_budget` diagnosis only proposes a wider access check, not a guaranteed complete journey.
4. Check the horizon, transfer cap, and timetable. For depart-at, the horizon bounds transit boarding and alighting; it is not a door-to-door duration cap.
5. If a changed constraint is justified, save it as a new request and compare the outcomes. Preserve the blocked Result as part of the analysis.

Do not silently raise walking limits, substitute service dates, or convert blocked durations to zero. [Route diagnostics](../reference/routing.md#result) explain the bounded failure categories.

## Live reports and routes disagree

| Observation | Interpretation |
| --- | --- |
| A vehicle is visible but its trip is unavailable to Route | Vehicle Positions do not create timetable service; added-service display and routing admission are separate |
| Realtime times equal the schedule | Unreported trips retain scheduled times; inspect admitted/excluded update counts and fallback |
| The same saved snapshot stops applying later | Freshness is checked against the captured current clock; a saved observation is not perpetually live |
| An alert describes disruption but the route is unchanged | Text alerts are display evidence and do not close services automatically |
| Playback appears to show a vehicle that is not reporting | Scheduled playback is labeled Estimated and interpolates the timetable |

Keep service date, source scope, trip identity, feed timestamp, and record timestamp together. Ambiguous matches remain unresolved. See [Network evidence](network.md) and [realtime routing](../reference/realtime-routing.md).

## Results or comparisons look unexpected

Matrix's top-level `ready` can include blocked rows. Arrive-by Matrix duration includes destination waiting. Compare can omit unmatched Matrix IDs and does not enforce all request identities. Reach comparisons require identical grids, and finite-cell means exclude unreachable cells. The [Result guide](../reference/results.md) explains these cases before you change the routing inputs.

For a path that appears to jump to a platform, inspect its station-path and coordinate-snap qualifications. A visible line is not sufficient evidence of a physical entrance connection. See [station and street limits](../reference/known-routing-limitations.md).

## Report a reproducible issue

Include the VIGO version, OS/CPU, failing command, request, City inspection summary, stderr, and full Result if one was returned. State what you expected and whether it reproduces with the same inputs. Share a minimal redistributable fixture when possible. Review paths, coordinates, credentials, and source licensing before attaching files to a public issue; use the [security policy](../../SECURITY.md) for a vulnerability.

Retain the complete original run locally. Instructions for preserving it are in [Read and retain a Result](../reference/results.md#keep-a-reproducible-run).
