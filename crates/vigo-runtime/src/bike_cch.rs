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
// Arrival surfaces run only in the standalone runtime.
#[cfg(any(feature = "standalone", test))]
#[path = "bike_hierarchy_reverse.rs"]
pub(super) mod reverse;
#[path = "bike_hierarchy_scoped.rs"]
mod scoped;
#[path = "bike_hierarchy_temporal.rs"]
mod temporal;
#[cfg(test)]
pub(in crate::bike) use temporal::SEARCH_MOVEMENTS;

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
            #[cfg(feature = "standalone")]
            fn heap_bytes(&self) -> usize {
                4 * (0 $(+ self.$column.capacity())+)
            }
        }
    };
}

/// Persisted topology key. Only the upward chordal graph is stored; the
/// elimination tree, downward graph and input-arc maps are derived on open.
const TOPOLOGY_KEY: &[u8] = b"upward-graph-v2";

impl RankGraph {
    fn read(reader: &mut index::Reader, movements: &MovementGraph) -> std::io::Result<Self> {
        let invalid = || {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid bicycle upward hierarchy",
            )
        };
        let rank: index::Column<u32> = reader.column(None)?;
        let up_first_out: index::Column<u32> = reader.column(None)?;
        let up_head: index::Column<u32> = reader.column(None)?;
        let n = rank.len();
        if n + 1 != movements.input.first_out.len() || up_first_out.len() != n + 1 {
            return Err(invalid());
        }
        let mut order = vec![NONE; n];
        for (node, &r) in rank.iter().enumerate() {
            match order.get_mut(r as usize) {
                Some(slot) if *slot == NONE => *slot = node as u32,
                _ => return Err(invalid()),
            }
        }
        let derived =
            cch::structure::Downward::derive(&up_first_out, &up_head).ok_or_else(invalid)?;
        let graph = Self {
            rank,
            elimination_tree_parent: derived.elimination_tree_parent.into(),
            up_first_out,
            up_head,
            up_tail: derived.up_tail.into(),
            down_first_out: derived.down_first_out.into(),
            down_head: derived.down_head.into(),
            down_to_up: derived.down_to_up.into(),
            order: order.into(),
        };
        // Every movement must have its arc, so later lookups cannot fail.
        for (from, range) in movements.input.first_out.windows(2).enumerate() {
            for index in range[0] as usize..range[1] as usize {
                let (tail, head) = (
                    graph.rank[from],
                    graph.rank[movements.input.head[index] as usize],
                );
                if tail != head && graph.arc_between(tail.min(head), tail.max(head)).is_none() {
                    return Err(invalid());
                }
            }
        }
        Ok(graph)
    }

    #[cfg(feature = "standalone")]
    fn write(&self, writer: &mut index::Writer) -> std::io::Result<()> {
        writer.column(&self.rank)?;
        writer.column(&self.up_first_out)?;
        writer.column(&self.up_head)
    }
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
    order,
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
            && self.order.len() == n
    }

    fn arc_between(&self, low: u32, high: u32) -> Option<u32> {
        let first = self.up_first_out[low as usize] as usize;
        let end = self.up_first_out[low as usize + 1] as usize;
        self.up_head[first..end]
            .binary_search(&high)
            .ok()
            .map(|i| (first + i) as u32)
    }

    /// The CCH arc of input movement `index` leaving state `from`, or NONE
    /// for a loop. Input-arc maps are derived on demand instead of stored.
    fn input_arc(&self, movements: &MovementGraph, from: usize, index: usize) -> u32 {
        let (tail, head) = (
            self.rank[from],
            self.rank[movements.input.head[index] as usize],
        );
        if tail == head {
            return NONE;
        }
        self.arc_between(tail.min(head), tail.max(head))
            .expect("every movement has a hierarchy arc")
    }

    /// Input movements that set arc `low -> high` in one direction, in
    /// ascending movement order (the first one, then any parallel extras).
    fn arc_inputs<'a>(
        &'a self,
        movements: &'a MovementGraph,
        low: usize,
        high: usize,
        upward: bool,
    ) -> impl Iterator<Item = u32> + 'a {
        let (from, to) = if upward { (low, high) } else { (high, low) };
        let (from, to) = (self.order[from] as usize, self.order[to]);
        (movements.input.first_out[from]..movements.input.first_out[from + 1])
            .filter(move |&index| movements.input.head[index as usize] == to)
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

/// Shortcut columns shared by one customization height.
///
/// Safety contract: within a height, `relax(x)` is called at most once per
/// rank x; it writes only x's upward arcs and reads only arcs of x's strict
/// descendants, which were completed at lower heights.
#[derive(Clone, Copy)]
struct TriangleArcs {
    up_costs: *mut f64,
    down_costs: *mut f64,
    up_witness: *mut u32,
    down_witness: *mut u32,
    witness: bool,
}
unsafe impl Send for TriangleArcs {}
unsafe impl Sync for TriangleArcs {}

impl TriangleArcs {
    #[inline]
    unsafe fn improve(self, costs: *mut f64, witness: *mut u32, arc: usize, cost: f64, via: u32) {
        unsafe {
            if cost < *costs.add(arc) {
                *costs.add(arc) = cost;
                if self.witness {
                    *witness.add(arc) = via;
                }
            }
        }
    }

    unsafe fn relax(self, graph: &RankGraph, x: usize) {
        // x's upward heads are sorted; find the arc x -> z without a
        // City-sized scratch index per worker thread.
        let first = graph.up_first_out[x] as usize;
        let row = &graph.up_head[first..graph.up_first_out[x + 1] as usize];
        for incoming in graph.down_first_out[x]..graph.down_first_out[x + 1] {
            let lower = graph.down_head[incoming as usize] as usize;
            let bottom = graph.down_to_up[incoming as usize] as usize;
            for mid in (graph.up_first_out[lower]..graph.up_first_out[lower + 1]).rev() {
                let z = graph.up_head[mid as usize] as usize;
                if z <= x {
                    break;
                }
                let top = first
                    + row
                        .binary_search(&(z as u32))
                        .expect("chordal hierarchy has every triangle arc");
                let mid = mid as usize;
                unsafe {
                    let forward = *self.down_costs.add(bottom) + *self.up_costs.add(mid);
                    let backward = *self.up_costs.add(bottom) + *self.down_costs.add(mid);
                    let via = lower as u32 | VIA;
                    self.improve(self.up_costs, self.up_witness, top, forward, via);
                    self.improve(self.down_costs, self.down_witness, top, backward, via);
                }
            }
        }
    }
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
                let arc = graph.input_arc(movements, from, index);
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
        //
        // Node x writes only its own upward arcs and reads arcs of strict
        // elimination-tree descendants. Nodes of equal subtree height are
        // never ancestors of one another, so each height runs in parallel
        // while every node keeps the serial loop order (bit-identical).
        let shared = TriangleArcs {
            up_costs: up.costs.as_mut_ptr(),
            down_costs: down.costs.as_mut_ptr(),
            up_witness: up.witness.as_mut_ptr(),
            down_witness: down.witness.as_mut_ptr(),
            witness: !up.witness.is_empty(),
        };
        for level in cch::Levels::from_parents(&graph.elimination_tree_parent).iter() {
            // SAFETY: see TriangleArcs; x belongs to this height only.
            let relax = |x: usize| unsafe { shared.relax(graph, x) };
            if level.len() < 256 {
                level.iter().for_each(|&x| relax(x as usize));
            } else {
                use rayon::prelude::*;
                level.par_iter().for_each(|&x| relax(x as usize));
            }
        }
    }

    fn find_arc(&self, low: u32, high: u32) -> Option<u32> {
        self.graph.arc_between(low, high)
    }

    fn search_space(&self, nodes: impl Iterator<Item = u32>) -> Vec<u32> {
        self.rank_space(nodes).ranks.clone()
    }

    /// The union of the elimination-tree paths above `nodes`, ascending,
    /// with a rank-to-slot index. Uses reusable scratch instead of a fresh
    /// City-sized marker and a comparison sort on every query.
    fn rank_space(&self, nodes: impl Iterator<Item = u32>) -> RankSpace {
        let mut space = RankSpace::take(self.graph.node_count());
        let parent = &*self.graph.elimination_tree_parent;
        let words = &mut space.words;
        for node in nodes {
            let mut rank = self.graph.rank[node as usize];
            while rank != NONE {
                let (word, bit) = (rank as usize / 64, 1u64 << (rank % 64));
                if words[word] & bit != 0 {
                    break;
                }
                words[word] |= bit;
                rank = parent[rank as usize];
            }
        }
        // Reading the bitset in word order yields ranks in ascending order
        // and leaves the scratch cleared for the next query.
        for (index, word) in space.words.iter_mut().enumerate() {
            let mut bits = std::mem::take(word);
            while bits != 0 {
                let rank = index * 64 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                space.slot[rank] = space.ranks.len() as u32;
                space.ranks.push(rank as u32);
            }
        }
        space
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
    #[cfg(any(feature = "standalone", test))]
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
        let mut pending = vec![0u64; self.graph.node_count().div_ceil(64)];
        for &rank in &work.source_space {
            let rank = rank as usize;
            let value = work.up_cost[rank];
            if value <= maximum && value.is_finite() {
                work.down_cost[rank] = value;
                pending[rank / 64] |= 1 << (rank % 64);
            }
        }
        for word in (0..pending.len()).rev() {
            let mut active = pending[word];
            while active != 0 {
                let bit = 63 - active.leading_zeros() as usize;
                active ^= 1 << bit;
                let rank = word * 64 + bit;
                let value = work.down_cost[rank];
                for arc in first[rank] as usize..first[rank + 1] as usize {
                    let candidate = value + costs.1.arc(weights[arc] as usize);
                    let to = heads[arc] as usize;
                    let prior = &mut work.down_cost[to];
                    if candidate <= maximum && candidate.is_finite() && candidate < *prior {
                        if !prior.is_finite() {
                            let flag = 1 << (to % 64);
                            if to / 64 == word {
                                active |= flag;
                            } else {
                                pending[to / 64] |= flag;
                            }
                        }
                        *prior = candidate;
                    }
                }
            }
        }
    }
}

/// A sorted elimination-tree search space with a direct rank-to-slot index.
/// The City-sized columns are reused per thread; only touched slots are
/// reset when the space is returned.
pub(super) struct RankSpace {
    pub ranks: Vec<u32>,
    slot: Vec<u32>,
    words: Vec<u64>,
}

thread_local! {
    static RANK_SPACES: std::cell::RefCell<Vec<RankSpace>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

impl RankSpace {
    const POOLED: usize = 4;

    fn take(nodes: usize) -> Self {
        RANK_SPACES
            .with(|pool| {
                let mut pool = pool.borrow_mut();
                let at = pool.iter().rposition(|s| s.slot.len() == nodes)?;
                Some(pool.swap_remove(at))
            })
            .unwrap_or_else(|| Self {
                ranks: Vec::new(),
                slot: vec![NONE; nodes],
                words: vec![0; nodes.div_ceil(64)],
            })
    }

    #[inline]
    pub fn slot(&self, rank: u32) -> Option<usize> {
        let slot = self.slot[rank as usize];
        (slot != NONE).then_some(slot as usize)
    }

    pub fn len(&self) -> usize {
        self.ranks.len()
    }
}

impl Drop for RankSpace {
    fn drop(&mut self) {
        if self.slot.is_empty() {
            return;
        }
        for &rank in &self.ranks {
            self.slot[rank as usize] = NONE;
        }
        self.ranks.clear();
        // Construct a pooled value only when the pool accepts it; otherwise
        // the columns drop normally (a rejected value must not re-enter here).
        let _ = RANK_SPACES.try_with(|pool| {
            if let Ok(mut pool) = pool.try_borrow_mut()
                && pool.len() < Self::POOLED
            {
                pool.push(Self {
                    ranks: std::mem::take(&mut self.ranks),
                    slot: std::mem::take(&mut self.slot),
                    words: std::mem::take(&mut self.words),
                });
            }
        });
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
/// The per-road scalar of one customized metric. Shared by customization
/// and by rebuilding persisted witnesses, so both compute identical values.
fn road_weight(
    kernel: &BikeKernel,
    options: BikeOptions,
    elapsed: bool,
    rebate: f64,
) -> impl Fn(u32) -> f64 + Sync + '_ {
    move |road| {
        let (seconds, price) = kernel.metric(road, options);
        kernel.distances[road as usize] as f64 / 100.
            * if elapsed {
                seconds
            } else {
                (price - rebate * seconds).max(0.)
            }
    }
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
            road_weight(kernel, options, elapsed, rebate),
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

    /// Reads shortcut witnesses and rebuilds their unrounded costs. A
    /// witness is either the admitted input movement that set the arc or the
    /// lower triangle vertex that last improved it, so each cost is the same
    /// single addition customization performed, in the same order.
    fn read(
        reader: &mut index::Reader,
        graph: &RankGraph,
        movements: &MovementGraph,
        weight: impl Fn(u32) -> f64 + Sync,
    ) -> std::io::Result<Self> {
        let count = graph.cch_arc_count();
        let up_witness: index::Column<u32> = reader.column(Some(count))?;
        let down_witness: index::Column<u32> = reader.column(Some(count))?;
        Self::rebuild(graph, movements, up_witness, down_witness, weight).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid bicycle shortcut witness",
            )
        })
    }

    fn rebuild(
        graph: &RankGraph,
        movements: &MovementGraph,
        up_witness: index::Column<u32>,
        down_witness: index::Column<u32>,
        weight: impl Fn(u32) -> f64 + Sync,
    ) -> Option<Self> {
        let count = graph.cch_arc_count();
        if up_witness.len() != count || down_witness.len() != count {
            return None;
        }
        let mut up = vec![f64::INFINITY; count];
        let mut down = vec![f64::INFINITY; count];
        let columns = WitnessCosts {
            up: up.as_mut_ptr(),
            down: down.as_mut_ptr(),
        };
        let failed = std::sync::atomic::AtomicBool::new(false);
        for level in cch::Levels::from_parents(&graph.elimination_tree_parent).iter() {
            let rebuild = |x: u32| {
                // SAFETY: see WitnessCosts; x belongs to this height only.
                if unsafe {
                    !columns.rebuild(
                        graph,
                        movements,
                        &up_witness,
                        &down_witness,
                        &weight,
                        x as usize,
                    )
                } {
                    failed.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            };
            if level.len() < 256 {
                level.iter().for_each(|&x| rebuild(x));
            } else {
                use rayon::prelude::*;
                level.par_iter().for_each(|&x| rebuild(x));
            }
        }
        if failed.into_inner() {
            return None;
        }
        Some(Self {
            up: Arcs {
                costs: up.into(),
                witness: up_witness,
            },
            down: Arcs {
                costs: down.into(),
                witness: down_witness,
            },
        })
    }

    #[cfg(feature = "standalone")]
    fn write(up: &Arcs, down: &Arcs, writer: &mut index::Writer) -> std::io::Result<()> {
        writer.column(&up.witness)?;
        writer.column(&down.witness)
    }
}

/// Cost columns rebuilt from witnesses, one elimination-tree height at a
/// time. Same contract as `TriangleArcs`: rank x writes only its own upward
/// arcs and reads arcs of strict descendants completed at lower heights.
#[derive(Clone, Copy)]
struct WitnessCosts {
    up: *mut f64,
    down: *mut f64,
}
unsafe impl Send for WitnessCosts {}
unsafe impl Sync for WitnessCosts {}

impl WitnessCosts {
    unsafe fn rebuild(
        self,
        graph: &RankGraph,
        movements: &MovementGraph,
        up_witness: &[u32],
        down_witness: &[u32],
        weight: &impl Fn(u32) -> f64,
        x: usize,
    ) -> bool {
        let find =
            |low: usize, high: u32| graph.arc_between(low as u32, high).map(|arc| arc as usize);
        for top in graph.up_first_out[x] as usize..graph.up_first_out[x + 1] as usize {
            let z = graph.up_head[top];
            for (upward, witness) in [(true, up_witness[top]), (false, down_witness[top])] {
                let cost = if witness == NONE {
                    f64::INFINITY
                } else if witness & VIA == 0 {
                    match movements.roads.get(witness as usize) {
                        Some(&road) => weight(road),
                        None => return false,
                    }
                } else {
                    let lower = (witness & !VIA) as usize;
                    let (Some(bottom), Some(mid)) =
                        (find(lower, x as u32).filter(|_| lower < x), find(lower, z))
                    else {
                        return false;
                    };
                    // SAFETY: bottom and mid are arcs of `lower`, a strict
                    // descendant of x, completed at a lower height.
                    unsafe {
                        if upward {
                            *self.down.add(bottom) + *self.up.add(mid)
                        } else {
                            *self.up.add(bottom) + *self.down.add(mid)
                        }
                    }
                };
                unsafe {
                    *(if upward { self.up } else { self.down }).add(top) = cost;
                }
            }
        }
        true
    }
}

pub(crate) struct PreparedTopology {
    movements: std::sync::Arc<MovementGraph>,
    graph: std::sync::Arc<RankGraph>,
    #[cfg(feature = "standalone")]
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
    #[cfg(any(feature = "standalone", test))]
    dual: std::sync::OnceLock<LowerBounds>,
    maximum_price_rate: f64,
    #[cfg(feature = "standalone")]
    published: std::sync::atomic::AtomicBool,
}
fn metric_key(options: BikeOptions) -> (&'static str, [u8; 10]) {
    let mut key = [0; 10];
    key[..8].copy_from_slice(&options.speed_kph.to_bits().to_le_bytes());
    key[8] = options.max_lts.unwrap_or(u8::MAX);
    key[9] = 4; // shortcut witnesses and exact patches; bounds recomputed
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
        let topology = if let Some(topology) = kernel.cch_topology.get() {
            topology.clone()
        } else {
            let movements = std::sync::Arc::new(MovementGraph::new(kernel)?);
            let mapped = kernel.cch_index().and_then(|store| {
                let mut reader = store.open("topology", TOPOLOGY_KEY).ok()?;
                let graph = RankGraph::read(&mut reader, &movements).ok()?;
                (reader.finish().is_ok() && graph.matches(&movements)).then_some(graph)
            });
            let graph = if let Some(graph) = mapped {
                graph
            } else {
                let order = projected_order(kernel, &movements)?;
                RankGraph::from(cch::Cch::build(&movements.input, &order))
            };
            #[cfg(feature = "standalone")]
            let mapped = graph.rank.mapped();
            let graph = std::sync::Arc::new(graph);
            let topology = std::sync::Arc::new(PreparedTopology {
                movements,
                graph,
                #[cfg(feature = "standalone")]
                published: std::sync::atomic::AtomicBool::new(mapped),
            });
            let _ = kernel.cch_topology.set(topology.clone());
            topology
        };
        let movements = topology.movements.clone();
        let graph = topology.graph.clone();
        if graph.rank.mapped()
            && let Some(store) = kernel.cch_index()
            && let Ok(loaded) = Self::open(kernel, store, options, &topology)
        {
            return Ok(loaded);
        }
        let steady = Weights::prepare(kernel, &movements, &graph, options, false, 0., true, true);
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
            #[cfg(any(feature = "standalone", test))]
            dual: std::sync::OnceLock::new(),
            maximum_price_rate,
            #[cfg(feature = "standalone")]
            published: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn open(
        kernel: &BikeKernel,
        store: &index::Store,
        options: BikeOptions,
        topology: &PreparedTopology,
    ) -> std::io::Result<Self> {
        let (kind, key) = metric_key(options);
        let graph = topology.graph.clone();
        let n = graph.cch_arc_count();
        let mut reader = store.open(kind, &key)?;
        let maximum_price_rate = reader.column::<f64>(Some(1))?[0];
        let steady = Weights::read(
            &mut reader,
            &graph,
            &topology.movements,
            road_weight(kernel, options, false, 0.),
        )?;
        let optimistic = PreferencePatches::read(&mut reader, n)?;
        reader.finish()?;
        Ok(Self {
            movements: topology.movements.clone(),
            hierarchy: Hierarchy {
                graph,
                up: steady.up,
                down: steady.down,
            },
            // Lower-bound metrics are recomputed on first use; they are
            // cheaper to customize than to store per City and profile.
            physical: std::sync::OnceLock::new(),
            optimistic: std::sync::OnceLock::from(optimistic),
            #[cfg(any(feature = "standalone", test))]
            dual: std::sync::OnceLock::new(),
            maximum_price_rate,
            #[cfg(feature = "standalone")]
            published: std::sync::atomic::AtomicBool::new(true),
        })
    }

    #[cfg(feature = "standalone")]
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
            store.publish("topology", TOPOLOGY_KEY, |writer| {
                topology.graph.write(writer)
            })?;
            topology.published.store(true, Ordering::Relaxed);
        }
        let (kind, key) = metric_key(options);
        let optimistic = self.optimistic(kernel, options);
        store.publish(kind, &key, |writer| {
            writer.column(&[self.maximum_price_rate])?;
            Weights::write(&self.hierarchy.up, &self.hierarchy.down, writer)?;
            optimistic.write(writer)
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

    #[cfg(any(feature = "standalone", test))]
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

    /// One short default route between two network nodes, so the first
    /// request finds the attachment and search state already built.
    #[cfg(feature = "standalone")]
    pub(crate) fn warm_up(&self) {
        if let Some(store) = self.cch_index() {
            store.prefetch();
        }
        let count = self.lons.len();
        if count < 2 {
            return;
        }
        let point = |node: usize| [self.lons[node], self.lats[node]];
        let origin = point(count / 2);
        let destination = (count / 2 + 1..count.min(count / 2 + 200_000))
            .map(point)
            .find(|p| vigo_route::geo::haversine_m(origin, *p) > 800.)
            .unwrap_or_else(|| point(count - 1));
        let _ = self.route_at(
            origin,
            destination,
            BikeOptions::default(),
            1200.,
            4.8,
            50_000.,
            None,
        );
    }

    #[cfg(feature = "standalone")]
    pub(crate) fn prepare_cch(&self, options: BikeOptions) -> Result<(), String> {
        options.validate()?;
        let (prepared, _) = self.hierarchy(options)?;
        // Preparing a City can publish a source-matched index. Read-only
        // cache directories do not change the routing algorithm or results.
        let _ = prepared.publish(self, options);
        // Lower bounds are not persisted; a prepared worker keeps them ready.
        together(
            || prepared.physical(self, options),
            || prepared.dual(self, options),
        );
        Ok(())
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep hierarchy query inputs explicit."
)]
#[cfg(any(feature = "standalone", test))]
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
    // A node's best arrival state depends only on the node and the cell's
    // permission group. Many cells share a node, so evaluate it once.
    let mut zero_best: smallvec::SmallVec<[(usize, f64, u32); 2]> = smallvec::SmallVec::new();
    for &node in nodes {
        let variants: smallvec::SmallVec<[u32; 4]> = movements.states.variants(node).collect();
        zero_best.clear();
        for &end in &ends.entries
            [ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
        {
            let cell = end.target as usize;
            let i = end.index();
            let group = uniform_group.unwrap_or(ends.groups[cell]);
            let distance = |state: u32| {
                let rank = hierarchy.graph.rank[state as usize];
                (values.cost(rank, group, masks), rank)
            };
            let (prefix, rank, partial) = if end.zero() {
                let (cost, rank) = if let Some(&(_, cost, rank)) =
                    zero_best.iter().find(|(known, _, _)| *known == group)
                {
                    (cost, rank)
                } else {
                    let (cost, rank) = variants
                        .iter()
                        .copied()
                        .map(distance)
                        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
                        .unwrap();
                    zero_best.push((group, cost, rank));
                    (cost, rank)
                };
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
#[cfg(any(feature = "standalone", test))]
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
    first_pass: bool,
) -> Result<Vec<Option<f64>>, String> {
    let (prepared, resident) = kernel.hierarchy(options)?;
    let movements = &prepared.movements;
    let hierarchy = &prepared.hierarchy;
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
        for state in start_states(kernel, movements, a) {
            earliest_sources.push((state, a.walk_seconds + a.drive_meters * seconds));
            lower_sources.push((state, a.walk_seconds + a.drive_meters * price));
            lower_attachments.push(index);
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
    // A legal optimistic minimum settles the cell outright. Compute road
    // entry clocks and permission bounds only for cells that need them.
    let mut possible = vec![true; ends.attachments.len()];
    let before = Instant::now();
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
    if certified == ends.attachments.len() {
        trace("BIKE_HIERARCHY", || {
            serde_json::json!({
                "phase":"build","preparedBeforeRequest":resident,
                "certificateMs":certificate_ms,"certifiedCells":certified,
                "earliestScopeMs":ms(before),
            })
        });
        trace("BIKE_HIERARCHY", || {
            serde_json::json!({
                "phase":"query","cells":ends.attachments.len(),"directHierarchyQuery":true,
                "endpointMs":attachment_ms,"changingMovements":0,"postGateRoots":0,
            })
        });
        return Ok(verified);
    }
    if first_pass {
        // The caller resolves the remaining cells with full endpoint sets.
        return Ok(verified);
    }
    let earliest_scope_ms = ms(before);
    let before = Instant::now();
    let mut workspace = Workspace::new(hierarchy.graph.node_count());
    let event_states: Vec<_> = movements.timed.iter().map(|event| event.0).collect();
    hierarchy.bounds(
        &earliest_sources,
        &mut workspace,
        prepared.physical(kernel, options).directions(false),
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
    let mut physically_possible = vec![false; ends.attachments.len()];
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
            if !possible[cell] || physically_possible[cell] {
                continue;
            }
            let ride = if end.zero() {
                0.
            } else {
                let b = ends.attachments[cell].candidate(&graph, end.index());
                b.drive_meters * kernel.metric(b.edge, options).0
            };
            physically_possible[cell] |=
                earliest + (ride + end.walk_seconds) * (1. - 1e-9) <= cutoff;
        }
    }
    for &(cell, a, b) in &ends.direct {
        if !possible[cell] || physically_possible[cell] {
            continue;
        }
        let a = starts.candidate(&graph, a);
        let b = ends.attachments[cell].candidate(&graph, b);
        if a.fraction <= b.fraction {
            let length =
                (b.fraction - a.fraction) * kernel.distances[a.edge as usize] as f64 / 100.;
            physically_possible[cell] |=
                (a.walk_seconds + b.walk_seconds + length * kernel.metric(a.edge, options).0)
                    * (1. - 1e-9)
                    <= cutoff;
        }
    }
    for (active, reachable) in possible.iter_mut().zip(physically_possible) {
        *active &= reachable;
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
    let mut admitted: Vec<bool> = movements.dynamic.iter().map(|&dynamic| !dynamic).collect();
    let feasible = metric.solve(&sources, &targets, &mut masks);
    let feasible = reduce_terminals(
        kernel, ends, options, movements, hierarchy, &nodes, &admitted, &feasible, &masks, None,
    );
    let mut bounds: Vec<_> = feasible
        .iter()
        .map(|&(cost, _, _)| {
            if distance_limit >= cost / rate * maximum_speed {
                cutoff_cap.min(cost * (1. + 1e-9))
            } else {
                cutoff_cap
            }
        })
        .collect();
    // A cell without a clock-stable path keeps the whole cutoff as its price
    // ceiling, which widens the horizon and dated gates of every cell. A legal
    // earliest arrival through dated movements bounds such cells instead.
    if bounds
        .iter()
        .zip(&possible)
        .any(|(&bound, &active)| active && bound >= cutoff_cap)
    {
        let started = Instant::now();
        let query = temporal::Query {
            kernel,
            movements,
            hierarchy,
            starts,
            ends,
            target_nodes: &nodes,
            target_states: &targets,
            options,
            clock,
            rate,
            // Report every legal arrival: a price filter could hide one.
            cap: f64::INFINITY,
            horizon: cutoff,
            distance_limit,
            maximum_speed,
            permissions: &permissions,
            steady: &admitted,
            reversed: false,
            continuation: None,
            lower_start: &lower_start,
            lower_start_price: &lower_start,
            lower_remaining: &lower_start,
        };
        let mut groups: Vec<_> = (0..bounds.len())
            .filter(|&cell| possible[cell] && bounds[cell] >= cutoff_cap)
            .map(|cell| ends.groups[cell])
            .collect();
        groups.sort_unstable();
        groups.dedup();
        let (mut tightened, mut unreachable) = (0, 0);
        for &group in &groups {
            let fastest = query.earliest(&mut masks, group, false, None)?;
            let cheapest = query.earliest(&mut masks, group, true, None)?;
            for (cell, (&(fast, arrival), &(cheap, _))) in fastest.iter().zip(&cheapest).enumerate()
            {
                if !possible[cell] || ends.groups[cell] != group || bounds[cell] < cutoff_cap {
                    continue;
                }
                let cost = fast.min(cheap);
                if !arrival.is_finite() || arrival > cutoff {
                    // No legal movement sequence, waiting included, reaches
                    // the cell inside the cutoff: every route arrives later.
                    if !query.constrained() {
                        possible[cell] = false;
                        unreachable += 1;
                    }
                } else if cost < cutoff_cap {
                    bounds[cell] = cost * (1. + 1e-9);
                    tightened += 1;
                }
            }
        }
        if unreachable > 0 {
            nodes.retain(|&node| {
                ends.entries
                    [ends.offsets[node as usize] as usize..ends.offsets[node as usize + 1] as usize]
                    .iter()
                    .any(|terminal| possible[terminal.target as usize])
            });
            targets = nodes
                .iter()
                .flat_map(|&node| movements.states.variants(node))
                .collect();
        }
        trace("BIKE_TEMPORAL_HIERARCHY", || {
            serde_json::json!({
                "phase":"earliest-ceilings","tightenedCells":tightened,"unreachableCells":unreachable,
                "groups":groups.len(),"earliestMs":ms(started),
            })
        });
    }
    let cap = bounds
        .iter()
        .zip(&possible)
        .filter_map(|(&cost, &active)| active.then_some(cost))
        .fold(0., f64::max);
    hierarchy.bounds(
        &lower_sources,
        &mut workspace,
        optimistic.directions(hierarchy, false),
        cap,
    );
    let lower_start_price: Vec<_> = workspace
        .down_cost
        .iter()
        .map(|value| value * (1. - 1e-9))
        .collect();
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
            "hierarchyArcs":hierarchy.graph.cch_arc_count(),
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
    Ok(seconds.into_iter().map(Some).collect())
}

#[cfg(any(feature = "standalone", test))]
/// Hierarchy states a departure attachment enters: the movements along its
/// first road, or its node when the attachment starts at the node.
fn start_states<'a>(
    kernel: &BikeKernel,
    movements: &'a MovementGraph,
    a: RoadCandidate,
) -> impl Iterator<Item = u32> + 'a {
    let (range, road, at_node) = if a.drive_meters > 1e-7 {
        let start = kernel.source(a.edge) as usize;
        (
            movements.input.first_out[start] as usize
                ..movements.input.first_out[start + 1] as usize,
            a.edge,
            None,
        )
    } else {
        (0..0, NONE, Some(a.node))
    };
    at_node.into_iter().chain(
        range
            .filter(move |&input| movements.roads[input] == road)
            .map(|input| movements.input.head[input]),
    )
}

/// Relaxed (optimistic) preference costs between an endpoint attachment and
/// every bicycle node: the minimum over the node's turn states, and the cost
/// at its base state. This is the metric and source set the surface
/// certificate uses, so the minimum lower-bounds every terminal through the
/// node and the base value equals a zero-length terminal's certified cost.
#[cfg(any(feature = "standalone", test))]
pub(super) struct NodeBounds {
    pub minimum: Vec<f64>,
    pub base: Vec<f64>,
}

#[cfg(any(feature = "standalone", test))]
pub(super) fn node_bounds(
    kernel: &BikeKernel,
    endpoint: &Attachment,
    options: BikeOptions,
    arrive: bool,
) -> Result<NodeBounds, String> {
    let (prepared, _) = kernel.hierarchy(options)?;
    let movements = &prepared.movements;
    let hierarchy = &prepared.hierarchy;
    let graph = kernel.graph();
    let mut sources = Vec::new();
    for index in 0..endpoint.candidates.len() {
        let a = endpoint.candidate(&graph, index);
        let price = kernel.metric(a.edge, options).1;
        let cost = a.walk_seconds + a.drive_meters * price;
        if arrive {
            sources.extend(reverse::destination_states(movements, a).map(|s| (s, cost)));
        } else {
            sources.extend(start_states(kernel, movements, a).map(|s| (s, cost)));
        }
    }
    let optimistic = prepared.optimistic(kernel, options);
    let mut work = Workspace::new(hierarchy.graph.node_count());
    hierarchy.solve(
        &sources,
        None,
        &mut work,
        optimistic.directions(hierarchy, arrive),
    );
    let rank = &hierarchy.graph.rank;
    let value = |state: u32| work.down_cost[rank[state as usize] as usize];
    let nodes = kernel.lons.len() as u32;
    Ok(NodeBounds {
        minimum: (0..nodes)
            .map(|node| {
                movements
                    .states
                    .variants(node)
                    .map(value)
                    .fold(f64::INFINITY, f64::min)
            })
            .collect(),
        base: (0..nodes).map(value).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A compact index stores only the upward graph and shortcut witnesses.
    // Everything derived on open must equal the freshly built hierarchy.
    #[test]
    fn compact_index_rebuilds_the_built_hierarchy_exactly() {
        const CYCLE: u32 = (30 << 8) | (15 << 14) | (2 << 3);
        const MAJOR: u32 = (30 << 8) | (80 << 14) | 6;
        let side = 9u32;
        let nodes: Vec<_> = (0..side * side)
            .map(|i| [f64::from(i % side) * 0.001, f64::from(i / side) * 0.001])
            .collect();
        let mut edges = Vec::new();
        for i in 0..side * side {
            let (x, y) = (i % side, i / side);
            let cm = 10_000 + (i * 37 % 900);
            if x + 1 < side {
                let way = i64::from(100 + y);
                let kind = if y % 3 == 0 { MAJOR } else { CYCLE };
                edges.push((i, i + 1, cm, way, kind));
                if y % 4 != 1 {
                    edges.push((i + 1, i, cm, way, kind));
                }
            }
            if y + 1 < side {
                let way = i64::from(200 + x);
                edges.push((i, i + side, cm + 50, way, CYCLE));
                edges.push((i + side, i, cm + 50, way, CYCLE));
                // Parallel road between the same states.
                if x == 4 {
                    edges.push((i, i + side, cm + 75, i64::from(300 + y), CYCLE));
                }
            }
        }
        let k =
            crate::bike::tests::fixture(&nodes, &edges, &[(40, 104, 204, 0), (22, 202, 102, 1)]);
        let movements = MovementGraph::new(&k).unwrap();
        let order = projected_order(&k, &movements).unwrap();
        let built = cch::Cch::build(&movements.input, &order);
        let derived =
            cch::structure::Downward::derive(&built.up_first_out, &built.up_head).unwrap();
        assert_eq!(
            derived.elimination_tree_parent,
            built.elimination_tree_parent
        );
        assert_eq!(derived.up_tail, built.up_tail);
        assert_eq!(derived.down_first_out, built.down_first_out);
        assert_eq!(derived.down_head, built.down_head);
        assert_eq!(derived.down_to_up, built.down_to_up);
        let lists = |first: &[u32], extra_first: &[u32], extra: &[u32], arc: usize| {
            std::iter::once(first[arc])
                .chain(
                    extra[extra_first[arc] as usize..extra_first[arc + 1] as usize]
                        .iter()
                        .copied(),
                )
                .filter(|&input| input != NONE)
                .collect::<Vec<_>>()
        };
        let expected_inputs = built.input_arc_to_cch_arc.clone();
        let forward: Vec<_> = (0..built.up_head.len())
            .map(|a| {
                lists(
                    &built.forward_input_arc_of_cch,
                    &built.first_extra_forward_input_arc_of_cch,
                    &built.extra_forward_input_arc_of_cch,
                    a,
                )
            })
            .collect();
        let backward: Vec<_> = (0..built.up_head.len())
            .map(|a| {
                lists(
                    &built.backward_input_arc_of_cch,
                    &built.first_extra_backward_input_arc_of_cch,
                    &built.extra_backward_input_arc_of_cch,
                    a,
                )
            })
            .collect();
        let graph = RankGraph::from(built);
        for (from, range) in movements.input.first_out.windows(2).enumerate() {
            let range = range[0] as usize..range[1] as usize;
            for (index, &expected) in expected_inputs[range.clone()].iter().enumerate() {
                assert_eq!(
                    graph.input_arc(&movements, from, range.start + index),
                    expected
                );
            }
        }
        for x in 0..graph.node_count() {
            for arc in graph.up_first_out[x] as usize..graph.up_first_out[x + 1] as usize {
                let y = graph.up_head[arc] as usize;
                let up: Vec<_> = graph.arc_inputs(&movements, x, y, true).collect();
                let down: Vec<_> = graph.arc_inputs(&movements, x, y, false).collect();
                assert_eq!(up, forward[arc]);
                assert_eq!(down, backward[arc]);
            }
        }
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let options = BikeOptions {
                profile,
                ..Default::default()
            };
            let customized =
                Weights::prepare(&k, &movements, &graph, options, false, 0., true, true);
            let rebuilt = Weights::rebuild(
                &graph,
                &movements,
                customized.up.witness.to_vec().into(),
                customized.down.witness.to_vec().into(),
                road_weight(&k, options, false, 0.),
            )
            .unwrap();
            for (a, b) in [
                (&customized.up, &rebuilt.up),
                (&customized.down, &rebuilt.down),
            ] {
                let bits = |costs: &[f64]| costs.iter().map(|c| c.to_bits()).collect::<Vec<_>>();
                assert_eq!(bits(&a.costs), bits(&b.costs));
                assert!(a.costs.iter().any(|c| c.is_finite()));
            }
        }
    }

    #[test]
    fn bounded_sweep_matches_rank_minima_across_bitmap_words() {
        let n = 145;
        let mut input = cch::graph::Graph {
            first_out: vec![0],
            head: Vec::new(),
            weight: Vec::new(),
        };
        for node in 0..n {
            if node + 1 < n && node != 5 {
                input.head.push(node + 1);
            }
            if node + 16 < n && node > 5 {
                input.head.push(node + 16);
            }
            input.first_out.push(input.head.len() as u32);
        }
        let order: Vec<_> = (0..n).rev().collect();
        let graph = RankGraph::from(cch::Cch::build(&input, &order));
        let unused = || Arcs {
            costs: Vec::new().into(),
            witness: Vec::new().into(),
        };
        let hierarchy = Hierarchy {
            graph: std::sync::Arc::new(graph),
            up: unused(),
            down: unused(),
        };
        let cost_up = vec![1.; hierarchy.graph.cch_arc_count()];
        let cost_down = vec![2.; hierarchy.graph.cch_arc_count()];
        let weights = (&cost_up[..], &cost_down[..]);
        let mut work = Workspace::new(n as usize);
        for (seeds, budget) in [
            (vec![(143, 0.), (16, 5.)], 18.),
            (vec![(30, 2.)], 6.),
            (vec![(4, 1.)], 1.),
            (vec![], 100.),
        ] {
            hierarchy.solve(&seeds, None, &mut work, weights);
            let expected: Vec<_> = work
                .down_cost
                .iter()
                .map(|&cost| if cost <= budget { cost } else { f64::INFINITY })
                .collect();
            hierarchy.bounds(&seeds, &mut work, weights, budget);
            assert_eq!(work.down_cost, expected);
        }
    }

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
