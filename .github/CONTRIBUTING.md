# Contributing to VIGO

This repository contains Engine, Studio and the independently packaged Python interface in `python/`. Keep private datasets, executed notebooks, generated data, release archives and local workspaces outside tracked source. Public Python tutorial notebooks belong in `python/examples/` with empty outputs. Follow the [quickstart](../docs/guide.md#quickstart) to install and build.

The current release line is [VIGO 1.0.0-rc.1](../docs/releases/1.0.0-rc.1.md).

## Make a change

1. Discuss substantial behavior changes in an issue. Keep patches focused and preserve unrelated work.
2. Keep graph search and timetable propagation in Rust. UI, HTTP, and CLI code validate inputs and shape results; see [architecture](../docs/developer.md#architecture).
3. Add a focused fixture for changed behavior, cancellation, failure, or source identity. Update the canonical guide when the public contract changes.
4. Before removing old code or fixtures, trace imports, dynamic loading, scripts, and retained research consumers. A historical name is not evidence of dead code.
5. Preserve dependency licenses and attribution. Do not commit caches, native build output, `node_modules`, or `release/`.

## Verify

Use the relevant lane while developing, then run `npm test` before submitting. Report what ran and any unavailable platform checks.

| Change | Focused check |
| --- | --- |
| Documentation or repository contents | `npm run check:public` |
| TypeScript / UI state | `npm run typecheck` · `npm run check:ui` |
| Maps and desktop interactions | `npm run check:map` · `npm run check:studio-runtime` |
| Transit / streets / Reach | `npm run check:routing` · `npm run check:rust-routing-kernel` |
| Network and realtime inspection | `npm run check:agency` · `npm run check:gtfs` |
| CLI contract and City portability | `npm run check:cli` |
| Documentation guide | `npm run docs:build` · `npm run docs:standalone` · `npm run check:docs` |

`npm run typecheck` includes the CLI. JavaScript imports are inferred, with checked
JSDoc contracts at the local HTTP security, routing data-mode, and native timing
boundaries. This is incremental coverage, not a claim that all server JavaScript
is strictly checked. Add contracts as modules are changed; do not suppress errors
with blanket declarations or exclude the CLI.

`npm run format:check` checks the files listed in `scripts/format-scope.json`.
Use `npm run format` to format that scope and expand it incrementally. Avoid
unrelated whole-repository formatting. Independent test groups are listed in
`scripts/check-suites.json`; the runner reports each check's wall time, continues
after a failure, and returns failure if any check fails. Checks remain sequential
because some fixtures share generated artifacts and native caches. Build and
preparation prerequisites still stop their dependent groups when they fail.

Rust has two supported configurations: the default Node addon and
`--no-default-features --features standalone`. They use different buffer
representations; combining them fails with an explicit build instruction.
Run tests and Clippy for both supported configurations.

`check:docs` verifies the generated guide is current and validates local links, document anchors, assets, documented npm scripts, and guide/package versions across Markdown and HTML. Keep the docs index connected to current guides; preserve version history in release notes and the changelog.

Use `docs/guide.md` for user documentation, `docs/developer.md` for implementation and research guidance, and `docs/history.md` for dated records. `docs/guides/rust-standalone.md` is the engine manual and the README of engine archives, and `docs/guides/cli-only.md` is the compiler archive README; both, with the shared references, also feed the guide. Add chapters to these canonical files rather than creating a Markdown file for every topic.


## Packaging and releases

Run `npm run check:release` before a release-affecting change. On each supported target, `npm run release:studio` checks icons, builds, packages, verifies the bundled runtime, and archives Studio. macOS bundles receive an ad-hoc signature.

`check:public` scans every public file for developer paths, private workspace references and credential patterns. `check:packaged` scans the built payload and runs the relocated application with an isolated environment. These checks detect known patterns; they do not certify the absence of every possible secret. Keep runtime defaults portable and derive product versions from package metadata.

`check:public` also tests the host archiver with a small fixture. Archive paths belong to `scripts/lib/studio-paths.mjs`; pass the produced file directly to the uploader instead of duplicating filename rules in CI. The release workflow verifies supported OS/CPU targets and City portability. A local pass establishes only that host's results.

Tests validate the declared model and interfaces, not observed service, passenger impact, operational feasibility, or general model quality. See [accuracy](../docs/developer.md#checking-routing-accuracy) and [security reporting](../SECURITY.md).

## Python package

The independently versioned Python distribution lives in [`python/`](../python/README.md). Follow its [contributor guide](../python/CONTRIBUTING.md) for Python-only tests and wheels. Engine and Python integration use the same repository commit. Python release tags are `python-v<VERSION>`; engine tags remain `v<VERSION>`. Python source installs do not require frontend dependencies.
