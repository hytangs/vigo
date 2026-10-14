//! Inactive scheduled timetables, without query workspaces. The active timetable
//! remains outside this budget. Each City owns its cache and immutable identity.
use super::{Result, city::Timetable, memory::Heap};
use std::{collections::VecDeque, mem::size_of};

const DEFAULT_BYTES: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 8;

pub(crate) struct TimetableCache {
    entries: VecDeque<(Timetable, usize)>,
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
            budget,
            bytes: 0,
            hits: 0,
            evictions: 0,
        })
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = &Timetable> {
        self.entries.iter().map(|(t, _)| t)
    }

    pub(crate) fn find(&self, key: &str, end: Option<u32>) -> Option<usize> {
        self.entries.iter().position(|(t, _)| {
            t.key == key && end.is_some_and(|end| t.coverage_end.is_some_and(|saved| saved >= end))
        })
    }

    pub(crate) fn get(&self, index: usize) -> &Timetable {
        &self.entries[index].0
    }

    pub(crate) fn take(&mut self, index: usize) -> Timetable {
        let (timetable, bytes) = self.entries.remove(index).unwrap();
        self.bytes -= bytes;
        self.hits += 1;
        timetable
    }

    /// Returns whether a schedule was discarded and weak block owners may expire.
    pub(crate) fn insert(&mut self, mut timetable: Timetable) -> bool {
        if self.budget == 0 || !timetable.key.ends_with(":scheduled") {
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
            .position(|(t, _)| t.key == timetable.key)
        {
            let (_, old_bytes) = self.entries.remove(index).unwrap();
            self.bytes -= old_bytes;
            released = true;
        }
        while self.entries.len() >= MAX_ENTRIES || self.bytes > self.budget - bytes {
            let (_, old_bytes) = self.entries.pop_front().unwrap();
            self.bytes -= old_bytes;
            released = true;
            self.evictions += 1;
        }
        self.bytes += bytes;
        self.entries.push_back((timetable, bytes));
        released
    }
}
