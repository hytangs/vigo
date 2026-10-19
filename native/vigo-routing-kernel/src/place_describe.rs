//! Short place names for any point in a City: "Washington St & Massachusetts
//! Ave" at a corner, "Boylston St near Arlington St" along a street, "Boston
//! Public Garden" inside a park, or "Near Park Street" by a stop.
//!
//! The OSM importer stores named streets and areas in the optional
//! `place_streets` and `place_areas` tables of the street index; stops come
//! from the routing store. Each loads once per City into flat arrays with a
//! uniform grid, and corners (vertices shared by differently named streets)
//! are found at load, so a lookup is a few grid probes.

use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

const STREETS: &str = "place_streets";
const AREAS: &str = "place_areas";
const CELL_M: f64 = 120.0;
const CORNER_M: f64 = 35.0;
const STREET_M: f64 = 50.0;
const CROSS_STREET_M: f64 = 250.0;
const STOP_M: f64 = 200.0;
const NEAR_M: f64 = 400.0;
const POOLED_INDEXES: usize = 4;
const METERS_PER_DEGREE_LAT: f64 = 110_574.0;
const METERS_PER_DEGREE_LON: f64 = 111_320.0;

#[derive(Debug, Clone, PartialEq)]
pub struct PlaceDescription {
    pub label: String,
    /// `intersection`, `street`, `area`, `stop` or `near-street`.
    pub kind: &'static str,
}

/// Item ids by cell, built in two counting passes.
#[derive(Default)]
struct Grid {
    west: f64,
    south: f64,
    cell_lon: f64,
    cell_lat: f64,
    cols: usize,
    rows: usize,
    offsets: Vec<u32>,
    items: Vec<u32>,
}

impl Grid {
    fn build(boxes: &[[f64; 4]]) -> Grid {
        let mut bounds = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for bbox in boxes {
            bounds = [
                bounds[0].min(bbox[0]),
                bounds[1].min(bbox[1]),
                bounds[2].max(bbox[2]),
                bounds[3].max(bbox[3]),
            ];
        }
        let [west, south, east, north] = bounds;
        if boxes.is_empty() || !(east >= west && north >= south) {
            return Grid::default();
        }
        let cos = ((south + north) / 2.0).to_radians().cos().max(0.05);
        let (mut cell_lon, mut cell_lat) = (
            CELL_M / (METERS_PER_DEGREE_LON * cos),
            CELL_M / METERS_PER_DEGREE_LAT,
        );
        // Bound empty grid cells for sparse or widely separated source areas.
        let scale = (((east - west) / cell_lon + 1.) * ((north - south) / cell_lat + 1.)
            / 262_144.)
            .sqrt()
            .max(1.);
        cell_lon *= scale;
        cell_lat *= scale;
        let cols = (((east - west) / cell_lon).floor() as usize + 1).clamp(1, 4096);
        let rows = (((north - south) / cell_lat).floor() as usize + 1).clamp(1, 4096);
        let mut grid = Grid {
            west,
            south,
            cell_lon,
            cell_lat,
            cols,
            rows,
            offsets: vec![0; cols * rows + 1],
            items: Vec::new(),
        };
        for pass in 0..2 {
            let mut cursor = grid.offsets.clone();
            if pass == 1 {
                grid.items = vec![0; grid.offsets[cols * rows] as usize];
            }
            for (item, bbox) in boxes.iter().enumerate() {
                let (c0, r0) = grid.cell(bbox[0], bbox[1]);
                let (c1, r1) = grid.cell(bbox[2], bbox[3]);
                for row in r0..=r1 {
                    for col in c0..=c1 {
                        let cell = row * cols + col;
                        if pass == 0 {
                            grid.offsets[cell + 1] += 1;
                        } else {
                            grid.items[cursor[cell] as usize] = item as u32;
                            cursor[cell] += 1;
                        }
                    }
                }
            }
            if pass == 0 {
                for cell in 0..cols * rows {
                    grid.offsets[cell + 1] += grid.offsets[cell];
                }
            }
        }
        grid
    }

    fn cell(&self, lon: f64, lat: f64) -> (usize, usize) {
        let col = ((lon - self.west) / self.cell_lon)
            .floor()
            .clamp(0.0, (self.cols - 1) as f64);
        let row = ((lat - self.south) / self.cell_lat)
            .floor()
            .clamp(0.0, (self.rows - 1) as f64);
        (col as usize, row as usize)
    }

    fn visit(
        &self,
        lon: f64,
        lat: f64,
        radius_lon: f64,
        radius_lat: f64,
        mut visit: impl FnMut(usize),
    ) {
        if self.offsets.is_empty() {
            return;
        }
        let (c0, r0) = self.cell(lon - radius_lon, lat - radius_lat);
        let (c1, r1) = self.cell(lon + radius_lon, lat + radius_lat);
        for row in r0..=r1 {
            for col in c0..=c1 {
                let cell = row * self.cols + col;
                for &item in
                    &self.items[self.offsets[cell] as usize..self.offsets[cell + 1] as usize]
                {
                    visit(item as usize);
                }
            }
        }
    }
}

struct Area {
    name: String,
    ring: Vec<[f64; 2]>,
    bbox: [f64; 4],
    size: f64,
}

#[derive(Default)]
pub struct PlaceIndex {
    names: Vec<String>,
    /// Most important road rank each name carries: motorway 1 … residential 6.
    name_rank: Vec<u8>,
    segments: Vec<[f32; 4]>,
    segment_name: Vec<u32>,
    segment_grid: Grid,
    corners: Vec<[f64; 2]>,
    corner_offsets: Vec<u32>,
    corner_names: Vec<u32>,
    corner_grid: Grid,
    areas: Vec<Area>,
    area_grid: Grid,
    stops: Vec<([f64; 2], String)>,
    stop_grid: Grid,
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*offset)?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

/// Polyline as zigzag varint deltas of microdegree longitude/latitude pairs.
pub fn decode_polyline(bytes: &[u8]) -> Option<Vec<[i32; 2]>> {
    let mut offset = 0;
    let mut point = [0_i64; 2];
    let mut points = Vec::new();
    while offset < bytes.len() {
        for axis in &mut point {
            let raw = read_varint(bytes, &mut offset)?;
            *axis = axis.checked_add(((raw >> 1) as i64) ^ -((raw & 1) as i64))?;
        }
        if point[0].unsigned_abs() > 180_000_000 || point[1].unsigned_abs() > 90_000_000 {
            return None;
        }
        points.push([i32::try_from(point[0]).ok()?, i32::try_from(point[1]).ok()?]);
    }
    Some(points)
}

fn degrees(point: [i32; 2]) -> [f64; 2] {
    [f64::from(point[0]) * 1e-6, f64::from(point[1]) * 1e-6]
}

fn open(path: &str) -> Result<Option<Connection>, String> {
    if path.is_empty() {
        return Ok(None);
    }
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map(Some)
    .map_err(|error| format!("City data could not be opened for place names: {error}"))
}

fn has_table(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |_| Ok(()),
        )
        .is_ok()
}

/// Every row of a query, or none when its table is absent.
fn rows<T>(
    connection: &Connection,
    table: &str,
    sql: &str,
    mut row: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    if !has_table(connection, table) {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let mapped = statement
        .query_map([], |r| row(r))
        .map_err(|error| error.to_string())?;
    mapped
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())
}

impl PlaceIndex {
    pub fn load(street_path: &str, routing_path: &str) -> Result<PlaceIndex, String> {
        let mut index = PlaceIndex::default();
        if let Some(connection) = open(street_path)? {
            let streets = rows(
                &connection,
                STREETS,
                "SELECT name, road_class, geometry FROM place_streets",
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )?;
            index.add_streets(streets);
            let areas = rows(
                &connection,
                AREAS,
                "SELECT name, geometry FROM place_areas",
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )?;
            index.add_areas(areas);
        }
        if let Some(connection) = open(routing_path)? {
            // A platform reads as its station: "Park Street", not one platform of it.
            let stops = rows(
                &connection,
                "stops",
                "SELECT COALESCE(NULLIF(p.name, ''), s.name), s.lon, s.lat FROM stops s \
                 LEFT JOIN stops p ON p.stop_id = s.parent_station \
                 WHERE s.lon IS NOT NULL AND s.lat IS NOT NULL AND COALESCE(s.location_type, 0) IN (0, 1)",
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                    ))
                },
            )?;
            for (name, lon, lat) in stops {
                if lon.is_finite() && lat.is_finite() && !name.trim().is_empty() {
                    index.stops.push(([lon, lat], name.trim().to_string()));
                }
            }
            let boxes: Vec<_> = index
                .stops
                .iter()
                .map(|([lon, lat], _)| [*lon, *lat, *lon, *lat])
                .collect();
            index.stop_grid = Grid::build(&boxes);
        }
        Ok(index)
    }

    fn add_streets(&mut self, streets: Vec<(String, i64, Vec<u8>)>) {
        let mut name_ids = HashMap::<String, u32>::new();
        // Vertex → names that meet there.
        let mut vertices = HashMap::<[i32; 2], Vec<u32>>::new();
        let mut boxes = Vec::new();
        for (name, rank, geometry) in streets {
            let name = name.trim();
            let Some(points) =
                decode_polyline(&geometry).filter(|points| points.len() >= 2 && !name.is_empty())
            else {
                continue;
            };
            let id = *name_ids.entry(name.to_string()).or_insert_with(|| {
                self.names.push(name.to_string());
                self.name_rank.push(u8::MAX);
                (self.names.len() - 1) as u32
            });
            self.name_rank[id as usize] = self.name_rank[id as usize].min(rank.clamp(0, 254) as u8);
            for point in &points {
                let names = vertices.entry(*point).or_default();
                if !names.contains(&id) {
                    names.push(id);
                }
            }
            for pair in points.windows(2) {
                let (a, b) = (degrees(pair[0]), degrees(pair[1]));
                boxes.push([
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[0].max(b[0]),
                    a[1].max(b[1]),
                ]);
                self.segments
                    .push([a[0] as f32, a[1] as f32, b[0] as f32, b[1] as f32]);
                self.segment_name.push(id);
            }
        }
        self.segment_grid = Grid::build(&boxes);
        let mut corners: Vec<_> = vertices
            .into_iter()
            .filter(|(_, names)| names.len() >= 2)
            .collect();
        corners.sort_unstable_by_key(|(point, _)| *point);
        self.corner_offsets.push(0);
        for (point, mut names) in corners {
            // The more important street first: "Massachusetts Ave & Tremont St".
            names.sort_by_key(|&name| (self.name_rank[name as usize], name));
            self.corners.push(degrees(point));
            self.corner_names.extend(names);
            self.corner_offsets.push(self.corner_names.len() as u32);
        }
        let boxes: Vec<_> = self
            .corners
            .iter()
            .map(|[lon, lat]| [*lon, *lat, *lon, *lat])
            .collect();
        self.corner_grid = Grid::build(&boxes);
    }

    fn add_areas(&mut self, areas: Vec<(String, Vec<u8>)>) {
        for (name, geometry) in areas {
            let Some(points) = decode_polyline(&geometry).filter(|points| points.len() >= 4) else {
                continue;
            };
            let ring: Vec<[f64; 2]> = points.into_iter().map(degrees).collect();
            let mut bbox = [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ];
            for [lon, lat] in &ring {
                bbox = [
                    bbox[0].min(*lon),
                    bbox[1].min(*lat),
                    bbox[2].max(*lon),
                    bbox[3].max(*lat),
                ];
            }
            let size = ring
                .windows(2)
                .map(|p| p[0][0] * p[1][1] - p[1][0] * p[0][1])
                .sum::<f64>()
                .abs();
            if !name.trim().is_empty() {
                self.areas.push(Area {
                    name: name.trim().to_string(),
                    ring,
                    bbox,
                    size,
                });
            }
        }
        let boxes: Vec<_> = self.areas.iter().map(|area| area.bbox).collect();
        self.area_grid = Grid::build(&boxes);
    }

    pub fn describe(&self, lon: f64, lat: f64) -> Option<PlaceDescription> {
        if !lon.is_finite() || !lat.is_finite() || lat.abs() > 89.0 {
            return None;
        }
        let kx = METERS_PER_DEGREE_LON * lat.to_radians().cos().max(0.05);
        let ky = METERS_PER_DEGREE_LAT;
        let nearest = |grid: &Grid, limit_m: f64, distance: &dyn Fn(usize) -> f64| {
            let mut best: Option<(f64, usize)> = None;
            grid.visit(lon, lat, limit_m / kx, limit_m / ky, |item| {
                let d = distance(item);
                if d <= limit_m && best.is_none_or(|(current, _)| d < current) {
                    best = Some((d, item));
                }
            });
            best.map(|(_, item)| item)
        };
        let to_point = |[x, y]: [f64; 2]| ((x - lon) * kx).hypot((y - lat) * ky);
        // A more important street wins by a few meters: motorway 1 … residential 6.
        let to_street = |item: usize| {
            let [ax, ay, bx, by] = self.segments[item].map(f64::from);
            let rank = self.name_rank[self.segment_name[item] as usize];
            segment_distance(
                [(ax - lon) * kx, (ay - lat) * ky],
                [(bx - lon) * kx, (by - lat) * ky],
            ) + f64::from(rank)
        };
        let label = |names: &[u32], joiner: &str| {
            names
                .iter()
                .map(|&name| short_street_name(&self.names[name as usize]))
                .collect::<Vec<_>>()
                .join(joiner)
        };

        // 1. At a corner of two named streets.
        if let Some(corner) = nearest(&self.corner_grid, CORNER_M, &|item| {
            to_point(self.corners[item])
        }) {
            return Some(PlaceDescription {
                label: label(&self.names_at(corner)[..2], " & "),
                kind: "intersection",
            });
        }
        // 2. On a street, placed by its nearest cross street.
        if let Some(segment) = nearest(&self.segment_grid, STREET_M, &to_street) {
            let street = self.segment_name[segment];
            let cross = nearest(&self.corner_grid, CROSS_STREET_M, &|item| {
                if self.names_at(item).contains(&street) {
                    to_point(self.corners[item])
                } else {
                    f64::INFINITY
                }
            });
            let mut names = vec![street];
            names.extend(cross.and_then(|item| {
                self.names_at(item)
                    .iter()
                    .copied()
                    .find(|&name| name != street)
            }));
            return Some(PlaceDescription {
                label: label(&names, " near "),
                kind: "street",
            });
        }
        // 3. Inside a named park, campus or landmark.
        if let Some(area) = self.containing_area(lon, lat) {
            return Some(PlaceDescription {
                label: area.name.clone(),
                kind: "area",
            });
        }
        // 4. By a stop or station.
        if let Some(stop) = nearest(&self.stop_grid, STOP_M, &|item| {
            to_point(self.stops[item].0)
        }) {
            return Some(PlaceDescription {
                label: format!("Near {}", self.stops[stop].1),
                kind: "stop",
            });
        }
        // 5. Off the street network, near a street.
        let segment = nearest(&self.segment_grid, NEAR_M, &to_street)?;
        Some(PlaceDescription {
            label: format!("Near {}", label(&[self.segment_name[segment]], "")),
            kind: "near-street",
        })
    }

    fn names_at(&self, corner: usize) -> &[u32] {
        &self.corner_names
            [self.corner_offsets[corner] as usize..self.corner_offsets[corner + 1] as usize]
    }

    /// The smallest named area containing the point, by even-odd crossings.
    fn containing_area(&self, lon: f64, lat: f64) -> Option<&Area> {
        let mut best: Option<&Area> = None;
        self.area_grid.visit(lon, lat, 0.0, 0.0, |item| {
            let area = &self.areas[item];
            let [west, south, east, north] = area.bbox;
            if lon < west
                || lon > east
                || lat < south
                || lat > north
                || best.is_some_and(|b| b.size <= area.size)
            {
                return;
            }
            let inside = area.ring.windows(2).fold(false, |inside, pair| {
                let ([x1, y1], [x2, y2]) = (pair[0], pair[1]);
                inside ^ ((y1 > lat) != (y2 > lat) && lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1))
            });
            if inside {
                best = Some(area);
            }
        });
        best
    }
}

/// Distance from the origin to segment a–b, in local meters.
fn segment_distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length = dx * dx + dy * dy;
    let t = if length > 0.0 {
        (-(a[0] * dx + a[1] * dy) / length).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (a[0] + t * dx).hypot(a[1] + t * dy)
}

const SUFFIXES: [(&str, &str); 14] = [
    ("Street", "St"),
    ("Avenue", "Ave"),
    ("Road", "Rd"),
    ("Boulevard", "Blvd"),
    ("Drive", "Dr"),
    ("Lane", "Ln"),
    ("Place", "Pl"),
    ("Square", "Sq"),
    ("Parkway", "Pkwy"),
    ("Highway", "Hwy"),
    ("Court", "Ct"),
    ("Terrace", "Ter"),
    ("Turnpike", "Tpke"),
    ("Circle", "Cir"),
];

/// Shorten a trailing English street type: "Massachusetts Avenue" → "Massachusetts Ave".
/// Only the last word changes, so other languages and leading types
/// ("Avenue des Champs-Élysées") stay as written.
pub fn short_street_name(name: &str) -> String {
    match name.rsplit_once(' ') {
        Some((rest, last)) => match SUFFIXES.iter().find(|(long, _)| *long == last) {
            Some((_, short)) => format!("{rest} {short}"),
            None => name.to_string(),
        },
        None => name.to_string(),
    }
}

type Identity = Option<(SystemTime, u64)>;

struct Pooled {
    identity: ((Identity, Identity), (Identity, Identity)),
    index: Arc<PlaceIndex>,
    used: u64,
}

static INDEXES: LazyLock<Mutex<(HashMap<String, Pooled>, u64)>> = LazyLock::new(Default::default);

fn identity(path: &str) -> Identity {
    let metadata = std::fs::metadata(path).ok()?;
    Some((
        metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        metadata.len(),
    ))
}

fn store_identity(path: &str) -> (Identity, Identity) {
    // Optional name-table upgrades may commit to WAL without changing the main
    // file. Include the WAL so a warm City cannot retain its stop-only fallback.
    (identity(path), identity(&format!("{path}-wal")))
}

/// The index for a City, built once and rebuilt when either store changes.
pub fn place_index(street_path: &str, routing_path: &str) -> Result<Arc<PlaceIndex>, String> {
    let key = format!("{street_path}\u{0}{routing_path}");
    let identity = (store_identity(street_path), store_identity(routing_path));
    // Held while building so concurrent first requests share one load.
    let mut guard = INDEXES
        .lock()
        .map_err(|_| "Place index pool is unavailable.".to_string())?;
    let (pool, clock) = &mut *guard;
    *clock += 1;
    if let Some(entry) = pool.get_mut(&key)
        && entry.identity == identity
    {
        entry.used = *clock;
        return Ok(entry.index.clone());
    }
    let index = Arc::new(PlaceIndex::load(street_path, routing_path)?);
    pool.insert(
        key,
        Pooled {
            identity,
            index: index.clone(),
            used: *clock,
        },
    );
    if pool.len() > POOLED_INDEXES
        && let Some(oldest) = pool
            .iter()
            .min_by_key(|(_, entry)| entry.used)
            .map(|(key, _)| key.clone())
    {
        pool.remove(&oldest);
    }
    Ok(index)
}

#[cfg(feature = "node")]
pub(crate) mod node {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    #[napi(object)]
    pub struct NativePlaceDescription {
        pub label: String,
        pub kind: String,
    }

    pub struct DescribePlaceTask {
        street_path: String,
        routing_path: String,
        coordinates: Vec<f64>,
    }

    #[napi]
    impl Task for DescribePlaceTask {
        type Output = Vec<Option<super::PlaceDescription>>;
        type JsValue = Vec<Option<NativePlaceDescription>>;

        fn compute(&mut self) -> Result<Self::Output> {
            let index = super::place_index(&self.street_path, &self.routing_path)
                .map_err(|reason| Error::new(Status::GenericFailure, reason))?;
            Ok(self
                .coordinates
                .chunks_exact(2)
                .map(|pair| index.describe(pair[0], pair[1]))
                .collect())
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(output
                .into_iter()
                .map(|place| {
                    place.map(|place| NativePlaceDescription {
                        label: place.label,
                        kind: place.kind.to_string(),
                    })
                })
                .collect())
        }
    }

    /// Describe flat `[lon, lat, …]` pairs on the libuv pool. An empty street
    /// or routing path skips that source; the first call loads the City's index.
    #[napi]
    pub fn describe_places(
        street_path: String,
        routing_path: String,
        coordinates: Vec<f64>,
    ) -> AsyncTask<DescribePlaceTask> {
        AsyncTask::new(DescribePlaceTask {
            street_path,
            routing_path,
            coordinates,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(points: &[[f64; 2]]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut previous = [0_i64; 2];
        for point in points {
            for axis in 0..2 {
                let value = (point[axis] * 1e6).round() as i64;
                let delta = value - previous[axis];
                previous[axis] = value;
                let mut zigzag = ((delta << 1) ^ (delta >> 63)) as u64;
                while zigzag >= 0x80 {
                    bytes.push((zigzag & 0x7f) as u8 | 0x80);
                    zigzag >>= 7;
                }
                bytes.push(zigzag as u8);
            }
        }
        bytes
    }

    /// Two avenues, two streets and a park around (-71.08, 42.35), and two stops.
    fn fixture(dir: &std::path::Path, with_streets: bool) -> (String, String) {
        let streets = dir.join("streets.sqlite");
        let routing = dir.join("routing.sqlite");
        let connection = Connection::open(&streets).unwrap();
        connection
            .execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        if with_streets {
            connection
                .execute_batch(
                    "CREATE TABLE place_streets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, road_class INTEGER NOT NULL, geometry BLOB NOT NULL);
                     CREATE TABLE place_areas(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, geometry BLOB NOT NULL);",
                )
                .unwrap();
            let rows: [(&str, i64, Vec<[f64; 2]>); 5] = [
                (
                    "Massachusetts Avenue",
                    3,
                    vec![[-71.084, 42.350], [-71.080, 42.350], [-71.076, 42.350]],
                ),
                (
                    "Columbus Avenue",
                    4,
                    vec![[-71.084, 42.346], [-71.080, 42.346], [-71.076, 42.346]],
                ),
                (
                    "Tremont Street",
                    4,
                    vec![
                        [-71.080, 42.354],
                        [-71.080, 42.350],
                        [-71.080, 42.346],
                        [-71.080, 42.342],
                    ],
                ),
                (
                    "Shawmut Street",
                    6,
                    vec![[-71.076, 42.354], [-71.076, 42.350]],
                ),
                (
                    "Shawmut Street",
                    6,
                    vec![[-71.076, 42.350], [-71.076, 42.346]],
                ),
            ];
            for (name, rank, points) in rows {
                connection
                    .execute(
                        "INSERT INTO place_streets(name, road_class, geometry) VALUES(?1, ?2, ?3)",
                        rusqlite::params![name, rank, encode(&points)],
                    )
                    .unwrap();
            }
            let park = [
                [-71.0790, 42.3510],
                [-71.0770, 42.3510],
                [-71.0770, 42.3530],
                [-71.0790, 42.3530],
                [-71.0790, 42.3510],
            ];
            connection
                .execute(
                    "INSERT INTO place_areas(name, kind, geometry) VALUES('Titus Sparrow Park', 'leisure:park', ?1)",
                    [encode(&park)],
                )
                .unwrap();
        }
        let connection = Connection::open(&routing).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER);
                 INSERT INTO stops VALUES('station', 'Back Bay', 42.3474, -71.0754, NULL, 1);
                 INSERT INTO stops VALUES('platform', 'Back Bay - Orange Line', 42.3474, -71.0755, 'station', 0);",
            )
            .unwrap();
        (
            streets.to_string_lossy().into_owned(),
            routing.to_string_lossy().into_owned(),
        )
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vigo-place-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn describe(index: &PlaceIndex, lon: f64, lat: f64) -> (&'static str, String) {
        index
            .describe(lon, lat)
            .map(|place| (place.kind, place.label))
            .unwrap_or(("none", String::new()))
    }

    #[test]
    fn decodes_delta_polylines() {
        let points = decode_polyline(&encode(&[[-71.084, 42.35], [-71.08, 42.3501]])).unwrap();
        assert_eq!(
            points,
            vec![[-71_084_000, 42_350_000], [-71_080_000, 42_350_100]]
        );
        assert!(decode_polyline(&[0x80]).is_none());
        assert!(decode_polyline(&[0xff; 20]).is_none());
        assert!(
            decode_polyline(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 0])
                .is_none()
        );
        assert!(decode_polyline(&encode(&[[181., 0.]])).is_none());
    }

    #[test]
    fn names_corners_streets_areas_and_stops() {
        let dir = temp_dir("streets");
        let (streets, routing) = fixture(&dir, true);
        let index = PlaceIndex::load(&streets, &routing).unwrap();
        let cases = [
            // At Tremont × Massachusetts: the more important street first.
            (
                (-71.0801, 42.3501),
                ("intersection", "Massachusetts Ave & Tremont St"),
            ),
            // Along Columbus between Tremont and Shawmut, placed by the nearer cross street.
            (
                (-71.0786, 42.3461),
                ("street", "Columbus Ave near Tremont St"),
            ),
            // Two Shawmut segments share a vertex but one name: not a corner.
            (
                (-71.0761, 42.3520),
                ("street", "Shawmut St near Massachusetts Ave"),
            ),
            ((-71.0780, 42.3521), ("area", "Titus Sparrow Park")),
            // Off the streets by a station: the station, not its platform.
            ((-71.0735, 42.3478), ("stop", "Near Back Bay")),
            ((-71.0820, 42.3480), ("near-street", "Near Tremont St")),
            ((-71.0600, 42.3700), ("none", "")),
        ];
        for ((lon, lat), (kind, label)) in cases {
            assert_eq!(
                describe(&index, lon, lat),
                (kind, label.to_string()),
                "at {lon}, {lat}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_points_from_stops_without_streets() {
        let dir = temp_dir("stops");
        let (streets, routing) = fixture(&dir, false);
        let index = PlaceIndex::load(&streets, &routing).unwrap();
        assert_eq!(
            describe(&index, -71.0757, 42.3478),
            ("stop", "Near Back Bay".to_string())
        );
        assert_eq!(describe(&index, -71.06, 42.37).0, "none");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shortens_trailing_english_street_types_only() {
        assert_eq!(
            short_street_name("Massachusetts Avenue"),
            "Massachusetts Ave"
        );
        assert_eq!(
            short_street_name("Avenue des Champs-Élysées"),
            "Avenue des Champs-Élysées"
        );
        assert_eq!(short_street_name("Broadway"), "Broadway");
    }
}
