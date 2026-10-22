//! Offline basemap as Mapbox Vector Tiles (MVT 2.1).
//!
//! The OSM importer writes generalized roads, water, rivers and coastlines into
//! the City's street index (`map_features`, schema `vigo.local-basemap.v1`).
//! This module only reads that table. Each tile is cut in Web Mercator, clipped
//! with a small buffer and encoded as one `basemap` layer whose `kind` and
//! `roadClass` properties match the GeoJSON features the Studio has always
//! styled. Oceans are polygonized from coastlines per tile with the same rules
//! the JavaScript viewport reader used: land on the left of a coastline, closed
//! clockwise along the tile boundary, and never across an incomplete shore.

use rusqlite::{Connection, OpenFlags, params};
use serde::Deserialize;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

const SCHEMA_VERSION: &str = "vigo.local-basemap.v1";
pub(crate) const EXTENT: f64 = 4096.0;
/// Tile units kept outside each edge so strokes and fills join seamlessly.
pub(crate) const BUFFER: f64 = 64.0;
const MAX_FEATURES: usize = 4_500;
const MAX_VERTICES: usize = 80_000;
const COAST_PIECES: usize = 4_096;
const COAST_VERTICES: usize = 80_000;
const CONTAINMENT_CHECKS: usize = 1_000_000;
pub(crate) const MAX_LATITUDE: f64 = 85.051_128_78;
const POOLED_CONNECTIONS: usize = 4;

type Point = [f64; 2];

#[derive(Clone, Copy, Debug)]
struct Bounds {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

impl Bounds {
    fn intersect(self, other: Bounds) -> Option<Bounds> {
        let bounds = Bounds {
            west: self.west.max(other.west),
            south: self.south.max(other.south),
            east: self.east.min(other.east),
            north: self.north.min(other.north),
        };
        (bounds.west < bounds.east && bounds.south < bounds.north).then_some(bounds)
    }
}

#[derive(Deserialize)]
struct StoredBounds {
    west: f64,
    east: f64,
    south: f64,
    north: f64,
}

#[derive(Deserialize, Default)]
struct StoredCounts {
    #[serde(default)]
    coastline: u64,
}

#[derive(Deserialize)]
struct StoredMetadata {
    #[serde(rename = "schemaVersion")]
    schema_version: String,
    #[serde(default)]
    counts: StoredCounts,
    bounds: Option<StoredBounds>,
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "coordinates")]
enum StoredGeometry {
    LineString(Vec<Point>),
    Polygon(Vec<Vec<Point>>),
}

/// A few read-only connections per store keep SQLite's page cache warm across
/// the burst of tiles a single camera move requests. A changed file (a new OSM
/// import) is detected by its modification time and length.
struct StorePool {
    identity: (SystemTime, u64),
    generation: Arc<()>,
    connections: Vec<Connection>,
}

static STORE_POOLS: LazyLock<Mutex<HashMap<String, StorePool>>> = LazyLock::new(Default::default);

fn store_identity(path: &str) -> Result<(SystemTime, u64), String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Street index is unavailable: {error}"))?;
    Ok((
        metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        metadata.len(),
    ))
}

fn checkout(path: &str) -> Result<(Connection, Arc<()>), String> {
    let identity = store_identity(path)?;
    let generation = {
        let mut pools = STORE_POOLS.lock().map_err(|error| error.to_string())?;
        if pools
            .get(path)
            .is_some_and(|pool| pool.identity != identity)
        {
            pools.remove(path);
        }
        let pool = pools.entry(path.to_string()).or_insert_with(|| StorePool {
            identity,
            generation: Arc::new(()),
            connections: Vec::new(),
        });
        if let Some(connection) = pool.connections.pop() {
            return Ok((connection, Arc::clone(&pool.generation)));
        }
        Arc::clone(&pool.generation)
    };
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Street index could not be opened: {error}"))?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY;")
        .map_err(|error| error.to_string())?;
    Ok((connection, generation))
}

fn checkin(path: &str, generation: Arc<()>, connection: Connection) {
    if let Ok(mut pools) = STORE_POOLS.lock()
        && let Some(pool) = pools.get_mut(path)
        && Arc::ptr_eq(&pool.generation, &generation)
        && pool.connections.len() < POOLED_CONNECTIONS
    {
        pool.connections.push(connection);
    }
}

/// Release idle readers before replacing or deleting a street store. In-flight
/// tiles from the retired generation close their readers instead of caching them.
#[cfg(any(feature = "node", test))]
pub fn dispose_local_basemap_store(path: &str) {
    if let Ok(mut pools) = STORE_POOLS.lock() {
        pools.remove(path);
    }
}

// ---------------------------------------------------------------------------
// Tile geometry
// ---------------------------------------------------------------------------

fn tile_lon(x: f64, scale: f64) -> f64 {
    x / scale * 360.0 - 180.0
}

fn tile_lat(y: f64, scale: f64) -> f64 {
    (PI * (1.0 - 2.0 * y / scale)).sinh().atan().to_degrees()
}

struct TileFrame {
    x: f64,
    y: f64,
    scale: f64,
}

impl TileFrame {
    fn project(&self, [lon, lat]: Point) -> Point {
        let latitude = lat.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
        let mercator_x = (lon + 180.0) / 360.0 * self.scale;
        let mercator_y =
            (1.0 - (latitude.tan() + 1.0 / latitude.cos()).ln() / PI) / 2.0 * self.scale;
        [
            (mercator_x - self.x) * EXTENT,
            (mercator_y - self.y) * EXTENT,
        ]
    }

    fn bounds(&self, buffer_units: f64) -> Bounds {
        let margin = buffer_units / EXTENT;
        Bounds {
            west: tile_lon(self.x - margin, self.scale).max(-180.0),
            east: tile_lon(self.x + 1.0 + margin, self.scale).min(180.0),
            north: tile_lat(self.y - margin, self.scale).min(MAX_LATITUDE),
            south: tile_lat(self.y + 1.0 + margin, self.scale).max(-MAX_LATITUDE),
        }
    }
}

/// Liang–Barsky: the part of segment `a`→`b` inside an axis-aligned box.
fn clip_segment(a: Point, b: Point, min: Point, max: Point) -> Option<(Point, Point)> {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let mut enter = 0.0_f64;
    let mut leave = 1.0_f64;
    for (p, q) in [
        (-dx, a[0] - min[0]),
        (dx, max[0] - a[0]),
        (-dy, a[1] - min[1]),
        (dy, max[1] - a[1]),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
            continue;
        }
        let t = q / p;
        if p < 0.0 {
            enter = enter.max(t);
        } else {
            leave = leave.min(t);
        }
        if enter >= leave {
            return None;
        }
    }
    Some((
        [a[0] + enter * dx, a[1] + enter * dy],
        [a[0] + leave * dx, a[1] + leave * dy],
    ))
}

fn same_point(left: Point, right: Point) -> bool {
    (left[0] - right[0]).abs() < 1e-9 && (left[1] - right[1]).abs() < 1e-9
}

/// Split a polyline into the runs that fall inside the box.
pub(crate) fn clip_polyline(line: &[Point], min: Point, max: Point) -> Vec<Vec<Point>> {
    let mut parts: Vec<Vec<Point>> = Vec::new();
    let mut current: Option<Vec<Point>> = None;
    for pair in line.windows(2) {
        match clip_segment(pair[0], pair[1], min, max) {
            None => {
                if let Some(part) = current.take() {
                    parts.push(part);
                }
            }
            Some((start, end)) => match current.as_mut() {
                Some(part) if same_point(*part.last().unwrap(), start) => part.push(end),
                _ => {
                    if let Some(part) = current.take() {
                        parts.push(part);
                    }
                    current = Some(vec![start, end]);
                }
            },
        }
    }
    if let Some(part) = current {
        parts.push(part);
    }
    parts
}

/// Sutherland–Hodgman against the four box edges. Fill rendering tolerates the
/// degenerate edges this leaves along the tile border.
fn clip_ring(ring: &[Point], min: Point, max: Point) -> Vec<Point> {
    let mut output: Vec<Point> = ring.to_vec();
    if output.len() > 1 && same_point(output[0], *output.last().unwrap()) {
        output.pop();
    }
    for edge in 0..4 {
        if output.is_empty() {
            break;
        }
        let inside = |point: Point| match edge {
            0 => point[0] >= min[0],
            1 => point[0] <= max[0],
            2 => point[1] >= min[1],
            _ => point[1] <= max[1],
        };
        let intersect = |a: Point, b: Point| {
            let (axis, value) = match edge {
                0 => (0, min[0]),
                1 => (0, max[0]),
                2 => (1, min[1]),
                _ => (1, max[1]),
            };
            let t = (value - a[axis]) / (b[axis] - a[axis]);
            [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
        };
        let input = std::mem::take(&mut output);
        let mut previous = *input.last().unwrap();
        for &point in &input {
            match (inside(point), inside(previous)) {
                (true, true) => output.push(point),
                (true, false) => {
                    output.push(intersect(previous, point));
                    output.push(point);
                }
                (false, true) => output.push(intersect(previous, point)),
                (false, false) => {}
            }
            previous = point;
        }
    }
    output
}

pub(crate) fn quantize(points: impl IntoIterator<Item = Point>) -> Vec<[i32; 2]> {
    let mut result: Vec<[i32; 2]> = Vec::new();
    for [x, y] in points {
        let point = [x.round() as i32, y.round() as i32];
        if result.last() != Some(&point) {
            result.push(point);
        }
    }
    result
}

fn ring_area(ring: &[[i32; 2]]) -> f64 {
    let mut area = 0.0;
    for index in 0..ring.len() {
        let [x1, y1] = ring[index];
        let [x2, y2] = ring[(index + 1) % ring.len()];
        area += f64::from(x1) * f64::from(y2) - f64::from(x2) * f64::from(y1);
    }
    area / 2.0
}

// ---------------------------------------------------------------------------
// Coastlines to ocean (a port of local-basemap-geometry.mjs)
// ---------------------------------------------------------------------------

fn point_key(point: Point) -> (i64, i64) {
    (
        (point[0] * 1e8).round() as i64,
        (point[1] * 1e8).round() as i64,
    )
}

fn signed_area(ring: &[Point]) -> f64 {
    let mut area = 0.0;
    for pair in ring.windows(2) {
        area += pair[0][0] * pair[1][1] - pair[1][0] * pair[0][1];
    }
    area / 2.0
}

fn contains_point(ring: &[Point], point: Point) -> bool {
    let mut inside = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn segment_distance(point: Point, start: Point, end: Point) -> f64 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let t = if dx != 0.0 || dy != 0.0 {
        (((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy))
            .clamp(0.0, 1.0)
    } else {
        0.0
    };
    (point[0] - start[0] - t * dx).powi(2) + (point[1] - start[1] - t * dy).powi(2)
}

/// Join coastline pieces end to end, keeping their direction (land on the left).
fn join_directed(lines: Vec<Vec<Point>>) -> Vec<Vec<Point>> {
    let mut starts: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    let mut ends: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (index, line) in lines.iter().enumerate() {
        starts.entry(point_key(line[0])).or_default().push(index);
        ends.entry(point_key(*line.last().unwrap()))
            .or_default()
            .push(index);
    }
    let mut used = vec![false; lines.len()];
    let mut result = Vec::new();
    for index in 0..lines.len() {
        if used[index] {
            continue;
        }
        used[index] = true;
        let mut prefix: Vec<usize> = Vec::new();
        let mut suffix: Vec<usize> = Vec::new();
        let mut first = lines[index][0];
        let mut last = *lines[index].last().unwrap();
        while !same_point(first, last) {
            let next = starts.get(&point_key(last)).and_then(|candidates| {
                candidates
                    .iter()
                    .copied()
                    .find(|&candidate| !used[candidate])
            });
            let Some(next) = next else { break };
            used[next] = true;
            suffix.push(next);
            last = *lines[next].last().unwrap();
        }
        while !same_point(first, last) {
            let previous = ends.get(&point_key(first)).and_then(|candidates| {
                candidates
                    .iter()
                    .copied()
                    .find(|&candidate| !used[candidate])
            });
            let Some(previous) = previous else { break };
            used[previous] = true;
            prefix.push(previous);
            first = lines[previous][0];
        }
        let mut line: Vec<Point> = Vec::new();
        for part in prefix
            .iter()
            .rev()
            .chain(std::iter::once(&index))
            .chain(suffix.iter())
        {
            let skip = usize::from(!line.is_empty());
            line.extend(lines[*part].iter().skip(skip).copied());
        }
        result.push(line);
    }
    result
}

fn polygons_with_holes(
    outers: Vec<Vec<Point>>,
    holes: Vec<Vec<Point>>,
) -> Option<Vec<Vec<Vec<Point>>>> {
    let mut polygons: Vec<Vec<Vec<Point>>> = outers
        .into_iter()
        .map(|ring| {
            vec![if signed_area(&ring) < 0.0 {
                ring.into_iter().rev().collect()
            } else {
                ring
            }]
        })
        .collect();
    let areas: Vec<f64> = polygons
        .iter()
        .map(|polygon| signed_area(&polygon[0]).abs())
        .collect();
    let mut work = 0_usize;
    for hole in holes {
        let mut owner = None;
        let mut smallest = f64::INFINITY;
        for (index, polygon) in polygons.iter().enumerate() {
            work += 1;
            if work > CONTAINMENT_CHECKS {
                return None;
            }
            if areas[index] >= smallest {
                continue;
            }
            work += polygon[0].len();
            if work > CONTAINMENT_CHECKS {
                return None;
            }
            if contains_point(&polygon[0], hole[0]) {
                owner = Some(index);
                smallest = areas[index];
            }
        }
        if let Some(owner) = owner {
            polygons[owner].push(if signed_area(&hole) > 0.0 {
                hole.into_iter().rev().collect()
            } else {
                hole
            });
        }
    }
    Some(polygons)
}

fn nearest_coast_side(lines: &[Vec<Point>], point: Point) -> Option<f64> {
    let mut nearest = f64::INFINITY;
    let mut side = None;
    for line in lines {
        for pair in line.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let length = (b[0] - a[0]).hypot(b[1] - a[1]);
            if length == 0.0 {
                continue;
            }
            let distance = segment_distance(point, a, b);
            let direction =
                ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) / length;
            if (distance - nearest).abs() < 1e-18 {
                // At a shared vertex use both adjacent shore normals.
                side = Some(side.unwrap_or(0.0) + direction);
            } else if distance < nearest {
                nearest = distance;
                side = Some(direction);
            }
        }
    }
    side
}

struct Ocean {
    polygons: Vec<Vec<Vec<Point>>>,
    outlines: Vec<Vec<Point>>,
}

fn clip_coasts(lines: &[Vec<Point>], bounds: Bounds) -> (Vec<Vec<Point>>, bool) {
    let min = [bounds.west, bounds.south];
    let max = [bounds.east, bounds.north];
    let mut result = Vec::new();
    let mut vertices = 0_usize;
    for line in lines {
        for part in clip_polyline(line, min, max) {
            if result.len() >= COAST_PIECES || vertices + part.len() > COAST_VERTICES {
                return (result, false);
            }
            vertices += part.len();
            result.push(part);
        }
    }
    (result, true)
}

/// Close complete coastlines inside `bounds` into ocean polygons. Exterior
/// closures follow the boundary clockwise; an incomplete or limited shore only
/// yields outlines, never an invented diagonal across land.
fn ocean_polygons(
    lines: &[Vec<Point>],
    bounds: Bounds,
    corner_side: Option<f64>,
    source_complete: bool,
) -> Ocean {
    let (clipped, clipped_complete) = clip_coasts(lines, bounds);
    let incomplete = |outlines: Vec<Vec<Point>>| Ocean {
        polygons: Vec::new(),
        outlines,
    };
    if !clipped_complete || !source_complete {
        return incomplete(clipped);
    }
    let Bounds {
        west: w,
        south: s,
        east: e,
        north: n,
    } = bounds;
    let (width, height) = (e - w, n - s);
    let perimeter = 2.0 * (width + height);
    let corners = [[w, s], [w, n], [e, n], [e, s]];
    let positions = [0.0, height, height + width, 2.0 * height + width];
    let boundary_position = |point: Point| -> Option<f64> {
        let epsilon = 1e-7;
        if (point[0] - w).abs() < epsilon {
            Some(point[1] - s)
        } else if (point[1] - n).abs() < epsilon {
            Some(height + point[0] - w)
        } else if (point[0] - e).abs() < epsilon {
            Some(height + width + n - point[1])
        } else if (point[1] - s).abs() < epsilon {
            Some(2.0 * height + width + e - point[0])
        } else {
            None
        }
    };
    let mut open: Vec<(Vec<Point>, f64, f64)> = Vec::new();
    let mut outers: Vec<Vec<Point>> = Vec::new();
    let mut holes: Vec<Vec<Point>> = Vec::new();
    for line in join_directed(clipped.clone()) {
        if same_point(line[0], *line.last().unwrap()) {
            if line.len() >= 4 {
                if signed_area(&line) < 0.0 {
                    outers.push(line);
                } else {
                    holes.push(line);
                }
            }
        } else {
            let (Some(start), Some(end)) = (
                boundary_position(line[0]),
                boundary_position(*line.last().unwrap()),
            ) else {
                return incomplete(clipped);
            };
            open.push((line, start, end));
        }
    }
    let mut starts: Vec<(f64, usize)> = open
        .iter()
        .enumerate()
        .map(|(index, (_, start, _))| (*start, index))
        .collect();
    starts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut visited = vec![false; open.len()];
    for first in 0..open.len() {
        if visited[first] {
            continue;
        }
        let mut ring: Vec<Point> = Vec::new();
        let mut cursor = first;
        loop {
            if visited[cursor] {
                return incomplete(clipped);
            }
            visited[cursor] = true;
            let (line, _, end) = &open[cursor];
            ring.extend(line.iter().copied());
            let next = starts.partition_point(|(start, _)| *start < *end);
            let (next_start, next_index) = starts.get(next).copied().unwrap_or(starts[0]);
            let distance = (next_start - end + perimeter) % perimeter;
            let mut boundary: Vec<(f64, Point)> = positions
                .iter()
                .zip(corners)
                .map(|(position, corner)| ((position - end + perimeter) % perimeter, corner))
                .filter(|(corner_distance, _)| {
                    *corner_distance > 1e-10 && *corner_distance < distance
                })
                .collect();
            boundary.sort_by(|a, b| a.0.total_cmp(&b.0));
            ring.extend(boundary.into_iter().map(|(_, corner)| corner));
            cursor = next_index;
            if cursor == first {
                break;
            }
        }
        ring.push(ring[0]);
        outers.push(ring);
    }
    if open.is_empty() && corner_side.is_some_and(|side| side < 0.0) {
        outers.insert(
            0,
            vec![corners[0], corners[1], corners[2], corners[3], corners[0]],
        );
    }
    match polygons_with_holes(outers, holes) {
        Some(polygons) => Ocean {
            polygons,
            outlines: clipped,
        },
        None => incomplete(clipped),
    }
}

// ---------------------------------------------------------------------------
// MVT encoding
// ---------------------------------------------------------------------------

pub(crate) const GEOMETRY_LINE: u32 = 2;
const GEOMETRY_POLYGON: u32 = 3;

pub(crate) fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        buffer.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    buffer.push(value as u8);
}

pub(crate) fn write_key(buffer: &mut Vec<u8>, field: u32, wire: u32) {
    write_varint(buffer, u64::from((field << 3) | wire));
}

pub(crate) fn write_bytes(buffer: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    write_key(buffer, field, 2);
    write_varint(buffer, bytes.len() as u64);
    buffer.extend_from_slice(bytes);
}

pub(crate) fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

pub(crate) fn command(id: u32, count: usize) -> u32 {
    (id & 0x7) | ((count as u32) << 3)
}

struct LayerWriter {
    features: Vec<u8>,
    feature_count: usize,
    vertex_count: usize,
    values: Vec<String>,
}

impl LayerWriter {
    fn new() -> Self {
        Self {
            features: Vec::new(),
            feature_count: 0,
            vertex_count: 0,
            values: Vec::new(),
        }
    }

    fn value_index(&mut self, value: &str) -> u32 {
        if let Some(index) = self.values.iter().position(|candidate| candidate == value) {
            return index as u32;
        }
        self.values.push(value.to_string());
        (self.values.len() - 1) as u32
    }

    fn has_room(&self, vertices: usize) -> bool {
        self.feature_count < MAX_FEATURES && self.vertex_count + vertices <= MAX_VERTICES
    }

    fn push(
        &mut self,
        kind: &str,
        road_class: Option<&str>,
        geometry_type: u32,
        geometry: &[u32],
        vertices: usize,
    ) {
        let mut tags = vec![0, self.value_index(kind)];
        if let Some(road_class) = road_class {
            tags.extend([1, self.value_index(road_class)]);
        }
        let mut feature = Vec::new();
        let mut packed = Vec::new();
        for tag in tags {
            write_varint(&mut packed, u64::from(tag));
        }
        write_bytes(&mut feature, 2, &packed);
        write_key(&mut feature, 3, 0);
        write_varint(&mut feature, u64::from(geometry_type));
        packed.clear();
        for value in geometry {
            write_varint(&mut packed, u64::from(*value));
        }
        write_bytes(&mut feature, 4, &packed);
        write_bytes(&mut self.features, 2, &feature);
        self.feature_count += 1;
        self.vertex_count += vertices;
    }

    /// Encode clipped polylines; returns false once the tile budget is spent.
    fn push_lines(
        &mut self,
        kind: &str,
        road_class: Option<&str>,
        lines: Vec<Vec<[i32; 2]>>,
    ) -> bool {
        let lines: Vec<_> = lines.into_iter().filter(|line| line.len() >= 2).collect();
        let vertices: usize = lines.iter().map(Vec::len).sum();
        if lines.is_empty() {
            return true;
        }
        if !self.has_room(vertices) {
            return false;
        }
        let mut geometry = Vec::with_capacity(vertices * 2 + lines.len() * 2);
        let mut cursor = [0_i32, 0_i32];
        for line in &lines {
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
        self.push(kind, road_class, GEOMETRY_LINE, &geometry, vertices);
        true
    }

    /// Encode one polygon (exterior first). MVT winding: exterior rings have
    /// positive area in tile coordinates (y down), interior rings negative.
    fn push_polygon(&mut self, kind: &str, rings: Vec<Vec<[i32; 2]>>) -> bool {
        let mut prepared: Vec<Vec<[i32; 2]>> = Vec::new();
        for (index, mut ring) in rings.into_iter().enumerate() {
            if ring.len() > 1 && ring.first() == ring.last() {
                ring.pop();
            }
            if ring.len() < 3 {
                if index == 0 {
                    return true;
                }
                continue;
            }
            let area = ring_area(&ring);
            if area == 0.0 {
                if index == 0 {
                    return true;
                }
                continue;
            }
            if (index == 0) != (area > 0.0) {
                ring.reverse();
            }
            prepared.push(ring);
        }
        if prepared.is_empty() {
            return true;
        }
        let vertices: usize = prepared.iter().map(Vec::len).sum();
        if !self.has_room(vertices) {
            return false;
        }
        let mut geometry = Vec::with_capacity(vertices * 2 + prepared.len() * 3);
        let mut cursor = [0_i32, 0_i32];
        for ring in &prepared {
            geometry.push(command(1, 1));
            geometry.extend([
                zigzag(ring[0][0] - cursor[0]),
                zigzag(ring[0][1] - cursor[1]),
            ]);
            cursor = ring[0];
            geometry.push(command(2, ring.len() - 1));
            for point in &ring[1..] {
                geometry.extend([zigzag(point[0] - cursor[0]), zigzag(point[1] - cursor[1])]);
                cursor = *point;
            }
            geometry.push(command(7, 1));
        }
        self.push(kind, None, GEOMETRY_POLYGON, &geometry, vertices);
        true
    }

    fn finish(self) -> Vec<u8> {
        if self.feature_count == 0 {
            return Vec::new();
        }
        let mut layer = Vec::new();
        write_key(&mut layer, 15, 0);
        write_varint(&mut layer, 2);
        write_bytes(&mut layer, 1, b"basemap");
        layer.extend_from_slice(&self.features);
        write_bytes(&mut layer, 3, b"kind");
        write_bytes(&mut layer, 3, b"roadClass");
        for value in &self.values {
            let mut encoded = Vec::new();
            write_bytes(&mut encoded, 1, value.as_bytes());
            write_bytes(&mut layer, 4, &encoded);
        }
        write_key(&mut layer, 5, 0);
        write_varint(&mut layer, EXTENT as u64);
        let mut tile = Vec::new();
        write_bytes(&mut tile, 3, &layer);
        tile
    }
}

// ---------------------------------------------------------------------------
// Reading the street index
// ---------------------------------------------------------------------------

const SPATIAL_SQL: &str = "FROM map_features_rtree AS box CROSS JOIN map_features AS feature ON feature.id=box.id \
  WHERE box.west<=?1 AND box.east>=?2 AND box.south<=?3 AND box.north>=?4 AND box.min_lod<=?5 AND box.max_lod>=?5 \
  AND box.min_rank<=?6 AND box.max_rank>=?7 AND box.min_zoom<=?8 AND box.max_zoom>=?8";

struct Coasts {
    lines: Vec<Vec<Point>>,
    complete: bool,
}

fn read_coasts(
    connection: &Connection,
    bounds: Bounds,
    lod: u32,
    zoom: u32,
) -> Result<Coasts, String> {
    let mut statement = connection
        .prepare_cached(&format!("SELECT feature.geometry,feature.vertices {SPATIAL_SQL} AND feature.kind='coastline' LIMIT ?9"))
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(params![
            bounds.east,
            bounds.west,
            bounds.north,
            bounds.south,
            lod,
            0,
            0,
            zoom,
            (COAST_PIECES + 1) as i64
        ])
        .map_err(|error| error.to_string())?;
    let mut lines = Vec::new();
    let mut vertices = 0_usize;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let count: i64 = row.get(1).map_err(|error| error.to_string())?;
        if lines.len() >= COAST_PIECES || vertices + count as usize > COAST_VERTICES {
            return Ok(Coasts {
                lines,
                complete: false,
            });
        }
        let text: String = row.get(0).map_err(|error| error.to_string())?;
        if let Ok(StoredGeometry::LineString(line)) = serde_json::from_str(&text)
            && line.len() >= 2
        {
            lines.push(line);
        }
        vertices += count as usize;
    }
    Ok(Coasts {
        lines,
        complete: true,
    })
}

fn stored_metadata(connection: &Connection) -> Option<StoredMetadata> {
    let text: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='localBasemap'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str::<StoredMetadata>(&text)
        .ok()
        .filter(|metadata| metadata.schema_version == SCHEMA_VERSION)
}

fn render(connection: &Connection, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let Some(metadata) = stored_metadata(connection) else {
        return Ok(Vec::new());
    };
    let frame = TileFrame {
        x: f64::from(x),
        y: f64::from(y),
        scale: f64::from(1_u32 << z),
    };
    let bounds = frame.bounds(BUFFER);
    let lod = if z < 9 {
        0
    } else if z < 13 {
        1
    } else {
        2
    };
    let min = [-BUFFER, -BUFFER];
    let max = [EXTENT + BUFFER, EXTENT + BUFFER];
    let mut layer = LayerWriter::new();

    let project_lines = |lines: &[Vec<Point>]| -> Vec<Vec<[i32; 2]>> {
        lines
            .iter()
            .flat_map(|line| {
                let projected: Vec<Point> =
                    line.iter().map(|point| frame.project(*point)).collect();
                clip_polyline(&projected, min, max)
            })
            .map(quantize)
            .collect()
    };
    let project_polygon = |rings: &[Vec<Point>]| -> Vec<Vec<[i32; 2]>> {
        rings
            .iter()
            .map(|ring| {
                let projected: Vec<Point> =
                    ring.iter().map(|point| frame.project(*point)).collect();
                quantize(clip_ring(&projected, min, max))
            })
            .collect()
    };

    // Ocean first: it underlies every other water and road feature.
    if metadata.counts.coastline > 0
        && let Some(stored) = metadata.bounds.as_ref()
    {
        {
            let extract = Bounds {
                west: stored.west,
                south: stored.south,
                east: stored.east,
                north: stored.north,
            };
            if let Some(ocean_bounds) = bounds.intersect(extract) {
                let coasts = read_coasts(connection, ocean_bounds, lod, z)?;
                let corner = [ocean_bounds.west + 1e-8, ocean_bounds.south + 1e-8];
                let mut reference = None;
                let mut radius = 0.02;
                while radius <= 32.0 && reference.is_none() {
                    let nearby = read_coasts(
                        connection,
                        Bounds {
                            west: corner[0] - radius,
                            east: corner[0] + radius,
                            south: corner[1] - radius,
                            north: corner[1] + radius,
                        },
                        lod,
                        z,
                    )?;
                    if !nearby.complete {
                        break;
                    }
                    reference = nearest_coast_side(&nearby.lines, corner);
                    radius *= 4.0;
                }
                let ocean = ocean_polygons(&coasts.lines, ocean_bounds, reference, coasts.complete);
                for polygon in &ocean.polygons {
                    if !layer.push_polygon("ocean", project_polygon(polygon)) {
                        return Ok(layer.finish());
                    }
                }
                if !layer.push_lines("coastline", None, project_lines(&ocean.outlines)) {
                    return Ok(layer.finish());
                }
            }
        }
    }

    for roads in [false, true] {
        let (kinds, min_rank, max_rank) = if roads {
            ("'road'", 3, 7)
        } else {
            ("'water','river'", 1, 2)
        };
        let mut statement = connection
            .prepare_cached(&format!(
                "SELECT feature.kind,feature.road_class,feature.geometry {SPATIAL_SQL} AND feature.kind IN ({kinds}) \
                 ORDER BY feature.rank,feature.area DESC,feature.id LIMIT ?9"
            ))
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query(params![
                bounds.east,
                bounds.west,
                bounds.north,
                bounds.south,
                lod,
                max_rank,
                min_rank,
                z,
                (MAX_FEATURES + 1) as i64
            ])
            .map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let kind: String = row.get(0).map_err(|error| error.to_string())?;
            let road_class: Option<String> = row.get(1).map_err(|error| error.to_string())?;
            let text: String = row.get(2).map_err(|error| error.to_string())?;
            let accepted = match serde_json::from_str::<StoredGeometry>(&text) {
                Ok(StoredGeometry::LineString(line)) => {
                    layer.push_lines(&kind, road_class.as_deref(), project_lines(&[line]))
                }
                Ok(StoredGeometry::Polygon(rings)) => {
                    layer.push_polygon(&kind, project_polygon(&rings))
                }
                Err(_) => true,
            };
            if !accepted {
                return Ok(layer.finish());
            }
        }
    }
    Ok(layer.finish())
}

/// Encode tile `z/x/y` of the offline basemap stored in a City's street index.
/// An empty vector means the tile has no features or the index predates the
/// local basemap schema.
pub fn local_basemap_tile(path: &str, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    if z > 22 || x >= (1_u32 << z) || y >= (1_u32 << z) {
        return Err(format!(
            "Tile {z}/{x}/{y} is outside the Web Mercator pyramid."
        ));
    }
    let (connection, generation) = checkout(path)?;
    let result = render(&connection, z, x, y);
    checkin(path, generation, connection);
    result
}

#[cfg(feature = "node")]
pub(crate) mod node {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    pub struct LocalBasemapTileTask {
        path: String,
        z: u32,
        x: u32,
        y: u32,
    }

    #[napi]
    impl Task for LocalBasemapTileTask {
        type Output = Vec<u8>;
        type JsValue = Buffer;

        fn compute(&mut self) -> Result<Self::Output> {
            super::local_basemap_tile(&self.path, self.z, self.x, self.y)
                .map_err(|reason| Error::new(Status::GenericFailure, reason))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(output.into())
        }
    }

    #[napi]
    pub fn dispose_local_basemap_store(store_path: String) {
        super::dispose_local_basemap_store(&store_path);
    }

    /// Render one offline basemap tile on the libuv pool.
    #[napi]
    pub fn local_basemap_tile(
        store_path: String,
        z: u32,
        x: u32,
        y: u32,
    ) -> AsyncTask<LocalBasemapTileTask> {
        AsyncTask::new(LocalBasemapTileTask {
            path: store_path,
            z,
            x,
            y,
        })
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

    /// Decode the kinds carried by a one-layer tile.
    fn tile_kinds(tile: &[u8]) -> Vec<String> {
        fn fields(bytes: &[u8]) -> Vec<(u64, Vec<u8>)> {
            let mut offset = 0;
            let mut result = Vec::new();
            while offset < bytes.len() {
                let key = decode_varint(bytes, &mut offset);
                if key & 7 == 2 {
                    let length = decode_varint(bytes, &mut offset) as usize;
                    result.push((key >> 3, bytes[offset..offset + length].to_vec()));
                    offset += length;
                } else {
                    let value = decode_varint(bytes, &mut offset);
                    result.push((key >> 3, value.to_le_bytes().to_vec()));
                }
            }
            result
        }
        let mut kinds = Vec::new();
        for (field, layer) in fields(tile) {
            assert_eq!(field, 3);
            let layer_fields = fields(&layer);
            let values: Vec<String> = layer_fields
                .iter()
                .filter(|(field, _)| *field == 4)
                .map(|(_, value)| String::from_utf8(fields(value)[0].1.clone()).unwrap())
                .collect();
            for (_, feature) in layer_fields.iter().filter(|(field, _)| *field == 2) {
                let tags = &fields(feature)
                    .into_iter()
                    .find(|(field, _)| *field == 2)
                    .unwrap()
                    .1;
                let mut offset = 0;
                let _key = decode_varint(tags, &mut offset);
                kinds.push(values[decode_varint(tags, &mut offset) as usize].clone());
            }
        }
        kinds
    }

    #[test]
    fn street_index_renders_ocean_water_and_roads() {
        let path =
            std::env::temp_dir().join(format!("vigo-basemap-tiles-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
                 CREATE TABLE map_features(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, road_class TEXT, rank INTEGER NOT NULL,
                   min_zoom INTEGER NOT NULL, area REAL NOT NULL, vertices INTEGER NOT NULL, geometry TEXT NOT NULL);
                 CREATE VIRTUAL TABLE map_features_rtree USING rtree(id,west,east,south,north,min_lod,max_lod,min_rank,max_rank,min_zoom,max_zoom);",
            )
            .unwrap();
        let features = [
            // A northbound coast: land to the west, sea to the east.
            (
                "coastline",
                None,
                0,
                r#"{"type":"LineString","coordinates":[[0.0,-0.05],[0.0,0.05]]}"#,
                [0.0, 0.0, -0.05, 0.05],
            ),
            (
                "water",
                None,
                1,
                r#"{"type":"Polygon","coordinates":[[[-0.012,-0.004],[-0.004,-0.004],[-0.004,0.004],[-0.012,0.004],[-0.012,-0.004]]]}"#,
                [-0.012, -0.004, -0.004, 0.004],
            ),
            (
                "road",
                Some("primary"),
                5,
                r#"{"type":"LineString","coordinates":[[-0.015,0.006],[-0.001,0.006]]}"#,
                [-0.015, -0.001, 0.006, 0.006],
            ),
        ];
        for (index, (kind, road_class, rank, geometry, [west, east, south, north])) in
            features.into_iter().enumerate()
        {
            connection
                .execute(
                    "INSERT INTO map_features VALUES(?1,?2,?3,?4,0,0,2,?5)",
                    params![index as i64 + 1, kind, road_class, rank, geometry],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO map_features_rtree VALUES(?1,?2,?3,?4,?5,0,2,?6,?6,0,22)",
                    params![index as i64 + 1, west, east, south, north, rank],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO metadata VALUES('localBasemap',?1)",
                params![r#"{"schemaVersion":"vigo.local-basemap.v1","counts":{"coastline":1},"bounds":{"west":-0.05,"east":0.05,"south":-0.05,"north":0.05}}"#],
            )
            .unwrap();
        drop(connection);
        let store = path.to_str().unwrap();
        // z14 tiles meet at (0, 0): the north-east tile is open sea, the
        // north-west tile holds the lake, the road and the shore.
        let sea = tile_kinds(&local_basemap_tile(store, 14, 8192, 8191).unwrap());
        assert!(sea.contains(&"ocean".to_string()), "{sea:?}");
        let land = tile_kinds(&local_basemap_tile(store, 14, 8191, 8191).unwrap());
        for kind in ["water", "road", "coastline"] {
            assert!(
                land.contains(&kind.to_string()),
                "{kind} missing from {land:?}"
            );
        }
        // The tile one further west never reaches the coast, even with its buffer.
        let inland = tile_kinds(&local_basemap_tile(store, 14, 8190, 8191).unwrap());
        assert!(!inland.contains(&"ocean".to_string()), "{inland:?}");
        assert!(local_basemap_tile(store, 3, 9, 0).is_err());
        let (retired, old_generation) = checkout(store).unwrap();
        dispose_local_basemap_store(store);
        let (current, generation) = checkout(store).unwrap();
        checkin(store, old_generation, retired);
        assert!(STORE_POOLS.lock().unwrap()[store].connections.is_empty());
        checkin(store, generation, current);
        assert_eq!(STORE_POOLS.lock().unwrap()[store].connections.len(), 1);
        dispose_local_basemap_store(store);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn tile_frame_projects_corners_to_extent() {
        let frame = TileFrame {
            x: 1205.0,
            y: 1539.0,
            scale: 4096.0,
        };
        let bounds = frame.bounds(0.0);
        let north_west = frame.project([bounds.west, bounds.north]);
        let south_east = frame.project([bounds.east, bounds.south]);
        assert!(north_west[0].abs() < 1e-6 && north_west[1].abs() < 1e-6);
        assert!((south_east[0] - EXTENT).abs() < 1e-6 && (south_east[1] - EXTENT).abs() < 1e-6);
    }

    #[test]
    fn lines_split_where_they_leave_the_box() {
        let parts = clip_polyline(
            &[
                [-10.0, 5.0],
                [5.0, 5.0],
                [5.0, 20.0],
                [8.0, 20.0],
                [8.0, 6.0],
            ],
            [0.0, 0.0],
            [10.0, 10.0],
        );
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], vec![[0.0, 5.0], [5.0, 5.0], [5.0, 10.0]]);
        assert_eq!(parts[1], vec![[8.0, 10.0], [8.0, 6.0]]);
    }

    #[test]
    fn rings_are_clipped_to_the_box() {
        let ring = clip_ring(
            &[
                [-5.0, -5.0],
                [5.0, -5.0],
                [5.0, 5.0],
                [-5.0, 5.0],
                [-5.0, -5.0],
            ],
            [0.0, 0.0],
            [10.0, 10.0],
        );
        let quantized = quantize(ring);
        assert_eq!(ring_area(&quantized).abs(), 25.0);
    }

    #[test]
    fn polygons_follow_mvt_winding_and_commands() {
        let mut layer = LayerWriter::new();
        // Counter-clockwise in tile space: the writer must reverse it.
        assert!(layer.push_polygon(
            "water",
            vec![vec![[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]
        ));
        let tile = layer.finish();
        assert!(!tile.is_empty());
        // Tile -> layer (field 3) -> ... feature geometry starts with MoveTo(1).
        let mut offset = 0;
        assert_eq!(decode_varint(&tile, &mut offset), (3 << 3) | 2);
        let _layer_length = decode_varint(&tile, &mut offset);
        assert_eq!(decode_varint(&tile, &mut offset), 15 << 3);
        assert_eq!(decode_varint(&tile, &mut offset), 2);
    }

    #[test]
    fn coast_with_sea_on_the_right_closes_clockwise_along_the_boundary() {
        // A coast running north through the middle: land west (left), sea east.
        let bounds = Bounds {
            west: 0.0,
            south: 0.0,
            east: 10.0,
            north: 10.0,
        };
        let ocean = ocean_polygons(&[vec![[5.0, -1.0], [5.0, 11.0]]], bounds, None, true);
        assert_eq!(ocean.polygons.len(), 1);
        let ring = &ocean.polygons[0][0];
        assert!(ring.iter().all(|point| point[0] >= 5.0 - 1e-9));
        assert!((signed_area(ring).abs() - 50.0).abs() < 1e-6);
    }

    #[test]
    fn tiles_without_coasts_are_ocean_only_when_the_corner_is_seaward() {
        let bounds = Bounds {
            west: 0.0,
            south: 0.0,
            east: 1.0,
            north: 1.0,
        };
        assert_eq!(
            ocean_polygons(&[], bounds, Some(-1.0), true).polygons.len(),
            1
        );
        assert!(
            ocean_polygons(&[], bounds, Some(1.0), true)
                .polygons
                .is_empty()
        );
        assert!(ocean_polygons(&[], bounds, None, true).polygons.is_empty());
    }

    #[test]
    fn incomplete_shores_never_invent_closures() {
        let bounds = Bounds {
            west: 0.0,
            south: 0.0,
            east: 10.0,
            north: 10.0,
        };
        // Ends inside the box: polygonizing would cut across land.
        let ocean = ocean_polygons(&[vec![[5.0, -1.0], [5.0, 4.0]]], bounds, Some(-1.0), true);
        assert!(ocean.polygons.is_empty());
        assert_eq!(ocean.outlines.len(), 1);
    }
}
