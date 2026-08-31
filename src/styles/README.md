# Style ownership

`App.css` is the ordered stylesheet entrypoint. Keep that list short and add new
rules to an existing owner instead of creating another `refresh`, `parity`, or
`future` override layer.

- `foundation.css` — reset, tokens, and app-level primitives.
- `shell.css` — top bar, navigation, projects, dialogs, and shared panels.
- `network.css` — map, service playback, route detail, and sidebox surfaces.
- `responsive.css` — light-mode compatibility and shell breakpoints.
- `components.css` — shared controls and consolidated component refinements.
- `workspaces.css` — accessibility, data, native-shell, and workbench surfaces.
- `theme.css` — the current VIGO visual system and final app-wide treatment.
- `features/*/*.css` — isolated feature styles, imported after the shared system.

Import order is intentional because the current theme refines the structural
rules before feature-local styles take ownership. Do not reorder it without a
production CSS comparison and UI verification.

`npm run check:css` rejects declarations that are unconditionally replaced by
a later rule with the same selector and media context. `npm run clean:css`
removes those declarations mechanically; review and rebuild after using it.
