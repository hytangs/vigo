//! Bicycle endpoint walks over the existing immutable pedestrian snapshot.
//! The only additional resident data is a source-identity join; search scratch
//! and path witnesses belong to the query, never to a profile or global cache.
use super::*;
use crate::drive_attachment::BikeCandidate;
use crate::{IntegerHasher, SnapWorkspace, Snapshot};
use rusqlite::OptionalExtension;
use std::collections::hash_map::Entry;
use std::hash::BuildHasherDefault;
use std::sync::Arc;

pub(super) struct WalkNetwork {
    snapshot: Arc<Snapshot>,
    // Sorted walking-node -> bicycle-node pairs. Never join by coordinates.
    links: Vec<(u32, u32)>,
}
struct WalkSearch {
    // Keys are compact snapshot node ids, never external strings. Candidate
    // order is sorted below, independent of hash-table iteration order.
    labels: HashMap<u32, (f64, u32), BuildHasherDefault<IntegerHasher>>,
    projection: [f64; 2],
    gap: f64,
    attached_bike_nodes: Vec<u32>,
}

// Walking access is Dijkstra search: priority is always the physical distance.
// Keep it once, preserving the shared queue's distance-then-node tie order.
#[derive(Clone, Copy)]
struct WalkQueue {
    node: u32,
    meters: f64,
}
impl PartialEq for WalkQueue {
    fn eq(&self, other: &Self) -> bool {
        self.node == other.node && self.meters.to_bits() == other.meters.to_bits()
    }
}
impl Eq for WalkQueue {}
impl PartialOrd for WalkQueue {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for WalkQueue {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .meters
            .total_cmp(&self.meters)
            .then_with(|| other.node.cmp(&self.node))
    }
}
const MAX_LABELS: usize = 32_768;
const MAX_CANDIDATES: usize = 512 * 1024 / std::mem::size_of::<BikeCandidate>();
const CANDIDATE_LIMIT: &str =
    "Bicycle walking access exceeded its 512 KiB candidate budget; reduce maxWalkKm";
fn push_candidate(candidates: &mut Vec<BikeCandidate>, candidate: BikeCandidate) -> bool {
    if candidates.len() >= MAX_CANDIDATES {
        return false;
    }
    if candidates.len() == candidates.capacity() {
        let capacity = (candidates.capacity().max(16) * 2).min(MAX_CANDIDATES);
        candidates.reserve_exact(capacity - candidates.len());
    }
    candidates.push(candidate);
    true
}

impl WalkNetwork {
    pub(super) fn load(
        db: &Connection,
        path: &str,
        ids: &HashMap<i64, u32>,
        lons: &[f64],
        lats: &[f64],
    ) -> Result<Option<Self>, String> {
        let raw: Option<String> = db
            .query_row(
                "SELECT value FROM metadata WHERE key='bikeWalkAccess'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(raw) = raw else { return Ok(None) };
        let meta: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if meta["version"] != 1 || meta["snapshotSuffix"] != ".street-accelerator-v7.bin" {
            return Err("Unsupported bicycle walking access index".into());
        }
        let snapshot =
            crate::shared_streets::snapshot(&format!("{path}.street-accelerator-v7.bin"))
                .map_err(|e| e.to_string())?;
        let header: serde_json::Value =
            serde_json::from_slice(&snapshot.mmap[..4096]).map_err(|e| e.to_string())?;
        if meta["identity"] != header["identity"]
            || meta["nodeCount"] != header["nodeCount"]
            || meta["edgeCount"] != header["edgeCount"]
        {
            return Err("Bicycle walking links do not match the pedestrian snapshot".into());
        }
        let xs = snapshot.f64_array("nodeLons").map_err(|e| e.to_string())?;
        let ys = snapshot.f64_array("nodeLats").map_err(|e| e.to_string())?;
        let count: usize = db
            .query_row("SELECT count(*) FROM bike_walk_nodes", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count > ids.len() {
            return Err("Too many bicycle walking links".into());
        }
        let mut links = Vec::with_capacity(count);
        let mut statement = db
            .prepare("SELECT bike_node,walk_node FROM bike_walk_nodes ORDER BY walk_node")
            .map_err(|e| e.to_string())?;
        for row in statement
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (source, walk) = row.map_err(|e| e.to_string())?;
            let bike = *ids.get(&source).ok_or("Unknown bicycle walking node")?;
            if walk as usize >= xs.len()
                || links.last().is_some_and(|&(previous, _)| previous >= walk)
                || (xs[walk as usize] - lons[bike as usize]).abs() > 1e-7
                || (ys[walk as usize] - lats[bike as usize]).abs() > 1e-7
            {
                return Err("Invalid bicycle walking node identity".into());
            }
            links.push((walk, bike));
        }
        Ok(Some(Self { snapshot, links }))
    }
    #[cfg(any(feature = "standalone", test))]
    pub(super) fn heap_bytes(&self) -> usize {
        self.links.capacity() * std::mem::size_of::<(u32, u32)>()
    }
    fn bike_node(&self, node: u32) -> Option<u32> {
        self.links
            .binary_search_by_key(&node, |&(walk, _)| walk)
            .ok()
            .map(|i| self.links[i].1)
    }
    fn search(&self, point: [f64; 2], maximum: f64, origin: bool) -> Result<WalkSearch, String> {
        let snapshot = &self.snapshot;
        let (snaps, projection) = crate::street_attachment_with_workspace(
            snapshot,
            snapshot.reciprocal_edge_flags(),
            &mut SnapWorkspace::default(),
            point[0],
            point[1],
        )
        .map_err(|e| e.to_string())?;
        let xs = snapshot.f64_array("nodeLons").map_err(|e| e.to_string())?;
        let ys = snapshot.f64_array("nodeLats").map_err(|e| e.to_string())?;
        let gap = projection.map_or_else(
            || snaps.first().map_or(f64::INFINITY, |s| s.distance_m),
            |p| p.projection_distance_m,
        );
        let projected = projection.map_or_else(
            || {
                snaps
                    .first()
                    .map_or(point, |s| [xs[s.node as usize], ys[s.node as usize]])
            },
            |p| {
                let a = p.left.node as usize;
                let b = p.right.node as usize;
                [
                    xs[a] + p.fraction * (xs[b] - xs[a]),
                    ys[a] + p.fraction * (ys[b] - ys[a]),
                ]
            },
        );
        let attached_bike_nodes = snaps
            .iter()
            .filter_map(|s| self.bike_node(s.node))
            .collect();
        let mut labels = HashMap::<_, _, BuildHasherDefault<IntegerHasher>>::default();
        let mut queue = BinaryHeap::new();
        if gap <= crate::SNAP_RADIUS_M && gap <= maximum {
            for snap in snaps.into_iter().filter(|s| s.distance_m <= maximum) {
                labels.insert(snap.node, (snap.distance_m, u32::MAX));
                queue.push(WalkQueue {
                    node: snap.node,
                    meters: snap.distance_m,
                });
            }
        }
        let offsets = snapshot
            .u32_array(if origin {
                "edgeOffsets"
            } else {
                "reverseOffsets"
            })
            .map_err(|e| e.to_string())?;
        let targets = snapshot
            .u32_array(if origin {
                "edgeTargets"
            } else {
                "reverseSources"
            })
            .map_err(|e| e.to_string())?;
        let distances = snapshot
            .f64_array("edgeDistances")
            .map_err(|e| e.to_string())?;
        let reverse = snapshot
            .u32_array("reverseEdgeIndices")
            .map_err(|e| e.to_string())?;
        while let Some(current) = queue.pop() {
            if labels[&current.node].0 != current.meters {
                continue;
            }
            for edge in
                offsets[current.node as usize] as usize..offsets[current.node as usize + 1] as usize
            {
                let next = targets[edge];
                let length = distances[if origin { edge } else { reverse[edge] as usize }];
                let distance = current.meters + length;
                if distance > maximum {
                    continue;
                }
                let full = labels.len() >= MAX_LABELS;
                let entry = labels.entry(next);
                if let Entry::Occupied(known) = &entry
                    && known.get().0 <= distance
                {
                    continue;
                }
                if (full && matches!(&entry, Entry::Vacant(_))) || queue.len() >= MAX_LABELS {
                    return Err("Bicycle walking access exceeded its bounded search workspace; reduce maxWalkKm".into());
                }
                entry
                    .and_modify(|label| *label = (distance, current.node))
                    .or_insert((distance, current.node));
                queue.push(WalkQueue {
                    node: next,
                    meters: distance,
                });
            }
        }
        Ok(WalkSearch {
            labels,
            projection: projected,
            gap,
            attached_bike_nodes,
        })
    }
    pub(super) fn attach(
        &self,
        bike: &BikeKernel,
        point: [f64; 2],
        maximum: f64,
        speed: f64,
        origin: bool,
        eligible: &impl Fn(u32) -> bool,
    ) -> Result<Attachment, String> {
        let walk = self.search(point, maximum, origin)?;
        let graph = bike.graph();
        // A coordinate can choose a nearer bicycle road, but cannot jump over
        // its nearer pedestrian attachment to an unrelated road. Remaining
        // off-network snapping is bounded by the existing pedestrian radius.
        let snap_limit = maximum.min(crate::SNAP_RADIUS_M);
        let direct = bike
            .index
            .attach_bicycle_matching(&graph, point, snap_limit, speed, origin, false, eligible);
        let mut candidates = direct.candidates;
        candidates.retain(|c| {
            c.walk_meters <= walk.gap + 0.01 || {
                let from = bike.source(c.edge);
                let to = bike.targets[c.edge as usize];
                // Both kernels project with their existing local metrics. A
                // centimetre comparison must not reject the same physical edge
                // just because those projection metrics differ slightly.
                (walk.attached_bike_nodes.len() == 2
                    && walk.attached_bike_nodes.contains(&from)
                    && walk.attached_bike_nodes.contains(&to))
                    || (walk.attached_bike_nodes.len() == 1
                        && ((c.fraction == 0. && walk.attached_bike_nodes[0] == from)
                            || (c.fraction == 1. && walk.attached_bike_nodes[0] == to)))
            }
        });
        let mut reached: Vec<_> = walk
            .labels
            .iter()
            .filter_map(|(&node, &(meters, _))| self.bike_node(node).map(|b| (b, meters)))
            .collect();
        reached.sort_unstable_by_key(|&(node, _)| node);
        for (node, meters) in reached {
            let edges = bike.offsets[node as usize]..bike.offsets[node as usize + 1];
            let mut outgoing = edges.filter(|&e| eligible(e));
            if origin {
                for edge in outgoing {
                    if !push_candidate(
                        &mut candidates,
                        BikeCandidate {
                            node: bike.targets[edge as usize],
                            edge,
                            fraction: 2.,
                            walk_meters: meters,
                        },
                    ) {
                        return Err(CANDIDATE_LIMIT.into());
                    }
                }
            } else if let Some(edge) = outgoing.next() {
                // Zero partial length: terminate at the shared physical node.
                if !push_candidate(
                    &mut candidates,
                    BikeCandidate {
                        node,
                        edge,
                        fraction: 2.,
                        walk_meters: meters,
                    },
                ) {
                    return Err(CANDIDATE_LIMIT.into());
                }
            } else {
                // Directed sinks have no outgoing edge to represent that node.
                let complete = bike.index.visit_segments(
                    &graph,
                    bike.point(node),
                    0.01,
                    &|e| eligible(e) && bike.targets[e as usize] == node,
                    &mut |p| {
                        push_candidate(
                            &mut candidates,
                            BikeCandidate {
                                node: bike.source(p.1),
                                edge: p.1,
                                fraction: 3.,
                                walk_meters: meters,
                            },
                        )
                    },
                );
                if !complete {
                    return Err(CANDIDATE_LIMIT.into());
                }
            }
        }
        candidates.sort_unstable_by(|a, b| {
            a.walk_meters
                .total_cmp(&b.walk_meters)
                .then(a.edge.cmp(&b.edge))
                .then(a.fraction.total_cmp(&b.fraction))
        });
        // The same coordinate may already coincide with a joined vertex.
        candidates.dedup_by(|a, b| {
            a.edge == b.edge && a.fraction == b.fraction && a.walk_meters == b.walk_meters
        });
        Ok(Attachment::from_candidates(candidates, speed, origin))
    }
    pub(super) fn legs(
        &self,
        bike: &BikeKernel,
        point: [f64; 2],
        candidate: RoadCandidate,
        origin: bool,
    ) -> Result<Option<Vec<BikeLeg>>, String> {
        if !candidate.walk_network || candidate.walk_meters <= 1e-6 {
            return Ok(None);
        }
        let node = if candidate.fraction == 0. {
            bike.source(candidate.edge)
        } else if candidate.fraction == 1. {
            bike.targets[candidate.edge as usize]
        } else {
            return Err("A network bicycle connector must end at a joined node".into());
        };
        let walk = self.search(point, candidate.walk_meters + 1e-5, origin)?;
        let target = self
            .links
            .iter()
            .find(|&&(_, b)| b == node)
            .map(|&(w, _)| w)
            .ok_or("Missing bicycle walking join")?;
        let (meters, _) = *walk
            .labels
            .get(&target)
            .ok_or("Bicycle walking witness disappeared")?;
        if (meters - candidate.walk_meters).abs() > 1e-5 {
            return Err("Bicycle walking witness distance differs".into());
        }
        let xs = self
            .snapshot
            .f64_array("nodeLons")
            .map_err(|e| e.to_string())?;
        let ys = self
            .snapshot
            .f64_array("nodeLats")
            .map_err(|e| e.to_string())?;
        let mut nodes = vec![target];
        let mut cursor = target;
        while walk.labels[&cursor].1 != u32::MAX {
            cursor = walk.labels[&cursor].1;
            nodes.push(cursor)
        }
        nodes.reverse();
        let mut coordinates = vec![walk.projection];
        coordinates.extend(nodes.into_iter().map(|n| [xs[n as usize], ys[n as usize]]));
        // Bicycle coordinates are quantized at import, while the shared walk
        // snapshot retains the original source precision.
        coordinates.push(candidate.road);
        let mut legs = Vec::new();
        let seconds_per_meter = candidate.walk_seconds / candidate.walk_meters;
        if walk.gap > 1e-6 {
            legs.push(BikeLeg {
                kind: "walk",
                meters: walk.gap,
                seconds: walk.gap * seconds_per_meter,
                coordinates: vec![point, walk.projection],
                source: "coordinate-snap",
                verified: false,
                wait_before_seconds: 0.,
            })
        }
        legs.push(BikeLeg {
            kind: "walk",
            meters: meters - walk.gap,
            seconds: (meters - walk.gap) * seconds_per_meter,
            coordinates,
            source: "osm",
            verified: true,
            wait_before_seconds: 0.,
        });
        if !origin {
            legs.reverse();
            for leg in &mut legs {
                leg.coordinates.reverse()
            }
        }
        Ok(Some(legs))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_walk_queue_preserves_distance_and_node_ties() {
        assert_eq!(std::mem::size_of::<WalkQueue>(), 16);
        assert_eq!(std::mem::size_of::<crate::PointHeapEntry>(), 24);
        let mut compact = BinaryHeap::new();
        let mut reference = BinaryHeap::new();
        // Repeated improvements leave stale entries in the queue. Include
        // equal distances, fractional lengths and the full compact-id range.
        for node in [u32::MAX - 1, 19, 0, 1, 32768] {
            for meters in [32.5, 0., 32.5, 0.125, 1e-6, 10000.] {
                compact.push(WalkQueue { node, meters });
                reference.push(crate::PointHeapEntry {
                    node,
                    distance_m: meters,
                    priority_m: meters,
                });
            }
        }
        while let Some(expected) = reference.pop() {
            let actual = compact.pop().unwrap();
            assert_eq!(actual.node, expected.node);
            assert_eq!(actual.meters.to_bits(), expected.distance_m.to_bits());
        }
        assert!(compact.is_empty());
    }
}
