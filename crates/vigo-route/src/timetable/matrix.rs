use super::*;

impl TimetableKernel {
    /// Schedule both time directions inside one Node-API boundary. A fixed
    /// departure shares a scan across destinations; a fixed deadline shares a
    /// reverse scan across origins. Matrix orientation never changes the time
    /// constraint or reverses the directed physical network.
    pub fn route_matrix_csa(
        &mut self,
        input: TimetableMatrixQueryInput,
    ) -> Result<TimetableMatrixQueryResult> {
        let started = Instant::now();
        let origin_count = input.origin_offsets.len().saturating_sub(1);
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
        let valid_offsets = |offsets: &[u32], count: usize| {
            offsets.first() == Some(&0)
                && offsets.last().is_some_and(|last| *last as usize == count)
                && offsets.windows(2).all(|pair| pair[0] <= pair[1])
        };
        if origin_count == 0
            || destination_count == 0
            || origin_count.saturating_mul(destination_count) > crate::MAXIMUM_MATRIX_PAIRS
            || !valid_offsets(&input.origin_offsets, input.origin_stops.len())
            || !valid_offsets(&input.destination_offsets, input.destination_stops.len())
            || input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.allow_pre_ride_transfers.len() != origin_count
        {
            return Err(Error::from_reason(
                "Rust timetable matrix arrays or size are inconsistent.",
            ));
        }
        let mut output = TimetableMatrixQueryResult {
            journeys: None,
            times: vec![
                if input.arrive_by {
                    f64::NEG_INFINITY
                } else {
                    f64::INFINITY
                };
                origin_count * destination_count
            ],
            forward_searches: 0,
            reverse_searches: 0,
            query_ns: 0.0,
            scanned_departures: 0.0,
            relaxed_stops: 0.0,
            expanded_trip_runs: 0.0,
            dominated_trip_boardings: 0.0,
            explicit_transfer_checks: 0.0,
        };
        // A coordinate point journey can use the same destination-directed
        // scalar scan as Route to establish its primary bound. An unrestricted
        // witness proves the capped bound only when it fits the requested cap;
        // otherwise keep the exact layered Matrix scan below. The full journey
        // rounds still certify boarding/walking ties and reconstruct the same
        // witness; this shortcut never substitutes the scalar witness itself.
        let point_bound = if origin_count == 1
            && destination_count == 1
            && !input.arrive_by
            && input.include_journeys == Some(true)
            && !input.allow_pre_ride_transfers[0]
            && input
                .allow_post_ride_transfers
                .as_ref()
                .is_some_and(|flags| !flags[0])
        {
            boarding_layers(input.maximum_boardings)?;
            let scalar = self.route_scalar_csa(TimetableQueryInput {
                origin_stops: input.origin_stops.clone(),
                origin_walk_seconds: input.origin_walk_seconds.clone(),
                origin_candidate_indices: (0..input.origin_stops.len() as u32).collect(),
                destination_stops: input.destination_stops.clone(),
                destination_walk_seconds: input.destination_walk_seconds.clone(),
                destination_candidate_indices: (0..input.destination_stops.len() as u32).collect(),
                departure: input.departure,
                horizon: input.horizon,
                allow_pre_ride_transfers: false,
                allow_post_ride_transfers: Some(false),
                maximum_boardings: None,
            })?;
            (scalar.supported
                && (scalar.status == "blocked"
                    || scalar.best_boardings.is_some_and(|boardings| {
                        input.maximum_boardings.is_none_or(|cap| boardings <= cap)
                    })))
            .then_some(scalar)
        } else {
            None
        };
        if let Some(bound) = point_bound {
            output.times[0] = bound.best_arrival.unwrap_or(f64::INFINITY);
            output.forward_searches = 1;
            output.scanned_departures = f64::from(bound.scanned_departures);
            output.relaxed_stops = f64::from(bound.relaxed_stops);
            output.expanded_trip_runs = f64::from(bound.expanded_trip_runs);
            output.dominated_trip_boardings = f64::from(bound.dominated_trip_boardings);
            output.explicit_transfer_checks = f64::from(bound.explicit_transfer_checks);
        } else if origin_count == 1
            && destination_count == 1
            && input.arrive_by
            && !input.allow_pre_ride_transfers[0]
            && input
                .allow_post_ride_transfers
                .as_ref()
                .is_some_and(|flags| !flags[0])
        {
            let bound = self.route_arrive_by_csa(TimetableArriveByQueryInput {
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
                maximum_boardings: input.maximum_boardings,
            })?;
            output.times[0] = bound.latest_departure.unwrap_or(f64::NEG_INFINITY);
            output.reverse_searches = 1;
            output.scanned_departures = f64::from(bound.scanned_departures);
            output.relaxed_stops = f64::from(bound.relaxed_stops);
            output.expanded_trip_runs = f64::from(bound.expanded_trip_runs);
            output.dominated_trip_boardings = f64::from(bound.dominated_trip_boardings);
            output.explicit_transfer_checks = f64::from(bound.explicit_transfer_checks);
        } else if input.arrive_by {
            // Keep the shared endpoint arrays once for the batch. Each reverse
            // search changes only its destination frontier and terminal policy.
            let mut query = TimetableArriveByManyQueryInput {
                origin_offsets: input.origin_offsets.clone(),
                origin_stops: input.origin_stops.clone(),
                origin_walk_seconds: input.origin_walk_seconds.clone(),
                allow_pre_ride_transfers: input.allow_pre_ride_transfers.clone(),
                allow_post_ride_transfers: None,
                destination_stops: Vec::new(),
                destination_walk_seconds: Vec::new(),
                earliest: input.departure,
                deadline: input.horizon,
                excluded_trips: Vec::new(),
                maximum_boardings: input.maximum_boardings,
            };
            for destination in 0..destination_count {
                let range = input.destination_offsets[destination] as usize
                    ..input.destination_offsets[destination + 1] as usize;
                query.allow_post_ride_transfers = input
                    .allow_post_ride_transfers
                    .as_ref()
                    .map(|flags| flags[destination]);
                query.destination_stops.clear();
                query
                    .destination_stops
                    .extend_from_slice(&input.destination_stops[range.clone()]);
                query.destination_walk_seconds.clear();
                query
                    .destination_walk_seconds
                    .extend_from_slice(&input.destination_walk_seconds[range]);
                let result = self.route_arrive_by_many_csa_impl(&query)?;
                for (origin, departure) in result.latest_departures.into_iter().enumerate() {
                    output.times[origin * destination_count + destination] = departure;
                }
                output.reverse_searches += 1;
                output.scanned_departures += f64::from(result.scanned_departures);
                output.relaxed_stops += f64::from(result.relaxed_stops);
                output.expanded_trip_runs += f64::from(result.expanded_trip_runs);
                output.dominated_trip_boardings += f64::from(result.dominated_trip_boardings);
                output.explicit_transfer_checks += f64::from(result.explicit_transfer_checks);
            }
        } else {
            let mut query = TimetableManyQueryInput {
                origin_stops: Vec::new(),
                origin_walk_seconds: Vec::new(),
                allow_post_ride_transfers: input.allow_post_ride_transfers.clone(),
                destination_offsets: input.destination_offsets.clone(),
                destination_stops: input.destination_stops.clone(),
                destination_walk_seconds: input.destination_walk_seconds.clone(),
                departure: input.departure,
                horizon: input.horizon,
                allow_pre_ride_transfers: false,
                excluded_trips: Vec::new(),
                maximum_boardings: input.maximum_boardings,
            };
            for origin in 0..origin_count {
                let range = input.origin_offsets[origin] as usize
                    ..input.origin_offsets[origin + 1] as usize;
                query.origin_stops.clear();
                query
                    .origin_stops
                    .extend_from_slice(&input.origin_stops[range.clone()]);
                query.origin_walk_seconds.clear();
                query
                    .origin_walk_seconds
                    .extend_from_slice(&input.origin_walk_seconds[range]);
                query.allow_pre_ride_transfers = input.allow_pre_ride_transfers[origin];
                let result = self.route_many_csa_impl(&query)?;
                output.times[origin * destination_count..(origin + 1) * destination_count]
                    .copy_from_slice(&result.best_arrivals);
                output.forward_searches += 1;
                output.scanned_departures += f64::from(result.scanned_departures);
                output.relaxed_stops += f64::from(result.relaxed_stops);
                output.expanded_trip_runs += f64::from(result.expanded_trip_runs);
                output.dominated_trip_boardings += f64::from(result.dominated_trip_boardings);
                output.explicit_transfer_checks += f64::from(result.explicit_transfer_checks);
            }
        }
        if input.include_journeys.unwrap_or(false) {
            output = self.matrix_journeys(&input, output)?;
        }
        output.query_ns = started.elapsed().as_nanos() as f64;
        Ok(output)
    }
}
