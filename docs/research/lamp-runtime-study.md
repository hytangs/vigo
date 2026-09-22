# Saved LAMP running-time studies

The internal **Running-time prediction review** method and the `historical_runtime` tool read an existing MBTA LAMP study from the selected City's research directory at `lamp/study.json`. VIGO no longer includes the study-generation scripts, Python dependencies, or a retained example result.

The reader reports training and evaluation dates, coverage, matched timetable errors, and route or segment summaries from the saved report. A filtered route view retains an explicitly labeled study-wide comparison. Missing studies are reported as unavailable.

LAMP reconstructed stop events can include final arrival predictions. Saved results describe retrospective running-time comparisons, not independent sensor validation, live delay causes, recovery forecasts, or passenger impacts. MBTA results must not be applied to another agency because route names match.
