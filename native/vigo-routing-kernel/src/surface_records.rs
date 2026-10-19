//! Append-only search witnesses. Fixed-size pages avoid doubling large vectors
//! while queue and frontier indices continue to refer to stable record numbers.
use std::ops::{Index, IndexMut};

const PAGE: usize = 4096;

pub(super) struct SurfaceRecords<T> {
    pages: Vec<Vec<T>>,
    len: usize,
}

impl<T> SurfaceRecords<T> {
    pub(super) fn new() -> Self {
        Self {
            pages: Vec::new(),
            len: 0,
        }
    }
    pub(super) fn len(&self) -> usize {
        self.len
    }
    pub(super) fn push(&mut self, value: T) {
        if self.len.is_multiple_of(PAGE) {
            self.pages.push(Vec::with_capacity(PAGE));
        }
        self.pages.last_mut().unwrap().push(value);
        self.len += 1;
    }
    pub(super) fn last_mut(&mut self) -> Option<&mut T> {
        let index = self.len.checked_sub(1)?;
        Some(&mut self[index])
    }
    pub(super) fn iter(&self) -> impl Iterator<Item = &T> {
        self.pages.iter().flat_map(|page| page.iter())
    }
}

impl<T> Index<usize> for SurfaceRecords<T> {
    type Output = T;
    fn index(&self, index: usize) -> &T {
        &self.pages[index / PAGE][index % PAGE]
    }
}
impl<T> IndexMut<usize> for SurfaceRecords<T> {
    fn index_mut(&mut self, index: usize) -> &mut T {
        &mut self.pages[index / PAGE][index % PAGE]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indices_and_iteration_survive_page_boundaries() {
        let mut records = SurfaceRecords::new();
        for i in 0..PAGE * 3 + 7 {
            records.push(i);
        }
        records[PAGE] = 17;
        assert_eq!(records.len(), PAGE * 3 + 7);
        for (i, &value) in records.iter().enumerate() {
            assert_eq!(value, if i == PAGE { 17 } else { i });
        }
        assert!(records.pages.iter().all(|p| p.capacity() == PAGE));
    }
}
