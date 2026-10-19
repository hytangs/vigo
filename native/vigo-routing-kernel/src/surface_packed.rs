//! Lossless, bounded reference blocks. XOR-varints preserve every floating-point
//! bit, including signed zero; column blocks compress repeated field patterns. Both
//! construction and restoration use one small block, never a full raw copy.
use flate2::{Compression, read::DeflateDecoder, write::DeflateEncoder};
use std::io::{Read, Write};

const ROWS: usize = 4096;

pub(super) struct Packed<const N: usize> {
    blocks: Vec<Box<[u8]>>,
    count: usize,
}

impl<const N: usize> Packed<N> {
    pub(super) fn bytes(&self) -> usize {
        self.blocks.capacity() * std::mem::size_of::<Box<[u8]>>()
            + self.blocks.iter().map(|b| b.len()).sum::<usize>()
    }

    // Budget excludes the inline Packed structure, which its owner accounts for.
    pub(super) fn encode(rows: impl Iterator<Item = [u64; N]>, budget: usize) -> Option<Self> {
        let mut result = Self {
            blocks: Vec::new(),
            count: 0,
        };
        let mut previous = [0; N];
        let mut columns: [Vec<u8>; N] = std::array::from_fn(|_| Vec::with_capacity(ROWS * 10));
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
        let mut flush = |result: &mut Self, columns: &mut [Vec<u8>; N]| -> Option<()> {
            let count = (result.count - 1) % ROWS + 1;
            encoder.write_all(&(count as u32).to_le_bytes()).ok()?;
            for column in columns.iter() {
                encoder
                    .write_all(&(column.len() as u32).to_le_bytes())
                    .ok()?;
            }
            for column in columns.iter_mut() {
                encoder.write_all(column).ok()?;
                column.clear();
            }
            result
                .blocks
                .push(encoder.reset(Vec::new()).ok()?.into_boxed_slice());
            (result.bytes() <= budget).then_some(())
        };
        for row in rows {
            for ((old, value), column) in previous.iter_mut().zip(row).zip(&mut columns) {
                let mut delta = value ^ *old;
                *old = value;
                while delta >= 128 {
                    column.push(delta as u8 | 128);
                    delta >>= 7;
                }
                column.push(delta as u8);
            }
            result.count += 1;
            if result.count.is_multiple_of(ROWS) {
                flush(&mut result, &mut columns)?;
                previous.fill(0);
            }
        }
        if !result.count.is_multiple_of(ROWS) {
            flush(&mut result, &mut columns)?;
        }
        Some(result)
    }

    pub(super) fn for_each(&self, mut visit: impl FnMut([u64; N])) {
        let mut raw = Vec::with_capacity(ROWS * N * 10 + (N + 1) * 4);
        for block in &self.blocks {
            raw.clear();
            // Blocks are created internally and never persisted or supplied by callers.
            DeflateDecoder::new(&block[..])
                .read_to_end(&mut raw)
                .expect("internal surface reference block");
            let word =
                |offset| u32::from_le_bytes(raw[offset..offset + 4].try_into().unwrap()) as usize;
            let count = word(0);
            let mut offset = (N + 1) * 4;
            let mut cursors = std::array::from_fn::<_, N, _>(|field| {
                let start = offset;
                offset += word((field + 1) * 4);
                start
            });
            let mut previous = [0; N];
            for _ in 0..count {
                for (old, cursor) in previous.iter_mut().zip(&mut cursors) {
                    let mut delta = 0;
                    let mut shift = 0;
                    loop {
                        let byte = raw[*cursor];
                        *cursor += 1;
                        delta |= u64::from(byte & 127) << shift;
                        if byte < 128 {
                            break;
                        }
                        shift += 7;
                    }
                    *old ^= delta;
                }
                visit(previous);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lossless_across_blocks_and_rejects_over_budget() {
        let mut state = 731_u64;
        let rows: Vec<_> = (0..ROWS * 3 + 17)
            .map(|i| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                [
                    i as u64,
                    state,
                    (-0.0_f64).to_bits(),
                    f64::INFINITY.to_bits(),
                ]
            })
            .collect();
        let packed = Packed::encode(rows.iter().copied(), usize::MAX).unwrap();
        let mut decoded = Vec::new();
        packed.for_each(|row| decoded.push(row));
        assert_eq!(rows, decoded);
        assert!(Packed::encode(rows.iter().copied(), packed.bytes()).is_some());
        assert!(Packed::encode(rows.iter().copied(), packed.bytes() - 1).is_none());
        assert!(Packed::encode(rows.iter().copied(), 0).is_none());
        let empty = Packed::<4>::encode(std::iter::empty(), 0).unwrap();
        empty.for_each(|_| panic!("empty reference"));
        assert_eq!(empty.bytes(), 0);
    }
    #[test]
    fn streams_a_reference_larger_than_the_retained_budget() {
        let count = 600_000;
        let budget = 32 * 1024 * 1024;
        assert!(count * std::mem::size_of::<[u64; 8]>() > budget);
        let row = |i: usize| {
            [
                i as u64,
                (i / 2) as u64,
                0,
                1.0_f64.to_bits(),
                (i as f64 / 7.0).to_bits(),
                (i % 13) as u64,
                0,
                (i % 31) as u64,
            ]
        };
        let packed = Packed::encode((0..count).map(row), budget).unwrap();
        assert!(packed.bytes() < budget);
        let mut index = 0;
        packed.for_each(|actual| {
            assert_eq!(actual, row(index));
            index += 1;
        });
        assert_eq!(index, count);
    }
}
