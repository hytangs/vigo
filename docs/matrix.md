# Matrix

Matrix computes scalar travel time between origin and destination sets.

```json
{
  "origins": [{"id": "origin", "point": "A"}],
  "destinations": [{"id": "destination", "point": "B"}],
  "mode": "transit"
}
```

Transit Matrix supports fixed departure and arrive-by deadlines. Walk and Drive Matrix require coordinate points. Results contain one row per requested pair with status, duration, and distance where applicable.

For transit, `includeJourneys: true` adds a `journey` to each ready row, with
actual departure and arrival, `transfers`, `walkMinutes`, `rideMinutes`,
`waitMinutes`, and timed legs with trip and stop IDs. Blocked rows have a null
journey. `includeGeometry: true` additionally uses the existing Route renderer
to supply route metadata, distances, and coordinates for those selected
witnesses. It requires `includeJourneys: true` and performs no new timetable
search. Both options default to false.
The parent Matrix diagnostics report the complete shared query time. Timings
inside a materialized journey cover that witness's rendering, not a separate
timetable search or an allocated share of the batch cost.

Journey searches first obtain exact scalar bounds, then share boarding rounds
across the same endpoint group. They retain the time/walking frontier needed
for secondary objectives. Depart-at minimizes arrival, then boardings and
walking. Arrive-by maximizes departure, then minimizes boardings, walking, and
actual arrival within the deadline. Equal-objective paths can differ from
Route's stable traversal order and therefore have different ride/wait splits.
The public objective is `earliest_arrival`; Matrix does not return Route's departure-window alternatives.

Coordinate Transit Matrix requires a vehicle boarding by default. With `requireTransitRide: false`, it compares scheduled transit with a direct OSM walk, using the same independent end-to-end walking limit as Route. For depart-at, the horizon bounds the timetable search and the direct walk; a final transit egress walk can extend beyond the timetable horizon. For arrive-by, egress must finish by the deadline. Walking distances are computed in one native batch.

A request accepts up to 100,000 pairs, with no separate origin or destination
limit. Both 1 × 100,000 and 100,000 × 1 fit in one call. Results remain in
origin-major order, including repeated endpoints.
The public CLI also applies its [16 MiB request limit](programmatic.md); pair count and encoded request size are separate limits.

| Scalar query | Shared Rust timetable work |
| --- | --- |
| Depart-at, one origin and many destinations | One forward scan |
| Depart-at, many origins and one destination | One forward scan per unique origin |
| Arrive-by, one origin and many destinations | One reverse scan per unique destination |
| Arrive-by, many origins and one destination | One reverse scan |

Rust schedules the entire matrix inside one native call. Endpoint access stays
directed: reversing the timetable scan does not swap physical origins and
destinations. All rows in a request share the service date and time constraint.

Group requests by shared endpoint, service date, time, and routing options.
A common destination and deadline share a reverse scan; a common origin and
departure share a forward scan.

```sh
vigo matrix --city=/path/to/city --request=matrix.json \
  --time-preference=arrive --time=08:30 --service-date=YYYY-MM-DD
```

Use a service date covered by the feed. The CLI also accepts `timePreference: "arrive"` in the request JSON; the clock belongs in `--time`.
In arrive-by rows, `departMinutes` is the latest feasible departure,
`arriveMinutes` is the requested deadline, and `durationMinutes` is deadline
minus departure, including any waiting after early arrival. The diagnostic
`arrivalSemantics` records this convention. Route provides actual itinerary
arrival and legs when needed, as does the optional nested `journey`. A blocked arrive-by row retains the deadline
and has null departure and duration. The horizon limits how far back to search,
clipped to the start of the selected service day; egress must finish by the
deadline.

Every City and OD set uses the same exact shared search for the requested output.
Matrix size and endpoint distance do not select an approximation. Scalar
queries count one search per endpoint group; journey queries count both the
scalar bound search and the shared journey rounds.

The optional `maxTransfers` integer (0–31) has the same meaning as in Route.
Both time directions and every Matrix shape enforce it. Capped scans retain
separate states for each permitted boarding count during the shared scan;
they do not run one search per destination. Work and workspace grow with the
chosen cap. Omitting it retains the smaller unrestricted scalar workspace.
Synthetic coverage is in `test/check-bounded-search.mjs`, including independent
whole-ride enumeration and 100,000-target forward and reverse checks.

For coordinate endpoints, access frontiers and their projection to timetable
stops stay in Rust through the matrix scan. Scalar results, or the requested
compact witnesses, cross back to JavaScript. Named-stop and mixed endpoint requests retain their station access
semantics. Both paths use the same timetable kernel and are checked for parity.
