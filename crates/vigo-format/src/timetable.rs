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

#[cfg(test)]
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
/// The service slice in canonical (offset-major) order, equal to the SQL join
/// below. The connections primary key is read in parallel trip ranges, with
/// services, permissions and stops resolved in memory. A full read remembers
/// each trip's services, so later reads of the unchanged store read only the
/// runs of trips that carry an active service.
pub fn read_service_timetable(input: ServiceTimetableInput) -> Result<ServiceTimetableResult> {
    let fixed_stop_count = input.stop_ids.len();
    let (result, trip_offsets) = scan::read(input)?;
    Ok(order_service_instances(
        result,
        &trip_offsets,
        fixed_stop_count,
    ))
}

mod scan {
    use super::*;
    use std::hash::{BuildHasherDefault, Hasher};

    /// FxHash: short stop and trip identifiers dominate the read.
    #[derive(Default)]
    struct Fx(u64);
    impl Hasher for Fx {
        fn finish(&self) -> u64 {
            self.0
        }
        fn write(&mut self, bytes: &[u8]) {
            for chunk in bytes.chunks(8) {
                let mut word = [0u8; 8];
                word[..chunk.len()].copy_from_slice(chunk);
                self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word))
                    .wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
            }
        }
        fn write_u8(&mut self, value: u8) {
            self.write(&[value]);
        }
    }
    type Map<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;

    struct Instance {
        offset: i32,
        date: String,
    }
    /// Stops absent from the caller's dictionary are numbered after it.
    const UNKNOWN: u32 = 1 << 31;

    struct Shared {
        path: String,
        stops: Map<String, u32>,
        instances: Map<String, Vec<Instance>>,
        // Trip → stop_sequence bits → (can_board, can_alight).
        permissions: Map<String, Map<u64, (bool, bool)>>,
        maximum: f64,
    }

    #[derive(Default)]
    struct Chunk {
        departure: Vec<u32>,
        arrival: Vec<u32>,
        from: Vec<u32>,
        to: Vec<u32>,
        sequence: Vec<u32>,
        trip: Vec<u32>,
        run: Vec<u32>,
        breaks: Vec<u8>,
        board: Vec<u8>,
        alight: Vec<u8>,
        trip_start: Vec<u32>,
        trip_ids: Vec<String>,
        route_ids: Vec<String>,
        service_ids: Vec<String>,
        direction_ids: Vec<String>,
        trip_service_dates: Vec<String>,
        trip_offsets: Vec<i32>,
        run_count: u32,
        // Stops absent from the dictionary: read order, then emission order.
        pending: Vec<String>,
        pending_order: Vec<u32>,
        unknown: Vec<String>,
    }
    impl Chunk {
        fn stop(&mut self, stop: u32) -> u32 {
            if stop & UNKNOWN == 0 {
                return stop;
            }
            let pending = (stop & !UNKNOWN) as usize;
            if self.pending_order[pending] == u32::MAX {
                self.pending_order[pending] = self.unknown.len() as u32;
                self.unknown.push(self.pending[pending].clone());
            }
            UNKNOWN | self.pending_order[pending]
        }
    }

    /// One row of the trip being read; strings are interned per chunk.
    struct Row {
        departure: f64,
        arrival: f64,
        route: u32,
        service: u32,
        direction: u32,
        from: u32,
        to: u32,
        sequence: f64,
        board: bool,
        alight: bool,
        headway: bool,
    }

    fn key(value: f64) -> u64 {
        (value + 0.0).to_bits()
    }

    pub(super) fn read(input: ServiceTimetableInput) -> Result<(ServiceTimetableResult, Vec<i32>)> {
        let db = Connection::open_with_flags(
            &input.store_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(source_error)?;
        let mut instances: Map<String, Vec<Instance>> = Map::default();
        let mut add = |service: &str, offset: i32, date: &str| {
            let list = instances.entry(service.to_owned()).or_default();
            // The SQL reader's (service, offset) key keeps the first date.
            if !list.iter().any(|i| i.offset == offset) {
                list.push(Instance {
                    offset,
                    date: date.to_owned(),
                });
            }
        };
        match &input.service_instances {
            Some(list) => list
                .iter()
                .for_each(|i| add(&i.service_id, i.offset_seconds, &i.service_date)),
            None => input.service_ids.iter().for_each(|id| add(id, 0, "")),
        }
        instances
            .values_mut()
            .for_each(|list| list.sort_by_key(|i| i.offset));
        let mut permissions: Map<String, Map<u64, (bool, bool)>> = Map::default();
        if input.has_connection_permissions {
            let mut statement = db
                .prepare(
                    "SELECT trip_id,stop_sequence,can_board,can_alight FROM connection_permissions",
                )
                .map_err(source_error)?;
            let mut rows = statement.query([]).map_err(source_error)?;
            while let Some(row) = rows.next().map_err(source_error)? {
                let flag = |i| row.get::<_, f64>(i).map(|v| v == 1.0);
                permissions
                    .entry(row.get::<_, String>(0).map_err(source_error)?)
                    .or_default()
                    .entry(key(row.get::<_, f64>(1).map_err(source_error)?))
                    // A duplicate join row cannot occur: (trip, sequence) is the key.
                    .or_insert((
                        flag(2).map_err(source_error)?,
                        flag(3).map_err(source_error)?,
                    ));
            }
        }
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(8);
        let generation = generation(&input.store_path);
        let index = generation
            .as_deref()
            .and_then(|generation| cached_index(&input.store_path, generation));
        let bounds = if index.is_none() {
            trip_bounds(&db, threads)?
        } else {
            vec![]
        };
        drop(db);
        let shared = Shared {
            path: input.store_path,
            stops: input
                .stop_ids
                .iter()
                .enumerate()
                .map(|(i, id)| (id.clone(), i as u32))
                .collect(),
            instances,
            permissions,
            maximum: f64::from(input.maximum_departure_seconds.unwrap_or(u32::MAX)),
        };
        let chunks = if let Some(index) = index {
            // Read only the runs of consecutive trips whose rows carry an
            // active service; trips cluster by service, so runs are few.
            let active: Vec<bool> = index
                .names
                .iter()
                .map(|name| shared.instances.contains_key(name))
                .collect();
            let needed = |trip: &IndexedTrip| trip.services.iter().any(|&s| active[s as usize]);
            let total: u64 = index
                .trips
                .iter()
                .filter(|trip| needed(trip))
                .map(|trip| u64::from(trip.rows))
                .sum();
            // Runs split between readers at similar row counts.
            let mut groups: Vec<Vec<(&str, &str)>> = vec![vec![]];
            let (mut filled, mut open) = (0, false);
            for trip in &index.trips {
                if !needed(trip) {
                    open = false;
                    continue;
                }
                if filled * threads as u64 > total * groups.len() as u64 && groups.len() < threads {
                    groups.push(vec![]);
                    open = false;
                }
                let group = groups.last_mut().unwrap();
                match (open, group.last_mut()) {
                    (true, Some(run)) => run.1 = &trip.id,
                    _ => group.push((&trip.id, &trip.id)),
                }
                open = true;
                filled += u64::from(trip.rows);
            }
            in_parallel(groups.iter().map(|runs| {
                let shared = &shared;
                move || read_runs(shared, runs)
            }))?
            .into_iter()
            .map(|(chunk, _)| chunk)
            .collect()
        } else {
            let ranges: Vec<(Option<&str>, Option<&str>)> = (0..=bounds.len())
                .map(|i| {
                    (
                        i.checked_sub(1).map(|j| bounds[j].as_str()),
                        bounds.get(i).map(String::as_str),
                    )
                })
                .collect();
            let read = in_parallel(ranges.iter().map(|&range| {
                let shared = &shared;
                move || read_range(shared, range)
            }))?;
            let mut trips = vec![];
            let chunks = read
                .into_iter()
                .map(|(chunk, recorded)| {
                    trips.extend(recorded);
                    chunk
                })
                .collect();
            if let Some(generation) = generation {
                remember_index(&shared.path, generation, trips);
            }
            chunks
        };
        merge(chunks, input.stop_ids, input.segment_count)
    }

    fn in_parallel<T: Send>(
        jobs: impl Iterator<Item = impl FnOnce() -> Result<T> + Send>,
    ) -> Result<Vec<T>> {
        std::thread::scope(|scope| {
            let handles: Vec<_> = jobs.map(|job| scope.spawn(job)).collect();
            handles
                .into_iter()
                .map(|h| {
                    h.join()
                        .unwrap_or_else(|_| Err(source_error("reader thread panicked")))
                })
                .collect()
        })
    }

    /// Every trip of one unchanged store with the services its rows carry,
    /// from a full scan. Later reads of the store seek only active trips.
    struct TripIndex {
        names: Vec<String>,
        trips: Vec<IndexedTrip>,
    }
    struct IndexedTrip {
        id: Box<str>,
        services: Box<[u32]>,
        rows: u32,
    }
    type Indexes = Vec<(String, String, std::sync::Arc<TripIndex>)>;
    static INDEXES: std::sync::Mutex<Indexes> = std::sync::Mutex::new(vec![]);
    const RETAINED_INDEXES: usize = 8;

    /// The store file's identity, or None when commits could change rows
    /// without changing it (a WAL journal).
    fn generation(path: &str) -> Option<String> {
        use std::io::Read;
        if std::path::Path::new(&format!("{path}-wal")).exists() {
            return None;
        }
        let metadata = std::fs::metadata(path).ok()?;
        let mut header = [0u8; 100];
        std::fs::File::open(path)
            .ok()?
            .read_exact(&mut header)
            .ok()?;
        if header[18] == 2 || header[19] == 2 {
            return None;
        }
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos();
        Some(format!(
            "{}:{modified}:{:?}:{:?}:{:?}",
            metadata.len(),
            &header[24..28],
            &header[40..44],
            &header[92..96]
        ))
    }

    fn cached_index(path: &str, generation: &str) -> Option<std::sync::Arc<TripIndex>> {
        let indexes = INDEXES.lock().ok()?;
        indexes
            .iter()
            .find(|(p, g, _)| p == path && g == generation)
            .map(|(_, _, index)| index.clone())
    }

    fn remember_index(path: &str, generation: String, trips: Vec<Trip>) {
        let mut names: Vec<String> = vec![];
        let mut known: Map<String, u32> = Map::default();
        let trips = trips
            .into_iter()
            .map(|trip| IndexedTrip {
                id: trip.id.into_boxed_str(),
                services: trip
                    .services
                    .into_iter()
                    .map(|name| {
                        *known.entry(name.clone()).or_insert_with(|| {
                            names.push(name);
                            names.len() as u32 - 1
                        })
                    })
                    .collect(),
                rows: trip.rows,
            })
            .collect();
        let index = std::sync::Arc::new(TripIndex { names, trips });
        if let Ok(mut indexes) = INDEXES.lock() {
            indexes.retain(|(p, _, _)| p != path);
            if indexes.len() == RETAINED_INDEXES {
                indexes.remove(0);
            }
            indexes.push((path.to_owned(), generation, index));
        }
    }

    /// Trip identifiers that split the primary key into `parts` similar ranges.
    fn trip_bounds(db: &Connection, parts: usize) -> Result<Vec<String>> {
        let has_trips: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='trips')",
                [],
                |r| r.get(0),
            )
            .map_err(source_error)?;
        if parts < 2 || !has_trips {
            return Ok(vec![]);
        }
        // Bounds only partition the key space, so any sample of trip
        // identifiers is exact; a rowid stride keeps the sample small.
        let Ok(mut sample) = db
            .prepare(
                "SELECT trip_id FROM trips WHERE rowid % \
                 MAX(1, (SELECT MAX(rowid) FROM trips) / ?1) = 0",
            )
            .and_then(|mut s| {
                s.query_map([parts as i64 * 16], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()
            })
        else {
            return Ok(vec![]);
        };
        sample.sort_unstable();
        sample.dedup();
        if sample.len() < parts * 4 {
            return Ok(vec![]);
        }
        Ok((1..parts)
            .map(|i| sample[i * sample.len() / parts].clone())
            .collect())
    }

    fn columns(db: &Connection) -> Result<String> {
        let headway: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='headway_connections')",
                [],
                |r| r.get(0),
            )
            .map_err(source_error)?;
        let headway = headway
            && db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM headway_connections)",
                    [],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(source_error)?;
        let source = if headway {
            "(SELECT *,0 AS headway FROM connections UNION ALL SELECT *,1 AS headway FROM headway_connections)"
        } else {
            "(SELECT *,0 AS headway FROM connections)"
        };
        Ok(format!(
            "SELECT departure,arrival,trip_id,route_id,service_id,direction_id,from_stop_id,to_stop_id,stop_sequence,headway FROM {source}"
        ))
    }

    fn connect(path: &str) -> Result<Connection> {
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(source_error)?;
        // Bound the file mapping independently of the SQLite page cache.
        // The OS can reclaim these shared, file-backed pages.
        db.execute_batch("PRAGMA mmap_size=268435456; PRAGMA cache_size=-8192;")
            .map_err(source_error)?;
        Ok(db)
    }

    /// Every row of a trip-id range, recording each trip's services.
    fn read_range(
        shared: &Shared,
        (low, high): (Option<&str>, Option<&str>),
    ) -> Result<(Chunk, Vec<Trip>)> {
        let db = connect(&shared.path)?;
        let mut sql = columns(&db)?;
        let mut parameters = vec![];
        for (bound, comparison) in [(low, ">="), (high, "<")] {
            if let Some(bound) = bound {
                sql.push_str(if parameters.is_empty() {
                    " WHERE "
                } else {
                    " AND "
                });
                sql.push_str(&format!("trip_id{comparison}?{}", parameters.len() + 1));
                parameters.push(bound);
            }
        }
        sql.push_str(" ORDER BY trip_id,stop_sequence");
        let mut statement = db.prepare(&sql).map_err(source_error)?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(parameters))
            .map_err(source_error)?;
        let mut reader = Reader::new(shared, true);
        while let Some(row) = rows.next().map_err(source_error)? {
            reader.row(row)?;
        }
        reader.finish()
    }

    /// Only the given runs of consecutive trips, in primary-key order.
    fn read_runs(shared: &Shared, runs: &[(&str, &str)]) -> Result<(Chunk, Vec<Trip>)> {
        let db = connect(&shared.path)?;
        let columns = columns(&db)?;
        let mut statement = db
            .prepare(&format!(
                "{columns} WHERE trip_id>=?1 AND trip_id<=?2 ORDER BY trip_id,stop_sequence"
            ))
            .map_err(source_error)?;
        let mut reader = Reader::new(shared, false);
        for (first, last) in runs {
            let mut rows = statement.query([first, last]).map_err(source_error)?;
            while let Some(row) = rows.next().map_err(source_error)? {
                reader.row(row)?;
            }
        }
        reader.finish()
    }

    /// A trip in primary-key order, with the services its rows carry.
    struct Trip {
        id: String,
        services: Vec<String>,
        rows: u32,
    }

    /// Rows in primary-key order, emitted trip by trip.
    struct Reader<'a> {
        shared: &'a Shared,
        chunk: Chunk,
        table: Strings,
        services: Services<'a>,
        unknown: Map<String, u32>,
        trip_id: String,
        trip: Vec<Row>,
        trip_permissions: Option<&'a Map<u64, (bool, bool)>>,
        last_to: (String, u32),
        // With `record`, every trip and its services, active or not.
        record: bool,
        trips: Vec<Trip>,
    }

    impl<'a> Reader<'a> {
        fn new(shared: &'a Shared, record: bool) -> Self {
            Self {
                shared,
                chunk: Chunk::default(),
                table: Strings::default(),
                services: Services::default(),
                unknown: Map::default(),
                trip_id: String::new(),
                trip: vec![],
                trip_permissions: None,
                last_to: (String::new(), u32::MAX),
                record,
                trips: vec![],
            }
        }

        fn row(&mut self, row: &rusqlite::Row) -> Result<()> {
            let text = |i| -> Result<&str> {
                row.get_ref(i)
                    .map_err(source_error)?
                    .as_str()
                    .map_err(source_error)
            };
            let id = text(2)?;
            if id != self.trip_id {
                emit(
                    self.shared,
                    &mut self.chunk,
                    &self.trip_id,
                    &self.trip,
                    &self.table,
                    &self.services,
                )?;
                self.trip.clear();
                self.trip_id.clear();
                self.trip_id.push_str(id);
                self.trip_permissions = self.shared.permissions.get(id);
                if self.record {
                    self.trips.push(Trip {
                        id: id.to_owned(),
                        services: vec![],
                        rows: 0,
                    });
                }
            }
            let service_id = text(4)?;
            let service = self.services.index(self.shared, service_id);
            if self.record {
                let trip = self
                    .trips
                    .last_mut()
                    .ok_or_else(|| source_error("missing trip"))?;
                trip.rows += 1;
                if !trip.services.iter().any(|s| s == service_id) {
                    trip.services.push(service_id.to_owned());
                }
            }
            // Rows of services without an active instance never join.
            if self.services.instances[service as usize].is_empty() {
                return Ok(());
            }
            let route = self.table.index(0, text(3)?);
            let direction = match row.get_ref(5).map_err(source_error)? {
                rusqlite::types::ValueRef::Null => self.table.index(1, ""),
                value => self.table.index(1, value.as_str().map_err(source_error)?),
            };
            let (shared, unknown, chunk) = (self.shared, &mut self.unknown, &mut self.chunk);
            let mut stop = |value: &str| -> u32 {
                if let Some(&index) = shared.stops.get(value) {
                    return index;
                }
                let next = unknown.len() as u32;
                *unknown.entry(value.to_owned()).or_insert_with(|| {
                    chunk.pending.push(value.to_owned());
                    chunk.pending_order.push(u32::MAX);
                    UNKNOWN | next
                })
            };
            let from_id = text(6)?;
            let last_to = &mut self.last_to;
            let from = if last_to.1 != u32::MAX && last_to.0 == from_id {
                last_to.1
            } else {
                stop(from_id)
            };
            let to_id = text(7)?;
            let to = stop(to_id);
            last_to.0.clear();
            last_to.0.push_str(to_id);
            last_to.1 = to;
            let sequence = row.get::<_, f64>(8).map_err(source_error)?;
            let (board, alight) = self
                .trip_permissions
                .and_then(|p| p.get(&key(sequence)).copied())
                .unwrap_or((true, true));
            self.trip.push(Row {
                departure: row.get(0).map_err(source_error)?,
                arrival: row.get(1).map_err(source_error)?,
                route,
                service,
                direction,
                from,
                to,
                sequence,
                board,
                alight,
                headway: row.get(9).map_err(source_error)?,
            });
            Ok(())
        }

        fn finish(mut self) -> Result<(Chunk, Vec<Trip>)> {
            emit(
                self.shared,
                &mut self.chunk,
                &self.trip_id,
                &self.trip,
                &self.table,
                &self.services,
            )?;
            Ok((self.chunk, self.trips))
        }
    }

    /// Route and direction identifiers, interned per reader; the previous
    /// row's value is reused without hashing.
    #[derive(Default)]
    struct Strings {
        values: Vec<String>,
        index: Map<String, u32>,
        last: [(String, u32); 2],
    }
    impl Strings {
        fn index(&mut self, slot: usize, value: &str) -> u32 {
            let last = &mut self.last[slot];
            if last.1 != 0 && last.0 == value {
                return last.1 - 1;
            }
            let values = &mut self.values;
            let index = *self.index.entry(value.to_owned()).or_insert_with(|| {
                values.push(value.to_owned());
                values.len() as u32 - 1
            });
            last.0.clear();
            last.0.push_str(value);
            last.1 = index + 1;
            index
        }
    }

    /// Service identifiers with their active instances, resolved once each.
    #[derive(Default)]
    struct Services<'a> {
        names: Vec<String>,
        instances: Vec<&'a [Instance]>,
        index: Map<String, u32>,
        last: (String, u32),
    }
    impl<'a> Services<'a> {
        fn index(&mut self, shared: &'a Shared, value: &str) -> u32 {
            if self.last.1 != 0 && self.last.0 == value {
                return self.last.1 - 1;
            }
            let (names, instances) = (&mut self.names, &mut self.instances);
            let index = *self.index.entry(value.to_owned()).or_insert_with(|| {
                names.push(value.to_owned());
                instances.push(shared.instances.get(value).map_or(&[], Vec::as_slice));
                names.len() as u32 - 1
            });
            self.last.0.clear();
            self.last.0.push_str(value);
            self.last.1 = index + 1;
            index
        }
    }

    /// One trip's rows for each active instance, in (offset, sequence) order,
    /// through the same continuity rules as the SQL reader.
    fn emit(
        shared: &Shared,
        chunk: &mut Chunk,
        trip_id: &str,
        rows: &[Row],
        table: &Strings,
        services: &Services,
    ) -> Result<()> {
        let Some(first) = rows.first() else {
            return Ok(());
        };
        let instances = |row: &Row| services.instances[row.service as usize];
        let single = rows.iter().all(|r| r.service == first.service);
        let offsets: Vec<i32> = if single {
            instances(first).iter().map(|i| i.offset).collect()
        } else {
            let mut all: Vec<i32> = rows
                .iter()
                .flat_map(|r| instances(r).iter().map(|i| i.offset))
                .collect();
            all.sort_unstable();
            all.dedup();
            all
        };
        // The previous emitted row's state, for continuity.
        let mut previous: Option<(u32, u32, u32, f64, f64)> = None;
        for offset in offsets {
            for row in rows {
                let Some(instance) = instances(row).iter().find(|i| i.offset == offset) else {
                    continue;
                };
                // A headway template is a relative shape, not a scheduled trip.
                // Keep the full shape across midnight; its actual windows are
                // resolved separately using the original service-day offset.
                let shift = f64::from(offset)
                    + if first.headway {
                        (-(first.departure + f64::from(offset))).max(0.)
                    } else {
                        0.
                    };
                let departure = row.departure + shift;
                if !(departure >= 0.0 && departure <= shared.maximum) {
                    continue;
                }
                let arrival = row.arrival + shift;
                let new_trip = chunk.trip_ids.last().is_none_or(|id| id != trip_id)
                    || chunk
                        .trip_service_dates
                        .last()
                        .is_none_or(|day| *day != instance.date);
                let unsafe_gap = !new_trip
                    && previous.is_some_and(|(to, route, service, sequence, arrival)| {
                        to != row.from
                            && !(row.sequence - sequence > 1.0
                                && route == row.route
                                && service == row.service
                                && departure >= arrival)
                    });
                if new_trip {
                    chunk.trip_start.push(chunk.departure.len() as u32);
                    chunk.trip_offsets.push(offset);
                    chunk.trip_ids.push(trip_id.to_owned());
                    chunk.trip_service_dates.push(instance.date.clone());
                    chunk
                        .route_ids
                        .push(table.values[row.route as usize].clone());
                    chunk
                        .service_ids
                        .push(services.names[row.service as usize].clone());
                    chunk
                        .direction_ids
                        .push(table.values[row.direction as usize].clone());
                }
                if new_trip || unsafe_gap {
                    chunk.run_count += 1;
                }
                chunk.departure.push(seconds(departure));
                chunk.arrival.push(seconds(arrival));
                let (from, to) = (chunk.stop(row.from), chunk.stop(row.to));
                chunk.from.push(from);
                chunk.to.push(to);
                chunk.sequence.push(seconds(row.sequence));
                chunk.trip.push(chunk.trip_ids.len() as u32 - 1);
                chunk.run.push(chunk.run_count - 1);
                chunk.breaks.push(u8::from(unsafe_gap));
                chunk.board.push(u8::from(row.board));
                chunk.alight.push(u8::from(row.alight));
                previous = Some((row.to, row.route, row.service, row.sequence, arrival));
            }
        }
        Ok(())
    }

    fn merge(
        chunks: Vec<Chunk>,
        mut stop_ids: Vec<String>,
        segment_count: Option<u32>,
    ) -> Result<(ServiceTimetableResult, Vec<i32>)> {
        let total: usize = chunks.iter().map(|c| c.departure.len()).sum();
        if segment_count.is_some_and(|count| count as usize != total) || total >= u32::MAX as usize
        {
            return Err(source_error("service slice changed while reading"));
        }
        let mut out = Chunk::default();
        macro_rules! reserve {
            ($($field:ident),*) => {$(out.$field.reserve(total);)*};
        }
        reserve!(
            departure, arrival, from, to, sequence, trip, run, breaks, board, alight
        );
        let mut global: Map<String, u32> = Map::default();
        let (mut trip_base, mut run_base) = (0u32, 0u32);
        for chunk in chunks {
            // Unknown stops take dictionary positions in first-encounter order.
            let local: Vec<u32> = chunk
                .unknown
                .into_iter()
                .map(|id| {
                    *global.entry(id.clone()).or_insert_with(|| {
                        stop_ids.push(id);
                        stop_ids.len() as u32 - 1
                    })
                })
                .collect();
            let resolve = |stop: u32| {
                if stop & UNKNOWN != 0 {
                    local[(stop & !UNKNOWN) as usize]
                } else {
                    stop
                }
            };
            let base = out.departure.len() as u32;
            out.trip_start
                .extend(chunk.trip_start.iter().map(|s| s + base));
            out.departure.extend(chunk.departure);
            out.arrival.extend(chunk.arrival);
            out.from.extend(chunk.from.into_iter().map(resolve));
            out.to.extend(chunk.to.into_iter().map(resolve));
            out.sequence.extend(chunk.sequence);
            out.trip.extend(chunk.trip.iter().map(|t| t + trip_base));
            out.run.extend(chunk.run.iter().map(|r| r + run_base));
            out.breaks.extend(chunk.breaks);
            out.board.extend(chunk.board);
            out.alight.extend(chunk.alight);
            trip_base += chunk.trip_ids.len() as u32;
            run_base += chunk.run_count;
            out.trip_ids.extend(chunk.trip_ids);
            out.route_ids.extend(chunk.route_ids);
            out.service_ids.extend(chunk.service_ids);
            out.direction_ids.extend(chunk.direction_ids);
            out.trip_service_dates.extend(chunk.trip_service_dates);
            out.trip_offsets.extend(chunk.trip_offsets);
        }
        out.trip_start.push(total as u32);
        Ok((
            ServiceTimetableResult {
                stop_count: stop_ids.len() as u32,
                stop_ids,
                run_count: run_base,
                departure_seconds: out.departure.into(),
                arrival_seconds: out.arrival.into(),
                from_stop: out.from.into(),
                to_stop: out.to.into(),
                sequence: out.sequence.into(),
                segment_trip: out.trip.into(),
                segment_run: out.run.into(),
                continuity_break: out.breaks.into(),
                can_board: out.board.into(),
                can_alight: out.alight.into(),
                trip_start: out.trip_start.into(),
                trip_ids: out.trip_ids,
                route_ids: out.route_ids,
                service_ids: out.service_ids,
                direction_ids: out.direction_ids,
                trip_service_dates: out.trip_service_dates,
            },
            out.trip_offsets,
        ))
    }
}

/// The SQL join the scan reproduces; kept as the reference for tests.
#[cfg(test)]
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
        db.execute_batch(
            "CREATE TABLE connections(departure INTEGER,arrival INTEGER,
            trip_id TEXT,route_id TEXT,service_id TEXT,direction_id TEXT,
            from_stop_id TEXT,to_stop_id TEXT,stop_sequence INTEGER,
            PRIMARY KEY(trip_id,stop_sequence)) WITHOUT ROWID;
            CREATE TABLE connection_permissions(trip_id TEXT,stop_sequence INTEGER,
            can_board INTEGER,can_alight INTEGER,PRIMARY KEY(trip_id,stop_sequence)) WITHOUT ROWID;
            CREATE TABLE trips(trip_id TEXT PRIMARY KEY);",
        )
        .unwrap();
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
        // One trip whose rows belong to two services.
        for (sequence, service) in [(0, "weekday"), (1, "weekend"), (2, "weekday")] {
            db.execute(
                "INSERT INTO connections VALUES(?,?,'trip-mixed','route',?,NULL,?,?,?)",
                rusqlite::params![
                    40_000 + sequence * 60,
                    40_060 + sequence * 60,
                    service,
                    format!("s{sequence}"),
                    format!("s{}", sequence + 1),
                    sequence,
                ],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO connection_permissions VALUES('trip-03',1,0,1)",
            [],
        )
        .unwrap();
        // Split the scan into several trip ranges.
        db.execute_batch(
            "INSERT INTO trips SELECT DISTINCT trip_id FROM connections ORDER BY random();",
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
                    let reference = serde_json::to_value(reference).unwrap();
                    assert_eq!(
                        serde_json::to_value(candidate).unwrap(),
                        reference,
                        "instances={instances}, permissions={permissions}, horizon={horizon:?}"
                    );
                    assert_eq!(
                        serde_json::to_value(read_service_timetable(input()).unwrap()).unwrap(),
                        reference,
                        "scan: instances={instances}, permissions={permissions}, horizon={horizon:?}"
                    );
                }
            }
        }
        // Changing dates must not hide service after a cached read. Repeated
        // reads exercise both cold loading and the cached trip ranges.
        for services in [
            vec!["weekday"],
            vec!["weekend"],
            vec![],
            vec!["weekday", "weekend"],
            vec!["weekday"],
        ] {
            for _ in 0..2 {
                let input = || ServiceTimetableInput {
                    store_path: path.to_str().unwrap().to_owned(),
                    stop_ids: vec!["fixed".into(), "s2".into()],
                    service_ids: services.iter().map(|s| (*s).into()).collect(),
                    has_connection_permissions: true,
                    segment_count: None,
                    service_instances: None,
                    maximum_departure_seconds: Some(108_000),
                };
                assert_eq!(
                    serde_json::to_value(read_service_timetable(input()).unwrap()).unwrap(),
                    serde_json::to_value(read_service_timetable_ordered(input(), false).unwrap())
                        .unwrap()
                );
            }
        }
        std::fs::remove_file(path).unwrap();
    }

    /// `VIGO_FORMAT_STORE=<routing sqlite> cargo test -- --ignored`: the scan
    /// equals the SQL join on a real store, for every service on three days.
    #[test]
    #[ignore]
    fn scan_matches_sql_on_store() {
        let Ok(path) = std::env::var("VIGO_FORMAT_STORE") else {
            return;
        };
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let services: Vec<String> = db
            .prepare("SELECT DISTINCT service_id FROM connections ORDER BY service_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let stops: Vec<String> = db
            .prepare("SELECT stop_id FROM stops ORDER BY stop_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let permissions: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='connection_permissions')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for (instances, horizon) in [(false, None), (true, Some(129_600)), (true, None)] {
            let input = || ServiceTimetableInput {
                store_path: path.clone(),
                stop_ids: stops.clone(),
                service_ids: services.clone(),
                has_connection_permissions: permissions,
                segment_count: None,
                service_instances: instances.then(|| {
                    [-86_400, 0, 86_400]
                        .into_iter()
                        .flat_map(|offset| {
                            services
                                .iter()
                                .enumerate()
                                .filter(move |(i, _)| !(i + offset as usize / 3).is_multiple_of(3))
                                .map(move |(_, service)| ServiceInstance {
                                    service_id: service.clone(),
                                    offset_seconds: offset,
                                    service_date: format!("day{offset}"),
                                })
                        })
                        .collect()
                }),
                maximum_departure_seconds: horizon,
            };
            let started = std::time::Instant::now();
            let reference = read_service_timetable_ordered(input(), true).unwrap();
            let sql = started.elapsed();
            let started = std::time::Instant::now();
            let candidate = read_service_timetable(input()).unwrap();
            let scan = started.elapsed();
            eprintln!(
                "instances={instances} horizon={horizon:?}: {} segments, SQL {sql:?}, scan {scan:?}",
                candidate.departure_seconds.len()
            );
            assert_eq!(
                serde_json::to_value(candidate).unwrap(),
                serde_json::to_value(reference).unwrap()
            );
        }
    }
}
