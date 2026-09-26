# Runtime limits and recovery

These changes follow the frozen `v0.4.2` revision. They do not move that tag or
replace its archived build. API 1.0, City format 1, and Result schema 1 are unchanged.

## Memory and request admission

The runtime uses the smaller of host RAM and Node's reported container limit to
choose its default budgets. Configuration accepts finite positive integers;
invalid values use the default, and valid values are clamped to the supported
range. Zero no longer disables the timetable byte guard.

| Control | Default | Supported range |
| --- | --- | --- |
| `VIGO_ACTIVE_KERNEL_MAX_BYTES` | One eighth of capacity, between 64 MiB and 2 GiB | 1 MiB–16 GiB |
| `VIGO_ROUTE_MAX_PENDING` | 128 dispatches and, separately, 128 preparation lifecycles | 1–1,024 |
| `VIGO_ROUTE_MAX_QUEUED` | 32 jobs per worker | 1–256 |
| `VIGO_ROUTE_WORKER_HEAP_MB` | One eighth of capacity, between 128 and 2,048 MiB | 64–8,192 MiB |
| `VIGO_ROUTE_JOB_TIMEOUT_MS` | 900,000 ms | 1,000–3,600,000 ms |
| `VIGO_ROUTE_WORKER_RSS_BUDGET_BYTES` | One eighth of capacity, between 64 MiB and 2 GiB | 64 MiB–reported capacity |

Timetable admission counts the active service slice before allocating native
arrays, estimates its size, and checks retained bytes after construction.
Default cache budgets now scale with capacity instead of imposing large minimums.
This adds a count query to cold timetable construction. No latency improvement
or large-City performance result is claimed.

The pool rejects excess work with status 503. Capacity waits have a deadline,
and a worker watchdog requests termination when an operation exceeds its deadline. Under
memory pressure the pool avoids adding a second City until an unleased idle
worker can be retired. Worker diagnostics expose limits and pending counts.
Shutdown wakes waiting requests and permanently closes the pool.

These are admission and retention safeguards, not a hard whole-process memory
limit. V8's worker heap limit excludes native arrays and mapped street data.
Imports, realtime reconstruction, result assembly, and serialization can still
have temporary allocation peaks. The RSS check cannot interrupt a native
allocation already in progress. A native call must return before thread termination
can complete; operating-system memory exhaustion remains possible. Street and timetable budgets must be considered together for large
Cities.

## Recovery

A routing-thread failure rejects its active and queued work, waits for termination,
and reopens authoritative City data for a subsequent request. Structured-clone
failures reject only the affected job and leave the worker usable. No failed
query is converted into a fabricated journey.

Studio keeps its window when the Engine exits. It allows three starts within a
rolling minute, including the initial start, with increasing restart delays.
Startup has a 30-second deadline. Once the restart budget is exhausted, a later
request can try again after the rolling window permits it. Engine startup
failure does not prevent the window from opening. Pending requests fail rather
than being replayed automatically, because some requests change stored data.
Studio admits at most 128 Engine requests, including those waiting for startup.

Packaged Engine environment filtering lives in `public/engine-environment.mjs`.
Studio supplies its own application-data path after filtering so startup and
recovery use the same configuration directory.

## Smaller tests with real execution

`test/check-national-runtime-isolation.mjs` builds actual GTFS and OSM inputs,
uses the production worker and native kernel, verifies exact journeys after
thread termination, rejects a 50,000-trip input under a 4 MiB budget, verifies
subsequent small-City routing, and checks overload and shutdown. It replaces the
simulated worker and several overlapping lifecycle suites.

`test/check-engine-recovery-runtime.mjs` runs the actual Electron entry point,
kills Engine processes, checks health after each restart, checks the retained
window and sandbox settings, and verifies the crash limit. Browser polling uses
real timers. Streaming and provider-deadline checks use real local sockets.
Operations permissions, approval invalidation, SQLite transactions, audit history,
and reopening retained records run against the production operations service.

Canned model replies, substituted providers, worker emulators, global clock
patches, browser-method spies, and injected storage exceptions were removed.
Routing and vehicle-frame calculations accept explicit observation instants;
other browser checks use current timestamps and real timers. Small generated
GTFS/OSM and observation inputs remain test data, and production algorithms
compute their results.

Pruning removes coverage previously supplied by canned model conversations,
specific renderer refresh spies, simulated DNS changes, native-binding substitutions, forced file-deletion and
storage-quota errors, and server-wide clock replacement. Those assertions are not counted as equivalent real integration coverage.
The retained UI suites cover rendering, source updates, navigation, selection,
draft persistence, and damaged-storage handling. Actual model behavior requires
separately configured live evaluation; the release suite makes no model-quality
claim. Frozen replay inputs and saved-study readers remain because runtime and
research consumers still use them.

## Verification on this checkout

The final `check:release` gate passed, including native routing comparisons,
TypeScript, import and request security, CLI/City portability, agency computation,
and worker lifecycle checks. The real Electron suites passed, with the final
map-source replacement and Engine-recovery changes also checked directly.
`release:studio` passed for macOS ARM64: package isolation, startup, City build,
prepared-state reuse, Route parity, and archive creation. The follow-up archive
was written under `temp/hardened-release/`, leaving the frozen release archive
untouched. These checks do not establish other-platform behavior, live provider
quality, or whole-process immunity to memory exhaustion.
