# Automatic build memory selection

The Node build entry points (`scripts/build-standalone.mjs` and
`scripts/build-rust-routing-kernel.mjs`) automatically select low-memory Cargo
settings when detected physical or container-constrained memory is
4 GiB or less. Temporary available-memory pressure instead limits compilation
to one job while preserving the normal release optimizations. Unknown limits
are ignored. Detection uses Node's OS/libuv memory APIs; run with the project's supported Node version.

Low-memory mode uses one Cargo job, 16 code-generation units, no incremental
compilation, no debug information, and no LTO. It logs its selection. These
settings reduce compiler memory demand; they do not guarantee that every build
fits a particular memory limit. They do not change VIGO's runtime memory controls.

`VIGO_BUILD_MEMORY=low` forces this mode. `VIGO_BUILD_MEMORY=full` preserves the
normal release profile and explicit Cargo environment settings. The default is
`auto`. Low-memory builds can have different runtime performance, so use `full`
on a sufficiently provisioned build host for comparable release benchmarks.

Direct `cargo build` bypasses the Node build entry points and therefore bypasses
automatic detection. Use `node scripts/build-standalone.mjs` when automatic
selection is required. Changing modes rebuilds affected Cargo artifacts.

Run detection tests with `node --test test/check-build-memory.mjs`.
