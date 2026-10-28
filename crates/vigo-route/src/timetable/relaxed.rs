//! A transfer graph that bounds the stateful transfer-rule search from below.
//!
//! Transfer rules and the request buffer only ever remove transfers, except
//! that a rule may also permit a transfer: a timed or recommended transfer, a
//! shorter published minimum, or an edge with no ordinary walking path. This
//! graph keeps every ordinary edge and adds every permitting rule as an
//! unscoped edge at its smallest minimum. A scan over it without rule state or
//! buffer reaches every stop no later than the stateful search does, so it
//! can prove a request has no journey, or bound the stateful search's window.
use super::*;
use std::sync::Arc;

pub(super) struct RelaxedGraph {
    /// Identity of the rule set the graph was built from.
    rules: usize,
    transfer_offset: Vec<u32>,
    transfer_edges: Vec<TransferEdge>,
    reverse_transfer_offset: Vec<u32>,
    reverse_transfer_edges: Vec<TransferEdge>,
    same_stop_transfer_minimum: Vec<u32>,
    forbidden_same_stop: U8Buffer,
}

fn compressed(stops: usize, edges: &[(u32, u32, u32)]) -> (Vec<u32>, Vec<TransferEdge>) {
    let mut offset = vec![0u32; stops + 1];
    for &(from, _, _) in edges {
        offset[from as usize + 1] += 1;
    }
    for i in 0..stops {
        offset[i + 1] += offset[i];
    }
    let mut cursor = offset.clone();
    let mut out = vec![TransferEdge::new(0, 0); edges.len()];
    for &(from, to, duration) in edges {
        out[cursor[from as usize] as usize] = TransferEdge::new(to, duration);
        cursor[from as usize] += 1;
    }
    (offset, out)
}

impl TimetableKernel {
    fn build_relaxed_graph(&self, data: &service::ServiceSemantics, rules: usize) -> RelaxedGraph {
        let stops = self.stop_count;
        let mut minimum: HashMap<(u32, u32), u32> = HashMap::new();
        for from in 0..stops {
            let edges = &self.transfer_edges
                [self.transfer_offset[from] as usize..self.transfer_offset[from + 1] as usize];
            for edge in edges {
                let slot = minimum
                    .entry((from as u32, edge.stop() as u32))
                    .or_insert(u32::MAX);
                *slot = (*slot).min(edge.duration());
            }
        }
        let mut same_stop = self.same_stop_transfer_minimum.clone();
        let mut forbidden: Vec<u8> = self.forbidden_same_stop.as_ref().to_vec();
        for rule in data.rules.iter().filter(|r| r.kind != 3) {
            let least = if rule.kind == 2 { rule.minimum } else { 0 };
            if rule.from_stop == rule.to_stop {
                let s = rule.from_stop as usize;
                same_stop[s] = same_stop[s].min(least);
                forbidden[s] = 0;
            } else {
                let slot = minimum
                    .entry((rule.from_stop, rule.to_stop))
                    .or_insert(u32::MAX);
                *slot = (*slot).min(least);
            }
        }
        let mut forward: Vec<(u32, u32, u32)> =
            minimum.iter().map(|(&(a, b), &d)| (a, b, d)).collect();
        forward.sort_unstable();
        let mut reverse: Vec<(u32, u32, u32)> =
            forward.iter().map(|&(a, b, d)| (b, a, d)).collect();
        reverse.sort_unstable();
        let (transfer_offset, transfer_edges) = compressed(stops, &forward);
        let (reverse_transfer_offset, reverse_transfer_edges) = compressed(stops, &reverse);
        RelaxedGraph {
            rules,
            transfer_offset,
            transfer_edges,
            reverse_transfer_offset,
            reverse_transfer_edges,
            same_stop_transfer_minimum: same_stop,
            forbidden_same_stop: forbidden.into(),
        }
    }

    /// Runs `search` over the relaxed graph, without rule state or buffer.
    /// `None` when frequency windows need the stateful search.
    pub(super) fn relaxed<T>(
        &mut self,
        search: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<Option<T>> {
        let Some(service) = self.service.take() else {
            let buffer = std::mem::take(&mut self.minimum_transfer_buffer_seconds);
            let result = search(self);
            self.minimum_transfer_buffer_seconds = buffer;
            return result.map(Some);
        };
        if !service.data.headways.is_empty() {
            self.service = Some(service);
            return Ok(None);
        }
        let rules = Arc::as_ptr(&service.data) as usize;
        if self.relaxed_graph.as_ref().is_none_or(|g| g.rules != rules) {
            self.relaxed_graph = Some(self.build_relaxed_graph(&service.data, rules));
        }
        let mut graph = self.relaxed_graph.take().unwrap();
        let swap = |kernel: &mut Self, graph: &mut RelaxedGraph| {
            std::mem::swap(&mut kernel.transfer_offset, &mut graph.transfer_offset);
            std::mem::swap(&mut kernel.transfer_edges, &mut graph.transfer_edges);
            std::mem::swap(
                &mut kernel.reverse_transfer_offset,
                &mut graph.reverse_transfer_offset,
            );
            std::mem::swap(
                &mut kernel.reverse_transfer_edges,
                &mut graph.reverse_transfer_edges,
            );
            std::mem::swap(
                &mut kernel.same_stop_transfer_minimum,
                &mut graph.same_stop_transfer_minimum,
            );
            std::mem::swap(
                &mut kernel.forbidden_same_stop,
                &mut graph.forbidden_same_stop,
            );
        };
        swap(self, &mut graph);
        let buffer = std::mem::take(&mut self.minimum_transfer_buffer_seconds);
        let result = search(self);
        self.minimum_transfer_buffer_seconds = buffer;
        swap(self, &mut graph);
        self.relaxed_graph = Some(graph);
        self.service = Some(service);
        result.map(Some)
    }

    /// Whether every transfer of a journey chain (origin first) obeys the
    /// transfer rules exactly as the stateful search evaluates them. A legal
    /// relaxed earliest journey is then the earliest journey overall.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn legal_chain(
        &self,
        kinds: &[u32],
        from: &[i32],
        to: &[i32],
        trips: &[i32],
        board: &[f64],
        alight: &[f64],
        arrivals: &[f64],
    ) -> bool {
        let Some(s) = self.service.as_ref() else {
            return true;
        };
        let physical = |trip: u32, sequence: f64| {
            s.data
                .physical_trips
                .get(trip as usize)
                .and_then(|parts| {
                    parts
                        .iter()
                        .rev()
                        .find(|(first, _)| f64::from(*first) <= sequence)
                })
                .map_or(trip, |(_, p)| *p)
        };
        let route = |trip: u32| s.data.trip_routes.get(trip as usize).copied();
        // (trip, alight sequence, stop, clock) of the last ride.
        let mut previous: Option<(u32, f64, u32, f64)> = None;
        for i in 0..kinds.len() {
            if kinds[i] != 2 {
                continue;
            }
            let (trip, stop) = (trips[i] as u32, from[i] as u32);
            if let Some((last, sequence, anchor, anchor_clock)) = previous {
                let (arriving, departing) = (physical(last, sequence), physical(trip, board[i]));
                let mut matching = s.data.rules.iter().filter(|r| {
                    r.from_stop == anchor
                        && r.to_stop == stop
                        && !r.from_trip.is_some_and(|t| t != arriving)
                        && !r.to_trip.is_some_and(|t| t != departing)
                        && !r.from_route.is_some_and(|v| Some(v) != route(arriving))
                        && !r.to_route.is_some_and(|v| Some(v) != route(departing))
                });
                let Ok(rule) = TransferRule::select_most_specific(&mut matching) else {
                    return false;
                };
                let walk = (anchor != stop).then(|| {
                    let edges = &self.transfer_edges[self.transfer_offset[anchor as usize] as usize
                        ..self.transfer_offset[anchor as usize + 1] as usize];
                    edges
                        .iter()
                        .filter(|e| e.stop() as u32 == stop)
                        .map(|e| e.duration())
                        .min()
                });
                let scoped_path = walk.is_some_and(|w| w.is_none());
                let forbidden =
                    anchor == stop && self.forbidden_same_stop.as_ref()[stop as usize] != 0;
                if !transfer_allowed(forbidden, rule.map(|r| r.kind), scoped_path) {
                    return false;
                }
                let minimum = rule.map_or(
                    if anchor == stop {
                        self.same_stop_transfer_minimum[stop as usize]
                    } else {
                        0
                    },
                    |r| if r.kind == 2 { r.minimum } else { 0 },
                );
                let buffer = if rule.is_some_and(|r| r.kind == 1) {
                    0
                } else {
                    self.minimum_transfer_buffer_seconds
                };
                let clock = anchor_clock + f64::from(walk.flatten().unwrap_or(0));
                let ready = transfer_ready_time::<false>(clock, anchor_clock, minimum, buffer);
                match self.ride_departure(trip, board[i]) {
                    Ok(departure) if departure + 1e-9 >= ready => {}
                    _ => return false,
                }
            }
            previous = Some((trip, alight[i], to[i] as u32, arrivals[i]));
        }
        true
    }

    /// The stateful search confined to a window that the relaxed graph
    /// proves sufficient: no window at all when nothing is reachable, then
    /// widening windows after the relaxed arrival. The earliest journey in a
    /// window is the earliest overall, since anything outside arrives later.
    pub(super) fn windowed_service_scalar(
        &mut self,
        input: &TimetableQueryInput,
    ) -> Result<TimetableQueryResult> {
        let Some(bound) = self.relaxed(|k| k.route_scalar_csa_impl::<true>(input))? else {
            return self.service_scalar(input);
        };
        if !bound.supported {
            return self.service_scalar(input);
        }
        let Some(floor) = bound.best_arrival else {
            return Ok(bound);
        };
        // The usual case: the relaxed earliest journey breaks no rule.
        if self.legal_chain(
            &bound.chain_kinds,
            &bound.chain_from_stops,
            &bound.chain_to_stops,
            &bound.chain_trip_or_candidate,
            &bound.chain_board_sequences,
            &bound.chain_alight_sequences,
            &bound.chain_arrivals,
        ) {
            self.record_ordinary_search();
            return Ok(bound);
        }
        for slack in WINDOWS {
            let horizon = (floor + slack).min(input.horizon);
            let result = self.service_scalar(&TimetableQueryInput {
                horizon,
                ..input.clone()
            })?;
            if result.best_arrival.is_some() || horizon >= input.horizon {
                return Ok(result);
            }
        }
        unreachable!()
    }

    /// The Pareto search over the relaxed graph, accepted when every journey
    /// on its frontier is legal: each legal journey is then dominated by a
    /// legal frontier member, so the frontiers agree.
    pub(super) fn validated_service_pareto(
        &mut self,
        input: &TimetableParetoQueryInput,
    ) -> Result<TimetableParetoQueryResult> {
        let Some(bound) = self.relaxed(|k| k.route_pareto_round_csa(input.clone()))? else {
            return self.service_pareto(input);
        };
        if !bound.supported {
            return self.service_pareto(input);
        }
        if bound.best_arrival.is_none() {
            return Ok(bound);
        }
        let legal = self.legal_chain(
            &bound.chain_kinds,
            &bound.chain_from_stops,
            &bound.chain_to_stops,
            &bound.chain_trip_or_candidate,
            &bound.chain_board_sequences,
            &bound.chain_alight_sequences,
            &bound.chain_arrivals,
        ) && bound.alternatives.iter().flatten().all(|a| {
            self.legal_chain(
                &a.chain_kinds,
                &a.chain_from_stops,
                &a.chain_to_stops,
                &a.chain_trip_or_candidate,
                &a.chain_board_sequences,
                &a.chain_alight_sequences,
                &a.chain_arrivals,
            )
        });
        if legal {
            self.record_ordinary_search();
            return Ok(bound);
        }
        self.service_pareto(input)
    }

    pub(super) fn windowed_service_arrive(
        &mut self,
        input: &TimetableArriveByQueryInput,
    ) -> Result<TimetableArriveByQueryResult> {
        let Some(bound) = self.relaxed(|k| k.route_arrive_by_csa(input.clone()))? else {
            return self.service_arrive(input);
        };
        if !bound.supported {
            return self.service_arrive(input);
        }
        let Some(ceiling) = bound.latest_departure else {
            return Ok(bound);
        };
        for slack in WINDOWS {
            let earliest = (ceiling - slack).max(input.earliest);
            let result = self.service_arrive(&TimetableArriveByQueryInput {
                earliest,
                ..input.clone()
            })?;
            if result.latest_departure.is_some() || earliest <= input.earliest {
                return Ok(result);
            }
        }
        unreachable!()
    }

    pub(super) fn windowed_service_many(
        &mut self,
        input: &TimetableManyQueryInput,
    ) -> Result<TimetableManyQueryResult> {
        let Some(bound) = self.relaxed(|k| k.route_many_csa_impl(input))? else {
            return self.service_many(input);
        };
        if !bound.supported {
            return self.service_many(input);
        }
        let reachable: Vec<bool> = bound.best_arrivals.iter().map(|a| a.is_finite()).collect();
        let Some(floor) = bound
            .best_arrivals
            .iter()
            .copied()
            .filter(|a| a.is_finite())
            .reduce(f64::max)
        else {
            return Ok(bound);
        };
        for slack in WINDOWS {
            let horizon = (floor + slack).min(input.horizon);
            let result = self.service_many(&TimetableManyQueryInput {
                horizon,
                ..clone_many(input)
            })?;
            let complete = result
                .best_arrivals
                .iter()
                .zip(&reachable)
                .all(|(a, reachable)| a.is_finite() || !reachable);
            if complete || horizon >= input.horizon {
                return Ok(result);
            }
        }
        unreachable!()
    }
}

/// Widening stateful windows after the relaxed bound, in seconds; the last
/// covers the whole request horizon.
const WINDOWS: [f64; 4] = [600., 1800., 3600., f64::INFINITY];

fn clone_many(input: &TimetableManyQueryInput) -> TimetableManyQueryInput {
    TimetableManyQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        destination_offsets: input.destination_offsets.clone(),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        excluded_trips: input.excluded_trips.clone(),
        departure: input.departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: input.allow_pre_ride_transfers,
        allow_post_ride_transfers: input.allow_post_ride_transfers.clone(),
        maximum_boardings: input.maximum_boardings,
    }
}
