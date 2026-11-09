//! Exact reverse lower bounds, expanded only as the forward search needs them.
//! Both cost metrics share query-local reverse links; nothing is retained by a City.
use super::*;

pub(super) struct Links {
    pub(super) head: Vec<u32>,
    pub(super) next: Vec<u32>,
    sources: Vec<u32>,
}

impl Links {
    pub(super) fn new(kernel: &BikeKernel) -> Self {
        let mut head = vec![u32::MAX; kernel.lons.len()];
        let mut next = vec![u32::MAX; kernel.targets.len()];
        let mut sources =
            if kernel.targets.len() <= crate::resources::cache_budget(32 * 1024 * 1024, 128) / 4 {
                Vec::with_capacity(kernel.targets.len())
            } else {
                Vec::new()
            };
        let mut source = 0;
        for (edge, &node) in kernel.targets.iter().enumerate() {
            next[edge] = head[node as usize];
            head[node as usize] = edge as u32;
            if sources.capacity() > 0 {
                while kernel.offsets[source + 1] <= edge as u32 {
                    source += 1;
                }
                sources.push(source as u32);
            }
        }
        Self {
            head,
            next,
            sources,
        }
    }

    pub(super) fn source(&self, kernel: &BikeKernel, edge: u32) -> usize {
        if self.sources.is_empty() {
            kernel.source(edge) as usize
        } else {
            self.sources[edge as usize] as usize
        }
    }
    // Skip heap entries at interior shape points, without summing their edges.
    // All directed neighbors must stay on the same two-neighbor chain.
    fn through(
        &self,
        kernel: &BikeKernel,
        node: usize,
        previous: usize,
        reverse: bool,
    ) -> Option<u32> {
        let start = kernel.offsets[node];
        let end = kernel.offsets[node + 1];
        let first = self.head[node];
        let second = if first == u32::MAX {
            u32::MAX
        } else {
            self.next[first as usize]
        };
        let third = if second == u32::MAX {
            u32::MAX
        } else {
            self.next[second as usize]
        };
        if end - start > 2 || third != u32::MAX {
            return None;
        }
        let outgoing = if reverse {
            [first, second]
        } else {
            [
                if start < end { start } else { u32::MAX },
                if end - start == 2 {
                    start + 1
                } else {
                    u32::MAX
                },
            ]
        };
        if outgoing[0] == u32::MAX {
            return Some(u32::MAX);
        }
        let neighbor = |edge| {
            if reverse {
                self.source(kernel, edge)
            } else {
                kernel.targets[edge as usize] as usize
            }
        };
        let next = if outgoing[1] == u32::MAX {
            outgoing[0]
        } else if neighbor(outgoing[0]) == previous {
            outgoing[1]
        } else if neighbor(outgoing[1]) == previous {
            outgoing[0]
        } else {
            return None;
        };
        let target = neighbor(next);
        let opposite = if reverse {
            [
                if start < end { start } else { u32::MAX },
                if end - start == 2 {
                    start + 1
                } else {
                    u32::MAX
                },
            ]
        } else {
            [first, second]
        };
        for edge in opposite.into_iter().filter(|&e| e != u32::MAX) {
            let other = if reverse {
                kernel.targets[edge as usize] as usize
            } else {
                self.source(kernel, edge)
            };
            if other != previous && other != target {
                return None;
            }
        }
        Some(next)
    }
}

// Directed reachability is independent of the profile. Walking can attach to
// a one-way dead end in the main weak component; do not exhaust a whole cost
// field just to establish that it cannot reach any destination attachment.
struct Components {
    node: Vec<u32>,
    head: Vec<u32>,
    edges: Vec<(u32, u32)>,
}
impl Components {
    fn new(kernel: &BikeKernel, links: &Links) -> Self {
        let count = kernel.lons.len();
        let mut visited = vec![false; count];
        let mut order = Vec::with_capacity(count);
        let mut stack = Vec::<(u32, u32)>::new();
        for root in 0..count {
            if visited[root] {
                continue;
            }
            visited[root] = true;
            stack.push((root as u32, kernel.offsets[root]));
            while let Some((node, edge)) = stack.last_mut() {
                if *edge == kernel.offsets[*node as usize + 1] {
                    order.push(*node);
                    stack.pop();
                } else {
                    let target = kernel.targets[*edge as usize];
                    *edge += 1;
                    if !visited[target as usize] {
                        visited[target as usize] = true;
                        stack.push((target, kernel.offsets[target as usize]));
                    }
                }
            }
        }
        drop(visited);
        drop(stack);
        let mut node = vec![u32::MAX; count];
        let mut pending = Vec::new();
        let mut head = Vec::new();
        for root in order.into_iter().rev() {
            if node[root as usize] != u32::MAX {
                continue;
            }
            let component = head.len() as u32;
            head.push(u32::MAX);
            node[root as usize] = component;
            pending.push(root);
            while let Some(target) = pending.pop() {
                let mut edge = links.head[target as usize];
                while edge != u32::MAX {
                    let source = links.source(kernel, edge);
                    if node[source] == u32::MAX {
                        node[source] = component;
                        pending.push(source as u32);
                    }
                    edge = links.next[edge as usize];
                }
            }
        }
        let mut edges = Vec::new();
        for (edge, &target) in kernel.targets.iter().enumerate() {
            let source = node[links.source(kernel, edge as u32)];
            let target = node[target as usize];
            if source != target {
                edges.push((source, head[target as usize]));
                head[target as usize] = edges.len() as u32 - 1;
            }
        }
        Self { node, head, edges }
    }
    fn reaching(&self, seeds: impl Iterator<Item = u32>) -> Vec<bool> {
        let mut reaches = vec![false; self.head.len()];
        let mut pending = Vec::new();
        for seed in seeds {
            let component = self.node[seed as usize];
            if !reaches[component as usize] {
                reaches[component as usize] = true;
                pending.push(component);
            }
        }
        while let Some(component) = pending.pop() {
            let mut edge = self.head[component as usize];
            while edge != u32::MAX {
                let (source, next) = self.edges[edge as usize];
                if !reaches[source as usize] {
                    reaches[source as usize] = true;
                    pending.push(source);
                }
                edge = next;
            }
        }
        reaches
    }
}

#[derive(Clone, Copy)]
pub(super) struct Weight {
    pub seconds: f64,
    pub cost: f64,
    pub excess: f64,
}

// Large timed fallback batches reuse only immutable query scratch. Smaller
// batches and memory-constrained hosts keep the ordinary calculation path.
struct OriginCosts {
    values: Vec<f64>,
    maximum: f64,
}

pub(super) struct Prepared {
    pub links: Links,
    opt: BikeOptions,
    metric_ids: Vec<u16>,
    metrics: Vec<Weight>,
    components: Components,
    forward_cost: std::sync::OnceLock<OriginCosts>,
    forward_excess: std::sync::OnceLock<OriginCosts>,
    forward_fast: std::sync::OnceLock<OriginCosts>,
}
impl Prepared {
    pub(super) fn for_batch(kernel: &BikeKernel, opt: BikeOptions, targets: usize) -> Option<Self> {
        let bytes = kernel
            .targets
            .len()
            .checked_mul(18)?
            .checked_add(kernel.lons.len().checked_mul(56)?)?
            .checked_add(65_536 * std::mem::size_of::<Weight>())?;
        if targets < 16 || bytes > crate::resources::cache_budget(224 * 1024 * 1024, 16) {
            return None;
        }
        let factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let mut ids: HashMap<u32, u16, std::hash::BuildHasherDefault<OsmNodeHasher>> =
            HashMap::default();
        let mut metrics = Vec::new();
        let mut metric_ids = Vec::with_capacity(kernel.targets.len());
        for (edge, &attributes) in kernel.attributes.iter().enumerate() {
            let id = if let Some(&id) = ids.get(&attributes) {
                id
            } else {
                let id = u16::try_from(metrics.len()).ok()?;
                let (seconds, cost) = kernel.metric(edge as u32, opt);
                metrics.push(Weight {
                    seconds,
                    cost,
                    excess: (cost - factor * seconds).max(0.),
                });
                ids.insert(attributes, id);
                id
            };
            metric_ids.push(id);
        }
        let links = Links::new(kernel);
        let components = Components::new(kernel, &links);
        Some(Self {
            links,
            components,
            forward_cost: std::sync::OnceLock::new(),
            forward_excess: std::sync::OnceLock::new(),
            forward_fast: std::sync::OnceLock::new(),
            opt,
            metric_ids,
            metrics,
        })
    }

    fn forward(
        &self,
        kernel: &BikeKernel,
        starts: &Attachment,
        opt: BikeOptions,
        excess: bool,
    ) -> Option<&OriginCosts> {
        if opt.speed_kph.to_bits() != self.opt.speed_kph.to_bits()
            || opt.max_lts != self.opt.max_lts
        {
            return None;
        }
        let storage = if matches!(opt.profile, Profile::Fast) && !excess {
            &self.forward_fast
        } else if std::mem::discriminant(&opt.profile) == std::mem::discriminant(&self.opt.profile)
        {
            if excess {
                &self.forward_excess
            } else {
                &self.forward_cost
            }
        } else {
            return None;
        };
        Some(storage.get_or_init(|| {
            let factor = if matches!(opt.profile, Profile::Fast) {
                1.
            } else {
                0.8
            };
            let mut values = vec![f64::INFINITY; kernel.lons.len()];
            let mut queue = BinaryHeap::new();
            for i in 0..starts.candidates.len() {
                let a = starts.candidate(&kernel.graph(), i);
                let (seconds, cost) = kernel.metric(a.edge, opt);
                let cost = a.walk_seconds * if excess { 1. - factor } else { 1. }
                    + a.drive_meters
                        * if excess {
                            (cost - factor * seconds).max(0.)
                        } else {
                            cost
                        };
                if cost < values[a.node as usize] {
                    values[a.node as usize] = cost;
                    queue.push(Queue(cost, a.node as usize));
                }
            }
            while let Some(Queue(cost, node)) = queue.pop() {
                if cost > values[node] {
                    continue;
                }
                for edge in kernel.offsets[node]..kernel.offsets[node + 1] {
                    let mut current_edge = edge;
                    let mut previous = node;
                    let mut candidate = cost;
                    for step in 0..64 {
                        let target = kernel.targets[current_edge as usize] as usize;
                        let w = self.weight(kernel, current_edge, opt).unwrap();
                        candidate += if excess { w.excess } else { w.cost };
                        if candidate >= values[target] {
                            break;
                        }
                        values[target] = candidate;
                        let next = self.links.through(kernel, target, previous, false);
                        if next == Some(u32::MAX) {
                            break;
                        }
                        if step == 63 || next.is_none() {
                            queue.push(Queue(candidate, target));
                            break;
                        }
                        previous = target;
                        current_edge = next.unwrap();
                    }
                }
            }
            let maximum = values
                .iter()
                .copied()
                .filter(|x| x.is_finite())
                .fold(0., f64::max);
            OriginCosts { values, maximum }
        }))
    }

    #[inline]
    pub(super) fn weight(
        &self,
        kernel: &BikeKernel,
        edge: u32,
        opt: BikeOptions,
    ) -> Option<Weight> {
        if opt.speed_kph.to_bits() != self.opt.speed_kph.to_bits()
            || opt.max_lts != self.opt.max_lts
        {
            return None;
        }
        let metric = self.metrics[self.metric_ids[edge as usize] as usize];
        let meters = kernel.distances[edge as usize] as f64 / 100.;
        if matches!(opt.profile, Profile::Fast) {
            Some(Weight {
                seconds: meters * metric.seconds,
                cost: meters * metric.seconds,
                excess: 0.,
            })
        } else if std::mem::discriminant(&opt.profile) == std::mem::discriminant(&self.opt.profile)
        {
            Some(Weight {
                seconds: meters * metric.seconds,
                cost: meters * metric.cost,
                excess: meters * metric.excess,
            })
        } else {
            None
        }
    }
}

struct GeographicPotential {
    bounds: TargetBounds,
    scale: f64,
    values: Vec<std::cell::Cell<f64>>,
}

pub(super) struct Costs<'a> {
    kernel: &'a BikeKernel,
    links: &'a Links,
    opt: BikeOptions,
    excess: bool,
    wait_factor: f64,
    components: Vec<u32>,
    costs: Vec<f64>,
    queue: BinaryHeap<Queue>,
    prepared: Option<&'a Prepared>,
    reachable: Option<Vec<bool>>,
    forward: Option<&'a OriginCosts>,
    origin: Option<GeographicPotential>,
    reverse: bool,
    ceiling: f64,
}
impl<'a> Costs<'a> {
    pub(super) fn new(
        kernel: &'a BikeKernel,
        links: &'a Links,
        ends: &Attachment,
        opt: BikeOptions,
        excess: bool,
        ceiling: f64,
    ) -> Self {
        let wait_factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let mut field = Self {
            kernel,
            links,
            opt,
            excess,
            wait_factor,
            components: Vec::new(),
            costs: vec![ceiling; kernel.lons.len()],
            queue: BinaryHeap::new(),
            prepared: None,
            reachable: None,
            forward: None,
            origin: None,
            reverse: true,
            ceiling,
        };
        for i in 0..ends.candidates.len() {
            let b = ends.candidate(&kernel.graph(), i);
            let cost = b.walk_seconds * if excess { 1. - wait_factor } else { 1. }
                + field.edge_cost(b.edge, b.drive_meters);
            field.seed(b.node, cost);
        }
        field
    }

    #[cfg(any(feature = "standalone", test))]
    pub(super) fn through_nodes(
        kernel: &'a BikeKernel,
        links: &'a Links,
        opt: BikeOptions,
        ceiling: f64,
        seeds: impl Iterator<Item = (u32, f64)>,
    ) -> Self {
        let empty = Attachment::from_candidates(vec![], 1., false);
        let mut field = Self::new(kernel, links, &empty, opt, false, ceiling);
        let mut nodes = Vec::new();
        for (node, cost) in seeds {
            let value = &mut field.costs[node as usize];
            if cost < *value {
                if *value == ceiling {
                    nodes.push(node);
                }
                *value = cost;
            }
        }
        // Endpoint walks overlap heavily on a surface. Queue the final minimum
        // once per vertex, rather than retaining every superseded seed.
        for &node in &nodes {
            if !field
                .components
                .iter()
                .any(|&known| kernel.index.connected_nodes(known, node))
            {
                field.components.push(node);
            }
        }
        field.queue = nodes
            .into_iter()
            .map(|node| Queue(field.costs[node as usize], node as usize))
            .collect();
        field
    }

    #[cfg(any(feature = "standalone", test))]
    pub(super) fn forward_direction(mut self, forward: bool) -> Self {
        self.reverse = !forward;
        self
    }

    fn seed(&mut self, node: u32, cost: f64) {
        if cost < self.costs[node as usize] {
            if !self
                .components
                .iter()
                .any(|&known| self.kernel.index.connected_nodes(known, node))
            {
                self.components.push(node);
            }
            self.costs[node as usize] = cost;
            self.queue.push(Queue(cost, node as usize));
        }
    }

    pub(super) fn with_prepared(
        mut self,
        prepared: Option<&'a Prepared>,
        starts: &Attachment,
    ) -> Self {
        self.prepared = prepared;
        self.reachable = prepared.map(|p| {
            p.components
                .reaching(self.queue.iter().map(|&Queue(_, node)| node as u32))
        });
        if self.ceiling.is_finite() {
            self.forward =
                prepared.and_then(|p| p.forward(self.kernel, starts, self.opt, self.excess));
            self.queue = std::mem::take(&mut self.queue)
                .into_iter()
                .map(|Queue(cost, node)| Queue(self.priority(cost, node), node))
                .collect();
        }
        self
    }

    #[cfg(any(feature = "standalone", test))]
    pub(super) fn with_origin(mut self, starts: &Attachment) -> Self {
        if self.excess || starts.candidates.is_empty() {
            return self;
        }
        let bounds = TargetBounds::new(starts.candidates.iter().map(|c| self.kernel.point(c.node)));
        let scale = self.kernel.minimum_length_ratio
            * (0.8 * 3.6 / (self.opt.speed_kph * 1.24).clamp(3., 45.))
            * (1. - 1e-12);
        let values =
            if self.kernel.lons.len() <= crate::resources::cache_budget(32 * 1024 * 1024, 64) / 8 {
                vec![std::cell::Cell::new(f64::NAN); self.kernel.lons.len()]
            } else {
                vec![]
            };
        self.origin = Some(GeographicPotential {
            bounds,
            scale,
            values,
        });
        self.queue = std::mem::take(&mut self.queue)
            .into_iter()
            .map(|Queue(cost, node)| Queue(self.priority(cost, node), node))
            .collect();
        self
    }
    fn potential(&self, node: usize) -> f64 {
        if let Some(field) = self.forward {
            field.values[node].min(field.maximum)
        } else {
            self.origin.as_ref().map_or(0., |origin| {
                if let Some(value) = origin.values.get(node)
                    && !value.get().is_nan()
                {
                    return value.get();
                }
                let value = origin.bounds.meters(self.kernel.point(node as u32)) * origin.scale;
                if let Some(slot) = origin.values.get(node) {
                    slot.set(value);
                }
                value
            })
        }
    }
    fn priority(&self, cost: f64, node: usize) -> f64 {
        cost + self.potential(node)
    }

    fn edge_cost(&self, edge: u32, meters: f64) -> f64 {
        let (seconds, cost) = self.kernel.metric(edge, self.opt);
        meters
            * if self.excess {
                (cost - self.wait_factor * seconds).max(0.)
            } else {
                cost
            }
    }

    pub(super) fn get(&mut self, target: u32, ceiling: f64) -> f64 {
        if let (Some(prepared), Some(reachable)) = (self.prepared, &self.reachable)
            && !reachable[prepared.components.node[target as usize] as usize]
        {
            return self.costs[target as usize].min(ceiling);
        }
        // A walking attachment can lie on a disconnected bicycle component.
        // Its bound is the ceiling, without exhausting another component's
        // entire reverse search just to establish that absence.
        if !self
            .components
            .iter()
            .any(|&node| self.kernel.index.connected_nodes(node, target))
        {
            return self.costs[target as usize].min(ceiling);
        }
        // Nonnegative weights make a discovered value final once it is no
        // larger than the unsettled frontier. Equality is safe, including
        // zero-cost cycling plateaus. Resuming retains all unsettled work and the eager search's
        // exact floating-point edge additions.
        while let Some(&Queue(frontier, _)) = self.queue.peek() {
            if self.forward.is_some() || self.origin.is_some() {
                // An origin-to-node distance is a consistent reverse-search
                // potential. The frontier certifies the requested scalar,
                // rather than accepting a node merely because it was popped.
                // Expand ties and a conservative roundoff band; values still
                // use the original edge additions, without quantization.
                let wanted = self.costs[target as usize].min(ceiling);
                let margin = 8. * self.kernel.lons.len() as f64 * f64::EPSILON + 1e-12;
                if wanted == 0. || frontier > self.priority(wanted, target as usize) * (1. + margin)
                {
                    return wanted;
                }
            } else {
                if self.costs[target as usize] <= frontier {
                    return self.costs[target as usize].min(ceiling);
                }
                if frontier >= ceiling {
                    return ceiling;
                }
            }
            let Queue(priority, node) = self.queue.pop().unwrap();
            let cost = self.costs[node];
            if priority > self.priority(cost, node) {
                continue;
            }
            let mut edge = if self.reverse {
                self.links.head[node]
            } else {
                let edge = self.kernel.offsets[node];
                if edge < self.kernel.offsets[node + 1] {
                    edge
                } else {
                    u32::MAX
                }
            };
            while edge != u32::MAX {
                let mut current_edge = edge;
                let mut previous = node;
                let mut candidate = cost;
                for step in 0..64 {
                    let source = if self.reverse {
                        self.links.source(self.kernel, current_edge)
                    } else {
                        self.kernel.targets[current_edge as usize] as usize
                    };
                    let weight = self
                        .prepared
                        .and_then(|p| p.weight(self.kernel, current_edge, self.opt))
                        .map_or_else(
                            || {
                                self.edge_cost(
                                    current_edge,
                                    self.kernel.distances[current_edge as usize] as f64 / 100.,
                                )
                            },
                            |w| if self.excess { w.excess } else { w.cost },
                        );
                    candidate += weight;
                    if candidate >= self.costs[source] {
                        break;
                    }
                    self.costs[source] = candidate;
                    let next = self
                        .links
                        .through(self.kernel, source, previous, self.reverse);
                    if next == Some(u32::MAX) {
                        break;
                    }
                    if step == 63 || next.is_none() {
                        self.queue
                            .push(Queue(self.priority(candidate, source), source));
                        break;
                    }
                    previous = source;
                    current_edge = next.unwrap();
                }
                edge = if self.reverse {
                    self.links.next[edge as usize]
                } else if edge + 1 < self.kernel.offsets[node + 1] {
                    edge + 1
                } else {
                    u32::MAX
                };
            }
        }
        // An exhausted field needs only its values, not retained heap capacity.
        self.queue = BinaryHeap::new();
        self.costs[target as usize].min(ceiling)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_bounds_match_eager_search_through_cycles_ties_and_partial_attachments() {
        let nodes: Vec<_> = (0..17).map(|n| [n as f64 * 0.001, 0.]).collect();
        let mut edges = Vec::new();
        for node in 0..15 {
            for &step in if node % 5 == 0 {
                &[1, 3, 7][..]
            } else {
                &[1][..]
            } {
                edges.push((
                    node,
                    (node + step) % 15,
                    10_000 + node * 17,
                    (node * 10 + step) as i64,
                    (30 << 8)
                        | if step == 1 {
                            (15 << 14) | (2 << 3) | if node % 2 == 0 { 2 } else { 0 }
                        } else {
                            (80 << 14) | 6
                        },
                ));
            }
        }
        let backwards: Vec<_> = edges
            .iter()
            .filter(|&&(from, to, _, _, _)| to == (from + 1) % 15)
            .map(|&(from, to, distance, way, attributes)| (to, from, distance, way, attributes))
            .collect();
        edges.extend(backwards);
        edges.push((14, 16, 20_000, 999, 30 << 8));
        let k = super::super::tests::fixture(&nodes, &edges, &[]);
        let ends = k.index.attach_bicycle_matching(
            &k.graph(),
            [0.0134, 0.],
            100.,
            4.8 / 3.6,
            false,
            false,
            &|_| true,
        );
        assert!(!ends.candidates.is_empty());
        let links = Links::new(&k);
        let starts = k.index.attach_bicycle_matching(
            &k.graph(),
            [0.0004, 0.],
            100.,
            4.8 / 3.6,
            true,
            false,
            &|_| true,
        );
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            for speed_kph in [5., 18., 40.] {
                let opt = BikeOptions {
                    profile,
                    speed_kph,
                    ..Default::default()
                };
                assert!(Prepared::for_batch(&k, opt, 15).is_none());
                let prepared = Prepared::for_batch(&k, opt, 16).unwrap();
                for edge in 0..k.targets.len() as u32 {
                    for option in [
                        opt,
                        BikeOptions {
                            profile: Profile::Fast,
                            ..opt
                        },
                    ] {
                        let actual = prepared.weight(&k, edge, option).unwrap();
                        let (seconds, cost) = k.metric(edge, option);
                        let meters = k.distances[edge as usize] as f64 / 100.;
                        let factor = if matches!(option.profile, Profile::Fast) {
                            1.
                        } else {
                            0.8
                        };
                        assert_eq!(actual.seconds.to_bits(), (meters * seconds).to_bits());
                        assert_eq!(actual.cost.to_bits(), (meters * cost).to_bits());
                        assert_eq!(
                            actual.excess.to_bits(),
                            (meters * (cost - factor * seconds).max(0.)).to_bits()
                        );
                    }
                }
                for (prepared, geographic) in
                    [(None, false), (None, true), (Some(&prepared), false)]
                {
                    for excess in [false, true] {
                        for ceiling in [0., 1., 30., 100., f64::INFINITY] {
                            let expected = k.costs_to(&ends, opt, excess, ceiling);
                            for order in [1, 3, 7, 15] {
                                let mut field = Costs::new(&k, &links, &ends, opt, excess, ceiling)
                                    .with_prepared(prepared, &starts);
                                if geographic {
                                    field = field.with_origin(&starts);
                                }
                                let queued = field.queue.len();
                                if prepared.is_some() {
                                    assert_eq!(field.get(16, f64::INFINITY), ceiling);
                                    assert_eq!(
                                        field.queue.len(),
                                        queued,
                                        "A directed dead end must not drain the field"
                                    );
                                }
                                assert_eq!(field.get(15, f64::INFINITY), ceiling);
                                assert_eq!(
                                    field.queue.len(),
                                    queued,
                                    "A disconnected target must not drain the reachable component"
                                );
                                for i in 0..32 {
                                    let node = (i * order + 13) % 16;
                                    for limit in [0., 0.1, 3., 0.5, f64::INFINITY] {
                                        assert_eq!(
                                            field.get(node, limit).to_bits(),
                                            expected[node as usize].min(limit).to_bits(),
                                            "{profile:?}/{speed_kph}/{excess}/{ceiling}/{order}/{node}/{limit}"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
