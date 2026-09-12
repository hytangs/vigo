# Explore GTFS in VIGO Studio

Open **Explore** to understand the transit service represented by a City.

## Map

The map can show routes, stops, stations, published shapes, streets, scheduled vehicles, and live vehicles. Display layers do not change Query semantics.

Vehicles use circles in their route color, with an inset white arrow showing the supplied or estimated bearing. The arrow rotates with the map, including in Network view. The symbol is bundled locally and works without a font server. A vehicle without a bearing remains a plain colored dot.

## Services

Select a route to inspect its patterns, ordered stops, trip count, service span, and published geometry. Select a stop or station to inspect the services that call there.

The **Directions** chooser shows each pattern's first and last stops. Select a pattern to isolate its map and ordered stop list; repeated visits to a stop remain separate entries. **Full service** restores the service's patterns. Direction IDs are feed labels: `0` and `1` do not establish compass directions, and a missing direction ID remains unspecified. Technical identifiers are available under **Source data** and in pattern tooltips.

Feed totals cover the imported calendars. Once a selected date's trip details load, the timetable bands and trip counts use that service date. Empty dates show no service band. Times such as `25:10` remain on the selected GTFS service day. See the [GTFS schedule reference](https://gtfs.org/documentation/schedule/reference/#stop_timestxt).

Schedule playback interpolates the supplied schedule for visual inspection. It is not a routing Result and does not claim observed operations.

The **Estimated** readout identifies these simulated positions. Vehicles stay at a stop during its dwell interval and follow their pattern's shape between calls. Different published shapes remain separate patterns. Select a vehicle to inspect its trip, service date, current or next stop, and timing. Missing or inconsistent timetable geometry is omitted from projection and counted in the diagnostics.

Stop placement on a shape is an ordered geometric estimate. The current index does not retain `shape_dist_traveled` or every untimed intermediate call, so playback cannot establish exact vehicle locations between timed calls. A timetable band represents the first departure through the last arrival, including any gaps in service.

Live service is another Explore lens. Studio Route can apply a bounded overlay of matched, supported Trip Updates. Vehicle Positions and Alerts are display data. See the [realtime limits](known-routing-limitations.md#realtime); this is unavailable through the public CLI.
