# Contributing to VIGO

VIGO—Visual Intelligence for GTFS Operations—is experimental and is still
being prepared for public release. This repository contains the workbench,
native Rust computation kernel, and loopback HTTP and CLI surfaces that use it.
Keep language bindings, notebooks, generated data, release archives, private
datasets, and local project files outside it.

## Set up a source checkout

Follow the [Quick Start](docs/quickstart.md) for supported platforms and the
complete fetch and build path. The reproducible dependency restore is:

```bash
npm ci
npm run build:rust-routing-kernel
npm run build:cli
```

Do not commit `node_modules`, native build output, local workspaces, caches, or
files under `release/`.

## Make a change

1. Open an issue before a substantial behavioral or contract change.
2. Keep routing ownership in the native kernel. UI, HTTP, and CLI code should
   validate requests and shape results, not create a second routing algorithm.
3. Add a focused fixture for the behavior, failure state, cancellation path, or
   source-identity rule being changed.
4. Update the routing/support documents and user guide in the same
   change when behavior changes.
5. Preserve third-party license and attribution files when adding or updating a
   dependency.

## Verify the change

Run the public and development checks while working:

```bash
npm test
```

Before proposing a release-affecting change, run:

```bash
npm run check:release
```

On a supported Apple-silicon Mac, `npm run release:macos` adds the packaged,
checksum, code-signature, source-manifest, and isolated-startup checks. Report
which lanes ran and any platform-specific lane that was not run.

## Claims and limitations

Tests establish agreement with VIGO's declared timetable and street-network
model. They do not establish observed operations, demand, ridership,
operational feasibility, or causal effects. Keep public descriptions within
the behavior that the source and tests actually implement.

## Security reports

Do not place credentials, private data, or detailed vulnerability reports in a
public issue. Follow [SECURITY.md](SECURITY.md) for the current reporting path.
