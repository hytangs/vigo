//! Bicycle Reach over the directed movement contraction hierarchy.
use super::*;
use std::hash::BuildHasherDefault;

#[path = "bike_cch.rs"]
pub(super) mod hierarchy;

#[cfg(any(feature = "standalone", test))]
pub(crate) struct BikeSurface {
    pub seconds: Vec<f64>,
    pub access_groups: usize,
    pub access_group_key_bytes: usize,
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
                .many_from(
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
            let arrival = kernel
                .many_to(
                    &[nodes[0], nodes[0]],
                    nodes[0],
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
                    .many_from(nodes[0], &targets, opt, 0., 4.8, 10000., clock, 60.)
                    .unwrap();
                let arrival = kernel
                    .many_to(&targets, nodes[1], opt, 0., 4.8, 10000., clock, 60., None)
                    .unwrap();
                for result in [departure, arrival] {
                    assert_eq!(result.seconds, vec![f64::INFINITY; targets.len()]);
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
                    kernel.many_to(&targets, nodes[0], opt, 0., 4.8, 10000., None, 900., None)
                } else {
                    kernel.many_from(nodes[0], &targets, opt, 0., 4.8, 10000., None, 900.)
                }
                .unwrap();
                assert!(surface.access_groups > 128);
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
        let clock = BikeClock::service("2026-11-02", "America/New_York", 28_800.).unwrap();
        assert!(!kernel.windows.stable_until(clock, 600.));
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let options = BikeOptions {
                profile,
                ..Default::default()
            };
            let point = kernel
                .route_at(nodes[0], nodes[2], options, 0., 4.8, 10_000., Some(clock))
                .unwrap();
            let surface = kernel
                .many_from(
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
        }
        // Starting halfway along the timed road requires waiting for it
        // to open before entering the remaining partial edge.
        let surface = kernel
            .many_from(
                [0.0105, 0.],
                &[nodes[2]],
                BikeOptions::default(),
                1.,
                4.8,
                10000.,
                Some(clock),
                600.,
            )
            .unwrap();
        assert!((surface.seconds[0] - 70.).abs() < 1e-7);
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
        let zero = zero_terminal(candidate.fraction, arrive);
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
    #[cfg(any(feature = "standalone", test))]
    permissions: Vec<Vec<u32>>,
    offsets: Vec<u32>,
    entries: Vec<SurfaceTerminal>,
    direct: Vec<(usize, usize, usize)>,
}
impl SurfaceEnds {
    #[cfg(any(feature = "standalone", test))]
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

// Most paths serve every destination; a private road narrows that set. Intern
// those sets once instead of repeating a full search for each machine word.
struct SurfaceMasks {
    sets: Vec<std::sync::Arc<[u64]>>,
    ids: HashMap<std::sync::Arc<[u64]>, u32>,
    // The two mask ids fit exactly in one integer key. Separate operation
    // tables avoid hashing a tuple for every frontier dominance comparison.
    operations: [HashMap<u64, u32, BuildHasherDefault<crate::IntegerHasher>>; 2],
    all: u32,
}
impl SurfaceMasks {
    fn new(count: usize) -> Self {
        let mut masks = Self {
            sets: vec![],
            ids: HashMap::new(),
            operations: Default::default(),
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
    fn operation(&mut self, mut a: u32, mut b: u32, op: u32) -> u32 {
        if op != 1 && a > b {
            std::mem::swap(&mut a, &mut b);
        }
        let key = (u64::from(a) << 32) | u64::from(b);
        if let Some(&id) = self.operations[op as usize].get(&key) {
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
        if self.operations.iter().map(HashMap::len).sum::<usize>() >= 65536 {
            for table in &mut self.operations {
                table.clear();
            }
        }
        self.operations[op as usize].insert(key, id);
        id
    }
}

#[cfg(any(feature = "standalone", test))]
impl BikeKernel {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the surface's exact routing policy explicit."
    )]
    pub(crate) fn many_from(
        &self,
        origin: [f64; 2],
        targets: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
    ) -> Result<BikeSurface, String> {
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
        )
    }

    #[expect(clippy::too_many_arguments, reason = "Keep arrival bounds explicit.")]
    pub(crate) fn many_to(
        &self,
        origins: &[[f64; 2]],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        maximum_seconds: f64,
        max_elapsed: Option<f64>,
    ) -> Result<BikeSurface, String> {
        if max_elapsed.is_some_and(|v| !v.is_finite() || v < 0.) {
            return Err("Invalid bicycle arrival limit".into());
        }
        let limit = max_elapsed.unwrap_or(f64::MAX / 4.);
        self.surface_policy(
            destination,
            origins,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            maximum_seconds,
            Some(limit),
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
        arrival_limit: Option<f64>,
    ) -> Result<BikeSurface, String> {
        let started = std::time::Instant::now();
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
        let starts = self.attach_bicycle_matching(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            arrival_limit.is_none(),
            false,
            &eligible,
        )?;
        let origin_access: HashSet<_> = starts
            .candidates
            .iter()
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect();
        let arrive = arrival_limit.is_some();
        let speed = walk_speed / 3.6;
        let mut starts_by_edge = HashMap::<
            u32,
            smallvec::SmallVec<[usize; 2]>,
            std::hash::BuildHasherDefault<crate::IntegerHasher>,
        >::default();
        for (i, c) in starts.candidates.iter().enumerate() {
            starts_by_edge.entry(c.edge).or_default().push(i);
        }
        let attach = |point: [f64; 2], reach: f64, scratch: &mut walk::WalkSearch| {
            if let Some(walking) = &self.walking {
                return walking.attach_with_workspace(
                    self, point, max_walk, reach, speed, arrive, &eligible, arrive, scratch,
                );
            }
            self.attach_bicycle_matching(&graph, point, max_walk, speed, arrive, false, &eligible)
        };
        let ends_of = |attachments: Vec<Result<Attachment, String>>| {
            self.surface_ends(attachments, &starts_by_edge, &origin_access, arrive)
        };
        let run = |ends: &SurfaceEnds, first_pass: bool| {
            let attachment_ms = started.elapsed().as_secs_f64() * 1000.;
            if let Some(limit) = arrival_limit {
                hierarchy::reverse::measure(
                    self,
                    &starts,
                    ends,
                    &origin_access,
                    opt,
                    clock,
                    max_distance,
                    maximum_seconds,
                    limit,
                    walk_speed,
                    attachment_ms,
                    first_pass,
                )
            } else {
                hierarchy::measure(
                    self,
                    &starts,
                    ends,
                    &origin_access,
                    opt,
                    clock,
                    max_distance,
                    maximum_seconds,
                    walk_speed,
                    attachment_ms,
                    first_pass,
                )
            }
        };
        let complete = |values: Vec<Option<f64>>| {
            values
                .into_iter()
                .map(|value| value.ok_or("Bicycle surface left a cell unresolved"))
                .collect::<Result<Vec<_>, _>>()
        };
        if self.walking.is_none() {
            let ends = ends_of(in_parallel(targets.len(), |i, scratch| {
                attach(targets[i], max_walk, scratch)
            }))?;
            if std::iter::once(&starts)
                .chain(&ends.attachments)
                .any(|attachment| {
                    attachment
                        .nearest_meters
                        .is_some_and(|meters| max_walk > meters + ALTERNATIVE_TOLERANCE_M)
                })
            {
                // Select the endpoint scope using the uncut CCH minimum.
                // Reach's display cutoff must not change which roads match.
                let (from, to) = if arrive {
                    (targets, std::slice::from_ref(&origin))
                } else {
                    (std::slice::from_ref(&origin), targets)
                };
                let batch = hierarchy::batch::Batch::new(
                    hierarchy::batch::Request {
                        kernel: self,
                        options: opt,
                        max_walk,
                        walk_speed,
                        max_meters: max_distance,
                        clock,
                        arrive,
                        max_elapsed: arrival_limit,
                    },
                    from,
                    to,
                )?
                .row(0)?;
                let cutoff = maximum_seconds.min(arrival_limit.unwrap_or(f64::INFINITY));
                let seconds = batch
                    .seconds
                    .into_iter()
                    .map(|s| if s <= cutoff { s } else { f64::INFINITY })
                    .collect();
                return Ok(BikeSurface {
                    seconds,
                    access_groups: batch.access_groups,
                    access_group_key_bytes: batch.access_group_key_bytes,
                });
            }
            return Ok(BikeSurface {
                seconds: complete(run(&ends, false)?)?,
                access_groups: ends.permissions.len(),
                access_group_key_bytes: ends.permissions.iter().map(|v| v.capacity() * 4).sum(),
            });
        }
        // First pass: each cell searches only as far as a walking candidate
        // could still beat the best one it has found. Every candidate in
        // this prefix keeps its exact full-radius distance and order, so a
        // certified minimum is the full-radius minimum. Cells the
        // certificate cannot settle repeat with every candidate below.
        let bounds = hierarchy::node_bounds(self, &starts, opt, arrive)?;
        let tiles = Tiles::new(self, &bounds.minimum, targets, max_walk);
        let near = self.near_endpoint(&starts, origin, targets, max_walk);
        let first = in_parallel(targets.len(), |i, scratch| {
            let point = targets[i];
            if near[i] {
                return attach(point, max_walk, scratch);
            }
            let probe = PROBE_REACH_M.min(max_walk);
            let found = attach(point, probe, scratch)?;
            let best = found
                .candidates
                .iter()
                .filter(|c| zero_terminal(c.fraction, arrive))
                .map(|c| {
                    let prefix = if arrive {
                        bounds.base[c.node as usize]
                    } else {
                        bounds.minimum[c.node as usize]
                    };
                    prefix * (1. + 1e-9) + 1e-9 + c.walk_meters / speed
                })
                .fold(f64::INFINITY, f64::min);
            let reach = match tiles.reach(point, best, speed) {
                Some(reach) if best.is_finite() => {
                    (reach * (1. + 1e-6) + 1.).clamp(probe, max_walk)
                }
                _ => max_walk,
            };
            if reach > probe {
                attach(point, reach, scratch)
            } else {
                Ok(found)
            }
        });
        let ends = ends_of(first)?;
        let mut seconds = run(&ends, true)?;
        let pending: Vec<_> = (0..seconds.len())
            .filter(|&i| seconds[i].is_none())
            .collect();
        let mut access_groups = ends.permissions.len();
        let mut access_group_key_bytes = ends.permissions.iter().map(|v| v.capacity() * 4).sum();
        if !pending.is_empty() {
            let full = ends_of(in_parallel(pending.len(), |k, scratch| {
                attach(targets[pending[k]], max_walk, scratch)
            }))?;
            for (&cell, value) in pending.iter().zip(run(&full, false)?) {
                seconds[cell] = value;
            }
            access_groups = access_groups.max(full.permissions.len());
            access_group_key_bytes += full
                .permissions
                .iter()
                .map(|v| v.capacity() * 4)
                .sum::<usize>();
        }
        Ok(BikeSurface {
            seconds: complete(seconds)?,
            access_groups,
            access_group_key_bytes,
        })
    }

    /// Groups endpoint candidates by bicycle node, interns each cell's
    /// private-access permissions and records same-road start pairs.
    fn surface_ends(
        &self,
        attachments: Vec<Result<Attachment, String>>,
        starts_by_edge: &HashMap<
            u32,
            smallvec::SmallVec<[usize; 2]>,
            std::hash::BuildHasherDefault<crate::IntegerHasher>,
        >,
        origin_access: &HashSet<u32>,
        arrive: bool,
    ) -> Result<SurfaceEnds, String> {
        let mut ends = SurfaceEnds {
            attachments: Vec::with_capacity(attachments.len()),
            groups: vec![],
            permissions: vec![],
            offsets: vec![0; self.lons.len() + 1],
            entries: vec![],
            direct: vec![],
        };
        let mut groups = HashMap::<Vec<u32>, usize>::new();
        // Millions of terminal candidates are checked against a few start
        // roads. Test a bitset before probing the exact start index.
        let mut start_edges = vec![0u64; self.targets.len().div_ceil(64)];
        for &edge in starts_by_edge.keys() {
            start_edges[edge as usize / 64] |= 1 << (edge % 64);
        }
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
                let edge = candidate.edge as usize;
                if start_edges[edge / 64] & (1 << (edge % 64)) != 0
                    && let Some(ids) = starts_by_edge.get(&candidate.edge)
                {
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
                    SurfaceTerminal::new(target, end, attachment, arrive);
                *slot += 1;
            }
        }
        Ok(ends)
    }

    /// Cells close enough to share a road with the fixed endpoint. Their
    /// same-road pairs bypass the hierarchy, so they keep a full search.
    fn near_endpoint(
        &self,
        endpoint: &Attachment,
        point: [f64; 2],
        targets: &[[f64; 2]],
        max_walk: f64,
    ) -> Vec<bool> {
        let longest = endpoint
            .candidates
            .iter()
            .map(|c| f64::from(self.distances[c.edge as usize]) / 100.)
            .fold(0., f64::max);
        let limit = 2. * (max_walk * 1.02 + 30.) + longest + 100.;
        let (ky, kx) = (110_574., 111_320. * point[1].to_radians().cos());
        targets
            .iter()
            .map(|p| {
                let (dx, dy) = ((p[0] - point[0]) * kx, (p[1] - point[1]) * ky);
                // Equirectangular distance underestimates by far less than
                // the 2% margin at Reach extents.
                (dx * dx + dy * dy).sqrt() <= limit * 1.02
            })
            .collect()
    }
}

/// The least relaxed node cost in each map tile around the grid. A walking
/// candidate in a tile costs at least that minimum plus the walk to the
/// tile's nearest point, which bounds how far a cell must search.
#[cfg(any(feature = "standalone", test))]
struct Tiles {
    minimum: Vec<f64>,
    columns: usize,
    rows: usize,
    west: f64,
    south: f64,
    kx: f64,
    ky: f64,
    radius: f64,
}

#[cfg(any(feature = "standalone", test))]
impl Tiles {
    const SIZE_M: f64 = 100.;

    fn new(kernel: &BikeKernel, node_minimum: &[f64], targets: &[[f64; 2]], max_walk: f64) -> Self {
        // Walks follow network edges, so they are never shorter than the
        // straight-line distance; the margin covers projection error.
        let radius = max_walk * 1.02 + 30.;
        let latitude = targets.iter().map(|p| p[1]).sum::<f64>() / targets.len().max(1) as f64;
        let (ky, kx) = (110_574., 111_320. * latitude.to_radians().cos().max(1e-6));
        let (mut west, mut south, mut east, mut north) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for p in targets {
            west = west.min(p[0]);
            east = east.max(p[0]);
            south = south.min(p[1]);
            north = north.max(p[1]);
        }
        west -= radius / kx;
        east += radius / kx;
        south -= radius / ky;
        north += radius / ky;
        let columns = (((east - west) * kx / Self::SIZE_M).ceil() as usize).max(1);
        let rows = (((north - south) * ky / Self::SIZE_M).ceil() as usize).max(1);
        let mut minimum = vec![f64::INFINITY; columns * rows];
        for (node, &cost) in node_minimum.iter().enumerate() {
            let (x, y) = (kernel.lons[node], kernel.lats[node]);
            if cost.is_finite() && x >= west && x < east && y >= south && y < north {
                let column = (((x - west) * kx / Self::SIZE_M) as usize).min(columns - 1);
                let row = (((y - south) * ky / Self::SIZE_M) as usize).min(rows - 1);
                let tile = &mut minimum[row * columns + column];
                *tile = tile.min(cost);
            }
        }
        Self {
            minimum,
            columns,
            rows,
            west,
            south,
            kx,
            ky,
            radius,
        }
    }

    /// The walking distance beyond which no candidate around `point` can
    /// cost at most `best`, or `None` when that needs the full radius.
    fn reach(&self, point: [f64; 2], best: f64, speed: f64) -> Option<f64> {
        let (px, py) = (
            (point[0] - self.west) * self.kx,
            (point[1] - self.south) * self.ky,
        );
        let size = Self::SIZE_M;
        let span = |v: f64, n: usize| {
            let low = ((v - self.radius) / size).floor();
            let high = ((v + self.radius) / size).floor();
            (low >= 0. && high < n as f64).then_some((low as usize, high as usize))
        };
        // A cell whose search disk leaves the tiled area needs every tile.
        let (top, bottom) = span(py, self.rows)?;
        let (left, right) = span(px, self.columns)?;
        let mut reach: f64 = 0.;
        for row in top..=bottom {
            let dy = (row as f64 * size - py)
                .max(py - (row + 1) as f64 * size)
                .max(0.);
            for column in left..=right {
                let dx = (column as f64 * size - px)
                    .max(px - (column + 1) as f64 * size)
                    .max(0.);
                let distance = (dx * dx + dy * dy).sqrt();
                let cost = self.minimum[row * self.columns + column];
                if distance > self.radius || !cost.is_finite() {
                    continue;
                }
                // Undercount the walk to this tile so the bound stays safe.
                let walk = (distance / 1.02 - 30.).max(0.);
                if cost + walk / speed <= best {
                    reach = reach.max((best - cost) * speed);
                }
            }
        }
        Some(reach)
    }
}

#[cfg(any(feature = "standalone", test))]
/// The first walking radius a cell searches before its bound is known.
const PROBE_REACH_M: f64 = 150.;

/// Whether a candidate ends at a node without riding part of a road; its
/// certified cost is then the node's hierarchy value plus its walk.
fn zero_terminal(fraction: f64, arrive: bool) -> bool {
    if arrive {
        fraction == 1. || fraction == 3. || fraction == 4.
    } else {
        fraction == 0. || fraction == 2.
    }
}

#[cfg(any(feature = "standalone", test))]
/// Runs `work` for `0..count` on the endpoint pool, in index order, with one
/// walking scratch per lane.
fn in_parallel<T: Send>(
    count: usize,
    work: impl Fn(usize, &mut walk::WalkSearch) -> T + Sync,
) -> Vec<T> {
    let Some(pool) = crate::ENDPOINT_ACCESS_POOL.as_ref() else {
        let mut scratch = walk::WalkSearch::default();
        return (0..count).map(|i| work(i, &mut scratch)).collect();
    };
    use rayon::prelude::*;
    const CHUNK: usize = 32;
    let chunks = count.div_ceil(CHUNK);
    let lanes = chunks.min(pool.current_num_threads()).max(1);
    let mut done: Vec<_> = pool.install(|| {
        (0..lanes)
            .into_par_iter()
            .flat_map_iter(|lane| {
                let mut scratch = walk::WalkSearch::default();
                let work = &work;
                (lane..chunks).step_by(lanes).map(move |chunk| {
                    let start = chunk * CHUNK;
                    let rows: Vec<_> = (start..(start + CHUNK).min(count))
                        .map(|i| work(i, &mut scratch))
                        .collect();
                    (chunk, rows)
                })
            })
            .collect()
    });
    done.sort_unstable_by_key(|(chunk, _)| *chunk);
    done.into_iter().flat_map(|(_, rows)| rows).collect()
}
