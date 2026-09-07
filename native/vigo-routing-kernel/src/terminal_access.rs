//! Mapped restricted streets used only at a journey's endpoints.
//!
//! Public transit-access components form the boundary. A terminal search may
//! traverse its interior public islands and authorized private streets, but
//! stops on first reaching that boundary. All subsequent routing uses the
//! unchanged public graph, so these streets cannot become through shortcuts.
use super::*;
use std::cmp::Reverse;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAccessFile {
    schema_version: String,
    public_node_count: usize,
    public_edge_count: usize,
    node_lons: Vec<f64>,
    node_lats: Vec<f64>,
    public_nodes: Vec<u32>,
    edge_sources: Vec<u32>,
    edge_targets: Vec<u32>,
    edge_distances_m: Vec<f64>,
    boundary_components: Vec<u32>,
}

pub(crate) struct TerminalAccessGraph {
    lons: Vec<f64>,
    lats: Vec<f64>,
    public_nodes: Vec<u32>,
    public_to_local: Vec<u32>,
    forward: Vec<Vec<(u32, f64)>>,
    reverse: Vec<Vec<(u32, f64)>>,
    boundary: Vec<bool>,
    cells: HashMap<(i32, i32), Vec<u32>>,
    public_count: u32,
}

#[derive(Clone)]
pub(crate) struct TerminalAttachment {
    pub(crate) boundary_snaps: Vec<Snap>,
    pub(crate) original_snaps: Vec<Snap>,
    distances: HashMap<u32, f64>,
    predecessors: HashMap<u32, u32>,
}

impl TerminalAttachment {
    pub(crate) fn byte_length(&self) -> usize {
        self.boundary_snaps.capacity() * size_of::<Snap>()
            + self.original_snaps.capacity() * size_of::<Snap>()
            + self.distances.capacity() * size_of::<(u32, f64)>()
            + self.predecessors.capacity() * size_of::<(u32, u32)>()
    }

    pub(crate) fn path_to(&self, mut node: u32) -> Vec<u32> {
        let mut path = vec![node];
        while let Some(&previous) = self.predecessors.get(&node) {
            if previous == node {
                break;
            }
            path.push(previous);
            node = previous;
        }
        path.reverse();
        path
    }

    pub(crate) fn direct_to(&self, destination: &Self) -> Option<(f64, u32)> {
        destination
            .original_snaps
            .iter()
            .filter_map(|snap| {
                self.distances
                    .get(&snap.node)
                    .map(|distance| (distance + snap.distance_m, snap.node))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)))
    }

    pub(crate) fn extend_path(&self, mut path: Vec<u32>, reverse: bool) -> Vec<u32> {
        let Some(&boundary) = (if reverse { path.last() } else { path.first() }) else {
            return path;
        };
        let mut prefix = self.path_to(boundary);
        if reverse {
            prefix.reverse();
            path.extend(prefix.into_iter().skip(1));
            path
        } else {
            prefix.extend(path.into_iter().skip(1));
            prefix
        }
    }
}

impl TerminalAccessGraph {
    pub(crate) fn open(snapshot: &Snapshot, path: &Path) -> napi::Result<Self> {
        let file: TerminalAccessFile =
            serde_json::from_reader(std::io::BufReader::new(File::open(path).map_err(|e| {
                Error::from_reason(format!("Cannot open terminal access graph: {e}"))
            })?))
            .map_err(|e| Error::from_reason(format!("Invalid terminal access graph: {e}")))?;
        let count = file.node_lons.len();
        let public_count = snapshot.header.node_count;
        let components = snapshot.f64_array("componentLengthKm")?.len();
        if file.schema_version != "vigo.street.terminal-access.v1"
            || file.public_node_count != public_count
            || file.public_edge_count != snapshot.header.edge_count
            || count > (u32::MAX as usize).saturating_sub(public_count)
            || file.node_lats.len() != count
            || file.public_nodes.len() != count
            || file.edge_sources.len() != file.edge_targets.len()
            || file.edge_sources.len() != file.edge_distances_m.len()
            || file.boundary_components.is_empty()
            || file
                .boundary_components
                .iter()
                .any(|&c| c as usize >= components)
        {
            return Err(Error::from_reason(
                "Terminal access graph dimensions or public graph identity differ.",
            ));
        }
        let source_lons = snapshot.f64_array("nodeLons")?;
        let source_lats = snapshot.f64_array("nodeLats")?;
        let mut public_to_local = vec![u32::MAX; public_count];
        let mut cells: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for i in 0..count {
            let lon = file.node_lons[i];
            let lat = file.node_lats[i];
            let public = file.public_nodes[i];
            if !lon.is_finite()
                || !lat.is_finite()
                || !(-180.0..=180.0).contains(&lon)
                || !(-90.0..=90.0).contains(&lat)
                || (public != u32::MAX
                    && (public as usize >= public_count
                        || (source_lons[public as usize] - lon).abs() > 1e-10
                        || (source_lats[public as usize] - lat).abs() > 1e-10
                        || public_to_local[public as usize] != u32::MAX))
            {
                return Err(Error::from_reason(
                    "Terminal access node is invalid or does not match its public node.",
                ));
            }
            if public != u32::MAX {
                public_to_local[public as usize] = i as u32;
            }
            cells
                .entry(access_cell(lat, lon))
                .or_default()
                .push(i as u32);
        }
        let mut forward = vec![Vec::new(); count];
        let mut reverse = vec![Vec::new(); count];
        for ((&from, &to), &distance) in file
            .edge_sources
            .iter()
            .zip(&file.edge_targets)
            .zip(&file.edge_distances_m)
        {
            if from as usize >= count
                || to as usize >= count
                || !distance.is_finite()
                || distance <= 0.0
            {
                return Err(Error::from_reason("Terminal access edge is invalid."));
            }
            forward[from as usize].push((to, distance));
            reverse[to as usize].push((from, distance));
        }
        let mut boundary = vec![false; components];
        for component in file.boundary_components {
            boundary[component as usize] = true;
        }
        Ok(Self {
            lons: file.node_lons,
            lats: file.node_lats,
            public_nodes: file.public_nodes,
            public_to_local,
            forward,
            reverse,
            boundary,
            cells,
            public_count: public_count as u32,
        })
    }

    fn global_node(&self, local: u32) -> u32 {
        let public = self.public_nodes[local as usize];
        if public == u32::MAX {
            self.public_count + local
        } else {
            public
        }
    }

    fn local_node(&self, global: u32) -> Option<u32> {
        if global >= self.public_count {
            Some(global - self.public_count)
        } else {
            let local = self.public_to_local[global as usize];
            (local != u32::MAX).then_some(local)
        }
    }

    pub(crate) fn coordinate(&self, snapshot: &Snapshot, node: u32) -> napi::Result<[f64; 2]> {
        if node < self.public_count {
            Ok([
                snapshot.f64_array("nodeLons")?[node as usize],
                snapshot.f64_array("nodeLats")?[node as usize],
            ])
        } else {
            let n = (node - self.public_count) as usize;
            Ok([self.lons[n], self.lats[n]])
        }
    }

    pub(crate) fn flatten(
        &self,
        snapshot: &Snapshot,
        nodes: &[u32],
        maximum_points: usize,
    ) -> napi::Result<Vec<f64>> {
        let stride = nodes.len().div_ceil(maximum_points.max(2)).max(1);
        let mut result = Vec::new();
        for (i, &node) in nodes.iter().enumerate() {
            if i == 0 || i + 1 == nodes.len() || i % stride == 0 {
                result.extend(self.coordinate(snapshot, node)?);
            }
        }
        Ok(result)
    }

    fn snaps(
        &self,
        snapshot: &Snapshot,
        public: &[Snap],
        lon: f64,
        lat: f64,
    ) -> napi::Result<Vec<Snap>> {
        let mut selected = public.to_vec();
        let mut best = public
            .iter()
            .map(|s| s.distance_m)
            .min_by(f64::total_cmp)
            .unwrap_or(f64::INFINITY);
        // A projected public attachment's cost includes travel to both edge
        // endpoints. Compare the perpendicular attachment, not that travel.
        if public.len() == 2 {
            let a = self.coordinate(snapshot, public[0].node)?;
            let b = self.coordinate(snapshot, public[1].node)?;
            if let Some((distance, _)) = projection([lon, lat], a, b) {
                best = best.min(distance);
            }
        }
        let delta_lat = RECOVERY_SNAP_RADIUS_M / 1000.0 / 110.574;
        let delta_lon =
            RECOVERY_SNAP_RADIUS_M / 1000.0 / (111.32 * lat.to_radians().cos().abs()).max(1.0);
        let min = access_cell(lat - delta_lat, lon - delta_lon);
        let max = access_cell(lat + delta_lat, lon + delta_lon);
        let mut nearby = HashSet::new();
        for y in min.0..=max.0 {
            for x in min.1..=max.1 {
                if let Some(nodes) = self.cells.get(&(y, x)) {
                    for &local in nodes {
                        let distance = haversine_m(
                            lon,
                            lat,
                            self.lons[local as usize],
                            self.lats[local as usize],
                        );
                        if distance <= RECOVERY_SNAP_RADIUS_M {
                            nearby.insert(local);
                            if distance < best {
                                best = distance;
                                selected = vec![Snap {
                                    node: self.global_node(local),
                                    distance_m: distance,
                                }];
                            }
                        }
                    }
                }
            }
        }
        let mut ordered: Vec<_> = nearby.iter().copied().collect();
        ordered.sort_unstable();
        for from in ordered {
            for &(to, length) in &self.forward[from as usize] {
                if from >= to
                    || !nearby.contains(&to)
                    || !self.reverse[from as usize].iter().any(|&(n, _)| n == to)
                {
                    continue;
                }
                if let Some((distance, t)) = projection(
                    [lon, lat],
                    [self.lons[from as usize], self.lats[from as usize]],
                    [self.lons[to as usize], self.lats[to as usize]],
                ) && distance <= SNAP_RADIUS_M
                    && distance < best
                {
                    best = distance;
                    selected = vec![
                        Snap {
                            node: self.global_node(from),
                            distance_m: distance + t * length,
                        },
                        Snap {
                            node: self.global_node(to),
                            distance_m: distance + (1.0 - t) * length,
                        },
                    ];
                }
            }
        }
        Ok(selected)
    }

    pub(crate) fn attach(
        &self,
        snapshot: &Snapshot,
        public: &[Snap],
        lon: f64,
        lat: f64,
        maximum: f64,
        reverse: bool,
    ) -> napi::Result<Option<Arc<TerminalAttachment>>> {
        let snaps = self.snaps(snapshot, public, lon, lat)?;
        let components = snapshot.i32_array("componentByNode")?;
        let is_boundary = |node: u32| {
            node < self.public_count && self.boundary[components[node as usize] as usize]
        };
        if snaps.len() == public.len()
            && snaps.iter().zip(public).all(|(a, b)| {
                a.node == b.node && a.distance_m == b.distance_m && is_boundary(a.node)
            })
        {
            return Ok(None);
        }
        let offsets = snapshot.u32_array(if reverse {
            "reverseOffsets"
        } else {
            "edgeOffsets"
        })?;
        let targets = snapshot.u32_array(if reverse {
            "reverseSources"
        } else {
            "edgeTargets"
        })?;
        let edge_indices = snapshot.u32_array("reverseEdgeIndices")?;
        let edge_distances = snapshot.f64_array("edgeDistances")?;
        let mut distances = HashMap::new();
        let mut predecessors = HashMap::new();
        let mut queue = BinaryHeap::new();
        let mut boundary_snaps = Vec::new();
        for s in &snaps {
            if s.distance_m <= maximum && distances.get(&s.node).is_none_or(|&d| s.distance_m < d) {
                distances.insert(s.node, s.distance_m);
                predecessors.insert(s.node, s.node);
                queue.push(Reverse((s.distance_m.to_bits(), s.node)));
            }
        }
        while let Some(Reverse((bits, node))) = queue.pop() {
            let distance = f64::from_bits(bits);
            if distances.get(&node) != Some(&distance) {
                continue;
            }
            if is_boundary(node) {
                boundary_snaps.push(Snap {
                    node,
                    distance_m: distance,
                });
                continue;
            }
            let mut offer = |target, weight| {
                let candidate = distance + weight;
                if candidate <= maximum && distances.get(&target).is_none_or(|&d| candidate < d) {
                    distances.insert(target, candidate);
                    predecessors.insert(target, node);
                    queue.push(Reverse((candidate.to_bits(), target)));
                }
            };
            if node < self.public_count {
                for edge in offsets[node as usize] as usize..offsets[node as usize + 1] as usize {
                    let index = if reverse {
                        edge_indices[edge] as usize
                    } else {
                        edge
                    };
                    offer(targets[edge], edge_distances[index]);
                }
            }
            if let Some(local) = self.local_node(node) {
                for &(target, weight) in &(if reverse {
                    &self.reverse
                } else {
                    &self.forward
                })[local as usize]
                {
                    offer(self.global_node(target), weight);
                }
            }
        }
        boundary_snaps.sort_by_key(|s| s.node);
        Ok(Some(Arc::new(TerminalAttachment {
            boundary_snaps,
            original_snaps: snaps,
            distances,
            predecessors,
        })))
    }
}

fn projection(point: [f64; 2], from: [f64; 2], to: [f64; 2]) -> Option<(f64, f64)> {
    let scale = 111.32 * point[1].to_radians().cos();
    let x = (from[0] - point[0]) * scale;
    let y = (from[1] - point[1]) * 110.574;
    let dx = (to[0] - from[0]) * scale;
    let dy = (to[1] - from[1]) * 110.574;
    let length = dx * dx + dy * dy;
    if length == 0.0 {
        return None;
    }
    let t = -(x * dx + y * dy) / length;
    (0.0..=1.0)
        .contains(&t)
        .then_some(((x + t * dx).hypot(y + t * dy) * 1000.0, t))
}
