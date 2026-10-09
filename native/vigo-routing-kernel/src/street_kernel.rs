//! Immutable graph admission and native kernel construction.
use super::*;

pub(super) fn open_street_cch_bundles(
    input: &StreetCchLoadInput,
) -> napi::Result<(Arc<cch::CchBundle>, Arc<cch::MetricBundle>)> {
    Ok((
        shared_streets::structure(&input.structure_path)?,
        shared_streets::metric(&input.metric_path)?,
    ))
}

impl CoordinateKernel {
    pub(crate) fn memory_ledger(&self) -> serde_json::Value {
        let mut mapped = self.snapshot.mmap.len();
        let mut workspace = self.origin_workspace.byte_length()
            + self.destination_workspace.byte_length()
            + self.path_workspace.byte_length()
            + self.reverse_path_workspace.byte_length();
        let mut access = self.profile.as_ref().map_or(0, AccessProfile::byte_length);
        let mut access_mapped = 0;
        if let Some(index) = &self.street_cch {
            mapped += index.structure.mmap_bytes().len() + index.metric.mmap_bytes().len();
            workspace += index.forward_query.byte_length()
                + index.reverse_query.byte_length()
                + index
                    .path_query
                    .as_ref()
                    .map_or(0, cch::PathQuery::byte_length)
                + index.origin_member_workspace.byte_length()
                + index.destination_member_workspace.byte_length();
            let mut seen = HashSet::new();
            for bucket in [&index.origin_buckets, &index.destination_buckets]
                .into_iter()
                .flatten()
            {
                match &bucket.storage {
                    CchBucketStorage::Owned { offsets, entries } => {
                        access += offsets.capacity() * 4
                            + entries.capacity() * size_of::<CchBucketEntry>()
                    }
                    CchBucketStorage::Mapped { mmap, .. } => {
                        if seen.insert(Arc::as_ptr(mmap)) {
                            access_mapped += mmap.len();
                        }
                    }
                }
            }
        }
        for w in [
            &self.origin_snap_workspace,
            &self.destination_snap_workspace,
        ] {
            workspace += w.evaluated_from_nodes.capacity() * 5
                + w.candidate_nodes.capacity() * size_of::<Snap>()
                + w.projected_edges.capacity() * size_of::<ReciprocalEdgeSnap>();
        }
        for w in [
            &self.origin_access_reduction_workspace,
            &self.destination_access_reduction_workspace,
        ] {
            workspace += (w.source_generation.capacity()
                + w.source_touched.capacity()
                + w.direct_station_generation.capacity()
                + w.direct_station_touched.capacity()
                + w.linked_station_generation.capacity()
                + w.linked_station_touched.capacity()
                + w.selected_generation.capacity()
                + w.selected_touched.capacity())
                * 4
                + (w.sources.capacity() + w.direct_stations.capacity()) * size_of::<DirectSource>()
                + w.linked_stations.capacity() * size_of::<LinkedSource>()
                + w.selected.capacity() * size_of::<AccessLabel>();
        }
        let mut cache = self.surface_snap_cache.byte_length();
        let mut frontiers = HashSet::new();
        for (entries, order) in [
            (&self.origin_cache, &self.origin_cache_order),
            (&self.destination_cache, &self.destination_cache_order),
        ] {
            cache += frontier_cache_bytes(entries, order, 0);
            for value in entries.values() {
                if frontiers.insert(Arc::as_ptr(value)) {
                    cache += value.byte_length();
                }
            }
        }
        for value in [&self.last_origin_frontier, &self.last_destination_frontier]
            .into_iter()
            .flatten()
        {
            if frontiers.insert(Arc::as_ptr(value)) {
                cache += value.byte_length();
            }
        }
        serde_json::json!({"sharedMappedFileBytes":mapped,
            "sharedHeapBytes":self.snapshot.heap_bytes() + self.terminal_access.as_ref().map_or(0, |g|g.heap_bytes()),
            "accessHeapBytes":access,"accessMappedFileBytes":access_mapped,
            "workspaceHeapBytes":workspace,"cacheHeapBytes":cache,
            "cchForwardScratchBytes":self.street_cch.as_ref().map_or(0, |i|i.forward_query.byte_length()),
            "cchReverseScratchBytes":self.street_cch.as_ref().map_or(0, |i|i.reverse_query.byte_length()),
            "cchPathScratchBytes":self.street_cch.as_ref().and_then(|i|i.path_query.as_ref()).map_or(0, cch::PathQuery::byte_length),
            "tileScratchBytes":self.origin_workspace.byte_length()+self.destination_workspace.byte_length()+self.path_workspace.byte_length()+self.reverse_path_workspace.byte_length()})
    }
    pub(super) fn install_shared_street_cch(
        &mut self,
        structure: Arc<cch::CchBundle>,
        metric: Arc<cch::MetricBundle>,
    ) -> napi::Result<StreetCchLoadResult> {
        let started = Instant::now();
        let structure_view = structure.view();
        let metric_view = metric.view();
        let node_count = structure_view.node_count() as usize;
        let cch_arc_count = structure_view.cch_arc_count() as usize;
        if node_count != self.snapshot.header.node_count
            || metric_view.forward.len() != cch_arc_count
            || metric_view.backward.len() != cch_arc_count
        {
            return Err(Error::from_reason(
                "Street CCH index does not match the active street snapshot.",
            ));
        }
        let forward_query = DynamicCchQuery::new(0);
        let reverse_query = DynamicCchQuery::new(0);
        let origin_member_workspace = CchMemberWorkspace::new();
        let destination_member_workspace = CchMemberWorkspace::new();
        let workspace_bytes = forward_query.byte_length() + reverse_query.byte_length();
        self.street_cch = Some(StreetCchIndex {
            path_query: None,
            path_view: None,
            structure,
            metric,
            forward_query,
            reverse_query,
            origin_member_workspace,
            destination_member_workspace,
            origin_buckets: None,
            destination_buckets: None,
            bucket_build_ns: 0.0,
        });
        if let (Some(profile), Some(index)) = (&self.profile, &mut self.street_cch) {
            prepare_street_cch_target_buckets(profile, index)?;
        }
        // A cached exact-graph frontier and a CCH frontier have different path
        // witnesses. Never let one acceleration mode reuse the other's entry.
        self.clear_endpoint_caches();
        let result = StreetCchLoadResult {
            node_count: node_count as u32,
            cch_arc_count: cch_arc_count as u32,
            distance_units_per_meter: CCH_DISTANCE_UNITS_PER_METER,
            workspace_bytes: workspace_bytes as f64,
            load_ns: started.elapsed().as_nanos() as f64,
        };
        self.street_cch_load = Some(result.clone());
        Ok(result)
    }

    /// Share immutable street data. Stop profiles, target buckets, caches and
    /// retained path witnesses belong to the new kernel.
    #[cfg(feature = "standalone")]
    pub(crate) fn share_streets(&self) -> napi::Result<Self> {
        let mut kernel = Self::from_shared_snapshot(Arc::clone(&self.snapshot));
        kernel.terminal_access = self.terminal_access.clone();
        if let Some(index) = &self.street_cch {
            kernel.install_shared_street_cch(
                Arc::clone(&index.structure),
                Arc::clone(&index.metric),
            )?;
        }
        Ok(kernel)
    }

    /// The collection executes one query at a time. Transfer the large CCH
    /// search scratch to its next caller; profiles and retained witnesses stay
    /// with each City. Both indexes must own the same immutable mapped graph.
    #[cfg(feature = "standalone")]
    pub(crate) fn reuse_street_scratch(&mut self, donor: &mut Self) {
        let (Some(target), Some(source)) = (&mut self.street_cch, &mut donor.street_cch) else {
            return;
        };
        if Arc::ptr_eq(&target.structure, &source.structure)
            && Arc::ptr_eq(&target.metric, &source.metric)
        {
            if !donor.surface_snap_cache.is_empty() {
                self.surface_snap_cache = std::mem::take(&mut donor.surface_snap_cache);
            }
            if source.path_query.is_some() {
                target.path_query = source.path_query.take();
                target.path_view = source.path_view.take();
            }
            if !source.forward_query.distances.is_empty() {
                target.forward_query =
                    std::mem::replace(&mut source.forward_query, DynamicCchQuery::new(0));
            }
            if !source.reverse_query.distances.is_empty() {
                target.reverse_query =
                    std::mem::replace(&mut source.reverse_query, DynamicCchQuery::new(0));
            }
            for (target, source) in [
                (
                    &mut target.origin_member_workspace,
                    &mut source.origin_member_workspace,
                ),
                (
                    &mut target.destination_member_workspace,
                    &mut source.destination_member_workspace,
                ),
            ] {
                if !source.distances.is_empty() {
                    *target = std::mem::replace(source, CchMemberWorkspace::new());
                }
            }
            // Each operation begins a fresh generation. Persistent endpoint
            // witnesses own their predecessor arrays and do not borrow these.
            for (target, source) in [
                (&mut self.origin_workspace, &mut donor.origin_workspace),
                (
                    &mut self.destination_workspace,
                    &mut donor.destination_workspace,
                ),
                (&mut self.path_workspace, &mut donor.path_workspace),
                (
                    &mut self.reverse_path_workspace,
                    &mut donor.reverse_path_workspace,
                ),
            ] {
                if !source.distances.is_empty() {
                    *target = std::mem::replace(source, TileWorkspace::new());
                }
            }
        }
    }

    #[cfg(feature = "standalone")]
    pub(crate) fn shared_street_owners(&self) -> usize {
        Arc::strong_count(&self.snapshot)
    }

    #[cfg(feature = "standalone")]
    pub(crate) fn partition_cache_budget(&mut self, residents: usize) {
        self.endpoint_cache_budget = *MAXIMUM_ENDPOINT_CACHE_BYTES / residents.max(1);
    }

    pub(super) fn from_shared_snapshot(snapshot: Arc<Snapshot>) -> Self {
        let origin_workspace = TileWorkspace::new();
        let destination_workspace = TileWorkspace::new();
        let path_workspace = TileWorkspace::new();
        let reverse_path_workspace = TileWorkspace::new();
        Self {
            street_cch_load: None,
            snapshot,
            origin_workspace,
            destination_workspace,
            origin_snap_workspace: SnapWorkspace::default(),
            destination_snap_workspace: SnapWorkspace::default(),
            surface_snap_cache: street_analysis::SurfaceSnapCache::default(),
            origin_access_reduction_workspace: AccessReductionWorkspace::new(),
            destination_access_reduction_workspace: AccessReductionWorkspace::new(),
            path_workspace,
            reverse_path_workspace,
            street_cch: None,
            terminal_access: None,
            profile: None,
            query_token: 0,
            last_origin_frontier: None,
            last_destination_frontier: None,
            origin_cache: HashMap::new(),
            origin_cache_order: VecDeque::new(),
            origin_cache_bytes: 0,
            endpoint_cache_budget: *MAXIMUM_ENDPOINT_CACHE_BYTES,
            destination_cache: HashMap::new(),
            destination_cache_order: VecDeque::new(),
            destination_cache_bytes: 0,
        }
    }
}
