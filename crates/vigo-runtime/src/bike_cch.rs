//! Turn-aware bicycle contraction hierarchy. Stable movements are customized
//! once per profile; query clocks constrain the dated movements.
use super::*;
use std::time::Instant;

#[path = "bike_cch_batch.rs"]
pub(in crate::bike) mod batch;
#[path = "bike_hierarchy_certify.rs"]
mod certify;
#[path = "bike_hierarchy_point.rs"]
pub(in crate::bike) mod point;
#[path = "bike_cch_point_guard.rs"]
mod point_guard;
#[path = "bike_cch_point_path.rs"]
mod point_path;
#[path = "bike_hierarchy_reverse.rs"]
pub(super) mod reverse;
#[path = "bike_hierarchy_scoped.rs"]
mod scoped;
#[path = "bike_hierarchy_temporal.rs"]
mod temporal;

const NONE: u32 = u32::MAX;
const VIA: u32 = 1 << 31;

struct Arcs {
    costs: index::Column<f64>,
    witness: index::Column<u32>,
}

impl Arcs {
    fn improve(&mut self, arc: usize, cost: f64, witness: u32) {
        if cost < self.costs[arc] {
            self.costs[arc] = cost;
            if !self.witness.is_empty() {
                self.witness[arc] = witness;
            }
        }
    }
}

struct Hierarchy {
    graph: std::sync::Arc<RankGraph>,
    up: Arcs,
    down: Arcs,
}

// The same CCH topology is either newly compiled or mapped read-only. Keep
// the field layout identical so all queries use the same rank traversal.
macro_rules! ranked_columns {
    ($($column:ident),+ $(,)?) => {
        struct RankGraph { $($column: index::Column<u32>),+ }
        impl From<cch::Cch> for RankGraph {
            fn from(graph: cch::Cch) -> Self {
                Self { $($column: graph.$column.into()),+ }
            }
        }
        impl RankGraph {
            fn read(reader: &mut index::Reader) -> std::io::Result<Self> {
                Ok(Self { $($column: reader.column(None)?),+ })
            }
            #[cfg(feature = "standalone")]
            fn heap_bytes(&self) -> usize {
                4 * (0 $(+ self.$column.capacity())+)
            }
            fn write(&self, writer: &mut index::Writer) -> std::io::Result<()> {
                $(writer.column(&self.$column)?;)+
                Ok(())
            }
        }
    };
}
ranked_columns!(
    rank,
    elimination_tree_parent,
    up_first_out,
    up_head,
    up_tail,
    down_first_out,
    down_head,
    down_to_up,
    input_arc_to_cch_arc,
    forward_input_arc_of_cch,
    backward_input_arc_of_cch,
    first_extra_forward_input_arc_of_cch,
    first_extra_backward_input_arc_of_cch,
    extra_forward_input_arc_of_cch,
    extra_backward_input_arc_of_cch,
);
impl RankGraph {
    fn node_count(&self) -> usize {
        self.rank.len()
    }
    fn cch_arc_count(&self) -> usize {
        self.up_head.len()
    }
    fn matches(&self, movements: &MovementGraph) -> bool {
        let n = self.node_count();
        let a = self.cch_arc_count();
        n + 1 == movements.input.first_out.len()
            && self.elimination_tree_parent.len() == n
            && self.up_first_out.len() == n + 1
            && self.down_first_out.len() == n + 1
            && self.up_tail.len() == a
            && self.down_head.len() == a
            && self.down_to_up.len() == a
            && self.forward_input_arc_of_cch.len() == a
            && self.backward_input_arc_of_cch.len() == a
            && self.first_extra_forward_input_arc_of_cch.len() == a + 1
            && self.first_extra_backward_input_arc_of_cch.len() == a + 1
            && self.input_arc_to_cch_arc.len() == movements.input.head.len()
    }
}

struct MovementGraph {
    states: arrival_states::ArrivalStates,
    input: cch::graph::Graph,
    roads: Vec<u32>,
    timed: Vec<(u32, u32, std::ops::Range<usize>)>,
    private: Vec<(u32, u32)>,
    dynamic: Vec<bool>,
}

fn incoming_state(kernel: &BikeKernel, edge: u32) -> u32 {
    if kernel.attributes[edge as usize] & (NODE_TURN | WAY_TURN) != 0 {
        edge
    } else {
        NONE
    }
}

fn state_id(
    states: &arrival_states::ArrivalStates,
    node: u32,
    incoming: u32,
    history: &TurnState,
) -> u32 {
    if incoming == NONE && history.is_empty() {
        node
    } else {
        states.ids[&(node, incoming, states.turn_ids[history])]
    }
}

type MovementSuccessors = (smallvec::SmallVec<[u32; 2]>, bool, Option<u32>);

fn possible_successors(
    kernel: &BikeKernel,
    states: &arrival_states::ArrivalStates,
    from: u32,
    road: u32,
    clock: Option<BikeClock>,
    mut at: f64,
    latest: f64,
) -> Result<MovementSuccessors, String> {
    let start = states.state(from);
    let history = &states.turns[start.turns as usize];
    let incoming = (start.incoming != NONE).then_some(start.incoming);
    let mut targets = smallvec::SmallVec::new();
    let mut timed = false;
    let mut stable = None;
    let mut observed = false;
    while at <= latest {
        let local = clock.map(|clock| BikeClock {
            epoch: clock.epoch + at,
            ..clock
        });
        let mut successor = None;
        if let Some((_, state)) = kernel
            .movements(
                history,
                incoming,
                start.node,
                road,
                local,
                0.,
                MovementPolicy::Check,
                false,
            )?
            .first
        {
            let target = state_id(
                states,
                kernel.targets[road as usize],
                incoming_state(kernel, road),
                &state,
            );
            successor = Some(target);
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
        if !observed {
            stable = successor;
            observed = true;
        } else if stable != successor {
            stable = None;
        }
        let Some(next) = clock.and_then(|clock| {
            kernel.movement_next_change(history, incoming, start.node, road, clock, at)
        }) else {
            break;
        };
        timed = true;
        assert!(next > at);
        at = next;
    }
    Ok((targets, timed, stable))
}

impl MovementGraph {
    fn new(kernel: &BikeKernel) -> Result<Self, String> {
        let states = arrival_states::ArrivalStates::build(kernel)?;
        let nodes = kernel.lons.len();
        let count = nodes + states.extra.len();
        let mut offsets = Vec::with_capacity(count + 1);
        let mut heads = Vec::with_capacity(kernel.targets.len());
        let mut roads = Vec::with_capacity(kernel.targets.len());
        let mut timed = Vec::new();
        // All conditions in the prepared bicycle graph use civil week minutes.
        // A Monday in UTC provides every weekly state without clock jumps.
        let week = BikeClock::service("2026-01-05", "UTC", 0.)?;
        for source in 0..count as u32 {
            offsets.push(heads.len() as u32);
            let state = states.state(source);
            for road in kernel.offsets[state.node as usize]..kernel.offsets[state.node as usize + 1]
            {
                if source < nodes as u32 && kernel.attributes[road as usize] & TIMED_EDGE == 0 {
                    let target = state_id(
                        &states,
                        kernel.targets[road as usize],
                        incoming_state(kernel, road),
                        &states.turns[0],
                    );
                    heads.push(target);
                    roads.push(road);
                    continue;
                }
                let (mut destinations, changing, dated) =
                    possible_successors(kernel, &states, source, road, Some(week), 0., 604799.)?;
                let (_, _, conservative) =
                    possible_successors(kernel, &states, source, road, None, 0., 0.)?;
                let conditional = changing || conservative != dated;
                if let Some(to) = conservative
                    && !destinations.contains(&to)
                {
                    destinations.push(to);
                }
                let first = heads.len();
                roads.extend(std::iter::repeat_n(road, destinations.len()));
                heads.extend(destinations);
                if conditional && first != heads.len() {
                    timed.push((source, road, first..heads.len()));
                }
            }
        }
        offsets.push(heads.len() as u32);
        let private = roads
            .iter()
            .enumerate()
            .filter(|(_, road)| kernel.attributes[**road as usize] & (1 << 22) != 0)
            .map(|(index, &road)| {
                (
                    kernel.destination_components[kernel.source(road) as usize],
                    index as u32,
                )
            })
            .collect();
        let mut dynamic = vec![false; roads.len()];
        for (_, _, range) in &timed {
            dynamic[range.clone()].fill(true);
        }
        Ok(Self {
            states,
            input: cch::graph::Graph {
                first_out: offsets,
                head: heads,
                weight: vec![],
            },
            roads,
            timed,
            private,
            dynamic,
        })
    }
}

fn projected_order(kernel: &BikeKernel, movements: &MovementGraph) -> Result<Vec<u32>, String> {
    let states = &movements.states;
    let Some((walking, rank)) = kernel
        .walking
        .as_ref()
        .and_then(|walking| walking.prepared_rank().map(|rank| (walking, rank)))
    else {
        // Cities without an identity join build the same hierarchy from
        // the movement graph and its own coordinates.
        let mut lats = Vec::with_capacity(movements.input.first_out.len() - 1);
        let mut lons = Vec::with_capacity(lats.capacity());
        let mut tails = Vec::with_capacity(movements.input.head.len());
        for (id, row) in movements.input.first_out.windows(2).enumerate() {
            let state = states.state(id as u32);
            let p = kernel.point(state.node);
            lons.push(p[0] as f32);
            lats.push(p[1] as f32);
            tails.extend(std::iter::repeat_n(id as u32, (row[1] - row[0]) as usize));
        }
        return Ok(cch::order::balanced_inertial_order(
            lons.len() as u32,
            &tails,
            &movements.input.head,
            &lats,
            &lons,
        ));
    };
    let mut by_rank = vec![NONE; rank.len()];
    let mut linked = vec![false; kernel.lons.len()];
    let mut insert = |walk: usize, bike: u32| {
        if bike != NONE {
            assert!(!linked[bike as usize]);
            linked[bike as usize] = true;
            by_rank[rank[walk] as usize] = bike;
        }
    };
    match walking.prepared_links() {
        walk::WalkLinks::Dense(links) => {
            assert_eq!(links.len(), rank.len());
            for (walk, &bike) in links.iter().enumerate() {
                insert(walk, bike);
            }
        }
        walk::WalkLinks::Sparse(links) => {
            for &(walk, bike) in links {
                insert(walk as usize, bike);
            }
        }
    }
    Ok(linked
        .into_iter()
        .enumerate()
        .filter_map(|(node, linked)| (!linked).then_some(node as u32))
        .chain(by_rank.into_iter().filter(|&node| node != NONE))
        .flat_map(|node| states.variants(node))
        .collect())
}

impl Hierarchy {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep hierarchy query inputs explicit."
    )]
    fn customize_into(
        graph: &RankGraph,
        up: &mut Arcs,
        down: &mut Arcs,
        kernel: &BikeKernel,
        movements: &MovementGraph,
        options: BikeOptions,
        weight: impl Fn(u32) -> f64,
        public_only: bool,
    ) {
        up.costs.fill(f64::INFINITY);
        down.costs.fill(f64::INFINITY);
        for (from, range) in movements.input.first_out.windows(2).enumerate() {
            for index in range[0] as usize..range[1] as usize {
                let arc = graph.input_arc_to_cch_arc[index];
                let road = movements.roads[index];
                if arc == NONE
                    || !kernel.allowed_edge(road, options)
                    || public_only
                        && (movements.dynamic[index]
                            || kernel.attributes[road as usize] & (1 << 22) != 0)
                {
                    continue;
                }
                let cost = weight(road);
                let arcs = if graph.rank[from] < graph.rank[movements.input.head[index] as usize] {
                    &mut *up
                } else {
                    &mut *down
                };
                arcs.improve(arc as usize, cost, index as u32);
            }
        }
        // Match the existing CCH triangle order, carrying the winning
        // contraction vertex alongside the unquantized scalar weight.
        let mut arc_to = vec![0; graph.node_count()];
        for x in 0..graph.node_count() {
            for top in graph.up_first_out[x]..graph.up_first_out[x + 1] {
                arc_to[graph.up_head[top as usize] as usize] = top;
            }
            for incoming in graph.down_first_out[x]..graph.down_first_out[x + 1] {
                let lower = graph.down_head[incoming as usize] as usize;
                let bottom = graph.down_to_up[incoming as usize] as usize;
                for mid in (graph.up_first_out[lower]..graph.up_first_out[lower + 1]).rev() {
                    let z = graph.up_head[mid as usize] as usize;
                    if z <= x {
                        break;
                    }
                    let top = arc_to[z] as usize;
                    let forward = down.costs[bottom] + up.costs[mid as usize];
                    let backward = up.costs[bottom] + down.costs[mid as usize];
                    up.improve(top, forward, lower as u32 | VIA);
                    down.improve(top, backward, lower as u32 | VIA);
                }
            }
        }
    }

    fn find_arc(&self, low: u32, high: u32) -> Option<u32> {
        let first = self.graph.up_first_out[low as usize] as usize;
        let end = self.graph.up_first_out[low as usize + 1] as usize;
        self.graph.up_head[first..end]
            .binary_search(&high)
            .ok()
            .map(|i| (first + i) as u32)
    }

    fn search_space(&self, nodes: impl Iterator<Item = u32>) -> Vec<u32> {
        let mut marked = vec![false; self.graph.node_count()];
        let mut search_space = Vec::new();
        for node in nodes {
            let mut rank = self.graph.rank[node as usize];
            while rank != NONE && !marked[rank as usize] {
                marked[rank as usize] = true;
                search_space.push(rank);
                rank = self.graph.elimination_tree_parent[rank as usize];
            }
        }
        search_space.sort_unstable();
        search_space
    }

    fn ascend<M: ArcCosts>(&self, starts: &[(u32, f64)], work: &mut Workspace, costs: M) {
        work.reset();
        let source_space = self.search_space(starts.iter().map(|&(node, _)| node));
        let first = &*self.graph.up_first_out;
        let heads = &*self.graph.up_head;
        for &(node, cost) in starts {
            let rank = self.graph.rank[node as usize] as usize;
            if cost < work.up_cost[rank] {
                work.up_cost[rank] = cost;
            }
        }
        for &rank in &source_space {
            let value = work.up_cost[rank as usize];
            if !value.is_finite() {
                continue;
            }
            for arc in first[rank as usize]..first[rank as usize + 1] {
                let to = heads[arc as usize] as usize;
                let cost = value + costs.arc(arc as usize);
                if cost < work.up_cost[to] {
                    work.up_cost[to] = cost;
                }
            }
        }
        work.source_space = source_space;
    }

    fn solve<M: ArcCosts>(
        &self,
        starts: &[(u32, f64)],
        targets: Option<&[u32]>,
        work: &mut Workspace,
        costs: (M, M),
    ) {
        self.ascend(starts, work, costs.0);
        let first = &*self.graph.up_first_out;
        let heads = &*self.graph.up_head;
        // Every target's higher neighbours are ancestors, so this sweep
        // overwrites each slot before any later read. Keep the reusable
        // distance columns without clearing a whole City between bounds.
        let mut descend = |rank: u32| {
            let node = rank as usize;
            let mut cost = work.up_cost[node];
            for arc in first[node]..first[node + 1] {
                let to = heads[arc as usize];
                let candidate = work.down_cost[to as usize] + costs.1.arc(arc as usize);
                if candidate < cost {
                    cost = candidate;
                }
            }
            work.down_cost[node] = cost;
        };
        if let Some(targets) = targets {
            for &rank in self.search_space(targets.iter().copied()).iter().rev() {
                descend(rank);
            }
        } else {
            for rank in (0..self.graph.node_count() as u32).rev() {
                descend(rank);
            }
        }
    }

    // Only ranks within this budget can constrain a terminal or a timed
    // movement. Push down from finite ranks instead of pulling every arc in
    // the City. Nonnegative weights make an out-of-budget bound conclusive.
    fn bounds<M: ArcCosts>(
        &self,
        starts: &[(u32, f64)],
        work: &mut Workspace,
        costs: (M, M),
        maximum: f64,
    ) {
        self.ascend(starts, work, costs.0);
        work.down_cost.fill(f64::INFINITY);
        let maximum = maximum * (1. + 1e-8) + 1e-6;
        let first = &*self.graph.down_first_out;
        let heads = &*self.graph.down_head;
        let weights = &*self.graph.down_to_up;
        for rank in (0..self.graph.node_count()).rev() {
            let value = work.up_cost[rank].min(work.down_cost[rank]);
            if value > maximum || !value.is_finite() {
                continue;
            }
            work.down_cost[rank] = value;
            for arc in first[rank] as usize..first[rank + 1] as usize {
                let candidate = value + costs.1.arc(weights[arc] as usize);
                let to = heads[arc] as usize;
                if candidate <= maximum && candidate < work.down_cost[to] {
                    work.down_cost[to] = candidate;
                }
            }
        }
    }
}

struct Workspace {
    up_cost: Vec<f64>,
    down_cost: Vec<f64>,
    source_space: Vec<u32>,
}

impl Workspace {
    fn new(nodes: usize) -> Self {
        Self {
            up_cost: vec![f64::INFINITY; nodes],
            down_cost: vec![f64::INFINITY; nodes],
            source_space: Vec::new(),
        }
    }
    fn reset(&mut self) {
        for &node in &self.source_space {
            self.up_cost[node as usize] = f64::INFINITY;
        }
    }
}

fn trace(label: &str, fields: impl FnOnce() -> serde_json::Value) {
    if std::env::var_os("VIGO_BIKE_TRACE").is_some() {
        eprintln!("{label} {}", fields());
    }
}
fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.
}

trait ArcCosts: Copy {
    fn arc(self, index: usize) -> f64;
}
impl ArcCosts for &[f64] {
    #[inline]
    fn arc(self, index: usize) -> f64 {
        self[index]
    }
}
impl ArcCosts for &[u32] {
    #[inline]
    fn arc(self, index: usize) -> f64 {
        let units = self[index];
        if units == u32::MAX {
            f64::INFINITY
        } else {
            f64::from(units) / 1024.
        }
    }
}

// Physical and wait-price bounds can only rule out routes. Quantize these
// shortcut weights downward; the preference metrics that pick a path and
// the original movement values that report its time remain unrounded.
struct LowerBounds {
    up: index::Column<u32>,
    down: index::Column<u32>,
}
impl LowerBounds {
    fn new(weights: Weights) -> Self {
        let encode = |arcs: Arcs| {
            arcs.costs
                .iter()
                .map(|&cost| {
                    if cost.is_finite() {
                        ((cost * 1024.) as u32).min(u32::MAX - 1)
                    } else {
                        u32::MAX
                    }
                })
                .collect::<Vec<_>>()
                .into()
        };
        Self {
            up: encode(weights.up),
            down: encode(weights.down),
        }
    }
    fn directions(&self, reverse: bool) -> (&[u32], &[u32]) {
        if reverse {
            (&self.down, &self.up)
        } else {
            (&self.up, &self.down)
        }
    }
    fn read(reader: &mut index::Reader, arcs: usize) -> std::io::Result<Self> {
        Ok(Self {
            up: reader.column(Some(arcs))?,
            down: reader.column(Some(arcs))?,
        })
    }
    #[cfg(feature = "standalone")]
    fn write(&self, writer: &mut index::Writer) -> std::io::Result<()> {
        writer.column(&self.up)?;
        writer.column(&self.down)
    }
}

// Allowing private and scheduled movements changes only some shortcuts.
// Keep one exact scalar metric and store the differing minima and witnesses.
#[derive(Clone, Copy, Default)]
struct PatchPage {
    bits: u64,
    first: u32,
}

struct ArcPatches {
    pages: Vec<PatchPage>,
    ids: index::Column<u32>,
    costs: index::Column<f64>,
    witness: index::Column<u32>,
}

impl ArcPatches {
    fn pack(base: &Arcs, allowed: Arcs) -> Self {
        let n = base.costs.len();
        let mut ids = Vec::new();
        let mut costs = Vec::new();
        let mut witness = Vec::new();
        for i in 0..n {
            if base.costs[i].to_bits() != allowed.costs[i].to_bits()
                || base.witness[i] != allowed.witness[i]
            {
                ids.push(i as u32);
                costs.push(allowed.costs[i]);
                witness.push(allowed.witness[i]);
            }
        }
        Self::layout(n, ids.into(), costs.into(), witness.into()).expect("ordered patch arcs")
    }

    fn layout(
        n: usize,
        ids: index::Column<u32>,
        costs: index::Column<f64>,
        witness: index::Column<u32>,
    ) -> std::io::Result<Self> {
        if ids.last().is_some_and(|&last| last as usize >= n)
            || ids.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(std::io::Error::other(
                "Invalid bicycle shortcut patch layout",
            ));
        }
        let mut pages = if ids.is_empty() {
            Vec::new()
        } else {
            vec![PatchPage::default(); n.div_ceil(64)]
        };
        for (i, &id) in ids.iter().enumerate() {
            let page = &mut pages[id as usize / 64];
            if page.bits == 0 {
                page.first = i as u32;
            }
            page.bits |= 1 << (id % 64);
        }
        Ok(Self {
            pages,
            ids,
            costs,
            witness,
        })
    }

    #[inline]
    fn slot(&self, arc: usize) -> Option<usize> {
        let page = self.pages[arc / 64];
        let bit = 1 << (arc % 64);
        (page.bits & bit != 0)
            .then(|| page.first as usize + (page.bits & (bit - 1)).count_ones() as usize)
    }

    fn read(reader: &mut index::Reader, n: usize) -> std::io::Result<Self> {
        let ids = reader.column(None)?;
        let count = ids.len();
        let costs = reader.column(Some(count))?;
        let witness = reader.column(Some(count))?;
        Self::layout(n, ids, costs, witness)
    }

    #[cfg(feature = "standalone")]
    fn write(&self, writer: &mut index::Writer) -> std::io::Result<()> {
        writer.column(&self.ids)?;
        writer.column(&self.costs)?;
        writer.column(&self.witness)
    }
}

#[derive(Clone, Copy)]
struct ArcView<'a> {
    costs: &'a [f64],
    witness: &'a [u32],
    patches: Option<&'a ArcPatches>,
}
impl<'a> ArcView<'a> {
    fn new(arcs: &'a Arcs, patches: Option<&'a ArcPatches>) -> Self {
        Self {
            costs: &arcs.costs,
            witness: &arcs.witness,
            patches: patches.filter(|p| !p.ids.is_empty()),
        }
    }
    #[inline]
    fn values(self, arc: usize) -> (f64, u32) {
        if let Some(patch) = self.patches
            && let Some(slot) = patch.slot(arc)
        {
            (patch.costs[slot], patch.witness[slot])
        } else {
            (self.costs[arc], self.witness[arc])
        }
    }
}
impl ArcCosts for ArcView<'_> {
    #[inline]
    fn arc(self, arc: usize) -> f64 {
        if let Some(patch) = self.patches
            && let Some(slot) = patch.slot(arc)
        {
            patch.costs[slot]
        } else {
            self.costs[arc]
        }
    }
}

struct PreferencePatches {
    up: ArcPatches,
    down: ArcPatches,
}
impl PreferencePatches {
    fn new(base: &Hierarchy, allowed: Weights) -> Self {
        Self {
            up: ArcPatches::pack(&base.up, allowed.up),
            down: ArcPatches::pack(&base.down, allowed.down),
        }
    }
    fn directions<'a>(&'a self, base: &'a Hierarchy, reverse: bool) -> (ArcView<'a>, ArcView<'a>) {
        let up = ArcView::new(&base.up, Some(&self.up));
        let down = ArcView::new(&base.down, Some(&self.down));
        if reverse { (down, up) } else { (up, down) }
    }
    fn read(reader: &mut index::Reader, n: usize) -> std::io::Result<Self> {
        Ok(Self {
            up: ArcPatches::read(reader, n)?,
            down: ArcPatches::read(reader, n)?,
        })
    }
    #[cfg(feature = "standalone")]
    fn write(&self, writer: &mut index::Writer) -> std::io::Result<()> {
        self.up.write(writer)?;
        self.down.write(writer)
    }
}

struct Weights {
    up: Arcs,
    down: Arcs,
}
impl Weights {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep hierarchy query inputs explicit."
    )]
    fn prepare(
        kernel: &BikeKernel,
        movements: &MovementGraph,
        graph: &RankGraph,
        options: BikeOptions,
        elapsed: bool,
        rebate: f64,
        retain_witness: bool,
        steady: bool,
    ) -> Self {
        Self::weighted(
            kernel,
            movements,
            graph,
            options,
            retain_witness,
            steady,
            |road| {
                let (seconds, price) = kernel.metric(road, options);
                kernel.distances[road as usize] as f64 / 100.
                    * if elapsed {
                        seconds
                    } else {
                        (price - rebate * seconds).max(0.)
                    }
            },
        )
    }

    fn distance(
        kernel: &BikeKernel,
        movements: &MovementGraph,
        graph: &RankGraph,
        options: BikeOptions,
    ) -> Self {
        Self::weighted(kernel, movements, graph, options, true, true, |road| {
            kernel.distances[road as usize] as f64 / 100.
        })
    }

    fn weighted(
        kernel: &BikeKernel,
        movements: &MovementGraph,
        graph: &RankGraph,
        options: BikeOptions,
        retain_witness: bool,
        steady: bool,
        weight: impl Fn(u32) -> f64,
    ) -> Self {
        let n = graph.cch_arc_count();
        let create = || Arcs {
            costs: vec![f64::INFINITY; n].into(),
            witness: if retain_witness {
                vec![NONE; n]
            } else {
                vec![]
            }
            .into(),
        };
        let mut up = create();
        let mut down = create();
        Hierarchy::customize_into(
            graph, &mut up, &mut down, kernel, movements, options, weight, steady,
        );
        Self { up, down }
    }

    fn read(reader: &mut index::Reader, count: usize, witness: bool) -> std::io::Result<Self> {
        let mut read_arc = || {
            Ok::<_, std::io::Error>(Arcs {
                costs: reader.column(Some(count))?,
                witness: reader.column(Some(if witness { count } else { 0 }))?,
            })
        };
        Ok(Self {
            up: read_arc()?,
            down: read_arc()?,
        })
    }

    fn write(up: &Arcs, down: &Arcs, writer: &mut index::Writer) -> std::io::Result<()> {
        for arc in [up, down] {
            writer.column(&arc.costs)?;
            writer.column(&arc.witness)?;
        }
        Ok(())
    }
}

pub(crate) struct PreparedTopology {
    movements: std::sync::Arc<MovementGraph>,
    graph: std::sync::Arc<RankGraph>,
    published: std::sync::atomic::AtomicBool,
}
fn together<A: Send, B: Send>(
    first: impl FnOnce() -> A + Send,
    second: impl FnOnce() -> B + Send,
) -> (A, B) {
    if let Some(pool) = crate::ENDPOINT_ACCESS_POOL.as_ref() {
        pool.install(|| rayon::join(first, second))
    } else {
        (first(), second())
    }
}
struct Prepared {
    movements: std::sync::Arc<MovementGraph>,
    hierarchy: Hierarchy,
    physical: std::sync::OnceLock<LowerBounds>,
    optimistic: std::sync::OnceLock<PreferencePatches>,
    dual: std::sync::OnceLock<LowerBounds>,
    timings: [f64; 5],
    maximum_price_rate: f64,
    published: std::sync::atomic::AtomicBool,
}
fn metric_key(options: BikeOptions) -> (&'static str, [u8; 10]) {
    let mut key = [0; 10];
    key[..8].copy_from_slice(&options.speed_kph.to_bits().to_le_bytes());
    key[8] = options.max_lts.unwrap_or(u8::MAX);
    key[9] = 3; // packed bounds and exact shortcut patches
    (
        match options.profile {
            Profile::Balanced => "balanced",
            Profile::Fast => "fast",
            Profile::Quiet => "quiet",
        },
        key,
    )
}
impl Prepared {
    fn new(kernel: &BikeKernel, options: BikeOptions) -> Result<Self, String> {
        let (topology, movement_ms, order_ms, topology_ms) =
            if let Some(topology) = kernel.cch_topology.get() {
                (topology.clone(), 0., 0., 0.)
            } else {
                let t = Instant::now();
                let movements = std::sync::Arc::new(MovementGraph::new(kernel)?);
                let movement_ms = ms(t);
                let t = Instant::now();
                let mapped = kernel.cch_index().and_then(|store| {
                    let mut reader = store.open("topology", &[]).ok()?;
                    let graph = RankGraph::read(&mut reader).ok()?;
                    (reader.finish().is_ok() && graph.matches(&movements)).then_some(graph)
                });
                let (graph, order_ms, topology_ms) = if let Some(graph) = mapped {
                    (graph, 0., ms(t))
                } else {
                    let t = Instant::now();
                    let order = projected_order(kernel, &movements)?;
                    let order_ms = ms(t);
                    let t = Instant::now();
                    (
                        RankGraph::from(cch::Cch::build(&movements.input, &order)),
                        order_ms,
                        ms(t),
                    )
                };
                let mapped = graph.rank.mapped();
                let graph = std::sync::Arc::new(graph);
                let topology = std::sync::Arc::new(PreparedTopology {
                    movements,
                    graph,
                    published: std::sync::atomic::AtomicBool::new(mapped),
                });
                let _ = kernel.cch_topology.set(topology.clone());
                (topology, movement_ms, order_ms, topology_ms)
            };
        let movements = topology.movements.clone();
        let graph = topology.graph.clone();
        if graph.rank.mapped()
            && let Some(store) = kernel.cch_index()
            && let Ok(loaded) = Self::open(
                store,
                options,
                &topology,
                [movement_ms, order_ms, topology_ms, 0., 0.],
            )
        {
            return Ok(loaded);
        }
        let t = Instant::now();
        let steady = Weights::prepare(kernel, &movements, &graph, options, false, 0., true, true);
        let preferred_ms = ms(t);
        let hierarchy = Hierarchy {
            graph,
            up: steady.up,
            down: steady.down,
        };
        let maximum_price_rate = (0..kernel.targets.len() as u32)
            .filter(|&edge| kernel.allowed_edge(edge, options))
            .map(|edge| {
                let (seconds, price) = kernel.metric(edge, options);
                price / seconds
            })
            .fold(1., f64::max);
        Ok(Self {
            movements,
            hierarchy,
            physical: std::sync::OnceLock::new(),
            optimistic: std::sync::OnceLock::new(),
            dual: std::sync::OnceLock::new(),
            maximum_price_rate,
            published: std::sync::atomic::AtomicBool::new(false),
            timings: [movement_ms, order_ms, topology_ms, 0., preferred_ms],
        })
    }

    fn open(
        store: &index::Store,
        options: BikeOptions,
        topology: &PreparedTopology,
        mut timings: [f64; 5],
    ) -> std::io::Result<Self> {
        let opened = Instant::now();
        let (kind, key) = metric_key(options);
        let graph = topology.graph.clone();
        let n = graph.cch_arc_count();
        let mut reader = store.open(kind, &key)?;
        let maximum_price_rate = reader.column::<f64>(Some(1))?[0];
        let physical = LowerBounds::read(&mut reader, n)?;
        let steady = Weights::read(&mut reader, n, true)?;
        let optimistic = PreferencePatches::read(&mut reader, n)?;
        let dual = LowerBounds::read(&mut reader, n)?;
        reader.finish()?;
        timings[3] = ms(opened);
        Ok(Self {
            movements: topology.movements.clone(),
            hierarchy: Hierarchy {
                graph,
                up: steady.up,
                down: steady.down,
            },
            physical: std::sync::OnceLock::from(physical),
            optimistic: std::sync::OnceLock::from(optimistic),
            dual: std::sync::OnceLock::from(dual),
            timings,
            maximum_price_rate,
            published: std::sync::atomic::AtomicBool::new(true),
        })
    }

    fn publish(&self, kernel: &BikeKernel, options: BikeOptions) -> std::io::Result<()> {
        use std::sync::atomic::Ordering;
        let Some(store) = kernel.cch_index() else {
            return Ok(());
        };
        if self.published.load(Ordering::Relaxed) {
            if let Some(walking) = &kernel.walking {
                walking.publish_hierarchy(store)?;
            }
            return Ok(());
        }
        let topology = kernel.cch_topology.get().expect("prepared topology");
        if !topology.published.load(Ordering::Relaxed) {
            store.publish("topology", &[], |writer| topology.graph.write(writer))?;
            topology.published.store(true, Ordering::Relaxed);
        }
        let (kind, key) = metric_key(options);
        let (physical, optimistic) = together(
            || self.physical(kernel, options),
            || self.optimistic(kernel, options),
        );
        let dual = self.dual(kernel, options);
        store.publish(kind, &key, |writer| {
            writer.column(&[self.maximum_price_rate])?;
            physical.write(writer)?;
            Weights::write(&self.hierarchy.up, &self.hierarchy.down, writer)?;
            optimistic.write(writer)?;
            dual.write(writer)
        })?;
        self.published.store(true, Ordering::Relaxed);
        if let Some(walking) = &kernel.walking {
            walking.publish_hierarchy(store)?;
        }
        Ok(())
    }

    fn physical(&self, kernel: &BikeKernel, options: BikeOptions) -> &LowerBounds {
        self.physical.get_or_init(|| {
            LowerBounds::new(Weights::prepare(
                kernel,
                &self.movements,
                &self.hierarchy.graph,
                options,
                true,
                0.,
                false,
                false,
            ))
        })
    }

    fn optimistic(&self, kernel: &BikeKernel, options: BikeOptions) -> &PreferencePatches {
        self.optimistic.get_or_init(|| {
            PreferencePatches::new(
                &self.hierarchy,
                Weights::prepare(
                    kernel,
                    &self.movements,
                    &self.hierarchy.graph,
                    options,
                    false,
                    0.,
                    true,
                    false,
                ),
            )
        })
    }

    fn dual(&self, kernel: &BikeKernel, options: BikeOptions) -> &LowerBounds {
        self.dual.get_or_init(|| {
            let rate = if matches!(options.profile, Profile::Fast) {
                1.
            } else {
                0.8
            };
            LowerBounds::new(Weights::prepare(
                kernel,
                &self.movements,
                &self.hierarchy.graph,
                options,
                false,
                rate * 0.5,
                false,
                false,
            ))
        })
    }
}

pub(crate) struct PreparedSlot {
    key: (u8, u64, Option<u8>),
    data: std::sync::Arc<Prepared>,
}

impl BikeKernel {
    fn cch_index(&self) -> Option<&index::Store> {
        if let Some(store) = self.cch_index.get() {
            return Some(store);
        }
        let _ = self.cch_index.set(self.cch_source.as_ref()?.store(None)?);
        self.cch_index.get()
    }

    fn hierarchy(&self, options: BikeOptions) -> Result<(std::sync::Arc<Prepared>, bool), String> {
        let key = (
            options.profile as u8,
            options.speed_kph.to_bits(),
            options.max_lts,
        );
        let mut slot = self
            .cch_prepared
            .lock()
            .map_err(|_| "Bicycle hierarchy preparation lock failed")?;
        if let Some(prepared) = slot.as_ref().filter(|slot| slot.key == key) {
            return Ok((prepared.data.clone(), true));
        }
        *slot = None;
        let data = std::sync::Arc::new(Prepared::new(self, options)?);
        *slot = Some(PreparedSlot {
            key,
            data: data.clone(),
        });
        Ok((data, false))
    }

    #[cfg(feature = "standalone")]
    pub(crate) fn hierarchy_memory(&self) -> (usize, usize) {
        let (mut heap, mut mapped) = self.cch_topology.get().map_or((0, 0), |topology| {
            let graph = &topology.movements;
            let movement_bytes = 4
                * (graph.input.first_out.capacity()
                    + graph.input.head.capacity()
                    + graph.roads.capacity())
                + graph.dynamic.capacity()
                + graph.private.capacity() * std::mem::size_of::<(u32, u32)>()
                + graph.timed.capacity()
                    * std::mem::size_of::<(u32, u32, std::ops::Range<usize>)>()
                + graph.states.extra.capacity()
                    * std::mem::size_of::<arrival_states::ArrivalState>()
                + graph.states.ids.capacity() * 17
                + graph
                    .states
                    .turns
                    .iter()
                    .map(|turn| turn.capacity() * 12)
                    .sum::<usize>();
            (
                topology.graph.heap_bytes() + movement_bytes,
                topology.graph.rank.mapped_file_bytes(),
            )
        });
        if let Ok(slot) = self.cch_prepared.lock()
            && let Some(slot) = slot.as_ref()
        {
            let p = &slot.data;
            heap += [&p.hierarchy.up, &p.hierarchy.down]
                .into_iter()
                .map(|arcs| 8 * arcs.costs.capacity() + 4 * arcs.witness.capacity())
                .sum::<usize>();
            heap += [p.physical.get(), p.dual.get()]
                .into_iter()
                .flatten()
                .map(|bounds| 4 * (bounds.up.capacity() + bounds.down.capacity()))
                .sum::<usize>();
            if let Some(patches) = p.optimistic.get() {
                heap += [&patches.up, &patches.down]
                    .into_iter()
                    .map(|arc| {
                        arc.pages.capacity() * std::mem::size_of::<PatchPage>()
                            + 4 * (arc.ids.capacity() + arc.witness.capacity())
                            + 8 * arc.costs.capacity()
                    })
                    .sum::<usize>();
            }
            mapped += p.hierarchy.up.costs.mapped_file_bytes();
        }
        if let Some(walk) = &self.walking {
            let (walk_heap, walk_mapped) = walk.hierarchy_memory();
            heap += walk_heap;
            mapped += walk_mapped;
        }
        (heap, mapped + self.lons.mapped_file_bytes())
    }

    #[cfg(feature = "standalone")]
    pub(crate) fn prepare_cch(&self, options: BikeOptions) -> Result<(), String> {
        options.validate()?;
        let (prepared, _) = self.hierarchy(options)?;
        // Preparing a City can publish a source-matched index. Read-only
        // cache directories do not change the routing algorithm or results.
        let _ = prepared.publish(self, options);
        Ok(())
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep hierarchy query inputs explicit."
)]
fn reduce_terminals(
    kernel: &BikeKernel,
    ends: &SurfaceEnds,
    options: BikeOptions,
    movements: &MovementGraph,
    hierarchy: &Hierarchy,
    nodes: &[u32],
    admitted: &[bool],
    values: &scoped::RankedValues,
    masks: &SurfaceMasks,
    uniform_group: Option<usize>,
) -> Vec<(f64, u32, usize)> {
    let graph = kernel.graph();
    let mut winners = vec![(f64::INFINITY, NONE, 0usize); ends.attachments.len()];
    for &node in nodes {
        let variants: smallvec::SmallVec<[u32; 4]> = movements.states.variants(node).collect();
        for &end in &ends.entries
            [ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
        {
            let cell = end.target as usize;
            let i = end.index();
            let distance = |state: u32| {
                let rank = hierarchy.graph.rank[state as usize];
                (
                    values.cost(rank, uniform_group.unwrap_or(ends.groups[cell]), masks),
                    rank,
                )
            };
            let (prefix, rank, partial) = if end.zero() {
                let (cost, rank) = variants
                    .iter()
                    .copied()
                    .map(distance)
                    .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
                    .unwrap();
                (cost, rank, 0.)
            } else {
                let b = ends.attachments[cell].candidate(&graph, i);
                let best = variants
                    .iter()
                    .copied()
                    .filter(|&state| {
                        let range = movements.input.first_out[state as usize] as usize
                            ..movements.input.first_out[state as usize + 1] as usize;
                        range
                            .into_iter()
                            .any(|j| movements.roads[j] == b.edge && admitted[j])
                    })
                    .map(distance)
                    .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                let Some((prefix, rank)) = best else {
                    continue;
                };
                (
                    prefix,
                    rank,
                    b.drive_meters * kernel.metric(b.edge, options).1,
                )
            };
            let cost = prefix + end.walk_seconds + partial;
            if (cost, i) < (winners[cell].0, winners[cell].2) {
                winners[cell] = (cost, rank, i);
            }
        }
    }
    winners
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep hierarchy query inputs explicit."
)]
pub(super) fn measure(
    kernel: &BikeKernel,
    starts: &Attachment,
    ends: &SurfaceEnds,
    origin_access: &HashSet<u32>,
    options: BikeOptions,
    clock: Option<BikeClock>,
    distance_limit: f64,
    cutoff: f64,
    walk_speed_kph: f64,
    attachment_ms: f64,
) -> Result<Vec<f64>, String> {
    let (prepared, resident) = kernel.hierarchy(options)?;
    let movements = &prepared.movements;
    let hierarchy = &prepared.hierarchy;
    let [
        movement_ms,
        order_ms,
        topology_ms,
        earliest_customization_ms,
        preferred_customization_ms,
    ] = if resident { [0.; 5] } else { prepared.timings };
    let physical = prepared.physical(kernel, options);
    let graph = kernel.graph();
    let rate = if matches!(options.profile, Profile::Fast) {
        1.
    } else {
        0.8
    };
    let maximum_speed = walk_speed_kph.max(45.) / 3.6;
    // A route that fits inside the requested time has cost at most
    // the largest per-second preference price times that time. Tighten
    // individual ceilings with the valid stationary paths below.
    let cutoff_cap = cutoff * prepared.maximum_price_rate * (1. + 1e-9);
    let mut earliest_sources = Vec::with_capacity(starts.candidates.len());
    let mut lower_sources = Vec::with_capacity(starts.candidates.len());
    let mut lower_attachments = Vec::with_capacity(starts.candidates.len());
    let mut sources = Vec::with_capacity(starts.candidates.len());
    for index in 0..starts.candidates.len() {
        let a = starts.candidate(&graph, index);
        let incoming = if a.drive_meters > 1e-7 {
            incoming_state(kernel, a.edge)
        } else {
            NONE
        };
        let (seconds, price) = kernel.metric(a.edge, options);
        let first = kernel
            .start_movements(&a, a.drive_meters, None, clock, MovementPolicy::Wait, false)?
            .first;
        if let Some((departure, history)) = first {
            sources.push((
                state_id(&movements.states, a.node, incoming, &history),
                a.walk_seconds + a.drive_meters * price + (departure - a.walk_seconds) * rate,
            ));
        } else {
            // Preserve the origin attachment index for witness replay.
            sources.push((a.node, f64::INFINITY));
        }
        let mut push_lower = |state| {
            earliest_sources.push((state, a.walk_seconds + a.drive_meters * seconds));
            lower_sources.push((state, a.walk_seconds + a.drive_meters * price));
            lower_attachments.push(index);
        };
        if a.drive_meters > 1e-7 {
            let start = kernel.source(a.edge) as usize;
            for input in movements.input.first_out[start] as usize
                ..movements.input.first_out[start + 1] as usize
            {
                if movements.roads[input] == a.edge {
                    push_lower(movements.input.head[input]);
                }
            }
        } else {
            push_lower(a.node);
        }
    }
    let mut nodes: Vec<_> = ends
        .offsets
        .windows(2)
        .enumerate()
        .filter_map(|(node, range)| (range[0] != range[1]).then_some(node as u32))
        .collect();
    let mut targets: Vec<_> = nodes
        .iter()
        .flat_map(|&node| movements.states.variants(node))
        .collect();
    let mut workspace = Workspace::new(hierarchy.graph.node_count());
    let before = Instant::now();
    let event_states: Vec<_> = movements.timed.iter().map(|event| event.0).collect();
    hierarchy.bounds(
        &earliest_sources,
        &mut workspace,
        physical.directions(false),
        cutoff_cap / rate,
    );
    let earliest_at: Vec<_> = event_states
        .iter()
        .map(|&state| {
            workspace.down_cost[hierarchy.graph.rank[state as usize] as usize] * (1. - 1e-9)
        })
        .collect();
    let lower_start: Vec<_> = workspace
        .down_cost
        .iter()
        .map(|value| value * (1. - 1e-9))
        .collect();
    // If even the optimistic travel-time metric cannot reach a cell before
    // the cutoff, that cell cannot constrain any preference path or gate.
    let mut possible = vec![false; ends.attachments.len()];
    for &node in &nodes {
        let earliest = movements
            .states
            .variants(node)
            .map(|state| lower_start[hierarchy.graph.rank[state as usize] as usize])
            .fold(f64::INFINITY, f64::min);
        for &end in &ends.entries
            [ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
        {
            let cell = end.target as usize;
            let ride = if end.zero() {
                0.
            } else {
                let b = ends.attachments[cell].candidate(&graph, end.index());
                b.drive_meters * kernel.metric(b.edge, options).0
            };
            possible[cell] |= earliest + (ride + end.walk_seconds) * (1. - 1e-9) <= cutoff;
        }
    }
    for &(cell, a, b) in &ends.direct {
        let a = starts.candidate(&graph, a);
        let b = ends.attachments[cell].candidate(&graph, b);
        if a.fraction <= b.fraction {
            let length =
                (b.fraction - a.fraction) * kernel.distances[a.edge as usize] as f64 / 100.;
            possible[cell] |=
                (a.walk_seconds + b.walk_seconds + length * kernel.metric(a.edge, options).0)
                    * (1. - 1e-9)
                    <= cutoff;
        }
    }
    let preparing = Instant::now();
    let optimistic = prepared.optimistic(kernel, options);
    let optimistic_prep_ms = ms(preparing);
    let certifying = Instant::now();
    let verified = certify::Query {
        kernel,
        starts,
        ends,
        origin_access,
        movements,
        hierarchy,
        weights: optimistic,
        nodes: &nodes,
        targets: &targets,
        lower_sources: &lower_sources,
        source_attachments: &lower_attachments,
        clock,
        options,
        maximum_meters: distance_limit,
    }
    .certify(&possible, cutoff)?;
    let certified = verified.iter().filter(|v| v.is_some()).count();
    let certificate_ms = ms(certifying);
    for (active, result) in possible.iter_mut().zip(&verified) {
        *active &= result.is_none();
    }
    nodes.retain(|&node| {
        ends.entries[ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
            .iter()
            .any(|terminal| possible[terminal.target as usize])
    });
    targets = nodes
        .iter()
        .flat_map(|&node| movements.states.variants(node))
        .collect();
    hierarchy.bounds(
        &lower_sources,
        &mut workspace,
        optimistic.directions(hierarchy, false),
        cutoff_cap,
    );
    let lower_start_price: Vec<_> = workspace
        .down_cost
        .iter()
        .map(|value| value * (1. - 1e-9))
        .collect();
    let earliest_scope_ms = ms(before);
    let mut masks = SurfaceMasks::new(ends.permissions.len());
    let permissions = ends.permissions_for(origin_access, 0, ends.permissions.len(), &mut masks);
    let mut metric = scoped::Metric::new(hierarchy, &masks);
    let private: Vec<_> = movements
        .private
        .iter()
        .filter_map(|&(component, index)| {
            if movements.dynamic[index as usize] {
                return None;
            }
            permissions
                .get(&component)
                .copied()
                .map(|scope| (index, scope))
        })
        .collect();
    let before = Instant::now();
    let mut admitted: Vec<bool> = movements.dynamic.iter().map(|&dynamic| !dynamic).collect();
    let feasible = metric.solve(&sources, &targets, &mut masks);
    let feasible = reduce_terminals(
        kernel, ends, options, movements, hierarchy, &nodes, &admitted, &feasible, &masks, None,
    );
    let bounds: Vec<_> = feasible
        .iter()
        .map(|&(cost, _, _)| {
            if distance_limit >= cost / rate * maximum_speed {
                cutoff_cap.min(cost * (1. + 1e-9))
            } else {
                cutoff_cap
            }
        })
        .collect();
    let cap = bounds
        .iter()
        .zip(&possible)
        .filter_map(|(&cost, &active)| active.then_some(cost))
        .fold(0., f64::max);
    let horizon = cap / rate;
    let constrained = distance_limit < horizon * maximum_speed;
    let mut reverse_sources = Vec::new();
    for &node in &nodes {
        let mut best = f64::INFINITY;
        for &end in &ends.entries
            [ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
        {
            let cell = end.target as usize;
            if !possible[cell] {
                continue;
            }
            let terminal = if end.zero() {
                0.
            } else {
                let b = ends.attachments[cell].candidate(&graph, end.index());
                b.drive_meters * kernel.metric(b.edge, options).1
            };
            best = best.min((cap - bounds[cell]).max(0.) + end.walk_seconds + terminal);
        }
        if best.is_finite() {
            reverse_sources.extend(movements.states.variants(node).map(|state| (state, best)));
        }
    }
    hierarchy.bounds(
        &reverse_sources,
        &mut workspace,
        optimistic.directions(hierarchy, true),
        cap,
    );
    let mut extra = Vec::new();
    let mut gates = Vec::new();
    let all = masks.all;
    for ((from, road, range), earliest) in movements.timed.iter().zip(earliest_at) {
        let length = kernel.distances[*road as usize] as f64 / 100.;
        let movement_cost = length * kernel.metric(*road, options).1;
        let node = movements.states.state(*from).node as usize;
        let mut partial = f64::INFINITY;
        {
            for &terminal in
                &ends.entries[ends.offsets[node] as usize..ends.offsets[node + 1] as usize]
            {
                let cell = terminal.target as usize;
                if possible[cell]
                    && !terminal.zero()
                    && ends.attachments[cell].candidates[terminal.index()].edge == *road
                {
                    let b = ends.attachments[cell].candidate(&graph, terminal.index());
                    partial = partial.min(
                        (cap - bounds[cell])
                            + b.walk_seconds
                            + b.drive_meters * kernel.metric(*road, options).1,
                    );
                }
            }
        }
        for index in range.clone() {
            let to = movements.input.head[index];
            let remaining = workspace.down_cost[hierarchy.graph.rank[to as usize] as usize] / rate
                * (1. - 1e-9);
            let latest =
                (horizon - remaining - movement_cost / rate).max(horizon - partial / rate) + 1e-6;
            let (successors, _, stable) = possible_successors(
                kernel,
                &movements.states,
                *from,
                *road,
                clock,
                earliest,
                latest,
            )?;
            if successors.contains(&to) {
                admitted[index] = true;
                let scope = if kernel.attributes[*road as usize] & (1 << 22) != 0 {
                    let component = kernel.destination_components[kernel.source(*road) as usize];
                    permissions.get(&component).copied().unwrap_or(0)
                } else {
                    all
                };
                if stable != Some(to) {
                    admitted[index] = false;
                    if scope != 0 {
                        gates.push(temporal::Gate {
                            input: index as u32,
                            from: *from,
                            original_from: *from,
                            scope,
                        });
                    }
                } else {
                    extra.push((index as u32, scope));
                }
            }
        }
    }
    let bound_ms = ms(before);
    let lower_remaining: Vec<_> = workspace
        .down_cost
        .iter()
        .map(|value| value / rate * (1. - 1e-9))
        .collect();
    let before = Instant::now();
    let corridor = scoped::Corridor {
        start: &lower_start_price,
        remaining: &lower_remaining,
        cap,
        start_scale: 1.,
        remaining_scale: rate,
    };
    metric.admit(
        kernel,
        movements,
        options,
        private.into_iter().chain(extra),
        &mut masks,
        &corridor,
    );
    let sparse_customization_ms = ms(before);
    let mut post_gate_roots = Vec::new();
    let mut partial_gate_endings = vec![(f64::INFINITY, f64::INFINITY); ends.attachments.len()];
    let gates_before_proof = gates.len();
    let before = Instant::now();
    if !gates.is_empty() || constrained {
        // Lower the price ceilings with the clock-stable paths already
        // computed by the hierarchy. No value from the oracle is used.
        let steady_values = metric.solve(&sources, &targets, &mut masks);
        let steady = reduce_terminals(
            kernel,
            ends,
            options,
            movements,
            hierarchy,
            &nodes,
            &admitted,
            &steady_values,
            &masks,
            None,
        );
        let refined: Vec<_> = bounds
            .iter()
            .zip(steady)
            .map(|(&bound, (cost, _, _))| {
                if distance_limit >= cost / rate * maximum_speed {
                    bound.min(cost * (1. + 1e-9))
                } else {
                    bound
                }
            })
            .collect();
        let mut sinks = Vec::new();
        for &node in &nodes {
            let mut best = f64::INFINITY;
            for &terminal in &ends.entries
                [ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
            {
                let cell = terminal.target as usize;
                if !possible[cell] {
                    continue;
                }
                let road_cost = if terminal.zero() {
                    0.
                } else {
                    let b = ends.attachments[cell].candidate(&graph, terminal.index());
                    b.drive_meters * kernel.metric(b.edge, options).1
                };
                best = best.min(cap - refined[cell] + terminal.walk_seconds + road_cost);
            }
            if best.is_finite() {
                sinks.extend(movements.states.variants(node).map(|state| (state, best)));
            }
        }
        let origins: Vec<_> = gates.iter().map(|gate| gate.from).collect();
        let exits: Vec<_> = gates
            .iter()
            .map(|gate| movements.input.head[gate.input as usize])
            .collect();
        let before_cost: Vec<_> = origins
            .iter()
            .map(|&node| lower_start_price[hierarchy.graph.rank[node as usize] as usize])
            .collect();
        // For any prefix with elapsed t and excess X, both branches of
        // X + rate * max(t, opening) are bounded by
        // X + (rate - rebate) * t + rebate * opening.
        let dual = prepared.dual(kernel, options);
        let rebate = rate * 0.5;
        let dual_sources: Vec<_> = sources
            .iter()
            .enumerate()
            .map(|(i, &(state, _))| {
                let a = starts.candidate(&graph, i);
                let (seconds, price) = kernel.metric(a.edge, options);
                (
                    state,
                    (1. - rebate) * a.walk_seconds
                        + a.drive_meters * (price - rebate * seconds).max(0.),
                )
            })
            .collect();
        hierarchy.solve(
            &dual_sources,
            Some(&origins),
            &mut workspace,
            dual.directions(false),
        );
        let dual_cost: Vec<_> = origins
            .iter()
            .map(|&node| {
                workspace.down_cost[hierarchy.graph.rank[node as usize] as usize] * (1. - 1e-9)
            })
            .collect();
        hierarchy.solve(
            &sinks,
            Some(&exits),
            &mut workspace,
            optimistic.directions(hierarchy, true),
        );
        let mut gate_remaining = Vec::with_capacity(gates.len());
        let mut surviving = Vec::new();
        for ((gate, prefix), dual) in gates.into_iter().zip(before_cost).zip(dual_cost) {
            let state = movements.states.state(gate.from);
            let incoming = (state.incoming != NONE).then_some(state.incoming);
            let history = &movements.states.turns[state.turns as usize];
            let edge = movements.roads[gate.input as usize];
            let to = movements.input.head[gate.input as usize];
            let expected = movements.states.state(to).turns as usize;
            let earliest = lower_start[hierarchy.graph.rank[gate.from as usize] as usize];
            let Some((departure, _)) = kernel
                .movements(
                    history,
                    incoming,
                    state.node,
                    edge,
                    clock,
                    earliest,
                    MovementPolicy::Wait,
                    true,
                )?
                .into_iter()
                .find(|(_, turns)| *turns == movements.states.turns[expected])
            else {
                continue;
            };
            let mut suffix = workspace.down_cost[hierarchy.graph.rank[to as usize] as usize]
                * (1. - 1e-9)
                + kernel.distances[edge as usize] as f64 / 100. * kernel.metric(edge, options).1;
            let node = state.node as usize;
            for &terminal in
                &ends.entries[ends.offsets[node] as usize..ends.offsets[node + 1] as usize]
            {
                let cell = terminal.target as usize;
                if possible[cell]
                    && !terminal.zero()
                    && ends.attachments[cell].candidates[terminal.index()].edge == edge
                {
                    let b = ends.attachments[cell].candidate(&graph, terminal.index());
                    suffix = suffix.min(
                        cap - refined[cell]
                            + b.walk_seconds
                            + b.drive_meters * kernel.metric(edge, options).1,
                    );
                }
            }
            if prefix.max(rate * departure).max(dual + rebate * departure) + suffix
                <= cap * (1. + 1e-8)
            {
                gate_remaining.push(suffix);
                surviving.push(gate);
            }
        }
        gates = surviving;
        let port_states: Vec<_> = gates.iter().map(|gate| gate.from).collect();
        let port_seeds: Vec<_> = gates
            .iter()
            .zip(gate_remaining)
            .map(|(gate, suffix)| (gate.from, suffix))
            .collect();
        let proof_ms = ms(before);
        trace("BIKE_TEMPORAL_HIERARCHY", || {
            serde_json::json!({
                "phase":"gate-proof","initialGates":gates_before_proof,"remainingGates":gates.len(),
                "proofMs":proof_ms,"optimisticMetricPreparationMs":optimistic_prep_ms,
            })
        });
        if !gates.is_empty() || constrained {
            let before_gates: Vec<_> = if constrained {
                lower_remaining.clone()
            } else {
                hierarchy.bounds(
                    &port_seeds,
                    &mut workspace,
                    optimistic.directions(hierarchy, true),
                    cap,
                );
                workspace
                    .down_cost
                    .iter()
                    .map(|value| value / rate * (1. - 1e-9))
                    .collect()
            };
            let states: Vec<_> = if constrained {
                port_states
                    .into_iter()
                    .chain(targets.iter().copied())
                    .collect()
            } else {
                port_states
            };
            drop(workspace);
            let query = temporal::Query {
                kernel,
                movements,
                hierarchy,
                starts,
                ends,
                target_nodes: &nodes,
                target_states: &states,
                options,
                clock,
                rate,
                cap,
                horizon,
                distance_limit,
                maximum_speed,
                permissions: &permissions,
                steady: &admitted,
                reversed: false,
                continuation: None,
                lower_start: &lower_start,
                lower_start_price: &lower_start_price,
                lower_remaining: &before_gates,
            };
            let (roots, terminals) = query.run(&gates, &lower_remaining, &mut masks)?;
            post_gate_roots = roots;
            partial_gate_endings = terminals;
        }
    }
    let mut scopes = vec![masks.all; sources.len()];
    for &(state, root) in &post_gate_roots {
        sources.push((state, rate * root.elapsed + root.excess));
        scopes.push(root.scope);
    }

    let time_scope_ms = earliest_scope_ms + bound_ms;
    trace("BIKE_HIERARCHY", || {
        serde_json::json!({
            "phase":"build","preparedBeforeRequest":resident,"nodes":hierarchy.graph.node_count(),"turnStates":movements.states.extra.len(),
            "roadEdges":kernel.targets.len(),"inputMovements":movements.roads.len(),
            "hierarchyArcs":hierarchy.graph.cch_arc_count(),"movementGraphMs":movement_ms,
            "projectedWalkOrderMs":order_ms,"topologyMs":topology_ms,
            "earliestCustomizationMs":earliest_customization_ms,"preferredCustomizationMs":preferred_customization_ms,
            "metricBytes":hierarchy.graph.cch_arc_count() * 2 * 12,
            "timeScopedMovements":admitted.iter().filter(|&&enabled| !enabled).count(),
            "earliestScopeMs":time_scope_ms,"horizonSeconds":horizon,
            "certificateMs":certificate_ms,"certifiedCells":certified,
            "sparseCustomizationMs":sparse_customization_ms,"changedDirectedShortcuts":metric.changed(),
        })
    });
    let swept = Instant::now();
    let values = metric.solve_scoped(&sources, &scopes, &targets, &mut masks);
    let sweep_ms = ms(swept);
    let t = Instant::now();
    let mut path = Vec::new();
    let winners = reduce_terminals(
        kernel, ends, options, movements, hierarchy, &nodes, &admitted, &values, &masks, None,
    );
    let attachment_reduction_ms = ms(t);
    let t = Instant::now();
    let mut seconds = vec![f64::INFINITY; ends.attachments.len()];
    for (cell, attachment) in ends.attachments.iter().enumerate() {
        if let Some(value) = verified[cell] {
            seconds[cell] = value;
            continue;
        }
        if !possible[cell] {
            continue;
        }
        if constrained {
            let (_, elapsed) = partial_gate_endings[cell];
            if elapsed <= cutoff {
                seconds[cell] = elapsed;
            }
            continue;
        }
        let mut best = winners[cell];
        let mut direct = None;
        let first = ends.direct.partition_point(|&(target, _, _)| target < cell);
        let end = first + ends.direct[first..].partition_point(|&(target, _, _)| target == cell);
        for &(_, a_index, b_index) in &ends.direct[first..end] {
            let a = starts.candidate(&graph, a_index);
            let b = attachment.candidate(&graph, b_index);
            if b.fraction < a.fraction {
                continue;
            }
            let meters =
                (b.fraction - a.fraction) * kernel.distances[a.edge as usize] as f64 / 100.;
            let Some((departure, _)) = kernel
                .start_movements(&a, meters, None, clock, MovementPolicy::Wait, false)?
                .first
            else {
                continue;
            };
            let cost = a.walk_seconds
                + b.walk_seconds
                + meters * kernel.metric(a.edge, options).1
                + rate * (departure - a.walk_seconds);
            if cost < best.0 {
                best = (cost, NONE, b_index);
                direct = Some((a_index, meters));
            }
        }
        let (partial_cost, partial_elapsed) = partial_gate_endings[cell];
        if partial_cost < best.0 {
            if partial_elapsed <= cutoff {
                seconds[cell] = partial_elapsed;
            }
            continue;
        }
        if !best.0.is_finite() || best.0 > cutoff_cap {
            continue;
        }
        let b = attachment.candidate(&graph, best.2);
        let (a_index, partial) = if let Some((index, length)) = direct {
            path.clear();
            (index, Some(length))
        } else {
            (
                metric.path(best.1, ends.groups[cell], &values, &masks, &mut path),
                None,
            )
        };
        let origin = (a_index < starts.candidates.len()).then(|| starts.candidate(&graph, a_index));
        let mut state = TurnState::new();
        let mut incoming = None;
        let (mut elapsed, mut meters) = if let Some(a) = origin {
            (a.walk_seconds, a.walk_meters + b.walk_meters)
        } else {
            let (node, root) = post_gate_roots[a_index - starts.candidates.len()];
            let seed = movements.states.state(node);
            state.clone_from(&movements.states.turns[seed.turns as usize]);
            incoming = (seed.incoming != NONE).then_some(seed.incoming);
            (root.elapsed, root.meters + b.walk_meters)
        };
        let legs = origin
            .map(|a| (a.edge, partial.unwrap_or(a.drive_meters), None))
            .into_iter()
            .chain(path.iter().map(|&input| {
                let edge = movements.roads[input as usize];
                (
                    edge,
                    kernel.distances[edge as usize] as f64 / 100.,
                    Some(input),
                )
            }))
            .chain(partial.is_none().then_some((b.edge, b.drive_meters, None)));
        let mut reason = None;
        for (step, (edge, length, input)) in legs.enumerate() {
            if length <= 1e-7 && input.is_none() {
                continue;
            }
            let expected = input.map(|id| movements.input.head[id as usize]);
            if let Some(id) = input
                && !movements.dynamic[id as usize]
            {
                let turns = movements.states.state(expected.unwrap()).turns;
                state.clone_from(&movements.states.turns[turns as usize]);
                incoming = Some(edge);
                elapsed += length * kernel.metric(edge, options).0;
                meters += length;
                continue;
            }
            let from = kernel.source(edge);
            if kernel.attributes[edge as usize] & (1 << 22) != 0 {
                let component = kernel.destination_components[from as usize];
                if !origin_access.contains(&component)
                    && ends.permissions[ends.groups[cell]]
                        .binary_search(&component)
                        .is_err()
                {
                    reason = Some("private");
                    break;
                }
            }
            let Some((departure, next)) = kernel
                .movements(
                    &state,
                    incoming,
                    from,
                    edge,
                    clock,
                    elapsed,
                    MovementPolicy::Wait,
                    expected.is_some(),
                )?
                .into_iter()
                .find(|(_, next)| {
                    expected.is_none_or(|id| {
                        let turn = movements.states.state(id).turns;
                        movements.states.turns[turn as usize] == *next
                    })
                })
            else {
                reason = Some("illegal_movement");
                break;
            };
            if departure != elapsed && (step != 0 || origin.is_none()) {
                reason = Some("dated_wait");
                break;
            }
            elapsed = departure + length * kernel.metric(edge, options).0;
            meters += length;
            incoming = Some(edge);
            state = next;
        }
        if reason.is_none() && meters > distance_limit {
            reason = Some("distance_limit");
        }
        if let Some(reason) = reason {
            return Err(format!(
                "Could not verify bicycle hierarchy terminal: {reason}"
            ));
        }
        elapsed += b.walk_seconds;
        if elapsed <= cutoff {
            seconds[cell] = elapsed;
        }
    }
    trace("BIKE_HIERARCHY", || {
        serde_json::json!({
            "phase":"query","cells":ends.attachments.len(),"directHierarchyQuery":true,"endpointMs":attachment_ms,
            "hierarchySweepMs":sweep_ms,"attachmentReductionMs":attachment_reduction_ms,"replayMs":ms(t),
            "changingMovements":gates.len(),"gatesBeforeProof":gates_before_proof,"postGateRoots":post_gate_roots.len(),
        })
    });
    Ok(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patched_shortcuts_preserve_exact_costs_and_witnesses_across_pages() {
        let mut source = Vec::new();
        let mut chosen = Vec::new();
        for i in 0..137 {
            let cost = if i % 17 == 0 {
                f64::INFINITY
            } else {
                f64::from(i) / 7.
            };
            source.push((cost, i));
            chosen.push(match i {
                9 | 66 => (0.125, 999),
                63 | 64 | 136 => (cost, 777),
                _ => (cost, i),
            });
        }
        let columns = |items: &[(f64, u32)]| {
            let (costs, witness): (Vec<_>, Vec<_>) = items.iter().copied().unzip();
            Arcs {
                costs: costs.into(),
                witness: witness.into(),
            }
        };
        let base = columns(&source);
        let changes = ArcPatches::pack(&base, columns(&chosen));
        assert_eq!(&*changes.ids, &[9, 63, 64, 66, 136]);
        let view = ArcView::new(&base, Some(&changes));
        for (i, &(cost, witness)) in chosen.iter().enumerate() {
            assert_eq!(view.arc(i).to_bits(), cost.to_bits());
            assert_eq!(view.values(i), (cost, witness));
        }
    }

    #[test]
    fn packed_pruning_weights_never_increase_a_bound_or_reopen_a_missing_arc() {
        let source = vec![0., 0.001, 1. / 3., 90.000001, 4500000., f64::INFINITY];
        let arcs = || Arcs {
            costs: source.clone().into(),
            witness: Vec::new().into(),
        };
        let packed = LowerBounds::new(Weights {
            up: arcs(),
            down: arcs(),
        });
        let (up, down) = packed.directions(false);
        for (i, &value) in source.iter().enumerate() {
            assert!(up.arc(i) <= value);
            assert_eq!(up.arc(i), down.arc(i));
        }
        assert!(up.arc(source.len() - 1).is_infinite());
    }
}
