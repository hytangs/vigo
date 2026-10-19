//! Stream admitted stop times into the permanent 0.5 connections layout.
//! The caller must close its SQLite handles before transferring ownership here.
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::collections::HashSet;
use vigo_route::types::*;

type CompileResult<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GtfsConnectionInput {
    pub store_path: String,
    pub stop_times_path: String,
    pub excluded_trip_ids: Vec<String>,
    pub cache_kib: u32,
}

#[derive(Default, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GtfsConnectionResult {
    pub connection_count: f64,
    pub bridged_untimed_gap_count: f64,
    pub exact_frequency_expanded_trip_count: f64,
    pub exact_frequency_expanded_connection_count: f64,
}

struct StopTime {
    trip_id: String,
    sequence: f64,
    stop_id: String,
    arrival: Option<f64>,
    departure: Option<f64>,
    can_board: bool,
    can_alight: bool,
}
struct Instance {
    trip_id: String,
    offset: f64,
}
struct Trip {
    route: String,
    service: String,
    direction: Option<String>,
    instances: Option<Vec<Instance>>,
}

// Preserve the published compiler's inclusive frequency endpoint and ordering.
// Changing these semantics is a separate correctness change, not a migration.
fn frequency_instances(db: &Connection, trip: &str, start: f64) -> CompileResult<Vec<Instance>> {
    let mut statement = db.prepare_cached("SELECT start_time,end_time,headway_secs FROM frequencies WHERE trip_id=? AND exact_times=1 ORDER BY start_time,end_time,headway_secs")?;
    let mut rows = statement.query([trip])?;
    let mut instances = Vec::new();
    let mut seen = HashSet::new();
    while let Some(row) = rows.next()? {
        let from: f64 = row.get(0)?;
        let to: f64 = row.get(1)?;
        let headway: f64 = row.get(2)?;
        let count = ((to - from) / headway).floor() + 1.0;
        if !from.is_finite()
            || !to.is_finite()
            || !headway.is_finite()
            || headway <= 0.0
            || !count.is_finite()
            || !(1.0..=100_000.0).contains(&count)
        {
            return Err(format!("GTFS exact frequency window for trip {trip} is outside the supported expansion bound.").into());
        }
        for i in 0..count as usize {
            let departure = from + i as f64 * headway;
            let id = format!("{trip}#frequency-{departure}");
            if seen.insert(id.clone()) {
                instances.push(Instance {
                    trip_id: id,
                    offset: departure - start,
                });
            }
        }
    }
    Ok(instances)
}

fn compile(
    db: &Connection,
    stage: &Connection,
    excluded: &HashSet<&str>,
) -> CompileResult<GtfsConnectionResult> {
    let known_stops = db
        .prepare("SELECT stop_id FROM stops")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    let mut trip_lookup =
        db.prepare("SELECT route_id,service_id,direction_id FROM trips WHERE trip_id=?")?;
    let mut insert_trip = db.prepare("INSERT OR IGNORE INTO trips VALUES(?,?,?,?)")?;
    let mut shape_lookup = db.prepare("SELECT shape_id FROM trip_shapes WHERE trip_id=?")?;
    let mut insert_shape = db.prepare("INSERT OR IGNORE INTO trip_shapes VALUES(?,?)")?;
    let mut copy_details = db.prepare(
        "INSERT INTO trip_details SELECT ?,headsign,short_name FROM trip_details WHERE trip_id=?",
    )?;
    let mut insert = db.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)")?;
    let mut permissions = db.prepare("INSERT INTO connection_permissions VALUES(?,?,?,?)")?;
    let mut source = stage.prepare("SELECT trip_id,stop_sequence,stop_id,arrival,departure,can_board,can_alight FROM stop_times ORDER BY trip_id,stop_sequence")?;
    let mut rows = source.query([])?;
    let mut previous: Option<StopTime> = None;
    let mut trip: Option<Trip> = None;
    let mut frequency_trip_ids = HashSet::new();
    let mut result = GtfsConnectionResult::default();
    while let Some(row) = rows.next()? {
        let row = StopTime {
            trip_id: row.get(0)?,
            sequence: row.get(1)?,
            stop_id: row.get(2)?,
            arrival: row.get(3)?,
            departure: row.get(4)?,
            can_board: row.get::<_, i64>(5)? == 1,
            can_alight: row.get::<_, i64>(6)? == 1,
        };
        if !known_stops.contains(&row.stop_id) {
            return Err(format!(
                "Broken GTFS reference stop_times.stop_id -> stops.stop_id: trip {} references {}.",
                if row.trip_id.is_empty() {
                    "(missing)"
                } else {
                    &row.trip_id
                },
                if row.stop_id.is_empty() {
                    "(missing)"
                } else {
                    &row.stop_id
                }
            )
            .into());
        }
        if previous
            .as_ref()
            .is_none_or(|prev| prev.trip_id != row.trip_id)
        {
            let referenced = trip_lookup
                .query_row([&row.trip_id], |r| {
                    Ok(Trip {
                        route: r.get(0)?,
                        service: r.get(1)?,
                        direction: r.get(2)?,
                        instances: None,
                    })
                })
                .optional()?;
            if referenced.is_none() {
                return Err(format!(
                    "Broken GTFS reference stop_times.trip_id -> trips.trip_id: {}.",
                    if row.trip_id.is_empty() {
                        "(missing)"
                    } else {
                        &row.trip_id
                    }
                )
                .into());
            }
            trip = if excluded.contains(row.trip_id.as_str()) {
                None
            } else {
                referenced
            };
            previous = Some(row);
            continue;
        }
        let prev = previous.as_ref().expect("trip has a previous stop");
        if row.sequence <= prev.sequence {
            return Err(format!(
                "Non-increasing or duplicate GTFS stop_sequence for trip {} at {}.",
                row.trip_id, row.sequence
            )
            .into());
        }
        let departure = prev.departure.or(prev.arrival);
        let arrival = row.arrival.or(row.departure);
        if let (Some(departure), Some(arrival)) = (departure, arrival)
            && arrival < departure
        {
            return Err(format!(
                "Non-monotone GTFS trip time for trip {} between stop_sequence {} and {}.",
                row.trip_id, prev.sequence, row.sequence
            )
            .into());
        }
        if let Some(trip) = trip.as_mut() {
            if trip.instances.is_none() {
                // Number(null) is zero in the retained JS compiler.
                let mut instances =
                    frequency_instances(db, &row.trip_id, departure.unwrap_or(0.0))?;
                for instance in &instances {
                    if !frequency_trip_ids.insert(instance.trip_id.clone()) {
                        continue;
                    }
                    insert_trip.execute(params![
                        instance.trip_id,
                        trip.route,
                        trip.service,
                        trip.direction
                    ])?;
                    copy_details.execute(params![instance.trip_id, row.trip_id])?;
                    let shape: Option<String> = shape_lookup
                        .query_row([&row.trip_id], |r| r.get(0))
                        .optional()?;
                    if let Some(shape) = shape.filter(|s| !s.is_empty()) {
                        insert_shape.execute(params![instance.trip_id, shape])?;
                    }
                    result.exact_frequency_expanded_trip_count += 1.0;
                }
                if instances.is_empty() {
                    instances.push(Instance {
                        trip_id: row.trip_id.clone(),
                        offset: 0.0,
                    });
                }
                trip.instances = Some(instances);
            }
            if let (Some(departure), Some(arrival)) = (departure, arrival) {
                for instance in trip.instances.as_ref().expect("instances initialized") {
                    insert.execute(params![
                        departure + instance.offset,
                        arrival + instance.offset,
                        instance.trip_id,
                        trip.route,
                        trip.service,
                        trip.direction,
                        prev.stop_id,
                        row.stop_id,
                        prev.sequence
                    ])?;
                    if !prev.can_board || !row.can_alight {
                        permissions.execute(params![
                            instance.trip_id,
                            prev.sequence,
                            i32::from(prev.can_board),
                            i32::from(row.can_alight)
                        ])?;
                    }
                    result.connection_count += 1.0;
                    if instance.trip_id != row.trip_id {
                        result.exact_frequency_expanded_connection_count += 1.0;
                    }
                }
                if row.sequence > prev.sequence + 1.0 {
                    result.bridged_untimed_gap_count += 1.0;
                }
            }
        }
        if row.arrival.is_some() || row.departure.is_some() {
            previous = Some(row);
        }
    }
    Ok(result)
}

fn compile_files(input: GtfsConnectionInput) -> CompileResult<GtfsConnectionResult> {
    if std::fs::canonicalize(&input.store_path)? == std::fs::canonicalize(&input.stop_times_path)? {
        return Err("GTFS compiler requires distinct routing and stop-time databases.".into());
    }
    if input.cache_kib == 0 || input.cache_kib > 1_048_576 {
        return Err("GTFS compiler cacheKiB must be between 1 and 1048576.".into());
    }
    let mut db = Connection::open_with_flags(
        &input.store_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let stage = Connection::open_with_flags(
        &input.stop_times_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // Roll back this unpublished operator on error. Never create missing inputs.
    db.execute_batch(&format!(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA cache_size=-{};",
        input.cache_kib
    ))?;
    stage.execute_batch(&format!("PRAGMA cache_size=-{};", input.cache_kib))?;
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let excluded = input.excluded_trip_ids.iter().map(String::as_str).collect();
    let result = compile(&transaction, &stage, &excluded)?;
    transaction.commit()?;
    Ok(result)
}
pub fn compile_gtfs_connections(input: GtfsConnectionInput) -> Result<GtfsConnectionResult> {
    compile_files(input)
        .map_err(|error| Error::from_reason(format!("GTFS connection compiler: {error}")))
}
