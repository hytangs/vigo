# Agency evidence audit · September 13, 2026

This pass checked the two supplied product critiques against the station board,
route diagram, retained investigations, and actual MBTA records. It focused on
what a staff member can establish from the displayed evidence.

## Park Street: the early prediction is in the source

A sample taken at 23:47:53 EDT contained Green E trip `77658528`, service date
`20260913`, Park Street stop `70200`, sequence `600`. The imported timetable
gave an arrival of 00:06 on September 14. MBTA's schedules API returned that same
time, date, and sequence. The realtime source supplied 23:48:47 on September 13:
17 minutes 13 seconds earlier. Its departure prediction was one minute after
arrival, so arrival and departure were not accidentally interchanged.

This checks the join and the schedule value for that sample. It does not establish
why the agency predicted an early arrival or whether the vehicle actually arrived
at that time. Negative deviations are permitted by GTFS Realtime; an arbitrary
“too early” threshold would discard potentially valid information.

Sources: [MBTA schedule record](https://api-v3.mbta.com/schedules?filter%5Btrip%5D=77658528&filter%5Bstop%5D=70200&filter%5Bdate%5D=2026-09-13),
[MBTA TripUpdates](https://cdn.mbta.com/realtime/TripUpdates.pb),
[GTFS Realtime StopTimeEvent](https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent).
The API and feed are mutable public sources. The inspected sample is retained
locally in the ignored `temp/agency-semantics-audit/park-street-source.json`.

## Changes

- The shared station board names predictions and schedule-only rows explicitly,
  shows their same-event early/late difference, and includes dates across midnight.
  A disclosure exposes both arrival and departure, service date, exact stop
  sequence, trip ID, source record, and prediction timestamp.
- Both the board and vehicle detail reject a source arrival later than its own
  departure. The board retains those contradictory source values for inspection.
  Absolute reported time still takes precedence over a supplied delay.
- Feed health distinguishes current, partial, unavailable, and failed refreshes.
  A fresh feed does not make every individual trip report fresh. Each row still
  applies its own timestamp checks.
- A failed board refresh retains absolute times with an explicit last-known
  notice, rather than clearing the panel or continuing a current countdown.
- Selected operational evidence stays fixed until the user requests the newer
  report. Saved-answer evidence remains fixed. Map and line views are explicitly
  identified as showing the latest available feeds; rider drafts use the latest
  report, as their action label now states.
- Stop-pattern selectors expose the vehicle counts on other patterns. A selected
  short pattern with zero vehicles no longer silently suggests an empty direction.

## Validation and boundaries

Regression checks cover repeated stops, terminals, cancelled/skipped service,
duplicate identities, unknown/stale/future timestamps, partial feed failure,
negative predictions, contradictory event order, midnight and separate GTFS
service dates. Render checks cover the failed-refresh and midnight presentation.

This is still an observational prototype. Predicted departure spacing is not
measured headway, and disappearance from an observation is not incident resolution.
This pass does not add a dispatch incident lifecycle, access control, publishing,
or infer actual arrival performance from predictions. The three assessment
Markdown documents were left untouched.
