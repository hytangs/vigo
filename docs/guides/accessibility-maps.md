# Beautiful accessibility maps

An accessibility map becomes useful when the visual design explains the
question instead of competing with it. VIGO already computes the hard part: a
walk + transit + walk travel-time surface over the directed OSM pedestrian
network. This guide shows how to present that surface as a clear, attractive,
and reproducible map.

VIGO does not currently expose a plugin API. The practical extension point is
the standalone renderer at
[`scripts/render-accessibility-map.mjs`](../../scripts/render-accessibility-map.mjs).
It has no additional npm dependency and reads the full
`vigo.cli.isochrone.v1` result produced by the CLI.

## The quick path

Run the isochrone workflow from [CLI Tutorial 4](../tutorials/cli/04-matrices-and-isochrones.md)
and retain the complete JSON result. Then render it:

```bash
node scripts/render-accessibility-map.mjs \
  --input="$VIGO_OUTPUT/isochrone-result.json" \
  --output="$VIGO_OUTPUT/accessibility-map.html" \
  --palette=viridis \
  --theme=light \
  --title="Origin accessibility"

open "$VIGO_OUTPUT/accessibility-map.html"
```

The generated page contains:

- a continuous travel-time raster;
- labeled cutoff contours such as 15, 30, and 45 minutes;
- the origin and reached timetable stops;
- a legend tied to the actual cutoff values;
- surface, contour, stop, opacity, palette, and theme controls; and
- the run settings needed to interpret the picture.

The HTML embeds the VIGO result, but the basemap uses remote Leaflet and
OpenStreetMap tiles. An internet connection is therefore needed for the
background map. The data layer remains local and can also be exported to QGIS
with the normal GeoJSON command in the CLI tutorial.

## Pick the visual language

The renderer provides three palettes:

| Palette | Best use | Caution |
| --- | --- | --- |
| `viridis` | Quantitative work, reports, and color-vision-safe reading | Less dramatic than a rainbow, by design |
| `sunset` | A warm presentation or public-facing story map | Keep the numeric labels visible |
| `rainbow` | A high-energy presentation or exploratory map | Hue is not a reliable numeric scale; do not use it alone for precise comparisons |

Use one ordered ramp for the surface and the same ramp for its contours. The
reader should be able to infer that a nearby contour is an earlier or later
threshold, rather than learning a new color code for every layer.

For a serious comparison, keep the palette, cutoff list, opacity, and raster
size fixed across all maps. The desktop display extent follows the complete
reached street envelope rather than a user-selected rectangle. If two maps use
different normalization, the colors can look different even when the underlying
travel times are the same.

## Three recipes

### 1. Clean isochrone

Use this for a report, memo, or a single-origin question:

```bash
node scripts/render-accessibility-map.mjs \
  --input="$VIGO_OUTPUT/isochrone-result.json" \
  --output="$VIGO_OUTPUT/isochrone-clean.html" \
  --palette=viridis \
  --theme=light
```

Keep the surface and contours on. Turn off reached stops when the map becomes
busy. Three or four cutoffs are usually enough; the labels carry the exact
meaning of each line.

### 2. Rainbow exploration

For a more expressive map, opt into the rainbow palette:

```bash
node scripts/render-accessibility-map.mjs \
  --input="$VIGO_OUTPUT/isochrone-result.json" \
  --output="$VIGO_OUTPUT/isochrone-rainbow.html" \
  --palette=rainbow \
  --theme=dark \
  --title="Reachable network · fixed 08:00 departure"
```

Keep the contour labels and legend. The rainbow is then a visual accent, not
the only carrier of the travel-time values. For a quantitative publication,
use `viridis` instead.

### 3. Current network / scenario case

Use the **Evidence** workspace when comparing a baseline with a declared line,
route-removal, or walking-policy case. Fix the origin, service date, departure,
cutoffs, raster size, and walking assumptions; then inspect **Current
network**, **Scenario**, and **Time difference**. The time-difference view is
signed: green is faster under the case, gray is unchanged, and red is slower.

Do not stack two opaque rainbow surfaces and call the visible color mixture a
benefit map. A good comparison gives the baseline a quiet treatment, gives the
case one clear accent, and reserves a separate legend for “improved,” “same,”
and “worse.” The desktop Evidence view retains the current-network, scenario,
and improved-cell metrics. See [Accessibility and scenarios](../accessibility.md)
for the computational and evidence boundary.

## Design rules that make the map read well

1. Start with the question. Put the origin, departure, service date, walking
   budget, and maximum cutoff in the title or side panel.
2. Use the surface for continuity and contours for decisions. The raster shows
   the shape of the network effect; a 30-minute line answers a threshold
   question.
3. Keep an outline around bright lines. The renderer uses a light/dark casing
   beneath each colored contour so roads and satellite imagery do not erase it.
4. Use labels and hover text. Color should reinforce “15 min,” not replace it.
5. Show the pedestrian network honestly. VIGO does not fill disconnected
   empty space with a circle or straight-line interpolation.
6. Reduce rather than decorate. Too many thresholds, route labels, and opaque
   layers make a map impressive at first glance but hard to audit.
7. Keep the complete JSON beside the HTML. The HTML is a presentation artifact;
   the JSON retains source identity, query settings, diagnostics, and the full
   raster.

## What the colors mean

For a VIGO isochrone, a cell’s value is the earliest modeled arrival time
supported by a reachable directed OSM edge from the selected origin. Edge
values are interpolated between graph nodes; empty cells are left transparent
instead of being filled by a radial or cross-barrier straight-line guess. The
value includes walking, waiting, scheduled transit, transfers, and terminal
walking under the declared query.
The map does not automatically represent population, jobs, land area,
ridership, reliability, capacity, behavior, or a causal policy effect.

The output is sampled on a raster. Increasing `--raster-size` from 48 to 96 or
128 gives a finer display, but it does not turn the result into observed
precision. Contours still reflect the represented timetable and directed OSM
network.

## Accessibility and reproducibility checklist

Before publishing or sharing a map, verify:

- the legend has numeric cutoff labels;
- the origin is visible and named;
- the map does not rely on color alone;
- the same palette and cutoffs are used in comparisons;
- the HTML’s title states the analysis context;
- the full result JSON is retained beside the HTML; and
- the source GTFS, OSM store, VIGO version, service date, departure time,
  walking policy, raster size, complete reached-edge extent, and diagnostics are recorded.

The renderer includes a focused self-test:

```bash
node scripts/render-accessibility-map.mjs --self-test
```

If the page is blank, first check that you passed the full isochrone JSON, not
only `isochrones.geojson`; the GeoJSON contains the contours but not the
travel-time raster used for the colored surface.
