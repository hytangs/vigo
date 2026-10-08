# Reproduce a service workload

Use a retained NDJSON request file containing public Route, Matrix, and Reach requests. Each line includes `kind`, the City or scenario selection supported by your service, the service date, and all routing constraints. Keep the file and prepared City together with their source checksums.

```sh
node scripts/benchmark-service.mjs \
  --url http://127.0.0.1:8080 \
  --requests queries.ndjson --output results.json \
  --rounds 20 --concurrency 4 --warmup 1 --city ./city
```

Set `VIGO_API_TOKEN` if the service requires authentication. The benchmark does not write the token to its report and refuses to overwrite an existing result. It calls the service's `/v1/route`, `/v1/matrix`, and `/v1/reach` endpoints.

The report retains every measured call, warmup calls, request-file hash, runtime capabilities, client platform, and optional unique-file City storage. Latency includes queueing, HTTP, response transfer, and JSON parsing. Quantiles use nearest rank. Successful results, valid no-journey results, HTTP failures, overload, service unavailability, timeouts, invalid responses, and transport failures are reported separately. Errors during warmup also fail the run.

For a cold-start measurement, start a fresh service and use `--warmup 0 --rounds 1`. Measure readiness separately from the first query. For sustained use, retain the same workload and increase rounds; report how much the workload repeats and whether caches are enabled. Compare equivalent inputs, constraints, output detail, hardware limits, and runtime builds.

City storage counts each file identity once, including shared scenario directories. It is logical file size, not physical APFS clone allocation. Server memory must be measured at the service: retain process-tree RSS/PSS or cgroup memory samples at startup, first query, repeated and concurrent queries, scenario switches, and peak large-output requests. Include the full application stack when claiming a deployment budget. The benchmark client's memory is not server memory.

Use public synthetic fixtures for CI and caller-owned Cities for operational acceptance. A short replay establishes behavior for that retained workload; it does not establish production reliability across unobserved traffic. See [upgrading](upgrading.md) for installation and rollback checks.
