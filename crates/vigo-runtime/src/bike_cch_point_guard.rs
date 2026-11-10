//! Exact constrained point query on the same movement hierarchy as Reach.
use super::*;

pub(super) struct Point<'a> {
    pub kernel: &'a BikeKernel,
    pub prepared: &'a Prepared,
    pub start: &'a Attachment,
    pub end: &'a Attachment,
    pub origin: [f64; 2],
    pub destination: [f64; 2],
    pub options: BikeOptions,
    pub clock: Option<BikeClock>,
    pub reversed: bool,
    pub meters: f64,
    pub max_elapsed: Option<f64>,
    pub walk_speed: f64,
    pub continuation: Option<&'a BikeContinuation>,
}

struct Terminals {
    sources: Vec<(usize, u32, f64)>, // attachment, forward state, earliest wait
    ends: Vec<(usize, u32)>,
    direct: Vec<(usize, usize)>,
}
impl Point<'_> {
    fn terminals(&self, allowed: &[bool]) -> Result<Terminals, String> {
        let k = self.kernel;
        let moves = &self.prepared.movements;
        let g = k.graph();
        let mut sources = Vec::new();
        let mut direct = Vec::new();
        let mut ends = Vec::new();
        let mut edge_starts =
            HashMap::<u32, Vec<usize>, BuildHasherDefault<crate::IntegerHasher>>::default();
        for i in 0..self.start.candidates.len() {
            let a = self.start.candidate(&g, i);
            edge_starts.entry(a.edge).or_default().push(i);
            if !self.reversed {
                for (entry, history) in k
                    .start_movements(
                        &a,
                        a.drive_meters,
                        self.continuation,
                        self.clock,
                        MovementPolicy::Wait,
                        true,
                    )?
                    .into_iter()
                {
                    let incoming = if a.drive_meters > 1e-7 {
                        incoming_state(k, a.edge)
                    } else {
                        self.continuation
                            .filter(|c| same_point(a.road, c.road))
                            .and_then(|c| c.incoming)
                            .map_or(NONE, |edge| incoming_state(k, edge))
                    };
                    sources.push((
                        i,
                        state_id(&moves.states, a.node, incoming, &history),
                        (entry - a.walk_seconds).max(0.),
                    ));
                }
            } else if a.drive_meters <= 1e-7 {
                sources.push((i, a.node, 0.));
            } else {
                let from = k.source(a.edge) as usize;
                let range =
                    moves.input.first_out[from] as usize..moves.input.first_out[from + 1] as usize;
                for ((&road, &state), &admitted) in moves.roads[range.clone()]
                    .iter()
                    .zip(&moves.input.head[range.clone()])
                    .zip(&allowed[range])
                {
                    if road == a.edge && admitted {
                        sources.push((i, state, 0.));
                    }
                }
            }
        }
        for j in 0..self.end.candidates.len() {
            let b = self.end.candidate(&g, j);
            for &i in edge_starts.get(&b.edge).into_iter().flatten() {
                let a = self.start.candidate(&g, i);
                if a.fraction <= b.fraction
                    && (self.reversed
                        || k.start_movements(
                            &a,
                            (b.fraction - a.fraction) * k.distances[b.edge as usize] as f64 / 100.,
                            self.continuation,
                            self.clock,
                            MovementPolicy::Wait,
                            false,
                        )?
                        .first
                        .is_some())
                {
                    direct.push((i, j));
                }
            }
            for state in moves.states.variants(b.node) {
                let start = moves.input.first_out[state as usize] as usize;
                let end = moves.input.first_out[state as usize + 1] as usize;
                if b.drive_meters <= 1e-7
                    || (start..end).any(|index| allowed[index] && moves.roads[index] == b.edge)
                {
                    ends.push((j, state));
                }
            }
        }
        Ok(Terminals {
            sources,
            ends,
            direct,
        })
    }

    fn minimum(
        &self,
        metric: &scoped::Metric<'_>,
        ends: &Terminals,
        masks: &mut SurfaceMasks,
        by_meters: bool,
        rate: f64,
    ) -> Option<temporal::PointWitness> {
        let k = self.kernel;
        let g = k.graph();
        let h = &self.prepared.hierarchy;
        let length = |edge: u32| k.distances[edge as usize] as f64 / 100.;
        let price = |edge: u32| {
            if by_meters {
                1.
            } else {
                k.metric(edge, self.options).1
            }
        };
        let walk = |a: RoadCandidate| {
            if by_meters {
                a.walk_meters
            } else {
                a.walk_seconds
            }
        };
        let sources: Vec<_> = ends
            .sources
            .iter()
            .map(|&(i, state, wait)| {
                let a = self.start.candidate(&g, i);
                (
                    state,
                    walk(a)
                        + a.drive_meters * price(a.edge)
                        + if by_meters { 0. } else { wait * rate },
                )
            })
            .collect();
        let targets: Vec<_> = ends.ends.iter().map(|&(_, state)| state).collect();
        let values = metric.solve(&sources, &targets, masks);
        let mut best: Option<(f64, usize, u32, Option<usize>)> = None;
        let mut ceiling = f64::INFINITY;
        for &(i, j) in &ends.direct {
            let a = self.start.candidate(&g, i);
            let b = self.end.candidate(&g, j);
            let cost =
                walk(a) + walk(b) + (b.fraction - a.fraction) * length(b.edge) * price(b.edge);
            if cost < ceiling {
                ceiling = cost;
                best = Some((cost, j, NONE, Some(i)));
            }
        }
        for &(j, state) in &ends.ends {
            let b = self.end.candidate(&g, j);
            let rank = h.graph.rank[state as usize];
            let cost = values.cost(rank, 0, masks) + walk(b) + b.drive_meters * price(b.edge);
            if cost < ceiling {
                ceiling = cost;
                best = Some((cost, j, rank, None));
            }
        }
        let (cost, destination, rank, direct) = best?;
        let mut steps = Vec::new();
        let (origin, seed_state) = if let Some(i) = direct {
            (i, None)
        } else {
            let seed = metric.path(rank, 0, &values, masks, &mut steps);
            (ends.sources[seed].0, Some(ends.sources[seed].1))
        };
        Some(temporal::PointWitness {
            cost,
            elapsed: 0.,
            origin,
            destination,
            seed_state,
            steps,
        })
    }

    pub fn solve(&self) -> Result<Option<point_path::Replayed>, String> {
        let k = self.kernel;
        let moves = &self.prepared.movements;
        let h = &self.prepared.hierarchy;
        let g = k.graph();
        let opt = self.options;
        let rate = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let access: HashSet<_> = self
            .start
            .candidates
            .iter()
            .chain(&self.end.candidates)
            .filter(|a| k.attributes[a.edge as usize] & (1 << 22) != 0)
            .map(|a| k.destination_components[k.source(a.edge) as usize])
            .collect();
        let mut masks = SurfaceMasks::new(1);
        let permission: HashMap<_, _> = access
            .iter()
            .map(|&component| (component, masks.all))
            .collect();
        let permits = |road| {
            k.allowed_edge(road, opt)
                && (k.attributes[road as usize] & (1 << 22) == 0
                    || access.contains(&k.destination_components[k.source(road) as usize]))
        };
        let mut allowed: Vec<_> = moves
            .roads
            .iter()
            .zip(&moves.dynamic)
            .map(|(&road, &dynamic)| !dynamic && permits(road))
            .collect();
        let reference = self
            .clock
            .map(|_| BikeClock::service("2026-01-05", "UTC", 0.))
            .transpose()?;
        let mut guarded = Vec::new();
        for &(component, input) in &moves.private {
            if access.contains(&component) && allowed[input as usize] {
                guarded.push((input, masks.all));
            }
        }
        for (from, road, range) in &moves.timed {
            if !permits(*road) {
                continue;
            }
            let (states, _, _) =
                possible_successors(k, &moves.states, *from, *road, reference, 0., 604799.)?;
            for i in range.clone() {
                if states.contains(&moves.input.head[i]) {
                    allowed[i] = true;
                    guarded.push((i as u32, masks.all));
                }
            }
        }
        let terminals = self.terminals(&allowed)?;
        let hard_time = self.max_elapsed.unwrap_or(f64::MAX / 4.);
        let replay = point_path::Replay {
            kernel: k,
            movements: moves,
            options: opt,
            clock: self.clock,
            arrival: self.reversed,
            max_meters: self.meters,
            horizon: hard_time,
            access: &access,
            continuation: self.continuation,
        };
        let materialize = |witness: &temporal::PointWitness, reverse_seed| {
            let a = self.start.candidate(&g, witness.origin);
            let b = self.end.candidate(&g, witness.destination);
            replay.path(self.origin, self.destination, a, b, witness, reverse_seed)
        };
        let zeros = vec![0.; h.graph.node_count()];
        let unconstrained = scoped::Corridor {
            start: &zeros,
            remaining: &zeros,
            cap: f64::INFINITY,
            start_scale: 1.,
            remaining_scale: 1.,
        };
        let mut metric = scoped::Metric::new(h, &masks);
        metric.admit(
            k,
            moves,
            opt,
            guarded.iter().copied(),
            &mut masks,
            &unconstrained,
        );
        let Some(cheap) = self.minimum(&metric, &terminals, &mut masks, false, rate) else {
            return Ok(None);
        };
        if self.max_elapsed.is_some_and(|limit| {
            cheap.cost > limit * self.prepared.maximum_price_rate * (1. + 1e-9)
        }) {
            return Ok(None);
        }
        let mut feasible = materialize(&cheap, false)?;
        if feasible
            .as_ref()
            .is_some_and(|r| r.cost <= cheap.cost * (1. + 1e-10) + 1e-8)
        {
            return Ok(feasible);
        }
        if feasible.is_none() && self.max_elapsed.is_none() {
            let lengths = Weights::distance(k, moves, &h.graph, opt);
            let mut metric = scoped::Metric::weighted(h, &lengths, &masks);
            metric.admit_weighted(
                k,
                moves,
                opt,
                guarded.iter().copied(),
                &mut masks,
                &unconstrained,
                |road| k.distances[road as usize] as f64 / 100.,
            );
            let Some(shortest) = self.minimum(&metric, &terminals, &mut masks, true, rate) else {
                return Ok(None);
            };
            if shortest.cost > self.meters * (1. + 1e-12) {
                return Ok(None);
            }
            feasible = materialize(&shortest, false)?;
            if feasible.is_none() {
                return Err("Could not verify a finite bicycle hierarchy bound".into());
            }
        }
        drop(metric);
        let cap = feasible
            .as_ref()
            .map_or(hard_time * self.prepared.maximum_price_rate, |r| r.cost)
            * (1. + 1e-8);
        let horizon = (cap / rate).min(hard_time);
        let (fixed, variable) = if self.reversed {
            (self.end, self.start)
        } else {
            (self.start, self.end)
        };
        let mut ends = SurfaceEnds {
            attachments: vec![Attachment::from_candidates(
                variable.candidates.clone(),
                self.walk_speed / 3.6,
                self.reversed,
            )],
            #[cfg(any(feature = "standalone", test))]
            permissions: vec![vec![]],
            groups: vec![0],
            offsets: vec![0; k.lons.len() + 1],
            entries: Vec::new(),
            direct: terminals
                .direct
                .iter()
                .map(|&(a, b)| if self.reversed { (0, b, a) } else { (0, a, b) })
                .collect(),
        };
        let mut indices: Vec<_> = (0..variable.candidates.len()).collect();
        indices.sort_by_key(|&i| variable.candidates[i].node);
        let mut nodes = Vec::new();
        for i in indices {
            let node = variable.candidates[i].node;
            if nodes.last().copied() != Some(node) {
                nodes.push(node);
            }
            ends.offsets[node as usize + 1] += 1;
            ends.entries.push(SurfaceTerminal::new(
                0,
                i,
                &ends.attachments[0],
                self.reversed,
            ));
        }
        for i in 1..ends.offsets.len() {
            ends.offsets[i] += ends.offsets[i - 1];
        }
        let mut forward_time = Vec::new();
        let mut forward_price = Vec::new();
        let mut backward_time = Vec::new();
        let mut backward_price = Vec::new();
        for &(i, state, wait) in &terminals.sources {
            let a = self.start.candidate(&g, i);
            let (seconds, price) = k.metric(a.edge, opt);
            forward_time.push((state, a.walk_seconds + a.drive_meters * seconds + wait));
            forward_price.push((state, a.walk_seconds + a.drive_meters * price + rate * wait));
        }
        for &(i, state) in &terminals.ends {
            let b = self.end.candidate(&g, i);
            let (seconds, price) = k.metric(b.edge, opt);
            backward_time.push((state, b.walk_seconds + b.drive_meters * seconds));
            backward_price.push((state, b.walk_seconds + b.drive_meters * price));
        }
        let (time, price, remaining) = if self.reversed {
            (&backward_time, &backward_price, &forward_price)
        } else {
            (&forward_time, &forward_price, &backward_price)
        };
        let physical = self.prepared.physical(k, opt);
        let preferred = self.prepared.optimistic(k, opt);
        let mut work = Workspace::new(h.graph.node_count());
        h.solve(time, None, &mut work, physical.directions(self.reversed));
        let lower_start: Vec<_> = work
            .down_cost
            .iter()
            .map(|cost| cost * (1. - 1e-9))
            .collect();
        h.solve(
            price,
            None,
            &mut work,
            preferred.directions(h, self.reversed),
        );
        let lower_start_price: Vec<_> = work
            .down_cost
            .iter()
            .map(|cost| cost * (1. - 1e-9))
            .collect();
        h.solve(
            remaining,
            None,
            &mut work,
            preferred.directions(h, !self.reversed),
        );
        let lower_remaining: Vec<_> = work
            .down_cost
            .iter()
            .map(|cost| cost / rate * (1. - 1e-9))
            .collect();
        let mut states: Vec<_> = remaining.iter().map(|&(state, _)| state).collect();
        let mut steady: Vec<_> = moves.dynamic.iter().map(|&dynamic| !dynamic).collect();
        let mut gates = Vec::new();
        for (from, road, range) in &moves.timed {
            let meters = k.distances[*road as usize] as f64 / 100.;
            let (seconds, price) = k.metric(*road, opt);
            for i in range.clone() {
                if !allowed[i] {
                    continue;
                }
                let target = moves.input.head[i];
                let (u, v) = if self.reversed {
                    (target, *from)
                } else {
                    (*from, target)
                };
                let earliest = lower_start[h.graph.rank[u as usize] as usize];
                let finish = lower_remaining[h.graph.rank[v as usize] as usize];
                let latest = (cap / rate - price * meters / rate - finish)
                    .min(horizon - seconds * meters)
                    + 1e-6;
                let (low, high) = if self.reversed {
                    (-latest - meters * seconds, -earliest - meters * seconds)
                } else {
                    (earliest, latest)
                };
                let (possible, _, fixed) =
                    possible_successors(k, &moves.states, *from, *road, self.clock, low, high)?;
                if fixed == Some(target) {
                    steady[i] = true;
                } else if possible.contains(&target) {
                    states.push(u);
                    gates.push(temporal::Gate {
                        input: i as u32,
                        from: u,
                        original_from: *from,
                        scope: masks.all,
                    });
                }
            }
        }
        let query = temporal::Query {
            kernel: k,
            movements: moves,
            hierarchy: h,
            starts: fixed,
            ends: &ends,
            target_nodes: &nodes,
            target_states: &states,
            options: opt,
            clock: self.clock,
            rate,
            cap,
            horizon,
            distance_limit: self.meters,
            maximum_speed: self.walk_speed.max(45.) / 3.6,
            permissions: &permission,
            lower_start: &lower_start,
            lower_start_price: &lower_start_price,
            lower_remaining: &lower_remaining,
            steady: &steady,
            reversed: self.reversed,
            continuation: self.continuation,
        };
        if let Some(witness) = query.point(&gates, &lower_remaining, &mut masks)? {
            let result = materialize(&witness, self.reversed)?
                .ok_or("Bicycle hierarchy point witness could not be verified")?;
            if (result.elapsed - witness.elapsed).abs() > 1e-5 {
                return Err(
                    "Bicycle hierarchy point clocks disagree with the unpacked path".into(),
                );
            }
            if feasible
                .as_ref()
                .is_none_or(|other| result.cost < other.cost)
            {
                feasible = Some(result);
            }
        }
        Ok(feasible)
    }
}
