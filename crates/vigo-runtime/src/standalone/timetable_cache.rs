//! Inactive timetables, without query workspaces, and the schedule sources
//! realtime views derive from. The active timetable remains outside this
//! budget. Each City owns its cache and immutable identity.
use super::{
    Result,
    city::{ScheduleSource, Timetable},
    memory::Heap,
};
use std::{
    collections::VecDeque,
    io::{BufReader, BufWriter, Write},
    mem::size_of,
    sync::Arc,
};
use vigo_format::ServiceTimetableResult;

struct CompactSource {
    key: String,
    data: Box<[u8]>,
}

/// A failed optional cache admission must not allocate past its byte allowance.
struct LimitedBytes {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for LimitedBytes {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let end = self.bytes.len().saturating_add(data.len());
        if end > self.limit {
            return Err(std::io::Error::other("schedule cache allowance exceeded"));
        }
        if end > self.bytes.capacity() {
            let capacity = end
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.limit);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

const DEFAULT_BYTES: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 8;
// Realtime views are superseded by every new snapshot. Keep the latest few so
// that alternating scheduled and live queries do not rebuild them.
const MAX_VIEWS: usize = 2;
const MAX_SOURCES: usize = 2;

struct Entry<T> {
    value: T,
    bytes: usize,
    used: u64,
}

pub(crate) struct TimetableCache {
    entries: VecDeque<Entry<Timetable>>,
    sources: VecDeque<Entry<Arc<ScheduleSource>>>,
    compact: VecDeque<Entry<CompactSource>>,
    clock: u64,
    pub(crate) budget: usize,
    pub(crate) bytes: usize,
    pub(crate) hits: u64,
    pub(crate) evictions: u64,
}

impl TimetableCache {
    pub(crate) fn from_env() -> Result<Self> {
        let budget = match std::env::var("VIGO_TIMETABLE_CACHE_BYTES") {
            Ok(value) => value
                .parse::<usize>()
                .map_err(|_| "VIGO_TIMETABLE_CACHE_BYTES must be a nonnegative integer")?,
            Err(std::env::VarError::NotPresent) => {
                crate::resources::cache_budget(DEFAULT_BYTES, 32)
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            entries: VecDeque::new(),
            sources: VecDeque::new(),
            compact: VecDeque::new(),
            clock: 0,
            budget,
            bytes: 0,
            hits: 0,
            evictions: 0,
        })
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = &Timetable> {
        self.entries.iter().map(|e| &e.value)
    }

    /// A clocked request needs a retained prefix at least as long as its own;
    /// a full view (no coverage end) only matches another full view.
    pub(crate) fn find(&self, key: &str, end: Option<u32>) -> Option<usize> {
        self.entries.iter().position(|e| {
            e.value.key == key
                && match (end, e.value.coverage_end) {
                    (Some(end), Some(saved)) => saved >= end,
                    (None, None) => true,
                    _ => false,
                }
        })
    }

    pub(crate) fn get(&self, index: usize) -> &Timetable {
        &self.entries[index].value
    }

    pub(crate) fn take(&mut self, index: usize) -> Timetable {
        let entry = self.entries.remove(index).unwrap();
        self.bytes -= entry.bytes;
        self.hits += 1;
        entry.value
    }

    /// Returns whether a schedule was discarded and weak block owners may expire.
    pub(crate) fn insert(&mut self, mut timetable: Timetable) -> bool {
        if self.budget == 0 {
            return true;
        }
        // Scratch must never be multiplied by the number of retained dates.
        drop(timetable.kernel.take_query_workspace());
        let bytes = size_of::<Timetable>()
            + timetable.heap_bytes()
            + timetable.kernel.retained_schedule_bytes();
        // Keep instant kernel reuse when several views fit. On a tight budget,
        // prefer compact sources over one kernel that displaces the other dates.
        if bytes > self.budget
            || (scheduled(&timetable) && !self.compact.is_empty() && bytes > self.budget / 2)
        {
            return true;
        }
        let mut released = false;
        if let Some(index) = self
            .entries
            .iter()
            .position(|e| e.value.key == timetable.key)
        {
            self.remove_entry(index);
            released = true;
        }
        if !scheduled(&timetable) {
            // A view rebuilds from its retained source in a fraction of a
            // source read, so it never displaces a schedule or a source.
            let views: usize = self
                .entries
                .iter()
                .filter(|e| !scheduled(&e.value))
                .map(|e| e.bytes)
                .sum();
            if bytes > self.budget.saturating_sub(self.bytes - views) {
                return true;
            }
            if self.entries.iter().filter(|e| !scheduled(&e.value)).count() >= MAX_VIEWS {
                released |= self.evict_view();
            }
        }
        while self.entries.len() >= MAX_ENTRIES {
            released |= self.evict_view() || self.evict_scheduled();
        }
        released |= self.reserve(bytes);
        self.bytes += bytes;
        let used = self.tick();
        self.entries.push_back(Entry {
            value: timetable,
            bytes,
            used,
        });
        released
    }

    /// The retained source read for `key`, marked most recently used.
    pub(crate) fn source(&mut self, key: &str) -> Option<Arc<ScheduleSource>> {
        let index = self.sources.iter().position(|e| e.value.key == key)?;
        let used = self.tick();
        let entry = &mut self.sources[index];
        entry.used = used;
        Some(entry.value.clone())
    }

    /// Retains a source when it fits; returns whether anything was evicted.
    pub(crate) fn insert_source(&mut self, source: Arc<ScheduleSource>) -> bool {
        let bytes = size_of::<ScheduleSource>() + source.heap_bytes();
        if self.budget == 0 || bytes > self.budget {
            return false;
        }
        let mut released = false;
        if let Some(index) = self.sources.iter().position(|e| e.value.key == source.key) {
            self.bytes -= self.sources.remove(index).unwrap().bytes;
            released = true;
        }
        if self.sources.len() >= MAX_SOURCES {
            released |= self.evict_source();
        }
        released |= self.reserve(bytes);
        self.bytes += bytes;
        let used = self.tick();
        self.sources.push_back(Entry {
            value: source,
            bytes,
            used,
        });
        released
    }

    pub(crate) fn source_heap_bytes(&self) -> usize {
        self.sources.iter().map(|e| e.bytes).sum::<usize>()
            + self.compact.iter().map(|e| e.bytes).sum::<usize>()
    }

    pub(crate) fn compact_source(&mut self, key: &str) -> Result<Option<ServiceTimetableResult>> {
        let Some(index) = self.compact.iter().position(|e| e.value.key == key) else {
            return Ok(None);
        };
        let used = self.tick();
        let entry = &mut self.compact[index];
        let decoder = flate2::read::DeflateDecoder::new(entry.value.data.as_ref());
        let mut result = bincode::deserialize_from(BufReader::new(decoder))?;
        delta_columns(&mut result, false);
        entry.used = used;
        self.hits += 1;
        Ok(Some(result))
    }

    /// Cache only sizeable scheduled slices, before realtime and linked-trip
    /// expansion. The same LRU byte budget covers sources and inactive kernels.
    pub(crate) fn insert_compact_source(
        &mut self,
        key: String,
        source: &mut ServiceTimetableResult,
    ) {
        if self.budget == 0 || source.departure_seconds.len() < 32_768 {
            return;
        }
        let overhead = size_of::<Entry<CompactSource>>() + key.capacity();
        let limit = self.budget.saturating_sub(overhead).min(16 * 1024 * 1024);
        if limit == 0 {
            return;
        }
        delta_columns(source, true);
        let mut encoder = flate2::write::DeflateEncoder::new(
            LimitedBytes {
                bytes: Vec::new(),
                limit,
            },
            flate2::Compression::fast(),
        );
        // Buffer serialization writes; do not materialize an uncompressed copy.
        let encoded = (|| -> Result<Box<[u8]>> {
            let mut writer = BufWriter::new(&mut encoder);
            bincode::serialize_into(&mut writer, &*source)?;
            writer.flush()?;
            drop(writer);
            Ok(encoder.finish()?.bytes.into_boxed_slice())
        })();
        delta_columns(source, false);
        let Ok(data) = encoded else {
            return;
        };
        let bytes = overhead + data.len();
        if let Some(index) = self.compact.iter().position(|e| e.value.key == key) {
            self.bytes -= self.compact.remove(index).unwrap().bytes;
        }
        if self.compact.len() >= MAX_ENTRIES {
            self.evict_compact();
        }
        self.reserve(bytes);
        self.bytes += bytes;
        let used = self.tick();
        self.compact.push_back(Entry {
            value: CompactSource { key, data },
            bytes,
            used,
        });
    }

    fn evict_compact(&mut self) -> bool {
        let Some(index) = (0..self.compact.len()).min_by_key(|&i| self.compact[i].used) else {
            return false;
        };
        self.bytes -= self.compact.remove(index).unwrap().bytes;
        self.evictions += 1;
        true
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// Frees room for `bytes`, which the caller has checked fits on its own.
    /// Superseded realtime views are the cheapest to rebuild, so they go first;
    /// scheduled timetables and sources then leave least recently used first.
    fn reserve(&mut self, bytes: usize) -> bool {
        let mut released = false;
        while self.bytes > self.budget - bytes {
            let oldest = [
                self.entries.iter().map(|e| e.used).min().map(|n| (n, 0)),
                self.sources.iter().map(|e| e.used).min().map(|n| (n, 1)),
                self.compact.iter().map(|e| e.used).min().map(|n| (n, 2)),
            ]
            .into_iter()
            .flatten()
            .min();
            let evicted = self.evict_view()
                || match oldest {
                    Some((_, 0)) => self.evict_scheduled(),
                    Some((_, 1)) => self.evict_source(),
                    Some((_, 2)) => self.evict_compact(),
                    _ => false,
                };
            if !evicted {
                break;
            }
            released = true;
        }
        released
    }

    fn evict_view(&mut self) -> bool {
        let Some(index) = self.entries.iter().position(|e| !scheduled(&e.value)) else {
            return false;
        };
        self.remove_entry(index);
        self.evictions += 1;
        true
    }

    fn evict_scheduled(&mut self) -> bool {
        let Some(index) = (0..self.entries.len()).min_by_key(|&i| self.entries[i].used) else {
            return false;
        };
        self.remove_entry(index);
        self.evictions += 1;
        true
    }

    fn evict_source(&mut self) -> bool {
        let Some(index) = (0..self.sources.len()).min_by_key(|&i| self.sources[i].used) else {
            return false;
        };
        self.bytes -= self.sources.remove(index).unwrap().bytes;
        self.evictions += 1;
        true
    }

    fn remove_entry(&mut self, index: usize) {
        self.bytes -= self.entries.remove(index).unwrap().bytes;
    }
}

// Reversible wrapping differences make neighboring numeric columns compact.
// Transform only the fresh, owned source buffers, then restore them before use;
// no second uncompressed schedule or persistent data format is introduced.
fn delta_columns(source: &mut ServiceTimetableResult, encode: bool) {
    for column in [
        &mut source.departure_seconds,
        &mut source.arrival_seconds,
        &mut source.from_stop,
        &mut source.to_stop,
        &mut source.sequence,
        &mut source.segment_trip,
        &mut source.segment_run,
        &mut source.trip_start,
    ] {
        let mut previous = 0u32;
        for value in column.iter_mut() {
            if encode {
                let original = *value;
                *value = original.wrapping_sub(previous);
                previous = original;
            } else {
                *value = value.wrapping_add(previous);
                previous = *value;
            }
        }
    }
}

fn scheduled(timetable: &Timetable) -> bool {
    timetable.coverage_end.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> ServiceTimetableResult {
        let n = 32_768;
        ServiceTimetableResult {
            stop_ids: vec!["A".into(), "B".into()],
            departure_seconds: (0..n).collect::<Vec<_>>().into(),
            arrival_seconds: (1..=n).collect::<Vec<_>>().into(),
            from_stop: vec![0; n as usize].into(),
            to_stop: vec![1; n as usize].into(),
            sequence: (0..n).collect::<Vec<_>>().into(),
            segment_trip: vec![0; n as usize].into(),
            segment_run: vec![0; n as usize].into(),
            continuity_break: vec![0; n as usize].into(),
            can_board: vec![1; n as usize].into(),
            can_alight: vec![1; n as usize].into(),
            trip_start: vec![0, n].into(),
            trip_ids: vec!["trip".into()],
            route_ids: vec!["route".into()],
            service_ids: vec!["service".into()],
            direction_ids: vec!["0".into()],
            trip_service_dates: vec!["2026-07-15".into()],
            run_count: 1,
            stop_count: 2,
        }
    }

    #[test]
    fn compact_sources_roundtrip_and_evict_within_shared_budget() {
        let mut cache = TimetableCache::from_env().unwrap();
        cache.budget = 4 * 1024 * 1024;
        let mut source = source();
        let original = serde_json::to_value(&source).unwrap();
        cache.insert_compact_source("day-a".into(), &mut source);
        assert!(cache.bytes > 0);
        let restored = cache.compact_source("day-a").unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&source).unwrap(),
            serde_json::to_value(restored).unwrap()
        );
        assert_eq!(serde_json::to_value(&source).unwrap(), original);
        let first_bytes = cache.bytes;
        cache.budget = first_bytes * 2;
        cache.insert_compact_source("day-b".into(), &mut source);
        cache.compact_source("day-a").unwrap().unwrap();
        cache.insert_compact_source("day-c".into(), &mut source);
        assert!(cache.compact_source("day-b").unwrap().is_none());
        assert!(cache.compact_source("day-a").unwrap().is_some());
        assert!(cache.compact_source("day-c").unwrap().is_some());
        assert!(cache.bytes <= cache.budget);
        assert_eq!(cache.bytes, cache.source_heap_bytes());
        assert_eq!(cache.evictions, 1);
    }

    #[test]
    fn compact_source_admission_is_optional_and_bounded() {
        let mut cache = TimetableCache::from_env().unwrap();
        for budget in [0, 128] {
            cache.budget = budget;
            cache.insert_compact_source("too-large".into(), &mut source());
            assert_eq!(cache.bytes, 0);
            assert!(cache.compact_source("too-large").unwrap().is_none());
        }
        let mut writer = LimitedBytes {
            bytes: Vec::new(),
            limit: 10,
        };
        writer.write_all(b"12345").unwrap();
        assert!(writer.write_all(b"678901").is_err());
        assert_eq!(writer.bytes, b"12345");
        assert!(writer.bytes.capacity() <= writer.limit);
    }
}
