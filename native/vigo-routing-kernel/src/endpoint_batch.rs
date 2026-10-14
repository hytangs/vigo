use super::*;

impl CoordinateKernel {
    /// Project independent coordinates with a bounded four-worker pool.
    /// Only uncached CCH batches use this path; retained endpoint caches keep
    /// their ordinary sequential semantics. Results retain input order.
    pub(crate) fn route_endpoint_batch(
        &mut self,
        coordinates: &[[f64; 2]],
        input: EndpointRoleInput,
    ) -> napi::Result<Vec<EndpointRoleResult>> {
        if coordinates.len() < 32
            || input.disable_cache != Some(true)
            || input.maximum_walk_m > CCH_MAXIMUM_QUERY_DISTANCE_M
            || self.street_cch.is_none()
        {
            return coordinates
                .iter()
                .map(|&[longitude, latitude]| {
                    self.route_endpoint(EndpointRoleInput {
                        longitude,
                        latitude,
                        maximum_walk_m: input.maximum_walk_m,
                        walking_speed_kph: input.walking_speed_kph,
                        access_padding_factor: input.access_padding_factor,
                        access_overhead_seconds: input.access_overhead_seconds,
                        role: input.role.clone(),
                        disable_cache: input.disable_cache,
                    })
                })
                .collect();
        }
        if !input.maximum_walk_m.is_finite() || input.maximum_walk_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumWalkM must be a positive finite number.",
            ));
        }
        let reverse = match input.role.as_str() {
            "origin" => false,
            "destination" => true,
            _ => {
                return Err(Error::from_reason(
                    "Endpoint role must be origin or destination.",
                ));
            }
        };
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?;
        let timing = AccessTiming::resolve(
            profile,
            input.walking_speed_kph,
            input.access_padding_factor,
            input.access_overhead_seconds,
        )?;
        let index = self.street_cch.as_mut().unwrap();
        let buckets = if reverse {
            index.destination_buckets.as_ref()
        } else {
            index.origin_buckets.as_ref()
        };
        let snapshot = &self.snapshot;
        let terminals = self.terminal_access.as_deref();
        let reciprocal = snapshot.reciprocal_edge_flags();
        let structure = &index.structure;
        let metric = &index.metric;
        let run = |points: &[[f64; 2]],
                   workspace: &mut TileWorkspace,
                   snaps: &mut SnapWorkspace,
                   query: &mut DynamicCchQuery,
                   members: &mut CchMemberWorkspace,
                   reduction: &mut AccessReductionWorkspace|
         -> napi::Result<_> {
            // Caching is disabled. These empty containers satisfy the shared
            // search interface without reading or mutating either role cache.
            let mut cache = HashMap::new();
            let mut order = VecDeque::new();
            let mut bytes = 0;
            let mut results = Vec::with_capacity(points.len());
            let mut last = None;
            for &[longitude, latitude] in points {
                let query_started = Instant::now();
                let result = cached_cch_frontier_search(
                    snapshot,
                    terminals,
                    reciprocal,
                    workspace,
                    snaps,
                    profile,
                    structure,
                    metric,
                    query,
                    members,
                    buckets,
                    &mut cache,
                    &mut order,
                    &mut bytes,
                    0,
                    longitude,
                    latitude,
                    input.maximum_walk_m,
                    reverse,
                    true,
                )?;
                let access = reduce_access_frontier(
                    profile,
                    timing,
                    &result.frontier,
                    reduction,
                    AccessEndpoint {
                        longitude,
                        latitude,
                        maximum_walk_m: input.maximum_walk_m,
                        origin_role: !reverse,
                    },
                );
                last = Some(Arc::clone(&result.frontier));
                results.push(EndpointRoleResult {
                    query_token: 0,
                    cache_hit: result.cache_hit,
                    member_indices: access.member_indices,
                    path_member_indices: access.path_member_indices,
                    distances_m: access.distances_m,
                    access_seconds: access.access_seconds,
                    candidate_kinds: access.candidate_kinds,
                    link_from_stop_keys: access.link_from_stop_keys,
                    link_to_stop_keys: access.link_to_stop_keys,
                    link_durations: access.link_durations,
                    link_path_distances_m: access.link_path_distances_m,
                    link_street_verified: access.link_street_verified,
                    query_ns: query_started.elapsed().as_nanos() as f64,
                    access_reduction_ns: access.reduction_ns,
                    snap_ns: result.snap_ns,
                    search_ns: result.search_ns,
                    settled_nodes: result.frontier.settled_nodes,
                    relaxed_edges: result.frontier.relaxed_edges,
                    raw_candidates: result.frontier.member_indices.len() as u32,
                    linked_stations: access.linked_stations,
                    cch_accelerated: result.frontier.cch_accelerated,
                });
            }
            Ok((results, last))
        };
        // Two additional workspaces are scoped to this batch. They share the
        // immutable graph/profile and release their scratch when it finishes.
        let mut extra_tiles = [TileWorkspace::new(), TileWorkspace::new()];
        let mut extra_snaps = [SnapWorkspace::default(), SnapWorkspace::default()];
        let mut extra_queries = [DynamicCchQuery::new(0), DynamicCchQuery::new(0)];
        let mut extra_members = [CchMemberWorkspace::new(), CchMemberWorkspace::new()];
        let mut extra_reductions = [
            AccessReductionWorkspace::new(),
            AccessReductionWorkspace::new(),
        ];
        let [tiles_a, tiles_b] = &mut extra_tiles;
        let [snaps_a, snaps_b] = &mut extra_snaps;
        let [query_a, query_b] = &mut extra_queries;
        let [members_a, members_b] = &mut extra_members;
        let [reduction_a, reduction_b] = &mut extra_reductions;
        let (left, right) = coordinates.split_at(coordinates.len() / 2);
        let (a, b) = left.split_at(left.len() / 2);
        let (c, d) = right.split_at(right.len() / 2);
        let ((a, b), (c, d)) = join_endpoint_access(
            || {
                join_endpoint_access(
                    || {
                        run(
                            a,
                            &mut self.origin_workspace,
                            &mut self.origin_snap_workspace,
                            &mut index.forward_query,
                            &mut index.origin_member_workspace,
                            &mut self.origin_access_reduction_workspace,
                        )
                    },
                    || run(b, tiles_a, snaps_a, query_a, members_a, reduction_a),
                )
            },
            || {
                join_endpoint_access(
                    || {
                        run(
                            c,
                            &mut self.destination_workspace,
                            &mut self.destination_snap_workspace,
                            &mut index.reverse_query,
                            &mut index.destination_member_workspace,
                            &mut self.destination_access_reduction_workspace,
                        )
                    },
                    || run(d, tiles_b, snaps_b, query_b, members_b, reduction_b),
                )
            },
        );
        let (mut results, _) = a?;
        results.extend(b?.0);
        results.extend(c?.0);
        let (remaining, last) = d?;
        results.extend(remaining);
        for result in &mut results {
            self.query_token = self.query_token.wrapping_add(1).max(1);
            result.query_token = self.query_token;
        }
        if reverse {
            self.last_destination_frontier = last;
        } else {
            self.last_origin_frontier = last;
        }
        Ok(results)
    }
}
