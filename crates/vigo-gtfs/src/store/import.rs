//! GTFS ZIP import into the routing store (`importGtfsFeed`,
//! `buildNationalGtfsStore`, `buildNationalGtfsCityStore`).

use super::fares::{read_fare_catalog, write_fare_catalog};
use super::flex::{FlexInput, import_flex_catalog};
use super::merge::{link_nearby_transfer_stops, merged_metadata, service_time_bounds};
use super::policy::{
    PathwayCost, TransferCost, WheelchairStop, estimated_pathway_seconds, haversine_km,
    transfer_duration_seconds, wheelchair_boarding_values, wheelchair_description,
    wheelchair_pathway_cost,
};
use super::schema::{assert_no_broken_references, create_indexes, create_schema};
use super::schema_sql::WHEELCHAIR_TABLES;
use super::topology::{build_default_sidecar, publish_with_sidecar, static_topology_sidecar_path};
use super::*;
use crate::jsval::{self, numeric, slice_utf16, trim, trimmed};
use crate::zip::{Archive, Budget, Entry, Row, TableProfile, stream_csv};
use rusqlite::OptionalExtension;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use vigo_format::js::{Js, number as js_number};

const PREFIXED_FIELDS: &[&str] = &[
    "stop_id",
    "route_id",
    "trip_id",
    "service_id",
    "shape_id",
    "block_id",
    "from_stop_id",
    "to_stop_id",
    "from_trip_id",
    "to_trip_id",
    "from_route_id",
    "to_route_id",
    "location_id",
    "location_group_id",
    "booking_rule_id",
    "pickup_booking_rule_id",
    "drop_off_booking_rule_id",
    "prior_notice_service_id",
];

/// Streams tables of one feed, namespacing identifiers with its scope prefix.
pub(crate) struct FeedReader<'a> {
    pub archive: &'a Archive,
    pub prefix: String,
    pub budget: Budget,
}

impl FeedReader<'_> {
    pub fn stream(
        &mut self,
        entry: &Entry,
        progress: Option<&mut dyn FnMut(u64, u64)>,
        on_row: &mut dyn FnMut(&mut Row) -> Result<()>,
    ) -> Result<TableProfile> {
        let prefix = self.prefix.clone();
        stream_csv(
            self.archive,
            entry,
            &mut self.budget,
            progress,
            &mut |row| {
                if !prefix.is_empty() {
                    for field in PREFIXED_FIELDS {
                        if let Some(value) = row.get(field)
                            && !trim(value).is_empty()
                        {
                            let value = format!("{prefix}{value}");
                            row.set(field, value);
                        }
                    }
                    if let Some(parent) = row.get("parent_station")
                        && !parent.is_empty()
                    {
                        let value = format!("{prefix}{parent}");
                        row.set("parent_station", value);
                    }
                }
                on_row(row)
            },
        )
    }

    pub fn stream_table(
        &mut self,
        name: &str,
        on_row: &mut dyn FnMut(&mut Row) -> Result<()>,
    ) -> Result<()> {
        let archive = self.archive;
        if let Some(entry) = archive.table(name) {
            self.stream(entry, None, on_row)?;
        }
        Ok(())
    }
}

fn gtfs_seconds(value: Option<&str>) -> Option<f64> {
    let text = trimmed(value);
    let (hours, rest) = text.split_once(':')?;
    let (minutes, seconds) = rest.split_once(':')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !(1..=3).contains(&hours.len()) || minutes.len() != 2 || seconds.len() != 2 {
        return None;
    }
    if !digits(hours) || !digits(minutes) || !digits(seconds) {
        return None;
    }
    let (h, m, s): (f64, f64, f64) = (
        hours.parse().ok()?,
        minutes.parse().ok()?,
        seconds.parse().ok()?,
    );
    if m > 59.0 || s > 59.0 {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + s)
}

fn context_suffix(context: &str) -> String {
    if context.is_empty() {
        String::new()
    } else {
        format!(" for {context}")
    }
}

/// `requiredGtfsDate(value, field, context)`.
fn required_gtfs_date(value: Option<&str>, field: &str, context: &str) -> Result<f64> {
    let text = trimmed(value);
    let invalid = |shown: &str| {
        Error::new(format!(
            "Invalid GTFS {field}{}: {shown}.",
            context_suffix(context)
        ))
    };
    if text.len() != 8 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid(if text.is_empty() { "(missing)" } else { text }));
    }
    let year: i32 = text[..4].parse().unwrap();
    let month: u32 = text[4..6].parse().unwrap();
    let day: u32 = text[6..8].parse().unwrap();
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    if !(1..=9999).contains(&year) || day == 0 || day > days {
        return Err(invalid(text));
    }
    Ok(jsval::to_number(text))
}

/// `requiredGtfsEnum(value, allowed, field, context, defaultValue)`.
fn required_gtfs_enum(
    value: Option<&str>,
    allowed: &[f64],
    field: &str,
    context: &str,
    default: Option<f64>,
) -> Result<f64> {
    let text = trimmed(value);
    if text.is_empty()
        && let Some(default) = default
    {
        return Ok(default);
    }
    let parsed = jsval::to_number(text);
    if !jsval::is_integer(parsed) || !allowed.contains(&parsed) {
        return Err(Error::new(format!(
            "Invalid GTFS {field}{}: {}.",
            context_suffix(context),
            if text.is_empty() { "(missing)" } else { text }
        )));
    }
    Ok(parsed)
}

/// Counters of the feature inventory, in first-assignment order.
struct Inventory(Js);

impl Inventory {
    fn new() -> Self {
        let mut members = Js::object();
        for key in [
            "blockTripCount",
            "routeContinuousRuleCount",
            "tripContinuousRuleCount",
            "restrictedPickupStopTimeCount",
            "restrictedDropOffStopTimeCount",
            "onDemandPickupStopTimeCount",
            "onDemandDropOffStopTimeCount",
            "driverCoordinatedStopTimeCount",
            "continuousPickupStopTimeCount",
            "continuousDropOffStopTimeCount",
            "routeSpecificTransferCount",
            "tripSpecificTransferCount",
            "timedTransferCount",
            "inSeatTransferCount",
            "pathwayCount",
            "pathwayAccessibilityRuleCount",
            "stopWheelchairBoardingRuleCount",
            "tripWheelchairAccessibleRuleCount",
            "tripBikesAllowedRuleCount",
            "stationEntranceCount",
            "stationLevelRuleCount",
            "exactFrequencyCount",
            "inexactFrequencyCount",
            "exactFrequencyExpandedTripCount",
            "exactFrequencyExpandedConnectionCount",
            "excludedTripCount",
            "excludedTransferCount",
        ] {
            members.set(key, 0);
        }
        Inventory(members)
    }
    fn get(&self, key: &str) -> f64 {
        self.0.get(key).and_then(Js::as_f64).unwrap_or(0.0)
    }
    fn has(&self, key: &str) -> bool {
        self.0.get(key).is_some()
    }
    fn add(&mut self, key: &str) {
        let value = self.get(key) + 1.0;
        self.0.set(key, value);
    }
    fn set(&mut self, key: &str, value: impl Into<Js>) {
        self.0.set(key, value);
    }
}

fn continuous_rule(value: Option<&str>) -> bool {
    !trimmed(value).is_empty() && numeric(value, 1.0) != 1.0
}

fn feature(code: &str, count: f64, exactness: Option<&str>, detail: &str) -> Js {
    let mut value = Js::object().with("code", code).with("count", count);
    if let Some(exactness) = exactness {
        value.set("exactness", exactness);
    }
    value.with("detail", detail)
}

fn profile(name: &str, present: bool, rows: u64, fields: Vec<String>) -> Js {
    Js::object()
        .with("name", name)
        .with("present", present)
        .with("rowCount", rows)
        .with("fields", fields)
}

fn discard_build_database(temp: &Path) {
    remove_file(temp);
    remove_file(Path::new(&format!("{}-journal", path_text(temp))));
}

fn cleanup_failed_build(temp: &Path, output: &Path, extra: &[PathBuf]) {
    let sidecar = path_text(&static_topology_sidecar_path(output));
    for path in [
        temp.to_path_buf(),
        PathBuf::from(format!("{}-journal", path_text(temp))),
        PathBuf::from(format!("{sidecar}.next")),
        PathBuf::from(format!("{sidecar}.next.building")),
    ]
    .iter()
    .chain(extra)
    {
        remove_file(path);
    }
}

fn open_build_database(path: &Path) -> Result<Connection> {
    let db = Connection::open(path)?;
    configure_build_database(&db)?;
    Ok(db)
}

type Values<'r> = Option<Vec<V<'r>>>;

struct ImportState<'p, 'q, 'a> {
    reader: FeedReader<'a>,
    profiles: Vec<Js>,
    counts: HashMap<String, f64>,
    progress: &'p RefCell<&'q mut dyn FnMut(&Progress)>,
}

impl ImportState<'_, '_, '_> {
    fn report(&self, phase: &str, value: f64, detail: &str) {
        report(&mut **self.progress.borrow_mut(), phase, value, detail);
    }

    /// `importTable(name, progress, insertSql, values)`.
    fn import_table(
        &mut self,
        target: &Connection,
        name: &str,
        value: f64,
        sql: &str,
        values: &mut dyn for<'r> FnMut(&'r Row) -> Result<Values<'r>>,
    ) -> Result<()> {
        let archive = self.reader.archive;
        let Some(entry) = archive.table(name) else {
            self.profiles.push(profile(name, false, 0, Vec::new()));
            return Ok(());
        };
        self.report(&format!("Reading {name}"), value, "");
        let mut statement = target.prepare(sql)?;
        let mut batch = 0u64;
        target.execute_batch("BEGIN IMMEDIATE")?;
        let progress = self.progress;
        let phase = format!("Reading {name}");
        let total = entry.uncompressed_bytes;
        let mut on_progress = |rows: u64, completed: u64| {
            (*progress.borrow_mut())(&Progress {
                phase: phase.clone(),
                progress: value,
                detail: format!("{} rows", grouped(rows)),
                work: Some(Work {
                    completed,
                    total,
                    rows,
                }),
            });
        };
        let outcome = self
            .reader
            .stream(entry, Some(&mut on_progress), &mut |row| {
                if let Some(prepared) = values(row)? {
                    check_bindable(&prepared)?;
                    if let Err(error) =
                        statement.execute(rusqlite::params_from_iter(prepared.iter()))
                    {
                        if is_constraint(&error) {
                            return Err(Error::new(format!(
                                "Duplicate or conflicting GTFS key in {name}."
                            )));
                        }
                        return Err(error.into());
                    }
                }
                batch += 1;
                if batch.is_multiple_of(100_000) {
                    target.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
                    report(
                        &mut **progress.borrow_mut(),
                        &format!("Reading {name}"),
                        value,
                        &format!("{} rows", grouped(batch)),
                    );
                }
                Ok(())
            });
        match outcome {
            Ok(table) => {
                target.execute_batch("COMMIT")?;
                self.counts.insert(name.to_owned(), table.rows as f64);
                self.profiles
                    .push(profile(name, true, table.rows, table.fields));
                Ok(())
            }
            Err(error) => {
                let _ = target.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn count(&self, name: &str) -> f64 {
        self.counts.get(name).copied().unwrap_or(0.0)
    }
}

/// Source state the per-table closures share.
struct FeedState {
    inventory: Inventory,
    wheelchair_order: Vec<String>,
    wheelchair_stops: HashMap<String, WheelchairStop>,
    boarding: HashMap<String, f64>,
    excluded_trips: HashSet<String>,
    excluded_order: Vec<String>,
    flex_trips: Vec<Option<String>>,
    flex_trip_set: HashSet<Option<String>>,
    booking_trips: Vec<Option<String>>,
    booking_trip_set: HashSet<Option<String>>,
    trip_models: HashMap<Option<String>, Js>,
    agency_timezones: Vec<String>,
}

fn insert_unique(
    list: &mut Vec<Option<String>>,
    set: &mut HashSet<Option<String>>,
    value: Option<&str>,
) {
    let value = value.map(str::to_owned);
    if set.insert(value.clone()) {
        list.push(value);
    }
}

pub(crate) struct ImportOptions<'a> {
    pub zip: &'a Path,
    pub output: &'a Path,
    pub for_city: bool,
    pub scope: &'a str,
    pub wheelchair: bool,
    pub wheelchair_streets: &'a str,
}

/// `importGtfsFeed(...)`. With a shared database (multi-feed City), the
/// connection is taken and returned through `shared`; the metadata is
/// returned without being written.
pub(crate) fn import_feed(
    options: &ImportOptions,
    shared: Option<&mut Option<Connection>>,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Js> {
    let started = Instant::now();
    let archive = Archive::inspect(options.zip)?;
    let source_fingerprint = sha256_file(options.zip)?;
    let prefix = if options.scope.is_empty() {
        String::new()
    } else {
        format!("{}\u{1f}", options.scope)
    };
    let mut required = vec!["routes.txt", "trips.txt", "stop_times.txt"];
    if archive.table("locations.geojson").is_none() {
        required.push("stops.txt");
    }
    for name in required {
        if archive.table(name).is_none() {
            return Err(Error::new(format!("GTFS is missing {name}.")));
        }
    }
    if archive.table("calendar.txt").is_none() && archive.table("calendar_dates.txt").is_none() {
        return Err(Error::new(
            "GTFS requires calendar.txt, calendar_dates.txt, or both to define active service.",
        ));
    }
    if let Some(parent) = options.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = PathBuf::from(format!("{}.building", path_text(options.output)));
    let stage_path = PathBuf::from(format!("{}.stop-times-building", path_text(options.output)));
    remove_file(&stage_path);
    let is_shared = shared.is_some();
    if !is_shared {
        discard_build_database(&temp);
    }
    let mut owned: Option<Connection> = None;
    let shared_slot = match shared {
        Some(slot) => slot,
        None => {
            let db = Connection::open(&temp)?;
            configure_build_database(&db)?;
            create_schema(&db)?;
            owned = Some(db);
            &mut owned
        }
    };
    let progress = RefCell::new(progress);
    let outcome = import_into(
        options,
        &archive,
        &source_fingerprint,
        &prefix,
        &temp,
        &stage_path,
        shared_slot,
        is_shared,
        &progress,
        started,
    );
    match outcome {
        Ok(result) => Ok(result),
        Err(error) => {
            if is_shared {
                remove_file(&stage_path);
            } else {
                drop(owned.take());
                cleanup_failed_build(&temp, options.output, &[stage_path]);
            }
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn import_into(
    options: &ImportOptions,
    archive: &Archive,
    source_fingerprint: &str,
    prefix: &str,
    temp: &Path,
    stage_path: &Path,
    slot: &mut Option<Connection>,
    is_shared: bool,
    progress: &RefCell<&mut dyn FnMut(&Progress)>,
    started: Instant,
) -> Result<Js> {
    let wheelchair = options.wheelchair;
    let stage = Connection::open(stage_path)?;
    configure_build_database(&stage)?;
    stage.execute_batch(
        "CREATE TABLE stop_times(trip_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL, stop_id TEXT NOT NULL, arrival INTEGER, departure INTEGER, can_board INTEGER NOT NULL, can_alight INTEGER NOT NULL, pickup_type INTEGER NOT NULL, drop_off_type INTEGER NOT NULL);",
    )?;
    let db = slot.as_ref().expect("routing database is open");
    if wheelchair {
        db.execute_batch(WHEELCHAIR_TABLES)?;
    }
    let mut state = ImportState {
        reader: FeedReader {
            archive,
            prefix: prefix.to_owned(),
            budget: Budget::default(),
        },
        profiles: Vec::new(),
        counts: HashMap::new(),
        progress,
    };
    let mut feed = FeedState {
        inventory: Inventory::new(),
        wheelchair_order: Vec::new(),
        wheelchair_stops: HashMap::new(),
        boarding: HashMap::new(),
        excluded_trips: HashSet::new(),
        excluded_order: Vec::new(),
        flex_trips: Vec::new(),
        flex_trip_set: HashSet::new(),
        booking_trips: Vec::new(),
        booking_trip_set: HashSet::new(),
        trip_models: HashMap::new(),
        agency_timezones: Vec::new(),
    };

    let fare_catalog = read_fare_catalog(archive, &mut state.reader.budget)?;
    write_fare_catalog(db, fare_catalog.as_ref(), options.scope)?;
    match archive.table("agency.txt") {
        Some(entry) => {
            let timezones = &mut feed.agency_timezones;
            let table = state.reader.stream(entry, None, &mut |row| {
                let zone = trimmed(row.get("agency_timezone"));
                if !zone.is_empty() && !timezones.iter().any(|z| z == zone) {
                    timezones.push(zone.to_owned());
                }
                Ok(())
            })?;
            state.counts.insert("agency.txt".into(), table.rows as f64);
            state
                .profiles
                .push(profile("agency.txt", true, table.rows, table.fields));
        }
        None => state
            .profiles
            .push(profile("agency.txt", false, 0, Vec::new())),
    }

    let prefix_units = prefix.encode_utf16().count();
    state.import_table(
        db,
        "stops.txt",
        0.05,
        "INSERT INTO stops VALUES(?,?,?,?,?,?,?)",
        &mut |row| {
            if trim(&slice_utf16(row.get("stop_id").unwrap_or(""), prefix_units)).is_empty() {
                return Err(Error::new("GTFS stops.txt requires a non-empty stop_id."));
            }
            let location_type = numeric(row.get("location_type"), 0.0);
            let boarding_text = trimmed(row.get("wheelchair_boarding"));
            if !boarding_text.is_empty() && numeric(Some(boarding_text), 0.0) != 0.0 {
                feed.inventory.add("stopWheelchairBoardingRuleCount");
            }
            if wheelchair {
                let id = row.get("stop_id").unwrap_or("").to_owned();
                let boarding = required_gtfs_enum(
                    row.get("wheelchair_boarding"),
                    &[0.0, 1.0, 2.0],
                    "wheelchair_boarding",
                    row.get("stop_id").unwrap_or(""),
                    Some(0.0),
                )?;
                let stop = WheelchairStop {
                    parent: row.get("parent_station").map(str::to_owned),
                    level: trimmed(row.get("level_id")).to_owned(),
                    boarding,
                };
                if feed.wheelchair_stops.insert(id.clone(), stop).is_none() {
                    feed.wheelchair_order.push(id);
                }
            }
            if location_type == 2.0 {
                feed.inventory.add("stationEntranceCount");
            }
            if !trimmed(row.get("level_id")).is_empty() {
                feed.inventory.add("stationLevelRuleCount");
            }
            let coordinate = |field: &str| {
                if trimmed(row.get(field)).is_empty() {
                    V::Null
                } else {
                    V::opt_num(Some(numeric(row.get(field), f64::NAN)).filter(|v| !v.is_nan()))
                }
            };
            Ok(Some(vec![
                V::field(row.get("stop_id")),
                V::Text(row.get("stop_name").unwrap_or("")),
                coordinate("stop_lat"),
                coordinate("stop_lon"),
                V::or_null(row.get("parent_station")),
                V::Num(location_type),
                V::or_null(row.get("platform_code")),
            ]))
        },
    )?;
    if wheelchair {
        let resolved = wheelchair_boarding_values(&feed.wheelchair_order, &feed.wheelchair_stops)?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        let mut insert = db.prepare("INSERT INTO wheelchair_stops VALUES(?,?)")?;
        for (id, boarding) in &resolved {
            insert.execute(rusqlite::params![id, boarding])?;
        }
        feed.boarding = resolved.into_iter().collect();
        drop(insert);
        db.execute_batch("COMMIT")?;
    }
    state.import_table(
        db,
        "routes.txt",
        0.09,
        "INSERT INTO routes VALUES(?,?,?,?,?)",
        &mut |row| {
            if continuous_rule(row.get("continuous_pickup"))
                || continuous_rule(row.get("continuous_drop_off"))
            {
                feed.inventory.add("routeContinuousRuleCount");
            }
            Ok(Some(vec![
                V::field(row.get("route_id")),
                V::Text(jsval::or_null(row.get("route_short_name")).unwrap_or("")),
                V::Text(jsval::or_null(row.get("route_long_name")).unwrap_or("")),
                V::Num(numeric(row.get("route_type"), 3.0)),
                V::Text(jsval::or_null(row.get("route_color")).unwrap_or("")),
            ]))
        },
    )?;
    {
        let mut insert_operations = db.prepare("INSERT INTO trip_operations VALUES(?,?,?)")?;
        let mut insert_details = db.prepare("INSERT INTO trip_details VALUES(?,?,?)")?;
        state.import_table(
            db,
            "trips.txt",
            0.14,
            "INSERT INTO trips VALUES(?,?,?,?)",
            &mut |row| {
                let safe = |field: &str| jsval::or_null(row.get(field)).map(jsval::to_number);
                let factor = safe("safe_duration_factor");
                let offset = safe("safe_duration_offset");
                if factor.is_some_and(|f| !f.is_finite() || f < 0.0)
                    || offset.is_some_and(|o| !o.is_finite() || o < 0.0)
                {
                    return Err(Error::new("Invalid GTFS safe duration model"));
                }
                let trip_id = row.get("trip_id");
                let context = trip_id.unwrap_or("");
                if wheelchair || factor.is_some() || offset.is_some() {
                    let accessible = required_gtfs_enum(
                        row.get("wheelchair_accessible"),
                        &[0.0, 1.0, 2.0],
                        "wheelchair_accessible",
                        context,
                        Some(0.0),
                    )?;
                    feed.trip_models.insert(
                        trip_id.map(str::to_owned),
                        Js::object()
                            .with("factor", factor)
                            .with("offset", offset)
                            .with("wheelchair", accessible),
                    );
                }
                let block = trimmed(row.get("block_id"));
                let bikes = required_gtfs_enum(
                    row.get("bikes_allowed"),
                    &[0.0, 1.0, 2.0],
                    "bikes_allowed",
                    context,
                    Some(0.0),
                )?;
                run(
                    &mut insert_operations,
                    &[
                        V::field(trip_id),
                        if block.is_empty() {
                            V::Null
                        } else {
                            V::Text(block)
                        },
                        V::Num(bikes),
                    ],
                )?;
                run(
                    &mut insert_details,
                    &[
                        V::field(trip_id),
                        V::or_null(row.get("trip_headsign")),
                        V::or_null(row.get("trip_short_name")),
                    ],
                )?;
                if !block.is_empty() {
                    feed.inventory.add("blockTripCount");
                }
                let accessible_text = trimmed(row.get("wheelchair_accessible"));
                if wheelchair
                    && required_gtfs_enum(
                        row.get("wheelchair_accessible"),
                        &[0.0, 1.0, 2.0],
                        "wheelchair_accessible",
                        context,
                        Some(0.0),
                    )? != 1.0
                {
                    let id = trip_id.unwrap_or("undefined").to_owned();
                    if feed.excluded_trips.insert(id.clone()) {
                        feed.excluded_order.push(id);
                    }
                    feed.inventory.add("wheelchairExcludedTripCount");
                }
                let bikes_text = trimmed(row.get("bikes_allowed"));
                if !accessible_text.is_empty() && numeric(Some(accessible_text), 0.0) != 0.0 {
                    feed.inventory.add("tripWheelchairAccessibleRuleCount");
                }
                if !bikes_text.is_empty() && numeric(Some(bikes_text), 0.0) != 0.0 {
                    feed.inventory.add("tripBikesAllowedRuleCount");
                }
                if continuous_rule(row.get("continuous_pickup"))
                    || continuous_rule(row.get("continuous_drop_off"))
                {
                    feed.inventory.add("tripContinuousRuleCount");
                }
                Ok(Some(vec![
                    V::field(trip_id),
                    V::field(row.get("route_id")),
                    V::field(row.get("service_id")),
                    V::or_null(row.get("direction_id")),
                ]))
            },
        )?;
    }
    if archive.table("shapes.txt").is_some() {
        let entry = archive.table("trips.txt").expect("trips.txt is required");
        let mut insert = db.prepare("INSERT INTO trip_shapes VALUES(?,?)")?;
        let mut mapped = 0u64;
        db.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = state.reader.stream(entry, None, &mut |row| {
            let shape = trim(&slice_utf16(
                row.get("shape_id").unwrap_or(""),
                prefix_units,
            ))
            .to_owned();
            if shape.is_empty() {
                return Ok(());
            }
            run(
                &mut insert,
                &[
                    V::field(row.get("trip_id")),
                    V::Owned(format!("{prefix}{shape}")),
                ],
            )?;
            mapped += 1;
            if mapped.is_multiple_of(100_000) {
                db.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
            }
            Ok(())
        });
        match outcome {
            Ok(_) => db.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    state.import_table(
        db,
        "calendar.txt",
        0.18,
        "INSERT INTO calendar VALUES(?,?,?,?,?,?,?,?,?,?)",
        &mut |row| {
            let context = format!(
                "service {}",
                jsval::or_null(row.get("service_id")).unwrap_or("(missing service_id)")
            );
            let start = required_gtfs_date(row.get("start_date"), "start_date", &context)?;
            let end = required_gtfs_date(row.get("end_date"), "end_date", &context)?;
            if end < start {
                return Err(Error::new(format!(
                    "Invalid GTFS calendar date range for {context}: end_date precedes start_date."
                )));
            }
            let mut values = vec![V::field(row.get("service_id"))];
            for day in [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            ] {
                values.push(V::Num(required_gtfs_enum(
                    row.get(day),
                    &[0.0, 1.0],
                    day,
                    &context,
                    None,
                )?));
            }
            values.push(V::Num(start));
            values.push(V::Num(end));
            Ok(Some(values))
        },
    )?;
    state.import_table(
        db,
        "calendar_dates.txt",
        0.23,
        "INSERT INTO calendar_dates VALUES(?,?,?)",
        &mut |row| {
            let context = format!(
                "service {}",
                jsval::or_null(row.get("service_id")).unwrap_or("(missing service_id)")
            );
            Ok(Some(vec![
                V::field(row.get("service_id")),
                V::Num(required_gtfs_date(row.get("date"), "date", &context)?),
                V::Num(required_gtfs_enum(
                    row.get("exception_type"),
                    &[1.0, 2.0],
                    "exception_type",
                    &context,
                    None,
                )?),
            ]))
        },
    )?;
    {
        let mut insert_rule = db.prepare("INSERT INTO transfer_rules VALUES(?,?,?,?,?,?,?,?)")?;
        let mut insert_link = db.prepare("INSERT INTO trip_links VALUES(?,?,?)")?;
        state.import_table(
            db,
            "transfers.txt",
            0.27,
            "INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)",
            &mut |row| {
                let route_specific = !trimmed(row.get("from_route_id")).is_empty()
                    || !trimmed(row.get("to_route_id")).is_empty();
                let trip_specific = !trimmed(row.get("from_trip_id")).is_empty()
                    || !trimmed(row.get("to_trip_id")).is_empty();
                let context = format!(
                    "{} -> {}",
                    jsval::or_null(row.get("from_stop_id")).unwrap_or("(missing from_stop_id)"),
                    jsval::or_null(row.get("to_stop_id")).unwrap_or("(missing to_stop_id)")
                );
                let transfer_type = required_gtfs_enum(
                    row.get("transfer_type"),
                    &[0.0, 1.0, 2.0, 3.0, 4.0, 5.0],
                    "transfer_type",
                    &context,
                    Some(0.0),
                )?;
                let minimum_text = trimmed(row.get("min_transfer_time"));
                let minimum = if minimum_text.is_empty() {
                    0.0
                } else {
                    jsval::to_number(minimum_text)
                };
                if !jsval::is_integer(minimum) || minimum < 0.0 {
                    return Err(Error::new(format!(
                        "Invalid GTFS min_transfer_time for {context}: {}.",
                        if minimum_text.is_empty() {
                            "(missing)"
                        } else {
                            minimum_text
                        }
                    )));
                }
                if transfer_type < 4.0
                    && (trimmed(row.get("from_stop_id")).is_empty()
                        || trimmed(row.get("to_stop_id")).is_empty())
                {
                    return Err(Error::new(
                        "GTFS ordinary transfers require both stop selectors.",
                    ));
                }
                let mut rule: Vec<V> = [
                    "from_stop_id",
                    "to_stop_id",
                    "from_route_id",
                    "to_route_id",
                    "from_trip_id",
                    "to_trip_id",
                ]
                .iter()
                .map(|key| {
                    let text = trimmed(row.get(key));
                    if text.is_empty() {
                        V::Null
                    } else {
                        V::Text(text)
                    }
                })
                .collect();
                rule.push(V::Num(transfer_type));
                rule.push(V::Num(minimum));
                run(&mut insert_rule, &rule)?;
                if transfer_type == 1.0 {
                    feed.inventory.add("timedTransferCount");
                }
                if transfer_type == 4.0 || transfer_type == 5.0 {
                    feed.inventory.add("inSeatTransferCount");
                    if trimmed(row.get("from_trip_id")).is_empty()
                        || trimmed(row.get("to_trip_id")).is_empty()
                    {
                        return Err(Error::new(
                            "GTFS linked trips require both from_trip_id and to_trip_id.",
                        ));
                    }
                    run(
                        &mut insert_link,
                        &[
                            V::field(row.get("from_trip_id")),
                            V::field(row.get("to_trip_id")),
                            V::Num(transfer_type),
                        ],
                    )?;
                    return Ok(None);
                }
                if route_specific {
                    feed.inventory.add("routeSpecificTransferCount");
                }
                if trip_specific {
                    feed.inventory.add("tripSpecificTransferCount");
                }
                if route_specific || trip_specific || [1.0, 4.0, 5.0].contains(&transfer_type) {
                    feed.inventory.add("excludedTransferCount");
                    return Ok(None);
                }
                Ok(Some(vec![
                    V::field(row.get("from_stop_id")),
                    V::field(row.get("to_stop_id")),
                    V::Num(transfer_type),
                    V::Num(minimum),
                ]))
            },
        )?;
    }
    db.execute(
        "INSERT OR REPLACE INTO transfer_provenance(from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m)
      SELECT from_stop_id, to_stop_id, 'gtfs_transfer', NULL, NULL FROM transfers
      WHERE ? = '' OR substr(from_stop_id, 1, length(?)) = ?",
        rusqlite::params![prefix, prefix, prefix],
    )?;
    if wheelchair {
        db.execute_batch("INSERT OR IGNORE INTO wheelchair_transfer_minimum SELECT from_stop_id,to_stop_id,min_transfer_time FROM transfers WHERE transfer_type=2")?;
    }
    state.import_table(
        db,
        "frequencies.txt",
        0.29,
        "INSERT INTO frequencies VALUES(?,?,?,?,?)",
        &mut |row| {
            let start = gtfs_seconds(row.get("start_time"));
            let end = gtfs_seconds(row.get("end_time"));
            let headway = numeric(row.get("headway_secs"), 0.0);
            let exact = required_gtfs_enum(
                row.get("exact_times"),
                &[0.0, 1.0],
                "exact_times",
                row.get("trip_id").unwrap_or(""),
                Some(0.0),
            )?;
            let valid = matches!((start, end), (Some(s), Some(e)) if e > s)
                && jsval::is_integer(headway)
                && headway > 0.0;
            if !valid {
                return Err(Error::new(format!(
                    "Invalid GTFS frequency window for trip {}.",
                    jsval::or_null(row.get("trip_id")).unwrap_or("(missing trip_id)")
                )));
            }
            if exact == 1.0 {
                feed.inventory.add("exactFrequencyCount");
            } else {
                feed.inventory.add("inexactFrequencyCount");
            }
            Ok(Some(vec![
                V::field(row.get("trip_id")),
                V::Num(start.unwrap()),
                V::Num(end.unwrap()),
                V::Num(headway),
                V::Num(exact),
            ]))
        },
    )?;
    state.import_table(
        db,
        "shapes.txt",
        0.3,
        "INSERT INTO shape_points VALUES(?,?,?,?)",
        &mut |row| {
            Ok(Some(vec![
                V::field(row.get("shape_id")),
                V::Num(numeric(row.get("shape_pt_sequence"), 0.0)),
                V::Num(numeric(row.get("shape_pt_lat"), 0.0)),
                V::Num(numeric(row.get("shape_pt_lon"), 0.0)),
            ]))
        },
    )?;
    state.import_table(
        &stage,
        "stop_times.txt",
        0.32,
        "INSERT INTO stop_times VALUES(?,?,?,?,?,?,?,?,?)",
        &mut |row| {
            let truthy = |field: &str| row.get(field).is_some_and(|v| !v.is_empty());
            if truthy("location_id")
                || truthy("location_group_id")
                || truthy("start_pickup_drop_off_window")
                || truthy("end_pickup_drop_off_window")
            {
                insert_unique(
                    &mut feed.flex_trips,
                    &mut feed.flex_trip_set,
                    row.get("trip_id"),
                );
                return Ok(None);
            }
            let trip_label = jsval::or_null(row.get("trip_id")).unwrap_or("(missing trip_id)");
            let sequence_label =
                jsval::or_null(row.get("stop_sequence")).unwrap_or("(missing sequence)");
            let permission = |field: &str| {
                // Build the error context only when the value is invalid.
                required_gtfs_enum(row.get(field), &[0.0, 1.0, 2.0, 3.0], field, "", Some(0.0))
                    .or_else(|_| {
                        let context = format!("trip {trip_label} stop_sequence {sequence_label}");
                        required_gtfs_enum(
                            row.get(field),
                            &[0.0, 1.0, 2.0, 3.0],
                            field,
                            &context,
                            Some(0.0),
                        )
                    })
            };
            let pickup = permission("pickup_type")?;
            let drop_off = permission("drop_off_type")?;
            if pickup == 2.0 || drop_off == 2.0 {
                insert_unique(
                    &mut feed.booking_trips,
                    &mut feed.booking_trip_set,
                    row.get("trip_id"),
                );
            }
            let restricted_pickup = pickup == 1.0 || pickup == 2.0;
            let restricted_drop_off = drop_off == 1.0 || drop_off == 2.0;
            let continuous_pickup = continuous_rule(row.get("continuous_pickup"));
            let continuous_drop_off = continuous_rule(row.get("continuous_drop_off"));
            let inventory = &mut feed.inventory;
            if restricted_pickup {
                inventory.add("restrictedPickupStopTimeCount");
            }
            if restricted_drop_off {
                inventory.add("restrictedDropOffStopTimeCount");
            }
            if pickup == 2.0 {
                inventory.add("onDemandPickupStopTimeCount");
            }
            if drop_off == 2.0 {
                inventory.add("onDemandDropOffStopTimeCount");
            }
            if pickup == 3.0 || drop_off == 3.0 {
                inventory.add("driverCoordinatedStopTimeCount");
            }
            if continuous_pickup {
                inventory.add("continuousPickupStopTimeCount");
            }
            if continuous_drop_off {
                inventory.add("continuousDropOffStopTimeCount");
            }
            let arrival_text = trimmed(row.get("arrival_time"));
            let departure_text = trimmed(row.get("departure_time"));
            let sequence_text = trimmed(row.get("stop_sequence"));
            let sequence = jsval::to_number(sequence_text);
            if sequence_text.is_empty() || !jsval::is_integer(sequence) || sequence < 0.0 {
                return Err(Error::new(format!(
                    "Invalid GTFS stop_sequence for trip {trip_label}: {}.",
                    if sequence_text.is_empty() {
                        "(missing sequence)"
                    } else {
                        sequence_text
                    }
                )));
            }
            let arrival = gtfs_seconds(Some(arrival_text));
            let departure = gtfs_seconds(Some(departure_text));
            if (!arrival_text.is_empty() && arrival.is_none())
                || (!departure_text.is_empty() && departure.is_none())
            {
                return Err(Error::new(format!(
                    "Invalid GTFS time for trip {trip_label} at stop_sequence {sequence_label}."
                )));
            }
            let inaccessible =
                wheelchair && row.get("stop_id").and_then(|id| feed.boarding.get(id)) != Some(&1.0);
            Ok(Some(vec![
                V::field(row.get("trip_id")),
                V::Num(sequence),
                V::field(row.get("stop_id")),
                V::opt_num(arrival),
                V::opt_num(departure),
                V::Num(if restricted_pickup || inaccessible {
                    0.0
                } else {
                    1.0
                }),
                V::Num(if restricted_drop_off || inaccessible {
                    0.0
                } else {
                    1.0
                }),
                V::Num(pickup),
                V::Num(drop_off),
            ]))
        },
    )?;
    let continuous_present = feed.inventory.get("routeContinuousRuleCount")
        + feed.inventory.get("continuousPickupStopTimeCount")
        + feed.inventory.get("continuousDropOffStopTimeCount")
        > 0.0;
    if !feed.flex_trips.is_empty() || !feed.booking_trips.is_empty() || continuous_present {
        let mut windows: Vec<Option<String>> = feed.flex_trips.clone();
        for id in &feed.booking_trips {
            if !feed.flex_trip_set.contains(id) {
                windows.push(id.clone());
            }
        }
        let flex = import_flex_catalog(FlexInput {
            reader: &mut state.reader,
            db,
            prefix,
            windows,
            on_demand: &feed.flex_trip_set,
            trip_models: &feed.trip_models,
            continuous_present,
        })?;
        stage.execute_batch("BEGIN IMMEDIATE")?;
        let removed = (|| -> Result<()> {
            let mut remove = stage.prepare("DELETE FROM stop_times WHERE trip_id=?")?;
            for id in &feed.flex_trips {
                run(&mut remove, &[V::field(id.as_deref())])?;
            }
            Ok(())
        })();
        if let Err(error) = removed {
            let _ = stage.execute_batch("ROLLBACK");
            return Err(error);
        }
        stage.execute_batch("COMMIT")?;
        feed.inventory.set(
            "flexTripCount",
            feed.flex_trips.len() as f64 - flex.omitted_on_demand as f64,
        );
        feed.inventory.set(
            "flexCatalogOmittedTripCount",
            (flex.omitted_fixed + flex.omitted_on_demand) as f64,
        );
    }
    feed.inventory
        .set("excludedTripCount", feed.excluded_trips.len() as f64);

    import_pathways(&mut state, &mut feed, db, wheelchair)?;

    assert_no_broken_references(db)?;
    if wheelchair {
        db.execute_batch(
            "DELETE FROM transfers WHERE transfer_type!=3 AND from_stop_id!=to_stop_id
          AND EXISTS(SELECT 1 FROM transfer_provenance AS p
            WHERE p.from_stop_id=transfers.from_stop_id AND p.to_stop_id=transfers.to_stop_id
              AND p.provenance='gtfs_transfer');
        DELETE FROM transfer_provenance WHERE NOT EXISTS(SELECT 1 FROM transfers AS t
          WHERE t.from_stop_id=transfer_provenance.from_stop_id AND t.to_stop_id=transfer_provenance.to_stop_id);",
        )?;
    }
    state.report("Ordering stop times", 0.72, "");
    stage.execute_batch(
        "CREATE INDEX stop_times_trip_sequence ON stop_times(trip_id, stop_sequence);",
    )?;
    state.report("Compiling transit connections", 0.72, "");
    drop(stage);
    drop(slot.take());
    let compiled = vigo_prepare::compile_gtfs_connections(vigo_prepare::GtfsConnectionInput {
        store_path: path_text(temp),
        stop_times_path: path_text(stage_path),
        excluded_trip_ids: feed.excluded_order.clone(),
        cache_kib: build_sqlite_cache_kib(),
        invalid_time_policy: Some("repair".into()),
    });
    *slot = Some(open_build_database(temp)?);
    let db = slot.as_ref().expect("routing database is open");
    let compiled = compiled.map_err(|error| Error::new(error.reason))?;
    state.report("Compiled transit connections", 0.89, "");
    let connection_count = compiled.connection_count;
    state.counts.insert("connections".into(), connection_count);
    if !is_shared {
        state.report("Linking nearby interchanges", 0.895, "");
    }
    let candidate_count = if is_shared {
        0.0
    } else {
        link_nearby_transfer_stops(db)?
    };
    if !is_shared {
        state.report("Building routing indexes", 0.9, "");
        create_indexes(db, options.for_city)?;
    }
    let quarantined = compiled.quarantined_time_trip_count.unwrap_or(0.0);
    let samples = |list: &Option<Vec<String>>| Js::from(list.clone().unwrap_or_default());
    feed.inventory.set("quarantinedTimeTripCount", quarantined);
    feed.inventory.set(
        "quarantinedTimeTripSamples",
        samples(&compiled.quarantined_time_trip_samples),
    );
    if quarantined != 0.0 {
        state.report(
            "Timetable warning",
            0.9,
            &format!(
                "{} trip(s) with backward times excluded; source times preserved.",
                js_number(quarantined)
            ),
        );
    }
    let repaired = compiled.repaired_time_trip_count.unwrap_or(0.0);
    feed.inventory.set("repairedTimeTripCount", repaired);
    feed.inventory.set(
        "repairedTimeTripSamples",
        samples(&compiled.repaired_time_trip_samples),
    );
    if repaired != 0.0 {
        state.report(
            "Timetable warning",
            0.9,
            &format!("{} trip(s) with backward times repaired by delaying events at most 600 seconds; source times preserved.", js_number(repaired)),
        );
    }
    let mut blocking: Vec<Js> = Vec::new();
    let mut limitations: Vec<Js> = Vec::new();
    let limit = |list: &mut Vec<Js>, code: &str, count: f64, detail: &str| {
        if count > 0.0 {
            list.push(feature(code, count, Some("unsupported"), detail));
        }
    };
    let inv = &mut feed.inventory;
    if repaired != 0.0 {
        limitations.push(feature("repaired_trip_times", repaired, Some("approximate"), "Backward times were clamped to the preceding event, delaying each event by at most 600 seconds. All stops and permissions are retained; source ZIPs are unchanged."));
    }
    limit(
        &mut limitations,
        "backward_trip_times",
        quarantined,
        "Trips requiring time corrections greater than 600 seconds are excluded in full. Source times are preserved; no partial trip is routed.",
    );
    let extra_zones = 0f64.max(feed.agency_timezones.len() as f64 - 1.0);
    if extra_zones > 0.0 {
        blocking.push(feature("multiple_agency_timezones", extra_zones, None, "A single routing store cannot yet resolve service-day coordinates across multiple agency timezones."));
    }
    inv.set(
        "exactFrequencyExpandedTripCount",
        compiled.exact_frequency_expanded_trip_count,
    );
    inv.set(
        "exactFrequencyExpandedConnectionCount",
        compiled.exact_frequency_expanded_connection_count,
    );
    if inv.get("inexactFrequencyCount") != 0.0 {
        limitations.push(feature("frequency_based_service", inv.get("inexactFrequencyCount"), Some("approximate"), "Frequency-based trips (GTFS exact_times=0) depart every headway from each window's start. Actual departures may differ; times are estimates."));
    }
    if inv.has("flexTripCount") && inv.get("flexTripCount") != 0.0 {
        limitations.push(feature("flex_service", inv.get("flexTripCount"), Some("conditional"), "Flex service requires an explicit flex request and OSM driving estimates. Booking and vehicle availability are not confirmed."));
    }
    if inv.has("flexCatalogOmittedTripCount") && inv.get("flexCatalogOmittedTripCount") != 0.0 {
        limitations.push(feature("flex_catalog_limit", inv.get("flexCatalogOmittedTripCount"), Some("unsupported"), "Conditional trip details exceed the 32 MiB Flex catalog. Fixed-route continuous-stopping and booking trips are omitted first, then on-demand trips; scheduled service is unaffected."));
    }
    limit(
        &mut limitations,
        "on_demand_boarding_or_alighting",
        inv.get("onDemandPickupStopTimeCount") + inv.get("onDemandDropOffStopTimeCount"),
        "pickup_type/drop_off_type value 2 requires booking. Omitted by default; flex requests may return conditional journeys with booking instructions.",
    );
    if inv.get("driverCoordinatedStopTimeCount") != 0.0 {
        limitations.push(feature("driver_coordinated_stops", inv.get("driverCoordinatedStopTimeCount"), Some("conditional"), "Fixed-stop pickup_type/drop_off_type=3 is routable. Riders must signal or notify the driver to board or alight; service assumes this coordination."));
    }
    limit(
        &mut limitations,
        "continuous_pickup_or_drop_off",
        inv.get("routeContinuousRuleCount")
            + inv.get("tripContinuousRuleCount")
            + inv.get("continuousPickupStopTimeCount")
            + inv.get("continuousDropOffStopTimeCount"),
        "Fixed-stop service is retained. Opt-in Flex requests support continuous stopping on directed GTFS shapes with interpolated clocks and source permission overrides.",
    );
    limit(
        &mut limitations,
        "block_interlining",
        inv.get("blockTripCount"),
        "Rust infers consecutive same-terminal block continuations within one service_id and service day. Different-terminal, cross-service and ambiguous block continuations still require explicit linked trips.",
    );
    limit(
        &mut limitations,
        "timed_transfer_guarantee",
        inv.get("timedTransferCount"),
        "Timed transfers waive the default transfer buffer in Rust. Vehicle holding after a missed scheduled connection is not predicted.",
    );
    limit(
        &mut limitations,
        "pathway_accessibility",
        if wheelchair {
            0.0
        } else {
            inv.get("pathwayAccessibilityRuleCount")
        },
        "Pathway direction and traversal time are used, but accessibility attributes are not query constraints.",
    );
    limit(
        &mut limitations,
        "unpriced_pathways",
        inv.get("unpricedPathwayCount"),
        "Pathways without traversal time, length, or distinct located endpoints are excluded. Their declared station connectivity still suppresses inferred shortcuts.",
    );
    limit(
        &mut limitations,
        "wheelchair_accessibility",
        if wheelchair {
            0.0
        } else {
            inv.get("stopWheelchairBoardingRuleCount")
                + inv.get("tripWheelchairAccessibleRuleCount")
        },
        "Stop wheelchair_boarding and trip wheelchair_accessible values require a separately prepared wheelchair City to constrain routing.",
    );
    limit(
        &mut limitations,
        "bicycle_accessibility",
        inv.get("tripBikesAllowedRuleCount"),
        "Trip bikes_allowed values are inventoried, but VIGO does not yet expose a bicycle-constrained routing request.",
    );
    limit(
        &mut limitations,
        "station_entrances",
        inv.get("stationEntranceCount"),
        "Station entrances are inventoried, but the routing graph does not yet use the complete GTFS entrance hierarchy for access and egress.",
    );
    limit(
        &mut limitations,
        "station_level_hierarchy",
        inv.get("stationLevelRuleCount"),
        "Stop level_id values are inventoried, but station levels are not complete routing constraints.",
    );

    let count_rows = |table: &str, id: &str| -> Result<f64> {
        Ok(if prefix.is_empty() {
            db.query_row(
                &format!("SELECT COUNT(*) AS count FROM {table}"),
                [],
                |row| row.get(0),
            )?
        } else {
            db.query_row(
                &format!(
                    "SELECT COUNT(*) AS count FROM {table} WHERE substr({id}, 1, length(?)) = ?"
                ),
                rusqlite::params![prefix, prefix],
                |row| row.get(0),
            )?
        })
    };
    let (minimum_time, maximum_time) = service_time_bounds(db)?;
    let mut metadata = Js::object();
    if wheelchair {
        metadata.set(
            "accessibility",
            wheelchair_description(options.wheelchair_streets)?,
        );
    }
    let fare_data = fare_catalog.as_ref().map_or(Js::Null, |catalog| {
        let tables = catalog.get("tables");
        let standard = if tables.and_then(|t| t.get("fare_products")).is_some() {
            Js::from("GTFS Fares v2")
        } else if tables.and_then(|t| t.get("fare_attributes")).is_some() {
            Js::from("GTFS Fares v1")
        } else {
            Js::Null
        };
        let unavailable = catalog.get("unavailableReason").is_some_and(jsval::truthy);
        Js::object()
            .with("standard", standard)
            .with("boardingPrices", !unavailable)
            .with("transferTotals", false)
    });
    let inexact = feed.inventory.get("inexactFrequencyCount");
    let exact_expanded = compiled.exact_frequency_expanded_trip_count;
    let mut agency_timezones = feed.agency_timezones.clone();
    agency_timezones.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    metadata
        .set("schemaVersion", STORE_SCHEMA_VERSION)
        .set("storeId", source_fingerprint[..20].to_owned())
        .set("sourceFingerprint", source_fingerprint)
        .set("sourceFile", basename(options.zip))
        .set("sourceBytes", archive.compressed_bytes)
        .set("fareData", fare_data)
        .set("builtAt", iso_now())
        .set("routeCount", state.count("routes.txt"))
        .set("stopCount", state.count("stops.txt"))
        .set("tripCount", count_rows("trips", "trip_id")?)
        .set("stopTimeCount", state.count("stop_times.txt"))
        .set("connectionCount", connection_count)
        .set(
            "connectionPermissionCount",
            count_rows("connection_permissions", "trip_id")?,
        )
        .set("minimumServiceTimeSeconds", minimum_time)
        .set("maximumServiceTimeSeconds", maximum_time)
        .set("boardingAlightingModel", "sparse-connection-permissions-v1")
        .set(
            "departureIndexState",
            if options.for_city {
                "deferred"
            } else {
                "ready"
            },
        )
        .set("stopAccessRoleIndexVersion", STOP_ACCESS_ROLE_INDEX_VERSION)
        .set(
            "stopAccessRoleCount",
            count_rows("stop_access_roles", "stop_id")?,
        )
        .set("calendarDateCount", state.count("calendar_dates.txt"))
        .set("transferCount", count_rows("transfers", "from_stop_id")?)
        .set("frequencyCount", state.count("frequencies.txt"))
        .set(
            "frequencyRoutingModel",
            if inexact > 0.0 {
                "inexact_frequency_departures_every_headway"
            } else if exact_expanded > 0.0 {
                "exact_times_1_expanded_fixed_departures"
            } else {
                "none"
            },
        )
        .set("shapePointCount", state.count("shapes.txt"))
        .set("bridgedUntimedGapCount", compiled.bridged_untimed_gap_count)
        .set("routeServiceCatalogVersion", ROUTE_SERVICE_CATALOG_VERSION)
        .set("routeServiceCatalogBuiltAt", iso_now())
        .set("serviceModel", "exact-date")
        .set("agencyTimezones", agency_timezones)
        .set("featureInventory", feed.inventory.0.clone())
        .set("blockingRoutingFeatures", Js::Array(blocking))
        .set("routingLimitations", Js::Array(limitations))
        .set("transferSemanticsVersion", TRANSFER_SEMANTICS_VERSION)
        .set(
            "transferGeneration",
            Js::object()
                .with("strategy", "source_literal_only")
                .with("exact", true)
                .with("maxDistanceKm", NEARBY_TRANSFER_MAX_DISTANCE_KM)
                .with("radialCandidateCount", candidate_count)
                .with("inferredTransferCount", 0),
        );
    remove_file(stage_path);
    let profiles = Js::Array(std::mem::take(&mut state.profiles));
    if is_shared {
        return Ok(metadata.with("tableProfiles", profiles));
    }
    db.execute_batch("BEGIN IMMEDIATE")?;
    write_metadata(db, "INSERT OR REPLACE INTO metadata VALUES(?,?)", &metadata)?;
    db.execute_batch("COMMIT")?;
    let db = slot.take().expect("routing database is open");
    let (static_topology, bytes) = finalize_build(
        db,
        temp,
        options.output,
        &mut **progress.borrow_mut(),
        options.for_city,
    )?;
    report(
        &mut **progress.borrow_mut(),
        "Routing store ready",
        1.0,
        &format!(
            "{} MB",
            grouped((bytes as f64 / 1024.0 / 1024.0).round() as u64)
        ),
    );
    Ok(metadata
        .with("path", path_text(options.output))
        .with("bytes", bytes)
        .with(
            "buildSeconds",
            (started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0,
        )
        .with("tableProfiles", profiles)
        .with("staticTopology", static_topology))
}

fn import_pathways(
    state: &mut ImportState<'_, '_, '_>,
    feed: &mut FeedState,
    db: &Connection,
    wheelchair: bool,
) -> Result<()> {
    let archive = state.reader.archive;
    let Some(entry) = archive.table("pathways.txt") else {
        state
            .profiles
            .push(profile("pathways.txt", false, 0, Vec::new()));
        return Ok(());
    };
    state.report("Reading pathways.txt", 0.31, "");
    let mut insert = db.prepare("INSERT OR IGNORE INTO transfers VALUES(?,?,0,?)")?;
    let mut insert_provenance =
        db.prepare("INSERT OR IGNORE INTO transfer_provenance VALUES(?,?,?,NULL,?)")?;
    let mut existing_pathway = db.prepare(
        "SELECT min_transfer_time,transfer_type,provenance,path_distance_m FROM transfers
        JOIN transfer_provenance USING(from_stop_id,to_stop_id) WHERE from_stop_id=? AND to_stop_id=?",
    )?;
    let mut wheelchair_minimum = if wheelchair {
        Some(db.prepare("SELECT min_transfer_time FROM wheelchair_transfer_minimum WHERE from_stop_id=? AND to_stop_id=?")?)
    } else {
        None
    };
    let mut replace = db.prepare("INSERT OR REPLACE INTO transfers VALUES(?,?,0,?)")?;
    let mut replace_provenance =
        db.prepare("INSERT OR REPLACE INTO transfer_provenance VALUES(?,?,?,NULL,?)")?;
    let mut stop_location = db.prepare("SELECT lon, lat FROM stops WHERE stop_id=?")?;
    let mut batch = 0u64;
    db.execute_batch("BEGIN IMMEDIATE")?;
    let boarding = &feed.boarding;
    let stops = &feed.wheelchair_stops;
    let inventory = &mut feed.inventory;
    let outcome = state.reader.stream(entry, None, &mut |row| {
        let pathway_id = row.get("pathway_id").unwrap_or("undefined").to_owned();
        let optional_cost = |field: &str| -> Result<Option<f64>> {
            if trimmed(row.get(field)).is_empty() {
                return Ok(None);
            }
            let cost = jsval::number(row.get(field));
            if !cost.is_finite() || cost < 0.0 {
                return Err(Error::new(format!(
                    "Invalid GTFS pathway {field}: {pathway_id}"
                )));
            }
            Ok(Some(cost))
        };
        let published = optional_cost("traversal_time")?;
        let estimated = if published.is_none() {
            estimated_pathway_seconds(row)?
        } else {
            None
        };
        let from_id = row.get("from_stop_id");
        let to_id = row.get("to_stop_id");
        let wheelchair_cost: Option<PathwayCost> = if wheelchair {
            let accessible = |id: Option<&str>| id.and_then(|id| boarding.get(id)) == Some(&1.0);
            let level = |id: Option<&str>| {
                id.and_then(|id| stops.get(id))
                    .map(|stop| stop.level.as_str())
            };
            let from_level = level(from_id);
            let same_level =
                from_level.is_some_and(|l| !l.is_empty()) && from_level == level(to_id);
            wheelchair_pathway_cost(row, accessible(from_id) && accessible(to_id), same_level)?
        } else {
            None
        };
        let seconds = if wheelchair {
            wheelchair_cost.as_ref().map(|c| c.seconds)
        } else {
            published.or(estimated)
        };
        if wheelchair && seconds.is_none() {
            inventory.add("wheelchairExcludedPathwayCount");
        }
        let provenance = if wheelchair {
            wheelchair_cost
                .as_ref()
                .map_or("gtfs_pathway", |c| c.provenance)
        } else if estimated.is_none() {
            "gtfs_pathway"
        } else {
            "gtfs_pathway_estimated"
        };
        let mut location = |id: Option<&str>| -> Result<Option<(Option<f64>, Option<f64>)>> {
            check_bindable(&[V::field(id)])?;
            Ok(stop_location
                .query_row([id.unwrap()], |r| {
                    Ok((r.get::<_, Option<f64>>(0)?, r.get::<_, Option<f64>>(1)?))
                })
                .optional()?)
        };
        let from = location(from_id)?;
        let to = location(to_id)?;
        let chord = match (from, to) {
            (Some((Some(lon1), Some(lat1))), Some((Some(lon2), Some(lat2))))
                if [lon1, lat1, lon2, lat2].iter().all(|v| v.is_finite()) =>
            {
                Some(haversine_km(lon1, lat1, lon2, lat2) * 1000.0)
            }
            _ => None,
        };
        let distance = if wheelchair && seconds.is_none() {
            None
        } else {
            let wheelchair_length = if wheelchair {
                optional_cost("wheelchair_length")?.filter(|v| *v != 0.0)
            } else {
                None
            };
            match wheelchair_length {
                Some(length) => Some(length),
                None => match optional_cost("length")? {
                    Some(length) => Some(length),
                    None => chord.filter(|c| *c > 0.0),
                },
            }
        };
        if seconds.is_none() && distance.is_none() {
            inventory.add("unpricedPathwayCount");
        }
        let mut add = |from: Option<&str>, to: Option<&str>| -> Result<()> {
            check_bindable(&[V::field(from), V::field(to)])?;
            let (from, to) = (from.unwrap(), to.unwrap());
            let existing = existing_pathway
                .query_row([from, to], |r| {
                    Ok((
                        r.get::<_, Option<f64>>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<f64>>(3)?,
                    ))
                })
                .optional()?;
            let is_pathway = |p: &Option<String>| {
                matches!(
                    p.as_deref(),
                    Some("gtfs_pathway" | "gtfs_pathway_estimated")
                )
            };
            if wheelchair {
                if existing.as_ref().is_some_and(|e| e.1 == Some(3.0)) {
                    return Ok(());
                }
                let minimum = wheelchair_minimum
                    .as_mut()
                    .unwrap()
                    .query_row([from, to], |r| r.get::<_, Option<f64>>(0))
                    .optional()?
                    .flatten()
                    .unwrap_or(0.0);
                let duration = seconds.map(|s| {
                    if s.is_nan() || minimum.is_nan() {
                        f64::NAN
                    } else {
                        s.max(minimum)
                    }
                });
                if let Some(e) = &existing
                    && is_pathway(&e.2)
                    && let Some(existing_minimum) = e.0
                    && duration.is_none_or(|d| existing_minimum <= d)
                {
                    return Ok(());
                }
                run(
                    &mut replace,
                    &[V::Text(from), V::Text(to), V::opt_num(duration)],
                )?;
                run(
                    &mut replace_provenance,
                    &[
                        V::Text(from),
                        V::Text(to),
                        V::Text(provenance),
                        V::opt_num(distance),
                    ],
                )?;
            } else {
                let candidate = TransferCost {
                    provenance: Some(provenance),
                    min_transfer_time: seconds,
                    path_distance_m: distance,
                };
                let duration = transfer_duration_seconds(&candidate);
                if let Some(e) = &existing
                    && is_pathway(&e.2)
                    && let Some(duration) = duration
                {
                    let current = transfer_duration_seconds(&TransferCost {
                        provenance: e.2.as_deref(),
                        min_transfer_time: e.0,
                        path_distance_m: e.3,
                    });
                    if current.is_none_or(|c| duration < c) {
                        run(
                            &mut replace,
                            &[V::Text(from), V::Text(to), V::opt_num(seconds)],
                        )?;
                        run(
                            &mut replace_provenance,
                            &[
                                V::Text(from),
                                V::Text(to),
                                V::Text(provenance),
                                V::opt_num(distance),
                            ],
                        )?;
                        return Ok(());
                    }
                }
                if run(
                    &mut insert,
                    &[V::Text(from), V::Text(to), V::opt_num(seconds)],
                )? != 0
                {
                    run(
                        &mut insert_provenance,
                        &[
                            V::Text(from),
                            V::Text(to),
                            V::Text(provenance),
                            V::opt_num(distance),
                        ],
                    )?;
                }
            }
            Ok(())
        };
        add(from_id, to_id)?;
        if numeric(row.get("is_bidirectional"), 0.0) == 1.0 {
            add(to_id, from_id)?;
        }
        inventory.add("pathwayCount");
        if [
            "wheelchair_traversal_time",
            "stair_count",
            "max_slope",
            "min_width",
        ]
        .iter()
        .any(|f| !trimmed(row.get(f)).is_empty())
        {
            inventory.add("pathwayAccessibilityRuleCount");
        }
        batch += 1;
        if batch.is_multiple_of(100_000) {
            db.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
        }
        Ok(())
    });
    match outcome {
        Ok(table) => {
            db.execute_batch("COMMIT")?;
            state
                .counts
                .insert("pathways.txt".into(), table.rows as f64);
            state
                .profiles
                .push(profile("pathways.txt", true, table.rows, table.fields));
            Ok(())
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// `finalizeRoutingStoreBuild`: seal and publish; non-City stores also get
/// their static topology sidecar. Returns the topology result and bytes.
fn finalize_build(
    db: Connection,
    temp: &Path,
    output: &Path,
    progress: &mut dyn FnMut(&Progress),
    for_city: bool,
) -> Result<(Js, u64)> {
    db.execute_batch("PRAGMA optimize;")?;
    drop(db);
    if for_city {
        std::fs::rename(temp, output)?;
        let topology = Js::object()
            .with("ready", false)
            .with("reason", "city_transfers_pending");
        return Ok((topology, std::fs::metadata(output)?.len()));
    }
    let staged = build_default_sidecar(temp, output, progress)?;
    let topology = publish_with_sidecar(temp, output, staged)?;
    Ok((topology, std::fs::metadata(output)?.len()))
}

/// `buildNationalGtfsStore({ zipPath, outputPath, forCity, wheelchair, wheelchairStreets })`.
pub fn build_store(
    zip: &Path,
    output: &Path,
    options: &BuildOptions,
    for_city: bool,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Js> {
    import_feed(
        &ImportOptions {
            zip,
            output,
            for_city,
            scope: "",
            wheelchair: options.wheelchair,
            wheelchair_streets: &options.wheelchair_streets,
        },
        None,
        progress,
    )
}

/// `buildNationalGtfsCityStore({ feeds, outputPath, wheelchair, wheelchairStreets })`.
pub fn build_city_store(
    feeds: &[Feed],
    output: &Path,
    options: &BuildOptions,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Js> {
    if feeds.is_empty() {
        return Err(Error::new("At least one GTFS feed is required."));
    }
    let mut descriptors: Vec<Feed> = feeds
        .iter()
        .map(|feed| Feed {
            scope: trim(&feed.scope).to_owned(),
            path: resolve(&feed.path),
        })
        .collect();
    descriptors.sort_by(|a, b| vigo_format::js::locale_compare(&a.scope, &b.scope));
    let unique: HashSet<&str> = descriptors.iter().map(|d| d.scope.as_str()).collect();
    if descriptors.iter().any(|d| d.scope.is_empty()) || unique.len() != descriptors.len() {
        return Err(Error::new("GTFS scopes must be non-empty and unique."));
    }
    if descriptors.len() == 1 {
        return build_store(&descriptors[0].path, output, options, true, progress);
    }
    let started = Instant::now();
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = PathBuf::from(format!("{}.building", path_text(output)));
    discard_build_database(&temp);
    let mut slot = Some(open_build_database(&temp)?);
    let outcome = (|| -> Result<Js> {
        create_schema(slot.as_ref().unwrap())?;
        let mut sources = Vec::new();
        for feed in &descriptors {
            let scope = feed.scope.clone();
            let mut scoped = |event: &Progress| {
                progress(&Progress {
                    phase: format!("{scope}: {}", event.phase),
                    progress: event.progress,
                    detail: event.detail.clone(),
                    work: event.work,
                })
            };
            sources.push(import_feed(
                &ImportOptions {
                    zip: &feed.path,
                    output,
                    for_city: true,
                    scope: &feed.scope,
                    wheelchair: options.wheelchair,
                    wheelchair_streets: &options.wheelchair_streets,
                },
                Some(&mut slot),
                &mut scoped,
            )?);
        }
        let db = slot.as_ref().expect("routing database is open");
        report(progress, "Building combined routing indexes", 0.9, "");
        create_indexes(db, true)?;
        let candidates = link_nearby_transfer_stops(db)?;
        let scopes: Vec<String> = descriptors.iter().map(|d| d.scope.clone()).collect();
        let metadata = merged_metadata(db, &scopes, &sources, candidates, true)?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        write_metadata(db, "INSERT INTO metadata VALUES(?,?)", &metadata)?;
        db.execute_batch("COMMIT")?;
        let db = slot.take().expect("routing database is open");
        let (topology, bytes) = finalize_build(db, &temp, output, progress, true)?;
        Ok(metadata
            .with("staticTopology", topology)
            .with("path", path_text(output))
            .with("bytes", bytes)
            .with("buildSeconds", started.elapsed().as_secs_f64()))
    })();
    if outcome.is_err() {
        drop(slot.take());
        cleanup_failed_build(&temp, output, &[]);
    }
    outcome
}
