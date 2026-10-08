//! Compact CCH persistence. Query arrays stay aligned and memory-mappable.
//! Driving indexes append a compressed input-arc mapping for traffic updates;
//! walking indexes omit that preparation data entirely.

use std::io::{self, Read, Write};
use flate2::{Compression, bufread::GzDecoder, write::GzEncoder};
use crate::bundle::{CchBundle, INVALID_ID};
use crate::customize::Metric;
use crate::structure::Cch;

const STRUCT_MAGIC: u64 = 0x4343_485F_5354_5243;
const METRIC_MAGIC: u64 = 0x4343_485F_4D45_5452;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn write_u32<W: Write>(out: &mut W, value: u32) -> io::Result<()> {
    out.write_all(&value.to_le_bytes())
}

fn write_u64<W: Write>(out: &mut W, value: u64) -> io::Result<()> {
    out.write_all(&value.to_le_bytes())
}

// Fixed scratch space, independent of the graph size. Do not copy a whole
// street column merely to serialize its byte order.
fn write_sized_vector<W: Write>(out: &mut W, values: &[u32]) -> io::Result<()> {
    write_u64(out, std::mem::size_of_val(values) as u64)?;
    let mut bytes = [0_u8; 16_384];
    for chunk in values.chunks(bytes.len() / 4) {
        for (value, slot) in chunk.iter().zip(bytes.chunks_exact_mut(4)) {
            slot.copy_from_slice(&value.to_le_bytes());
        }
        out.write_all(&bytes[..chunk.len() * 4])?;
    }
    Ok(())
}

fn read_sized_vector<R: Read>(input: &mut R, maximum: usize, exact: bool) -> io::Result<Vec<u32>> {
    let mut header = [0; 8];
    input.read_exact(&mut header)?;
    let bytes = usize::try_from(u64::from_le_bytes(header))
        .map_err(|_| invalid("CCH customization length exceeds the address space"))?;
    if bytes % 4 != 0 || bytes / 4 > maximum || (exact && bytes / 4 != maximum) {
        return Err(invalid("CCH customization section length disagrees with graph counts"));
    }
    // A corrupt compressed section must not reserve its declared size before
    // producing those bytes. Grow only as verified chunks arrive.
    let mut result = Vec::new();
    let mut buffer = [0_u8; 16_384];
    let mut remaining = bytes;
    while remaining != 0 {
        let count = remaining.min(buffer.len());
        input.read_exact(&mut buffer[..count])?;
        result.try_reserve(count / 4)
            .map_err(|_| invalid("CCH customization allocation failed"))?;
        result.extend(buffer[..count].chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().expect("four-byte chunk"))));
        remaining -= count;
    }
    Ok(result)
}

fn validate_extra(offsets: &[u32], entries: &[u32], input_count: usize) -> io::Result<()> {
    if offsets.first() != Some(&0)
        || offsets.last().copied().map(|v| v as usize) != Some(entries.len())
        || offsets.windows(2).any(|p| p[0] > p[1])
        || entries.iter().any(|&v| v as usize >= input_count)
    {
        return Err(invalid("CCH extra input-arc adjacency is inconsistent"));
    }
    Ok(())
}

impl Cch {
    /// Save the seven query columns without preparation-only input mappings.
    ///
    /// # Errors
    /// Returns an error when creating, writing, or flushing the file fails.
    pub fn save_query_struct(&self, path: &std::path::Path) -> io::Result<()> {
        self.save_structure(path, false)
    }

    /// Save a query index with compressed mappings for later customization.
    ///
    /// # Errors
    /// Returns an error when creating, writing, or flushing the file fails.
    pub fn save_struct(&self, path: &std::path::Path) -> io::Result<()> {
        self.save_structure(path, true)
    }

    fn save_structure(&self, path: &std::path::Path, customizable: bool) -> io::Result<()> {
        let mut out = io::BufWriter::new(std::fs::File::create(path)?);
        write_u64(&mut out, STRUCT_MAGIC)?;
        write_u32(&mut out, 2)?;
        write_u32(&mut out, u32::from(customizable))?;
        write_u64(&mut out, self.node_count() as u64)?;
        write_u64(&mut out, self.cch_arc_count() as u64)?;
        write_u64(&mut out, if customizable { self.input_arc_to_cch_arc.len() as u64 } else { 0 })?;
        for values in [
            &self.rank, &self.elimination_tree_parent, &self.up_first_out,
            &self.up_head, &self.down_first_out, &self.down_head, &self.down_to_up,
        ] {
            write_sized_vector(&mut out, values)?;
        }
        if customizable {
            let mut compressed = GzEncoder::new(&mut out, Compression::fast());
            for values in [
                &self.input_arc_to_cch_arc, &self.forward_input_arc_of_cch,
                &self.backward_input_arc_of_cch, &self.first_extra_forward_input_arc_of_cch,
                &self.first_extra_backward_input_arc_of_cch, &self.extra_forward_input_arc_of_cch,
                &self.extra_backward_input_arc_of_cch,
            ] {
                write_sized_vector(&mut compressed, values)?;
            }
            compressed.finish()?;
        }
        out.flush()
    }

    /// Load customization data only when a driving metric actually changes.
    /// Query columns are validated through the same mmap reader used by routing.
    /// The inverse rank and upward tails are reconstructed from those columns.
    ///
    /// # Errors
    /// Returns an error for I/O failures, old formats, query-only indexes, or
    /// malformed query columns and customization data.
    #[allow(clippy::too_many_lines)]
    #[allow(clippy::cast_possible_truncation)] // bundle reader validates u32 graph counts
    pub fn load_struct(path: &std::path::Path) -> io::Result<Self> {
        let bundle = CchBundle::open(path)?;
        let (payload, input_count) = bundle.customization_data()
            .ok_or_else(|| invalid("CCH query-only index has no customization data"))?;
        let view = bundle.view();
        let arc_count = view.up_head.len();
        let mut input = GzDecoder::new(payload);
        let read = |input: &mut GzDecoder<&[u8]>, maximum, exact| {
            read_sized_vector(input, maximum, exact)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        };
        let input_arc_to_cch_arc = read(&mut input, input_count, true)?;
        let forward_input_arc_of_cch = read(&mut input, arc_count, true)?;
        let backward_input_arc_of_cch = read(&mut input, arc_count, true)?;
        let first_extra_forward_input_arc_of_cch = read(&mut input, arc_count + 1, true)?;
        let first_extra_backward_input_arc_of_cch = read(&mut input, arc_count + 1, true)?;
        let extra_forward_input_arc_of_cch = read(&mut input, input_count, false)?;
        let extra_backward_input_arc_of_cch = read(&mut input, input_count, false)?;
        // Force gzip checksum/footer validation, and reject another member or
        // unexplained trailing bytes. Each file contains exactly one payload.
        let mut end = [0_u8; 1];
        if input.read(&mut end).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))? != 0
            || !input.into_inner().is_empty()
        {
            return Err(invalid("CCH customization contains trailing data"));
        }
        if input_arc_to_cch_arc.iter().any(|&a| a != INVALID_ID && a as usize >= arc_count)
            || forward_input_arc_of_cch.iter().chain(&backward_input_arc_of_cch)
                .any(|&a| a != INVALID_ID && a as usize >= input_count)
        {
            return Err(invalid("CCH customization references an out-of-range arc"));
        }
        validate_extra(&first_extra_forward_input_arc_of_cch, &extra_forward_input_arc_of_cch, input_count)?;
        validate_extra(&first_extra_backward_input_arc_of_cch, &extra_backward_input_arc_of_cch, input_count)?;
        let mut order = vec![0; view.rank.len()];
        for (node, &rank) in view.rank.iter().enumerate() {
            order[rank as usize] = node as u32;
        }
        let mut up_tail = vec![0; arc_count];
        for (node, offsets) in view.up_first_out.windows(2).enumerate() {
            up_tail[offsets[0] as usize..offsets[1] as usize].fill(node as u32);
        }
        Ok(Self {
            order, up_tail, rank: view.rank.to_vec(),
            elimination_tree_parent: view.elimination_tree_parent.to_vec(),
            up_first_out: view.up_first_out.to_vec(), up_head: view.up_head.to_vec(),
            down_first_out: view.down_first_out.to_vec(), down_head: view.down_head.to_vec(),
            down_to_up: view.down_to_up.to_vec(), input_arc_to_cch_arc,
            forward_input_arc_of_cch, backward_input_arc_of_cch,
            first_extra_forward_input_arc_of_cch, first_extra_backward_input_arc_of_cch,
            extra_forward_input_arc_of_cch, extra_backward_input_arc_of_cch,
        })
    }
}

impl Metric {
    /// Write aligned forward and backward metric columns.
    ///
    /// # Errors
    /// Returns an error on I/O failure.
    pub fn save(&self, path: &std::path::Path) -> io::Result<()> {
        let mut out = io::BufWriter::new(std::fs::File::create(path)?);
        write_u64(&mut out, METRIC_MAGIC)?;
        write_u32(&mut out, 1)?;
        write_u32(&mut out, 0)?;
        write_u64(&mut out, self.forward.len() as u64)?;
        write_sized_vector(&mut out, &self.forward)?;
        write_sized_vector(&mut out, &self.backward)?;
        out.flush()
    }
}
