//! Immutable graph admission and native kernel construction.
use super::*;

pub(super) fn open_street_cch_bundles(
    input: &StreetCchLoadInput,
) -> napi::Result<(cch::CchBundle, cch::MetricBundle)> {
    let structure = cch::CchBundle::open(Path::new(&input.structure_path)).map_err(|error| {
        Error::from_reason(format!("Unable to mmap street CCH structure: {error}"))
    })?;
    let metric = cch::MetricBundle::open(Path::new(&input.metric_path)).map_err(|error| {
        Error::from_reason(format!("Unable to mmap street CCH metric: {error}"))
    })?;
    Ok((structure, metric))
}

impl CoordinateKernel {
    pub(super) fn install_street_cch(
        &mut self,
        structure: cch::CchBundle,
        metric: cch::MetricBundle,
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
        let forward_query = DynamicCchQuery::new(node_count);
        let reverse_query = DynamicCchQuery::new(node_count);
        let origin_member_workspace = CchMemberWorkspace::new();
        let destination_member_workspace = CchMemberWorkspace::new();
        let workspace_bytes = forward_query.byte_length()
            + reverse_query.byte_length()
            // PathQuery owns four u32 arrays plus a bit-packed membership
            // vector. Touched lists grow only with the elimination-tree search
            // space and are reported through process RSS by runtime diagnostics.
            + node_count * size_of::<u32>() * 4
            + node_count.div_ceil(8);
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

    pub(super) fn from_snapshot(snapshot: Snapshot) -> Self {
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
            destination_cache: HashMap::new(),
            destination_cache_order: VecDeque::new(),
            destination_cache_bytes: 0,
        }
    }
}
