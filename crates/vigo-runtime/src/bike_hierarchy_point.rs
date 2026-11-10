//! Point queries use the same prepared movement CCH as the surface, with
//! elimination-tree paths restricted to the two attachment sets.
use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Preserve the point query contract."
)]
pub(in crate::bike) fn route(
    kernel: &BikeKernel,
    origin: [f64; 2],
    destination: [f64; 2],
    options: BikeOptions,
    max_walk: f64,
    walk_speed: f64,
    max_meters: f64,
    clock: Option<BikeClock>,
    arrival: bool,
    max_elapsed: Option<f64>,
) -> Result<BikeResult, String> {
    kernel.validate_request(
        origin,
        destination,
        options,
        max_walk,
        walk_speed,
        max_meters,
        clock,
    )?;
    let timing_policy = if arrival && clock.is_some() && kernel.has_timing() {
        "dated_arrive_by_verified"
    } else if clock.is_none() || !kernel.has_timing() {
        "conservative"
    } else if !kernel.edge_windows.is_empty() {
        "dated_roads_and_turns"
    } else if kernel.timed_way_turns {
        "dated_turns"
    } else {
        "dated_node_turns"
    };
    let roads = kernel.graph();
    let allowed = |edge| {
        kernel.allowed_edge(edge, options)
            && (clock.is_some() || kernel.attributes[edge as usize] & TIMED_EDGE == 0)
    };
    let starts = kernel.attach_bicycle_matching(
        &roads,
        origin,
        max_walk,
        walk_speed / 3.6,
        true,
        false,
        &allowed,
    )?;
    let ends = kernel.attach_bicycle_matching(
        &roads,
        destination,
        max_walk,
        walk_speed / 3.6,
        false,
        false,
        &allowed,
    )?;
    let mut result = BikeResult {
        status: "blocked",
        reason: Some("no_path"),
        legs: vec![],
        cost: None,
        end_wait_seconds: 0.,
        settled_labels: 0,
        origin_road_meters: starts.nearest_meters,
        destination_road_meters: ends.nearest_meters,
        unsupported_restrictions: kernel.unsupported_restrictions,
        timing_policy,
        distance_limit_best_found: false,
        max_lts: options.max_lts,
        temporal_valid: true,
        continuation: None,
    };
    if starts.candidates.is_empty() || ends.candidates.is_empty() {
        result.reason = Some("no_bike_attachment");
        return Ok(result);
    }
    let (prepared, _) = kernel.hierarchy(options)?;
    let movement = &prepared.movements;
    let hierarchy = &prepared.hierarchy;
    let (optimistic, _) = prepared.gate_metrics(kernel, options);
    let mut source_indices = Vec::new();
    let mut sources = Vec::new();
    let mut on_edge =
        HashMap::<u32, Vec<usize>, BuildHasherDefault<crate::IntegerHasher>>::default();
    for (i, _) in starts.candidates.iter().enumerate() {
        let a = starts.candidate(&roads, i);
        on_edge.entry(a.edge).or_default().push(i);
        let cost = a.walk_seconds + a.drive_meters * kernel.metric(a.edge, options).1;
        let mut seed = |state| {
            source_indices.push(i);
            sources.push((state, cost));
        };
        if a.drive_meters <= 1e-7 {
            seed(a.node);
        } else {
            let node = kernel.source(a.edge) as usize;
            for input in
                movement.input.first_out[node] as usize..movement.input.first_out[node + 1] as usize
            {
                if movement.roads[input] == a.edge {
                    seed(movement.input.head[input]);
                }
            }
        }
    }
    let targets: Vec<_> = ends
        .candidates
        .iter()
        .flat_map(|b| movement.states.variants(b.node))
        .collect();
    let mut masks = SurfaceMasks::new(1);
    let metric = scoped::Metric::optimistic(hierarchy, optimistic, &masks);
    let values = metric.solve(&sources, &targets, &mut masks);
    let mut best = f64::INFINITY;
    let mut winner = None;
    for (j, _) in ends.candidates.iter().enumerate() {
        let b = ends.candidate(&roads, j);
        for &i in on_edge.get(&b.edge).into_iter().flatten() {
            let a = starts.candidate(&roads, i);
            if a.fraction <= b.fraction {
                let meters =
                    (b.fraction - a.fraction) * kernel.distances[b.edge as usize] as f64 / 100.;
                let cost =
                    a.walk_seconds + b.walk_seconds + meters * kernel.metric(b.edge, options).1;
                if cost < best {
                    best = cost;
                    winner = Some((j, Some((i, meters)), NONE));
                }
            }
        }
    }
    for (j, _) in ends.candidates.iter().enumerate() {
        let b = ends.candidate(&roads, j);
        let terminal_cost = b.walk_seconds + b.drive_meters * kernel.metric(b.edge, options).1;
        for state in movement.states.variants(b.node) {
            if b.drive_meters > 1e-7
                && !movement.roads[movement.input.first_out[state as usize] as usize
                    ..movement.input.first_out[state as usize + 1] as usize]
                    .contains(&b.edge)
            {
                continue;
            }
            let rank = hierarchy.graph.rank[state as usize];
            let cost = values.cost(rank, 0, &masks) + terminal_cost;
            if cost < best {
                best = cost;
                winner = Some((j, None, rank));
            }
        }
    }
    let Some((end, direct, rank)) = winner else {
        return Ok(result);
    };
    let mut path = Vec::new();
    let (start, expected) = match direct {
        Some((start, _)) => (start, None),
        None => {
            let seed = metric.path(rank, 0, &values, &masks, &mut path);
            (
                source_indices[seed],
                Some(movement.states.state(sources[seed].0).turns),
            )
        }
    };
    let a = starts.candidate(&roads, start);
    let b = ends.candidate(&roads, end);
    let mut parts = Vec::with_capacity(path.len() + 2);
    if let Some((_, meters)) = direct {
        parts.push((a.edge, meters, a.road, b.road, 0.));
    } else {
        parts.push((a.edge, a.drive_meters, a.road, kernel.point(a.node), 0.));
        for &input in &path {
            let edge = movement.roads[input as usize];
            let length = kernel.distances[edge as usize] as f64 / 100.;
            parts.push((
                edge,
                length,
                kernel.point(kernel.source(edge)),
                kernel.point(kernel.targets[edge as usize]),
                0.,
            ));
        }
        parts.push((b.edge, b.drive_meters, kernel.point(b.node), b.road, 0.));
    }
    let duration = a.walk_seconds
        + b.walk_seconds
        + parts
            .iter()
            .map(|&(e, m, _, _, _)| kernel.metric(e, options).0 * m)
            .sum::<f64>();
    let total_meters = a.walk_meters + b.walk_meters + parts.iter().map(|part| part.1).sum::<f64>();
    if total_meters > max_meters || max_elapsed.is_some_and(|maximum| duration > maximum) {
        return Err(
            "The CCH point witness needs distance or time constrained customization".into(),
        );
    }
    let access: HashSet<_> = starts
        .candidates
        .iter()
        .chain(&ends.candidates)
        .filter(|c| kernel.attributes[c.edge as usize] & (1 << 22) != 0)
        .map(|c| kernel.destination_components[kernel.source(c.edge) as usize])
        .collect();
    let replay = clock.map(|clock| BikeClock {
        epoch: clock.epoch - if arrival { duration } else { 0. },
        ..clock
    });
    let mut elapsed = a.walk_seconds;
    let mut history = TurnState::new();
    let mut incoming = None;
    let mut cost = a.walk_seconds;
    for (i, &(edge, meters, _, _, _)) in parts.iter().enumerate() {
        if meters <= 1e-7 && (i == 0 || i + 1 == parts.len()) {
            continue;
        }
        let node = kernel.source(edge);
        if kernel.attributes[edge as usize] & (1 << 22) != 0
            && !access.contains(&kernel.destination_components[node as usize])
        {
            return Err("The CCH point witness needs endpoint access customization".into());
        }
        let actual = replay.map(|c| BikeClock {
            epoch: c.epoch + elapsed,
            ..c
        });
        let Some((_, state)) = kernel
            .movements(
                &history,
                incoming,
                node,
                edge,
                actual,
                0.,
                SearchKind::Frozen,
                false,
            )?
            .first
        else {
            return Err("The CCH point witness needs calendar customization".into());
        };
        let turn = if i == 0 {
            expected
        } else {
            path.get(i - 1).map(|&input| {
                movement
                    .states
                    .state(movement.input.head[input as usize])
                    .turns
            })
        };
        if turn.is_some_and(|turn| movement.states.turns[turn as usize] != state) {
            return Err("The CCH point witness needs turn-state customization".into());
        }
        let (seconds, price) = kernel.metric(edge, options);
        elapsed += meters * seconds;
        cost += meters * price;
        incoming = Some(edge);
        history = state;
    }
    result.legs = kernel.path_legs(origin, destination, options, a, b, parts)?;
    result.status = "ready";
    result.reason = None;
    result.cost = Some(cost + b.walk_seconds);
    Ok(result)
}
