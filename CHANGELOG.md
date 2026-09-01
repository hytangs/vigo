# Changelog

VIGO is pre-release software. Entries describe public source and packaged
artifacts; they do not imply operational validation or stable interfaces.

## Unreleased

- Bind API response and service-coverage caches to canonical store
  fingerprints, complete metadata generations, and storage generations.
- Separate release building from provenance attestation and pin GitHub Actions
  to immutable revisions.

## 0.3.0 - 2026-08-31

- Reject overflowed or out-of-bounds native snapshot descriptors before any
  pointer arithmetic.
- Validate CCH structure semantics and native timetable indexes before queries,
  including transfer targets, trip ranges, binary flags, and departure order.
- Bind persisted street and drive CCH structures and metrics to their exact
  source snapshots through generation manifests and SHA-256 digests.
- Enforce OSM PBF header, block, required-feature, compression, decompression,
  string-table, node, way, tag, and reference limits.
- Restrict the local HTTP service to loopback clients and require an explicit
  unsafe override before binding to a non-loopback address.
- Align source builds on Node.js 24.18.0 or newer, stream GTFS-Realtime under a
  hard byte limit, reject differential feeds, and block private feed targets.
- Add public CI on Linux x64, Apple-silicon macOS, and Windows x64, plus
  nightly portable release checks.
- Add Linux x64 native-kernel builds and deterministic public smoke-benchmark
  inputs, hashes, timings, memory, disk, and route-result checksums.
- Add maintainability boundaries and a stop-growth budget for the largest
  remaining modules.
- Open the initial public pre-release source tree, documentation, and
  Apple-silicon macOS runtime archive.
