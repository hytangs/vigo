# Version history

## 1.0.0-rc.2

- Apply the wheelchair City's expanded-walking policy even when a request inherits its profile without an explicit wheelchair flag.
- Keep keyboard focus in Studio search while moving through results, and announce an empty search outside the listbox.
- Describe unknown street tags and `wheelchair=yes` overrides accurately in inferred wheelchair City's limitations.
- Update Electron to 44.9.3 and Undici to 7.30.1 for their security fixes.
- Search GTFS Flex and fixed service together: Flex access and egress are time-dependent endpoints of one timetable scan, on either or both ends, departing or arriving by.
- Serve deviated routes through their fixed calls on schedule, and price continuous stopping once per shared shape pattern.
- Prepare wheelchair Cities with inferred step-free street evidence by default; `--wheelchair-streets verified` keeps the `wheelchair=yes`-only rule. Results report `accessibility.streetEvidence`.
- Preserve compatible prepared Cities, API 1.0, City format 1 and Result schema 1.

## 1.0.0-rc.1

- Add bounded Node CLI stream workers with ordered output and resource caps.
- Restore lightweight timed-leg Matrix journeys without per-cell Studio metadata; retain full metadata and geometry on request. Reuse unique native Matrix journeys across the internal transport.

- Execute Route, Matrix and Reach in Rust, including all-day accessibility.
- Add the versioned alternatives policy for thin API clients, shared-service information and explicit walking limits.
- Extend GTFS transfer, headway and station-access handling with capability and limitation reporting.
- Preserve compatible prepared Cities, API 1.0, City format 1 and Result schema 1.
- Align the Python release candidate with the same-commit engine and independent package tags.

Earlier release records remain in Git history and the archived GitHub releases.
