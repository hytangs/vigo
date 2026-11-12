//! Local basemap features (local-basemap-store.mjs, local-basemap-geometry.mjs):
//! main roads, water and coastline, simplified per level of detail.

use crate::jsrt::{self, to_fixed};
use crate::pbf::{Block, Bounds, Relation, Way};
use crate::store::NodeLookup;
use crate::tags::Tags;
use crate::{Error, Result};
use rusqlite::{Connection, params};
use std::collections::{HashMap, HashSet};
use vigo_format::js::{Js, number};

const SCHEMA_VERSION: &str = "vigo.local-basemap.v1";
const TOLERANCES: [f64; 3] = [0.001, 0.00012, 0.000008];
const MAXIMUM_GEOMETRY_VERTICES: usize = 8_000;
const MAXIMUM_RELATION_VERTICES: usize = 200_000;

type Point = [f64; 2];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Road,
    Coastline,
    Water,
    River,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Road => "road",
            Kind::Coastline => "coastline",
            Kind::Water => "water",
            Kind::River => "river",
        }
    }
}

struct Definition {
    kind: Kind,
    road_class: Option<String>,
    rank: f64,
    min_zoom: f64,
}

fn classify(tags: &Tags) -> Option<Definition> {
    let highway = tags.get("highway").unwrap_or("");
    let road_class = highway.strip_suffix("_link").unwrap_or(highway);
    let road = match road_class {
        "motorway" => Some((0.0, 5.0)),
        "trunk" => Some((1.0, 6.0)),
        "primary" => Some((2.0, 8.0)),
        "secondary" => Some((3.0, 10.0)),
        "tertiary" => Some((4.0, 12.0)),
        _ => None,
    };
    if let Some((rank, zoom)) = road
        && tags.get("area") != Some("yes")
    {
        return Some(Definition {
            kind: Kind::Road,
            road_class: Some(road_class.to_owned()),
            rank: rank + 3.0,
            min_zoom: if highway.ends_with("_link") {
                12.0
            } else {
                zoom
            },
        });
    }
    let natural = tags.get("natural");
    let waterway = tags.get("waterway");
    if natural == Some("coastline") {
        return Some(Definition {
            kind: Kind::Coastline,
            road_class: None,
            rank: 0.0,
            min_zoom: 0.0,
        });
    }
    if natural == Some("water")
        || waterway == Some("riverbank")
        || matches!(tags.get("landuse"), Some("reservoir" | "basin"))
    {
        return Some(Definition {
            kind: Kind::Water,
            road_class: None,
            rank: 1.0,
            min_zoom: 0.0,
        });
    }
    if matches!(waterway, Some("river" | "canal"))
        && tags.get("tunnel") != Some("yes")
        && tags.get("covered") != Some("yes")
    {
        return Some(Definition {
            kind: Kind::River,
            road_class: None,
            rank: 2.0,
            min_zoom: if waterway == Some("river") { 8.0 } else { 12.0 },
        });
    }
    None
}

fn point_key(point: &Point) -> String {
    format!("{},{}", to_fixed(point[0], 8), to_fixed(point[1], 8))
}

fn same_point(left: &Point, right: &Point) -> bool {
    point_key(left) == point_key(right)
}

pub fn signed_area(ring: &[Point]) -> f64 {
    let mut area = 0.0;
    for i in 1..ring.len() {
        area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
    }
    area / 2.0
}

fn contains_point(ring: &[Point], point: &Point) -> bool {
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

fn segment_distance(point: &Point, start: &Point, end: &Point) -> f64 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    // `dx || dy`: zero and NaN are falsy.
    let truthy = |v: f64| v != 0.0 && !v.is_nan();
    let t = if truthy(dx) || truthy(dy) {
        jsrt::max(
            0.0,
            jsrt::min(
                1.0,
                ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy),
            ),
        )
    } else {
        0.0
    };
    let x = point[0] - start[0] - t * dx;
    let y = point[1] - start[1] - t * dy;
    x * x + y * y
}

fn simplify_line(points: &[Point], tolerance: f64) -> Vec<Point> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![0usize, points.len() - 1];
    while let (Some(end), Some(start)) = (stack.pop(), stack.pop()) {
        let mut maximum = tolerance * tolerance;
        let mut selected = None;
        for i in start + 1..end {
            let distance = segment_distance(&points[i], &points[start], &points[end]);
            if distance > maximum {
                maximum = distance;
                selected = Some(i);
            }
        }
        if let Some(selected) = selected {
            keep[selected] = true;
            stack.extend([start, selected, selected, end]);
        }
    }
    let result: Vec<Point> = points
        .iter()
        .zip(&keep)
        .filter(|(_, keep)| **keep)
        .map(|(p, _)| *p)
        .collect();
    if same_point(&points[0], &points[points.len() - 1]) && result.len() < 4 {
        points.to_vec()
    } else {
        result
    }
}

fn join_lines(lines: &[Vec<Point>]) -> Vec<Vec<Point>> {
    let mut endpoints: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, line) in lines.iter().enumerate() {
        for point in [&line[0], &line[line.len() - 1]] {
            endpoints.entry(point_key(point)).or_default().push(i);
        }
    }
    let mut used: HashSet<usize> = HashSet::new();
    let mut result = Vec::new();
    for i in 0..lines.len() {
        if !used.insert(i) {
            continue;
        }
        let mut prefix: Vec<Vec<Point>> = Vec::new();
        let mut suffix: Vec<Vec<Point>> = Vec::new();
        let mut first = lines[i][0];
        let mut last = lines[i][lines[i].len() - 1];
        for prepend in [false, true] {
            while !same_point(&first, &last) {
                let point = if prepend { first } else { last };
                let candidates = endpoints.get(&point_key(&point));
                let Some(found) = candidates
                    .and_then(|list| list.iter().copied().find(|index| !used.contains(index)))
                else {
                    break;
                };
                used.insert(found);
                let mut part = lines[found].clone();
                let end = if prepend {
                    part[part.len() - 1]
                } else {
                    part[0]
                };
                if !same_point(&end, &point) {
                    part.reverse();
                }
                if prepend {
                    first = part[0];
                    prefix.push(part);
                } else {
                    last = part[part.len() - 1];
                    suffix.push(part);
                }
            }
        }
        let mut line: Vec<Point> = Vec::new();
        prefix.reverse();
        for part in prefix
            .iter()
            .chain(std::iter::once(&lines[i]))
            .chain(suffix.iter())
        {
            let skip = usize::from(!line.is_empty());
            line.extend_from_slice(&part[skip..]);
        }
        result.push(line);
    }
    result
}

fn polygon_with_holes(outers: Vec<Vec<Point>>, inners: Vec<Vec<Point>>) -> Vec<Vec<Vec<Point>>> {
    let mut polygons: Vec<Vec<Vec<Point>>> = outers
        .into_iter()
        .map(|mut ring| {
            if signed_area(&ring) < 0.0 {
                ring.reverse();
            }
            vec![ring]
        })
        .collect();
    let areas: Vec<f64> = polygons
        .iter()
        .map(|polygon| signed_area(&polygon[0]).abs())
        .collect();
    for mut inner in inners {
        let mut owner = None;
        let mut smallest = f64::INFINITY;
        for (index, polygon) in polygons.iter().enumerate() {
            if areas[index] >= smallest {
                continue;
            }
            if contains_point(&polygon[0], &inner[0]) {
                owner = Some(index);
                smallest = areas[index];
            }
        }
        if let Some(owner) = owner {
            if signed_area(&inner) > 0.0 {
                inner.reverse();
            }
            polygons[owner].push(inner);
        }
    }
    polygons
}

fn write_ring(out: &mut String, ring: &[Point]) {
    out.push('[');
    for (index, point) in ring.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&number(point[0]));
        out.push(',');
        out.push_str(&number(point[1]));
        out.push(']');
    }
    out.push(']');
}

fn geometry_json(polygon: bool, rings: &[Vec<Point>]) -> String {
    let mut out = String::from(if polygon {
        "{\"type\":\"Polygon\",\"coordinates\":"
    } else {
        "{\"type\":\"LineString\",\"coordinates\":"
    });
    if polygon {
        out.push('[');
        for (index, ring) in rings.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_ring(&mut out, ring);
        }
        out.push(']');
    } else {
        write_ring(&mut out, &rings[0]);
    }
    out.push('}');
    out
}

pub struct BasemapWriter {
    feature_id: f64,
    skipped_relations: f64,
    incomplete_ways: f64,
    counts: [f64; 4],
    extent: [f64; 4],
    source_bounds: Option<Bounds>,
    member_ways: HashSet<i64>,
}

impl BasemapWriter {
    pub fn create(db: &Connection) -> Result<Self> {
        db.execute_batch(
            "CREATE TABLE map_features(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, road_class TEXT,
      rank INTEGER NOT NULL, min_zoom INTEGER NOT NULL, area REAL NOT NULL,
      vertices INTEGER NOT NULL, geometry TEXT NOT NULL);
    CREATE VIRTUAL TABLE map_features_rtree USING rtree(id,west,east,south,north,min_lod,max_lod,min_rank,max_rank,min_zoom,max_zoom);
    CREATE TABLE map_relations(id INTEGER PRIMARY KEY,complete INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE map_members(relation_id INTEGER,way_id INTEGER,role TEXT,PRIMARY KEY(relation_id,way_id,role)) WITHOUT ROWID;
    CREATE INDEX map_members_way ON map_members(way_id);
    CREATE TABLE map_ways(id INTEGER PRIMARY KEY,geometry TEXT NOT NULL);",
        )?;
        Ok(Self {
            feature_id: 0.0,
            skipped_relations: 0.0,
            incomplete_ways: 0.0,
            counts: [0.0; 4],
            extent: [
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
            ],
            source_bounds: None,
            member_ways: HashSet::new(),
        })
    }

    pub fn set_source_bounds(&mut self, bounds: Option<Bounds>) {
        if let Some(bounds) = bounds
            && bounds.west < bounds.east
            && bounds.south < bounds.north
        {
            self.source_bounds = Some(bounds);
        }
    }

    pub fn select_relation(
        &mut self,
        db: &Connection,
        block: &Block,
        relation: &Relation,
        tags: &Tags,
    ) -> Result<()> {
        if tags.get("type") != Some("multipolygon")
            || classify(tags).map(|d| d.kind) != Some(Kind::Water)
        {
            return Ok(());
        }
        db.prepare_cached("INSERT OR IGNORE INTO map_relations(id) VALUES(?)")?
            .execute(params![relation.id as f64])?;
        for i in 0..relation.refs.len() {
            let Some(role) = block.string(relation.roles[i]) else {
                return Err(Error::new(
                    "OSM relation references an invalid role string.",
                ));
            };
            let polygon_role = matches!(role, "" | "outer" | "inner");
            if relation.types[i] != 1 && polygon_role {
                db.prepare_cached("UPDATE map_relations SET complete=0 WHERE id=?")?
                    .execute(params![relation.id as f64])?;
            }
            if relation.types[i] == 1 && polygon_role {
                db.prepare_cached("INSERT OR IGNORE INTO map_members VALUES(?,?,?)")?
                    .execute(params![
                        relation.id as f64,
                        relation.refs[i] as f64,
                        if role == "inner" { "inner" } else { "outer" }
                    ])?;
                self.member_ways.insert(relation.refs[i]);
            }
        }
        Ok(())
    }

    pub fn needs_way(&self, way: &Way, tags: &Tags) -> bool {
        classify(tags).is_some() || self.member_ways.contains(&way.id)
    }

    fn write_geometry(
        &mut self,
        db: &Connection,
        definition: &Definition,
        polygon: bool,
        original: &[Vec<Point>],
    ) -> Result<()> {
        let mut bounds = [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ];
        for ring in original {
            for point in ring {
                bounds[0] = jsrt::min(bounds[0], point[0]);
                bounds[1] = jsrt::max(bounds[1], point[0]);
                bounds[2] = jsrt::min(bounds[2], point[1]);
                bounds[3] = jsrt::max(bounds[3], point[1]);
            }
        }
        if !bounds.iter().all(|v| v.is_finite()) {
            return Ok(());
        }
        let area = if polygon {
            signed_area(&original[0]).abs()
        } else {
            0.0
        };
        let min_zoom = if polygon {
            let by_area = if area > 0.005 {
                0.0
            } else if area > 0.0001 {
                8.0
            } else if area > 0.000005 {
                11.0
            } else {
                14.0
            };
            jsrt::max(definition.min_zoom, by_area)
        } else {
            definition.min_zoom
        };
        let mut previous: Option<(String, f64)> = None;
        for (lod, tolerance) in TOLERANCES.iter().enumerate() {
            if min_zoom > [8.0, 12.0, 22.0][lod] {
                continue;
            }
            let simplify = |tolerance: f64| -> (Vec<Vec<Point>>, usize) {
                let rings: Vec<Vec<Point>> = original
                    .iter()
                    .map(|ring| simplify_line(ring, tolerance))
                    .collect();
                let vertices = rings.iter().map(Vec::len).sum();
                (rings, vertices)
            };
            let (mut rings, mut vertices) = simplify(*tolerance);
            let mut scale = 2.0;
            while vertices > MAXIMUM_GEOMETRY_VERTICES && scale <= 1024.0 {
                (rings, vertices) = simplify(tolerance * scale);
                scale *= 2.0;
            }
            if vertices > MAXIMUM_GEOMETRY_VERTICES {
                continue;
            }
            let encoded = geometry_json(polygon, &rings);
            if let Some((previous_geometry, previous_id)) = &previous
                && *previous_geometry == encoded
            {
                db.prepare_cached("UPDATE map_features_rtree SET max_lod=? WHERE id=?")?
                    .execute(params![lod as f64, *previous_id])?;
                continue;
            }
            self.feature_id += 1.0;
            db.prepare_cached("INSERT INTO map_features VALUES(?,?,?,?,?,?,?,?)")?
                .execute(params![
                    self.feature_id,
                    definition.kind.name(),
                    definition.road_class.as_deref(),
                    definition.rank,
                    min_zoom,
                    area,
                    vertices as f64,
                    encoded
                ])?;
            db.prepare_cached("INSERT INTO map_features_rtree VALUES(?,?,?,?,?,?,?,?,?,?,?)")?
                .execute(params![
                    self.feature_id,
                    bounds[0],
                    bounds[1],
                    bounds[2],
                    bounds[3],
                    lod as f64,
                    lod as f64,
                    definition.rank,
                    definition.rank,
                    min_zoom,
                    22.0
                ])?;
            previous = Some((encoded, self.feature_id));
        }
        let slot = match definition.kind {
            Kind::Road => 0,
            Kind::Water => 1,
            Kind::River => 2,
            Kind::Coastline => 3,
        };
        self.counts[slot] += 1.0;
        self.extent[0] = jsrt::min(self.extent[0], bounds[0]);
        self.extent[1] = jsrt::max(self.extent[1], bounds[1]);
        self.extent[2] = jsrt::min(self.extent[2], bounds[2]);
        self.extent[3] = jsrt::max(self.extent[3], bounds[3]);
        Ok(())
    }

    pub fn add_way(
        &mut self,
        db: &Connection,
        way: &Way,
        tags: &Tags,
        nodes: &dyn NodeLookup,
    ) -> Result<()> {
        let definition = classify(tags);
        let member = self.member_ways.contains(&way.id);
        if definition.is_none() && !member {
            return Ok(());
        }
        if way.refs.len() > MAXIMUM_RELATION_VERTICES {
            self.incomplete_ways += 1.0;
            return Ok(());
        }
        let mut parts: Vec<Vec<Point>> = Vec::new();
        let mut points: Vec<Point> = Vec::new();
        let mut current: Vec<Point> = Vec::new();
        for &id in &way.refs {
            match nodes.get(id) {
                Some((lat, lon)) if lon.is_finite() && lat.is_finite() => {
                    let coordinate = [
                        jsrt::string_to_number(&to_fixed(lon, 6)),
                        jsrt::string_to_number(&to_fixed(lat, 6)),
                    ];
                    current.push(coordinate);
                    points.push(coordinate);
                }
                _ => {
                    if current.len() > 1 {
                        parts.push(std::mem::take(&mut current));
                    }
                    current.clear();
                }
            }
        }
        if current.len() > 1 {
            parts.push(current);
        }
        let complete = points.len() == way.refs.len();
        if !complete {
            self.incomplete_ways += 1.0;
        }
        if member && complete && points.len() <= MAXIMUM_RELATION_VERTICES {
            let mut json = String::new();
            write_ring(&mut json, &points);
            db.prepare_cached("INSERT OR REPLACE INTO map_ways VALUES(?,?)")?
                .execute(params![way.id as f64, json])?;
        }
        let Some(definition) = definition else {
            return Ok(());
        };
        if definition.kind == Kind::Water {
            if !member
                && complete
                && way.refs.len() >= 4
                && way.refs[0] == way.refs[way.refs.len() - 1]
            {
                self.write_geometry(db, &definition, true, &[points])?;
            }
        } else {
            for part in &parts {
                let mut start = 0;
                for i in 1..part.len() {
                    if i == part.len() - 1
                        || i - start >= 127
                        || (part[i][0] - part[start][0]).abs() > 0.05
                        || (part[i][1] - part[start][1]).abs() > 0.05
                    {
                        self.write_geometry(db, &definition, false, &[part[start..=i].to_vec()])?;
                        start = i;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn finish(mut self, db: &Connection) -> Result<Js> {
        let relations: Vec<(i64, i64)> = {
            let mut statement = db.prepare("SELECT id,complete FROM map_relations")?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (id, supported) in relations {
            if supported == 0 {
                self.skipped_relations += 1.0;
                continue;
            }
            let mut outer: Vec<Vec<Point>> = Vec::new();
            let mut inner: Vec<Vec<Point>> = Vec::new();
            let mut vertices = 0usize;
            let mut complete = true;
            {
                let mut members = db.prepare_cached(
                    "SELECT member.role,way.geometry FROM map_members AS member
        LEFT JOIN map_ways AS way ON way.id=member.way_id WHERE member.relation_id=?",
                )?;
                let mut rows = members.query(params![id as f64])?;
                while let Some(row) = rows.next()? {
                    let role: Option<String> = row.get(0)?;
                    let geometry: Option<String> = row.get(1)?;
                    let Some(geometry) = geometry.filter(|g| !g.is_empty()) else {
                        complete = false;
                        break;
                    };
                    let line: Vec<Point> =
                        serde_json::from_str(&geometry).map_err(|e| Error::new(e.to_string()))?;
                    vertices += line.len();
                    if vertices > MAXIMUM_RELATION_VERTICES {
                        complete = false;
                        break;
                    }
                    if role.as_deref() == Some("inner") {
                        inner.push(line)
                    } else {
                        outer.push(line)
                    }
                }
            }
            if !complete {
                self.skipped_relations += 1.0;
                continue;
            }
            let outers = join_lines(&outer);
            let inners = join_lines(&inner);
            let ring_text = |point: &Point| format!("{},{}", number(point[0]), number(point[1]));
            if outers.is_empty()
                || outers.iter().chain(&inners).any(|ring| {
                    ring.len() < 4 || ring_text(&ring[0]) != ring_text(&ring[ring.len() - 1])
                })
            {
                self.skipped_relations += 1.0;
                continue;
            }
            let definition = Definition {
                kind: Kind::Water,
                road_class: None,
                rank: 1.0,
                min_zoom: 0.0,
            };
            for polygon in polygon_with_holes(outers, inners) {
                self.write_geometry(db, &definition, true, &polygon)?;
            }
        }
        db.execute_batch("DROP TABLE map_ways; DROP TABLE map_members; DROP TABLE map_relations;")?;
        let bounds = match self.source_bounds {
            Some(bounds) => bounds.to_js(),
            None if self.extent.iter().all(|v| v.is_finite()) => Js::object()
                .with("west", self.extent[0])
                .with("east", self.extent[1])
                .with("south", self.extent[2])
                .with("north", self.extent[3]),
            None => Js::Null,
        };
        Ok(Js::object()
            .with("schemaVersion", SCHEMA_VERSION)
            .with(
                "counts",
                Js::object()
                    .with("road", self.counts[0])
                    .with("water", self.counts[1])
                    .with("river", self.counts[2])
                    .with("coastline", self.counts[3]),
            )
            .with("rows", self.feature_id)
            .with("skippedRelations", self.skipped_relations)
            .with("incompleteWays", self.incomplete_ways)
            .with("bounds", bounds))
    }
}
