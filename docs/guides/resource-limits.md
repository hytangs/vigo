# Resource limits and constrained serving

Python batch concurrency and Engine query concurrency have different costs. `City.iter_run(queries, workers=2)` overlaps complete queries using separate resident processes. Each owns its prepared City. The native HTTP service uses one supervised query worker with bounded admission, deadlines, cancellation and recovery; its routing kernel can parallelize supported work internally. On a 2 CPU / 2 GiB deployment, keep one resident query process and two native threads. Additional processes are not a free speedup.

The native endpoint-access pool also follows available CPU parallelism (including Linux quota/affinity) and a positive `RAYON_NUM_THREADS` cap, up to four threads. With one available thread it runs sequentially without creating a pool. This shares one City and preserves exact endpoint searches.

## Capacity-aware defaults

At startup, native cache defaults use the smallest reported Linux physical-memory, cgroup v2 `memory.max`/`memory.high`, or cgroup v1 memory limit. Visible ancestor limits are included. Unlimited values are ignored. Non-Linux and unknown-capacity installations retain the existing bounded cache defaults. Explicit cache settings remain operator overrides.

| Native allocation | Default upper bound | Fraction of detected capacity |
| --- | ---: | ---: |
| Endpoint cache, per role | 64 MiB | 1/64 |
| Shape geometry cache | 64 MiB | 1/64 |
| Inactive timetables | 128 MiB | 1/32 |
| HTTP pending request bytes | 64 MiB | 1/32 |
| HTTP retained response bytes | 128 MiB | 1/16 |

HTTP budgets preserve room for one maximum-sized request and one worker response line. Caches are optional retained work: reducing them does not truncate journeys or change routing results. Collections partition the applicable caches across resident scenarios. The active City and query scratch are outside these cache budgets; a small cache does not prove a large network will fit.

`vigo info` and `/v1/info` report `resourcePolicy.memoryCapacityBytes` and `swapCountsAsRam`. Capacity is a startup sizing input, not current free memory or a hard process RSS guarantee. Linux controllers at nonstandard mount locations require explicit operator limits. Restart after changing controller limits.

Python caps its existing one-to-four worker budget using affinity, CPU quota and the same visible Linux memory-controller hierarchy. Unknown memory capacity selects one worker. On all platforms, `workers=1` remains the public batch default.

## Swap is an explicit deployment choice

The Compose service disables swap by default by setting total RAM-plus-swap equal to RAM. To permit up to 4 GiB of swap alongside 2 GiB RAM, use `VIGO_MEMORY=2g VIGO_MEMORY_SWAP=6g`. The Linux host must already provide sufficient swap; Compose does not create it. A swap-free comparison uses `VIGO_MEMORY_SWAP=2g`.

Swap is never added to the resident capacity used to size workers or caches. It can preserve cold anonymous pages under pressure, but may substantially increase latency. File-backed mappings can be reclaimed independently. Record RSS, cgroup current/peak memory, swap usage, memory events, pressure and request latency separately; container memory includes page cache and is not RSS. See the [Linux memory-controller specification](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) for the accounting rules.

## Validation boundaries

The deployment check exercises the shipped image and Compose file at 2 GiB and a 256 MiB synthetic collection, including full geometry, scenario eviction, restart parity and read-only City integrity. The small fixture validates controls and recovery; it does not establish that a regional City fits in 256 MiB. Regional endurance and swap tests need retained workload-specific evidence, including errors and OOM counters, before making a deployment claim.
