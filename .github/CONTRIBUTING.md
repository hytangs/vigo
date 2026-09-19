# Contributing to VIGO

This repository contains Engine and Studio. Keep language bindings, private datasets, notebooks, generated data, release archives, and local workspaces outside it. Follow the [quickstart](../docs/quickstart.md) to install and build.

## Make a change

1. Discuss substantial behavior changes in an issue. Keep patches focused and preserve unrelated work.
2. Keep graph search and timetable propagation in Rust. UI, HTTP, and CLI code validate inputs and shape results; see [architecture](../docs/development/architecture.md).
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
| Network, realtime inspection, Ask | `npm run check:agency` · `npm run check:gtfs` |
| CLI contract and City portability | `npm run check:cli` |
| Printable guide | `npm run docs:developer-guide` (XeLaTeX) |

`check:docs` validates local links, document anchors, assets, documented npm scripts, and guide/package versions across Markdown and HTML. Keep the docs index connected to current guides; preserve version history in release notes and the changelog.

Actual-model evaluations are opt-in, never part of deterministic tests. `npm run evaluate:intelligence -- --output intelligence.jsonl` exercises the configured provider; `node scripts/evaluate-network-briefing.mjs --output briefing.json` evaluates a synthetic briefing. The latter requires a new output path and `VIGO_AGENCY_LLM_*` settings; use `--variant stale` for expired evidence. Retain provider, input, and revision provenance, and distinguish these runs from live service evidence.

## Packaging and releases

Run `npm run check:release` before a release-affecting change. On each supported target, `npm run release:studio` checks icons, builds, packages, verifies the bundled runtime, and archives Studio. macOS bundles receive an ad-hoc signature.

`check:public` also tests the host archiver with a small fixture. Archive paths belong to `scripts/lib/studio-paths.mjs`; pass the produced file directly to the uploader instead of duplicating filename rules in CI. The release workflow verifies supported OS/CPU targets and City portability. A local pass establishes only that host's results.

Tests validate the declared model and interfaces, not observed service, passenger impact, operational feasibility, or general model quality. See [accuracy](../docs/routing-accuracy.md) and [security reporting](../SECURITY.md).
