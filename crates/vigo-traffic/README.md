# vigo-traffic

Rust traffic compilation shared by the Node adapter and standalone runtime. The crate receives an immutable CSR graph, graph fingerprint, input data and an explicit admission clock. It does not read a system clock, open a socket, rebuild a City, or depend on N-API.

`TrafficEngine::compile` returns an `Arc<Snapshot>`. `Snapshot::admit(now_ms)` evaluates freshness once for the route or matrix, returning either admitted costs or an explicit baseline fallback. Prepared snapshots also require observation time. Sorted effective edge costs determine CCH reuse; changing provenance or TTL cannot disguise changed weights. Overlapping observations use maximum cost, and costs cannot undercut baseline. Whole-path travel times are allocated in proportion to baseline edge times (at most half a centisecond rounding error per edge).

The engine retains one compiled input, a lazy spatial index, and a bounded path cache (8,192 geometries / approximately 131,072 cached edges, with at most one extra 4,096-edge path before eviction). Matching follows a connected directed path, checks shape in both directions within a corridor of min(radius, 30 m, max(1 m, 5% of path length)), checks 70–130% geometric length agreement, and rejects distinct directed alternatives within 25 cost-metres (overlapping endpoint trims of the same chain are equivalent). Search is bounded to 64 endpoint candidates, 20,000 labels and 4,096 edges per observation; exceeding bounds is an explicit rejection. The graph fingerprint invalidates both caches. The spatial index is only built when geometry is supplied.

`ndw::Configuration` streams DATEX II v3 XML and retains versioned linear measurement-site definitions. `ingest` joins current measurements to that configuration. `Batch::snapshot` feeds the ordinary compiler. Records with unsupported location, vehicle, lane or time semantics are rejected; they never become closures. See the [public import and coverage contract](../../docs/guides/rust-standalone.md#drive-traffic). XML is bounded to 256 MiB per document, 2 MiB per record and 64 nested elements. DTDs and external entities are not supported.

Run `cargo test -p vigo-traffic`, then `npm run check:traffic`. Test XML is authored synthetic data following the public NDW v3 shape, with no private inputs or provider measurements. To inspect a retained public feed pair at its historical observation clock:

```bash
cargo run --release -p vigo-traffic --example inspect_ndw -- sites.xml measurements.xml 2026-10-19T06:07:00Z
```

The public synthetic performance probe compares resident native queries against a retained pre-change binding and measures the new snapshot compiler separately:

```bash
node scripts/profile-traffic.mjs /path/to/baseline.node output/traffic-profile.json
```

It checks equal query durations and reports p50/p95/p99, first customization, matching/admission timings and process memory. Its grid is not evidence of national coverage, live operation or a full City workflow speedup.

Real-network matching can be reproduced with `python3 scripts/validate-ndw-network.py --osm roads.osm --configuration sites.xml.gz --measurements measurements.xml.gz --clock RFC3339 --output output/ndw-audit` from the repository root. It uses the production PBF importer and drive CSR, then verifies accepted directed edges against the original OSM XML. Preserve input hashes and report accepted/rejected counts; a bounded extract is not national matching accuracy. Requires osmium, Node and Cargo. Raw OSM/NDW inputs and reports stay in the ignored output directory.
