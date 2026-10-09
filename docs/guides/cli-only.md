# Install the Node CLI

The CLI archive contains `vigo.mjs`, the matching native routing kernel, license notices, and a checksum manifest. It builds Cities from raw inputs and runs the public query commands. Provide Node.js 24.18 or newer on the matching OS and CPU.

## Run the archive

Extract a matching archive from [VIGO releases](https://github.com/hytangs/vigo/releases), keep its files together, and run:

```sh
node vigo.mjs --version
node vigo.mjs capabilities
node vigo.mjs help route
```

No npm installation, Rust compiler, or Studio application is needed after extraction. This archive does not bundle Node or City data. For a standalone query service that requires no Node, use the [Rust executable](rust-standalone.md).

The guides use `vigo` as a short command. In a POSIX shell:

```sh
alias vigo='node "/absolute/path/to/vigo.mjs"'
```

On Windows, use `node .\vigo.mjs` in place of `vigo`, or configure your own command alias.

## Build a City

Follow [Build your first City](../guide.md#vigo-cli-quickstart) for data download links, source coverage, exact commands, and a complete Boston example. From local inputs:

```sh
vigo build --gtfs feed.zip --osm region.osm.pbf --output ./city
vigo inspect --city ./city
```

For transit and walking only, add `--street-modes walk` to avoid compiling driving data.
Low-memory builds use disk-backed SQLite temporary work and compact numeric node
lookups. They can take longer; keep the output and temporary directory on a local
Linux filesystem (inside WSL, prefer the Linux filesystem to `/mnt/c`). Leave
space for the source database, temporary sorts and the completed City. The CLI
reports progress during long import phases and respects container memory limits
when deciding whether GTFS and OSM compilation may overlap. Import and native
street-preparation stages run in separate processes so each releases its working
memory before the next stage. Regional native CCH preprocessing can still exceed
2 GiB without swap: configure disk-backed swap for the offline builder, or build
on a larger machine and copy the complete City to the serving machine. Runtime
RAM limits and build working-memory requirements are separate.

Street preparation must successfully write the walking accelerator before the
source graph is sealed. Missing or unwritable snapshots fail preparation rather
than publishing a City that cannot open. These changes preserve the published
0.5 data layout; they do not require a new City format. Older downloaded 0.5.0
CLI archives do not acquire builder fixes merely because the version is the same.

The City is a whole directory, not the inspection JSON. Rebuild older prepared Cities using 0.5.0. Use [multiple feeds](../guide.md#combine-timetables-and-live-feeds) to combine agencies with explicit source scopes.

## Run a query

```sh
vigo route --city ./city --request route.json \
  --service-date 2026-10-05 --time 08:00 --output result.json
```

Choose a date covered by the feed. The [Route](../guide.md#route-1), [Matrix](../guide.md#matrix-1), and [Reach](../guide.md#reach-and-isochrones) references define the request shapes. Public results use seconds and explicit schemas; [read the response](../reference/results.md) before consuming it.

## Keep the engine resident

Use `stream` for repeated queries. Each input line declares its `kind` and can carry an `id`:

```sh
vigo stream --city ./city --service-date 2026-10-05 \
  < queries.ndjson > results.ndjson
```

See the [resident protocol](../guide.md#keep-the-engine-resident) for a complete request file. Reuse the process to avoid reopening the network for every query. Check every response, including per-query errors.

## Package and verify

From a source checkout, run `npm run package:cli`, then `npm run check:cli-package`. The checks exercise the extracted package. A native archive is specific to its platform; use its matching runtime and retain the manifest when reporting a problem.

For HTTP, use [the native service](../guide.md#deploy-the-routing-engine). For Python objects and notebooks, use [VIGO Python](https://github.com/hytangs/vigo-py/tree/main/docs).
