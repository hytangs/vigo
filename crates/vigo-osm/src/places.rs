//! Street and area names for map points ("Washington St & Massachusetts
//! Ave"): the optional `place_streets` and `place_areas` tables of the street
//! index. Geometry is zigzag varint deltas of microdegree longitude/latitude
//! pairs, read by `place_describe.rs` in the routing kernel; 0.5 readers
//! ignore the tables.

use crate::Result;
use crate::jsrt::{round, trim};
use crate::pbf::Way;
use crate::store::NodeLookup;
use crate::tags::Tags;
use rusqlite::{Connection, params};

fn road_rank(highway: &str) -> Option<f64> {
    Some(match highway {
        "motorway" | "motorway_link" => 1.0,
        "trunk" | "trunk_link" => 2.0,
        "primary" | "primary_link" => 3.0,
        "secondary" | "secondary_link" => 4.0,
        "tertiary" | "tertiary_link" => 5.0,
        "unclassified" | "residential" | "living_street" | "road" | "pedestrian" => 6.0,
        _ => return None,
    })
}

const AREA_TAGS: [(&str, &[&str]); 6] = [
    (
        "leisure",
        &[
            "park",
            "garden",
            "nature_reserve",
            "golf_course",
            "stadium",
            "common",
            "recreation_ground",
            "marina",
        ],
    ),
    ("amenity", &["university", "college", "hospital", "school"]),
    ("tourism", &["zoo", "theme_park", "museum", "attraction"]),
    ("aeroway", &["aerodrome"]),
    ("landuse", &["cemetery"]),
    ("place", &["square", "island", "islet"]),
];

fn street_name(tags: &Tags) -> Option<(String, f64)> {
    let rank = road_rank(tags.get("highway").unwrap_or(""))?;
    if tags
        .get("tunnel")
        .is_some_and(|tunnel| !tunnel.is_empty() && tunnel != "no")
    {
        return None;
    }
    let mut name = trim(tags.get("name").unwrap_or(""));
    if name.is_empty() && rank <= 2.0 {
        name = trim(tags.get("ref").unwrap_or(""));
    }
    (!name.is_empty() && name.encode_utf16().count() <= 160).then(|| (name.to_owned(), rank))
}

fn area_kind(way: &Way, tags: &Tags) -> Option<String> {
    if trim(tags.get("name").unwrap_or("")).is_empty()
        || way.refs.len() < 4
        || way.refs[0] != way.refs[way.refs.len() - 1]
    {
        return None;
    }
    for (key, values) in AREA_TAGS {
        let value = tags.get(key).unwrap_or("");
        if values.contains(&value) {
            return Some(format!("{key}:{value}"));
        }
    }
    None
}

/// True when a way's nodes must be resolved for place names.
pub fn way_needs_nodes(way: &Way, tags: &Tags) -> bool {
    street_name(tags).is_some() || area_kind(way, tags).is_some()
}

fn encode_polyline(points: &[(f64, f64)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let (mut previous_lon, mut previous_lat) = (0f64, 0f64);
    for &(lon, lat) in points {
        let x = round(lon * 1e6);
        let y = round(lat * 1e6);
        for delta in [x - previous_lon, y - previous_lat] {
            let mut value = if delta < 0.0 {
                -delta * 2.0 - 1.0
            } else {
                delta * 2.0
            };
            while value >= 128.0 {
                bytes.push(((value % 128.0) as u8) | 0x80);
                value = (value / 128.0).floor();
            }
            bytes.push(value as u8);
        }
        previous_lon = x;
        previous_lat = y;
    }
    bytes
}

pub fn create_tables(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE place_streets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, road_class INTEGER NOT NULL, geometry BLOB NOT NULL);
    CREATE TABLE place_areas(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, geometry BLOB NOT NULL)",
    )?;
    Ok(())
}

/// What a named way contributes: a street with its rank, or a named area.
pub(crate) enum Place {
    Street { name: String, rank: f64 },
    Area { name: String, kind: String },
}

pub(crate) fn classify(way: &Way, tags: &Tags) -> Option<Place> {
    if let Some((name, rank)) = street_name(tags) {
        return Some(Place::Street { name, rank });
    }
    area_kind(way, tags).map(|kind| Place::Area {
        name: trim(tags.get("name").unwrap_or("")).to_owned(),
        kind,
    })
}

/// Insert one place. Missing nodes must not create a fictional straight link
/// or close an incomplete area, so such a way is skipped.
pub(crate) fn write(
    db: &Connection,
    place: &Place,
    refs: &[i64],
    nodes: &dyn NodeLookup,
) -> Result<()> {
    let mut points = Vec::with_capacity(refs.len());
    for &id in refs {
        let Some((lat, lon)) = nodes.get(id) else {
            return Ok(());
        };
        points.push((lon, lat));
    }
    match place {
        Place::Street { name, rank } if points.len() >= 2 => {
            db.prepare_cached(
                "INSERT INTO place_streets(name, road_class, geometry) VALUES(?,?,?)",
            )?
            .execute(params![name, rank, encode_polyline(&points)])?;
        }
        Place::Area { name, kind } if points.len() >= 4 => {
            db.prepare_cached("INSERT INTO place_areas(name, kind, geometry) VALUES(?,?,?)")?
                .execute(params![name, kind, encode_polyline(&points)])?;
        }
        _ => {}
    }
    Ok(())
}

/// Add a named way's street or area, when all its nodes are known.
pub fn add_way(db: &Connection, way: &Way, tags: &Tags, nodes: &dyn NodeLookup) -> Result<()> {
    match classify(way, tags) {
        Some(place) => write(db, &place, &way.refs, nodes),
        None => Ok(()),
    }
}
