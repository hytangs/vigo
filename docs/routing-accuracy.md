# Checking routing accuracy

VIGO uses one exact Transit Matrix search for every City and OD set. City names, endpoint distance, and matrix dimensions do not select different algorithms. Independent reference implementations live in tests and never supply production answers.

Accuracy has two parts: the search must solve the declared model, and the model must faithfully represent the input data and the intended trip. A fast result or agreement between two VIGO interfaces establishes neither part by itself.

## Reproducible independent checks

```bash
npm run build:rust-routing-kernel
npm run check:accuracy
# Extend the same checks to 100 deterministic generated networks:
VIGO_ACCURACY_SEEDS=100 npm run check:accuracy
```

`test/check-routing-accuracy.mjs` generates its own public synthetic inputs. A failing run retains the input directory and reports its seed and query. It uses:

- **Floyd–Warshall**, implemented independently from VIGO's routing and contraction code, to check every directed walking distance and driving travel time on weighted graphs. Alternating graphs allow only forward edges, so unreachable OD pairs are checked as well. Drive witnesses are checked edge by edge against the input weights.
- **Whole-trip enumeration** from generated raw GTFS, independently of VIGO's compiled connection scan, to check earliest arrival and latest departure. The fixtures exercise pickup/drop-off restrictions, staying aboard restricted stops, dwell, midnight, inactive dates, missed connections, published same-stop minimums and forbidden transfers. Zero-duration trips are deliberately placed in reverse dependency order; all scans resolve same-time connections to a fixed point.
- **Every stop-to-stop OD at each boarding-time boundary** on the generated transit networks. This covers each distinct exact-stop departure interval in those fixtures. Separate queries check Matrix permutations, duplicate endpoints, scalar Route parity and materialized ride times and permissions.

Separate raw GTFS fixtures verify 0-, 30-, 90- and 300-second platform transfer rules, parent-station expansion, and forbidden transfers through Route, Matrix and arrive-by queries.

The normal suite runs eight seeds on every supported CI operating system. Larger runs use the same algorithms and assertions. They do not select easier queries based on a City's identity or on previous outcomes.

## Declare the model before comparing answers

The engine adds no implicit boarding buffer. Same-stop vehicle changes honor published GTFS minimum transfer times and forbidden transfers; staying aboard does not incur a transfer minimum. The minimum affects boarding readiness, not the alighting time or final egress. Explicit transfer edges retain their durations without an added boarding margin or a 60-second floor. Native diagnostics report `transferBoardSlackSeconds: 0`. A published platform-to-platform transfer rule takes precedence over the station walking fallback.

GTFS service dates, after-midnight times, pickup/drop-off permissions and transfer rules must come from the same input snapshot. Their definitions are in the [GTFS Schedule Reference](https://gtfs.org/documentation/schedule/reference/).

Record the exact date, time zone, departure/arrival objective, walking speed, per-endpoint walking limit, direct-walk limit, transfer policy, search horizon and live-state snapshot. Distinguish exact selected stops from arbitrary coordinates. Coordinate snapping and street access are part of the query model and require their own verification.

## Checks required for a real City

1. **Validate compilation.** Check raw GTFS references, calendars, exceptions, permissions and transferred identities against the compiled City. Inspect omitted or unsupported features. Check directed OSM access and connectivity, including isolated components, bridges and one-way streets.
2. **Verify journey witnesses.** Each ride must reference an active raw trip, follow its stop order, use legal boarding/alighting events and preserve published times. Every street segment must follow allowed directed edges. Check endpoint connectors separately so a correct graph path cannot conceal an invalid snap.
3. **Compare independently.** Run the same inputs and query policies through an independent router such as OpenTripPlanner. Its [route-request documentation](https://docs.opentripplanner.org/en/latest/RouteRequest/) describes configurable routing policies. Retain both itineraries and investigate each disagreement; matching durations alone is insufficient, and another engine's answer is not ground truth.
4. **Test changes that should preserve or constrain the answer.** Rename IDs, reorder input rows and Matrix endpoints, move the complete City directory, and repeat after unrelated queries. Answers should remain stable. Under identical horizons and policies, removing service must not improve earliest arrival, and adding service must not make it worse.
5. **Retain failures.** Keep false reachable results, false blocked results, invalid witnesses, timing discrepancies, setup failures and query errors as separate outcomes. Save the smallest reproducing input and add a regression before accepting a fix. Do not change the oracle to match an unexplained engine answer.

For exact graph and timetable comparisons, require zero feasibility disagreements. Use only the documented public timestamp rounding tolerance when comparing numeric results. Equivalent optimal itineraries may differ in geometry or route choice; validate feasibility and the objective before comparing presentation details.

## What passing means

The independent suite validates the generated graph and timetable models under their declared policy. It does not establish correct coordinate snapping on arbitrary OSM extracts, complete GTFS transfer-rule support, live-provider correctness, or real delivered travel times. Those require retained City-specific input and witness checks. A universal algorithmic guarantee comes from the algorithm's invariants and input assumptions; finite testing supports it but cannot prove every possible City or OD.
