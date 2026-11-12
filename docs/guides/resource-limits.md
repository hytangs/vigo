# Resource limits and constrained serving

This page explains how VIGO uses CPU and memory, and how to size a deployment. The [Compose defaults](../guide.md#resource-controls) suit a 2 CPU, 2 GiB container; [environment variables](rust-standalone.md#environment-variables) lists every control.

## Processes and threads

The HTTP service runs one supervised query worker with bounded admission, deadlines, cancellation and recovery. A query can use several threads (`RAYON_NUM_THREADS`), and endpoint access searches run on up to four threads, following the available CPUs, Linux quotas and affinity. One query worker and two threads suit a 2 CPU, 2 GiB deployment.

More processes are not a free speedup: each one loads its own City. Python's `City.iter_run(queries, workers=2)` and the compiler's `stream --workers 2` run separate resident processes; measure before adding them. Python caps its one to four workers by CPU affinity, quota and visible memory limits, chooses one worker when memory capacity is unknown, and defaults to `workers=1`.

## Capacity-aware defaults

At startup, the engine reads the smallest of Linux physical memory, cgroup v2 `memory.max` and `memory.high`, and cgroup v1 limits, including visible parent limits, and sizes its caches from it. Unlimited values are ignored. Other platforms, and Linux controllers mounted in unusual places, keep the fixed defaults below. Explicit settings always win.

| Allocation | Default upper bound | Share of detected memory |
| --- | ---: | ---: |
| Endpoint cache, per role | 64 MiB | 1/64 |
| Shape geometry cache | 64 MiB | 1/64 |
| Inactive timetables | 128 MiB, growing to twice a retired view | 1/32, growing to 1/16 |
| HTTP pending request bytes | 64 MiB | 1/32 |
| HTTP pending response bytes | 128 MiB | 1/16 |

Caches hold reusable work; shrinking them never changes or truncates an answer. Collections divide the caches among resident members. The loaded City and query scratch are outside these budgets, so small caches do not make a large City fit.

`vigo info` and `GET /v1/info` report `resourcePolicy.memoryCapacityBytes` and `swapCountsAsRam`. Capacity is a startup sizing input, not free memory or an RSS limit. Restart after changing container limits.

## Scenario and date switching

For a collection, read the residency counters in `/v1/info` before blaming route search for latency. Rising `cityOpens` and `evictions` on a repeated scenario sweep mean the resident members exceed `VIGO_RESIDENT_HEAP_BYTES`, even when `VIGO_MAX_RESIDENT_SCENARIOS` allows them. Raise the budget only with measured container peaks, leaving room for query scratch, mapped pages and other services. When the heap exceeds its budget, the collection first drops optional timetable caches, then evicts members.

Changing service dates can rebuild a timetable when the inactive-timetable cache is too small. Large scheduled timetables are kept losslessly compressed within the same budget, so more dates fit on a small host. Their keys include the active services, dates and horizon; realtime and linked trips are applied after restoring. The first use of a date still reads SQLite, and eviction remains possible. Trace timings separate `linkedCandidatesMs` and `linkedTripsMs` within `sourceAndRealtimeMs`.

## Swap is an explicit choice

The Compose service disables swap by setting memory plus swap equal to memory. To allow 4 GiB of swap beside 2 GiB of RAM, set `VIGO_MEMORY=2g VIGO_MEMORY_SWAP=6g`; the host must already have the swap. Swap is never counted as RAM when sizing workers or caches. It can hold cold pages under pressure but can make queries much slower.

Record RSS, cgroup current and peak memory, swap, memory events, pressure and latency separately; container memory includes page cache and is not RSS. See the [Linux memory-controller documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

## What the checks establish

`npm run check:deployment` runs the shipped image and Compose file at 2 GiB with a small synthetic collection, including full geometry, scenario eviction, restart and read-only City integrity. It validates the controls and recovery; it does not show that a regional City fits a given size. Before claiming a deployment budget, measure your own City and workload, including errors and out-of-memory events.
