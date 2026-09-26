//! Numeric itinerary materialization. JavaScript owns store lifetime and output
//! objects; Rust reads shapes, indexes/aligns them and hashes identifiers.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use std::collections::{HashMap, VecDeque};

const RADIUS_KM: f64 = 6371.0088;
const CANDIDATE_LIMIT: usize = 16;

fn unit_position(point: [f64; 2]) -> [f64; 3] {
    let (sin_lat, cos_lat) = point[1].to_radians().sin_cos();
    let (sin_lon, cos_lon) = point[0].to_radians().sin_cos();
    [cos_lat * cos_lon, cos_lat * sin_lon, sin_lat]
}

#[derive(Clone, Copy, Default)]
struct ShapeNode {
    minimum: [f64; 3],
    maximum: [f64; 3],
    start: u32,
    end: u32,
    right: u32,
}

impl ShapeNode {
    fn lower_bound(&self, point: [f64; 3]) -> f64 {
        let mut distance = 0.0;
        for (axis, value) in point.iter().enumerate() {
            let delta =
                (self.minimum[axis] - value).max(0.0) + (value - self.maximum[axis]).max(0.0);
            distance += delta * delta;
        }
        distance
    }
}

// A linear-build hierarchy over consecutive source sections. Bounds use unit
// sphere coordinates, so poles and antimeridian crossings need no special case.
// Leaf points still use the original haversine and source-index tie breaking.
fn shape_nodes(points: &[[f64; 2]]) -> Vec<ShapeNode> {
    fn build(points: &[[f64; 2]], nodes: &mut Vec<ShapeNode>, start: usize, end: usize) -> usize {
        let index = nodes.len();
        nodes.push(ShapeNode::default());
        let mut node = ShapeNode {
            start: start as u32,
            end: end as u32,
            minimum: [f64::INFINITY; 3],
            maximum: [f64::NEG_INFINITY; 3],
            right: 0,
        };
        if end - start <= 16 {
            for &point in &points[start..end] {
                for (axis, value) in unit_position(point).iter().enumerate() {
                    node.minimum[axis] = node.minimum[axis].min(*value);
                    node.maximum[axis] = node.maximum[axis].max(*value);
                }
            }
        } else {
            let middle = start + (end - start) / 2;
            let left = build(points, nodes, start, middle);
            let right = build(points, nodes, middle, end);
            node.right = right as u32;
            for axis in 0..3 {
                node.minimum[axis] = nodes[left].minimum[axis].min(nodes[right].minimum[axis]);
                node.maximum[axis] = nodes[left].maximum[axis].max(nodes[right].maximum[axis]);
            }
        }
        nodes[index] = node;
        index
    }
    let mut nodes = Vec::new();
    if !points.is_empty() {
        build(points, &mut nodes, 0, points.len());
    }
    nodes
}

fn haversine_km(a: [f64; 2], b: [f64; 2]) -> f64 {
    let radians = |v: f64| v * std::f64::consts::PI / 180.0;
    let dlat = radians(b[1] - a[1]);
    let dlon = radians(b[0] - a[0]);
    let value = (dlat / 2.0).sin().powi(2)
        + radians(a[1]).cos() * radians(b[1]).cos() * (dlon / 2.0).sin().powi(2);
    RADIUS_KM * 2.0 * value.sqrt().atan2((1.0 - value).sqrt())
}

fn coordinates(values: &[f64]) -> Result<Vec<[f64; 2]>> {
    if !values.len().is_multiple_of(2) || values.iter().any(|v| !v.is_finite()) {
        return Err(Error::from_reason(
            "Shape coordinates must be finite longitude/latitude pairs.",
        ));
    }
    Ok(values.chunks_exact(2).map(|v| [v[0], v[1]]).collect())
}

#[derive(Clone, Copy)]
struct Candidate {
    index: usize,
    distance: f64,
}

#[derive(Clone, Copy)]
struct State {
    index: usize,
    first: usize,
    cost: f64,
    previous: usize,
}

/// A source reader owned by the same lifetime as the JS routing store. Reading
/// directly into native points avoids one JS object and two coordinate copies
/// per shape point. It does not retain shapes or itinerary answers.
#[napi]
pub struct ShapeGeometrySource {
    db: Option<Connection>,
}

fn source_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("Native shape geometry: {error}"))
}

fn coordinate_number(value: ValueRef<'_>) -> Option<f64> {
    let number = match value {
        ValueRef::Null => 0.0, // Match Number(null) in the existing loader.
        ValueRef::Integer(value) => value as f64,
        ValueRef::Real(value) => value,
        ValueRef::Text(value) => {
            let value = std::str::from_utf8(value).ok()?.trim();
            if value.is_empty() {
                0.0
            } else {
                value.parse().ok()?
            }
        }
        ValueRef::Blob(_) => return None,
    };
    number.is_finite().then_some(number)
}

#[napi]
impl ShapeGeometrySource {
    #[napi(constructor)]
    pub fn new(store_path: String) -> Result<Self> {
        let db = Connection::open_with_flags(
            store_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(source_error)?;
        db.execute_batch("PRAGMA mmap_size=0; PRAGMA cache_size=-2048; PRAGMA query_only=ON;")
            .map_err(source_error)?;
        db.set_prepared_statement_cache_capacity(1);
        Ok(Self { db: Some(db) })
    }

    #[napi]
    pub fn read_shape(&self, shape_id: String) -> Result<Option<ShapeGeometry>> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| source_error("source is closed"))?;
        let mut statement = db
            .prepare_cached("SELECT lon,lat FROM shape_points WHERE shape_id=? ORDER BY sequence")
            .map_err(source_error)?;
        let mut rows = statement.query([shape_id]).map_err(source_error)?;
        let mut points = Vec::new();
        while let Some(row) = rows.next().map_err(source_error)? {
            let lon = coordinate_number(row.get_ref(0).map_err(source_error)?);
            let lat = coordinate_number(row.get_ref(1).map_err(source_error)?);
            if let (Some(lon), Some(lat)) = (lon, lat) {
                points.push([lon, lat]);
            }
        }
        if points.len() < 2 {
            return Ok(None);
        }
        ShapeGeometry::from_points(points).map(Some)
    }

    #[napi]
    pub fn close(&mut self) {
        self.db.take();
    }
}

#[napi]
pub struct ShapeGeometry {
    points: Vec<[f64; 2]>,
    prefix: Vec<f64>,
    nodes: Vec<ShapeNode>,
    candidates: HashMap<(u64, u64), Vec<Candidate>>,
    candidate_order: VecDeque<(u64, u64)>,
    candidate_bytes: usize,
}

#[napi(object)]
pub struct ShapeRenderCoordinates {
    pub coordinates: Float64Array,
    pub distinct_indices: Option<Uint32Array>,
}

#[napi]
impl ShapeGeometry {
    #[napi(constructor)]
    pub fn new(values: Float64Array) -> Result<Self> {
        Self::from_points(coordinates(&values)?)
    }

    #[napi(getter)]
    pub fn point_count(&self) -> u32 {
        self.points.len() as u32
    }

    // One compact coordinate column per prepared shape, rather than crossing
    // Node-API and allocating a native output buffer for every selected leg.
    // Its bytes are accounted separately by the owning JS store.
    #[napi(getter)]
    pub fn packed_coordinates(&self) -> Float64Array {
        self.points
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>()
            .into()
    }

    /// Compile the source-order distinct-point projection once with the
    /// coordinate column. Shapes without consecutive duplicates need no index.
    /// Both returned columns are owned and budgeted by the JS routing store.
    #[napi]
    pub fn render_coordinates(&self) -> ShapeRenderCoordinates {
        let mut coordinates = Vec::with_capacity(self.points.len() * 2);
        let mut distinct: Option<Vec<u32>> = None;
        for (index, point) in self.points.iter().enumerate() {
            coordinates.extend_from_slice(point);
            if index > 0 && *point == self.points[index - 1] {
                distinct.get_or_insert_with(|| (0..index as u32).collect());
            } else if let Some(indices) = &mut distinct {
                indices.push(index as u32);
            }
        }
        ShapeRenderCoordinates {
            coordinates: coordinates.into(),
            distinct_indices: distinct.map(|indices| indices.into_boxed_slice().into_vec().into()),
        }
    }

    /// Returns source-order point indices, or an empty array when no monotone
    /// alignment is possible. No approximate nearest-neighbor search is used.
    #[napi]
    pub fn align_stops(&mut self, values: Float64Array) -> Result<Uint32Array> {
        let stops = coordinates(&values)?;
        Ok(self.align(&stops).into())
    }

    // Includes allocated cache capacities, so JS can evict the complete shape
    // when candidate reuse grows beyond its owning store's byte budget.
    #[napi(getter)]
    pub fn estimated_bytes(&self) -> f64 {
        (self.points.capacity() * std::mem::size_of::<[f64; 2]>()
            + self.prefix.capacity() * std::mem::size_of::<f64>()
            + self.nodes.capacity() * std::mem::size_of::<ShapeNode>()
            + self.candidates.capacity() * 64
            + self.candidate_order.capacity() * 16
            + self.candidate_bytes) as f64
    }
}

impl ShapeGeometry {
    fn from_points(points: Vec<[f64; 2]>) -> Result<Self> {
        if points.len() > u32::MAX as usize {
            return Err(Error::from_reason(
                "Shape point count exceeds the index domain.",
            ));
        }
        let mut prefix = vec![0.0; points.len()];
        for i in 1..points.len() {
            prefix[i] = prefix[i - 1] + haversine_km(points[i - 1], points[i]);
        }
        let nodes = shape_nodes(&points);
        Ok(Self {
            points,
            prefix,
            nodes,
            candidates: HashMap::new(),
            candidate_order: VecDeque::new(),
            candidate_bytes: 0,
        })
    }

    fn candidates(&self, stop: [f64; 2]) -> Vec<Candidate> {
        let mut nearest: Vec<Candidate> = Vec::with_capacity(CANDIDATE_LIMIT);
        if !self.nodes.is_empty() {
            let mut radius_squared = (2.0 * (0.5 / RADIUS_KM).sin()).powi(2);
            self.visit_candidates(
                0,
                unit_position(stop),
                stop,
                &mut nearest,
                &mut radius_squared,
            );
        }
        nearest
    }

    fn visit_candidates(
        &self,
        node_index: usize,
        position: [f64; 3],
        stop: [f64; 2],
        nearest: &mut Vec<Candidate>,
        radius_squared: &mut f64,
    ) {
        let node = &self.nodes[node_index];
        // Conservative slack covers unit-vector and box arithmetic roundoff,
        // including coincident points. It only adds work, never candidates.
        if node.lower_bound(position) > *radius_squared + 1e-15 {
            return;
        }
        if node.right != 0 {
            let left = node_index + 1;
            let right = node.right as usize;
            let (first, second) = if self.nodes[left].lower_bound(position)
                <= self.nodes[right].lower_bound(position)
            {
                (left, right)
            } else {
                (right, left)
            };
            self.visit_candidates(first, position, stop, nearest, radius_squared);
            self.visit_candidates(second, position, stop, nearest, radius_squared);
            return;
        }
        let latitude_delta = 180.0 / (std::f64::consts::PI * RADIUS_KM) + 1e-12;
        for index in node.start as usize..node.end as usize {
            if (self.points[index][1] - stop[1]).abs() > latitude_delta {
                continue;
            }
            let distance = haversine_km(self.points[index], stop);
            if distance > 1.0 || !distance.is_finite() {
                continue;
            }
            let candidate = Candidate { index, distance };
            let position = nearest.partition_point(|previous| {
                previous.distance < distance
                    || (previous.distance == distance && previous.index < index)
            });
            if position >= CANDIDATE_LIMIT {
                continue;
            }
            if nearest.len() == CANDIDATE_LIMIT {
                nearest.pop();
            }
            nearest.insert(position, candidate);
            if nearest.len() == CANDIDATE_LIMIT {
                *radius_squared = (2.0
                    * (nearest[CANDIDATE_LIMIT - 1].distance / (2.0 * RADIUS_KM)).sin())
                .powi(2);
            }
        }
    }

    fn cached_candidates(&mut self, stop: [f64; 2]) -> Vec<Candidate> {
        let key = (stop[0].to_bits(), stop[1].to_bits());
        if let Some(candidates) = self.candidates.get(&key) {
            return candidates.clone();
        }
        let candidates = self.candidates(stop);
        if self.candidates.len() >= 2048
            && let Some(oldest) = self.candidate_order.pop_front()
            && let Some(removed) = self.candidates.remove(&oldest)
        {
            self.candidate_bytes -= removed.capacity() * std::mem::size_of::<Candidate>();
        }
        let retained = candidates.clone();
        self.candidate_bytes += retained.capacity() * std::mem::size_of::<Candidate>();
        self.candidates.insert(key, retained);
        self.candidate_order.push_back(key);
        candidates
    }

    fn align(&mut self, stops: &[[f64; 2]]) -> Vec<u32> {
        if self.points.is_empty() || stops.len() < 2 {
            return Vec::new();
        }
        let initial = self.cached_candidates(stops[0]);
        if initial.is_empty() {
            return Vec::new();
        }
        let mut layers: Vec<Vec<State>> = Vec::with_capacity(stops.len());
        layers.push(
            initial
                .iter()
                .map(|c| State {
                    index: c.index,
                    first: c.index,
                    cost: c.distance,
                    previous: 0,
                })
                .collect(),
        );
        for i in 1..stops.len() {
            let direct = haversine_km(stops[i - 1], stops[i]);
            let mut next = Vec::with_capacity(CANDIDATE_LIMIT);
            for candidate in self.cached_candidates(stops[i]) {
                let mut best: Option<State> = None;
                for (previous_index, previous) in layers[i - 1].iter().enumerate() {
                    if candidate.index < previous.index {
                        continue;
                    }
                    let section = self.prefix[candidate.index] - self.prefix[previous.index];
                    let detour = (section - 0.2_f64.max(direct * 3.0)).max(0.0);
                    let collapsed = if candidate.index == previous.index && direct > 0.05 {
                        2.0
                    } else {
                        0.0
                    };
                    let cost = previous.cost + candidate.distance + detour * 0.05 + collapsed;
                    if best.is_none_or(|b| {
                        cost < b.cost || (cost == b.cost && previous.first > b.first)
                    }) {
                        best = Some(State {
                            index: candidate.index,
                            first: previous.first,
                            cost,
                            previous: previous_index,
                        });
                    }
                }
                if let Some(best) = best {
                    next.push(best);
                }
            }
            if next.is_empty() {
                return Vec::new();
            }
            layers.push(next);
        }
        let states = layers.last().unwrap();
        let mut selected: Option<usize> = None;
        for (index, candidate) in states.iter().enumerate() {
            if candidate.index <= candidate.first {
                continue;
            }
            if selected.is_none_or(|s| {
                candidate.cost < states[s].cost
                    || (candidate.cost == states[s].cost
                        && candidate.index - candidate.first < states[s].index - states[s].first)
            }) {
                selected = Some(index);
            }
        }
        let Some(mut selected) = selected else {
            return Vec::new();
        };
        let mut indices = vec![0; layers.len()];
        for layer in (0..layers.len()).rev() {
            let state = layers[layer][selected];
            indices[layer] = state.index as u32;
            selected = state.previous;
        }
        indices
    }
}

/// Preserve JavaScript String iteration: valid surrogate pairs are one code
/// point; unpaired surrogates retain their original code-unit value. Hashing
/// UTF-8 bytes or replacing malformed surrogates would change existing IDs.
#[napi]
pub fn stable_key_suffix(value: Utf16String) -> String {
    let mut state = 0xcbf29ce484222325_u64;
    for character in char::decode_utf16(value.iter().copied()) {
        let point = match character {
            Ok(c) => c as u32,
            Err(e) => u32::from(e.unpaired_surrogate()),
        };
        state = (state ^ u64::from(point)).wrapping_mul(0x100000001b3);
    }
    let mut output = [b'0'; 13];
    for digit in output.iter_mut().rev() {
        *digit = b"0123456789abcdefghijklmnopqrstuvwxyz"[(state % 36) as usize];
        state /= 36;
    }
    String::from_utf8(output.to_vec()).unwrap()
}
