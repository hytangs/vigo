# Style ownership

`App.css` is the ordered stylesheet entrypoint. Keep that list short and add new
rules to an existing owner instead of creating another `refresh`, `parity`, or
`future` override layer.

- `foundation.css` — reset, design tokens for both appearances, and app-level primitives.
- `shell.css` — top bar, navigation, projects, dialogs, and shared panels.
- `network.css` — map, service playback, route detail, Reach legend, and sidebox surfaces.
- `responsive.css` — shell breakpoints.
- `components.css` — shared controls and consolidated component refinements.
- `surfaces.css` — analyze, data, desktop-shell, and workbench surfaces.
- `theme.css` — the current VIGO visual system, including the stage layout where
  tool panels float over a full-bleed map.
- `primary-navigation.css` — the activity rail.
- `features/*/*.css` — isolated feature styles, imported after the shared system.
- `kit.css` — the V1 workspace kit: inspector head, segmented control, grouped
  rows, fields, buttons, notices, stats and disclosures.
- `network-workspace.css`, `route-workspace.css`, `reach-workspace.css` — each
  workspace's composition of the kit. They are imported last and own their
  selectors outright; do not restyle these classes in earlier files.

Import order is intentional because the current theme refines the structural
rules before feature-local styles take ownership. Do not reorder it without a
production CSS comparison and UI verification. A rule only takes effect in the
last file that owns its selector: style the rail in `primary-navigation.css`,
not in `theme.css`.

## Tokens

New rules use the canonical tokens: `--ink-*` surfaces, `--line-*` hairlines,
`--text-*` text, `--signal*` for the single interface accent, `--good`,
`--watch` and `--alert` for service states, `--material*` and `--elev-*` for
floating surfaces, and the type, radius and motion scales. Pre-V1 names such as
`--panel`, `--border` and `--text-muted` are aliases kept for existing rules.
Color in map layers comes from transit data; interface chrome stays neutral.
The reasoning is recorded in the
[Studio V1 design](../../docs/reference/studio-v1-design.md).

`npm run check:css` rejects declarations that are unconditionally replaced by
a later rule with the same selector and media context, and selectors or custom
properties nothing uses. `npm run clean:css` removes those declarations
mechanically; review and rebuild after using it.
