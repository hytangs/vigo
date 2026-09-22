//! Numeric itinerary materialization. JavaScript owns source loading and output
//! objects; Rust owns shape indexing/alignment and stable identifier arithmetic.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, VecDeque};

const RADIUS_KM: f64 = 6371.0088;
const CANDIDATE_LIMIT: usize = 16;

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

#[napi]
pub struct ShapeGeometry {
    points: Vec<[f64; 2]>,
    prefix: Vec<f64>,
    latitude_order: Vec<u32>,
    candidates: HashMap<(u64, u64), Vec<Candidate>>,
    candidate_order: VecDeque<(u64, u64)>,
    candidate_bytes: usize,
}

#[napi]
impl ShapeGeometry {
    #[napi(constructor)]
    pub fn new(values: Float64Array) -> Result<Self> {
        let points = coordinates(&values)?;
        if points.len() > u32::MAX as usize {
            return Err(Error::from_reason(
                "Shape point count exceeds the index domain.",
            ));
        }
        let mut prefix = vec![0.0; points.len()];
        for i in 1..points.len() {
            prefix[i] = prefix[i - 1] + haversine_km(points[i - 1], points[i]);
        }
        let mut latitude_order: Vec<u32> = (0..points.len() as u32).collect();
        latitude_order.sort_unstable_by(|&a, &b| {
            points[a as usize][1]
                .total_cmp(&points[b as usize][1])
                .then(a.cmp(&b))
        });
        Ok(Self {
            points,
            prefix,
            latitude_order,
            candidates: HashMap::new(),
            candidate_order: VecDeque::new(),
            candidate_bytes: 0,
        })
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
            + self.latitude_order.capacity() * std::mem::size_of::<u32>()
            + self.candidates.capacity() * 64
            + self.candidate_order.capacity() * 16
            + self.candidate_bytes) as f64
    }
}

impl ShapeGeometry {
    fn candidates(&self, stop: [f64; 2]) -> Vec<Candidate> {
        // Great-circle distance is bounded below by latitude separation. The
        // epsilon makes both binary-search boundaries conservative.
        let delta = 180.0 / (std::f64::consts::PI * RADIUS_KM) + 1e-12;
        let start = self
            .latitude_order
            .partition_point(|&i| self.points[i as usize][1] < stop[1] - delta);
        let end = self
            .latitude_order
            .partition_point(|&i| self.points[i as usize][1] <= stop[1] + delta);
        let mut nearest: Vec<Candidate> = Vec::with_capacity(CANDIDATE_LIMIT);
        for &index in &self.latitude_order[start..end] {
            let index = index as usize;
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
        }
        nearest
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
