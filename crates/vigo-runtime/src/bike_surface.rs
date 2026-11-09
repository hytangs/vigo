//! One temporal frontier serves every endpoint in a surface. Road permissions
//! travel as target-group masks; time/cost dominance never merges incompatible
//! destinations. No point queries are issued while evaluating the surface.
use super::*;
use many::BikeManyResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfacePass {
    Primary,
    Earliest,
    Feasible,
    Relaxed,
    Exact,
}

struct SurfaceArrival {
    states: arrival_states::ArrivalStates,
    links: costs::Links,
    max_elapsed: f64,
}

#[derive(Clone, Copy)]
struct SurfaceLabel {
    node: u32,
    incoming: u32,
    edge: u32,
    state: u32,
    elapsed: f64,
    cost: f64,
    meters: f64,
    groups: u32,
    parent: u32,
    start: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_length_routes_remain_reachable_for_every_profile() {
        let nodes = [[0., 0.], [0.001, 0.]];
        let kernel = super::super::tests::fixture(&nodes, &[(0, 1, 10000, 1, 30 << 8)], &[]);
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            let surface = kernel
                .surface_from(
                    nodes[0],
                    &[nodes[0], nodes[0]],
                    opt,
                    0.,
                    4.8,
                    10000.,
                    None,
                    60.,
                )
                .unwrap();
            assert_eq!(surface.seconds, vec![0., 0.]);
            assert_eq!(surface.fallback_targets, 0);
            let arrival = kernel
                .surface_to(
                    nodes[0],
                    &[nodes[0], nodes[0]],
                    opt,
                    0.,
                    4.8,
                    10000.,
                    None,
                    60.,
                    Some(0.),
                )
                .unwrap();
            assert_eq!(arrival.seconds, vec![0., 0.]);
        }
    }

    #[test]
    fn empty_and_off_network_grids_return_unreachable_without_calendar_work() {
        let nodes = [[0., 0.], [0.001, 0.]];
        let mut kernel = super::super::tests::fixture(&nodes, &[(0, 1, 10000, 1, 30 << 8)], &[]);
        kernel.windows.schedules = vec![vec![(480, 540)]];
        kernel.attributes[0] |= TIMED_EDGE;
        kernel.edge_windows.insert(0, 1);
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            for targets in [vec![], vec![[1., 1.], [2., 2.]]] {
                let opt = BikeOptions {
                    profile,
                    ..Default::default()
                };
                let departure = kernel
                    .surface_from(nodes[0], &targets, opt, 0., 4.8, 10000., clock, 60.)
                    .unwrap();
                let arrival = kernel
                    .surface_to(nodes[1], &targets, opt, 0., 4.8, 10000., clock, 60., None)
                    .unwrap();
                for result in [departure, arrival] {
                    assert_eq!(result.seconds, vec![f64::INFINITY; targets.len()]);
                    assert_eq!(result.fallback_targets, 0);
                }
            }
        }
    }

    #[test]
    fn private_endpoint_permissions_stay_separate_across_many_mask_words() {
        let cycle = (30 << 8) | (15 << 14) | (2 << 3);
        let mut nodes = vec![[0., 0.], [0.0001, 0.]];
        let mut edges = vec![(0, 1, 1000, 1, cycle)];
        let mut targets = Vec::new();
        for i in 0..130 {
            let angle = (i as f64 + 0.25) / 130. * std::f64::consts::TAU;
            let first = nodes.len() as u32;
            for radius in [0.01, 0.011, 0.012] {
                nodes.push([
                    (radius * angle.cos() * 1e7).round() / 1e7,
                    (radius * angle.sin() * 1e7).round() / 1e7,
                ]);
            }
            edges.extend([
                (1, first, 100000 + i * 7, (i * 4 + 2) as i64, cycle),
                (
                    first,
                    first + 1,
                    5000 + i * 3,
                    (i * 4 + 3) as i64,
                    cycle | (1 << 22),
                ),
                (first + 1, first + 2, 5000, (i * 4 + 4) as i64, cycle),
                (1, first + 2, 300000 + i * 13, (i * 4 + 5) as i64, cycle),
            ]);
            targets.extend([nodes[first as usize + 1], nodes[first as usize + 2]]);
        }
        targets.extend([targets[0], targets[259], targets[0]]);
        for reverse in [false, true] {
            let directed: Vec<_> = edges
                .iter()
                .map(|&(a, b, m, w, v)| {
                    if reverse {
                        (b, a, m, w, v)
                    } else {
                        (a, b, m, w, v)
                    }
                })
                .collect();
            let kernel = super::super::tests::fixture(&nodes, &directed, &[]);
            for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
                let opt = BikeOptions {
                    profile,
                    ..Default::default()
                };
                let surface = if reverse {
                    kernel.surface_to(nodes[0], &targets, opt, 0., 4.8, 10000., None, 900., None)
                } else {
                    kernel.surface_from(nodes[0], &targets, opt, 0., 4.8, 10000., None, 900.)
                }
                .unwrap();
                assert!(surface.access_groups > 128);
                assert_eq!(surface.fallback_targets, 0);
                for (i, &target) in targets.iter().enumerate() {
                    let point = if reverse {
                        kernel.route_arrive_at(target, nodes[0], opt, 0., 4.8, 10000., None)
                    } else {
                        kernel.route_at(nodes[0], target, opt, 0., 4.8, 10000., None)
                    }
                    .unwrap();
                    assert_eq!(point.status, "ready");
                    assert!(
                        (surface.seconds[i] - point.elapsed_seconds()).abs() < 1e-8,
                        "{profile:?}/{i}: {} versus {}",
                        surface.seconds[i],
                        point.elapsed_seconds()
                    );
                    if i < 260 && i % 2 == 1 {
                        assert!(
                            surface.seconds[i] > 600.,
                            "A private branch must not become a through shortcut"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn earliest_bounds_cover_the_cutoff_beyond_the_nearest_destination() {
        let mut nodes = vec![[0., 0.], [0., 0.001]];
        nodes.extend((1..=17000).map(|i| [i as f64 * 0.000001, 0.]));
        let mut edges = vec![(0, 1, 500, 1, 30 << 8), (0, 2, 1, 2, 30 << 8)];
        edges.extend((2..17001).map(|i| (i, i + 1, 1, i as i64 + 1, 30 << 8)));
        let kernel = super::super::tests::fixture(&nodes, &edges, &[]);
        let graph = kernel.graph();
        let starts = kernel
            .attach_bicycle_matching(&graph, nodes[0], 0., 1., true, false, &|_| true)
            .unwrap();
        let end = kernel
            .attach_bicycle_matching(&graph, nodes[1], 0., 1., false, false, &|_| true)
            .unwrap();
        let mut ends = SurfaceEnds {
            attachments: vec![end],
            groups: vec![0],
            permissions: vec![vec![]],
            offsets: vec![0; nodes.len() + 1],
            entries: vec![],
            direct: vec![],
        };
        for candidate in &ends.attachments[0].candidates {
            ends.offsets[candidate.node as usize + 1] += 1;
        }
        for i in 1..ends.offsets.len() {
            ends.offsets[i] += ends.offsets[i - 1];
        }
        ends.entries.resize(
            *ends.offsets.last().unwrap() as usize,
            SurfaceTerminal::default(),
        );
        let mut slots = ends.offsets.clone();
        for (i, candidate) in ends.attachments[0].candidates.iter().enumerate() {
            let slot = &mut slots[candidate.node as usize];
            ends.entries[*slot as usize] = SurfaceTerminal::new(0, i, &ends.attachments[0], false);
            *slot += 1;
        }
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let (_, _, bounds) = kernel
            .surface_scan(
                &starts,
                &ends,
                opt,
                None,
                SurfacePass::Earliest,
                10000.,
                100.,
                0,
                1,
                &HashMap::new(),
                &mut SurfaceMasks::new(1),
                None,
                None,
                None,
                None,
                None,
                1.,
                None,
            )
            .unwrap();
        assert!(
            (33.99..=34.0000001).contains(&bounds[17001]),
            "A nearby target must not turn a reachable node's lower bound into the full cutoff: {}",
            bounds[17001]
        );
    }

    #[test]
    fn window_changes_before_earliest_access_do_not_expand_temporal_frontiers() {
        let nodes = [[0., 0.], [0.01, 0.], [0.011, 0.]];
        let mut kernel = super::super::tests::fixture(
            &nodes,
            &[(0, 1, 200_000, 1, 30 << 8), (1, 2, 10_000, 2, 30 << 8)],
            &[],
        );
        kernel.windows.schedules = vec![vec![(481, 1440)]];
        let edge = kernel.ways.iter().position(|&way| way == 2).unwrap() as u32;
        kernel.attributes[edge as usize] |= TIMED_EDGE;
        kernel.edge_windows.insert(edge, 1);
        let starts = kernel
            .attach_bicycle_matching(
                &kernel.graph(),
                nodes[0],
                0.,
                4.8 / 3.6,
                true,
                false,
                &|_| true,
            )
            .unwrap();
        let clock = BikeClock::service("2026-11-02", "America/New_York", 28_800.).unwrap();
        assert!(!kernel.windows.stable_until(clock, 600.));
        assert!(!kernel.surface_variable_windows(clock, 600., &starts, &[0., 400., 420.]));
        assert!(kernel.surface_variable_windows(clock, 600., &starts, &[0., 30., 50.]));
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let options = BikeOptions {
                profile,
                ..Default::default()
            };
            let point = kernel
                .route_at(nodes[0], nodes[2], options, 0., 4.8, 10_000., Some(clock))
                .unwrap();
            let surface = kernel
                .surface_from(
                    nodes[0],
                    &[nodes[2]],
                    options,
                    0.,
                    4.8,
                    10_000.,
                    Some(clock),
                    600.,
                )
                .unwrap();
            assert_eq!(surface.seconds[0], point.elapsed_seconds());
            assert_eq!(surface.fallback_targets, 0);
        }
        // A partial origin edge can encounter a permission before its far node.
        let partial = kernel
            .attach_bicycle_matching(
                &kernel.graph(),
                [0.0105, 0.],
                1.,
                4.8 / 3.6,
                true,
                false,
                &|_| true,
            )
            .unwrap();
        assert!(kernel.surface_variable_windows(clock, 600., &partial, &[400., 400., 420.]));
    }
}
#[derive(Clone, Copy)]
struct SurfaceValue {
    seconds: f64,
    cost: f64,

    valid: bool,
}
impl Default for SurfaceValue {
    fn default() -> Self {
        Self {
            seconds: f64::INFINITY,
            cost: f64::INFINITY,

            valid: false,
        }
    }
}
// The high bit marks an endpoint with no road segment. Bicycle attachment
// candidates have a 512 KiB budget, far below this 31-bit candidate index.
#[derive(Clone, Copy, Default)]
struct SurfaceTerminal {
    target: u32,
    end: u32,
    walk_seconds: f64,
}
impl SurfaceTerminal {
    fn new(target: usize, end: usize, attachment: &Attachment, arrive: bool) -> Self {
        debug_assert!(end < 1 << 31);
        let candidate = attachment.candidates[end];
        let zero = if arrive {
            candidate.fraction == 1. || candidate.fraction == 3. || candidate.fraction == 4.
        } else {
            candidate.fraction == 0. || candidate.fraction == 2.
        };
        Self {
            target: target as u32,
            end: end as u32 | (u32::from(zero) << 31),
            walk_seconds: attachment.walk_seconds(end),
        }
    }
    fn index(self) -> usize {
        (self.end & 0x7fff_ffff) as usize
    }
    fn zero(self) -> bool {
        self.end & 0x8000_0000 != 0
    }
}

struct SurfaceEnds {
    attachments: Vec<Attachment>,
    groups: Vec<usize>,
    permissions: Vec<Vec<u32>>,
    offsets: Vec<u32>,
    entries: Vec<SurfaceTerminal>,
    direct: Vec<(usize, usize, usize)>,
}
impl SurfaceEnds {
    fn permissions_for(
        &self,
        origin_access: &HashSet<u32>,
        first: usize,
        count: usize,
        masks: &mut SurfaceMasks,
    ) -> HashMap<u32, u32> {
        let mut permissions = HashMap::<u32, Vec<u64>>::new();
        for (index, group) in self.permissions[first..first + count].iter().enumerate() {
            for &component in group {
                permissions
                    .entry(component)
                    .or_insert_with(|| vec![0; count.div_ceil(64)])[index / 64] |=
                    1u64 << (index % 64);
            }
        }
        let mut permissions: HashMap<_, _> = permissions
            .into_iter()
            .map(|(component, words)| (component, masks.intern(words)))
            .collect();
        for &component in origin_access {
            permissions.insert(component, masks.all);
        }
        permissions
    }
}

#[derive(Default)]
struct SurfaceScopes {
    nodes: HashMap<u32, usize>,
    bands: Vec<SurfaceBand>,
}
struct SurfaceBand {
    starts: std::ops::Range<f64>,
    horizons: std::ops::Range<f64>,
    windows: Vec<Option<bool>>,
}

// Most paths serve every destination; a private road narrows that set. Intern
// those sets once instead of repeating a full search for each machine word.
struct SurfaceMasks {
    sets: Vec<std::sync::Arc<[u64]>>,
    ids: HashMap<std::sync::Arc<[u64]>, u32>,
    operations: HashMap<[u32; 3], u32>,
    all: u32,
}
impl SurfaceMasks {
    fn new(count: usize) -> Self {
        let mut masks = Self {
            sets: vec![],
            ids: HashMap::new(),
            operations: HashMap::new(),
            all: 0,
        };
        masks.intern(vec![0; count.div_ceil(64)]);
        let mut all = vec![u64::MAX; count.div_ceil(64)];
        if !count.is_multiple_of(64) {
            *all.last_mut().unwrap() = (1u64 << (count % 64)) - 1;
        }
        masks.all = masks.intern(all);
        masks
    }
    fn intern(&mut self, words: Vec<u64>) -> u32 {
        if let Some(&id) = self.ids.get(words.as_slice()) {
            return id;
        }
        let id = self.sets.len() as u32;
        let words: std::sync::Arc<[u64]> = words.into();
        self.sets.push(words.clone());
        self.ids.insert(words, id);
        id
    }
    fn contains(&self, id: u32, group: usize) -> bool {
        self.sets[id as usize][group / 64] & (1u64 << (group % 64)) != 0
    }
    fn intersect(&mut self, a: u32, b: u32) -> u32 {
        if a == 0 || b == 0 {
            0
        } else if a == b || b == self.all {
            a
        } else if a == self.all {
            b
        } else {
            self.operation(a, b, 0)
        }
    }
    fn subtract(&mut self, a: u32, b: u32) -> u32 {
        if a == 0 || a == b || b == self.all {
            0
        } else if b == 0 {
            a
        } else {
            self.operation(a, b, 1)
        }
    }
    fn union(&mut self, a: u32, b: u32) -> u32 {
        if a == b || b == 0 || a == self.all {
            a
        } else if a == 0 || b == self.all {
            b
        } else {
            self.operation(a, b, 2)
        }
    }
    fn operation(&mut self, mut a: u32, mut b: u32, op: u32) -> u32 {
        if op != 1 && a > b {
            std::mem::swap(&mut a, &mut b);
        }
        let key = [a, b, op];
        if let Some(&id) = self.operations.get(&key) {
            return id;
        }
        let words = self.sets[a as usize]
            .iter()
            .zip(self.sets[b as usize].iter())
            .map(|(&a, &b)| match op {
                0 => a & b,
                1 => a & !b,
                _ => a | b,
            })
            .collect();
        let id = self.intern(words);
        if self.operations.len() >= 65536 {
            self.operations.clear();
        }
        self.operations.insert(key, id);
        id
    }
}

struct SurfaceLimits {
    costs: Vec<f64>,
    masks: Vec<u32>,
}
impl SurfaceLimits {
    fn new(limits: &[f64], masks: &mut SurfaceMasks) -> Self {
        let mut order: Vec<_> = (0..limits.len()).collect();
        order.sort_unstable_by(|&a, &b| limits[a].total_cmp(&limits[b]).then(a.cmp(&b)));
        let mut values = vec![0; order.len() + 1];
        let mut words = vec![0; limits.len().div_ceil(64)];
        for i in (0..order.len()).rev() {
            let group = order[i];
            words[group / 64] |= 1u64 << (group % 64);
            values[i] = masks.intern(words.clone());
        }
        Self {
            costs: order.into_iter().map(|i| limits[i]).collect(),
            masks: values,
        }
    }
    fn above(&self, cost: f64) -> u32 {
        self.masks[self.costs.partition_point(|&limit| limit <= cost)]
    }
}

impl BikeKernel {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the surface's exact routing policy explicit."
    )]
    pub(super) fn surface_from(
        &self,
        origin: [f64; 2],
        targets: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
    ) -> Result<BikeManyResult, String> {
        self.surface_policy(
            origin,
            targets,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            maximum_seconds,
            None,
            None,
        )
    }

    #[expect(clippy::too_many_arguments, reason = "Keep arrival bounds explicit.")]
    pub(super) fn surface_to(
        &self,
        destination: [f64; 2],
        origins: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        max_elapsed: Option<f64>,
    ) -> Result<BikeManyResult, String> {
        if max_elapsed.is_some_and(|v| !v.is_finite() || v < 0.) {
            return Err("Invalid bicycle arrival limit".into());
        }
        let arrival = SurfaceArrival {
            states: arrival_states::ArrivalStates::build(self)?,
            links: costs::Links::new(self),
            max_elapsed: max_elapsed.unwrap_or(f64::MAX / 4.),
        };
        self.surface_policy(
            destination,
            origins,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            maximum_seconds,
            None,
            Some(&arrival),
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the surface's endpoint policy explicit."
    )]
    fn surface_policy(
        &self,
        origin: [f64; 2],
        targets: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        expanded: Option<bool>,
        arrival: Option<&SurfaceArrival>,
    ) -> Result<BikeManyResult, String> {
        self.validate_request(
            origin,
            origin,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
        )?;
        if targets.iter().any(|p| {
            !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 180. || p[1].abs() > 90.
        }) || !maximum_seconds.is_finite()
            || maximum_seconds <= 0.
        {
            return Err("Invalid bicycle routing coordinates or limits".into());
        }
        let graph = self.graph();
        let eligible = |edge| {
            self.allowed_edge(edge, opt)
                && (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
        };
        let starts = if expanded == Some(true) {
            self.attach_bicycle_fallback(
                &graph,
                origin,
                max_walk,
                walk_speed / 3.6,
                arrival.is_none(),
                &eligible,
            )?
        } else {
            self.attach_bicycle_matching(
                &graph,
                origin,
                max_walk,
                walk_speed / 3.6,
                arrival.is_none(),
                false,
                &eligible,
            )?
        };
        let origin_access: HashSet<_> = starts
            .candidates
            .iter()
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect();
        let mut ends = SurfaceEnds {
            attachments: Vec::with_capacity(targets.len()),
            groups: vec![],
            permissions: vec![],
            offsets: vec![0; self.lons.len() + 1],
            entries: vec![],
            direct: vec![],
        };
        let mut starts_by_edge = HashMap::<
            u32,
            smallvec::SmallVec<[usize; 2]>,
            std::hash::BuildHasherDefault<crate::IntegerHasher>,
        >::default();
        for (i, c) in starts.candidates.iter().enumerate() {
            starts_by_edge.entry(c.edge).or_default().push(i);
        }
        let mut groups = HashMap::<Vec<u32>, usize>::new();
        let attach = |&point: &[f64; 2], scratch: &mut walk::WalkSearch| {
            if let Some(walking) = &self.walking {
                return walking.attach_with_workspace(
                    self,
                    point,
                    max_walk,
                    walk_speed / 3.6,
                    arrival.is_some(),
                    &eligible,
                    arrival.is_some(),
                    scratch,
                );
            }
            if expanded == Some(true) {
                return self.attach_bicycle_fallback(
                    &graph,
                    point,
                    max_walk,
                    walk_speed / 3.6,
                    arrival.is_some(),
                    &eligible,
                );
            }
            self.attach_bicycle_matching(
                &graph,
                point,
                max_walk,
                walk_speed / 3.6,
                arrival.is_some(),
                false,
                &eligible,
            )
        };
        let attachments: Vec<_> = if let Some(pool) = crate::ENDPOINT_ACCESS_POOL.as_ref() {
            use rayon::prelude::*;
            let chunks: Vec<Vec<_>> = pool.install(|| {
                targets
                    .par_chunks(32)
                    .map(|points| {
                        let mut scratch = walk::WalkSearch::default();
                        points
                            .iter()
                            .map(|point| attach(point, &mut scratch))
                            .collect()
                    })
                    .collect()
            });
            chunks.into_iter().flatten().collect()
        } else {
            let mut scratch = walk::WalkSearch::default();
            targets
                .iter()
                .map(|point| attach(point, &mut scratch))
                .collect()
        };
        for attachment in attachments {
            let attachment = attachment?;
            let target = ends.attachments.len();
            let mut permission = Vec::new();
            for (j, candidate) in attachment.candidates.iter().enumerate() {
                if self.attributes[candidate.edge as usize] & (1 << 22) != 0 {
                    // Destination attachments end at an edge's source vertex.
                    let component = self.destination_components[candidate.node as usize];
                    if !origin_access.contains(&component) {
                        permission.push(component);
                    }
                }
                if let Some(ids) = starts_by_edge.get(&candidate.edge) {
                    for &i in ids {
                        ends.direct.push((target, i, j));
                    }
                }
                ends.offsets[candidate.node as usize + 1] += 1;
            }
            permission.sort_unstable();
            permission.dedup();
            let group = *groups.entry(permission.clone()).or_insert_with(|| {
                let id = ends.permissions.len();
                ends.permissions.push(permission);
                id
            });
            ends.groups.push(group);
            ends.attachments.push(attachment);
        }
        for i in 1..ends.offsets.len() {
            ends.offsets[i] += ends.offsets[i - 1];
        }
        ends.entries.resize(
            *ends.offsets.last().unwrap() as usize,
            SurfaceTerminal::default(),
        );
        let mut next = ends.offsets.clone();
        for (target, attachment) in ends.attachments.iter().enumerate() {
            for (end, candidate) in attachment.candidates.iter().enumerate() {
                let slot = &mut next[candidate.node as usize];
                ends.entries[*slot as usize] =
                    SurfaceTerminal::new(target, end, attachment, arrival.is_some());
                *slot += 1;
            }
        }
        drop(next);
        let mut result = BikeManyResult {
            seconds: vec![f64::INFINITY; targets.len()],
            meters: vec![],
            settled_labels: 0,
            certified_targets: targets.len(),
            fallback_targets: 0,
            tree_limited: false,
            fallback_reasons: Default::default(),
            scoped_trees: 0,
            attachment_certificates: 0,
            access_groups: ends.permissions.len(),
            access_group_key_bytes: ends.permissions.iter().map(|v| v.capacity() * 4).sum(),
            access_group_limit_targets: 0,
        };
        if self.walking.is_none() && expanded.is_none() && max_walk > 0. {
            // A long primary route must keep its nearest-road endpoints even
            // when it lies outside Reach. Prove primary existence and dated
            // validity under the distance cap before choosing endpoint sets.
            let proof_limit = (max_distance * (20. + 3.6 / walk_speed)).min(f64::MAX / 1024.);
            let mut primary = vec![SurfaceValue::default(); targets.len()];
            {
                let first = 0;
                let count = ends.permissions.len();
                let mut masks = SurfaceMasks::new(count);
                let permissions = ends.permissions_for(&origin_access, first, count, &mut masks);
                let (values, work, _) = self.surface_scan(
                    &starts,
                    &ends,
                    opt,
                    clock,
                    SurfacePass::Primary,
                    max_distance,
                    proof_limit,
                    first,
                    count,
                    &permissions,
                    &mut masks,
                    None,
                    None,
                    None,
                    None,
                    None,
                    walk_speed / 3.6,
                    arrival,
                )?;
                result.settled_labels += work;
                for i in 0..targets.len() {
                    if ends.groups[i] >= first && ends.groups[i] < first + count {
                        primary[i] = values[i];
                    }
                }
            }
            let wider: Vec<bool> = primary
                .iter()
                .enumerate()
                .map(|(i, value)| {
                    if starts.candidates.is_empty() || ends.attachments[i].candidates.is_empty() {
                        return false;
                    }
                    if clock.is_some()
                        && self.has_timing()
                        && value.cost.is_finite()
                        && !value.valid
                    {
                        return true;
                    }
                    !value.cost.is_finite()
                        && [starts.nearest_meters, ends.attachments[i].nearest_meters]
                            .into_iter()
                            .flatten()
                            .any(|distance| max_walk > distance + ALTERNATIVE_TOLERANCE_M)
                })
                .collect();
            if wider.iter().any(|&value| value) {
                result.access_groups = 0;
                result.access_group_key_bytes = 0;
                for expanded in [false, true] {
                    let indices: Vec<_> = (0..targets.len())
                        .filter(|&i| wider[i] == expanded)
                        .collect();
                    if indices.is_empty() {
                        continue;
                    }
                    let points: Vec<_> = indices.iter().map(|&i| targets[i]).collect();
                    let part = self.surface_policy(
                        origin,
                        &points,
                        opt,
                        max_walk,
                        walk_speed,
                        max_distance,
                        clock,
                        maximum_seconds,
                        Some(expanded),
                        arrival,
                    )?;
                    for (i, seconds) in indices.into_iter().zip(part.seconds) {
                        result.seconds[i] = seconds;
                    }
                    result.settled_labels += part.settled_labels;
                    result.access_groups += part.access_groups;
                    result.access_group_key_bytes += part.access_group_key_bytes;
                }
                return Ok(result);
            }
        }
        let departure_links = (arrival.is_none() && !matches!(opt.profile, Profile::Fast))
            .then(|| costs::Links::new(self));
        let reverse_links = arrival.map(|a| &a.links).or(departure_links.as_ref());
        // Every permission group shares the same traversal and endpoint index.
        {
            let first_group = 0;
            let count = ends.permissions.len();
            let mut masks = SurfaceMasks::new(count);
            let permissions = ends.permissions_for(&origin_access, first_group, count, &mut masks);
            let (fast, settled, earliest_at) = self.surface_scan(
                &starts,
                &ends,
                opt,
                clock,
                SurfacePass::Earliest,
                max_distance,
                maximum_seconds,
                first_group,
                count,
                &permissions,
                &mut masks,
                None,
                None,
                None,
                None,
                None,
                walk_speed / 3.6,
                arrival,
            )?;
            result.settled_labels += settled;
            // A preferred path cannot reach the cutoff if even the earliest
            // traversal reaches no target. This also handles empty and wholly
            // off-network grids before calendar bounds are indexed.
            if fast.iter().all(|value| !value.cost.is_finite()) {
                return Ok(result);
            }
            let values = if matches!(opt.profile, Profile::Fast) {
                fast
            } else {
                // A feasible shared scalar traversal tightens the branch-and-
                // bound incumbent. Every edge is checked at its actual clock;
                // these paths supply upper bounds, never optimality claims.
                let (incumbents, work, _) = self.surface_scan(
                    &starts,
                    &ends,
                    opt,
                    clock,
                    SurfacePass::Feasible,
                    max_distance,
                    maximum_seconds,
                    first_group,
                    count,
                    &permissions,
                    &mut masks,
                    Some(&fast),
                    None,
                    None,
                    None,
                    Some(&earliest_at),
                    walk_speed / 3.6,
                    arrival,
                )?;
                result.settled_labels += work;
                let change = clock.map_or(f64::INFINITY, |clock| {
                    self.surface_change(clock, &starts, &earliest_at, arrival)
                });
                let uncertain: Vec<_> = (0..targets.len())
                    .filter(|&i| {
                        fast[i].cost.is_finite()
                            && ends.groups[i] >= first_group
                            && ends.groups[i] < first_group + count
                            && (incumbents[i].cost / 0.8 >= change
                                || arrival
                                    .is_some_and(|a| incumbents[i].cost / 0.8 > a.max_elapsed))
                    })
                    .collect();
                let lower = if uncertain.is_empty() {
                    incumbents.clone()
                } else {
                    let (lower, work, _) = self.surface_scan(
                        &starts,
                        &ends,
                        opt,
                        clock,
                        SurfacePass::Relaxed,
                        max_distance,
                        maximum_seconds,
                        first_group,
                        count,
                        &permissions,
                        &mut masks,
                        Some(&fast),
                        Some(&incumbents),
                        Some(&uncertain),
                        reverse_links,
                        Some(&earliest_at),
                        walk_speed / 3.6,
                        arrival,
                    )?;
                    result.settled_labels += work;
                    lower
                };
                // Below the first reachable permission change, the scalar
                // traversal is already an exact cost search. Only prefixes
                // whose improving-path horizon crosses that event need both
                // time and preference labels.
                let mut preferred = incumbents.clone();
                for &i in &uncertain {
                    if lower[i].valid && lower[i].cost <= incumbents[i].cost {
                        preferred[i] = lower[i];
                    }
                }
                let mut members: Vec<usize> = (0..targets.len())
                    .filter(|&i| {
                        fast[i].cost.is_finite()
                            && ends.groups[i] >= first_group
                            && ends.groups[i] < first_group + count
                            && (incumbents[i].cost / 0.8 >= change
                                || arrival
                                    .is_some_and(|a| incumbents[i].cost / 0.8 > a.max_elapsed))
                            && lower[i].cost != incumbents[i].cost
                            && !(lower[i].valid && lower[i].cost <= incumbents[i].cost)
                    })
                    .collect();
                let mut batches = Vec::new();
                fn partition(
                    points: &[[f64; 2]],
                    fast: &[SurfaceValue],
                    incumbents: &[SurfaceValue],
                    members: &mut [usize],
                    batches: &mut Vec<Vec<usize>>,
                ) {
                    let costs = members
                        .iter()
                        .map(|&i| incumbents[i].cost)
                        .fold((f64::INFINITY, 0f64), |(lo, hi), v| (lo.min(v), hi.max(v)));
                    let times = members
                        .iter()
                        .map(|&i| fast[i].seconds)
                        .fold((f64::INFINITY, 0f64), |(lo, hi), v| (lo.min(v), hi.max(v)));
                    if members.len() <= 1
                        || members.len() <= 8
                            && costs.1 - costs.0 <= 60.
                            && times.1 - times.0 <= 60.
                    {
                        if !members.is_empty() {
                            batches.push(members.to_vec());
                        }
                        return;
                    }
                    let mut low = [f64::INFINITY; 2];
                    let mut high = [f64::NEG_INFINITY; 2];
                    for &i in members.iter() {
                        for a in 0..2 {
                            low[a] = low[a].min(points[i][a]);
                            high[a] = high[a].max(points[i][a]);
                        }
                    }
                    let axis = usize::from(high[1] - low[1] > high[0] - low[0]);
                    members.sort_unstable_by(|&a, &b| {
                        (if costs.1 - costs.0 > 60. || times.1 - times.0 > 60. {
                            if costs.1 - costs.0 >= times.1 - times.0 {
                                incumbents[a].cost.total_cmp(&incumbents[b].cost)
                            } else {
                                fast[a].seconds.total_cmp(&fast[b].seconds)
                            }
                        } else {
                            points[a][axis].total_cmp(&points[b][axis])
                        })
                        .then(a.cmp(&b))
                    });
                    let middle = members.len() / 2;
                    let (left, right) = members.split_at_mut(middle);
                    partition(points, fast, incumbents, left, batches);
                    partition(points, fast, incumbents, right, batches);
                }
                partition(targets, &fast, &incumbents, &mut members, &mut batches);
                for batch in batches {
                    let (values, settled, _) = self.surface_scan(
                        &starts,
                        &ends,
                        opt,
                        clock,
                        SurfacePass::Exact,
                        max_distance,
                        maximum_seconds,
                        first_group,
                        count,
                        &permissions,
                        &mut masks,
                        Some(&fast),
                        Some(&incumbents),
                        Some(&batch),
                        reverse_links,
                        Some(&earliest_at),
                        walk_speed / 3.6,
                        arrival,
                    )?;
                    result.settled_labels += settled;
                    for target in batch {
                        preferred[target] = values[target];
                    }
                }
                preferred
            };
            for (index, value) in values.into_iter().enumerate() {
                if ends.groups[index] >= first_group
                    && ends.groups[index] < first_group + count
                    && value.seconds <= maximum_seconds
                {
                    result.seconds[index] = value.seconds;
                }
            }
        }
        Ok(result)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep shared temporal and permission bounds explicit."
    )]
    fn surface_scan(
        &self,
        starts: &Attachment,
        ends: &SurfaceEnds,
        opt: BikeOptions,
        clock: Option<BikeClock>,
        pass: SurfacePass,
        max_distance: f64,
        maximum_seconds: f64,
        first_group: usize,
        count: usize,
        permissions: &HashMap<u32, u32>,
        masks: &mut SurfaceMasks,
        fastest: Option<&[SurfaceValue]>,
        incumbents: Option<&[SurfaceValue]>,
        members: Option<&[usize]>,
        reverse_links: Option<&costs::Links>,
        earliest_at: Option<&[f64]>,
        walk_speed: f64,
        arrival: Option<&SurfaceArrival>,
    ) -> Result<(Vec<SurfaceValue>, usize, Vec<f64>), String> {
        let earliest = pass == SurfacePass::Earliest;
        let scalar_bound = matches!(
            pass,
            SurfacePass::Primary | SurfacePass::Feasible | SurfacePass::Relaxed
        );
        let relaxed = matches!(pass, SurfacePass::Primary | SurfacePass::Relaxed);
        let factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let mut limits = vec![0f64; count];
        let mut best = vec![SurfaceValue::default(); ends.attachments.len()];
        let mut active = vec![false; best.len()];
        let mut assigned = vec![false; best.len()];
        let mut prices = vec![f64::INFINITY; best.len()];
        let mut winners = vec![None::<(u32, usize, usize)>; best.len()];
        for target in 0..best.len() {
            if members.is_some_and(|members| !members.contains(&target)) {
                continue;
            }
            let group = ends.groups[target];
            if group < first_group
                || group >= first_group + count
                || ends.attachments[target].candidates.is_empty()
            {
                continue;
            }
            let bound = incumbents
                .or(fastest)
                .map_or(maximum_seconds, |fast| fast[target].cost);
            if !bound.is_finite() {
                continue;
            }
            active[target] = true;
            best[target].cost = bound * (1. + 1e-9);
            limits[group - first_group] = limits[group - first_group].max(best[target].cost);
        }
        let ceiling = limits.iter().copied().fold(0., f64::max);
        if ceiling == 0. {
            if let Some(values) = incumbents.or(fastest) {
                for target in 0..best.len() {
                    if active[target] {
                        best[target] = values[target];
                    }
                }
            }
            return Ok((best, 0, vec![]));
        }
        let scope = (pass == SurfacePass::Relaxed)
            .then(|| {
                clock.map(|clock| {
                    self.surface_scoped_windows(
                        clock,
                        ceiling / factor * (1. + 1e-8),
                        starts,
                        earliest_at.unwrap(),
                        arrival,
                    )
                })
            })
            .flatten();
        let kind = if relaxed && clock.is_some() {
            scope
                .as_ref()
                .map_or(SearchKind::Relaxed, |scope| SearchKind::Scoped(scope))
        } else {
            SearchKind::Normal
        };
        let timed = !earliest
            && !scalar_bound
            && (clock.is_some_and(|c| {
                self.surface_change(c, starts, earliest_at.unwrap(), arrival) <= ceiling / factor
            }) || arrival.is_some_and(|a| ceiling / factor > a.max_elapsed));
        let mut arrival_bounds = if earliest {
            vec![maximum_seconds * (1. - 1e-9); self.lons.len()]
        } else {
            vec![]
        };
        let constrained = max_distance
            < ceiling * (45f64 / 3.6).max(walk_speed) / if earliest { 1. } else { factor };
        let minimum_time = fastest.map_or(0., |fast| {
            active
                .iter()
                .enumerate()
                .filter(|(_, a)| **a)
                .map(|(i, _)| fast[i].seconds)
                .fold(f64::INFINITY, f64::min)
        }) * (1. - 1e-9);
        let mut scope_bounds =
            reverse_links
                .filter(|_| pass == SurfacePass::Relaxed)
                .map(|links| {
                    // The endpoint index already groups all walks at a road
                    // vertex. Reduce those exact seed costs there, without
                    // reconstructing millions of zero-length road segments.
                    let seeds = ends
                        .offsets
                        .windows(2)
                        .enumerate()
                        .filter_map(|(node, range)| {
                            let mut cost = f64::INFINITY;
                            for &terminal in &ends.entries[range[0] as usize..range[1] as usize] {
                                let target = terminal.target as usize;
                                if !active[target] {
                                    continue;
                                }
                                let road = if terminal.zero() {
                                    0.
                                } else {
                                    let b = ends.attachments[target]
                                        .candidate(&self.graph(), terminal.index());
                                    b.drive_meters * self.metric(b.edge, opt).1
                                };
                                cost = cost.min(
                                    (ceiling - best[target].cost).max(0.)
                                        + terminal.walk_seconds
                                        + road,
                                );
                            }
                            cost.is_finite().then_some((node as u32, cost))
                        });
                    costs::Costs::through_nodes(self, links, opt, ceiling * (1. + 1e-8), seeds)
                        .forward_direction(arrival.is_some())
                        .with_origin(starts)
                });
        let mut local_scopes = SurfaceScopes::default();
        let joint_ends = reverse_links
            .filter(|_| pass == SurfacePass::Exact)
            .map(|_| {
                Attachment::from_candidates(
                    active
                        .iter()
                        .enumerate()
                        .filter(|(_, a)| **a)
                        .flat_map(|(i, _)| ends.attachments[i].candidates.iter().copied())
                        .collect(),
                    walk_speed,
                    arrival.is_some(),
                )
            });
        let mut remaining = reverse_links.zip(joint_ends.as_ref()).map(|(links, end)| {
            costs::Costs::new(self, links, end, opt, false, ceiling * (1. + 1e-8))
                .forward_direction(arrival.is_some())
                .with_origin(starts)
        });
        let mut remaining_excess = reverse_links
            .zip(joint_ends.as_ref())
            .filter(|_| timed)
            .map(|(links, end)| {
                costs::Costs::new(
                    self,
                    links,
                    end,
                    opt,
                    true,
                    (ceiling * (1. + 1e-8) - factor * minimum_time).max(0.),
                )
                .forward_direction(arrival.is_some())
            });
        let stable_after = if timed && arrival.is_some() {
            f64::INFINITY
        } else if timed {
            self.surface_last_change(clock.unwrap(), ceiling / factor * (1. + 1e-8))
        } else {
            0.
        };
        let mut via_changes = if timed && arrival.is_none() {
            let nodes = self.surface_event_nodes(
                clock.unwrap(),
                ceiling / factor * (1. + 1e-8),
                earliest_at.unwrap(),
            );
            let mut seeds = Vec::with_capacity(nodes.len());
            for node in nodes {
                let cap =
                    (ceiling * (1. + 1e-8) - factor * earliest_at.unwrap()[node as usize]).max(0.);
                let lower = remaining.as_mut().unwrap().get(node, cap) * (1. - 1e-9);
                if lower < cap {
                    seeds.push((node, lower));
                }
            }
            Some(
                costs::Costs::through_nodes(
                    self,
                    reverse_links.unwrap(),
                    opt,
                    ceiling * (1. + 1e-8),
                    seeds.into_iter(),
                )
                .forward_direction(arrival.is_some())
                .with_origin(starts),
            )
        } else {
            None
        };
        let mut labels = Vec::<SurfaceLabel>::new();
        let mut frontiers = Vec::<smallvec::SmallVec<[u32; 2]>>::new();
        let mut heads = vec![u32::MAX; self.lons.len()];
        let mut special = HashMap::<(u32, u32, u32), u32>::new();
        let mut states = arrival.map_or_else(|| vec![TurnState::new()], |a| a.states.turns.clone());
        let mut state_ids = HashMap::from([(TurnState::new(), 0u32)]);
        let mut queue = BinaryHeap::new();
        let mut settled = 0usize;
        let mut gates = SurfaceLimits::new(&limits, masks);
        let all = gates.above(0.);
        let score = |label: &SurfaceLabel| {
            if earliest {
                label.elapsed
            } else if timed {
                label.cost + factor * label.elapsed
            } else {
                label.cost
            }
        };
        let mut insert = |mut label: SurfaceLabel,
                          labels: &mut Vec<SurfaceLabel>,
                          heads: &mut [u32],
                          special: &mut HashMap<(u32, u32, u32), u32>,
                          frontiers: &mut Vec<smallvec::SmallVec<[u32; 2]>>,
                          queue: &mut BinaryHeap<Queue>,
                          masks: &mut SurfaceMasks,
                          gates: &SurfaceLimits| {
            let mut priority = score(&label);
            label.groups = masks.intersect(label.groups, gates.above(priority));
            if label.groups == 0
                || label.meters > max_distance
                || arrival.is_some_and(|a| label.elapsed > a.max_elapsed)
            {
                return;
            }
            if earliest {
                arrival_bounds[label.node as usize] =
                    arrival_bounds[label.node as usize].min(label.elapsed * (1. - 1e-9));
            }
            let incoming = if label.incoming != u32::MAX
                && self.attributes[label.incoming as usize] & (NODE_TURN | WAY_TURN) != 0
            {
                label.incoming
            } else {
                u32::MAX
            };
            let head = if incoming == u32::MAX && label.state == 0 {
                &mut heads[label.node as usize]
            } else {
                special
                    .entry((label.node, incoming, label.state))
                    .or_insert(u32::MAX)
            };
            if *head == u32::MAX {
                *head = frontiers.len() as u32;
                frontiers.push(smallvec::SmallVec::new());
            }
            let known = &mut frontiers[*head as usize];
            // Contiguous arrival order avoids chasing a long linked list for
            // every dominated relaxation. Before the last event, only earlier
            // labels can dominate a new arrival. Permission masks remain on
            // the labels, so no incompatible endpoint sets are merged.
            let before = if timed && label.elapsed < stable_after {
                known.partition_point(|&id| labels[id as usize].elapsed <= label.elapsed)
            } else {
                known.len()
            };
            let mut shadowed = 0u32;
            for &id in known[..before].iter().rev() {
                let old = labels[id as usize];
                let fixed = timed && old.elapsed >= stable_after && label.elapsed >= stable_after;
                let dominates = (if fixed {
                    score(&old) <= score(&label)
                } else {
                    (earliest || old.cost <= label.cost)
                        && (!earliest && !timed || old.elapsed <= label.elapsed)
                }) && (!constrained || old.meters <= label.meters);
                if dominates {
                    label.groups = masks.subtract(label.groups, old.groups);
                }
                if label.groups == 0 {
                    return;
                }
            }
            if timed && arrival.is_none() && label.state == 0 {
                for &id in known.iter() {
                    let old = labels[id as usize];
                    if score(&old) < score(&label) * (1. - 1e-9)
                        && (!constrained || old.meters <= label.meters)
                    {
                        shadowed = masks.union(shadowed, old.groups);
                    }
                }
            }
            if let Some(costs) = &mut remaining {
                let cap = (ceiling * (1. + 1e-8) - priority).max(0.);
                let lower = costs.get(label.node, cap) * (1. - 1e-9);
                priority = if timed {
                    let residual =
                        (ceiling * (1. + 1e-8) - label.cost - factor * minimum_time).max(0.);
                    let excess = remaining_excess
                        .as_mut()
                        .map_or(0., |costs| costs.get(label.node, residual) * (1. - 1e-9));
                    label.cost
                        + (factor * label.elapsed + lower).max(factor * minimum_time + excess)
                } else {
                    label.cost + lower
                };
                label.groups = masks.intersect(label.groups, gates.above(priority));
                if label.groups == 0 {
                    return;
                }
            }
            // A more expensive prefix can beat a cheaper prefix in the same
            // state only through a permission that changes with arrival time.
            // Bound the whole suffix through such a movement and then to an
            // endpoint. Ordinary suffixes are already covered by the cheaper
            // prefix. Active via-way histories keep the general bound until
            // their state ends, since their restriction may have started behind
            // this node.
            shadowed = masks.intersect(shadowed, label.groups);
            if shadowed != 0 {
                let actual = score(&label);
                let cap = (ceiling * (1. + 1e-8) - actual).max(0.);
                let bound =
                    actual + via_changes.as_mut().unwrap().get(label.node, cap) * (1. - 1e-9);
                let others = masks.subtract(label.groups, shadowed);
                let permitted = masks.intersect(shadowed, gates.above(bound));
                label.groups = masks.union(others, permitted);
                if label.groups == 0 {
                    return;
                }
                if masks.subtract(label.groups, shadowed) == 0 {
                    priority = priority.max(bound);
                }
            }
            known.retain(|id| {
                let old = &mut labels[*id as usize];
                let fixed = timed && old.elapsed >= stable_after && label.elapsed >= stable_after;
                if (if fixed {
                    score(&label) <= score(old)
                } else {
                    (earliest || label.cost <= old.cost)
                        && (!earliest && !timed || label.elapsed <= old.elapsed)
                }) && (!constrained || label.meters <= old.meters)
                {
                    old.groups = masks.subtract(old.groups, label.groups);
                }
                old.groups != 0
            });
            let position =
                known.partition_point(|&id| labels[id as usize].elapsed <= label.elapsed);
            known.insert(position, labels.len() as u32);
            queue.push(Queue(priority, labels.len()));
            labels.push(label);
        };
        for &(target, i, j) in &ends.direct {
            if !active[target] {
                continue;
            }
            let b = ends.attachments[target].candidate(&self.graph(), j);
            let a = starts.candidate(&self.graph(), i);
            if let Some(arrival) = arrival {
                if a.fraction < b.fraction {
                    continue;
                }
                let meters =
                    (a.fraction - b.fraction) * self.distances[a.edge as usize] as f64 / 100.;
                if a.walk_meters + b.walk_meters + meters > max_distance {
                    continue;
                }
                let (seconds, cost) = self.metric(a.edge, opt);
                let latest = -a.walk_seconds - meters * seconds;
                let departure = if meters <= 1e-7 {
                    Some(latest)
                } else {
                    self.latest_arrival_movement(
                        &TurnState::new(),
                        None,
                        self.source(a.edge),
                        a.edge,
                        None,
                        clock,
                        latest,
                        -arrival.max_elapsed + b.walk_seconds,
                        kind,
                    )?
                };
                let Some(departure) = departure else {
                    continue;
                };
                let elapsed = -departure + b.walk_seconds;
                if elapsed > arrival.max_elapsed {
                    continue;
                }
                let price = a.walk_seconds
                    + b.walk_seconds
                    + meters * cost
                    + (latest - departure).max(0.) * factor;
                let value = if earliest { elapsed } else { price };
                if value < best[target].cost {
                    best[target] = SurfaceValue {
                        seconds: elapsed,
                        cost: value,

                        valid: !relaxed,
                    };
                    winners[target] = Some((u32::MAX, i, j));
                    prices[target] = price;
                    assigned[target] = true;
                }
                continue;
            }
            if b.fraction < a.fraction {
                continue;
            }
            let meters = (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.;
            let Some((departure, _)) = self
                .start_movements(&a, meters, None, clock, kind, false)?
                .first
            else {
                continue;
            };
            if a.walk_meters + b.walk_meters + meters > max_distance {
                continue;
            }
            let (seconds, cost) = self.metric(a.edge, opt);
            let elapsed = departure + meters * seconds + b.walk_seconds;
            let price = a.walk_seconds
                + b.walk_seconds
                + meters * cost
                + (departure - a.walk_seconds) * factor;
            let value = if earliest { elapsed } else { price };
            if value < best[target].cost {
                best[target] = SurfaceValue {
                    seconds: elapsed,
                    cost: value,

                    valid: !relaxed,
                };
                winners[target] = Some((u32::MAX, i, j));
                prices[target] = price;
                assigned[target] = true;
            }
        }
        for i in 0..starts.candidates.len() {
            let a = starts.candidate(&self.graph(), i);
            let (seconds, cost) = self.metric(a.edge, opt);
            if let Some(arrival) = arrival {
                for variant in arrival.states.variants(a.node) {
                    let state = arrival.states.state(variant);
                    let latest = -a.walk_seconds - a.drive_meters * seconds;
                    let departure = if a.drive_meters <= 1e-7 {
                        Some(latest)
                    } else {
                        self.latest_arrival_movement(
                            &states[state.turns as usize],
                            (state.incoming != u32::MAX).then_some(state.incoming),
                            a.node,
                            a.edge,
                            None,
                            clock,
                            latest,
                            -arrival.max_elapsed,
                            kind,
                        )?
                    };
                    let Some(departure) = departure else {
                        continue;
                    };
                    let elapsed = -departure;
                    let price = if timed {
                        a.walk_seconds * (1. - factor)
                            + a.drive_meters * (cost - factor * seconds).max(0.)
                    } else {
                        a.walk_seconds
                            + a.drive_meters * cost
                            + (latest - departure).max(0.) * factor
                    };
                    insert(
                        SurfaceLabel {
                            node: a.node,
                            incoming: state.incoming,
                            edge: a.edge,
                            state: state.turns,
                            elapsed,
                            cost: price,
                            meters: a.walk_meters + a.drive_meters,
                            groups: all,
                            parent: u32::MAX,
                            start: i as u32,
                        },
                        &mut labels,
                        &mut heads,
                        &mut special,
                        &mut frontiers,
                        &mut queue,
                        masks,
                        &gates,
                    );
                }
                continue;
            }
            for (departure, state) in self
                .start_movements(&a, a.drive_meters, None, clock, kind, true)?
                .into_iter()
            {
                let state = if state.is_empty() {
                    0
                } else {
                    *state_ids.entry(state.clone()).or_insert_with(|| {
                        let id = states.len() as u32;
                        states.push(state);
                        id
                    })
                };
                let elapsed = departure + a.drive_meters * seconds;
                let price = if timed {
                    a.walk_seconds * (1. - factor)
                        + a.drive_meters * (cost - factor * seconds).max(0.)
                } else {
                    a.walk_seconds + a.drive_meters * cost + (departure - a.walk_seconds) * factor
                };
                insert(
                    SurfaceLabel {
                        node: a.node,
                        edge: a.edge,
                        incoming: if a.drive_meters > 1e-7 {
                            a.edge
                        } else {
                            u32::MAX
                        },
                        state,
                        elapsed,
                        cost: price,
                        meters: a.walk_meters + a.drive_meters,
                        groups: all,
                        parent: u32::MAX,
                        start: i as u32,
                    },
                    &mut labels,
                    &mut heads,
                    &mut special,
                    &mut frontiers,
                    &mut queue,
                    masks,
                    &gates,
                );
            }
        }
        while let Some(Queue(priority, id)) = queue.pop() {
            let mut label = labels[id];
            if label.groups == 0 {
                continue;
            }
            label.groups = masks.intersect(label.groups, gates.above(priority));
            if label.groups == 0 {
                continue;
            }
            settled += 1;
            if labels.len()
                > crate::resources::cache_budget(512 * 1024 * 1024, 6)
                    / std::mem::size_of::<SurfaceLabel>()
            {
                return Err("Bicycle surface exceeded its bounded temporal workspace".into());
            }
            if !earliest && settled.is_multiple_of(16384) {
                limits.fill(0.);
                for target in 0..best.len() {
                    if active[target] {
                        let g = ends.groups[target] - first_group;
                        limits[g] = limits[g].max(best[target].cost);
                    }
                }
                gates = SurfaceLimits::new(&limits, masks);
            }

            for &terminal in &ends.entries[ends.offsets[label.node as usize] as usize
                ..ends.offsets[label.node as usize + 1] as usize]
            {
                let target = terminal.target as usize;
                let j = terminal.index();
                if !active[target]
                    || !masks.contains(label.groups, ends.groups[target] - first_group)
                {
                    continue;
                }
                let prefix = if earliest {
                    label.elapsed
                } else {
                    score(&label)
                };
                if prefix + terminal.walk_seconds >= best[target].cost {
                    continue;
                }
                if arrival.is_some() {
                    let expected_incoming = if terminal.zero() {
                        u32::MAX
                    } else {
                        let edge = ends.attachments[target].candidates[j].edge;
                        if self.attributes[edge as usize] & (NODE_TURN | WAY_TURN) != 0 {
                            edge
                        } else {
                            u32::MAX
                        }
                    };
                    if label.state != 0 || label.incoming != expected_incoming {
                        continue;
                    }
                }
                if terminal.zero() {
                    let candidate = ends.attachments[target].candidates[j];
                    if label.meters + candidate.walk_meters > max_distance {
                        continue;
                    }
                    let elapsed = label.elapsed + terminal.walk_seconds;
                    if arrival.is_some_and(|a| elapsed > a.max_elapsed) {
                        continue;
                    }
                    let price =
                        if earliest { label.cost } else { score(&label) } + terminal.walk_seconds;
                    let value = if earliest { elapsed } else { price };
                    best[target] = SurfaceValue {
                        seconds: elapsed,
                        cost: value,

                        valid: !relaxed,
                    };
                    winners[target] = Some((id as u32, label.start as usize, j));
                    prices[target] = price;
                    assigned[target] = true;
                    continue;
                }
                let b = ends.attachments[target].candidate(&self.graph(), j);
                if let Some(arrival) = arrival {
                    if label.meters + b.walk_meters + b.drive_meters > max_distance {
                        continue;
                    }
                    let (seconds, cost) = self.metric(b.edge, opt);
                    let latest = -label.elapsed - b.drive_meters * seconds;
                    let departure = if b.drive_meters <= 1e-7 {
                        Some(latest)
                    } else {
                        self.latest_arrival_movement(
                            &TurnState::new(),
                            None,
                            self.source(b.edge),
                            b.edge,
                            Some(&TurnState::new()),
                            clock,
                            latest,
                            -arrival.max_elapsed + b.walk_seconds,
                            kind,
                        )?
                    };
                    let Some(departure) = departure else {
                        continue;
                    };
                    let elapsed = -departure + b.walk_seconds;
                    if elapsed > arrival.max_elapsed {
                        continue;
                    }
                    let price = score(&label)
                        + b.walk_seconds
                        + b.drive_meters * cost
                        + (latest - departure).max(0.) * factor;
                    // Earliest uses physical duration for ordering, but preserves
                    // the preference price for the next shared bound pass.
                    let price = if earliest {
                        label.cost
                            + b.walk_seconds
                            + b.drive_meters * cost
                            + (latest - departure).max(0.) * factor
                    } else {
                        price
                    };
                    let value = if earliest { elapsed } else { price };
                    if value < best[target].cost {
                        best[target] = SurfaceValue {
                            seconds: elapsed,
                            cost: value,

                            valid: !relaxed,
                        };
                        winners[target] = Some((id as u32, label.start as usize, j));
                        prices[target] = price;
                        assigned[target] = true;
                    }
                    continue;
                }
                let departure = if b.drive_meters > 1e-7 {
                    let kind = if let (Some(bounds), Some(clock)) = (scope_bounds.as_mut(), clock) {
                        if self.surface_needs_scope(
                            &states[label.state as usize],
                            label.incoming,
                            label.node,
                            b.edge,
                            kind,
                        ) {
                            SearchKind::Scoped(self.surface_scope_at(
                                label.node,
                                clock,
                                ceiling,
                                factor,
                                earliest_at.unwrap(),
                                bounds,
                                &mut local_scopes,
                            ))
                        } else {
                            kind
                        }
                    } else {
                        kind
                    };
                    let Some((departure, _)) = self
                        .movements(
                            &states[label.state as usize],
                            (label.incoming != u32::MAX).then_some(label.incoming),
                            label.node,
                            b.edge,
                            clock,
                            label.elapsed,
                            kind,
                            false,
                        )?
                        .first
                    else {
                        continue;
                    };
                    departure
                } else {
                    label.elapsed
                };
                let (seconds, cost) = if b.drive_meters == 0. {
                    (0., 0.)
                } else {
                    self.metric(b.edge, opt)
                };
                if label.meters + b.walk_meters + b.drive_meters > max_distance {
                    continue;
                }
                let elapsed = departure + b.drive_meters * seconds + b.walk_seconds;
                let price = label.cost
                    + if timed {
                        factor * departure
                    } else {
                        (departure - label.elapsed) * factor
                    }
                    + b.walk_seconds
                    + b.drive_meters * cost;
                let value = if earliest { elapsed } else { price };
                if value < best[target].cost {
                    best[target] = SurfaceValue {
                        seconds: elapsed,
                        cost: value,

                        valid: !relaxed,
                    };
                    winners[target] = Some((id as u32, label.start as usize, j));
                    prices[target] = price;
                    assigned[target] = true;
                }
            }
            if let Some(arrival) = arrival {
                let mut edge = arrival.links.head[label.node as usize];
                while edge != u32::MAX {
                    let current_edge = edge;
                    edge = arrival.links.next[edge as usize];
                    let expected =
                        if self.attributes[current_edge as usize] & (NODE_TURN | WAY_TURN) != 0 {
                            current_edge
                        } else {
                            u32::MAX
                        };
                    if expected != label.incoming
                        || !self.allowed_edge(current_edge, opt)
                        || clock.is_none()
                            && self.attributes[current_edge as usize] & TIMED_EDGE != 0
                    {
                        continue;
                    }
                    let node = arrival.links.source(self, current_edge) as u32;
                    let groups = if self.attributes[current_edge as usize] & (1 << 22) != 0 {
                        masks.intersect(
                            label.groups,
                            permissions
                                .get(&self.destination_components[node as usize])
                                .copied()
                                .unwrap_or(0),
                        )
                    } else {
                        label.groups
                    };
                    if groups == 0 {
                        continue;
                    }
                    let meters = self.distances[current_edge as usize] as f64 / 100.;
                    let (seconds, cost) = self.metric(current_edge, opt);
                    let latest = -label.elapsed - meters * seconds;
                    for variant in arrival.states.variants(node) {
                        let state = arrival.states.state(variant);
                        let Some(departure) = self.latest_arrival_movement(
                            &states[state.turns as usize],
                            (state.incoming != u32::MAX).then_some(state.incoming),
                            node,
                            current_edge,
                            Some(&states[label.state as usize]),
                            clock,
                            latest,
                            -arrival.max_elapsed,
                            kind,
                        )?
                        else {
                            continue;
                        };
                        let elapsed = -departure;
                        let price = label.cost
                            + if timed {
                                meters * (cost - factor * seconds).max(0.)
                            } else {
                                meters * cost + (latest - departure).max(0.) * factor
                            };
                        insert(
                            SurfaceLabel {
                                node,
                                incoming: state.incoming,
                                edge: current_edge,
                                state: state.turns,
                                elapsed,
                                cost: price,
                                meters: label.meters + meters,
                                groups,
                                parent: id as u32,
                                start: label.start,
                            },
                            &mut labels,
                            &mut heads,
                            &mut special,
                            &mut frontiers,
                            &mut queue,
                            masks,
                            &gates,
                        );
                    }
                }
                continue;
            }
            for edge in self.offsets[label.node as usize]..self.offsets[label.node as usize + 1] {
                if !self.allowed_edge(edge, opt)
                    || clock.is_none() && self.attributes[edge as usize] & TIMED_EDGE != 0
                {
                    continue;
                }
                let groups = if self.attributes[edge as usize] & (1 << 22) != 0 {
                    masks.intersect(
                        label.groups,
                        permissions
                            .get(&self.destination_components[label.node as usize])
                            .copied()
                            .unwrap_or(0),
                    )
                } else {
                    label.groups
                };
                if groups == 0 {
                    continue;
                }
                let meters = self.distances[edge as usize] as f64 / 100.;
                let (seconds, cost) = self.metric(edge, opt);
                let kind = if let (Some(bounds), Some(clock)) = (scope_bounds.as_mut(), clock) {
                    if self.surface_needs_scope(
                        &states[label.state as usize],
                        label.incoming,
                        label.node,
                        edge,
                        kind,
                    ) {
                        SearchKind::Scoped(self.surface_scope_at(
                            label.node,
                            clock,
                            ceiling,
                            factor,
                            earliest_at.unwrap(),
                            bounds,
                            &mut local_scopes,
                        ))
                    } else {
                        kind
                    }
                } else {
                    kind
                };
                for (departure, state) in self
                    .movements(
                        &states[label.state as usize],
                        (label.incoming != u32::MAX).then_some(label.incoming),
                        label.node,
                        edge,
                        clock,
                        label.elapsed,
                        kind,
                        true,
                    )?
                    .into_iter()
                {
                    let state = if state.is_empty() {
                        0
                    } else {
                        *state_ids.entry(state.clone()).or_insert_with(|| {
                            let id = states.len() as u32;
                            states.push(state);
                            id
                        })
                    };
                    let elapsed = departure + meters * seconds;
                    let price = label.cost
                        + if timed {
                            meters * (cost - factor * seconds).max(0.)
                        } else {
                            meters * cost + (departure - label.elapsed) * factor
                        };
                    insert(
                        SurfaceLabel {
                            node: self.targets[edge as usize],
                            edge,
                            incoming: edge,
                            state,
                            elapsed,
                            cost: price,
                            meters: label.meters + meters,
                            groups,
                            parent: id as u32,
                            start: label.start,
                        },
                        &mut labels,
                        &mut heads,
                        &mut special,
                        &mut frontiers,
                        &mut queue,
                        masks,
                        &gates,
                    );
                }
            }
        }
        for target in 0..best.len() {
            if !assigned[target] {
                best[target] = if active[target] && !relaxed {
                    incumbents
                        .or(fastest)
                        .map_or(SurfaceValue::default(), |values| values[target])
                } else {
                    SurfaceValue::default()
                };
            } else if earliest {
                best[target].cost = prices[target] * (1. + 1e-8);
            }
            if relaxed && let Some((mut id, start, end)) = winners[target] {
                let fixed = starts.candidate(&self.graph(), start);
                let variable = ends.attachments[target].candidate(&self.graph(), end);
                let (a, b) = if arrival.is_some() {
                    (variable, fixed)
                } else {
                    (fixed, variable)
                };
                let replay_clock = if arrival.is_some() {
                    clock.map(|c| BikeClock {
                        epoch: c.epoch - best[target].seconds,
                        ..c
                    })
                } else {
                    clock
                };
                let mut parts = Vec::new();
                if id == u32::MAX {
                    parts.push((
                        a.edge,
                        (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.,
                    ));
                } else if arrival.is_some() {
                    parts.push((a.edge, a.drive_meters));
                    while labels[id as usize].parent != u32::MAX {
                        let edge = labels[id as usize].edge;
                        parts.push((edge, self.distances[edge as usize] as f64 / 100.));
                        id = labels[id as usize].parent;
                    }
                    parts.push((b.edge, b.drive_meters));
                } else {
                    parts.push((b.edge, b.drive_meters));
                    while labels[id as usize].parent != u32::MAX {
                        let edge = labels[id as usize].edge;
                        parts.push((edge, self.distances[edge as usize] as f64 / 100.));
                        id = labels[id as usize].parent;
                    }
                    parts.push((a.edge, a.drive_meters));
                    parts.reverse();
                }
                let mut elapsed = a.walk_seconds;
                let mut state = TurnState::new();
                let mut incoming = None;
                let mut valid = true;
                for (edge, meters) in parts {
                    if meters < 1e-7 {
                        continue;
                    }
                    let movement = self
                        .movements(
                            &state,
                            incoming,
                            self.source(edge),
                            edge,
                            replay_clock,
                            elapsed,
                            SearchKind::Normal,
                            false,
                        )?
                        .first;
                    let Some((departure, next)) = movement else {
                        valid = false;
                        elapsed = f64::INFINITY;
                        break;
                    };
                    if departure != elapsed {
                        valid = false;
                    }
                    elapsed = departure + meters * self.metric(edge, opt).0;
                    incoming = Some(edge);
                    state = next;
                }
                best[target].valid =
                    valid && arrival.is_none_or(|a| best[target].seconds <= a.max_elapsed);
                if arrival.is_none() {
                    best[target].seconds = elapsed + b.walk_seconds;
                }
            }
        }
        Ok((best, settled, arrival_bounds))
    }

    // A distant restriction may change before any route can reach it. Such a
    // change cannot create time/cost tradeoffs in this query. Check each window
    // only after its earliest reachable occurrence, including partial origin
    // edges and via-way entry states. The earliest search supplies lower bounds
    // for every permission group; beyond its cutoff the cutoff itself is a
    // lower bound. No geometry approximation authorizes a route here.
    fn surface_change(
        &self,
        clock: BikeClock,
        starts: &Attachment,
        earliest: &[f64],
        arrival: Option<&SurfaceArrival>,
    ) -> f64 {
        let Some(arrival) = arrival else {
            return self.surface_next_change(clock, starts, earliest);
        };
        self.arrival_window_earliest(starts, earliest, arrival)
            .into_iter()
            .enumerate()
            .skip(1)
            .filter(|(_, start)| start.is_finite())
            .filter_map(|(id, start)| self.windows.previous_change(id as u32, clock, -start))
            .map(|time| -time)
            .fold(f64::INFINITY, f64::min)
    }

    fn surface_scoped_windows(
        &self,
        clock: BikeClock,
        horizon: f64,
        starts: &Attachment,
        earliest: &[f64],
        arrival: Option<&SurfaceArrival>,
    ) -> Vec<Option<bool>> {
        let Some(arrival) = arrival else {
            return self.surface_scope(clock, horizon, starts, earliest);
        };
        self.arrival_window_earliest(starts, earliest, arrival)
            .into_iter()
            .enumerate()
            .map(|(id, start)| {
                if id == 0 {
                    return Some(true);
                }
                (start.is_finite()
                    && self
                        .windows
                        .previous_change(id as u32, clock, -start)
                        .is_none_or(|previous| -previous > horizon))
                .then(|| self.windows.active(id as u32, Some(clock), -start))
            })
            .collect()
    }

    // The forward movement is checked on entry, before any waiting. In a
    // reverse search, its outgoing endpoint is a lower bound on elapsed time;
    // using the reached source would incorrectly include a wait at a closure.
    fn arrival_window_earliest(
        &self,
        starts: &Attachment,
        earliest: &[f64],
        arrival: &SurfaceArrival,
    ) -> Vec<f64> {
        let mut values = vec![f64::INFINITY; self.windows.schedules.len() + 1];
        let at = |node: u32| {
            (self.offsets[node as usize]..self.offsets[node as usize + 1])
                .map(|e| earliest[self.targets[e as usize] as usize])
                .fold(earliest[node as usize], f64::min)
        };
        for (&(node, _), rules) in &self.turns {
            let lower = at(node);
            for rule in rules {
                values[rule.window as usize] = values[rule.window as usize].min(lower);
            }
        }
        for (&edge, &window) in &self.edge_windows {
            values[window as usize] =
                values[window as usize].min(earliest[self.targets[edge as usize] as usize]);
        }
        for (&(node, _), ids) in &self.way_starts {
            let lower = at(node);
            for &id in ids {
                let window = self.way_turns[id as usize].window as usize;
                values[window] = values[window].min(lower);
            }
        }
        for state in &arrival.states.extra {
            let lower = at(state.node);
            for &(id, _, _) in &arrival.states.turns[state.turns as usize] {
                let window = self.way_turns[id as usize].window as usize;
                values[window] = values[window].min(lower);
            }
        }
        for i in 0..starts.candidates.len() {
            let start = starts.candidate(&self.graph(), i);
            if let Some(&window) = self.edge_windows.get(&start.edge) {
                values[window as usize] =
                    values[window as usize].min(start.walk_seconds * (1. - 1e-9));
            }
            // Partial destination roads can encounter turns before their far
            // endpoint, so include every rule that starts at this attachment.
            for variant in arrival.states.variants(start.node) {
                let state = arrival.states.state(variant);
                if state.incoming != u32::MAX
                    && let Some(rules) = self
                        .turns
                        .get(&(start.node, self.ways[state.incoming as usize]))
                {
                    for rule in rules {
                        values[rule.window as usize] =
                            values[rule.window as usize].min(start.walk_seconds);
                    }
                }
                for &(id, _, _) in &arrival.states.turns[state.turns as usize] {
                    let window = self.way_turns[id as usize].window as usize;
                    values[window] = values[window].min(start.walk_seconds);
                }
            }
        }
        values
    }

    #[cfg(test)]
    fn surface_variable_windows(
        &self,
        clock: BikeClock,
        horizon: f64,
        starts: &Attachment,
        earliest_at: &[f64],
    ) -> bool {
        if self.windows.stable_until(clock, horizon) {
            return false;
        }
        self.surface_next_change(clock, starts, earliest_at) <= horizon
    }

    fn surface_next_change(
        &self,
        clock: BikeClock,
        starts: &Attachment,
        earliest_at: &[f64],
    ) -> f64 {
        self.surface_window_earliest(starts, earliest_at)
            .into_iter()
            .enumerate()
            .skip(1)
            .filter(|(_, start)| start.is_finite())
            .filter_map(|(id, start)| self.windows.next_change(id as u32, clock, start))
            .fold(f64::INFINITY, f64::min)
    }

    fn surface_scope(
        &self,
        clock: BikeClock,
        horizon: f64,
        starts: &Attachment,
        earliest_at: &[f64],
    ) -> Vec<Option<bool>> {
        self.surface_window_earliest(starts, earliest_at)
            .into_iter()
            .enumerate()
            .map(|(id, start)| {
                if id == 0 {
                    return Some(true);
                }
                (start.is_finite()
                    && self
                        .windows
                        .next_change(id as u32, clock, start)
                        .is_none_or(|next| next > horizon))
                .then(|| self.windows.active(id as u32, Some(clock), start))
            })
            .collect()
    }

    fn surface_needs_scope(
        &self,
        state: &TurnState,
        incoming: u32,
        node: u32,
        outgoing: u32,
        kind: SearchKind<'_>,
    ) -> bool {
        if self.attributes[outgoing as usize] & TIMED_EDGE != 0
            && kind.variable(self.edge_windows[&outgoing])
        {
            return true;
        }
        if incoming != u32::MAX {
            if self.attributes[incoming as usize] & NODE_TURN != 0
                && self
                    .turns
                    .get(&(node, self.ways[incoming as usize]))
                    .is_some_and(|turns| turns.iter().any(|turn| kind.variable(turn.window)))
            {
                return true;
            }
            if self.attributes[incoming as usize] & WAY_TURN != 0
                && self
                    .way_starts
                    .get(&(node, self.ways[incoming as usize]))
                    .is_some_and(|ids| {
                        ids.iter()
                            .any(|&id| kind.variable(self.way_turns[id as usize].window))
                    })
            {
                return true;
            }
        }
        state
            .iter()
            .any(|&(id, _, _)| kind.variable(self.way_turns[id as usize].window))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the exact calendar interval and residual bounds explicit."
    )]
    fn surface_scope_at<'a>(
        &self,
        node: u32,
        clock: BikeClock,
        ceiling: f64,
        factor: f64,
        earliest: &[f64],
        bounds: &mut costs::Costs<'_>,
        scopes: &'a mut SurfaceScopes,
    ) -> &'a [Option<bool>] {
        let id = if let Some(&id) = scopes.nodes.get(&node) {
            id
        } else {
            let remaining = bounds.get(node, ceiling) * (1. - 1e-9);
            let horizon = ((ceiling - remaining).max(0.) / factor) * (1. + 1e-8);
            let start = earliest[node as usize];
            let id = scopes
                .bands
                .iter()
                .position(|band| band.starts.contains(&start) && band.horizons.contains(&horizon))
                .unwrap_or_else(|| {
                    let mut low_start = f64::NEG_INFINITY;
                    let mut high_start = f64::INFINITY;
                    let mut low_end = f64::NEG_INFINITY;
                    let mut high_end = f64::INFINITY;
                    let mut values = vec![Some(true)];
                    for id in 1..=self.windows.schedules.len() as u32 {
                        let next = self
                            .windows
                            .next_change(id, clock, start)
                            .unwrap_or(f64::INFINITY);
                        high_start = high_start.min(next);
                        low_start = low_start.max(
                            self.windows
                                .previous_change(id, clock, start)
                                .unwrap_or(f64::NEG_INFINITY),
                        );
                        high_end = high_end.min(
                            self.windows
                                .next_change(id, clock, horizon)
                                .unwrap_or(f64::INFINITY),
                        );
                        low_end = low_end.max(
                            self.windows
                                .previous_change(id, clock, horizon)
                                .unwrap_or(f64::NEG_INFINITY),
                        );
                        values.push(
                            (next > horizon).then(|| self.windows.active(id, Some(clock), start)),
                        );
                    }
                    let id = scopes.bands.len();
                    scopes.bands.push(SurfaceBand {
                        starts: low_start..high_start,
                        horizons: low_end..high_end,
                        windows: values,
                    });
                    id
                });
            scopes.nodes.insert(node, id);
            id
        };
        &scopes.bands[id].windows
    }

    fn surface_window_earliest(&self, starts: &Attachment, earliest_at: &[f64]) -> Vec<f64> {
        let mut earliest = vec![f64::INFINITY; self.windows.schedules.len() + 1];
        for (&(node, _), turns) in &self.turns {
            for turn in turns {
                earliest[turn.window as usize] =
                    earliest[turn.window as usize].min(earliest_at[node as usize]);
            }
        }
        for (&edge, &window) in &self.edge_windows {
            earliest[window as usize] =
                earliest[window as usize].min(earliest_at[self.source(edge) as usize]);
        }
        for (&(node, _), rules) in &self.way_starts {
            for &rule in rules {
                let window = self.way_turns[rule as usize].window as usize;
                earliest[window] = earliest[window].min(earliest_at[node as usize]);
            }
        }
        for i in 0..starts.candidates.len() {
            let start = starts.candidate(&self.graph(), i);
            if let Some(&window) = self.edge_windows.get(&start.edge) {
                earliest[window as usize] =
                    earliest[window as usize].min(start.walk_seconds * (1. - 1e-9));
            }
        }
        earliest
    }

    fn surface_last_change(&self, clock: BikeClock, horizon: f64) -> f64 {
        let mut last = 0f64;
        for id in 1..=self.windows.schedules.len() as u32 {
            let mut at = 0.;
            while let Some(next) = self
                .windows
                .next_change(id, clock, at)
                .filter(|&t| t <= horizon)
            {
                last = last.max(next);
                at = next;
            }
        }
        last
    }

    fn surface_event_nodes(&self, clock: BikeClock, horizon: f64, earliest: &[f64]) -> Vec<u32> {
        let mut nodes = Vec::new();
        let mut add = |node: u32, window: u32| {
            if window != 0
                && earliest[node as usize] <= horizon
                && self
                    .windows
                    .next_change(window, clock, earliest[node as usize])
                    .is_some_and(|next| next <= horizon)
            {
                nodes.push(node);
            }
        };
        for (&(node, _), turns) in &self.turns {
            for turn in turns {
                add(node, turn.window);
            }
        }
        for (&edge, &window) in &self.edge_windows {
            add(self.source(edge), window);
        }
        for (&(node, _), rules) in &self.way_starts {
            for &rule in rules {
                add(node, self.way_turns[rule as usize].window);
            }
        }
        nodes.sort_unstable();
        nodes.dedup();
        nodes
    }
}
