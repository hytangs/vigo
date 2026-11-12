# Walking costs and source evidence

This page explains how VIGO prices walks between streets, stops and platforms, which OSM permissions it follows, and what a returned walk does and does not establish. Every runtime uses the same prepared City data and rules.

## Time and connectivity are separate

A [GTFS transfer minimum](https://gtfs.org/documentation/schedule/reference/#transferstxt) constrains the time between services. It does not describe a physical path or permit arbitrarily fast walking. Before searching, VIGO prices each expanded stop pair at the larger of the published minimum and its distance divided by the configured walking speed, rounded up to a whole second. The distance is at least the straight-line separation of valid stop coordinates. That separation supplies a lower bound; a missing interior path remains unknown.

[GTFS pathways](https://gtfs.org/documentation/schedule/reference/#pathwaystxt) describe directed station connections. An explicit `traversal_time` remains a source cost, including for lifts and moving walkways. If it is absent, VIGO derives a time from the available length and walking policy. A declared pathway supports the feed's connectivity model; it is not a current field measurement. When a station declares pathways and public entrances, coordinate access uses those entrances; snapping straight to a platform cannot bypass the station connections.

The walking floor enters preparation before boarding selection, so a depart-at query may choose a later connection and an arrive-by query may require an earlier departure. Route and both scalar and journey Matrix modes use those same costs.

## Pedestrian permissions

The OSM importer reads tags on ways and their nodes, including packed dense nodes. It excludes `foot=no`, `foot=private`, and `foot=use_sidepath`, honors explicit pedestrian permission over generic access, and preserves directed pedestrian rules. A motor-vehicle one-way restriction alone does not prohibit walking in the reverse direction.

An explicit pedestrian permission also overrides general conditional restrictions, and a conditional rule that only permits walking where the base rule already permits it does not disconnect the way. Restrictive or unknown pedestrian conditions, opening hours and conditional directions stay excluded, because VIGO does not evaluate them at journey time.

For nodes, impassable barriers and denied access exclude incident pedestrian segments. Ambiguous gates require explicit permission. Foot/access conditional rules and opening hours other than `24/7` are excluded because this static model does not evaluate their conditions. This conservative policy can reduce coverage, including approaches to a blocked barrier. Driving retains its separate permissions. See the OSM definitions of [foot access](https://wiki.openstreetmap.org/wiki/Key:foot) and [pedestrian direction](https://wiki.openstreetmap.org/wiki/Key:oneway:foot).

## What a returned route establishes

Closed elevator ways describe cabin footprints, so they are not imported as
horizontal walking loops. Open inclined-elevator ways retain their existing
walking treatment. Station vertical travel still requires declared pathways;
removing a cabin outline does not invent a street-to-platform connection.

`streetPathVerified` concerns the prepared street graph; it is not independent proof of an entire door-to-platform walk. Free-coordinate snapping is returned separately as `endpointConnector`, with `streetPathVerified: false`. The walk's line still starts or ends at the requested coordinate, so a journey is drawn without gaps; its first or last segment is that connector. An assumed station interior has `stationAccessStatus: "unverified"`; a published transfer minimum does not change that status. Selected station costs and stop chains are exposed in `accessCost` when available.

An independent physical audit needs a continuous, directed source path, legal node/way access, and evidence for the links between the requested location, street, stop, entrance, and platform. A line near an OSM street is insufficient. Source gaps require better mapped entrances, agency pathways, or validated access links. Even complete source evidence does not establish current closures or observed travel times.

An interior GTFS node may omit coordinates. VIGO retains its declared pathway connections and stop ID but omits that node from displayed geometry, setting `stationGeometryStatus: "incomplete"`. A line between the remaining known coordinates is schematic. If a source-timed pathway also lacks length and located endpoints, its distance contributes only a zero lower bound and the leg reports `stationDistanceStatus: "lower_bound"`; it is not measured zero-distance walking. When `traversal_time` is absent, stairs with a nonzero `stair_count` use one second per step and fare/exit gates use five seconds. These fixed routing assumptions are recorded as `gtfs_pathway_estimated`, retain `stationAccessStatus: "unverified"`, and are floored by available distance at the configured walking pace. They are not measured or agency-published traversal times. Explicit traversal times take precedence. Other pathways without time, length, or distinct located endpoints remain excluded and reported as `unpriced_pathways`. The declared station topology remains in force, so exclusion cannot create a fallback shortcut. A feed-supplied connection alone does not certify its physical duration.

## Rebuild to apply these rules

These rules are prepared into a City when it is built. To apply them to older data, build a new City from the original GTFS and OSM into a new directory, and keep the old City with its original runtime for reproducibility. The engine rejects prepared data whose street, timetable or transfer policy is older than it supports.

| Prepared layer | Current version | What it adds |
| --- | --- | --- |
| Street store | Schema v6 | Node restrictions from the PBF; platform outlines excluded from walking |
| Routing store | Schema v3 | Missing coordinates and pathway costs distinguished from real zeros |
| Transfer semantics | v4 | Pathway modes and stair counts kept from the GTFS |
| Prepared access policy | v9 | Street transfers through public entrances and directed station pathways |

Each transfer between boardings uses at most one external transfer edge, and the itinerary keeps every original pathway segment. Declared pathways suppress invented parent-station shortcuts.

The public regression checks use generated inputs:

```sh
npm run check:osm-pbf
npm run check:national-focused
npm run check:standalone
```

These checks exercise node barriers, access overrides, malformed node tags, pedestrian direction, physically feasible transfer selection in both time directions, scalar/journey matrices, and rejection of old prepared data. They test the implementation and declared input model, not the completeness of any agency's pedestrian map.
