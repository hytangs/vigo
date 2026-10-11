# Permanent prepared-data compatibility

- Published VIGO 0.5.0 at `c8da84fff7812d570fd5985cbcbcb83885587bf6` is the permanent data baseline.
- Future readers must open valid published 0.5 Cities without rebuilding. Standard writers must produce Cities readable by the published 0.5.0 runtime.
- Preserve existing format identifiers, field meanings, units, required layouts and portable references. New optional indexes must remain ignorable by old readers and unnecessary for old Cities.
- Follow `docs/reference/format-0.5.0.md`. Run `npm run check:format-050` for reader, writer or prepared-data changes; the release gate also runs through `check:standalone`.
- Never regenerate the frozen `test/fixtures/format-0.5.0` archive or change its hashes to bypass a compatibility failure. Extend coverage while retaining historical fixtures.
