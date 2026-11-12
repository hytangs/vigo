# Prepared-data contract

A City written by one VIGO release stays readable by later releases, and every standard City stays readable by the published reference runtime. This page is that promise: the compatibility policy, the release gate that enforces it, and the optional extensions a City may carry. Maintainers must follow it for any change to a reader, a writer or prepared data.

## Compatibility policy

The published reference runtime at source `c8da84fff7812d570fd5985cbcbcb83885587bf6`
is the permanent prepared-data baseline. Future VIGO readers must continue to
open these Cities without requiring users to rebuild them. Future standard City
writers must continue producing data readable by that published runtime.

Keep the existing City manifest, routing/street SQLite layouts, prepared access
and timetable snapshots, CCH members, and portable relative references compatible.
Do not reuse a format identifier for an incompatible layout. Algorithm and
performance improvements must retain the published representation. Additional
optional metadata/indexes are allowed only when existing readers can ignore them
and old Cities still work without them. A new required format or an automatic
rebuild of valid baseline Cities violates this policy.

This applies to regular, wheelchair and scenario-collection data. It does not
promise immutable GTFS/OSM contents or identical answers after a routing bug fix.
Invalid/corrupt source data must still be rejected. Internal diagnostic traces
are not a persistent data format. Public `vigo.*.v1` results retain existing
field meanings, units and time conventions; additions must remain optional.

## Release gate

`npm run check:format-050` builds candidate runtimes and tests both directions:

- The candidate reader opens the frozen City produced by the published CLI.
- The published Rust reader opens a City produced by the candidate writer.

Both execute transit, arrive-by, walking, matrix and reach queries. The test is
also part of `check:standalone`, used by the engine and release CI matrices.
The original archive-only CI build (run `37885649818`) is preserved in the
`v0.5.0` release under `*-baseline-c8da84fff781.tar.gz` asset names. Downloads
require no GitHub token and do not expire with Actions artifact retention.
Every platform retains its original pinned SHA-256; the later, differently
packaged reference downloads are not interchangeable with these baseline assets.
For offline checks, `VIGO_050_REFERENCE_BINARY` may point to an extracted
package whose manifest, source identity and executable hash are verified.

The small synthetic GTFS/OSM and prepared archive live in
`test/fixtures/format-0.5.0`. Never regenerate that archive, change its pinned
hashes, or weaken its expectations to hide an incompatibility. It is a permanent
historical reader test, not generated build output. Extend coverage with new
fixtures while retaining this baseline. The initial fixture covers regular
walking/transit; additional wheelchair, collection and large-network fixtures
are still needed before claiming comprehensive format coverage.

The policy is permanent; the tests are evidence for the cases they execute,
not a proof that all future code or every possible City is compatible.

## Optional extensions

Each extension below is optional: readers that predate it ignore it, and Cities without it keep working without a rebuild. A present but malformed extension fails admission; an absent one keeps the conservative baseline behavior.

| Extension | Identified by | Used for |
| --- | --- | --- |
| [Bicycle profile](#bicycle-profile) | `bikeProfileVersion=1` | Bike Route, Matrix and Reach |
| [Bicycle turn windows](#bicycle-turn-windows) | `bikeTurnWindowVersion=1` | Time-dependent turn restrictions |
| [Bicycle timed edges](#bicycle-timed-edges) | `bikeEdgeWindowVersion=1` | Time-dependent road access |
| [Bicycle traffic stress](#bicycle-traffic-stress) | `bikeStressVersion=1` | `bike.maxLts` |
| [Bicycle walking access](#bicycle-walking-access) | `bikeWalkAccess` | Walking to and from the bicycle network |
| [Street names](#add-street-names-to-an-existing-city) | `place_streets`, `place_areas` tables | Names for map points |
| [Scenario street bases](#scenario-street-bases-and-endpoint-overlays) | `streets/<osm-sha256>/` | Shared streets in scenario collections |

### Bicycle profile

VIGO writers can add `bikeProfileVersion=1` metadata and four base tables to
`street-index.sqlite`. They do not change the walking/driving snapshots,
required layouts, City version, or existing units. Historical readers ignore
them; new readers require them only for Bike Route and Matrix. A missing
profile produces a bike-preparation error without rebuilding an old City.

| Table | Columns |
| --- | --- |
| `bike_nodes` | OSM `node_id`, integer `lon_e7`, integer `lat_e7` |
| `bike_edges` | `from_node`, `to_node`, positive `distance_cm`, OSM `way_id`, packed `attributes` |
| `bike_turns` | `via_node`, `from_way`, `to_way`, `only_turn` flags |
| `bike_way_turns` | `from_way`, ordered JSON `via_ways`, `to_way`, `only_turn` flags |

Each edge is directed. Length is rounded upward to centimetres. Attribute
bits encode road class (0–2), facility (3–4), surface (5–6), dismount (7),
incline percent plus 30 (8–13), motor speed in km/h (14–21), and destination
access (22); upper bits are reserved. This compact profile stores no tag strings.

The low turn flag bit marks an `only_*` restriction. For node turns, bits 1
and 2 distinguish same-way U-turn and straight movements; bit 3 makes a
conditional-only rule independent of other allowed alternatives. For via-way
turns, bit 1 marks that independent conditional rule. Without a timing index,
conditional prohibitions apply all day. Optional metadata counts unsupported relation
shapes and conditional restrictions. The reference-reader gate also opens a
new City containing these bicycle tables.

### Bicycle turn windows

An optional `bike_turn_windows` table is identified by
`bikeTurnWindowVersion=1`. Its columns are `turn_table` (0 for `bike_turns`, 1 for
`bike_way_turns`), `turn_row` (the referenced table's SQLite rowid),
`start_minute`, and `end_minute`. Row identities must be preserved with this
index. Each interval is half-open in a Monday-first local week:
`0 <= start_minute < end_minute <= 10080`. Intervals for one restriction must
not overlap and are limited to 256. A restriction without interval rows applies
at all times. Malformed present indexes produce a bicycle-preparation error;
absent indexes preserve the conservative baseline behavior.

Writers compile weekly weekday/time ranges and conditional overrides into these
intervals. Unrecognized expressions remain conservative. Readers that ignore the
index still enforce every retained restriction. The current runtime evaluates
node-turn and via-way windows for dated depart-at requests with a known City
timezone. Both share one interned schedule pool. No-turn via-way restrictions
are checked at the final movement; only-turn restrictions constrain each
movement while the mapped sequence is being followed.

### Bicycle timed edges

Optional `bike_timed_edges` and `bike_edge_windows` tables are identified by
`bikeEdgeWindowVersion=1`. Timed edges have the same five columns and units as
`bike_edges`, plus a positive `window_id`. Their allowed entry intervals are in
`bike_edge_windows(window_id,start_minute,end_minute)`, with the same Monday-first,
half-open minute convention and 256-interval limit. Every referenced schedule
must exist, and every stored schedule must be referenced. Both tables must be
present together. Equal schedules may be shared across edges and directions.

These supplemental edges never replace the conservative meaning of legacy
`bike_edges`. Earlier bicycle readers ignore them. The current runtime admits
them only with a usable depart-at date/timezone, evaluates permissions at entry
to each directed segment, and permits completion of a segment entered while
open. Attribute variants, such as cycling versus dismounting, use separate timed
edges. `bike_nodes` contains their endpoints; old readers may see isolated nodes.
The runtime shares one graph across all bicycle preferences and keeps the window
lookup sparse. Internal timed-edge and incoming-turn flags reuse reserved bits
in memory only; they are never persisted in `attributes`.

### Bicycle traffic stress

`bikeStressVersion=1` adds an optional `stress INTEGER NOT NULL` column to
`bike_edges` and, when present, `bike_timed_edges`. Bits 0–2 contain an estimated
LTS integer 1–4; bit 3 permits walking while pushing the bicycle. All other bits
must be zero. Walking permission includes both incident nodes and the direction
of the way. The `attributes` word, table identities and existing units do not
change. Older readers may ignore this column. New readers require both the
version and valid values before accepting a traffic-stress limit; old Cities
without it retain ordinary bicycle routing. The writer removes temporary
intersection data before sealing the City. Custom LTS and signal-aware
intersection adjustment are compiled into the column, not inferred at runtime.

### Bicycle walking access

`bikeWalkAccess` is a JSON metadata value with `version: 1`, the adjacent
`snapshotSuffix` (`.street-accelerator-v7.bin`), and the pedestrian snapshot's
`identity`, `nodeCount` and `edgeCount`. It identifies the optional table
`bike_walk_nodes(bike_node INTEGER PRIMARY KEY, walk_node INTEGER NOT NULL)`.
`bike_node` is the original OSM node ID in `bike_nodes`; `walk_node` is the
zero-based vertex index in that exact spatially ordered pedestrian snapshot.
The join is built from source IDs, not coordinate equality, before source-table
compaction. Walking indexes must be unique, in range, and coordinate-consistent
with their bicycle node. A present malformed or mismatched index fails admission.

These links enable bounded access/egress walks on the prepared public pedestrian
graph. The runtime shares its existing immutable snapshot; it retains only the
node join and query-local walking scratch. Network walks count toward the walking
and total-distance limits and supply mapped geometry. Ordinary coordinate snaps
remain unverified and use the existing 80 m pedestrian snap ceiling. A nearer
pedestrian attachment cannot be skipped to snap to an unrelated bicycle road.
Older readers ignore this index; absent metadata preserves legacy bicycle
coordinate attachment. Rebuilding from OSM creates the index for older Cities.

### Add street names to an existing City

Older Cities may lack the optional `place_streets` and `place_areas` tables.
Coordinate labels then fall back to nearby transit stops or “Dropped pin”.
Use the original OSM PBF to add names without rebuilding the City:

```sh
npm run backfill:project:places -- --city=/path/to/City --osm=/path/to/original.osm.pbf
```

The command verifies the source against the street store's SHA-256 fingerprint,
stages named ways and their nodes in temporary SQLite storage, and commits the
two name tables and an optional `placeNames` metadata receipt together. It does
not change the timetable, routing graphs, accelerators, basemap or City manifest.
A completed upgrade is a read-only no-op on retry. A missing source, mismatch,
cancellation or publication error leaves the previous name tables intact.

Names describe nearby streets, intersections and supported named areas from
OSM; they are not verified postal addresses. No external geocoding is required.
Current Rust lookups reload when the SQLite database or its WAL changes. Re-enter
a coordinate search to refresh already displayed labels. Studio also needs a
build containing coordinate-search naming: quit an older running Studio before
opening the updated application, because its single-instance lock otherwise
keeps the older process active.

### Scenario street bases and endpoint overlays

Scenario collections built from the same OSM bytes and preparation profile keep
one immutable base under `streets/<osm-sha256>/`. Public-only Cities retain the
existing relative `osm` directory link. Endpoint-enabled Cities have their own
`osm/` directory: relative symbolic links point to the common street database and pedestrian
snapshot, and hard links expose the same immutable CCH members inside each City
for published readers that enforce adjacent-file resolution. Meanwhile,
`street-index.sqlite.terminal-access-v1.json` remains a regular City-local file.
Its boundary components depend on that City's timetable stop anchors and must
never be copied from another scenario. The existing filenames and formats remain
readable by published runtimes. Moving the entire collection preserves its links;
copying one City alone still requires including or materializing its referenced
base files.

Archives must preserve hard links to retain the storage savings (for example,
use tar); a copying/export tool may materialize duplicate CCH files without
changing routing results.

The resident runtime identifies the base by the resolved snapshot directory,
shares only the immutable graph and hierarchy, and installs the receiving City's
endpoint overlay. Overlay heap usage is charged per City, separately from the
shared base. `check-scenario-endpoint-access.mjs` compares distinct-boundary
scenarios with separately built Cities, including resident switching, eviction,
relocation and optional published-reader checks.
