//! Reverse sweep over the forward movement states. Validation still runs
//! the actual forward road and turn calendar on the unpacked witness.
use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Replay an exact forward movement path against its deadline."
)]
fn replay_with_wait(
    query: &certify::Query<'_>,
    cell: usize,
    a: RoadCandidate,
    b: RoadCandidate,
    end_state: u32,
    same_edge: Option<f64>,
    path: &[u32],
    horizon: f64,
) -> Result<Option<(f64, f64)>, String> {
    let kernel = query.kernel;
    let moves = query.movements;
    let rate = if matches!(query.options.profile, Profile::Fast) {
        1.
    } else {
        0.8
    };
    let mut elapsed = b.walk_seconds;
    let mut meters = a.walk_meters + b.walk_meters;
    let mut cost = b.walk_seconds;
    let mut add = |edge: u32,
                   length: f64,
                   before: Option<u32>,
                   after: Option<u32>,
                   steady: bool|
     -> Result<bool, String> {
        if length <= 1e-7 {
            return Ok(true);
        }
        meters += length;
        if meters > query.maximum_meters {
            return Ok(false);
        }
        if kernel.attributes[edge as usize] & (1 << 22) != 0 {
            let component = kernel.destination_components[kernel.source(edge) as usize];
            if !query.origin_access.contains(&component)
                && query.ends.permissions[query.ends.groups[cell]]
                    .binary_search(&component)
                    .is_err()
            {
                return Ok(false);
            }
        }
        let (seconds, price) = kernel.metric(edge, query.options);
        let latest = -elapsed - length * seconds;
        let state = before.map(|id| moves.states.state(id));
        let incoming = state
            .as_ref()
            .and_then(|state| (state.incoming != NONE).then_some(state.incoming));
        let history = &moves.states.turns[state.as_ref().map_or(0, |state| state.turns) as usize];
        let required = after.map(|id| &moves.states.turns[moves.states.state(id).turns as usize]);
        let departure = if steady {
            Some(latest)
        } else {
            kernel.latest_arrival_movement(
                history,
                incoming,
                kernel.source(edge),
                edge,
                required,
                query.clock,
                latest,
                -horizon + a.walk_seconds,
            )?
        };
        let Some(departure) = departure else {
            return Ok(false);
        };
        elapsed = -departure;
        cost += length * price + (latest - departure).max(0.) * rate;
        Ok(true)
    };
    if let Some(length) = same_edge {
        if !add(a.edge, length, None, None, false)? {
            return Ok(None);
        }
    } else {
        if !add(b.edge, b.drive_meters, Some(end_state), None, false)? {
            return Ok(None);
        }
        for &input in path.iter().rev() {
            let edge = moves.roads[input as usize];
            let from = moves
                .input
                .first_out
                .partition_point(|&offset| offset <= input) as u32
                - 1;
            let to = moves.input.head[input as usize];
            let length = kernel.distances[edge as usize] as f64 / 100.;
            if !add(
                edge,
                length,
                Some(from),
                Some(to),
                !moves.dynamic[input as usize],
            )? {
                return Ok(None);
            }
        }
        if a.drive_meters > 1e-7 {
            let initial = state_id(
                &moves.states,
                a.node,
                incoming_state(kernel, a.edge),
                &moves.states.turns[0],
            );
            if !add(a.edge, a.drive_meters, None, Some(initial), false)? {
                return Ok(None);
            }
        }
    }
    elapsed += a.walk_seconds;
    cost += a.walk_seconds;
    Ok((elapsed <= horizon && meters <= query.maximum_meters).then_some((elapsed, cost)))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the arrival limits explicit."
)]
pub(in crate::bike::surface) fn measure(
    kernel: &BikeKernel,
    destination: &Attachment,
    origins: &SurfaceEnds,
    destination_access: &HashSet<u32>,
    options: BikeOptions,
    clock: Option<BikeClock>,
    max_distance: f64,
    cutoff: f64,
    max_elapsed: f64,
    maximum_speed_kph: f64,
    endpoint_ms: f64,
    first_pass: bool,
) -> Result<Vec<Option<f64>>, String> {
    let started = Instant::now();
    let (prepared, resident) = kernel.hierarchy(options)?;
    let graph = kernel.graph();
    let movements = &prepared.movements;
    let hierarchy = &prepared.hierarchy;
    let optimistic = prepared.optimistic(kernel, options);
    let mut attachments = Vec::new();
    let mut sources = Vec::new();
    let mut physical_sources = Vec::new();
    for (i, _) in destination.candidates.iter().enumerate() {
        let a = destination.candidate(&graph, i);
        let (seconds, cost) = kernel.metric(a.edge, options);
        for state in destination_states(movements, a) {
            attachments.push(i);
            sources.push((state, a.walk_seconds + a.drive_meters * cost));
            physical_sources.push((state, a.walk_seconds + a.drive_meters * seconds));
        }
    }
    let origin_state = |a: RoadCandidate| {
        if a.drive_meters <= 1e-7 {
            a.node
        } else {
            state_id(
                &movements.states,
                a.node,
                incoming_state(kernel, a.edge),
                &movements.states.turns[0],
            )
        }
    };
    let mut targets = Vec::new();
    for attachment in &origins.attachments {
        targets.extend(
            (0..attachment.candidates.len()).map(|i| origin_state(attachment.candidate(&graph, i))),
        );
    }
    let mut masks = SurfaceMasks::new(1);
    let metric = scoped::Metric::optimistic_reversed(hierarchy, optimistic, &masks);
    let values = metric.solve(&sources, &targets, &mut masks);
    let limit = cutoff.min(max_elapsed);
    let mut minimum_seconds = vec![f64::INFINITY; origins.attachments.len()];
    let mut winners = vec![(f64::INFINITY, 0, NONE, None); origins.attachments.len()];
    for &(cell, end, start) in &origins.direct {
        let a = origins.attachments[cell].candidate(&graph, start);
        let b = destination.candidate(&graph, end);
        if a.fraction > b.fraction {
            continue;
        }
        let meters = (b.fraction - a.fraction) * kernel.distances[a.edge as usize] as f64 / 100.;
        let (seconds, price) = kernel.metric(a.edge, options);
        let cost = a.walk_seconds + b.walk_seconds + meters * price;
        minimum_seconds[cell] =
            minimum_seconds[cell].min(a.walk_seconds + b.walk_seconds + meters * seconds);
        if cost < winners[cell].0 {
            winners[cell] = (cost, start, NONE, Some((end, meters)));
        }
    }
    for (cell, origin) in origins.attachments.iter().enumerate() {
        for (i, _) in origin.candidates.iter().enumerate() {
            let a = origin.candidate(&graph, i);
            let rank = hierarchy.graph.rank[origin_state(a) as usize];
            let (_, price) = kernel.metric(a.edge, options);
            let cost = values.cost(rank, 0, &masks) + a.walk_seconds + a.drive_meters * price;
            if cost < winners[cell].0 {
                winners[cell] = (cost, i, rank, None);
            }
        }
    }
    let verification = certify::Query {
        kernel,
        starts: destination,
        ends: origins,
        origin_access: destination_access,
        movements,
        hierarchy,
        weights: optimistic,
        nodes: &[],
        targets: &targets,
        lower_sources: &[],
        source_attachments: &[],
        clock,
        options,
        maximum_meters: max_distance,
    };
    let mut result = vec![f64::INFINITY; winners.len()];
    let mut path = Vec::new();
    let mut unresolved = 0;
    let mut active = vec![false; winners.len()];
    for (cell, (cost, start, rank, direct)) in winners.into_iter().enumerate() {
        if !cost.is_finite() {
            continue;
        }
        let a = origins.attachments[cell].candidate(&graph, start);
        let (end, initial, same_edge) = if let Some((end, meters)) = direct {
            path.clear();
            (end, None, Some(meters))
        } else {
            let seed = metric.path(rank, 0, &values, &masks, &mut path);
            path.reverse();
            (attachments[seed], Some(origin_state(a)), None)
        };
        let b = destination.candidate(&graph, end);
        let nominal = a.walk_seconds
            + b.walk_seconds
            + if let Some(meters) = same_edge {
                meters * kernel.metric(a.edge, options).0
            } else {
                a.drive_meters * kernel.metric(a.edge, options).0
                    + path
                        .iter()
                        .map(|&input| {
                            let edge = movements.roads[input as usize];
                            kernel.distances[edge as usize] as f64 / 100.
                                * kernel.metric(edge, options).0
                        })
                        .sum::<f64>()
                    + b.drive_meters * kernel.metric(b.edge, options).0
            };
        let departure = clock.map(|clock| BikeClock {
            epoch: clock.epoch - nominal,
            ..clock
        });
        if let Some(seconds) =
            verification.check(cell, a, b, initial, same_edge, &path, departure)?
            && seconds <= max_elapsed
        {
            if seconds <= cutoff {
                result[cell] = seconds;
            }
        } else {
            unresolved += 1;
            active[cell] = true;
        }
    }
    if first_pass {
        // The caller resolves unsettled cells with full endpoint sets.
        return Ok(result
            .into_iter()
            .zip(active)
            .map(|(value, unresolved)| (!unresolved).then_some(value))
            .collect());
    }
    let first_unresolved = unresolved;
    let mut physical = (unresolved > 0).then(|| Workspace::new(hierarchy.graph.node_count()));
    if let Some(physical) = &mut physical {
        // Resolve legal minima first. One physical sweep then bounds both
        // unresolved terminals and entry clocks at all guarded roads.
        hierarchy.bounds(
            &physical_sources,
            physical,
            prepared.physical(kernel, options).directions(true),
            max_elapsed.min(
                limit * prepared.maximum_price_rate
                    / if matches!(options.profile, Profile::Fast) {
                        1.
                    } else {
                        0.8
                    },
            ),
        );
        for (cell, attachment) in origins.attachments.iter().enumerate() {
            if !active[cell] {
                continue;
            }
            for i in 0..attachment.candidates.len() {
                let a = attachment.candidate(&graph, i);
                let rank = hierarchy.graph.rank[origin_state(a) as usize] as usize;
                let seconds = physical.down_cost[rank]
                    + a.walk_seconds
                    + a.drive_meters * kernel.metric(a.edge, options).0;
                minimum_seconds[cell] = minimum_seconds[cell].min(seconds);
            }
            if minimum_seconds[cell] * (1. - 1e-9) > limit {
                active[cell] = false;
                unresolved -= 1;
            }
        }
    }
    if unresolved > 0 {
        let mut physical = physical.unwrap();
        let rate = if matches!(options.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let mut cap = limit * prepared.maximum_price_rate * (1. + 1e-9);
        let mut horizon = max_elapsed.min(cap / rate);
        let mut remaining_sources = Vec::new();
        let mut terminal_states = Vec::new();
        let mut terminal_nodes = Vec::new();
        for (cell, attachment) in origins.attachments.iter().enumerate() {
            if !active[cell] {
                continue;
            }
            for i in 0..attachment.candidates.len() {
                let a = attachment.candidate(&graph, i);
                let state = origin_state(a);
                terminal_states.push(state);
                terminal_nodes.push(a.node);
            }
        }
        terminal_nodes.sort_unstable();
        terminal_nodes.dedup();
        let mut masks = SurfaceMasks::new(origins.permissions.len());
        let mut permission =
            origins.permissions_for(destination_access, 0, origins.permissions.len(), &mut masks);
        let mut groups = vec![0; origins.permissions.len().div_ceil(64)];
        for (cell, &needs_guard) in active.iter().enumerate() {
            if needs_guard {
                let group = origins.groups[cell];
                groups[group / 64] |= 1u64 << (group % 64);
            }
        }
        let active_groups = masks.intern(groups);
        permission.retain(|_, scope| {
            *scope = masks.intersect(*scope, active_groups);
            *scope != 0
        });
        let mut metric = scoped::Metric::reversed(hierarchy, &masks);
        let mut ceilings = vec![cap; active.len()];
        let mut feasible = vec![None; active.len()];
        // Get a cheap valid bound from the prepared public metric before
        // spending work admitting any conditional or private movements.
        let stationary = metric.solve(&sources, &terminal_states, &mut masks);
        for (cell, attachment) in origins.attachments.iter().enumerate() {
            if !active[cell] {
                continue;
            }
            let group = origins.groups[cell];
            let mut best = (cap, NONE, 0);
            for i in 0..attachment.candidates.len() {
                let a = attachment.candidate(&graph, i);
                let rank = hierarchy.graph.rank[origin_state(a) as usize];
                let cost = stationary.cost(rank, group, &masks)
                    + a.walk_seconds
                    + a.drive_meters * kernel.metric(a.edge, options).1;
                if cost < best.0 {
                    best = (cost, rank, i);
                }
            }
            if best.1 == NONE {
                continue;
            }
            let seed = metric.path(best.1, group, &stationary, &masks, &mut path);
            path.reverse();
            let a = attachment.candidate(&graph, best.2);
            let b = destination.candidate(&graph, attachments[seed]);
            if let Some((seconds, cost)) = replay_with_wait(
                &verification,
                cell,
                a,
                b,
                sources[seed].0,
                None,
                &path,
                horizon,
            )? && cost <= ceilings[cell]
            {
                ceilings[cell] = ceilings[cell].min(cost * (1. + 1e-9));
                feasible[cell] = Some((cost, seconds));
            }
        }
        drop(stationary);
        cap = ceilings
            .iter()
            .zip(&active)
            .filter_map(|(&price, &active)| active.then_some(price))
            .fold(0., f64::max);
        horizon = max_elapsed.min(cap / rate);
        for (cell, attachment) in origins.attachments.iter().enumerate() {
            if !active[cell] {
                continue;
            }
            for i in 0..attachment.candidates.len() {
                let a = attachment.candidate(&graph, i);
                remaining_sources.push((
                    origin_state(a),
                    cap - ceilings[cell]
                        + a.walk_seconds
                        + a.drive_meters * kernel.metric(a.edge, options).1,
                ));
            }
        }
        let lower_start: Vec<_> = physical.down_cost.iter().map(|v| v * (1. - 1e-9)).collect();
        hierarchy.bounds(
            &sources,
            &mut physical,
            optimistic.directions(hierarchy, true),
            cap,
        );
        let lower_start_price: Vec<_> =
            physical.down_cost.iter().map(|v| v * (1. - 1e-9)).collect();
        hierarchy.bounds(
            &remaining_sources,
            &mut physical,
            optimistic.directions(hierarchy, false),
            cap,
        );
        let remaining: Vec<_> = physical
            .down_cost
            .iter()
            .map(|v| v / rate * (1. - 1e-9))
            .collect();
        let mut admitted: Vec<_> = movements.dynamic.iter().map(|dynamic| !dynamic).collect();
        let mut additional: Vec<_> = movements
            .private
            .iter()
            .filter_map(|&(component, input)| {
                (!movements.dynamic[input as usize])
                    .then(|| permission.get(&component).map(|&scope| (input, scope)))
                    .flatten()
            })
            .collect();
        let mut gates = Vec::new();
        for (from, road, inputs) in &movements.timed {
            if !kernel.allowed_edge(*road, options) {
                continue;
            }
            let meters = kernel.distances[*road as usize] as f64 / 100.;
            let (seconds, price) = kernel.metric(*road, options);
            let scope = if kernel.attributes[*road as usize] & (1 << 22) != 0 {
                permission
                    .get(&kernel.destination_components[kernel.source(*road) as usize])
                    .copied()
                    .unwrap_or(0)
            } else {
                masks.all
            };
            if scope == 0 {
                continue;
            }
            let from_rank = hierarchy.graph.rank[*from as usize] as usize;
            for index in inputs.clone() {
                let to = movements.input.head[index];
                let to_rank = hierarchy.graph.rank[to as usize] as usize;
                if lower_start_price[to_rank] + meters * price + remaining[from_rank] * rate
                    > cap * (1. + 1e-8)
                {
                    continue;
                }
                let (targets, _, stable) = possible_successors(
                    kernel,
                    &movements.states,
                    *from,
                    *road,
                    clock,
                    -horizon,
                    -lower_start[to_rank] - meters * seconds + 1e-6,
                )?;
                if targets.contains(&to) {
                    additional.push((index as u32, scope));
                    admitted[index] = stable == Some(to);
                    if !admitted[index] {
                        gates.push(temporal::Gate {
                            input: index as u32,
                            from: to,
                            original_from: *from,
                            scope,
                        });
                    }
                }
            }
        }
        let corridor = scoped::Corridor {
            start: &lower_start_price,
            remaining: &remaining,
            cap,
            start_scale: 1.,
            remaining_scale: rate,
        };
        metric.admit(
            kernel,
            movements,
            options,
            additional.iter().copied(),
            &mut masks,
            &corridor,
        );
        let bounds = metric.solve(&sources, &terminal_states, &mut masks);
        for (cell, attachment) in origins.attachments.iter().enumerate() {
            if !active[cell] {
                continue;
            }
            let group = origins.groups[cell];
            let mut best = (f64::INFINITY, 0, NONE, None);
            for &(c, end, start) in &origins.direct {
                if c != cell {
                    continue;
                }
                let a = attachment.candidate(&graph, start);
                let b = destination.candidate(&graph, end);
                if a.fraction > b.fraction {
                    continue;
                }
                let meters =
                    (b.fraction - a.fraction) * kernel.distances[a.edge as usize] as f64 / 100.;
                let cost =
                    a.walk_seconds + b.walk_seconds + meters * kernel.metric(a.edge, options).1;
                if cost < best.0 {
                    best = (cost, start, NONE, Some((end, meters)));
                }
            }
            for start in 0..attachment.candidates.len() {
                let a = attachment.candidate(&graph, start);
                let rank = hierarchy.graph.rank[origin_state(a) as usize];
                let cost = bounds.cost(rank, group, &masks)
                    + a.walk_seconds
                    + a.drive_meters * kernel.metric(a.edge, options).1;
                if cost < best.0 {
                    best = (cost, start, rank, None);
                }
            }
            if !best.0.is_finite() || best.0 > cap {
                active[cell] = false;
                unresolved -= 1;
                continue;
            }
            let a = attachment.candidate(&graph, best.1);
            let (end, initial, end_state, same_edge) = if let Some((end, meters)) = best.3 {
                path.clear();
                (end, None, 0, Some(meters))
            } else {
                let seed = metric.path(best.2, group, &bounds, &masks, &mut path);
                path.reverse();
                (
                    attachments[seed],
                    Some(origin_state(a)),
                    sources[seed].0,
                    None,
                )
            };
            let b = destination.candidate(&graph, end);
            let nominal = a.walk_seconds
                + b.walk_seconds
                + same_edge.map_or_else(
                    || {
                        a.drive_meters * kernel.metric(a.edge, options).0
                            + b.drive_meters * kernel.metric(b.edge, options).0
                            + path
                                .iter()
                                .map(|&input| {
                                    let edge = movements.roads[input as usize];
                                    kernel.distances[edge as usize] as f64 / 100.
                                        * kernel.metric(edge, options).0
                                })
                                .sum::<f64>()
                    },
                    |meters| meters * kernel.metric(a.edge, options).0,
                );
            let departure = clock.map(|clock| BikeClock {
                epoch: clock.epoch - nominal,
                ..clock
            });
            if let Some(seconds) =
                verification.check(cell, a, b, initial, same_edge, &path, departure)?
                && seconds <= max_elapsed
            {
                if seconds <= cutoff {
                    result[cell] = seconds;
                }
                active[cell] = false;
                unresolved -= 1;
            } else if let Some((seconds, cost)) = replay_with_wait(
                &verification,
                cell,
                a,
                b,
                end_state,
                same_edge,
                &path,
                horizon,
            )? && cost <= ceilings[cell]
            {
                ceilings[cell] = ceilings[cell].min(cost * (1. + 1e-9));
                feasible[cell] = Some((cost, seconds));
            }
        }
        if unresolved > 0 {
            // A path that avoids clock changes is a feasible upper bound,
            // often much tighter than a cheaper relaxed path that must
            // wait until a dated road reopens.
            let mut stationary = scoped::Metric::reversed(hierarchy, &masks);
            stationary.admit(
                kernel,
                movements,
                options,
                additional
                    .iter()
                    .copied()
                    .filter(|&(input, _)| admitted[input as usize]),
                &mut masks,
                &corridor,
            );
            let exact_sources: Vec<_> = sources
                .iter()
                .zip(&attachments)
                .map(|(&(id, cost), &index)| {
                    let b = destination.candidate(&graph, index);
                    if b.drive_meters <= 1e-7 {
                        return Ok((id, cost));
                    }
                    let state = movements.states.state(id);
                    let latest =
                        -b.walk_seconds - b.drive_meters * kernel.metric(b.edge, options).0;
                    let entry = kernel.latest_arrival_movement(
                        &movements.states.turns[state.turns as usize],
                        (state.incoming != NONE).then_some(state.incoming),
                        state.node,
                        b.edge,
                        None,
                        clock,
                        latest,
                        -horizon,
                    )?;
                    Ok((
                        id,
                        entry.map_or(f64::INFINITY, |at| cost + (latest - at).max(0.) * rate),
                    ))
                })
                .collect::<Result<_, String>>()?;
            let choices = stationary.solve(&exact_sources, &terminal_states, &mut masks);
            for (cell, attachment) in origins.attachments.iter().enumerate() {
                if !active[cell] {
                    continue;
                }
                let group = origins.groups[cell];
                let mut best = (ceilings[cell], NONE, 0);
                for i in 0..attachment.candidates.len() {
                    let a = attachment.candidate(&graph, i);
                    let rank = hierarchy.graph.rank[origin_state(a) as usize];
                    let cost = choices.cost(rank, group, &masks)
                        + a.walk_seconds
                        + a.drive_meters * kernel.metric(a.edge, options).1;
                    if cost < best.0 {
                        best = (cost, rank, i);
                    }
                }
                if best.1 == NONE {
                    continue;
                }
                let seed = stationary.path(best.1, group, &choices, &masks, &mut path);
                path.reverse();
                let a = attachment.candidate(&graph, best.2);
                let b = destination.candidate(&graph, attachments[seed]);
                if let Some((seconds, cost)) = replay_with_wait(
                    &verification,
                    cell,
                    a,
                    b,
                    sources[seed].0,
                    None,
                    &path,
                    horizon,
                )? && cost < ceilings[cell]
                {
                    ceilings[cell] = ceilings[cell].min(cost * (1. + 1e-9));
                    feasible[cell] = Some((cost, seconds));
                }
            }
            // A replayed path may wait for a dated road to reopen, and a cell
            // whose replays all failed keeps the whole limit as its ceiling.
            // Either widens the horizon and dated gates of every cell. A legal
            // latest departure bounds each cell more tightly, or proves that
            // no departure reaches the destination in time.
            {
                let started = std::time::Instant::now();
                let free: Vec<bool> = movements.dynamic.iter().map(|&dynamic| !dynamic).collect();
                let latest = temporal::Query {
                    kernel,
                    movements,
                    hierarchy,
                    starts: destination,
                    ends: origins,
                    target_nodes: &terminal_nodes,
                    target_states: &terminal_states,
                    options,
                    clock,
                    rate,
                    // Report every legal departure: a price filter could hide one.
                    cap: f64::INFINITY,
                    horizon: limit,
                    distance_limit: max_distance,
                    maximum_speed: maximum_speed_kph.max(45.) / 3.6,
                    permissions: &permission,
                    lower_start: &lower_start,
                    lower_start_price: &lower_start,
                    lower_remaining: &lower_start,
                    steady: &free,
                    reversed: true,
                    continuation: None,
                };
                let mut groups: Vec<_> = (0..active.len())
                    .filter(|&cell| active[cell])
                    .map(|cell| origins.groups[cell])
                    .collect();
                groups.sort_unstable();
                groups.dedup();
                let (mut tightened, mut unreachable) = (0, 0);
                let backwards = latest.reverse_movements();
                for &group in &groups {
                    let latest_departures =
                        latest.earliest(&mut masks, group, false, Some(&backwards))?;
                    let cheapest = latest.earliest(&mut masks, group, true, Some(&backwards))?;
                    for (cell, (&(fast, _), &(cheap, _))) in
                        latest_departures.iter().zip(&cheapest).enumerate()
                    {
                        if !active[cell] || origins.groups[cell] != group {
                            continue;
                        }
                        let cost = fast.min(cheap);
                        if !fast.is_finite() {
                            if !latest.constrained() {
                                active[cell] = false;
                                unresolved -= 1;
                                unreachable += 1;
                            }
                        } else if cost < ceilings[cell] {
                            ceilings[cell] = cost * (1. + 1e-9);
                            tightened += 1;
                        }
                    }
                }
                trace("BIKE_TEMPORAL_HIERARCHY", || {
                    serde_json::json!({
                        "phase":"latest-ceilings","tightenedCells":tightened,
                        "unreachableCells":unreachable,"groups":groups.len(),
                        "latestMs":started.elapsed().as_secs_f64() * 1000.,
                    })
                });
            }
            if unresolved == 0 {
                return Ok(result.into_iter().map(Some).collect());
            }
            let cap = ceilings
                .iter()
                .zip(&active)
                .filter_map(|(&cap, &active)| active.then_some(cap))
                .fold(0., f64::max);
            let horizon = max_elapsed.min(cap / rate);
            remaining_sources.clear();
            for (cell, attachment) in origins.attachments.iter().enumerate() {
                if !active[cell] {
                    continue;
                }
                for i in 0..attachment.candidates.len() {
                    let a = attachment.candidate(&graph, i);
                    remaining_sources.push((
                        origin_state(a),
                        cap - ceilings[cell]
                            + a.walk_seconds
                            + a.drive_meters * kernel.metric(a.edge, options).1,
                    ));
                }
            }
            hierarchy.bounds(
                &remaining_sources,
                &mut physical,
                optimistic.directions(hierarchy, false),
                cap,
            );
            let remaining: Vec<_> = physical
                .down_cost
                .iter()
                .map(|v| v / rate * (1. - 1e-9))
                .collect();
            let mut useful_gates = Vec::new();
            for gate in gates {
                let road = movements.roads[gate.input as usize];
                let length = kernel.distances[road as usize] as f64 / 100.;
                let (seconds, price) = kernel.metric(road, options);
                let from_rank = hierarchy.graph.rank[gate.original_from as usize] as usize;
                let to_rank = hierarchy.graph.rank[gate.from as usize] as usize;
                let entry = -lower_start[to_rank] - length * seconds;
                let (available, _, stable) = possible_successors(
                    kernel,
                    &movements.states,
                    gate.original_from,
                    road,
                    clock,
                    -(cap / rate - remaining[from_rank]).min(horizon),
                    entry + 1e-6,
                )?;
                if !available.contains(&gate.from) {
                    continue;
                }
                if stable == Some(gate.from) {
                    admitted[gate.input as usize] = true;
                    continue;
                }
                let state = movements.states.state(gate.original_from);
                let required = movements.states.state(gate.from).turns;
                let Some(latest) = kernel.latest_arrival_movement(
                    &movements.states.turns[state.turns as usize],
                    (state.incoming != NONE).then_some(state.incoming),
                    state.node,
                    road,
                    Some(&movements.states.turns[required as usize]),
                    clock,
                    entry,
                    -horizon,
                )?
                else {
                    continue;
                };
                let minimum_wait_cost = (-latest - length * seconds) * rate;
                if lower_start_price[to_rank].max(minimum_wait_cost)
                    + price * length
                    + rate * remaining[from_rank]
                    > cap * (1. + 1e-8)
                {
                    continue;
                }
                useful_gates.push(gate);
            }
            let gates = useful_gates;
            trace("BIKE_TEMPORAL_HIERARCHY", || {
                serde_json::json!({
                    "phase":"reverse-gate-proof", "unresolvedCells":unresolved,
                    "feasibleCeilings":feasible.iter().filter(|value| value.is_some()).count(),
                    "remainingGates":gates.len(), "cap":cap, "horizonSeconds":horizon,
                })
            });
            let full_profile =
                horizon < cap / rate || max_distance < horizon * (maximum_speed_kph.max(45.) / 3.6);
            let mut ports = Vec::new();
            if !full_profile {
                for gate in &gates {
                    let road = movements.roads[gate.input as usize];
                    let length = kernel.distances[road as usize] as f64 / 100.;
                    let suffix_rank = hierarchy.graph.rank[gate.original_from as usize] as usize;
                    ports.push((
                        gate.from,
                        length * kernel.metric(road, options).1 + rate * remaining[suffix_rank],
                    ));
                }
                for (cell, attachment) in origins.attachments.iter().enumerate() {
                    if !active[cell] {
                        continue;
                    }
                    for i in 0..attachment.candidates.len() {
                        let a = attachment.candidate(&graph, i);
                        if a.drive_meters > 1e-7
                            && kernel.attributes[a.edge as usize] & TIMED_EDGE != 0
                        {
                            ports.push((
                                origin_state(a),
                                cap - ceilings[cell]
                                    + a.walk_seconds
                                    + a.drive_meters * kernel.metric(a.edge, options).1,
                            ));
                        }
                    }
                }
            }
            let port_bounds = if full_profile {
                None
            } else {
                hierarchy.bounds(
                    &ports,
                    &mut physical,
                    optimistic.directions(hierarchy, false),
                    cap,
                );
                Some(
                    physical
                        .down_cost
                        .iter()
                        .map(|value| value / rate * (1. - 1e-9))
                        .collect::<Vec<_>>(),
                )
            };
            let profile_states: Vec<_> = if full_profile {
                terminal_states
                    .iter()
                    .copied()
                    .chain(gates.iter().map(|gate| gate.from))
                    .collect()
            } else {
                ports.iter().map(|&(state, _)| state).collect()
            };
            let query = temporal::Query {
                kernel,
                movements,
                hierarchy,
                starts: destination,
                ends: origins,
                target_nodes: &terminal_nodes,
                target_states: &profile_states,
                options,
                clock,
                rate,
                cap,
                horizon,
                distance_limit: max_distance,
                maximum_speed: maximum_speed_kph.max(45.) / 3.6,
                permissions: &permission,
                lower_start: &lower_start,
                lower_start_price: &lower_start_price,
                lower_remaining: port_bounds.as_deref().unwrap_or(&remaining),
                steady: &admitted,
                reversed: true,
                continuation: None,
            };
            let (roots, mut endings) = query.run(&gates, &remaining, &mut masks)?;
            if !full_profile {
                // Between gates, time and metres cannot constrain the price
                // optimum. Continue with scalar shortcuts from the actual
                // destination and gate arrivals to ordinary terminals.
                let mut seeds = query.initial(&mut masks)?;
                seeds.extend(roots);
                let sources: Vec<_> = seeds
                    .iter()
                    .map(|&(state, value)| (state, rate * value.elapsed + value.excess))
                    .collect();
                let scopes: Vec<_> = seeds.iter().map(|&(_, value)| value.scope).collect();
                let mut fixed = scoped::Metric::reversed(hierarchy, &masks);
                let private = movements.private.iter().filter_map(|&(component, input)| {
                    if admitted[input as usize] && !movements.dynamic[input as usize] {
                        permission
                            .get(&component)
                            .copied()
                            .map(|scope| (input, scope))
                    } else {
                        None
                    }
                });
                let all = masks.all;
                let dated = movements
                    .timed
                    .iter()
                    .flat_map(|(_, road, inputs)| {
                        let scope = if kernel.attributes[*road as usize] & (1 << 22) != 0 {
                            permission
                                .get(&kernel.destination_components[kernel.source(*road) as usize])
                                .copied()
                                .unwrap_or(0)
                        } else {
                            all
                        };
                        inputs.clone().map(move |input| (input, scope))
                    })
                    .filter(|&(input, scope)| scope != 0 && admitted[input])
                    .map(|(input, scope)| (input as u32, scope));
                let corridor = scoped::Corridor {
                    start: &lower_start_price,
                    remaining: &remaining,
                    cap,
                    start_scale: 1.,
                    remaining_scale: rate,
                };
                fixed.admit(
                    kernel,
                    movements,
                    options,
                    private.chain(dated),
                    &mut masks,
                    &corridor,
                );
                let choices = fixed.solve_scoped(&sources, &scopes, &terminal_states, &mut masks);
                for (cell, attachment) in origins.attachments.iter().enumerate() {
                    if !active[cell] {
                        continue;
                    }
                    let group = origins.groups[cell];
                    let mut best = (endings[cell].0, NONE, 0);
                    for i in 0..attachment.candidates.len() {
                        let a = attachment.candidate(&graph, i);
                        if a.drive_meters > 1e-7
                            && kernel.attributes[a.edge as usize] & TIMED_EDGE != 0
                        {
                            continue;
                        }
                        let rank = hierarchy.graph.rank[origin_state(a) as usize];
                        let cost = choices.cost(rank, group, &masks)
                            + a.walk_seconds
                            + a.drive_meters * kernel.metric(a.edge, options).1;
                        if cost < best.0 {
                            best = (cost, rank, i);
                        }
                    }
                    if best.1 != NONE && best.0 <= ceilings[cell] * (1. + 1e-8) {
                        let source = fixed.path(best.1, group, &choices, &masks, &mut path);
                        let mut elapsed = seeds[source].1.elapsed;
                        for &input in &path {
                            let edge = movements.roads[input as usize];
                            elapsed += kernel.distances[edge as usize] as f64 / 100.
                                * kernel.metric(edge, options).0;
                        }
                        let a = attachment.candidate(&graph, best.2);
                        elapsed +=
                            a.drive_meters * kernel.metric(a.edge, options).0 + a.walk_seconds;
                        endings[cell] = (best.0, elapsed);
                    }
                }
            }
            for (cell, (cost, seconds)) in endings.into_iter().enumerate() {
                if active[cell] {
                    let seconds = feasible[cell]
                        .filter(|&(price, _)| price < cost)
                        .map_or(seconds, |(_, seconds)| seconds);
                    if seconds <= cutoff {
                        result[cell] = seconds;
                    }
                }
            }
        }
    }
    trace("BIKE_HIERARCHY", || {
        serde_json::json!({
            "phase":"build", "preparedBeforeRequest":resident, "hierarchyArcs":hierarchy.graph.cch_arc_count(),
        })
    });
    trace("BIKE_HIERARCHY", || {
        serde_json::json!({
            "phase":"query", "cells":result.len(), "directHierarchyQuery":true,
            "endpointMs":endpoint_ms, "reverseSweepAndProofMs":ms(started),
            "guardedCells":first_unresolved, "gateProfileCells":unresolved,
        })
    });
    Ok(result.into_iter().map(Some).collect())
}

/// Hierarchy states that reach an arrival attachment: the turn states of its
/// node, restricted to those leaving along its last road when it is partial.
pub(super) fn destination_states<'a>(
    movements: &'a MovementGraph,
    a: RoadCandidate,
) -> impl Iterator<Item = u32> + 'a {
    movements.states.variants(a.node).filter(move |&state| {
        a.drive_meters <= 1e-7
            || movements.roads[movements.input.first_out[state as usize] as usize
                ..movements.input.first_out[state as usize + 1] as usize]
                .contains(&a.edge)
    })
}
