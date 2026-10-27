use super::*;

impl TimetableKernel {
    pub fn route_scalar_csa(&mut self, input: TimetableQueryInput) -> Result<TimetableQueryResult> {
        self.route_scalar_csa_impl::<true>(&input)
    }

    /// Earliest arrival without transfer-rule state or the transfer buffer,
    /// for pruning. Rules and the buffer only remove journeys, so this bounds
    /// every journey that uses no rule-only transfer edge (a scoped or timed
    /// rule between different stops with no ordinary path). `None` when
    /// frequency windows need the stateful search.
    pub fn route_scalar_relaxed_csa(
        &mut self,
        input: &TimetableQueryInput,
    ) -> Result<Option<TimetableQueryResult>> {
        self.relaxed(|kernel| kernel.route_scalar_csa_impl::<false>(input))
    }

    pub(super) fn relaxed<T>(
        &mut self,
        search: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<Option<T>> {
        if self
            .service
            .as_ref()
            .is_some_and(|s| !s.data.headways.is_empty())
        {
            return Ok(None);
        }
        let service = self.service.take();
        let buffer = std::mem::take(&mut self.minimum_transfer_buffer_seconds);
        let result = search(self);
        self.service = service;
        self.minimum_transfer_buffer_seconds = buffer;
        result.map(Some)
    }

    pub(super) fn route_scalar_csa_impl<const RETAIN_JOURNEY: bool>(
        &mut self,
        input: &TimetableQueryInput,
    ) -> Result<TimetableQueryResult> {
        let started = Instant::now();
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.origin_stops.len() != input.origin_candidate_indices.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_stops.len() != input.destination_candidate_indices.len()
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
            || !input.departure.is_finite()
            || !input.horizon.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
        {
            return Err(Error::from_reason(
                "Rust timetable query arrays or bounds are inconsistent.",
            ));
        }

        if self.service.is_some() {
            let mut result = if let Some(result) = self.guarded_scalar(input)? {
                result
            } else {
                self.service_scalar(input)?
            };
            result.query_ns = started.elapsed().as_nanos() as f64;
            return Ok(result);
        }
        if let Some(maximum) = input.maximum_boardings {
            boarding_layers(Some(maximum))?;
            self.query.forward_workspace.scalar_identity = None;
            // The exact rounds below construct the final journey. This first
            // scan needs only its arrival, boarding bound and run envelope;
            // retain all label/tie semantics without writing unused predecessors.
            let unrestricted = self.route_scalar_csa_impl::<false>(&TimetableQueryInput {
                maximum_boardings: None,
                ..input.clone()
            })?;
            if unrestricted.status == "blocked" {
                return Ok(TimetableQueryResult {
                    query_ns: started.elapsed().as_nanos() as f64,
                    ..unrestricted
                });
            }
            // A feasible unrestricted winner proves the capped arrival too.
            // Its boarding count tightens the exact rounds; no transfer layer
            // above that witnessed count can improve the lexicographic result.
            let (arrival, boarding_bound, initial_query_ns, initial_scanned) = if unrestricted
                .best_boardings
                .is_some_and(|boardings| boardings <= maximum)
                && let Some(arrival) = unrestricted.best_arrival
            {
                (
                    arrival,
                    unrestricted.best_boardings.unwrap(),
                    unrestricted.query_ns,
                    unrestricted.scanned_departures,
                )
            } else {
                let times = self.route_many_csa(TimetableManyQueryInput {
                    origin_stops: input.origin_stops.clone(),
                    origin_walk_seconds: input.origin_walk_seconds.clone(),
                    destination_offsets: vec![0, input.destination_stops.len() as u32],
                    destination_stops: input.destination_stops.clone(),
                    destination_walk_seconds: input.destination_walk_seconds.clone(),
                    excluded_trips: Vec::new(),
                    departure: input.departure,
                    horizon: input.horizon,
                    allow_pre_ride_transfers: input.allow_pre_ride_transfers,
                    allow_post_ride_transfers: Some(vec![
                        input.allow_post_ride_transfers.unwrap_or(true),
                    ]),
                    maximum_boardings: Some(maximum),
                })?;
                (
                    times.best_arrivals[0],
                    maximum,
                    times.query_ns + unrestricted.query_ns,
                    times
                        .scanned_departures
                        .saturating_add(unrestricted.scanned_departures),
                )
            };
            if !arrival.is_finite() {
                let mut result = empty_result(started, true, "no_path_within_transfer_limit");
                result.status = "blocked".to_owned();
                result.scanned_departures = initial_scanned;
                return Ok(result);
            }
            // The shared capped scan supplies a proven feasible arrival. Its
            // worst-case walking bound admits every witness at that arrival;
            // exact rounds recover the least-boardings/least-walking chain.
            let result = self.route_pareto_round_csa(TimetableParetoQueryInput {
                origin_stops: input.origin_stops.clone(),
                origin_walk_seconds: input.origin_walk_seconds.clone(),
                origin_candidate_indices: input.origin_candidate_indices.clone(),
                destination_stops: input.destination_stops.clone(),
                destination_walk_seconds: input.destination_walk_seconds.clone(),
                destination_candidate_indices: input.destination_candidate_indices.clone(),
                departure: input.departure,
                horizon: input.horizon,
                allow_pre_ride_transfers: input.allow_pre_ride_transfers,
                allow_post_ride_transfers: input.allow_post_ride_transfers,
                earliest_arrival: arrival,
                boarding_upper_bound: boarding_bound,
                candidate_destination_index: 0,
                candidate_walking_seconds: f64::MAX,
                arrival_slack_seconds: 0.0,
                transfer_penalty_seconds: 0.0,
                walk_reluctance: 0.0,
                collect_alternatives: None,
                alternative_ranking: None,
                alternative_limit: None,
                restriction_mode: None,
                deadline_objective: None,
            })?;
            if !result.improved_candidate {
                return Err(Error::from_reason(
                    "Capped timetable arrival has no matching exact journey witness.",
                ));
            }
            return Ok(TimetableQueryResult {
                supported: result.supported,
                status: result.status,
                reason: result.reason,
                best_arrival: result.best_arrival,
                best_boardings: result.best_boardings,
                best_destination_index: result.best_destination_index,
                chain_kinds: result.chain_kinds,
                chain_from_stops: result.chain_from_stops,
                chain_to_stops: result.chain_to_stops,
                chain_trip_or_candidate: result.chain_trip_or_candidate,
                chain_board_sequences: result.chain_board_sequences,
                chain_alight_sequences: result.chain_alight_sequences,
                chain_durations: result.chain_durations,
                chain_arrivals: result.chain_arrivals,
                query_ns: started.elapsed().as_nanos() as f64,
                destination_seed_ns: 0.0,
                origin_seed_ns: 0.0,
                scan_ns: initial_query_ns + result.query_ns,
                chain_ns: 0.0,
                popped_states: 0,
                scanned_departures: initial_scanned.saturating_add(result.scanned_departures),
                relaxed_stops: result.relaxed_stops,
                expanded_trip_runs: result.expanded_trip_runs,
                dominated_trip_boardings: result.dominated_trip_boardings,
                explicit_transfer_checks: result.explicit_transfer_checks,
            });
        }
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
            reverse_transfer_offset: _,
            reverse_transfer_edges: _,
            exit_event_offset: _,
            exit_events: _,
            query:
                TimetableQueryWorkspace {
                    workspace,
                    many_workspace: _,
                    forward_workspace,
                    profile_workspace: _,
                    journey_workspace: _,
                },
        } = self;
        let forbidden_same_stop = forbidden_same_stop.as_ref();
        forward_workspace.scalar_identity = None;
        forward_workspace.scalar_first_boarding.fill(u32::MAX);
        let epoch = workspace.begin_query();
        workspace.allow_post_ride_transfers = input.allow_post_ride_transfers.unwrap_or(true);
        let destination_seed_started = Instant::now();
        let mut destination_seeds = 0_u32;
        let mut minimum_destination_egress = f64::INFINITY;
        for index in 0..input.destination_stops.len() {
            let stop = input.destination_stops[index] as usize;
            let walk_seconds = input.destination_walk_seconds[index];
            minimum_destination_egress = minimum_destination_egress.min(walk_seconds);
            if workspace.destination_generation[stop] != epoch {
                workspace.destination_generation[stop] = epoch;
                workspace.destination_egress[stop] = walk_seconds;
                workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
                destination_seeds = destination_seeds.saturating_add(1);
            } else if walk_seconds < workspace.destination_egress[stop] {
                workspace.destination_egress[stop] = walk_seconds;
                workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
            }
        }
        if destination_seeds == 0 {
            return Ok(empty_result(started, false, "destination_outside_kernel"));
        }
        let destination_seed_ns = destination_seed_started.elapsed().as_nanos() as f64;

        let mut stats = SearchStats::default();
        let mut best = BestState::default();
        let origin_seed_started = Instant::now();
        let mut origin_seeds = 0_u32;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            let state = relax_connection_scan::<RETAIN_JOURNEY>(
                workspace,
                epoch,
                &mut best,
                &mut stats,
                stop,
                arrival,
                false,
                false,
                false,
                NO_STATE,
                3,
                input.origin_candidate_indices[index] as i32,
                0.0,
                0.0,
                input.origin_walk_seconds[index].max(0.0).round() as u32,
            );
            if state < 0 {
                continue;
            }
            origin_seeds = origin_seeds.saturating_add(1);
            if input.allow_pre_ride_transfers {
                expand_connection_scan_transfer_edges::<RETAIN_JOURNEY>(
                    workspace,
                    epoch,
                    &mut best,
                    &mut stats,
                    transfer_offset,
                    transfer_edges,
                    stop,
                    arrival,
                    false,
                    state,
                );
            }
        }
        if origin_seeds == 0 {
            return Ok(empty_result(started, false, "origin_outside_kernel"));
        }
        let origin_seed_ns = origin_seed_started.elapsed().as_nanos() as f64;

        let scan_started = Instant::now();
        // With coordinate access, pre-ride transfer expansion is disabled.
        // The first feasible event is therefore the earliest indexed departure
        // at any origin stop after that stop's own access walk completes.
        // Starting there skips only departures that cannot be boarded.
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
        let mut bucket_boardings = RunMap::<Vec<ScalarRunBoarding>>::default();
        while time_index < scan_times.len() {
            let connection_departure = scan_times[time_index] as f64;
            // Every remaining journey must spend at least the smallest legal
            // destination-egress time after a departure at this timestamp.
            // A strict bound preserves equal-arrival, fewer-boarding ties.
            if connection_departure > input.horizon
                || connection_departure + minimum_destination_egress > best.arrival
            {
                break;
            }
            let start = scan_time_offsets[time_index] as usize;
            let end = scan_time_offsets[time_index + 1] as usize;
            let bucket_events = &scan_events[start..end];
            let bucket_arrivals = &scan_arrivals[start..end];
            let bucket_journeys = &scan_journeys[start..end];
            // Within a zero-time bucket, a later segment can be boarded first.
            // Its lower boarding count does not dominate a newly reachable
            // earlier segment. Retain both until this timestamp is closed.
            if !bucket_boardings.is_empty() {
                bucket_boardings.clear();
            }
            workspace.instant_time = connection_departure;
            let closure = scan_time_needs_closure[time_index];
            if closure && workspace.event_closure_tick.len() < end - start {
                workspace.event_closure_tick.resize(end - start, 0);
            }
            let mut revisit_all = true;
            loop {
                let previous_instant_labels = workspace.instant_labels;
                let previous_replacements = workspace.instant_replacements;
                if revisit_all {
                    stats.scanned_departures += (end - start) as u32;
                }
                for (offset, &event) in bucket_events.iter().enumerate() {
                    let connection = start + offset;
                    let scan_flags = event.flags();
                    let stop = event.source_stop();
                    let run = event.run();
                    if closure {
                        // A revisit repeats this event's last decisions unless
                        // its stop gained a label it can board from, or its run
                        // changed, since that visit.
                        let visited = workspace.event_closure_tick[offset];
                        if !revisit_all
                            && workspace.stop_closure_tick[stop] <= visited
                            && workspace.run_closure_tick[run] <= visited
                        {
                            continue;
                        }
                        if !revisit_all {
                            stats.scanned_departures += 1;
                        }
                        workspace.closure_tick += 2;
                        workspace.event_closure_tick[offset] = workspace.closure_tick;
                        // A label this event creates at its own stop is newer
                        // than this visit; its own run changes are not.
                        workspace.instant_stamp = workspace.closure_tick + 1;
                    }
                    // Unreachable source and inactive run: nothing to board or ride.
                    if !bit_is_set(&workspace.active_run_bits, run)
                        && (scan_flags & SCAN_CAN_BOARD == 0
                            || !bit_is_set(&workspace.reached_stop_bits, stop))
                    {
                        continue;
                    }
                    let can_reach_boarding = scan_flags & SCAN_CAN_BOARD != 0
                        && workspace.active_stop_generation[stop] == epoch
                        && workspace.active_state_mask[stop] != 0
                        // A reached stop can still have only future labels.
                        // Slack and transfer rules can only delay boarding.
                        && workspace.earliest_stop_arrival[stop] <= connection_departure;
                    // Most departures are unreachable. Do not load their cold
                    // arrival and journey columns or inspect boarding states.
                    if !can_reach_boarding && workspace.run_generation[run] != epoch {
                        continue;
                    }
                    let journey = bucket_journeys[offset];
                    let mut boarding_state = NO_STATE;
                    // An already boarded run needs no new boarding search if
                    // even the smallest stop boarding count cannot improve it.
                    // The sequence guard preserves the first-boardable-position
                    // envelope; equal-time buckets retain their full closure.
                    let boarding_dominated = workspace.run_generation[run] == epoch
                        && !scan_time_needs_closure[time_index]
                        && workspace.expanded_run_start[run] >= 0
                        && workspace.expanded_run_start[run] as usize <= connection
                        && journey.sequence >= forward_workspace.scalar_first_boarding[run]
                        && workspace.labels[workspace.run_predecessor_state[run] as usize]
                            .boardings
                            <= workspace.minimum_stop_boardings[stop];
                    if can_reach_boarding && !boarding_dominated {
                        let mut active_states = workspace.active_state_mask[stop];
                        while active_states != 0 {
                            let flags = active_states.trailing_zeros() as usize;
                            active_states &= active_states - 1;
                            let state = stop * STATE_STRIDE + flags;
                            let has_ride = flags & 4 != 0;
                            if has_ride
                                && flags & 1 != 0
                                && !transfer_allowed(forbidden_same_stop[stop] != 0, None, false)
                            {
                                continue;
                            }
                            let needs_board_slack = flags & 1 != 0;
                            if boarding_ready_time(
                                workspace.labels[state].arrival,
                                has_ride,
                                needs_board_slack,
                                same_stop_transfer_minimum[stop],
                                transfer_buffer_seconds,
                            ) > connection_departure
                            {
                                continue;
                            }
                            if boarding_state < 0 {
                                boarding_state = state as i32;
                                continue;
                            }
                            let retained = boarding_state as usize;
                            if workspace.labels[state].boardings
                                < workspace.labels[retained].boardings
                                || (workspace.labels[state].boardings
                                    == workspace.labels[retained].boardings
                                    && (workspace.labels[state].arrival
                                        < workspace.labels[retained].arrival
                                        || (workspace.labels[state].arrival
                                            == workspace.labels[retained].arrival
                                            && (workspace.labels[state].walking_seconds
                                                < workspace.labels[retained].walking_seconds
                                                || (workspace.labels[state].walking_seconds
                                                    == workspace.labels[retained]
                                                        .walking_seconds
                                                    && state < retained)))))
                            {
                                boarding_state = state as i32;
                            }
                        }
                    }

                    let run_active = workspace.run_generation[run] == epoch;
                    let earlier_start = if run_active {
                        workspace.expanded_run_start[run]
                    } else {
                        NO_STATE
                    };
                    let mut run_updated = false;
                    if boarding_state >= 0 {
                        if journey.sequence < forward_workspace.scalar_first_boarding[run] {
                            forward_workspace.scalar_first_boarding[run] = journey.sequence;
                            workspace.run_closure_tick[run] = workspace.closure_tick;
                        }
                        let candidate_boardings = workspace.labels[boarding_state as usize]
                            .boardings
                            .saturating_add(1);
                        let retained_boardings = if run_active {
                            workspace.labels[workspace.run_predecessor_state[run] as usize]
                                .boardings
                                .saturating_add(1)
                        } else {
                            u16::MAX
                        };
                        if !run_active
                            || candidate_boardings < retained_boardings
                            || (candidate_boardings == retained_boardings
                                && connection < earlier_start as usize)
                        {
                            if run_active
                                && scan_time_needs_closure[time_index]
                                && connection as i32 > earlier_start
                            {
                                retain_scalar_bucket_boarding(
                                    &mut bucket_boardings,
                                    run,
                                    ScalarRunBoarding {
                                        connection: earlier_start,
                                        predecessor: workspace.run_predecessor_state[run],
                                        sequence: workspace.run_board_sequence[run],
                                        boardings: retained_boardings,
                                    },
                                );
                            }
                            if !run_active {
                                workspace.run_generation[run] = epoch;
                                set_bit(&mut workspace.active_run_bits, run);
                                workspace.touched_runs.push(run as u32);
                            }
                            workspace.expanded_run_start[run] = connection as i32;
                            workspace.run_predecessor_state[run] = boarding_state;
                            workspace.run_closure_tick[run] = workspace.closure_tick;
                            run_updated = true;
                            stats.expanded_trip_runs += 1;
                        } else {
                            if (connection as i32) < earlier_start
                                && retain_scalar_bucket_boarding(
                                    &mut bucket_boardings,
                                    run,
                                    ScalarRunBoarding {
                                        connection: connection as i32,
                                        predecessor: boarding_state,
                                        sequence: journey.sequence,
                                        boardings: candidate_boardings,
                                    },
                                )
                            {
                                workspace.run_closure_tick[run] = workspace.closure_tick;
                                stats.expanded_trip_runs += 1;
                            } else {
                                stats.dominated_trip_boardings += 1;
                            }
                        }
                    }
                    if workspace.run_generation[run] != epoch
                        || workspace.expanded_run_start[run] < 0
                    {
                        continue;
                    }
                    if run_updated {
                        workspace.run_board_sequence[run] = journey.sequence;
                    }
                    let mut boarding = workspace.expanded_run_start[run];
                    let mut predecessor = workspace.run_predecessor_state[run];
                    let mut board_sequence = workspace.run_board_sequence[run] as f64;
                    // Only zero-time buckets retain alternative boardings; avoid
                    // hashing every active run when there are none.
                    if !bucket_boardings.is_empty()
                        && let Some(frontier) = bucket_boardings.get(&run)
                    {
                        let mut boardings = workspace.labels[predecessor as usize]
                            .boardings
                            .saturating_add(1);
                        for &candidate in frontier {
                            if candidate.connection <= connection as i32
                                && (boarding > connection as i32
                                    || (candidate.boardings, candidate.connection)
                                        < (boardings, boarding))
                            {
                                boarding = candidate.connection;
                                predecessor = candidate.predecessor;
                                board_sequence = candidate.sequence as f64;
                                boardings = candidate.boardings;
                            }
                        }
                    }
                    if boarding > connection as i32 {
                        continue;
                    }
                    let boarding = boarding as usize;
                    let trip = journey.trip as i32;
                    if connection > boarding && scan_flags & SCAN_BRIDGE_EXIT != 0 {
                        let bridge_arrival = connection_departure;
                        let bridge_stop = event.source_stop();
                        if bridge_arrival <= input.horizon
                            && bridge_arrival <= best.arrival
                            && !workspace.ride_candidate_later(
                                epoch,
                                bridge_stop,
                                1,
                                bridge_arrival,
                            )
                        {
                            let bridge_state = relax_connection_scan::<RETAIN_JOURNEY>(
                                workspace,
                                epoch,
                                &mut best,
                                &mut stats,
                                bridge_stop,
                                bridge_arrival,
                                true,
                                true,
                                true,
                                predecessor,
                                2,
                                trip,
                                board_sequence,
                                journey.prior_sequence as f64 + 0.5,
                                0,
                            );
                            if bridge_state >= 0 {
                                expand_connection_scan_transfer_edges::<RETAIN_JOURNEY>(
                                    workspace,
                                    epoch,
                                    &mut best,
                                    &mut stats,
                                    transfer_offset,
                                    transfer_edges,
                                    bridge_stop,
                                    bridge_arrival,
                                    true,
                                    bridge_state,
                                );
                            }
                        }
                    }
                    let arrival = bucket_arrivals[offset];
                    let connection_arrival = arrival.arrival as f64;
                    if scan_flags & SCAN_CAN_ALIGHT == 0
                        || connection_arrival > input.horizon
                        || connection_arrival > best.arrival
                    {
                        continue;
                    }
                    let alight_stop = arrival.to as usize;
                    if workspace.ride_candidate_later(epoch, alight_stop, 1, connection_arrival) {
                        continue;
                    }
                    let alight_state = relax_connection_scan::<RETAIN_JOURNEY>(
                        workspace,
                        epoch,
                        &mut best,
                        &mut stats,
                        alight_stop,
                        connection_arrival,
                        true,
                        true,
                        true,
                        predecessor,
                        2,
                        trip,
                        board_sequence,
                        journey.sequence as f64,
                        0,
                    );
                    if alight_state >= 0 {
                        expand_connection_scan_transfer_edges::<RETAIN_JOURNEY>(
                            workspace,
                            epoch,
                            &mut best,
                            &mut stats,
                            transfer_offset,
                            transfer_edges,
                            alight_stop,
                            connection_arrival,
                            true,
                            alight_state,
                        );
                    }
                }
                // Only a label arriving at this bucket's own time can board an
                // earlier departure of the bucket. Later labels and run updates
                // would repeat this pass's decisions.
                if !closure || workspace.instant_labels == previous_instant_labels {
                    break;
                }
                // A replaced label can be a run's boarding predecessor, which
                // later rides of that run read: revisit everything.
                revisit_all = workspace.instant_replacements != previous_replacements;
            }
            time_index += 1;
        }
        workspace.instant_time = f64::NEG_INFINITY;
        let scan_ns = scan_started.elapsed().as_nanos() as f64;

        if best.state >= 0 {
            forward_workspace.scalar_runs.fill(0);
            for run in workspace.touched_runs.iter().copied() {
                set_run_bit(&mut forward_workspace.scalar_runs, run as usize);
            }
            forward_workspace.scalar_identity =
                Some(ScalarEnvelopeIdentity::new(input, &best, time_index));
        }
        if best.state < 0 {
            return Ok(TimetableQueryResult {
                supported: true,
                status: "blocked".to_owned(),
                reason: None,
                best_arrival: None,
                best_boardings: None,
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
                destination_seed_ns,
                origin_seed_ns,
                scan_ns,
                chain_ns: 0.0,
                popped_states: 0,
                scanned_departures: stats.scanned_departures,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: stats.expanded_trip_runs,
                dominated_trip_boardings: stats.dominated_trip_boardings,
                explicit_transfer_checks: stats.explicit_transfer_checks,
            });
        }

        let (chain, chain_ns) = if RETAIN_JOURNEY {
            let chain_started = Instant::now();
            let mut chain = Vec::<JourneyChainStep>::new();
            let mut state = best.state;
            while state >= 0 {
                let state_index = state as usize;
                let predecessor_record = workspace.predecessors[state_index];
                let kind = predecessor_record.kind;
                let stop = (state_index / STATE_STRIDE) as i32;
                if kind == 3 {
                    chain.push((
                        3,
                        NO_STATE,
                        stop,
                        predecessor_record.trip,
                        0.0,
                        0.0,
                        predecessor_record.duration,
                        workspace.labels[state_index].arrival,
                    ));
                    break;
                }
                let predecessor = predecessor_record.state;
                if predecessor < 0 {
                    break;
                }
                chain.push((
                    kind as u32,
                    (predecessor as usize / STATE_STRIDE) as i32,
                    stop,
                    predecessor_record.trip,
                    f64::from(predecessor_record.board_sequence_twice) * 0.5,
                    f64::from(predecessor_record.alight_sequence_twice) * 0.5,
                    predecessor_record.duration,
                    workspace.labels[state_index].arrival,
                ));
                state = predecessor;
            }
            chain.reverse();
            (chain, chain_started.elapsed().as_nanos() as f64)
        } else {
            (Vec::new(), 0.0)
        };

        Ok(TimetableQueryResult {
            supported: true,
            status: "ready".to_owned(),
            reason: None,
            best_arrival: Some(best.arrival),
            best_boardings: Some(best.boardings as u32),
            best_destination_index: Some(best.destination_index as u32),
            chain_kinds: chain.iter().map(|step| step.0).collect(),
            chain_from_stops: chain.iter().map(|step| step.1).collect(),
            chain_to_stops: chain.iter().map(|step| step.2).collect(),
            chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
            chain_board_sequences: chain.iter().map(|step| step.4).collect(),
            chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
            chain_durations: chain.iter().map(|step| step.6).collect(),
            chain_arrivals: chain.iter().map(|step| step.7).collect(),
            query_ns: started.elapsed().as_nanos() as f64,
            destination_seed_ns,
            origin_seed_ns,
            scan_ns,
            chain_ns,
            popped_states: 0,
            scanned_departures: stats.scanned_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }
}
