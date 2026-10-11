# Permanent VIGO 0.5 data baseline

The published VIGO 0.5.0 release at source `c8da84fff7812d570fd5985cbcbcb83885587bf6`
is the permanent prepared-data baseline. Future VIGO readers must continue to
open these Cities without requiring users to rebuild them. Future standard City
writers must continue producing data readable by that published runtime.

Keep the existing City manifest, routing/street SQLite layouts, prepared access
and timetable snapshots, CCH members, and portable relative references compatible.
Do not reuse a format identifier for an incompatible layout. Algorithm and
performance improvements must retain the published representation. Additional
optional metadata/indexes are allowed only when existing readers can ignore them
and old Cities still work without them. A new required format or an automatic
rebuild of valid 0.5 Cities violates this policy.

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
With `GH_TOKEN` or `GITHUB_TOKEN` (`actions: read`), it retrieves the original
archive-only CI build (run `37885649818`) and verifies the pinned archive SHA-256.
Without a token, it checks the release download against the same hash. CI artifacts
have limited retention; if the original artifact is unavailable, the gate accepts `VIGO_050_REFERENCE_BINARY` pointing to an extracted package whose
manifest, source identity and executable hash are verified.

The small synthetic GTFS/OSM and prepared archive live in
`test/fixtures/format-0.5.0`. Never regenerate that archive, change its pinned
hashes, or weaken its expectations to hide an incompatibility. It is a permanent
historical reader test, not generated build output. Extend coverage with new
fixtures while retaining this baseline. The initial fixture covers regular
walking/transit; additional wheelchair, collection and large-network fixtures
are still needed before claiming comprehensive format coverage.

The policy is permanent; the tests are evidence for the cases they execute,
not a proof that all future code or every possible City is compatible.
