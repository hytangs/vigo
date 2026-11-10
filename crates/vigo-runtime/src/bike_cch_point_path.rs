//! Unpack a bicycle hierarchy witness and verify each movement in the
//! original forward turn automaton.
use super::*;

pub(super) struct Replayed {
    pub cost: f64,
    pub elapsed: f64,
    pub legs: Vec<BikeLeg>,
    pub end_wait: f64,
    pub continuation: BikeContinuation,
}

#[derive(Clone, Copy)]
struct Part {
    edge: u32,
    meters: f64,
    from: [f64; 2],
    to: [f64; 2],
    before: Option<u32>,
    after: Option<u32>,
}

pub(super) struct Replay<'a> {
    pub kernel: &'a BikeKernel,
    pub movements: &'a MovementGraph,
    pub options: BikeOptions,
    pub clock: Option<BikeClock>,
    pub arrival: bool,
    pub max_meters: f64,
    pub horizon: f64,
    pub access: &'a HashSet<u32>,
    pub continuation: Option<&'a BikeContinuation>,
}

impl Replay<'_> {
    pub fn path(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        a: RoadCandidate,
        b: RoadCandidate,
        witness: &temporal::PointWitness,
        reverse_seed: bool,
    ) -> Result<Option<Replayed>, String> {
        let graph = self.movements;
        let kernel = self.kernel;
        let mut parts = Vec::with_capacity(witness.steps.len() + 2);
        if let Some(seed) = witness.seed_state {
            let state_before = |input| {
                graph
                    .input
                    .first_out
                    .partition_point(|&offset| offset <= input) as u32
                    - 1
            };
            let first = if reverse_seed {
                witness.steps.first().copied().map_or(seed, state_before)
            } else {
                seed
            };
            let last = if reverse_seed {
                seed
            } else {
                witness
                    .steps
                    .last()
                    .map_or(seed, |&input| graph.input.head[input as usize])
            };
            parts.push(Part {
                edge: a.edge,
                meters: a.drive_meters,
                from: a.road,
                to: kernel.point(a.node),
                before: None,
                after: Some(first),
            });
            for &input in &witness.steps {
                let edge = graph.roads[input as usize];
                parts.push(Part {
                    edge,
                    meters: kernel.distances[edge as usize] as f64 / 100.,
                    from: kernel.point(kernel.source(edge)),
                    to: kernel.point(kernel.targets[edge as usize]),
                    before: Some(state_before(input)),
                    after: Some(graph.input.head[input as usize]),
                });
            }
            parts.push(Part {
                edge: b.edge,
                meters: b.drive_meters,
                from: kernel.point(b.node),
                to: b.road,
                before: Some(last),
                after: None,
            });
        } else {
            parts.push(Part {
                edge: a.edge,
                meters: (b.fraction - a.fraction) * kernel.distances[a.edge as usize] as f64 / 100.,
                from: a.road,
                to: b.road,
                before: None,
                after: None,
            });
        }
        if a.walk_meters + b.walk_meters + parts.iter().map(|part| part.meters).sum::<f64>()
            > self.max_meters
            || parts.iter().any(|p| {
                p.meters > 1e-7
                    && kernel.attributes[p.edge as usize] & (1 << 22) != 0
                    && !self
                        .access
                        .contains(&kernel.destination_components[kernel.source(p.edge) as usize])
            })
        {
            return Ok(None);
        }
        let rate = if matches!(self.options.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let mut waits = vec![0.; parts.len()];
        let mut history = self
            .continuation
            .filter(|c| same_point(c.road, a.road))
            .map_or_else(Vec::new, |c| c.state.clone());
        let mut incoming = self
            .continuation
            .filter(|c| same_point(c.road, a.road))
            .and_then(|c| c.incoming);
        let mut price = a.walk_seconds + b.walk_seconds;
        let lookback = if self.arrival {
            let mut after = b.walk_seconds;
            for p in parts.iter().rev() {
                if p.meters <= 1e-7 {
                    continue;
                }
                let before = p.before.map(|id| graph.states.state(id));
                let incoming = before
                    .as_ref()
                    .and_then(|state| (state.incoming != NONE).then_some(state.incoming));
                let history =
                    &graph.states.turns[before.as_ref().map_or(0, |state| state.turns) as usize];
                let required = p
                    .after
                    .map(|id| &graph.states.turns[graph.states.state(id).turns as usize]);
                let (seconds, _) = kernel.metric(p.edge, self.options);
                let latest = -after - p.meters * seconds;
                let Some(entry) = kernel.latest_arrival_movement(
                    history,
                    incoming,
                    kernel.source(p.edge),
                    p.edge,
                    required,
                    self.clock,
                    latest,
                    -self.horizon + a.walk_seconds,
                )?
                else {
                    return Ok(None);
                };
                after = -entry;
            }
            after + a.walk_seconds
        } else {
            0.
        };
        // The backward sweep fixes the latest legal start. Ride forward from
        // that instant so only necessary waits occur en route. Any remaining
        // slack belongs at the destination, as in the public arrival result.
        let mut at = a.walk_seconds - lookback;
        for (i, p) in parts.iter().enumerate() {
            if p.meters <= 1e-7 {
                continue;
            }
            let moves = if i == 0 && !self.arrival {
                kernel.start_movements(
                    &a,
                    p.meters,
                    self.continuation,
                    self.clock,
                    MovementPolicy::Wait,
                    true,
                )?
            } else {
                kernel.movements(
                    &history,
                    incoming,
                    kernel.source(p.edge),
                    p.edge,
                    self.clock,
                    at,
                    MovementPolicy::Wait,
                    true,
                )?
            };
            let required = p
                .after
                .map(|id| &graph.states.turns[graph.states.state(id).turns as usize]);
            let Some((entry, state)) = moves
                .into_iter()
                .find(|(_, state)| required.is_none_or(|expected| expected == state))
            else {
                return Ok(None);
            };
            let wait = (entry - at).max(0.);
            let (seconds, cost) = kernel.metric(p.edge, self.options);
            price += p.meters * cost + rate * wait;
            waits[i] = wait;
            at = entry + p.meters * seconds;
            history = state;
            incoming = Some(p.edge);
        }
        let arrival = at + b.walk_seconds;
        if self.arrival && arrival > 1e-6 {
            return Ok(None);
        }
        let end_wait = if self.arrival { (-arrival).max(0.) } else { 0. };
        price += rate * end_wait;
        let elapsed = lookback + arrival + end_wait;
        if elapsed > self.horizon {
            return Ok(None);
        }
        let legs = kernel.path_legs(
            origin,
            destination,
            self.options,
            a,
            b,
            parts
                .iter()
                .zip(waits)
                .map(|(p, wait)| (p.edge, p.meters, p.from, p.to, wait))
                .collect(),
        )?;
        Ok(Some(Replayed {
            cost: price,
            elapsed,
            legs,
            end_wait,
            continuation: BikeContinuation {
                incoming,
                state: history,
                road: b.road,
                walk_meters: b.walk_meters,
            },
        }))
    }
}
