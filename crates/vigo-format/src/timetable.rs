//! Read a service slice directly from SQLite into native column buffers.
//! No per-connection objects or strings cross the Node-API boundary.
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use vigo_route::types::*;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInstance {
    pub service_id: String,
    pub offset_seconds: i32,
    pub service_date: String,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTimetableInput {
    pub store_path: String,
    pub stop_ids: Vec<String>,
    pub service_ids: Vec<String>,
    pub has_connection_permissions: bool,
    pub segment_count: Option<u32>,
    pub service_instances: Option<Vec<ServiceInstance>>,
    /// Include departures through this service-clock second. Used only for
    /// scheduled slices; realtime preparation needs the unfiltered source.
    pub maximum_departure_seconds: Option<u32>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTimetableResult {
    pub stop_ids: Vec<String>,
    pub departure_seconds: U32Buffer,
    pub arrival_seconds: U32Buffer,
    pub from_stop: U32Buffer,
    pub to_stop: U32Buffer,
    pub sequence: U32Buffer,
    pub segment_trip: U32Buffer,
    pub segment_run: U32Buffer,
    pub continuity_break: U8Buffer,
    pub can_board: U8Buffer,
    pub can_alight: U8Buffer,
    pub trip_start: U32Buffer,
    pub trip_ids: Vec<String>,
    pub route_ids: Vec<String>,
    pub service_ids: Vec<String>,
    pub direction_ids: Vec<String>,
    pub trip_service_dates: Vec<String>,
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

// Match JavaScript's U32Buffer assignment for the admitted numeric columns.
fn seconds(value: f64) -> u32 {
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}
pub fn read_service_timetable(input: ServiceTimetableInput) -> Result<ServiceTimetableResult> {
    read_service_timetable_ordered(input, true)
}

fn read_service_timetable_ordered(
    input: ServiceTimetableInput,
    trip_major: bool,
) -> Result<ServiceTimetableResult> {
    let db = Connection::open_with_flags(
        &input.store_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(source_error)?;
    db.execute_batch("PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; CREATE TEMP TABLE active_kernel_services(service_id TEXT,offset_seconds INTEGER,service_date TEXT,PRIMARY KEY(service_id,offset_seconds)) WITHOUT ROWID;").map_err(source_error)?;
    {
        let mut insert = db
            .prepare("INSERT OR IGNORE INTO active_kernel_services VALUES(?,?,?)")
            .map_err(source_error)?;
        if let Some(instances) = &input.service_instances {
            for instance in instances {
                insert
                    .execute(rusqlite::params![
                        instance.service_id,
                        instance.offset_seconds,
                        instance.service_date
                    ])
                    .map_err(source_error)?;
            }
        } else {
            for id in &input.service_ids {
                insert
                    .execute(rusqlite::params![id, 0, ""])
                    .map_err(source_error)?;
            }
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
    let row_order = if trip_major {
        "c.trip_id,a.offset_seconds,c.stop_sequence"
    } else {
        "a.offset_seconds,c.trip_id,c.stop_sequence"
    };
    let sql = format!(
        "SELECT c.departure+a.offset_seconds,c.arrival+a.offset_seconds,c.trip_id,c.route_id,c.service_id,c.direction_id,c.from_stop_id,c.to_stop_id,c.stop_sequence,{},a.service_date,a.offset_seconds FROM connections c JOIN active_kernel_services a ON a.service_id=c.service_id {} WHERE c.departure+a.offset_seconds>=0 AND c.departure+a.offset_seconds<=?1 ORDER BY {row_order}",
        permission.1, permission.0
    );
    let mut statement = db.prepare(&sql).map_err(source_error)?;
    let mut rows = statement
        .query([input.maximum_departure_seconds.unwrap_or(u32::MAX)])
        .map_err(source_error)?;
    let expected = input.segment_count.map(|count| count as usize);
    let capacity = expected.unwrap_or(8192);
    let fixed_stop_count = input.stop_ids.len();
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
    let mut trip_service_dates = Vec::<String>::new();
    let mut trip_offsets = Vec::new();
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
        let service_date = text(11)?;
        let new_trip = trip_ids.last().is_none_or(|id| id != trip_id)
            || trip_service_dates
                .last()
                .is_none_or(|day| day != service_date);
        let unsafe_gap = !new_trip
            && previous_to != from_id
            && !(sequence_value - previous_sequence > 1.0
                && previous_route == route_id
                && previous_service == service_id
                && departure_value >= previous_arrival);
        if new_trip {
            trip_start.push(departure.len() as u32);
            trip_offsets.push(row.get::<_, i32>(12).map_err(source_error)?);
            trip_ids.push(trip_id.to_owned());
            trip_service_dates.push(service_date.to_owned());
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
    let result = ServiceTimetableResult {
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
        trip_service_dates,
    };
    Ok(if trip_major {
        order_service_instances(result, &trip_offsets, fixed_stop_count)
    } else {
        result
    })
}

// SQLite reads in trip order, matching the source primary key, and sorts only
// within each trip. Restore the canonical offset-major order with a stable
// permutation of trip blocks, rather than sorting every row and its strings.
fn order_service_instances(
    mut source: ServiceTimetableResult,
    offsets: &[i32],
    fixed_stop_count: usize,
) -> ServiceTimetableResult {
    if offsets.windows(2).all(|pair| pair[0] <= pair[1]) {
        return source;
    }
    let mut order: Vec<usize> = (0..offsets.len()).collect();
    order.sort_by_key(|&trip| offsets[trip]);
    fn segments<T: Copy>(values: &[T], starts: &[u32], order: &[usize]) -> Vec<T> {
        let mut output = Vec::with_capacity(values.len());
        for &trip in order {
            output.extend_from_slice(&values[starts[trip] as usize..starts[trip + 1] as usize]);
        }
        output
    }
    let starts = source.trip_start.to_vec();
    macro_rules! reorder {
        ($($field:ident),* $(,)?) => {$(
            source.$field = segments(&source.$field, &starts, &order).into();
        )*};
    }
    reorder!(
        departure_seconds,
        arrival_seconds,
        sequence,
        continuity_break,
        can_board,
        can_alight
    );
    let mut from_stop = segments(&source.from_stop, &starts, &order);
    let mut to_stop = segments(&source.to_stop, &starts, &order);
    // Preserve the original dictionary's prefix and first-encounter order for
    // source stops absent from the caller's dictionary.
    if source.stop_ids.len() > fixed_stop_count {
        let mut ids = source.stop_ids[..fixed_stop_count].to_vec();
        let mut remap = vec![u32::MAX; source.stop_ids.len()];
        for (index, value) in remap[..fixed_stop_count].iter_mut().enumerate() {
            *value = index as u32;
        }
        for segment in 0..from_stop.len() {
            for stop in [&mut from_stop[segment], &mut to_stop[segment]] {
                let old = *stop as usize;
                if remap[old] == u32::MAX {
                    remap[old] = ids.len() as u32;
                    ids.push(source.stop_ids[old].clone());
                }
                *stop = remap[old];
            }
        }
        source.stop_ids = ids;
    }
    source.from_stop = from_stop.into();
    source.to_stop = to_stop.into();
    let mut segment_trip = Vec::with_capacity(source.segment_trip.len());
    let mut segment_run = Vec::with_capacity(source.segment_run.len());
    let mut trip_start = Vec::with_capacity(order.len() + 1);
    let mut segment = 0;
    let mut run = 0;
    for (trip, &old) in order.iter().enumerate() {
        trip_start.push(segment as u32);
        for within in 0..(starts[old + 1] - starts[old]) {
            if within == 0 || source.continuity_break[segment] != 0 {
                run += 1;
            }
            segment_trip.push(trip as u32);
            segment_run.push(run - 1);
            segment += 1;
        }
    }
    trip_start.push(segment as u32);
    source.trip_start = trip_start.into();
    source.segment_trip = segment_trip.into();
    source.segment_run = segment_run.into();
    fn trips(values: Vec<String>, order: &[usize]) -> Vec<String> {
        let mut values: Vec<Option<String>> = values.into_iter().map(Some).collect();
        order
            .iter()
            .map(|&trip| values[trip].take().unwrap())
            .collect()
    }
    source.trip_ids = trips(source.trip_ids, &order);
    source.route_ids = trips(source.route_ids, &order);
    source.service_ids = trips(source.service_ids, &order);
    source.direction_ids = trips(source.direction_ids, &order);
    source.trip_service_dates = trips(source.trip_service_dates, &order);
    source
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trip_block_read_matches_full_row_sort() {
        let path = std::env::temp_dir().join(format!(
            "vigo-source-order-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE connections(departure INTEGER,arrival INTEGER,
            trip_id TEXT,route_id TEXT,service_id TEXT,direction_id TEXT,
            from_stop_id TEXT,to_stop_id TEXT,stop_sequence INTEGER,
            PRIMARY KEY(trip_id,stop_sequence)) WITHOUT ROWID;
            CREATE TABLE connection_permissions(trip_id TEXT,stop_sequence INTEGER,
            can_board INTEGER,can_alight INTEGER,PRIMARY KEY(trip_id,stop_sequence)) WITHOUT ROWID;").unwrap();
        for trip in (0..60).rev() {
            for sequence in 0..4 {
                let departure =
                    1_000 + trip * 100 + sequence * 600 + if trip % 3 == 0 { 86_400 } else { 0 };
                db.execute(
                    "INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)",
                    rusqlite::params![
                        departure,
                        departure + 600,
                        format!("trip-{trip:02}"),
                        "route",
                        if trip % 2 == 0 { "weekday" } else { "weekend" },
                        if trip % 2 == 0 { Some("0") } else { None },
                        format!("s{}", sequence + if trip % 7 == 0 { 1 } else { 0 }),
                        format!("s{}", sequence + 1),
                        sequence,
                    ],
                )
                .unwrap();
            }
        }
        db.execute(
            "INSERT INTO connection_permissions VALUES('trip-03',1,0,1)",
            [],
        )
        .unwrap();
        drop(db);
        for instances in [false, true] {
            for permissions in [false, true] {
                for horizon in [Some(108_000), Some(0), None] {
                    let input = || ServiceTimetableInput {
                        store_path: path.to_str().unwrap().to_owned(),
                        stop_ids: vec!["fixed".into(), "s2".into()],
                        service_ids: vec!["weekday".into(), "weekend".into()],
                        has_connection_permissions: permissions,
                        segment_count: None,
                        service_instances: instances.then(|| {
                            [-86_400, 0, 86_400]
                                .into_iter()
                                .flat_map(|offset| {
                                    ["weekday", "weekend"].into_iter().map(move |service| {
                                        ServiceInstance {
                                            service_id: service.into(),
                                            offset_seconds: offset,
                                            service_date: format!(
                                                "2026-10-{:02}",
                                                5 + offset / 86_400
                                            ),
                                        }
                                    })
                                })
                                .collect()
                        }),
                        maximum_departure_seconds: horizon,
                    };
                    let reference = read_service_timetable_ordered(input(), false).unwrap();
                    let candidate = read_service_timetable_ordered(input(), true).unwrap();
                    assert_eq!(
                        serde_json::to_value(candidate).unwrap(),
                        serde_json::to_value(reference).unwrap(),
                        "instances={instances}, permissions={permissions}, horizon={horizon:?}"
                    );
                }
            }
        }
        std::fs::remove_file(path).unwrap();
    }
}
