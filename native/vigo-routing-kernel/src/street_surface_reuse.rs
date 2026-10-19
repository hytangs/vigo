//! Reuse a reference search only under a monotone improvement of its seeds.
//! Labels pruned by an old seed remain dominated by that seed's improvement.
//! Removing or delaying a seed breaks that proof and must run a fresh search.
use super::*;

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
    seeds: Vec<Seed>,
    labels: Vec<SurfaceLabel>,
    segments: Vec<Segment>,
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
    pub(crate) fn byte_length(&self) -> usize {
        self.baseline.as_ref().map_or(0, |b| {
            std::mem::size_of::<Baseline>()
                + b.seeds.capacity() * std::mem::size_of::<Seed>()
                + b.labels.capacity() * std::mem::size_of::<SurfaceLabel>()
                + b.segments.capacity() * std::mem::size_of::<Segment>()
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
    pub(super) fn restore(
        &self,
        input: &StreetSurfaceInput,
        endpoints: Option<&[bool]>,
        heads: &mut PagedVec<u32>,
        labels: &mut Vec<SurfaceLabel>,
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
        for old in &baseline.labels {
            if let Some(index) = retained[old.seed_index as usize] {
                let label_index = labels.len() as u32;
                labels.push(SurfaceLabel {
                    seed_index: index,
                    frontier_next: heads[old.node as usize],
                    ..*old
                });
                heads[old.node as usize] = label_index;
            }
        }
        for old in &baseline.segments {
            if let Some(index) = retained[old.seed as usize] {
                profiles.push(
                    Segment {
                        seed: index,
                        ..*old
                    },
                    input,
                );
            }
        }
        Some((skip, labels.len() as u32))
    }

    pub(super) fn remember(
        &mut self,
        input: &StreetSurfaceInput,
        endpoints: Option<&[bool]>,
        labels: &[SurfaceLabel],
        profiles: &Profiles,
    ) {
        self.baseline = None;
        if input.independent_terminal_walk {
            return;
        }
        let label_count = labels.iter().filter(|l| l.active).count();
        let segment_count = profiles.records.len() - profiles.free.len();
        let bytes = std::mem::size_of::<Baseline>()
            + input.seed_durations_minutes.len() * std::mem::size_of::<Seed>()
            + label_count * std::mem::size_of::<SurfaceLabel>()
            + segment_count * std::mem::size_of::<Segment>();
        if bytes > MAX_BYTES {
            return;
        }
        let mut segments = Vec::with_capacity(segment_count);
        for &edge in &profiles.edges {
            let mut index = profiles.heads[edge as usize];
            while index != u32::MAX {
                let record = &profiles.records[index as usize];
                segments.push(record.segment);
                index = record.next;
            }
        }
        self.baseline = Some(Baseline {
            limits: limits(input),
            seeds: (0..input.seed_durations_minutes.len())
                .map(|i| seed(input, endpoints, i))
                .collect(),
            labels: labels.iter().filter(|l| l.active).copied().collect(),
            segments,
            raster: None,
        });
        if self.byte_length() > MAX_BYTES {
            self.baseline = None;
        }
    }
}

fn limits(input: &StreetSurfaceInput) -> [f64; 3] {
    [
        input.maximum_walk_m,
        input.walk_speed_kph,
        input.maximum_duration_minutes,
    ]
}
