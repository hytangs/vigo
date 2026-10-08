# Upgrade and rollback

Keep the running application and its prepared City together until the replacement passes your saved requests. A new application version does not imply that an older prepared City is compatible.

## Before changing versions

1. Save the runtime version, package checksum, `capabilities` output, and City inspection output. The Node CLI uses `inspect --city ./city`; the Rust runtime uses `info --city ./city`.
2. Retain the original GTFS and OSM inputs, their checksums, preparation options, and any scenario definitions. Prepared data is not a substitute for those sources.
3. Keep representative Route, Matrix, and Reach requests and their expected results. Include your transfer, walking, and arrive-by constraints.

## Prepared City policy

VIGO 0.5.0 accepts only the prepared artifact formats advertised or admitted by its runtime. The outer `vigo.city.v1` manifest is not sufficient: timetable, transfer, street, access, and accelerator formats are checked separately. Older incompatible artifacts are rejected. Editing a format marker cannot migrate their contents.

There is no backward-compatibility or in-place conversion requirement for pre-0.5.0 Cities. Rebuild from the original sources into a **different output directory**:

```sh
node vigo.mjs build --gtfs feed.zip --osm region.osm.pbf --output ./city-next
node vigo.mjs inspect --city ./city-next
node vigo.mjs route --city ./city-next --request route.json --service-date 2026-07-15
```

Use a service date covered by your feed. The Rust query runtime consumes prepared Cities; raw-data preparation is a separate CLI step. See [multiple feeds](multiple-feeds.md) for scoped sources and [standalone operation](rust-standalone.md) for scenario collections.

Optional query caches may be regenerated from an admitted City. Incompatible source artifacts require a rebuild. Query execution does not silently convert an old City. Treat published City files as immutable while a service has them open.

## Validate, switch, and recover

Run the saved requests against the candidate through the interface your application actually uses. Check result schemas, no-journey outcomes, walking geometry, arrival/departure times, boardings, and resource use. Test a cold start and repeated requests as well as a single successful query.

Start a second local service with `city-next`, check readiness, and replay the requests before switching the application endpoint. Preserve the previous binary and City until acceptance is complete. Roll back by restoring both together. Do not overwrite a live mmap-backed City.

`build --replace` validates staging before replacing the destination and restores the previous directory if publication fails. A successful replacement removes its temporary backup; it is not a retained rollback copy. Use a separate output directory when rollback matters.

## Checks available without the maintainer

Use the [service benchmark](benchmarking.md) to retain comparable latency and storage measurements for your own workload.

From a source checkout with the documented toolchain:

```sh
npm ci
npm run build:engine
npm run build:standalone
npm run check:correctness
npm run check:public-results
npm run check:portability
npm run package:engine
npm run check:engine-package
```

These use public synthetic inputs. They cover independent objective verification, difficult routing cases, public schemas, City relocation, and operation from the extracted package. They do not require private benchmark files or a running maintainer service. Platform CI runs the broader release checks; a local pass does not establish that unrun platforms passed.

For an operational issue, retain the request, schema and engine versions, City/source checksums, logs, and the smallest shareable input that reproduces it. [Troubleshooting](troubleshooting.md) explains the diagnostics. See [public results](../reference/results.md) for the API stability policy.
