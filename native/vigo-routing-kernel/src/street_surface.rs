//! Time and distance constrained street intervals, including partial edges.
use super::*;

#[derive(Clone, Copy)]
struct Segment {
    edge: usize,
    from_node: u32,
    start: f64,
    end: f64,
    start_minutes: f64,
    end_minutes: f64,
    end_walk_m: f64,
    seed: u32,
}

impl Segment {
    fn at(self, fraction: f64) -> f64 {
        self.start_minutes
            + (self.end_minutes - self.start_minutes) * (fraction - self.start)
                / (self.end - self.start)
    }

    fn coordinate(self, graph: &StreetGraph<'_>, fraction: f64) -> [f64; 2] {
        let a = self.from_node as usize;
        let b = graph.edge_targets[self.edge] as usize;
        [
            graph.node_lons[a] + fraction * (graph.node_lons[b] - graph.node_lons[a]),
            graph.node_lats[a] + fraction * (graph.node_lats[b] - graph.node_lats[a]),
        ]
    }

    fn surface_cost(self, input: &StreetSurfaceInput) -> f64 {
        if input.independent_terminal_walk {
            input.seed_durations_minutes[self.seed as usize]
        } else {
            self.at(0.0)
        }
    }
}

struct Candidate {
    segment: Segment,
    next: u32,
}

struct Profiles {
    heads: PagedVec<u32>,
    records: Vec<Candidate>,
    free: Vec<u32>,
    edges: Vec<u32>,
}

impl Profiles {
    fn new(edges: usize) -> Self {
        Self {
            heads: PagedVec::new(edges, u32::MAX),
            records: Vec::new(),
            free: Vec::new(),
            edges: Vec::new(),
        }
    }

    fn push(&mut self, segment: Segment, input: &StreetSurfaceInput) {
        let dominates = |a: Segment, b: Segment| {
            a.start <= b.start
                && a.end >= b.end
                && (a.surface_cost(input) < b.surface_cost(input) - DURATION_EPSILON_MINUTES
                    || (a.surface_cost(input) - b.surface_cost(input)).abs()
                        <= DURATION_EPSILON_MINUTES
                        && a.at(0.0) <= b.at(0.0) + DURATION_EPSILON_MINUTES)
        };
        let mut i = self.heads[segment.edge];
        let first_on_edge = i == u32::MAX;
        while i != u32::MAX {
            let record = &self.records[i as usize];
            if dominates(record.segment, segment) {
                return;
            }
            i = record.next;
        }
        let mut i = self.heads[segment.edge];
        let mut previous: Option<usize> = None;
        while i != u32::MAX {
            let record = &self.records[i as usize];
            let next = record.next;
            if dominates(segment, record.segment) {
                if let Some(previous) = previous {
                    self.records[previous].next = next;
                } else {
                    self.heads[segment.edge] = next;
                }
                self.free.push(i);
            } else {
                previous = Some(i as usize);
            }
            i = next;
        }
        let next = self.heads[segment.edge];
        if first_on_edge { self.edges.push(segment.edge as u32); }
        // No queue references edge candidates. Reuse retired records in place
        // instead of retaining their geometry for the rest of the query.
        let candidate = Candidate { segment, next };
        let index = if let Some(index) = self.free.pop() {
            self.records[index as usize] = candidate;
            index
        } else {
            let index = self.records.len() as u32;
            self.records.push(candidate);
            index
        };
        self.heads[segment.edge] = index;
    }

    fn envelope(mut self, graph: &StreetGraph<'_>, input: &StreetSurfaceInput) -> Vec<Segment> {
        // Order only the touched edge IDs. Sorting all 64-byte candidate
        // records needlessly moves geometry for the entire reached network.
        self.edges.sort_unstable();
        let mut result: Vec<Segment> = Vec::with_capacity(self.edges.len());
        let mut group = Vec::new();
        let mut cuts = Vec::new();
        for edge in self.edges {
            group.clear();
            let mut index = self.heads[edge as usize];
            while index != u32::MAX {
                let record = &self.records[index as usize];
                group.push(record.segment);
                index = record.next;
            }
            // Restore insertion order for exact ties in the stable sort.
            group.reverse();
            group.sort_by(|a,b| a.start.total_cmp(&b.start).then_with(|| a.seed.cmp(&b.seed)));
            if group.len() == 1 {
                result.push(group[0]);
                continue;
            }
            cuts.clear();
            cuts.extend(group.iter().flat_map(|r| [r.start, r.end]));
            cuts.sort_by(f64::total_cmp);
            cuts.dedup();
            for pair in cuts.windows(2) {
                let [start, end] = [pair[0], pair[1]];
                if end <= start {
                    continue;
                }
                let middle = (start + end) / 2.0;
                let best = group
                    .iter()
                    .filter(|r| r.start <= middle && r.end >= middle)
                    .min_by(|a, b| {
                        a.surface_cost(input)
                            .total_cmp(&b.surface_cost(input))
                            .then_with(|| a.at(middle).total_cmp(&b.at(middle)))
                            .then_with(|| a.end_walk_m.total_cmp(&b.end_walk_m))
                            .then_with(|| a.seed.cmp(&b.seed))
                    });
                let Some(best) = best else {
                    continue;
                };
                let clipped = Segment {
                    start,
                    end,
                    start_minutes: best.at(start),
                    end_minutes: best.at(end),
                    end_walk_m: best.end_walk_m
                        - (best.end - end) * graph.edge_distances_m[best.edge],
                    ..*best
                };
                if let Some(previous) = result.last_mut()
                    && previous.edge == clipped.edge
                    && previous.seed == clipped.seed
                    && previous.end == clipped.start
                    && (previous.end_minutes - clipped.start_minutes).abs()
                        < DURATION_EPSILON_MINUTES
                {
                    previous.end = clipped.end;
                    previous.end_minutes = clipped.end_minutes;
                    previous.end_walk_m = clipped.end_walk_m;
                } else {
                    result.push(clipped);
                }
            }
        }
        result
    }
}

#[allow(clippy::too_many_arguments)]
fn reachable_segment(
    graph: &StreetGraph<'_>,
    input: &StreetSurfaceInput,
    edge: usize,
    from_node: u32,
    start: f64,
    start_minutes: f64,
    start_walk_m: f64,
    seed: u32,
) -> Option<Segment> {
    let minutes_per_meter = 60.0 / (input.walk_speed_kph * 1000.0);
    let maximum_minutes = if input.independent_terminal_walk {
        (input.seed_durations_minutes[seed as usize] + input.maximum_walk_m * minutes_per_meter)
            .min(input.maximum_duration_minutes)
    } else {
        input.maximum_duration_minutes
    };
    let remaining = (input.maximum_walk_m - start_walk_m)
        .min((maximum_minutes - start_minutes) / minutes_per_meter);
    let length = graph.edge_distances_m[edge];
    if remaining <= DISTANCE_EPSILON_M || start >= 1.0 {
        return None;
    }
    let end = if length > 0.0 {
        (start + remaining / length).min(1.0)
    } else {
        1.0
    };
    let distance = (end - start) * length;
    Some(Segment {
        edge,
        from_node,
        start,
        end,
        start_minutes,
        end_minutes: start_minutes + distance * minutes_per_meter,
        end_walk_m: start_walk_m + distance,
        seed,
    })
}

fn raster_segment(
    values: &mut [f64],
    bounds: &[f64],
    width: usize,
    height: usize,
    graph: &StreetGraph<'_>,
    input: &StreetSurfaceInput,
    segment: Segment,
) {
    let from = segment.coordinate(graph, segment.start);
    let to = segment.coordinate(graph, segment.end);
    rasterize_surface_edge(
        values,
        bounds,
        width,
        height,
        RasterSurfaceEdge {
            from_longitude: from[0],
            from_latitude: from[1],
            to_longitude: to[0],
            to_latitude: to[1],
            from_duration_minutes: segment.start_minutes,
            edge_duration_minutes: segment.end_minutes - segment.start_minutes,
            maximum_duration_minutes: input.maximum_duration_minutes,
            constant_duration_minutes: input
                .independent_terminal_walk
                .then(|| input.seed_durations_minutes[segment.seed as usize]),
        },
    );
}

pub(super) fn compute(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    snaps: &mut SurfaceSnapCache,
    input: StreetSurfaceInput,
) -> napi::Result<StreetSurfaceResult> {
    let started = Instant::now();
    if input.bounds.len() != 4
        || input.bounds.iter().any(|v| !v.is_finite())
        || input.bounds[0] >= input.bounds[2]
        || input.bounds[1] >= input.bounds[3]
        || input.width == 0
        || input.height == 0
        || input.width > 1024
        || input.height > 1024
    {
        return Err(Error::from_reason(
            "Rust street surface requires valid bounds and a raster no larger than 1024 by 1024.",
        ));
    }
    validate_common_limits(
        input.maximum_walk_m,
        input.walk_speed_kph,
        input.maximum_duration_minutes,
    )?;
    validate_coordinate_pairs(
        &input.seed_coordinates,
        input.seed_durations_minutes.len(),
        "surface seed",
    )?;
    if input
        .seed_durations_minutes
        .iter()
        .any(|d| !d.is_finite() || *d < 0.0)
        || input.seed_walk_distances_m.as_ref().is_some_and(|v| {
            v.len() != input.seed_durations_minutes.len()
                || v.iter().any(|d| !d.is_finite() || *d < 0.0)
        })
    {
        return Err(Error::from_reason(
            "Street surface seed durations or walking distances are inconsistent.",
        ));
    }
    let graph = StreetGraph::open(snapshot)?;
    let (width, height) = (input.width as usize, input.height as usize);
    let mut values = vec![f64::INFINITY; width * height];
    let mut labels = Vec::<SurfaceLabel>::new();
    let mut heads = PagedVec::new(graph.node_lats.len(), u32::MAX);
    let mut queue = BinaryHeap::<LabelQueueEntry>::new();
    let mut profiles = Profiles::new(graph.edge_targets.len());
    let mut diagnostics = SearchDiagnostics::default();
    let minutes_per_meter = 60.0 / (input.walk_speed_kph * 1000.0);
    let mut workspace = SnapWorkspace::default();
    // Seed all labels before propagation. Dominance compares both arrival and
    // walking distance, so a later seed with more walking left remains eligible.
    for seed in 0..input.seed_durations_minutes.len() {
        let initial = input
            .seed_walk_distances_m
            .as_ref()
            .map_or(0.0, |d| d[seed]);
        let arrival = input.seed_durations_minutes[seed];
        let (snaps, projection) = snaps.attach(
            snapshot,
            reciprocal_edge_flags,
            &mut workspace,
            input.seed_coordinates[seed * 2],
            input.seed_coordinates[seed * 2 + 1],
        )?;
        let mut snapped = false;
        if let Some(p) = projection {
            let start_minutes = arrival + p.projection_distance_m * minutes_per_meter;
            let start_walk = initial + p.projection_distance_m;
            let reverse = (graph.edge_offsets[p.right.node as usize] as usize
                ..graph.edge_offsets[p.right.node as usize + 1] as usize)
                .filter(|&e| graph.edge_targets[e] == p.left.node)
                .min_by(|&a, &b| graph.edge_distances_m[a].total_cmp(&graph.edge_distances_m[b]));
            for (edge, node, fraction) in std::iter::once((p.edge_index, p.left.node, p.fraction))
                .chain(reverse.map(|e| (e, p.right.node, 1.0 - p.fraction)))
            {
                if let Some(segment) = reachable_segment(
                    &graph,
                    &input,
                    edge,
                    node,
                    fraction,
                    start_minutes,
                    start_walk,
                    seed as u32,
                ) {
                    profiles.push(segment, &input);
                    snapped = true;
                }
            }
        }
        for snap in snaps {
            let retained = push_surface_label(
                &mut heads,
                &mut labels,
                &mut queue,
                &input.seed_durations_minutes,
                snap.node,
                arrival + snap.distance_m * minutes_per_meter,
                initial + snap.distance_m,
                input.maximum_walk_m,
                input.maximum_duration_minutes,
                arrival,
                seed as u32,
                input.independent_terminal_walk,
            );
            if retained {
                snapped = true;
                diagnostics.retained_labels = diagnostics.retained_labels.saturating_add(1);
            }
        }
        if snapped {
            diagnostics.snapped_seeds = diagnostics.snapped_seeds.saturating_add(1);
        }
    }
    let seed_ns = started.elapsed().as_nanos() as f64;
    let propagation_started = Instant::now();
    while let Some(entry) = queue.pop() {
        if !labels[entry.label_index].active {
            continue;
        }
        let current = labels[entry.label_index];
        diagnostics.settled_labels = diagnostics.settled_labels.saturating_add(1);
        let node = current.node as usize;
        for edge in graph.edge_offsets[node] as usize..graph.edge_offsets[node + 1] as usize {
            diagnostics.relaxed_edges = diagnostics.relaxed_edges.saturating_add(1);
            if let Some(segment) = reachable_segment(
                &graph,
                &input,
                edge,
                current.node,
                0.0,
                current.duration_minutes,
                current.walk_distance_m,
                current.seed_index,
            ) {
                profiles.push(segment, &input);
                if segment.end == 1.0
                    && push_surface_label(
                        &mut heads,
                        &mut labels,
                        &mut queue,
                        &input.seed_durations_minutes,
                        graph.edge_targets[edge],
                        segment.end_minutes,
                        segment.end_walk_m,
                        input.maximum_walk_m,
                        input.maximum_duration_minutes,
                        input.seed_durations_minutes[current.seed_index as usize],
                        current.seed_index,
                        input.independent_terminal_walk,
                    )
                {
                    diagnostics.retained_labels = diagnostics.retained_labels.saturating_add(1);
                }
            }
        }
    }
    let propagation_ns = propagation_started.elapsed().as_nanos() as f64;
    let envelope_started = Instant::now();
    let segments = profiles.envelope(&graph, &input);
    let envelope_ns = envelope_started.elapsed().as_nanos() as f64;
    let raster_started = Instant::now();
    let reached_edge_count = segments
        .iter()
        .map(|s| s.edge)
        .fold((None, 0_u32), |(last, n), edge| {
            (Some(edge), n + u32::from(last != Some(edge)))
        })
        .1;
    let reached_edge_length_m = segments
        .iter()
        .map(|s| (s.end - s.start) * graph.edge_distances_m[s.edge])
        .sum();
    let mut full_bounds = input.bounds.clone();
    if input.expand_bounds_to_reached_edges {
        let mut bounds = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        let mut include = |p: [f64; 2]| {
            bounds[0] = bounds[0].min(p[0]);
            bounds[1] = bounds[1].min(p[1]);
            bounds[2] = bounds[2].max(p[0]);
            bounds[3] = bounds[3].max(p[1]);
        };
        if let Some(p) = input.seed_coordinates.as_chunks::<2>().0.first() {
            include(*p);
        }
        for s in &segments {
            include(s.coordinate(&graph, s.start));
            include(s.coordinate(&graph, s.end));
        }
        for l in labels.iter().filter(|l| l.active) {
            include([
                graph.node_lons[l.node as usize],
                graph.node_lats[l.node as usize],
            ]);
        }
        if bounds.iter().all(|v| v.is_finite()) {
            if bounds[0] == bounds[2] {
                bounds[0] -= 1e-7;
                bounds[2] += 1e-7;
            }
            if bounds[1] == bounds[3] {
                bounds[1] -= 1e-7;
                bounds[3] += 1e-7;
            }
            full_bounds = bounds.to_vec();
        }
    }
    let mut full_values = input
        .expand_bounds_to_reached_edges
        .then(|| vec![f64::INFINITY; width * height]);
    for &segment in &segments {
        raster_segment(
            &mut values,
            &input.bounds,
            width,
            height,
            &graph,
            &input,
            segment,
        );
        if let Some(full) = full_values.as_mut() {
            raster_segment(full, &full_bounds, width, height, &graph, &input, segment);
        }
    }
    let mut node_evidence = HashMap::<u32, (f64, f64)>::new();
    for label in labels.iter().filter(|l| l.active) {
        let lon = graph.node_lons[label.node as usize];
        let lat = graph.node_lats[label.node as usize];
        let duration = if input.independent_terminal_walk {
            input.seed_durations_minutes[label.seed_index as usize]
        } else {
            label.duration_minutes
        };
        if let Some(cell) = raster_cell(&input.bounds, width, height, lon, lat) {
            values[cell] = values[cell].min(duration);
            if input.include_nodes {
                let best = node_evidence
                    .entry(label.node)
                    .or_insert((label.duration_minutes, label.walk_distance_m));
                if (label.duration_minutes, label.walk_distance_m) < *best {
                    *best = (label.duration_minutes, label.walk_distance_m);
                }
            }
        }
        if let Some(full) = full_values.as_mut()
            && let Some(cell) = raster_cell(&full_bounds, width, height, lon, lat)
        {
            full[cell] = full[cell].min(duration);
        }
    }
    let mut node_evidence: Vec<_> = node_evidence
        .into_iter()
        .map(
            |(node, (duration_minutes, walk_distance_m))| StreetSurfaceNode {
                longitude: graph.node_lons[node as usize],
                latitude: graph.node_lats[node as usize],
                duration_minutes,
                walk_distance_m,
            },
        )
        .collect();
    node_evidence.sort_by(|a, b| {
        a.duration_minutes
            .total_cmp(&b.duration_minutes)
            .then_with(|| a.walk_distance_m.total_cmp(&b.walk_distance_m))
            .then_with(|| a.latitude.total_cmp(&b.latitude))
            .then_with(|| a.longitude.total_cmp(&b.longitude))
    });
    let node_limit = input.node_evidence_limit.clamp(1, 100_000) as usize;
    let node_evidence_truncated = node_evidence.len() > node_limit;
    node_evidence.truncate(node_limit);
    let edge_limit = if input.edge_evidence_limit == 0 {
        usize::MAX
    } else {
        input.edge_evidence_limit.clamp(1, 100_000) as usize
    };
    let edge_evidence_truncated = input.include_edges && segments.len() > edge_limit;
    let mut edge_evidence = Vec::new();
    let mut coordinates = Vec::<f64>::new();
    let mut node_ids = HashMap::<u32, u32>::new();
    let mut endpoints = Vec::new();
    let mut ids = Vec::new();
    let mut durations = Vec::new();
    let mut starts = Vec::new();
    let mut fractions = Vec::new();
    let mut ends = Vec::new();
    let mut walks = Vec::new();
    let mut arrivals = Vec::new();
    if input.include_edges {
        for s in segments.iter().take(edge_limit) {
            let transit_arrival = if s.seed == 0 {
                None
            } else {
                Some(input.seed_durations_minutes[s.seed as usize])
            };
            if input.edge_evidence_limit > 0 {
                let a = s.coordinate(&graph, s.start);
                let b = s.coordinate(&graph, s.end);
                edge_evidence.push(StreetSurfaceEdge {
                    from_longitude: a[0],
                    from_latitude: a[1],
                    to_longitude: b[0],
                    to_latitude: b[1],
                    duration_minutes: s.end_minutes,
                    from_duration_minutes: s.start_minutes,
                    walk_distance_m: s.end_walk_m,
                    transit_arrival_minutes: transit_arrival,
                });
                continue;
            }
            for node in [s.from_node, graph.edge_targets[s.edge]] {
                let id = *node_ids.entry(node).or_insert_with(|| {
                    let id = (coordinates.len() / 2) as u32;
                    coordinates.extend([
                        graph.node_lons[node as usize],
                        graph.node_lats[node as usize],
                    ]);
                    id
                });
                endpoints.push(id);
            }
            ids.push(s.edge as u32);
            durations.push(s.end_minutes);
            starts.push(s.start_minutes);
            fractions.push(s.start);
            ends.push(s.end);
            walks.push(s.end_walk_m);
            arrivals.push(transit_arrival.unwrap_or(-1.0));
        }
    }
    let packed = input.include_edges && input.edge_evidence_limit == 0;
    Ok(StreetSurfaceResult {
        reached_pixels: values.iter().filter(|v| v.is_finite()).count() as u32,
        values,
        full_surface_values: full_values,
        full_surface_bounds: input.expand_bounds_to_reached_edges.then_some(full_bounds),
        snapped_seeds: diagnostics.snapped_seeds,
        settled_labels: diagnostics.settled_labels,
        relaxed_edges: diagnostics.relaxed_edges,
        retained_labels: diagnostics.retained_labels,
        query_ns: started.elapsed().as_nanos() as f64,
        seed_ns,
        propagation_ns,
        envelope_ns,
        raster_ns: raster_started.elapsed().as_nanos() as f64,
        node_evidence,
        node_evidence_truncated,
        reached_edge_count,
        reached_edge_length_m,
        edge_evidence,
        edge_evidence_truncated,
        edge_evidence_nodes: packed.then(|| coordinates.into()),
        edge_evidence_endpoints: packed.then(|| endpoints.into()),
        edge_evidence_ids: packed.then(|| ids.into()),
        edge_evidence_durations: packed.then(|| durations.into()),
        edge_evidence_start_durations: packed.then(|| starts.into()),
        edge_evidence_start_fractions: packed.then(|| fractions.into()),
        edge_evidence_end_fractions: packed.then(|| ends.into()),
        edge_evidence_walk_distances: packed.then(|| walks.into()),
        edge_evidence_transit_arrivals: packed.then(|| arrivals.into()),
    })
}
