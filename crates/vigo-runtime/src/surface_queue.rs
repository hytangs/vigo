//! Monotone elapsed-time queue for street propagation. Float bits preserve the
//! exact order of finite nonnegative times; no duration is rounded. Equal-time
//! entries retain the original heap's walking, node, seed and witness order.
use super::{BinaryHeap, LabelQueueEntry};

pub(super) struct SurfaceQueue {
    last: u64,
    buckets: [Vec<LabelQueueEntry>; 64],
    occupied: u64,
    ready: BinaryHeap<LabelQueueEntry>,
    fallback: Option<BinaryHeap<LabelQueueEntry>>,
}

impl SurfaceQueue {
    pub(super) fn new() -> Self {
        Self {
            last: 0,
            buckets: std::array::from_fn(|_| Vec::new()),
            occupied: 0,
            ready: BinaryHeap::new(),
            fallback: None,
        }
    }
    fn key(entry: &LabelQueueEntry) -> u64 {
        if entry.duration_minutes == 0. {
            0
        } else {
            entry.duration_minutes.to_bits()
        }
    }
    fn distribute(&mut self, entry: LabelQueueEntry, key: u64) {
        let difference = key ^ self.last;
        if difference == 0 {
            self.ready.push(entry);
        } else {
            let index = 63 - difference.leading_zeros();
            self.buckets[index as usize].push(entry);
            self.occupied |= 1_u64 << index;
        }
    }
    pub(super) fn push(&mut self, entry: LabelQueueEntry) {
        if let Some(heap) = &mut self.fallback {
            heap.push(entry);
            return;
        }
        let key = Self::key(&entry);
        // Defensive fallback keeps the old behavior if a caller ever supplies
        // a nonmonotone priority, including numerical cancellation at an edge.
        if key < self.last || !entry.duration_minutes.is_finite() || entry.duration_minutes < 0. {
            let mut heap = std::mem::take(&mut self.ready);
            for bucket in &mut self.buckets {
                heap.extend(bucket.drain(..));
            }
            heap.push(entry);
            self.fallback = Some(heap);
        } else {
            self.distribute(entry, key);
        }
    }
    pub(super) fn pop(&mut self) -> Option<LabelQueueEntry> {
        if let Some(heap) = &mut self.fallback {
            return heap.pop();
        }
        if self.ready.is_empty() {
            if self.occupied == 0 {
                return None;
            }
            // Exact timestamps often occupy high radix buckets. Finding the
            // next bucket must not scan dozens of empty vectors per label.
            let index = self.occupied.trailing_zeros() as usize;
            self.occupied &= !(1_u64 << index);
            let mut entries = std::mem::take(&mut self.buckets[index]);
            self.last = entries.iter().map(Self::key).min().unwrap();
            for entry in entries.drain(..) {
                self.distribute(entry, Self::key(&entry));
            }
            // Every redistributed key differs at a lower bit, so this bucket
            // is empty and its capacity can be reused on the next timestamp.
            self.buckets[index] = entries;
        }
        self.ready.pop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_heap_for_monotone_float_priorities_and_all_ties() {
        let mut queue = SurfaceQueue::new();
        let mut reference = BinaryHeap::new();
        let mut random = 731_u64;
        let mut time = 0.;
        for index in 0..40_000 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let entry = LabelQueueEntry {
                label_index: index,
                duration_minutes: time + (random % 100) as f64 / 13.,
                walk_distance_m: (random % 17) as f64,
                node: (random % 11) as u32,
                seed_index: (random % 5) as u32,
            };
            queue.push(entry);
            reference.push(entry);
            if index % 3 != 0 {
                let expected = reference.pop().unwrap();
                let actual = queue.pop().unwrap();
                assert_eq!(actual.label_index, expected.label_index);
                time = expected.duration_minutes;
            }
        }
        while let Some(expected) = reference.pop() {
            assert_eq!(queue.pop().unwrap().label_index, expected.label_index);
        }
        assert!(queue.pop().is_none());
        assert!(queue.fallback.is_none());
    }
    #[test]
    fn preserves_heap_order_after_nonmonotone_input() {
        let mut queue = SurfaceQueue::new();
        let entry = |time, index| LabelQueueEntry {
            duration_minutes: time,
            label_index: index,
            walk_distance_m: 0.,
            node: 0,
            seed_index: 0,
        };
        queue.push(entry(3., 0));
        queue.push(entry(8., 1));
        assert_eq!(queue.pop().unwrap().label_index, 0);
        queue.push(entry(2., 2));
        queue.push(entry(9., 3));
        for index in [2, 1, 3] {
            assert_eq!(queue.pop().unwrap().label_index, index);
        }
        assert!(queue.pop().is_none());
    }
}
