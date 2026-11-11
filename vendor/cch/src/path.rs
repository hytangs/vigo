//! Shortcut path unpacking — node-path reconstruction after a CCH query.
//!
//! Provides [`node_path`], shortcut unpacking, and reusable query state.
//!
//! The algorithm is a bidirectional elimination-tree search that records
//! predecessors in both the forward and backward sweeps, selects the
//! meeting node exactly as routingkit does (strict `<` update along the
//! backward ancestor walk), and then recursively unpacks each shortcut arc
//! via a merge-join over the lower-triangle down-neighbour lists — choosing
//! the FIRST witness, matching routingkit's `unpack_forward_arc` /
//! `unpack_backward_arc`.

use crate::INF_WEIGHT;
use crate::paged::PagedVec;
use crate::bundle::{CchView, INVALID_ID, MetricView};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Direction selector for shortcut unpacking. `Fwd` uses forward
/// (up-direction) customized weights; `Bwd` uses backward weights.
enum Dir {
    Fwd,
    Bwd,
}

/// Find the up-arc id from `tail` to `head`, or `None` if no such arc exists.
/// Keep the short adjacency case linear; high-degree separator nodes use
/// their sorted heads to avoid scanning the whole range during unpacking.
fn find_up_arc(cch: &CchView, tail: u32, head: u32) -> Option<u32> {
    let from = cch.up_first_out[tail as usize];
    let to = cch.up_first_out[tail as usize + 1];
    let heads = &cch.up_head[from as usize..to as usize];
    let offset = if heads.len() <= 16 {
        heads.iter().position(|&value| value == head)
    } else {
        heads.binary_search(&head).ok()
    };
    offset.map(|index| from + index as u32)
}

/// Recursively unpack CCH arc (`x` → `y`) with id `xy`, emitting the ORIGINAL
/// dense node ids of the path's interior + head into `out` in source→target
/// order. `order[v]` maps a rank-space (CCH) node id back to its dense id.
///
/// The arc is a shortcut iff there is a lower-triangle witness `z` (common
/// down-neighbour of x and y) whose two half-arc weights sum to the arc's
/// customized weight (in the chosen direction). We pick the FIRST such
/// witness, matching routingkit's `unpack_forward_arc` / `unpack_backward_arc`.
///
/// The algorithm uses single-character names for rank-space nodes (`x`, `y`,
/// `z`) and arc cursor positions (`a`, `b`) which are conventional in CCH
/// literature; the `many_single_char_names` lint does not apply here.
// The 8-argument signature keeps the shortcut-unpacking state explicit.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::many_single_char_names)] // x,y,z,a,b conventional in CCH literature
fn unpack_arc(
    cch: &CchView,
    metric: &MetricView,
    order: &[u32],
    dir: &Dir,
    x: u32,
    y: u32,
    xy: u32,
    out: &mut Vec<u32>,
) {
    // Merge-join over the down-neighbour lists of x and y to find common
    // lower neighbours (the lower triangle of arc x→y).
    let (mut a, ae) = (
        cch.down_first_out[x as usize],
        cch.down_first_out[x as usize + 1],
    );
    let (mut b, be) = (
        cch.down_first_out[y as usize],
        cch.down_first_out[y as usize + 1],
    );
    while a != ae && b != be {
        let hx = cch.down_head[a as usize];
        let hy = cch.down_head[b as usize];
        match hx.cmp(&hy) {
            std::cmp::Ordering::Less => a += 1,
            std::cmp::Ordering::Greater => b += 1,
            std::cmp::Ordering::Equal => {
                // z = hx is a common lower neighbour.
                // bottom_arc = up-arc z→x (== down_to_up[a]);
                // mid_arc    = up-arc z→y (== down_to_up[b]).
                let bottom_arc = cch.down_to_up[a as usize];
                let mid_arc = cch.down_to_up[b as usize];
                let z = hx;
                match dir {
                    Dir::Fwd => {
                        // forward fit: f[xy] == b[bottom] + f[mid]. Recurse:
                        // bottom half backward (z→x), mid half forward (z→y).
                        if metric.forward[xy as usize]
                            == metric.backward[bottom_arc as usize]
                                .saturating_add(metric.forward[mid_arc as usize])
                        {
                            unpack_arc(cch, metric, order, &Dir::Bwd, z, x, bottom_arc, out);
                            unpack_arc(cch, metric, order, &Dir::Fwd, z, y, mid_arc, out);
                            return;
                        }
                    }
                    Dir::Bwd => {
                        // backward fit: b[xy] == f[bottom] + b[mid]. Recurse:
                        // mid half backward (z→y), bottom half forward (z→x).
                        if metric.backward[xy as usize]
                            == metric.forward[bottom_arc as usize]
                                .saturating_add(metric.backward[mid_arc as usize])
                        {
                            unpack_arc(cch, metric, order, &Dir::Bwd, z, y, mid_arc, out);
                            unpack_arc(cch, metric, order, &Dir::Fwd, z, x, bottom_arc, out);
                            return;
                        }
                    }
                }
                a += 1;
                b += 1;
            }
        }
    }
    // No witness: this is an original arc. Emit the head/tail per direction.
    match dir {
        Dir::Fwd => out.push(order[x as usize]),
        Dir::Bwd => out.push(order[y as usize]),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Reusable, buffer-recycling node-path query against a single CCH.
///
/// [`node_path`] allocates dense scratch and rebuilds the inverse-rank order
/// on every call. `PathQuery` computes that order once and allocates search
/// pages only when reached by a query,
/// then answers each [`PathQuery::path`] reusing the buffers with a cheap
/// *touched-only* reset — restoring just the entries the previous query
/// dirtied, never the whole `node_count`-sized arrays.
///
/// Results are byte-identical to [`node_path`] (same bidirectional
/// elimination-tree search, same strict-`<` meeting tie-break, same shortcut
/// unpacking).
///
/// ```
/// # use cch::graph::Graph;
/// # use cch::{Cch, degree_order, PathQuery, node_path};
/// let graph = Graph { first_out: vec![0, 1, 2, 3, 3], head: vec![1, 2, 3], weight: vec![1, 1, 1] };
/// let order = degree_order(&graph);
/// let cch = Cch::build(&graph, &order);
/// let metric = cch.customize(&graph.weight);
/// let cv = cch.view();
/// let mv = metric.view();
/// let mut q = PathQuery::new(&cv);
/// // Each `.path` reuses the buffers and matches the one-shot `node_path`.
/// assert_eq!(q.path(&mv, 0, 3), node_path(&cv, &mv, 0, 3));
/// assert_eq!(q.path(&mv, 1, 3), node_path(&cv, &mv, 1, 3));
/// ```
pub struct PathQuery<'a> {
    cch: &'a CchView<'a>,
    state: PathQueryState,
}

impl<'a> PathQuery<'a> {
    /// Allocate reusable path buffers for one immutable structure.
    #[must_use]
    pub fn new(cch: &'a CchView<'a>) -> Self {
        Self {
            cch,
            state: PathQueryState::new(cch),
        }
    }

    /// Reuse the validated order of an earlier query on this same structure,
    /// so a query recreated after its scratch was released starts at once.
    /// Panics if `order` was validated for a different structure.
    #[must_use]
    pub fn with_order(cch: &'a CchView<'a>, order: &ValidatedOrder) -> Self {
        assert!(order.validates(cch), "ValidatedOrder belongs to another CchView");
        Self {
            cch,
            state: PathQueryState::with_order(order.order.clone()),
        }
    }

    /// This structure's validated inverse-rank order, for a later query.
    #[must_use]
    pub fn order(&self) -> ValidatedOrder {
        ValidatedOrder {
            order: self.state.order.clone(),
            up_head: (self.cch.up_head.as_ptr() as usize, self.cch.up_head.len()),
        }
    }

    /// Retained buffer capacity, excluding the borrowed graph and allocator overhead.
    #[must_use]
    pub fn byte_length(&self) -> usize {
        let s = &self.state;
        s.scratch_bytes() + s.order.len() * std::mem::size_of::<u32>()
    }

    /// Return the shortest path, recycling the previous query's buffers.
    #[must_use]
    pub fn path(&mut self, metric: &MetricView, source: u32, target: u32) -> Option<Vec<u32>> {
        self.state.path(self.cch, metric, source, target)
    }

    /// Share the forward sweep for destinations in one call. No search state
    /// is reused across calls or metrics; each path retains the scalar tie rule.
    #[must_use]
    pub fn paths_from(
        &mut self,
        metric: &MetricView,
        source: u32,
        targets: &[u32],
    ) -> Vec<Option<Vec<u32>>> {
        if targets.is_empty() {
            return Vec::new();
        }
        self.state.prepare_source(self.cch, metric, source);
        targets
            .iter()
            .map(|&target| {
                self.state
                    .path_from_prepared_source(self.cch, metric, source, target)
            })
            .collect()
    }

    /// Row-major `sources × targets` distances, [`INF_WEIGHT`] when
    /// unreachable, reusing this query's validated order and paged scratch:
    /// no node-sized buffer is filled or checked per call.
    #[must_use]
    pub fn distance_matrix(
        &mut self,
        metric: &MetricView,
        sources: &[u32],
        targets: &[u32],
    ) -> Vec<u32> {
        self.state
            .distance_matrix(self.cch, metric, sources, targets)
    }
}

/// An inverse-rank order whose structure's `up_head` was checked against its
/// node count, bound to that exact `up_head` memory.
#[derive(Clone)]
pub struct ValidatedOrder {
    order: std::sync::Arc<[u32]>,
    up_head: (usize, usize),
}

impl ValidatedOrder {
    fn validates(&self, cch: &CchView<'_>) -> bool {
        self.order.len() == cch.node_count() as usize
            && self.up_head == (cch.up_head.as_ptr() as usize, cch.up_head.len())
    }
}

/// Own an in-memory structure and its reusable path buffers without borrowing
/// from the owning object. Metrics can change between calls; topology cannot.
pub struct OwnedPathQuery {
    structure: crate::Cch,
    state: PathQueryState,
}

impl OwnedPathQuery {
    #[must_use]
    pub fn new(structure: crate::Cch) -> Self {
        let state = PathQueryState::new(&structure.view());
        Self { structure, state }
    }

    #[must_use]
    pub fn structure(&self) -> &crate::Cch {
        &self.structure
    }

    #[must_use]
    pub fn path(&mut self, metric: &MetricView, source: u32, target: u32) -> Option<Vec<u32>> {
        self.state
            .path(&self.structure.view(), metric, source, target)
    }

    /// Row-major distances; see [`PathQuery::distance_matrix`].
    #[must_use]
    pub fn distance_matrix(
        &mut self,
        metric: &MetricView,
        sources: &[u32],
        targets: &[u32],
    ) -> Vec<u32> {
        self.state
            .distance_matrix(&self.structure.view(), metric, sources, targets)
    }
}

struct PathQueryState {
    /// Inverse rank: `order[rank[v]] = v`. Computed once in [`Self::new`] and
    /// never mutated thereafter (invariant; not part of the page reset).
    order: std::sync::Arc<[u32]>,
    /// Distances XOR-encoded with INF_WEIGHT: zero means unreachable.
    /// Zero-filled allocation avoids touching every graph page on a cold query.
    fwd_dist: PagedVec<u32>,
    /// Forward predecessors, read only for reached nodes. The source is
    /// explicitly marked INVALID_ID when each query starts.
    fwd_pred: PagedVec<u32>,
    /// Backward distances use the same zero-as-unreachable encoding.
    bwd_dist: PagedVec<u32>,
    /// Backward predecessors; the target is explicitly marked INVALID_ID.
    bwd_pred: PagedVec<u32>,
    /// Reconstruction scratch holding the forward elim-path `[meeting, .., s]`.
    /// Reused across queries; capacity grows monotonically.
    up_path: Vec<u32>,
}

impl PathQueryState {
    fn scratch_bytes(&self) -> usize {
        self.fwd_dist.byte_length() + self.fwd_pred.byte_length()
            + self.bwd_dist.byte_length() + self.bwd_pred.byte_length()
            + self.up_path.capacity() * std::mem::size_of::<u32>()
    }

    // Bound accumulated regional coverage between queries. A large individual
    // query can use more scratch; its pages are released before the next one.
    fn trim_scratch(&mut self) {
        if self.scratch_bytes() > 32 * 1024 * 1024 {
            self.fwd_dist.fill(0);
            self.fwd_pred.fill(0);
            self.bwd_dist.fill(0);
            self.bwd_pred.fill(0);
            self.up_path = Vec::new();
        }
    }

    /// Allocate the sparse page tables and the inverse-rank order once.
    /// Panics if the CCH contains an invalid up-arc head or rank.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)] // v < node_count ≤ u32::MAX by CCH invariant
    fn new(cch: &CchView<'_>) -> Self {
        let n = cch.node_count() as usize;
        // Reject malformed structures before the first query.
        assert!(
            cch.up_head
                .iter()
                .fold(true, |valid, &h| valid & ((h as usize) < n)),
            "malformed CchView: up_head contains a node id >= node_count"
        );
        // order = inverse(rank): order[rank[v]] = v. Computed once.
        let mut order = vec![0u32; n];
        for v in 0..n {
            order[cch.rank[v] as usize] = v as u32; // v < node_count ≤ u32::MAX
        }
        Self::with_order(order.into())
    }

    fn with_order(order: std::sync::Arc<[u32]>) -> Self {
        let n = order.len();
        Self {
            order,
            fwd_dist: PagedVec::new(n, 0),
            fwd_pred: PagedVec::new(n, 0),
            bwd_dist: PagedVec::new(n, 0),
            bwd_pred: PagedVec::new(n, 0),
            up_path: Vec::new(),
        }
    }

    /// Shortest-path node sequence in ORIGINAL dense node ids, source first,
    /// target last, reusing this query's buffers. Returns `None` if `target` is
    /// unreachable from `source`; self-pair (`source == target`) returns
    /// `Some(vec![source])`. Identical to [`node_path`].
    ///
    /// # Panics
    ///
    /// Panics via `expect` if the CCH structure is inconsistent (an arc recorded
    /// in `fwd_pred`/`bwd_pred` is not found in the up-arc list). This never
    /// happens with a valid, routingkit-produced CCH bundle.
    #[must_use]
    #[allow(clippy::too_many_lines)] // faithful port of routingkit's path query — splitting obscures algorithm
    #[allow(clippy::many_single_char_names)] // s,t,x,y,l: conventional rank-space node variables
    fn path(
        &mut self,
        cch: &CchView<'_>,
        metric: &MetricView,
        source: u32,
        target: u32,
    ) -> Option<Vec<u32>> {
        if source == target {
            return Some(vec![source]);
        }
        self.prepare_source(cch, metric, source);
        self.path_from_prepared_source(cch, metric, source, target)
    }

    /// Elimination-tree distance matrix (routingkit's
    /// `cch_compute_distance_matrix`): per source, an upward sweep along its
    /// ancestor chain, then a downward sweep over the targets' ancestor
    /// chains, parents before children. `fwd_dist` holds the tentative
    /// distances in the zero-as-unreachable encoding; a nonzero `bwd_dist`
    /// marks a node on some target's chain. Both are reset only where touched.
    #[allow(clippy::many_single_char_names)]
    fn distance_matrix(
        &mut self,
        cch: &CchView<'_>,
        metric: &MetricView,
        sources: &[u32],
        targets: &[u32],
    ) -> Vec<u32> {
        if sources.is_empty() || targets.is_empty() {
            return Vec::new();
        }
        self.trim_scratch();
        self.fwd_dist.recycle(0);
        self.bwd_dist.recycle(0);
        let up_first_out = cch.up_first_out;
        let up_head = cch.up_head;
        let elim = cch.elimination_tree_parent;
        let (forward, backward) = (metric.forward, metric.backward);

        // Each target's chain stops at the first node an earlier target marked.
        let mut target_node = Vec::with_capacity(targets.len());
        let mut chain_end = Vec::with_capacity(targets.len());
        for &target in targets {
            let t = cch.rank[target as usize];
            target_node.push(t);
            let mut end = INVALID_ID;
            let mut x = t;
            while x != INVALID_ID {
                if self.bwd_dist[x as usize] != 0 {
                    end = x;
                    break;
                }
                self.bwd_dist[x as usize] = 1;
                x = elim[x as usize];
            }
            chain_end.push(end);
        }
        // Later targets' chains hang below earlier ones, so this sequence
        // reversed visits every node after all of its marked ancestors.
        let mut sweep = Vec::new();
        for (&t, &end) in target_node.iter().zip(&chain_end).rev() {
            let mut x = t;
            while x != end {
                sweep.push(x);
                x = elim[x as usize];
            }
        }

        let dist = &mut self.fwd_dist;
        let mut out = vec![0u32; sources.len() * targets.len()];
        for (row, &source) in out.chunks_exact_mut(targets.len()).zip(sources) {
            let s = cch.rank[source as usize];
            dist[s as usize] = INF_WEIGHT; // distance 0
            let mut x = s;
            loop {
                let dx = dist[x as usize] ^ INF_WEIGHT;
                if dx != INF_WEIGHT {
                    let from = up_first_out[x as usize] as usize;
                    let to = up_first_out[x as usize + 1] as usize;
                    for (&y, &w) in up_head[from..to].iter().zip(&forward[from..to]) {
                        let cand = dx.saturating_add(w);
                        let slot = &mut dist[y as usize];
                        if cand < (*slot ^ INF_WEIGHT) {
                            *slot = cand ^ INF_WEIGHT;
                        }
                    }
                }
                let parent = elim[x as usize];
                if parent == INVALID_ID {
                    break;
                }
                x = parent;
            }
            for &x in sweep.iter().rev() {
                let from = up_first_out[x as usize] as usize;
                let to = up_first_out[x as usize + 1] as usize;
                let current = dist[x as usize] ^ INF_WEIGHT;
                let mut best = current;
                for (&y, &w) in up_head[from..to].iter().zip(&backward[from..to]) {
                    let dy = dist[y as usize] ^ INF_WEIGHT;
                    if dy != INF_WEIGHT {
                        best = best.min(dy.saturating_add(w));
                    }
                }
                if best != current {
                    dist[x as usize] = best ^ INF_WEIGHT;
                }
            }
            for (value, &t) in row.iter_mut().zip(&target_node) {
                *value = dist[t as usize] ^ INF_WEIGHT;
            }
            // Only the source's chain and the targets' chains hold labels:
            // every up-arc points to an elimination-tree ancestor.
            let mut x = s;
            while x != INVALID_ID {
                if dist[x as usize] != 0 {
                    dist[x as usize] = 0;
                }
                x = elim[x as usize];
            }
            for &x in &sweep {
                if dist[x as usize] != 0 {
                    dist[x as usize] = 0;
                }
            }
        }
        out
    }

    #[allow(clippy::many_single_char_names)]
    fn prepare_source(&mut self, cch: &CchView<'_>, metric: &MetricView, source: u32) {
        self.trim_scratch();
        // Preserve the immutable order but release pages from earlier origins.
        self.fwd_dist.recycle(0);
        self.fwd_pred.recycle(INVALID_ID);

        // Hoist borrowed slices so the inner relaxation loops index plain
        // `&[u32]`s and slice each node's arc range once — letting the compiler
        // elide the per-arc bounds checks on `up_head` and the weight arrays.
        let up_first_out = cch.up_first_out;
        let up_head = cch.up_head;
        let elim = cch.elimination_tree_parent;
        let forward = metric.forward;

        let s = cch.rank[source as usize];

        // Forward sweep from s (up-arcs, forward weights). Relax along the
        // elimination-tree ancestor chain of s, recording predecessors.
        // Mirrors routingkit's `run()`.
        self.fwd_dist[s as usize] = INF_WEIGHT;
        self.fwd_pred[s as usize] = INVALID_ID;
        {
            let fwd_dist = &mut self.fwd_dist;
            let fwd_pred = &mut self.fwd_pred;
            let mut x = s;
            loop {
                let dx = fwd_dist[x as usize] ^ INF_WEIGHT;
                if dx != INF_WEIGHT {
                    let from = up_first_out[x as usize] as usize;
                    let to = up_first_out[x as usize + 1] as usize;
                    let heads = &up_head[from..to];
                    let weights = &forward[from..to];
                    for (&yv, &w) in heads.iter().zip(weights) {
                        let y = yv as usize;
                        let cand = dx.saturating_add(w);
                        let slot = &mut fwd_dist[y];
                        if cand < (*slot ^ INF_WEIGHT) {
                            *slot = cand ^ INF_WEIGHT;
                            fwd_pred[y] = x;
                        }
                    }
                }
                let parent = elim[x as usize];
                if parent == INVALID_ID {
                    break;
                }
                x = parent;
            }
        }
    }

    #[allow(clippy::too_many_lines, clippy::many_single_char_names)]
    fn path_from_prepared_source(
        &mut self,
        cch: &CchView<'_>,
        metric: &MetricView,
        source: u32,
        target: u32,
    ) -> Option<Vec<u32>> {
        if source == target {
            return Some(vec![source]);
        }
        // Forward scratch is shared by every target of this prepared source.
        self.bwd_dist.recycle(0);
        self.bwd_pred.recycle(INVALID_ID);
        let up_first_out = cch.up_first_out;
        let up_head = cch.up_head;
        let elim = cch.elimination_tree_parent;
        let backward = metric.backward;
        let t = cch.rank[target as usize];
        // Backward sweep from t (up-arcs, backward weights), choosing the meeting
        // node EXACTLY as routingkit does: walk t's ancestor chain in order,
        // relaxing then — if x is in the forward search space — updating the
        // meeting node with a STRICT `<` test. This reproduces routingkit's
        // tie-break (first equal-cost ancestor wins) so node paths are
        // byte-identical to `get_node_path`.
        self.bwd_dist[t as usize] = INF_WEIGHT;
        self.bwd_pred[t as usize] = INVALID_ID;
        let mut meeting = INVALID_ID;
        let mut best = INF_WEIGHT;
        {
            let bwd_dist = &mut self.bwd_dist;
            let bwd_pred = &mut self.bwd_pred;
            let mut x = t;
            loop {
                let dx = bwd_dist[x as usize] ^ INF_WEIGHT;
                if dx != INF_WEIGHT {
                    let from = up_first_out[x as usize] as usize;
                    let to = up_first_out[x as usize + 1] as usize;
                    let heads = &up_head[from..to];
                    let weights = &backward[from..to];
                    for (&yv, &w) in heads.iter().zip(weights) {
                        let y = yv as usize;
                        let cand = dx.saturating_add(w);
                        let slot = &mut bwd_dist[y];
                        if cand < (*slot ^ INF_WEIGHT) {
                            *slot = cand ^ INF_WEIGHT;
                            bwd_pred[y] = x;
                        }
                    }
                }
                // Every finite forward label lies on the source's ancestor
                // chain: all CCH up-arcs point to elimination-tree ancestors.
                // Its distance therefore certifies membership too. Untouched
                // pages read INF, including after a different source/metric.
                let fd = self.fwd_dist[x as usize] ^ INF_WEIGHT;
                if fd != INF_WEIGHT {
                    let bd = bwd_dist[x as usize] ^ INF_WEIGHT;
                    if bd != INF_WEIGHT {
                        let l = fd.saturating_add(bd);
                        if l < best {
                            best = l;
                            meeting = x;
                        }
                    }
                }
                let parent = elim[x as usize];
                if parent == INVALID_ID {
                    break;
                }
                x = parent;
            }
        }

        if meeting == INVALID_ID || best == INF_WEIGHT {
            return None;
        }

        let mut out: Vec<u32> = Vec::new();
        let order = &self.order;

        // Forward half: chain source → meeting via fwd_pred (rank space).
        // up_path = [meeting, pred(meeting), ..., s]; unpack from top down so we
        // emit interior heads in source→target order.
        self.up_path.clear();
        self.up_path.push(meeting);
        {
            let mut x = meeting;
            while self.fwd_pred[x as usize] != INVALID_ID {
                x = self.fwd_pred[x as usize];
                self.up_path.push(x);
            }
        }
        // up_path is [meeting, ..., s]; iterate i from high (near s) down to 1.
        for i in (1..self.up_path.len()).rev() {
            let tail = self.up_path[i]; // closer to s
            let head = self.up_path[i - 1]; // closer to meeting
            let arc = find_up_arc(cch, tail, head).expect("forward up-arc on elim path");
            unpack_arc(cch, metric, order, &Dir::Fwd, tail, head, arc, &mut out);
        }

        // Backward half: meeting → target via bwd_pred. Each step y = pred(x) is
        // an up-arc y→x in rank space; unpack it backward (emits head = order[x]).
        {
            let mut x = meeting;
            let mut y = self.bwd_pred[x as usize];
            while y != INVALID_ID {
                let arc = find_up_arc(cch, y, x).expect("backward up-arc on elim path");
                unpack_arc(cch, metric, order, &Dir::Bwd, y, x, arc, &mut out);
                x = y;
                y = self.bwd_pred[y as usize];
            }
            // x is now the last node on the backward chain (== t in rank space).
            out.push(order[x as usize]);
        }

        Some(out)
    }
}

/// Shortest-path node sequence in ORIGINAL dense node ids, source first,
/// target last. Returns `None` if `target` is unreachable from `source`.
/// Self-pair (`source == target`) returns `Some(vec![source])`.
///
/// Pure-Rust port of routingkit's CCH node-path query: a bidirectional
/// elimination-tree search recording predecessors, followed by recursive
/// shortcut unpacking. Produces results byte-identical to the C++
/// `get_node_path` (verified by `mmap_unpack_matches_cpp_reference_over_200_pairs`).
///
/// This is a one-shot query: it allocates its scratch buffers and rebuilds the
/// inverse-rank `order` per call. For repeated queries against the same CCH use
/// [`PathQuery`], which amortizes both away across calls — clearly faster than
/// the C++ oracle for repeated path queries. `node_path` is kept standalone
/// (rather than delegating to `PathQuery::new(..).path(..)`) because the
/// one-time `O(arc_count)` `up_head` validation in [`PathQuery::new`] would
/// regress this one-shot path meaningfully below C++ parity; see the benches.
///
/// # Panics
///
/// Panics via `expect` if the CCH structure is inconsistent (an arc recorded
/// in `fwd_pred` or `bwd_pred` is not found in the up-arc list). This should
/// never happen with a valid, routingkit-produced CCH bundle.
#[must_use]
#[allow(clippy::too_many_lines)] // faithful port of routingkit's path query — splitting obscures algorithm
#[allow(clippy::many_single_char_names)] // s,t,n,x,y,l: conventional rank-space node variables
#[allow(clippy::cast_possible_truncation)] // v < node_count ≤ u32::MAX by CCH invariant
pub fn node_path(cch: &CchView, metric: &MetricView, source: u32, target: u32) -> Option<Vec<u32>> {
    if source == target {
        return Some(vec![source]);
    }

    let n = cch.node_count() as usize;

    // Hoist borrowed slices so the inner relaxation loops index plain `&[u32]`s
    // and slice each node's arc range once — letting the compiler elide the
    // per-arc bounds checks on `up_head` and the weight arrays.
    let up_first_out = cch.up_first_out;
    let up_head = cch.up_head;
    let elim = cch.elimination_tree_parent;
    let forward = metric.forward;
    let backward = metric.backward;

    // order = inverse(rank): order[rank[v]] = v.
    let mut order = vec![0u32; n];
    for v in 0..n {
        order[cch.rank[v] as usize] = v as u32; // v < node_count ≤ u32::MAX
    }

    let s = cch.rank[source as usize];
    let t = cch.rank[target as usize];

    // Forward sweep from s (up-arcs, forward weights). Relax along the
    // elimination-tree ancestor chain of s, recording predecessors and
    // marking the forward search space. Mirrors routingkit's `run()`.
    let mut fwd_dist = vec![INF_WEIGHT; n];
    let mut fwd_pred = vec![INVALID_ID; n];
    let mut in_forward_search_space = vec![false; n];
    fwd_dist[s as usize] = 0;
    {
        let mut x = s;
        loop {
            in_forward_search_space[x as usize] = true;
            let dx = fwd_dist[x as usize];
            if dx != INF_WEIGHT {
                let from = up_first_out[x as usize] as usize;
                let to = up_first_out[x as usize + 1] as usize;
                let heads = &up_head[from..to];
                let weights = &forward[from..to];
                for (&yv, &w) in heads.iter().zip(weights) {
                    let y = yv as usize;
                    let cand = dx.saturating_add(w);
                    if cand < fwd_dist[y] {
                        fwd_dist[y] = cand;
                        fwd_pred[y] = x;
                    }
                }
            }
            let parent = elim[x as usize];
            if parent == INVALID_ID {
                break;
            }
            x = parent;
        }
    }

    // Backward sweep from t (up-arcs, backward weights), choosing the meeting
    // node EXACTLY as routingkit does: walk t's ancestor chain in order,
    // relaxing then — if x is in the forward search space — updating the
    // meeting node with a STRICT `<` test. This reproduces routingkit's
    // tie-break (first equal-cost ancestor wins) so node paths are
    // byte-identical to `get_node_path`.
    let mut bwd_dist = vec![INF_WEIGHT; n];
    let mut bwd_pred = vec![INVALID_ID; n];
    bwd_dist[t as usize] = 0;
    let mut meeting = INVALID_ID;
    let mut best = INF_WEIGHT;
    {
        let mut x = t;
        loop {
            let dx = bwd_dist[x as usize];
            if dx != INF_WEIGHT {
                let from = up_first_out[x as usize] as usize;
                let to = up_first_out[x as usize + 1] as usize;
                let heads = &up_head[from..to];
                let weights = &backward[from..to];
                for (&yv, &w) in heads.iter().zip(weights) {
                    let y = yv as usize;
                    let cand = dx.saturating_add(w);
                    if cand < bwd_dist[y] {
                        bwd_dist[y] = cand;
                        bwd_pred[y] = x;
                    }
                }
            }
            if in_forward_search_space[x as usize] {
                let fd = fwd_dist[x as usize];
                let bd = bwd_dist[x as usize];
                if fd != INF_WEIGHT && bd != INF_WEIGHT {
                    let l = fd.saturating_add(bd);
                    if l < best {
                        best = l;
                        meeting = x;
                    }
                }
            }
            let parent = cch.elimination_tree_parent[x as usize];
            if parent == INVALID_ID {
                break;
            }
            x = parent;
        }
    }

    if meeting == INVALID_ID || best == INF_WEIGHT {
        return None;
    }

    let mut out: Vec<u32> = Vec::new();

    // Forward half: chain source → meeting via fwd_pred (rank space).
    // up_path = [meeting, pred(meeting), ..., s]; unpack from top down so we
    // emit interior heads in source→target order.
    let mut up_path = vec![meeting];
    {
        let mut x = meeting;
        while fwd_pred[x as usize] != INVALID_ID {
            x = fwd_pred[x as usize];
            up_path.push(x);
        }
    }
    // up_path is [meeting, ..., s]; iterate i from high (near s) down to 1.
    for i in (1..up_path.len()).rev() {
        let tail = up_path[i]; // closer to s
        let head = up_path[i - 1]; // closer to meeting
        let arc = find_up_arc(cch, tail, head).expect("forward up-arc on elim path");
        unpack_arc(cch, metric, &order, &Dir::Fwd, tail, head, arc, &mut out);
    }

    // Backward half: meeting → target via bwd_pred. Each step y = pred(x) is
    // an up-arc y→x in rank space; unpack it backward (emits head = order[x]).
    {
        let mut x = meeting;
        let mut y = bwd_pred[x as usize];
        while y != INVALID_ID {
            let arc = find_up_arc(cch, y, x).expect("backward up-arc on elim path");
            unpack_arc(cch, metric, &order, &Dir::Bwd, y, x, arc, &mut out);
            x = y;
            y = bwd_pred[y as usize];
        }
        // x is now the last node on the backward chain (== t in rank space).
        out.push(order[x as usize]);
    }

    Some(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A 10-node cycle with a costly chord, persisted as mmappable bundles.
    ///
    /// Input arcs: 0→1 … 8→9 and 9→0 cost 1 each; the chord 0→5 costs 100.
    /// The shortest 0→5 path goes around the cycle (cost 5), forcing shortcut
    /// unpacking through contracted nodes.
    fn test_bundle_paths() -> (std::path::PathBuf, std::path::PathBuf) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let graph = crate::graph::Graph {
            first_out: vec![0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            head: vec![1, 5, 2, 3, 4, 5, 6, 7, 8, 9, 0],
            weight: vec![1, 100, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        };
        let order: Vec<u32> = (0u32..10).collect();
        let cch = crate::Cch::build(&graph, &order);
        let metric = cch.customize(&graph.weight);
        let dir = std::env::temp_dir().join(format!(
            "cch-path-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("test directory");
        let struct_path = dir.join("test.cch-struct");
        let metric_path = dir.join("test.cch-metric");
        cch.save_struct(&struct_path).expect("save_struct");
        metric.save(&metric_path).expect("save metric");
        (struct_path, metric_path)
    }

    /// Customized weight of the ORIGINAL arc (u,v): look up the up-arc u→v
    /// (forward weight) or the reverse up-arc v→u (backward weight). For this
    /// fixture all original arcs survive as CCH arcs in one direction.
    fn original_arc_weight(cch: &CchView, metric: &MetricView, u: u32, v: u32) -> u64 {
        let ru = cch.rank[u as usize];
        let rv = cch.rank[v as usize];
        let fwd = (cch.up_first_out[ru as usize]..cch.up_first_out[ru as usize + 1])
            .find(|&i| cch.up_head[i as usize] == rv)
            .map(|i| u64::from(metric.forward[i as usize]));
        let bwd = (cch.up_first_out[rv as usize]..cch.up_first_out[rv as usize + 1])
            .find(|&i| cch.up_head[i as usize] == ru)
            .map(|i| u64::from(metric.backward[i as usize]));
        fwd.or(bwd)
            .unwrap_or_else(|| panic!("no original CCH arc between rank {ru} and {rv}"))
    }

    /// Path endpoints must equal source/target; sum of original-arc weights
    /// must equal the query distance.
    #[test]
    fn path_query_endpoints_and_weight_match_distance() {
        use crate::bundle::{CchBundle, MetricBundle};
        use crate::query::distance_matrix;

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let (cv, mv) = (cch_bundle.view(), metric_bundle.view());
        let (s, t) = (0u32, 5u32);
        let path = node_path(&cv, &mv, s, t).expect("reachable");
        assert_eq!(*path.first().unwrap(), s);
        assert_eq!(*path.last().unwrap(), t);
        let dist = distance_matrix(&cv, &mv, &[s], &[t])[0];
        let summed: u64 = path
            .windows(2)
            .map(|w| original_arc_weight(&cv, &mv, w[0], w[1]))
            .sum();
        assert_eq!(summed, u64::from(dist));
    }

    /// Self-pair returns `Some(vec![s])`.
    #[test]
    fn path_query_self_pair_is_single_node() {
        use crate::bundle::{CchBundle, MetricBundle};

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let p = node_path(&cch_bundle.view(), &metric_bundle.view(), 0, 0).unwrap();
        assert_eq!(p, vec![0]);
    }

    /// Verify `original_arc_weight` handles the second loop (backward direction
    /// lookup). The path from 5 to 0 in the 10-node cycle includes arc 9→0,
    /// where rank(9) = 9 > rank(0) = 0, which forces the second loop in
    /// `original_arc_weight`.
    #[test]
    fn path_query_backward_arc_weight_lookup() {
        use crate::bundle::{CchBundle, MetricBundle};
        use crate::query::distance_matrix;

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let (cv, mv) = (cch_bundle.view(), metric_bundle.view());
        let (s, t) = (5u32, 0u32);
        let path = node_path(&cv, &mv, s, t).expect("5→0 should be reachable");
        assert_eq!(*path.first().unwrap(), s);
        assert_eq!(*path.last().unwrap(), t);
        let dist = distance_matrix(&cv, &mv, &[s], &[t])[0];
        let summed: u64 = path
            .windows(2)
            .map(|w| original_arc_weight(&cv, &mv, w[0], w[1]))
            .sum();
        assert_eq!(summed, u64::from(dist));
    }

    /// All-pairs path validity: every reachable (s,t) pair on the 10-node
    /// fixture must produce a path whose endpoint matches and whose summed
    /// original-arc weight equals the query distance. This exercises more
    /// code paths including potential `Dir::Fwd` shortcuts.
    #[test]
    fn path_query_all_pairs_valid() {
        use crate::bundle::{CchBundle, MetricBundle};
        use crate::query::distance_matrix;

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let (cv, mv) = (cch_bundle.view(), metric_bundle.view());
        let n = 10u32;

        for s in 0..n {
            for t in 0..n {
                if s == t {
                    continue;
                }
                // The 10-node cycle is strongly connected: every pair is reachable.
                let dist = distance_matrix(&cv, &mv, &[s], &[t])[0];
                let path = node_path(&cv, &mv, s, t).expect("reachable");
                assert_eq!(*path.first().unwrap(), s);
                assert_eq!(*path.last().unwrap(), t);
                let summed: u64 = path
                    .windows(2)
                    .map(|w| original_arc_weight(&cv, &mv, w[0], w[1]))
                    .sum();
                assert_eq!(summed, u64::from(dist), "path weight mismatch for {s}→{t}");
            }
        }
    }

    // -----------------------------------------------------------------------
    // PathQuery (buffer-reusing) tests
    // -----------------------------------------------------------------------

    /// `PathQuery::new` validates the invariant the hot-loop `get_unchecked`
    /// relies on (every `up_head` value `< node_count`) and rejects a malformed
    /// `CchView`, mirroring `query.rs::new_rejects_out_of_range_up_head`.
    #[test]
    #[should_panic(expected = "up_head contains a node id")]
    fn pathquery_new_rejects_out_of_range_up_head() {
        let view = CchView {
            rank: &[0], // node_count = 1
            elimination_tree_parent: &[INVALID_ID],
            up_first_out: &[0, 1],
            up_head: &[5], // 5 >= node_count (1) → invalid
            down_first_out: &[0, 1],
            down_head: &[0],
            down_to_up: &[0],
        };
        let _ = PathQuery::new(&view);
    }

    /// Self-pair on a reused `PathQuery` returns `Some(vec![s])` (and exercises
    /// the early-return branch before any reset).
    #[test]
    fn pathquery_self_pair_is_single_node() {
        use crate::bundle::{CchBundle, MetricBundle};

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let (cv, mv) = (cch_bundle.view(), metric_bundle.view());
        let mut q = PathQuery::new(&cv);
        assert_eq!(q.path(&mv, 0, 0).unwrap(), vec![0]);
        // A self-pair must not corrupt a subsequent real query.
        assert_eq!(q.path(&mv, 0, 5), node_path(&cv, &mv, 0, 5));
    }

    /// Stale-state hunter: issue the SAME pair twice and DIFFERENT pairs
    /// interleaved on one `PathQuery`, asserting each `.path()` matches a fresh
    /// one-shot `node_path`. Catches buffer-reset bugs the sequential 200-pair
    /// run could mask.
    #[test]
    fn pathquery_repeated_and_interleaved_pairs_match_node_path() {
        use crate::bundle::{CchBundle, MetricBundle};

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let (cv, mv) = (cch_bundle.view(), metric_bundle.view());

        let mut q = PathQuery::new(&cv);
        // Interleave: same pair twice, then alternate distinct pairs, then
        // revisit an earlier pair — every result must match a fresh node_path.
        let probes = [
            (0u32, 5u32),
            (0, 5), // same pair again — reset must be idempotent
            (5, 0),
            (3, 8),
            (0, 5), // revisit
            (8, 3),
            (7, 2),
            (3, 8), // revisit
            (1, 1), // self-pair in the middle
            (2, 9),
            (5, 0), // revisit
        ];
        for &(s, t) in &probes {
            assert_eq!(
                q.path(&mv, s, t),
                node_path(&cv, &mv, s, t),
                "reused PathQuery disagrees with one-shot node_path for ({s} -> {t})"
            );
        }
    }

    /// Parity over assorted pairs: `PathQuery::path` == `node_path` (free fn).
    /// All reachable pairs of the 10-node fixture through one reused query.
    #[test]
    fn pathquery_all_pairs_match_node_path() {
        use crate::bundle::{CchBundle, MetricBundle};

        let (sp, mp) = test_bundle_paths();
        let cch_bundle = CchBundle::open(&sp).unwrap();
        let metric_bundle = MetricBundle::open(&mp).unwrap();
        let (cv, mv) = (cch_bundle.view(), metric_bundle.view());

        let mut q = PathQuery::new(&cv);
        for s in 0..10u32 {
            for t in 0..10u32 {
                assert_eq!(
                    q.path(&mv, s, t),
                    node_path(&cv, &mv, s, t),
                    "mismatch for ({s} -> {t})"
                );
            }
        }
    }
}
