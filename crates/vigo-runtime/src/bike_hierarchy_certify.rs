//! Validate the minimum on the optimistic contraction metric. A fully
//! legal witness establishes optimality; remaining terminals need the
//! guarded shortcuts of the same hierarchy.
use super::*;

pub(super) struct Query<'a> {
    pub kernel: &'a BikeKernel,
    pub starts: &'a Attachment,
    pub ends: &'a SurfaceEnds,
    pub origin_access: &'a HashSet<u32>,
    pub movements: &'a MovementGraph,
    pub hierarchy: &'a Hierarchy,
    pub weights: &'a Weights,
    pub nodes: &'a [u32],
    pub targets: &'a [u32],
    pub lower_sources: &'a [(u32, f64)],
    pub source_attachments: &'a [usize],
    pub clock: Option<BikeClock>,
    pub options: BikeOptions,
    pub maximum_meters: f64,
}

#[derive(Clone, Copy)]
pub(super) struct Metrics {
    pub seconds: f64,
    pub meters: f64,
}

#[derive(Clone, Copy)]
pub(super) enum Proof {
    Exact(Metrics),
    Unreachable,
    NeedsGuards,
}

impl Query<'_> {
    pub fn certify(&self, possible: &[bool], cutoff: f64) -> Result<Vec<Option<f64>>, String> {
        self.prove(possible).map(|proofs| {
            proofs
                .into_iter()
                .map(|proof| match proof {
                    Proof::Exact(m) if m.seconds <= cutoff => Some(m.seconds),
                    Proof::Exact(_) | Proof::Unreachable => Some(f64::INFINITY),
                    Proof::NeedsGuards => None,
                })
                .collect()
        })
    }

    pub(super) fn prove(&self, possible: &[bool]) -> Result<Vec<Proof>, String> {
        let mut unrestricted = SurfaceMasks::new(1);
        let metric = scoped::Metric::optimistic(self.hierarchy, self.weights, &unrestricted);
        let values = metric.solve(self.lower_sources, self.targets, &mut unrestricted);
        let admitted = vec![true; self.movements.input.head.len()];
        let mut winners = reduce_terminals(
            self.kernel,
            self.ends,
            self.options,
            self.movements,
            self.hierarchy,
            self.nodes,
            &admitted,
            &values,
            &unrestricted,
            Some(0),
        );
        let graph = self.kernel.graph();
        let mut direct = vec![None; possible.len()];
        for &(cell, a_index, b_index) in &self.ends.direct {
            if !possible[cell] {
                continue;
            }
            let a = self.starts.candidate(&graph, a_index);
            let b = self.ends.attachments[cell].candidate(&graph, b_index);
            if a.fraction <= b.fraction {
                let length = self.kernel.distances[a.edge as usize] as f64 / 100.;
                let meters = (b.fraction - a.fraction) * length;
                let cost = a.walk_seconds
                    + b.walk_seconds
                    + meters * self.kernel.metric(a.edge, self.options).1;
                if cost <= winners[cell].0 && (cost < winners[cell].0 || direct[cell].is_none()) {
                    winners[cell] = (cost, NONE, b_index);
                    direct[cell] = Some((a_index, meters));
                }
            }
        }
        let mut result = vec![Proof::NeedsGuards; possible.len()];
        let mut path = Vec::new();
        for (cell, (price, rank, b_index)) in winners.into_iter().enumerate() {
            if !possible[cell] || !price.is_finite() {
                result[cell] = Proof::Unreachable;
                continue;
            }
            let b = self.ends.attachments[cell].candidate(&graph, b_index);
            let (a_index, state, same_edge) = if let Some((a, length)) = direct[cell] {
                path.clear();
                (a, None, Some(length))
            } else {
                let seed = metric.path(rank, 0, &values, &unrestricted, &mut path);
                (
                    self.source_attachments[seed],
                    Some(self.lower_sources[seed].0),
                    None,
                )
            };
            let a = self.starts.candidate(&graph, a_index);
            if let Some(metrics) = self.metrics(cell, a, b, state, same_edge, &path, self.clock)? {
                result[cell] = Proof::Exact(metrics);
            }
        }
        Ok(result)
    }

    pub(super) fn check(
        &self,
        cell: usize,
        a: RoadCandidate,
        b: RoadCandidate,
        seed: Option<u32>,
        direct: Option<f64>,
        path: &[u32],
        clock: Option<BikeClock>,
    ) -> Result<Option<f64>, String> {
        self.metrics(cell, a, b, seed, direct, path, clock)
            .map(|value| value.map(|metrics| metrics.seconds))
    }

    pub(super) fn metrics(
        &self,
        cell: usize,
        a: RoadCandidate,
        b: RoadCandidate,
        seed: Option<u32>,
        direct: Option<f64>,
        path: &[u32],
        clock: Option<BikeClock>,
    ) -> Result<Option<Metrics>, String> {
        let access = &self.ends.permissions[self.ends.groups[cell]];
        verify(
            self.kernel,
            self.movements,
            self.options,
            self.maximum_meters,
            a,
            b,
            seed,
            direct,
            path,
            clock,
            |component| {
                self.origin_access.contains(&component) || access.binary_search(&component).is_ok()
            },
        )
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The certificate verifies a complete path and its limits."
)]
pub(super) fn verify(
    kernel: &BikeKernel,
    movements: &MovementGraph,
    options: BikeOptions,
    maximum_meters: f64,
    a: RoadCandidate,
    b: RoadCandidate,
    seed: Option<u32>,
    direct: Option<f64>,
    path: &[u32],
    clock: Option<BikeClock>,
    permits: impl Fn(u32) -> bool,
) -> Result<Option<Metrics>, String> {
    let mut elapsed = a.walk_seconds;
    let mut meters = a.walk_meters + b.walk_meters;
    let mut incoming = None;
    let mut history = TurnState::new();
    let first = direct.unwrap_or(a.drive_meters);
    let start = std::iter::once((a.edge, first, seed, None));
    let middle = path.iter().map(|&input| {
        let edge = movements.roads[input as usize];
        (
            edge,
            kernel.distances[edge as usize] as f64 / 100.,
            Some(movements.input.head[input as usize]),
            Some(input),
        )
    });
    let end = direct
        .is_none()
        .then_some((b.edge, b.drive_meters, None, None));
    for (edge, length, next, input) in start.chain(middle).chain(end) {
        if length <= 1e-7 && input.is_none() {
            continue;
        }
        if kernel.attributes[edge as usize] & (1 << 22) != 0 {
            let component = kernel.destination_components[kernel.source(edge) as usize];
            if !permits(component) {
                return Ok(None);
            }
        }
        let expected = next.map(|id| movements.states.state(id).turns);
        if input.is_some_and(|i| !movements.dynamic[i as usize]) {
            history.clone_from(&movements.states.turns[expected.unwrap() as usize]);
        } else {
            let entered = clock.map(|clock| BikeClock {
                epoch: clock.epoch + elapsed,
                ..clock
            });
            let Some((_, turns)) = kernel
                .movements(
                    &history,
                    incoming,
                    kernel.source(edge),
                    edge,
                    entered,
                    0.,
                    SearchKind::Frozen,
                    false,
                )?
                .first
            else {
                return Ok(None);
            };
            if expected.is_some_and(|turn| movements.states.turns[turn as usize] != turns) {
                return Ok(None);
            }
            history = turns;
        }
        incoming = Some(edge);
        meters += length;
        elapsed += length * kernel.metric(edge, options).0;
    }
    Ok((meters <= maximum_meters).then_some(Metrics {
        seconds: elapsed + b.walk_seconds,
        meters,
    }))
}
