# VIGO Engine package and deployment

The Engine ZIP contains the minified CLI, a small HTTP service, the shared Rust
kernel, licenses, and a file-hash manifest. It excludes Studio, Electron, the
Python wrapper, Node itself, source/test files, and City data. The JavaScript
layer remains necessary for input validation, preparation, and Result assembly.
No routing implementation is copied into a separate deployment fork.

## Build and extract

From a VIGO source checkout with its normal Node/npm and Rust build tools:

```sh
npm ci
npm run package:engine
npm run check:engine-package
```

`build:engine` builds only the native kernel, CLI, and HTTP entry, without the
web application or Electron. `package:engine` rebuilds those entries and writes
`release/engine/VIGO-Engine-VERSION-PLATFORM-ARCH.zip`, its SHA-256 file, and a
relocated runtime directory. `VIGO_ENGINE_RELEASE_DIR` changes the output folder.
Packaging uses an explicit file list and audits it for development data and
embedded credentials or developer paths. `manifest.json` records the source
commit, dirty state, platform, Rust target, and hashes of every payload file.

Extract the ZIP on its matching OS/CPU and provide Node.js 24.18 or newer:

```sh
node vigo.mjs capabilities
node vigo.mjs --help
node vigo.mjs build --gtfs feed.zip --osm region.osm.pbf --output ./city
node vigo.mjs route --city ./city --request route.json --service-date 2026-07-15
```

The CLI, resident NDJSON, City, and Result contracts are the same as the full
VIGO distribution. No npm install, Python, Rust compiler, or desktop application
is required after extraction. The caller supplies its own City and request files.

## HTTP queries

Configure one complete City directory for the service:

```sh
VIGO_CITY_DIR=./city node engine-http.mjs
```

The default address is `127.0.0.1:8080`. `node engine-http.mjs --help` lists
configuration variables. The service exposes:

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health` | Process/native startup readiness and worker count |
| GET | `/v1/capabilities` | Public Engine capability JSON |
| POST | `/v1/route` | CLI Route Result, with `result` and optional `choices` |
| POST | `/v1/matrix` | CLI Matrix Result, with `rows` |
| POST | `/v1/reach` | CLI Reach Result, with `surface` and `contours` |

POST JSON uses the corresponding CLI JSON request, plus `serviceDate` and
`time` (`HH:MM` or integral service-day minutes). A matching `serviceDay` is
optional. `timeMinutes`, `departMinutes`, or `arriveMinutes` can supply the clock
when `time` is omitted. `VIGO_SERVICE_DATE` supplies an optional default date.
Cities, imports, filesystem output paths, and Studio project endpoints cannot
be selected through these requests.

```sh
curl http://127.0.0.1:8080/v1/route \
  -H 'Content-Type: application/json' \
  -d '{"origin":"A","destination":"B","serviceDate":"2026-07-15","time":"08:00","allowStreetTransfers":false,"minimumTransferBufferMinutes":2}'
```

Each service-date worker reuses the public resident CLI and prepares requested
modes lazily. Requests within one worker run serially. Two dates are retained
by default; an idle worker is evicted for another date. Concurrent busy dates
or full queues return HTTP 429. An expired query/queue timeout kills that worker
and fails its pending requests; a subsequent request can create a fresh worker.
Set `VIGO_ENGINE_MAX_WORKERS`, `VIGO_ENGINE_QUEUE_LIMIT`, and
`VIGO_ENGINE_TIMEOUT_MS` for the intended memory and concurrency budget.

The worker is force-terminated on timeout, including when native execution is
stalled, and all of its queued requests fail together. The service bounds each
worker response to 64 MiB (`VIGO_ENGINE_MAX_RESPONSE_BYTES`); exceeding that bound
returns 503 and replaces the worker on the next request. Size large Matrix or
Reach responses to fit the configured limit, or split them into smaller batches.
JSON bodies default to 1 MiB (`VIGO_ENGINE_MAX_BODY_BYTES`) and must finish within
10 seconds (`VIGO_ENGINE_BODY_TIMEOUT_MS`), even if bytes continue arriving.
Incomplete timed-out bodies return 408 and close the connection. Responses have
a 10-second absolute write deadline. `VIGO_ENGINE_MAX_CONNECTIONS` defaults to
128 and closes excess connections before admitting requests.

Ready and valid blocked Results return HTTP 200. Invalid HTTP envelopes return
4xx; resident CLI query errors return 422 with the original error envelope.
Worker failures return 503 and timeouts return 504. Health does not guarantee
service coverage for every requested date. Startup validates the City and
loads the matching native binary; queries still perform their usual admission
and schedule checks.

## Containers and cloud hosts

A native ZIP is platform-specific. Supported build targets are macOS ARM64/x64,
Linux GNU ARM64/x64, and Windows x64. Linux packages require compatible glibc;
the supplied container uses Ubuntu 24.04. A Mac ZIP cannot supply the native
binary to a Linux container. Node-API does not make it an edge/Wasm runtime.

From the source checkout, build the Linux image on the deployment architecture:

```sh
docker build -f deploy/engine.Dockerfile -t vigo-engine .
docker run --rm -p 8080:8080 \
  -v /absolute/city:/data/city \
  -e VIGO_ENGINE_API_TOKEN="$VIGO_ENGINE_API_TOKEN" vigo-engine
```

`docker build -f deploy/engine.Dockerfile --target verify .` also verifies the
extracted Linux package, including worker termination and recovery, input and
output bounds, and Route/Matrix/Reach parity with the CLI. CI runs this container
gate on Linux ARM64 and x64. A configured CI job is not evidence of a completed
release run; retain the successful run for the image being delivered.

The multi-stage build compiles the matching Linux kernel. The final image keeps
only Node and the Engine runtime. Linux ZIPs also include a `Dockerfile` that
wraps an already built matching Linux payload: extract it, then build with
`docker build -t vigo-engine .`.

The service reads its City from `VIGO_CITY_DIR` (container default `/data/city`).
The City volume must permit writing derived routing caches; the container uses
UID/GID 1000. Use a persistent City volume and replace prepared Cities through
the normal City workflow. The Engine ZIP contains no transport data.

For a remote bind, set `VIGO_ENGINE_HOST=0.0.0.0` and a nonempty
`VIGO_ENGINE_API_TOKEN`. Query and capability endpoints require
`Authorization: Bearer TOKEN`; `/health` remains available to health probes.
Supply the token through the deployment's secret environment and put HTTPS at
the load balancer or reverse proxy. The service does not enable cross-origin
browser access. Ordinary Linux containers/VMs with Node and native libraries
can host this package; runtimes that cannot load native Node add-ons cannot.

## Operate the self-hosted and hosted service

`deploy/compose.yml` is a single-instance starting configuration for both
delivery paths. Set `VIGO_ENGINE_IMAGE` to the verified image (prefer its digest),
`VIGO_CITY_DIR` to an existing prepared City, and `VIGO_ENGINE_API_TOKEN` through
the operator's secret store. Run `docker compose -f deploy/compose.yml up -d`.
The Linux ZIP includes the same profile as `compose.yml`; after extraction,
use `docker compose -f compose.yml up -d` instead.
The City must be writable by the configured UID/GID (default 1000); matching
`VIGO_ENGINE_UID` and `VIGO_ENGINE_GID` can accommodate an existing volume.
The profile binds only to loopback, drops capabilities, uses a read-only root
filesystem, and bounds memory, CPU, process count, and shutdown time. The
defaults are starting limits, not a capacity guarantee.

For a hosted service, place that same image behind managed HTTPS ingress and
keep the engine port private. Use a separately prepared City for each replica;
do not overwrite a City that running processes have mapped. Build and validate
a new City in staging, exercise representative Route and Matrix requests on
covered service dates, then switch traffic. Retain the previous image digest
and City revision together so a rollback restores both. Drain traffic before
stopping a replica; shutdown aborts remaining queued work.

The image's `/health` probe checks the running process, not feed freshness or
journey correctness. Gate traffic with service-date canary queries as well.
Monitor successful routes, valid blocked results, 4xx input failures, 429
capacity rejections, 503 worker failures, 504 timeouts, latency, and memory
separately. Validate feed replacement, restart, overload, and rollback using the
deployment's actual limits before admitting public traffic. Preserve request
IDs and aggregate metrics without logging tokens or rider coordinates by
default. A public launch additionally needs an agreed feature contract, target
load and latency budget, data-refresh policy, and operator response ownership.
