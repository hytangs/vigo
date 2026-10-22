# V1 prepared-data compatibility

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

## Add street names to an existing City

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
