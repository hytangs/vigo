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

#[path = "bike_hierarchy_walk.rs"]
mod hierarchy;

pub(super) struct WalkNetwork {
    snapshot: Arc<Snapshot>,
    // Source-identity join, dense only when it occupies no more memory than
    // sorted pairs. Never join by coordinates.
    links: WalkLinks,
    hierarchy: std::sync::OnceLock<hierarchy::WalkHierarchy>,
}
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) enum WalkLinks {
    Dense(Vec<u32>),
    Sparse(Vec<(u32, u32)>),
}
impl WalkLinks {
    fn bike_node(&self, node: u32) -> Option<u32> {
        match self {
            Self::Dense(nodes) => nodes.get(node as usize).copied().filter(|&n| n != u32::MAX),
            Self::Sparse(links) => links
                .binary_search_by_key(&node, |&(walk, _)| walk)
                .ok()
                .map(|i| links[i].1),
        }
    }
    fn walk_node(&self, node: u32) -> Option<u32> {
        match self {
            Self::Dense(nodes) => nodes
                .iter()
                .position(|&bike| bike == node)
                .map(|i| i as u32),
            Self::Sparse(links) => links
                .iter()
                .find(|&&(_, bike)| bike == node)
                .map(|&(walk, _)| walk),
        }
    }
    #[cfg(any(feature = "standalone", test))]
    fn heap_bytes(&self) -> usize {
        match self {
            Self::Dense(nodes) => nodes.capacity() * 4,
            Self::Sparse(links) => links.capacity() * 8,
        }
    }
}
#[derive(Default)]
pub(super) struct WalkSearch {
    snap: SnapWorkspace,
    // Keys are compact snapshot node ids, never external strings. Candidate
    // order is sorted below, independent of hash-table iteration order.
    labels: Vec<(u32, f64)>,
    projection: [f64; 2],
    gap: f64,
    attached_bike_nodes: Vec<u32>,
    ranked: hierarchy::Scratch,
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
    pub(super) fn prepare_hierarchy(
        &self,
        path: Option<&str>,
        store: Option<&index::Store>,
    ) -> Result<(), String> {
        if self.hierarchy.get().is_none() {
            let structure = if let Some(path) = path {
                hierarchy::Topology::Mapped(
                    crate::shared_streets::structure(path).map_err(|err| err.to_string())?,
                )
            } else {
                hierarchy::Topology::build(&self.snapshot)?
            };
            let prepared = hierarchy::WalkHierarchy::prepare(&self.snapshot, structure, store)?;
            let _ = self.hierarchy.set(prepared);
        }
        Ok(())
    }

    #[cfg(feature = "standalone")]
    pub(super) fn hierarchy_memory(&self) -> (usize, usize) {
        self.hierarchy
            .get()
            .map_or((0, 0), hierarchy::WalkHierarchy::memory)
    }

    pub(super) fn publish_hierarchy(&self, store: &index::Store) -> std::io::Result<()> {
        if let Some(hierarchy) = self.hierarchy.get() {
            hierarchy.publish(store)?;
        }
        Ok(())
    }

    pub(super) fn prepared_links(&self) -> &WalkLinks {
        &self.links
    }

    pub(super) fn prepared_rank(&self) -> Option<&[u32]> {
        self.hierarchy.get().map(hierarchy::WalkHierarchy::rank)
    }

    pub(super) fn from_prepared(
        path: &str,
        links: WalkLinks,
        lons: &[f64],
        lats: &[f64],
        verified: bool,
    ) -> Result<Self, String> {
        let snapshot =
            crate::shared_streets::snapshot(&format!("{path}.street-accelerator-v7.bin"))
                .map_err(|e| e.to_string())?;
        if !verified {
            let xs = snapshot.f64_array("nodeLons").map_err(|e| e.to_string())?;
            let ys = snapshot.f64_array("nodeLats").map_err(|e| e.to_string())?;
            let valid = |walk: usize, bike: u32| {
                walk < xs.len()
                    && (bike as usize) < lons.len()
                    && (xs[walk] - lons[bike as usize]).abs() <= 1e-7
                    && (ys[walk] - lats[bike as usize]).abs() <= 1e-7
            };
            let matches = match &links {
                WalkLinks::Dense(nodes) => {
                    nodes.len() == xs.len()
                        && nodes
                            .iter()
                            .enumerate()
                            .all(|(walk, &bike)| bike == u32::MAX || valid(walk, bike))
                }
                WalkLinks::Sparse(nodes) => {
                    nodes.windows(2).all(|pair| pair[0].0 < pair[1].0)
                        && nodes.iter().all(|&(walk, bike)| valid(walk as usize, bike))
                }
            };
            if !matches {
                return Err("Invalid compiled bicycle walking node identity".into());
            }
        }
        Ok(Self {
            snapshot,
            links,
            hierarchy: std::sync::OnceLock::new(),
        })
    }

    pub(super) fn load(
        db: &Connection,
        path: &str,
        ids: &super::OsmNodeIds,
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
        let count: i64 = db
            .query_row("SELECT count(*) FROM bike_walk_nodes", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let count = usize::try_from(count).map_err(|_| "Invalid bicycle walking link count")?;
        if count > ids.len() {
            return Err("Too many bicycle walking links".into());
        }
        let mut links = if xs.len() <= count.saturating_mul(2) {
            WalkLinks::Dense(vec![u32::MAX; xs.len()])
        } else {
            WalkLinks::Sparse(Vec::with_capacity(count))
        };
        // Dense links need no row order. Sorting this multi-million-row table
        // in SQLite can spill to disk on a cold open. Sparse links sort their
        // compact integer pairs below; both paths reject duplicate identities.
        let mut statement = db
            .prepare("SELECT bike_node,walk_node FROM bike_walk_nodes")
            .map_err(|e| e.to_string())?;
        for row in statement
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (source, walk) = row.map_err(|e| e.to_string())?;
            let bike = *ids.get(&source).ok_or("Unknown bicycle walking node")?;
            if walk as usize >= xs.len()
                || (xs[walk as usize] - lons[bike as usize]).abs() > 1e-7
                || (ys[walk as usize] - lats[bike as usize]).abs() > 1e-7
            {
                return Err("Invalid bicycle walking node identity".into());
            }
            match &mut links {
                WalkLinks::Dense(nodes) => {
                    if nodes[walk as usize] != u32::MAX {
                        return Err("Invalid bicycle walking node identity".into());
                    }
                    nodes[walk as usize] = bike;
                }
                WalkLinks::Sparse(links) => links.push((walk, bike)),
            }
        }
        if let WalkLinks::Sparse(links) = &mut links {
            links.sort_unstable_by_key(|&(walk, _)| walk);
            if links.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                return Err("Invalid bicycle walking node identity".into());
            }
        }
        Ok(Some(Self {
            snapshot,
            links,
            hierarchy: std::sync::OnceLock::new(),
        }))
    }
    #[cfg(any(feature = "standalone", test))]
    pub(super) fn heap_bytes(&self) -> usize {
        self.links.heap_bytes()
    }
    fn bike_node(&self, node: u32) -> Option<u32> {
        self.links.bike_node(node)
    }
    fn search(&self, point: [f64; 2], maximum: f64, origin: bool) -> Result<WalkSearch, String> {
        let mut walk = WalkSearch::default();
        self.search_into(point, maximum, origin, &mut walk)?;
        Ok(walk)
    }
    fn search_into(
        &self,
        point: [f64; 2],
        maximum: f64,
        origin: bool,
        walk: &mut WalkSearch,
    ) -> Result<(), String> {
        // A batch reuses bounded allocations, never labels or answers from
        // another coordinate. Queue ordering and every relaxation stay intact.
        walk.labels.clear();
        walk.attached_bike_nodes.clear();
        let snapshot = &self.snapshot;
        let (snaps, projection) = crate::street_attachment_with_workspace(
            snapshot,
            snapshot.reciprocal_edge_flags(),
            &mut walk.snap,
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
        walk.attached_bike_nodes
            .extend(snaps.iter().filter_map(|s| self.bike_node(s.node)));
        self.hierarchy
            .get()
            .ok_or("Bicycle walking hierarchy was not opened")?
            .within(
                snaps
                    .into_iter()
                    .filter(|s| gap <= crate::SNAP_RADIUS_M && s.distance_m <= maximum)
                    .map(|snap| (snap.node, snap.distance_m)),
                maximum,
                origin,
                &mut walk.ranked,
                &mut walk.labels,
            )?;
        walk.projection = projected;
        walk.gap = gap;
        Ok(())
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
        self.attach_with_workspace(
            bike,
            point,
            maximum,
            speed,
            origin,
            eligible,
            false,
            &mut WalkSearch::default(),
        )
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Batch scratch must not change endpoint policy."
    )]
    pub(super) fn attach_with_workspace(
        &self,
        bike: &BikeKernel,
        point: [f64; 2],
        maximum: f64,
        speed: f64,
        origin: bool,
        eligible: &impl Fn(u32) -> bool,
        vertex_origins: bool,
        walk: &mut WalkSearch,
    ) -> Result<Attachment, String> {
        self.search_into(point, maximum, origin, walk)?;
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
            .filter_map(|&(node, meters)| self.bike_node(node).map(|b| (b, meters)))
            .collect();
        reached.sort_unstable_by_key(|&(node, _)| node);
        for (node, meters) in reached {
            let edges = bike.offsets[node as usize]..bike.offsets[node as usize + 1];
            let mut outgoing = edges.filter(|&e| eligible(e));
            if origin && vertex_origins {
                // A shared reverse search already checks the first road when
                // it reaches this vertex. Store one walking terminal instead
                // of repeating it once for every outgoing edge. Preserve the
                // endpoint's private-component permission when one is present.
                let edge = outgoing
                    .clone()
                    .find(|&e| bike.attributes[e as usize] & (1 << 22) != 0)
                    .or_else(|| outgoing.next());
                if let Some(edge) = edge
                    && !push_candidate(
                        &mut candidates,
                        BikeCandidate {
                            node,
                            edge,
                            fraction: 4.,
                            walk_meters: meters,
                        },
                    )
                {
                    return Err(CANDIDATE_LIMIT.into());
                }
            } else if origin {
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
            .walk_node(node)
            .ok_or("Missing bicycle walking join")?;
        let hierarchy = self
            .hierarchy
            .get()
            .ok_or("Bicycle walking hierarchy was not opened")?;
        let meters = hierarchy
            .distance(target, &walk.ranked)
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
        let nodes = hierarchy.path(target, origin, &walk.ranked);
        // A shortcut groups metres differently from the original walk.
        // Report the unpacked witness with the original edge order.
        let meters = {
            let offsets = self
                .snapshot
                .u32_array("edgeOffsets")
                .map_err(|e| e.to_string())?;
            let heads = self
                .snapshot
                .u32_array("edgeTargets")
                .map_err(|e| e.to_string())?;
            let lengths = self
                .snapshot
                .f64_array("edgeDistances")
                .map_err(|e| e.to_string())?;
            let mut exact = hierarchy.seed_meters(nodes[0], &walk.ranked);
            for pair in nodes.windows(2) {
                let (a, b) = if origin {
                    (pair[0], pair[1])
                } else {
                    (pair[1], pair[0])
                };
                let length = (offsets[a as usize] as usize..offsets[a as usize + 1] as usize)
                    .filter(|&edge| heads[edge] == b)
                    .map(|edge| lengths[edge])
                    .min_by(f64::total_cmp)
                    .ok_or("Bicycle walking witness is missing a pedestrian edge")?;
                exact += length;
            }
            exact
        };
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
    fn dense_and_sparse_identity_joins_agree() {
        let sparse = WalkLinks::Sparse(vec![(0, 8), (2, 4), (4, 1)]);
        let dense = WalkLinks::Dense(vec![8, u32::MAX, 4, u32::MAX, 1]);
        for node in 0..8 {
            assert_eq!(dense.bike_node(node), sparse.bike_node(node));
        }
        for node in 0..10 {
            assert_eq!(dense.walk_node(node), sparse.walk_node(node));
        }
        assert!(dense.heap_bytes() <= sparse.heap_bytes());
    }
}
