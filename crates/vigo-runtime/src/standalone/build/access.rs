//! Station access prepared from a City's routing store.
//!
//! This reproduces the JavaScript compiler's resident store materialization:
//! expanded station transfers, the stop-access index, transfer shortcuts and
//! station paths. The result is persisted as `project.sqlite.access-context.bin`,
//! which every runtime reads instead of rebuilding it, so member order and JSON
//! spelling follow the published layout exactly.
use super::Result;
use super::policy::{
    self, POLICY, TransferTiming, WHEELCHAIR_PROFILE, encode_uri_component, js_string,
    station_transfer_duration_seconds, transfer_duration_seconds,
};
use rusqlite::{Connection, OpenFlags, types::Value as Sql};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;
use vigo_format::js::{Js, locale_compare};
use vigo_format::{PortableArray, encode_routing_snapshot};
use vigo_route::timetable::{
    StationEdge, StationGroup, StationPathsInput, TransferPathInput, compile_station_paths,
    compile_transfer_paths,
};

const ACCESS_CONTEXT_SCHEMA: &str = "vigo.routing.access-context.v2";
const STOP_ACCESS_CELL_DEGREES: f64 = 0.01;

fn sql_js(value: Sql) -> Js {
    match value {
        Sql::Null | Sql::Blob(_) => Js::Null,
        Sql::Integer(v) => Js::Number(v as f64),
        Sql::Real(v) => Js::Number(v),
        Sql::Text(v) => Js::String(v),
    }
}

/// JavaScript `Number(value)`; `None` is `undefined`.
fn js_to_number(value: Option<&Js>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Js::Null) => 0.0,
        Some(Js::Bool(v)) => f64::from(u8::from(*v)),
        Some(Js::Number(v)) => *v,
        Some(Js::String(v)) => policy::js_number(v),
        Some(_) => f64::NAN,
    }
}

/// `numeric(value, fallback)`: `Number(value)` when finite.
fn numeric(value: Option<&Js>, fallback: f64) -> f64 {
    let number = js_to_number(value);
    if number.is_finite() { number } else { fallback }
}

fn finite(value: &Js) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

/// An ordered set with JavaScript `Set` insertion semantics.
#[derive(Default)]
pub(crate) struct Ordered {
    pub items: Vec<String>,
    seen: HashSet<String>,
}
impl Ordered {
    pub fn insert(&mut self, value: &str) {
        if self.seen.insert(value.to_owned()) {
            self.items.push(value.to_owned());
        }
    }
    pub fn contains(&self, value: &str) -> bool {
        self.seen.contains(value)
    }
    fn to_js(&self) -> Js {
        Js::Array(self.items.iter().map(Js::from).collect())
    }
}

/// One row of `SELECT stop_id, name, lat, lon, parent_station, location_type`.
pub(crate) struct Stop {
    pub id: String,
    name: Js,
    lat: Js,
    lon: Js,
    parent_station: Js,
    location_type: Js,
    /// Present only in a wheelchair City: resolved `wheelchair_boarding`.
    pub wheelchair_boarding: Option<f64>,
}
impl Stop {
    pub fn lon(&self) -> Option<f64> {
        finite(&self.lon)
    }
    pub fn lat(&self) -> Option<f64> {
        finite(&self.lat)
    }
    pub fn coordinate(&self) -> Option<(f64, f64)> {
        Some((self.lon()?, self.lat()?))
    }
    /// `numeric(stop.location_type, 0)`.
    pub fn location(&self) -> f64 {
        numeric(Some(&self.location_type), 0.0)
    }
    /// `Number(stop.location_type)`.
    fn location_number(&self) -> f64 {
        js_to_number(Some(&self.location_type))
    }
    /// The parent identifier when it is truthy.
    pub fn parent(&self) -> Option<&str> {
        self.parent_station.as_str().filter(|p| !p.is_empty())
    }
    /// `Number(stop.lon)` as a packed coordinate (null is 0).
    pub fn packed(&self) -> (f64, f64) {
        (js_to_number(Some(&self.lon)), js_to_number(Some(&self.lat)))
    }
    fn to_js(&self) -> Js {
        let mut record = Js::object()
            .with("stop_id", self.id.as_str())
            .with("name", self.name.clone())
            .with("lat", self.lat.clone())
            .with("lon", self.lon.clone())
            .with("parent_station", self.parent_station.clone())
            .with("location_type", self.location_type.clone());
        if let Some(value) = self.wheelchair_boarding {
            record.set("wheelchair_boarding", value);
        }
        record
    }
}

/// An expanded directed transfer, in the JavaScript object's member order.
#[derive(Clone)]
pub(crate) struct Transfer {
    pub from: String,
    pub to: String,
    transfer_type: Js,
    /// After expansion this is always the resolved duration.
    pub min_transfer_time: Js,
    pub provenance: String,
    evidence: Js,
    pub path_distance_m: Js,
    parent_station_transfer: bool,
    parent_minimum: Option<(f64, String, String)>,
}
impl Transfer {
    pub fn timing(&self) -> TransferTiming<'_> {
        TransferTiming {
            provenance: &self.provenance,
            min_transfer_time: match &self.min_transfer_time {
                Js::Null => None,
                other => Some(js_to_number(Some(other))),
            },
            path_distance_m: match &self.path_distance_m {
                Js::Null => None,
                other => Some(js_to_number(Some(other))),
            },
            transfer_type: Some(js_to_number(Some(&self.transfer_type))),
        }
    }
    pub fn seconds(&self) -> f64 {
        js_to_number(Some(&self.min_transfer_time))
    }
    fn is_pathway(&self) -> bool {
        matches!(
            self.provenance.as_str(),
            "gtfs_pathway" | "gtfs_pathway_estimated"
        )
    }
    fn persisted(&self, evidence_index: usize) -> Js {
        let mut row = Js::object()
            .with("to_stop_id", self.to.as_str())
            .with("transfer_type", self.transfer_type.clone())
            .with("min_transfer_time", self.min_transfer_time.clone())
            .with("provenance", self.provenance.as_str())
            .with("path_distance_m", self.path_distance_m.clone());
        if self.parent_station_transfer {
            row.set("parent_station_transfer", true);
        }
        if let Some((seconds, from, to)) = &self.parent_minimum {
            row.set("parentStationMinimumSeconds", *seconds);
            row.set("parentStationMinimumFrom", from.as_str());
            row.set("parentStationMinimumTo", to.as_str());
        }
        row.with("evidenceIndex", evidence_index)
    }
}

pub(crate) struct ShortcutStep {
    from: String,
    to: String,
    seconds: f64,
}
pub(crate) struct Shortcut {
    pub to: String,
    pub seconds: f64,
    steps: Vec<ShortcutStep>,
}

struct Profile {
    route_departures: Vec<(f64, f64)>,
    departure_count: f64,
    sample_count: f64,
}
impl Profile {
    fn new(map: &[(f64, f64)], sample_count: f64) -> Self {
        let mut route_departures = map.to_vec();
        route_departures.sort_by(|a, b| a.0.total_cmp(&b.0));
        let departure_count = route_departures.iter().fold(0.0, |sum, (_, d)| sum + d);
        Profile {
            route_departures,
            departure_count,
            sample_count,
        }
    }
    fn to_js(&self) -> Js {
        let band = |route_type: f64| {
            let value = route_type;
            if value <= 2.0 {
                "rail"
            } else if value == 3.0 {
                "bus"
            } else {
                "other"
            }
        };
        let route_types: Vec<f64> = self.route_departures.iter().map(|(t, _)| *t).collect();
        let heavy = route_types.iter().any(|&v| {
            v == 1.0 || v == 2.0 || (100.0..200.0).contains(&v) || (400.0..500.0).contains(&v)
        });
        Js::object()
            .with(
                "routeDepartures",
                Js::Array(
                    self.route_departures
                        .iter()
                        .map(|(t, d)| Js::object().with("routeType", *t).with("departures", *d))
                        .collect(),
                ),
            )
            .with("departureCount", self.departure_count)
            .with("sampleCount", self.sample_count)
            .with("routeTypes", route_types.clone())
            .with(
                "modes",
                ["rail", "bus", "other"]
                    .into_iter()
                    .filter(|mode| route_types.iter().any(|t| band(*t) == *mode))
                    .map(Js::from)
                    .collect::<Vec<_>>(),
            )
            .with("hasHeavyRail", heavy)
    }
}

/// `buildStopAccessIndex`: service roles, departure profiles and a spatial grid.
pub(crate) struct StopAccessIndex {
    anchors: Vec<usize>,
    cells: Vec<(String, Vec<usize>)>,
    profiles_by_stop: Vec<(String, Profile)>,
    direct_profiles_by_stop: Vec<(String, Profile)>,
    pub direct_service: Ordered,
    pub departure_service: Ordered,
    pub arrival_service: Ordered,
    mode_row_count: usize,
    role_row_count: usize,
    build_ms: f64,
}

/// Paths between the stops of one access profile (`prepareStationAccessPaths`).
pub(crate) struct StationPaths {
    pub stop_ids: Vec<String>,
    sources: Vec<String>,
    pub result: vigo_route::timetable::StationPathsResult,
}

pub(crate) struct AccessStore {
    pub path: PathBuf,
    pub metadata: Value,
    pub stops: Vec<Stop>,
    pub stop_index: HashMap<String, usize>,
    pub station_members: Vec<(String, Vec<String>)>,
    pub transfers: Vec<(String, Vec<Transfer>)>,
    transfer_index: HashMap<String, usize>,
    pub declared_pathway_stops: Ordered,
    pub forbidden: Ordered,
    raw_transfer_count: usize,
    raw_forbidden_transfer_count: usize,
    resolved_transfer_count: usize,
    pub index: StopAccessIndex,
    pub shortcuts: Vec<(String, Vec<Shortcut>)>,
    pub source_artifact_identity: String,
    pub station_paths: Option<StationPaths>,
    pub has_connection_permissions: bool,
}

pub(crate) fn read_metadata(db: &Connection) -> Result<Value> {
    let mut statement = db.prepare("SELECT key, value FROM metadata")?;
    let mut rows = statement.query([])?;
    let mut metadata = serde_json::Map::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let text: String = row.get(1)?;
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        metadata.insert(key, value);
    }
    Ok(Value::Object(metadata))
}

/// `stationHierarchyMembers`: every ancestor lists itself, then descendants.
fn station_hierarchy(
    stops: &[Stop],
    index: &HashMap<String, usize>,
) -> Result<Vec<(String, Vec<String>)>> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for stop in stops {
        let mut seen = HashSet::from([stop.id.clone()]);
        let mut parent = stop.parent().map(str::to_owned);
        while let Some(current) = parent {
            if !seen.insert(current.clone()) {
                return Err(format!("Cyclic GTFS station hierarchy: {}", stop.id).into());
            }
            let Some(&record) = index.get(&current) else {
                return Err(format!("Missing GTFS parent: {current}").into());
            };
            let position = *positions.entry(current.clone()).or_insert_with(|| {
                groups.push((current.clone(), vec![current.clone()]));
                groups.len() - 1
            });
            groups[position].1.push(stop.id.clone());
            parent = stops[record].parent().map(str::to_owned);
        }
    }
    Ok(groups)
}

/// `Number(value || 0)`.
fn number_or_zero(value: &Js) -> f64 {
    match value {
        Js::Null | Js::Bool(false) => 0.0,
        Js::Number(n) if *n == 0.0 || n.is_nan() => 0.0,
        Js::String(s) if s.is_empty() => 0.0,
        other => js_to_number(Some(other)),
    }
}

/// `boardingAreaLinks`: zero-cost links between a boarding area and its
/// platform, which becomes a terminal that paths may not cross.
fn boarding_area_links(store: &AccessStore) -> Result<(Vec<Transfer>, HashSet<String>)> {
    let mut links = vec![];
    let mut terminals = HashSet::new();
    for stop in &store.stops {
        if stop.location_number() != 4.0 {
            continue;
        }
        let parent = stop
            .parent_station
            .as_str()
            .and_then(|id| store.stop_index.get(id))
            .map(|&i| &store.stops[i]);
        let Some(parent) = parent.filter(|p| number_or_zero(&p.location_type) == 0.0) else {
            return Err(format!("Invalid boarding-area parent: {}", stop.id).into());
        };
        terminals.insert(parent.id.clone());
        if stop.wheelchair_boarding.is_some_and(|w| w != 1.0) {
            continue;
        }
        for (from, to) in [(&stop.id, &parent.id), (&parent.id, &stop.id)] {
            links.push(Transfer {
                from: from.clone(),
                to: to.clone(),
                transfer_type: Js::Null,
                min_transfer_time: Js::Number(0.0),
                provenance: "gtfs_boarding_area".into(),
                evidence: Js::Null,
                path_distance_m: Js::Number(0.0),
                parent_station_transfer: false,
                parent_minimum: None,
            });
        }
    }
    Ok((links, terminals))
}

/// Expanded rows of one origin, with each destination's position.
type OriginRows = (String, Vec<(String, Transfer)>, HashMap<String, usize>);

struct Expansion {
    transfers: Vec<(String, Vec<Transfer>)>,
    raw: usize,
    resolved: usize,
    declared: Ordered,
}

/// `expandParentStationTransfers`.
fn expand_transfers(
    raw: Vec<Transfer>,
    stops: &[Stop],
    index: &HashMap<String, usize>,
    members: &HashMap<&str, &Vec<String>>,
    wheelchair: bool,
) -> Expansion {
    let speed = POLICY.walking_speed_kph;
    let stop = |id: &str| index.get(id).map(|&i| &stops[i]);
    let mut targets: Vec<OriginRows> = vec![];
    let mut origin_position: HashMap<String, usize> = HashMap::new();
    let mut declared = Ordered::default();
    let mut parent_rules = vec![];
    let mut add = |transfer: Transfer, targets: &mut Vec<OriginRows>| {
        let (Some(from), Some(to)) = (stop(&transfer.from), stop(&transfer.to)) else {
            return;
        };
        let Some(duration) = station_transfer_duration_seconds(
            &transfer.timing(),
            from.coordinate(),
            to.coordinate(),
            speed,
        ) else {
            return;
        };
        let position = match origin_position.get(&transfer.from) {
            Some(&p) => p,
            None => {
                targets.push((transfer.from.clone(), vec![], HashMap::new()));
                origin_position.insert(transfer.from.clone(), targets.len() - 1);
                targets.len() - 1
            }
        };
        let (_, rows, row_index) = &mut targets[position];
        match row_index.get(&transfer.to) {
            Some(&existing) => {
                if duration < rows[existing].1.seconds() {
                    rows[existing].1 = Transfer {
                        min_transfer_time: Js::Number(duration),
                        ..transfer
                    };
                }
            }
            None => {
                row_index.insert(transfer.to.clone(), rows.len());
                rows.push((
                    transfer.to.clone(),
                    Transfer {
                        min_transfer_time: Js::Number(duration),
                        ..transfer
                    },
                ));
            }
        }
    };
    let service_members = |id: &str| -> Vec<String> {
        let Some(record) = stop(id) else {
            return vec![id.to_owned()];
        };
        if record.location() != 1.0 {
            return vec![id.to_owned()];
        }
        let list: Vec<String> = members
            .get(id)
            .map(|ids| {
                ids.iter()
                    .filter(|m| m.as_str() != id && stop(m).map_or(0.0, Stop::location) == 0.0)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if list.is_empty() {
            vec![id.to_owned()]
        } else {
            list
        }
    };
    let raw_count = raw.len();
    for raw_transfer in raw {
        if raw_transfer.is_pathway() {
            declared.insert(&raw_transfer.from);
            declared.insert(&raw_transfer.to);
        }
        let location = |id: &str| stop(id).map_or(0.0, Stop::location);
        if raw_transfer.provenance == "gtfs_transfer"
            && js_to_number(Some(&raw_transfer.transfer_type)) == 2.0
            && (location(&raw_transfer.from) == 1.0 || location(&raw_transfer.to) == 1.0)
        {
            parent_rules.push(raw_transfer.clone());
        }
        if wheelchair
            && raw_transfer.provenance == "gtfs_transfer"
            && js_to_number(Some(&raw_transfer.transfer_type)) != 3.0
            && raw_transfer.from != raw_transfer.to
        {
            continue;
        }
        let transfer = if raw_transfer.provenance == "osm_certified_radial" {
            let distance = numeric(Some(&raw_transfer.path_distance_m), 0.0);
            Transfer {
                min_transfer_time: Js::Number(policy::walk_seconds(distance / 1000.0)),
                ..raw_transfer
            }
        } else {
            raw_transfer
        };
        add(transfer.clone(), &mut targets);
        let from_members = service_members(&transfer.from);
        let to_members = service_members(&transfer.to);
        if from_members.len() == 1
            && from_members[0] == transfer.from
            && to_members.len() == 1
            && to_members[0] == transfer.to
        {
            continue;
        }
        for from in &from_members {
            for to in &to_members {
                add(
                    Transfer {
                        from: from.clone(),
                        to: to.clone(),
                        parent_station_transfer: true,
                        ..transfer.clone()
                    },
                    &mut targets,
                );
            }
        }
    }
    for rule in &parent_rules {
        let Some(minimum) = transfer_duration_seconds(&rule.timing()) else {
            continue;
        };
        for from in service_members(&rule.from) {
            for to in service_members(&rule.to) {
                let Some(&position) = origin_position.get(&from) else {
                    continue;
                };
                let (_, rows, row_index) = &mut targets[position];
                let Some(&existing) = row_index.get(&to) else {
                    continue;
                };
                let edge = &mut rows[existing].1;
                if edge.seconds() >= minimum {
                    continue;
                }
                edge.min_transfer_time = Js::Number(minimum);
                edge.parent_minimum = Some((minimum, rule.from.clone(), rule.to.clone()));
            }
        }
    }
    let mut resolved = 0;
    let transfers = targets
        .into_iter()
        .map(|(from, rows, _)| {
            let mut rows: Vec<Transfer> = rows.into_iter().map(|(_, row)| row).collect();
            rows.sort_by(|a, b| locale_compare(&a.to, &b.to));
            resolved += rows.len();
            (from, rows)
        })
        .collect();
    Expansion {
        transfers,
        raw: raw_count,
        resolved,
        declared,
    }
}

const TRANSFER_SELECT: &str = "
    SELECT transfer.from_stop_id, transfer.to_stop_id, transfer.transfer_type,
      transfer.min_transfer_time, provenance.provenance,
      provenance.evidence_fingerprint, provenance.path_distance_m
    FROM transfers AS transfer
    JOIN transfer_provenance AS provenance
      ON provenance.from_stop_id=transfer.from_stop_id
      AND provenance.to_stop_id=transfer.to_stop_id
  ";

fn read_transfers(db: &Connection, sql: &str) -> Result<Vec<Transfer>> {
    let mut statement = db.prepare(sql)?;
    let mut rows = statement.query([])?;
    let mut transfers = vec![];
    while let Some(row) = rows.next()? {
        let text = |i: usize| -> rusqlite::Result<String> {
            Ok(match row.get::<_, Sql>(i)? {
                Sql::Text(v) => v,
                Sql::Integer(v) => v.to_string(),
                Sql::Real(v) => js_string(v),
                _ => String::new(),
            })
        };
        transfers.push(Transfer {
            from: text(0)?,
            to: text(1)?,
            transfer_type: sql_js(row.get(2)?),
            min_transfer_time: sql_js(row.get(3)?),
            provenance: text(4)?,
            evidence: sql_js(row.get(5)?),
            path_distance_m: sql_js(row.get(6)?),
            parent_station_transfer: false,
            parent_minimum: None,
        });
    }
    Ok(transfers)
}

impl AccessStore {
    /// Open a routing store and materialize its station access.
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let metadata = read_metadata(&db)?;
        let wheelchair = metadata["accessibility"]["profile"] == WHEELCHAIR_PROFILE;
        let accessibility: HashMap<String, f64> = if wheelchair {
            let mut statement = db.prepare("SELECT stop_id,boarding FROM wheelchair_stops")?;
            statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        } else {
            HashMap::new()
        };
        let mut stops = vec![];
        {
            let mut statement = db.prepare(
                "SELECT stop_id, name, lat, lon, parent_station, location_type FROM stops ORDER BY stop_id",
            )?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                stops.push(Stop {
                    wheelchair_boarding: wheelchair
                        .then(|| accessibility.get(&id).copied().unwrap_or(0.0)),
                    id,
                    name: sql_js(row.get(1)?),
                    lat: sql_js(row.get(2)?),
                    lon: sql_js(row.get(3)?),
                    parent_station: sql_js(row.get(4)?),
                    location_type: sql_js(row.get(5)?),
                });
            }
        }
        let stop_index: HashMap<String, usize> = stops
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id.clone(), i))
            .collect();
        let station_members = station_hierarchy(&stops, &stop_index)?;
        let members: HashMap<&str, &Vec<String>> = station_members
            .iter()
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        let regular = expand_transfers(
            read_transfers(
                &db,
                &format!("{TRANSFER_SELECT} WHERE transfer.transfer_type != 3"),
            )?,
            &stops,
            &stop_index,
            &members,
            wheelchair,
        );
        let mut declared = regular.declared;
        // Never invent connections or snap through a station interior here.
        if wheelchair {
            for stop in &stops {
                declared.insert(&stop.id);
            }
        }
        let forbidden_expansion = expand_transfers(
            read_transfers(
                &db,
                &format!("{TRANSFER_SELECT} WHERE transfer.transfer_type = 3"),
            )?,
            &stops,
            &stop_index,
            &members,
            false,
        );
        let mut forbidden = Ordered::default();
        for (from, rows) in &forbidden_expansion.transfers {
            for row in rows {
                forbidden.insert(&format!("{from}\0{}", row.to));
            }
        }
        let index = build_stop_access_index(&db, &stops, &stop_index, &members)?;
        let mut transfers = regular.transfers;
        let minimums = if wheelchair {
            expand_transfers(
                read_transfers(&db, "SELECT from_stop_id,to_stop_id,2 AS transfer_type,min_transfer_time,'gtfs_transfer' AS provenance,NULL,NULL FROM wheelchair_transfer_minimum")?,
                &stops,
                &stop_index,
                &members,
                false,
            )
            .transfers
        } else {
            vec![]
        };
        let transfer_index: HashMap<String, usize> = transfers
            .iter()
            .enumerate()
            .map(|(i, (f, _))| (f.clone(), i))
            .collect();
        for (from, rules) in &minimums {
            let Some(&position) = transfer_index.get(from) else {
                continue;
            };
            for rule in rules {
                if let Some(edge) = transfers[position].1.iter_mut().find(|e| e.to == rule.to) {
                    edge.min_transfer_time = Js::Number(edge.seconds().max(rule.seconds()));
                }
            }
        }
        let has_connection_permissions: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='connection_permissions')",
            [],
            |r| r.get(0),
        )?;
        drop(db);
        let identity = super::super::city::routing_source_identity(&metadata);
        let source_artifact_identity = format!(
            "{}\n{}",
            serde_json::to_string(&identity)?,
            vigo_gtfs::store::sqlite_store_generation(path)?
        );
        let mut store = AccessStore {
            path: path.to_path_buf(),
            metadata,
            stops,
            stop_index,
            station_members,
            transfers,
            transfer_index,
            declared_pathway_stops: declared,
            forbidden,
            raw_transfer_count: regular.raw,
            raw_forbidden_transfer_count: forbidden_expansion.raw,
            resolved_transfer_count: regular.resolved,
            index,
            shortcuts: vec![],
            source_artifact_identity,
            station_paths: None,
            has_connection_permissions,
        };
        store.shortcuts = store.service_shortcuts(&minimums)?;
        Ok(store)
    }

    pub fn transfers_from(&self, id: &str) -> &[Transfer] {
        self.transfer_index
            .get(id)
            .map_or(&[], |&i| self.transfers[i].1.as_slice())
    }

    pub fn stop(&self, id: &str) -> Option<&Stop> {
        self.stop_index.get(id).map(|&i| &self.stops[i])
    }

    /// `prepareServiceTransfers`: shortcuts through declared pathways that
    /// the timetable projection relaxes as one edge.
    fn service_shortcuts(
        &self,
        minimums: &[(String, Vec<Transfer>)],
    ) -> Result<Vec<(String, Vec<Shortcut>)>> {
        let (links, terminals) = boarding_area_links(self)?;
        let edges: Vec<&Transfer> = self
            .transfers
            .iter()
            .flat_map(|(_, rows)| rows)
            .chain(&links)
            .collect();
        let position = |id: &str| self.stop_index[id] as u32;
        let forbidden: Vec<(u32, u32)> = self
            .forbidden
            .items
            .iter()
            .filter_map(|pair| {
                let (a, b) = pair.split_once('\0')?;
                Some((
                    *self.stop_index.get(a)? as u32,
                    *self.stop_index.get(b)? as u32,
                ))
            })
            .collect();
        let paths = compile_transfer_paths(TransferPathInput {
            terminal_only: Some(
                self.stops
                    .iter()
                    .map(|s| u8::from(terminals.contains(&s.id)))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            eligible: self
                .stops
                .iter()
                .map(|s| u8::from(self.index.direct_service.contains(&s.id)))
                .collect::<Vec<_>>()
                .into(),
            from: edges
                .iter()
                .map(|e| position(&e.from))
                .collect::<Vec<_>>()
                .into(),
            to: edges
                .iter()
                .map(|e| position(&e.to))
                .collect::<Vec<_>>()
                .into(),
            seconds: edges
                .iter()
                .map(|e| to_uint32(e.seconds()))
                .collect::<Vec<_>>()
                .into(),
            pathway: edges
                .iter()
                .map(|e| u8::from(e.is_pathway() || e.provenance == "gtfs_boarding_area"))
                .collect::<Vec<_>>()
                .into(),
            forbidden_from: forbidden.iter().map(|p| p.0).collect::<Vec<_>>().into(),
            forbidden_to: forbidden.iter().map(|p| p.1).collect::<Vec<_>>().into(),
        })?;
        let minimum_index: HashMap<&str, &Vec<Transfer>> =
            minimums.iter().map(|(k, v)| (k.as_str(), v)).collect();
        let mut shortcuts: Vec<(String, Vec<Shortcut>)> = vec![];
        let mut positions: HashMap<String, usize> = HashMap::new();
        for i in 0..paths.from.len() {
            let from = &self.stops[paths.from[i] as usize].id;
            let to = &self.stops[paths.to[i] as usize].id;
            let direct = self.transfers_from(from).iter().find(|e| &e.to == to);
            let minimum = minimum_index
                .get(from.as_str())
                .and_then(|rules| rules.iter().find(|e| &e.to == to))
                .map(Transfer::seconds)
                .or_else(|| direct.and_then(|d| d.parent_minimum.as_ref().map(|m| m.0)))
                .unwrap_or_else(|| match direct {
                    Some(d) if d.provenance == "gtfs_transfer" => d.seconds(),
                    _ => 0.0,
                });
            let minimum = if minimum.is_nan() {
                0.0
            } else {
                minimum.trunc()
            };
            let path_seconds = f64::from(paths.seconds[i]);
            let seconds = path_seconds.max(minimum);
            if direct.is_some_and(|d| d.seconds().trunc() <= seconds) {
                continue;
            }
            let start = paths.path_offsets[i] as usize;
            let end = paths.path_offsets[i + 1] as usize;
            let mut steps: Vec<ShortcutStep> = paths.path_edges[start..end]
                .iter()
                .map(|&edge| {
                    let edge = edges[edge as usize];
                    ShortcutStep {
                        from: edge.from.clone(),
                        to: edge.to.clone(),
                        seconds: edge.seconds().trunc(),
                    }
                })
                .collect();
            if let Some(last) = steps.last_mut() {
                last.seconds += seconds - path_seconds;
            }
            let position = *positions.entry(from.clone()).or_insert_with(|| {
                shortcuts.push((from.clone(), vec![]));
                shortcuts.len() - 1
            });
            shortcuts[position].1.push(Shortcut {
                to: to.clone(),
                seconds,
                steps,
            });
        }
        Ok(shortcuts)
    }

    /// `prepareStationAccessPaths` for the given profile members.
    pub fn prepare_station_paths(&mut self, members: &[usize]) -> Result<()> {
        if let Some(paths) = &self.station_paths
            && paths.stop_ids.len() == members.len()
            && paths
                .stop_ids
                .iter()
                .zip(members)
                .all(|(id, &m)| *id == self.stops[m].id)
        {
            return Ok(());
        }
        let speed = POLICY.walking_speed_kph;
        let indices: HashMap<&str, u32> = members
            .iter()
            .enumerate()
            .map(|(i, &m)| (self.stops[m].id.as_str(), i as u32))
            .collect();
        let mut sources = vec!["parent_station_fallback".to_owned()];
        let mut source_index: HashMap<String, u32> = HashMap::from([(sources[0].clone(), 0)]);
        let (links, terminals) = boarding_area_links(self)?;
        let mut graph: Vec<(String, Vec<&Transfer>)> = self
            .transfers
            .iter()
            .map(|(id, rows)| (id.clone(), rows.iter().collect()))
            .collect();
        let mut graph_index: HashMap<String, usize> = graph
            .iter()
            .enumerate()
            .map(|(i, (id, _))| (id.clone(), i))
            .collect();
        for link in &links {
            match graph_index.get(&link.from) {
                Some(&i) => graph[i].1.push(link),
                None => {
                    graph_index.insert(link.from.clone(), graph.len());
                    graph.push((link.from.clone(), vec![link]));
                }
            }
        }
        let stop_at = |i: u32| &self.stops[members[i as usize]];
        let mut edges = vec![];
        for (id, transfers) in &graph {
            let Some(&from) = indices.get(id.as_str()) else {
                continue;
            };
            for transfer in transfers {
                let Some(&to) = indices.get(transfer.to.as_str()) else {
                    continue;
                };
                let Some(seconds) = station_transfer_duration_seconds(
                    &transfer.timing(),
                    stop_at(from).coordinate(),
                    stop_at(to).coordinate(),
                    speed,
                ) else {
                    continue;
                };
                let source = match source_index.get(&transfer.provenance) {
                    Some(&s) => s,
                    None => {
                        source_index.insert(transfer.provenance.clone(), sources.len() as u32);
                        sources.push(transfer.provenance.clone());
                        sources.len() as u32 - 1
                    }
                };
                let located =
                    stop_at(from).coordinate().is_some() && stop_at(to).coordinate().is_some();
                let distance = match &transfer.path_distance_m {
                    Js::Null => (!located).then_some(0.0),
                    value => Some(js_to_number(Some(value))),
                };
                edges.push(StationEdge {
                    from,
                    to,
                    seconds,
                    distance,
                    source,
                    street: transfer.provenance == "osm_certified_radial",
                });
            }
        }
        let groups = self
            .station_members
            .iter()
            .map(|(_, ids)| StationGroup {
                members: ids
                    .iter()
                    .filter_map(|id| indices.get(id.as_str()).copied())
                    .collect(),
                declared: ids.iter().any(|id| {
                    self.declared_pathway_stops.contains(id)
                        || self.transfers_from(id).iter().any(Transfer::is_pathway)
                }),
            })
            .collect();
        let (forbidden_from, forbidden_to): (Vec<u32>, Vec<u32>) = self
            .forbidden
            .items
            .iter()
            .filter_map(|pair| {
                let (a, b) = pair.split_once('\0')?;
                Some((*indices.get(a)?, *indices.get(b)?))
            })
            .unzip();
        let result = compile_station_paths(StationPathsInput {
            coordinates: members
                .iter()
                .flat_map(|&m| {
                    let (lon, lat) = self.stops[m].packed();
                    [lon, lat]
                })
                .collect::<Vec<_>>()
                .into(),
            platforms: members
                .iter()
                .map(|&m| u8::from(number_or_zero(&self.stops[m].location_type) == 0.0))
                .collect::<Vec<_>>()
                .into(),
            terminal_only: Some(
                members
                    .iter()
                    .map(|&m| u8::from(terminals.contains(&self.stops[m].id)))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            edges,
            groups,
            forbidden_from: forbidden_from.into(),
            forbidden_to: forbidden_to.into(),
            fallback_source: 0,
            walking_speed_kph: speed,
        })?;
        let retained = result
            .source_ids
            .iter()
            .map(|&i| {
                sources
                    .get(i as usize)
                    .cloned()
                    .ok_or("Prepared station paths have invalid sources.")
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        self.station_paths = Some(StationPaths {
            stop_ids: members.iter().map(|&m| self.stops[m].id.clone()).collect(),
            sources: retained,
            result,
        });
        Ok(())
    }

    /// Write `project.sqlite.access-context.bin` (`persistPreparedAccessContext`).
    pub fn persist(&self) -> Result<u64> {
        let mut evidence: Vec<Js> = vec![];
        let mut evidence_index: HashMap<String, usize> = HashMap::new();
        let mut evidence_position = |value: &Js| -> usize {
            let key = value.stringify();
            *evidence_index.entry(key).or_insert_with(|| {
                evidence.push(value.clone());
                evidence.len() - 1
            })
        };
        let transfers = Js::Array(
            self.transfers
                .iter()
                .map(|(from, rows)| {
                    Js::Array(vec![
                        Js::from(from.as_str()),
                        Js::Array(
                            rows.iter()
                                .map(|row| row.persisted(evidence_position(&row.evidence)))
                                .collect(),
                        ),
                    ])
                })
                .collect(),
        );
        let shortcuts = Js::Array(
            self.shortcuts
                .iter()
                .map(|(from, rows)| {
                    Js::Array(vec![
                        Js::from(from.as_str()),
                        Js::Array(
                            rows.iter()
                                .map(|row| {
                                    Js::object()
                                        .with("from_stop_id", from.as_str())
                                        .with("to_stop_id", row.to.as_str())
                                        .with("min_transfer_time", row.seconds)
                                        .with(
                                            "steps",
                                            Js::Array(
                                                row.steps
                                                    .iter()
                                                    .map(|s| {
                                                        Js::object()
                                                            .with("from_stop_id", s.from.as_str())
                                                            .with("to_stop_id", s.to.as_str())
                                                            .with("min_transfer_time", s.seconds)
                                                    })
                                                    .collect(),
                                            ),
                                        )
                                })
                                .collect(),
                        ),
                    ])
                })
                .collect(),
        );
        let pairs = |list: &[(String, Vec<String>)]| {
            Js::Array(
                list.iter()
                    .map(|(k, v)| {
                        Js::Array(vec![
                            Js::from(k.as_str()),
                            Js::Array(v.iter().map(Js::from).collect()),
                        ])
                    })
                    .collect(),
            )
        };
        let index = &self.index;
        let ids = |list: &[usize]| {
            Js::Array(
                list.iter()
                    .map(|&i| Js::from(self.stops[i].id.as_str()))
                    .collect(),
            )
        };
        let profiles = |list: &[(String, Profile)]| {
            Js::Array(
                list.iter()
                    .map(|(id, p)| Js::Array(vec![Js::from(id.as_str()), p.to_js()]))
                    .collect(),
            )
        };
        let profiled = index
            .anchors
            .iter()
            .filter(|&&a| {
                index
                    .profiles_by_stop
                    .iter()
                    .any(|(id, _)| *id == self.stops[a].id)
            })
            .count();
        let stop_access_index = Js::object()
            .with("ready", true)
            .with("reason", "ready")
            .with("strategy", "immutable_grid_persisted_exact_stop_roles")
            .with("cellDegrees", STOP_ACCESS_CELL_DEGREES)
            .with("anchors", ids(&index.anchors))
            .with(
                "cells",
                Js::Array(
                    index
                        .cells
                        .iter()
                        .map(|(key, stops)| Js::Array(vec![Js::from(key.as_str()), ids(stops)]))
                        .collect(),
                ),
            )
            .with("profilesByStop", profiles(&index.profiles_by_stop))
            .with(
                "directProfilesByStop",
                profiles(&index.direct_profiles_by_stop),
            )
            .with("directServiceStopIds", index.direct_service.to_js())
            .with("departureServiceStopIds", index.departure_service.to_js())
            .with("arrivalServiceStopIds", index.arrival_service.to_js())
            .with("anchorCount", index.anchors.len())
            .with("profiledAnchorCount", profiled)
            .with("cellCount", index.cells.len())
            .with("modeRowCount", index.mode_row_count)
            .with("roleRowCount", index.role_row_count)
            .with(
                "estimatedBytes",
                index.anchors.len() * 96
                    + index.mode_row_count * 40
                    + index.role_row_count * 24
                    + index.cells.len() * 64,
            )
            .with("buildMs", index.build_ms)
            .with("queryCount", 0)
            .with("queryMs", 0);
        let materialized = Js::object()
            .with("transfers", transfers)
            .with("transferShortcuts", shortcuts)
            .with("stationMembers", pairs(&self.station_members))
            .with(
                "stopRecords",
                Js::Array(
                    self.stops
                        .iter()
                        .map(|s| Js::Array(vec![Js::from(s.id.as_str()), s.to_js()]))
                        .collect(),
                ),
            )
            .with("forbiddenTransferPairs", self.forbidden.to_js())
            .with("declaredPathwayStops", self.declared_pathway_stops.to_js())
            .with("rawTransferCount", self.raw_transfer_count)
            .with(
                "rawForbiddenTransferCount",
                self.raw_forbidden_transfer_count,
            )
            .with("resolvedTransferCount", self.resolved_transfer_count)
            .with("stopAccessIndex", stop_access_index)
            .with("transferEvidence", Js::Array(evidence));
        let station_paths = match &self.station_paths {
            Some(paths) => Js::object()
                .with(
                    "stopIds",
                    Js::Array(paths.stop_ids.iter().map(Js::from).collect()),
                )
                .with(
                    "sources",
                    Js::Array(paths.sources.iter().map(Js::from).collect()),
                ),
            None => Js::Null,
        };
        let metadata = Js::object()
            .with("schemaVersion", ACCESS_CONTEXT_SCHEMA)
            .with(
                "sourceArtifactIdentity",
                self.source_artifact_identity.as_str(),
            )
            .with("accessPolicyIdentity", POLICY.identity.as_str())
            .with("materialized", materialized)
            .with("stationPaths", station_paths);
        let mut arrays = vec![];
        if let Some(paths) = &self.station_paths {
            let r = &paths.result;
            arrays.push(u32_array("offsets", &r.offsets));
            arrays.push(u32_array("pathOffsets", &r.path_offsets));
            arrays.push(u32_array("from", &r.from));
            arrays.push(u32_array("to", &r.to));
            arrays.push(f64_array("seconds", &r.seconds));
            arrays.push(f64_array("distanceM", &r.distance_m));
            arrays.push(u32_array("pathStops", &r.path_stops));
            arrays.push(u32_array("pathSources", &r.path_sources));
        }
        let bytes = encode_routing_snapshot(Some(&metadata.stringify()), &arrays)?;
        if bytes.len() > 512 * 1024 * 1024 {
            return Err("Prepared access context exceeds its size limit.".into());
        }
        let mut target = self.path.as_os_str().to_owned();
        target.push(".access-context.bin");
        super::write_private(Path::new(&target), &bytes)?;
        Ok(bytes.len() as u64)
    }
}

/// `Uint32Array.from([value])` conversion (ToUint32).
pub(crate) fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    (value.trunc().rem_euclid(4_294_967_296.0)) as u32
}

pub(crate) fn u32_array(name: &str, values: &[u32]) -> PortableArray {
    PortableArray {
        name: name.into(),
        kind: "Uint32Array".into(),
        data: values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>()
            .into(),
    }
}
pub(crate) fn u8_array(name: &str, values: &[u8]) -> PortableArray {
    PortableArray {
        name: name.into(),
        kind: "Uint8Array".into(),
        data: values.to_vec().into(),
    }
}
pub(crate) fn f64_array(name: &str, values: &[f64]) -> PortableArray {
    PortableArray {
        name: name.into(),
        kind: "Float64Array".into(),
        data: values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>()
            .into(),
    }
}

fn build_stop_access_index(
    db: &Connection,
    stops: &[Stop],
    stop_index: &HashMap<String, usize>,
    members: &HashMap<&str, &Vec<String>>,
) -> Result<StopAccessIndex> {
    let started = Instant::now();
    let has_modes: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='stop_modes')",
        [],
        |r| r.get(0),
    )?;
    if !has_modes {
        return Err(
            "Routing store requires a resident stop-access index and must be rebuilt: stop_modes_absent"
                .into(),
        );
    }
    let mut raw: Vec<(String, Vec<(f64, f64)>)> = vec![];
    let mut raw_index: HashMap<String, usize> = HashMap::new();
    let mut mode_row_count = 0;
    {
        let mut statement =
            db.prepare("SELECT stop_id, route_type, departure_count FROM stop_modes ORDER BY stop_id, route_type")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id = match row.get::<_, Sql>(0)? {
                Sql::Text(v) => v,
                other => js_string(js_to_number(Some(&sql_js(other)))),
            };
            let route_type = numeric(Some(&sql_js(row.get(1)?)), 3.0);
            let departures = numeric(Some(&sql_js(row.get(2)?)), 0.0).max(0.0);
            let position = *raw_index.entry(id.clone()).or_insert_with(|| {
                raw.push((id, vec![]));
                raw.len() - 1
            });
            let entries = &mut raw[position].1;
            match entries.iter_mut().find(|(t, _)| *t == route_type) {
                Some(entry) => entry.1 += departures,
                None => entries.push((route_type, departures)),
            }
            mode_row_count += 1;
        }
    }
    let mut direct_service = Ordered::default();
    let mut departure_service = Ordered::default();
    let mut arrival_service = Ordered::default();
    let mut role_row_count = 0;
    {
        let mut statement = db.prepare(
            "SELECT stop_id, can_board, can_alight FROM stop_access_roles ORDER BY stop_id",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let parent = stop_index
                .get(&id)
                .and_then(|&i| stops[i].parent_station.as_str())
                .map(|p| p.trim().to_owned())
                .unwrap_or_default();
            let flag = |value: Sql| {
                matches!(value, Sql::Integer(1)) || matches!(value, Sql::Real(v) if v == 1.0)
            };
            if flag(row.get(1)?) {
                direct_service.insert(&id);
                departure_service.insert(&id);
                if !parent.is_empty() {
                    departure_service.insert(&parent);
                }
            }
            if flag(row.get(2)?) {
                direct_service.insert(&id);
                arrival_service.insert(&id);
                if !parent.is_empty() {
                    arrival_service.insert(&parent);
                }
            }
            role_row_count += 1;
        }
    }
    let total = |entries: &[(f64, f64)]| entries.iter().fold(0.0, |sum, (_, d)| sum + d);
    let direct_profiles_by_stop = raw
        .iter()
        .map(|(id, entries)| (id.clone(), Profile::new(entries, total(entries).min(12.0))))
        .collect();
    let mut profiles_by_stop = vec![];
    for stop in stops {
        let direct = raw_index
            .get(&stop.id)
            .map_or(&[][..], |&i| raw[i].1.as_slice());
        let mut route_departures = direct.to_vec();
        let direct_count = total(direct);
        let mut sample_count = direct_count.min(12.0);
        if stop.location() == 1.0 {
            let mut member_departures: Vec<(f64, f64)> = vec![];
            let mut member_samples = 0.0;
            for member in members
                .get(stop.id.as_str())
                .map_or(&[][..], |m| m.as_slice())
            {
                if *member == stop.id {
                    continue;
                }
                let Some(&i) = raw_index.get(member) else {
                    continue;
                };
                let entries = &raw[i].1;
                member_samples += total(entries).min(12.0);
                for &(route_type, departures) in entries {
                    match member_departures.iter_mut().find(|(t, _)| *t == route_type) {
                        Some(entry) => entry.1 += departures,
                        None => member_departures.push((route_type, departures)),
                    }
                }
            }
            if !member_departures.is_empty() {
                for (route_type, departures) in member_departures {
                    match route_departures.iter_mut().find(|(t, _)| *t == route_type) {
                        Some(entry) => entry.1 = entry.1.max(departures),
                        None => route_departures.push((route_type, departures)),
                    }
                }
                sample_count = member_samples.max(direct_count.min(12.0));
            }
        }
        if !route_departures.is_empty() {
            profiles_by_stop.push((
                stop.id.clone(),
                Profile::new(&route_departures, sample_count),
            ));
        }
    }
    let mut anchors = vec![];
    let mut cells: Vec<(String, Vec<usize>)> = vec![];
    let mut cell_index: HashMap<String, usize> = HashMap::new();
    for (i, stop) in stops.iter().enumerate() {
        let (Some(lat), Some(lon)) = (stop.lat(), stop.lon()) else {
            continue;
        };
        let has_parent = match &stop.parent_station {
            Js::Null => false,
            Js::String(parent) => !parent.is_empty(),
            _ => true,
        };
        if stop.location() != 1.0 && has_parent {
            continue;
        }
        anchors.push(i);
        let key = format!(
            "{}:{}",
            vigo_format::js::number((lat / STOP_ACCESS_CELL_DEGREES).floor()),
            vigo_format::js::number((lon / STOP_ACCESS_CELL_DEGREES).floor())
        );
        let position = *cell_index.entry(key.clone()).or_insert_with(|| {
            cells.push((key, vec![]));
            cells.len() - 1
        });
        cells[position].1.push(i);
    }
    anchors.sort_by(|&a, &b| locale_compare(&stops[a].id, &stops[b].id));
    for (_, entries) in &mut cells {
        entries.sort_by(|&a, &b| locale_compare(&stops[a].id, &stops[b].id));
    }
    Ok(StopAccessIndex {
        anchors,
        cells,
        profiles_by_stop,
        direct_profiles_by_stop,
        direct_service,
        departure_service,
        arrival_service,
        mode_row_count,
        role_row_count,
        build_ms: (started.elapsed().as_secs_f64() * 1e6).round() / 1e3,
    })
}

/// A native access profile (`physicalStopAccessProfile`).
pub(crate) struct AccessProfile {
    pub key: String,
    pub members: Vec<usize>,
    pub input: crate::AccessProfileInput,
}

/// `osmStopTransferStreetIdentity(readNationalOsmStoreMetadata(street))`.
pub(crate) fn street_identity(street: &Value) -> String {
    let text = |key: &str| street[key].as_str().unwrap_or("").to_owned();
    let number = |key: &str| {
        js_string(
            street
                .get(key)
                .filter(|v| !v.is_null())
                .map_or(-1.0, |v| match v {
                    Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                    Value::String(s) => policy::js_number(s),
                    Value::Bool(b) => f64::from(u8::from(*b)),
                    _ => f64::NAN,
                }),
        )
    };
    [
        text("schemaVersion"),
        text("sourceModel"),
        text("sourceFingerprint"),
        number("sourceBytes"),
        number("nodeCount"),
        number("edgeCount"),
    ]
    .join("|")
}

impl AccessStore {
    /// Build the coordinate-access (`coordinate-access-v11`) or stop-transfer
    /// (`stop-transfer-v3`) profile. Coordinate access also prepares station
    /// paths and persists the access context, as the compiler does.
    pub fn access_profile(
        &mut self,
        version: &str,
        street_identity: &str,
    ) -> Result<AccessProfile> {
        let coordinate_access = version.starts_with("coordinate-access");
        let stop_transfer = version.starts_with("stop-transfer");
        let entrance_stations: HashSet<&str> = self
            .station_members
            .iter()
            .filter(|(_, ids)| {
                ids.iter()
                    .any(|id| self.stop(id).is_some_and(|s| s.location_number() == 2.0))
                    && ids
                        .iter()
                        .any(|id| self.declared_pathway_stops.contains(id))
            })
            .map(|(id, _)| id.as_str())
            .collect();
        let mut members = vec![];
        let (mut member_lons, mut member_lats) = (vec![], vec![]);
        let (mut origin, mut destination) = (vec![], vec![]);
        let (mut anchor_lons, mut anchor_lats) = (vec![], vec![]);
        let mut anchor_offsets = vec![0u32];
        let mut anchor_members = vec![];
        for (i, stop) in self.stops.iter().enumerate() {
            let coordinate = stop.coordinate();
            let location = stop.location();
            let interior = location == 3.0 || location == 4.0;
            if location == 1.0 || (coordinate.is_none() && (!interior || !coordinate_access)) {
                continue;
            }
            let origin_eligible = self.index.departure_service.contains(&stop.id);
            let destination_eligible = self.index.arrival_service.contains(&stop.id);
            let entrance = stop_transfer && stop.location_number() == 2.0;
            if !origin_eligible
                && !destination_eligible
                && (location == 0.0 || (stop_transfer && !entrance))
            {
                continue;
            }
            let member = members.len() as u32;
            members.push(i);
            member_lons.push(coordinate.map_or(0.0, |c| c.0));
            member_lats.push(coordinate.map_or(0.0, |c| c.1));
            origin.push(u32::from(origin_eligible || entrance));
            destination.push(u32::from(destination_eligible || entrance));
            if stop.wheelchair_boarding.is_none_or(|w| w == 1.0)
                && (location == 2.0
                    || (location == 0.0
                        && !stop
                            .parent_station
                            .as_str()
                            .is_some_and(|p| entrance_stations.contains(p))))
            {
                let (lon, lat) = stop.packed();
                anchor_lons.push(lon);
                anchor_lats.push(lat);
                anchor_members.push(member);
                anchor_offsets.push(anchor_members.len() as u32);
            }
        }
        let key = [
            version.to_owned(),
            encode_uri_component(&self.source_artifact_identity),
            encode_uri_component(street_identity),
            members.len().to_string(),
            anchor_lons.len().to_string(),
            encode_uri_component(&POLICY.identity),
        ]
        .join(":");
        let mut input = crate::AccessProfileInput {
            profile_key: key.clone(),
            anchor_lons,
            anchor_lats,
            anchor_member_offsets: anchor_offsets,
            anchor_member_indices: anchor_members,
            member_lons,
            member_lats,
            member_origin_eligible: origin.clone(),
            member_destination_eligible: destination.clone(),
            member_origin_expansion_eligible: None,
            member_destination_expansion_eligible: None,
            member_stop_keys: None,
            member_station_keys: None,
            stop_lons: None,
            stop_lats: None,
            transfer_from_stop_keys: None,
            transfer_to_stop_keys: None,
            transfer_to_station_keys: None,
            transfer_min_durations: None,
            transfer_osm_certified: None,
            transfer_path_distances_m: None,
            walking_speed_kph: Some(POLICY.walking_speed_kph),
            access_padding_factor: Some(POLICY.access_padding_factor),
            access_overhead_seconds: Some(POLICY.access_overhead_seconds),
            prepare_cch_buckets: None,
        };
        if coordinate_access {
            self.prepare_station_paths(&members)?;
            self.persist()?;
            let paths = &self.station_paths.as_ref().expect("station paths").result;
            let keys: Vec<u32> = (0..members.len() as u32).collect();
            input.member_stop_keys = Some(keys.clone());
            input.member_station_keys = Some(keys);
            input.member_origin_expansion_eligible = Some(origin);
            input.member_destination_expansion_eligible = Some(destination);
            input.member_origin_eligible = vec![1; members.len()];
            input.member_destination_eligible = vec![1; members.len()];
            input.transfer_from_stop_keys = Some(paths.from.to_vec());
            input.transfer_to_stop_keys = Some(paths.to.to_vec());
            input.transfer_to_station_keys = Some(paths.to.to_vec());
            input.transfer_min_durations =
                Some(paths.seconds.iter().map(|&s| to_uint32(s)).collect());
            input.transfer_path_distances_m = Some(paths.distance_m.to_vec());
            input.transfer_osm_certified = Some(vec![0; paths.from.len()]);
        }
        Ok(AccessProfile {
            key,
            members,
            input,
        })
    }
}
