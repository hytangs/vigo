# Evidence workspace: accessibility, GTFS comparisons, and scenarios

## Overview

The **Evidence** workspace turns one-to-many routing into a baseline,
baseline-versus-case, or multi-feed accessibility surface. It answers:

> From this origin, on this service date and departure time, which parts of the
> pedestrian network are reachable within the selected cutoff—and how would a
> declared service or walking-policy case change that result?

Open **Evidence** or press `3`. With at least two independently indexed GTFS
feeds in the same workspace, choose **Compare GTFS group**, select the feeds,
and run the identical snapshot against each one. Every isochrone is overlaid on
the map with its own color.

This is a network accessibility calculation, not “routing many times.” The
resident timetable is scanned once for the selected origin, then reached
transit stops seed one final directed OSM surface. Access walking, waiting,
transit, transfers, and terminal walking share one elapsed-time cutoff.
Terminal walking uses only the remaining time and is additionally capped by
the declared maximum walking distance. Stop selection and surface expansion
have no geographic envelope.

### Map renderings

After an analysis completes, choose one of two map renderings. Both come from
the same one-to-many OSM search; changing the rendering does not rerun the
analysis:

- **Accessible area**: filled polygons for the union of directed OSM streets
  reachable from the origin and from every transit stop reached within the
  transit cutoff. The polygonization envelope is derived from the complete
  reached-edge geometry after the native search; it is not a rectangular map
  crop. Cells without a supporting reachable street remain outside the polygon.
- **Street paths**: the directed OSM street edges reachable from those seeds
  under the complete walking budget. A path is retained when its supporting
  stop arrives within the transit cutoff, even if walking the full terminal
  budget takes additional clock time. Colors identify the earliest transit
  arrival of the supporting seed; walking distance remains explicit edge
  evidence.

The desktop response carries the complete reached-edge evidence for both
renderings. The native surface returns one indexed binary edge bundle with the
exact directed OSM edge ID, so endpoint coordinates are deduplicated and
comparison views can join baseline and scenario surfaces by a linear ID merge.
The browser batches the full set into `MultiLineString` features without an
object per edge and decodes only geometry, arrival duration, and edge IDs needed
for rendering. Other edge evidence remains packed. When baseline and scenario
are identical, the response carries one bundle plus an explicit reference
rather than serializing the geometry twice.
The native query replays that retained edge table once into a compact
edge-envelope raster for polygonization; this is not a second routing search.
Area mode renders the resulting vector polygons and contours directly, with no
rectangular raster `ImageSource` and no browser-side PNG canvas allocation.
Settled OSM nodes remain internal to the native search and are not returned as
an accessibility point layer.

### Empty transit windows

The selected date and departure time are binding. If the timetable has no
active service, or the first scheduled departure falls after the selected
cutoff window, the response reports that state and the earliest scheduled
departure when it is available. The desktop may still show the origin-only
walking context, but it does not relabel that context as transit reach or
invent a reached stop. A zero stop count therefore means either no service,
no service inside the requested window, or no stop reachable under the stated
OSM access budget; inspect the status message before interpreting the area.

### Network comparison views

After choosing an origin and running the analysis, the Evidence map can show:

- **Current network**: the existing network’s modeled minutes from the origin,
  using one continuous blue-to-red ramp and numeric legend endpoints.
- **Scenario**: the same minute ramp for the declared case.
- **Time difference**: current-network minutes minus scenario minutes; green is
  faster, gray is unchanged, and red is slower. The visual difference is capped
  at 15 minutes while the returned raster retains the modeled values.

With no active case, **Current network** is the useful surface and there is no
implied counterfactual comparison.

The current-network, scenario, and time-difference views select which network
result is shown in either rendering mode. The polygon and street-path layers
are visualizations of the same exact search, not a second accessibility
calculation or a cropped evidence sample.

## What the analysis is—and is not

The current workspace produces a total-arrival raster, area polygons,
and all reached directed-OSM street edges for one origin. The raster is
not a radial heatmap: reachable edge values include elapsed terminal walking
from the best supporting seed, while cells with no reachable OSM edge remain
transparent. This keeps visual coverage honest around barriers, parks, water,
and disconnected street components without adding a free outer walking fringe.
It can compare a selected group of independent GTFS feeds, or compare one feed
against up to six retained in-memory cases, each with up to eight line or
walking-policy interventions.

It is not currently:

- an opportunity-weighted jobs, schools, or population accessibility measure;
- a demand assignment or ridership forecast;
- a reliability or stochastic waiting model;
- a continuous departure-window analysis; or
- proof that a network change causes an observed social outcome.

Those questions require additional destination, population, behavior, or
identification data beyond the schedule and street network.

## Requirements

Evidence requires both:

- a ready GTFS timetable store for the selected service date; and
- a ready directed OSM pedestrian store and native accelerator.

GTFS comparison additionally requires at least two independently indexed
feeds. The comparison never uses the project bundle for a selected feed when
an individual feed store is available.

The operation fails closed when either dependency is unavailable. It does not
replace a missing street path with a circle or straight-line distance.

## Analysis model

| Input | Role |
| --- | --- |
| Origin | One exact stop or map coordinate |
| Service date and time | Selects the resident scheduled timetable and departure |
| Maximum walk | Bounds access and egress on the OSM graph |
| Walking speed | Converts admitted graph distance to time |
| Display envelope | Derived from every reached directed OSM edge; no user-selected rectangle |
| Cutoff | Selects which reached cells are shown or counted |
| Case | Optional route exclusions, temporary services, and walking-policy changes |

The output is total-elapsed access walk + transit + terminal walk. Walking-only
reach starts from a zero-minute origin seed. Transit egress is represented by
additional seeds whose duration is their arrival time at each reachable stop;
OSM expansion then consumes the time remaining before the shared cutoff.

## Typical workflow

1. Select an origin on the map.
2. Set the service date, departure time, walk limit, speed, and cutoff.
3. Run the baseline.
4. Add a named case if a counterfactual is needed.
5. Add line or policy interventions and configure their assumptions.
6. Run again, choose **Accessible area** or **Street paths**, and inspect
   **Current network**, **Scenario**, and **Time difference**.
7. Retain the request, result, source identities, and diagnostics when the
   comparison will be cited.

For a multi-feed comparison:

1. Import the GTFS ZIPs in **Manage workspace** and wait for each SQLite
   routing store to become ready.
2. Open **Evidence**, choose **Compare GTFS group**, and select at least two
   feeds from the checklist.
3. Choose one origin and keep the date, departure, walking policy, and cutoff
   fixed.
4. Run the comparison. The map shows the same-cutoff surface for every
   selected feed with a separate color, and the panel reports reachable cells
   and transit-stop seeds for each feed.

### Street-service comparison

When exactly two feeds are selected, **Map street service change** adds a
separate physical-service view to the same Evidence map. It answers a
different question from the isochrone:

> Which directed road segments carry scheduled bus service in both feeds, only
> the baseline, or only the comparison feed?

VIGO uses each feed's published GTFS `shapes.txt` geometry and matches it to the
project's local OSM `drive_edges`. Matching is therefore independent of GTFS
route IDs and can identify a maintained physical segment when a feed renames a
route. The map colors edges as added, maintained, or removed and reports the
matched pattern/edge diagnostics.

This is deliberately a bounded VIGO implementation of physical-network
comparison. VIGO does not invent geometry from stop chords, use the pedestrian
graph as a bus graph, or count a pattern whose shape match is partial/unmatched.
Patterns without published shape geometry are excluded, and the current
representation is one directed OSM edge rather than unverified stop-split
geometry. Use the accessibility surface for reachability
and this view for scheduled service continuity; neither is a demand or
operations forecast.

Changing an input invalidates the displayed calculation. Cancel stops the
active request cooperatively; progress is reported across preparation,
baseline, case, surface, and completion stages.

## Supported case interventions

| Intervention | Current semantics |
| --- | --- |
| Add line | Create an ordered temporary service from map-sketched stops, operating window, headway, speed, dwell, and optional reverse direction |
| Enhance line | Overlay declared frequency/speed service on an existing representative route pattern while retaining baseline service |
| Change line | Exclude the selected baseline route identity and add a declared replacement service |
| Remove line | Exclude the selected route identity from the case search |
| Policy | Change maximum walking distance and/or walking speed for the case |

A case may combine these operations. It does not edit the imported GTFS ZIP,
SQLite store, or canonical point-routing endpoint.

### Editing an existing route

For **Change line** and **Enhance line**, choose one explicit **Path + timing**
mode:

- **Published shape + timetable** keeps the selected branch's stored GTFS
  geometry and published segment runtimes.
- **Hybrid: GTFS shape + OSM roads** is the default for edited routes. VIGO
  keeps every untouched original A → B span on the published `shapes.txt`
  geometry, then sends only gaps created by an inserted or moved stop to the
  local OSM driving graph. The original A → B runtime is preserved, adjusted
  for the new road distance at the original distance-based speed, and a dwell
  is added at each inserted station. If OSM cannot connect an edited gap,
  VIGO uses that gap's published-shape sub-segment as a disclosed fallback;
  it never silently draws a straight line.
- **Straight-line estimate** is an explicit fallback for a sketch that does
  not need road geometry. It uses the configured average speed and does not
  claim that the chord is drivable.

Intermediate stops are placed into an explicit ordered gap. The editor moves
the active gap forward after each insertion, so a sequence of new stations can
be added without accidentally reusing the first gap. **All branches serving
this exact A → B edge** copies inserted stops only to GTFS branches whose
ordered adjacent stop IDs are exactly that edge; branches with a different
sequence remain unchanged.

## Scenario comparison

The baseline and case share the same origin, date, departure, source GTFS/OSM
identity, raster definition, and walking policy unless the intervention
explicitly changes that policy. Their display envelopes are derived separately
from their complete reached-edge sets, so a scenario cannot be clipped to the
baseline rectangle.

Temporary services are compiled into query-scoped scheduled connections and
chronologically merged with the resident timetable. The merged scan supports
baseline-to-scenario, scenario-to-baseline, and scenario-to-scenario transfers.
Generic boarding slack still applies across zero-second identity connectors.

Route removal is a route-level counterfactual. When one public line corresponds
to multiple stored GTFS route variants in the same feed scope, the selection
expands to those matching variants rather than deleting unrelated same-name
routes.

## Outputs and metrics

The desktop presents:

- current-network and scenario accessible-area polygons or reached street paths;
- a continuous minute legend for the selected surface;
- a signed time-difference surface with faster, unchanged, and slower states;
- an OSM-supported transit-arrival raster retained for diagnostics and stable
  cell comparisons; each reached transit stop contributes its full terminal
  walking envelope;
- reachable baseline and case cell counts;
- approximate mapped accessible area, reachable directed-OSM street-network
  kilometres, and transit stops reached by the selected transit cutoff;
- cells improved by the active case;
- route/service intervention summaries;
- resident and scenario stop reachability; and
- multi-feed reachable-cell and isochrone comparisons under one fixed snapshot;
- optional directed OSM drive-edge service comparison for exactly two feeds;
- preparation, native scan, street-surface, memory, cache, and source-identity
  diagnostics.

The desktop does not return or render a settled-node point cloud. Reached-edge
evidence and edge-envelope raster cells are views of the same directed OSM search;
empty space is not filled by radial interpolation or an invented straight walk
across a gap. Cell counts are useful for comparing the same fixed raster; they
are not automatically people, jobs, parcel area, or welfare. The mapped-area
value is an estimate of raster-cell coverage, not a loaded population or
opportunity measure.

The current range operator returns scalar earliest-arrival fields, not a
reconstructed itinerary for every cell. Use the Route workspace to inspect a
specific journey behind a location-level question.

## Scale and execution

VIGO does not route every raster pixel independently. It sends every active
timetable stop through one resident one-to-many connection scan, without a
geographic destination preselection, and then propagates all reached seeds over
the directed street graph. The final-walk budget remains an explicit routing
policy; it is not a display crop.

The operation has no public matrix destination cap, sampled transit destination
set, rectangular display crop, or request-local timetable compiler. Journeys may
leave the initial raster envelope and return; the displayed area follows the
complete reached-edge geometry.

## Reproducibility and export

The desktop keeps completed results in a bounded in-memory cache keyed by the
source artifacts and complete request. The local HTTP endpoint returns the
machine-readable `vigo.scenario-analysis.v1` envelope. The CLI `isochrone`
command exposes the same native surface and generated GeoJSON contours for
retention outside the desktop. There is not yet
a dedicated one-click population-analysis export in the Evidence panel.

For reproducible work, preserve:

- GTFS and OSM source identities;
- compiled store/accelerator identities;
- VIGO version and source state;
- origin, service date, and departure time;
- all walking, cutoff, and raster assumptions;
- every intervention definition; and
- the complete returned diagnostics.

## Interpretation and limitations

An improved cell means the case reaches the sampled street vertex sooner under
the declared model. It does not by itself show how many people benefit, whether
they would use the service, whether operations are feasible, or whether an
observed outcome is causally attributable to the change.

Temporary service travel times use declared speed, dwell, headway, operating
window, ordered stops, and directed OSM connectors. They are planning
assumptions, not a simulated operating plan. Street topology, missing paths,
calendar limits, and unsupported GTFS semantics remain binding.

See the [scenario-analysis architecture](scenario-analysis-architecture.md),
[routing contract](routing-contract.md), and [known limitations](known-routing-limitations.md)
for the exact computational boundary.
