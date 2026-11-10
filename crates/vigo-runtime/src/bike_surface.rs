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
                    arrival_limit.is_some(),
                    &eligible,
                    arrival_limit.is_some(),
                    scratch,
                );
            }
            self.attach_bicycle_matching(
                &graph,
                point,
                max_walk,
                walk_speed / 3.6,
                arrival_limit.is_some(),
                false,
                &eligible,
            )
        };
        let attachments: Vec<_> = if let Some(pool) = crate::ENDPOINT_ACCESS_POOL.as_ref() {
            use rayon::prelude::*;
            const CHUNK: usize = 32;
            let count = targets.len().div_ceil(CHUNK);
            let lanes = count.min(pool.current_num_threads());
            let mut chunks: Vec<_> = pool.install(|| {
                (0..lanes)
                    .into_par_iter()
                    .flat_map_iter(|lane| {
                        let mut scratch = walk::WalkSearch::default();
                        (lane..count).step_by(lanes).map(move |index| {
                            let start = index * CHUNK;
                            let rows: Vec<_> = targets[start..(start + CHUNK).min(targets.len())]
                                .iter()
                                .map(|point| attach(point, &mut scratch))
                                .collect();
                            (index, rows)
                        })
                    })
                    .collect()
            });
            chunks.sort_unstable_by_key(|(index, _)| *index);
            chunks.into_iter().flat_map(|(_, rows)| rows).collect()
        } else {
            let mut scratch = walk::WalkSearch::default();
            targets
                .iter()
                .map(|point| attach(point, &mut scratch))
                .collect()
        };
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
                    SurfaceTerminal::new(target, end, attachment, arrival_limit.is_some());
                *slot += 1;
            }
        }
        drop(next);
        let access_groups = ends.permissions.len();
        let access_group_key_bytes = ends.permissions.iter().map(|v| v.capacity() * 4).sum();
        if self.walking.is_none()
            && std::iter::once(&starts)
                .chain(&ends.attachments)
                .any(|attachment| {
                    attachment
                        .nearest_meters
                        .is_some_and(|meters| max_walk > meters + ALTERNATIVE_TOLERANCE_M)
                })
        {
            // Select the endpoint scope using the uncut CCH minimum.
            // Reach's display cutoff must not change which roads match.
            let arrive = arrival_limit.is_some();
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
        let attachment_ms = started.elapsed().as_secs_f64() * 1000.;
        let seconds = if let Some(limit) = arrival_limit {
            hierarchy::reverse::measure(
                self,
                &starts,
                &ends,
                &origin_access,
                opt,
                clock,
                max_distance,
                maximum_seconds,
                limit,
                walk_speed,
                attachment_ms,
            )?
        } else {
            hierarchy::measure(
                self,
                &starts,
                &ends,
                &origin_access,
                opt,
                clock,
                max_distance,
                maximum_seconds,
                walk_speed,
                attachment_ms,
            )?
        };
        Ok(BikeSurface {
            seconds,
            access_groups,
            access_group_key_bytes,
        })
    }
}
