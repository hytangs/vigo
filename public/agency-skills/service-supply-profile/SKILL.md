# Scheduled service profile

## Research question
How does scheduled service supply vary across service hours on the selected date?

## Unit and method
The unit is a scheduled trip with at least one indexed connection. Activate service_id using calendar weekday rules, then apply calendar_dates additions and removals for the exact service date. Exclude frequency templates. For each remaining trip, take MIN(departure) in the VIGO connections table. Group this first indexed departure by integer service hour and count trips and distinct routes.

## Interpretation
Hours above 23 belong to the same GTFS service day. These are scheduled trip starts, not observed departures, passenger capacity, boardings, or accessibility. Trips without indexed connections are absent. If an initial stop time is missing, the first indexed connection may be later than the actual trip origin. Report the selected date, timezone, route scope, and exclusions with the table.

## Reproducibility
Save the exact SQL, source references, observation timestamp, and output CSV. The table is descriptive; this single-date profile does not establish demand or a causal effect.
