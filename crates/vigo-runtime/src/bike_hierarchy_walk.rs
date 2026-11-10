//! Bicycle endpoint walking over the pedestrian contraction hierarchy.
//! The topology is shared with Walk. This metric retains the snapshot's
//! unrounded metres, including during candidate selection.
use super::*;

const NONE: u32 = u32::MAX;
type RankMap = HashMap<u32, RankLabel, BuildHasherDefault<IntegerHasher>>;

#[derive(Clone, Copy)]
struct RankLabel {
    meters: f64,
    parent: u32,
}

struct Metric {
    meters: index::Column<f64>,
    via: index::Column<u32>,
}

impl Metric {
    fn new(arcs: usize) -> Self {
        Self {
            meters: vec![f64::INFINITY; arcs].into(),
            via: vec![NONE; arcs].into(),
        }
    }

    fn reduce(&mut self, arc: usize, meters: f64, via: u32) {
        if meters < self.meters[arc] {
            self.meters[arc] = meters;
            self.via[arc] = via;
        }
    }
}

fn arc(view: &cch::CchView<'_>, low: u32, high: u32) -> Option<usize> {
    let first = view.up_first_out[low as usize] as usize;
    let end = view.up_first_out[low as usize + 1] as usize;
    view.up_head[first..end]
        .binary_search(&high)
        .ok()
        .map(|i| first + i)
}

pub(super) enum Topology {
    Mapped(Arc<cch::CchBundle>),
    Owned(Box<cch::Cch>),
}
impl Topology {
    fn view(&self) -> cch::CchView<'_> {
        match self {
            Self::Mapped(value) => value.view(),
            Self::Owned(value) => value.view(),
        }
    }

    pub fn build(snapshot: &Snapshot) -> Result<Self, String> {
        let offsets = snapshot
            .u32_array("edgeOffsets")
            .map_err(|e| e.to_string())?;
        let targets = snapshot
            .u32_array("edgeTargets")
            .map_err(|e| e.to_string())?;
        let lons = snapshot.f64_array("nodeLons").map_err(|e| e.to_string())?;
        let lats = snapshot.f64_array("nodeLats").map_err(|e| e.to_string())?;
        let n = u32::try_from(lons.len()).map_err(|_| "Too many pedestrian nodes")?;
        if offsets.len() != n as usize + 1
            || lats.len() != n as usize
            || offsets.first() != Some(&0)
            || offsets.last().copied().map(|n| n as usize) != Some(targets.len())
            || offsets.windows(2).any(|pair| pair[0] > pair[1])
        {
            return Err("Invalid pedestrian snapshot dimensions".into());
        }
        let mut tails = Vec::with_capacity(targets.len());
        for (node, edges) in offsets.windows(2).enumerate() {
            tails.extend(std::iter::repeat_n(
                node as u32,
                (edges[1] - edges[0]) as usize,
            ));
        }
        if tails.len() != targets.len() || targets.iter().any(|&node| node >= n) {
            return Err("Invalid pedestrian graph".into());
        }
        let lats = lats.iter().map(|&lat| lat as f32).collect::<Vec<_>>();
        let lons = lons.iter().map(|&lon| lon as f32).collect::<Vec<_>>();
        let order = cch::order::balanced_inertial_order(n, &tails, targets, &lats, &lons);
        let graph = cch::graph::Graph {
            first_out: offsets.to_vec(),
            head: targets.to_vec(),
            weight: vec![],
        };
        Ok(Self::Owned(Box::new(cch::Cch::build(&graph, &order))))
    }
}

pub(super) struct WalkHierarchy {
    structure: Topology,
    nodes: index::Column<u32>,
    forward: Metric,
    backward: Metric,
}

#[derive(Default)]
pub(super) struct Scratch {
    up: RankMap,
    down: RankMap,
    ascending: RankQueue,
    descending: RankQueue,
}

// Both sweeps visit ranks monotonically. Bucket by the first differing
// bit to retain rank order without a comparison at each relaxation.
struct RankQueue {
    last: u32,
    bins: [Vec<u32>; 33],
}
impl Default for RankQueue {
    fn default() -> Self {
        Self {
            last: 0,
            bins: std::array::from_fn(|_| Vec::new()),
        }
    }
}
impl RankQueue {
    fn clear(&mut self) {
        self.last = 0;
        for bin in &mut self.bins {
            bin.clear();
        }
    }
    fn push(&mut self, value: u32) {
        debug_assert!(value >= self.last);
        self.bins[(u32::BITS - (value ^ self.last).leading_zeros()) as usize].push(value);
    }
    fn pop(&mut self) -> Option<u32> {
        if self.bins[0].is_empty() {
            let i = self.bins.iter().position(|bin| !bin.is_empty())?;
            let mut values = std::mem::take(&mut self.bins[i]);
            self.last = *values.iter().min().unwrap();
            for value in values.drain(..) {
                self.push(value);
            }
            self.bins[i] = values;
        }
        self.bins[0].pop()
    }
}

fn improve(labels: &mut RankMap, rank: u32, meters: f64, parent: u32) -> bool {
    match labels.entry(rank) {
        Entry::Occupied(mut existing) => {
            if meters < existing.get().meters {
                existing.insert(RankLabel { meters, parent });
            }
            false
        }
        Entry::Vacant(vacant) => {
            vacant.insert(RankLabel { meters, parent });
            true
        }
    }
}

impl WalkHierarchy {
    pub fn rank(&self) -> &[u32] {
        self.structure.view().rank
    }

    pub fn prepare(
        snapshot: &Snapshot,
        structure: Topology,
        store: Option<&index::Store>,
    ) -> Result<Self, String> {
        if let Some(store) = store
            && let Ok((nodes, forward, backward)) = Self::open(store, structure.view())
        {
            return Ok(Self {
                structure,
                nodes,
                forward,
                backward,
            });
        }
        let view = structure.view();
        let offsets = snapshot
            .u32_array("edgeOffsets")
            .map_err(|e| e.to_string())?;
        let targets = snapshot
            .u32_array("edgeTargets")
            .map_err(|e| e.to_string())?;
        let lengths = snapshot
            .f64_array("edgeDistances")
            .map_err(|e| e.to_string())?;
        if offsets.len() != view.rank.len() + 1 || targets.len() != lengths.len() {
            return Err("Pedestrian hierarchy does not match bicycle walking links".into());
        }
        let mut nodes = vec![0; view.rank.len()];
        let mut forward = Metric::new(view.up_head.len());
        let mut backward = Metric::new(view.up_head.len());
        for (node, &from) in view.rank.iter().enumerate() {
            nodes[from as usize] = node as u32;
            for e in offsets[node] as usize..offsets[node + 1] as usize {
                let to = view.rank[targets[e] as usize];
                if from == to {
                    continue;
                }
                let index = arc(&view, from.min(to), from.max(to))
                    .ok_or("Pedestrian hierarchy is missing a snapshot edge")?;
                let metric = if from < to {
                    &mut forward
                } else {
                    &mut backward
                };
                metric.reduce(index, lengths[e], NONE);
            }
        }
        // The same lower triangles that customize the street metric, with
        // unrounded weights and the winning contraction vertex as witness.
        let mut top = vec![0; view.rank.len()];
        for x in 0..view.rank.len() {
            for a in view.up_first_out[x]..view.up_first_out[x + 1] {
                top[view.up_head[a as usize] as usize] = a as usize;
            }
            for a in view.down_first_out[x] as usize..view.down_first_out[x + 1] as usize {
                let y = view.down_head[a] as usize;
                let bottom = view.down_to_up[a] as usize;
                for middle in
                    (view.up_first_out[y] as usize..view.up_first_out[y + 1] as usize).rev()
                {
                    let z = view.up_head[middle] as usize;
                    if z <= x {
                        break;
                    }
                    forward.reduce(
                        top[z],
                        backward.meters[bottom] + forward.meters[middle],
                        y as u32,
                    );
                    backward.reduce(
                        top[z],
                        forward.meters[bottom] + backward.meters[middle],
                        y as u32,
                    );
                }
            }
        }
        Ok(Self {
            structure,
            nodes: nodes.into(),
            forward,
            backward,
        })
    }

    fn open(
        store: &index::Store,
        structure: cch::CchView<'_>,
    ) -> std::io::Result<(index::Column<u32>, Metric, Metric)> {
        let mut reader = store.open("walk", &[])?;
        let n = structure.rank.len();
        let arcs = structure.up_head.len();
        let nodes = reader.column(Some(n))?;
        let mut read_metric = || {
            Ok::<_, std::io::Error>(Metric {
                meters: reader.column(Some(arcs))?,
                via: reader.column(Some(arcs))?,
            })
        };
        let forward = read_metric()?;
        let backward = read_metric()?;
        reader.finish()?;
        Ok((nodes, forward, backward))
    }

    #[cfg(feature = "standalone")]
    pub fn memory(&self) -> (usize, usize) {
        let metrics = [&self.forward, &self.backward]
            .into_iter()
            .map(|m| m.meters.capacity() * 8 + m.via.capacity() * 4)
            .sum::<usize>();
        let topology = match &self.structure {
            Topology::Mapped(_) => 0,
            Topology::Owned(cch) => {
                4 * (cch.rank.capacity()
                    + cch.elimination_tree_parent.capacity()
                    + cch.up_first_out.capacity()
                    + cch.up_head.capacity()
                    + cch.up_tail.capacity()
                    + cch.down_first_out.capacity()
                    + cch.down_head.capacity()
                    + cch.down_to_up.capacity()
                    + cch.input_arc_to_cch_arc.capacity()
                    + cch.forward_input_arc_of_cch.capacity()
                    + cch.backward_input_arc_of_cch.capacity()
                    + cch.first_extra_forward_input_arc_of_cch.capacity()
                    + cch.first_extra_backward_input_arc_of_cch.capacity()
                    + cch.extra_forward_input_arc_of_cch.capacity()
                    + cch.extra_backward_input_arc_of_cch.capacity())
            }
        };
        (
            metrics + self.nodes.capacity() * 4 + topology,
            self.nodes.mapped_file_bytes(),
        )
    }

    pub fn publish(&self, store: &index::Store) -> std::io::Result<()> {
        if self.nodes.mapped() {
            return Ok(());
        }
        store.publish("walk", &[], |writer| {
            writer.column(&self.nodes)?;
            for metric in [&self.forward, &self.backward] {
                writer.column(&metric.meters)?;
                writer.column(&metric.via)?;
            }
            Ok(())
        })
    }

    pub fn within(
        &self,
        seeds: impl Iterator<Item = (u32, f64)>,
        maximum: f64,
        origin: bool,
        scratch: &mut Scratch,
        labels: &mut Vec<(u32, f64)>,
    ) -> Result<(), String> {
        let view = self.structure.view();
        let (up_metric, down_metric) = if origin {
            (&self.forward, &self.backward)
        } else {
            (&self.backward, &self.forward)
        };
        let up_meters = &*up_metric.meters;
        let down_meters = &*down_metric.meters;
        let nodes = &*self.nodes;
        let Scratch {
            up,
            down,
            ascending,
            descending,
        } = scratch;
        up.clear();
        down.clear();
        ascending.clear();
        descending.clear();
        for (node, meters) in seeds {
            let rank = view.rank[node as usize];
            if improve(up, rank, meters, NONE) {
                ascending.push(rank);
            }
        }
        // Each relaxation increases rank, so a rank is final when visited.
        while let Some(rank) = ascending.pop() {
            let prefix = up[&rank].meters;
            improve(down, rank, prefix, NONE);
            descending.push(!rank);
            let x = rank as usize;
            let arcs = view.up_first_out[x] as usize..view.up_first_out[x + 1] as usize;
            for (&to, &distance) in view.up_head[arcs.clone()].iter().zip(&up_meters[arcs]) {
                let meters = prefix + distance;
                if meters <= maximum && improve(up, to, meters, rank) {
                    ascending.push(to);
                }
            }
            if up.len() > MAX_LABELS {
                return Err("Bicycle walking access exceeded its bounded hierarchy workspace; reduce maxWalkKm".into());
            }
        }
        // Descending propagation only visits ranks reached within the
        // distance budget. Its order is topological, independent of weights.
        while let Some(reverse) = descending.pop() {
            let rank = !reverse;
            let prefix = down[&rank].meters;
            labels.push((nodes[rank as usize], prefix));
            let x = rank as usize;
            for a in view.down_first_out[x] as usize..view.down_first_out[x + 1] as usize {
                let meters = prefix + down_meters[view.down_to_up[a] as usize];
                if meters <= maximum && improve(down, view.down_head[a], meters, rank) {
                    descending.push(!view.down_head[a]);
                }
            }
            if down.len() > MAX_LABELS {
                return Err("Bicycle walking access exceeded its bounded hierarchy workspace; reduce maxWalkKm".into());
            }
        }
        Ok(())
    }

    pub fn distance(&self, target: u32, scratch: &Scratch) -> Option<f64> {
        let rank = self.structure.view().rank[target as usize];
        scratch.down.get(&rank).map(|label| label.meters)
    }

    pub fn path(&self, target: u32, origin: bool, scratch: &Scratch) -> Vec<u32> {
        let view = self.structure.view();
        let mut rank = view.rank[target as usize];
        let mut path = vec![rank];
        loop {
            let parent = scratch.down[&rank].parent;
            if parent == NONE {
                break;
            }
            rank = parent;
            path.push(rank);
        }
        loop {
            let parent = scratch.up[&rank].parent;
            if parent == NONE {
                break;
            }
            rank = parent;
            path.push(rank);
        }
        path.reverse();
        let mut nodes = vec![self.nodes[path[0] as usize]];
        let mut steps = Vec::new();
        for pair in path.windows(2) {
            steps.push((pair[0], pair[1]));
            while let Some((from, to)) = steps.pop() {
                let a = arc(&view, from.min(to), from.max(to))
                    .expect("Bicycle walking witness is a hierarchy arc");
                let metric = if (from < to) == origin {
                    &self.forward
                } else {
                    &self.backward
                };
                let via = metric.via[a];
                if via == NONE {
                    nodes.push(self.nodes[to as usize]);
                } else {
                    steps.push((via, to));
                    steps.push((from, via));
                }
            }
        }
        nodes
    }

    pub fn seed_meters(&self, node: u32, scratch: &Scratch) -> f64 {
        scratch.up[&self.structure.view().rank[node as usize]].meters
    }
}
