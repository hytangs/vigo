//! Sparse metric changes on an immutable hierarchy. At every arc, each
//! destination permission group keeps its own minimum and path witness.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Choice {
    pub cost: f64,
    pub witness: u32,
    pub scope: u32,
}

type Choices = smallvec::SmallVec<[Choice; 2]>;
type Overrides = HashMap<u32, Choices, BuildHasherDefault<crate::IntegerHasher>>;

fn improve(choices: &mut Choices, mut value: Choice, masks: &mut SurfaceMasks) -> bool {
    if value.scope == 0 || !value.cost.is_finite() {
        return false;
    }
    for known in choices.iter_mut() {
        if known.cost <= value.cost {
            value.scope = masks.subtract(value.scope, known.scope);
        } else {
            known.scope = masks.subtract(known.scope, value.scope);
        }
        if value.scope == 0 {
            return false;
        }
    }
    choices.retain(|v| v.scope != 0);
    choices.push(value);
    true
}

fn combine(
    result: &mut Choices,
    first: &[Choice],
    second: &[Choice],
    witness: u32,
    masks: &mut SurfaceMasks,
    ceiling: f64,
) -> bool {
    let mut changed = false;
    for a in first {
        for b in second {
            let cost = a.cost + b.cost;
            if cost > ceiling {
                continue;
            }
            let scope = masks.intersect(a.scope, b.scope);
            changed |= improve(
                result,
                Choice {
                    cost,
                    witness,
                    scope,
                },
                masks,
            );
        }
    }
    changed
}

pub(super) struct Corridor<'a> {
    pub start: &'a [f64],
    pub remaining: &'a [f64],
    pub cap: f64,
    pub start_scale: f64,
    pub remaining_scale: f64,
}

impl Corridor<'_> {
    fn ceiling(&self, from: u32, to: u32) -> f64 {
        self.cap * (1. + 1e-8)
            - self.start_scale * self.start[from as usize]
            - self.remaining_scale * self.remaining[to as usize]
    }
}

enum ChoiceView<'a> {
    Empty,
    Single(Choice),
    Many(&'a [Choice]),
}
impl ChoiceView<'_> {
    fn as_slice(&self) -> &[Choice] {
        match self {
            Self::Empty => &[],
            Self::Single(value) => std::slice::from_ref(value),
            Self::Many(values) => values,
        }
    }
    fn owned(&self) -> Choices {
        Choices::from_slice(self.as_slice())
    }
}

fn scalar(arcs: ArcView<'_>, index: u32, all: u32) -> ChoiceView<'_> {
    let (cost, witness) = arcs.values(index as usize);
    if cost.is_finite() {
        ChoiceView::Single(Choice {
            cost,
            witness,
            scope: all,
        })
    } else {
        ChoiceView::Empty
    }
}

// Most shortcuts still read the prepared metric. Changed entries use a
// paged index so a query allocates slots only for affected rank ranges.
const PAGE: usize = 256;
struct Overlay {
    slots: Vec<Option<Box<[u32; PAGE]>>>,
    values: Vec<Choices>,
}
impl Overlay {
    fn new(arcs: usize) -> Self {
        Self {
            slots: (0..arcs.div_ceil(PAGE)).map(|_| None).collect(),
            values: Vec::new(),
        }
    }
    fn get(&self, arc: u32) -> Option<&[Choice]> {
        let index = arc as usize;
        let page = self.slots[index / PAGE].as_ref()?;
        let slot = page[index % PAGE];
        (slot != 0).then(|| self.values[(slot - 1) as usize].as_slice())
    }
    fn insert(&mut self, arc: u32, choices: Choices) {
        let index = arc as usize;
        let page = self.slots[index / PAGE].get_or_insert_with(|| Box::new([0; PAGE]));
        let slot = &mut page[index % PAGE];
        if *slot == 0 {
            self.values.push(choices);
            *slot = self.values.len() as u32;
        } else {
            self.values[(*slot - 1) as usize] = choices;
        }
    }
}

fn merged(
    prior: &[Choice],
    left: &[Choice],
    right: &[Choice],
    witness: u32,
    masks: &mut SurfaceMasks,
    mut ceiling: f64,
) -> Option<Choices> {
    if let [only] = prior
        && only.scope == masks.all
    {
        ceiling = ceiling.min(only.cost);
    }
    let mut result = None;
    for a in left {
        for b in right {
            let cost = a.cost + b.cost;
            if cost > ceiling {
                continue;
            }
            let scope = masks.intersect(a.scope, b.scope);
            if scope == 0 {
                continue;
            }
            let next = Choice {
                cost,
                witness,
                scope,
            };
            if let Some(values) = &mut result {
                improve(values, next, masks);
            } else {
                let mut values = Choices::from_slice(prior);
                if improve(&mut values, next, masks) {
                    result = Some(values);
                }
            }
        }
    }
    result
}

pub(super) struct Metric<'a> {
    pub base: &'a Hierarchy,
    base_up: ArcView<'a>,
    base_down: ArcView<'a>,
    up: Overlay,
    down: Overlay,
    all: u32,
    reversed: bool,
}

impl<'a> Metric<'a> {
    pub fn new(base: &'a Hierarchy, masks: &SurfaceMasks) -> Self {
        Self {
            base,
            base_up: ArcView::new(&base.up, None),
            base_down: ArcView::new(&base.down, None),
            up: Overlay::new(base.graph.cch_arc_count()),
            down: Overlay::new(base.graph.cch_arc_count()),
            all: masks.all,
            reversed: false,
        }
    }

    pub fn optimistic(
        base: &'a Hierarchy,
        patches: &'a PreferencePatches,
        masks: &SurfaceMasks,
    ) -> Self {
        let (base_up, base_down) = patches.directions(base, false);
        Self {
            base_up,
            base_down,
            ..Self::new(base, masks)
        }
    }

    pub fn optimistic_reversed(
        base: &'a Hierarchy,
        patches: &'a PreferencePatches,
        masks: &SurfaceMasks,
    ) -> Self {
        let (base_up, base_down) = patches.directions(base, true);
        Self {
            base_up,
            base_down,
            reversed: true,
            ..Self::new(base, masks)
        }
    }

    pub fn weighted(base: &'a Hierarchy, weights: &'a Weights, masks: &SurfaceMasks) -> Self {
        Self {
            base_up: ArcView::new(&weights.up, None),
            base_down: ArcView::new(&weights.down, None),
            ..Self::new(base, masks)
        }
    }

    pub fn reversed(base: &'a Hierarchy, masks: &SurfaceMasks) -> Self {
        Self {
            base_up: ArcView::new(&base.down, None),
            base_down: ArcView::new(&base.up, None),
            reversed: true,
            ..Self::new(base, masks)
        }
    }

    // The prepared metric has no private or dated arcs. Admitting a movement
    // only decreases the minima. Process the resulting lower triangles in
    // rank order, without visiting unrelated witnesses at a changed arc.
    pub fn admit(
        &mut self,
        kernel: &BikeKernel,
        movements: &MovementGraph,
        opt: BikeOptions,
        inputs: impl Iterator<Item = (u32, u32)>,
        masks: &mut SurfaceMasks,
        corridor: &Corridor<'_>,
    ) {
        self.admit_weighted(kernel, movements, opt, inputs, masks, corridor, |road| {
            kernel.distances[road as usize] as f64 / 100. * kernel.metric(road, opt).1
        });
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep hierarchy query inputs explicit."
    )]
    pub fn admit_weighted(
        &mut self,
        kernel: &BikeKernel,
        movements: &MovementGraph,
        opt: BikeOptions,
        inputs: impl Iterator<Item = (u32, u32)>,
        masks: &mut SurfaceMasks,
        corridor: &Corridor<'_>,
        weight: impl Fn(u32) -> f64,
    ) {
        let graph = &self.base.graph;
        const UP: u8 = 1;
        const DOWN: u8 = 2;
        let mut pending = vec![0u64; graph.node_count().div_ceil(64)];
        let mut dirty = vec![0u8; graph.cch_arc_count()];
        let enqueue = |arc: u32, direction, pending: &mut [u64], dirty: &mut [u8]| {
            dirty[arc as usize] |= direction;
            let tail = graph.up_tail[arc as usize] as usize;
            pending[tail / 64] |= 1 << (tail % 64);
        };
        for (input, scope) in inputs {
            if scope == 0 {
                continue;
            }
            let arc = graph.input_arc_to_cch_arc[input as usize];
            let road = movements.roads[input as usize];
            if arc == NONE || !kernel.allowed_edge(road, opt) {
                continue;
            }
            let from = movements
                .input
                .first_out
                .partition_point(|&begin| begin <= input)
                - 1;
            let to = movements.input.head[input as usize] as usize;
            let cost = weight(road);
            let (from, to) = if self.reversed {
                (graph.rank[to], graph.rank[from])
            } else {
                (graph.rank[from], graph.rank[to])
            };
            if cost > corridor.ceiling(from, to) {
                continue;
            }
            let up = from < to;
            let mut choices = self.values(arc, up).owned();
            if improve(
                &mut choices,
                Choice {
                    cost,
                    witness: input,
                    scope,
                },
                masks,
            ) {
                self.store(arc, up, choices);
                enqueue(arc, if up { UP } else { DOWN }, &mut pending, &mut dirty);
            }
        }
        // A lower-triangle update always dirties a higher tail. A compact
        // rank-ordered bitset therefore replaces a priority queue, and the
        // direction bits identify the triangles whose minima can change.
        for word in 0..pending.len() {
            while pending[word] != 0 {
                let bit = pending[word].trailing_zeros();
                pending[word] &= !(1 << bit);
                let x = (word * 64 + bit as usize) as u32;
                let siblings = graph.up_first_out[x as usize]..graph.up_first_out[x as usize + 1];
                for left in siblings
                    .clone()
                    .filter(|&arc| dirty[arc as usize] != 0)
                    .collect::<smallvec::SmallVec<[u32; 16]>>()
                {
                    let y = graph.up_head[left as usize];
                    let changed = dirty[left as usize];
                    let x_to_y = self.values(left, true).owned();
                    let y_to_x = self.values(left, false).owned();
                    for right in siblings.clone() {
                        let right_changed = dirty[right as usize];
                        if right == left || (right < left && right_changed != 0) {
                            continue;
                        }
                        let z = graph.up_head[right as usize];
                        let fwd_limit = corridor.ceiling(y, z);
                        let bwd_limit = corridor.ceiling(z, y);
                        let forwards = (changed & DOWN != 0 || right_changed & UP != 0)
                            && fwd_limit >= 0.
                            && !y_to_x.is_empty();
                        let backwards = (changed & UP != 0 || right_changed & DOWN != 0)
                            && bwd_limit >= 0.
                            && !x_to_y.is_empty();
                        if !forwards && !backwards {
                            continue;
                        }
                        let forward = y < z;
                        let top = self
                            .base
                            .find_arc(y.min(z), y.max(z))
                            .expect("CCH neighbors form a clique");
                        if forwards {
                            let a = merged(
                                self.values(top, forward).as_slice(),
                                &y_to_x,
                                self.values(right, true).as_slice(),
                                x | VIA,
                                masks,
                                fwd_limit,
                            );
                            if let Some(values) = a {
                                self.store(top, forward, values);
                                enqueue(
                                    top,
                                    if forward { UP } else { DOWN },
                                    &mut pending,
                                    &mut dirty,
                                );
                            }
                        }
                        if backwards {
                            let b = merged(
                                self.values(top, !forward).as_slice(),
                                self.values(right, false).as_slice(),
                                &x_to_y,
                                x | VIA,
                                masks,
                                bwd_limit,
                            );
                            if let Some(values) = b {
                                self.store(top, !forward, values);
                                enqueue(
                                    top,
                                    if forward { DOWN } else { UP },
                                    &mut pending,
                                    &mut dirty,
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    fn store(&mut self, arc: u32, up: bool, values: Choices) {
        (if up { &mut self.up } else { &mut self.down }).insert(arc, values);
    }

    fn values(&self, arc: u32, up: bool) -> ChoiceView<'_> {
        let (changes, base) = if up {
            (&self.up, self.base_up)
        } else {
            (&self.down, self.base_down)
        };
        match changes.get(arc) {
            Some(values) => ChoiceView::Many(values),
            None => scalar(base, arc, self.all),
        }
    }

    pub fn changed(&self) -> usize {
        self.up.values.len() + self.down.values.len()
    }

    pub fn solve(
        &self,
        sources: &[(u32, f64)],
        targets: &[u32],
        masks: &mut SurfaceMasks,
    ) -> RankedValues {
        self.solve_scoped(sources, &[], targets, masks)
    }

    pub fn solve_scoped(
        &self,
        sources: &[(u32, f64)],
        scopes: &[u32],
        targets: &[u32],
        masks: &mut SurfaceMasks,
    ) -> RankedValues {
        let graph = &self.base.graph;
        let source_space = self
            .base
            .search_space(sources.iter().map(|&(node, _)| node));
        let target_space = self.base.search_space(targets.iter().copied());
        let mut up = RankedLabels::new(graph.node_count(), source_space.len());
        let mut down = RankedLabels::new(graph.node_count(), target_space.len());
        if self.up.values.is_empty() && self.down.values.is_empty() && scopes.is_empty() {
            // All permission lanes share the same scalar minima. Avoid
            // constructing temporary lane vectors at every arc.
            let improve = |slots: &mut SingleSlots, rank, cost: f64, witness| {
                let prior = slots.get(rank);
                if cost.is_finite() && (prior.scope == 0 || cost < prior.cost) {
                    slots.set(
                        rank,
                        Choice {
                            cost,
                            witness,
                            scope: masks.all,
                        },
                    );
                }
            };
            for (i, &(node, cost)) in sources.iter().enumerate() {
                improve(
                    &mut up.single,
                    graph.rank[node as usize],
                    cost,
                    i as u32 | VIA,
                );
            }
            for rank in source_space {
                let value = up.single.get(rank);
                if value.scope == 0 {
                    continue;
                }
                for arc in graph.up_first_out[rank as usize] as usize
                    ..graph.up_first_out[rank as usize + 1] as usize
                {
                    improve(
                        &mut up.single,
                        graph.up_head[arc],
                        value.cost + self.base_up.arc(arc),
                        rank,
                    );
                }
            }
            for rank in target_space.into_iter().rev() {
                let value = up.single.get(rank);
                if value.scope != 0 {
                    down.single.set(
                        rank,
                        Choice {
                            witness: NONE,
                            ..value
                        },
                    );
                }
                for arc in graph.up_first_out[rank as usize] as usize
                    ..graph.up_first_out[rank as usize + 1] as usize
                {
                    let parent = graph.up_head[arc];
                    let value = down.single.get(parent);
                    if value.scope != 0 {
                        improve(
                            &mut down.single,
                            rank,
                            value.cost + self.base_down.arc(arc),
                            parent,
                        );
                    }
                }
            }
            return RankedValues { up, down };
        }
        for (i, &(node, cost)) in sources.iter().enumerate() {
            let rank = graph.rank[node as usize];
            let choices = up.get(rank);
            let mut next = choices;
            improve(
                &mut next,
                Choice {
                    cost,
                    witness: i as u32 | VIA,
                    scope: scopes.get(i).copied().unwrap_or(masks.all),
                },
                masks,
            );
            up.set(rank, next);
        }
        for rank in source_space {
            let first = up.get(rank);
            if first.is_empty() {
                continue;
            }
            for arc in graph.up_first_out[rank as usize]..graph.up_first_out[rank as usize + 1] {
                let to = graph.up_head[arc as usize];
                let mut values = up.get(to);
                combine(
                    &mut values,
                    &first,
                    self.values(arc, true).as_slice(),
                    rank,
                    masks,
                    f64::INFINITY,
                );
                up.set(to, values);
            }
        }
        for rank in target_space.into_iter().rev() {
            let mut choices = up.get(rank);
            for value in &mut choices {
                value.witness = NONE;
            }
            for arc in graph.up_first_out[rank as usize]..graph.up_first_out[rank as usize + 1] {
                let above = graph.up_head[arc as usize];
                let first = down.get(above);
                if first.is_empty() {
                    continue;
                }
                combine(
                    &mut choices,
                    &first,
                    self.values(arc, false).as_slice(),
                    above,
                    masks,
                    f64::INFINITY,
                );
            }
            down.set(rank, choices);
        }
        RankedValues { up, down }
    }

    fn unpack(&self, from: u32, to: u32, group: usize, masks: &SurfaceMasks, path: &mut Vec<u32>) {
        let arc = self.base.find_arc(from.min(to), from.max(to)).unwrap();
        let witness = self
            .values(arc, from < to)
            .as_slice()
            .iter()
            .find(|v| masks.contains(v.scope, group))
            .unwrap()
            .witness;
        if witness & VIA == 0 {
            path.push(witness);
        } else {
            let middle = witness & !VIA;
            self.unpack(from, middle, group, masks, path);
            self.unpack(middle, to, group, masks, path);
        }
    }

    pub fn path(
        &self,
        rank: u32,
        group: usize,
        values: &RankedValues,
        masks: &SurfaceMasks,
        path: &mut Vec<u32>,
    ) -> usize {
        let mut descending = Vec::new();
        let mut rank = rank;
        loop {
            let parent = values.down.best(rank, group, masks).unwrap().witness;
            if parent == NONE {
                break;
            }
            descending.push((parent, rank));
            rank = parent;
        }
        let mut ascending = Vec::new();
        loop {
            let parent = values.up.best(rank, group, masks).unwrap().witness;
            if parent & VIA != 0 {
                path.clear();
                for (from, to) in ascending
                    .into_iter()
                    .rev()
                    .chain(descending.into_iter().rev())
                {
                    self.unpack(from, to, group, masks, path);
                }
                return (parent & !VIA) as usize;
            }
            ascending.push((parent, rank));
            rank = parent;
        }
    }
}

const EMPTY: Choice = Choice {
    cost: 0.,
    witness: 0,
    scope: 0,
};
enum SingleSlots {
    Dense(Vec<Choice>),
    Sparse(HashMap<u32, Choice, BuildHasherDefault<crate::IntegerHasher>>),
}
impl SingleSlots {
    fn get(&self, rank: u32) -> Choice {
        match self {
            Self::Dense(values) => values[rank as usize],
            Self::Sparse(values) => values.get(&rank).copied().unwrap_or(EMPTY),
        }
    }
    fn set(&mut self, rank: u32, value: Choice) {
        match self {
            Self::Dense(values) => values[rank as usize] = value,
            Self::Sparse(values) => {
                if value == EMPTY {
                    values.remove(&rank);
                } else {
                    values.insert(rank, value);
                }
            }
        }
    }
}
struct RankedLabels {
    single: SingleSlots,
    extra: Overrides,
}
impl RankedLabels {
    fn new(n: usize, visited: usize) -> Self {
        Self {
            single: if visited <= 65_536 && visited.saturating_mul(8) < n {
                SingleSlots::Sparse(HashMap::with_capacity_and_hasher(
                    visited,
                    BuildHasherDefault::default(),
                ))
            } else {
                SingleSlots::Dense(vec![EMPTY; n])
            },
            extra: Overrides::default(),
        }
    }
    fn get(&self, rank: u32) -> Choices {
        let value = self.single.get(rank);
        if value.scope != 0 {
            smallvec::smallvec![value]
        } else if value.witness == NONE {
            self.extra[&rank].clone()
        } else {
            Choices::new()
        }
    }
    fn set(&mut self, rank: u32, mut values: Choices) {
        let v = self.single.get(rank);
        if values.len() <= 1 {
            if v.scope == 0 && v.witness == NONE {
                self.extra.remove(&rank);
            }
            self.single.set(rank, values.pop().unwrap_or(EMPTY));
        } else {
            self.single.set(
                rank,
                Choice {
                    cost: 0.,
                    witness: NONE,
                    scope: 0,
                },
            );
            self.extra.insert(rank, values);
        }
    }
    fn best(&self, rank: u32, group: usize, masks: &SurfaceMasks) -> Option<Choice> {
        let v = self.single.get(rank);
        if v.scope != 0 {
            (v.scope == masks.all || masks.contains(v.scope, group)).then_some(v)
        } else if v.witness == NONE {
            self.extra[&rank]
                .iter()
                .find(|v| masks.contains(v.scope, group))
                .copied()
        } else {
            None
        }
    }
}

pub(super) struct RankedValues {
    up: RankedLabels,
    down: RankedLabels,
}

impl RankedValues {
    pub fn cost(&self, rank: u32, group: usize, masks: &SurfaceMasks) -> f64 {
        self.down
            .best(rank, group, masks)
            .map_or(f64::INFINITY, |v| v.cost)
    }
}
