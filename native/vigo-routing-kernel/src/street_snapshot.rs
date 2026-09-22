use memmap2::Mmap;
use napi::bindgen_prelude::Error;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::mem::{align_of, size_of};
use std::ops::Range;

use crate::snapshot_validation::{
    all_values, checked_array_byte_range, csr_offsets_are_valid, validate_array_layouts,
};

pub(crate) const HEADER_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Header {
    pub(crate) magic: String,
    pub(crate) version: u32,
    pub(crate) node_count: usize,
    pub(crate) edge_count: usize,
    pub(crate) spatial_min_lat: f64,
    pub(crate) spatial_min_lon: f64,
    pub(crate) spatial_cell_degrees: f64,
    pub(crate) spatial_rows: usize,
    pub(crate) spatial_columns: usize,
    pub(crate) spatial_node_order: String,
    arrays: HashMap<String, ArrayDescriptor>,
}

#[derive(Debug, Deserialize)]
struct ArrayDescriptor {
    #[serde(rename = "type")]
    type_name: String,
    offset: usize,
    length: usize,
}

pub(crate) struct Snapshot {
    pub(crate) mmap: Mmap,
    pub(crate) header: Header,
    reciprocal_edge_flags_range: Range<usize>,
}

impl Snapshot {
    pub(crate) fn open(snapshot_path: &str) -> napi::Result<Self> {
        let file = File::open(snapshot_path).map_err(|error| {
            Error::from_reason(format!("Unable to open street snapshot: {error}"))
        })?;
        let mmap = unsafe {
            Mmap::map(&file).map_err(|error| {
                Error::from_reason(format!("Unable to memory-map street snapshot: {error}"))
            })?
        };
        if mmap.len() < HEADER_BYTES {
            return Err(Error::from_reason(
                "Street accelerator snapshot is truncated.",
            ));
        }
        let header_text = std::str::from_utf8(&mmap[..HEADER_BYTES])
            .map_err(|error| {
                Error::from_reason(format!("Street snapshot header is not UTF-8: {error}"))
            })?
            .trim();
        let header: Header = serde_json::from_str(header_text).map_err(|error| {
            Error::from_reason(format!("Street snapshot header is invalid: {error}"))
        })?;
        if header.magic != "vigo.street.accelerator" || header.version != 7 {
            return Err(Error::from_reason(format!(
                "Unsupported street accelerator snapshot {} version {}.",
                header.magic, header.version
            )));
        }
        validate_array_layouts(
            &mmap,
            HEADER_BYTES,
            header.arrays.iter().map(|(name, descriptor)| {
                let (element_size, alignment) = match descriptor.type_name.as_str() {
                    "Float64Array" => (size_of::<f64>(), align_of::<f64>()),
                    "Uint32Array" => (size_of::<u32>(), align_of::<u32>()),
                    "Int32Array" => (size_of::<i32>(), align_of::<i32>()),
                    "Uint8Array" => (size_of::<u8>(), align_of::<u8>()),
                    _ => (0, 1),
                };
                (
                    name.as_str(),
                    descriptor.offset,
                    descriptor.length,
                    element_size,
                    alignment,
                )
            }),
        )
        .map_err(Error::from_reason)?;
        if header.arrays.values().any(|descriptor| {
            !matches!(
                descriptor.type_name.as_str(),
                "Float64Array" | "Uint32Array" | "Int32Array" | "Uint8Array"
            )
        }) {
            return Err(Error::from_reason(
                "Street snapshot declares an unsupported array type.",
            ));
        }
        let reciprocal_edge_flags_descriptor =
            header.arrays.get("reciprocalEdgeFlags").ok_or_else(|| {
                Error::from_reason("Street snapshot is missing required reciprocalEdgeFlags data.")
            })?;
        let reciprocal_edge_flags_range = checked_array_byte_range(
            reciprocal_edge_flags_descriptor.offset,
            reciprocal_edge_flags_descriptor.length,
            size_of::<u8>(),
        )
        .filter(|range| range.start >= HEADER_BYTES && range.end <= mmap.len())
        .ok_or_else(|| {
            Error::from_reason("Street snapshot reciprocalEdgeFlags exceeds or overflows its file.")
        })?;
        let snapshot = Self {
            mmap,
            header,
            reciprocal_edge_flags_range,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    fn validate(&self) -> napi::Result<()> {
        let node_lats = self.f64_array("nodeLats")?;
        let node_lons = self.f64_array("nodeLons")?;
        let edge_offsets = self.u32_array("edgeOffsets")?;
        let edge_targets = self.u32_array("edgeTargets")?;
        let edge_distances = self.f64_array("edgeDistances")?;
        let spatial_offsets = self.u32_array("spatialOffsets")?;
        let reverse_offsets = self.u32_array("reverseOffsets")?;
        let reverse_sources = self.u32_array("reverseSources")?;
        let reverse_edge_indices = self.u32_array("reverseEdgeIndices")?;
        let reciprocal_edge_flags = self.u8_array("reciprocalEdgeFlags")?;
        let node_offsets_len = self.header.node_count.checked_add(1);
        let spatial_offsets_len = self
            .header
            .spatial_rows
            .checked_mul(self.header.spatial_columns)
            .and_then(|cells| cells.checked_add(1));
        if node_lats.len() != self.header.node_count
            || node_lons.len() != self.header.node_count
            || Some(edge_offsets.len()) != node_offsets_len
            || edge_targets.len() != self.header.edge_count
            || edge_distances.len() != self.header.edge_count
            || Some(spatial_offsets.len()) != spatial_offsets_len
            || Some(reverse_offsets.len()) != node_offsets_len
            || reverse_sources.len() != self.header.edge_count
            || reverse_edge_indices.len() != self.header.edge_count
            || reciprocal_edge_flags.len() != self.header.edge_count
            || !csr_offsets_are_valid(edge_offsets, self.header.edge_count)
            || !csr_offsets_are_valid(spatial_offsets, self.header.node_count)
            || !csr_offsets_are_valid(reverse_offsets, self.header.edge_count)
            || !all_values(edge_targets, |node| {
                (*node as usize) < self.header.node_count
            })
            || !all_values(reverse_sources, |node| {
                (*node as usize) < self.header.node_count
            })
            || !all_values(reverse_edge_indices, |edge| {
                (*edge as usize) < self.header.edge_count
            })
            || !all_values(edge_distances, |distance| {
                distance.is_finite() & (*distance >= 0.0)
            })
            || !all_values(reciprocal_edge_flags, |flag| *flag <= 1)
            || !all_values(node_lats, |value| {
                value.is_finite() & (-90.0..=90.0).contains(value)
            })
            || !all_values(node_lons, |value| {
                value.is_finite() & (-180.0..=180.0).contains(value)
            })
            || self.header.spatial_node_order != "cell_then_source_node_id"
        {
            return Err(Error::from_reason(
                "Street accelerator snapshot topology is inconsistent.",
            ));
        }
        Ok(())
    }

    fn typed_array<T>(&self, name: &str, expected_type: &str) -> napi::Result<&[T]> {
        let descriptor = self
            .header
            .arrays
            .get(name)
            .ok_or_else(|| Error::from_reason(format!("Street snapshot is missing {name}.")))?;
        if descriptor.type_name != expected_type {
            return Err(Error::from_reason(format!(
                "Street snapshot {name} has type {}, expected {expected_type}.",
                descriptor.type_name
            )));
        }
        let byte_range =
            checked_array_byte_range(descriptor.offset, descriptor.length, size_of::<T>())
                .ok_or_else(|| {
                    Error::from_reason(format!("Street snapshot {name} range overflow."))
                })?;
        if byte_range.start < HEADER_BYTES || byte_range.end > self.mmap.len() {
            return Err(Error::from_reason(format!(
                "Street snapshot {name} exceeds or is misaligned within its file."
            )));
        }
        let start = self.mmap[byte_range.start..].as_ptr();
        if !(start as usize).is_multiple_of(align_of::<T>()) {
            return Err(Error::from_reason(format!(
                "Street snapshot {name} exceeds or is misaligned within its file."
            )));
        }
        Ok(unsafe { std::slice::from_raw_parts(start.cast::<T>(), descriptor.length) })
    }

    pub(crate) fn f64_array(&self, name: &str) -> napi::Result<&[f64]> {
        self.typed_array(name, "Float64Array")
    }

    pub(crate) fn u32_array(&self, name: &str) -> napi::Result<&[u32]> {
        self.typed_array(name, "Uint32Array")
    }

    pub(crate) fn i32_array(&self, name: &str) -> napi::Result<&[i32]> {
        self.typed_array(name, "Int32Array")
    }

    pub(crate) fn u8_array(&self, name: &str) -> napi::Result<&[u8]> {
        self.typed_array(name, "Uint8Array")
    }

    pub(crate) fn reciprocal_edge_flags(&self) -> &[u8] {
        &self.mmap[self.reciprocal_edge_flags_range.clone()]
    }
}
