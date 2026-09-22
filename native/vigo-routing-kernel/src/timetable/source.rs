//! Read a service slice directly from SQLite into native column buffers.
//! No per-connection objects or strings cross the Node-API boundary.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;

#[napi(object)]
pub struct ServiceTimetableInput {
    pub store_path: String,
    pub stop_ids: Vec<String>,
    pub service_ids: Vec<String>,
    pub has_connection_permissions: bool,
    pub segment_count: Option<u32>,
}

#[napi(object)]
pub struct ServiceTimetableResult {
    pub stop_ids: Vec<String>,
    pub departure_seconds: Uint32Array,
    pub arrival_seconds: Uint32Array,
    pub from_stop: Uint32Array,
    pub to_stop: Uint32Array,
    pub sequence: Uint32Array,
    pub segment_trip: Uint32Array,
    pub segment_run: Uint32Array,
    pub continuity_break: Uint8Array,
    pub can_board: Uint8Array,
    pub can_alight: Uint8Array,
    pub trip_start: Uint32Array,
    pub trip_ids: Vec<String>,
    pub route_ids: Vec<String>,
    pub service_ids: Vec<String>,
    pub direction_ids: Vec<String>,
    pub run_count: u32,
    pub stop_count: u32,
}

fn source_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("Native service timetable: {error}"))
}

fn stop_index(ids: &mut Vec<String>, index: &mut HashMap<String, u32>, id: &str) -> u32 {
    if let Some(&value) = index.get(id) {
        return value;
    }
    let value = ids.len() as u32;
    ids.push(id.to_owned());
    index.insert(id.to_owned(), value);
    value
}

// Match JavaScript's Uint32Array assignment for the admitted numeric columns.
fn seconds(value: f64) -> u32 {
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}

#[napi]
pub fn read_service_timetable(input: ServiceTimetableInput) -> Result<ServiceTimetableResult> {
    let db = Connection::open_with_flags(
        &input.store_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(source_error)?;
    db.execute_batch("PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; CREATE TEMP TABLE active_kernel_services(service_id TEXT PRIMARY KEY) WITHOUT ROWID;").map_err(source_error)?;
    {
        let mut insert = db
            .prepare("INSERT OR IGNORE INTO active_kernel_services VALUES(?)")
            .map_err(source_error)?;
        for id in &input.service_ids {
            insert.execute([id]).map_err(source_error)?;
        }
    }
    let permission = if input.has_connection_permissions {
        (
            "LEFT JOIN connection_permissions p ON p.trip_id=c.trip_id AND p.stop_sequence=c.stop_sequence",
            "COALESCE(p.can_board,1), COALESCE(p.can_alight,1)",
        )
    } else {
        ("", "1,1")
    };
    let sql = format!(
        "SELECT c.departure,c.arrival,c.trip_id,c.route_id,c.service_id,c.direction_id,c.from_stop_id,c.to_stop_id,c.stop_sequence,{} FROM connections c JOIN active_kernel_services a ON a.service_id=c.service_id {} ORDER BY c.trip_id,c.stop_sequence",
        permission.1, permission.0
    );
    let mut statement = db.prepare(&sql).map_err(source_error)?;
    let mut rows = statement.query([]).map_err(source_error)?;
    let expected = input.segment_count.map(|count| count as usize);
    let capacity = expected.unwrap_or(8192);
    let mut stop_ids = input.stop_ids;
    let mut stops: HashMap<String, u32> = stop_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i as u32))
        .collect();
    let mut departure = Vec::with_capacity(capacity);
    let mut arrival = Vec::with_capacity(capacity);
    let mut from = Vec::with_capacity(capacity);
    let mut to = Vec::with_capacity(capacity);
    let mut sequence = Vec::with_capacity(capacity);
    let mut trip = Vec::with_capacity(capacity);
    let mut run = Vec::with_capacity(capacity);
    let mut breaks = Vec::with_capacity(capacity);
    let mut board = Vec::with_capacity(capacity);
    let mut alight = Vec::with_capacity(capacity);
    let mut trip_start = Vec::new();
    let mut trip_ids = Vec::<String>::new();
    let mut route_ids = Vec::<String>::new();
    let mut service_ids = Vec::<String>::new();
    let mut direction_ids = Vec::new();
    let mut run_count = 0;
    let mut previous_to = String::new();
    let mut previous_route = String::new();
    let mut previous_service = String::new();
    let mut previous_sequence = 0.0;
    let mut previous_arrival = 0.0;
    while let Some(row) = rows.next().map_err(source_error)? {
        if expected.is_some_and(|count| departure.len() >= count)
            || departure.len() >= u32::MAX as usize
        {
            return Err(source_error("service slice changed while reading"));
        }
        let text = |i| -> Result<&str> {
            row.get_ref(i)
                .map_err(source_error)?
                .as_str()
                .map_err(source_error)
        };
        let number = |i| -> Result<f64> { row.get::<_, f64>(i).map_err(source_error) };
        let departure_value = number(0)?;
        let arrival_value = number(1)?;
        let trip_id = text(2)?;
        let route_id = text(3)?;
        let service_id = text(4)?;
        let from_id = text(6)?;
        let to_id = text(7)?;
        let sequence_value = number(8)?;
        let new_trip = trip_ids.last().is_none_or(|id| id != trip_id);
        let unsafe_gap = !new_trip
            && previous_to != from_id
            && !(sequence_value - previous_sequence > 1.0
                && previous_route == route_id
                && previous_service == service_id
                && departure_value >= previous_arrival);
        if new_trip {
            trip_start.push(departure.len() as u32);
            trip_ids.push(trip_id.to_owned());
            route_ids.push(route_id.to_owned());
            service_ids.push(service_id.to_owned());
            direction_ids.push(
                row.get::<_, Option<String>>(5)
                    .map_err(source_error)?
                    .unwrap_or_default(),
            );
        }
        if new_trip || unsafe_gap {
            run_count += 1;
        }
        departure.push(seconds(departure_value));
        arrival.push(seconds(arrival_value));
        from.push(stop_index(&mut stop_ids, &mut stops, from_id));
        to.push(stop_index(&mut stop_ids, &mut stops, to_id));
        sequence.push(seconds(sequence_value));
        trip.push(trip_ids.len() as u32 - 1);
        run.push(run_count - 1);
        breaks.push(u8::from(unsafe_gap));
        board.push(u8::from(number(9)? == 1.0));
        alight.push(u8::from(number(10)? == 1.0));
        previous_to.clear();
        previous_to.push_str(to_id);
        previous_route.clear();
        previous_route.push_str(route_id);
        previous_service.clear();
        previous_service.push_str(service_id);
        previous_sequence = sequence_value;
        previous_arrival = arrival_value;
    }
    if expected.is_some_and(|count| departure.len() != count) {
        return Err(source_error("service slice changed while reading"));
    }
    trip_start.push(departure.len() as u32);
    Ok(ServiceTimetableResult {
        stop_count: stop_ids.len() as u32,
        stop_ids,
        run_count,
        departure_seconds: departure.into(),
        arrival_seconds: arrival.into(),
        from_stop: from.into(),
        to_stop: to.into(),
        sequence: sequence.into(),
        segment_trip: trip.into(),
        segment_run: run.into(),
        continuity_break: breaks.into(),
        can_board: board.into(),
        can_alight: alight.into(),
        trip_start: trip_start.into(),
        trip_ids,
        route_ids,
        service_ids,
        direction_ids,
    })
}
