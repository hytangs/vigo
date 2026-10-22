//! Reach display geometry. No-data remains a mask; diagonal cells never bridge.
//! Node orchestration owns presentation metadata, while Rust owns grid traversal,
//! stitching, topology and containment. All allocations have explicit admission limits.
use crate::decimal_rounding::rounded;
use serde_json::{Value, json};
use std::collections::HashMap;

type Point = [f64; 2];
type Key = [i64; 2];
type Ring = Vec<Point>;
type Polygon = Vec<Ring>;
const SCALE: f64 = 1e12;
const MAX_CELLS: usize = 1_048_576;
const MAX_VERTICES: usize = 2_000_000;

fn key(p: Point) -> Key {
    [(p[0] * SCALE).round() as i64, (p[1] * SCALE).round() as i64]
}
fn coordinate(p: Point, w: usize, h: usize, b: &[f64], cells: bool) -> Point {
    let shift = if cells { 0. } else { 0.5 };
    let digits = if cells { 6 } else { 12 };
    [
        rounded(
            b[0] + (p[0] + shift).clamp(0., w as f64) / w as f64 * (b[2] - b[0]),
            digits,
        ),
        rounded(
            b[3] - (p[1] + shift).clamp(0., h as f64) / h as f64 * (b[3] - b[1]),
            digits,
        ),
    ]
}
fn value_at(v: &[f64], w: usize, h: usize, x: i32, y: i32) -> f64 {
    if x < 0 || y < 0 || x as usize >= w || y as usize >= h {
        return f64::INFINITY;
    }
    let value = v[y as usize * w + x as usize];
    if value.is_finite() {
        value
    } else {
        f64::INFINITY
    }
}
fn interpolate(a: f64, b: f64, cutoff: f64) -> f64 {
    if !a.is_finite() || !b.is_finite() || (b - a).abs() < 1e-9 {
        0.5
    } else {
        ((cutoff - a) / (b - a)).clamp(1e-6, 1. - 1e-6)
    }
}
fn segments(
    v: &[f64],
    w: usize,
    h: usize,
    b: &[f64],
    cutoff: f64,
    cells: bool,
) -> Result<Vec<[Point; 2]>, String> {
    let cases: [&[(usize, usize)]; 16] = [
        &[],
        &[(3, 0)],
        &[(0, 1)],
        &[(3, 1)],
        &[(1, 2)],
        &[(3, 0), (1, 2)],
        &[(0, 2)],
        &[(3, 2)],
        &[(2, 3)],
        &[(0, 2)],
        &[(0, 1), (2, 3)],
        &[(1, 2)],
        &[(3, 1)],
        &[(0, 1)],
        &[(3, 0)],
        &[],
    ];
    let mut edges = vec![];
    let start = if cells { 0 } else { -1 };
    for y in start..h as i32 {
        for x in start..w as i32 {
            let coord = |p| coordinate(p, w, h, b, cells);
            let mut add = |a, b| edges.push([coord(a), coord(b)]);
            if cells {
                if value_at(v, w, h, x, y) > cutoff {
                    continue;
                }
                let (xf, yf) = (x as f64, y as f64);
                if value_at(v, w, h, x, y - 1) > cutoff {
                    add([xf, yf], [xf + 1., yf]);
                }
                if value_at(v, w, h, x + 1, y) > cutoff {
                    add([xf + 1., yf], [xf + 1., yf + 1.]);
                }
                if value_at(v, w, h, x, y + 1) > cutoff {
                    add([xf + 1., yf + 1.], [xf, yf + 1.]);
                }
                if value_at(v, w, h, x - 1, y) > cutoff {
                    add([xf, yf + 1.], [xf, yf]);
                }
            } else {
                let values = [
                    value_at(v, w, h, x, y),
                    value_at(v, w, h, x + 1, y),
                    value_at(v, w, h, x + 1, y + 1),
                    value_at(v, w, h, x, y + 1),
                ];
                let state = values
                    .iter()
                    .enumerate()
                    .fold(0, |s, (i, &v)| s | (usize::from(v <= cutoff) << i));
                if state == 0 || state == 15 {
                    continue;
                }
                let (xf, yf) = (x as f64, y as f64);
                let points = [
                    [xf + interpolate(values[0], values[1], cutoff), yf],
                    [xf + 1., yf + interpolate(values[1], values[2], cutoff)],
                    [xf + interpolate(values[3], values[2], cutoff), yf + 1.],
                    [xf, yf + interpolate(values[0], values[3], cutoff)],
                ];
                for &(a, b) in cases[state] {
                    add(points[a], points[b]);
                }
            }
            if edges.len() * 2 > MAX_VERTICES {
                return Err("Reach boundaries exceed the vertex budget".into());
            }
        }
    }
    Ok(edges)
}
fn stitch(edges: &[[Point; 2]], directed: bool) -> Vec<Ring> {
    let mut node_ids = HashMap::<Key, usize>::new();
    let mut nodes: Vec<(Point, Vec<usize>)> = vec![];
    let mut endpoints = Vec::with_capacity(edges.len());
    for (i, &[a, b]) in edges.iter().enumerate() {
        let mut ends = [0; 2];
        for (side, p) in [a, b].into_iter().enumerate() {
            let n = *node_ids.entry(key(p)).or_insert_with(|| {
                nodes.push((p, vec![]));
                nodes.len() - 1
            });
            if !directed || side == 0 {
                nodes[n].1.push(i);
            }
            ends[side] = n;
        }
        endpoints.push(ends);
    }
    let mut visited = vec![false; edges.len()];
    let mut rings = vec![];
    let mut walk = |start: usize, first: usize| {
        if visited[first] {
            return;
        }
        let mut ring = vec![nodes[start].0];
        let mut at = start;
        let mut next = Some(first);
        while let Some(i) = next {
            if visited[i] {
                break;
            }
            visited[i] = true;
            let previous = at;
            at = if endpoints[i][0] == at {
                endpoints[i][1]
            } else {
                endpoints[i][0]
            };
            ring.push(nodes[at].0);
            if directed && at == start {
                break;
            }
            let available = nodes[at].1.iter().copied().filter(|&j| !visited[j]);
            next = if directed {
                let a = nodes[previous].0;
                let b = nodes[at].0;
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let turn = |j: usize| {
                    let p = edges[j][1];
                    let (nx, ny) = (p[0] - b[0], p[1] - b[1]);
                    (dx * ny - dy * nx).atan2(dx * nx + dy * ny)
                };
                available.min_by(|&a, &b| turn(a).total_cmp(&turn(b)))
            } else {
                available.into_iter().next()
            };
        }
        if ring.len() >= 2 {
            rings.push(ring);
        }
    };
    if !directed {
        for (n, (_, edges)) in nodes.iter().enumerate() {
            if edges.len() != 2 {
                for &i in edges {
                    walk(n, i);
                }
            }
        }
    }
    for (i, ends) in endpoints.iter().enumerate() {
        walk(ends[0], i);
    }
    rings
}
fn signed_area(r: &[Point]) -> f64 {
    let o = r[0];
    r.windows(2)
        .map(|p| (p[0][0] - o[0]) * (p[1][1] - o[1]) - (p[1][0] - o[0]) * (p[0][1] - o[1]))
        .sum::<f64>()
        / 2.
}
fn contains(r: &[Point], [x, y]: Point) -> bool {
    let mut inside = false;
    for p in r.windows(2) {
        let [a, b] = [p[0], p[1]];
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
    }
    inside
}
fn split(r: Ring) -> Vec<Ring> {
    let mut positions = HashMap::new();
    let mut path = vec![];
    let mut rings = vec![];
    for p in r {
        if let Some(&start) = positions.get(&key(p)) {
            let mut part = path[start..].to_vec();
            part.push(p);
            rings.push(part);
            for &p in &path[start + 1..] {
                positions.remove(&key(p));
            }
            path.truncate(start + 1);
        } else {
            positions.insert(key(p), path.len());
            path.push(p);
        }
    }
    rings
}
fn simplify(r: Ring) -> Ring {
    let points = &r[..r.len() - 1];
    let mut simple = vec![];
    for (i, &p) in points.iter().enumerate() {
        let a = points[(i + points.len() - 1) % points.len()];
        let b = points[(i + 1) % points.len()];
        let (ax, ay, bx, by) = (p[0] - a[0], p[1] - a[1], b[0] - p[0], b[1] - p[1]);
        let (left, right) = (ax * by, ay * bx);
        if (left - right).abs() > 8. * f64::EPSILON * (left.abs() + right.abs())
            || ax * bx + ay * by < 0.
        {
            simple.push(p);
        }
    }
    if simple.len() < 3 {
        r
    } else {
        simple.push(simple[0]);
        simple
    }
}
struct Record {
    ring: Ring,
    bounds: [f64; 4],
    area: f64,
    parent: Option<usize>,
    depth: usize,
}
fn bounds(r: &[Point]) -> [f64; 4] {
    r.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        },
    )
}
fn encloses(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
}
// Bounding-volume hierarchy avoids the old all-pairs containment scan on
// checkerboard rasters with tens of thousands of disconnected islands.
struct Index {
    bounds: [f64; 4],
    children: Option<Box<[Index; 2]>>,
    ids: Vec<usize>,
}
impl Index {
    fn build(mut ids: Vec<usize>, records: &[Record]) -> Self {
        let b = ids.iter().fold(
            [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ],
            |b, &i| {
                let a = records[i].bounds;
                [
                    b[0].min(a[0]),
                    b[1].min(a[1]),
                    b[2].max(a[2]),
                    b[3].max(a[3]),
                ]
            },
        );
        if ids.len() <= 8 {
            return Self {
                bounds: b,
                children: None,
                ids,
            };
        }
        let axis = usize::from(b[3] - b[1] > b[2] - b[0]);
        ids.sort_by(|&a, &b| {
            (records[a].bounds[axis] + records[a].bounds[axis + 2])
                .total_cmp(&(records[b].bounds[axis] + records[b].bounds[axis + 2]))
        });
        let right = ids.split_off(ids.len() / 2);
        Self {
            bounds: b,
            children: Some(Box::new([
                Self::build(ids, records),
                Self::build(right, records),
            ])),
            ids: vec![],
        }
    }
    fn parent(&self, target: usize, records: &[Record], probe: Point, best: &mut Option<usize>) {
        let r = &records[target];
        if !encloses(self.bounds, r.bounds) {
            return;
        }
        if let Some(children) = &self.children {
            for child in children.iter() {
                child.parent(target, records, probe, best);
            }
        }
        for &i in &self.ids {
            let candidate = &records[i];
            if i >= target
                || best.is_some_and(|old| {
                    records[old].area < candidate.area
                        || (records[old].area == candidate.area && old > i)
                })
            {
                continue;
            }
            if candidate.area > r.area
                && encloses(candidate.bounds, r.bounds)
                && contains(&candidate.ring, probe)
            {
                *best = Some(i);
            }
        }
    }
}
fn polygons(rings: Vec<Ring>) -> Vec<Polygon> {
    let mut records: Vec<_> = rings
        .into_iter()
        .filter(|r| r.len() >= 4 && r.first() == r.last())
        .flat_map(split)
        .filter(|r| r.len() >= 4)
        .map(|r| {
            let ring = simplify(r);
            Record {
                area: signed_area(&ring).abs(),
                bounds: bounds(&ring),
                ring,
                parent: None,
                depth: 0,
            }
        })
        .filter(|r| r.area > 0.)
        .collect();
    records.sort_by(|a, b| b.area.total_cmp(&a.area));
    let index = Index::build((0..records.len()).collect(), &records);
    for i in 0..records.len() {
        let r = &records[i].ring;
        let probe = [(r[0][0] + r[1][0]) / 2., (r[0][1] + r[1][1]) / 2.];
        let mut parent = None;
        index.parent(i, &records, probe, &mut parent);
        records[i].parent = parent;
        records[i].depth = parent.map_or(0, |p| records[p].depth + 1);
    }
    let mut result = vec![];
    let mut outer_ids = HashMap::new();
    for (i, r) in records.iter().enumerate() {
        if r.depth % 2 == 0 {
            let mut ring = r.ring.clone();
            if signed_area(&ring) < 0. {
                ring.reverse();
            }
            outer_ids.insert(i, result.len());
            result.push(vec![ring]);
        }
    }
    for r in records {
        if r.depth % 2 == 1 {
            let mut ring = r.ring;
            if signed_area(&ring) >= 0. {
                ring.reverse();
            }
            result[outer_ids[&r.parent.unwrap()]].push(ring);
        }
    }
    result
}
pub(crate) fn raster_areas(
    v: &[f64],
    w: usize,
    h: usize,
    b: &[f64],
    cutoffs: &[f64],
    surface: &str,
    cells: bool,
) -> Result<Value, String> {
    let count = w.checked_mul(h).ok_or("Invalid Reach raster dimensions")?;
    if w == 0
        || h == 0
        || count > MAX_CELLS
        || count != v.len()
        || cutoffs.len() > 32
        || count.saturating_mul(cutoffs.len()) > 16 * MAX_CELLS
    {
        return Err("Reach raster dimensions or cutoffs exceed the geometry budget".into());
    }
    if b.len() != 4
        || b.iter().any(|v| !v.is_finite())
        || b[0] >= b[2]
        || b[1] >= b[3]
        || b[0] < -180.
        || b[2] > 180.
        || b[1] < -90.
        || b[3] > 90.
        || cutoffs.iter().any(|v| !v.is_finite())
        || surface.len() > 128
    {
        return Err("Invalid Reach bounds, cutoffs or surface".into());
    }
    let mut features = vec![];
    let mut vertices = 0;
    for &cutoff in cutoffs {
        let polygons = polygons(stitch(&segments(v, w, h, b, cutoff, cells)?, cells));
        vertices += polygons.iter().flatten().map(Vec::len).sum::<usize>();
        if vertices > MAX_VERTICES {
            return Err("Reach boundaries exceed the vertex budget".into());
        }
        if polygons.is_empty() {
            continue;
        }
        let id = format!("{surface}-area-{cutoff}");
        let geometry = if polygons.len() == 1 {
            json!({"type":"Polygon","coordinates":polygons[0]})
        } else {
            json!({"type":"MultiPolygon","coordinates":polygons})
        };
        features.push(json!({"type":"Feature","id":id,"properties":{"id":id,"surface":surface,"cutoffMinutes":cutoff},"geometry":geometry}));
    }
    Ok(json!({"type":"FeatureCollection","features":features}))
}
#[cfg(feature = "node")]
#[napi_derive::napi]
pub fn reach_boundary_areas(
    values: napi::bindgen_prelude::Float64Array,
    width: u32,
    height: u32,
    bounds: Vec<f64>,
    cutoffs: Vec<f64>,
    surface: String,
    cells: bool,
) -> napi::Result<String> {
    raster_areas(
        &values,
        width as usize,
        height as usize,
        &bounds,
        &cutoffs,
        &surface,
        cells,
    )
    .and_then(|result| serde_json::to_string(&result).map_err(|e| e.to_string()))
    .map_err(|message| napi::Error::new(napi::Status::InvalidArg, message))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_and_unbounded_grids() {
        for (w, h) in [
            (0, 1),
            (1, 0),
            (2, 1),
            (u32::MAX as usize, u32::MAX as usize),
        ] {
            assert!(raster_areas(&[0.], w, h, &[0., 0., 1., 1.], &[1.], "test", false).is_err());
        }
        assert!(raster_areas(&[0.], 1, 1, &[0., 0., f64::NAN, 1.], &[1.], "test", false).is_err());
        assert!(
            raster_areas(
                &[0.],
                1,
                1,
                &[0., 0., 1., 1.],
                &[f64::INFINITY],
                "test",
                false
            )
            .is_err()
        );
    }
    #[test]
    fn diagonal_samples_stay_separate() {
        let v = [0., f64::INFINITY, f64::INFINITY, 0.];
        for cells in [false, true] {
            let result = raster_areas(&v, 2, 2, &[0., 0., 2., 2.], &[1.], "test", cells).unwrap();
            assert_eq!(
                result["features"][0]["geometry"]["coordinates"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
        }
    }
}
