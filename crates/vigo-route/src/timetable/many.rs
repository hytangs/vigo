use super::*;
use std::collections::HashMap;

impl TimetableKernel {
    /// One destination and deadline, shared by every origin. Reverse labels
    /// retain the latest feasible first boarding at each stop; endpoint access
    /// and its permitted single pre-ride transfer bound the scan as soon as
    /// every endpoint is settled. The scalar workspace is reused without stop-sized
    /// allocations or a timetable scan per origin.
    pub fn route_arrive_by_many_csa(
        &mut self,
        input: TimetableArriveByManyQueryInput,
    ) -> Result<TimetableArriveByManyQueryResult> {
        self.route_arrive_by_many_csa_impl(&input)
    }

    pub(super) fn route_arrive_by_many_csa_impl(
        &mut self,
        input: &TimetableArriveByManyQueryInput,
    ) -> Result<TimetableArriveByManyQueryResult> {
        let started = Instant::now();
        let origin_count = input.origin_offsets.len().saturating_sub(1);
        if origin_count == 0
            || origin_count > crate::MAXIMUM_MATRIX_PAIRS
            || input.origin_offsets[0] != 0
            || input.origin_offsets[origin_count] as usize != input.origin_stops.len()
            || input
                .origin_offsets
                .windows(2)
                .any(|pair| pair[0] > pair[1])
            || input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.allow_pre_ride_transfers.len() != origin_count
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input
                .origin_stops
                .iter()
                .chain(&input.destination_stops)
                .any(|stop| *stop as usize >= self.stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(&input.destination_walk_seconds)
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || input.excluded_trips.iter().any(|trip| {
                *trip as usize >= self.query.many_workspace.excluded_trip_generation.len()
            })
            || !input.earliest.is_finite()
            || input.earliest < 0.0
            || !input.deadline.is_finite()
            || input.deadline < input.earliest
        {
            return Err(Error::from_reason(
                "Rust arrive-by many-to-one query arrays or bounds are inconsistent.",
            ));
        }
        if self.service.is_some() {
            let safe = self.ordinary_reverse_is_safe(
                &input.destination_stops,
                &input.destination_walk_seconds,
                input.earliest,
                input.deadline,
                input.allow_post_ride_transfers.unwrap_or(true),
                input.maximum_boardings,
                &input.excluded_trips,
            )?;
            let mut result = if safe {
                let service = self.service.take();
                let result = self.route_arrive_by_many_csa_impl(input);
                self.service = service;
                self.record_ordinary_search();
                result?
            } else {
                self.service_arrive_many(input)?
            };
            result.query_ns = started.elapsed().as_nanos() as f64;
            return Ok(result);
        }
        let forbidden_same_stop = self.forbidden_same_stop.as_ref();
        let maximum_layer = boarding_layers(input.maximum_boardings)?;
        let first_layer = usize::from(input.maximum_boardings.is_some());
        let workspace = &mut self.query.workspace;
        workspace.ensure_dimensions(
            self.stop_count * (maximum_layer + 1),
            self.run_count * (maximum_layer + 1),
        );
        let epoch = workspace.begin_query();
        let excluded_epoch = self.query.many_workspace.begin_query();
        for trip in &input.excluded_trips {
            self.query.many_workspace.excluded_trip_generation[*trip as usize] = excluded_epoch;
        }
        // Both directions share the same endpoint-bound accumulator. Reverse
        // times are negated so improving a departure is also minimization.
        // Keep the allocation-free single-origin path used by point queries.
        let mut terminals = (origin_count > 1).then(|| Terminals::new(origin_count));
        let mut minimum_origin_offset = f64::INFINITY;
        let mut stats = SearchStats::default();
        for origin in 0..origin_count {
            let range =
                input.origin_offsets[origin] as usize..input.origin_offsets[origin + 1] as usize;
            for seed in range {
                let stop = input.origin_stops[seed] as usize;
                let walk = input.origin_walk_seconds[seed];
                retain_reverse_origin_offset(workspace, epoch, stop, walk);
                minimum_origin_offset = minimum_origin_offset.min(walk);
                if let Some(targets) = &mut terminals {
                    targets.add(stop, origin, walk);
                }
                if input.allow_pre_ride_transfers[origin] {
                    let edges = &self.transfer_edges[self.transfer_offset[stop] as usize
                        ..self.transfer_offset[stop + 1] as usize];
                    stats.explicit_transfer_checks = stats
                        .explicit_transfer_checks
                        .saturating_add(edges.len() as u32);
                    for edge in edges {
                        let offset = walk + f64::from(edge.duration());
                        retain_reverse_origin_offset(workspace, epoch, edge.stop(), offset);
                        minimum_origin_offset = minimum_origin_offset.min(offset);
                        if let Some(targets) = &mut terminals {
                            targets.add(edge.stop(), origin, offset);
                        }
                    }
                }
            }
        }
        if let Some(targets) = &mut terminals {
            targets.finish();
        }
        let mut latest_origin_departure = f64::NEG_INFINITY;
        let mut excluded_departures = 0_u32;
        let mut latest_destination_deadline = f64::NEG_INFINITY;
        for (stop, walk) in input
            .destination_stops
            .iter()
            .zip(&input.destination_walk_seconds)
        {
            let deadline = input.deadline - walk;
            if deadline < input.earliest {
                continue;
            }
            latest_destination_deadline = latest_destination_deadline.max(deadline);
            relax_reverse_post_ride_deadline(
                workspace,
                epoch,
                &mut stats,
                *stop as usize,
                deadline,
                input.earliest,
            );
            if input.allow_post_ride_transfers.unwrap_or(true) {
                relax_reverse_transfer_target_deadline(
                    workspace,
                    epoch,
                    &mut stats,
                    *stop as usize,
                    deadline,
                    input.earliest,
                    &self.reverse_transfer_offset,
                    &self.reverse_transfer_edges,
                );
            }
        }
        let first_time = scan_time_lower_bound(&self.scan_times, input.earliest);
        let time_end = scan_time_upper_bound(&self.scan_times, latest_destination_deadline);
        for time_index in (first_time..time_end).rev() {
            let departure = f64::from(self.scan_times[time_index]);
            if terminals.as_ref().map_or_else(
                || departure - minimum_origin_offset <= latest_origin_departure,
                |targets| -departure > targets.cutoff,
            ) {
                break;
            }
            let start = self.scan_time_offsets[time_index] as usize;
            let end = self.scan_time_offsets[time_index + 1] as usize;
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures = stats
                    .scanned_departures
                    .saturating_add(((end - start) * (maximum_layer + 1 - first_layer)) as u32);
                for connection in (start..end).rev() {
                    if !input.excluded_trips.is_empty()
                        && self.query.many_workspace.excluded_trip_generation
                            [self.scan_journeys[connection].trip as usize]
                            == excluded_epoch
                    {
                        excluded_departures = excluded_departures.saturating_add(1);
                        continue;
                    }
                    let event = self.scan_events[connection];
                    let arrival = self.scan_arrivals[connection];
                    // A connection cannot enter any boarding layer until its
                    // run or an exit stop has a suffix to the destination.
                    // This union is updated immediately, including during
                    // equal-time closure; all layer-specific checks remain.
                    if workspace.reverse_reached_runs[event.run()] != epoch
                        && workspace.reverse_reached_stops[arrival.to as usize] != epoch
                        && (event.flags() & SCAN_BRIDGE_EXIT == 0
                            || workspace.reverse_reached_stops[event.source_stop()] != epoch)
                    {
                        continue;
                    }
                    for layer in first_layer..=maximum_layer {
                        let input_offset = layer.saturating_sub(1) * self.stop_count;
                        let output_offset = layer * self.stop_count;
                        let event = self.scan_events[connection];
                        let flags = event.flags();
                        let base_stop = event.source_stop();
                        let stop = output_offset + base_stop;
                        let exit_stop = input_offset + base_stop;
                        let run = layer * self.run_count + event.run();
                        let arrival = self.scan_arrivals[connection];
                        let run_was_feasible = workspace.run_generation[run] == epoch
                            && workspace.expanded_run_start[run] >= connection as i32;
                        let direct_exit_feasible = flags & SCAN_CAN_ALIGHT != 0
                            && workspace.destination_generation[input_offset + arrival.to as usize]
                                == epoch
                            && f64::from(arrival.arrival)
                                <= workspace.destination_egress[input_offset + arrival.to as usize];
                        if flags & SCAN_CAN_BOARD != 0 && (run_was_feasible || direct_exit_feasible)
                        {
                            let access =
                                workspace.labels[base_stop * STATE_STRIDE + (STATE_STRIDE - 2)];
                            if access.generation == epoch {
                                if let Some(targets) = &mut terminals {
                                    targets.reach(base_stop, -departure);
                                } else {
                                    latest_origin_departure =
                                        latest_origin_departure.max(departure - access.arrival);
                                }
                            }
                            if transfer_allowed(forbidden_same_stop[base_stop] != 0, None, false) {
                                relax_reverse_post_ride_deadline(
                                    workspace,
                                    epoch,
                                    &mut stats,
                                    stop,
                                    transfer_ready_time::<true>(
                                        departure,
                                        departure,
                                        self.same_stop_transfer_minimum[base_stop],
                                        self.minimum_transfer_buffer_seconds,
                                    ),
                                    input.earliest,
                                );
                            }
                            relax_reverse_transfer_target_deadline(
                                workspace,
                                epoch,
                                &mut stats,
                                stop,
                                departure - f64::from(self.minimum_transfer_buffer_seconds),
                                input.earliest,
                                &self.reverse_transfer_offset,
                                &self.reverse_transfer_edges,
                            );
                        }
                        let bridge_exit_feasible = flags & SCAN_BRIDGE_EXIT != 0
                            && workspace.destination_generation[exit_stop] == epoch
                            && departure <= workspace.destination_egress[exit_stop];
                        let exit_connection = if direct_exit_feasible {
                            connection as i32
                        } else {
                            connection as i32 - 1
                        };
                        if (direct_exit_feasible || bridge_exit_feasible)
                            && (workspace.run_generation[run] != epoch
                                || exit_connection > workspace.expanded_run_start[run])
                        {
                            workspace.run_generation[run] = epoch;
                            workspace.reverse_reached_runs[event.run()] = epoch;
                            workspace.expanded_run_start[run] = exit_connection;
                            stats.expanded_trip_runs = stats.expanded_trip_runs.saturating_add(1);
                        } else if run_was_feasible && flags & SCAN_CAN_BOARD != 0 {
                            stats.dominated_trip_boardings =
                                stats.dominated_trip_boardings.saturating_add(1);
                        }
                    }
                }
                if !self.scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
        }
        let mut latest_departures = match terminals {
            Some(targets) => targets.bounds.into_iter().map(|time| -time).collect(),
            None => vec![latest_origin_departure],
        };
        for latest in &mut latest_departures {
            if *latest < input.earliest {
                *latest = f64::NEG_INFINITY;
            }
        }
        Ok(TimetableArriveByManyQueryResult {
            latest_departures,
            query_ns: started.elapsed().as_nanos() as f64,
            scanned_departures: stats.scanned_departures,
            excluded_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }
    pub fn route_many_csa(
        &mut self,
        input: TimetableManyQueryInput,
    ) -> Result<TimetableManyQueryResult> {
        self.route_many_csa_impl(&input)
    }

    /// One-to-many twin of `route_scalar_relaxed_csa`, with the same bound.
    pub fn route_many_relaxed_csa(
        &mut self,
        input: &TimetableManyQueryInput,
    ) -> Result<Option<TimetableManyQueryResult>> {
        self.relaxed(|kernel| kernel.route_many_csa_impl(input))
    }

    pub(super) fn route_many_csa_impl(
        &mut self,
        input: &TimetableManyQueryInput,
    ) -> Result<TimetableManyQueryResult> {
        let started = Instant::now();
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
                .any(|stop| *stop as usize >= self.stop_count)
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
                "Rust one-to-many timetable query arrays or bounds are inconsistent.",
            ));
        }

        if self.service.is_some() {
            let safe = self.ordinary_forward_is_safe(
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.departure,
                input.horizon,
                input.allow_pre_ride_transfers,
                input.maximum_boardings,
                &input.excluded_trips,
            )?;
            let mut result = if safe {
                let service = self.service.take();
                let result = self.route_many_csa_impl(input);
                self.service = service;
                self.record_ordinary_search();
                result?
            } else {
                self.windowed_service_many(input)?
            };
            result.query_ns = started.elapsed().as_nanos() as f64;
            return Ok(result);
        }
        let maximum_layer = boarding_layers(input.maximum_boardings)?;
        let first_layer = usize::from(input.maximum_boardings.is_some());
        let base_stop_count = self.stop_count;
        let base_run_count = self.run_count;
        self.query.many_workspace.ensure_dimensions(
            base_stop_count * (maximum_layer + 1),
            base_run_count * (maximum_layer + 1),
        );

        let transfer_buffer_seconds = self.minimum_transfer_buffer_seconds;
        let Self {
            service: _,
            relaxed_graph: _,
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
            departure_offset,
            departure_events,
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
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset: _,
            exit_events: _,
            query:
                TimetableQueryWorkspace {
                    workspace: destination_workspace,
                    many_workspace,
                    forward_workspace: _,
                    profile_workspace: _,
                    journey_workspace: _,
                },
        } = self;
        let forbidden_same_stop = forbidden_same_stop.as_ref();
        // Every target keeps the best arrival found so far: an alighting at
        // one of its stops, or one transfer before it, plus the walk out. Once
        // no later departure can improve any target, the scan stops. This is
        // the final read-out below, bounded early; it never changes a result.
        let destination_epoch = destination_workspace.begin_query();
        let mut terminals = Terminals::new(destination_count);
        for destination in 0..destination_count {
            let start = input.destination_offsets[destination] as usize;
            let end = input.destination_offsets[destination + 1] as usize;
            let transfers = input
                .allow_post_ride_transfers
                .as_ref()
                .is_none_or(|allowed| allowed[destination]);
            for seed in start..end {
                let target = input.destination_stops[seed] as usize;
                let walk = input.destination_walk_seconds[seed];
                terminals.add(target, destination, walk);
                if transfers {
                    for edge in &reverse_transfer_edges[reverse_transfer_offset[target] as usize
                        ..reverse_transfer_offset[target + 1] as usize]
                    {
                        terminals.add(edge.stop(), destination, walk + f64::from(edge.duration()));
                    }
                }
            }
        }
        for &stop in terminals.entries.keys() {
            destination_workspace.destination_generation[stop] = destination_epoch;
        }
        terminals.finish();
        let is_terminal =
            |stop: usize| destination_workspace.destination_generation[stop] == destination_epoch;
        let epoch = many_workspace.begin_query();
        let has_excluded_trips = !input.excluded_trips.is_empty();
        for trip in &input.excluded_trips {
            many_workspace.excluded_trip_generation[*trip as usize] = epoch;
        }
        let mut stats = SearchStats::default();
        let mut excluded_departures = 0_u32;
        let mut origin_seeds = 0_u32;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            if !relax_many(
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
            ) {
                continue;
            }
            origin_seeds = origin_seeds.saturating_add(1);
            if input.allow_pre_ride_transfers {
                expand_many_transfer_edges(
                    many_workspace,
                    epoch,
                    &mut stats,
                    transfer_offset,
                    transfer_edges,
                    stop,
                    arrival,
                    false,
                    input.horizon,
                );
            }
        }
        if origin_seeds == 0 {
            return Ok(TimetableManyQueryResult {
                supported: false,
                status: "unsupported".to_owned(),
                reason: Some("origin_outside_kernel".to_owned()),
                algorithm: "rust_resident_generation_tagged_connection_scan_one_to_many".to_owned(),
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
            });
        }

        // Coordinate access cannot board before its endpoint walk reaches an
        // origin stop. Start at the first indexed departure that any origin
        // can board; earlier timetable events are provably irrelevant.
        let scan_start = if input.allow_pre_ride_transfers {
            input.departure
        } else {
            earliest_boardable_departure(
                departure_offset,
                departure_events,
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.departure,
            )
        };
        let mut time_index = scan_time_lower_bound(scan_times, scan_start);
        while time_index < scan_times.len() {
            let connection_departure = scan_times[time_index] as f64;
            if connection_departure > input.horizon || connection_departure > terminals.cutoff {
                break;
            }
            let start = scan_time_offsets[time_index] as usize;
            let end = scan_time_offsets[time_index + 1] as usize;
            let bucket_events = &scan_events[start..end];
            let bucket_arrivals = &scan_arrivals[start..end];
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures = stats
                    .scanned_departures
                    .saturating_add(((end - start) * (maximum_layer + 1 - first_layer)) as u32);
                for (offset, (&event, &arrival)) in
                    bucket_events.iter().zip(bucket_arrivals).enumerate()
                {
                    for layer in first_layer..=maximum_layer {
                        let output_offset = layer * base_stop_count;
                        let input_offset = layer.saturating_sub(1) * base_stop_count;
                        let connection = start + offset;
                        let flags = event.flags();
                        let base_stop = event.source_stop();
                        let stop = input_offset + base_stop;
                        let run = layer * base_run_count + event.run();
                        if has_excluded_trips {
                            let trip = scan_journeys[connection].trip as usize;
                            if many_workspace.excluded_trip_generation[trip] == epoch {
                                excluded_departures = excluded_departures.saturating_add(1);
                                continue;
                            }
                        }
                        if flags & SCAN_CAN_BOARD != 0
                            && many_workspace.stop_generation[stop] == epoch
                            && many_workspace.active_state_mask[stop] != 0
                        {
                            let mut active_states = many_workspace.active_state_mask[stop];
                            let mut boardable = false;
                            while active_states != 0 {
                                let state_flags = active_states.trailing_zeros() as usize;
                                active_states &= active_states - 1;
                                let has_ride = state_flags & 4 != 0;
                                if has_ride
                                    && state_flags & 1 != 0
                                    && !transfer_allowed(
                                        forbidden_same_stop[base_stop] != 0,
                                        None,
                                        false,
                                    )
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
                                ) <= connection_departure
                                {
                                    boardable = true;
                                    break;
                                }
                            }
                            if boardable {
                                if many_workspace.run_generation[run] != epoch
                                    || (connection as u32)
                                        < many_workspace.run_boarding_connection[run]
                                {
                                    many_workspace.run_generation[run] = epoch;
                                    many_workspace.run_boarding_connection[run] = connection as u32;
                                    stats.expanded_trip_runs =
                                        stats.expanded_trip_runs.saturating_add(1);
                                } else {
                                    stats.dominated_trip_boardings =
                                        stats.dominated_trip_boardings.saturating_add(1);
                                }
                            }
                        }
                        if many_workspace.run_generation[run] != epoch {
                            continue;
                        }
                        let boarding = many_workspace.run_boarding_connection[run] as usize;
                        if connection < boarding {
                            continue;
                        }
                        if connection > boarding && flags & SCAN_BRIDGE_EXIT != 0 {
                            if is_terminal(event.source_stop()) {
                                terminals.reach(event.source_stop(), connection_departure);
                            }
                            let bridge_stop = output_offset + event.source_stop();
                            if relax_many(
                                many_workspace,
                                epoch,
                                &mut stats,
                                bridge_stop,
                                connection_departure,
                                true,
                                true,
                                true,
                                input.horizon,
                                false,
                            ) {
                                expand_many_transfer_edges(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    transfer_offset,
                                    transfer_edges,
                                    bridge_stop,
                                    connection_departure,
                                    true,
                                    input.horizon,
                                );
                            }
                        }
                        if flags & SCAN_CAN_ALIGHT == 0 || arrival.arrival as f64 > input.horizon {
                            continue;
                        }
                        if is_terminal(arrival.to as usize) {
                            terminals.reach(arrival.to as usize, f64::from(arrival.arrival));
                        }
                        let alight_stop = output_offset + arrival.to as usize;
                        if relax_many(
                            many_workspace,
                            epoch,
                            &mut stats,
                            alight_stop,
                            arrival.arrival as f64,
                            true,
                            true,
                            true,
                            input.horizon,
                            false,
                        ) {
                            expand_many_transfer_edges(
                                many_workspace,
                                epoch,
                                &mut stats,
                                transfer_offset,
                                transfer_edges,
                                alight_stop,
                                arrival.arrival as f64,
                                true,
                                input.horizon,
                            );
                        }
                    }
                }
                if !scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
            time_index += 1;
        }

        let mut best_arrivals = vec![f64::INFINITY; destination_count];
        for (destination, best) in best_arrivals.iter_mut().enumerate() {
            let start = input.destination_offsets[destination] as usize;
            let end = input.destination_offsets[destination + 1] as usize;
            for seed in start..end {
                for layer in first_layer..=maximum_layer {
                    let stop = layer * base_stop_count + input.destination_stops[seed] as usize;
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
                        // The horizon bounds the timetable scan. As in the scalar
                        // point operator, a terminal destination egress may finish
                        // after that boundary once its final ride has alighted
                        // within the scan horizon.
                        if arrival < *best {
                            *best = arrival;
                        }
                    }
                }
            }
        }
        Ok(TimetableManyQueryResult {
            supported: true,
            status: "complete".to_owned(),
            reason: None,
            algorithm: "rust_resident_generation_tagged_connection_scan_one_to_many".to_owned(),
            best_arrivals,
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
            scanned_departures: stats.scanned_departures,
            excluded_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }
}

/// Endpoint bounds shared by forward and reverse batch scans. Reverse scans
/// supply negated departures; endpoint walking offsets stay nonnegative.
struct Terminals {
    /// Stop to (target, walk from the stop to the target's endpoint).
    entries: HashMap<usize, Vec<(usize, f64)>>,
    bounds: Vec<f64>,
    minimum_offset: Vec<f64>,
    /// Targets with stops but no arrival yet; the cutoff waits for them.
    unreached: usize,
    /// Scan times after this (negated in reverse) cannot improve a target.
    cutoff: f64,
}

impl Terminals {
    fn new(count: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bounds: vec![f64::INFINITY; count],
            minimum_offset: vec![f64::INFINITY; count],
            unreached: 0,
            cutoff: f64::INFINITY,
        }
    }
    fn finish(&mut self) {
        // Empty endpoint frontiers are known unreachable and need no scan.
        self.unreached = self
            .minimum_offset
            .iter()
            .filter(|walk| walk.is_finite())
            .count();
        if self.unreached == 0 {
            self.cutoff = f64::NEG_INFINITY;
        }
    }
    fn add(&mut self, stop: usize, destination: usize, egress: f64) {
        self.minimum_offset[destination] = self.minimum_offset[destination].min(egress);
        let entry = self.entries.entry(stop).or_default();
        match entry.iter_mut().find(|(d, _)| *d == destination) {
            Some((_, walk)) => *walk = walk.min(egress),
            None => entry.push((destination, egress)),
        }
    }
    /// A feasible ride reached an endpoint candidate at the signed scan time.
    fn reach(&mut self, stop: usize, time: f64) {
        let mut improved = false;
        for &(destination, egress) in &self.entries[&stop] {
            if time + egress < self.bounds[destination] {
                if self.bounds[destination].is_infinite() {
                    self.unreached -= 1;
                }
                self.bounds[destination] = time + egress;
                improved = true;
            }
        }
        if improved && self.unreached == 0 {
            // Future scan events cannot beat this endpoint's bound even with
            // its smallest access/egress walk. All reachable targets must agree.
            self.cutoff = self
                .bounds
                .iter()
                .zip(&self.minimum_offset)
                .filter(|(_, walk)| walk.is_finite())
                .map(|(bound, walk)| bound - walk)
                .fold(f64::NEG_INFINITY, f64::max);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOCK: u32 = 2_000;
    // Each edge is a distinct trip. Mirroring swaps boarding/alighting, the
    // direction of directed walking edges, and both event clocks.
    fn kernel(edges: &[(u32, u32, u32, u32)], mirror: bool, buffer: u32) -> TimetableKernel {
        let edges: Vec<_> = edges
            .iter()
            .map(|&(from, to, dep, arr)| {
                if mirror {
                    (to, from, CLOCK - arr, CLOCK - dep)
                } else {
                    (from, to, dep, arr)
                }
            })
            .collect();
        let count = edges.len() as u32;
        let mut order: Vec<u32> = (0..count).collect();
        order.sort_by_key(|&i| (edges[i as usize].0, edges[i as usize].2));
        let offset: Vec<u32> = (0..=7)
            .map(|stop| edges.iter().filter(|e| e.0 < stop).count() as u32)
            .collect();
        let mut transfers = if mirror {
            vec![(0, 4, 7), (5, 2, 9)]
        } else {
            vec![(4, 0, 7), (2, 5, 9)]
        };
        transfers.sort_by_key(|e| e.0);
        TimetableKernel::new(TimetableKernelInput {
            stop_count: 7,
            run_count: count,
            departure_seconds: edges.iter().map(|e| e.2).collect::<Vec<_>>().into(),
            arrival_seconds: edges.iter().map(|e| e.3).collect::<Vec<_>>().into(),
            from_stop: edges.iter().map(|e| e.0).collect::<Vec<_>>().into(),
            to_stop: edges.iter().map(|e| e.1).collect::<Vec<_>>().into(),
            sequence: vec![1; count as usize].into(),
            segment_trip: (0..count).collect::<Vec<_>>().into(),
            segment_run: (0..count).collect::<Vec<_>>().into(),
            continuity_break: vec![1; count as usize].into(),
            can_board: vec![1; count as usize].into(),
            can_alight: vec![1; count as usize].into(),
            trip_start: (0..=count).collect::<Vec<_>>().into(),
            departure_offset: offset.into(),
            departure_order: order.into(),
            transfer_offset: (0..=7)
                .map(|stop| transfers.iter().filter(|e| e.0 < stop).count() as u32)
                .collect::<Vec<_>>()
                .into(),
            transfer_to: transfers.iter().map(|e| e.1).collect::<Vec<_>>().into(),
            transfer_duration: transfers.iter().map(|e| e.2).collect::<Vec<_>>().into(),
            forbidden_same_stop: vec![0; 7].into(),
            same_stop_transfer_minimum: None,
            minimum_transfer_buffer_seconds: Some(buffer),
        })
        .unwrap()
    }

    fn request() -> TimetableArriveByManyQueryInput {
        TimetableArriveByManyQueryInput {
            origin_offsets: vec![0, 2, 3, 4, 4],
            origin_stops: vec![0, 0, 1, 4],
            origin_walk_seconds: vec![13., 3., 5., 2.],
            allow_pre_ride_transfers: vec![false, false, true, true],
            destination_stops: vec![5],
            destination_walk_seconds: vec![11.],
            earliest: 0.,
            deadline: 1_900.,
            excluded_trips: vec![],
            allow_post_ride_transfers: Some(true),
            maximum_boardings: None,
        }
    }

    #[test]
    fn reverse_batch_matches_mirrored_forward_and_unpruned_scan() {
        let mut edges = vec![
            (0, 1, 1_700, 1_700),
            (1, 2, 1_700, 1_700),
            (0, 2, 1_600, 1_800),
        ];
        let mut random = 73_u32;
        for _ in 0..160 {
            let mut next = || {
                random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                random
            };
            let from = next() % 3;
            let to = (from + 1 + next() % 2) % 3;
            let dep = 100 + next() % 1_600;
            let arr = dep + next() % 180;
            edges.push((from, to, dep, arr));
        }
        for buffer in [0, 17] {
            let mut reverse = kernel(&edges, false, buffer);
            let mut forward = kernel(&edges, true, buffer);
            for cap in [None, Some(1), Some(2), Some(4)] {
                for deadline in [900., 1_700., 1_900.] {
                    for post in [false, true] {
                        for excluded in [vec![], vec![0, 2, 40]] {
                            let mut input = request();
                            input.maximum_boardings = cap;
                            input.deadline = deadline;
                            input.allow_post_ride_transfers = Some(post);
                            input.excluded_trips = excluded;
                            let result = reverse.route_arrive_by_many_csa_impl(&input).unwrap();
                            let reflected = forward
                                .route_many_csa(TimetableManyQueryInput {
                                    origin_stops: input.destination_stops.clone(),
                                    origin_walk_seconds: input.destination_walk_seconds.clone(),
                                    destination_offsets: input.origin_offsets.clone(),
                                    destination_stops: input.origin_stops.clone(),
                                    destination_walk_seconds: input.origin_walk_seconds.clone(),
                                    excluded_trips: input.excluded_trips.clone(),
                                    departure: f64::from(CLOCK) - input.deadline,
                                    horizon: f64::from(CLOCK) - input.earliest,
                                    allow_pre_ride_transfers: post,
                                    allow_post_ride_transfers: Some(
                                        input.allow_pre_ride_transfers.clone(),
                                    ),
                                    maximum_boardings: cap,
                                })
                                .unwrap();
                            let expected: Vec<_> = reflected
                                .best_arrivals
                                .iter()
                                .map(|t| f64::from(CLOCK) - t)
                                .collect();
                            assert_eq!(
                                result.latest_departures, expected,
                                "buffer={buffer} cap={cap:?} deadline={deadline} post={post}"
                            );
                            // A real but disconnected origin prevents the cutoff. Its
                            // presence must not change any other endpoint's answer.
                            input.origin_stops.push(6);
                            input.origin_walk_seconds.push(0.);
                            input.origin_offsets.push(input.origin_stops.len() as u32);
                            input.allow_pre_ride_transfers.push(true);
                            let full = reverse.route_arrive_by_many_csa_impl(&input).unwrap();
                            assert_eq!(result.latest_departures, full.latest_departures[..4]);
                            // Reusing the same workspace for a scalar must clear all
                            // bulk markers and preserve the minimum duplicate offset.
                            input.origin_offsets = vec![0, 2];
                            input.origin_stops.truncate(2);
                            input.origin_walk_seconds.truncate(2);
                            input.allow_pre_ride_transfers = vec![false];
                            let scalar = reverse.route_arrive_by_many_csa_impl(&input).unwrap();
                            assert_eq!(scalar.latest_departures[0], expected[0]);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn reverse_batch_stops_after_all_endpoints_are_settled() {
        let mut edges: Vec<_> = (0..1_000).map(|t| (0, 2, t, t + 1)).collect();
        edges.extend([(0, 2, 1_800, 1_810), (1, 2, 1_800, 1_810)]);
        let mut reverse = kernel(&edges, false, 0);
        let input = request();
        let pruned = reverse.route_arrive_by_many_csa_impl(&input).unwrap();
        assert_eq!(
            pruned.latest_departures,
            [1_797., 1_795., 1_791., f64::NEG_INFINITY]
        );
        assert!(
            pruned.scanned_departures < 10,
            "{}",
            pruned.scanned_departures
        );
        let mut full_input = request();
        full_input.origin_stops.push(6);
        full_input.origin_walk_seconds.push(0.);
        full_input.origin_offsets.push(5);
        full_input.allow_pre_ride_transfers.push(false);
        let full = reverse.route_arrive_by_many_csa_impl(&full_input).unwrap();
        assert_eq!(pruned.latest_departures, full.latest_departures[..4]);
        assert!(full.scanned_departures >= 1_002);
        let mut empty = request();
        empty.origin_offsets = vec![0, 0, 0];
        empty.origin_stops.clear();
        empty.origin_walk_seconds.clear();
        empty.allow_pre_ride_transfers = vec![true, false];
        let empty = reverse.route_arrive_by_many_csa_impl(&empty).unwrap();
        assert_eq!(empty.latest_departures, [f64::NEG_INFINITY; 2]);
        assert_eq!(empty.scanned_departures, 0);
    }
}
