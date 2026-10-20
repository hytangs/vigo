# VIGO Studio V1 design

This record explains why Studio V1 looks and behaves the way it does, what the
0.5 Studio audit found, and which heavy paths move into the Rust kernel next.
It is a design record for contributors, not a user guide.

## The idea

VIGO models how people move through a city: every journey, reach and
comparison is computed on this computer from a City's published timetables
and streets, exactly and reproducibly. The V1 release is named VIGO 1 Poros
(2026); the name appears only in Settings › About. Studio keeps the VIGO mark
artwork (`public/vigo-mark-transparent.png` and `public/vigo-mark-dark.png`)
and adds no release lockup to working surfaces.

## Audit of the 0.5 Studio

The exploratory audit used a Boston City with MBTA GTFS and an OpenStreetMap
extract on an Apple Silicon Mac, in the desktop window size Studio opens at
(1440 × 900). The observations below motivate the implementation. That audit
did not retain a public benchmark fixture, so it does not establish measured
speed or memory improvements.

### Experience

- **Two shells.** Network and City used one sidebar layout and Route and
  Analyze another. Switching between them remounted the map, so the camera
  jumped and every basemap request started again.
- **No context while routing.** Route and Analyze hid every transit line.
  Picking an origin showed only roads, so riders could not see where rail ran.
- **Points dove to street level.** Placing the first point flew the camera to
  zoom 14.6. Choosing the destination then took several zoom-outs.
- **Labels that disagreed.** The rail item labelled "City" opened a page titled
  "Settings" that held appearance, storage and documentation.
- **A rainbow ramp.** Reach colored travel time from blue through red. Hue
  alone does not order time, and the bands lost contrast on the dark map.
- **Search ranking.** Searching "Park Street" listed shuttle variants before
  the station itself. This is not fixed yet.

### Visual system

- Close to 10,000 lines of CSS across 16 files, applied as layers: a later
  "final treatment" file overrode the structural rules.
- Three competing palette blocks plus a block per accent and appearance, and
  token families with overlapping meanings (`--pq-*`, `--workbench-*`,
  `--topbar-*`, `--accent`/`--accent-2`).
- A green-tinted dark theme with a desaturated lime that read as grey, and
  hard-coded colors in map and HUD rules that ignored the appearance.

### Architecture

- `App.tsx` was 3,472 lines with about 95 `useState` hooks, 33 effects and 20
  refs. Every workspace's state lived there, so any change re-rendered the
  map and every panel.
- `VigoSidebar` took 78 props and `AnalyzePanel` 67. Most were passed through
  untouched.

### Data and performance

- Opening a City downloaded the full network preview as JSON. Almost all of it was
  `feeds[].mapPreview`, the whole network geometry, parsed on the main thread.
- The offline basemap fetched GeoJSON for the current
  viewport after every pan or zoom. The API read it synchronously from SQLite
  on its event loop, and the client
  parsed and re-tiled it again.
- The client derived level of detail, scheduled vehicle positions (on every
  playback tick), the search index and performance profiles from that JSON.
  Node computed Reach contours and ocean polygons.

## Principles

1. **The map is the canvas.** The map fills the window. Tool panels float over
   it, and the camera frames content in the part of the map left visible.
2. **One shell, one map.** Network, Route and Analyze share one frame and one
   map instance. Changing workspace changes overlays, not the camera.
3. **One question per workspace.** Network: how is service running? Route: how
   do I get there? Analyze: where can I reach? City: what data is this built from?
4. **Quiet chrome, loud data.** Neutral ink carries the interface. Color belongs
   to transit data: route colors, delay states and travel time.
5. **One signal.** The lime of the triangle in the VIGO mark is the only
   interface accent: the primary action, the active workspace, the origin.
6. **Rust owns heavy geometry.** The renderer receives tiles and compact
   buffers, not megabytes of JSON.

## What V1 changes

### Design tokens

`src/styles/foundation.css` defines one palette per appearance:

| Token family | Purpose |
| --- | --- |
| `--ink-0` … `--ink-4` | Neutral surfaces from map canvas to hover |
| `--line-1` … `--line-3` | Hairlines and borders |
| `--text-1` … `--text-4` | Text from primary to disabled |
| `--signal`, `--signal-text`, `--signal-ink`, `--signal-soft` | The single interface accent |
| `--good`, `--watch`, `--alert` | Service states, never decoration |
| `--material`, `--material-strong`, `--material-blur` | Glass for floating panels |
| `--elev-1` … `--elev-3` | Elevation |
| `--font-ui`, `--font-display`, `--font-mono`, `--type-*` | Type |
| `--radius-*`, `--ease-*`, `--duration-*` | Shape and motion |

The pre-V1 names (`--panel`, `--border`, `--text-muted`, `--accent` and so on)
are aliases of these tokens, so every existing component re-themes at once.
New rules should use the canonical names.

### Stage layout

On windows at least 900 px wide, Network, Route and Analyze use the stage
layout: a solid 48 px activity rail, a full-bleed map, and the tool panel
floating in glass with a 12 px gutter. Panels carry `data-map-occluder`. The
map measures them (`mapOcclusion` in `src/app/mapViewport.ts`) and adds the
covered area to every fit, so a selected route or journey lands in the visible
part of the map. Narrower windows keep the stacked layout.

The map is mounted once. Moving between Network and a query workspace keeps
the camera; selecting a route or receiving a journey still frames it.

### Workspaces

- **Route** draws the fixed-guideway network (rail, tram, ferry) faintly in its
  own colors under the query. Bus-only Cities fall back to their most frequent
  patterns. Placing points never zooms in; the camera only pans if a point is
  off screen, and frames the journey once it exists.
- **Analyze** colors travel time with a ramp whose luminance falls
  monotonically, from the signal chartreuse through teal and blue to violet,
  and shows an on-map key with the displayed band edges.
- **Panels start with the task.** The top bar names the City and workspace
  once, so Route and Analyze drop their large titles and open on the travel
  mode or the Reach origin. Workspace views, render modes and filters share one
  segmented control.
- **Network** opens on a status line (live, stale or timetable), three counts
  and a route status bar split into routes to review, routes reporting with
  nothing flagged, and routes without reports. Missing reports stay unknown,
  never "on time". Routes to review carry an edge mark for predicted delays of
  5 and 15 minutes, the same thresholds as the live vehicle legend.
- **Routes** is a catalog: search first, filters with counts, and each route
  shown as riders see it on signs, in its own color with readable ink, its
  short name and its mode. Status chips use the service colors only.
- The **service clock** floats as a compact transport bar under the visible
  map, with its editable clock and date above the playback controls. It measures
  its own height so map inspectors always clear it, including when controls wrap.
  The delay legend opens as a popover.
- **Scheduled vehicle details** show the destination, next scheduled stop and
  trip progress without nested metric boxes. Trip identity and service date sit
  under Timetable details. A selected vehicle follows the current playback frame;
  when the trip becomes inactive, old arrival times are hidden until it returns.
- **Cities** shows each City's own network, drawn by the local server from the
  stored map preview (`GET /api/projects/{id}/signature`). The City you last
  worked in leads as a wide card with one action, open or continue setup. A
  library with no Cities explains what a City is and the three steps to make
  one, and a new City's setup page tracks timetable, streets and routing.

### Waiting states

Studio shows two kinds of waiting, both defined once in `foundation.css`:

- **Work in progress** is a signal line sweeping a hairline (`.signal-loader`):
  opening the map, loading a City, opening a City from the library.
- **Content on its way** is a skeleton in the shape it will take (`.skeleton`):
  the City library, the Network overview and a stop's arrivals.

Skeletons take their tint from the text color, so they read on any surface in
either appearance. Neither one animates when the system asks for reduced
motion. Loading content over the map centers in the part the panel leaves
visible.

### Offline basemap tiles from Rust

The Rust kernel now renders the offline basemap as Mapbox Vector Tiles
(`native/vigo-routing-kernel/src/basemap_tiles.rs`), served at
`GET /api/projects/{id}/basemap-tiles/{z}/{x}/{y}.mvt`. Tiles are cut in Web
Mercator with a 64-unit buffer and rendered on the libuv thread pool, so a
burst of tiles never blocks the API. Oceans are polygonized from coastlines per
tile with the same rules as before: land on the left of a coastline, closures
clockwise along the boundary, and no closure across an incomplete shore. The
street index build time versions the URL, so tiles are cached as immutable.

| Work | 0.5 viewport GeoJSON | V1 vector tiles |
| --- | --- | --- |
| Transfer | Viewport geometry after each camera update | Binary tiles cached until the next import |
| Server work | Synchronous on the API event loop | Per-tile rendering on the libuv pool |
| Client work | Parse JSON, then re-tile it in a worker | MapLibre decodes binary tiles in its workers |

The tile reader opens the street index read-only and adds no table or index.
The JSON `local-basemap` endpoint remains for compatibility.

### Transit network tiles from Rust

Opening a City no longer ships route geometry. The Studio requests
`GET /api/projects/{id}?detail=catalog`: project metadata, the route catalog
and the stop catalog, with no route coordinates, stop sequences or stop pairs.
The response also carries `networkTiles`: for the whole City and for each feed,
a tile revision and the extent the Network view frames. The server computes that
extent exactly as the Studio did, over every route vertex and stop with the
outer 2% trimmed. The default response, without `detail`, is unchanged for
other clients.

The kernel draws the network (`native/vigo-routing-kernel/src/network_tiles.rs`),
served at `GET /api/projects/{id}/network-tiles/{z}/{x}/{y}.mvt?scope=&v=`.
The server registers each scope's route and stop overview once per revision,
the same records the Studio used to receive as JSON. Registration splits routes
at implausible jumps with the Studio's former rules, and ranks every vertex for
Douglas–Peucker simplification at MapLibre's GeoJSON tolerance. A tile then
only thresholds, clips and encodes, on the libuv pool. The `routes` layer
carries each route's identity, color, short and long name, route type,
frequency class, service values and geometry confidence. The `stops` layer
carries the stop id, route count, trip count and transfer score. The revision
hashes the routing store build times, feed identities and engine version, so
tiles are immutable. It reuses the basemap's MVT primitives and AsyncTask
pattern.

The Studio creates a tile twin of each network layer from that layer's own
style (`src/map/networkTileSource.ts`), so paint and lenses are defined once.
The twins draw the Network view. Selection, the selected stop and the Route and
Analyze context network are filters on tile ids, so a click never refetches a
tile. A focused route still draws its full patterns from
`gtfs-route-analysis`, fetched when the route is selected. Until that detail
arrives, the route's own tiles stand in.

The catalog still includes stops for search and selection. Rust constructs the
complete overview from read-only SQLite on first open, using the libuv pool.
The small capped compatibility preview and route catalog still use Node SQLite.
Geometry transfer and client-side GeoJSON construction are avoided by the tiles;
per-route timetable detail remains a separate migration.

Three behaviors differ by design:

- **Full-day schedules.** Loading the full-day schedule merges every route's
  patterns into Studio state. The GeoJSON map then drew all of them. Tiles
  keep the overview, one line
  per route, at all times. Every pattern still appears when a route is focused.
- **Headings.** A live vehicle without a reported bearing no longer takes its
  heading from the overview shape in the Network view. A focused route still
  supplies one.
- **Stop names.** Stop cards and tooltips read names and served routes from the
  stop catalog, because tiles carry only ids and styling values.


## Scenarios, Route and Compare

### What the audit found

- Scenario drafts and timetable groups lived in two browser-storage entries
  keyed by the City's import revision, so a reimport silently started over and
  nothing travelled with the City folder.
- Planned service applied to Reach only; Route always used the published or
  live timetable.
- Every scenario run recomputed the baseline street surface and returned JSON including outlines
  that duplicate the area fills.
- Compare ran each timetable independently and listed areas with the first
  one as reference. It could not compare saved scenarios or remixes.

### Saved scenarios

Studio saves a City's timetable groups and scenarios in the City folder,
`.vigo/scenarios.json` (`vigo.studio.scenarios.v1`). A group is a remix: a
named set of the City's timetables. A scenario runs on one group, optionally
with planned changes. Writes are atomic and serialized per City, carry the
revision they started from, and are rejected when another window saved first;
an unreadable copy is never written over. Studio saves shortly after each
edit, and drafts kept in the browser by earlier versions move into the City
folder once. This is Studio metadata beside the City: the engine and prepared
City formats never read it.

### Route on a scenario

The Route panel's **Network** picker routes transit on a saved scenario. The
Rust kernel compiles a derived timetable (`compileScenarioTimetable`): removed
trips are canceled, planned runs are expanded into appended trips over existing
and new stops, and walking links for new stops join the transfer index. The
resident timetable is borrowed and never edited, and original trip indices
survive, so journeys reconstruct exactly. New stops are reached on foot over
the City's streets, rides on planned service are labelled with the scenario
and drawn along its path, and the derived timetable is cached per plan.

### Reach performance

The Studio Engine keeps computed Reach ranges in a 64 MB, 10-entry cache keyed
by store, streets, timetables and request, and identical ranges requested
together share one computation. Water around an origin and baseline outlines
are reused with their range. Studio asks for a compact payload: outlines are
drawn from the area fills, coordinates keep six decimals, and an unchanged
scenario surface is not repeated.

For a changed scenario, Rust can reuse the reference street search after
station egress is resolved. Every reference seed must still have an equal or
earlier arrival at the same coordinate, with the same initial walking cost
and endpoint-access role. The walking speed, walking limit and elapsed-time
cutoff must match. Unchanged seed labels and edge intervals are retained;
improved and added seeds are propagated again. Any label pruned by an old seed
remains dominated by that seed's improvement. Removing or delaying a seed
breaks that argument and falls back to the full search. Independent terminal
walking also uses the full search.

When the requested grid and complete reached extent match, the reference
raster remains a valid upper bound. Only improved or added seed intervals
need rasterization before taking pointwise minima. Changed extents or grids
are fully rasterized. One reference is retained per resident street kernel,
capped at 32 MiB, included in native memory accounting, and released with the
kernel. References whose labels and pre-envelope edge candidates occupy at
most 8 MiB use direct storage, avoiding compression work during construction
and decoding during restoration. Larger references use bounded, losslessly
compressed column blocks. Stable radix passes group large label sets by node,
and the encoder reuses its compression state across 4,096-record blocks. A
bounded batch holds at most eight raw blocks. Large batches use at most two
jobs on the existing query worker pool, retaining blocks in source order;
smaller batches or a single-worker runtime encode serially. The raw batch and
codec workspaces are released after construction. Duration predictions retain
an XOR residual, so decoding restores the original floating-point bits. Neighboring
node and edge records share blocks; restoration decodes one block at a time.
The 32 MiB accounting includes direct or compressed allocations, seed metadata and any
retained rasters. If that representation exceeds the budget, no reference is
retained and subsequent scenarios run the full search. Live labels, edge
candidates and the final interval list use fixed-size pages to avoid large
vector capacity doublings. Search-only buffers are released before reference
encoding and result construction. The budget covers retained reuse state only: loaded City data, search scratch,
result construction and the application runtime still contribute to process
peak memory. Scenario queries never replace that reference. Cache misses
affect work performed, not the computed surface or the City format.

`npm run check:reach-scenarios` compares fresh and incremental rasters,
complete directed-edge evidence and node evidence on deterministic generated
networks, including service cuts and delays. The reproducible synthetic
profile is `node test/check-scenario-street-surface.mjs --profile`; it reports
alternating fresh/incremental samples, settled-label counts and retained
bytes. Its timing covers a warm surface call plus JavaScript materialization,
excluding the initial reference search, and is not a whole-city benchmark.
For real-city evaluation, report cache hits and full-search fallbacks
separately. Match the City, resolved service date, origin, scenario, cutoff,
walking limits, raster and output detail. Measure baseline preparation and
retention as well as repeated scenario calls; compare process peak memory in
separate processes with the same workload. Compression adds work to the first
reference query; report that cost separately from repeated scenario savings.
The surface diagnostic `referenceBuildMs` isolates retaining the reference:
clearing the old cache, sorting and encoding labels and edge candidates, and
copying retained rasters. It excludes the street search, envelope construction
and raster generation, and is zero on scenario calls. Measure first and warm
reference builds separately, and report CPU time alongside elapsed time when
encoding uses multiple workers. Reusing labels can save search work without
reducing total process memory.

### Compare

Compare measures saved scenarios, timetable groups or single timetables
against one reference on its grid. The reference surface is computed once.
Variants are ranked by reached area gained and report newly reached and lost
cells, mean minutes saved over cells both reach, and reached stops. Only the
mapped variant's full surface stays in memory; choosing another reuses the
cached ranges. The selected variant uses the normal Reach renderer and point
inspector. The former per-feed map layers, color palette, feature builders and
multi-result map props have been removed; selecting another variant replaces
the displayed result and cancels any point-inspection request for the old one.

### Memory

Live feed polling pauses in Analyze, which uses the scheduled timetable. Studio decodes each
Reach raster once per result, the travel-time band canvas is capped at 1280 px
and the Studio Engine's Reach cache is bounded
by bytes.

## Studio workspace state

`src/state/` holds separate stores for navigation, City data, the service clock,
Network, Route and Analyze. Components subscribe to selected values. The small
`App.tsx` shell arranges workspaces; `runtime.tsx` owns background requests,
leases and polling. Network, Route and Analyze share one map instance.

The scenario persistence hook remains the single owner of City-folder writes;
its current library is published to the scenario store. This preserves revision
conflicts, delayed saves and cancellation when changing Cities. Routing on a
scenario and Compare both compile the saved scenario against its timetable group.
Older browser-only draft/group hooks are removed; existing browser drafts still
migrate through the City library loader.

`node test/check-studio-stores-runtime.mjs` exercises the real React app in
Chromium. It checks that unrelated search updates and non-map Analyze settings
do not render the shell or map, that workspace changes keep the map mounted,
and that scenario edits, scenario routing and City isolation remain connected.
These are controlled integration checks, not a full-City startup benchmark.

Search ranks exact station names before service matches and collapses service
variants. `node test/check-search-ranking.mjs` retains a public, synthetic
station/shuttle fixture; ranking still runs in TypeScript.

## Native overview and Reach geometry

`network_overview.rs` owns the complete overview's read-only SQLite traversal,
shape retention, representative-trip recovery and service statistics. Studio
awaits its native worker task. Locale-sensitive display names, colors and stop
ordering remain in JavaScript. A read transaction keeps the queries on one
snapshot. Missing stores are never created; row/coordinate limits reject an
oversized overview explicitly instead of returning a truncated network.
`test/fixtures/gtfs-overview-e2fa31a.json` retains outputs from the removed JS
implementation for historical/current catalogs and scoped/empty feeds.

`reach_boundaries.rs` owns marching squares, cell boundaries, ring stitching,
holes and nested islands. A bounding-volume index replaces the quadratic
all-pairs containment scan on fragmented rasters. Raw raster times and masks are
unchanged; display estimates remain separately labeled. GeoJSON metadata and
outline projection are presentation work. The obsolete `reach-boundaries.mjs`
and JS cell-edge construction are removed. These calls run in the existing
Reach worker or CLI; they are not new work on the Studio main thread.

`node test/check-reach-geometry.mjs` checks every 3×3 no-data mask, seeded
geographic rasters, equal cutoffs, holes, winding, represented cell areas and
input preservation. `node scripts/profile-reach-boundaries.mjs` measures public
synthetic rasters; it does not measure routing, HTTP or map rendering.

## City and preparation lifecycle

A background refresh updates its City without changing selection, library order
or another City's active feed. Request generations discard older refreshes and
responses from a reset Studio. Deleted Cities are not resurrected. GTFS and OSM
imports, uploads and retries share one completion owner for messages and flags.
Polling includes City identity and is aborted on Studio reset.
`check-city-refresh.mjs` and `check-preparation-ownership.mjs` cover these races;
`check-studio-stores-runtime.mjs` exercises the connected application.

## Next for V1

1. **Vehicle positions in Rust.** Compile scheduled trajectories per service
   day; avoid merging the full day's patterns into browser state.
2. **Search in Rust.** Preserve station-first ranking and source identities,
   then replace the full stop catalog with a bounded query interface.
3. **Remaining geometry and timetable reads.** Migrate per-route analysis,
   block-interior display estimates and the capped compatibility preview,
   preserving their distinct evidence and display semantics.
4. **Finish the token migration.** Retire component aliases after verifying
   both appearances and map overlays.
5. **Release acceptance.** Complete the platform milestones and sustained
   real-City validation in [Poros readiness](poros-v1-readiness.md).
