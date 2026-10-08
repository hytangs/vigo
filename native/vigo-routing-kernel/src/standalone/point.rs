//! Reuse the destination-directed exact point certifier used by Node Route.
//! The shared Matrix rounds remain the fallback for unbounded/selected-stop
//! queries; no scalar witness bypasses boarding and walking tie certification.
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

pub(super) fn alternatives(
    kernel: &mut TimetableKernel,
    input: &TimetableMatrixQueryInput,
    best: &TimetableMatrixJourney,
    slack: f64,
) -> Result<Vec<TimetableMatrixJourney>> {
    let departure = if input.arrive_by {
        best.departure
    } else {
        input.departure
    };
    let request = TimetableParetoQueryInput {
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
        boarding_upper_bound: best.boardings,
        candidate_destination_index: 0,
        candidate_walking_seconds: f64::MAX,
        arrival_slack_seconds: if input.arrive_by { 0. } else { slack },
        transfer_penalty_seconds: 0.,
        walk_reluctance: 0.,
        collect_alternatives: Some(true),
        restriction_mode: None,
        deadline_objective: Some(false),
    };
    let mut result = kernel.route_pareto_round_csa(request.clone())?;
    if !result.supported && result.reason.as_deref() == Some("origin_outside_kernel") {
        result = kernel.route_pareto_round_csa(TimetableParetoQueryInput {
            restriction_mode: Some("anchor-only".into()),
            ..request
        })?;
    }
    if !result.supported {
        return Err(format!(
            "Alternative search failed: {}",
            result.reason.unwrap_or_default()
        )
        .into());
    }
    result
        .alternatives
        .unwrap_or_default()
        .into_iter()
        .map(|chain| reconstruct(kernel, input, departure, chain.into()))
        .collect()
}

pub(super) fn route(
    kernel: &mut TimetableKernel,
    input: &TimetableMatrixQueryInput,
) -> Result<Option<TimetableMatrixQueryResult>> {
    let Some(cap) = input.maximum_boardings else {
        return Ok(None);
    };
    if input.allow_pre_ride_transfers[0]
        || input
            .allow_post_ride_transfers
            .as_ref()
            .is_none_or(|a| a[0])
    {
        return Ok(None);
    }
    let started = Instant::now();
    let mut output = TimetableMatrixQueryResult {
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
    };
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
