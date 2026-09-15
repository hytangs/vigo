//! Exact journey ranking over the same scheduled + realtime service universe.
//! Only departures between the query and its known earliest arrival are copied.
//! The resident timetable is never mutated; the existing Pareto solver supplies
//! the arrival / boarding / walking ordering and all transfer semantics.
use super::*;

pub(super) struct CertifiedJourney {
    pub result: TimetableParetoQueryResult,
    pub bytes: f64,
}

#[derive(Default)]
struct Segments {
    departure: Vec<u32>,
    arrival: Vec<u32>,
    from: Vec<u32>,
    to: Vec<u32>,
    sequence: Vec<u32>,
    trip: Vec<u32>,
    continuity: Vec<u8>,
    board: Vec<u8>,
    alight: Vec<u8>,
}

pub(super) fn certify(
    base: &TimetableKernel,
    input: &TimetableOverlayManyQueryInput,
    overlay: &CompiledTimetableOverlay,
    witness: &[JourneyChainStep],
    arrival: f64,
    destination_index: u32,
) -> napi::Result<CertifiedJourney> {
    let boardings = witness.iter().filter(|step| step.0 == 2).count() as u32;
    if boardings == 0 || boardings as usize > MAX_PROFILE_BOARDINGS {
        return Err(Error::from_reason(
            "Realtime journey boarding bound is unsupported.",
        ));
    }
    let stop_count = base.stop_count + input.overlay_stop_count as usize;
    let last_departure = input.horizon.min(arrival);
    let mut excluded = vec![false; base.trip_start.len() - 1];
    for trip in &input.excluded_trips {
        excluded[*trip as usize] = true;
    }
    let mut segments = Segments::default();
    let mut trip_start = vec![0];
    let mut original_trips = Vec::<i32>::new();
    for run in 0..base.run_count {
        let start = base.run_start[run] as usize;
        let end = base.run_end[run] as usize;
        if start == end || excluded[base.segment_trip[start] as usize] {
            continue;
        }
        let times = &base.departure_seconds[start..end];
        let first = start + times.partition_point(|time| f64::from(*time) < input.departure);
        let last = start + times.partition_point(|time| f64::from(*time) <= last_departure);
        if first == last {
            continue;
        }
        let trip = original_trips.len() as u32;
        original_trips.push(base.segment_trip[start] as i32);
        for index in first..last {
            segments.departure.push(base.departure_seconds[index]);
            segments.arrival.push(base.arrival_seconds[index]);
            segments.from.push(base.from_stop[index]);
            segments.to.push(base.to_stop[index]);
            segments.sequence.push(base.sequence[index]);
            segments.trip.push(trip);
            segments.continuity.push(base.continuity_break[index]);
            segments.board.push(base.can_board[index]);
            segments.alight.push(base.can_alight[index]);
        }
        trip_start.push(segments.departure.len() as u32);
    }
    let mut events: Vec<_> = overlay
        .events
        .iter()
        .filter(|event| f64::from(event.departure) <= last_departure)
        .collect();
    events.sort_unstable_by_key(|event| (event.run, event.sequence));
    let mut prior_run = None;
    for event in events {
        if prior_run != Some(event.run) {
            if prior_run.is_some() {
                trip_start.push(segments.departure.len() as u32);
            }
            original_trips.push(-(event.run as i32) - 2);
            prior_run = Some(event.run);
        }
        segments.departure.push(event.departure);
        segments.arrival.push(event.arrival);
        segments.from.push(event.from as u32);
        segments.to.push(event.to as u32);
        segments.sequence.push(event.sequence);
        segments.trip.push(original_trips.len() as u32 - 1);
        segments.continuity.push(0);
        segments.board.push(u8::from(event.can_board));
        // Match the overlay scan's horizon, including its alighting rule.
        segments.alight.push(u8::from(
            event.can_alight && f64::from(event.arrival) <= input.horizon,
        ));
    }
    if prior_run.is_some() {
        trip_start.push(segments.departure.len() as u32);
    }

    let mut order: Vec<_> = (0..segments.departure.len() as u32)
        .filter(|index| segments.board[*index as usize] == 1)
        .collect();
    order.sort_unstable_by_key(|index| {
        (
            segments.from[*index as usize],
            segments.departure[*index as usize],
            *index,
        )
    });
    let mut departure_offset = vec![0_u32; stop_count + 1];
    for index in &order {
        departure_offset[segments.from[*index as usize] as usize + 1] += 1;
    }
    for stop in 0..stop_count {
        departure_offset[stop + 1] += departure_offset[stop];
    }
    let mut transfer_offset = vec![0];
    let mut transfer_to = Vec::new();
    let mut transfer_duration = Vec::new();
    let mut identity_transfers = Vec::new();
    for stop in 0..stop_count {
        if stop < base.stop_count {
            for edge in &base.transfer_edges
                [base.transfer_offset[stop] as usize..base.transfer_offset[stop + 1] as usize]
            {
                transfer_to.push(edge.stop() as u32);
                transfer_duration.push(edge.duration());
                identity_transfers.push(false);
            }
        }
        for index in input.supplemental_transfer_offsets[stop] as usize
            ..input.supplemental_transfer_offsets[stop + 1] as usize
        {
            transfer_to.push(input.supplemental_transfer_to[index]);
            transfer_duration.push(input.supplemental_transfer_duration[index]);
            identity_transfers.push(input.supplemental_transfer_duration[index] == 0);
        }
        transfer_offset.push(transfer_to.len() as u32);
    }
    let mut forbidden = base.forbidden_same_stop.to_vec();
    forbidden.resize(stop_count, 0);
    let mut minimum = base.same_stop_transfer_minimum.to_vec();
    minimum.resize(stop_count, 0);
    if let Some(identities) = &input.overlay_base_stops {
        for (local, original) in identities.iter().enumerate() {
            if *original >= 0 {
                forbidden[base.stop_count + local] = base.forbidden_same_stop[*original as usize];
                minimum[base.stop_count + local] =
                    base.same_stop_transfer_minimum[*original as usize];
            }
        }
    }
    let mut kernel = TimetableKernel::new(TimetableKernelInput {
        stop_count: stop_count as u32,
        run_count: original_trips.len() as u32,
        departure_seconds: segments.departure.into(),
        arrival_seconds: segments.arrival.into(),
        from_stop: segments.from.into(),
        to_stop: segments.to.into(),
        sequence: segments.sequence.into(),
        segment_run: segments.trip.clone().into(),
        segment_trip: segments.trip.into(),
        continuity_break: segments.continuity.into(),
        can_board: segments.board.into(),
        can_alight: segments.alight.into(),
        trip_start: trip_start.into(),
        departure_offset: departure_offset.into(),
        departure_order: order.into(),
        transfer_offset: transfer_offset.into(),
        transfer_to: transfer_to.into(),
        transfer_duration: transfer_duration.into(),
        forbidden_same_stop: forbidden.into(),
        same_stop_transfer_minimum: Some(minimum.into()),
    })?;
    kernel.profile_workspace.identity_transfer_edges = identity_transfers;
    let candidates = input
        .destination_candidate_indices
        .clone()
        .unwrap_or_else(|| (0..input.destination_stops.len() as u32).collect());
    let egress = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| **candidate == destination_index)
        .map(|(index, _)| input.destination_walk_seconds[index])
        .min_by(f64::total_cmp)
        .ok_or_else(|| Error::from_reason("Realtime journey destination is missing."))?;
    // The scalar overlay chain stores access arrival, not access duration.
    // Use that timestamp to build the same rounded walking bound as Pareto.
    let walking = witness
        .iter()
        .map(|step| match step.0 {
            3 => (step.7 - input.departure).round(),
            1 => f64::from(step.6),
            _ => 0.0,
        })
        .sum::<f64>()
        + egress;
    let query = |restriction: &str| TimetableParetoQueryInput {
        origin_stops: input.origin_stops.clone(),
        origin_walk_seconds: input.origin_walk_seconds.clone(),
        origin_candidate_indices: input
            .origin_candidate_indices
            .clone()
            .unwrap_or_else(|| (0..input.origin_stops.len() as u32).collect()),
        destination_stops: input.destination_stops.clone(),
        destination_walk_seconds: input.destination_walk_seconds.clone(),
        destination_candidate_indices: candidates.clone(),
        departure: input.departure,
        horizon: input.horizon,
        allow_pre_ride_transfers: input.allow_pre_ride_transfers,
        allow_post_ride_transfers: input
            .allow_post_ride_transfers
            .as_ref()
            .map(|flags| flags[0]),
        earliest_arrival: arrival,
        boarding_upper_bound: boardings,
        candidate_destination_index: destination_index,
        candidate_walking_seconds: walking,
        arrival_slack_seconds: 0.0,
        transfer_penalty_seconds: 0.0,
        walk_reluctance: 0.0,
        collect_alternatives: Some(false),
        restriction_mode: Some(restriction.to_owned()),
        deadline_objective: Some(false),
    };
    let mut result = kernel.route_pareto_round_csa(query("anchor+both"))?;
    if !result.supported && result.reason.as_deref() == Some("origin_outside_kernel") {
        result = kernel.route_pareto_round_csa(query("anchor-only"))?;
    }
    if !result.supported || result.status != "ready" || result.best_arrival != Some(arrival) {
        return Err(Error::from_reason(format!(
            "Realtime journey ranking failed: {:?}",
            result.reason
        )));
    }
    for (kind, trip) in result
        .chain_kinds
        .iter()
        .zip(&mut result.chain_trip_or_candidate)
    {
        if *kind == 2 {
            *trip = original_trips[*trip as usize];
        }
    }
    let diagnostics = kernel.diagnostics();
    Ok(CertifiedJourney {
        result,
        bytes: diagnostics.array_bytes + diagnostics.workspace_bytes,
    })
}
