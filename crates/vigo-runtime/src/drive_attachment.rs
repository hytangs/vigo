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
pub(crate) const ALTERNATIVE_TOLERANCE_M: f64 = 25.0;
/// Segments at the nearest distance, within numerical noise, are the same road.
const SAME_ROAD_TOLERANCE_M: f64 = 0.5;
const FIRST_SEARCH_RADIUS_M: f64 = 100.0;
type Projection = (f64, u32, f64, [f64; 2]);

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
    pub walk_network: bool,
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
    fn projected(graph: &DriveGraph<'_>, p: Projection, speed: f64, origin: bool) -> Self {
        let (walk_meters, edge, fraction, road) = p;
        let source = graph.edge_source(edge as usize) as u32;
        let target = graph.edge_targets[edge as usize];
        let (node, part) = if origin {
            (target, 1. - fraction)
        } else {
            (source, fraction)
        };
        Self {
            walk_network: false,
            node,
            edge,
            fraction,
            road,
            walk_meters,
            walk_seconds: walk_meters / speed,
            drive_meters: part * f64::from(graph.edge_distance_units[edge as usize])
                / graph.distance_units_per_meter,
            drive_seconds: part * f64::from(graph.edge_time_units[edge as usize])
                / graph.time_units_per_second,
        }
    }
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

/// Bicycle endpoints keep only the data which cannot be recovered from the
/// shared graph. No rounded coordinates, costs, or physical distances.
#[derive(Clone, Copy)]
pub(crate) struct BikeCandidate {
    pub node: u32,
    pub edge: u32,
    // 0..1 is a direct projection. Exact values 2/3 denote a network walk
    // to the source/target vertex. This keeps the bounded record at 24 bytes;
    // arbitrary projection fractions are never quantized or modified.
    pub fraction: f64,
    pub walk_meters: f64,
}

#[derive(Clone)]
pub(crate) struct BikeAttachment {
    pub nearest_meters: Option<f64>,
    pub candidates: Vec<BikeCandidate>,
    speed: f64,
    origin: bool,
}

impl BikeAttachment {
    pub(crate) fn from_candidates(
        candidates: Vec<BikeCandidate>,
        speed: f64,
        origin: bool,
    ) -> Self {
        Self {
            nearest_meters: candidates
                .iter()
                .map(|c| c.walk_meters)
                .min_by(f64::total_cmp),
            candidates,
            speed,
            origin,
        }
    }

    pub fn candidate(&self, graph: &DriveGraph<'_>, index: usize) -> RoadCandidate {
        let c = self.candidates[index];
        let walk_network = c.fraction >= 2.;
        let fraction = if walk_network {
            c.fraction - 2.
        } else {
            c.fraction
        };
        let source = if self.origin {
            graph.edge_source(c.edge as usize)
        } else {
            c.node as usize
        };
        let target = if self.origin {
            c.node as usize
        } else {
            graph.edge_targets[c.edge as usize] as usize
        };
        let along = |from: f64, to: f64| {
            if fraction >= 1. {
                to
            } else {
                from + fraction * (to - from)
            }
        };
        let part = if self.origin { 1. - fraction } else { fraction };
        RoadCandidate {
            walk_network,
            node: c.node,
            edge: c.edge,
            fraction,
            road: [
                along(graph.lons[source], graph.lons[target]),
                along(graph.lats[source], graph.lats[target]),
            ],
            walk_meters: c.walk_meters,
            walk_seconds: c.walk_meters / self.speed,
            drive_meters: part * f64::from(graph.edge_distance_units[c.edge as usize])
                / graph.distance_units_per_meter,
            drive_seconds: part * f64::from(graph.edge_time_units[c.edge as usize])
                / graph.time_units_per_second,
        }
    }
}

/// A uniform grid over road segments and the graph's weak components.
pub(crate) struct RoadIndex {
    min_lon: f64,
    min_lat: f64,
    columns: usize,
    rows: usize,
    cell_degrees: f64,
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
        // Bound the dense directory for large or sparse extracts. Coarser
        // cells change candidate work, never geometric attachment semantics.
        let cell_degrees =
            CELL_DEGREES.max(((max_lon - min_lon) * (max_lat - min_lat) / 250_000.).sqrt());
        let columns = ((max_lon - min_lon) / cell_degrees).floor() as usize + 1;
        let rows = ((max_lat - min_lat) / cell_degrees).floor() as usize + 1;
        let mut index = Self {
            min_lon,
            min_lat,
            columns,
            rows,
            cell_degrees,
            cell_offsets: Vec::new(),
            cell_edges: Vec::new(),
            component: Vec::new(),
            largest_component: 0,
        };
        // A long diagonal otherwise occupies its entire bounding rectangle,
        // potentially multiplying a handful of edges into millions of entries.
        // Coarsen this same index until references are linear in edge count.
        // Projection and candidate filtering remain exact; no edges are lost.
        let reference_limit = graph
            .edge_targets
            .len()
            .saturating_mul(8)
            .min(u32::MAX as usize);
        loop {
            let mut references = 0usize;
            'count: for source in 0..node_count {
                for edge in
                    graph.edge_offsets[source] as usize..graph.edge_offsets[source + 1] as usize
                {
                    let target = graph.edge_targets[edge] as usize;
                    let [(left, top), (right, bottom)] = index.segment_cells(graph, source, target);
                    references = references
                        .saturating_add((right - left + 1).saturating_mul(bottom - top + 1));
                    if references > reference_limit {
                        break 'count;
                    }
                }
            }
            if references <= reference_limit {
                break;
            }
            index.cell_degrees *= 2.;
            index.columns = ((max_lon - min_lon) / index.cell_degrees).floor() as usize + 1;
            index.rows = ((max_lat - min_lat) / index.cell_degrees).floor() as usize + 1;
        }
        let (columns, rows) = (index.columns, index.rows);
        // Two passes over every segment's cell range: count, then fill.
        let edge_cells = |visit: &mut dyn FnMut(usize, u32)| {
            for source in 0..node_count {
                let start = graph.edge_offsets[source] as usize;
                let end = graph.edge_offsets[source + 1] as usize;
                for edge in start..end {
                    let target = graph.edge_targets[edge] as usize;
                    let [(column_start, row_start), (column_end, row_end)] =
                        index.segment_cells(graph, source, target);
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

    pub(crate) fn connected_nodes(&self, a: u32, b: u32) -> bool {
        self.component[a as usize] == self.component[b as usize]
    }

    fn segment_cells(
        &self,
        graph: &DriveGraph<'_>,
        source: usize,
        target: usize,
    ) -> [(usize, usize); 2] {
        [
            self.cell(
                graph.lons[source].min(graph.lons[target]),
                graph.lats[source].min(graph.lats[target]),
            ),
            self.cell(
                graph.lons[source].max(graph.lons[target]),
                graph.lats[source].max(graph.lats[target]),
            ),
        ]
    }

    fn cell(&self, lon: f64, lat: f64) -> (usize, usize) {
        let column = ((lon - self.min_lon) / self.cell_degrees).floor();
        let row = ((lat - self.min_lat) / self.cell_degrees).floor();
        (
            column.clamp(0.0, (self.columns - 1) as f64) as usize,
            row.clamp(0.0, (self.rows - 1) as f64) as usize,
        )
    }

    /// Every directed edge within `radius` meters of `point`, with its distance
    /// and the projection's position along the edge.
    #[cfg(test)]
    fn segments_within(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        radius: f64,
    ) -> Vec<Projection> {
        self.segments_bounded(graph, point, radius, None).unwrap()
    }

    #[cfg(test)]
    fn segments_bounded(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        radius: f64,
        maximum: Option<usize>,
    ) -> Option<Vec<Projection>> {
        self.segments_matching(graph, point, radius, maximum, &|_| true)
    }

    fn segments_matching(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        radius: f64,
        maximum: Option<usize>,
        eligible: &impl Fn(u32) -> bool,
    ) -> Option<Vec<Projection>> {
        let mut found = Vec::new();
        let complete = self.visit_segments(graph, point, radius, eligible, &mut |projection| {
            if maximum.is_some_and(|limit| found.len() >= limit) {
                return false;
            }
            found.push(projection);
            true
        });
        if !complete {
            return None;
        }
        found.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        Some(found)
    }

    pub(crate) fn visit_segments(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        radius: f64,
        eligible: &impl Fn(u32) -> bool,
        visit: &mut impl FnMut(Projection) -> bool,
    ) -> bool {
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
        for row in row_start..=row_end {
            for column in column_start..=column_end {
                let cell = row * self.columns + column;
                let start = self.cell_offsets[cell] as usize;
                let end = self.cell_offsets[cell + 1] as usize;
                for &edge in &self.cell_edges[start..end] {
                    if !eligible(edge) {
                        continue;
                    }
                    let source = graph.edge_source(edge as usize);
                    let target = graph.edge_targets[edge as usize] as usize;
                    // Every edge occupies a rectangular range of index cells.
                    // Visit only the first cell shared with this query, avoiding
                    // duplicate projections and a query-sized deduplication set.
                    // Every entry in the query's first cell is already its
                    // first occurrence. Small endpoint searches often use only
                    // that cell, so avoid recomputing the edge's cell bounds.
                    if column != column_start || row != row_start {
                        let (first_column, first_row) = self.cell(
                            graph.lons[source].min(graph.lons[target]),
                            graph.lats[source].min(graph.lats[target]),
                        );
                        if column != first_column.max(column_start)
                            || row != first_row.max(row_start)
                        {
                            continue;
                        }
                    }
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
                    // OSM integer coordinates and decimal query coordinates can
                    // differ by a few floating-point ulps. Normalize sub-micron
                    // projection noise so a zero walking limit still permits
                    // an endpoint exactly on its road.
                    let distance = if distance <= 1e-6 { 0. } else { distance };
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
                        if !visit((distance, edge, fraction, road)) {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn attach_bicycle_matching(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        maximum_walk_meters: f64,
        speed: f64,
        origin: bool,
        nearest_road_only: bool,
        eligible: &impl Fn(u32) -> bool,
    ) -> BikeAttachment {
        let attached = self.attach_matching(
            graph,
            point,
            maximum_walk_meters,
            speed,
            origin,
            nearest_road_only,
            eligible,
        );
        BikeAttachment {
            nearest_meters: attached.nearest_meters,
            speed,
            origin,
            candidates: attached
                .candidates
                .into_iter()
                .map(|c| BikeCandidate {
                    node: c.node,
                    edge: c.edge,
                    fraction: c.fraction,
                    walk_meters: c.walk_meters,
                })
                .collect(),
        }
    }

    /// Failed bicycle searches can consider the entire permitted connector
    /// radius. Bound query-local storage; never report an incomplete scan as
    /// a valid no-path answer. Ordinary driving keeps its existing matching.
    pub(crate) fn attach_bicycle_fallback(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        maximum_walk_meters: f64,
        speed: f64,
        origin: bool,
        eligible: &impl Fn(u32) -> bool,
    ) -> Result<BikeAttachment, String> {
        const BUDGET: usize = 512 * 1024;
        let maximum = BUDGET / std::mem::size_of::<BikeCandidate>();
        let mut candidates = Vec::new();
        let complete = self.visit_segments(graph, point, maximum_walk_meters, eligible, &mut |p| {
            if graph.edge_time_units[p.1 as usize] >= graph.closed_time_units {
                return true;
            }
            if candidates.len() >= maximum {
                return false;
            }
            if candidates.len() == candidates.capacity() {
                let capacity = (candidates.capacity().max(16) * 2).min(maximum);
                candidates.reserve_exact(capacity - candidates.len());
            }
            candidates.push(BikeCandidate {
                node: if origin {
                    graph.edge_targets[p.1 as usize]
                } else {
                    graph.edge_source(p.1 as usize) as u32
                },
                edge: p.1,
                fraction: p.2,
                walk_meters: p.0,
            });
            true
        });
        if !complete {
            return Err(
                "Bicycle endpoint matching exceeded its 512 KiB candidate budget; reduce maxWalkKm"
                    .into(),
            );
        }
        candidates.sort_unstable_by(|a, b| {
            a.walk_meters
                .total_cmp(&b.walk_meters)
                .then(a.edge.cmp(&b.edge))
        });
        Ok(BikeAttachment {
            nearest_meters: candidates.first().map(|c| c.walk_meters),
            candidates,
            speed,
            origin,
        })
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
        self.attach_matching(
            graph,
            point,
            maximum_walk_meters,
            walking_speed_mps,
            origin,
            nearest_road_only,
            &|_| true,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn attach_matching(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        maximum_walk_meters: f64,
        walking_speed_mps: f64,
        origin: bool,
        nearest_road_only: bool,
        eligible: &impl Fn(u32) -> bool,
    ) -> Attachment {
        let mut radius = FIRST_SEARCH_RADIUS_M.min(maximum_walk_meters);
        let segments = loop {
            let segments = self
                .segments_matching(graph, point, radius, None, eligible)
                .unwrap();
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
            let mut wider = self
                .segments_matching(graph, point, maximum_walk_meters, None, eligible)
                .unwrap();
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
            .map(|p| RoadCandidate::projected(graph, p, walking_speed_mps, origin))
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
    type GraphParts = (Vec<f64>, Vec<f64>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<u32>);

    fn graph() -> GraphParts {
        let lons = vec![0.0, 0.01, 0.0, 0.0001];
        let lats = vec![0.0, 0.0, 0.05, 0.05];
        // 0 -> 1, 1 -> 0, 2 -> 3
        let offsets = vec![0, 1, 2, 3, 3];
        let targets = vec![1, 0, 3];
        let distances = vec![111_200, 111_200, 1_112];
        let times = vec![8_000, 8_000, 100];
        (lons, lats, offsets, targets, distances, times)
    }

    fn view<'a>(parts: &'a GraphParts) -> DriveGraph<'a> {
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
    fn bounded_candidates_count_unique_edges_and_never_silently_truncate() {
        let parts = graph();
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        // Each long edge occurs in several index cells, but counts only once.
        let point = [0.005, 0.];
        let two = index
            .segments_bounded(&graph, point, 1000., Some(2))
            .unwrap();
        assert_eq!(two.len(), 2);
        assert_eq!(two, index.segments_within(&graph, point, 1000.));
        assert!(
            index
                .segments_bounded(&graph, point, 1000., Some(1))
                .is_none()
        );
    }

    #[test]
    fn compact_bicycle_candidates_preserve_exact_projection_values() {
        let parts = graph();
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        for point in [[0., 0.], [0.01, 0.], [0.005, -0.0018], [0.00005, 0.0499]] {
            for origin in [true, false] {
                let expected = index.segments_within(&graph, point, 1200.);
                let compact = index
                    .attach_bicycle_fallback(&graph, point, 1200., 4.8 / 3.6, origin, &|_| true)
                    .unwrap();
                assert_eq!(compact.candidates.len(), expected.len());
                for (i, projection) in expected.into_iter().enumerate() {
                    let a = compact.candidate(&graph, i);
                    let b = RoadCandidate::projected(&graph, projection, 4.8 / 3.6, origin);
                    assert_eq!(
                        (
                            a.node,
                            a.edge,
                            a.fraction,
                            a.road,
                            a.walk_meters,
                            a.walk_seconds,
                            a.drive_meters,
                            a.drive_seconds
                        ),
                        (
                            b.node,
                            b.edge,
                            b.fraction,
                            b.road,
                            b.walk_meters,
                            b.walk_seconds,
                            b.drive_meters,
                            b.drive_seconds
                        )
                    );
                }
            }
        }
        assert_eq!(std::mem::size_of::<BikeCandidate>(), 24);
    }

    #[test]
    fn dense_bicycle_endpoints_fit_a_fixed_byte_budget_without_truncation() {
        for count in [20_000, 22_000] {
            let mut parts = (
                vec![0.001; count + 1],
                vec![0.; count + 1],
                vec![count as u32; count + 2],
                (1..=count as u32).collect(),
                vec![11_120; count],
                vec![800; count],
            );
            parts.0[0] = 0.;
            parts.2[0] = 0;
            let graph = view(&parts);
            let index = RoadIndex::build(&graph);
            for origin in [true, false] {
                let result = index.attach_bicycle_fallback(
                    &graph,
                    [0.0005, 0.0001],
                    1200.,
                    4.8 / 3.6,
                    origin,
                    &|_| true,
                );
                if count == 20_000 {
                    let result = result.unwrap();
                    assert_eq!(result.candidates.len(), count);
                    assert!(
                        result.candidates.capacity() * std::mem::size_of::<BikeCandidate>()
                            <= 512 * 1024
                    );
                    for (i, c) in result.candidates.iter().enumerate() {
                        assert_eq!(c.edge, i as u32);
                        assert_eq!(c.node, if origin { i as u32 + 1 } else { 0 });
                        assert!((c.fraction - 0.5).abs() < 1e-15);
                    }
                } else {
                    assert!(result.err().unwrap().contains("512 KiB"));
                }
            }
        }
    }

    #[test]
    fn long_diagonals_bound_index_references_without_losing_projections() {
        let parts = (
            vec![0., 2., 0., 2.],
            vec![0., 2., 2., 0.],
            vec![0, 2, 3, 4, 5],
            vec![1, 2, 0, 3, 2],
            vec![32_000_000; 5],
            vec![1000; 5],
        );
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        assert!(
            index.cell_edges.len() <= 8 * graph.edge_targets.len(),
            "{} references for {} edges",
            index.cell_edges.len(),
            graph.edge_targets.len()
        );
        println!(
            "Long-edge index: {} references, {} retained bytes",
            index.cell_edges.len(),
            index.byte_length()
        );
        let mut all = RoadIndex::build(&graph);
        all.columns = 1;
        all.rows = 1;
        all.cell_offsets = vec![0, graph.edge_targets.len() as u32];
        all.cell_edges = (0..graph.edge_targets.len() as u32).collect();
        for x in -1..=9 {
            for y in -1..=9 {
                for radius in [0., 40., 4000., 40000.] {
                    let point = [x as f64 * 0.25, y as f64 * 0.25];
                    assert_eq!(
                        index.segments_within(&graph, point, radius),
                        all.segments_within(&graph, point, radius)
                    );
                }
            }
        }
    }

    #[test]
    fn cell_clipping_matches_a_single_cell_full_edge_scan() {
        let parts = (
            vec![0., 0.02, 0., 0.02],
            vec![0., 0.02, 0.02, 0.],
            vec![0, 2, 3, 4, 5],
            vec![1, 2, 0, 3, 2],
            vec![100_000; 5],
            vec![1000; 5],
        );
        let graph = view(&parts);
        let index = RoadIndex::build(&graph);
        let mut all = RoadIndex::build(&graph);
        all.columns = 1;
        all.rows = 1;
        all.cell_offsets = vec![0, graph.edge_targets.len() as u32];
        all.cell_edges = (0..graph.edge_targets.len() as u32).collect();
        for x in -1..=5 {
            for y in -1..=5 {
                for radius in [0., 40., 400., 2000.] {
                    let point = [x as f64 * 0.005, y as f64 * 0.005];
                    assert_eq!(
                        index.segments_within(&graph, point, radius),
                        all.segments_within(&graph, point, radius)
                    );
                }
            }
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
