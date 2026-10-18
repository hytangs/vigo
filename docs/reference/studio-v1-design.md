# VIGO Studio V1 design

This record explains why Studio V1 looks and behaves the way it does, what the
0.5 Studio audit found, and which heavy paths move into the Rust kernel next.
It is a design record for contributors, not a user guide.

## Audit of the 0.5 Studio

The audit used a Boston City (MBTA GTFS with 402 routes and 10,281 stops, plus
a Boston OpenStreetMap extract) on an Apple Silicon Mac, in the desktop window
size Studio opens at (1440 × 900).

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

- Opening a City downloaded 4.0 MB of JSON. Almost all of it was
  `feeds[].mapPreview`, the whole network geometry, parsed on the main thread.
- The offline basemap fetched 0.7 to 1.0 MB of GeoJSON for the current
  viewport after every pan or zoom. The API read it synchronously from SQLite
  on its event loop (42 ms for a city-wide zoom 12 view), and the client
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
5. **One signal.** The chartreuse of the triangle in the VIGO mark is the only
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
- The **service clock** floats as a transport bar under the visible map. The
  delay legend opens as a popover instead of a second row.
- **Cities** shows each City's own network, drawn by the local server from the
  stored map preview (`GET /api/projects/{id}/signature`).

### Offline basemap tiles from Rust

The Rust kernel now renders the offline basemap as Mapbox Vector Tiles
(`native/vigo-routing-kernel/src/basemap_tiles.rs`), served at
`GET /api/projects/{id}/basemap-tiles/{z}/{x}/{y}.mvt`. Tiles are cut in Web
Mercator with a 64-unit buffer and rendered on the libuv thread pool, so a
burst of tiles never blocks the API. Oceans are polygonized from coastlines per
tile with the same rules as before: land on the left of a coastline, closures
clockwise along the boundary, and no closure across an incomplete shore. The
street index build time versions the URL, so tiles are cached as immutable.

| Boston, city-wide view (zoom 12) | 0.5 viewport GeoJSON | V1 vector tiles |
| --- | --- | --- |
| Transfer | 678 KB for the viewport, again after every pan | 3 to 72 KB per tile, cached until the next import |
| Server work | 42 ms, synchronous on the API event loop | 5 to 15 ms per tile on the libuv pool |
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

| Boston City open (Chromium, warm server) | Before | After |
| --- | --- | --- |
| `GET /api/projects/boston` | 4,040,159 bytes | 1,013,216 bytes (`detail=catalog`) |
| Main-thread `JSON.parse` (median of 9) | 9.7 ms | 2.8 ms |
| Build route and stop GeoJSON for the Network view | 20.4 ms | none |
| Structured clone of that GeoJSON to MapLibre's worker | 56.4 ms | none |
| Network geometry for the first view (zoom 8.3) | inside the 4 MB JSON | 6 tiles, 311 KB, decoded in workers |
| Downtown at zoom 12.5 | already loaded | 6 tiles, 240 KB, cached until the next store build |
| Server per tile | none | 1.5 to 9 ms; registration about 100 ms once per revision |

The two views match. The first camera framed zoom 8.2897 before and 8.2976
after. At zoom 12.5 over downtown both drew 228 routes and 845 stops. Most of
the remaining catalog is the 4,237-stop list (746 KB) that search and selection
read. The server still spends 1.5 to 2.4 s building the overview from SQLite on
the first open after start; that cost is unchanged.

Three behaviors differ by design:

- **Full-day schedules.** Loading the full-day schedule merges every route's
  patterns into Studio state. The GeoJSON map then began drawing all of them,
  3 minutes 26 seconds after open for Boston. Tiles keep the overview, one line
  per route, at all times. Every pattern still appears when a route is focused.
- **Headings.** A live vehicle without a reported bearing no longer takes its
  heading from the overview shape in the Network view. A focused route still
  supplies one.
- **Stop names.** Stop cards and tooltips read names and served routes from the
  stop catalog, because tiles carry only ids and styling values.

## Next for V1

1. **Overview in Rust.** Build the route and stop overview from the routing
   store in the kernel, removing the first-open SQLite pass in Node. Then
   consider a compact stop catalog or kernel-side search instead of the 746 KB
   stop list.
2. **A Studio state store.** Split `App.tsx` into per-workspace stores read
   through selectors, so panels subscribe to what they show and the map stops
   re-rendering for unrelated changes.
3. **Vehicle positions in Rust.** Compute scheduled trajectories per service
   day in the kernel; the client only interpolates.
4. **Search in Rust.** A ranked index of stations, stops, lines and places that
   puts "Park Street" the station first.
5. **Reach contours in Rust.** Move marching squares and polygonization next
   to the raster the kernel already produces.
6. **Finish the token migration.** Move remaining component rules to canonical
   tokens and retire the aliases.
