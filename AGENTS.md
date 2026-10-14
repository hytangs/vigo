# Permanent prepared-data compatibility

- Published VIGO 0.5.0 at `c8da84fff7812d570fd5985cbcbcb83885587bf6` is the permanent data baseline.
- Future readers must open valid published 0.5 Cities without rebuilding. Standard writers must produce Cities readable by the published 0.5.0 runtime.
- Preserve existing format identifiers, field meanings, units, required layouts and portable references. New optional indexes must remain ignorable by old readers and unnecessary for old Cities.
- Follow `docs/reference/format-0.5.0.md`. Run `npm run check:format-050` for reader, writer or prepared-data changes; the release gate also runs through `check:standalone`.
- Never regenerate the frozen `test/fixtures/format-0.5.0` archive or change its hashes to bypass a compatibility failure. Extend coverage while retaining historical fixtures.

# Package ownership

- `python/` owns the independently versioned Python distribution, its dependencies, documentation and tests. Run its tools from that directory and follow `python/AGENTS.md`.
- Native routing computation stays in the engine; Python wraps the public protocol. Source-wheel installation must not require npm or Rust.
- Python integration and bundled wheels build the engine from this same checkout. Keep Python release tags (`python-v<VERSION>`) separate from engine tags (`v<VERSION>`).
