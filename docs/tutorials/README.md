# VIGO tutorials (0.3.0)

These tutorials take one declared GTFS + OSM snapshot from raw inputs to an
inspectable journey, a detailed leg table, a travel-time matrix, and an
edge-supported accessibility surface. Every path keeps the service date,
walking policy, source identities, and full result beside the presentation
output.

## Choose a path

| Question | Start here | You will finish with |
| --- | --- | --- |
| I want a complete reproducible command-line workflow | [CLI Document 0](cli/00-setup-and-build.md) | A compiled network from one matching GTFS + OSM input pair |
| I want to understand one journey and its geometry | [CLI Tutorial 2](cli/02-route-a-batch.md) | A ready/blocked result, leg-level details, route geometry, and a browser map |
| I want to keep routing resident for an application | [CLI Tutorial 3](cli/03-stream-requests.md) | One NDJSON process with explicit response and error semantics |
| I want travel-time rows or an accessibility surface | [CLI Tutorial 4](cli/04-matrices-and-isochrones.md) | Labeled one-to-many rows, a full raster, and GeoJSON contours |
| I want the desktop workflow | [Quick Start](../quickstart.md) and [Evidence](../accessibility.md) | Network inspection, Route replay, and baseline/case accessibility analysis |

The complete numbered path is in the [CLI tutorial index](cli/README.md).
Document 0 contains the complete setup flow; generated source inputs and network
artifacts remain outside the VIGO source checkout.

## The shared mental model

```text
GTFS ZIP + OSM PBF
        ↓ validate and compile
SQLite timetable store + directed OSM street store
        ↓ exact service-date query
route / route-ndjson / one-to-many / isochrone
        ↓ inspect status, diagnostics, geometry, and provenance
CSV + full JSON + GeoJSON/HTML presentation
```

The timetable supplies stops, routes, trips, calendars, and stop times. OSM
supplies the directed street graph used for coordinate access, transfers,
egress, and the accessibility surface. VIGO does not replace a missing street
path with a radial or straight-line walk.

## One environment, several interfaces

Document 0 uses `$HOME/Documents/vigo` for the source checkout and
`$HOME/Documents/vigo-data` for generated data. Keeping those
directories separate makes rebuilds and release checks safer. Every CLI command
reuses the same compiled stores and native Rust kernels as the desktop and HTTP
surfaces.

## What a tutorial result proves

Treat a result as evidence only after checking both layers:

- the command completed successfully; and
- the returned plan/row is `ready`, or the retained `blocked` reason is the
  result you intend to study.

For a journey, retain the full JSON because the compact CSV does not contain
all legs, route/trip identity, diagnostics, or geometry. For an isochrone,
retain the full result beside the GeoJSON because the GeoJSON contours do not
carry the complete raster and source/query receipt.

The [automation tutorial](cli/05-automate-and-diagnose.md) turns these checks
into a repeatable run bundle. The [accessibility map guide](../guides/accessibility-maps.md)
turns a retained isochrone result into a legible presentation.

## First desktop session

The desktop path follows the same contract without requiring a terminal:

1. Open the app, create a local workspace, and import one static GTFS ZIP.
2. Add the matching OSM PBF when you need coordinate routing, walking access,
   or Evidence accessibility analysis.
3. In **Network**, inspect the imported routes, stops, patterns, service date,
   and source lineage before asking a question.
4. In **Route**, select the exact date and time, reproduce one journey, and
   inspect its ordered legs and route geometry.
5. In **Evidence**, fix the origin, date, departure, walking policy, cutoff,
   radius, and raster size before comparing a baseline with a named case.

The [Quick Start](../quickstart.md) has the concrete import and launch steps;
[Accessibility](../accessibility.md) defines the surface and scenario
semantics. This keeps the UI walkthrough and CLI tutorials on the
same data and evidence model.
