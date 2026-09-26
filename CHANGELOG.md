# Version history

## 0.4.2 — 2026-09-25

Persist Drive hierarchies during City build, prepare only the requested CLI mode, and share endpoint work in native coordinate Matrix execution. Move shape alignment and stable identifier arithmetic into Rust while retaining JavaScript source loading and itinerary assembly. Clarify blocked access and station-pathway costs, preserve cache-disable boundaries, isolate packaged Engine from shell credentials, and strengthen source/package leak checks. Remove the stale README screenshot and refresh current documentation. API 1.0, City format 1, and Result schema 1 are unchanged. See the [release notes](docs/releases/0.4.2.md).

The final freeze repairs worker queue recovery after message-transfer failures, bounds stop-projection cache retention, aligns mock memory accounting with production, validates CI tag/version agreement, and documents remaining architectural cost centers.

## 0.4.1 — 2026-09-21

Move active-timetable indexing, transfer preparation, realtime reconstruction, and directed station-path compilation into Rust without JavaScript execution fallbacks; preserve transfer precedence and snapshot layout, fix supported reordered bunching membership and multiple map links, and modularize Engine and Studio. Reduce cold preparation, unreachable-departure scan work, realtime reconstruction, and unused drive allocations. Unify shape alignment, fix compact Network navigation, organize documentation by topic, and consolidate test scaffolding. API 1.0, City format 1, and Result schema 1 are unchanged. See the [release notes](docs/releases/0.4.1.md).

## 0.4.0 — 2026-09-18

API 1.0, City format 1, and Result schema 1 are unchanged. See the [release notes](docs/releases/0.4.0.md).

- Add live network inspection, trip times, station boards, line diagrams, and experimental Ask to VIGO Studio.
- Show reported added service in line views and the trip selector without inventing scheduled times or delays.
- Detect compressed spacing across prediction-order changes and mark both vehicles in a bunching pair.
- Separate scheduled and realtime Route modes, disable unsupported transfer caps for via-point routes, and clear recovered routing errors.
- Delete individual GTFS feeds or OSM data from City sources while preserving the remaining data and notebooks.
- Fix map startup readiness and cross-platform UI test cleanup and keyboard focus.

## 0.3.2 — 2026-09-12

API 1.0, City format 1, and Result schema 1 are unchanged. See the [release notes](docs/releases/0.3.2.md).

- Replace Studio Route place-search fields with coordinate map points, up to eight points, direct repicking and reordering, and a persistent rerun control.
- Align desktop and mobile navigation, contain playback controls and text, and simplify the GTFS inspector.
- Preserve route colors in vehicle markers and show direction inside each circle.
- Correct scheduled vehicle shape alignment, loop stop occurrences, dwell, service dates, and live branch membership.
- Preserve repeated stop visits and directed shared-edge edits across complete GTFS branches.
- Revalidate local web assets so updated styles and scripts are loaded after upgrades.
- Report street routing, driving, station access, and City publication stages during Build.
- Define complete raw-file Build and first-answer timing, including the limits of compiler-stage diagnostics.
- Ordered waypoint routes preserve fractional intermediate clocks across HTTP and CLI, for depart-at and arrive-by routing.

## 0.3.1 — 2026-09-11

Stabilization release; API 1.0, City format 1, and Result schema 1 are unchanged. See the [release notes](docs/releases/0.3.1.md).

- Update MapLibre to 6.4.1 to fix attribution sanitization; verify the built map through the Studio protocol.
- Remove filesystem-timestamp dependencies from prepared street/drive index discovery.
- Package and verify macOS Apple Silicon/Intel, Linux ARM64/x64, and Windows x64; exchange prepared City fixtures between targets.
- Align Engine / Studio / Python documentation and state the bounded Studio-only realtime routing support.

- Persist prepared station-access state with each City and materialize only selected station paths when reopening.
- Use portable timetable snapshots across Node and the packaged runtime, avoiding V8-version-dependent recompilation.
- Load and align ride geometry only for selected trips; remove blanket geometry preparation and calibration routes from opening.
- Keep the main documentation focused on Studio and the command line; maintain Python examples in the separate wrapper repository.
- Remove provisional City metadata aliases from CLI results and inspection.
- Reuse the unrestricted search prefix when an exact transfer-capped journey needs a later arrival deadline.
- Keep distinct persisted access profiles for complete source identities instead of a shared version prefix.
- Place complete plans first in streaming responses so clients can preserve native JSON during export.

## 0.3.0

VIGO 0.3 establishes one product model:

```text
GTFS + OSM -> City -> Scenario -> Route | Matrix | Reach -> Result
```

- A City is one complete, movable directory. Building publishes it atomically.
- Route, Matrix, and Reach are the only public computation families.
- Scenario holds transport changes; walking limits and times remain Query inputs.
- Compare acts on completed Results.
- Studio and the command line use the same names and meanings.
- Query answers are computed on every call. Repeated work benefits from an open City and prepared indexes, not saved answers.
- Runtime preparation, temporary-file cleanup, and worker lifetime are managed automatically.
- Build, open, compute, and end-to-end timings remain separate.

VIGO 0.3 intentionally removes the provisional commands, maintenance controls, and duplicate analysis surfaces that preceded this model. There is no compatibility layer.

The final 0.3.0 fixes preserve Studio Scenario drafts between sessions and apply edited road gaps to every affected branch while retaining each branch's published geometry and runtime. Derived routing snapshots use the current content identity; older snapshots rebuild automatically. Transit Matrix uses the same native one-to-many computation for every matrix size, without an implicit transfer-time buffer. See the [GTFS support matrix](docs/reference/gtfs-support-matrix.md) and [Studio guide](docs/guides/studio.md) for the supported source rules and interface limits.

## Private development history

Versions before 0.3.0 were private development milestones. These entries retain the dates and terminology recorded in the archived version notes.

### 0.2.5 - 2026-08-21

- Made GTFS and OSM preparation recoverable after restart, with cancellation, retained inputs, and retry support.
- Unified routing statuses and preparation timings across the desktop, CLI, and Python interfaces.
- Separated live vehicles from scheduled playback and preserved every route pattern within a feed-scoped service.
- Reused resident native one-to-many routing for accessibility maps and returned complete reached-street geometry in packed edge bundles.

### 0.2.4 - 2026-08-21

- Consolidated OSM preparation around sealed runtime snapshots, persisted driving data, and the native pedestrian CCH index.
- Refreshed GTFS and OSM readiness after import and reported missing or stale native indexes with rebuild instructions.
- Added memory- and load-aware parallel compilation and verified the packaged native runtime with the Python wrapper.

### 0.2.3 - 2026-08-15

- Added accessible-area polygons and directed street-path views backed by the same native search.
- Added feed- and branch-scoped stop insertion and movement, with published shapes or optional local OSM road inference.
- Consolidated settings and source intake, and bundled the Rust kernel with the standalone desktop runtime.

### 0.2.2 - 2026-08-14

- Used feed-scoped GTFS route IDs consistently in catalogs, search, the route browser, and the service atlas.
- Moved accessibility and finite-service scenario analysis onto the resident native timetable kernel.
- Shared native street acceleration across analysis and point routing, with point surfaces and signed scenario differences.

### 0.2.1 - 2026-08-11

- Separated timetable-store admission from service-date and coordinate-access preparation.
- Coalesced preparation work so an early route request waited for the same preparation operation.
- Kept the prepared routing worker resident while its desktop workspace remained open.

### 0.2.0 - 2026-08-01

- Moved production graph and timetable search into the resident Rust Node-API kernel.
- Brought street paths, scheduled transit, arrive-by routing, matrices, accessibility, and scenario propagation under native routing ownership.
- Kept SQLite as durable storage and JavaScript as orchestration and presentation code.

### 0.1.7 - 2026-07-31

Git milestones recorded routing and release-hardening work under this label. Package metadata remained at 0.1.6; there was no separately versioned 0.1.7 package release.

### 0.1.6 - 2026-07-28

- Established the map-first transit workbench with Explore, Diagnose, Compare, Analyze, Review, and Publish modes.
- Added a complete SQLite-backed service atlas and a shared left-side object inspector.
- Supported local review records and evidence exports containing reports, findings, and route geometry.

### 0.1.5 - 2026-07-20

- Consolidated timetable queries into resident in-memory execution, using SQLite for compilation and persistence.
- Removed SQL routing fallbacks and aligned desktop, HTTP, CLI, streaming, and Python requests on one executor.
- Preserved boarding and alighting permissions at individual GTFS stop events, including through-riding.

### 0.1.4 - 2026-07-18

- Improved native macOS window controls, appearance, workspace-folder access, and compact layouts.
- Opened a lightweight workspace library at startup and deferred project hydration and routing preparation until needed.
- Improved route-result relevance, stop-search ranking, and the distinction between published and inferred geometry.

### 0.1.3 - 2026-07-15

- Established local-first macOS routing through the persisted desktop backend.
- Prepared service and street snapshots before routing and presented distinct transit and graph-verified walking alternatives.

### 0.1.2 - 2026-07-13

- Introduced the standalone macOS app with a bundled local Node.js runtime and first-run workspace configuration.
- Added multi-feed workspaces, GTFS profiling, map inspection, scheduled playback, and GTFS-Realtime inspection.
- Added Pathfinder, local OSM walking data, timetable sidecars, and GeoJSON/GPX route export.

### 0.1.1 - 2026-07-01

Git history recorded this milestone while package metadata remained at 0.1.0. It was not a separately versioned package release.

### 0.1.0 - 2026-06-30

- Established the initial browser-first, local-first GTFS workspace.
- Supported GTFS ZIP import, project storage, linked map and table views, feed validation, scheduled-vehicle projection, route and stop search, and optional realtime inspection.
