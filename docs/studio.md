# VIGO Studio Guide

VIGO Studio provides network exploration, Route planning, and Reach analysis over the VIGO routing engine.

## Open a City

Select a project from the Studio library and import GTFS and OSM. Rebuild when the source feed or street extract changes. Studio currently stores its projects in a library format; it cannot directly open the movable City directories built by the CLI or Python.

## Explore

### Network

View transit lines, stops, stations, and streets together. Select a service to inspect its directions, patterns, stop sequence, service span, and exact-date trip count.

### Playback

Choose a service date and local time. Scheduled playback uses trip-level stop times active on that date; it does not animate the route-wide trip total. Live state, when available, stays separate from the baseline schedule.

## Route

### Plan

Choose an origin, destination, optional ordered waypoints, mode, date, time, and depart-at or arrive-by. Coordinate access and egress follow the OSM street graph. Inspect every returned leg before using its geometry.

### Recent

Reopen recent Route Results for the current City revision. A Result keeps its normalized request, status, warnings, and timing beside the journey.

## Analyze

### Reach

Run a Reach Query and display its travel-time surface as contours or reached streets. The origin is a map point, not a zero-minute text label. Reach measures modeled network reach; it does not add jobs, population, or other opportunities.

### Compare

Studio's feed comparison runs a Reach Query for each selected GTFS feed and displays the resulting surfaces. To compare completed Results without rerunning their Queries, use `vigo compare` or Python's `vigo.compare`.

Scenario drafts remain in the current Studio session. Changing projects or closing Studio discards them.

Matrix is available through the CLI and VIGO Python in 0.3.0. Studio does not add a separate Matrix screen.

## City

### Data

Review GTFS and OSM sources, coverage, counts, and warnings. City files are generated together and should move together.

### Settings

Choose appearance, storage location, and map preferences. Runtime detail appears only when it helps diagnose a problem.

The optional CARTO basemaps currently require a provider key that Studio does not configure. Use the OpenStreetMap street style or the local map if those styles display an API-key watermark.

## Troubleshooting

### Playback shows no trips

Check the exact service date, `calendar.txt`, `calendar_dates.txt`, the selected direction and pattern, and whether the playback time falls between a trip's first departure and last arrival.

A route-wide total is not the number of vehicles active at one time. If Studio has not loaded trip-level detail, it reports that the detail is unavailable instead of claiming that no trip exists.

### An access path crosses a block

The visible access or egress line must come from OSM street geometry. Rebuild the City from current OSM data, confirm the point lies within coverage, and inspect the selected street leg. Studio does not replace a missing street path with a straight jump.

### A date is rejected

Use an exact `YYYY-MM-DD` date inside the feed's active service range. Studio applies the same calendar rules as the CLI and Python.

### A Result differs after rebuilding

Confirm the City revision and source data shown with each Result. A new feed or OSM extract creates a new City revision.
