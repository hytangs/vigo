# Contributing to VIGO

This repository contains Engine and Studio. Keep language bindings, private datasets, notebooks, generated data, release archives, and local workspaces outside it. Follow the [quickstart](../docs/guide.md#vigo-cli-quickstart) to install and build.

The current release line is [VIGO 0.5.0](../docs/releases/0.5.0.md).

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
| Network, realtime inspection, Ask | `npm run check:agency` · `npm run check:gtfs` |
| CLI contract and City portability | `npm run check:cli` |
| Documentation readers | `npm run docs:build` · `npm run docs:standalone` · `npm run check:docs` |

`check:docs` verifies the generated reader is current and validates local links, document anchors, assets, documented npm scripts, and guide/package versions across Markdown and HTML. Keep the docs index connected to current guides; preserve version history in release notes and the changelog.

Use `docs/guide.md` for user documentation, `docs/developer.md` for implementation and research guidance, and `docs/history.md` for dated records. The remaining CLI, standalone, and shared reference sources feed packaged documentation. Add chapters to these canonical files rather than creating a Markdown file for every topic.

Actual-model evaluations are opt-in, never part of deterministic tests. `npm run evaluate:intelligence -- --output intelligence.jsonl` exercises the configured provider; `node scripts/evaluate-network-briefing.mjs --output briefing.json` evaluates a synthetic briefing. The latter requires a new output path and `VIGO_AGENCY_LLM_*` settings; use `--variant stale` for expired evidence. Retain provider, input, and revision provenance, and distinguish these runs from live service evidence.

## Packaging and releases

Run `npm run check:release` before a release-affecting change. On each supported target, `npm run release:studio` checks icons, builds, packages, verifies the bundled runtime, and archives Studio. macOS bundles receive an ad-hoc signature.

`check:public` scans every public file for developer paths, private workspace references and credential patterns. `check:packaged` scans the built payload and runs the relocated application with an isolated environment. These checks detect known patterns; they do not certify the absence of every possible secret. Keep runtime defaults portable and derive product versions from package metadata.

`check:public` also tests the host archiver with a small fixture. Archive paths belong to `scripts/lib/studio-paths.mjs`; pass the produced file directly to the uploader instead of duplicating filename rules in CI. The release workflow verifies supported OS/CPU targets and City portability. A local pass establishes only that host's results.

Tests validate the declared model and interfaces, not observed service, passenger impact, operational feasibility, or general model quality. See [accuracy](../docs/developer.md#checking-routing-accuracy) and [security reporting](../SECURITY.md).
