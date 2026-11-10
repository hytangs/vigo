//! Gate-aware bicycle hierarchy. Contract clock-stable movements, retain
//! competing costs and arrival times only on the approach to a dated gate.
use super::*;

pub(super) struct Gate {
    pub input: u32,
    pub from: u32,
    pub original_from: u32,
    pub scope: u32,
}
type CompactMap<V> = HashMap<u32, V, BuildHasherDefault<crate::IntegerHasher>>;

#[derive(Clone)]
struct Path {
    seconds: f64,
    excess: f64,
    meters: f64,
    scope: u32,
    id: u32,
    parts: [u32; 2],
}

#[derive(Clone, Copy)]
pub(super) struct Label {
    pub elapsed: f64,
    pub excess: f64,
    pub meters: f64,
    pub scope: u32,
    seed: u32,
    state: u32,
    trail: u32,
}

struct Trail {
    enabled: bool,
    legs: Vec<(u32, u32)>,
}
impl Trail {
    fn step(&mut self, parent: u32, step: u32) -> u32 {
        if !self.enabled {
            return NONE;
        }
        let id = self.legs.len() as u32;
        self.legs.push((parent, step));
        id
    }

    fn movements(&self, mut trail: u32, profiles: &Profiles, reversed: bool) -> Vec<u32> {
        let mut parts = Vec::new();
        while trail != NONE {
            let (parent, step) = self.legs[trail as usize];
            parts.push(step);
            trail = parent;
        }
        let mut movements = Vec::new();
        let mut stack = Vec::new();
        for step in parts.into_iter().rev() {
            stack.push(step);
            while let Some(part) = stack.pop() {
                if part & VIA != 0 {
                    movements.push(part & !VIA);
                } else {
                    let [left, right] = profiles.paths[part as usize].parts;
                    if right != NONE {
                        stack.push(right);
                    }
                    stack.push(left);
                }
            }
        }
        if reversed {
            movements.reverse();
        }
        movements
    }
}

#[derive(Clone, Copy)]
struct Ending {
    value: (f64, f64),
    label: Option<Label>,
    seed: u32,
    terminal: u32,
}
impl Default for Ending {
    fn default() -> Self {
        Self {
            value: (f64::INFINITY, f64::INFINITY),
            label: None,
            seed: NONE,
            terminal: NONE,
        }
    }
}

pub(super) struct PointWitness {
    pub cost: f64,
    pub elapsed: f64,
    pub origin: usize,
    pub destination: usize,
    // Forward state after the first partial edge, or reverse state before
    // the final partial edge. Direct partials have neither state.
    pub seed_state: Option<u32>,
    pub steps: Vec<u32>,
}

#[derive(Clone, Copy, Default)]
struct Range {
    start: u32,
    count: u32,
}

struct Profiles {
    up: CompactMap<Range>,
    down: CompactMap<Range>,
    paths: Vec<Path>,
}

impl Profiles {
    fn get(&self, arc: usize, up: bool) -> &[Path] {
        let ranges = if up { &self.up } else { &self.down };
        ranges.get(&(arc as u32)).map_or(&[], |range| {
            &self.paths[range.start as usize..(range.start + range.count) as usize]
        })
    }

    fn store(&mut self, arc: usize, up: bool, list: &mut Vec<Path>) -> Result<(), String> {
        if list.is_empty() {
            return Ok(());
        }
        if self.paths.len() + list.len() > 6_000_000 {
            return Err("Temporal contraction exceeded the experiment's path workspace".into());
        }
        let range = Range {
            start: self.paths.len() as u32,
            count: list.len() as u32,
        };
        if up {
            self.up.insert(arc as u32, range);
        } else {
            self.down.insert(arc as u32, range);
        }
        for (i, path) in list.iter_mut().enumerate() {
            path.id = range.start + i as u32;
        }
        self.paths.append(list);
        Ok(())
    }
}

pub(super) struct Query<'a> {
    pub kernel: &'a BikeKernel,
    pub movements: &'a MovementGraph,
    pub hierarchy: &'a Hierarchy,
    pub starts: &'a Attachment,
    pub ends: &'a SurfaceEnds,
    pub target_nodes: &'a [u32],
    pub target_states: &'a [u32],
    pub options: BikeOptions,
    pub clock: Option<BikeClock>,
    pub rate: f64,
    pub cap: f64,
    pub horizon: f64,
    pub distance_limit: f64,
    pub maximum_speed: f64,
    pub permissions: &'a HashMap<u32, u32>,
    pub lower_start: &'a [f64],
    pub lower_start_price: &'a [f64],
    pub lower_remaining: &'a [f64],
    pub steady: &'a [bool],
    pub reversed: bool,
    pub continuation: Option<&'a BikeContinuation>,
}

impl Query<'_> {
    fn viable(&self, from: usize, to: usize, path: &Path) -> bool {
        let entry = self.lower_start[from];
        let exit = entry + path.seconds;
        path.meters <= self.distance_limit
            && exit <= self.horizon
            && self.lower_start_price[from]
                + self.rate * (path.seconds + self.lower_remaining[to])
                + path.excess
                <= self.cap * (1. + 1e-8)
    }

    fn constrained(&self) -> bool {
        self.distance_limit < self.horizon * self.maximum_speed
    }

    fn put_path(&self, values: &mut Vec<Path>, mut candidate: Path, masks: &mut SurfaceMasks) {
        for prior in values.iter_mut() {
            if masks.intersect(prior.scope, candidate.scope) == 0 {
                continue;
            }
            if prior.excess <= candidate.excess
                && (!self.constrained() || prior.meters <= candidate.meters)
                && prior.seconds <= candidate.seconds
            {
                candidate.scope = masks.subtract(candidate.scope, prior.scope);
            } else if candidate.excess <= prior.excess
                && (!self.constrained() || candidate.meters <= prior.meters)
                && candidate.seconds <= prior.seconds
            {
                prior.scope = masks.subtract(prior.scope, candidate.scope);
            }
            if candidate.scope == 0 {
                break;
            }
        }
        values.retain(|path| path.scope != 0);
        if candidate.scope != 0 {
            values.push(candidate);
        }
    }

    fn join(
        &self,
        from: usize,
        to: usize,
        values: &mut Vec<Path>,
        left: &[Path],
        right: &[Path],
        masks: &mut SurfaceMasks,
    ) {
        for a in left {
            let entry = self.lower_start[from];
            let middle = entry + a.seconds;
            if middle > self.horizon {
                continue;
            }
            for b in right {
                let scope = masks.intersect(a.scope, b.scope);
                if scope == 0 {
                    continue;
                }
                let excess = a.excess + b.excess;
                let meters = a.meters + b.meters;
                let exit = middle + b.seconds;
                if meters > self.distance_limit
                    || exit > self.horizon
                    || self.lower_start_price[from]
                        + self.rate * (a.seconds + b.seconds + self.lower_remaining[to])
                        + excess
                        > self.cap * (1. + 1e-8)
                {
                    continue;
                }
                self.put_path(
                    values,
                    Path {
                        seconds: a.seconds + b.seconds,
                        excess,
                        meters,
                        scope,
                        id: NONE,
                        parts: [a.id, b.id],
                    },
                    masks,
                );
            }
        }
    }

    fn direct(&self, input: u32, masks: &SurfaceMasks) -> Option<Path> {
        if input == NONE || !self.steady[input as usize] {
            return None;
        }
        let road = self.movements.roads[input as usize];
        if !self.kernel.allowed_edge(road, self.options) {
            return None;
        }
        let scope = if self.kernel.attributes[road as usize] & (1 << 22) != 0 {
            let component = self.kernel.destination_components[self.kernel.source(road) as usize];
            self.permissions.get(&component).copied().unwrap_or(0)
        } else {
            masks.all
        };
        if scope == 0 {
            return None;
        }
        let meters = self.kernel.distances[road as usize] as f64 / 100.;
        let (seconds, price) = self.kernel.metric(road, self.options);
        Some(Path {
            seconds: seconds * meters,
            meters,
            excess: ((price - self.rate * seconds) * meters).max(0.),
            scope,
            id: NONE,
            parts: [input | VIA, NONE],
        })
    }

    fn customize(&self, masks: &mut SurfaceMasks) -> Result<Profiles, String> {
        let graph = &self.hierarchy.graph;
        let mut result = Profiles {
            up: CompactMap::default(),
            down: CompactMap::default(),
            paths: Vec::new(),
        };
        let mut index = vec![0; graph.node_count()];
        let mut upward = Vec::<Vec<Path>>::new();
        let mut downward = Vec::<Vec<Path>>::new();
        for x in 0..graph.node_count() {
            // Every gate prefix through this rank pays both bounds. The
            // bounds use a relaxation of all movements, so no child shortcut
            // whose witness visits an excluded rank can affect a gate.
            if self.lower_start_price[x] + self.rate * self.lower_remaining[x]
                > self.cap * (1. + 1e-8)
            {
                continue;
            }
            let start = graph.up_first_out[x] as usize;
            let end = graph.up_first_out[x + 1] as usize;
            if upward.len() < end - start {
                upward.resize_with(end - start, Vec::new);
                downward.resize_with(end - start, Vec::new);
            }
            for (i, arc) in (start..end).enumerate() {
                let y = graph.up_head[arc] as usize;
                index[y] = i;
                let mut fwd = std::iter::once(graph.forward_input_arc_of_cch[arc]).chain(
                    graph.extra_forward_input_arc_of_cch[graph.first_extra_forward_input_arc_of_cch
                        [arc] as usize
                        ..graph.first_extra_forward_input_arc_of_cch[arc + 1] as usize]
                        .iter()
                        .copied(),
                );
                let mut bwd = std::iter::once(graph.backward_input_arc_of_cch[arc]).chain(
                    graph.extra_backward_input_arc_of_cch[graph
                        .first_extra_backward_input_arc_of_cch[arc]
                        as usize
                        ..graph.first_extra_backward_input_arc_of_cch[arc + 1] as usize]
                        .iter()
                        .copied(),
                );
                if self.reversed {
                    std::mem::swap(&mut fwd, &mut bwd);
                }
                for input in fwd {
                    if let Some(path) = self.direct(input, masks)
                        && self.viable(x, y, &path)
                    {
                        self.put_path(&mut upward[i], path, masks);
                    }
                }
                for input in bwd {
                    if let Some(path) = self.direct(input, masks)
                        && self.viable(y, x, &path)
                    {
                        self.put_path(&mut downward[i], path, masks);
                    }
                }
            }
            for i in graph.down_first_out[x]..graph.down_first_out[x + 1] {
                let y = graph.down_head[i as usize] as usize;
                let bottom = graph.down_to_up[i as usize] as usize;
                let into_x = result.get(bottom, true);
                let out_of_x = result.get(bottom, false);
                if into_x.is_empty() && out_of_x.is_empty() {
                    continue;
                }
                for mid in
                    (graph.up_first_out[y] as usize..graph.up_first_out[y + 1] as usize).rev()
                {
                    let z = graph.up_head[mid] as usize;
                    if z <= x {
                        break;
                    }
                    let top = index[z];
                    self.join(
                        x,
                        z,
                        &mut upward[top],
                        out_of_x,
                        result.get(mid, true),
                        masks,
                    );
                    self.join(
                        z,
                        x,
                        &mut downward[top],
                        result.get(mid, false),
                        into_x,
                        masks,
                    );
                }
            }
            for (i, arc) in (start..end).enumerate() {
                result.store(arc, true, &mut upward[i])?;
                result.store(arc, false, &mut downward[i])?;
            }
        }
        Ok(result)
    }

    fn put_label(
        &self,
        labels: &mut Vec<Label>,
        mut candidate: Label,
        masks: &mut SurfaceMasks,
    ) -> bool {
        for prior in labels.iter_mut() {
            if prior.elapsed <= candidate.elapsed
                && prior.excess <= candidate.excess
                && (!self.constrained() || prior.meters <= candidate.meters)
            {
                candidate.scope = masks.subtract(candidate.scope, prior.scope);
            } else if candidate.elapsed <= prior.elapsed
                && candidate.excess <= prior.excess
                && (!self.constrained() || candidate.meters <= prior.meters)
            {
                prior.scope = masks.subtract(prior.scope, candidate.scope);
            }
            if candidate.scope == 0 {
                break;
            }
        }
        labels.retain(|label| label.scope != 0);
        if candidate.scope != 0 {
            labels.push(candidate);
            true
        } else {
            false
        }
    }

    fn extend(
        &self,
        labels: &mut Vec<Label>,
        from: &[Label],
        paths: &[Path],
        rank: usize,
        masks: &mut SurfaceMasks,
        trail: &mut Trail,
    ) {
        for a in from {
            for b in paths {
                let scope = masks.intersect(a.scope, b.scope);
                if scope == 0 {
                    continue;
                }
                let elapsed = a.elapsed + b.seconds;
                let excess = a.excess + b.excess;
                let meters = a.meters + b.meters;
                if meters <= self.distance_limit
                    && elapsed <= self.horizon
                    && self.rate * (elapsed + self.lower_remaining[rank]) + excess
                        <= self.cap * (1. + 1e-8)
                {
                    if self.put_label(
                        labels,
                        Label {
                            elapsed,
                            excess,
                            meters,
                            scope,
                            ..*a
                        },
                        masks,
                    ) {
                        labels.last_mut().unwrap().trail = trail.step(a.trail, b.id);
                    }
                }
            }
        }
    }

    pub(super) fn initial(&self, masks: &mut SurfaceMasks) -> Result<Vec<(u32, Label)>, String> {
        let mut sources = Vec::new();
        let roads = self.kernel.graph();
        for i in 0..self.starts.candidates.len() {
            let candidate = self.starts.candidate(&roads, i);
            let (seconds, price) = self.kernel.metric(candidate.edge, self.options);
            if self.reversed {
                for id in self.movements.states.variants(candidate.node) {
                    let state = self.movements.states.state(id);
                    let latest = -candidate.walk_seconds - candidate.drive_meters * seconds;
                    let entry = if candidate.drive_meters <= 1e-7 {
                        Some(latest)
                    } else {
                        self.kernel.latest_arrival_movement(
                            &self.movements.states.turns[state.turns as usize],
                            (state.incoming != NONE).then_some(state.incoming),
                            state.node,
                            candidate.edge,
                            None,
                            self.clock,
                            latest,
                            -self.horizon,
                            SearchKind::Normal,
                        )?
                    };
                    if let Some(entry) = entry {
                        sources.push((
                            id,
                            Label {
                                elapsed: -entry,
                                excess: candidate.walk_seconds * (1. - self.rate)
                                    + candidate.drive_meters
                                        * (price - self.rate * seconds).max(0.),
                                meters: candidate.walk_meters + candidate.drive_meters,
                                scope: masks.all,
                                seed: i as u32,
                                state: id,
                                trail: NONE,
                            },
                        ));
                    }
                }
                continue;
            }
            for (departure, turns) in self
                .kernel
                .start_movements(
                    &candidate,
                    candidate.drive_meters,
                    self.continuation,
                    self.clock,
                    SearchKind::Normal,
                    true,
                )?
                .into_iter()
            {
                let incoming = if candidate.drive_meters > 1e-7 {
                    incoming_state(self.kernel, candidate.edge)
                } else {
                    self.continuation
                        .filter(|c| same_point(c.road, candidate.road))
                        .and_then(|c| c.incoming)
                        .map_or(NONE, |edge| incoming_state(self.kernel, edge))
                };
                let state = state_id(&self.movements.states, candidate.node, incoming, &turns);
                sources.push((
                    state,
                    Label {
                        elapsed: departure + candidate.drive_meters * seconds,
                        excess: candidate.walk_seconds * (1. - self.rate)
                            + candidate.drive_meters * (price - self.rate * seconds).max(0.),
                        meters: candidate.walk_meters + candidate.drive_meters,
                        scope: masks.all,
                        seed: i as u32,
                        state,
                        trail: NONE,
                    },
                ));
            }
        }
        Ok(sources)
    }

    fn sweep(
        &self,
        profiles: &Profiles,
        seeds: &[(u32, Label)],
        masks: &mut SurfaceMasks,
        trail: &mut Trail,
    ) -> CompactMap<Vec<Label>> {
        let hierarchy = self.hierarchy;
        let graph = &hierarchy.graph;
        let mut up = CompactMap::<Vec<Label>>::default();
        for &(state, label) in seeds {
            let rank = graph.rank[state as usize];
            self.put_label(up.entry(rank).or_default(), label, masks);
        }
        for rank in hierarchy.search_space(seeds.iter().map(|(state, _)| *state)) {
            let Some(values) = up.get(&rank).cloned() else {
                continue;
            };
            for arc in graph.up_first_out[rank as usize] as usize
                ..graph.up_first_out[rank as usize + 1] as usize
            {
                let paths = profiles.get(arc, true);
                if paths.is_empty() {
                    continue;
                }
                let to = graph.up_head[arc];
                self.extend(
                    up.entry(to).or_default(),
                    &values,
                    paths,
                    to as usize,
                    masks,
                    trail,
                );
            }
        }
        let mut down = CompactMap::<Vec<Label>>::default();
        for rank in hierarchy
            .search_space(self.target_states.iter().copied())
            .into_iter()
            .rev()
        {
            let mut values = up.remove(&rank).unwrap_or_default();
            for arc in graph.up_first_out[rank as usize] as usize
                ..graph.up_first_out[rank as usize + 1] as usize
            {
                let to = graph.up_head[arc];
                let Some(from) = down.get(&to) else {
                    continue;
                };
                self.extend(
                    &mut values,
                    from,
                    profiles.get(arc, false),
                    rank as usize,
                    masks,
                    trail,
                );
            }
            if !values.is_empty() {
                down.insert(rank, values);
            }
        }
        down
    }

    fn finish(
        &self,
        values: &CompactMap<Vec<Label>>,
        masks: &SurfaceMasks,
    ) -> Result<Vec<Ending>, String> {
        let graph = self.kernel.graph();
        let mut results = vec![Ending::default(); self.ends.attachments.len()];
        let mut improve =
            |cell: usize, cost: f64, elapsed, meters, label: Option<Label>, seed, terminal| {
                if cost < results[cell].value.0
                    && cost <= self.cap * (1. + 1e-8)
                    && meters <= self.distance_limit
                {
                    results[cell] = Ending {
                        value: (cost, elapsed),
                        label,
                        seed,
                        terminal,
                    };
                }
            };
        for &(cell, i, j) in &self.ends.direct {
            let a = self.starts.candidate(&graph, i);
            let b = self.ends.attachments[cell].candidate(&graph, j);
            if b.fraction < a.fraction {
                continue;
            }
            let meters =
                (b.fraction - a.fraction) * self.kernel.distances[a.edge as usize] as f64 / 100.;
            let (seconds, price) = self.kernel.metric(a.edge, self.options);
            if let Some((departure, _)) = self
                .kernel
                .start_movements(
                    &a,
                    meters,
                    self.continuation,
                    self.clock,
                    SearchKind::Normal,
                    false,
                )?
                .first
            {
                improve(
                    cell,
                    a.walk_seconds
                        + b.walk_seconds
                        + price * meters
                        + self.rate * (departure - a.walk_seconds),
                    departure + seconds * meters + b.walk_seconds,
                    a.walk_meters + b.walk_meters + meters,
                    None,
                    i as u32,
                    j as u32,
                );
            }
        }
        for &node in self.target_nodes {
            let first = self.ends.offsets[node as usize] as usize;
            let end = self.ends.offsets[node as usize + 1] as usize;
            for state in self.movements.states.variants(node) {
                let rank = self.hierarchy.graph.rank[state as usize];
                let Some(labels) = values.get(&rank) else {
                    continue;
                };
                let state = self.movements.states.state(state);
                let incoming = (state.incoming != NONE).then_some(state.incoming);
                let history = &self.movements.states.turns[state.turns as usize];
                for terminal in &self.ends.entries[first..end] {
                    let cell = terminal.target as usize;
                    let walk = self.ends.attachments[cell].candidates[terminal.index()].walk_meters;
                    for label in labels {
                        if !masks.contains(label.scope, self.ends.groups[cell]) {
                            continue;
                        }
                        if terminal.zero() {
                            improve(
                                cell,
                                self.rate * label.elapsed + label.excess + terminal.walk_seconds,
                                label.elapsed + terminal.walk_seconds,
                                label.meters + walk,
                                Some(*label),
                                label.seed,
                                terminal.index() as u32,
                            );
                        } else {
                            let candidate =
                                self.ends.attachments[cell].candidate(&graph, terminal.index());
                            let Some((departure, _)) = self
                                .kernel
                                .movements(
                                    history,
                                    incoming,
                                    node,
                                    candidate.edge,
                                    self.clock,
                                    label.elapsed,
                                    SearchKind::Normal,
                                    false,
                                )?
                                .first
                            else {
                                continue;
                            };
                            let (seconds, price) = self.kernel.metric(candidate.edge, self.options);
                            improve(
                                cell,
                                self.rate * departure
                                    + label.excess
                                    + price * candidate.drive_meters
                                    + terminal.walk_seconds,
                                departure
                                    + seconds * candidate.drive_meters
                                    + terminal.walk_seconds,
                                label.meters + candidate.drive_meters + walk,
                                Some(*label),
                                label.seed,
                                terminal.index() as u32,
                            );
                        }
                    }
                }
            }
        }
        Ok(results)
    }

    fn finish_arrival(
        &self,
        values: &CompactMap<Vec<Label>>,
        masks: &SurfaceMasks,
    ) -> Result<Vec<Ending>, String> {
        let graph = self.kernel.graph();
        let mut results = vec![Ending::default(); self.ends.attachments.len()];
        let mut improve =
            |cell: usize, cost: f64, elapsed, meters, label: Option<Label>, seed, terminal| {
                if cost <= self.cap * (1. + 1e-8)
                    && cost < results[cell].value.0
                    && elapsed <= self.horizon
                    && meters <= self.distance_limit
                {
                    results[cell] = Ending {
                        value: (cost, elapsed),
                        label,
                        seed,
                        terminal,
                    };
                }
            };
        for &(cell, end, start) in &self.ends.direct {
            let a = self.ends.attachments[cell].candidate(&graph, start);
            let b = self.starts.candidate(&graph, end);
            if a.fraction > b.fraction {
                continue;
            }
            let meters =
                (b.fraction - a.fraction) * self.kernel.distances[a.edge as usize] as f64 / 100.;
            let (seconds, price) = self.kernel.metric(a.edge, self.options);
            let latest = -b.walk_seconds - meters * seconds;
            let entry = if meters <= 1e-7 {
                Some(latest)
            } else {
                self.kernel.latest_arrival_movement(
                    &TurnState::new(),
                    None,
                    self.kernel.source(a.edge),
                    a.edge,
                    None,
                    self.clock,
                    latest,
                    -self.horizon + a.walk_seconds,
                    SearchKind::Normal,
                )?
            };
            if let Some(entry) = entry {
                improve(
                    cell,
                    a.walk_seconds
                        + b.walk_seconds
                        + meters * price
                        + (latest - entry).max(0.) * self.rate,
                    -entry + a.walk_seconds,
                    a.walk_meters + b.walk_meters + meters,
                    None,
                    end as u32,
                    start as u32,
                );
            }
        }
        for &node in self.target_nodes {
            let start = self.ends.offsets[node as usize] as usize;
            let end = self.ends.offsets[node as usize + 1] as usize;
            for terminal in &self.ends.entries[start..end] {
                let cell = terminal.target as usize;
                let a = self.ends.attachments[cell].candidate(&graph, terminal.index());
                let incoming = if a.drive_meters <= 1e-7 {
                    NONE
                } else {
                    incoming_state(self.kernel, a.edge)
                };
                let id = state_id(
                    &self.movements.states,
                    node,
                    incoming,
                    &self.movements.states.turns[0],
                );
                let rank = self.hierarchy.graph.rank[id as usize];
                let Some(labels) = values.get(&rank) else {
                    continue;
                };
                let (seconds, price) = self.kernel.metric(a.edge, self.options);
                for label in labels {
                    if !masks.contains(label.scope, self.ends.groups[cell]) {
                        continue;
                    }
                    let latest = -label.elapsed - a.drive_meters * seconds;
                    let entry = if a.drive_meters <= 1e-7 {
                        Some(latest)
                    } else {
                        self.kernel.latest_arrival_movement(
                            &TurnState::new(),
                            None,
                            self.kernel.source(a.edge),
                            a.edge,
                            Some(&self.movements.states.turns[0]),
                            self.clock,
                            latest,
                            -self.horizon + a.walk_seconds,
                            SearchKind::Normal,
                        )?
                    };
                    if let Some(entry) = entry {
                        improve(
                            cell,
                            self.rate * label.elapsed
                                + label.excess
                                + a.walk_seconds
                                + a.drive_meters * price
                                + (latest - entry).max(0.) * self.rate,
                            -entry + a.walk_seconds,
                            label.meters + a.walk_meters + a.drive_meters,
                            Some(*label),
                            label.seed,
                            terminal.index() as u32,
                        );
                    }
                }
            }
        }
        Ok(results)
    }

    pub fn run(
        &self,
        gates: &[Gate],
        final_remaining: &[f64],
        masks: &mut SurfaceMasks,
    ) -> Result<(Vec<(u32, Label)>, Vec<(f64, f64)>), String> {
        self.run_profiles(gates, final_remaining, masks, false)
            .map(|(roots, values, _)| (roots, values))
    }

    pub fn point(
        &self,
        gates: &[Gate],
        final_remaining: &[f64],
        masks: &mut SurfaceMasks,
    ) -> Result<Option<PointWitness>, String> {
        self.run_profiles(gates, final_remaining, masks, true)
            .map(|(_, _, point)| point)
    }

    fn run_profiles(
        &self,
        gates: &[Gate],
        final_remaining: &[f64],
        masks: &mut SurfaceMasks,
        witness: bool,
    ) -> Result<(Vec<(u32, Label)>, Vec<(f64, f64)>, Option<PointWitness>), String> {
        let mut trail = Trail {
            enabled: witness,
            legs: Vec::new(),
        };
        let started = Instant::now();
        let profiles = self.customize(masks)?;
        let customize_ms = ms(started);
        let started = Instant::now();
        let mut pending = self.initial(masks)?;
        let mut gate_prefixes = CompactMap::<Vec<Label>>::default();
        let mut gate_exits = CompactMap::<Vec<Label>>::default();
        let mut rounds = 0;
        while !pending.is_empty() && !gates.is_empty() {
            rounds += 1;
            if rounds > 128 {
                return Err("Dated gate propagation exceeded the experiment's workspace".into());
            }
            let reached = self.sweep(&profiles, &pending, masks, &mut trail);
            pending.clear();
            for gate in gates {
                let rank = self.hierarchy.graph.rank[gate.from as usize];
                let Some(prefixes) = reached.get(&rank) else {
                    continue;
                };
                let state = self.movements.states.state(gate.original_from);
                let incoming = (state.incoming != NONE).then_some(state.incoming);
                let history = &self.movements.states.turns[state.turns as usize];
                let edge = self.movements.roads[gate.input as usize];
                let next_forward = self.movements.input.head[gate.input as usize];
                let to = if self.reversed {
                    gate.original_from
                } else {
                    next_forward
                };
                let required = self.movements.states.state(next_forward).turns as usize;
                let meters = self.kernel.distances[edge as usize] as f64 / 100.;
                let (seconds, price) = self.kernel.metric(edge, self.options);
                for prefix in prefixes {
                    let scope = masks.intersect(prefix.scope, gate.scope);
                    if scope == 0 {
                        continue;
                    }
                    self.put_label(gate_prefixes.entry(rank).or_default(), *prefix, masks);
                    let elapsed = if self.reversed {
                        self.kernel
                            .latest_arrival_movement(
                                history,
                                incoming,
                                state.node,
                                edge,
                                Some(&self.movements.states.turns[required]),
                                self.clock,
                                -prefix.elapsed - seconds * meters,
                                -self.horizon,
                                SearchKind::Normal,
                            )?
                            .map(|entry| -entry)
                    } else {
                        self.kernel
                            .movements(
                                history,
                                incoming,
                                state.node,
                                edge,
                                self.clock,
                                prefix.elapsed,
                                SearchKind::Normal,
                                true,
                            )?
                            .into_iter()
                            .find(|(_, turns)| *turns == self.movements.states.turns[required])
                            .map(|(departure, _)| departure + seconds * meters)
                    };
                    let Some(elapsed) = elapsed else {
                        continue;
                    };
                    let next = Label {
                        elapsed,
                        excess: prefix.excess + (price - self.rate * seconds).max(0.) * meters,
                        meters: prefix.meters + meters,
                        scope,
                        ..*prefix
                    };
                    let remaining =
                        final_remaining[self.hierarchy.graph.rank[to as usize] as usize];
                    if next.meters > self.distance_limit
                        || next.elapsed > self.horizon
                        || self.rate * (next.elapsed + remaining) + next.excess
                            > self.cap * (1. + 1e-8)
                    {
                        continue;
                    }
                    let previous = gate_exits.entry(to).or_default();
                    let before = previous.len();
                    let known = previous.iter().fold(next.scope, |mut unknown, known| {
                        if known.elapsed <= next.elapsed
                            && known.excess <= next.excess
                            && (!self.constrained() || known.meters <= next.meters)
                        {
                            unknown = masks.subtract(unknown, known.scope);
                        }
                        unknown
                    });
                    if known != 0 {
                        let next = Label {
                            scope: known,
                            trail: trail.step(prefix.trail, gate.input | VIA),
                            ..next
                        };
                        self.put_label(previous, next, masks);
                        pending.push((to, next));
                    } else {
                        debug_assert_eq!(previous.len(), before);
                    }
                }
            }
        }
        let sweep_ms = ms(started);
        let roots: Vec<_> = gate_exits
            .into_iter()
            .flat_map(|(node, labels)| labels.into_iter().map(move |label| (node, label)))
            .collect();
        let started = Instant::now();
        let endings = if self.constrained() || self.reversed || witness {
            // The scalar minimum cannot certify a binding distance limit.
            // Keep all undominated metres, price and time on the same
            // ranked shortcuts through the terminal sweep.
            let mut seeds = self.initial(masks)?;
            seeds.extend_from_slice(&roots);
            let values = self.sweep(&profiles, &seeds, masks, &mut trail);
            if self.reversed {
                self.finish_arrival(&values, masks)?
            } else {
                self.finish(&values, masks)?
            }
        } else {
            self.finish(&gate_prefixes, masks)?
        };
        eprintln!(
            "BIKE_TEMPORAL_HIERARCHY {}",
            serde_json::json!({
                "variableMovements":gates.len(),"rounds":rounds,"postGateRoots":roots.len(),
                "profileVariants":profiles.paths.len(),
                "portalLabelCount":gate_prefixes.values().map(Vec::len).sum::<usize>(),
                "profileCustomizationMs":customize_ms,"rankSweepMs":sweep_ms,
                "partialGateTerminalsMs":ms(started),
            })
        );
        let point = endings
            .first()
            .filter(|result| witness && result.value.0.is_finite())
            .map(|result| {
                let (a, b) = (result.seed as usize, result.terminal as usize);
                PointWitness {
                    cost: result.value.0,
                    elapsed: result.value.1,
                    origin: if self.reversed { b } else { a },
                    destination: if self.reversed { a } else { b },
                    seed_state: result.label.map(|label| label.state),
                    steps: result.label.map_or_else(Vec::new, |label| {
                        trail.movements(label.trail, &profiles, self.reversed)
                    }),
                }
            });
        Ok((
            roots,
            endings.into_iter().map(|ending| ending.value).collect(),
            point,
        ))
    }
}
