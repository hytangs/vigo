# Python package boundary

This directory owns the independently versioned `vigo` Python distribution. Run Python checks from this directory; keep its dependencies, wheel metadata and release notes here. Engine computation belongs in the repository root's crates/vigo-runtime/ and src/ code, not in Python.

Source wheels must remain installable without Node, Rust or the Studio build. Bundled wheels use an explicitly staged runtime from the same repository revision. Keep the public Python API and existing runtime-selection behavior stable unless the task explicitly changes them.

For cross-boundary changes, run unit, lint/type, docs/notebook/source checks and the synthetic live-runtime and isolated bundled-wheel checks described in CONTRIBUTING.md. Preserve engine 0.5 City compatibility. Never add private study data or executed notebook outputs.
