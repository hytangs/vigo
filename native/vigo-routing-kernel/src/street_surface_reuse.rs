//! Reuse a reference search only under a monotone improvement of its seeds.
//! Labels pruned by an old seed remain dominated by that seed's improvement.
//! Removing or delaying a seed breaks that proof and must run a fresh search.
use super::*;
#[path = "surface_packed.rs"]
mod packed;
use packed::Packed;

// Per CoordinateKernel; accounted with native caches and released with the graph.
const MAX_BYTES: usize = 32 * 1024 * 1024;
// Small references do not need compression to fit. Bound this faster path so
// larger references keep the compact representation and its memory savings.
const PLAIN_BYTES: usize = 8 * 1024 * 1024;
type SeedKey = (u64, u64, u64, bool, bool);

#[derive(Clone, Copy)]
struct Seed {
    key: SeedKey,
    arrival: f64,
}

fn seed(input: &StreetSurfaceInput, endpoints: Option<&[bool]>, index: usize) -> Seed {
    Seed {
        key: (
            input.seed_coordinates[index * 2].to_bits(),
            input.seed_coordinates[index * 2 + 1].to_bits(),
            input
                .seed_walk_distances_m
                .as_ref()
                .map_or(0.0, |v| v[index])
                .to_bits(),
            endpoints.is_none_or(|flags| flags[index]),
            index == 0,
        ),
        arrival: input.seed_durations_minutes[index],
    }
}

#[derive(Default)]
pub(crate) struct SurfaceReuseCache {
    baseline: Option<Baseline>,
}

struct Baseline {
    limits: [f64; 3],
    seeds: Box<[Seed]>,
    reference: Reference,
    raster: Option<Raster>,
}

#[derive(Clone, Copy)]
struct Label {
    node: u32,
    seed: u32,
    duration: f64,
    walk: f64,
}

enum Reference {
    Plain {
        labels: Box<[Label]>,
        segments: Box<[Segment]>,
    },
    Packed {
        labels: Packed<4>,
        segments: Packed<8>,
    },
}

impl Reference {
    fn bytes(&self) -> usize {
        match self {
            Self::Plain { labels, segments } => {
                std::mem::size_of_val(&**labels) + std::mem::size_of_val(&**segments)
            }
            Self::Packed { labels, segments } => labels.bytes() + segments.bytes(),
        }
    }
}

impl Baseline {
    fn labels(&self, speed: f64, mut visit: impl FnMut(Label)) {
        match &self.reference {
            Reference::Plain { labels, .. } => labels.iter().copied().for_each(visit),
            Reference::Packed { labels, .. } => labels.for_each(|[node, duration, walk, seed]| {
                let walk = f64::from_bits(walk);
                visit(Label {
                    node: node as u32,
                    seed: seed as u32,
                    walk,
                    duration: f64::from_bits(
                        duration
                            ^ predicted_duration(&self.seeds[seed as usize], walk, speed).to_bits(),
                    ),
                });
            }),
        }
    }

    fn segments<const ENDPOINTS: bool>(
        &self,
        speed: f64,
        graph: &StreetGraph<'_, ENDPOINTS>,
        mut visit: impl FnMut(Segment),
    ) {
        match &self.reference {
            Reference::Plain { segments, .. } => segments.iter().copied().for_each(visit),
            Reference::Packed { segments, .. } => {
                segments.for_each(|[edge, node, start, end, from, to, walk, seed]| {
                    let start = f64::from_bits(start);
                    let end = f64::from_bits(end);
                    let walk = f64::from_bits(walk);
                    let distance = (end - start) * graph.distance(edge as usize);
                    let from = f64::from_bits(
                        from ^ predicted_duration(
                            &self.seeds[seed as usize],
                            walk - distance,
                            speed,
                        )
                        .to_bits(),
                    );
                    let to = f64::from_bits(
                        to ^ (from + distance * (60.0 / (speed * 1000.0))).to_bits(),
                    );
                    visit(Segment {
                        edge: edge as usize,
                        from_node: node as u32,
                        start,
                        end,
                        start_minutes: from,
                        end_minutes: to,
                        end_walk_m: walk,
                        seed: seed as u32,
                    });
                })
            }
        }
    }
}

fn segments(profiles: &Profiles) -> impl Iterator<Item = Segment> + '_ {
    profiles.edges.iter().flat_map(move |&edge| {
        let mut index = profiles.heads[edge as usize];
        std::iter::from_fn(move || {
            if index == u32::MAX {
                return None;
            }
            let record = &profiles.records[index as usize];
            index = record.next;
            Some(record.segment)
        })
    })
}

// Stable radix passes preserve the original label order within each node.
// Sorting only indices avoids moving witnesses or comparing tuples O(n log n).
fn order_labels(order: &mut Vec<u32>, labels: &SurfaceRecords<SurfaceLabel>) {
    if order.len() < 65536 {
        order.sort_unstable_by_key(|&i| (labels[i as usize].node, i));
        return;
    }
    let mut scratch = vec![0; order.len()];
    let mut counts = vec![0_usize; 1 << 16];
    for shift in [0, 16] {
        counts.fill(0);
        let digit = |i: u32| ((labels[i as usize].node >> shift) & 65535) as usize;
        for &i in order.iter() {
            counts[digit(i)] += 1;
        }
        let mut offset = 0;
        for count in &mut counts {
            let n = *count;
            *count = offset;
            offset += n;
        }
        for &i in order.iter() {
            let at = &mut counts[digit(i)];
            scratch[*at] = i;
            *at += 1;
        }
        std::mem::swap(order, &mut scratch);
    }
}

struct Raster {
    bounds: Vec<f64>,
    full_bounds: Vec<f64>,
    size: [u32; 2],
    values: Vec<f64>,
    full_values: Option<Vec<f64>>,
}

impl SurfaceReuseCache {
    pub(super) fn clear(&mut self) {
        self.baseline = None;
    }

    pub(crate) fn byte_length(&self) -> usize {
        self.baseline.as_ref().map_or(0, |b| {
            std::mem::size_of::<Baseline>()
                + b.seeds.len() * std::mem::size_of::<Seed>()
                + b.reference.bytes()
                + b.raster.as_ref().map_or(0, |r| {
                    std::mem::size_of::<Raster>()
                        + 8 * (r.bounds.capacity()
                            + r.full_bounds.capacity()
                            + r.values.capacity()
                            + r.full_values.as_ref().map_or(0, Vec::capacity))
                })
        })
    }

    pub(super) fn raster(
        &self,
        input: &StreetSurfaceInput,
        full_bounds: &[f64],
    ) -> Option<(Vec<f64>, Option<Vec<f64>>)> {
        let raster = self.baseline.as_ref()?.raster.as_ref()?;
        (raster.bounds == input.bounds
            && raster.full_bounds == full_bounds
            && raster.size == [input.width, input.height]
            && raster.full_values.is_some() == input.expand_bounds_to_reached_edges)
            .then(|| (raster.values.clone(), raster.full_values.clone()))
    }

    pub(super) fn remember_raster(
        &mut self,
        input: &StreetSurfaceInput,
        bounds: &[f64],
        values: &[f64],
        full: Option<&[f64]>,
    ) {
        let extra =
            std::mem::size_of::<Raster>() + 8 * (8 + values.len() + full.map_or(0, <[f64]>::len));
        if self.byte_length() + extra > MAX_BYTES {
            return;
        }
        if let Some(baseline) = self.baseline.as_mut() {
            baseline.raster = Some(Raster {
                bounds: input.bounds.clone(),
                full_bounds: bounds.to_vec(),
                size: [input.width, input.height],
                values: values.to_vec(),
                full_values: full.map(<[f64]>::to_vec),
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn restore<const ENDPOINTS: bool>(
        &self,
        input: &StreetSurfaceInput,
        endpoints: Option<&[bool]>,
        graph: &StreetGraph<'_, ENDPOINTS>,
        heads: &mut PagedVec<u32>,
        labels: &mut SurfaceRecords<SurfaceLabel>,
        profiles: &mut Profiles,
    ) -> Option<(Vec<bool>, u32)> {
        let baseline = self.baseline.as_ref()?;
        if input.independent_terminal_walk || baseline.limits != limits(input) {
            return None;
        }
        let mut best = HashMap::<SeedKey, usize>::new();
        for index in 0..input.seed_durations_minutes.len() {
            let candidate = seed(input, endpoints, index);
            let entry = best.entry(candidate.key).or_insert(index);
            if candidate.arrival < input.seed_durations_minutes[*entry] {
                *entry = index;
            }
        }
        // Check every old seed, including those whose entire frontier was pruned.
        let mut retained = Vec::with_capacity(baseline.seeds.len());
        let mut skip = vec![false; input.seed_durations_minutes.len()];
        for old in &baseline.seeds {
            let &index = best.get(&old.key)?;
            let arrival = input.seed_durations_minutes[index];
            if arrival > old.arrival {
                return None;
            }
            let unchanged = arrival == old.arrival;
            retained.push(unchanged.then_some(index as u32));
            if unchanged {
                skip[index] = true;
            }
        }
        // Keep only unchanged seeds. Improved seeds are propagated anew, so
        // their arrival and walking evidence never retain an old time offset.
        baseline.labels(input.walk_speed_kph, |old| {
            if let Some(index) = retained[old.seed as usize] {
                let label_index = labels.len() as u32;
                labels.push(SurfaceLabel {
                    node: old.node,
                    duration_minutes: old.duration,
                    walk_distance_m: old.walk,
                    seed_index: index,
                    frontier_next: heads[old.node as usize],
                    active: true,
                });
                heads[old.node as usize] = label_index;
            }
        });
        baseline.segments(input.walk_speed_kph, graph, |old| {
            if let Some(index) = retained[old.seed as usize] {
                profiles.push(Segment { seed: index, ..old }, input);
            }
        });
        Some((skip, labels.len() as u32))
    }

    pub(super) fn remember<const ENDPOINTS: bool>(
        &mut self,
        input: &StreetSurfaceInput,
        endpoints: Option<&[bool]>,
        graph: &StreetGraph<'_, ENDPOINTS>,
        labels: &SurfaceRecords<SurfaceLabel>,
        profiles: &Profiles,
    ) {
        self.baseline = None;
        if input.independent_terminal_walk {
            return;
        }
        let overhead = std::mem::size_of::<Baseline>()
            + input.seed_durations_minutes.len() * std::mem::size_of::<Seed>();
        let Some(budget) = MAX_BYTES.checked_sub(overhead) else {
            return;
        };
        let label_count = labels.iter().filter(|l| l.active).count();
        let segment_count = profiles.records.len() - profiles.free.len();
        let plain_bytes = label_count * std::mem::size_of::<Label>()
            + segment_count * std::mem::size_of::<Segment>();
        if plain_bytes <= PLAIN_BYTES.min(budget) {
            let mut plain_labels = Vec::with_capacity(label_count);
            plain_labels.extend(labels.iter().filter(|l| l.active).map(|l| Label {
                node: l.node,
                seed: l.seed_index,
                duration: l.duration_minutes,
                walk: l.walk_distance_m,
            }));
            let mut plain_segments = Vec::with_capacity(segment_count);
            plain_segments.extend(segments(profiles));
            self.baseline = Some(Baseline {
                limits: limits(input),
                seeds: (0..input.seed_durations_minutes.len())
                    .map(|i| seed(input, endpoints, i))
                    .collect(),
                reference: Reference::Plain {
                    labels: plain_labels.into_boxed_slice(),
                    segments: plain_segments.into_boxed_slice(),
                },
                raster: None,
            });
            debug_assert!(self.byte_length() <= MAX_BYTES);
            return;
        }
        // Group neighboring nodes without changing the original order within a
        // frontier. Sorting only indices keeps the temporary working set small.
        let mut order = Vec::with_capacity(label_count);
        order.extend(
            labels
                .iter()
                .enumerate()
                .filter_map(|(i, l)| l.active.then_some(i as u32)),
        );
        order_labels(&mut order, labels);
        let packed_labels = Packed::encode(
            order.iter().map(|&i| {
                let l = &labels[i as usize];
                [
                    u64::from(l.node),
                    l.duration_minutes.to_bits()
                        ^ predicted_duration(
                            &seed(input, endpoints, l.seed_index as usize),
                            l.walk_distance_m,
                            input.walk_speed_kph,
                        )
                        .to_bits(),
                    l.walk_distance_m.to_bits(),
                    u64::from(l.seed_index),
                ]
            }),
            budget,
        );
        drop(order);
        let Some(labels) = packed_labels else {
            return;
        };
        let segments = segments(profiles).map(|s| {
            let distance = (s.end - s.start) * graph.distance(s.edge);
            [
                s.edge as u64,
                u64::from(s.from_node),
                s.start.to_bits(),
                s.end.to_bits(),
                s.start_minutes.to_bits()
                    ^ predicted_duration(
                        &seed(input, endpoints, s.seed as usize),
                        s.end_walk_m - distance,
                        input.walk_speed_kph,
                    )
                    .to_bits(),
                s.end_minutes.to_bits()
                    ^ (s.start_minutes + distance * (60.0 / (input.walk_speed_kph * 1000.0)))
                        .to_bits(),
                s.end_walk_m.to_bits(),
                u64::from(s.seed),
            ]
        });
        let Some(segments) = Packed::encode(segments, budget - labels.bytes()) else {
            return;
        };
        self.baseline = Some(Baseline {
            limits: limits(input),
            seeds: (0..input.seed_durations_minutes.len())
                .map(|i| seed(input, endpoints, i))
                .collect(),
            reference: Reference::Packed { labels, segments },
            raster: None,
        });
        debug_assert!(self.byte_length() <= MAX_BYTES);
    }
}

fn limits(input: &StreetSurfaceInput) -> [f64; 3] {
    [
        input.maximum_walk_m,
        input.walk_speed_kph,
        input.maximum_duration_minutes,
    ]
}

// Arrival and elapsed walking predict almost all duration bits. Store the XOR
// residual too: repeated edge additions do not round like one multiplication.
// Decoding restores the original bits, never a rounded or recomputed duration.
fn predicted_duration(seed: &Seed, walk: f64, speed: f64) -> f64 {
    seed.arrival + (walk - f64::from_bits(seed.key.2)) * (60.0 / (speed * 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radix_order_preserves_frontiers_and_all_node_id_bits() {
        let mut labels = SurfaceRecords::new();
        let mut state = 731_u32;
        for i in 0..150_000 {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            labels.push(SurfaceLabel {
                node: if i % 3 == 0 {
                    u32::MAX
                } else {
                    state & 0xffff_00ff
                },
                duration_minutes: 0.,
                walk_distance_m: 0.,
                seed_index: 0,
                frontier_next: u32::MAX,
                active: true,
            });
        }
        let mut order: Vec<_> = (0..labels.len() as u32).collect();
        let mut expected = order.clone();
        expected.sort_unstable_by_key(|&i| (labels[i as usize].node, i));
        order_labels(&mut order, &labels);
        assert_eq!(order, expected);
    }

    #[test]
    fn plain_and_packed_references_restore_identical_bits_and_replace_each_other() {
        let input = StreetSurfaceInput {
            surface_reuse: Some("baseline".into()),
            bounds: vec![0., 0., 1., 1.],
            width: 1,
            height: 1,
            seed_coordinates: vec![0., 0.],
            seed_durations_minutes: vec![1.3],
            seed_member_indices: None,
            seed_walk_distances_m: Some(vec![17.123]),
            maximum_walk_m: 1200.,
            walk_speed_kph: 4.8,
            maximum_duration_minutes: 30.,
            independent_terminal_walk: false,
            include_nodes: true,
            node_evidence_limit: 100_000,
            include_edges: true,
            edge_evidence_limit: 0,
            expand_bounds_to_reached_edges: true,
            reverse_direction: None,
        };
        let mut cache = SurfaceReuseCache::default();
        for count in [32, 120_000, 32] {
            let distances = vec![41.3; count];
            let targets = vec![0; count];
            let graph = StreetGraph::<false> {
                node_lats: &[],
                node_lons: &[],
                edge_offsets: &[],
                edge_targets: &targets,
                edge_distances_m: &distances,
                terminal: None,
            };
            let mut labels = SurfaceRecords::new();
            let mut profiles = Profiles::new(count);
            for i in 0..count {
                let walk = 17.123 + (i % 700) as f64 / 1.7;
                let duration = (1.3 + (walk - 17.123) * 0.0125) + (i % 7) as f64 * f64::EPSILON;
                labels.push(SurfaceLabel {
                    node: i as u32,
                    duration_minutes: duration,
                    walk_distance_m: walk,
                    seed_index: 0,
                    frontier_next: u32::MAX,
                    active: true,
                });
                profiles.push(
                    Segment {
                        edge: i,
                        from_node: i as u32,
                        start: 0.,
                        end: 1.,
                        start_minutes: duration,
                        end_minutes: duration + 41.3 * 0.0125,
                        end_walk_m: walk + 41.3,
                        seed: 0,
                    },
                    &input,
                );
            }
            cache.remember(&input, None, &graph, &labels, &profiles);
            assert!(cache.byte_length() <= MAX_BYTES);
            assert_eq!(
                matches!(
                    cache.baseline.as_ref().unwrap().reference,
                    Reference::Plain { .. }
                ),
                count == 32
            );
            let mut restored = SurfaceRecords::new();
            let mut heads = PagedVec::new(count, u32::MAX);
            let mut edges = Profiles::new(count);
            let (skip, reused) = cache
                .restore(&input, None, &graph, &mut heads, &mut restored, &mut edges)
                .unwrap();
            assert_eq!(skip, vec![true]);
            assert_eq!(reused as usize, count);
            for (a, b) in labels.iter().zip(restored.iter()) {
                assert_eq!(a.node, b.node);
                assert_eq!(a.duration_minutes.to_bits(), b.duration_minutes.to_bits());
                assert_eq!(a.walk_distance_m.to_bits(), b.walk_distance_m.to_bits());
            }
            for (a, b) in segments(&profiles).zip(segments(&edges)) {
                assert_eq!((a.edge, a.from_node, a.seed), (b.edge, b.from_node, b.seed));
                assert_eq!(
                    [a.start, a.end, a.start_minutes, a.end_minutes, a.end_walk_m]
                        .map(f64::to_bits),
                    [b.start, b.end, b.start_minutes, b.end_minutes, b.end_walk_m]
                        .map(f64::to_bits)
                );
            }
        }
    }
}
