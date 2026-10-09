//! Sparse, directly indexed scratch storage for searches on large graphs.
use std::ops::{Index, IndexMut};

// Small pages limit allocation amplification for sparse elimination-tree paths.
const PAGE: usize = 256;

/// An array whose untouched pages share one default value. Only writes allocate
/// pages, so a local query does not initialize an entire regional graph.
pub struct PagedVec<T: Copy> {
    pages: Vec<Option<Box<[T; PAGE]>>>,
    len: usize,
    default: T,
    allocated: usize,
    spare: Vec<Box<[T; PAGE]>>,
    populated: Vec<usize>,
}

impl<T: Copy> PagedVec<T> {
    #[must_use]
    pub fn new(len: usize, default: T) -> Self {
        Self {
            pages: (0..len.div_ceil(PAGE)).map(|_| None).collect(),
            len,
            default,
            allocated: 0,
            spare: Vec::new(),
            populated: Vec::new(),
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Retained allocation capacity, excluding allocator bookkeeping.
    #[must_use]
    pub fn byte_length(&self) -> usize {
        self.pages.capacity() * std::mem::size_of::<Option<Box<[T; PAGE]>>>()
            + (self.allocated + self.spare.len()) * PAGE * std::mem::size_of::<T>()
            + self.populated.capacity() * std::mem::size_of::<usize>()
            + self.spare.capacity() * std::mem::size_of::<Box<[T; PAGE]>>()
    }

    /// Reset query scratch, retaining at most one MiB of pages for reuse.
    /// This bounds retention by a query rather than the union of past queries.
    pub fn recycle(&mut self, value: T) {
        let limit = (1024 * 1024 / (PAGE * std::mem::size_of::<T>()).max(1)).max(1);
        for index in self.populated.drain(..) {
            if let Some(page) = self.pages[index].take() {
                if self.spare.len() < limit {
                    self.spare.push(page);
                }
            }
        }
        self.default = value;
        self.allocated = 0;
    }

    /// Reset the array and release its populated pages.
    pub fn fill(&mut self, value: T) {
        for page in &mut self.pages {
            *page = None;
        }
        self.default = value;
        self.allocated = 0;
        self.spare = Vec::new();
        self.populated = Vec::new();
    }
}

impl<T: Copy> Index<usize> for PagedVec<T> {
    type Output = T;
    #[inline]
    fn index(&self, index: usize) -> &T {
        assert!(index < self.len);
        self.pages[index / PAGE]
            .as_ref()
            .map_or(&self.default, |p| &p[index % PAGE])
    }
}

impl<T: Copy> IndexMut<usize> for PagedVec<T> {
    #[inline]
    fn index_mut(&mut self, index: usize) -> &mut T {
        assert!(index < self.len);
        let page = self.pages[index / PAGE].get_or_insert_with(|| {
            self.allocated += 1;
            self.populated.push(index / PAGE);
            if let Some(mut page) = self.spare.pop() {
                page.fill(self.default);
                page
            } else {
                Box::new([self.default; PAGE])
            }
        });
        &mut page[index % PAGE]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recycling_clears_stale_values_and_bounds_retained_pages() {
        let mut values = PagedVec::new(PAGE * 8192, 0u32);
        let empty = values.byte_length();
        for round in 0..4 {
            for page in 0..2048 {
                values[(round * 2048 + page) * PAGE] = 7;
            }
            values.recycle(11);
            for page in 0..8192 {
                assert_eq!(values[page * PAGE], 11);
            }
            assert!(values.byte_length() < empty + 2 * 1024 * 1024);
            values[round] = 19;
            assert_eq!(values[round], 19);
            assert_eq!(values[round + 1], 11);
            values.recycle(0);
        }
        values.fill(3);
        assert_eq!(values.byte_length(), empty);
        assert_eq!(values[0], 3);
    }

    #[test]
    fn distant_writes_allocate_only_touched_pages_and_reset() {
        let mut values = PagedVec::new(10_000_003, u32::MAX);
        let empty = values.byte_length();
        assert_eq!(values[9_999_999], u32::MAX);
        assert_eq!(values.byte_length(), empty);
        values[0] = 7;
        values[10_000_002] = 9;
        assert_eq!(values[0], 7);
        assert_eq!(values[1], u32::MAX);
        assert_eq!(values[10_000_002], 9);
        assert_eq!(
            values.byte_length(),
            empty + 2 * PAGE * 4 + values.populated.capacity() * std::mem::size_of::<usize>()
        );
        values.fill(0);
        assert_eq!(values.byte_length(), empty);
        assert_eq!(values[0], 0);
        assert_eq!(values[10_000_002], 0);
    }
}
