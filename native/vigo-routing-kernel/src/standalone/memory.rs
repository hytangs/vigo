//! Retained capacities by owner, separate from OS resident memory. Containers
//! include their allocation once; child values add only their dynamic storage.
use super::{
    City,
    access::*,
    city::{Stop, Timetable},
};
use serde_json::{Value, json};
use std::{collections::HashMap, mem::size_of};

static OUTPUT_ACCOUNTING: std::sync::LazyLock<bool> =
    std::sync::LazyLock::new(|| std::env::var("VIGO_MEMORY_ACCOUNTING").is_ok_and(|v| v == "1"));
static LAST_OUTPUT: std::sync::Mutex<(usize, usize)> = std::sync::Mutex::new((0, 0));
pub(crate) fn record_output(command: &str, raw: &Value, public: &Value) {
    if *OUTPUT_ACCOUNTING {
        record_output_bytes(command, raw.heap_bytes(), public);
    }
}
pub(crate) fn output_accounting() -> bool {
    *OUTPUT_ACCOUNTING
}
pub(crate) fn record_output_bytes(command: &str, raw: usize, public: &Value) {
    if *OUTPUT_ACCOUNTING && !matches!(command, "info" | "inspect") {
        *LAST_OUTPUT.lock().unwrap_or_else(|e| e.into_inner()) = (raw, public.heap_bytes());
    }
}
pub(crate) fn output_ledger() -> Value {
    if !*OUTPUT_ACCOUNTING {
        return Value::Null;
    }
    let (raw, public) = *LAST_OUTPUT.lock().unwrap_or_else(|e| e.into_inner());
    json!({"rawHeapBytes":raw,"publicHeapBytes":public,"overlapHeapBytes":raw+public,
        "scope":"last query's result trees at public formatting; estimated container overhead; excludes search temporaries and serialized buffers"})
}

pub(crate) trait Heap {
    fn heap_bytes(&self) -> usize;
}
impl Heap for String {
    fn heap_bytes(&self) -> usize {
        self.capacity()
    }
}
impl<T: Heap> Heap for Vec<T> {
    fn heap_bytes(&self) -> usize {
        self.capacity() * size_of::<T>() + self.iter().map(Heap::heap_bytes).sum::<usize>()
    }
}
// Tables shared by realtime views are charged in full to each owner, as shared
// timetable columns are for cache admission.
impl<T: Heap> Heap for std::sync::Arc<[T]> {
    fn heap_bytes(&self) -> usize {
        self.len() * size_of::<T>() + self.iter().map(Heap::heap_bytes).sum::<usize>()
    }
}
impl<K: Heap, V: Heap> Heap for std::sync::Arc<HashMap<K, V>> {
    fn heap_bytes(&self) -> usize {
        self.as_ref().heap_bytes()
    }
}
impl<T: Heap> Heap for Option<T> {
    fn heap_bytes(&self) -> usize {
        self.as_ref().map_or(0, Heap::heap_bytes)
    }
}
impl<A: Heap, B: Heap> Heap for (A, B) {
    fn heap_bytes(&self) -> usize {
        self.0.heap_bytes() + self.1.heap_bytes()
    }
}
impl<K: Heap, V: Heap> Heap for HashMap<K, V> {
    fn heap_bytes(&self) -> usize {
        // Swiss-table bucket/control estimate; allocator rounding is excluded.
        self.capacity().saturating_mul(8).div_ceil(7) * (size_of::<(K, V)>() + 1)
            + self
                .iter()
                .map(|(k, v)| k.heap_bytes() + v.heap_bytes())
                .sum::<usize>()
    }
}
impl Heap for Value {
    fn heap_bytes(&self) -> usize {
        match self {
            Self::String(v) => v.heap_bytes(),
            Self::Array(v) => v.heap_bytes(),
            // serde_json uses BTreeMap; this includes an estimated node cost.
            Self::Object(v) => v
                .iter()
                .map(|(k, v)| 96 + k.heap_bytes() + v.heap_bytes())
                .sum(),
            _ => 0,
        }
    }
}
macro_rules! scalar { ($($t:ty),*) => { $(impl Heap for $t { fn heap_bytes(&self) -> usize { 0 } })* }; }
scalar!(u32, usize, f64, bool);
macro_rules! fields {
    ($t:ty, $($f:ident),+) => { impl Heap for $t { fn heap_bytes(&self) -> usize { 0 $(+ self.$f.heap_bytes())+ } } };
}
fields!(Stop, id, name, parent);
fields!(StopRecord, name, lon, lat, parent_station, location_type);
fields!(Transfer, to_stop_id, provenance);
fields!(TransferStep, from_stop_id, to_stop_id);
fields!(TransferShortcut, to_stop_id, steps);
fields!(
    AccessIndex,
    direct_service_stop_ids,
    departure_service_stop_ids,
    arrival_service_stop_ids
);
fields!(
    Materialized,
    transfers,
    transfer_shortcuts,
    declared_pathway_stops,
    station_members,
    stop_records,
    forbidden_transfer_pairs,
    stop_access_index
);
fields!(
    AccessContext,
    schema_version,
    source_artifact_identity,
    access_policy_identity,
    materialized,
    station_paths
);
fields!(
    Timetable,
    stop_ids,
    index,
    trip_ids,
    route_ids,
    trip_service_dates,
    key,
    realtime
);

pub(crate) fn sqlite_bytes(db: &rusqlite::Connection) -> usize {
    let mut total = 0;
    for kind in [
        rusqlite::ffi::SQLITE_DBSTATUS_CACHE_USED,
        rusqlite::ffi::SQLITE_DBSTATUS_SCHEMA_USED,
        rusqlite::ffi::SQLITE_DBSTATUS_STMT_USED,
    ] {
        let (mut current, mut peak) = (0, 0);
        // The connection is borrowed on its owning query thread.
        let status = unsafe {
            rusqlite::ffi::sqlite3_db_status(db.handle(), kind, &mut current, &mut peak, 0)
        };
        if status == rusqlite::ffi::SQLITE_OK {
            total += current.max(0) as usize;
        }
    }
    total
}

impl City {
    pub(crate) fn memory_ledger(&self) -> Value {
        let tt = self.timetable.as_ref();
        let street = self.street.memory_ledger();
        let dictionary = self.stops.heap_bytes()
            + self.stop_index.heap_bytes()
            + self.members.heap_bytes()
            + self.access.heap_bytes()
            + self.transfer_rows.heap_bytes()
            + self.transfer_shortcut_rows.heap_bytes()
            + self.manifest.heap_bytes()
            + self.metadata.heap_bytes()
            + self.street_bounds.heap_bytes()
            + self.context.header.heap_bytes()
            + tt.map_or(0, Heap::heap_bytes)
            + self.calendar.get().map_or(0, |c| c.heap_bytes());
        let inactive_timetables = self
            .timetable_cache
            .entries()
            .map(|t| {
                t.heap_bytes()
                    + t.kernel.owned_source_bytes()
                    + t.kernel.diagnostics().native_index_bytes as usize
            })
            .sum::<usize>();
        let cache = inactive_timetables
            + self.shape_cache.retained_bytes()
            + self.route_metadata.heap_bytes()
            + self.trip_shape_ids.heap_bytes()
            + self.trip_details.heap_bytes()
            + self
                .fare_engines
                .values()
                .flatten()
                .map(crate::fares::FareEngine::estimated_bytes)
                .sum::<usize>();
        json!({"street":street,"cityDictionaryHeapBytes":dictionary,
            "timetableSourceOwnedHeapBytes":tt.map_or(0, |t|t.kernel.owned_source_bytes())
                + self.timetable_blocks.as_ref().map_or(0, |p| p.unique_bytes() + p.index_bytes()),
            "timetableIndexHeapBytes":tt.map_or(0, |t|t.kernel.diagnostics().native_index_bytes as usize),
            "timetableWorkspaceHeapBytes":tt.map_or(0, |t|t.kernel.diagnostics().workspace_bytes as usize)
                + self.query_workspace.as_ref().map_or(0, crate::timetable::TimetableQueryWorkspace::byte_length),
            "cityCacheHeapBytes":cache,"inactiveTimetableHeapBytes":inactive_timetables,
            "sqliteHeapBytes":sqlite_bytes(&self.db) + self.shapes.sqlite_heap_bytes(),
            "contextMappedFileBytes":self.context.mapped_bytes(),"lastOutput":output_ledger(),
            "drive":self.drive.as_ref().map(|d| d.memory_ledger()),
            "scope":"retained capacities; hash/JSON container overhead estimated; mappings are file lengths, not RSS; active-query temporaries and transport/UI allocations measured separately"})
    }
}

impl super::city::Drive {
    fn memory_ledger(&self) -> Value {
        let mut ledger = self.kernel.memory_ledger();
        let extra = self.image.header.heap_bytes();
        ledger["networkHeapBytes"] =
            json!(ledger["networkHeapBytes"].as_u64().unwrap_or(0) + extra as u64);
        ledger["mappedFileBytes"] = json!(
            ledger["mappedFileBytes"].as_u64().unwrap_or(0) + self.image.mapped_bytes() as u64
        );
        ledger
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_capacity_and_nested_storage_once() {
        let mut strings = Vec::with_capacity(7);
        let mut text = String::with_capacity(80);
        text.push('x');
        strings.push(text);
        assert_eq!(strings.heap_bytes(), 7 * size_of::<String>() + 80);
        let value = Value::Array(strings.into_iter().map(Value::String).collect());
        let Value::Array(values) = &value else {
            unreachable!()
        };
        assert_eq!(
            value.heap_bytes(),
            values.capacity() * size_of::<Value>() + 80
        );
    }
}
