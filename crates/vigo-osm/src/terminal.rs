//! Authorized private endpoint access (terminal-access-store.mjs).

use crate::accelerator::{self, HEADER_BYTES};
use crate::jsrt::{self, norm_opt};
use crate::pbf::{self, Block, DenseNodes, Handler, Node, Way};
use crate::rules::{self, Directions};
use crate::store::{IdSet, elapsed_ms};
use crate::tags::Tags;
use crate::{Error, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use vigo_format::js::Js;
use vigo_format::js_math;

const GATES: [&str; 5] = [
    "gate",
    "lift_gate",
    "swing_gate",
    "sliding_gate",
    "wicket_gate",
];

/// `authorizedTags(tags)`: private foot or access becomes yes.
fn authorized_tags<'a>(tags: &Tags<'a>) -> Tags<'a> {
    let mut permitted = Tags::default();
    for (key, value) in tags.iter() {
        let private = ["access", "foot", "foot:forward", "foot:backward"].contains(&key)
            && jsrt::norm(value) == "private";
        permitted.set(key, if private { "yes" } else { value });
    }
    permitted
}

fn authorized_private_way(tags: &Tags) -> bool {
    let access = norm_opt(tags.get("access"));
    let foot = norm_opt(tags.get("foot"));
    if access != "private" && foot != "private" {
        return false;
    }
    if foot == "no" || (access == "no" && foot != "private") {
        return false;
    }
    rules::way_walkable(&authorized_tags(tags), &[])
}

/// `authorizedEndpointNodeWalkable(tags)`.
pub fn authorized_endpoint_node_walkable(tags: &Tags) -> bool {
    let foot = norm_opt(tags.get("foot"));
    let access = norm_opt(tags.get("access"));
    let barrier = norm_opt(tags.get("barrier"));
    if ["yes", "1", "true"].contains(&norm_opt(tags.get("locked")).as_ref())
        || !norm_opt(tags.get("locked:conditional")).is_empty()
    {
        return false;
    }
    if [
        "wall",
        "fence",
        "retaining_wall",
        "block",
        "jersey_barrier",
        "full-height_turnstile",
    ]
    .contains(&barrier.as_ref())
    {
        return false;
    }
    if rules::node_walkable(tags) {
        return true;
    }
    if foot == "no" || foot == "use_sidepath" || (access == "no" && foot != "private") {
        return false;
    }
    let mut permitted = authorized_tags(tags);
    if GATES.contains(&barrier.as_ref())
        && (foot == "destination"
            || (foot.is_empty() && ["", "private", "destination"].contains(&access.as_ref())))
    {
        permitted.set("foot", "yes");
    }
    rules::node_walkable(&permitted)
}

struct PrivateWay {
    id: i64,
    refs: Vec<i64>,
    directions: Directions,
    access: Option<String>,
    foot: Option<String>,
}

#[derive(Default)]
struct CandidatePass {
    order: Vec<i64>,
    seen: IdSet,
    private_ways: Vec<PrivateWay>,
    platform_areas: Vec<Vec<i64>>,
}

impl CandidatePass {
    fn add(&mut self, refs: &[i64]) {
        for &id in refs {
            if self.seen.insert(id) {
                self.order.push(id);
            }
        }
    }
}

impl Handler for CandidatePass {
    fn wants_ways(&self) -> bool {
        true
    }
    fn way(&mut self, block: &Block, way: Way) -> Result<()> {
        let tags = Tags::from_keys(block, &way.keys, &way.vals)?;
        if rules::platform_area_walkable(&tags) {
            if rules::walk_directions(&tags).any() {
                self.add(&way.refs);
                self.platform_areas.push(way.refs);
            }
            return Ok(());
        }
        let public = rules::way_walkable(&tags, &[]);
        let private = !public && authorized_private_way(&tags);
        let directions = if private {
            rules::walk_directions(&authorized_tags(&tags))
        } else {
            rules::walk_directions(&tags)
        };
        if (!public && !private) || !directions.any() {
            return Ok(());
        }
        self.add(&way.refs);
        if private {
            self.private_ways.push(PrivateWay {
                id: way.id,
                directions,
                access: tags.get("access").map(str::to_owned),
                foot: tags.get("foot").map(str::to_owned),
                refs: way.refs,
            });
        }
        Ok(())
    }
}

struct Graph {
    by_id: HashMap<i64, usize>,
    lons: Vec<f64>,
    lats: Vec<f64>,
    public_nodes: Vec<u8>,
    permissions: Vec<u8>,
    authorized_gates: Vec<i64>,
    gate_connections: Vec<(usize, usize, f64, Directions, i64)>,
}

impl Graph {
    fn save(&mut self, index: usize, id: i64, point: (f64, f64), tags: &Tags) {
        self.lons[index] = point.0;
        self.lats[index] = point.1;
        let public = rules::node_walkable(tags);
        let authorized = authorized_endpoint_node_walkable(tags);
        self.permissions[index] = u8::from(public) | (u8::from(authorized) << 1);
        if !public
            && authorized
            && GATES.contains(&norm_opt(tags.get("barrier")).as_ref())
            && !self.authorized_gates.contains(&id)
        {
            self.authorized_gates.push(id);
        }
    }

    fn segments(&self, refs: &[i64], mut visit: impl FnMut(&Self, usize, usize, f64)) {
        for i in 1..refs.len() {
            let (Some(&from), Some(&to)) = (self.by_id.get(&refs[i - 1]), self.by_id.get(&refs[i]))
            else {
                continue;
            };
            if !self.lons[from].is_finite() || !self.lons[to].is_finite() {
                continue;
            }
            let distance = js_math::haversine_km(
                self.lons[from],
                self.lats[from],
                self.lons[to],
                self.lats[to],
            ) * 1000.0;
            if distance > 0.0 && distance < 10_000.0 {
                visit(self, from, to, distance);
            }
        }
    }
}

impl Handler for Graph {
    fn wants_nodes(&self) -> bool {
        true
    }
    fn wants_ways(&self) -> bool {
        true
    }
    fn node(&mut self, block: &Block, node: Node) -> Result<()> {
        if let Some(&index) = self.by_id.get(&node.id) {
            let point = block.coordinate(node.lat, node.lon)?;
            let tags = Tags::from_keys(block, &node.keys, &node.vals)?;
            self.save(index, node.id, point, &tags);
        }
        Ok(())
    }
    fn dense_nodes(&mut self, block: &Block, dense: DenseNodes) -> Result<()> {
        for i in 0..dense.ids.len() {
            if let Some(&index) = self.by_id.get(&dense.ids[i]) {
                let point = block.coordinate(dense.lats[i], dense.lons[i])?;
                let tags = Tags::from_dense(block, &dense, i)?;
                self.save(index, dense.ids[i], point, &tags);
            }
        }
        Ok(())
    }
    fn way(&mut self, block: &Block, way: Way) -> Result<()> {
        let tags = Tags::from_keys(block, &way.keys, &way.vals)?;
        let directions = rules::walk_directions(&tags);
        if rules::way_walkable(&tags, &[]) && directions.any() {
            let mut public_pairs = Vec::new();
            let mut gates = Vec::new();
            self.segments(&way.refs, |graph, from, to, distance| {
                if graph.permissions[from] & 1 != 0 && graph.permissions[to] & 1 != 0 {
                    public_pairs.push((from, to));
                } else if graph.permissions[from] & 2 != 0 && graph.permissions[to] & 2 != 0 {
                    gates.push((from, to, distance, directions, way.id));
                }
            });
            for (from, to) in public_pairs {
                self.public_nodes[from] = 1;
                self.public_nodes[to] = 1;
            }
            self.gate_connections.extend(gates);
        }
        Ok(())
    }
}

/// `buildTerminalAccessStore`. `boundary_components` prepares the City's
/// coordinate access and returns the public access components of the street
/// kernel (`nativePublicAccessComponents`).
pub fn build_terminal_access_store(
    pbf_path: &Path,
    street_store: &Path,
    boundary_components: &mut dyn FnMut() -> Result<Vec<u32>>,
) -> Result<Js> {
    let started = std::time::Instant::now();
    let snapshot_path = accelerator::walk_snapshot_path(street_store);
    let snapshot = std::fs::read(&snapshot_path)?;
    let header: serde_json::Value = serde_json::from_str(jsrt::trim(&String::from_utf8_lossy(
        &snapshot[..HEADER_BYTES.min(snapshot.len())],
    )))
    .map_err(|error| Error::new(error.to_string()))?;
    let column = |name: &str| -> Vec<f64> {
        let spec = &header["arrays"][name];
        let offset = spec["offset"].as_u64().unwrap_or(0) as usize;
        let length = spec["length"].as_u64().unwrap_or(0) as usize;
        (0..length)
            .map(|i| {
                f64::from_le_bytes(
                    snapshot[offset + 8 * i..offset + 8 * i + 8]
                        .try_into()
                        .unwrap_or_default(),
                )
            })
            .collect()
    };
    let source_lons = column("nodeLons");
    let source_lats = column("nodeLats");
    let fingerprint = header["identity"]["sourceFingerprint"]
        .as_str()
        .unwrap_or("")
        .to_owned();

    let mut candidates = CandidatePass::default();
    let source_hash = pbf::for_each_block(
        pbf_path,
        &mut |block| block.for_each(&mut candidates),
        &mut |_| Ok(()),
    )?;
    if source_hash != fingerprint {
        return Err(Error::new(
            "Terminal access requires the same OSM input used to build this City.",
        ));
    }
    let CandidatePass {
        order: ids,
        private_ways,
        platform_areas,
        ..
    } = candidates;
    let mut graph = Graph {
        by_id: ids
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index))
            .collect(),
        lons: vec![f64::NAN; ids.len()],
        lats: vec![f64::NAN; ids.len()],
        public_nodes: vec![0; ids.len()],
        permissions: vec![0; ids.len()],
        authorized_gates: Vec::new(),
        gate_connections: Vec::new(),
    };
    let node_hash = pbf::for_each_block(
        pbf_path,
        &mut |block| block.for_each(&mut graph),
        &mut |_| Ok(()),
    )?;
    if node_hash != fingerprint {
        return Err(Error::new(
            "OSM input changed while building endpoint access.",
        ));
    }
    let connected: Vec<&Vec<i64>> = platform_areas
        .iter()
        .filter(|refs| {
            rules::platform_area_has_walking_junctions(refs, |id| {
                graph
                    .by_id
                    .get(&id)
                    .is_some_and(|&i| graph.public_nodes[i] == 1)
            })
        })
        .collect();
    for refs in connected {
        let mut public_pairs = Vec::new();
        graph.segments(refs, |graph, from, to, _| {
            if graph.permissions[from] & 1 != 0 && graph.permissions[to] & 1 != 0 {
                public_pairs.push((from, to));
            }
        });
        for (from, to) in public_pairs {
            graph.public_nodes[from] = 1;
            graph.public_nodes[to] = 1;
        }
    }
    let rows = header["spatialRows"].as_f64().unwrap_or(1.0);
    let columns = header["spatialColumns"].as_f64().unwrap_or(1.0);
    let min_lat = header["spatialMinLat"].as_f64().unwrap_or(0.0);
    let min_lon = header["spatialMinLon"].as_f64().unwrap_or(0.0);
    let cell_degrees = header["spatialCellDegrees"].as_f64().unwrap_or(1.0);
    let cell = |i: usize| -> f64 {
        let row = jsrt::min(
            rows - 1.0,
            jsrt::max(0.0, ((graph.lats[i] - min_lat) / cell_degrees).floor()),
        );
        let column = jsrt::min(
            columns - 1.0,
            jsrt::max(0.0, ((graph.lons[i] - min_lon) / cell_degrees).floor()),
        );
        row * columns + column
    };
    let mut public_order: Vec<usize> = (0..ids.len())
        .filter(|&i| graph.public_nodes[i] != 0)
        .collect();
    public_order.sort_by(|&a, &b| cell(a).total_cmp(&cell(b)).then(ids[a].cmp(&ids[b])));
    let node_count = header["nodeCount"].as_f64().unwrap_or(-1.0);
    if public_order.len() as f64 != node_count {
        return Err(Error::new(
            "OSM source does not reproduce the public street snapshot node set; rebuild the City from the same inputs.",
        ));
    }
    let mut public_index = vec![u32::MAX; ids.len()];
    for (node, &i) in public_order.iter().enumerate() {
        if (graph.lons[i] - source_lons[node]).abs() > 1e-10
            || (graph.lats[i] - source_lats[node]).abs() > 1e-10
        {
            return Err(Error::new(
                "OSM source-node ordering differs from the public snapshot; terminal access cannot be linked safely.",
            ));
        }
        public_index[i] = node as u32;
    }
    let mut local_index: HashMap<usize, usize> = HashMap::new();
    let (mut node_lons, mut node_lats, mut mapped_public) = (Vec::new(), Vec::new(), Vec::new());
    let (mut sources, mut targets, mut distances, mut way_ids) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut add = |from: usize, to: usize, distance: f64, way: i64| {
        for i in [from, to] {
            local_index.entry(i).or_insert_with(|| {
                node_lons.push(graph.lons[i]);
                node_lats.push(graph.lats[i]);
                mapped_public.push(public_index[i]);
                node_lons.len() - 1
            });
        }
        sources.push(local_index[&from]);
        targets.push(local_index[&to]);
        distances.push(distance);
        way_ids.push(way);
    };
    for way in &private_ways {
        let mut pairs = Vec::new();
        graph.segments(&way.refs, |graph, from, to, distance| {
            if graph.permissions[from] & 2 != 0 && graph.permissions[to] & 2 != 0 {
                pairs.push((from, to, distance));
            }
        });
        for (from, to, distance) in pairs {
            if way.directions.forward {
                add(from, to, distance, way.id);
            }
            if way.directions.backward {
                add(to, from, distance, way.id);
            }
        }
    }
    for &(from, to, distance, directions, way) in &graph.gate_connections {
        if directions.forward {
            add(from, to, distance, way);
        }
        if directions.backward {
            add(to, from, distance, way);
        }
    }
    let boundary = boundary_components()?;
    if boundary.is_empty() {
        return Err(Error::new(
            "Authorized endpoint access requires a timetable with mapped public street anchors.",
        ));
    }
    let mut gates = graph.authorized_gates.clone();
    gates.sort_unstable();
    let numbers = |values: &[f64]| Js::Array(values.iter().map(|v| Js::Number(*v)).collect());
    let indices =
        |values: &[usize]| Js::Array(values.iter().map(|v| Js::Number(*v as f64)).collect());
    let result = Js::object()
        .with("schemaVersion", "vigo.street.terminal-access.v1")
        .with("permission", "authorized_endpoints")
        .with(
            "publicNodeCount",
            header["nodeCount"].as_f64().map_or(Js::Null, Js::Number),
        )
        .with(
            "publicEdgeCount",
            header["edgeCount"].as_f64().map_or(Js::Null, Js::Number),
        )
        .with("sourceFingerprint", fingerprint.as_str())
        .with("nodeLons", numbers(&node_lons))
        .with("nodeLats", numbers(&node_lats))
        .with(
            "publicNodes",
            Js::Array(
                mapped_public
                    .iter()
                    .map(|v| Js::Number(f64::from(*v)))
                    .collect(),
            ),
        )
        .with("edgeSources", indices(&sources))
        .with("edgeTargets", indices(&targets))
        .with("edgeDistancesM", numbers(&distances))
        .with(
            "edgeWayIds",
            Js::Array(way_ids.iter().map(|v| Js::Number(*v as f64)).collect()),
        )
        .with(
            "boundaryComponents",
            Js::Array(boundary.iter().map(|v| Js::Number(f64::from(*v))).collect()),
        )
        .with(
            "sourceWays",
            Js::Array(
                private_ways
                    .iter()
                    .map(|way| {
                        Js::object()
                            .with("id", way.id as f64)
                            .with("access", way.access.as_deref().map_or(Js::Null, Js::from))
                            .with("foot", way.foot.as_deref().map_or(Js::Null, Js::from))
                    })
                    .collect(),
            ),
        )
        .with(
            "authorizedGateNodeIds",
            Js::Array(gates.iter().map(|v| Js::Number(*v as f64)).collect()),
        );
    let destination = PathBuf::from(format!(
        "{}.terminal-access-v1.json",
        street_store.display()
    ));
    let temporary = PathBuf::from(format!(
        "{}.{}.tmp",
        destination.display(),
        std::process::id()
    ));
    let written = std::fs::write(&temporary, result.stringify())
        .and_then(|()| std::fs::rename(&temporary, &destination));
    let _ = std::fs::remove_file(&temporary);
    written?;
    Ok(Js::object()
        .with("model", "authorized_endpoints")
        .with(
            "artifact",
            destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
        .with("nodes", node_lons.len())
        .with("directedEdges", sources.len())
        .with("privateWays", private_ways.len())
        .with("publicBoundaryComponents", boundary.len())
        .with("authorizedGateNodes", graph.authorized_gates.len())
        .with("sourceNodeIdentityVerified", true)
        .with("throughPrivateStreets", false)
        .with("buildMs", elapsed_ms(started)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ported from test/check-terminal-access-store.mjs.
    #[test]
    fn authorized_endpoint_nodes() {
        let walkable = |pairs: &[(&str, &str)]| authorized_endpoint_node_walkable(&Tags::of(pairs));
        assert!(walkable(&[("barrier", "gate")]));
        assert!(walkable(&[("barrier", "gate"), ("access", "private")]));
        assert!(walkable(&[("barrier", "gate"), ("access", "destination")]));
        let blocked: [&[(&str, &str)]; 8] = [
            &[("foot", "no")],
            &[("access", "no")],
            &[("barrier", "gate"), ("locked", "yes")],
            &[("barrier", "gate"), ("foot", "yes"), ("locked", "yes")],
            &[("barrier", "wall")],
            &[("barrier", "wall"), ("foot", "yes")],
            &[
                ("barrier", "gate"),
                ("locked:conditional", "yes @ (sunset-sunrise)"),
            ],
            &[("barrier", "gate"), ("opening_hours", "08:00-18:00")],
        ];
        for tags in blocked {
            assert!(!walkable(tags), "{tags:?}");
        }
    }
}
