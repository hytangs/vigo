# Public smoke benchmark

VIGO ships one small, deterministic benchmark so the public performance path
is executable rather than implied by the architecture. It generates a fixed
GTFS schedule and OSM PBF street graph, builds both durable stores, starts one
resident routing process, and runs a seeded stop-pair corpus with result caching
disabled.

```bash
npm ci
npm run benchmark:smoke
```

The JSON receipt reports the source commit, input hashes, OD seed, preparation
wall time, reported compiler time, store bytes, first-query time, warm mean,
p50/p95, resident RSS where the host exposes it, and a checksum of the returned
paths. Override only the sample count or seed when diagnosing stability:

```bash
npm run benchmark:smoke -- --samples=301 --seed=20260830
```

This fixture proves that the measurement contract is reproducible. Its tiny
synthetic network is not evidence of city-scale throughput, a comparison with
another router, or a universal performance guarantee. Larger comparisons need
fixed public data, matched semantics, repeated runs, and separately reported
preparation, query, memory, and storage costs.
