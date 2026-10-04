# Travel-time uncertainty

VIGO 0.4.3 supports explicit time reserves that affect route selection. It does
not yet estimate an on-time arrival probability, travel-time distribution, or
calibrated confidence interval. Scheduled and admitted realtime event times
remain point estimates.

## Use reserves in a routing request

Both the Node Engine and standalone Rust accept these JSON controls:

| Control | Applies to | Meaning |
| --- | --- | --- |
| `minimumTransferBufferMinutes` | Transit Route and Matrix, depart-at or arrive-by | Extra minutes before each subsequent boarding, after walking and published transfer minima. Does not change first boarding or staying aboard. |
| `arrivalBufferMinutes` | Arrive-by Transit Route and Matrix | Reserve the final minutes before the requested arrival deadline. Search for the latest departure that reaches the destination before the earlier planning deadline. |

Both are integers from 0 to 60 and default to zero. Positive arrival reserves
require an arrival deadline at least as large as the reserve and a horizon
exceeding it by at least one minute. The earliest departure remains the one
implied by the original deadline and horizon. Transit via points reject a
positive reserve: independently composing segments would apply it repeatedly.
Walk, Drive, Reach, and native operations reject a positive arrival reserve.

For Harvard Square to South Station, save this as `reserved-arrival.json` for
the Node CLI. Choose a service date covered by your downloaded MBTA feed:

```json
{
  "origin": {"coordinate": [-71.11902, 42.37334]},
  "destination": {"coordinate": [-71.05524, 42.35227]},
  "serviceDate": "2026-10-05",
  "time": "09:00",
  "timePreference": "arrive",
  "maxTransfers": 3,
  "horizonMinutes": 120,
  "minimumTransferBufferMinutes": 3,
  "arrivalBufferMinutes": 5
}
```

```sh
vigo route --city ./boston --request reserved-arrival.json
```

The standalone Rust CLI accepts the same request (`arrive_by` is also accepted).
VIGO plans arrival by **08:55**, allows departure no earlier than **07:00**, and
requires three additional minutes at each transit change. These numbers are
illustrative user preferences, not an MBTA delay estimate or recommended
reliability threshold. A tighter request can legitimately become blocked.

Route clocks and leg durations still describe the selected timetable journey.
Matrix scalar duration keeps its deadline-minus-departure definition, including
the final reserve; nested journeys report their actual modeled arrival. Keep
`diagnostics.timeReserves` with the answer: it records the requested and planning
deadlines, both margins, and `calibratedProbability: false`. Node Route places
it inside `result.diagnostics` (or `plan.diagnostics` in the stream interface).
Defaults produce the existing deterministic result.

The reserve combines with supplied realtime Transit Route predictions. Transit
Matrix remains scheduled-only. A transfer reserve can absorb some lateness;
it does not model a departing vehicle leaving early, missed-connection recovery,
capacity denial, cancellations, correlated delays, or uncertain walking and
station access. The final reserve alone does not protect intermediate transfers.

## Calibrate probabilities before offering them

GTFS realtime `StopTimeEvent.uncertainty` has no defined statistical meaning;
an omitted value means unknown. It must not be converted into a standard
deviation or a 90% interval without a provider-specific validated model.
See the [GTFS realtime reference](https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent).

For a Boston calibration study, start with [MBTA LAMP exports and their data
dictionary](https://github.com/mbta/lamp/blob/main/Data_Dictionary.md). They
describe trip/stop/date identifiers, observed movement and stop timestamps,
travel times, and matched scheduled clocks. [TransitMatters Gobble](https://github.com/transitmatters/gobble)
also documents its collection of MBTA V3 streaming events. These are potential
inputs; 0.4.3 does not download or fit them automatically.

A proposed next stage is to retain historical forecast snapshots and outcomes,
match the exact feed revision and trip instance, and estimate errors by route,
direction, time of day, and forecast lead time. Validate on later service dates
with missing-data and coverage reporting. Keep same-vehicle and shared-corridor
delays correlated; multiplying marginal transfer probabilities is not a
justified journey probability. Evaluate missed connections and recovery choices
as well as final arrival. Probability-driven routing requires a separate search
and calibration contract, rather than interpreting the current deterministic
optimum as the most reliable path.

## Reproduce the implemented contract

Run `node test/check-arrive-by-boundary.mjs` after building the native kernel and
`npm run check:standalone` after building the Node CLI. Public fixtures cover a
changed selected departure, exact reserve boundary, blocked outcomes, unchanged
earliest departure, transfer-reserve combinations, matrices, invalid values,
and repeated requests through both interfaces. These checks establish modeled
feasibility, not measured on-time performance.
