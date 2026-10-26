# Version history

## 1.0.0-rc.2

- Board looping vehicles on their last pass and drop alternatives that stay aboard through a turnaround only to return to their own corridor. Forward in-seat continuations are unchanged.
- Keep route-distinct Pareto alternatives within the arrival slack, and merge journeys on one vehicle chain in both rankings.
- Offer wider-walk ("More walking") choices only when they arrive at least a minute before every ordinary choice.
- Replace a short final ride, and its wait, with walking the rest of the way when that arrives at least a minute sooner within the wider-walk budget.
- Stop the one-to-many Matrix scan once no later departure can improve any target: identical results, about 3.6× faster 5×5 Matrices on Boston.
- Studio turns walks between nearby stops on by default.

## 1.0.0-rc.1

- Add bounded Node CLI stream workers with ordered output and resource caps.
- Restore lightweight timed-leg Matrix journeys without per-cell Studio metadata; retain full metadata and geometry on request. Reuse unique native Matrix journeys across the internal transport.

- Execute Route, Matrix and Reach in Rust, including all-day accessibility.
- Add the versioned alternatives policy for thin API clients, shared-service information and explicit walking limits.
- Extend GTFS transfer, headway and station-access handling with capability and limitation reporting.
- Preserve compatible prepared Cities, API 1.0, City format 1 and Result schema 1.
- Align the Python release candidate with the same-commit engine and independent package tags.

Earlier release records remain in Git history and the archived GitHub releases.
