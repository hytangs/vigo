# Work with a City

Start with a built City from the [quickstart](quickstart.md). Choose the output your question needs, keep the inputs explicit, and inspect the resulting evidence before drawing a conclusion.

The commands below use `./boston` and the quickstart's coordinates. Replace `YYYY-MM-DD` with a covered local service date. Each JSON block is a complete request to save under the filename shown.

## Choose a query

| Question | Use | Read |
| --- | --- | --- |
| How can someone make this journey? | Route | Timed legs, transfers, walking, and access qualifications |
| When must people leave to reach one destination by a deadline? | Arrive-by Matrix | Per-pair status and departure; optional actual journey arrival |
| Where can someone travel within a time budget? | Reach | Grid values and contours at the chosen cutoffs |
| How would a proposed service change that reach? | Baseline Reach, Scenario Reach, then Compare | Time changes and newly/lost reachable cells |
| What are the feeds reporting now? | Studio Network | Observation time, coverage, predictions, and source identity |

The [support table](concepts.md#choose-a-supported-combination) shows which modes and supplied states each query accepts. A full alternative GTFS dataset needs its own City revision; planned service edits currently apply to Reach.

## Explain one journey

Save `journey.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.08337, 42.32978]},
  "mode": "transit"
}
```

```bash
vigo route --city ./boston --request ./journey.json \
  --service-date YYYY-MM-DD --time 08:00 --max-walk 1.2 \
  --output ./journey-result.json
```

Check `status`, then the chronological `result.legs`. Transit requires a boarding by default. A blocked journey can reflect the date, timetable, access network, or constraints; it does not automatically mean the physical locations are disconnected. Use [blocked-Route diagnostics](../reference/routing.md#result) to identify the next check.

For a walking journey, use `"mode": "walk"` with coordinate endpoints. For an arrive-by transit journey, add `--time-preference arrive` and set `--time` to the deadline. For alternatives around a departure, use `--departure-window 10` to sample within ten minutes either side of the requested time; inspect `choices` and the [Route contract](../reference/routing.md) before treating that list as a continuous timetable profile.

## Reach one destination by a deadline

Save `arrival-matrix.json`:

```json
{
  "origins": [
    {"id": "harvard", "point": {"coordinate": [-71.11902, 42.37334]}},
    {"id": "central", "point": {"coordinate": [-71.1035, 42.3654]}}
  ],
  "destinations": [
    {"id": "destination", "point": {"coordinate": [-71.08337, 42.32978]}}
  ],
  "includeJourneys": true
}
```

```bash
vigo matrix --city ./boston --request ./arrival-matrix.json \
  --service-date YYYY-MM-DD --time 09:00 --time-preference arrive \
  --output ./arrival-matrix-result.json
```

Every row shares the deadline. Read each row's status and `departMinutes`; use its `journey` for actual modeled arrival, walking, waiting, and transfers. Scalar `durationMinutes` runs to the deadline and can include destination waiting. Set `includeJourneys` to `false` when only scalar times are needed. Geometry is a separate opt-in that requires journeys.

A shared destination and deadline share the scalar reverse search; a shared origin and departure share the scalar forward search. Including journeys adds shared journey rounds. Keep IDs unique and stable across requests. Split larger jobs into requests with at most 100,000 pairs and within the CLI's 16 MiB JSON limit, grouping by shared time and options. See [Matrix](../reference/matrix.md) for execution and output details.

## Test a planned service change

Save `baseline-reach.json`:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48
}
```

Save `alternative-reach.json` with the same origin and surface settings:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "cutoffsMinutes": [15, 30, 45],
  "extentRadiusKm": 6,
  "rasterSize": 48,
  "scenario": {
    "id": "direct-service",
    "name": "Illustrative direct service",
    "services": [{
      "operation": "add",
      "name": "Direct service",
      "stops": [
        {"label": "Origin", "coordinate": [-71.11902, 42.37334]},
        {"label": "Destination", "coordinate": [-71.08337, 42.32978]}
      ],
      "headwayMinutes": 10,
      "startMinutes": 420,
      "endMinutes": 600,
      "averageSpeedKph": 20
    }]
  }
}
```

The speed, headway, and operating span are illustrative assumptions. This example uses the defaults of bidirectional service, distance-estimated timing, and 0.35-minute dwell. It does not establish a drivable alignment, achievable running time, vehicle requirement, or service plan. Use [Scenario semantics](../reference/scenarios.md) to specify supported branch edits and timing assumptions for a real proposal.

```bash
vigo reach --city ./boston --request ./baseline-reach.json \
  --service-date YYYY-MM-DD --time 08:00 --max-walk 1.2 \
  --output ./baseline-result.json

vigo reach --city ./boston --request ./alternative-reach.json \
  --service-date YYYY-MM-DD --time 08:00 --max-walk 1.2 \
  --output ./alternative-result.json

vigo compare --before ./baseline-result.json --after ./alternative-result.json \
  --output ./reach-change.json
```

Compare uses the retained surfaces. Negative `meanChangeMinutes` means faster modeled travel among cells reachable in both; newly reachable cells are counted separately. Check all counts together. A larger contour is not a population benefit estimate. An accessibility study also needs opportunity data, a spatial assignment method, and an explicit measure.

## Investigate live service

In Studio, start in **Network**, check the observation time and reporting coverage, then choose a route in **Routes**. Compare scheduled and predicted events at the same stop. Inspect a vehicle's position separately from its stop-time predictions. Ask can help interpret the retained evidence once a model is connected; its explanation remains subject to review.

Use **Route → Realtime** to query supported matched predictions. A vehicle visible on the map, an alert, or an added trip displayed in Trip times does not by itself make that service available to routing. See the [Network guide](network.md) and [realtime admission](../reference/realtime-routing.md).

For a reproducible scheduled analysis, use an exact date/time in Scheduled mode. For an incident review, retain the observation, identity, coverage, and result from the original investigation. See [reading and retaining Results](../reference/results.md) for both workflows.
