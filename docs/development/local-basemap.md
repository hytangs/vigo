# Local OSM basemap

`Local OSM` uses cartographic features retained in the City's SQLite street store. It does not query or load the pedestrian or driving accelerator. The `/local-basemap` endpoint returns roads and water in one GeoJSON collection. The former routing-edge renderer and its `/local-streets` endpoint have been removed.

## Import and geometry

The importer first selects water multipolygon members, then includes their node references in the street import's existing selection and geometry passes. Untagged members are joined in either direction, and inner rings remain island holes. These temporary relation tables are dropped before publication. Map tables survive routing-store compaction and travel with the SQLite artifact; no external source file or sidecar is required at runtime.

Only motorway, trunk, primary, secondary, and tertiary roads are drawn. Links enter at zoom 12; lesser road classes never enter the basemap. The routing graph still retains its original walk/drive eligibility rules. Rivers, canals, water polygons, and directed coastlines are independent of routing permissions.

Geometry is rounded to six decimal places and simplified at three detail levels during import. Identical geometries share one stored row across levels; invisible levels are omitted. Line pieces contain at most 128 input vertices, and persisted geometry contains at most 8,000 vertices per feature. Water relations exceeding 200,000 input vertices, containing unsupported nested geometric members, or missing complete rings are skipped and counted in metadata. Oversized source ways are also skipped for display. Display geometry is never used for routing.

Coastal water follows [OSM's land-left, sea-right direction](https://wiki.openstreetmap.org/wiki/Tag:natural%3Dcoastline). The query clips and joins shorelines, closes complete chains along the viewport boundary, and retains coastal islands as holes. A nearby shoreline supplies the side for views wholly on land or sea. Interior breaks suppress ocean fill rather than inventing a coast. The PBF header bounds, or the retained feature extent when the header omits bounds, limit coverage. This does not reconstruct missing ocean geography beyond a regional extract.

## Runtime bounds

- An SQLite R-tree selects the requested area, detail level, feature class, and zoom before loading geometry. Coastline searches do not scan unrelated roads.
- Each request opens a read-only connection with a 4 MiB page-cache target and no memory mapping; it closes the connection after querying. This is a SQLite cache setting, not a total process-memory guarantee.
- Responses contain at most 4,500 features and 80,000 vertices. Water has a separate half-budget so it cannot displace all roads. SQL sorts feature metadata and fetches geometry only after it fits the response budget.
- Coastline assembly separately caps both candidate input and clipped geometry at 4,096 pieces and 80,000 vertices. Boundary joins use sorted crossings instead of scanning all crossings repeatedly. Island assignment has a containment-work budget; exceeding either geometry or work limits keeps bounded shoreline outlines and omits ocean fill.
- The browser requests 18% padding around its viewport, reuses it for small pans, debounces moves, aborts superseded fetches, and discards geometry on City or basemap changes. A fresh OSM import invalidates the loaded geometry.
- Worker updates are serialized with only the newest waiting viewport retained. City changes hide the old layers immediately and wait for active worker work before removing or reusing the source, preventing delayed geometry from the previous City from reappearing.
- One GeoJSON source serves all five map layers. Its tile index stops at zoom 14 with a 32-pixel buffer and 0.75 simplification tolerance. Light/dark changes update paint without fetching geometry.
- Responses report sampling and incomplete geometry. There is no city-wide JavaScript geometry cache or tile-provider fallback.

These limits bound retained feature data, not total Electron, worker, tile-cache, or GPU memory. Viewport queries run synchronously; an R-tree query over many matching features can still take longer than a small-city query. Full-region import and prolonged large-city use require separate memory and responsiveness measurements.

Existing street stores remain usable for routing. A store without `localBasemap` metadata returns `needs-import` with a fresh-import instruction; it cannot recover road classes or water from routing snapshots that omitted them.

## Verification

Run `npm run check:map`, `npm run check:osm-pbf`, `node test/check-city-build-equivalence.mjs`, and `node test/check-map-runtime.mjs`. The basemap fixture checks road selection, lake holes, coastal islands, offshore and inland views, query budgets, pathological coastline clipping, R-tree access, compaction, and independence from routing snapshots. The Electron fixture renders both appearances through the local Studio protocol with all external HTTP requests blocked, overlaps updates with repeated City-source replacement, verifies that only the newest geometry renders, and checks source removal.

For manual visual review, the runtime fixture accepts `VIGO_BASEMAP_PREVIEW_FILE` pointing to a local GeoJSON response and `VIGO_BASEMAP_SCREENSHOT_DIR` for light/dark screenshots. Keep downloaded extracts and generated images outside tracked source files.
