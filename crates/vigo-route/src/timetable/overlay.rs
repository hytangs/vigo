use super::*;

impl TimetableKernel {
    /// Runs the resident timetable and finite query-scoped services as one
    /// chronological connection scan. Supplemental transfer edges join the
    /// resident and overlay stop domains, so a journey may alternate between
    /// baseline and proposed service any finite number of times admitted by
    /// the chronological event stream.
    pub fn route_overlay_many_csa(
        &mut self,
        input: TimetableOverlayManyQueryInput,
    ) -> Result<TimetableOverlayManyQueryResult> {
        let started = Instant::now();
        let compile_started = Instant::now();
        let overlay_stop_count = input.overlay_stop_count as usize;
        if overlay_stop_count > MAX_OVERLAY_STOPS {
            return Err(Error::from_reason(format!(
                "Rust timetable overlay exceeds the {MAX_OVERLAY_STOPS}-stop query limit."
            )));
        }
        let combined_stop_count = self
            .stop_count
            .checked_add(overlay_stop_count)
            .ok_or_else(|| Error::from_reason("Rust timetable overlay stop count overflowed."))?;
        if input.overlay_base_stops.len() != overlay_stop_count
            || input
                .overlay_base_stops
                .iter()
                .any(|stop| *stop < -1 || *stop >= self.stop_count as i32)
        {
            return Err(Error::from_reason(
                "Rust timetable overlay stop identities are inconsistent.",
            ));
        }
        let compiled = compile_timetable_overlay(&input, self.stop_count)?;
        let combined_run_count = self
            .run_count
            .checked_add(compiled.run_count)
            .ok_or_else(|| Error::from_reason("Rust timetable overlay run count overflowed."))?;
        if input.supplemental_transfer_offsets.len() != combined_stop_count + 1
            || input.supplemental_transfer_offsets.first().copied() != Some(0)
            || input.supplemental_transfer_offsets[combined_stop_count] as usize
                != input.supplemental_transfer_to.len()
            || input.supplemental_transfer_to.len() != input.supplemental_transfer_duration.len()
            || input
                .supplemental_transfer_offsets
                .windows(2)
                .any(|offsets| offsets[0] > offsets[1])
            || input
                .supplemental_transfer_to
                .iter()
                .any(|stop| *stop as usize >= combined_stop_count)
        {
            return Err(Error::from_reason(
                "Rust timetable overlay supplemental transfer arrays are inconsistent.",
            ));
        }
        if self.service.is_some() {
            return self.service_overlay(&input);
        }
        let supplemental_transfer_edges = input
            .supplemental_transfer_to
            .iter()
            .copied()
            .zip(input.supplemental_transfer_duration.iter().copied())
            .map(|(stop, duration)| TransferEdge::new(stop, duration))
            .collect::<Vec<_>>();
        let mut supplemental_identity_edges = Vec::with_capacity(supplemental_transfer_edges.len());
        for stop in 0..combined_stop_count {
            for edge in input.supplemental_transfer_offsets[stop] as usize
                ..input.supplemental_transfer_offsets[stop + 1] as usize
            {
                supplemental_identity_edges.push(overlay_identity_transfer(
                    &input,
                    self.stop_count,
                    stop,
                    edge,
                ));
            }
        }
        let compile_ns = compile_started.elapsed().as_nanos() as f64;
        let transient_bytes = compiled.byte_length()
            + supplemental_transfer_edges.capacity() * std::mem::size_of::<TransferEdge>()
            + supplemental_identity_edges.capacity() * std::mem::size_of::<bool>();

        let destination_count = input.destination_offsets.len().saturating_sub(1);
        if input
            .allow_post_ride_transfers
            .as_ref()
            .is_some_and(|flags| flags.len() != destination_count)
        {
            return Err(Error::from_reason(
                "Rust timetable terminal transfer flags must match destinations.",
            ));
        }
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_offsets.len() < 2
            || input.destination_offsets[0] != 0
            || input.destination_offsets[destination_count] as usize
                != input.destination_stops.len()
            || input
                .destination_offsets
                .windows(2)
                .any(|offsets| offsets[0] > offsets[1])
            || input
                .origin_stops
                .iter()
                .chain(input.destination_stops.iter())
                .any(|stop| *stop as usize >= combined_stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(input.destination_walk_seconds.iter())
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || input.excluded_trips.iter().any(|trip| {
                *trip as usize >= self.query.many_workspace.excluded_trip_generation.len()
            })
            || !input.departure.is_finite()
            || !input.horizon.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
        {
            return Err(Error::from_reason(
                "Rust overlay one-to-many timetable query arrays or bounds are inconsistent.",
            ));
        }
        if input
            .origin_candidate_indices
            .as_ref()
            .is_some_and(|indices| indices.len() != input.origin_stops.len())
            || input
                .destination_candidate_indices
                .as_ref()
                .is_some_and(|indices| indices.len() != input.destination_stops.len())
        {
            return Err(Error::from_reason(
                "Rust overlay candidate-index arrays are inconsistent.",
            ));
        }
        let scan_started = Instant::now();
        let origin_candidate_indices = input.origin_candidate_indices.as_deref();
        let destination_candidate_indices = input.destination_candidate_indices.as_deref();

        let base_stop_count = self.stop_count;
        let base_run_count = self.run_count;
        let transfer_buffer_seconds = self.minimum_transfer_buffer_seconds;
        let Self {
            service: _,
            stop_count: _,
            run_count: _,
            departure_seconds: _,
            arrival_seconds: _,
            from_stop: _,
            to_stop: _,
            sequence: _,
            segment_trip: _,
            segment_run: _,
            continuity_break: _,
            can_board: _,
            can_alight: _,
            trip_start: _,
            departure_offset: _,
            departure_events: _,
            transfer_offset,
            transfer_edges,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            minimum_transfer_buffer_seconds: _,
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys,
            run_start: _,
            run_end: _,
            reverse_transfer_offset: _,
            reverse_transfer_edges: _,
            exit_event_offset: _,
            exit_events: _,
            query:
                TimetableQueryWorkspace {
                    workspace: _,
                    many_workspace,
                    forward_workspace: _,
                    profile_workspace: _,
                    journey_workspace: _,
                },
        } = self;
        let forbidden_same_stop = forbidden_same_stop.as_ref();
        let maximum_layer = boarding_layers(input.maximum_boardings)?;
        let first_layer = usize::from(input.maximum_boardings.is_some());
        many_workspace.ensure_dimensions(
            combined_stop_count * (maximum_layer + 1),
            combined_run_count * (maximum_layer + 1),
        );
        many_workspace.predecessors.resize(
            combined_stop_count * (maximum_layer + 1) * STATE_STRIDE,
            ScalarPredecessor::default(),
        );
        many_workspace
            .run_boarding_state
            .resize(combined_run_count * (maximum_layer + 1), NO_STATE);
        let epoch = many_workspace.begin_query();
        for trip in &input.excluded_trips {
            many_workspace.excluded_trip_generation[*trip as usize] = epoch;
        }
        let mut stats = SearchStats::default();
        let mut excluded_departures = 0_u32;
        let mut origin_seeds = 0_u32;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            let state = relax_many_record(
                many_workspace,
                epoch,
                &mut stats,
                stop,
                arrival,
                false,
                false,
                false,
                input.horizon,
                false,
                NO_STATE,
                3,
                origin_candidate_indices
                    .and_then(|indices| indices.get(index).copied())
                    .unwrap_or(index as u32) as i32,
                0.0,
                0.0,
                0,
            );
            if state < 0 {
                continue;
            }
            origin_seeds = origin_seeds.saturating_add(1);
            if input.allow_pre_ride_transfers {
                expand_many_combined_transfer_edges_chain(
                    many_workspace,
                    epoch,
                    &mut stats,
                    base_stop_count,
                    transfer_offset,
                    transfer_edges,
                    &input.supplemental_transfer_offsets,
                    &supplemental_transfer_edges,
                    &supplemental_identity_edges,
                    stop,
                    arrival,
                    false,
                    input.horizon,
                    state,
                );
            }
        }
        if origin_seeds == 0 {
            let workspace_bytes = many_workspace.byte_length() as f64;
            many_workspace.predecessors = Vec::new();
            many_workspace.run_boarding_state = Vec::new();
            return Ok(TimetableOverlayManyQueryResult {
                timetable: TimetableManyQueryResult {
                    supported: false,
                    status: "unsupported".to_owned(),
                    reason: Some("origin_outside_kernel".to_owned()),
                    algorithm: "rust_resident_query_overlay_connection_scan_one_to_many".to_owned(),
                    best_arrivals: vec![f64::INFINITY; destination_count],
                    best_destination_index: None,
                    chain_kinds: Vec::new(),
                    chain_from_stops: Vec::new(),
                    chain_to_stops: Vec::new(),
                    chain_trip_or_candidate: Vec::new(),
                    chain_board_sequences: Vec::new(),
                    chain_alight_sequences: Vec::new(),
                    chain_durations: Vec::new(),
                    chain_arrivals: Vec::new(),
                    query_ns: started.elapsed().as_nanos() as f64,
                    scanned_departures: 0,
                    excluded_departures: 0,
                    relaxed_stops: stats.relaxed_stops,
                    expanded_trip_runs: 0,
                    dominated_trip_boardings: 0,
                    explicit_transfer_checks: stats.explicit_transfer_checks,
                },
                overlay_connections: compiled.events.len() as u32,
                overlay_runs: compiled.run_count as u32,
                overlay_run_directions: compiled.run_directions,
                supplemental_transfer_edges: supplemental_transfer_edges.len() as u32,
                compile_ns,
                scan_ns: scan_started.elapsed().as_nanos() as f64,
                transient_bytes: transient_bytes as f64,
                workspace_bytes,
                lexicographic_certified: false,
                quality_query_ns: 0.0,
                quality_bytes: 0.0,
                quality_reason: None,
            });
        }

        let mut base_time_index = scan_time_lower_bound(scan_times, input.departure);
        let mut overlay_index = compiled
            .events
            .partition_point(|event| f64::from(event.departure) < input.departure);
        while base_time_index < scan_times.len() || overlay_index < compiled.events.len() {
            let base_departure = scan_times.get(base_time_index).copied().unwrap_or(u32::MAX);
            let overlay_departure = compiled
                .events
                .get(overlay_index)
                .map(|event| event.departure)
                .unwrap_or(u32::MAX);
            let connection_departure = base_departure.min(overlay_departure);
            if f64::from(connection_departure) > input.horizon {
                break;
            }

            let base_bucket_start = base_time_index;
            let overlay_bucket_start = overlay_index;
            let needs_closure = (base_departure == connection_departure
                && scan_time_needs_closure
                    .get(base_time_index)
                    .copied()
                    .unwrap_or(false))
                || compiled.events[overlay_index..]
                    .iter()
                    .take_while(|event| event.departure == connection_departure)
                    .any(|event| event.arrival == connection_departure);
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                base_time_index = base_bucket_start;
                overlay_index = overlay_bucket_start;
                if base_departure == connection_departure && base_time_index < scan_times.len() {
                    let start = scan_time_offsets[base_time_index] as usize;
                    let end = scan_time_offsets[base_time_index + 1] as usize;
                    for connection in start..end {
                        for layer in first_layer..=maximum_layer {
                            let input_offset = layer.saturating_sub(1) * combined_stop_count;
                            let output_offset = layer * combined_stop_count;
                            let event = scan_events[connection];
                            let flags = event.flags();
                            let base_stop = event.source_stop();
                            let stop = input_offset + base_stop;
                            let run = layer * combined_run_count + event.run();
                            stats.scanned_departures = stats.scanned_departures.saturating_add(1);
                            let trip = scan_journeys[connection].trip as usize;
                            if many_workspace.excluded_trip_generation[trip] == epoch {
                                excluded_departures = excluded_departures.saturating_add(1);
                                continue;
                            }
                            let mut boarding_state = NO_STATE;
                            if flags & SCAN_CAN_BOARD != 0
                                && many_workspace.stop_generation[stop] == epoch
                                && many_workspace.active_state_mask[stop] != 0
                            {
                                let mut active_states = many_workspace.active_state_mask[stop];
                                while active_states != 0 {
                                    let state_flags = active_states.trailing_zeros() as usize;
                                    active_states &= active_states - 1;
                                    let has_ride = state_flags & 4 != 0;
                                    if has_ride
                                        && state_flags & 1 != 0
                                        && forbidden_same_stop[base_stop] == 1
                                    {
                                        continue;
                                    }
                                    let state = stop * STATE_STRIDE + state_flags;
                                    if boarding_ready_time(
                                        many_workspace.labels[state],
                                        has_ride,
                                        state_flags & 1 != 0,
                                        same_stop_transfer_minimum[base_stop],
                                        transfer_buffer_seconds,
                                    ) <= f64::from(connection_departure)
                                    {
                                        boarding_state = state as i32;
                                        break;
                                    }
                                }
                            }
                            if boarding_state >= 0 {
                                if many_workspace.run_generation[run] != epoch
                                    || (connection as u32)
                                        < many_workspace.run_boarding_connection[run]
                                {
                                    many_workspace.run_generation[run] = epoch;
                                    many_workspace.run_boarding_connection[run] = connection as u32;
                                    many_workspace.run_boarding_state[run] = boarding_state;
                                    stats.expanded_trip_runs =
                                        stats.expanded_trip_runs.saturating_add(1);
                                } else {
                                    stats.dominated_trip_boardings =
                                        stats.dominated_trip_boardings.saturating_add(1);
                                }
                            }
                            if many_workspace.run_generation[run] != epoch {
                                continue;
                            }
                            let boarding = many_workspace.run_boarding_connection[run] as usize;
                            if connection < boarding {
                                continue;
                            }
                            let predecessor = many_workspace.run_boarding_state[run];
                            let board_sequence = scan_journeys[boarding].sequence as f64;
                            let trip = scan_journeys[connection].trip as i32;
                            if connection > boarding && flags & SCAN_BRIDGE_EXIT != 0 {
                                let bridge_stop = output_offset + event.source_stop();
                                let bridge_state = relax_many_record(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    bridge_stop,
                                    f64::from(connection_departure),
                                    true,
                                    true,
                                    true,
                                    input.horizon,
                                    false,
                                    predecessor,
                                    2,
                                    trip,
                                    board_sequence,
                                    scan_journeys[connection].prior_sequence as f64 + 0.5,
                                    0,
                                );
                                if bridge_state >= 0 {
                                    expand_many_combined_transfer_edges_chain(
                                        many_workspace,
                                        epoch,
                                        &mut stats,
                                        base_stop_count,
                                        transfer_offset,
                                        transfer_edges,
                                        &input.supplemental_transfer_offsets,
                                        &supplemental_transfer_edges,
                                        &supplemental_identity_edges,
                                        bridge_stop,
                                        f64::from(connection_departure),
                                        true,
                                        input.horizon,
                                        bridge_state,
                                    );
                                }
                            }
                            let arrival = scan_arrivals[connection];
                            if flags & SCAN_CAN_ALIGHT == 0
                                || f64::from(arrival.arrival) > input.horizon
                            {
                                continue;
                            }
                            let alight_stop = output_offset + arrival.to as usize;
                            let alight_state = relax_many_record(
                                many_workspace,
                                epoch,
                                &mut stats,
                                alight_stop,
                                f64::from(arrival.arrival),
                                true,
                                true,
                                true,
                                input.horizon,
                                false,
                                predecessor,
                                2,
                                trip,
                                board_sequence,
                                scan_journeys[connection].sequence as f64,
                                0,
                            );
                            if alight_state >= 0 {
                                expand_many_combined_transfer_edges_chain(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    base_stop_count,
                                    transfer_offset,
                                    transfer_edges,
                                    &input.supplemental_transfer_offsets,
                                    &supplemental_transfer_edges,
                                    &supplemental_identity_edges,
                                    alight_stop,
                                    f64::from(arrival.arrival),
                                    true,
                                    input.horizon,
                                    alight_state,
                                );
                            }
                        }
                    }
                    base_time_index += 1;
                }

                while overlay_index < compiled.events.len()
                    && compiled.events[overlay_index].departure == connection_departure
                {
                    let event = compiled.events[overlay_index];
                    let rule_stop = input
                        .overlay_base_stops
                        .get(event.from - base_stop_count)
                        .copied()
                        .filter(|stop| *stop >= 0)
                        .map(|stop| stop as usize);
                    for layer in first_layer..=maximum_layer {
                        let input_stop = layer.saturating_sub(1) * combined_stop_count + event.from;
                        let output_stop = layer * combined_stop_count + event.to;
                        let run = layer * combined_run_count + base_run_count + event.run;
                        stats.scanned_departures = stats.scanned_departures.saturating_add(1);
                        let mut boarding_state = NO_STATE;
                        if event.can_board
                            && many_workspace.stop_generation[input_stop] == epoch
                            && many_workspace.active_state_mask[input_stop] != 0
                        {
                            let mut active_states = many_workspace.active_state_mask[input_stop];
                            while active_states != 0 {
                                let state_flags = active_states.trailing_zeros() as usize;
                                active_states &= active_states - 1;
                                let has_ride = state_flags & 4 != 0;
                                let state = input_stop * STATE_STRIDE + state_flags;
                                if has_ride
                                    && state_flags & 1 != 0
                                    && rule_stop.is_some_and(|stop| forbidden_same_stop[stop] == 1)
                                {
                                    continue;
                                }
                                if boarding_ready_time(
                                    many_workspace.labels[state],
                                    has_ride,
                                    state_flags & 1 != 0,
                                    rule_stop.map_or(0, |stop| same_stop_transfer_minimum[stop]),
                                    transfer_buffer_seconds,
                                ) <= f64::from(event.departure)
                                {
                                    boarding_state = state as i32;
                                    break;
                                }
                            }
                        }
                        if boarding_state >= 0 {
                            if many_workspace.run_generation[run] != epoch
                                || (overlay_index as u32)
                                    < many_workspace.run_boarding_connection[run]
                            {
                                many_workspace.run_generation[run] = epoch;
                                many_workspace.run_boarding_connection[run] = overlay_index as u32;
                                many_workspace.run_boarding_state[run] = boarding_state;
                                stats.expanded_trip_runs =
                                    stats.expanded_trip_runs.saturating_add(1);
                            } else {
                                stats.dominated_trip_boardings =
                                    stats.dominated_trip_boardings.saturating_add(1);
                            }
                        }
                        if many_workspace.run_generation[run] == epoch
                            && overlay_index >= many_workspace.run_boarding_connection[run] as usize
                            && event.can_alight
                            && f64::from(event.arrival) <= input.horizon
                        {
                            let boarding = many_workspace.run_boarding_connection[run] as usize;
                            let predecessor = many_workspace.run_boarding_state[run];
                            let boarding_event = compiled.events[boarding];
                            let overlay_trip = -(event.run as i32) - 2;
                            let alight_state = relax_many_record(
                                many_workspace,
                                epoch,
                                &mut stats,
                                output_stop,
                                f64::from(event.arrival),
                                true,
                                true,
                                true,
                                input.horizon,
                                false,
                                predecessor,
                                2,
                                overlay_trip,
                                boarding_event.sequence as f64,
                                event.sequence as f64,
                                0,
                            );
                            if alight_state >= 0 {
                                expand_many_combined_transfer_edges_chain(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    base_stop_count,
                                    transfer_offset,
                                    transfer_edges,
                                    &input.supplemental_transfer_offsets,
                                    &supplemental_transfer_edges,
                                    &supplemental_identity_edges,
                                    output_stop,
                                    f64::from(event.arrival),
                                    true,
                                    input.horizon,
                                    alight_state,
                                );
                            }
                        }
                    }
                    overlay_index += 1;
                }
                if !needs_closure
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
        }

        let mut best_arrivals = vec![f64::INFINITY; destination_count];
        let mut best_state = NO_STATE;
        let mut best_destination_index = NO_STATE;
        let mut best_overall_arrival = f64::INFINITY;
        for (destination, best) in best_arrivals.iter_mut().enumerate() {
            let start = input.destination_offsets[destination] as usize;
            let end = input.destination_offsets[destination + 1] as usize;
            for seed in start..end {
                for layer in first_layer..=maximum_layer {
                    let stop = layer * combined_stop_count + input.destination_stops[seed] as usize;
                    for flags in [6_usize, 7] {
                        if flags == 6
                            && input
                                .allow_post_ride_transfers
                                .as_ref()
                                .is_some_and(|allowed| !allowed[destination])
                        {
                            continue;
                        }
                        let state = stop * STATE_STRIDE + flags;
                        if many_workspace.state_generation[state] != epoch {
                            continue;
                        }
                        let arrival =
                            many_workspace.labels[state] + input.destination_walk_seconds[seed];
                        if arrival < *best {
                            *best = arrival;
                        }
                        let candidate_index = destination_candidate_indices
                            .and_then(|indices| indices.get(seed).copied())
                            .unwrap_or(seed as u32)
                            as i32;
                        if arrival < best_overall_arrival
                            || (arrival == best_overall_arrival
                                && (best_destination_index < 0
                                    || candidate_index < best_destination_index))
                        {
                            best_overall_arrival = arrival;
                            best_state = state as i32;
                            best_destination_index = candidate_index;
                        }
                    }
                }
            }
        }
        let mut chain = Vec::<JourneyChainStep>::new();
        if best_state >= 0 {
            let mut state = best_state;
            while state >= 0 {
                let state_index = state as usize;
                let predecessor_record = many_workspace.predecessors[state_index];
                let stop = ((state_index / STATE_STRIDE) % combined_stop_count) as i32;
                if predecessor_record.kind == 3 {
                    chain.push((
                        3,
                        NO_STATE,
                        stop,
                        predecessor_record.trip,
                        0.0,
                        0.0,
                        predecessor_record.duration,
                        many_workspace.labels[state_index],
                    ));
                    break;
                }
                let predecessor = predecessor_record.state;
                if predecessor < 0 {
                    break;
                }
                chain.push((
                    predecessor_record.kind as u32,
                    ((predecessor as usize / STATE_STRIDE) % combined_stop_count) as i32,
                    stop,
                    predecessor_record.trip,
                    f64::from(predecessor_record.board_sequence_twice) * 0.5,
                    f64::from(predecessor_record.alight_sequence_twice) * 0.5,
                    predecessor_record.duration,
                    many_workspace.labels[state_index],
                ));
                state = predecessor;
            }
            chain.reverse();
        }
        let workspace_bytes = many_workspace.byte_length() as f64;
        many_workspace.predecessors = Vec::new();
        many_workspace.run_boarding_state = Vec::new();
        let scan_ns = scan_started.elapsed().as_nanos() as f64;
        let mut lexicographic_certified = false;
        let mut quality_query_ns = 0.0;
        let mut quality_bytes = 0.0;
        let mut quality_reason = None;
        if input.certify_journey == Some(true) && destination_count == 1 && best_state >= 0 {
            let quality_started = Instant::now();
            match overlay_quality::certify(
                self,
                &input,
                &compiled,
                &chain,
                best_overall_arrival,
                best_destination_index as u32,
            ) {
                Ok(quality) => {
                    let result = quality.result;
                    if result.improved_candidate {
                        chain = (0..result.chain_kinds.len())
                            .map(|index| {
                                (
                                    result.chain_kinds[index],
                                    result.chain_from_stops[index],
                                    result.chain_to_stops[index],
                                    result.chain_trip_or_candidate[index],
                                    result.chain_board_sequences[index],
                                    result.chain_alight_sequences[index],
                                    result.chain_durations[index],
                                    result.chain_arrivals[index],
                                )
                            })
                            .collect();
                        best_destination_index = result.best_destination_index.unwrap() as i32;
                    }
                    quality_bytes = quality.bytes;
                    lexicographic_certified = true;
                }
                // Retain the live earliest-arrival witness on a resource or
                // certification failure, never silently restore cancelled trips.
                Err(error) => quality_reason = Some(error.reason),
            }
            quality_query_ns = quality_started.elapsed().as_nanos() as f64;
        }
        Ok(TimetableOverlayManyQueryResult {
            timetable: TimetableManyQueryResult {
                supported: true,
                status: "complete".to_owned(),
                reason: None,
                algorithm: "rust_resident_query_overlay_connection_scan_one_to_many".to_owned(),
                best_arrivals,
                best_destination_index: (best_destination_index >= 0)
                    .then_some(best_destination_index as u32),
                chain_kinds: chain.iter().map(|step| step.0).collect(),
                chain_from_stops: chain.iter().map(|step| step.1).collect(),
                chain_to_stops: chain.iter().map(|step| step.2).collect(),
                chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
                chain_board_sequences: chain.iter().map(|step| step.4).collect(),
                chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
                chain_durations: chain.iter().map(|step| step.6).collect(),
                chain_arrivals: chain.iter().map(|step| step.7).collect(),
                query_ns: started.elapsed().as_nanos() as f64,
                scanned_departures: stats.scanned_departures,
                excluded_departures,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: stats.expanded_trip_runs,
                dominated_trip_boardings: stats.dominated_trip_boardings,
                explicit_transfer_checks: stats.explicit_transfer_checks,
            },
            overlay_connections: compiled.events.len() as u32,
            overlay_runs: compiled.run_count as u32,
            overlay_run_directions: compiled.run_directions,
            supplemental_transfer_edges: input.supplemental_transfer_to.len() as u32,
            compile_ns,
            scan_ns,
            transient_bytes: transient_bytes as f64,
            workspace_bytes,
            lexicographic_certified,
            quality_query_ns,
            quality_bytes,
            quality_reason,
        })
    }
}
