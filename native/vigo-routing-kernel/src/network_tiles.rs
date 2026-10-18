//! Transit network as Mapbox Vector Tiles (MVT 2.1).
//!
//! The API server prepares a City's route and stop overview — the records the
//! Studio used to receive as one JSON document — and registers it here once per
//! routing-store revision. Registration splits each route where consecutive
//! points jump implausibly far (the rules the Studio's GeoJSON builder used)
//! and ranks every vertex for Douglas–Peucker simplification, so a tile only
//! thresholds, clips and encodes. Each tile carries a `routes` layer of lines
//! and a `stops` layer of points. Properties hold route and stop identities, so
//! the Studio applies selection and focus with filters while tiles stay
//! immutable for a revision.

use crate::mvt::{
    BUFFER, EXTENT, GEOMETRY_LINE, GEOMETRY_POINT, MAX_LATITUDE, clip_polyline, command, quantize,
    write_bytes, write_key, write_varint, zigzag,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Arc, LazyLock, Mutex};

/// MapLibre's GeoJSON source simplifies with 0.375 px of a 512 px tile, which
/// is three units of a 4096 extent. Matching it keeps the drawn lines as they were.
const TOLERANCE: f64 = 3.0;
/// Below this zoom's tolerance no vertex is ever dropped.
const FINEST_SIMPLIFIED_ZOOM: i32 = 18;
const MAX_ROUTE_VERTICES: usize = 400_000;
/// The Studio's network preview never drew more stops than this.
const MAX_STOPS: usize = 16_000;
const REGISTERED_NETWORKS: usize = 16;
const EARTH_RADIUS_KM: f64 = 6371.0088;
const MAX_TRUSTED_SHAPE_JUMP_KM: f64 = 18.0;
const MIN_INFERRED_JUMP_KM: f64 = 4.5;

const ROUTE_KEYS: [&str; 21] = [
    "featureId",
    "routeId",
    "patternId",
    "directionId",
    "shortName",
    "longName",
    "color",
    "routeType",
    "tripCount",
    "status",
    "headwayMinutes",
    "spanHours",
    "stopCount",
    "serviceHours",
    "serviceShare",
    "frequencyClass",
    "geometrySource",
    "geometryConfidence",
    "geometryFragmentCount",
    "distanceKm",
    "scheduledSpeedKph",
];
/// Stops carry what styling and hit-testing need; names and served routes
/// come from the stop catalog the Studio already holds.
const STOP_KEYS: [&str; 4] = ["stopId", "routeCount", "tripCount", "transferScore"];

// ---------------------------------------------------------------------------
// Registered input
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputRoute {
    feature_id: String,
    #[serde(default)]
    route_id: String,
    #[serde(default)]
    pattern_id: String,
    #[serde(default)]
    direction_id: String,
    #[serde(default)]
    short_name: String,
    #[serde(default)]
    long_name: String,
    #[serde(default)]
    color: String,
    route_type: Option<i64>,
    #[serde(default)]
    trip_count: f64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    headway_minutes: f64,
    #[serde(default)]
    span_hours: f64,
    #[serde(default)]
    stop_count: f64,
    #[serde(default)]
    service_hours: f64,
    #[serde(default)]
    service_share: f64,
    #[serde(default)]
    frequency_class: String,
    #[serde(default)]
    geometry_source: String,
    distance_km: Option<f64>,
    #[serde(default)]
    scheduled_speed_kph: f64,
    #[serde(default)]
    coordinates: Vec<[f64; 2]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputStop {
    stop_id: String,
    lon: f64,
    lat: f64,
    #[serde(default)]
    route_count: f64,
    #[serde(default)]
    trip_count: f64,
    #[serde(default)]
    transfer_score: f64,
}

#[derive(Deserialize)]
struct InputNetwork {
    #[serde(default)]
    routes: Vec<InputRoute>,
    #[serde(default)]
    stops: Vec<InputStop>,
}

// ---------------------------------------------------------------------------
// Indexed network
// ---------------------------------------------------------------------------

/// A property value as an MVT `Value` message distinguishes it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Value {
    Text(String),
    /// Bits of an `f64`, so values can be interned.
    Double(u64),
    Integer(i64),
}

impl Value {
    fn number(value: f64) -> Self {
        // Integral counts are common; sint64 encodes them in a byte or two.
        if value.fract() == 0.0 && value.abs() < 9.0e15 {
            Value::Integer(value as i64)
        } else {
            Value::Double(value.to_bits())
        }
    }
}

/// Web Mercator in [0, 1] on both axes, y down.
type Mercator = [f64; 2];

struct Part {
    bounds: [f64; 4],
    points: Vec<Mercator>,
    /// Squared Douglas–Peucker distance at which each vertex stops mattering.
    importance: Vec<f64>,
}

struct Route {
    bounds: [f64; 4],
    parts: Vec<Part>,
    properties: Vec<(u32, Value)>,
}

struct Stop {
    point: Mercator,
    rank: (f64, f64),
    properties: Vec<(u32, Value)>,
}

pub(crate) struct Network {
    routes: Vec<Route>,
    stops: Vec<Stop>,
}

fn valid(coordinate: &[f64; 2]) -> bool {
    coordinate[0].is_finite()
        && coordinate[1].is_finite()
        && (-180.0..=180.0).contains(&coordinate[0])
        && (-90.0..=90.0).contains(&coordinate[1])
}

fn mercator([lon, lat]: [f64; 2]) -> Mercator {
    let latitude = lat.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
    [
        (lon + 180.0) / 360.0,
        (1.0 - (latitude.tan() + 1.0 / latitude.cos()).ln() / PI) / 2.0,
    ]
}

fn distance_km(left: [f64; 2], right: [f64; 2]) -> f64 {
    let d_lat = (right[1] - left[1]).to_radians();
    let d_lon = (right[0] - left[0]).to_radians();
    let value = (d_lat / 2.0).sin().powi(2)
        + left[1].to_radians().cos() * right[1].to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    EARTH_RADIUS_KM * 2.0 * value.sqrt().atan2((1.0 - value).sqrt())
}

/// Published shapes may wrap or teleport between disjoint runs. Draw each
/// plausible run and never a straight chord across the gap.
fn split_at_jumps(coordinates: &[[f64; 2]], max_jump_km: f64) -> Vec<Vec<[f64; 2]>> {
    let mut parts = Vec::new();
    let mut part: Vec<[f64; 2]> = Vec::new();
    for &coordinate in coordinates {
        if let Some(&previous) = part.last() {
            let jump = distance_km(previous, coordinate);
            if jump > max_jump_km {
                if part.len() >= 2 {
                    parts.push(std::mem::take(&mut part));
                }
                part = vec![coordinate];
                continue;
            }
            if jump < 0.001 {
                continue;
            }
        }
        part.push(coordinate);
    }
    if part.len() >= 2 {
        parts.push(part);
    }
    parts
}

/// Stop-to-stop lines allow three typical spacings before a gap counts as a jump.
fn inferred_jump_threshold_km(coordinates: &[[f64; 2]]) -> f64 {
    let mut distances: Vec<f64> = coordinates
        .windows(2)
        .map(|pair| distance_km(pair[0], pair[1]))
        .filter(|distance| distance.is_finite() && *distance > 0.0)
        .collect();
    if distances.is_empty() {
        return MIN_INFERRED_JUMP_KM;
    }
    distances.sort_by(f64::total_cmp);
    let typical = distances[(distances.len() - 1) / 2];
    (typical * 3.0).clamp(MIN_INFERRED_JUMP_KM, 120.0)
}

fn squared_segment_distance(point: Mercator, start: Mercator, end: Mercator) -> f64 {
    let (mut x, mut y) = (start[0], start[1]);
    let (dx, dy) = (end[0] - x, end[1] - y);
    if dx != 0.0 || dy != 0.0 {
        let t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
        if t > 1.0 {
            (x, y) = (end[0], end[1]);
        } else if t > 0.0 {
            x += dx * t;
            y += dy * t;
        }
    }
    (point[0] - x).powi(2) + (point[1] - y).powi(2)
}

/// Rank vertices the way geojson-vt does: each interior vertex keeps the
/// largest squared distance at which Douglas–Peucker would still retain it.
/// Endpoints are always drawn.
fn vertex_importance(points: &[Mercator], finest_sq_tolerance: f64) -> Vec<f64> {
    let mut importance = vec![0.0; points.len()];
    if points.is_empty() {
        return importance;
    }
    importance[0] = f64::INFINITY;
    importance[points.len() - 1] = f64::INFINITY;
    let mut stack = vec![(0_usize, points.len() - 1, f64::INFINITY)];
    while let Some((first, last, ceiling)) = stack.pop() {
        if last <= first + 1 {
            continue;
        }
        let mut farthest = first;
        let mut farthest_distance = finest_sq_tolerance;
        for index in first + 1..last {
            let distance = squared_segment_distance(points[index], points[first], points[last]);
            if distance > farthest_distance {
                farthest = index;
                farthest_distance = distance;
            }
        }
        if farthest == first {
            continue;
        }
        // A vertex never outranks the split that exposed it.
        let rank = farthest_distance.min(ceiling);
        importance[farthest] = rank;
        stack.push((first, farthest, rank));
        stack.push((farthest, last, rank));
    }
    importance
}

fn bounds_of(points: &[Mercator]) -> [f64; 4] {
    points.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |[west, north, east, south], point| {
            [
                west.min(point[0]),
                north.min(point[1]),
                east.max(point[0]),
                south.max(point[1]),
            ]
        },
    )
}

fn intersects(left: [f64; 4], right: [f64; 4]) -> bool {
    left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1]
}

fn sq_tolerance(zoom: i32) -> f64 {
    (TOLERANCE / (EXTENT * 2_f64.powi(zoom))).powi(2)
}

impl Network {
    fn from_input(input: InputNetwork) -> Network {
        let finest = sq_tolerance(FINEST_SIMPLIFIED_ZOOM);
        let mut routes: Vec<(f64, Route)> = input
            .routes
            .into_iter()
            .filter_map(|route| {
                let coordinates: Vec<[f64; 2]> =
                    route.coordinates.iter().copied().filter(valid).collect();
                let shape = route.geometry_source == "shape";
                let max_jump_km = if shape {
                    let length = route.distance_km.unwrap_or_else(|| {
                        coordinates
                            .windows(2)
                            .map(|pair| distance_km(pair[0], pair[1]))
                            .sum()
                    });
                    (length * 0.22).clamp(7.0, MAX_TRUSTED_SHAPE_JUMP_KM)
                } else {
                    inferred_jump_threshold_km(&coordinates)
                };
                let pieces = split_at_jumps(&coordinates, max_jump_km);
                if pieces.is_empty() {
                    return None;
                }
                let confidence = match (shape, pieces.len()) {
                    (true, 1) => "trusted",
                    (true, _) => "split",
                    _ => "inferred",
                };
                let parts: Vec<Part> = pieces
                    .iter()
                    .map(|piece| {
                        let points: Vec<Mercator> = piece.iter().copied().map(mercator).collect();
                        Part {
                            bounds: bounds_of(&points),
                            importance: vertex_importance(&points, finest),
                            points,
                        }
                    })
                    .collect();
                let bounds = parts.iter().fold(parts[0].bounds, |bounds, part| {
                    [
                        bounds[0].min(part.bounds[0]),
                        bounds[1].min(part.bounds[1]),
                        bounds[2].max(part.bounds[2]),
                        bounds[3].max(part.bounds[3]),
                    ]
                });
                let mut properties = vec![
                    (0, Value::Text(route.feature_id)),
                    (1, Value::Text(route.route_id)),
                    (2, Value::Text(route.pattern_id)),
                    (3, Value::Text(route.direction_id)),
                    (4, Value::Text(route.short_name)),
                    (5, Value::Text(route.long_name)),
                    (6, Value::Text(route.color)),
                ];
                if let Some(route_type) = route.route_type {
                    properties.push((7, Value::Integer(route_type)));
                }
                properties.extend([
                    (8, Value::number(route.trip_count)),
                    (9, Value::Text(route.status)),
                    (10, Value::number(route.headway_minutes)),
                    (11, Value::number(route.span_hours)),
                    (12, Value::number(route.stop_count)),
                    (13, Value::number(route.service_hours)),
                    (14, Value::number((route.service_share * 1e4).round() / 1e4)),
                    (15, Value::Text(route.frequency_class)),
                    (16, Value::Text(route.geometry_source)),
                    (17, Value::Text(confidence.to_string())),
                    (18, Value::Integer(parts.len() as i64)),
                    (19, Value::number(route.distance_km.unwrap_or(0.0))),
                    (20, Value::number(route.scheduled_speed_kph)),
                ]);
                Some((
                    route.trip_count,
                    Route {
                        bounds,
                        parts,
                        properties,
                    },
                ))
            })
            .collect();
        // Busy services claim a crowded tile's vertex budget first.
        routes.sort_by(|left, right| right.0.total_cmp(&left.0));
        let stops = input
            .stops
            .into_iter()
            .filter(|stop| valid(&[stop.lon, stop.lat]))
            .map(|stop| Stop {
                point: mercator([stop.lon, stop.lat]),
                rank: (stop.transfer_score, stop.trip_count),
                properties: vec![
                    (0, Value::Text(stop.stop_id)),
                    (1, Value::number(stop.route_count)),
                    (2, Value::number(stop.trip_count)),
                    // Styling reads the score on a 0-100 ramp; whole points
                    // look identical and intern into far fewer values.
                    (3, Value::number(stop.transfer_score.round())),
                ],
            })
            .collect();
        Network {
            routes: routes.into_iter().map(|(_, route)| route).collect(),
            stops,
        }
    }

    fn tile(&self, z: u32, x: u32, y: u32) -> Vec<u8> {
        let scale = f64::from(1_u32 << z);
        let margin = BUFFER / EXTENT / scale;
        let tile_bounds = [
            f64::from(x) / scale - margin,
            f64::from(y) / scale - margin,
            f64::from(x + 1) / scale + margin,
            f64::from(y + 1) / scale + margin,
        ];
        let to_tile = |point: Mercator| -> [f64; 2] {
            [
                (point[0] * scale - f64::from(x)) * EXTENT,
                (point[1] * scale - f64::from(y)) * EXTENT,
            ]
        };
        let min = [-BUFFER, -BUFFER];
        let max = [EXTENT + BUFFER, EXTENT + BUFFER];
        let threshold = sq_tolerance(z as i32);

        let mut routes = LayerWriter::new("routes", &ROUTE_KEYS);
        let mut vertices = 0_usize;
        for route in &self.routes {
            if !intersects(route.bounds, tile_bounds) {
                continue;
            }
            let mut lines: Vec<Vec<[i32; 2]>> = Vec::new();
            for part in &route.parts {
                if !intersects(part.bounds, tile_bounds) {
                    continue;
                }
                let kept: Vec<[f64; 2]> = part
                    .points
                    .iter()
                    .zip(&part.importance)
                    .filter(|(_, importance)| **importance > threshold)
                    .map(|(point, _)| to_tile(*point))
                    .collect();
                lines.extend(
                    clip_polyline(&kept, min, max)
                        .into_iter()
                        .map(quantize)
                        .filter(|line| line.len() >= 2),
                );
            }
            let count: usize = lines.iter().map(Vec::len).sum();
            if count == 0 {
                continue;
            }
            if vertices + count > MAX_ROUTE_VERTICES {
                break;
            }
            vertices += count;
            routes.push(GEOMETRY_LINE, &line_geometry(&lines), &route.properties);
        }

        let mut candidates: Vec<usize> = self
            .stops
            .iter()
            .enumerate()
            .filter(|(_, stop)| {
                stop.point[0] >= tile_bounds[0]
                    && stop.point[0] <= tile_bounds[2]
                    && stop.point[1] >= tile_bounds[1]
                    && stop.point[1] <= tile_bounds[3]
            })
            .map(|(index, _)| index)
            .collect();
        if candidates.len() > MAX_STOPS {
            candidates.sort_by(|left, right| {
                let (left, right) = (self.stops[*left].rank, self.stops[*right].rank);
                right.0.total_cmp(&left.0).then(right.1.total_cmp(&left.1))
            });
            candidates.truncate(MAX_STOPS);
            candidates.sort_unstable();
        }
        let mut stops = LayerWriter::new("stops", &STOP_KEYS);
        for index in candidates {
            let stop = &self.stops[index];
            let [px, py] = to_tile(stop.point);
            let geometry = [
                command(1, 1),
                zigzag(px.round() as i32),
                zigzag(py.round() as i32),
            ];
            stops.push(GEOMETRY_POINT, &geometry, &stop.properties);
        }

        let mut tile = Vec::new();
        for layer in [routes, stops] {
            if let Some(encoded) = layer.finish() {
                write_bytes(&mut tile, 3, &encoded);
            }
        }
        tile
    }
}

fn line_geometry(lines: &[Vec<[i32; 2]>]) -> Vec<u32> {
    let mut geometry = Vec::new();
    let mut cursor = [0_i32, 0_i32];
    for line in lines {
        geometry.push(command(1, 1));
        geometry.extend([
            zigzag(line[0][0] - cursor[0]),
            zigzag(line[0][1] - cursor[1]),
        ]);
        cursor = line[0];
        geometry.push(command(2, line.len() - 1));
        for point in &line[1..] {
            geometry.extend([zigzag(point[0] - cursor[0]), zigzag(point[1] - cursor[1])]);
            cursor = *point;
        }
    }
    geometry
}

// ---------------------------------------------------------------------------
// MVT layer with typed, interned properties
// ---------------------------------------------------------------------------

struct LayerWriter {
    name: &'static str,
    keys: &'static [&'static str],
    values: Vec<Value>,
    value_index: HashMap<Value, u32>,
    features: Vec<u8>,
    feature_count: usize,
}

impl LayerWriter {
    fn new(name: &'static str, keys: &'static [&'static str]) -> Self {
        Self {
            name,
            keys,
            values: Vec::new(),
            value_index: HashMap::new(),
            features: Vec::new(),
            feature_count: 0,
        }
    }

    fn push(&mut self, geometry_type: u32, geometry: &[u32], properties: &[(u32, Value)]) {
        let mut tags = Vec::new();
        for (key, value) in properties {
            let next = self.values.len() as u32;
            let index = *self.value_index.entry(value.clone()).or_insert_with(|| {
                self.values.push(value.clone());
                next
            });
            write_varint(&mut tags, u64::from(*key));
            write_varint(&mut tags, u64::from(index));
        }
        let mut feature = Vec::new();
        write_bytes(&mut feature, 2, &tags);
        write_key(&mut feature, 3, 0);
        write_varint(&mut feature, u64::from(geometry_type));
        let mut packed = Vec::new();
        for value in geometry {
            write_varint(&mut packed, u64::from(*value));
        }
        write_bytes(&mut feature, 4, &packed);
        write_bytes(&mut self.features, 2, &feature);
        self.feature_count += 1;
    }

    fn finish(self) -> Option<Vec<u8>> {
        if self.feature_count == 0 {
            return None;
        }
        let mut layer = Vec::new();
        write_key(&mut layer, 15, 0);
        write_varint(&mut layer, 2);
        write_bytes(&mut layer, 1, self.name.as_bytes());
        layer.extend_from_slice(&self.features);
        for key in self.keys {
            write_bytes(&mut layer, 3, key.as_bytes());
        }
        for value in &self.values {
            let mut encoded = Vec::new();
            match value {
                Value::Text(text) => write_bytes(&mut encoded, 1, text.as_bytes()),
                Value::Double(bits) => {
                    write_key(&mut encoded, 3, 1);
                    encoded.extend_from_slice(&bits.to_le_bytes());
                }
                Value::Integer(integer) => {
                    write_key(&mut encoded, 6, 0);
                    write_varint(&mut encoded, ((integer << 1) ^ (integer >> 63)) as u64);
                }
            }
            write_bytes(&mut layer, 4, &encoded);
        }
        write_key(&mut layer, 5, 0);
        write_varint(&mut layer, EXTENT as u64);
        Some(layer)
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type Registry = Vec<(String, Arc<Network>)>;

/// Registered networks by the server's key, oldest first. The server releases
/// a key when its City changes; the cap only bounds a leak.
static NETWORKS: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);

pub(crate) const NOT_REGISTERED: &str = "TRANSIT_NETWORK_NOT_REGISTERED";

/// Parse and index a network overview, replacing any network under `key`.
/// Returns the number of drawable routes and stops.
pub fn register_transit_network(key: &str, json: &str) -> Result<(usize, usize), String> {
    let input: InputNetwork = serde_json::from_str(json)
        .map_err(|error| format!("Transit network overview is invalid: {error}"))?;
    let network = Arc::new(Network::from_input(input));
    let counts = (network.routes.len(), network.stops.len());
    let mut networks = NETWORKS
        .lock()
        .map_err(|_| "Transit network registry is unavailable.".to_string())?;
    networks.retain(|(existing, _)| existing != key);
    networks.push((key.to_string(), network));
    if networks.len() > REGISTERED_NETWORKS {
        let excess = networks.len() - REGISTERED_NETWORKS;
        networks.drain(..excess);
    }
    Ok(counts)
}

pub fn release_transit_network(key: &str) -> bool {
    NETWORKS.lock().is_ok_and(|mut networks| {
        let before = networks.len();
        networks.retain(|(existing, _)| existing != key);
        networks.len() != before
    })
}

/// Encode tile `z/x/y` of a registered network. An empty vector means the
/// tile has nothing to draw.
pub fn transit_network_tile(key: &str, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    if z > 22 || x >= (1_u32 << z) || y >= (1_u32 << z) {
        return Err(format!(
            "Tile {z}/{x}/{y} is outside the Web Mercator pyramid."
        ));
    }
    let network = NETWORKS
        .lock()
        .map_err(|_| "Transit network registry is unavailable.".to_string())?
        .iter()
        .find(|(existing, _)| existing == key)
        .map(|(_, network)| Arc::clone(network))
        .ok_or_else(|| NOT_REGISTERED.to_string())?;
    Ok(network.tile(z, x, y))
}

#[cfg(feature = "node")]
pub(crate) mod node {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    pub struct RegisterTransitNetworkTask {
        key: String,
        json: String,
    }

    #[napi]
    impl Task for RegisterTransitNetworkTask {
        type Output = (usize, usize);
        type JsValue = Vec<u32>;

        fn compute(&mut self) -> Result<Self::Output> {
            super::register_transit_network(&self.key, &self.json)
                .map_err(|reason| Error::new(Status::InvalidArg, reason))
        }

        fn resolve(&mut self, _env: Env, (routes, stops): Self::Output) -> Result<Self::JsValue> {
            Ok(vec![routes as u32, stops as u32])
        }
    }

    /// Index a City's route and stop overview (JSON) on the libuv pool.
    /// Resolves to `[routes, stops]` drawn by the registered network.
    #[napi]
    pub fn register_transit_network(
        key: String,
        network_json: String,
    ) -> AsyncTask<RegisterTransitNetworkTask> {
        AsyncTask::new(RegisterTransitNetworkTask {
            key,
            json: network_json,
        })
    }

    /// Forget a registered network. Returns whether one was registered.
    #[napi]
    pub fn release_transit_network(key: String) -> bool {
        super::release_transit_network(&key)
    }

    pub struct TransitNetworkTileTask {
        key: String,
        z: u32,
        x: u32,
        y: u32,
    }

    #[napi]
    impl Task for TransitNetworkTileTask {
        type Output = Vec<u8>;
        type JsValue = Buffer;

        fn compute(&mut self) -> Result<Self::Output> {
            super::transit_network_tile(&self.key, self.z, self.x, self.y)
                .map_err(|reason| Error::new(Status::GenericFailure, reason))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(output.into())
        }
    }

    /// Render one transit network tile on the libuv pool. Rejects with
    /// `TRANSIT_NETWORK_NOT_REGISTERED` when the key needs registering.
    #[napi]
    pub fn transit_network_tile(
        key: String,
        z: u32,
        x: u32,
        y: u32,
    ) -> AsyncTask<TransitNetworkTileTask> {
        AsyncTask::new(TransitNetworkTileTask { key, z, x, y })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_varint(bytes: &[u8], offset: &mut usize) -> u64 {
        let mut value = 0_u64;
        let mut shift = 0;
        loop {
            let byte = bytes[*offset];
            *offset += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return value;
            }
            shift += 7;
        }
    }

    fn fields(bytes: &[u8]) -> Vec<(u64, Vec<u8>)> {
        let mut offset = 0;
        let mut result = Vec::new();
        while offset < bytes.len() {
            let key = decode_varint(bytes, &mut offset);
            match key & 7 {
                2 => {
                    let length = decode_varint(bytes, &mut offset) as usize;
                    result.push((key >> 3, bytes[offset..offset + length].to_vec()));
                    offset += length;
                }
                1 => {
                    result.push((key >> 3, bytes[offset..offset + 8].to_vec()));
                    offset += 8;
                }
                _ => {
                    let value = decode_varint(bytes, &mut offset);
                    result.push((key >> 3, value.to_le_bytes().to_vec()));
                }
            }
        }
        result
    }

    #[derive(Debug)]
    struct Feature {
        properties: HashMap<String, String>,
        geometry: Vec<u32>,
    }

    /// Decode every layer into features with stringified properties.
    fn decode(tile: &[u8]) -> HashMap<String, Vec<Feature>> {
        let mut layers = HashMap::new();
        for (field, layer) in fields(tile) {
            assert_eq!(field, 3);
            let layer_fields = fields(&layer);
            let name = layer_fields
                .iter()
                .find(|(field, _)| *field == 1)
                .map(|(_, name)| String::from_utf8(name.clone()).unwrap())
                .unwrap();
            let keys: Vec<String> = layer_fields
                .iter()
                .filter(|(field, _)| *field == 3)
                .map(|(_, key)| String::from_utf8(key.clone()).unwrap())
                .collect();
            let values: Vec<String> = layer_fields
                .iter()
                .filter(|(field, _)| *field == 4)
                .map(|(_, value)| {
                    let (kind, bytes) = fields(value).remove(0);
                    match kind {
                        1 => String::from_utf8(bytes).unwrap(),
                        3 => f64::from_le_bytes(bytes.try_into().unwrap()).to_string(),
                        6 => {
                            let raw = u64::from_le_bytes(bytes.try_into().unwrap());
                            (((raw >> 1) as i64) ^ -((raw & 1) as i64)).to_string()
                        }
                        other => panic!("unexpected value type {other}"),
                    }
                })
                .collect();
            let features = layer_fields
                .iter()
                .filter(|(field, _)| *field == 2)
                .map(|(_, feature)| {
                    let feature_fields = fields(feature);
                    let packed = |wanted: u64| {
                        let bytes = &feature_fields
                            .iter()
                            .find(|(field, _)| *field == wanted)
                            .unwrap()
                            .1;
                        let mut offset = 0;
                        let mut numbers = Vec::new();
                        while offset < bytes.len() {
                            numbers.push(decode_varint(bytes, &mut offset) as u32);
                        }
                        numbers
                    };
                    let tags = packed(2);
                    Feature {
                        properties: tags
                            .chunks(2)
                            .map(|pair| {
                                (
                                    keys[pair[0] as usize].clone(),
                                    values[pair[1] as usize].clone(),
                                )
                            })
                            .collect(),
                        geometry: packed(4),
                    }
                })
                .collect();
            layers.insert(name, features);
        }
        layers
    }

    /// Number of MoveTo commands, i.e. drawn line parts.
    fn line_parts(geometry: &[u32]) -> usize {
        let mut index = 0;
        let mut parts = 0;
        while index < geometry.len() {
            let (id, count) = (geometry[index] & 7, (geometry[index] >> 3) as usize);
            if id == 1 {
                parts += 1;
            }
            index += 1 + count * 2;
        }
        parts
    }

    fn network_json() -> String {
        serde_json::json!({
            "routes": [
                {
                    "featureId": "feed::red", "routeId": "red", "patternId": "red-0", "directionId": "0",
                    "shortName": "Red", "longName": "Red Line", "color": "#DA291C", "routeType": 1,
                    "tripCount": 412, "status": "baseline", "headwayMinutes": 6, "spanHours": 19.5,
                    "stopCount": 3, "serviceHours": 210.25, "serviceShare": 0.25, "frequencyClass": "high",
                    "geometrySource": "shape", "distanceKm": 2.4, "scheduledSpeedKph": 28.5,
                    "coordinates": [[-71.06, 42.35], [-71.059, 42.355], [-71.058, 42.36]]
                },
                {
                    // A shape that teleports 40 km mid-route must not draw the chord.
                    "featureId": "feed::jump", "routeId": "jump", "shortName": "J", "color": "#000000",
                    "tripCount": 3, "geometrySource": "shape", "distanceKm": 10,
                    "coordinates": [[-71.06, 42.35], [-71.05, 42.35], [-70.6, 42.35], [-70.59, 42.35]]
                },
                { "featureId": "feed::none", "coordinates": [[-71.0, 42.0]] }
            ],
            "stops": [
                { "stopId": "feed::a", "lon": -71.0624, "lat": 42.3564,
                  "routeCount": 2, "tripCount": 900, "transferScore": 99.6 },
                { "stopId": "feed::far", "lon": 2.35, "lat": 48.85 }
            ]
        })
        .to_string()
    }

    /// The z/x/y tile containing a coordinate.
    fn tile_of(lon: f64, lat: f64, z: u32) -> (u32, u32) {
        let [mx, my] = mercator([lon, lat]);
        let scale = f64::from(1_u32 << z);
        ((mx * scale) as u32, (my * scale) as u32)
    }

    #[test]
    fn tiles_carry_route_and_stop_layers_with_identities() {
        let key = "test-identities";
        assert_eq!(
            register_transit_network(key, &network_json()).unwrap(),
            (2, 2)
        );
        let (x, y) = tile_of(-71.059, 42.355, 12);
        let layers = decode(&transit_network_tile(key, 12, x, y).unwrap());
        let red = layers["routes"]
            .iter()
            .find(|feature| feature.properties["featureId"] == "feed::red")
            .expect("red line in its tile");
        assert_eq!(red.properties["color"], "#DA291C");
        assert_eq!(red.properties["routeType"], "1");
        assert_eq!(red.properties["tripCount"], "412");
        assert_eq!(red.properties["spanHours"], "19.5");
        assert_eq!(red.properties["frequencyClass"], "high");
        assert_eq!(red.properties["geometryConfidence"], "trusted");
        assert_eq!(red.properties["geometryFragmentCount"], "1");
        let stop = &layers["stops"][0];
        assert_eq!(stop.properties["stopId"], "feed::a");
        assert_eq!(stop.properties["routeCount"], "2");
        assert_eq!(stop.properties["transferScore"], "100");
        assert!(release_transit_network(key));
        assert_eq!(
            transit_network_tile(key, 12, x, y).unwrap_err(),
            NOT_REGISTERED
        );
    }

    #[test]
    fn shapes_split_at_implausible_jumps() {
        let key = "test-jumps";
        register_transit_network(key, &network_json()).unwrap();
        // Both runs share one z8 tile, where each spans about thirty units.
        let (x, y) = tile_of(-70.8, 42.35, 8);
        let layers = decode(&transit_network_tile(key, 8, x, y).unwrap());
        let jump = layers["routes"]
            .iter()
            .find(|feature| feature.properties["featureId"] == "feed::jump")
            .unwrap();
        assert_eq!(jump.properties["geometryConfidence"], "split");
        assert_eq!(jump.properties["geometryFragmentCount"], "2");
        assert_eq!(line_parts(&jump.geometry), 2);
        // No routeType was published, so none is invented.
        assert!(!jump.properties.contains_key("routeType"));
        release_transit_network(key);
    }

    #[test]
    fn tiles_far_from_the_network_are_empty_and_stops_are_capped() {
        let key = "test-empty";
        let stops: Vec<_> = (0..MAX_STOPS + 10)
            .map(|index| {
                serde_json::json!({
                    "stopId": format!("s{index}"), "lon": -71.0 + index as f64 * 1e-6, "lat": 42.0,
                    "transferScore": if index == MAX_STOPS + 9 { 100 } else { 0 }
                })
            })
            .collect();
        let json = serde_json::json!({ "routes": [], "stops": stops }).to_string();
        register_transit_network(key, &json).unwrap();
        assert!(transit_network_tile(key, 10, 0, 0).unwrap().is_empty());
        let (x, y) = tile_of(-71.0, 42.0, 10);
        let layers = decode(&transit_network_tile(key, 10, x, y).unwrap());
        assert_eq!(layers["stops"].len(), MAX_STOPS);
        // The highest-ranked stop survives the cap.
        assert!(
            layers["stops"]
                .iter()
                .any(|stop| stop.properties["stopId"] == format!("s{}", MAX_STOPS + 9))
        );
        assert!(transit_network_tile(key, 3, 9, 0).is_err());
        release_transit_network(key);
    }

    #[test]
    fn simplification_keeps_endpoints_and_drops_negligible_vertices() {
        let line: Vec<Mercator> = vec![[0.0, 0.0], [0.5, 1e-12], [1.0, 0.0], [1.0, 1.0]];
        let importance = vertex_importance(&line, sq_tolerance(FINEST_SIMPLIFIED_ZOOM));
        assert!(importance[0].is_infinite() && importance[3].is_infinite());
        assert_eq!(importance[1], 0.0);
        assert!(importance[2] > sq_tolerance(0));
    }

    #[test]
    fn inferred_lines_tolerate_three_typical_spacings() {
        // Stops about 2 km apart on the equator: a 5 km gap is one line,
        // a 30 km gap splits it.
        let near = [
            [0.0, 0.0],
            [0.018, 0.0],
            [0.036, 0.0],
            [0.081, 0.0],
            [0.099, 0.0],
        ];
        let threshold = inferred_jump_threshold_km(&near);
        assert!((threshold - 6.0).abs() < 0.1, "{threshold}");
        assert_eq!(split_at_jumps(&near, threshold).len(), 1);
        let far = [
            [0.0, 0.0],
            [0.018, 0.0],
            [0.036, 0.0],
            [0.306, 0.0],
            [0.324, 0.0],
        ];
        assert_eq!(
            split_at_jumps(&far, inferred_jump_threshold_km(&far)).len(),
            2
        );
    }
}
