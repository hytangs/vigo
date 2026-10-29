//! Lossless, bounded reference blocks. XOR-varints preserve every floating-point
//! bit, including signed zero; column blocks compress repeated field patterns.
//! Varint blocks stay uncompressed while they fit the retained budget. Deflate
//! is a fallback for larger references, not work paid by every comparison.
//! Construction uses a bounded batch; restoration decodes one block at a time.
use flate2::{Compression, read::DeflateDecoder, write::DeflateEncoder};
use std::io::{Read, Write};

const ROWS: usize = 4096;
const BATCH: usize = 8;

type Encoder = DeflateEncoder<Vec<u8>>;
struct Block<const N: usize> {
    count: usize,
    columns: [Vec<u8>; N],
}
impl<const N: usize> Block<N> {
    fn new() -> Self {
        Self {
            count: 0,
            columns: std::array::from_fn(|_| Vec::with_capacity(ROWS * 10)),
        }
    }
}
fn compress<const N: usize>(
    blocks: &[Block<N>],
    encoder: &mut Option<Encoder>,
) -> Option<Vec<Box<[u8]>>> {
    let encoder =
        encoder.get_or_insert_with(|| DeflateEncoder::new(Vec::new(), Compression::fast()));
    blocks
        .iter()
        .map(|block| {
            encoder
                .write_all(&(block.count as u32).to_le_bytes())
                .ok()?;
            for column in &block.columns {
                encoder
                    .write_all(&(column.len() as u32).to_le_bytes())
                    .ok()?;
            }
            for column in &block.columns {
                encoder.write_all(column).ok()?;
            }
            Some(encoder.reset(Vec::new()).ok()?.into_boxed_slice())
        })
        .collect()
}

struct Stored {
    compressed: bool,
    bytes: Box<[u8]>,
}
fn raw<const N: usize>(block: &Block<N>) -> Stored {
    let mut bytes =
        Vec::with_capacity((N + 1) * 4 + block.columns.iter().map(Vec::len).sum::<usize>());
    bytes.extend_from_slice(&(block.count as u32).to_le_bytes());
    for column in &block.columns {
        bytes.extend_from_slice(&(column.len() as u32).to_le_bytes());
    }
    for column in &block.columns {
        bytes.extend_from_slice(column);
    }
    Stored {
        compressed: false,
        bytes: bytes.into_boxed_slice(),
    }
}

pub(super) struct Packed<const N: usize> {
    blocks: Vec<Stored>,
    count: usize,
}

impl<const N: usize> Packed<N> {
    pub(super) fn bytes(&self) -> usize {
        self.blocks.capacity() * std::mem::size_of::<Stored>()
            + self.blocks.iter().map(|b| b.bytes.len()).sum::<usize>()
    }

    // Budget excludes the inline Packed structure, which its owner accounts for.
    pub(super) fn encode(mut rows: impl Iterator<Item = [u64; N]>, budget: usize) -> Option<Self> {
        let mut result = Self {
            blocks: Vec::new(),
            count: 0,
        };
        let mut batch: Vec<Block<N>> = Vec::new();
        // At most eight builder blocks and two codec workspaces accompany
        // the budgeted encoded reference. Workspaces are dropped on return.
        let mut encoders = (None, None);
        let mut compressed = false;
        loop {
            let mut used = 0;
            let mut exhausted = false;
            for slot in 0..BATCH {
                if slot == batch.len() {
                    batch.push(Block::new());
                }
                let block = &mut batch[slot];
                block.count = 0;
                for column in &mut block.columns {
                    column.clear();
                }
                let mut previous = [0; N];
                for row in rows.by_ref().take(ROWS) {
                    for ((old, value), column) in
                        previous.iter_mut().zip(row).zip(&mut block.columns)
                    {
                        let mut delta = value ^ *old;
                        *old = value;
                        while delta >= 128 {
                            column.push(delta as u8 | 128);
                            delta >>= 7;
                        }
                        column.push(delta as u8);
                    }
                    block.count += 1;
                }
                if block.count == 0 {
                    exhausted = true;
                    break;
                }
                result.count += block.count;
                used += 1;
                if block.count < ROWS {
                    exhausted = true;
                    break;
                }
            }
            if used == 0 {
                break;
            }
            let blocks = &batch[..used];
            if !compressed {
                result.blocks.extend(blocks.iter().map(raw));
            } else {
                let encoded = if let Some(pool) =
                    crate::ENDPOINT_ACCESS_POOL.as_ref().filter(|_| used >= 4)
                {
                    let (left, right) = blocks.split_at(used.div_ceil(2));
                    let (a, b) = pool.install(|| {
                        rayon::join(
                            || compress(left, &mut encoders.0),
                            || compress(right, &mut encoders.1),
                        )
                    });
                    let mut a = a?;
                    a.extend(b?);
                    a
                } else {
                    compress(blocks, &mut encoders.0)?
                };
                result
                    .blocks
                    .extend(encoded.into_iter().map(|bytes| Stored {
                        compressed: true,
                        bytes,
                    }));
            }
            if !compressed && result.bytes() > budget {
                // The bounded raw reference did not fit. Compress its existing
                // blocks once and keep subsequent batches compressed as well.
                compressed = true;
                let encoder = encoders
                    .0
                    .get_or_insert_with(|| DeflateEncoder::new(Vec::new(), Compression::fast()));
                for block in &mut result.blocks {
                    encoder.write_all(&block.bytes).ok()?;
                    block.bytes = encoder.reset(Vec::new()).ok()?.into_boxed_slice();
                    block.compressed = true;
                }
            }
            if result.bytes() > budget {
                return None;
            }
            if exhausted {
                break;
            }
        }
        Some(result)
    }

    pub(super) fn for_each(&self, mut visit: impl FnMut([u64; N])) {
        let mut raw = Vec::with_capacity(ROWS * N * 10 + (N + 1) * 4);
        for block in &self.blocks {
            raw.clear();
            // Blocks are internal and never persisted or supplied by callers.
            let raw = if block.compressed {
                DeflateDecoder::new(&block.bytes[..])
                    .read_to_end(&mut raw)
                    .expect("internal surface reference block");
                &raw[..]
            } else {
                &block.bytes[..]
            };
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
        let rows: Vec<_> = (0..ROWS * BATCH * 2 + 17)
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
        assert!(packed.blocks.iter().all(|b| !b.compressed));
        let smaller = Packed::encode(rows.iter().copied(), packed.bytes() - 1);
        if let Some(smaller) = smaller {
            assert!(smaller.bytes() < packed.bytes());
            let mut decoded = Vec::new();
            smaller.for_each(|row| decoded.push(row));
            assert_eq!(rows, decoded);
        }
        assert!(Packed::encode(rows.iter().copied(), 0).is_none());
        let empty = Packed::<4>::encode(std::iter::empty(), 0).unwrap();
        empty.for_each(|_| panic!("empty reference"));
        assert_eq!(empty.bytes(), 0);
    }
    #[test]
    fn streams_a_reference_larger_than_the_retained_budget() {
        let count = 600_000;
        let budget = 2 * 1024 * 1024;
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
        assert!(packed.blocks.iter().all(|b| b.compressed));
        let mut index = 0;
        packed.for_each(|actual| {
            assert_eq!(actual, row(index));
            index += 1;
        });
        assert_eq!(index, count);
    }
}
