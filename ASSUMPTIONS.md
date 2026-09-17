# Assumptions

VIGO Agency is built on the existing VIGO 0.3.2 platform instead of building from scratch. This prior infrastructure created substantial development time savings and allowed VIGO Agency to focus on GTFS-RT dashboard and agentic AI.

Due to extremely limited time, the main simplifications are:

* Tested only with **MBTA**, with **RTDNV (Las Vegas)** as an additional test case.
* Realtime history is kept in memory and is not persistently stored. LAMP-style historical analysis is not covered or tested.
* Delay and headway measures are descriptive GTFS-RT indicators, not outputs from advanced prediction models.
* Realtime trip matching is conservative. Unspecified or erroneous cases remain unresolved.
* **Ask** remains experimental and preliminary.
* Network status briefings have not been validated by real agency staff and may be (likely) not comprehensive.
* No frontier model was used for Ask testing, which shall theoretically significantly improve the reasoning quality.
