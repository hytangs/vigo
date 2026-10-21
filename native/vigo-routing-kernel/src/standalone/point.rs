//! Reuse the destination-directed exact point certifier used by Node Route.
//! An uncapped departure scans for the earliest arrival, then certifies
//! boarding and walking ties inside that witness's corridor. The shared Matrix
//! rounds remain the fallback for other point queries; no scalar witness
//! bypasses boarding and walking tie certification.
use super::Result;
use crate::*;
use std::time::Instant;

struct Chain {
    arrival: f64,
    boardings: u32,
    destination: usize,
    kinds: Vec<u32>,
    from: Vec<i32>,
    to: Vec<i32>,
    trips: Vec<i32>,
    board: Vec<f64>,
    alight: Vec<f64>,
    durations: Vec<u32>,
    arrivals: Vec<f64>,
}
macro_rules! chain_from {
    ($kind:ty) => {
        impl From<$kind> for Chain {
            fn from(r: $kind) -> Self {
                Self {
                    arrival: r.best_arrival.unwrap(),
                    boardings: r.best_boardings.unwrap(),
                    destination: r.best_destination_index.unwrap() as usize,
                    kinds: r.chain_kinds,
                    from: r.chain_from_stops,
                    to: r.chain_to_stops,
                    trips: r.chain_trip_or_candidate,
                    board: r.chain_board_sequences,
                    alight: r.chain_alight_sequences,
                    durations: r.chain_durations,
                    arrivals: r.chain_arrivals,
                }
            }
        }
    };
}
chain_from!(TimetableQueryResult);
chain_from!(TimetableParetoQueryResult);

impl From<TimetableParetoAlternative> for Chain {
    fn from(r: TimetableParetoAlternative) -> Self {
        Self {
            arrival: r.best_arrival,
            boardings: r.best_boardings,
            destination: r.best_destination_index as usize,
            kinds: r.chain_kinds,
            from: r.chain_from_stops,
            to: r.chain_to_stops,
            trips: r.chain_trip_or_candidate,
            board: r.chain_board_sequences,
            alight: r.chain_alight_sequences,
            durations: r.chain_durations,
            arrivals: r.chain_arrivals,
        }
    }
}

/// Alternatives around `best`. A window sample keeps the bounded Pareto
/// frontier and fails loudly; an opt-in request uses its own ranking and
/// reports an unsupported search as its status instead.
pub(super) fn alternatives(
    kernel: &mut TimetableKernel,
    input: &TimetableMatrixQueryInput,
    best: &TimetableMatrixJourney,
    request: Option<&crate::route_alternatives::RouteAlternativeRequest>,
) -> Result<(Vec<TimetableMatrixJourney>, Option<String>)> {
    let departure = if input.arrive_by {
        best.departure
    } else {
        input.departure
    };
    let result = kernel.route_alternatives_csa(TimetableAlternativeQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
        departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: input.allow_pre_ride_transfers[0],
        allow_post_ride_transfers: input.allow_post_ride_transfers.as_ref().map(|a| a[0]),
        earliest_arrival: if input.arrive_by {
            input.horizon
        } else {
            best.arrival
        },
        arrival_slack_seconds: match request {
            Some(request) => request.arrival_slack_seconds,
            None if input.arrive_by => 0.,
            None => WINDOW_ARRIVAL_SLACK_SECONDS,
        },
        best_boardings: best.boardings,
        maximum_boardings: request.and(input.maximum_boardings),
        ranking: request.map(|r| r.ranking.clone()),
        limit: request.and_then(|r| r.limit),
    })?;
    if !result.supported {
        let reason = result.reason.unwrap_or_default();
        if request.is_some() {
            return Ok((vec![], Some(reason)));
        }
        return Err(format!("Alternative search failed: {reason}").into());
    }
    let journeys = result
        .alternatives
        .unwrap_or_default()
        .into_iter()
        .map(|chain| reconstruct(kernel, input, departure, chain.into()))
        .collect::<Result<_>>()?;
    Ok((journeys, None))
}

/// One departure-window sample, searched as fixed-departure Route certifies
/// a journey: a scalar connection scan proves the earliest arrival, then the
/// exact bounded Pareto rounds certify boarding and walking ties. The rounds
/// also keep their frontier: every journey arriving within the window slack
/// with at most the scalar witness's boardings that trades arrival, boardings
/// and walking, including the certified journey itself.
pub(super) fn window_sample(
    kernel: &mut TimetableKernel,
    input: &TimetableMatrixQueryInput,
) -> Result<Option<(TimetableMatrixJourney, Vec<TimetableMatrixJourney>)>> {
    let scalar = kernel.route_scalar_csa(TimetableQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
        departure: input.departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: input.allow_pre_ride_transfers[0],
        allow_post_ride_transfers: input.allow_post_ride_transfers.as_ref().map(|a| a[0]),
        maximum_boardings: input.maximum_boardings,
    })?;
    if !scalar.supported {
        return Err(format!(
            "Window sample search failed: {}",
            scalar.reason.unwrap_or_default()
        )
        .into());
    }
    if scalar.status == "blocked" || scalar.chain_kinds.is_empty() {
        return Ok(None);
    }
    let destination = scalar.best_destination_index.unwrap_or_default();
    let witness = reconstruct(kernel, input, input.departure, scalar.into())?;
    let query = TimetableParetoQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
        departure: input.departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: input.allow_pre_ride_transfers[0],
        allow_post_ride_transfers: input.allow_post_ride_transfers.as_ref().map(|a| a[0]),
        earliest_arrival: witness.arrival,
        boarding_upper_bound: witness.boardings,
        candidate_destination_index: destination,
        candidate_walking_seconds: witness.walking_seconds,
        arrival_slack_seconds: WINDOW_ARRIVAL_SLACK_SECONDS,
        transfer_penalty_seconds: 0.,
        walk_reluctance: 0.,
        collect_alternatives: Some(true),
        alternative_ranking: None,
        alternative_limit: None,
        restriction_mode: None,
        deadline_objective: None,
    };
    let mut r = kernel.route_pareto_round_csa(query.clone())?;
    // The corridor only accelerates; repeat the exact proof without it.
    if !r.supported && r.reason.as_deref() == Some("origin_outside_kernel") {
        r = kernel.route_pareto_round_csa(TimetableParetoQueryInput {
            restriction_mode: Some("anchor-only".into()),
            ..query
        })?;
    }
    if !r.supported || r.status != "ready" {
        return Err(format!(
            "Window sample certification failed: {}",
            r.reason.unwrap_or_else(|| r.status.clone())
        )
        .into());
    }
    let frontier = r
        .alternatives
        .take()
        .unwrap_or_default()
        .into_iter()
        .map(|alternative| reconstruct(kernel, input, input.departure, alternative.into()))
        .collect::<Result<_>>()?;
    let best = if r.improved_candidate {
        reconstruct(kernel, input, input.departure, r.into())?
    } else {
        witness
    };
    Ok(Some((best, frontier)))
}

/// Window samples admit alternatives arriving up to 15 minutes later.
pub(super) const WINDOW_ARRIVAL_SLACK_SECONDS: f64 = 15. * 60.;

fn unreached(input: &TimetableMatrixQueryInput) -> TimetableMatrixQueryResult {
    TimetableMatrixQueryResult {
        journeys: Some(vec![None]),
        times: vec![if input.arrive_by {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        }],
        forward_searches: 0,
        reverse_searches: 0,
        query_ns: 0.,
        scanned_departures: 0.,
        relaxed_stops: 0.,
        expanded_trip_runs: 0.,
        dominated_trip_boardings: 0.,
        explicit_transfer_checks: 0.,
    }
}

pub(super) fn route(
    kernel: &mut TimetableKernel,
    input: &TimetableMatrixQueryInput,
) -> Result<Option<TimetableMatrixQueryResult>> {
    let pre_ride_transfers = input.allow_pre_ride_transfers[0];
    let post_ride_transfers = input
        .allow_post_ride_transfers
        .as_ref()
        .is_none_or(|a| a[0]);
    let Some(cap) = input.maximum_boardings else {
        return if input.arrive_by {
            Ok(None)
        } else {
            certified_departure(kernel, input, pre_ride_transfers, post_ride_transfers)
        };
    };
    if pre_ride_transfers || post_ride_transfers {
        return Ok(None);
    }
    let started = Instant::now();
    let mut output = unreached(input);
    let mut departure = input.departure;
    if input.arrive_by {
        let bound = kernel.route_arrive_by_csa(TimetableArriveByQueryInput {
            origin_stops: input.origin_stops.clone(),
            origin_walk_seconds: input.origin_walk_seconds.clone(),
            origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
            destination_stops: input.destination_stops.clone(),
            destination_walk_seconds: input.destination_walk_seconds.clone(),
            destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
            earliest: input.departure,
            deadline: input.horizon,
            allow_pre_ride_transfers: false,
            allow_post_ride_transfers: Some(false),
            maximum_boardings: Some(cap),
        })?;
        if !bound.supported {
            return Ok(None);
        }
        output.reverse_searches = 1;
        output.scanned_departures += f64::from(bound.scanned_departures);
        output.relaxed_stops += f64::from(bound.relaxed_stops);
        output.expanded_trip_runs += f64::from(bound.expanded_trip_runs);
        output.dominated_trip_boardings += f64::from(bound.dominated_trip_boardings);
        output.explicit_transfer_checks += f64::from(bound.explicit_transfer_checks);
        let Some(latest) = bound.latest_departure else {
            output.query_ns = started.elapsed().as_nanos() as f64;
            return Ok(Some(output));
        };
        departure = latest;
    }
    let chain: Chain = if input.arrive_by {
        // At the proven latest departure, preserve the complete deadline
        // objective: boardings, walking, then actual arrival before the deadline.
        let query = TimetableParetoQueryInput {
            origin_stops: input.origin_stops.clone(),
            origin_walk_seconds: input.origin_walk_seconds.clone(),
            origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
            destination_stops: input.destination_stops.clone(),
            destination_walk_seconds: input.destination_walk_seconds.clone(),
            destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
            departure,
            horizon: input.horizon,
            allow_pre_ride_transfers: false,
            allow_post_ride_transfers: Some(false),
            earliest_arrival: input.horizon,
            boarding_upper_bound: cap,
            candidate_destination_index: 0,
            candidate_walking_seconds: f64::MAX,
            arrival_slack_seconds: 0.,
            transfer_penalty_seconds: 0.,
            walk_reluctance: 0.,
            collect_alternatives: None,
            alternative_ranking: None,
            alternative_limit: None,
            restriction_mode: None,
            deadline_objective: Some(true),
        };
        let mut r = kernel.route_pareto_round_csa(query.clone())?;
        if !r.supported && r.reason.as_deref() == Some("origin_outside_kernel") {
            r = kernel.route_pareto_round_csa(TimetableParetoQueryInput {
                restriction_mode: Some("anchor-only".into()),
                ..query
            })?;
        }
        if !r.supported || !r.improved_candidate || r.chain_kinds.is_empty() {
            return Ok(None);
        }
        output.forward_searches += 1;
        output.scanned_departures += f64::from(r.scanned_departures);
        output.relaxed_stops += f64::from(r.relaxed_stops);
        output.expanded_trip_runs += f64::from(r.expanded_trip_runs);
        output.dominated_trip_boardings += f64::from(r.dominated_trip_boardings);
        output.explicit_transfer_checks += f64::from(r.explicit_transfer_checks);
        r.into()
    } else {
        let r = kernel.route_scalar_csa(TimetableQueryInput {
            origin_stops: input.origin_stops.clone(),
            origin_walk_seconds: input.origin_walk_seconds.clone(),
            origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
            destination_stops: input.destination_stops.clone(),
            destination_walk_seconds: input.destination_walk_seconds.clone(),
            destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
            departure,
            horizon: input.horizon,
            allow_pre_ride_transfers: false,
            allow_post_ride_transfers: Some(false),
            maximum_boardings: Some(cap),
        })?;
        if !r.supported {
            return Ok(None);
        }
        output.forward_searches += 1;
        output.scanned_departures += f64::from(r.scanned_departures);
        output.relaxed_stops += f64::from(r.relaxed_stops);
        output.expanded_trip_runs += f64::from(r.expanded_trip_runs);
        output.dominated_trip_boardings += f64::from(r.dominated_trip_boardings);
        output.explicit_transfer_checks += f64::from(r.explicit_transfer_checks);
        if r.status == "blocked" {
            output.query_ns = started.elapsed().as_nanos() as f64;
            return Ok(Some(output));
        }
        if r.chain_kinds.is_empty() {
            return Ok(None);
        }
        r.into()
    };
    let journey = reconstruct(kernel, input, departure, chain)?;
    output.times[0] = if input.arrive_by {
        journey.departure
    } else {
        journey.arrival
    };
    output.journeys = Some(vec![Some(journey)]);
    output.query_ns = started.elapsed().as_nanos() as f64;
    Ok(Some(output))
}

/// The uncapped departure sequence Node Route uses: a scalar scan proves the
/// earliest arrival, then the bounded Pareto certifier settles boarding and
/// walking ties among journeys with that arrival. Selected stops may transfer
/// before the first ride and after the last, as in the scalar search. The
/// forward/reverse corridor only accelerates the proof; if it excludes every
/// origin, the certifier repeats without it. Any unsupported outcome returns
/// the Matrix fallback.
fn certified_departure(
    kernel: &mut TimetableKernel,
    input: &TimetableMatrixQueryInput,
    pre_ride_transfers: bool,
    post_ride_transfers: bool,
) -> Result<Option<TimetableMatrixQueryResult>> {
    let started = Instant::now();
    let mut output = unreached(input);
    let origin_candidate_indices: Vec<u32> = (0..input.origin_stops.len() as u32).collect();
    let destination_candidate_indices: Vec<u32> =
        (0..input.destination_stops.len() as u32).collect();
    let scalar = kernel.route_scalar_csa(TimetableQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        origin_candidate_indices: origin_candidate_indices.clone(),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        destination_candidate_indices: destination_candidate_indices.clone(),
        departure: input.departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: pre_ride_transfers,
        allow_post_ride_transfers: Some(post_ride_transfers),
        maximum_boardings: None,
    })?;
    if !scalar.supported {
        return Ok(None);
    }
    output.forward_searches += 1;
    output.scanned_departures += f64::from(scalar.scanned_departures);
    output.relaxed_stops += f64::from(scalar.relaxed_stops);
    output.expanded_trip_runs += f64::from(scalar.expanded_trip_runs);
    output.dominated_trip_boardings += f64::from(scalar.dominated_trip_boardings);
    output.explicit_transfer_checks += f64::from(scalar.explicit_transfer_checks);
    if scalar.status == "blocked" {
        output.query_ns = started.elapsed().as_nanos() as f64;
        return Ok(Some(output));
    }
    let (Some(arrival), Some(boardings), Some(destination)) = (
        scalar.best_arrival,
        scalar.best_boardings,
        scalar.best_destination_index,
    ) else {
        return Ok(None);
    };
    if scalar.chain_kinds.is_empty() || boardings == 0 {
        return Ok(None);
    }
    // The witness's walking: its access candidate, transfers and egress.
    let mut walking = input.destination_walk_seconds[destination as usize];
    for (i, kind) in scalar.chain_kinds.iter().enumerate() {
        match kind {
            3 => walking += input.origin_walk_seconds[scalar.chain_trip_or_candidate[i] as usize],
            1 => walking += f64::from(scalar.chain_durations[i]),
            _ => (),
        }
    }
    let query = TimetableParetoQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        origin_candidate_indices,
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        destination_candidate_indices,
        departure: input.departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: pre_ride_transfers,
        allow_post_ride_transfers: Some(post_ride_transfers),
        earliest_arrival: arrival,
        boarding_upper_bound: boardings,
        candidate_destination_index: destination,
        candidate_walking_seconds: walking,
        arrival_slack_seconds: 0.,
        transfer_penalty_seconds: 0.,
        walk_reluctance: 0.,
        collect_alternatives: None,
        alternative_ranking: None,
        alternative_limit: None,
        restriction_mode: None,
        deadline_objective: None,
    };
    let mut pareto = kernel.route_pareto_round_csa(query.clone())?;
    if !pareto.supported && pareto.reason.as_deref() == Some("origin_outside_kernel") {
        pareto = kernel.route_pareto_round_csa(TimetableParetoQueryInput {
            restriction_mode: Some("anchor-only".into()),
            ..query
        })?;
    }
    if !pareto.supported
        || pareto.status != "ready"
        || pareto.best_arrival.is_none_or(|a| a > arrival + 0.1)
    {
        return Ok(None);
    }
    output.forward_searches += 1;
    output.scanned_departures += f64::from(pareto.scanned_departures);
    output.relaxed_stops += f64::from(pareto.relaxed_stops);
    output.expanded_trip_runs += f64::from(pareto.expanded_trip_runs);
    output.dominated_trip_boardings += f64::from(pareto.dominated_trip_boardings);
    output.explicit_transfer_checks += f64::from(pareto.explicit_transfer_checks);
    let chain: Chain = if pareto.improved_candidate && !pareto.chain_kinds.is_empty() {
        pareto.into()
    } else {
        scalar.into()
    };
    let journey = reconstruct(kernel, input, input.departure, chain)?;
    output.times[0] = journey.arrival;
    output.journeys = Some(vec![Some(journey)]);
    output.query_ns = started.elapsed().as_nanos() as f64;
    Ok(Some(output))
}

fn reconstruct(
    kernel: &TimetableKernel,
    input: &TimetableMatrixQueryInput,
    departure: f64,
    chain: Chain,
) -> Result<TimetableMatrixJourney> {
    let mut legs = Vec::with_capacity(chain.kinds.len() + 1);
    let mut clock = departure;
    let (mut walking, mut riding) = (0., 0.);
    for i in 0..chain.kinds.len() {
        let ride = chain.kinds[i] == 2;
        let arrival = chain.arrivals[i];
        let start = if ride {
            kernel.ride_departure(chain.trips[i] as u32, chain.board[i])?
        } else {
            clock
        };
        let end = if ride {
            arrival
        } else {
            start + f64::from(chain.durations[i])
        };
        if start + 1e-7 < clock || end < start {
            return Err("Infeasible certified point witness".into());
        }
        if ride {
            riding += end - start
        } else {
            walking += end - start
        }
        legs.push(TimetableMatrixLeg {
            kind: if ride { "ride" } else { "walk" }.into(),
            from_stop: (chain.from[i] >= 0).then_some(chain.from[i] as u32),
            to_stop: (chain.to[i] >= 0).then_some(chain.to[i] as u32),
            trip: ride.then_some(chain.trips[i] as u32),
            board_sequence: ride.then_some(chain.board[i]),
            alight_sequence: ride.then_some(chain.alight[i]),
            departure: start,
            arrival: end,
        });
        clock = end;
    }
    let egress = input.destination_walk_seconds[chain.destination];
    if (clock + egress - chain.arrival).abs() > 1e-7 {
        return Err("Certified point egress disagrees with arrival".into());
    }
    legs.push(TimetableMatrixLeg {
        kind: "walk".into(),
        from_stop: Some(input.destination_stops[chain.destination]),
        to_stop: None,
        trip: None,
        board_sequence: None,
        alight_sequence: None,
        departure: clock,
        arrival: clock + egress,
    });
    walking += egress;
    Ok(TimetableMatrixJourney {
        departure,
        arrival: chain.arrival,
        boardings: chain.boardings,
        walking_seconds: walking,
        ride_seconds: riding,
        waiting_seconds: (chain.arrival - departure - walking - riding).max(0.),
        legs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Stop 0 reaches stop 2 at 40 s either through stop 1 (two boardings) or
    // on a direct trip (one boarding).
    fn kernel() -> TimetableKernel {
        TimetableKernel::new(TimetableKernelInput {
            stop_count: 3,
            run_count: 3,
            departure_seconds: vec![10, 25, 12].into(),
            arrival_seconds: vec![20, 40, 40].into(),
            from_stop: vec![0, 1, 0].into(),
            to_stop: vec![1, 2, 2].into(),
            sequence: vec![1, 1, 1].into(),
            segment_trip: vec![0, 1, 2].into(),
            segment_run: vec![0, 1, 2].into(),
            continuity_break: vec![1, 1, 1].into(),
            can_board: vec![1, 1, 1].into(),
            can_alight: vec![1, 1, 1].into(),
            trip_start: vec![0, 1, 2, 3].into(),
            departure_offset: vec![0, 2, 3, 3].into(),
            departure_order: vec![0, 2, 1].into(),
            transfer_offset: vec![0, 0, 0, 0].into(),
            transfer_to: vec![].into(),
            transfer_duration: vec![].into(),
            forbidden_same_stop: vec![0, 0, 0].into(),
            same_stop_transfer_minimum: None,
            minimum_transfer_buffer_seconds: None,
        })
        .unwrap()
    }

    fn input(maximum_boardings: Option<u32>) -> TimetableMatrixQueryInput {
        TimetableMatrixQueryInput {
            origin_offsets: vec![0, 1],
            origin_stops: vec![0],
            origin_walk_seconds: vec![0.0],
            allow_pre_ride_transfers: vec![false],
            destination_offsets: vec![0, 1],
            destination_stops: vec![2],
            destination_walk_seconds: vec![0.0],
            allow_post_ride_transfers: Some(vec![false]),
            departure: 0.0,
            horizon: 100.0,
            arrive_by: false,
            maximum_boardings,
            include_journeys: Some(true),
        }
    }

    #[test]
    fn uncapped_departure_certifies_boarding_ties_like_matrix_rounds() {
        let mut kernel = kernel();
        let certified = route(&mut kernel, &input(None)).unwrap().unwrap();
        let matrix = kernel.route_matrix_csa(input(None)).unwrap();
        let journey = certified.journeys.unwrap().remove(0).unwrap();
        let expected = matrix.journeys.unwrap().remove(0).unwrap();
        assert_eq!(certified.times, matrix.times);
        assert_eq!((journey.arrival, journey.boardings), (40.0, 1));
        assert_eq!(journey.boardings, expected.boardings);
        assert_eq!(
            certified.forward_searches, 2,
            "scalar scan, then certification"
        );
    }
}
