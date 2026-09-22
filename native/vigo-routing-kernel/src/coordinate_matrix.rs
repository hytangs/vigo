//! Shared directed street-matrix execution. Coordinate transit batches may
//! reuse same-request public street attachments, even when caches are disabled.
use super::*;

type MatrixSnapSets = (Vec<Vec<Snap>>, Vec<Vec<Snap>>);

struct MatrixEndpointProjection {
    offsets: Vec<u32>,
    stops: Vec<u32>,
    seconds: Vec<f64>,
    snaps: Vec<Vec<Snap>>,
    cache_hits: u32,
}

#[napi]
impl CoordinateKernel {
    /// Coordinate Matrix keeps endpoint frontiers and their timetable
    /// projection in Rust. It uses the same directed endpoint search and the
    /// same shared timetable scan as the separately exposed operations.
    #[napi]
    pub fn route_endpoints_timetable_matrix(
        &mut self,
        mut timetable: ClassInstance<'_, TimetableKernel>,
        input: CoordinateTimetableMatrixInput,
    ) -> napi::Result<CoordinateTimetableMatrixResult> {
        let started = Instant::now();
        if input
            .direct_walk_maximum_m
            .is_some_and(|distance| !distance.is_finite() || distance <= 0.0)
        {
            return Err(Error::from_reason(
                "Matrix direct-walk limit must be positive and finite.",
            ));
        }
        let origin_count = input.origin_coordinates.len() / 2;
        let destination_count = input.destination_coordinates.len() / 2;
        let member_count = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?
            .member_lons
            .len();
        if origin_count == 0
            || destination_count == 0
            || !input.origin_coordinates.len().is_multiple_of(2)
            || !input.destination_coordinates.len().is_multiple_of(2)
            || origin_count > MAXIMUM_MATRIX_PAIRS / destination_count
            || input.member_timetable_stops.len() != member_count
            || input
                .origin_coordinates
                .chunks_exact(2)
                .chain(input.destination_coordinates.chunks_exact(2))
                .any(|point| {
                    !point[0].is_finite()
                        || !point[1].is_finite()
                        || point[0].abs() > 180.0
                        || point[1].abs() > 90.0
                })
        {
            return Err(Error::from_reason(
                "Coordinate Matrix requires valid coordinates, a matching stop projection, and at most 100,000 pairs.",
            ));
        }
        let reuse_snaps = input.direct_walk_maximum_m.is_some() && self.terminal_access.is_none();
        let destinations =
            self.project_matrix_endpoints(&input, &input.destination_coordinates, true)?;
        let origins = self.project_matrix_endpoints(&input, &input.origin_coordinates, false)?;
        let access_ns = started.elapsed().as_nanos() as f64;
        let result = timetable.route_matrix_csa(TimetableMatrixQueryInput {
            origin_offsets: origins.offsets,
            origin_stops: origins.stops,
            origin_walk_seconds: origins.seconds,
            destination_offsets: destinations.offsets,
            destination_stops: destinations.stops,
            destination_walk_seconds: destinations.seconds,
            allow_pre_ride_transfers: vec![false; origin_count],
            allow_post_ride_transfers: Some(vec![false; destination_count]),
            departure: input.departure,
            horizon: input.horizon,
            arrive_by: input.arrive_by,
            maximum_boardings: input.maximum_boardings,
            include_journeys: input.include_journeys,
        })?;
        let direct_walk = if let Some(maximum_distance_m) = input.direct_walk_maximum_m {
            Some(self.street_matrix_with_snaps(
                StreetMatrixInput {
                    origin_coordinates: input.origin_coordinates,
                    destination_coordinates: input.destination_coordinates,
                    maximum_distance_m,
                    disable_cache: input.disable_cache,
                },
                reuse_snaps.then_some((origins.snaps, destinations.snaps)),
            )?)
        } else {
            None
        };
        Ok(CoordinateTimetableMatrixResult {
            direct_walk,
            origin_cache_hits: origins.cache_hits,
            destination_cache_hits: destinations.cache_hits,
            cache_disabled: input.disable_cache.unwrap_or(false),
            timetable: result,
            access_ns,
            query_ns: started.elapsed().as_nanos() as f64,
        })
    }

    /// CCH query shares one destination frontier across every source row and
    /// returns scalar distances only; path geometry remains an explicit
    /// point-query concern.
    #[napi]
    pub fn route_street_matrix(
        &mut self,
        input: StreetMatrixInput,
    ) -> napi::Result<StreetMatrixResult> {
        self.street_matrix_with_snaps(input, None)
    }
}

impl CoordinateKernel {
    fn project_matrix_endpoints(
        &mut self,
        input: &CoordinateTimetableMatrixInput,
        coordinates: &[f64],
        reverse: bool,
    ) -> napi::Result<MatrixEndpointProjection> {
        let reuse_snaps = input.direct_walk_maximum_m.is_some() && self.terminal_access.is_none();
        let mut projected = MatrixEndpointProjection {
            offsets: Vec::with_capacity(coordinates.len() / 2 + 1),
            stops: Vec::new(),
            seconds: Vec::new(),
            snaps: if reuse_snaps {
                Vec::with_capacity(coordinates.len() / 2)
            } else {
                Vec::new()
            },
            cache_hits: 0,
        };
        projected.offsets.push(0);
        for point in coordinates.chunks_exact(2) {
            let access = self.route_endpoint(EndpointRoleInput {
                longitude: point[0],
                latitude: point[1],
                role: if reverse { "destination" } else { "origin" }.to_owned(),
                maximum_walk_m: input.maximum_walk_m,
                walking_speed_kph: input.walking_speed_kph,
                access_padding_factor: input.access_padding_factor,
                access_overhead_seconds: input.access_overhead_seconds,
                disable_cache: input.disable_cache,
            })?;
            projected.cache_hits += u32::from(access.cache_hit);
            if reuse_snaps {
                let frontier = if reverse {
                    self.last_destination_frontier.as_ref()
                } else {
                    self.last_origin_frontier.as_ref()
                };
                projected.snaps.push(
                    frontier
                        .expect("route_endpoint retains its frontier")
                        .source_snaps
                        .clone(),
                );
            }
            for (&member, &walk) in access.member_indices.iter().zip(&access.access_seconds) {
                let stop = input.member_timetable_stops[member as usize];
                if stop != u32::MAX {
                    projected.stops.push(stop);
                    projected.seconds.push(f64::from(walk));
                }
            }
            projected
                .offsets
                .push(u32::try_from(projected.stops.len()).map_err(|_| {
                    Error::from_reason(
                        "Coordinate Matrix endpoint frontier exceeds native index capacity.",
                    )
                })?);
        }
        Ok(projected)
    }

    pub(crate) fn street_matrix_with_snaps(
        &mut self,
        input: StreetMatrixInput,
        prepared: Option<MatrixSnapSets>,
    ) -> napi::Result<StreetMatrixResult> {
        let (origin_coordinate_pairs, origin_remainder) = input.origin_coordinates.as_chunks::<2>();
        let (destination_coordinate_pairs, destination_remainder) =
            input.destination_coordinates.as_chunks::<2>();
        let origin_count = origin_coordinate_pairs.len();
        let destination_count = destination_coordinate_pairs.len();
        if !origin_remainder.is_empty()
            || !destination_remainder.is_empty()
            || origin_count == 0
            || destination_count == 0
        {
            return Err(Error::from_reason(
                "Street matrix coordinates must contain non-empty longitude/latitude pairs.",
            ));
        }
        if origin_count.saturating_mul(destination_count) > MAXIMUM_MATRIX_PAIRS {
            return Err(Error::from_reason(
                "Street matrices are limited to 100,000 pairs.",
            ));
        }
        if input
            .origin_coordinates
            .iter()
            .chain(input.destination_coordinates.iter())
            .any(|coordinate| !coordinate.is_finite())
            || !input.maximum_distance_m.is_finite()
            || input.maximum_distance_m <= 0.0
        {
            return Err(Error::from_reason(
                "Street matrix coordinates or distance bound are inconsistent.",
            ));
        }

        let started = Instant::now();
        let reused_endpoint_snaps = if prepared.is_some() {
            (origin_count + destination_count) as u32
        } else {
            0
        };
        let (origin_access, destination_access) = if let Some((origins, destinations)) = prepared {
            if origins.len() != origin_count
                || destinations.len() != destination_count
                || self.terminal_access.is_some()
            {
                return Err(Error::from_reason(
                    "Prepared Matrix street attachments are inconsistent.",
                ));
            }
            (
                origins
                    .into_iter()
                    .map(|snaps| (snaps, None))
                    .collect::<Vec<_>>(),
                destinations
                    .into_iter()
                    .map(|snaps| (snaps, None))
                    .collect::<Vec<_>>(),
            )
        } else {
            let reciprocal_edge_flags = self.snapshot.reciprocal_edge_flags();
            let origin_access = origin_coordinate_pairs
                .iter()
                .map(|pair| {
                    let key = EndpointCacheKey::new(pair[0], pair[1], input.maximum_distance_m);
                    if !input.disable_cache.unwrap_or(false)
                        && let Some(frontier) = self.origin_cache.get(&key)
                        && (!frontier.source_snaps.is_empty()
                            || frontier.terminal_attachment.is_some())
                    {
                        return Ok((
                            frontier.source_snaps.clone(),
                            frontier.terminal_attachment.clone(),
                        ));
                    }
                    terminal_endpoint_snaps(
                        &self.snapshot,
                        self.terminal_access.as_ref(),
                        snaps_for_coordinate(
                            &self.snapshot,
                            reciprocal_edge_flags,
                            pair[0],
                            pair[1],
                        )?,
                        pair[0],
                        pair[1],
                        input.maximum_distance_m,
                        false,
                    )
                })
                .collect::<napi::Result<Vec<_>>>()?;
            let destination_access = destination_coordinate_pairs
                .iter()
                .map(|pair| {
                    let key = EndpointCacheKey::new(pair[0], pair[1], input.maximum_distance_m);
                    if !input.disable_cache.unwrap_or(false)
                        && let Some(frontier) = self.destination_cache.get(&key)
                        && (!frontier.source_snaps.is_empty()
                            || frontier.terminal_attachment.is_some())
                    {
                        return Ok((
                            frontier.source_snaps.clone(),
                            frontier.terminal_attachment.clone(),
                        ));
                    }
                    terminal_endpoint_snaps(
                        &self.snapshot,
                        self.terminal_access.as_ref(),
                        snaps_for_coordinate(
                            &self.snapshot,
                            reciprocal_edge_flags,
                            pair[0],
                            pair[1],
                        )?,
                        pair[0],
                        pair[1],
                        input.maximum_distance_m,
                        true,
                    )
                })
                .collect::<napi::Result<Vec<_>>>()?;
            (origin_access, destination_access)
        };
        let (origin_snaps, origin_attachments): (Vec<_>, Vec<_>) =
            origin_access.into_iter().unzip();
        let (destination_snaps, destination_attachments): (Vec<_>, Vec<_>) =
            destination_access.into_iter().unzip();
        let reverse = origin_count > destination_count;
        let (target_coordinates, target_snaps, source_snaps) = if reverse {
            (&input.origin_coordinates, &origin_snaps, &destination_snaps)
        } else {
            (
                &input.destination_coordinates,
                &destination_snaps,
                &origin_snaps,
            )
        };
        let targets = cch_coordinate_targets_from_snap_sets(target_coordinates, target_snaps);
        let mut distances_m = vec![f64::INFINITY; origin_count * destination_count];
        let mut ready_pairs = 0_u32;
        let source_candidates = origin_snaps.iter().fold(0_u32, |count, snaps| {
            count.saturating_add(snaps.len() as u32)
        });
        let destination_candidates = destination_snaps.iter().fold(0_u32, |count, snaps| {
            count.saturating_add(snaps.len() as u32)
        });

        let Some(index) = self.street_cch.as_mut() else {
            return Err(Error::from_reason(
                "Rust street matrix routing requires a loaded current CCH index.",
            ));
        };
        let buckets = coordinate_matrix_buckets(
            index,
            &targets,
            source_snaps.len(),
            input.maximum_distance_m,
            reverse,
        )?;
        for (source, source_snap_set) in source_snaps.iter().enumerate() {
            let sources = source_snap_set
                .iter()
                .map(|snap| (snap.node, cch_distance_units(snap.distance_m)))
                .collect::<Vec<_>>();
            let row = cch_distances_to_coordinate_targets(
                index,
                &sources,
                &targets,
                input.maximum_distance_m,
                buckets.as_ref(),
                reverse,
            );
            for (target, distance) in row.iter().copied().enumerate() {
                let (origin, destination) = if reverse {
                    (target, source)
                } else {
                    (source, target)
                };
                let private_distance = origin_attachments[origin]
                    .as_ref()
                    .and_then(|a| {
                        destination_attachments[destination]
                            .as_ref()
                            .and_then(|b| a.direct_to(b))
                    })
                    .map_or(f64::INFINITY, |(d, _)| d);
                let distance = if private_distance <= input.maximum_distance_m {
                    distance.min(private_distance)
                } else {
                    distance
                };
                let matrix_index = origin * destination_count + destination;
                if input.origin_coordinates[origin * 2..origin * 2 + 2]
                    == input.destination_coordinates[destination * 2..destination * 2 + 2]
                {
                    distances_m[matrix_index] = 0.0;
                    ready_pairs = ready_pairs.saturating_add(1);
                } else if distance.is_finite() {
                    distances_m[matrix_index] = distance;
                    ready_pairs = ready_pairs.saturating_add(1);
                }
            }
        }

        Ok(StreetMatrixResult {
            distances_m,
            ready_pairs,
            reused_endpoint_snaps,
            source_candidates,
            destination_candidates,
            query_ns: started.elapsed().as_nanos() as f64,
            cch_accelerated: true,
            algorithm: "rust_cch_coordinate_distance_matrix_v1".to_owned(),
        })
    }
}
