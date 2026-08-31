# Quick Start

This guide takes VIGO from a fresh checkout to an inspected transit network, a
scheduled route, and a first accessibility surface. The core workflow is:

> Import → Understand → Query → Evaluate

## Requirements

The primary path is a source checkout: Apple-silicon macOS 13.5 or newer,
Linux x64, or Windows x64, with Node.js 24.18.0 or newer, npm 11.6.2, Git, and
rustup for the repository-pinned Rust toolchain. The install preflight checks
Node, SQLite, Node-API, platform, and architecture. Linux requires a GNU C
toolchain; Windows requires the stable MSVC Rust target and Visual Studio C++
build tools. A verified packaged desktop is an optional distribution path; the
current packaged artifact is macOS-only.

The repository does not ship a Python package and Python is not required to
build or run VIGO.

## Fetch the repository and build from source

Run this block from any directory. It fetches the repository, updates an
existing clean checkout with `git fetch`, builds the Rust routing kernel and
CLI, and starts the local workbench. If the checkout has local changes, the
block stops before changing branches or merging.

Paste the complete block as one block. The surrounding subshell keeps its shell
options and exported variables from changing the interactive terminal.

```bash
(
set -euo pipefail

export VIGO_HOME="${VIGO_HOME:-$HOME/Documents/vigo}"
export VIGO_REPO="$VIGO_HOME"
export VIGO_REMOTE="https://github.com/hytangs/vigo.git"

if [ -e "$VIGO_REPO" ] && [ ! -d "$VIGO_REPO/.git" ]; then
  echo "$VIGO_REPO exists but is not a git checkout; choose another VIGO_REPO." >&2
  exit 1
fi

if [ -d "$VIGO_REPO/.git" ]; then
  git -C "$VIGO_REPO" fetch --all --tags --prune
  if [ -n "$(git -C "$VIGO_REPO" status --short)" ]; then
    echo "The VIGO checkout has local changes. Save or commit them before updating." >&2
    git -C "$VIGO_REPO" status --short
    exit 1
  fi
  git -C "$VIGO_REPO" switch main
  git -C "$VIGO_REPO" merge --ff-only origin/main
else
  git clone "$VIGO_REMOTE" "$VIGO_REPO"
  git -C "$VIGO_REPO" fetch --all --tags --prune
fi

cd "$VIGO_REPO"
if [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
command -v cargo >/dev/null 2>&1 || {
  echo "Cargo was not found. Install Rust from https://rustup.rs, then rerun this block." >&2
  exit 1
}
npm ci
npm run build:rust-routing-kernel
npm run build:cli
npm run dev
)
```

On Windows PowerShell, use the same sequence without the shell-specific fetch
block:

```powershell
git clone https://github.com/hytangs/vigo.git vigo
Set-Location vigo
npm ci
npm run build:rust-routing-kernel
npm run build:cli
npm run dev
```

VIGO starts two local services:

```text
Workbench: http://127.0.0.1:5178
API:       http://127.0.0.1:5179
```

The desktop and browser workbench use the same local API and project files.
Static data does not need to leave the machine.

Confirm the local API before importing data:

```bash
curl --fail http://127.0.0.1:5179/api/health
```

## Raw inputs and generated network artifacts

`VIGO.app` is the application runtime; it does not contain a preselected city
or transit agency. Each workspace is built from the raw data for the region you
want to study:

| File or artifact | Meaning | Created by |
| --- | --- | --- |
| `network.gtfs.zip` or another static GTFS ZIP | Timetables, stops, routes, trips, and service calendars | The transit agency download for the region being studied |
| `*.osm.pbf` | OpenStreetMap street data used for walking, driving, and coordinate endpoints | An OSM extract provider covering the same region |
| `network/routing/project.sqlite` | VIGO's compiled timetable/routing store | `vigo build-network` |
| `network/osm/street-index.sqlite` | VIGO's directed OSM street store | `vigo build-network` |
| `network/network.json` | Build manifest with source fingerprints, counts, and timings | `vigo build-network` |
| `output/build-summary.json` | Machine-readable build receipt, when the command output is redirected there | Your shell command |

The GTFS ZIP and OSM PBF remain the source inputs. The SQLite stores, manifest,
native accelerators, and preparation files are derived artifacts and can be
regenerated. The desktop import panel creates the same kinds of local derived
stores; the exact project folder is chosen in **Settings** or on first launch.
For the complete download, service-date, build, and coordinate-to-coordinate
routing sequence, follow [Document 0](tutorials/cli/00-setup-and-build.md).

## Build the desktop app from this checkout (macOS arm64)

For the maintainer-oriented build stages, prerequisites, and failure diagnosis,
see [Compile and package the VIGO macOS app](development/macos-release.md).

The source build above starts the browser workbench. To generate the native
`VIGO.app` from the Git checkout, use an Apple-silicon Mac running macOS 13.5
or newer. This starts from Git and does not require a release download. The
release build requires a clean checkout because its build manifest records the
exact source tree.

```bash
(
set -euo pipefail

export VIGO_REPO="${VIGO_REPO:-$HOME/Documents/vigo}"
cd "$VIGO_REPO"
if [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
test -z "$(git status --short)" || {
  echo "Commit or save the VIGO checkout changes before making a release build." >&2
  git status --short
  exit 1
}

# Builds the app, archives it, writes a SHA-256 sidecar, and verifies the archive.
npm run release:macos

VIGO_VERSION="$(node -p "require('./package.json').version")"
test -d "release/VIGO-mac-arm64/VIGO.app"
ls -lh \
  "release/VIGO-mac-arm64/VIGO.app" \
  "release/VIGO-mac-arm64/vigo" \
  "release/VIGO-mac-arm64/BUILD_MANIFEST.json" \
  "release/VIGO-${VIGO_VERSION}-mac-arm64.zip" \
  "release/VIGO-${VIGO_VERSION}-mac-arm64.zip.sha256"

open "release/VIGO-mac-arm64/VIGO.app"
)
```

The generated artifacts are under `release/`:

```text
release/
├── VIGO-mac-arm64/
│   ├── VIGO.app                 # native desktop application
│   ├── vigo                     # bundled CLI launcher
│   ├── BUILD_MANIFEST.json      # source and artifact identity
│   └── README.txt               # standalone usage notes
├── VIGO-<version>-mac-arm64.zip
└── VIGO-<version>-mac-arm64.zip.sha256
```

If you only need the app directory and do not need the distributable ZIP, run
the same validated stages and stop after packaging:

```bash
npm run icons:macos
npm run build
npm run clean:caches --silent
npm run check:release --silent
npm run package:macos
open release/VIGO-mac-arm64/VIGO.app
```

## Optional: verify and launch a packaged app

Use this section only when a release channel provides both
`VIGO-0.3.0-mac-arm64.zip` and its matching `.sha256` sidecar. It is not needed
for the source checkout above. From the folder containing both files:

```bash
shasum -a 256 -c VIGO-0.3.0-mac-arm64.zip.sha256
ditto -x -k VIGO-0.3.0-mac-arm64.zip .
codesign --verify --deep --strict VIGO-mac-arm64/VIGO.app
open VIGO-mac-arm64/VIGO.app
```

The archive opens into `VIGO-mac-arm64/`, which also contains the `vigo` CLI
and the build manifest. You may move `VIGO.app` to
`/Applications` after verification. If macOS blocks the first launch because
the app is ad-hoc signed, Control-click **VIGO.app**, select **Open**, and review
the macOS prompt. Do not bypass a checksum or code-signature failure.

## Create a workspace

1. On first launch, choose a local library folder or keep the default:
   `~/Documents/Vigo Projects`.
2. Select **New workspace**.
3. Give the workspace a name and region.
4. Open the workspace and select **Manage** or the empty-workspace import panel.

### Choose a map backdrop

In **Settings → Preferences → Map base**, choose the backdrop independently
of the transit data. New workspaces start with **OpenStreetMap Standard**, a
labeled OSM backdrop that keeps route and accessibility overlays grounded
without requiring a local street index. The setting can be changed at any time.

- **No basemap** keeps a clean analysis canvas.
- **Local OSM streets** draws only the current workspace’s imported PBF street
  graph, so it works without network tiles and intentionally has no labels.
- **CARTO Positron**, **OpenStreetMap Standard**, **CARTO Dark Matter**, and
  **CARTO Voyager** provide optional OSM-derived online context. Remote tiles
  are requested only for the current map view; they are not downloaded for
  offline use.
- **CARTO Voyager** is the more colorful, detailed alternative when the map
  needs stronger land-use and road hierarchy; Positron is intentionally quiet.

The local option is a network-geometry backdrop, not a full cartographic tile
renderer. Import an `.osm.pbf` file in **Settings → Data sources** first if the
workspace does not yet have a ready street index.

A workspace is a local container for source files, SQLite indexes, native
accelerators, analysis state, and retained evidence. Deleting or resetting a
workspace is separate from removing the original GTFS or OSM files.

## Load GTFS

In **Manage → Data sources**:

1. Select **Add GTFS** or drop a static GTFS ZIP onto the import target.
2. Wait until VIGO reports that the SQLite routing store is ready.
3. Return to **Network** to inspect routes and stops.

VIGO streams the source into a local, content-identified SQLite store. Required
tables and references are validated during import. A rejected feed is not
silently converted into a partial routing network.

## Add OSM when needed

A GTFS ZIP is enough for route and stop inspection and exact stop-to-stop
transit routing. Add a local OSM PBF when you need:

- arbitrary coordinate origins or destinations;
- transit access and egress over streets;
- standalone Walk or Drive routing; or
- the Evidence accessibility surface and service-scenario analysis.

Select **OSM streets** in the import panel and wait for the local street index
and native accelerator to become ready. A stale or source-mismatched street
artifact produces an explicit rebuild message.

## Understand the network

Open **Network** or press `1`.

- Search for a route or stop, or select one on the map.
- Switch among Network, Shape, Service, Transfer, and Risk lenses.
- Inspect route patterns, scheduled span, headway, trip count, stop count, and
  calculation lineage.
- Select **Schedule** and scrub the service clock to render every exact timed
  trip active at that minute. VIGO does not infer vehicle dots from headways.
- Connect GTFS-RT by pasting Vehicle Positions, Trip Updates, and Service Alerts
  URLs one per line. Vehicle Positions drives the map; the other two enrich the
  live snapshot. Select **Live** explicitly; zero valid positions remains a
  visible zero and a failed refresh retains the last live frame rather than
  switching sources. The map does not apply a top-N vehicle cap.
- Route focus defaults to **Full service**, drawing every pattern as a separate
  feature. Use **Patterns** only when one stop sequence needs inspection.
- Open source tables when a displayed fact or inference needs review.

The [Network workspace guide](gtfs-visualizer.md) explains the distinction
between source GTFS facts, derived network structure, and visualization
geometry.

## Compute a route

Open **Route** or press `2`.

1. Choose Transit, Walk, or Drive.
2. Enter an origin and destination, add ordered intermediate stops if needed,
   or select points on the map.
3. For Transit, choose Depart or Arrive, the local service date, and the time.
4. Set the access/egress limit. Choose an exact departure or the finite
   **Later departures** search.
5. Select **Directions** and inspect the returned journey and diagnostics.

Transit results show access, waits, scheduled rides, transfers, egress,
departure and arrival times, and route/stop identity. A blocked result retains
the failure reason instead of substituting a geometric estimate.

See [Routing](routing.md) for query semantics and supported modes.

## Evaluate accessibility or a service change

Open **Evidence** or press `3`.

1. Choose one origin on the map.
2. Set the service date, departure time, walking assumptions, and cutoff. The
   map follows the complete reached street extent; there is no display-radius
   crop or map-extent selector.
3. Run a baseline-only analysis, or create a case with line or walking-policy
   interventions.
4. Choose **Accessible area** for the rendered reachable polygon or **Street
   paths** for the directed OSM streets reached after transit. Then compare
   **Before**, **After**, and **Difference** views.

The result is a total-elapsed access-walk + transit + terminal-walk surface
over the directed OSM graph. Terminal walking consumes the time remaining
before the cutoff and is capped by the selected maximum walking distance. It
is not a population-weighted accessibility score. See
[Accessibility](accessibility.md) for interpretation and scenario limits.

## Next steps

- [All tutorials](tutorials/README.md) — start with [Document 0](tutorials/cli/00-setup-and-build.md) for a copy-pasteable GTFS + OSM CLI workflow
- [Network / GTFS visualizer](gtfs-visualizer.md)
- [Routing](routing.md)
- [Accessibility and scenarios](accessibility.md)
- [Use cases](guides/use-cases.md)
- [CLI tutorials](tutorials/cli/README.md)
- [Algorithms](guides/algorithms.md)
- [Development architecture](development/architecture.md)
- [CLI process contract](vigo-cli.md)

## Common setup problems

- **No timetable:** reimport the GTFS ZIP and wait for the local SQLite store.
- **Coordinate route blocked:** import an OSM PBF and rebuild the current street
  index; exact stop-to-stop transit does not require it.
- **Date outside timetable:** choose a date inside the complete coverage shown
  by Route. VIGO does not silently substitute a representative date.
- **Ambiguous place name:** choose the intended stop or station from the
  confirmation list.
- **Remote map or live feed unavailable:** static analysis still works locally;
  remote tiles and GTFS-Realtime retrieval require network access.
