# Matrix

Matrix computes scalar travel time between origin and destination sets.

```json
{
  "origins": [{"id": "home", "point": "A"}],
  "destinations": [{"id": "school", "point": "B"}],
  "mode": "transit"
}
```

Transit Matrix supports fixed departure and arrive-by deadlines. Walk and Drive Matrix require coordinate points. Results contain one row per requested pair with status, duration, and distance where applicable. Full journey legs belong to Route, not Matrix.

Coordinate Transit Matrix compares scheduled transit with a direct OSM walk, using the same independent end-to-end walking limit as Route. For depart-at, the horizon bounds the timetable search and the direct walk; a final transit egress walk can extend beyond the timetable horizon. For arrive-by, egress must finish by the deadline. Walking distances are computed in one native batch.

A request accepts up to 100,000 pairs, with no separate origin or destination
limit. Both 1 × 100,000 and 100,000 × 1 fit in one call. Results remain in
origin-major order, including repeated endpoints.
HTTP also applies its JSON body limit: 8 MB by default, configurable up to
64 MB with `VIGO_MAX_JSON_BODY_BYTES` for larger endpoint descriptions.

| Query | Shared Rust timetable work |
| --- | --- |
| Depart-at, one origin and many destinations | One forward scan |
| Depart-at, many origins and one destination | One forward scan per unique origin |
| Arrive-by, one origin and many destinations | One reverse scan per unique destination |
| Arrive-by, many origins and one destination | One reverse scan |

Rust schedules the entire matrix inside one native call. Endpoint access stays
directed: reversing the timetable scan does not swap physical origins and
destinations. All rows in a request share the service date and time constraint.

For assigned-school analysis, submit homes as origins and their school as the
single destination with an arrive-by deadline for the morning. Submit that
school as the origin and its assigned homes as destinations at dismissal time.
Each school and time group needs one scan in each of these directions.
The Python City reuses a resident process across Matrix and transit Route
queries on the same service date, so a loop over schools loads the network once.

```sh
vigo matrix --city=/path/to/city --request=homes-to-school.json \
  --time-preference=arrive --time=08:30 --service-date=2026-07-15
```

The server request uses `timePreference: "arrive"` and `arriveMinutes: 510`.
In arrive-by rows, `departMinutes` is the latest feasible departure,
`arriveMinutes` is the requested deadline, and `durationMinutes` is deadline
minus departure, including any waiting after early arrival. The diagnostic
`arrivalSemantics` records this convention. Route provides actual itinerary
arrival and legs when needed. A blocked arrive-by row retains the deadline
and has null departure and duration. The horizon limits how far back to search,
clipped to the start of the selected service day; egress must finish by the
deadline.

Every City and OD set uses the same exact shared timetable scan. Matrix size and endpoint distance do not select a different search algorithm. Full-itinerary materialization is used only as a test reference.

The optional `maxTransfers` integer (0–31) has the same meaning as in Route.
Both time directions and every Matrix shape enforce it. Capped scans retain
separate states for each permitted boarding count during the shared scan;
they do not run one search per destination. Work and workspace grow with the
chosen cap. Omitting it retains the smaller unrestricted scalar workspace.
Synthetic coverage is in `test/check-bounded-search.mjs`, including independent
whole-ride enumeration and 100,000-target forward and reverse checks.

For coordinate endpoints, access frontiers and their projection to timetable
stops stay in Rust through the matrix scan. Only scalar results cross back to
JavaScript. Named-stop and mixed endpoint requests retain their station access
semantics. Both paths use the same timetable kernel and are checked for parity.
