use super::*;

impl TimetableKernel {
    /// Alternatives around a known primary journey. Pareto keeps the
    /// nondominated arrival/boarding/walking trade-offs that use at most the
    /// primary's boardings. Ranked keeps the earliest distinct completions,
    /// dominated ones included, with at most one additional boarding.
    pub fn route_alternatives_csa(
        &mut self,
        input: TimetableAlternativeQueryInput,
    ) -> Result<TimetableParetoQueryResult> {
        let ranked = input.ranking.as_deref() == Some("ranked");
        let cap = input
            .maximum_boardings
            .unwrap_or(u32::MAX)
            .min(MAX_PROFILE_BOARDINGS as u32);
        let boarding_upper_bound = if ranked {
            input.best_boardings.saturating_add(1).min(cap)
        } else {
            input.best_boardings
        }
        .max(input.best_boardings.min(cap));
        let request = TimetableParetoQueryInput {
            origin_stops: input.origin_stops,
            origin_walk_seconds: input.origin_walk_seconds,
            origin_candidate_indices: input.origin_candidate_indices,
            destination_stops: input.destination_stops,
            destination_walk_seconds: input.destination_walk_seconds,
            destination_candidate_indices: input.destination_candidate_indices,
            departure: input.departure,
            horizon: input.horizon,
            allow_pre_ride_transfers: input.allow_pre_ride_transfers,
            allow_post_ride_transfers: input.allow_post_ride_transfers,
            earliest_arrival: input.earliest_arrival,
            boarding_upper_bound,
            candidate_destination_index: 0,
            candidate_walking_seconds: f64::MAX,
            arrival_slack_seconds: input.arrival_slack_seconds,
            transfer_penalty_seconds: 0.0,
            walk_reluctance: 0.0,
            collect_alternatives: Some(true),
            alternative_ranking: input.ranking,
            alternative_limit: input.limit,
            restriction_mode: None,
            deadline_objective: Some(false),
        };
        let result = self.route_pareto_round_csa(request.clone())?;
        // The corridor is an accelerator. An origin outside it repeats the
        // same bounded search without corridor pruning.
        if !result.supported && result.reason.as_deref() == Some("origin_outside_kernel") {
            return self.route_pareto_round_csa(TimetableParetoQueryInput {
                restriction_mode: Some("anchor-only".into()),
                ..request
            });
        }
        Ok(result)
    }
    pub fn route_pareto_round_csa(
        &mut self,
        input: TimetableParetoQueryInput,
    ) -> Result<TimetableParetoQueryResult> {
        let started = Instant::now();
        let restriction_mode = ParetoRestrictionMode::parse(input.restriction_mode.as_deref())?;
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
            || !input.earliest_arrival.is_finite()
            || !input.candidate_walking_seconds.is_finite()
            || !input.arrival_slack_seconds.is_finite()
            || !input.transfer_penalty_seconds.is_finite()
            || !input.walk_reluctance.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
            || input.earliest_arrival < input.departure
            || input.candidate_walking_seconds < 0.0
            || input.arrival_slack_seconds < 0.0
            || input.transfer_penalty_seconds < 0.0
            || input.walk_reluctance < 0.0
            || input.boarding_upper_bound == 0
            || input.boarding_upper_bound as usize > MAX_PROFILE_BOARDINGS
        {
            return Err(Error::from_reason(
                "Rust round timetable query arrays or bounds are inconsistent.",
            ));
        }
        let transfer_buffer_seconds = self.minimum_transfer_buffer_seconds;
        if self.service.is_some() {
            return self.service_pareto(&input);
        }
        let Self {
            service: _,
            stop_count,
            run_count,
            departure_seconds,
            arrival_seconds,
            from_stop,
            to_stop,
            sequence,
            segment_trip,
            segment_run,
            continuity_break,
            can_board,
            can_alight,
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
            scan_journeys: _,
            run_start,
            run_end,
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset,
            exit_events,
            query:
                TimetableQueryWorkspace {
                    workspace: destination_workspace,
                    many_workspace: _,
                    forward_workspace,
                    profile_workspace,
                    journey_workspace: _,
                },
        } = self;
        let departure_seconds = &departure_seconds.view();
        let arrival_seconds = &arrival_seconds.view();
        let from_stop = &from_stop.view();
        let to_stop = &to_stop.view();
        let sequence = &sequence.view();
        let segment_trip = &segment_trip.view();
        let segment_run = &segment_run.view();
        let continuity_break = &continuity_break.view();
        let can_board = &can_board.view();
        let can_alight = &can_alight.view();
        let forbidden_same_stop = forbidden_same_stop.as_ref();
        let destination_epoch = destination_workspace.begin_query();
        destination_workspace.allow_post_ride_transfers =
            input.allow_post_ride_transfers.unwrap_or(true);
        let mut destination_seeds = 0_u32;
        for index in 0..input.destination_stops.len() {
            let stop = input.destination_stops[index] as usize;
            let walk_seconds = input.destination_walk_seconds[index];
            if destination_workspace.destination_generation[stop] != destination_epoch {
                destination_workspace.destination_generation[stop] = destination_epoch;
                destination_workspace.destination_egress[stop] = walk_seconds;
                destination_workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
                destination_seeds = destination_seeds.saturating_add(1);
            } else if walk_seconds < destination_workspace.destination_egress[stop] {
                destination_workspace.destination_egress[stop] = walk_seconds;
                destination_workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
            }
        }
        if destination_seeds == 0 {
            return Ok(empty_pareto_result(
                started,
                false,
                "destination_outside_kernel",
                restriction_mode,
            ));
        }
        let boarding_upper_bound = input.boarding_upper_bound as u16;
        let origin_epoch = profile_workspace.begin_query();
        // The horizon bounds ride departures and alightings. The scalar
        // witness may finish terminal walking after that horizon, so its final
        // arrival must remain inside the Pareto corridor.
        let arrival_upper_bound = input.earliest_arrival + input.arrival_slack_seconds.max(0.0);
        let transfer_penalty_seconds = input.transfer_penalty_seconds.max(0.0);
        let walk_reluctance = input.walk_reluctance.max(0.0);
        let collect_alternatives = input.collect_alternatives.unwrap_or(false);
        let ranked_alternatives = collect_alternatives
            && match input.alternative_ranking.as_deref() {
                None | Some("pareto") => false,
                Some("ranked") => true,
                Some(_) => {
                    return Err(Error::from_reason(
                        "Alternative ranking must be pareto or ranked.",
                    ));
                }
            };
        let deadline_objective = input.deadline_objective.unwrap_or(false);
        let generalized_upper_bound = generalized_seconds(
            input.earliest_arrival,
            boarding_upper_bound,
            input.candidate_walking_seconds,
            transfer_penalty_seconds,
            walk_reluctance,
        );
        let corridor_started = Instant::now();
        let forward_started = Instant::now();
        let scalar_envelope_reused = restriction_mode.uses_forward()
            && forward_workspace
                .scalar_identity
                .as_ref()
                .is_some_and(|identity| identity.matches(&input));
        let forward_envelope_built = restriction_mode.uses_forward() && !scalar_envelope_reused;
        let forward_envelope = if !restriction_mode.uses_forward() {
            ForwardRunEnvelope::default()
        } else if scalar_envelope_reused {
            let mut envelope = ForwardRunEnvelope::default();
            // Egress can stop the scalar scan before its final arrival time.
            // Resume at the first unscanned bucket, including that interval.
            let mut time_index = forward_workspace
                .scalar_identity
                .as_ref()
                .unwrap()
                .next_scan_time_index;
            while time_index < scan_times.len() {
                if scan_times[time_index] as f64 > arrival_upper_bound {
                    break;
                }
                let start = scan_time_offsets[time_index] as usize;
                let end = scan_time_offsets[time_index + 1] as usize;
                envelope.departure_events_scanned += (end - start) as u64;
                for event in &scan_events[start..end] {
                    set_run_bit(&mut forward_workspace.scalar_runs, event.run());
                }
                time_index += 1;
            }
            // Capped Route certification can be followed immediately by an
            // arrive-by deadline or preference certification. Keep this exact
            // request's universal reachability envelope and its scanned suffix
            // instead of rebuilding the same forward search. A smaller later
            // deadline sees a harmless superset; exact rounds still enforce it.
            forward_workspace
                .scalar_identity
                .as_mut()
                .unwrap()
                .next_scan_time_index = time_index;
            envelope
        } else {
            forward_workspace.scalar_runs.fill(0);
            build_forward_run_envelope_csa(
                forward_workspace,
                *stop_count,
                *run_count,
                boarding_upper_bound as usize,
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.departure,
                arrival_upper_bound,
                input.allow_pre_ride_transfers,
                scan_events,
                scan_times,
                scan_time_offsets,
                scan_time_needs_closure,
                scan_arrivals,
                transfer_offset,
                transfer_edges,
            )
        };
        // A separately built layered envelope overwrites scalar_runs. Never
        // retain its old scalar identity across that operation (or a query
        // that does not use the scalar envelope).
        if !scalar_envelope_reused {
            forward_workspace.scalar_identity = None;
        }
        let forward_ns = if restriction_mode.uses_forward() {
            forward_started.elapsed().as_nanos() as f64
        } else {
            0.0
        };
        let reverse_started = Instant::now();
        let forward_run_layers = if restriction_mode.uses_forward() && !scalar_envelope_reused {
            Some(&forward_workspace.run_layers[..boarding_upper_bound as usize])
        } else {
            None
        };
        let corridor = if restriction_mode.uses_reverse() {
            build_exact_deadline_corridor(
                *stop_count,
                *run_count,
                boarding_upper_bound as usize,
                restriction_mode.uses_forward(),
                forward_run_layers,
                &forward_workspace.scalar_runs,
                scalar_envelope_reused.then_some(&forward_workspace.scalar_first_boarding),
                &input.destination_stops,
                &input.destination_walk_seconds,
                departure_seconds,
                sequence,
                from_stop,
                can_board,
                run_start,
                run_end,
                scan_events.len(),
                reverse_transfer_offset,
                reverse_transfer_edges,
                exit_event_offset,
                exit_events,
                input.departure,
                arrival_upper_bound,
                if collect_alternatives || deadline_objective {
                    f64::INFINITY
                } else {
                    generalized_upper_bound
                },
                transfer_penalty_seconds,
                walk_reluctance,
            )
        } else {
            build_open_deadline_corridor(
                *stop_count,
                *run_count,
                scan_events.len(),
                boarding_upper_bound as usize,
                restriction_mode.uses_forward(),
                forward_run_layers,
                &forward_workspace.scalar_runs,
                run_start,
                run_end,
            )
        };
        let reverse_ns = if restriction_mode.uses_reverse() {
            reverse_started.elapsed().as_nanos() as f64
        } else {
            0.0
        };
        let corridor_ns = corridor_started.elapsed().as_nanos() as f64;
        let corridor_structure = corridor.structure;
        #[cfg(debug_assertions)]
        debug_assert_eq!(
            corridor_structure,
            corridor_structure_stats(&corridor, run_start, run_end)
        );
        let mut best = ParetoBest {
            deadline_objective,
            arrival: input.earliest_arrival,
            boardings: boarding_upper_bound,
            walking_seconds: input.candidate_walking_seconds,
            generalized_seconds: generalized_upper_bound,
            label: NO_STATE,
            destination_index: input.candidate_destination_index as i32,
            collect_alternatives,
            minimum_arrival: input.earliest_arrival,
            // Keep the anchor-only expansion as an independent reference for
            // both corridor and target-dominance pruning.
            prune_dominated_alternatives: collect_alternatives
                && !ranked_alternatives
                && restriction_mode != ParetoRestrictionMode::Only,
            retain_terminals: ranked_alternatives,
            // Arrival slack never extends the admitted timetable, including
            // when searching only for the primary journey.
            ride_horizon: input.horizon,
        };
        let mut stats = ParetoStats {
            terminal_candidates_evaluated: 1,
            ..ParetoStats::default()
        };
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            if !deadline_allows(
                corridor.stop_deadlines[boarding_upper_bound as usize][stop],
                arrival,
            ) {
                continue;
            }
            add_round_label(
                profile_workspace,
                origin_epoch,
                destination_workspace,
                destination_epoch,
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
                arrival_upper_bound,
                boarding_upper_bound,
                transfer_penalty_seconds,
                walk_reluctance,
            );
        }
        if input.allow_pre_ride_transfers {
            let origin_label_end = profile_workspace.labels.len();
            for index in 0..origin_label_end {
                if !profile_workspace.labels[index].active
                    || profile_workspace.labels[index].kind != 3
                {
                    continue;
                }
                let stop = profile_workspace.labels[index].state as usize / STATE_STRIDE;
                expand_round_transfers(
                    profile_workspace,
                    origin_epoch,
                    destination_workspace,
                    destination_epoch,
                    &mut best,
                    &mut stats,
                    transfer_offset,
                    transfer_edges,
                    &corridor.stop_deadlines[boarding_upper_bound as usize],
                    stop,
                    profile_workspace.labels[index].arrival,
                    false,
                    index as i32,
                    arrival_upper_bound,
                    boarding_upper_bound,
                    transfer_penalty_seconds,
                    walk_reluctance,
                );
            }
        }
        let mut previous_labels: Vec<i32> = (0..profile_workspace.labels.len())
            .filter(|index| profile_workspace.labels[*index].active)
            .map(|index| index as i32)
            .collect();
        if previous_labels.is_empty() {
            return Ok(empty_pareto_result(
                started,
                false,
                "origin_outside_kernel",
                restriction_mode,
            ));
        }

        let rounds_started = Instant::now();
        for round in 1..=boarding_upper_bound {
            let epoch = profile_workspace.next_round();
            let remaining = (boarding_upper_bound - round) as usize;
            previous_labels = execute_marked_run_round(
                profile_workspace,
                epoch,
                &mut previous_labels,
                round,
                destination_workspace,
                destination_epoch,
                &mut best,
                &mut stats,
                departure_seconds,
                arrival_seconds,
                from_stop,
                to_stop,
                sequence,
                segment_trip,
                segment_run,
                continuity_break,
                can_board,
                can_alight,
                departure_offset,
                departure_events,
                transfer_offset,
                transfer_edges,
                forbidden_same_stop,
                same_stop_transfer_minimum,
                transfer_buffer_seconds,
                run_start,
                run_end,
                &corridor.stop_deadlines[remaining],
                &corridor.run_layers[remaining],
                arrival_upper_bound,
                boarding_upper_bound,
                transfer_penalty_seconds,
                walk_reluctance,
            );
            // Rounds enumerate exact boarding counts. Once a deadline-feasible
            // round is exhausted, extra boardings cannot improve this objective.
            if (deadline_objective && round >= best.boardings)
                || profile_workspace.overflowed
                || previous_labels.is_empty()
            {
                break;
            }
        }
        let round_ns = rounds_started.elapsed().as_nanos() as f64;
        if profile_workspace.overflowed {
            return Ok(empty_pareto_result(
                started,
                false,
                "native_round_workspace_budget_exceeded",
                restriction_mode,
            ));
        }
        let alternatives = collect_alternatives.then(|| {
            if ranked_alternatives {
                collect_ranked_alternatives(
                    &profile_workspace.labels,
                    &profile_workspace.terminals,
                    destination_workspace,
                    input.alternative_limit.map_or(usize::MAX, |n| n as usize),
                )
            } else {
                collect_pareto_alternatives(
                    &profile_workspace.labels,
                    destination_workspace,
                    destination_epoch,
                    arrival_upper_bound,
                )
            }
        });
        let result = |chain: Vec<JourneyChainStep>,
                      improved_candidate: bool|
         -> TimetableParetoQueryResult {
            TimetableParetoQueryResult {
                supported: true,
                status: "ready".to_owned(),
                reason: None,
                best_arrival: Some(best.arrival),
                best_boardings: Some(best.boardings as u32),
                best_destination_index: Some(best.destination_index as u32),
                best_walking_seconds: Some(best.walking_seconds),
                best_generalized_seconds: Some(best.generalized_seconds),
                improved_candidate,
                alternatives,
                chain_kinds: chain.iter().map(|step| step.0).collect(),
                chain_from_stops: chain.iter().map(|step| step.1).collect(),
                chain_to_stops: chain.iter().map(|step| step.2).collect(),
                chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
                chain_board_sequences: chain.iter().map(|step| step.4).collect(),
                chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
                chain_durations: chain.iter().map(|step| step.6).collect(),
                chain_arrivals: chain.iter().map(|step| step.7).collect(),
                query_ns: started.elapsed().as_nanos() as f64,
                corridor_ns,
                forward_ns,
                reverse_ns,
                round_ns,
                corridor_exit_events: corridor.exit_events_scanned as f64,
                corridor_run_segments: corridor.run_segments_scanned as f64,
                corridor_transfer_edges: corridor.transfer_edges_scanned as f64,
                forward_departure_events: forward_envelope.departure_events_scanned as f64,
                forward_run_segments: forward_envelope.run_segments_scanned as f64,
                forward_transfer_edges: forward_envelope.transfer_edges_scanned as f64,
                scanned_departures: stats.scanned_departures,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: stats.expanded_trip_runs,
                dominated_trip_boardings: stats.dominated_trip_boardings,
                explicit_transfer_checks: stats.explicit_transfer_checks,
                dominated_candidate_labels: stats.dominated_candidate_labels,
                dominated_existing_labels: stats.dominated_existing_labels,
                terminal_candidates_evaluated: stats.terminal_candidates_evaluated,
                pareto_labels: profile_workspace.labels.len() as u32,
                run_profiles: stats.expanded_trip_runs,
                restriction_mode: restriction_mode.as_str().to_owned(),
                forward_restriction_applied: restriction_mode.uses_forward(),
                reverse_restriction_applied: restriction_mode.uses_reverse(),
                scalar_envelope_reused,
                forward_envelope_built,
                reverse_corridor_built: restriction_mode.uses_reverse(),
                retained_run_layer_memberships: corridor_structure.retained_run_layer_memberships
                    as f64,
                total_run_layer_memberships: corridor_structure.total_run_layer_memberships as f64,
                retained_segment_layer_memberships: corridor_structure
                    .retained_segment_layer_memberships
                    as f64,
                total_segment_layer_memberships: corridor_structure.total_segment_layer_memberships
                    as f64,
                retained_stop_deadline_memberships: corridor_structure
                    .retained_stop_deadline_memberships
                    as f64,
                total_stop_deadline_memberships: corridor_structure.total_stop_deadline_memberships
                    as f64,
                retained_unique_runs: corridor_structure.retained_unique_runs,
                restriction_bytes: corridor_structure.restriction_bytes as f64,
                label_bytes: (profile_workspace.labels.len() * std::mem::size_of::<ProfileLabel>())
                    as f64,
            }
        };
        if best.label < 0 {
            return Ok(result(Vec::new(), false));
        }
        let chain = profile_label_chain(&profile_workspace.labels, best.label);
        Ok(result(chain, true))
    }
}
