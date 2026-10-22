use super::*;

impl TimetableKernel {
    pub fn route_arrive_by_csa(
        &mut self,
        input: TimetableArriveByQueryInput,
    ) -> Result<TimetableArriveByQueryResult> {
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
            || !input.earliest.is_finite()
            || input.earliest < 0.0
            || !input.deadline.is_finite()
            || input.deadline < input.earliest
        {
            return Err(Error::from_reason(
                "Rust arrive-by query arrays or bounds are inconsistent.",
            ));
        }

        if self.service.is_some() {
            let service = self.service.take();
            let ordinary = self.route_arrive_by_csa(input.clone());
            self.service = service;
            let ordinary = ordinary?;
            let safe = self.ordinary_reverse_is_safe(
                &input.destination_stops,
                &input.destination_walk_seconds,
                ordinary.latest_departure.unwrap_or(input.earliest),
                input.deadline,
                input.allow_post_ride_transfers.unwrap_or(true),
                input.maximum_boardings,
                &[],
            )?;
            let mut result = if safe {
                self.record_ordinary_search();
                ordinary
            } else {
                self.service_arrive(&input)?
            };
            result.query_ns = started.elapsed().as_nanos() as f64;
            return Ok(result);
        }
        if let Some(cap) = input.maximum_boardings {
            boarding_layers(Some(cap))?;
            // The unrestricted latest departure is an upper bound for every
            // capped journey. Accept it only with a forward witness that fits
            // the cap and deadline. Otherwise the layered search below remains
            // authoritative. No scalar witness replaces journey tie selection.
            let mut proof = None;
            if !input.allow_pre_ride_transfers && input.allow_post_ride_transfers == Some(false) {
                let mut bound = self.route_arrive_by_csa(TimetableArriveByQueryInput {
                    maximum_boardings: None,
                    ..input.clone()
                })?;
                if let Some(departure) = bound.latest_departure {
                    let witness = self.route_scalar_csa(TimetableQueryInput {
                        origin_stops: input.origin_stops.clone(),
                        origin_walk_seconds: input.origin_walk_seconds.clone(),
                        origin_candidate_indices: input.origin_candidate_indices.clone(),
                        destination_stops: input.destination_stops.clone(),
                        destination_walk_seconds: input.destination_walk_seconds.clone(),
                        destination_candidate_indices: input.destination_candidate_indices.clone(),
                        departure,
                        horizon: input.deadline,
                        allow_pre_ride_transfers: false,
                        allow_post_ride_transfers: Some(false),
                        maximum_boardings: None,
                    })?;
                    bound.scanned_departures = bound
                        .scanned_departures
                        .saturating_add(witness.scanned_departures);
                    bound.relaxed_stops = bound.relaxed_stops.saturating_add(witness.relaxed_stops);
                    bound.expanded_trip_runs = bound
                        .expanded_trip_runs
                        .saturating_add(witness.expanded_trip_runs);
                    bound.dominated_trip_boardings = bound
                        .dominated_trip_boardings
                        .saturating_add(witness.dominated_trip_boardings);
                    bound.explicit_transfer_checks = bound
                        .explicit_transfer_checks
                        .saturating_add(witness.explicit_transfer_checks);
                    bound.engine_query_ns += witness.query_ns;
                    if witness.supported
                        && witness.status == "ready"
                        && witness
                            .best_arrival
                            .is_some_and(|arrival| arrival <= input.deadline)
                        && witness
                            .best_boardings
                            .is_some_and(|boardings| boardings <= cap)
                    {
                        bound.query_ns = started.elapsed().as_nanos() as f64;
                        return Ok(bound);
                    }
                } else if bound.supported && bound.status == "blocked" {
                    bound.query_ns = started.elapsed().as_nanos() as f64;
                    return Ok(bound);
                }
                proof = Some(bound);
            }
            let result = self.route_arrive_by_many_csa(TimetableArriveByManyQueryInput {
                origin_offsets: vec![0, input.origin_stops.len() as u32],
                origin_stops: input.origin_stops,
                origin_walk_seconds: input.origin_walk_seconds,
                allow_pre_ride_transfers: vec![input.allow_pre_ride_transfers],
                destination_stops: input.destination_stops,
                destination_walk_seconds: input.destination_walk_seconds,
                earliest: input.earliest,
                deadline: input.deadline,
                excluded_trips: Vec::new(),
                allow_post_ride_transfers: input.allow_post_ride_transfers,
                maximum_boardings: input.maximum_boardings,
            })?;
            let latest = result.latest_departures[0];
            let mut result = TimetableArriveByQueryResult {
                supported: true,
                status: if latest.is_finite() {
                    "ready"
                } else {
                    "blocked"
                }
                .to_owned(),
                reason: None,
                latest_departure: latest.is_finite().then_some(latest),
                candidate_count: u32::from(latest.is_finite()),
                verified_candidates: u32::from(latest.is_finite()),
                query_ns: started.elapsed().as_nanos() as f64,
                engine_query_ns: result.query_ns,
                scanned_departures: result.scanned_departures,
                relaxed_stops: result.relaxed_stops,
                expanded_trip_runs: result.expanded_trip_runs,
                dominated_trip_boardings: result.dominated_trip_boardings,
                explicit_transfer_checks: result.explicit_transfer_checks,
            };
            if let Some(proof) = proof {
                result.engine_query_ns += proof.engine_query_ns;
                result.scanned_departures = result
                    .scanned_departures
                    .saturating_add(proof.scanned_departures);
                result.relaxed_stops = result.relaxed_stops.saturating_add(proof.relaxed_stops);
                result.expanded_trip_runs = result
                    .expanded_trip_runs
                    .saturating_add(proof.expanded_trip_runs);
                result.dominated_trip_boardings = result
                    .dominated_trip_boardings
                    .saturating_add(proof.dominated_trip_boardings);
                result.explicit_transfer_checks = result
                    .explicit_transfer_checks
                    .saturating_add(proof.explicit_transfer_checks);
            }
            return Ok(result);
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
            scan_journeys: _,
            run_start: _,
            run_end: _,
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset: _,
            exit_events: _,
            query:
                TimetableQueryWorkspace {
                    workspace,
                    many_workspace: _,
                    forward_workspace: _,
                    profile_workspace: _,
                    journey_workspace: _,
                },
        } = self;
        let forbidden_same_stop = forbidden_same_stop.as_ref();
        let epoch = workspace.begin_query();

        // The production transfer projection admits at most one explicit
        // transfer before the first ride. Store the minimum access offset in
        // an unused scalar label slot so arrive-by adds no stop-sized query
        // allocation.
        let maximum_offset = input.deadline - input.earliest;
        let mut minimum_origin_offset = f64::INFINITY;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let offset = input.origin_walk_seconds[index];
            let state = stop * STATE_STRIDE + (STATE_STRIDE - 2);
            if offset > maximum_offset
                || (workspace.labels[state].generation == epoch
                    && offset >= workspace.labels[state].arrival)
            {
                continue;
            }
            retain_reverse_origin_offset(workspace, epoch, stop, offset);
            minimum_origin_offset = minimum_origin_offset.min(offset);
        }
        if input.allow_pre_ride_transfers {
            for index in 0..input.origin_stops.len() {
                let source = input.origin_stops[index] as usize;
                let source_offset = input.origin_walk_seconds[index];
                if source_offset > maximum_offset {
                    continue;
                }
                let start = transfer_offset[source] as usize;
                let end = transfer_offset[source + 1] as usize;
                for edge in &transfer_edges[start..end] {
                    let target = edge.stop();
                    let offset = source_offset + f64::from(edge.duration());
                    let state = target * STATE_STRIDE + (STATE_STRIDE - 2);
                    if offset > maximum_offset
                        || (workspace.labels[state].generation == epoch
                            && offset >= workspace.labels[state].arrival)
                    {
                        continue;
                    }
                    retain_reverse_origin_offset(workspace, epoch, target, offset);
                    minimum_origin_offset = minimum_origin_offset.min(offset);
                }
            }
        }

        // A post-ride state may finish directly, board another run after the
        // standard same-stop interchange time, or traverse exactly one
        // explicit transfer whose duration already represents interchange.
        // Seed both deadline forms at each destination, then propagate every
        // newly discovered boarding opportunity while scanning the timetable
        // once in reverse time order.
        let engine_started = Instant::now();
        let mut stats = SearchStats::default();
        let mut latest_destination_deadline = f64::NEG_INFINITY;
        for index in 0..input.destination_stops.len() {
            let stop = input.destination_stops[index] as usize;
            let destination_deadline = input.deadline - input.destination_walk_seconds[index];
            if destination_deadline < input.earliest {
                continue;
            }
            latest_destination_deadline = latest_destination_deadline.max(destination_deadline);
            relax_reverse_post_ride_deadline(
                workspace,
                epoch,
                &mut stats,
                stop,
                destination_deadline,
                input.earliest,
            );
            if input.allow_post_ride_transfers.unwrap_or(true) {
                relax_reverse_transfer_target_deadline(
                    workspace,
                    epoch,
                    &mut stats,
                    stop,
                    destination_deadline,
                    input.earliest,
                    reverse_transfer_offset,
                    reverse_transfer_edges,
                );
            }
        }
        let mut latest_departure = None;
        let first_boarding = input.earliest + minimum_origin_offset;
        let first_time = scan_time_lower_bound(scan_times, first_boarding);
        let time_end = scan_time_upper_bound(scan_times, latest_destination_deadline);
        'time_scan: for time_index in (first_time..time_end).rev() {
            let departure = f64::from(scan_times[time_index]);
            // Events are ordered by decreasing departure. Once even the
            // shortest origin access cannot improve the retained departure,
            // no earlier event can improve it either.
            if latest_departure.is_some_and(|latest| departure - minimum_origin_offset <= latest) {
                break;
            }
            let start = scan_time_offsets[time_index] as usize;
            let end = scan_time_offsets[time_index + 1] as usize;
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures += (end - start) as u32;
                for connection in (start..end).rev() {
                    let event = scan_events[connection];
                    let flags = event.flags();
                    let stop = event.source_stop();
                    let run = event.run();
                    let arrival = scan_arrivals[connection];
                    let run_was_feasible = workspace.run_generation[run] == epoch
                        && workspace.expanded_run_start[run] >= connection as i32;
                    let direct_exit_feasible = flags & SCAN_CAN_ALIGHT != 0
                        && workspace.destination_generation[arrival.to as usize] == epoch
                        && f64::from(arrival.arrival)
                            <= workspace.destination_egress[arrival.to as usize];
                    let boardable_path = run_was_feasible || direct_exit_feasible;

                    if flags & SCAN_CAN_BOARD != 0 && boardable_path {
                        let origin_state = stop * STATE_STRIDE + (STATE_STRIDE - 2);
                        if workspace.labels[origin_state].generation == epoch {
                            let origin_offset = workspace.labels[origin_state].arrival;
                            let candidate = departure - origin_offset;
                            if candidate >= input.earliest
                                && candidate <= input.deadline
                                && latest_departure.is_none_or(|latest| candidate > latest)
                            {
                                latest_departure = Some(candidate);
                                // This is the largest physical departure possible
                                // at the latest timetable time still under
                                // consideration. Neither the rest of this bucket
                                // nor an earlier one can improve it.
                                if origin_offset <= minimum_origin_offset {
                                    break 'time_scan;
                                }
                            }
                        }

                        if transfer_allowed(forbidden_same_stop[stop] != 0, None, false) {
                            relax_reverse_post_ride_deadline(
                                workspace,
                                epoch,
                                &mut stats,
                                stop,
                                transfer_ready_time::<true>(
                                    departure,
                                    departure,
                                    same_stop_transfer_minimum[stop],
                                    transfer_buffer_seconds,
                                ),
                                input.earliest,
                            );
                        }
                        // Pair-specific incoming edges have already passed
                        // transfer filtering. A same-stop ban cannot forbid
                        // an explicit transfer from a different stop.
                        relax_reverse_transfer_target_deadline(
                            workspace,
                            epoch,
                            &mut stats,
                            stop,
                            departure - f64::from(transfer_buffer_seconds),
                            input.earliest,
                            reverse_transfer_offset,
                            reverse_transfer_edges,
                        );
                    }

                    let bridge_exit_feasible = flags & SCAN_BRIDGE_EXIT != 0
                        && workspace.destination_generation[stop] == epoch
                        && departure <= workspace.destination_egress[stop];
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
                        workspace.expanded_run_start[run] = exit_connection;
                        stats.expanded_trip_runs = stats.expanded_trip_runs.saturating_add(1);
                    } else if run_was_feasible && flags & SCAN_CAN_BOARD != 0 {
                        stats.dominated_trip_boardings =
                            stats.dominated_trip_boardings.saturating_add(1);
                    }
                }
                if !scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
        }
        let engine_query_ns = engine_started.elapsed().as_nanos() as f64;
        // The reverse scan resolves one exact upper boundary. The uncommon
        // presentation-only recovery reconstructs that same boundary in
        // JavaScript if forward materialization rejects that boundary.
        let verified_candidates = u32::from(latest_departure.is_some());
        let candidate_count = verified_candidates;

        Ok(TimetableArriveByQueryResult {
            supported: true,
            status: if latest_departure.is_some() {
                "ready".to_owned()
            } else {
                "blocked".to_owned()
            },
            reason: None,
            latest_departure,
            candidate_count,
            verified_candidates,
            query_ns: started.elapsed().as_nanos() as f64,
            engine_query_ns,
            scanned_departures: stats.scanned_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }
}
