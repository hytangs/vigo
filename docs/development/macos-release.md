# Compile and package the VIGO macOS app

This guide turns a VIGO source checkout into a standalone Apple-silicon
`VIGO.app` and ZIP. The package contains the Cocoa/WebKit shell, React
workbench, local API server, bundled Rust routing kernel, CLI, and pinned Node
runtime. Cargo, Rust, and system Node are build-time tools; the
installed app does not need them at runtime.

## Build stages

| Stage | Command | Main output |
| --- | --- | --- |
| Compile | `npm run build` | `dist/`, `dist-cli/`, and the Rust Node-API module |
| Package | `npm run package:macos` | `release/VIGO-mac-arm64/VIGO.app` |
| Archive | `npm run archive:macos` | Versioned ZIP and SHA-256 sidecar |
| Verify | `npm run check:macos-release` | Bundle, archive, signature, and standalone-runtime checks |

The complete sequence is `npm run release:macos`. It validates the checked-in icons,
builds the product, removes disposable build caches, runs the product release
checks, packages the app, creates the ZIP, and verifies the final artifact.

## Prerequisites

Use an Apple-silicon Mac running macOS 13.5 or newer with:

- Node.js 24.18.0 or newer, npm 11.6.2, and Git;
- rustup, which installs the toolchain pinned by `rust-toolchain.toml`;
- Xcode Command Line Tools, including `clang`, `vtool`, `codesign`, and
  `ditto`.

The native build script checks `$HOME/.cargo/bin/cargo`; set `VIGO_CARGO` if
Cargo is installed elsewhere. Packaging downloads the pinned Node arm64 archive
into `temp/runtime-cache/` and verifies its SHA-256. A local matching archive
can be supplied with `VIGO_NODE_ARCHIVE`.

## Build the app

From the repository root:

```bash
set -euo pipefail
npm ci
npm run release:macos
```

For an app directory without a ZIP:

```bash
npm run icons:macos
npm run build
npm run clean:caches --silent
npm run check:release --silent
npm run package:macos
```

To place artifacts elsewhere, set an explicit release root:

```bash
export VIGO_RELEASE_ROOT="/private/tmp/vigo-release"
```

The release checks cover documentation, UI and map contracts, source-import
contracts, routing behavior, native runtime ownership, package contents, and
the standalone first-run path.

## Outputs

```text
release/
├── VIGO-mac-arm64/
│   ├── VIGO.app
│   ├── vigo
│   ├── BUILD_MANIFEST.json
│   └── README.txt
├── VIGO-<version>-mac-arm64.zip
└── VIGO-<version>-mac-arm64.zip.sha256
```

Launch or smoke-test the result:

```bash
open release/VIGO-mac-arm64/VIGO.app
./release/VIGO-mac-arm64/vigo --help
```

Manual checks, also covered by `check:macos-release`, are:

```bash
VIGO_VERSION="$(node -p "require('./package.json').version")"
shasum -a 256 -c "release/VIGO-${VIGO_VERSION}-mac-arm64.zip.sha256"
codesign --verify --deep --strict "release/VIGO-mac-arm64/VIGO.app"
```

## Common failures

- **Cargo not found:** add `$HOME/.cargo/bin` to `PATH` or set `VIGO_CARGO`.
- **Xcode tools missing:** install or repair the Command Line Tools.
- **Icon check failed:** restore or intentionally regenerate every checked-in
  VIGO icon asset before packaging.
- **Stale manifest:** rebuild and repackage; do not edit `BUILD_MANIFEST.json`.
- **Node archive hash mismatch:** remove the invalid cache or provide a local
  archive matching `VIGO_NODE_ARCHIVE`.
- **First launch blocked:** verify the checksum and signature first. For an
  ad-hoc local build, Control-click `VIGO.app`, choose **Open**, and review the
  macOS confirmation dialog.

See [Development architecture](architecture.md) for the shell, API, worker,
and kernel boundaries, and [Quick Start](../quickstart.md) for the first local
workspace.
