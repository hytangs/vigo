//! Inactive timetables, without query workspaces, and the schedule sources
//! realtime views derive from. The active timetable remains outside this
//! budget. Each City owns its cache and immutable identity.
use super::{
    Result,
    city::{ScheduleSource, Timetable},
    memory::Heap,
};
use std::{collections::VecDeque, mem::size_of, sync::Arc};

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
        if bytes > self.budget {
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
            let oldest_entry = self.entries.iter().map(|e| e.used).min();
            let oldest_source = self.sources.iter().map(|e| e.used).min();
            let evicted = self.evict_view()
                || match (oldest_entry, oldest_source) {
                    (Some(entry), Some(source)) if source < entry => self.evict_source(),
                    (Some(_), _) => self.evict_scheduled(),
                    (None, Some(_)) => self.evict_source(),
                    (None, None) => false,
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

fn scheduled(timetable: &Timetable) -> bool {
    timetable.coverage_end.is_some()
}
