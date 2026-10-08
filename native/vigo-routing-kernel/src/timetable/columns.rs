//! Immutable columns share equal blocks across scenario views. A hash only
//! selects candidates: every reuse checks the complete block for equality.
//! Weak references let a retired service day release all of its unique data.
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    ops::Index,
    sync::{Arc, Weak},
};

const BLOCK: usize = 1024;

pub(super) enum Column<T> {
    Owned(Vec<T>),
    Shared { blocks: Vec<Arc<[T]>>, len: usize },
}
impl<T> From<Vec<T>> for Column<T> {
    fn from(values: Vec<T>) -> Self {
        Self::Owned(values)
    }
}
impl<T> Column<T> {
    pub(super) fn len(&self) -> usize {
        match self {
            Self::Owned(v) => v.len(),
            Self::Shared { len, .. } => *len,
        }
    }
    pub(super) fn block_references(&self) -> usize {
        match self {
            Self::Owned(_) => 0,
            Self::Shared { blocks, .. } => blocks.len(),
        }
    }
    pub(super) fn allocated_bytes(&self) -> usize {
        match self {
            Self::Owned(v) => v.capacity() * size_of::<T>(),
            // Block data is accounted once by the collection's pool.
            Self::Shared { blocks, .. } => blocks.capacity() * size_of::<Arc<[T]>>(),
        }
    }
}
impl<T> Index<usize> for Column<T> {
    type Output = T;
    #[inline]
    fn index(&self, index: usize) -> &T {
        match self {
            Self::Owned(v) => &v[index],
            Self::Shared { blocks, len } => {
                assert!(index < *len);
                &blocks[index / BLOCK][index % BLOCK]
            }
        }
    }
}

struct Pool<T> {
    blocks: HashMap<u64, Vec<Weak<[T]>>>,
}
impl<T> Default for Pool<T> {
    fn default() -> Self {
        Self {
            blocks: HashMap::new(),
        }
    }
}
impl<T: Copy + Hash + Eq> Pool<T> {
    fn intern(&mut self, values: &[T]) -> Arc<[T]> {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        values.hash(&mut hash);
        let candidates = self.blocks.entry(hash.finish()).or_default();
        candidates.retain(|block| block.strong_count() > 0);
        for candidate in candidates.iter().filter_map(Weak::upgrade) {
            if candidate.as_ref() == values {
                return candidate;
            }
        }
        let block: Arc<[T]> = values.into();
        candidates.push(Arc::downgrade(&block));
        block
    }
    fn share(&mut self, column: &mut Column<T>) -> bool {
        if matches!(column, Column::Shared { .. }) {
            return false;
        }
        let Column::Owned(values) = std::mem::replace(column, Column::Owned(Vec::new())) else {
            unreachable!()
        };
        let len = values.len();
        let blocks = values.chunks(BLOCK).map(|part| self.intern(part)).collect();
        *column = Column::Shared { blocks, len };
        true
    }
    fn prune(&mut self) {
        self.blocks.retain(|_, candidates| {
            candidates.retain(|block| block.strong_count() > 0);
            !candidates.is_empty()
        });
        if self.blocks.capacity() > self.blocks.len().saturating_mul(4).max(64) {
            self.blocks.shrink_to(self.blocks.len().saturating_mul(2));
        }
    }
    fn live_blocks(&self) -> usize {
        self.blocks
            .values()
            .flatten()
            .filter(|b| b.strong_count() > 0)
            .count()
    }
    fn index_bytes(&self) -> usize {
        self.blocks.capacity() * (size_of::<u64>() + size_of::<Vec<Weak<[T]>>>() + 1)
            + self
                .blocks
                .values()
                .map(|v| v.capacity() * size_of::<Weak<[T]>>())
                .sum::<usize>()
    }
    fn bytes(&self) -> usize {
        self.blocks
            .values()
            .flatten()
            .filter_map(Weak::upgrade)
            .map(|block| block.len() * size_of::<T>() + 2 * size_of::<usize>())
            .sum()
    }
}

#[derive(Default)]
pub(crate) struct TimetableBlockPool {
    u32s: Pool<u32>,
    u8s: Pool<u8>,
}
impl TimetableBlockPool {
    pub(super) fn share_u32(&mut self, column: &mut Column<u32>) -> bool {
        self.u32s.share(column)
    }
    pub(super) fn share_u8(&mut self, column: &mut Column<u8>) -> bool {
        self.u8s.share(column)
    }
    pub(crate) fn prune(&mut self) {
        self.u32s.prune();
        self.u8s.prune();
    }
    pub(crate) fn index_bytes(&self) -> usize {
        self.u32s.index_bytes() + self.u8s.index_bytes()
    }
    pub(crate) fn unique_blocks(&self) -> usize {
        self.u32s.live_blocks() + self.u8s.live_blocks()
    }
    pub(crate) fn unique_bytes(&self) -> usize {
        self.u32s.bytes() + self.u8s.bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_bus_with_distinct_rail_preserves_every_value_and_releases_retired_blocks() {
        let bus: Vec<u32> = (0..BLOCK * 4).map(|n| n as u32).collect();
        let a: Vec<u32> = bus.iter().copied().chain([11, 12, 13]).collect();
        let b: Vec<u32> = bus.iter().copied().chain([21, 22]).collect();
        let mut first = Column::from(a.clone());
        let mut second = Column::from(b.clone());
        let mut pool = TimetableBlockPool::default();
        pool.share_u32(&mut first);
        pool.share_u32(&mut second);
        for (i, value) in a.iter().enumerate() {
            assert_eq!(first[i], *value);
        }
        for (i, value) in b.iter().enumerate() {
            assert_eq!(second[i], *value);
        }
        assert!(pool.unique_bytes() < (a.len() + b.len()) * 4 * 3 / 4);
        let Column::Shared { blocks: x, .. } = &first else {
            unreachable!()
        };
        let Column::Shared { blocks: y, .. } = &second else {
            unreachable!()
        };
        assert!(Arc::ptr_eq(&x[0], &y[0]));
        assert!(!Arc::ptr_eq(x.last().unwrap(), y.last().unwrap()));
        drop(first);
        drop(second);
        pool.prune();
        assert_eq!(pool.unique_bytes(), 0);
        assert!(pool.u32s.blocks.is_empty());
    }
    #[test]
    fn hashes_are_only_candidates() {
        let mut pool = Pool::<u32>::default();
        let other: Arc<[u32]> = vec![9, 8, 7].into();
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        [1u32, 2, 3].as_slice().hash(&mut hash);
        pool.blocks
            .insert(hash.finish(), vec![Arc::downgrade(&other)]);
        let actual = pool.intern(&[1, 2, 3]);
        assert_eq!(actual.as_ref(), &[1, 2, 3]);
        assert!(!Arc::ptr_eq(&actual, &other));
    }
}
