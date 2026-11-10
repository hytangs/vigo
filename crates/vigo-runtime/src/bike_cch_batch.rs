//! Shared rank sweeps for bicycle metrics. Each endpoint is attached once;
//! a fixed endpoint and all of its paired terminals share one elimination
//! space and one scalar minimum proof.
use super::*;

pub(in crate::bike) struct Request<'a> {
    pub kernel: &'a BikeKernel,
    pub options: BikeOptions,
    pub max_walk: f64,
    pub walk_speed: f64,
    pub max_meters: f64,
    pub clock: Option<BikeClock>,
    pub arrive: bool,
    pub max_elapsed: Option<f64>,
}

#[derive(Clone, Copy)]
struct Terminal {
    state: u32,
    attachment: usize,
    cost: f64,
}

struct Endpoint {
    point: [f64; 2],
    candidates: Attachment,
    terminals: Vec<Terminal>,
    private: Vec<u32>,
}

#[derive(Clone, Copy)]
enum Pair {
    Direct {
        start: usize,
        end: usize,
        meters: f64,
    },
    Ranked {
        terminal: usize,
        state: u32,
        rank: u32,
    },
}

pub(in crate::bike) struct Row {
    pub seconds: Vec<f64>,
    pub meters: Vec<f64>,
    pub guards: usize,
    pub access_groups: usize,
    pub access_group_key_bytes: usize,
}

pub(in crate::bike) struct Batch<'a> {
    request: Request<'a>,
    prepared: std::sync::Arc<Prepared>,
    origins: Vec<Endpoint>,
    destinations: Vec<Endpoint>,
}

impl<'a> Batch<'a> {
    pub(in crate::bike) fn new(
        request: Request<'a>,
        origins: &[[f64; 2]],
        destinations: &[[f64; 2]],
    ) -> Result<Self, String> {
        let kernel = request.kernel;
        let (prepared, _) = kernel.hierarchy(request.options)?;
        let moves = &prepared.movements;
        let roads = kernel.graph();
        let eligible = |edge| {
            kernel.allowed_edge(edge, request.options)
                && (request.clock.is_some() || kernel.attributes[edge as usize] & TIMED_EDGE == 0)
        };
        let endpoint = |&point: &[f64; 2], origin: bool| -> Result<Endpoint, String> {
            let candidates = kernel.attach_bicycle_matching(
                &roads,
                point,
                request.max_walk,
                request.walk_speed / 3.6,
                origin,
                false,
                &eligible,
            )?;
            let mut terminals = Vec::with_capacity(candidates.candidates.len());
            let mut private = Vec::new();
            for (attachment, compact) in candidates.candidates.iter().enumerate() {
                let a = candidates.candidate(&roads, attachment);
                let cost =
                    a.walk_seconds + a.drive_meters * kernel.metric(a.edge, request.options).1;
                let add = |state| Terminal {
                    state,
                    attachment,
                    cost,
                };
                if kernel.attributes[a.edge as usize] & (1 << 22) != 0 {
                    private.push(kernel.destination_components[kernel.source(a.edge) as usize]);
                }
                if origin {
                    if a.drive_meters <= 1e-7 {
                        terminals.push(add(a.node));
                    } else {
                        let source = kernel.source(a.edge) as usize;
                        for input in moves.input.first_out[source] as usize
                            ..moves.input.first_out[source + 1] as usize
                        {
                            if moves.roads[input] == a.edge {
                                terminals.push(add(moves.input.head[input]));
                            }
                        }
                    }
                } else {
                    for state in moves.states.variants(compact.node) {
                        let start = moves.input.first_out[state as usize] as usize;
                        let end = moves.input.first_out[state as usize + 1] as usize;
                        if a.drive_meters <= 1e-7 || moves.roads[start..end].contains(&a.edge) {
                            terminals.push(add(state));
                        }
                    }
                }
            }
            private.sort_unstable();
            private.dedup();
            Ok(Endpoint {
                point,
                candidates,
                terminals,
                private,
            })
        };
        let (origins, destinations) = together(
            || {
                origins
                    .iter()
                    .map(|point| endpoint(point, true))
                    .collect::<Result<Vec<_>, _>>()
            },
            || {
                destinations
                    .iter()
                    .map(|point| endpoint(point, false))
                    .collect::<Result<Vec<_>, _>>()
            },
        );
        let (origins, destinations) = (origins?, destinations?);
        Ok(Self {
            request,
            prepared,
            origins,
            destinations,
        })
    }

    pub(in crate::bike) fn row(&self, row: usize) -> Result<Row, String> {
        let Request {
            kernel,
            options,
            clock,
            arrive,
            max_walk,
            walk_speed,
            max_meters,
            max_elapsed,
        } = self.request;
        let moves = &self.prepared.movements;
        let hierarchy = &self.prepared.hierarchy;
        let optimistic = self.prepared.optimistic(kernel, options);
        let graph = kernel.graph();
        let (fixed, varying) = if arrive {
            (&self.destinations[row], &self.origins)
        } else {
            (&self.origins[row], &self.destinations)
        };
        let mut mask = SurfaceMasks::new(1);
        let metric = if arrive {
            scoped::Metric::optimistic_reversed(hierarchy, optimistic, &mask)
        } else {
            scoped::Metric::optimistic(hierarchy, optimistic, &mask)
        };
        let starts: Vec<_> = fixed.terminals.iter().map(|a| (a.state, a.cost)).collect();
        let ends: Vec<_> = varying
            .iter()
            .flat_map(|end| end.terminals.iter().map(|b| b.state))
            .collect();
        let values = metric.solve(&starts, &ends, &mut mask);
        let mut on_edge = HashMap::<
            u32,
            smallvec::SmallVec<[usize; 2]>,
            BuildHasherDefault<crate::IntegerHasher>,
        >::default();
        for (i, a) in fixed.candidates.candidates.iter().enumerate() {
            on_edge.entry(a.edge).or_default().push(i);
        }
        let mut path = Vec::new();
        let mut out = Row {
            seconds: vec![f64::INFINITY; varying.len()],
            meters: vec![f64::INFINITY; varying.len()],
            guards: 0,
            access_groups: 0,
            access_group_key_bytes: 0,
        };
        let mut groups = HashSet::new();
        let timed_deadline = arrive && clock.is_some() && kernel.has_timing();
        for (cell, terminal) in varying.iter().enumerate() {
            let (a, b) = if arrive {
                (terminal, fixed)
            } else {
                (fixed, terminal)
            };
            let mut winner = None;
            let mut price = f64::INFINITY;
            for (i, c) in terminal.candidates.candidates.iter().enumerate() {
                for &j in on_edge.get(&c.edge).into_iter().flatten() {
                    let (start, end) = if arrive { (i, j) } else { (j, i) };
                    let first = a.candidates.candidate(&graph, start);
                    let last = b.candidates.candidate(&graph, end);
                    if first.fraction > last.fraction {
                        continue;
                    }
                    let meters = (last.fraction - first.fraction)
                        * kernel.distances[c.edge as usize] as f64
                        / 100.;
                    let cost = first.walk_seconds
                        + last.walk_seconds
                        + meters * kernel.metric(c.edge, options).1;
                    if cost < price {
                        price = cost;
                        winner = Some(Pair::Direct { start, end, meters });
                    }
                }
            }
            for end in &terminal.terminals {
                let rank = hierarchy.graph.rank[end.state as usize];
                let cost = values.cost(rank, 0, &mask) + end.cost;
                if cost < price {
                    price = cost;
                    winner = Some(Pair::Ranked {
                        terminal: end.attachment,
                        state: end.state,
                        rank,
                    });
                }
            }
            let mut access = terminal.private.clone();
            let verified = if let Some(winner) = winner {
                let (start, end, state, direct) = match winner {
                    Pair::Direct { start, end, meters } => {
                        path.clear();
                        (start, end, None, Some(meters))
                    }
                    Pair::Ranked {
                        terminal,
                        state,
                        rank,
                    } => {
                        let seed = metric.path(rank, 0, &values, &mask, &mut path);
                        let fixed = fixed.terminals[seed];
                        if arrive {
                            path.reverse();
                            (terminal, fixed.attachment, Some(state), None)
                        } else {
                            (fixed.attachment, terminal, Some(fixed.state), None)
                        }
                    }
                };
                let first = a.candidates.candidate(&graph, start);
                let last = b.candidates.candidate(&graph, end);
                let clock = if timed_deadline {
                    let physical = |edge, meters| kernel.metric(edge, options).0 * meters;
                    let seconds = first.walk_seconds
                        + last.walk_seconds
                        + direct.map_or_else(
                            || {
                                physical(first.edge, first.drive_meters)
                                    + physical(last.edge, last.drive_meters)
                                    + path
                                        .iter()
                                        .map(|&input| {
                                            let road = moves.roads[input as usize];
                                            physical(
                                                road,
                                                kernel.distances[road as usize] as f64 / 100.,
                                            )
                                        })
                                        .sum::<f64>()
                            },
                            |meters| physical(first.edge, meters),
                        );
                    clock.map(|clock| BikeClock {
                        epoch: clock.epoch - seconds,
                        ..clock
                    })
                } else {
                    clock
                };
                certify::verify(
                    kernel,
                    moves,
                    options,
                    max_meters,
                    first,
                    last,
                    state,
                    direct,
                    &path,
                    clock,
                    |component| {
                        a.private.binary_search(&component).is_ok()
                            || b.private.binary_search(&component).is_ok()
                    },
                )?
                .filter(|m| !timed_deadline || max_elapsed.is_none_or(|limit| m.seconds <= limit))
            } else {
                None
            };
            if let Some(metrics) = verified {
                out.seconds[cell] = metrics.seconds;
                out.meters[cell] = metrics.meters;
            } else if !a.candidates.candidates.is_empty()
                && !b.candidates.candidates.is_empty()
                && (winner.is_some()
                    || kernel.walking.is_none()
                        && [a, b].into_iter().any(|endpoint| {
                            endpoint
                                .candidates
                                .nearest_meters
                                .is_some_and(|d| max_walk > d + ALTERNATIVE_TOLERANCE_M)
                        }))
            {
                // A scalar witness cannot settle this pair. The point query
                // uses the same prepared hierarchy with its exact guard and
                // endpoint admission rules; geometry is needed only here.
                let route = point::route(
                    kernel,
                    a.point,
                    b.point,
                    options,
                    max_walk,
                    walk_speed,
                    max_meters,
                    clock,
                    arrive,
                    max_elapsed,
                )?;
                out.guards += 1;
                if route.status == "ready" {
                    out.seconds[cell] = route.elapsed_seconds();
                    out.meters[cell] = route.legs.iter().map(|leg| leg.meters).sum();
                }
                if kernel.walking.is_none() && max_walk > 0. {
                    let expanded = kernel.attach_bicycle_full_radius(
                        &graph,
                        terminal.point,
                        max_walk,
                        walk_speed / 3.6,
                        arrive,
                        &|edge| {
                            kernel.allowed_edge(edge, options)
                                && (clock.is_some()
                                    || kernel.attributes[edge as usize] & TIMED_EDGE == 0)
                        },
                    )?;
                    access = expanded
                        .candidates
                        .iter()
                        .filter(|c| kernel.attributes[c.edge as usize] & (1 << 22) != 0)
                        .map(|c| kernel.destination_components[kernel.source(c.edge) as usize])
                        .collect();
                    access.sort_unstable();
                    access.dedup();
                }
            }
            access.retain(|c| fixed.private.binary_search(c).is_err());
            groups.insert(access);
        }
        out.access_groups = groups.len();
        out.access_group_key_bytes = groups
            .iter()
            .map(|components| components.capacity() * 4)
            .sum();
        Ok(out)
    }
}
