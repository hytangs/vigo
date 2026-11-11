# Transfer semantics

Route, Matrix and Reach answer with one exact connection scan. Transfer
permissions are prepared into the timetable it scans; no query keeps per-trip
transfer state.

## What the scan applies

- **Physical transfers.** Preparation determines permitted transfer edges,
  station membership, wheelchair access and walking times. A rule cannot
  reintroduce an edge removed by `allowStreetTransfers=false` or the wheelchair
  profile.
- **Stop-level GTFS rules.** Rules without route or trip selectors apply at
  their stops, with parent-station expansion. A platform's own rule overrides
  the rule it inherits from its station. `transfer_type=3` forbids the
  transfer; `transfer_type=2` sets the stop's minimum; recommended and timed
  rules need no minimum.
- **Staying aboard.** In-seat continuations (`transfer_type=4`) and linked
  blocks keep the rider on one vehicle, counted as one boarding.
- **Frequency service.** `exact_times=1` windows are expanded when the City is
  built. `exact_times=0` templates are read as departures every headway from
  each window's start, before its exclusive end.
- **The request.** The transfer buffer applies after walking and published
  minimum times; it does not delay first boarding, final egress or staying
  aboard.

## What it does not apply

Route- and trip-scoped transfer selectors are retained in the City's
`transfer_rules` table, but Route, Matrix and Reach do not apply them: the
stop-level rule governs those transfers. Flex interchanges still resolve the
most specific rule, scoped selectors included, for their conditional legs.

Monte Carlo samples a phase only for a scenario's non-exact planned frequency
services; GTFS frequency templates are deterministic departures.
