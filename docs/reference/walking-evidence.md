# Walking costs and source evidence

VIGO 0.4.3 corrects underestimated stop-transfer walking times, omitted OSM node restrictions, and missing station coordinates coerced to `(0, 0)`. These corrections apply to both Node Engine and standalone Rust through their shared prepared City data. Rebuild Cities produced by earlier 0.4.3 candidates as described below.

## Time and connectivity are separate

A [GTFS transfer minimum](https://gtfs.org/documentation/schedule/reference/#transferstxt) constrains the time between services. It does not describe a physical path or permit arbitrarily fast walking. Before searching, VIGO prices each expanded stop pair at the larger of the published minimum and its distance divided by the configured walking speed, rounded up to a whole second. The distance is at least the straight-line separation of valid stop coordinates. That separation supplies a lower bound; a missing interior path remains unknown.

[GTFS pathways](https://gtfs.org/documentation/schedule/reference/#pathwaystxt) describe directed station connections. An explicit `traversal_time` remains a source cost, including for lifts and moving walkways. If it is absent, VIGO derives a time from the available length and walking policy. A declared pathway supports the feed's connectivity model; it is not a current field measurement. When a station declares pathways and public entrances, coordinate access uses those entrances; snapping straight to a platform cannot bypass the station connections.

The walking floor enters preparation before boarding selection, so a depart-at query may choose a later connection and an arrive-by query may require an earlier departure. Route and both scalar and journey Matrix modes use those same costs.

## Pedestrian permissions

The OSM importer reads tags on ways and their nodes, including packed dense nodes. It excludes `foot=no`, `foot=private`, and `foot=use_sidepath`, honors explicit pedestrian permission over generic access, and preserves directed pedestrian rules. A motor-vehicle one-way restriction alone does not prohibit walking in the reverse direction.

For nodes, impassable barriers and denied access exclude incident pedestrian segments. Ambiguous gates require explicit permission. Foot/access conditional rules and opening hours other than `24/7` are excluded because this static model does not evaluate their conditions. This conservative policy can reduce coverage, including approaches to a blocked barrier. Driving retains its separate permissions. See the OSM definitions of [foot access](https://wiki.openstreetmap.org/wiki/Key:foot) and [pedestrian direction](https://wiki.openstreetmap.org/wiki/Key:oneway:foot).

## What a returned route establishes

`streetPathVerified` concerns the prepared street graph; it is not independent proof of an entire door-to-platform walk. Free-coordinate snapping is returned separately as `endpointConnector`, with `streetPathVerified: false`. An assumed station interior has `stationAccessStatus: "unverified"`; a published transfer minimum does not change that status. Selected station costs and stop chains are exposed in `accessCost` when available.

An independent physical audit needs a continuous, directed source path, legal node/way access, and evidence for the links between the requested location, street, stop, entrance, and platform. A line near an OSM street is insufficient. Source gaps require better mapped entrances, agency pathways, or validated access links. Even complete source evidence does not establish current closures or observed travel times.

An interior GTFS node may omit coordinates. VIGO retains its declared pathway connections and stop ID but omits that node from displayed geometry, setting `stationGeometryStatus: "incomplete"`. A line between the remaining known coordinates is schematic. If a source-timed pathway also lacks length and located endpoints, its distance contributes only a zero lower bound and the leg reports `stationDistanceStatus: "lower_bound"`; it is not measured zero-distance walking. If a pathway has no time, length, or distinct located endpoints, VIGO excludes it and reports `unpriced_pathways`. The declared station topology remains in force, so exclusion cannot create a fallback shortcut. A feed-supplied connection alone does not certify its physical duration.

## Upgrade and check

Build a new City with the current runtime and the retained raw GTFS/OSM inputs. Use the [Boston quickstart](../guides/quickstart.md) and a new output directory, then prepare it for the standalone executable as described in the [Rust guide](../guides/rust-standalone.md). Keep the old City with its original runtime for reproducibility.

Street schema v4 cannot be upgraded by reopening a cache: its missing node restrictions require reimport from the original PBF. The new street schema is v5. Routing-store schema v3 distinguishes missing coordinates and pathway costs from genuine zeros and requires a fresh GTFS import. The prepared access policy also moves to v5. Node Engine refreshes outdated timing preparations; standalone Rust requires current prepared data and rejects stale street, routing-store, or transfer-time policies.

Public regression checks use generated inputs and can be run from the source checkout:

```sh
npm run check:osm-pbf
npm run check:national-focused
npm run check:standalone
```

These checks exercise node barriers, access overrides, malformed node tags, pedestrian direction, physically feasible transfer selection in both time directions, scalar/journey matrices, and rejection of old prepared data. They test the implementation and declared input model, not the completeness of any agency's pedestrian map.
