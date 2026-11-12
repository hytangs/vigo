//! GTFS-Flex catalogs (gtfs/flex.mjs). Optional service semantics kept
//! beside scheduled connections in a fixed 32 MiB budget: fixed-route trips
//! leave the catalog first, then on-demand trips.

use super::import::FeedReader;
use super::{V, check_bindable};
use crate::jsval::{self, JsMap, trim, truthy};
use crate::zip::Row;
use crate::{Error, Result};
use rusqlite::{Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use vigo_format::js::Js;

const FLEX_CATALOG_LIMIT_BYTES: usize = 32 * 1024 * 1024;
static NULL: Js = Js::Null;

pub(crate) struct FlexInput<'a, 'r> {
    pub reader: &'a mut FeedReader<'r>,
    pub db: &'a Connection,
    pub prefix: &'a str,
    pub windows: Vec<Option<String>>,
    pub on_demand: &'a HashSet<Option<String>>,
    pub trip_models: &'a HashMap<Option<String>, Js>,
    pub continuous_present: bool,
}

pub(crate) struct FlexOutcome {
    pub omitted_fixed: usize,
    pub omitted_on_demand: usize,
}

#[derive(Clone)]
struct Call {
    sequence: f64,
    continuous_pickup: f64,
    continuous_dropoff: f64,
    shape_distance: Option<f64>,
    location: String,
    start: Option<f64>,
    end: Option<f64>,
    window: bool,
    pickup: f64,
    dropoff: f64,
    pickup_booking: Option<String>,
    dropoff_booking: Option<String>,
}

impl Call {
    fn js(&self) -> Js {
        Js::object()
            .with("sequence", self.sequence)
            .with("continuousPickup", self.continuous_pickup)
            .with("continuousDropoff", self.continuous_dropoff)
            .with("shapeDistance", self.shape_distance)
            .with("location", self.location.clone())
            .with("start", self.start)
            .with("end", self.end)
            .with("window", self.window)
            .with("pickup", self.pickup)
            .with("dropoff", self.dropoff)
            .with("pickupBooking", self.pickup_booking.clone())
            .with("dropoffBooking", self.dropoff_booking.clone())
    }
}

struct Trip {
    base: Vec<(String, Js)>,
    calls: Vec<Call>,
    on_demand: Option<bool>,
}

impl Trip {
    fn field(&self, key: &str) -> Option<&Js> {
        self.base.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn js(&self) -> Js {
        let mut members = self.base.clone();
        members.push((
            "calls".into(),
            Js::Array(self.calls.iter().map(Call::js).collect()),
        ));
        if let Some(on_demand) = self.on_demand {
            members.push(("onDemand".into(), Js::Bool(on_demand)));
        }
        jsval::object(members)
    }
    fn shape_id(&self) -> Option<String> {
        match self.field("shapeId") {
            Some(Js::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    }
    fn trip_id(&self) -> Option<String> {
        self.field("trip_id")
            .and_then(Js::as_str)
            .map(str::to_owned)
    }
}

fn size_of(value: &Js) -> usize {
    value.stringify().len() + 16
}

/// `{ seconds }` of `/^(\d{1,3}):([0-5]\d):([0-5]\d)$/`.
fn seconds(value: Option<&str>) -> Option<f64> {
    let text = value.unwrap_or("");
    let mut parts = text.split(':');
    let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !(1..=3).contains(&h.len()) || m.len() != 2 || s.len() != 2 {
        return None;
    }
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if !digits(h) || !digits(m) || !digits(s) || m.as_bytes()[0] > b'5' || s.as_bytes()[0] > b'5' {
        return None;
    }
    Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?)
}

/// `continuous(value)`: null for absent or blank, otherwise 0..3.
fn continuous(value: Option<&str>) -> Result<Option<f64>> {
    let Some(text) = value else { return Ok(None) };
    if trim(text).is_empty() {
        return Ok(None);
    }
    let number = jsval::to_number(text);
    if ![0.0, 1.0, 2.0, 3.0].contains(&number) {
        return Err(Error::new("Invalid GTFS continuous stopping permission"));
    }
    Ok(Some(number))
}

fn truthy_text(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

fn row_object(row: &Row) -> Js {
    jsval::object(
        row.keys()
            .into_iter()
            .map(|key| (key.to_owned(), Js::from(row.get(key).unwrap_or(""))))
            .collect(),
    )
}

fn exists(db: &Connection, sql: &str, params: &[V]) -> Result<bool> {
    check_bindable(params)?;
    Ok(db
        .query_row(sql, rusqlite::params_from_iter(params.iter()), |_| Ok(()))
        .optional()?
        .is_some())
}

fn is_valid_time_of_day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 8
        && b[2] == b':'
        && b[5] == b':'
        && matches!(
            (b[0], b[1]),
            (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
        )
        && (b'0'..=b'5').contains(&b[3])
        && b[4].is_ascii_digit()
        && (b'0'..=b'5').contains(&b[6])
        && b[7].is_ascii_digit()
}

/// Budget accounting shared by catalog members and trips.
struct Budget {
    shared: usize,
    on_demand_bytes: usize,
    fixed: usize,
    fixed_omitted: bool,
    on_demand_omitted: bool,
}

impl Budget {
    fn total(&self) -> usize {
        self.shared + self.on_demand_bytes + self.fixed
    }
    fn retain(&mut self, value: &Js) -> Result<()> {
        self.shared += size_of(value);
        if self.shared > FLEX_CATALOG_LIMIT_BYTES {
            return Err(Error::new(
                "GTFS Flex location and booking definitions exceed 32 MiB",
            ));
        }
        Ok(())
    }
    fn omitted(&self, id: &Option<String>, on_demand: &HashSet<Option<String>>) -> bool {
        self.on_demand_omitted || (self.fixed_omitted && !on_demand.contains(id))
    }
}

struct Catalog {
    groups: JsMap<(Js, Vec<String>)>,
    locations: JsMap<Js>,
    bookings: JsMap<Js>,
    trips: JsMap<Trip>,
    shapes: HashMap<String, Vec<[Option<f64>; 4]>>,
    shape_order: Vec<String>,
    shape_owners: Vec<(String, Option<String>)>,
}

fn omit_next(catalog: &mut Catalog, budget: &mut Budget, on_demand: &HashSet<Option<String>>) {
    if budget.fixed_omitted {
        budget.on_demand_omitted = true;
    }
    budget.fixed_omitted = true;
    for id in catalog.trips.keys() {
        if budget.omitted(&Some(id.clone()), on_demand) {
            catalog.trips.remove(&id);
        }
    }
    for (shape, owner) in &catalog.shape_owners {
        if budget.omitted(owner, on_demand) {
            catalog.shapes.remove(shape);
        }
    }
    budget.fixed = 0;
    if budget.on_demand_omitted {
        budget.on_demand_bytes = 0;
    }
}

fn retain_trip(
    catalog: &mut Catalog,
    budget: &mut Budget,
    on_demand: &HashSet<Option<String>>,
    id: &Option<String>,
    value: &Js,
) -> bool {
    if budget.omitted(id, on_demand) {
        return false;
    }
    if on_demand.contains(id) {
        budget.on_demand_bytes += size_of(value);
    } else {
        budget.fixed += size_of(value);
    }
    while budget.total() > FLEX_CATALOG_LIMIT_BYTES {
        omit_next(catalog, budget, on_demand);
    }
    !budget.omitted(id, on_demand)
}

fn unique<T>(
    map: &mut JsMap<T>,
    id: Option<&str>,
    budget: &mut Budget,
    value: T,
    sized: &Js,
) -> Result<()> {
    let Some(id) = id.filter(|id| !id.is_empty() && !map.contains_key(id)) else {
        return Err(Error::new(format!(
            "Missing or duplicate GTFS Flex identity: {}",
            id.unwrap_or("undefined")
        )));
    };
    budget.retain(&Js::from(id))?;
    budget.retain(sized)?;
    map.insert(id.to_owned(), value);
    Ok(())
}

fn finite_number(value: &Js) -> Option<f64> {
    match value {
        Js::Number(n) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn validate_polygons(geometry: &Js) -> Result<()> {
    let kind = geometry.get("type").and_then(Js::as_str);
    let coordinates = geometry.get("coordinates");
    let polygons: Vec<&Js> = match (kind, coordinates) {
        (Some("Polygon"), Some(value)) => vec![value],
        (Some("Polygon"), None) => vec![&NULL],
        (Some("MultiPolygon"), Some(Js::Array(items))) => items.iter().collect(),
        _ => return Err(Error::new("Empty GTFS location geometry")),
    };
    if polygons.is_empty() {
        return Err(Error::new("Empty GTFS location geometry"));
    }
    for polygon in polygons {
        let Js::Array(rings) = polygon else {
            return Err(Error::new("Empty GTFS polygon"));
        };
        if rings.is_empty() {
            return Err(Error::new("Empty GTFS polygon"));
        }
        for ring in rings {
            let invalid = || Error::new("Invalid GTFS polygon ring");
            let Js::Array(points) = ring else {
                return Err(invalid());
            };
            if points.len() < 4 {
                return Err(invalid());
            }
            for point in points {
                let Js::Array(p) = point else {
                    return Err(invalid());
                };
                if p.len() < 2 {
                    return Err(invalid());
                }
                let (Some(x), Some(y)) = (finite_number(&p[0]), finite_number(&p[1])) else {
                    return Err(invalid());
                };
                if x.abs() > 180.0 || y.abs() > 90.0 {
                    return Err(invalid());
                }
            }
            let first = match &points[0] {
                Js::Array(p) => p,
                _ => unreachable!(),
            };
            let last = match &points[points.len() - 1] {
                Js::Array(p) => p,
                _ => unreachable!(),
            };
            if first[0] != last[0] || first[1] != last[1] {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

/// `importFlexCatalog(...)`.
pub(crate) fn import_flex_catalog(input: FlexInput) -> Result<FlexOutcome> {
    let FlexInput {
        reader,
        db,
        prefix,
        mut windows,
        on_demand,
        trip_models,
        continuous_present,
    } = input;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS flex_catalog(scope TEXT PRIMARY KEY, data TEXT NOT NULL);",
    )?;
    let mut window_set: HashSet<Option<String>> = windows.iter().cloned().collect();
    let mut budget = Budget {
        shared: 0,
        on_demand_bytes: 0,
        fixed: 0,
        fixed_omitted: false,
        on_demand_omitted: false,
    };
    let mut catalog = Catalog {
        groups: JsMap::new(),
        locations: JsMap::new(),
        bookings: JsMap::new(),
        trips: JsMap::new(),
        shapes: HashMap::new(),
        shape_order: Vec::new(),
        shape_owners: Vec::new(),
    };

    reader.stream_table("location_groups.txt", &mut |row| {
        let value = Js::object()
            .with(
                "name",
                jsval::or_null(row.get("location_group_name")).unwrap_or(""),
            )
            .with("stops", Js::Array(Vec::new()));
        let name = Js::from(jsval::or_null(row.get("location_group_name")).unwrap_or(""));
        unique(
            &mut catalog.groups,
            row.get("location_group_id"),
            &mut budget,
            (name, Vec::new()),
            &value,
        )
    })?;
    reader.stream_table("location_group_stops.txt", &mut |row| {
        let key = row
            .get("location_group_id")
            .unwrap_or("undefined")
            .to_owned();
        let known = catalog.groups.contains_key(&key)
            && exists(
                db,
                "SELECT 1 FROM stops WHERE stop_id=? AND COALESCE(location_type,0)=0",
                &[V::field(row.get("stop_id"))],
            )?;
        if !known {
            return Err(Error::new("Broken GTFS location-group stop reference"));
        }
        let stop = row.get("stop_id").unwrap_or("").to_owned();
        let group = catalog.groups.get_mut(&key).unwrap();
        if !group.1.contains(&stop) {
            budget.retain(&Js::from(stop.as_str()))?;
            group.1.push(stop);
        }
        Ok(())
    })?;
    reader.stream_table("booking_rules.txt", &mut |row| {
        let booking_type = jsval::number(row.get("booking_type"));
        if jsval::trimmed(row.get("booking_type")).is_empty() || ![0.0, 1.0, 2.0].contains(&booking_type) {
            return Err(Error::new("Invalid GTFS booking_type"));
        }
        for field in ["prior_notice_duration_min", "prior_notice_duration_max", "prior_notice_last_day", "prior_notice_start_day"] {
            if truthy_text(row.get(field)) {
                let value = jsval::number(row.get(field));
                if !jsval::is_safe_integer(value) || value < 0.0 {
                    return Err(Error::new(format!("Invalid GTFS {field}")));
                }
            }
        }
        for field in ["prior_notice_last_time", "prior_notice_start_time"] {
            if truthy_text(row.get(field)) && !is_valid_time_of_day(row.get(field).unwrap()) {
                return Err(Error::new(format!("Invalid GTFS {field}")));
            }
        }
        if truthy_text(row.get("prior_notice_duration_min"))
            && truthy_text(row.get("prior_notice_duration_max"))
            && jsval::number(row.get("prior_notice_duration_max")) < jsval::number(row.get("prior_notice_duration_min"))
        {
            return Err(Error::new("GTFS maximum notice precedes minimum notice"));
        }
        if truthy_text(row.get("prior_notice_service_id")) {
            let id = row.get("prior_notice_service_id");
            if !exists(
                db,
                "SELECT 1 FROM calendar WHERE service_id=? UNION SELECT 1 FROM calendar_dates WHERE service_id=?",
                &[V::field(id), V::field(id)],
            )? {
                return Err(Error::new("Unknown GTFS booking notice service"));
            }
        }
        if booking_type == 1.0 && jsval::trimmed(row.get("prior_notice_duration_min")).is_empty() {
            return Err(Error::new("Same-day GTFS booking requires minimum notice"));
        }
        if booking_type == 2.0
            && (jsval::trimmed(row.get("prior_notice_last_day")).is_empty() || !truthy_text(row.get("prior_notice_last_time")))
        {
            return Err(Error::new("Prior-day GTFS booking requires a deadline"));
        }
        let value = row_object(row);
        unique(&mut catalog.bookings, row.get("booking_rule_id"), &mut budget, value.clone(), &value)
    })?;
    let archive = reader.archive;
    if let Some(entry) = archive.table("locations.geojson") {
        let geojson = archive.read_json(entry, 32 * 1024 * 1024)?;
        let features = match (
            geojson.get("type").and_then(Js::as_str),
            geojson.get("features"),
        ) {
            (Some("FeatureCollection"), Some(Js::Array(features))) => features,
            _ => return Err(Error::new("GTFS locations must be a FeatureCollection")),
        };
        for feature in features {
            let id = feature.get("id").and_then(Js::as_str);
            let geometry = feature.get("geometry");
            let kind = geometry.and_then(|g| g.get("type")).and_then(Js::as_str);
            if feature.get("type").and_then(Js::as_str) != Some("Feature")
                || id.is_none_or(|id| trim(id).is_empty())
                || !matches!(kind, Some("Polygon" | "MultiPolygon"))
            {
                return Err(Error::new("Invalid GTFS location geometry"));
            }
            let geometry = geometry.unwrap();
            validate_polygons(geometry)?;
            let name = feature
                .get("properties")
                .and_then(|p| p.get("stop_name"))
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(Js::from(""));
            let value = Js::object()
                .with("name", name)
                .with("geometry", geometry.clone());
            let key = format!("{prefix}{}", id.unwrap());
            unique(
                &mut catalog.locations,
                Some(&key),
                &mut budget,
                value.clone(),
                &value,
            )?;
        }
    }
    let group_ids = catalog.groups.keys();
    let location_ids = catalog.locations.keys();
    for id in group_ids.iter().chain(location_ids.iter()) {
        if exists(db, "SELECT 1 FROM stops WHERE stop_id=?", &[V::Text(id)])?
            || (catalog.groups.contains_key(id) && catalog.locations.contains_key(id))
        {
            return Err(Error::new(
                "GTFS Flex locations must have globally unique IDs",
            ));
        }
    }

    let mut routes: HashMap<Option<String>, (f64, f64)> = HashMap::new();
    let mut models: HashMap<Option<String>, Vec<(String, Js)>> = HashMap::new();
    if continuous_present {
        reader.stream_table("routes.txt", &mut |row| {
            let pickup = continuous(row.get("continuous_pickup"))?.unwrap_or(1.0);
            let dropoff = continuous(row.get("continuous_drop_off"))?.unwrap_or(1.0);
            routes.insert(row.get("route_id").map(str::to_owned), (pickup, dropoff));
            Ok(())
        })?;
        reader.stream_table("trips.txt", &mut |row| {
            let mut model = Vec::new();
            let route = routes.get(&row.get("route_id").map(str::to_owned));
            if let Some((pickup, dropoff)) = route {
                model.push(("continuousPickup".to_owned(), Js::from(*pickup)));
                model.push(("continuousDropoff".to_owned(), Js::from(*dropoff)));
            }
            model.push((
                "shapeId".to_owned(),
                jsval::or_null(row.get("shape_id")).map_or(Js::Null, Js::from),
            ));
            let id = row.get("trip_id").map(str::to_owned);
            // An unknown route leaves both permissions undefined, which is not 1.
            if route.is_none_or(|(p, d)| *p != 1.0 || *d != 1.0) && window_set.insert(id.clone()) {
                windows.push(id.clone());
            }
            models.insert(id, model);
            Ok(())
        })?;
        reader.stream_table("stop_times.txt", &mut |row| {
            let pickup = continuous(row.get("continuous_pickup"))?;
            let dropoff = continuous(row.get("continuous_drop_off"))?;
            if [pickup, dropoff]
                .iter()
                .any(|v| v.is_some_and(|v| v != 1.0))
            {
                let id = row.get("trip_id").map(str::to_owned);
                if window_set.insert(id.clone()) {
                    windows.push(id);
                }
            }
            Ok(())
        })?;
    }

    if !window_set.is_empty() {
        let mut trip_lookup = db.prepare("SELECT * FROM trips WHERE trip_id=?")?;
        let column_names: Vec<String> = trip_lookup.column_names().map(str::to_owned).collect();
        let mut frequency_lookup = db.prepare("SELECT 1 FROM frequencies WHERE trip_id=?")?;
        let mut stop_lookup =
            db.prepare("SELECT 1 FROM stops WHERE stop_id=? AND COALESCE(location_type,0)=0")?;
        reader.stream_table("stop_times.txt", &mut |row| {
            let trip_key = row.get("trip_id").map(str::to_owned);
            if !window_set.contains(&trip_key) {
                return Ok(());
            }
            check_bindable(&[V::field(row.get("trip_id"))])?;
            let trip_id = row.get("trip_id").unwrap();
            let trip: Option<Vec<(String, Js)>> = trip_lookup
                .query_row([trip_id], |r| {
                    let mut members = Vec::new();
                    for (index, name) in column_names.iter().enumerate() {
                        let value = match r.get_ref(index)? {
                            rusqlite::types::ValueRef::Null => Js::Null,
                            rusqlite::types::ValueRef::Integer(n) => Js::from(n as f64),
                            rusqlite::types::ValueRef::Real(n) => Js::from(n),
                            rusqlite::types::ValueRef::Text(t) => {
                                Js::from(String::from_utf8_lossy(t).into_owned())
                            }
                            rusqlite::types::ValueRef::Blob(_) => Js::Null,
                        };
                        members.push((name.clone(), value));
                    }
                    Ok(members)
                })
                .optional()?;
            let window_row = truthy_text(row.get("location_id"))
                || truthy_text(row.get("location_group_id"))
                || truthy_text(row.get("start_pickup_drop_off_window"))
                || truthy_text(row.get("end_pickup_drop_off_window"));
            if frequency_lookup
                .query_row([trip_id], |_| Ok(()))
                .optional()?
                .is_some()
            {
                if window_row {
                    return Err(Error::new(
                        "GTFS Flex windows cannot be combined with frequencies",
                    ));
                }
                return Ok(());
            }
            let Some(trip) = trip else {
                return Err(Error::new("Unknown GTFS Flex trip"));
            };
            let ids: Vec<&str> = ["stop_id", "location_group_id", "location_id"]
                .iter()
                .filter_map(|field| row.get(field).filter(|v| !v.is_empty()))
                .collect();
            if ids.len() != 1 {
                return Err(Error::new(
                    "GTFS Flex call must reference exactly one location",
                ));
            }
            let id = ids[0];
            let known = catalog.groups.contains_key(id)
                || catalog.locations.contains_key(id)
                || stop_lookup
                    .query_row([id], |_| Ok(()))
                    .optional()?
                    .is_some();
            if !known {
                return Err(Error::new(format!("Unknown GTFS Flex location: {id}")));
            }
            let start = seconds(row.get("start_pickup_drop_off_window"));
            let end = seconds(row.get("end_pickup_drop_off_window"));
            let window = truthy_text(row.get("start_pickup_drop_off_window"))
                || truthy_text(row.get("end_pickup_drop_off_window"));
            if !window
                && (truthy_text(row.get("location_id"))
                    || truthy_text(row.get("location_group_id")))
            {
                return Err(Error::new(
                    "GTFS Flex zones and groups require time windows",
                ));
            }
            if window
                && (start.is_none()
                    || end.is_none()
                    || end <= start
                    || truthy_text(row.get("arrival_time"))
                    || truthy_text(row.get("departure_time")))
            {
                return Err(Error::new("Invalid GTFS Flex service window"));
            }
            let permission =
                |field: &str| jsval::to_number(jsval::or_null(row.get(field)).unwrap_or("0"));
            let pickup = permission("pickup_type");
            let dropoff = permission("drop_off_type");
            if ![0.0, 1.0, 2.0, 3.0].contains(&pickup)
                || ![0.0, 1.0, 2.0, 3.0].contains(&dropoff)
                || (window
                    && (![1.0, 2.0].contains(&pickup) || ![1.0, 2.0, 3.0].contains(&dropoff)))
            {
                return Err(Error::new("Invalid GTFS Flex pickup/drop-off permissions"));
            }
            for field in ["pickup_booking_rule_id", "drop_off_booking_rule_id"] {
                if let Some(rule) = row.get(field).filter(|v| !v.is_empty())
                    && !catalog.bookings.contains_key(rule)
                {
                    return Err(Error::new("Unknown GTFS Flex booking rule"));
                }
            }
            let sequence = jsval::number(row.get("stop_sequence"));
            if jsval::trimmed(row.get("stop_sequence")).is_empty()
                || !jsval::is_safe_integer(sequence)
                || sequence < 0.0
            {
                return Err(Error::new("Invalid GTFS Flex stop sequence"));
            }
            let existing = catalog.trips.contains_key(trip_id);
            let fresh = if existing {
                None
            } else {
                let mut base = trip;
                let mut spread = |members: &[(String, Js)]| {
                    for (key, value) in members {
                        match base.iter_mut().find(|(k, _)| k == key) {
                            Some(member) => member.1 = value.clone(),
                            None => base.push((key.clone(), value.clone())),
                        }
                    }
                };
                if let Some(Js::Object(model)) = trip_models.get(&trip_key) {
                    spread(model);
                }
                if let Some(model) = models.get(&trip_key) {
                    spread(model);
                }
                Some(Trip {
                    base,
                    calls: Vec::new(),
                    on_demand: None,
                })
            };
            let record = if existing {
                catalog.trips.get(trip_id).unwrap()
            } else {
                fresh.as_ref().unwrap()
            };
            if record.calls.iter().any(|c| c.sequence == sequence) {
                return Err(Error::new("Duplicate GTFS Flex stop sequence"));
            }
            let record_number = |key: &str| match record.field(key) {
                Some(Js::Number(n)) => Some(*n),
                _ => None,
            };
            let continuous_pickup = continuous(row.get("continuous_pickup"))?
                .or(record_number("continuousPickup"))
                .unwrap_or(1.0);
            let continuous_dropoff = continuous(row.get("continuous_drop_off"))?
                .or(record_number("continuousDropoff"))
                .unwrap_or(1.0);
            if window && (continuous_pickup != 1.0 || continuous_dropoff != 1.0) {
                return Err(Error::new(
                    "GTFS Flex windows cannot have continuous stopping",
                ));
            }
            let shape_distance =
                jsval::or_null(row.get("shape_dist_traveled")).map(jsval::to_number);
            if shape_distance.is_some_and(|d| !d.is_finite() || d < 0.0) {
                return Err(Error::new("Invalid shape distance"));
            }
            let first_of =
                |a: &str, b: &str| jsval::or_null(row.get(a)).or(jsval::or_null(row.get(b)));
            let call = Call {
                sequence,
                continuous_pickup,
                continuous_dropoff,
                shape_distance,
                location: id.to_owned(),
                start: if window {
                    start
                } else {
                    seconds(first_of("departure_time", "arrival_time"))
                },
                end: if window {
                    end
                } else {
                    seconds(first_of("arrival_time", "departure_time"))
                },
                window,
                pickup,
                dropoff,
                pickup_booking: jsval::or_null(row.get("pickup_booking_rule_id"))
                    .map(str::to_owned),
                dropoff_booking: jsval::or_null(row.get("drop_off_booking_rule_id"))
                    .map(str::to_owned),
            };
            let sized = if existing {
                call.js()
            } else {
                Js::object()
                    .with("record", fresh.as_ref().unwrap().js())
                    .with("call", call.js())
            };
            if !retain_trip(&mut catalog, &mut budget, on_demand, &trip_key, &sized) {
                return Ok(());
            }
            match fresh {
                Some(mut record) => {
                    record.calls.push(call);
                    catalog.trips.insert(trip_id.to_owned(), record);
                }
                None => catalog.trips.get_mut(trip_id).unwrap().calls.push(call),
            }
            Ok(())
        })?;
    }
    for id in catalog.trips.keys() {
        let trip = catalog.trips.get(&id).unwrap();
        if trip
            .calls
            .iter()
            .any(|c| c.continuous_pickup != 1.0 || c.continuous_dropoff != 1.0)
        {
            let Some(shape) = trip.shape_id() else {
                return Err(Error::new("GTFS continuous stopping requires a shape"));
            };
            if !catalog.shapes.contains_key(&shape) {
                catalog.shape_order.push(shape.clone());
            }
            catalog.shapes.insert(shape.clone(), Vec::new());
            let owner = trip.trip_id();
            let on_demand_owner = on_demand.contains(&owner);
            match catalog.shape_owners.iter_mut().find(|(s, _)| *s == shape) {
                Some(entry) if on_demand_owner => entry.1 = owner,
                Some(_) => {}
                None => catalog.shape_owners.push((shape, owner)),
            }
        }
    }
    if !catalog.shapes.is_empty() {
        reader.stream_table("shapes.txt", &mut |row| {
            let Some(shape) = row.get("shape_id").map(str::to_owned) else {
                return Ok(());
            };
            if !catalog.shapes.contains_key(&shape) {
                return Ok(());
            }
            let point = [
                jsval::number(row.get("shape_pt_lon")),
                jsval::number(row.get("shape_pt_lat")),
                jsval::number(row.get("shape_pt_sequence")),
            ];
            let distance = jsval::or_null(row.get("shape_dist_traveled")).map(jsval::to_number);
            if !point.iter().all(|v| v.is_finite())
                || point[0].abs() > 180.0
                || point[1].abs() > 90.0
                || distance.is_some_and(|d| !d.is_finite() || d < 0.0)
            {
                return Err(Error::new("Invalid continuous stopping shape"));
            }
            let value = Js::Array(vec![
                Js::from(point[0]),
                Js::from(point[1]),
                Js::from(point[2]),
                Js::from(distance),
            ]);
            let owner = catalog
                .shape_owners
                .iter()
                .find(|(s, _)| *s == shape)
                .map(|(_, o)| o.clone())
                .unwrap_or(None);
            if retain_trip(&mut catalog, &mut budget, on_demand, &owner, &value)
                && let Some(points) = catalog.shapes.get_mut(&shape)
            {
                points.push([Some(point[0]), Some(point[1]), Some(point[2]), distance]);
            }
            Ok(())
        })?;
    }
    for points in catalog.shapes.values_mut() {
        points.sort_by(|a, b| {
            a[2].unwrap()
                .partial_cmp(&b[2].unwrap())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let invalid = points.len() < 2
            || points.windows(2).any(|pair| {
                pair[1][2] == pair[0][2]
                    || matches!((pair[1][3], pair[0][3]), (Some(b), Some(a)) if b < a)
            });
        if invalid {
            return Err(Error::new("Invalid continuous stopping shape order"));
        }
    }
    for id in catalog.trips.keys() {
        let trip = catalog.trips.get_mut(&id).unwrap();
        trip.calls.sort_by(|a, b| {
            a.sequence
                .partial_cmp(&b.sequence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let on_demand_trip = trip.calls.iter().any(|c| c.window);
        trip.on_demand = Some(on_demand_trip);
        if on_demand_trip
            && trip
                .calls
                .iter()
                .any(|c| c.start.is_none() || c.end.is_none())
        {
            return Err(Error::new(
                "GTFS Flex trip needs timed fixed calls or windows",
            ));
        }
        trip.calls.retain(|c| c.start.is_some() && c.end.is_some());
        if trip.calls.len() < 2 {
            catalog.trips.remove(&id);
        }
    }
    let serialize = |catalog: &Catalog| -> String {
        let mut shapes: Vec<(String, Js)> = Vec::new();
        for id in catalog.trips.keys() {
            let trip = catalog.trips.get(&id).unwrap();
            if let Some(shape) = trip.shape_id()
                && let Some(points) = catalog.shapes.get(&shape)
            {
                let value = Js::Array(
                    points
                        .iter()
                        .map(|p| Js::Array(p.iter().map(|v| Js::from(*v)).collect()))
                        .collect(),
                );
                match shapes.iter_mut().find(|(k, _)| *k == shape) {
                    Some(member) => member.1 = value,
                    None => shapes.push((shape, value)),
                }
            }
        }
        let map = |keys: Vec<String>, value: &dyn Fn(&str) -> Js| {
            jsval::object(
                keys.into_iter()
                    .map(|k| {
                        let v = value(&k);
                        (k, v)
                    })
                    .collect(),
            )
        };
        Js::object()
            .with(
                "groups",
                map(catalog.groups.keys(), &|k| {
                    let (name, stops) = catalog.groups.get(k).unwrap();
                    Js::object()
                        .with("name", name.clone())
                        .with("stops", stops.clone())
                }),
            )
            .with(
                "locations",
                map(catalog.locations.keys(), &|k| {
                    catalog.locations.get(k).unwrap().clone()
                }),
            )
            .with(
                "bookings",
                map(catalog.bookings.keys(), &|k| {
                    catalog.bookings.get(k).unwrap().clone()
                }),
            )
            .with(
                "trips",
                map(catalog.trips.keys(), &|k| {
                    catalog.trips.get(k).unwrap().js()
                }),
            )
            .with("shapes", jsval::object(shapes))
            .stringify()
    };
    let mut data = serialize(&catalog);
    while data.len() > FLEX_CATALOG_LIMIT_BYTES && !budget.on_demand_omitted {
        omit_next(&mut catalog, &mut budget, on_demand);
        data = serialize(&catalog);
    }
    if data.len() > FLEX_CATALOG_LIMIT_BYTES {
        return Err(Error::new(
            "GTFS Flex location and booking definitions exceed 32 MiB",
        ));
    }
    if !catalog.trips.is_empty() {
        db.execute(
            "INSERT INTO flex_catalog VALUES(?,?)",
            rusqlite::params![prefix, data],
        )?;
    }
    let omitted: Vec<&Option<String>> = windows
        .iter()
        .filter(|id| budget.omitted(id, on_demand))
        .collect();
    Ok(FlexOutcome {
        omitted_fixed: omitted.iter().filter(|id| !on_demand.contains(id)).count(),
        omitted_on_demand: omitted.iter().filter(|id| on_demand.contains(id)).count(),
    })
}

fn js_string(value: &Js) -> String {
    match value {
        Js::String(s) => s.clone(),
        Js::Null => "null".into(),
        Js::Bool(b) => b.to_string(),
        Js::Number(n) => vigo_format::js::number(*n).replace("null", "NaN"),
        Js::Array(items) => items
            .iter()
            .map(|v| {
                if matches!(v, Js::Null) {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Object(_) => "[object Object]".into(),
    }
}

fn prefixed(prefix: &str, value: &Js) -> Js {
    Js::from(format!("{prefix}{}", js_string(value)))
}

fn prefix_keys(prefix: &str, value: Option<&Js>) -> Js {
    match value {
        Some(Js::Object(members)) => jsval::object(
            members
                .iter()
                .map(|(k, v)| (format!("{prefix}{k}"), v.clone()))
                .collect(),
        ),
        Some(other) => other.clone(),
        None => Js::object(),
    }
}

fn update_members(value: &mut Js, update: &mut dyn FnMut(&mut Js)) {
    if let Js::Object(members) = value {
        for (_, member) in members.iter_mut() {
            update(member);
        }
    }
}

/// `copyFlexCatalogs(db, alias, prefix)`.
pub(crate) fn copy_flex_catalogs(db: &Connection, alias: &str, prefix: &str) -> Result<()> {
    let present = db
        .query_row(
            &format!("SELECT 1 FROM {alias}.sqlite_master WHERE name='flex_catalog'"),
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !present {
        return Ok(());
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS flex_catalog(scope TEXT PRIMARY KEY, data TEXT NOT NULL)",
    )?;
    let rows: Vec<(String, String)> = db
        .prepare(&format!("SELECT scope,data FROM {alias}.flex_catalog"))?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    for (scope, data) in rows {
        let mut catalog = jsval::parse_json(&data).map_err(Error::new)?;
        let Js::Object(members) = &mut catalog else {
            continue;
        };
        for key in ["groups", "locations", "bookings", "trips"] {
            let renamed = prefix_keys(
                prefix,
                members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            );
            match members.iter_mut().find(|(k, _)| k == key) {
                Some(member) => member.1 = renamed,
                None => members.push((key.to_owned(), renamed)),
            }
        }
        if let Some((_, shapes)) = members.iter_mut().find(|(k, _)| k == "shapes")
            && truthy(shapes)
        {
            *shapes = prefix_keys(prefix, Some(shapes));
        }
        for (key, value) in members.iter_mut() {
            match key.as_str() {
                "groups" => update_members(value, &mut |group| {
                    if let Some(Js::Array(stops)) = group_get_mut(group, "stops") {
                        for stop in stops.iter_mut() {
                            *stop = prefixed(prefix, stop);
                        }
                    }
                }),
                "bookings" => update_members(value, &mut |rule| {
                    for field in ["booking_rule_id", "prior_notice_service_id"] {
                        if let Some(v) = group_get_mut(rule, field)
                            && truthy(v)
                        {
                            *v = prefixed(prefix, v);
                        }
                    }
                }),
                "trips" => update_members(value, &mut |trip| {
                    if let Some(v) = group_get_mut(trip, "shapeId")
                        && truthy(v)
                    {
                        *v = prefixed(prefix, v);
                    }
                    for field in ["trip_id", "route_id", "service_id"] {
                        let current = trip.get(field).cloned();
                        let next = match &current {
                            Some(v) => prefixed(prefix, v),
                            None => Js::from(format!("{prefix}undefined")),
                        };
                        trip.set(field, next);
                    }
                    if let Some(Js::Array(calls)) = group_get_mut(trip, "calls") {
                        for call in calls.iter_mut() {
                            for field in ["location", "pickupBooking", "dropoffBooking"] {
                                if let Some(v) = group_get_mut(call, field)
                                    && truthy(v)
                                {
                                    *v = prefixed(prefix, v);
                                }
                            }
                        }
                    }
                }),
                _ => {}
            }
        }
        db.execute(
            "INSERT INTO flex_catalog VALUES(?,?)",
            rusqlite::params![format!("{prefix}{scope}"), catalog.stringify()],
        )?;
    }
    Ok(())
}

fn group_get_mut<'v>(value: &'v mut Js, key: &str) -> Option<&'v mut Js> {
    match value {
        Js::Object(members) => members.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flex_clock_and_booking_times() {
        assert_eq!(seconds(Some("08:30:15")), Some(30615.0));
        assert_eq!(seconds(Some("125:00:00")), Some(450000.0));
        assert_eq!(seconds(Some("8:60:00")), None);
        assert_eq!(seconds(None), None);
        assert!(is_valid_time_of_day("23:59:59"));
        assert!(!is_valid_time_of_day("24:00:00"));
    }
}
