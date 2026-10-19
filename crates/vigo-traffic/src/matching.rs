use crate::Result;
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap},
};

/// Borrowed CSR graph. Callers validate array lengths when opening the graph.
#[derive(Clone, Copy)]
pub struct Graph<'a> {
    pub lons: &'a [f64],
    pub lats: &'a [f64],
    pub offsets: &'a [u32],
    pub targets: &'a [u32],
    pub distances: &'a [u32],
    pub times: &'a [u32],
}
impl Graph<'_> {
    fn point(self, n: u32) -> [f64; 2] {
        [self.lons[n as usize], self.lats[n as usize]]
    }
}
#[derive(Default)]
pub struct Matcher {
    identity: String,
    cells: HashMap<(i32, i32), Vec<u32>>,
    paths: HashMap<Vec<u64>, Result<Vec<u32>>>,
    cached_edges: usize,
}
fn cell(p: [f64; 2]) -> (i32, i32) {
    ((p[0] * 200.).floor() as i32, (p[1] * 200.).floor() as i32)
}
impl Matcher {
    pub(crate) fn estimated_heap_bytes(&self) -> usize {
        self.identity.capacity()
            + self.cells.capacity() * std::mem::size_of::<((i32, i32), Vec<u32>)>()
            + self.cells.values().map(|v| v.capacity() * 4).sum::<usize>()
            + self.paths.capacity() * std::mem::size_of::<(Vec<u64>, Result<Vec<u32>>)>()
            + self
                .paths
                .iter()
                .map(|(key, value)| {
                    key.capacity() * 8
                        + value
                            .as_ref()
                            .map_or_else(|s| s.capacity(), |v| v.capacity() * 4)
                })
                .sum::<usize>()
    }
    pub fn bind(&mut self, identity: &str) {
        if self.identity != identity {
            *self = Self {
                identity: identity.into(),
                ..Self::default()
            };
        }
    }
    pub fn match_path(
        &mut self,
        g: Graph<'_>,
        points: &[[f64; 2]],
        radius: f64,
    ) -> Result<Vec<u32>> {
        let key = std::iter::once(radius.to_bits())
            .chain(points.iter().flatten().map(|x| x.to_bits()))
            .collect::<Vec<_>>();
        if let Some(path) = self.paths.get(&key) {
            return path.clone();
        }
        if self.cells.is_empty() {
            for n in 0..g.lons.len() {
                self.cells
                    .entry(cell(g.point(n as u32)))
                    .or_default()
                    .push(n as u32);
            }
        }
        let result = self.search(g, points, radius);
        if self.paths.len() >= 8192 || self.cached_edges > 131072 {
            self.paths.clear();
            self.cached_edges = 0;
        }
        self.cached_edges += result.as_ref().map_or(0, Vec::len);
        self.paths.insert(key, result.clone());
        result
    }
    fn candidates(
        &self,
        g: Graph<'_>,
        p: [f64; 2],
        radius: f64,
        plane: &Polyline,
    ) -> Result<Vec<(u32, f64)>> {
        let dx = radius / (111195. * p[1].to_radians().cos().abs().max(0.01));
        let dy = radius / 111195.;
        let lo = cell([p[0] - dx, p[1] - dy]);
        let hi = cell([p[0] + dx, p[1] + dy]);
        let mut nodes = vec![];
        for x in lo.0..=hi.0 {
            for y in lo.1..=hi.1 {
                if let Some(cell) = self.cells.get(&(x, y)) {
                    for &n in cell {
                        let d = plane.distance(p, g.point(n));
                        if d <= radius {
                            nodes.push((n, d));
                        }
                    }
                }
            }
        }
        nodes.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        // Don't truncate dense junctions and silently choose a wrong road.
        if let Some(best) = nodes.first().map(|v| v.1) {
            nodes.retain(|v| v.1 <= best + 25.);
        }
        if nodes.len() > 16 {
            return Err("ambiguous_endpoints".into());
        }
        Ok(nodes)
    }
    fn search(&self, g: Graph<'_>, points: &[[f64; 2]], radius: f64) -> Result<Vec<u32>> {
        let line = Polyline::new(points);
        if line.length < 1. || line.length > 100_000. {
            return Err("unsupported_length".into());
        }
        // Endpoint search radius is not a license to cut corners. A narrow
        // shape corridor scales down for short links and never exceeds 30 m.
        let corridor = radius.min(30.).min((line.length * 0.05).max(1.));
        let starts = self.candidates(g, points[0], radius, &line)?;
        let ends = self
            .candidates(g, *points.last().unwrap(), radius, &line)?
            .into_iter()
            .collect::<HashMap<_, _>>();
        if starts.is_empty() || ends.is_empty() {
            return Err("unmatched_endpoints".into());
        }
        let mut labels = vec![];
        let mut queue = BinaryHeap::new();
        let mut visits = HashMap::<u32, u8>::new();
        let mut projection = HashMap::new();
        let mut solutions: Vec<(f64, Vec<u32>)> = vec![];
        for (node, d) in starts {
            labels.push(Label {
                node,
                length: 0.,
                previous: None,
                edge: 0,
                depth: 0,
            });
            queue.push(Entry(d * 4., labels.len() - 1));
        }
        while let Some(Entry(score, i)) = queue.pop() {
            if solutions.first().is_some_and(|s| score > s.0 + 25.) {
                break;
            }
            if labels.len() > 20_000 {
                return Err("search_budget_exceeded".into());
            }
            let l = labels[i];
            let count = visits.entry(l.node).or_default();
            if *count >= 2 {
                continue;
            }
            *count += 1;
            if let Some(&d) = ends.get(&l.node)
                && l.depth > 0
                && l.length >= line.length * 0.7
                && l.length <= line.length * 1.3
            {
                let mut path = vec![];
                let mut at = i;
                while let Some(prev) = labels[at].previous {
                    path.push(labels[at].edge);
                    at = prev;
                }
                path.reverse();
                if !line.covers_path(g, labels[at].node, &path, points, corridor) {
                    continue;
                }
                let score = score + d * 4.;
                if !solutions.iter().any(|s| s.1 == path) {
                    solutions.push((score, path));
                    solutions.sort_by(|a, b| a.0.total_cmp(&b.0));
                }
            }
            if l.depth >= 4096 || l.length > line.length * 1.3 {
                continue;
            }
            let a = *projection
                .entry(l.node)
                .or_insert_with(|| line.project(g.point(l.node)));
            for edge in g.offsets[l.node as usize]..g.offsets[l.node as usize + 1] {
                let target = g.targets[edge as usize];
                let b = *projection
                    .entry(target)
                    .or_insert_with(|| line.project(g.point(target)));
                // Entire directed path must follow the supplied geometry. This
                // excludes opposite carriageways, backtracking and shortcuts.
                if b.0 <= a.0 + 0.01 || a.1 > corridor || b.1 > corridor {
                    continue;
                }
                let from = g.point(l.node);
                let to = g.point(target);
                let distance = line.distance(from, to);
                if distance < 0.01 || (b.0 - a.0) > distance * 1.4 + 5. {
                    continue;
                }
                // Sample long chords so curved provider paths cannot jump a bend.
                let samples = (distance / 25.).ceil().clamp(1., 400.) as usize;
                if (1..samples).any(|j| {
                    let t = j as f64 / samples as f64;
                    line.project([
                        from[0] + t * (to[0] - from[0]),
                        from[1] + t * (to[1] - from[1]),
                    ])
                    .1 > corridor
                }) {
                    continue;
                }
                let length = l.length + distance;
                let cost = distance * (1. + (a.1 + b.1) / (2. * radius).max(1.)) + score;
                if labels.len() >= 20_000 {
                    return Err("search_budget_exceeded".into());
                }
                labels.push(Label {
                    node: target,
                    length,
                    previous: Some(i),
                    edge,
                    depth: l.depth + 1,
                });
                queue.push(Entry(cost, labels.len() - 1));
            }
        }
        if solutions.is_empty() {
            return Err("no_directed_path".into());
        }
        if solutions
            .get(1)
            .is_some_and(|s| s.0 - solutions[0].0 <= 25.)
        {
            return Err("ambiguous_path".into());
        }
        Ok(solutions.remove(0).1)
    }
}
#[derive(Clone, Copy)]
struct Label {
    node: u32,
    length: f64,
    previous: Option<usize>,
    edge: u32,
    depth: usize,
}
#[derive(PartialEq)]
struct Entry(f64, usize);
impl Eq for Entry {}
impl PartialOrd for Entry {
    fn partial_cmp(&self, b: &Self) -> Option<Ordering> {
        Some(self.cmp(b))
    }
}
impl Ord for Entry {
    fn cmp(&self, b: &Self) -> Ordering {
        b.0.total_cmp(&self.0).then(b.1.cmp(&self.1))
    }
}
struct Polyline {
    points: Vec<[f64; 2]>,
    offsets: Vec<f64>,
    length: f64,
    scale: f64,
    origin: [f64; 2],
}
impl Polyline {
    fn new(points: &[[f64; 2]]) -> Self {
        let mut p = Self {
            points: vec![],
            offsets: vec![0.],
            length: 0.,
            scale: points[0][1].to_radians().cos() * 111195.,
            origin: points[0],
        };
        p.points = points.iter().map(|&c| p.xy(c)).collect();
        for pair in p.points.windows(2) {
            p.length += (pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]);
            p.offsets.push(p.length);
        }
        p
    }
    fn xy(&self, p: [f64; 2]) -> [f64; 2] {
        [
            (p[0] - self.origin[0]) * self.scale,
            (p[1] - self.origin[1]) * 111195.,
        ]
    }
    fn distance(&self, a: [f64; 2], b: [f64; 2]) -> f64 {
        let a = self.xy(a);
        let b = self.xy(b);
        (a[0] - b[0]).hypot(a[1] - b[1])
    }
    fn covers_path(
        &self,
        g: Graph<'_>,
        start: u32,
        edges: &[u32],
        points: &[[f64; 2]],
        corridor: f64,
    ) -> bool {
        // Symmetric coverage: every provider vertex must also be close to the
        // matched road path, including bends that a shortcut would skip.
        points.iter().all(|&point| {
            let p = self.xy(point);
            let mut source = start;
            edges.iter().any(|&edge| {
                let a = self.xy(g.point(source));
                source = g.targets[edge as usize];
                let b = self.xy(g.point(source));
                let dx = b[0] - a[0];
                let dy = b[1] - a[1];
                let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy)
                    / (dx * dx + dy * dy).max(1e-12))
                .clamp(0., 1.);
                (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy) <= corridor
            })
        })
    }
    fn project(&self, p: [f64; 2]) -> (f64, f64) {
        let p = self.xy(p);
        let mut best = (0., f64::INFINITY);
        for (i, s) in self.points.windows(2).enumerate() {
            let dx = s[1][0] - s[0][0];
            let dy = s[1][1] - s[0][1];
            let length = dx.hypot(dy);
            if length < 0.001 {
                continue;
            }
            let t =
                (((p[0] - s[0][0]) * dx + (p[1] - s[0][1]) * dy) / (length * length)).clamp(0., 1.);
            let d = (p[0] - s[0][0] - t * dx).hypot(p[1] - s[0][1] - t * dy);
            if d < best.1 {
                best = (self.offsets[i] + t * length, d);
            }
        }
        best
    }
}
