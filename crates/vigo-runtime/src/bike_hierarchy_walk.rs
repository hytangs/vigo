//! Bicycle endpoint walking over the pedestrian contraction hierarchy.
//! The topology is shared with Walk. This metric retains the snapshot's
//! unrounded metres, including during candidate selection.
use super::*;

const NONE: u32 = u32::MAX;
const LIMIT: &str =
    "Bicycle walking access exceeded its bounded hierarchy workspace; reduce maxWalkKm";
const _: () = assert!(MAX_LABELS < u16::MAX as usize);

#[derive(Clone, Copy)]
struct RankLabel {
    meters: f64,
    parent: u32,
    rank: u32,
}

// The rank column is direct-addressed, while distances and witnesses occupy
// only visited slots. Reset exactly those slots between endpoint searches.
#[derive(Default)]
struct RankLabels {
    slots: Vec<u16>,
    labels: Vec<RankLabel>,
}

impl RankLabels {
    fn reset(&mut self, nodes: usize) {
        if self.slots.len() != nodes {
            self.slots = vec![0; nodes];
            self.labels.clear();
            return;
        }
        for label in self.labels.drain(..) {
            self.slots[label.rank as usize] = 0;
        }
    }

    fn get(&self, rank: u32) -> Option<&RankLabel> {
        let slot = self.slots[rank as usize];
        (slot != 0).then(|| &self.labels[slot as usize - 1])
    }

    fn at(&self, rank: u32) -> &RankLabel {
        &self.labels[self.slots[rank as usize] as usize - 1]
    }

    #[inline]
    fn improve(&mut self, rank: u32, meters: f64, parent: u32) -> Result<bool, &'static str> {
        let slot = &mut self.slots[rank as usize];
        if *slot != 0 {
            let label = &mut self.labels[*slot as usize - 1];
            if meters < label.meters {
                label.meters = meters;
                label.parent = parent;
            }
            return Ok(false);
        }
        if self.labels.len() == MAX_LABELS {
            return Err(LIMIT);
        }
        self.labels.push(RankLabel {
            meters,
            parent,
            rank,
        });
        *slot = self.labels.len() as u16;
        Ok(true)
    }
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
    up: RankLabels,
    down: RankLabels,
    ascending: RankQueue,
    descending: RankQueue,
}

// Higher levels mark nonempty words in the level below. Find the next
// rank without comparing labels or searching through empty City ranks.
#[derive(Default)]
struct RankQueue {
    levels: Vec<Box<[u64]>>,
    nodes: usize,
}
impl RankQueue {
    fn reset(&mut self, nodes: usize) {
        if self.nodes == nodes && !self.levels.is_empty() {
            if self.levels.last().unwrap()[0] != 0 {
                for level in &mut self.levels {
                    level.fill(0);
                }
            }
            return;
        }
        self.nodes = nodes;
        self.levels.clear();
        let mut words = nodes.div_ceil(64).max(1);
        loop {
            self.levels.push(vec![0; words].into_boxed_slice());
            if words == 1 {
                break;
            }
            words = words.div_ceil(64);
        }
    }

    #[inline]
    fn push(&mut self, rank: u32) {
        let mut index = rank as usize;
        for level in &mut self.levels {
            let word = &mut level[index / 64];
            let old = *word;
            *word |= 1 << (index % 64);
            if old != 0 {
                break;
            }
            index /= 64;
        }
    }

    #[inline]
    fn pop<const DESCENDING: bool>(&mut self) -> Option<u32> {
        if self.levels.last().unwrap()[0] == 0 {
            return None;
        }
        let mut index = 0;
        for level in self.levels.iter().rev() {
            let word = level[index];
            let bit = if DESCENDING {
                63 - word.leading_zeros()
            } else {
                word.trailing_zeros()
            };
            index = index * 64 + bit as usize;
        }
        let rank = index as u32;
        for level in &mut self.levels {
            let word = &mut level[index / 64];
            *word &= !(1 << (index % 64));
            if *word != 0 {
                break;
            }
            index /= 64;
        }
        Some(rank)
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
        mut visit: impl FnMut(u32, f64),
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
        let size = view.rank.len();
        up.reset(size);
        down.reset(size);
        ascending.reset(size);
        descending.reset(size);
        for (node, meters) in seeds {
            let rank = view.rank[node as usize];
            if up.improve(rank, meters, NONE)? {
                ascending.push(rank);
            }
        }
        // Each relaxation increases rank, so a rank is final when visited.
        while let Some(rank) = ascending.pop::<false>() {
            let prefix = up.at(rank).meters;
            down.improve(rank, prefix, NONE)?;
            descending.push(rank);
            let x = rank as usize;
            let arcs = view.up_first_out[x] as usize..view.up_first_out[x + 1] as usize;
            for (&to, &distance) in view.up_head[arcs.clone()].iter().zip(&up_meters[arcs]) {
                let meters = prefix + distance;
                if meters <= maximum && up.improve(to, meters, rank)? {
                    ascending.push(to);
                }
            }
        }
        // Descending propagation only visits ranks reached within the
        // distance budget. Its order is topological, independent of weights.
        while let Some(rank) = descending.pop::<true>() {
            let prefix = down.at(rank).meters;
            visit(nodes[rank as usize], prefix);
            let x = rank as usize;
            for a in view.down_first_out[x] as usize..view.down_first_out[x + 1] as usize {
                let meters = prefix + down_meters[view.down_to_up[a] as usize];
                if meters <= maximum && down.improve(view.down_head[a], meters, rank)? {
                    descending.push(view.down_head[a]);
                }
            }
        }
        Ok(())
    }

    pub fn distance(&self, target: u32, scratch: &Scratch) -> Option<f64> {
        let rank = self.structure.view().rank[target as usize];
        scratch.down.get(rank).map(|label| label.meters)
    }

    pub fn path(&self, target: u32, origin: bool, scratch: &Scratch) -> Vec<u32> {
        let view = self.structure.view();
        let mut rank = view.rank[target as usize];
        let mut path = vec![rank];
        loop {
            let parent = scratch.down.at(rank).parent;
            if parent == NONE {
                break;
            }
            rank = parent;
            path.push(rank);
        }
        loop {
            let parent = scratch.up.at(rank).parent;
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
        scratch
            .up
            .at(self.structure.view().rank[node as usize])
            .meters
    }
}
