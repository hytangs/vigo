# Known routing limitations

This file is public release information, not an internal backlog. A limitation
remains here until both its implementation and adversarial regression evidence
are complete.

## Correctness and GTFS semantics

- Headway-based frequency service with `exact_times=0` is not modeled. Bounded
  deterministic `exact_times=1` windows are expanded into fixed departures
  during import; very large windows remain rejected by the expansion bound.
- Fixed-stop pickup/drop-off permissions are represented per connection.
  On-demand values 2 and 3 remain unavailable because the request model cannot
  perform rider-agency coordination. Continuous pickup/drop-off between
  scheduled stops is not represented; fixed scheduled events on the same trip
  remain routable.
- Route- or trip-scoped transfer rows, timed-transfer guarantees
  (`transfer_type=1`), and in-seat transfer rows (`transfer_type=4/5`) are
  inventoried but omitted from the generic stop-pair graph. They are not
  broadened into unscoped transfers.
- `block_id` same-vehicle continuation is not modeled. Trips carrying a
  `block_id` remain routable independently, but VIGO can overstate a transfer or
  miss a useful in-seat continuation between adjacent trips in the block.
- These exclusions produce `supported_scheduled_core` diagnostics rather than
  disabling unrelated scheduled service. A ready result is optimal only over
  the retained core, and `no_path` establishes non-reachability only within that
  core.
- Pathway direction and traversal time are partially used, with a 60-second
  runtime floor; pathway mode, wheelchair, stairs, slope, and width are not
  complete routing constraints.
- Duplicate core IDs and broken required references are rejected atomically.
  This is an import-safety guarantee, not a claim of complete validation for
  optional GTFS extensions that VIGO does not consume.
- Existing SQLite stores built before the feature inventory must be rebuilt.

## Time

- Query time is a local service-date coordinate, not a timezone-aware instant.
  Multiple agency timezones in one store are blocked; ambiguous/nonexistent DST
  local times are not resolved.
- A civil-time query after midnight does not automatically combine trips from
  the previous service date. The caller must use the originating service date
  and a time above 24 hours when that is the intended GTFS coordinate.
- Long cross-midnight trips are routable only inside the declared horizon.
- Representative-date fallback is opt-in and changes the service date; it is
  not evidence for exact-date availability.

## Walking, transfers, and accessibility

- Nearby transfers are prepared as complete directed Rust one-to-many
  expansions from alightable to boardable stops within 500 m on the imported
  OSM graph. They cannot cross disconnected graph components, but correctness
  still inherits omissions or access-tag errors in that source graph.
- The PBF street builder respects explicit pedestrian one-way, directional foot
  access, and known conveying direction. `conveying=yes` and
  `conveying=reversible` do not prove a direction at query time, so those ways
  are excluded and counted in street-store metadata rather than guessed.
  Barriers, turn restrictions, and many access subtleties remain incomplete.
- PBF admission requires one `OSMHeader` before data, supports raw and zlib
  payloads, enforces the format's 64 KiB BlobHeader and 32 MiB expanded-blob
  limits, and rejects unknown required features or compression. LZ4, Zstandard,
  historical-information blocks, and files that omit required feature
  declarations are unsupported rather than silently skipped.
- Drive can customize its CCH time metric from a fresh normalized traffic
  snapshot, but VIGO does not fetch a commercial traffic feed itself. Coverage
  and map-matching quality depend on the caller's adapter; signals, turn costs,
  and OSM turn-restriction relations remain unmodeled.
- The walking tag filter is intentionally small and is not a complete OSM
  pedestrian/accessibility profile.
- Coordinate access and egress retain every role-compatible stop reached by the
  directed OSM search inside the declared radius. This is complete for the
  admitted snapshot, not for pedestrian links missing from OSM.
- Desktop and lower-level map-point routing fail closed until an
  identity-current OSM street store and native snapshot are ready. Explicit
  stop-to-stop HTTP and CLI calls can run without street access.
- Walking speed, boarding slack, walk clamp, and search horizon are global
  policies rather than person-specific accessibility settings.

## Algorithms and objectives

- “Exact” means exact within the active timetable, horizon, candidate access
  set, and transfer graph. It is not an unconditional physical-network proof.
- When diagnostics report `supported_scheduled_core`, the active timetable and
  transfer graph have already excluded the unsupported semantics listed above.
  Exactness therefore does not extend to the omitted feed content.
- Internal Pareto state covers arrival and boardings only. Fare, reliability,
  accessibility, route preference, waiting, and walking are not a complete
  multi-criteria frontier.
- The five-route UI set is a bounded usefulness selection, not a full Pareto
  profile. It may legitimately return fewer choices.
- Departure-window profiles are discrete sampled departures, not continuous or
  probabilistic profiles.
- Arrive-by is supported for one-to-one itineraries, but arrive-by matrix
  routing is rejected by `vigo.routing.matrix.v1`.
- Shared matrices return travel times, not reconstructable itineraries.

## Itinerary and geometry

- Shape-backed geometry is evidence-bearing and retains every published source
  point. If a feed has no usable shape, ordinary network lenses show no inferred
  alignment; selected-itinerary and Shape/Risk QA views may show a dashed,
  explicitly inferred stop sequence.
- Exact source-row offsets and a full replay provenance ledger are not exported.
- Same-vehicle continuation cannot be rendered until interlining is modeled.
- Untimed interior stop-time gaps retain their timed endpoints and report
  `interpolated-stop-time-gap`; omitted interior timestamps are not claimed as
  exact schedule evidence.

## Cache, scale, and reproducibility

- New street stores carry the source-PBF SHA-256; older stores must be rebuilt.
- Cross-machine and cross-operating-system byte-identical output has not yet
  been demonstrated for all builders and evidence packages. `builtAt` is
  intentionally nondeterministic metadata and must be excluded from semantic
  comparison.
- National-scale preparation can be storage-bound. Compact kernels are bounded
  by active segments and estimated bytes; exceeding a production bound is an
  explicit resident-kernel error, not a SQLite route fallback.
- A service set without a persisted active-kernel snapshot can take seconds to
  compile on a national feed. Pathfinder now returns from date-independent
  store admission while exact active-date, transfer, and coordinate-access work
  continues in the resident worker. A route submitted before that work finishes
  waits for it, so UI readiness is not a full cold-route latency claim.
  Content-addressed service-set keys reuse identical calendars, but a feed whose
  active service set changes daily can still create many large snapshots. The
  current build prunes them when derived artifacts are rebuilt but does not
  yet maintain an online per-store LRU. Prebuilding every date is neither
  attempted nor recommended.
- Route-result, GTFS/OSM open-store, topology-sidecar, active-service-date,
  component, and individual OSM path/snap caches are bounded. Retained-memory
  distributions across repeated pathological workloads remain a release
  measurement requirement.
- Performance evidence is strongest for the existing regional and national
  corpora; it is not a universal latency guarantee.

## Failure transparency and product scope

- Multiple agency timezones expose a machine-readable feed-wide blocker.
  Supported-core exclusions are exposed separately in routing coverage
  diagnostics; they must not be presented as full-feed support. Timeout, memory
  limit, stale cache, incomplete import, certification fallback, and internal
  inconsistency are not yet represented by one versioned result-status enum on
  every API surface.
- GTFS-RT scheduled trip updates are applied when they match a stored scheduled
  trip and remain fresh. New unscheduled trips, unsupported stop relationships,
  unmatched trips, and stale feeds fall back to the scheduled timetable with
  diagnostics; the desktop shows the freshness state.
- The supported durable transport path is SQLite. The stale JSON batch executor
  and JSON-to-street-store compatibility builder are removed; legacy street
  stores are rejected and must be rebuilt from OSM PBF.
