//! Where a free coordinate meets the drive graph.
//!
//! A point is attached to the nearest drivable road segment by projection,
//! not to the nearest graph node: on a long straight road the nearest node can
//! be far from the nearest road. The straight gap between the point and the
//! road is a walk. Entering the road mid-segment costs the remaining part of
//! that segment, in the segment's own direction.

const CELL_DEGREES: f64 = 0.004;
const EARTH_RADIUS_M: f64 = 6_371_008.8;
/// Roads this much farther than the nearest one remain alternatives, so a
/// point between a divided road's carriageways can use either direction.
const ALTERNATIVE_TOLERANCE_M: f64 = 25.0;
/// Segments at the nearest distance, within numerical noise, are the same road.
const SAME_ROAD_TOLERANCE_M: f64 = 0.5;
const FIRST_SEARCH_RADIUS_M: f64 = 100.0;

/// The graph as the drive kernel stores it.
pub(crate) struct DriveGraph<'a> {
    pub lons: &'a [f64],
    pub lats: &'a [f64],
    pub edge_offsets: &'a [u32],
    pub edge_targets: &'a [u32],
    pub edge_distance_units: &'a [u32],
    /// Current travel times, traffic included. A closed edge carries
    /// `closed_time_units`: it still locates the road, but cannot be driven.
    pub edge_time_units: &'a [u32],
    pub closed_time_units: u32,
    pub distance_units_per_meter: f64,
    pub time_units_per_second: f64,
}

impl DriveGraph<'_> {
    fn edge_source(&self, edge: usize) -> usize {
        // The last node whose first out-edge is at or before `edge`.
        self.edge_offsets
            .partition_point(|&offset| offset as usize <= edge)
            - 1
    }
}

/// One way to enter (origin) or leave (destination) the road network.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RoadCandidate {
    /// The graph node where the road search starts (origin) or ends.
    pub node: u32,
    /// The directed edge the point projects onto, and the projection's
    /// position along it from the edge's source, in [0, 1].
    pub edge: u32,
    pub fraction: f64,
    pub road: [f64; 2],
    pub walk_meters: f64,
    pub walk_seconds: f64,
    /// The part of the edge between the projection and `node`.
    pub drive_meters: f64,
    pub drive_seconds: f64,
}

impl RoadCandidate {
    pub fn meters(&self) -> f64 {
        self.walk_meters + self.drive_meters
    }

    pub fn seconds(&self) -> f64 {
        self.walk_seconds + self.drive_seconds
    }
}

pub(crate) struct Attachment {
    /// Distance to the nearest drivable road, when one lies within the limit.
    pub nearest_meters: Option<f64>,
    /// Every candidate, one per directed edge considered.
    pub candidates: Vec<RoadCandidate>,
}

impl Attachment {
    /// The cheapest candidate for each graph node, the form route queries take.
    pub fn by_node(&self) -> Vec<RoadCandidate> {
        let mut best: Vec<RoadCandidate> = Vec::with_capacity(self.candidates.len());
        for candidate in &self.candidates {
            match best.iter_mut().find(|known| known.node == candidate.node) {
                Some(known) => {
                    if (candidate.seconds(), candidate.walk_meters)
                        < (known.seconds(), known.walk_meters)
                    {
                        *known = *candidate;
                    }
                }
                None => best.push(*candidate),
            }
        }
        best
    }
}

/// A uniform grid over road segments and the graph's weak components.
pub(crate) struct RoadIndex {
    min_lon: f64,
    min_lat: f64,
    columns: usize,
    rows: usize,
    cell_offsets: Vec<u32>,
    cell_edges: Vec<u32>,
    component: Vec<u32>,
    largest_component: u32,
}

impl RoadIndex {
    pub fn build(graph: &DriveGraph<'_>) -> Self {
        let node_count = graph.lons.len();
        let (mut min_lon, mut min_lat) = (f64::INFINITY, f64::INFINITY);
        let (mut max_lon, mut max_lat) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for node in 0..node_count {
            min_lon = min_lon.min(graph.lons[node]);
            max_lon = max_lon.max(graph.lons[node]);
            min_lat = min_lat.min(graph.lats[node]);
            max_lat = max_lat.max(graph.lats[node]);
        }
        if node_count == 0 {
            (min_lon, min_lat, max_lon, max_lat) = (0.0, 0.0, 0.0, 0.0);
        }
        let columns = ((max_lon - min_lon) / CELL_DEGREES).floor() as usize + 1;
        let rows = ((max_lat - min_lat) / CELL_DEGREES).floor() as usize + 1;
        let mut index = Self {
            min_lon,
            min_lat,
            columns,
            rows,
            cell_offsets: vec![0; columns * rows + 1],
            cell_edges: Vec::new(),
            component: Vec::new(),
            largest_component: 0,
        };
        // Two passes over every segment's cell range: count, then fill.
        let edge_cells = |visit: &mut dyn FnMut(usize, u32)| {
            for source in 0..node_count {
                let start = graph.edge_offsets[source] as usize;
                let end = graph.edge_offsets[source + 1] as usize;
                for edge in start..end {
                    let target = graph.edge_targets[edge] as usize;
                    let (column_start, row_start) = index.cell(
                        graph.lons[source].min(graph.lons[target]),
                        graph.lats[source].min(graph.lats[target]),
                    );
                    let (column_end, row_end) = index.cell(
                        graph.lons[source].max(graph.lons[target]),
                        graph.lats[source].max(graph.lats[target]),
                    );
                    for row in row_start..=row_end {
                        for column in column_start..=column_end {
                            visit(row * index.columns + column, edge as u32);
                        }
                    }
                }
            }
        };
        let mut counts = vec![0_u32; columns * rows + 1];
        edge_cells(&mut |cell, _| counts[cell + 1] += 1);
        for cell in 0..columns * rows {
            counts[cell + 1] += counts[cell];
        }
        let mut cursor = counts[..columns * rows].to_vec();
        let mut cell_edges = vec![0_u32; counts[columns * rows] as usize];
        edge_cells(&mut |cell, edge| {
            cell_edges[cursor[cell] as usize] = edge;
            cursor[cell] += 1;
        });
        index.cell_offsets = counts;
        index.cell_edges = cell_edges;
        (index.component, index.largest_component) = weak_components(graph);
        index
    }

    #[cfg_attr(feature = "node", allow(dead_code))]
    pub fn byte_length(&self) -> usize {
        (self.cell_offsets.capacity() + self.cell_edges.capacity() + self.component.capacity())
            * std::mem::size_of::<u32>()
    }

    fn cell(&self, lon: f64, lat: f64) -> (usize, usize) {
        let column = ((lon - self.min_lon) / CELL_DEGREES).floor();
        let row = ((lat - self.min_lat) / CELL_DEGREES).floor();
        (
            column.clamp(0.0, (self.columns - 1) as f64) as usize,
            row.clamp(0.0, (self.rows - 1) as f64) as usize,
        )
    }

    /// Every directed edge within `radius` meters of `point`, with its distance
    /// and the projection's position along the edge.
    fn segments_within(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        radius: f64,
    ) -> Vec<(f64, u32, f64, [f64; 2])> {
        let meters_per_lat = EARTH_RADIUS_M.to_radians();
        let meters_per_lon = meters_per_lat * point[1].to_radians().cos().max(1e-6);
        let (column_start, row_start) = self.cell(
            point[0] - radius / meters_per_lon,
            point[1] - radius / meters_per_lat,
        );
        let (column_end, row_end) = self.cell(
            point[0] + radius / meters_per_lon,
            point[1] + radius / meters_per_lat,
        );
        let mut found = Vec::new();
        for row in row_start..=row_end {
            for column in column_start..=column_end {
                let cell = row * self.columns + column;
                let start = self.cell_offsets[cell] as usize;
                let end = self.cell_offsets[cell + 1] as usize;
                for &edge in &self.cell_edges[start..end] {
                    let source = graph.edge_source(edge as usize);
                    let target = graph.edge_targets[edge as usize] as usize;
                    // Local planar coordinates around the point, in meters.
                    let project = |node: usize| {
                        [
                            (graph.lons[node] - point[0]) * meters_per_lon,
                            (graph.lats[node] - point[1]) * meters_per_lat,
                        ]
                    };
                    let (a, b) = (project(source), project(target));
                    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                    let length_squared = dx * dx + dy * dy;
                    let fraction = if length_squared > 0.0 {
                        (-(a[0] * dx + a[1] * dy) / length_squared).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let (x, y) = (a[0] + fraction * dx, a[1] + fraction * dy);
                    let distance = (x * x + y * y).sqrt();
                    if distance <= radius {
                        // The same point along the edge, exact at its ends,
                        // so a leg ending at a node meets the next one there.
                        let along = |from: f64, to: f64| {
                            if fraction >= 1.0 {
                                to
                            } else {
                                from + fraction * (to - from)
                            }
                        };
                        let road = [
                            along(graph.lons[source], graph.lons[target]),
                            along(graph.lats[source], graph.lats[target]),
                        ];
                        found.push((distance, edge, fraction, road));
                    }
                }
            }
        }
        // A segment spanning several cells is seen once per cell.
        found.sort_by(|a, b| a.1.cmp(&b.1));
        found.dedup_by_key(|entry| entry.1);
        found.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        found
    }

    /// The road candidates for one endpoint, or none when no drivable road
    /// lies within `maximum_walk_meters`.
    pub fn attach(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        maximum_walk_meters: f64,
        walking_speed_mps: f64,
        origin: bool,
        nearest_road_only: bool,
    ) -> Attachment {
        let mut radius = FIRST_SEARCH_RADIUS_M.min(maximum_walk_meters);
        let segments = loop {
            let segments = self.segments_within(graph, point, radius);
            let wanted = match segments.first() {
                Some(nearest) => (nearest.0 + ALTERNATIVE_TOLERANCE_M).min(maximum_walk_meters),
                None if radius >= maximum_walk_meters => break segments,
                None => (radius * 4.0).min(maximum_walk_meters),
            };
            if wanted <= radius {
                break segments;
            }
            radius = wanted;
        };
        let Some(nearest) = segments.first().map(|segment| segment.0) else {
            return Attachment {
                nearest_meters: None,
                candidates: Vec::new(),
            };
        };
        let tolerance = if nearest_road_only {
            SAME_ROAD_TOLERANCE_M
        } else {
            ALTERNATIVE_TOLERANCE_M
        };
        let mut chosen: Vec<_> = segments
            .iter()
            .copied()
            .take_while(|segment| segment.0 <= nearest + tolerance)
            .collect();
        // A nearest road cut off from the main network (a parking aisle, a
        // fragment at the extract boundary) cannot be the only way in or out.
        let connected = |edge: u32| {
            let source = graph.edge_source(edge as usize);
            self.component[source] == self.largest_component
        };
        if !nearest_road_only && !chosen.iter().any(|segment| connected(segment.1)) {
            let mut wider = self.segments_within(graph, point, maximum_walk_meters);
            wider.retain(|segment| connected(segment.1));
            if let Some(first) = wider.first().map(|segment| segment.0) {
                chosen.extend(
                    wider
                        .into_iter()
                        .take_while(|segment| segment.0 <= first + ALTERNATIVE_TOLERANCE_M),
                );
            }
        }
        // A closure keeps the point where it is; it only removes the ways in.
        let candidates = chosen
            .into_iter()
            .filter(|segment| graph.edge_time_units[segment.1 as usize] < graph.closed_time_units)
            .map(|(walk_meters, edge, fraction, road)| {
                let source = graph.edge_source(edge as usize) as u32;
                let target = graph.edge_targets[edge as usize];
                // An origin drives on to the edge's target; a destination is
                // reached from the edge's source.
                let (node, part) = if origin {
                    (target, 1.0 - fraction)
                } else {
                    (source, fraction)
                };
                RoadCandidate {
                    node,
                    edge,
                    fraction,
                    road,
                    walk_meters,
                    walk_seconds: walk_meters / walking_speed_mps,
                    drive_meters: part * f64::from(graph.edge_distance_units[edge as usize])
                        / graph.distance_units_per_meter,
                    drive_seconds: part * f64::from(graph.edge_time_units[edge as usize])
                        / graph.time_units_per_second,
                }
            })
            .collect();
        Attachment {
            nearest_meters: Some(nearest),
            candidates,
        }
    }
}

/// Weakly connected components; returns each node's component and the largest.
fn weak_components(graph: &DriveGraph<'_>) -> (Vec<u32>, u32) {
    let node_count = graph.lons.len();
    let mut parent: Vec<u32> = (0..node_count as u32).collect();
    fn root(parent: &mut [u32], mut node: u32) -> u32 {
        while parent[node as usize] != node {
            let grandparent = parent[parent[node as usize] as usize];
            parent[node as usize] = grandparent;
            node = grandparent;
        }
        node
    }
    for source in 0..node_count {
        for edge in graph.edge_offsets[source] as usize..graph.edge_offsets[source + 1] as usize {
            let (a, b) = (
                root(&mut parent, source as u32),
                root(&mut parent, graph.edge_targets[edge]),
            );
            if a != b {
                parent[a.max(b) as usize] = a.min(b);
            }
        }
    }
    let mut sizes = vec![0_u32; node_count];
    let mut component = vec![0_u32; node_count];
    for node in 0..node_count {
        component[node] = root(&mut parent, node as u32);
        sizes[component[node] as usize] += 1;
    }
    let largest = (0..node_count)
        .max_by_key(|&node| (sizes[node], std::cmp::Reverse(node)))
        .unwrap_or(0) as u32;
    (component, largest)
}

/// Driving straight along one shared edge, when both endpoints project onto
/// it in its direction. The node search cannot express this trip.
pub(crate) fn same_edge(
    origin: &RoadCandidate,
    destination: &RoadCandidate,
    graph: &DriveGraph<'_>,
) -> Option<(f64, f64)> {
    if origin.edge != destination.edge
        || destination.fraction < origin.fraction
        || graph.edge_time_units[origin.edge as usize] >= graph.closed_time_units
    {
        return None;
    }
    let part = destination.fraction - origin.fraction;
    let edge = origin.edge as usize;
    Some((
        origin.walk_seconds
            + destination.walk_seconds
            + part * f64::from(graph.edge_time_units[edge]) / graph.time_units_per_second,
        origin.walk_meters
            + destination.walk_meters
            + part * f64::from(graph.edge_distance_units[edge]) / graph.distance_units_per_meter,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A straight two-way road from (0, 0) to (0.01, 0), about 1.1 km, and a
    /// detached one-way stub far to the north.
    fn graph() -> (Vec<f64>, Vec<f64>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<u32>) {
        let lons = vec![0.0, 0.01, 0.0, 0.0001];
        let lats = vec![0.0, 0.0, 0.05, 0.05];
        // 0 -> 1, 1 -> 0, 2 -> 3
        let offsets = vec![0, 1, 2, 3, 3];
        let targets = vec![1, 0, 3];
        let distances = vec![111_200, 111_200, 1_112];
        let times = vec![8_000, 8_000, 100];
        (lons, lats, offsets, targets, distances, times)
    }

    fn view<'a>(
        parts: &'a (Vec<f64>, Vec<f64>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<u32>),
    ) -> DriveGraph<'a> {
        DriveGraph {
            lons: &parts.0,
            lats: &parts.1,
            edge_offsets: &parts.2,
            edge_targets: &parts.3,
            edge_distance_units: &parts.4,
            edge_time_units: &parts.5,
            closed_time_units: u32::MAX,
            distance_units_per_meter: 100.0,
            time_units_per_second: 100.0,
        }
    }

    #[test]
    fn projects_onto_the_segment_not_its_nodes() {
        let parts = graph();
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        // 200 m south of the road's midpoint: nodes are ~570 m away.
        let point = [0.005, -0.0018];
        let attachment = index.attach(&graph, point, 1_200.0, 4.8 / 3.6, true, false);
        let nearest = attachment.nearest_meters.unwrap();
        assert!((nearest - 200.0).abs() < 2.0, "{nearest}");
        // Both directions of the one road, each driving on from the midpoint.
        let nodes: Vec<_> = attachment.by_node().iter().map(|c| c.node).collect();
        assert_eq!(nodes.len(), 2);
        for candidate in attachment.by_node() {
            assert!((candidate.drive_meters - 556.0).abs() < 1.0);
            assert!((candidate.drive_seconds - 40.0).abs() < 0.1);
            assert!((candidate.walk_seconds - nearest / (4.8 / 3.6)).abs() < 1e-9);
        }
    }

    #[test]
    fn blocks_beyond_the_walking_limit_and_skips_detached_roads() {
        let parts = graph();
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        let far = index.attach(&graph, [0.005, -0.02], 1_200.0, 4.8 / 3.6, true, false);
        assert!(far.nearest_meters.is_none() && far.candidates.is_empty());
        // Next to the detached stub, the main road is also offered.
        let stub = index.attach(&graph, [0.00005, 0.0499], 6_000.0, 4.8 / 3.6, true, false);
        assert!(stub.candidates.iter().any(|c| c.edge == 2));
        assert!(stub.candidates.iter().any(|c| c.edge != 2));
    }

    #[test]
    fn same_edge_trips_follow_the_edge_direction() {
        let parts = graph();
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        let speed = 4.8 / 3.6;
        let origin = index.attach(&graph, [0.002, 0.0001], 1_200.0, speed, true, true);
        let destination = index.attach(&graph, [0.008, 0.0001], 1_200.0, speed, false, true);
        let forward = |a: &Attachment, edge| *a.candidates.iter().find(|c| c.edge == edge).unwrap();
        let (seconds, meters) =
            same_edge(&forward(&origin, 0), &forward(&destination, 0), &graph).unwrap();
        assert!(
            (meters - (0.6 * 1_112.0 + 2.0 * 11.12)).abs() < 1.0,
            "{meters}"
        );
        assert!(
            (seconds - (0.6 * 80.0 + 2.0 * 11.12 / speed)).abs() < 0.1,
            "{seconds}"
        );
        // Against the edge's direction there is no direct trip on edge 0.
        assert!(same_edge(&forward(&destination, 0), &forward(&origin, 0), &graph).is_none());
    }
}
