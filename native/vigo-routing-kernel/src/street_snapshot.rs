#[cfg(not(feature = "node"))]
use crate::standalone_types as napi;
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
    long_edges_by_cell: HashMap<(i32, i32), Vec<[u32; 2]>>,
    unindexed_long_edges: Vec<([u32; 2], [f64; 4])>,
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
        let mut snapshot = Self {
            mmap,
            header,
            reciprocal_edge_flags_range,
            long_edges_by_cell: HashMap::new(),
            unindexed_long_edges: Vec::new(),
        };
        snapshot.validate()?;
        snapshot.index_long_edges()?;
        Ok(snapshot)
    }

    fn index_long_edges(&mut self) -> napi::Result<()> {
        let lats = self.f64_array("nodeLats")?;
        let lons = self.f64_array("nodeLons")?;
        let offsets = self.u32_array("edgeOffsets")?;
        let targets = self.u32_array("edgeTargets")?;
        let reciprocal = self.reciprocal_edge_flags();
        let mut cells = HashMap::<(i32, i32), Vec<[u32; 2]>>::new();
        let mut unindexed = Vec::new();
        for left in 0..lats.len() {
            for edge in offsets[left] as usize..offsets[left + 1] as usize {
                let right = targets[edge] as usize;
                if left >= right || reciprocal[edge] == 0 {
                    continue;
                }
                // A conservative coordinate-span filter: short segments are
                // already discoverable from the 160 m vertex search. Use
                // geometry rather than an edge's possibly customized weight.
                if (lats[left] - lats[right]).abs() * 111_320.0 < 160.0
                    && (lons[left] - lons[right]).abs() * 111_320.0 < 160.0
                {
                    continue;
                }
                let bounds = [
                    lons[left].min(lons[right]),
                    lats[left].min(lats[right]),
                    lons[left].max(lons[right]),
                    lats[left].max(lats[right]),
                ];
                let [west, south, east, north] = self.edge_cells(bounds);
                let count = (i64::from(east) - i64::from(west) + 1)
                    .saturating_mul(i64::from(north) - i64::from(south) + 1);
                let nodes = [left as u32, right as u32];
                // Very large segments must not allocate a dense world-sized
                // index. Keep them as bounded-box candidates instead.
                if count > 4096 {
                    unindexed.push((nodes, bounds));
                    continue;
                }
                for row in south..=north {
                    for col in west..=east {
                        cells.entry((row, col)).or_default().push(nodes);
                    }
                }
            }
        }
        self.long_edges_by_cell = cells;
        self.unindexed_long_edges = unindexed;
        Ok(())
    }

    fn edge_cells(&self, [west, south, east, north]: [f64; 4]) -> [i32; 4] {
        let h = &self.header;
        [
            ((west - h.spatial_min_lon) / h.spatial_cell_degrees).floor() as i32,
            ((south - h.spatial_min_lat) / h.spatial_cell_degrees).floor() as i32,
            ((east - h.spatial_min_lon) / h.spatial_cell_degrees).floor() as i32,
            ((north - h.spatial_min_lat) / h.spatial_cell_degrees).floor() as i32,
        ]
    }

    pub(crate) fn for_each_long_edge(
        &self,
        longitude: f64,
        latitude: f64,
        mut add: impl FnMut([u32; 2]),
    ) {
        let dy = crate::SNAP_RADIUS_M / 110_574.0;
        let dx = crate::SNAP_RADIUS_M / (111_320.0 * latitude.to_radians().cos().abs()).max(1000.0);
        let bounds = [longitude - dx, latitude - dy, longitude + dx, latitude + dy];
        let [west, south, east, north] = self.edge_cells(bounds);
        let count = (i64::from(east) - i64::from(west) + 1)
            .saturating_mul(i64::from(north) - i64::from(south) + 1);
        if count > 4096 {
            for (&(row, col), edges) in &self.long_edges_by_cell {
                if (south..=north).contains(&row) && (west..=east).contains(&col) {
                    for &nodes in edges {
                        add(nodes);
                    }
                }
            }
        } else {
            for row in south..=north {
                for col in west..=east {
                    if let Some(edges) = self.long_edges_by_cell.get(&(row, col)) {
                        for &nodes in edges {
                            add(nodes);
                        }
                    }
                }
            }
        }
        for &(nodes, [w, s, e, n]) in &self.unindexed_long_edges {
            if w <= bounds[2] && e >= bounds[0] && s <= bounds[3] && n >= bounds[1] {
                add(nodes);
            }
        }
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
            || !self.header.spatial_cell_degrees.is_finite()
            || self.header.spatial_cell_degrees <= 0.0
            || !self.header.spatial_min_lat.is_finite()
            || !self.header.spatial_min_lon.is_finite()
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
