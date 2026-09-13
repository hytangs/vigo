# Departure interval audit

## Research question
Where do currently predicted departure intervals differ from the timetable on the selected route?

## Unit and method
A row is a pair of adjacent scheduled trips at the same reference stop and direction. Require exact trip identity, active service date, fresh source data, and a departure prediction from both trips. Calculate predicted interval minus scheduled interval in minutes. Arrival-only predictions, unresolved identities, skipped comparisons, and missing reports do not count as zero deviation.

## Scope
This is a snapshot of predictions in the configured forward window. The two scans include at most 100 wider and 100 compressed intervals; they exclude unchanged intervals and are not a representative sample of all departures. Repeated pairs at different stops are dependent observations. Do not turn their row count into a count of disrupted trips or independent samples.

## Interpretation
Report the paired values and reference stops. Do not call predictions actual headways, estimate network reliability from these selected rows, or infer a causal effect. A longitudinal study needs retained raw observations, a defined sampling design, and a separate missing-data analysis.

## Reuse
Export the paired table, retain the source timestamps, and add a researcher note before using it in a manuscript.
