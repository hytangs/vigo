//! Sparse, directly indexed scratch storage for searches on large graphs.
use std::ops::{Index, IndexMut};

const PAGE: usize = 1024;

/// An array whose untouched pages share one default value. Only writes allocate
/// pages, so a local query does not initialize an entire regional graph.
pub struct PagedVec<T: Copy> {
    pages: Vec<Option<Box<[T; PAGE]>>>,
    len: usize,
    default: T,
    allocated: usize,
}

impl<T: Copy> PagedVec<T> {
    #[must_use]
    pub fn new(len: usize, default: T) -> Self {
        Self {
            pages: (0..len.div_ceil(PAGE)).map(|_| None).collect(),
            len,
            default,
            allocated: 0,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize { self.len }

    #[must_use]
    pub fn is_empty(&self) -> bool { self.len == 0 }

    /// Retained allocation capacity, excluding allocator bookkeeping.
    #[must_use]
    pub fn byte_length(&self) -> usize {
        self.pages.capacity() * std::mem::size_of::<Option<Box<[T; PAGE]>>>()
            + self.allocated * PAGE * std::mem::size_of::<T>()
    }

    /// Reset the array and release its populated pages.
    pub fn fill(&mut self, value: T) {
        for page in &mut self.pages { *page = None; }
        self.default = value;
        self.allocated = 0;
    }
}

impl<T: Copy> Index<usize> for PagedVec<T> {
    type Output = T;
    #[inline]
    fn index(&self, index: usize) -> &T {
        assert!(index < self.len);
        self.pages[index / PAGE].as_ref().map_or(&self.default, |p| &p[index % PAGE])
    }
}

impl<T: Copy> IndexMut<usize> for PagedVec<T> {
    #[inline]
    fn index_mut(&mut self, index: usize) -> &mut T {
        assert!(index < self.len);
        let page = self.pages[index / PAGE].get_or_insert_with(|| {
            self.allocated += 1;
            Box::new([self.default; PAGE])
        });
        &mut page[index % PAGE]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(values.byte_length(), empty + 2 * PAGE * 4);
        values.fill(0);
        assert_eq!(values.byte_length(), empty);
        assert_eq!(values[0], 0);
        assert_eq!(values[10_000_002], 0);
    }
}
