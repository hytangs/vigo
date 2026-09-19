# Contributing to VIGO Studio

VIGO Studio is pre-release software. This repository contains VIGO Studio, the command
line, and their shared computation code. Keep language bindings, notebooks,
generated data, release archives, private datasets, and local files outside it.

## Set up a source checkout

Follow the [Quick Start](../docs/quickstart.md) for supported platforms and the
complete fetch and build path. The reproducible dependency restore is:

```bash
npm ci
npm run build:rust-routing-kernel
npm run build:cli
```

Do not commit `node_modules`, native build output, local workspaces, caches, or
files under `release/`.

## Make a change

1. Open an issue before a substantial behavior change.
2. Keep routing ownership in the native kernel. UI, HTTP, and CLI code should
   validate requests and shape results, not create a second routing algorithm.
3. Add a focused fixture for the behavior, failure state, cancellation path, or
   source-identity rule being changed.
4. Update the routing/support documents and user guide in the same change when
   behavior changes.
5. Preserve third-party license and attribution files when adding or updating a
   dependency.

## Verify the change

Run `npm test` while working. Before proposing a release-affecting change, run
`npm run check:release`. On each supported target,
`npm run release:studio` builds, packages, checks the bundled runtime, and archives VIGO Studio; macOS bundles receive an ad-hoc signature.
Report which checks ran and which platform-specific checks did not.

For packaging changes, `npm run check:public` creates and inspects a small archive
with the host OS archiver before any full build. `npm run release:studio` remains
the complete local build, package, runtime-check, and archive command. Archive
names belong to `scripts/lib/studio-paths.mjs`; the archiver passes the produced
file directly to the release uploader. Do not duplicate filename patterns in CI.

## Claims and limitations

Tests establish agreement with VIGO's declared timetable and street-network
model. They do not establish observed operations, demand, ridership,
operational feasibility, or causal effects. Keep public descriptions within
the behavior that the source and tests implement.

## Security reports

The browser development server is loopback-only. Packaged VIGO Studio uses an
internal memory channel and does not listen on a local port. Use GitHub private
vulnerability reporting for sensitive reports. If it is unavailable, open a
brief public issue requesting a private contact channel without including exploit
details, credentials, private paths, or private datasets. Ordinary defects and
non-sensitive hardening suggestions can use the public issue tracker.
