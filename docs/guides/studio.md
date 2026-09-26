# VIGO Studio desktop guide

VIGO Studio provides Network, Route, Analyze and City views over the VIGO routing engine. See the [Network guide](network.md) for Network, Routes and Ask.

See the [visual tour](studio-tour.md) for real application captures and [multiple-feed setup](multiple-feeds.md) for combined timetables and live endpoints.

## Open a City

Select a project from the Studio library and import GTFS and OSM. Rebuild when the source feed or street extract changes. Studio currently stores its projects in a library format; it cannot directly open the movable City directories built by the CLI.

## Network

Use **Network** for reporting coverage and briefings, **Routes** for trip times, station boards and line views, and **Ask** for evidence-backed questions. Route and station selection is shared across the tabs. The [Network guide](network.md) explains playback, live timing, added service, and model connections.

## Route

### Plan

Pick an origin and destination on the map. **Add point** inserts a via point before the destination; a route supports up to eight points total. Each row shows latitude and longitude. Click the row to repick its location, use the arrows to reorder it, or remove it. **Reverse** reverses the complete sequence. The route form does not search place or station names.

Choose a travel mode. Realtime transit departs now; Scheduled exposes the service date, time, and depart-at or arrive-by controls. Transfer caps are disabled while via points are present. Point and option changes update the route; **Rerun route** submits the same coordinates again, and **New route** clears them. Coordinate access and egress follow the OSM street graph. Inspect every returned leg before using its geometry.

### Recent

Reopen recent Route Results for the current City revision. A Result keeps its normalized request, status, warnings, and timing beside the journey.

## Analyze

### Reach

Choose an origin on the map or use **Choose origin** to search imported stops by name/ID or enter coordinates. Run Reach, then switch between **Reachable area**, **Reached streets**, and time cutoffs. Displayed cutoffs reuse the retained result. See [Reach](../reference/reach.md) for query limits and surface bounds. Reach measures modeled travel time; it does not add jobs, population, or other opportunities.

### Compare

Studio's feed comparison runs a Reach Query for each selected GTFS feed and displays the resulting surfaces. To compare completed Results without rerunning their Queries, use `vigo compare`.

Scenario drafts and the selected case are saved in Studio's local profile when edited, and restored when reopening the same project and source revision. They do not travel with a City directory. Reimporting GTFS or rebuilding the project or street store starts a separate draft set. If local storage is unavailable, Studio shows a save error; keep the window open until saving succeeds.

For a stop inserted on an A → B edge shared by several branches, the road path is applied to each affected branch. Each branch retains its untouched published shape and its own A → B runtime, with dwell added at the inserted stop. Load complete branch shapes before building the path.

Matrix is available through the CLI in 0.4.2. Studio does not add a separate Matrix screen.

## City

### Data sources

Open **City → Data sources** to review GTFS feeds, OSM coverage, counts, and warnings.

To remove one source, select the trash button beside its row, check the source name, and confirm **Delete source**. You can import it again later.

- **GTFS:** removes that feed's timetable and refreshes the combined timetable from the remaining feeds. Deleting the last feed leaves the City available for a new import.
- **OSM:** removes street routing and the walking transfers derived from OSM. GTFS timetables remain, but queries that need the street network require another OSM import.

The City, other sources, saved notebooks, and your original input files are retained. Deletion is unavailable during import or preparation. If Studio reports that a source is busy, let the active work finish and retry.

### Preferences

Choose appearance, storage location, and map preferences. Runtime detail appears only when it helps diagnose a problem.

**Local OSM** is the default for new settings. It draws main roads, rivers, lakes, and coastal water from the City's imported PBF in light or dark appearance, with no tile service, API key, or network connection. Residential streets, service lanes, paths, buildings, and labels are omitted to keep routes and analysis clear. Your saved basemap preference is retained.

Cities imported before the local map index was introduced need one fresh OSM import. The map reports this when the geometry is missing. Coastlines must be complete within the visible area to fill the sea correctly; an incomplete shoreline remains a line. Water outside the imported coverage is unavailable. Online OpenStreetMap and CARTO styles remain optional.

## Troubleshooting

### Playback shows no trips

Check the exact service date, `calendar.txt`, `calendar_dates.txt`, the selected direction and pattern, and whether the playback time falls between a trip's first departure and last arrival.

A route-wide total is not the number of vehicles active at one time. If Studio has not loaded trip-level detail, it reports that the detail is unavailable instead of claiming that no trip exists.

### An access path crosses a block

The visible access or egress line must come from OSM street geometry. Rebuild the City from current OSM data, confirm the point lies within coverage, and inspect the selected street leg. Studio does not replace a missing street path with a straight jump.

### A date is rejected

Use an exact `YYYY-MM-DD` date inside the feed's active service range. Studio applies the same calendar rules as the CLI.

### A Result differs after rebuilding

Confirm the City revision and source data shown with each Result. A new feed or OSM extract creates a new City revision.
