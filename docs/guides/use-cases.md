# Use Cases

VIGO is organized around questions rather than isolated controls:

> Understand the network → Query a journey → Evaluate a case

The examples below state the question, the VIGO workflow, and the result that
can be supported by the current product.

## Explore an unfamiliar transit network

**Question:** What routes, stops, service patterns, and schedule coverage are
actually encoded in this feed?

**VIGO workflow:** Create a workspace, import the GTFS ZIP, open **Network**, and
inspect the service catalog, map, temporal patterns, route/stop lineage, and
Shape/Service/Transfer/Risk lenses.

**Result:** A local, inspectable representation that separates published GTFS
facts from derived pattern structure and visualization geometry. The result
describes the feed; it is not evidence of observed operations or ridership.

## Diagnose an unexpected itinerary

**Question:** Why did the route depart later, walk farther, transfer, or become
unreachable?

**VIGO workflow:** Reproduce the exact service date, time constraint, endpoints,
and walk limit in **Route**. Inspect the chronological legs, waits, route/trip
identity, access diagnostics, service coverage, and any unsupported-feature or
rebuild message. Return to **Network** to inspect the selected services and
stops.

**Result:** A source-bound explanation of the represented itinerary or failure.
It can reveal calendar, access, transfer, topology, or data-support boundaries;
it does not prove that the real-world trip operated as scheduled.

## Compare a proposed service change

**Question:** How would adding, enhancing, changing, or removing a line alter
the reachable street network from one origin?

**VIGO workflow:** In **Evidence**, fix the origin, date, departure, source
network, cutoff, and raster. Run the baseline, create one named case, define the
line intervention, and compare Before, After, and Difference.

**Result:** Baseline and case total-elapsed access-walk + transit + terminal-walk
surfaces under explicit planning assumptions. Access, waiting, transit,
transfers, and terminal walking share one cutoff; terminal walking uses only
the remaining time and is also capped by the declared maximum distance. The
result shows modeled reachability change, not demand, operational feasibility,
welfare, or a causal effect.

## Test a walking-policy assumption

**Question:** How sensitive is modeled access to the maximum walking distance
or assumed walking speed?

**VIGO workflow:** Create a Policy intervention in **Evidence** while keeping all
other inputs fixed. Run the case and compare the same raster and cutoffs.

**Result:** A controlled model-sensitivity comparison. It should be described as
an assumption change, not an observed behavioral response.

## Compute a reproducible batch of trips

**Question:** What itineraries or travel times result for a retained OD set?

**VIGO workflow:** Build the network once through the CLI, place many requests
in one batch, set the explicit service date and policy, and retain input/output
files plus preparation and per-request timing.

**Result:** Full itineraries and/or scalar rows from the same canonical
JavaScript/native runtime used by the desktop. Startup, preparation, search,
and output time remain separately visible.

## Prepare evidence for review

**Question:** What must another analyst retain to understand or reproduce a
claim?

**VIGO workflow:** Keep source hashes, store/accelerator identities, VIGO version
and source state, exact request/corpus, assumptions, raw rows, diagnostics,
machine environment for timing, and the relevant support/limitation contracts.

**Result:** A provenance package that distinguishes execution success,
descriptive network evidence, routing-model validity, and any separate causal or
operational claim.

## Choose the right workspace

| If your question begins with… | Start in… |
| --- | --- |
| “What did this GTFS encode?” | [Network](../gtfs-visualizer.md) |
| “How can this trip be made?” | [Route](../routing.md) |
| “What changes under this case?” | [Evidence](../accessibility.md) |

For setup, begin with the [Quick Start](../quickstart.md).
