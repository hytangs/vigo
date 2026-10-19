//! Reuse a reference search only under a monotone improvement of its seeds.
//! Labels pruned by an old seed remain dominated by that seed's improvement.
//! Removing or delaying a seed breaks that proof and must run a fresh search.
use super::*;
#[path = "surface_packed.rs"]
mod packed;
use packed::Packed;

// Per CoordinateKernel; accounted with native caches and released with the graph.
const MAX_BYTES: usize = 32 * 1024 * 1024;
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
    labels: Packed<4>,
    segments: Packed<8>,
    raster: Option<Raster>,
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
                + b.labels.bytes()
                + b.segments.bytes()
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
        baseline.labels.for_each(|[node, duration, walk, seed]| {
            if let Some(index) = retained[seed as usize] {
                let label_index = labels.len() as u32;
                labels.push(SurfaceLabel {
                    node: node as u32,
                    duration_minutes: f64::from_bits(
                        duration
                            ^ predicted_duration(
                                &baseline.seeds[seed as usize],
                                f64::from_bits(walk),
                                input.walk_speed_kph,
                            )
                            .to_bits(),
                    ),
                    walk_distance_m: f64::from_bits(walk),
                    seed_index: index,
                    frontier_next: heads[node as usize],
                    active: true,
                });
                heads[node as usize] = label_index;
            }
        });
        baseline
            .segments
            .for_each(|[edge, node, start, end, from, to, walk, seed]| {
                if let Some(index) = retained[seed as usize] {
                    let start = f64::from_bits(start);
                    let end = f64::from_bits(end);
                    let walk = f64::from_bits(walk);
                    let distance = (end - start) * graph.distance(edge as usize);
                    let from = f64::from_bits(
                        from ^ predicted_duration(
                            &baseline.seeds[seed as usize],
                            walk - distance,
                            input.walk_speed_kph,
                        )
                        .to_bits(),
                    );
                    let to = f64::from_bits(
                        to ^ (from + distance * (60.0 / (input.walk_speed_kph * 1000.0))).to_bits(),
                    );
                    profiles.push(
                        Segment {
                            edge: edge as usize,
                            from_node: node as u32,
                            start,
                            end,
                            start_minutes: from,
                            end_minutes: to,
                            end_walk_m: walk,
                            seed: index,
                        },
                        input,
                    );
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
        // Group neighboring nodes without changing the original order within a
        // frontier. Sorting only indices keeps the temporary working set small.
        let mut order = Vec::with_capacity(labels.iter().filter(|l| l.active).count());
        order.extend(
            labels
                .iter()
                .enumerate()
                .filter_map(|(i, l)| l.active.then_some(i as u32)),
        );
        order.sort_unstable_by_key(|&i| (labels[i as usize].node, i));
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
        let segments = profiles.edges.iter().flat_map(|&edge| {
            let mut index = profiles.heads[edge as usize];
            std::iter::from_fn(move || {
                if index == u32::MAX {
                    return None;
                }
                let record = &profiles.records[index as usize];
                index = record.next;
                let s = record.segment;
                let distance = (s.end - s.start) * graph.distance(s.edge);
                Some([
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
                ])
            })
        });
        let Some(segments) = Packed::encode(segments, budget - labels.bytes()) else {
            return;
        };
        self.baseline = Some(Baseline {
            limits: limits(input),
            seeds: (0..input.seed_durations_minutes.len())
                .map(|i| seed(input, endpoints, i))
                .collect(),
            labels,
            segments,
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
