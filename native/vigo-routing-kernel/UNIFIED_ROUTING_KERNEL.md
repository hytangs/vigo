# Unified resident Rust routing system

## Ownership

VIGO has one resident Rust routing system, not one algorithm forced onto every
problem. Its admitted operators share immutable street and timetable images,
query-scoped state, fixed routing semantics, and one thin Node-API boundary:

- `CoordinateKernel` owns directed street access, endpoint paths, timed
  connectors, and Accessibility raster propagation. Its admitted acceleration
  is customized contraction hierarchies (CCH).
- `TimetableKernel` owns scalar, Pareto, matrix, and one-to-many public-transit
  propagation. Its chronological operator is connection scan (CSA).
- `DriveKernel` owns driving paths. It uses one CCH structure customized with a
  time metric and a distance metric, plus one exact resource-constrained
  fallback when a distance cap makes the two scalar optima insufficient.

Accessibility owns the complete `walk + transit + walk` operation. It creates
scenario connectors, executes the resident/overlay timetable scan, and creates
the final surface in the same request. Scenario analysis consumes that result;
it does not own a router or a final-surface executor.

JavaScript validates and projects requests, manages resident lifetimes, and
materializes responses. It must not contain a shadow timetable, street,
scenario, or Drive search. If a required native image or artifact is missing or
inconsistent, production fails closed.

The former regional topology/timetable kernels and the standalone scenario
FIFO/Dijkstra kernel are removed execution paths, not fallbacks.

## Formal contracts

### Resident and query-overlay timetable range

Input:

- a resident service-date `TimetableKernel` with finite stops, runs,
  chronological connections, permissions, and directed transfer CSR;
- origin stop labels, departure `t0`, finite horizon `H`, output-stop indices,
  and optional excluded resident trip indices;
- optionally, finite scenario direction patterns, service windows/headways,
  overlay stops, and a finite supplemental directed transfer CSR joining the
  resident and overlay stop domains.

Output:

- a status-bearing earliest ride-bearing arrival for each requested resident
  output stop;
- earliest arrivals for overlay stops when an overlay is present; and
- scan, compilation, transfer, exclusion, resident-identity, and timing
  diagnostics.

The overlay is query scoped. It never mutates or recompiles the resident
timetable. Its combined stop domain permits baseline-to-scenario,
scenario-to-baseline, and scenario-to-scenario transfers.

### Accessibility range

Input:

- one origin coordinate or exact stop; service date and departure; walk speed,
  walk limit, cutoff, and display surface; plus
- optional resident route exclusions and the query overlay above.

Output:

- resident and overlay stop-arrival fields;
- one final directed-OSM travel-time raster seeded by the origin and every
  reached resident or overlay stop; and
- stage-separated access, connector, CSA, raster, and complete wall timings.

### Drive

Input:

- a finite directed drive CSR with node coordinates, edge travel seconds, and
  edge metres;
- finite origin and target snap candidates; and
- a positive maximum total distance.

The admitted exact numerical domain is centiseconds and centimetres. Every edge,
snap, cap, CCH metric, and fallback label is quantized once into that shared
fixed-point domain.

Output:

- the minimum-time feasible path and its node witness; or a typed blocked
  result;
- whether the constrained fallback ran; and
- CCH source, candidate-query count, stage timings, and bounded-search counts.

## Algorithms

### Query-scoped overlay CSA

```text
overlay_range(origin_labels, resident, overlay_spec, exclusions, t0, H):
    validate finite array bounds and declared overlay caps
    compile each frequency pattern into chronological overlay connections
    combine resident and overlay stops in one generation-tagged state space
    combine resident and supplemental directed transfer adjacency
    mark excluded resident trips for this generation
    seed origin labels and relax their legal transfers

    merge resident connection buckets and overlay connections by departure:
        stop when departure > t0 + H
        process every equal-departure event without order-sensitive boarding
        activate a run only from a legal, reachable boarding state
        preserve same-run continuation without adding a boarding
        relax legal alighting and directed transfers in the combined domain

    project resident targets and overlay-stop arrivals
```

Resident connections stay resident. Only the finite overlay event list is
compiled per request. Equal-departure bucket semantics, pickup/alighting rules,
same-run continuation, transfer slack, exclusions, and horizon behavior are the
same as the non-overlay CSA operators.

The production adapter may add a zero-second supplemental edge only when a
declared overlay stop names the same GTFS stop identity; the reverse identity
edge is added at the same time. All other resident/overlay and overlay/overlay
edges carry the finite directed OSM travel time. Positive explicit edges carry
their own interchange duration. A zero-second identity edge does not waive
transfer readiness: after a ride it retains the generic 180-second boarding
slack, and equality at `arrival + 180` is boardable. Pre-ride origin transfers
are relaxed before the chronological scan. Consequently, the legal zero-second
boundary does not depend on whether a resident or overlay event happens to be
visited first inside an equal-time bucket.

### Accessibility-owned scenario range and surface

```text
accessibility_range(origin, policy, surface, resident, optional_overlay):
    compute exact directed street access from origin using resident CCH
    project access labels into resident timetable stops

    if overlay exists:
        compute the scalar origin-to-overlay connector row with directed CCH
        compute the scalar overlay stop matrix with directed CCH many-to-many
        build one sparse supplemental transfer CSR over both stop domains
        arrivals = overlay_range(...)
    else:
        arrivals = resident_one_to_many_CSA(...)

    seeds = origin + reached resident stops + reached overlay stops
    raster = directed_OSM_multi_source_surface(seeds, policy, surface)
    return arrivals, raster, and complete diagnostics
```

No Euclidean connector is substituted for a missing OSM path. A one-way path
may create only one transfer direction. The final surface is created inside
this Accessibility operation; an optional preliminary walking preview is a UI
latency feature and is not used as the final result.

The production overlay request has one origin seed, so its connector row is a
scalar shortest-distance problem and uses the same resident CCH as the matrix.
The generic timed-connector contract still accepts multiple seeds with
different arrival times and remaining walk budgets. That genuinely
multi-resource case retains the exact non-dominated-label operator; it is not
representable by one scalar CCH metric.

### Dual-metric Drive CCH with exact constrained fallback

```text
drive(origin_candidates, target_candidates, maximum_distance):
    P_time = best candidate-pair path under the time-customized CCH
    if P_time is unreachable:
        return blocked(no_path)
    if distance(P_time) <= maximum_distance:
        return P_time                       // exact feasibility certificate

    P_distance = best candidate-pair path under the distance-customized CCH
    if P_distance is unreachable or distance(P_distance) > maximum_distance:
        return blocked(no_path)             // exact infeasibility certificate

    return pareto_label_search(
        objective = minimum time,
        resource = total distance <= maximum_distance,
        upper_bound = time(P_time),
        fixed_point_weights = same weights used by both CCH metrics,
    )
```

For each candidate pair, a reusable `PathQuery` operates on one memory-mapped
CCH structure. Time and distance metric bundles are immutable customizations of
that structure. Parallel-edge witnesses are evaluated under the selected
primary metric with the other metric as a deterministic tie break.

Production artifacts are identity-bound to the persisted Drive accelerator.
All three CCH files (structure, time metric, distance metric) must exist or none
may exist. A new set is written through unique temporary files and atomic
renames, then reopened as mmap bundles. A partial set fails closed.

The fallback retains non-dominated `(time, distance)` labels at each node. It is
not a former general Drive kernel: it is entered only after the two CCH probes
prove that the unconstrained time optimum violates the cap while some
distance-feasible path exists.

## Repository-wide query-algorithm census

The active VIGO runtime has no JavaScript, SQLite, regional, or standalone
scenario routing executor. Timetable propagation is CSA; ordinary pedestrian
and Drive shortest-path acceleration is CCH. Three native Rust operators remain
outside those two families by design:

1. the exact multi-resource Accessibility surface/timed-connector label search,
   because labels carry both arrival time and remaining walking distance;
2. the bounded exact pedestrian A-star used for explicit raw/diagnostic queries
   and when a diagnostic fixture has no admitted street CCH; and
3. the exact Drive `(time, distance)` Pareto fallback, entered only after the
   dual CCH certificates prove that the constrained case is unresolved.

These are operators inside the same resident Rust ownership boundary. No second
engine adapter or external routing runtime is part of the product. The
ownership check scans active server source, native heap owners, the packaged
server bundle, and the packaged native binary for removed execution paths.

## Correctness and finite termination

1. CSA processes a finite chronological sequence. Nonnegative ride, transfer,
   and walk durations preserve the earliest-arrival label-setting invariant.
2. Resident and overlay events share stop/run state and directed transfers, so
   crossing between the two domains does not reset time or boarding semantics.
3. Generation tags alter reset cost only. A slot is live exactly when its token
   equals the current query; token wrap performs a finite full clear.
4. Accessibility surface seeds use absolute arrival time and remaining walking
   resource. Dominance requires no-later time and no-less remaining distance,
   preserving later seeds that can still walk farther.
5. The time CCH returns the global scalar time optimum. If that witness satisfies
   the cap, no feasible path can be faster.
6. The distance CCH returns the global scalar distance optimum. If it violates
   the cap, no path can satisfy the cap.
7. Otherwise, Pareto dominance removes only labels no better in either time or
   distance, so the minimum-time feasible retained target label is exact in the
   declared fixed-point domain.
8. All resident arrays, overlay arrays, transfer arrays, candidate sets, and
   raster grids are finite. Overlay compilation has explicit size caps. The
   constrained Drive search has a finite eight-million-label safety cap and
   returns a typed budget result rather than changing algorithms. Every
   operator therefore terminates.

## Complexity

Let `C_b` be resident connections inspected in the horizon, `C_o` compiled
overlay connections, `T` inspected transfer edges, `S` combined stops, `R`
runs, `D` output stops, and `X` excluded trips.

- overlay compilation: `O(C_o log C_o)` time and `O(C_o)` memory;
- merged CSA: `O(C_b + C_o + T + X + D)` time;
- resident timetable workspace: `O(S + R)` plus resident exclusion state, with
  ordinary query reset `O(1)` and a full clear only on generation wrap.

Let `Q` be eligible origin-target Drive candidate pairs, `A_q` the CCH search
space for one pair, `P` its unpacked witness length, `M_c` customized CCH arcs,
and `L/E_L` the labels/edge relaxations reached by the constrained fallback.

- one-time Drive customization: one structure build plus `O(M_c)` work per
  metric, persisted outside measured steady-state queries;
- normal certified Drive query: `O(Q(A_q + P))` for the time metric;
- infeasibility certificate: one additional `O(Q(A_q + P))` distance pass;
- constrained fallback when required: `O((L + E_L) log L)` time and `O(L + S)`
  memory, with `L <= 8,000,000` by contract.

For Accessibility connectors, let `K` be the scenario-stop count and `A_c` the
CCH elimination-tree work for one source row. The production origin row costs
`O(A_c + K)` and the directed matrix costs `O(K(A_c + K))`, with reusable
resident query workspaces. The generic multi-seed fallback costs
`O((L_a + E_a) log L_a)` time and `O(L_a)` labels for the finite retained
non-dominated street frontier.

Complete Accessibility latency additionally includes directed access,
connector construction when present, multi-source OSM raster propagation,
serialization, and worker/API overhead. Native-only, warm-resident, and
complete-response timings must be reported separately.

## Verification gates

- Differentially compare resident and overlay one-to-many arrivals with the
  canonical point semantics, including baseline-scenario-baseline journeys.
- Require the exact ready-time boundary, the one-second-too-early boundary, and
  a missed-tail boundary against a finite temporal reference.
- Test pickup/alighting permissions, same-run continuation, transfer slack,
  exclusions, blocked targets, horizons, generation reuse, and directed
  one-way/barrier connectors.
- Test Drive time certification, distance infeasibility, constrained fallback,
  parallel edges, multiple snap candidates, CCH artifact reload, and partial
  artifact rejection.
- Source checks require the Rust CSA/CCH owners and forbid the former regional,
  standalone scenario, bidirectional Drive-Dijkstra, and JavaScript routing
  executors.
- Runtime diagnostics bind source and store identities and report preparation,
  native search, surface work, and complete response time separately.
