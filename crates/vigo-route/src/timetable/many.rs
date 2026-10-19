use super::*;

impl TimetableKernel {
    /// One destination and deadline, shared by every origin. Reverse labels
    /// retain the latest feasible first boarding at each stop; endpoint access
    /// and its permitted single pre-ride transfer are reduced only after the
    /// timetable scan. The scalar workspace is reused without stop-sized
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
        let forbidden_same_stop = self.forbidden_same_stop.as_ref();
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
        // A scalar request can stop at a proven latest departure. Reuse an
        // otherwise unused label slot for its directed access offsets; bulk
        // requests still share the full scan without per-origin bookkeeping.
        let mut minimum_origin_offset = f64::INFINITY;
        if origin_count == 1 {
            for (&stop, &walk) in input.origin_stops.iter().zip(&input.origin_walk_seconds) {
                retain_reverse_origin_offset(workspace, epoch, stop as usize, walk);
                minimum_origin_offset = minimum_origin_offset.min(walk);
                if input.allow_pre_ride_transfers[0] {
                    let edges = &self.transfer_edges[self.transfer_offset[stop as usize] as usize
                        ..self.transfer_offset[stop as usize + 1] as usize];
                    for edge in edges {
                        let offset = walk + f64::from(edge.duration());
                        retain_reverse_origin_offset(workspace, epoch, edge.stop(), offset);
                        minimum_origin_offset = minimum_origin_offset.min(offset);
                    }
                }
            }
        }
        let mut latest_origin_departure = f64::NEG_INFINITY;
        let mut stats = SearchStats::default();
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
            if origin_count == 1 && departure - minimum_origin_offset <= latest_origin_departure {
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
                            if origin_count == 1 {
                                let access =
                                    workspace.labels[base_stop * STATE_STRIDE + (STATE_STRIDE - 2)];
                                if access.generation == epoch {
                                    latest_origin_departure =
                                        latest_origin_departure.max(departure - access.arrival);
                                }
                            }
                            let boarding =
                                &mut workspace.labels[stop * STATE_STRIDE + (STATE_STRIDE - 1)];
                            if boarding.generation != epoch || departure > boarding.arrival {
                                boarding.generation = epoch;
                                boarding.arrival = departure;
                            }
                            if forbidden_same_stop[base_stop] == 0 {
                                relax_reverse_post_ride_deadline(
                                    workspace,
                                    epoch,
                                    &mut stats,
                                    stop,
                                    departure
                                        - f64::from(self.same_stop_transfer_minimum[base_stop])
                                        - f64::from(self.minimum_transfer_buffer_seconds),
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
        let mut latest_departures = vec![f64::NEG_INFINITY; origin_count];
        for (origin, latest) in latest_departures.iter_mut().enumerate() {
            let start = input.origin_offsets[origin] as usize;
            let end = input.origin_offsets[origin + 1] as usize;
            for seed in start..end {
                for layer in first_layer..=maximum_layer {
                    let layer_offset = layer * self.stop_count;
                    let base_stop = input.origin_stops[seed] as usize;
                    let stop = layer_offset + base_stop;
                    let walk = input.origin_walk_seconds[seed];
                    let boarding = workspace.labels[stop * STATE_STRIDE + (STATE_STRIDE - 1)];
                    if boarding.generation == epoch {
                        *latest = latest.max(boarding.arrival - walk);
                    }
                    if input.allow_pre_ride_transfers[origin] {
                        let edges = &self.transfer_edges[self.transfer_offset[base_stop] as usize
                            ..self.transfer_offset[base_stop + 1] as usize];
                        stats.explicit_transfer_checks = stats
                            .explicit_transfer_checks
                            .saturating_add(edges.len() as u32);
                        for edge in edges {
                            let boarding = workspace.labels
                                [(layer_offset + edge.stop()) * STATE_STRIDE + (STATE_STRIDE - 1)];
                            if boarding.generation == epoch {
                                *latest = latest
                                    .max(boarding.arrival - walk - f64::from(edge.duration()));
                            }
                        }
                    }
                }
            }
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
        // A single Matrix target also supplies the capped point-query anchor.
        // Retain a feasible terminal bound so that scan stops once remaining
        // departures cannot improve it; larger matrices keep the shared scan.
        let single_destination = destination_count == 1;
        let destination_epoch = if single_destination {
            destination_workspace.begin_query()
        } else {
            0
        };
        let mut minimum_egress = f64::INFINITY;
        if single_destination {
            for (index, &target) in input.destination_stops.iter().enumerate() {
                let target = target as usize;
                let walk = input.destination_walk_seconds[index];
                minimum_egress = minimum_egress.min(walk);
                if destination_workspace.destination_generation[target] != destination_epoch {
                    destination_workspace.destination_generation[target] = destination_epoch;
                    destination_workspace.destination_egress[target] = walk;
                } else {
                    destination_workspace.destination_egress[target] =
                        destination_workspace.destination_egress[target].min(walk);
                }
                if input
                    .allow_post_ride_transfers
                    .as_ref()
                    .is_none_or(|allowed| allowed[0])
                {
                    for edge in &reverse_transfer_edges[reverse_transfer_offset[target] as usize
                        ..reverse_transfer_offset[target + 1] as usize]
                    {
                        let source = edge.stop();
                        let egress = walk + f64::from(edge.duration());
                        if destination_workspace.destination_generation[source] != destination_epoch
                        {
                            destination_workspace.destination_generation[source] =
                                destination_epoch;
                            destination_workspace.destination_egress[source] = egress;
                        } else {
                            destination_workspace.destination_egress[source] =
                                destination_workspace.destination_egress[source].min(egress);
                        }
                    }
                }
            }
        }
        let terminal_egress = |stop: usize| {
            if single_destination
                && destination_workspace.destination_generation[stop] == destination_epoch
            {
                destination_workspace.destination_egress[stop]
            } else {
                f64::INFINITY
            }
        };
        let mut terminal_bound = f64::INFINITY;
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
            if connection_departure > input.horizon
                || (single_destination && connection_departure + minimum_egress > terminal_bound)
            {
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
                            terminal_bound = terminal_bound
                                .min(connection_departure + terminal_egress(event.source_stop()));
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
                        terminal_bound = terminal_bound
                            .min(f64::from(arrival.arrival) + terminal_egress(arrival.to as usize));
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
