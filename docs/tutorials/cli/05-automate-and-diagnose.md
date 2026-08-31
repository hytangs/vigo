# Tutorial 5: Automate and diagnose CLI runs

This final tutorial turns the earlier commands into a dependable automation
pattern. The central rule is simple: a successful process is not the same as a
successful route. Validate both.

## 1. Use the git-built CLI in an argument array

Document 0 built the CLI. Set the active data paths and service semantics here,
then keep the executable and its script in an argument array; this preserves
paths containing spaces:

```bash
set -euo pipefail

export VIGO_HOME="${VIGO_HOME:-$HOME/Documents/vigo}"
export VIGO_DATA_HOME="${VIGO_DATA_HOME:-$HOME/Documents/vigo-data}"
export VIGO_NODE="${VIGO_NODE:-$(command -v node)}"
export VIGO_CLI="$VIGO_HOME/dist-cli/vigo.mjs"
export VIGO_NETWORK="$VIGO_DATA_HOME/network"
export VIGO_OUTPUT="$VIGO_DATA_HOME/output"
export VIGO_STORE="$VIGO_NETWORK/routing/project.sqlite"
export VIGO_STREET_STORE="$VIGO_NETWORK/osm/street-index.sqlite"
export VIGO_SERVICE_DATE="${VIGO_SERVICE_DATE:?set an exact date covered by the GTFS calendar}"
export VIGO_SERVICE_DAY="${VIGO_SERVICE_DAY:?set the matching service-day class}"

VIGO_COMMAND=("$VIGO_NODE" "$VIGO_CLI")

"${VIGO_COMMAND[@]}" --version
```

Do not interpolate untrusted paths or request fields into a shell command.
Application code should use its process library's equivalent argument-array
API.

## 2. Give every run its own folder

The coordinate CSV from Tutorial 2 is a ready-to-run input:

```bash
export VIGO_RUNS="$VIGO_DATA_HOME/runs"
export VIGO_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export VIGO_RUN_DIR="$VIGO_RUNS/$VIGO_RUN_ID"
mkdir -p "$VIGO_RUN_DIR"

cp "$VIGO_DATA_HOME/input/coordinate-ods.csv" "$VIGO_RUN_DIR/od.csv"
cp "$VIGO_NETWORK/network.json" "$VIGO_RUN_DIR/network.json"
```

Run one batch and capture standard output and standard error separately:

```bash
"${VIGO_COMMAND[@]}" route \
  --store="$VIGO_STORE" \
  --street-store="$VIGO_STREET_STORE" \
  --od="$VIGO_RUN_DIR/od.csv" \
  --out="$VIGO_RUN_DIR/routes.csv" \
  --json-out="$VIGO_RUN_DIR/routes.json" \
  --time=08:00 \
  --time-preference=depart \
  --routing-preference=balanced \
  --service-date="$VIGO_SERVICE_DATE" \
  --service-day="$VIGO_SERVICE_DAY" \
  --max-walk=1.2 \
  > "$VIGO_RUN_DIR/summary.json" \
  2> "$VIGO_RUN_DIR/stderr.log"
```

Standard output is the JSON execution summary. Standard error contains build
progress, diagnostics, or fatal errors and should not be parsed as result JSON.

## 3. Require every row to be ready

This strict gate fails if the command produced no rows or any row is blocked:

```bash
jq -e '
  .schemaVersion == "vigo.cli.route.v2" and
  .rows.total > 0 and
  .rows.blocked == 0
' "$VIGO_RUN_DIR/summary.json"
```

If your analysis allows blocked rows, use an explicit threshold instead and
inspect the CSV:

```bash
jq '{total:.rows.total,ready:.rows.ready,blocked:.rows.blocked}' "$VIGO_RUN_DIR/summary.json"
awk -F, 'NR == 1 || $2 != "ready"' "$VIGO_RUN_DIR/routes.csv"
```

For NDJSON, validate every response line: envelope `status: "error"` means
parsing or validation failed; `status: "ok"` with `plan.status: "blocked"`
means routing ran but found no admissible plan; and `plan.status: "ready"` is a
materialized journey.

## 4. Keep a reproducible run bundle

Retain these files together:

- the VIGO version and exact invocation;
- the input CSV, NDJSON, or request JSON;
- `network.json`, including GTFS and OSM source fingerprints;
- the routing and street store identities;
- standard-output summary and standard-error log;
- compact CSV and full JSON results; and
- service date, time semantics, walking budget, and matrix/surface settings.

The result CSV without the build manifest is not enough to identify the data
that produced it.

## 5. Diagnose common failures

| Message or symptom | What to check |
| --- | --- |
| `--service-date is required` | Export an exact date covered by the GTFS calendar and its matching service-day class. |
| `coordinate endpoints require --street-store` | Pass `$VIGO_STREET_STORE`; coordinate access and egress use the OSM street graph. |
| `missing or unknown origin/destination` | Check compiled stop IDs, CSV headers, blank fields, and feed scopes. |
| `compiled network already exists` | Choose a new output directory or explicitly verify before using `--force`. |
| A row is `blocked` | Read `failure_code`, `failure_category`, and `blocked_reason`; then check date, coverage, and walking budget. |
| An NDJSON line is `error` | Read that line's `error.message`; other lines may still have completed. |
| Arrive-by rejects a departure window | Remove the window; finite departure profiles are depart-only. |
| Matrix or isochrone rejects arrive-by | These analytical operators support fixed departures only. |

## 6. Keep timing claims within their boundary

VIGO reports preparation, routing, output serialization, and process timing
separately. A batch or resident NDJSON process amortizes startup and
preparation. Identical routing keys may be reused, so duplicate rows are not
independent latency samples. For performance work, retain unique query keys,
environment, source identities, and result-agreement checks.

Next: return to [Document 0](00-setup-and-build.md) or the
[CLI tutorial index](README.md).

[Back to Tutorial 4](04-matrices-and-isochrones.md)
