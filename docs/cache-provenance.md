# Cache and provenance specification

## 1. Rule

A cache key is a correctness boundary. It must identify the canonical data,
schema and algorithm generation, complete query semantics, and every policy
that can alter reachability or ordering. A diagnostic run must report cache
state and must never present a cache lookup as search time.

Canonical GTFS stores use a SHA-256 content fingerprint. Schedule-derived and
merged stores hash stable, sorted source descriptors and source content. File
path, size, modification time, or `builtAt` alone are not data provenance.
New OSM PBF stores persist a streamed SHA-256 source fingerprint. Older street
stores without it must be rebuilt before they are used as release evidence.

## 2. Cache inventory

| Cache | Lifetime and bound | Complete key or identity | Required invalidation |
|---|---|---|---|
| Open GTFS SQLite store | Process LRU; default 8, configurable 1--32 | Absolute store path plus checked storage identity. Metadata includes source fingerprint and schema. | Replace/modify the SQLite file, project deletion, explicit invalidation, or LRU eviction. |
| Open OSM SQLite store | Process LRU; default 4, configurable 1--16 | Resolved store path plus checked storage identity; metadata carries the PBF content fingerprint on new builds. | Replace/modify store, explicit disposal, or LRU eviction. |
| Pedestrian accelerator snapshot | Persisted binary beside one OSM store; loaded only within edge, store-size, and worker-memory budgets | Snapshot schema v3 plus OSM file size/mtime, street schema, PBF source fingerprint, and exact node/edge counts. | Any identity mismatch rejects the snapshot. Eligible large snapshots are built only in the offline import worker; coordinate routing is blocked with a rebuild instruction when absent. |
| Street and drive CCH generation | Immutable structure plus one or more metric files and a manifest written last | SHA-256 of the source accelerator snapshot, structure, and every metric; exact filenames and byte lengths; node, edge, and CCH arc counts; format and builder version | A missing manifest/member, digest mismatch, dimension mismatch, or substituted metric rejects the whole generation before mmap loading. |
| Active services | 512 date/day entries per open GTFS store | Resolved service date and service-day template mode. | Store replacement, LRU eviction, or process close. |
| Service-date resolution | 256 entries | Service model, requested date, service-day, and fallback policy. | Store replacement. |
| Stop access/egress | 20,000 entries | Exact coordinate array, selected stop ID/source, walk budget, street-store path, expanded-recovery flag. | GTFS or OSM store replacement; access-policy version change. |
| Trip connection materialization | Weighted LRU: 8,192 trips, 80,000 segments, 96 MiB | Trip ID inside one content-identified open store. | Store replacement; connection schema/normalization version change. |
| Static-topology sidecar | Process LRU; default 16, configurable 1--64 | Sidecar path, topology schema v3, GTFS topology fingerprint, and source storage identity. | Any mismatch falls back to embedded topology; LRU eviction closes the sidecar. |
| Static lower bound | Four destination-seed sets per topology context | Sorted destination stop IDs plus exact egress seconds. | Topology context/store replacement. |
| Active-service kernel snapshot | Persisted binary, one context | Kernel schema v5, source storage identity, service key, topology identity, and same-stop forbidden-transfer flags. | Any schema, source, service, topology, transfer policy, or dimension mismatch. |
| Active-kernel destination lower bound | Weighted LRU: up to 256 entries and 64 MiB | Sorted destination stop indexes plus exact egress seconds within one active kernel. | Service/kernel change; cleared after calibration. |
| In-engine route result | Weighted LRU: 128 plans, 250,000 geometry points, 16 MiB | Requested/resolved date, fallback and coverage policies, day, departure, horizon, exact endpoints and selected stop metadata, walk budget, street/topology paths, window, restricted access sets, walk-dominance modes, lower-bound mode. | Store replacement, process close, or any key-field change. |
| API route response | LRU: 128 responses, 8 MiB | Explicit response-cache algorithm generation, routing and street artifact path/size/mtime-ns, and recursively sorted complete request. | Algorithm-generation change causes a miss; project/feed/store mutation invalidates project entries. |
| OSM point-to-point path | 20,000 entries | Exact origin/destination coordinates and exact maximum distance. | Street-store replacement. A cached miss is budget-specific. |
| GTFS route preview | Eight in-flight/results | Project/feed/scope, store size/mtime, route and trip counts. | Store/project metadata change. Presentation only; never routing truth. |
| Service-coverage summary | Eight entries | Store path, size, and modification time in nanoseconds. | Artifact identity change. |
| CLI duplicate-request map | One process/batch | Origin, destination, time, operator, service day/date, walk budget, window, street store. | End of process. The GTFS store is fixed by invocation. |

No persisted query or itinerary cache is part of the project format. Imported
stores and evidence bundles are separate from in-process caches and must carry
their own identity and hashes.

## 3. Generated-artifact retention

Disk artifacts are governed separately from in-process correctness caches.
`config/cache-retention-policy.json` removes disposable Vite output and bounds
the Rust build tree. It contains no application data, imported transit feeds,
street stores, or user workspace paths.

Use these commands from the repository root:

```bash
npm run check:caches
npm run clean:caches
```

The check is non-mutating and fails when a disposable path or Rust budget
violation is present. The cleaner only removes paths named by the tracked
policy; imported data and user workspace data are never swept by it.

## 4. Cache-poisoning regression matrix

The permanent suite must prove a miss and result re-evaluation when each of the
following changes independently:

1. one byte of GTFS content, even with unchanged path, size, and timestamp;
2. one byte or rebuilt identity of the OSM store;
3. service date, departure/arrival operator, or horizon;
4. maximum walk, endpoint coordinates, or explicit stop selection;
5. fallback and complete-coverage policy;
6. transfer/access policy version;
7. static-topology or active-kernel schema;
8. accessibility or optimization settings once supported;
9. matrix strategy only when it is diagnostic, never when it changes rows;
10. algorithm version across a long-lived persisted cache.

Warm/cold parity requires identical status, arrival/departure, boardings,
walking, route sequence, and itinerary legs. Timing fields and explicit
`cacheHit` diagnostics may differ.

## 5. Provenance exported with results

Release evidence and batch JSON should contain:

- VIGO version, source revision, dirty-tree state, and output schema;
- GTFS content fingerprint and routing-store schema;
- OSM content fingerprint when the street store provides it; older stores must
  report `unavailable` and be rebuilt, never receive an inferred hash;
- access policy, transfer policy, horizon, query operator, and objective;
- service date requested/resolved and fallback state;
- active-kernel/static-topology versions and fallback reason;
- unsupported-feature and limitation inventory;
- cache state for preparation and measured query phases;
- input manifest hashes and deterministic run identifiers.

## 6. Residual provenance boundaries

- Pre-v0.1.4 street stores may lack a PBF SHA-256 and must be rebuilt for trusted evidence.
- Some in-process caches rely on file storage identity because their canonical
  store is already immutable; replacement detection must remain mandatory.
- Pre-v0.1.4 GTFS stores lack feature inventory and content fingerprints and
  must be rebuilt before being treated as trusted evidence.
- The OSM open-store map is bounded to four entries by default; retained-RSS
  distributions remain a release measurement rather than a universal guarantee.

The retired JavaScript nearest-snap cache is no longer part of the production
path. Native point-to-point routing and its retained route results use exact
coordinates. The HTTP response cache carries the explicit
`vigo.routing.http-response-cache.v1` generation in every key, so an algorithm
generation change does not require a process restart for correctness.
