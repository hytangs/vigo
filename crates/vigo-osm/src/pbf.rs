//! OSM PBF reading: bounded blobs, string tables and entities. Limits and
//! error messages are those the earlier JavaScript reader used.

use crate::{Error, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub const BLOB_HEADER_BYTES: usize = 64 * 1024;
pub const BLOB_BYTES: usize = 32 * 1024 * 1024;
const STRING_TABLE_ENTRIES: usize = 1_000_000;
const PRIMITIVE_GROUPS: usize = 100_000;
const NODES_PER_BLOCK: usize = 5_000_000;
const WAYS_PER_BLOCK: usize = 1_000_000;
const RELATIONS_PER_BLOCK: usize = 100_000;
const TAGS_PER_BLOCK: usize = 5_000_000;
const WAY_REFERENCES: usize = 5_000_000;

/// A protobuf reader with the `pbf` package's varint and skip rules.
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn done(&self) -> bool {
        self.position >= self.bytes.len()
    }

    fn varint(&mut self) -> Result<u64> {
        let mut value = 0u64;
        for shift in 0..10 {
            let Some(&byte) = self.bytes.get(self.position) else {
                return Err(Error::new("Unexpected end of OSM PBF message."));
            };
            self.position += 1;
            value |= u64::from(byte & 0x7f) << (7 * shift);
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err(Error::new("Expected varint not more than 10 bytes"))
    }

    fn svarint(&mut self) -> Result<i64> {
        let value = self.varint()?;
        Ok((value >> 1) as i64 ^ -((value & 1) as i64))
    }

    fn bytes(&mut self) -> Result<&'a [u8]> {
        let length = self.varint()? as usize;
        let end = self
            .position
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len());
        let Some(end) = end else {
            return Err(Error::new("Unexpected end of OSM PBF message."));
        };
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn field(&mut self) -> Result<(u32, u32)> {
        let key = self.varint()?;
        Ok(((key >> 3) as u32, (key & 7) as u32))
    }

    fn skip(&mut self, wire: u32) -> Result<()> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => self.position += 8,
            2 => {
                self.bytes()?;
            }
            5 => self.position += 4,
            other => return Err(Error::new(format!("Unimplemented type: {other}"))),
        }
        Ok(())
    }

    /// `readPackedVarint`, accepting both packed and single encodings.
    fn packed_varint(&mut self, wire: u32, out: &mut Vec<u64>) -> Result<()> {
        if wire != 2 {
            out.push(self.varint()?);
            return Ok(());
        }
        let bytes = self.bytes()?;
        let mut inner = Reader::new(bytes);
        while !inner.done() {
            out.push(inner.varint()?);
        }
        Ok(())
    }

    fn packed_svarint(&mut self, wire: u32, out: &mut Vec<i64>) -> Result<()> {
        if wire != 2 {
            out.push(self.svarint()?);
            return Ok(());
        }
        let bytes = self.bytes()?;
        let mut inner = Reader::new(bytes);
        while !inner.done() {
            out.push(inner.svarint()?);
        }
        Ok(())
    }

    fn packed_u32(&mut self, wire: u32, out: &mut Vec<u32>) -> Result<()> {
        let mut values = Vec::new();
        self.packed_varint(wire, &mut values)?;
        out.extend(values.into_iter().map(|v| v as u32));
        Ok(())
    }
}

/// Header bounds; `order` keeps the field order the JavaScript object had.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub west: f64,
    pub east: f64,
    pub north: f64,
    pub south: f64,
    order: [u8; 4],
}

impl Bounds {
    pub fn to_js(self) -> vigo_format::js::Js {
        let mut object = vigo_format::js::Js::object();
        for field in self.order {
            match field {
                1 => object.set("west", self.west),
                2 => object.set("east", self.east),
                3 => object.set("north", self.north),
                _ => object.set("south", self.south),
            };
        }
        object
    }
}

pub struct Block {
    pub strings: Vec<String>,
    pub groups: Vec<(usize, usize)>,
    pub data: Vec<u8>,
    pub granularity: i64,
    pub lat_offset: i64,
    pub lon_offset: i64,
    pub dense_nodes_allowed: bool,
    pub bounds: Option<Bounds>,
    budget: std::cell::Cell<Budget>,
}

#[derive(Clone, Copy, Default)]
struct Budget {
    nodes: usize,
    ways: usize,
    relations: usize,
    tags: usize,
}

pub struct Node {
    pub id: i64,
    pub lat: i64,
    pub lon: i64,
    pub keys: Vec<u32>,
    pub vals: Vec<u32>,
}

pub struct DenseNodes {
    pub ids: Vec<i64>,
    pub lats: Vec<i64>,
    pub lons: Vec<i64>,
    pub keys_vals: Vec<u32>,
    pub tag_offsets: Vec<u32>,
}

pub struct Way {
    pub id: i64,
    pub keys: Vec<u32>,
    pub vals: Vec<u32>,
    pub refs: Vec<i64>,
}

pub struct Relation {
    pub id: i64,
    pub keys: Vec<u32>,
    pub vals: Vec<u32>,
    pub roles: Vec<u32>,
    pub refs: Vec<i64>,
    pub types: Vec<u32>,
}

/// Entity callbacks; a reader decodes only what a handler asks for.
pub trait Handler {
    fn wants_nodes(&self) -> bool {
        false
    }
    fn wants_ways(&self) -> bool {
        false
    }
    fn wants_relations(&self) -> bool {
        false
    }
    fn node(&mut self, _block: &Block, _node: Node) -> Result<()> {
        Ok(())
    }
    fn dense_nodes(&mut self, _block: &Block, _dense: DenseNodes) -> Result<()> {
        Ok(())
    }
    fn way(&mut self, _block: &Block, _way: Way) -> Result<()> {
        Ok(())
    }
    fn relation(&mut self, _block: &Block, _relation: Relation) -> Result<()> {
        Ok(())
    }
}

fn decode_string(bytes: &[u8]) -> Result<String> {
    // TextDecoder('utf8', { fatal: true }) rejects invalid UTF-8 and removes a BOM.
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::new("The encoded data was not valid for encoding utf-8"))?;
    Ok(text.strip_prefix('\u{FEFF}').unwrap_or(text).to_owned())
}

impl Block {
    fn parse(data: Vec<u8>) -> Result<Self> {
        let mut strings = Vec::new();
        let mut groups = Vec::new();
        let mut granularity: u64 = 100;
        let mut lat_offset = 0i64;
        let mut lon_offset = 0i64;
        {
            let mut reader = Reader::new(&data);
            while !reader.done() {
                let (tag, wire) = reader.field()?;
                match tag {
                    1 => {
                        let table = reader.bytes()?;
                        let mut inner = Reader::new(table);
                        while !inner.done() {
                            let (field, field_wire) = inner.field()?;
                            if field == 1 {
                                if strings.len() >= STRING_TABLE_ENTRIES {
                                    return Err(Error::new(
                                        "OSM PBF string table exceeds the per-block entry limit.",
                                    ));
                                }
                                strings.push(decode_string(inner.bytes()?)?);
                            } else {
                                inner.skip(field_wire)?;
                            }
                        }
                    }
                    2 => {
                        if groups.len() >= PRIMITIVE_GROUPS {
                            return Err(Error::new(
                                "OSM PBF primitive block exceeds the group limit.",
                            ));
                        }
                        let bytes = reader.bytes()?;
                        let start = bytes.as_ptr() as usize - data.as_ptr() as usize;
                        groups.push((start, start + bytes.len()));
                    }
                    17 => granularity = reader.varint()?,
                    19 => lat_offset = reader.varint()? as i64,
                    20 => lon_offset = reader.varint()? as i64,
                    _ => reader.skip(wire)?,
                }
            }
        }
        if granularity == 0 || granularity > i64::MAX as u64 {
            return Err(Error::new(
                "OSM PBF primitive block has an invalid granularity.",
            ));
        }
        Ok(Self {
            strings,
            groups,
            data,
            granularity: granularity as i64,
            lat_offset,
            lon_offset,
            dense_nodes_allowed: false,
            bounds: None,
            budget: std::cell::Cell::new(Budget::default()),
        })
    }

    pub fn string(&self, index: u32) -> Option<&str> {
        self.strings.get(index as usize).map(String::as_str)
    }

    /// `coordinate(block, lat, lon)` as `[lon, lat]`.
    pub fn coordinate(&self, lat: i64, lon: i64) -> Result<(f64, f64)> {
        let granularity = self.granularity as f64;
        let lon = (self.lon_offset as f64 + granularity * lon as f64) * 1e-9;
        let lat = (self.lat_offset as f64 + granularity * lat as f64) * 1e-9;
        if !lon.is_finite() || !lat.is_finite() || lon.abs() > 180.0 || lat.abs() > 90.0 {
            return Err(Error::new(
                "OSM PBF node has an invalid geographic coordinate.",
            ));
        }
        Ok((lon, lat))
    }

    pub fn for_each(&self, handler: &mut dyn Handler) -> Result<()> {
        for &(start, end) in &self.groups {
            let mut reader = Reader::new(&self.data[start..end]);
            while !reader.done() {
                let (tag, wire) = reader.field()?;
                match tag {
                    1 if handler.wants_nodes() => {
                        let node = self.read_node(reader.bytes()?)?;
                        handler.node(self, node)?;
                    }
                    2 if handler.wants_nodes() => {
                        let dense = self.read_dense(reader.bytes()?)?;
                        handler.dense_nodes(self, dense)?;
                    }
                    3 if handler.wants_ways() => {
                        let way = self.read_way(reader.bytes()?)?;
                        handler.way(self, way)?;
                    }
                    4 if handler.wants_relations() => {
                        let relation = self.read_relation(reader.bytes()?)?;
                        handler.relation(self, relation)?;
                    }
                    1..=4 => {
                        // The JavaScript reader decodes every entity it has a
                        // handler for; the others are skipped unvalidated.
                        reader.bytes()?;
                    }
                    _ => reader.skip(wire)?,
                }
            }
        }
        Ok(())
    }

    fn read_node(&self, bytes: &[u8]) -> Result<Node> {
        let mut budget = self.budget.get();
        if budget.nodes >= NODES_PER_BLOCK {
            return Err(Error::new(
                "OSM PBF primitive block exceeds the node limit.",
            ));
        }
        budget.nodes += 1;
        let mut node = Node {
            id: 0,
            lat: 0,
            lon: 0,
            keys: Vec::new(),
            vals: Vec::new(),
        };
        let mut reader = Reader::new(bytes);
        while !reader.done() {
            let (tag, wire) = reader.field()?;
            match tag {
                1 => node.id = reader.svarint()?,
                2 => reader.packed_u32(wire, &mut node.keys)?,
                3 => reader.packed_u32(wire, &mut node.vals)?,
                8 => node.lat = reader.svarint()?,
                9 => node.lon = reader.svarint()?,
                _ => reader.skip(wire)?,
            }
        }
        if node.keys.len() != node.vals.len() || budget.tags + node.keys.len() > TAGS_PER_BLOCK {
            return Err(Error::new(
                "OSM PBF node tags are inconsistent or exceed the tag limit.",
            ));
        }
        budget.tags += node.keys.len();
        self.budget.set(budget);
        Ok(node)
    }

    fn read_dense(&self, bytes: &[u8]) -> Result<DenseNodes> {
        if !self.dense_nodes_allowed {
            return Err(Error::new(
                "OSM PBF uses DenseNodes without declaring the required feature.",
            ));
        }
        let mut budget = self.budget.get();
        let mut dense = DenseNodes {
            ids: Vec::new(),
            lats: Vec::new(),
            lons: Vec::new(),
            keys_vals: Vec::new(),
            tag_offsets: Vec::new(),
        };
        let mut reader = Reader::new(bytes);
        while !reader.done() {
            let (tag, wire) = reader.field()?;
            match tag {
                1 => reader.packed_svarint(wire, &mut dense.ids)?,
                8 => reader.packed_svarint(wire, &mut dense.lats)?,
                9 => reader.packed_svarint(wire, &mut dense.lons)?,
                10 => reader.packed_u32(wire, &mut dense.keys_vals)?,
                _ => reader.skip(wire)?,
            }
        }
        let count = dense.ids.len();
        if count != dense.lats.len()
            || count != dense.lons.len()
            || budget.nodes + count > NODES_PER_BLOCK
        {
            return Err(Error::new(
                "OSM PBF dense-node arrays are inconsistent or exceed the node limit.",
            ));
        }
        budget.nodes += count;
        dense.tag_offsets = vec![0; count + 1];
        if !dense.keys_vals.is_empty() {
            let keys_vals = &dense.keys_vals;
            let mut offset = 0usize;
            for index in 0..count {
                while offset < keys_vals.len() && keys_vals[offset] != 0 {
                    budget.tags += 1;
                    if offset + 1 >= keys_vals.len() || budget.tags > TAGS_PER_BLOCK {
                        return Err(Error::new(
                            "OSM PBF dense-node tags are inconsistent or exceed the tag limit.",
                        ));
                    }
                    offset += 2;
                }
                if offset >= keys_vals.len() {
                    return Err(Error::new("OSM PBF dense-node tags lack a node delimiter."));
                }
                offset += 1;
                dense.tag_offsets[index + 1] = offset as u32;
            }
            if offset != keys_vals.len() {
                return Err(Error::new("OSM PBF dense-node tags exceed the node count."));
            }
        }
        let (mut id, mut lat, mut lon) = (0i64, 0i64, 0i64);
        for index in 0..count {
            id = id.wrapping_add(dense.ids[index]);
            lat = lat.wrapping_add(dense.lats[index]);
            lon = lon.wrapping_add(dense.lons[index]);
            dense.ids[index] = id;
            dense.lats[index] = lat;
            dense.lons[index] = lon;
        }
        self.budget.set(budget);
        Ok(dense)
    }

    fn read_way(&self, bytes: &[u8]) -> Result<Way> {
        let mut budget = self.budget.get();
        if budget.ways >= WAYS_PER_BLOCK {
            return Err(Error::new("OSM PBF primitive block exceeds the way limit."));
        }
        budget.ways += 1;
        let mut way = Way {
            id: 0,
            keys: Vec::new(),
            vals: Vec::new(),
            refs: Vec::new(),
        };
        let mut reader = Reader::new(bytes);
        while !reader.done() {
            let (tag, wire) = reader.field()?;
            match tag {
                1 => way.id = reader.varint()? as i64,
                2 => reader.packed_u32(wire, &mut way.keys)?,
                3 => reader.packed_u32(wire, &mut way.vals)?,
                8 => reader.packed_svarint(wire, &mut way.refs)?,
                _ => reader.skip(wire)?,
            }
        }
        if way.keys.len() != way.vals.len()
            || budget.tags + way.keys.len() > TAGS_PER_BLOCK
            || way.refs.len() > WAY_REFERENCES
        {
            return Err(Error::new(
                "OSM PBF way tags or references are inconsistent or exceed their limits.",
            ));
        }
        budget.tags += way.keys.len();
        let mut reference = 0i64;
        for value in &mut way.refs {
            reference = reference.wrapping_add(*value);
            *value = reference;
        }
        self.budget.set(budget);
        Ok(way)
    }

    fn read_relation(&self, bytes: &[u8]) -> Result<Relation> {
        let mut budget = self.budget.get();
        if budget.relations >= RELATIONS_PER_BLOCK {
            return Err(Error::new(
                "OSM PBF primitive block exceeds the relation limit.",
            ));
        }
        budget.relations += 1;
        let mut relation = Relation {
            id: 0,
            keys: Vec::new(),
            vals: Vec::new(),
            roles: Vec::new(),
            refs: Vec::new(),
            types: Vec::new(),
        };
        let mut reader = Reader::new(bytes);
        while !reader.done() {
            let (tag, wire) = reader.field()?;
            match tag {
                1 => relation.id = reader.varint()? as i64,
                2 => reader.packed_u32(wire, &mut relation.keys)?,
                3 => reader.packed_u32(wire, &mut relation.vals)?,
                8 => reader.packed_u32(wire, &mut relation.roles)?,
                9 => reader.packed_svarint(wire, &mut relation.refs)?,
                10 => reader.packed_u32(wire, &mut relation.types)?,
                _ => reader.skip(wire)?,
            }
        }
        if relation.keys.len() != relation.vals.len()
            || budget.tags + relation.keys.len() > TAGS_PER_BLOCK
            || relation.refs.len() > WAY_REFERENCES
            || relation.refs.len() != relation.roles.len()
            || relation.refs.len() != relation.types.len()
        {
            return Err(Error::new(
                "OSM PBF relation tags or members are inconsistent or exceed their limits.",
            ));
        }
        budget.tags += relation.keys.len();
        let mut reference = 0i64;
        for value in &mut relation.refs {
            reference = reference.wrapping_add(*value);
            *value = reference;
        }
        self.budget.set(budget);
        Ok(relation)
    }
}

/// Byte position after one blob, for progress reporting.
pub struct BlockProgress {
    pub bytes_read: u64,
    pub total_bytes: u64,
}

impl BlockProgress {
    pub fn fraction(&self) -> f64 {
        self.bytes_read as f64 / self.total_bytes as f64
    }
}

fn read_exact(file: &mut std::fs::File, buffer: &mut Vec<u8>, length: usize) -> Result<()> {
    buffer.clear();
    buffer.resize(length, 0);
    file.read_exact(buffer).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            Error::new("Unexpected end of OSM PBF.")
        } else {
            Error::from(error)
        }
    })
}

/// A blob read from the file, in file order.
struct RawBlob {
    seq: usize,
    kind: String,
    bytes: Vec<u8>,
    offset: u64,
}

enum Payload {
    Header(Vec<u8>),
    Data(Block),
    Other,
}

struct Decoded {
    seq: usize,
    kind: String,
    offset: u64,
    payload: Result<Payload>,
}

fn read_blob(
    file: &mut std::fs::File,
    hasher: &mut Sha256,
    offset: &mut u64,
    seq: usize,
) -> Result<RawBlob> {
    let mut buffer = Vec::new();
    read_exact(file, &mut buffer, 4)?;
    hasher.update(&buffer);
    let header_length = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
    if header_length == 0 || header_length > BLOB_HEADER_BYTES {
        return Err(Error::new(
            "OSM PBF BlobHeader length must be between 1 byte and 64 KiB.",
        ));
    }
    *offset += 4;
    read_exact(file, &mut buffer, header_length)?;
    hasher.update(&buffer);
    let (kind, data_size) = {
        let mut reader = Reader::new(&buffer);
        let mut kind = String::new();
        let mut data_size = 0u64;
        while !reader.done() {
            let (tag, wire) = reader.field()?;
            match tag {
                1 => kind = String::from_utf8_lossy(reader.bytes()?).into_owned(),
                3 => data_size = reader.varint()?,
                _ => reader.skip(wire)?,
            }
        }
        (kind, data_size)
    };
    if kind.is_empty() || data_size == 0 || data_size > BLOB_BYTES as u64 {
        return Err(Error::new(
            "OSM PBF BlobHeader has an invalid type or data size.",
        ));
    }
    *offset += header_length as u64;
    let mut bytes = Vec::new();
    read_exact(file, &mut bytes, data_size as usize)?;
    hasher.update(&bytes);
    *offset += data_size;
    Ok(RawBlob {
        seq,
        kind,
        bytes,
        offset: *offset,
    })
}

fn decode(raw: &RawBlob) -> Result<Payload> {
    let data = decode_blob(&raw.bytes, &raw.kind)?;
    Ok(match raw.kind.as_str() {
        "OSMHeader" => Payload::Header(data),
        "OSMData" => Payload::Data(Block::parse(data)?),
        _ => Payload::Other,
    })
}

/// One pass over the file, blocks delivered in file order.
/// Blobs are inflated and parsed on worker threads; callbacks, errors and
/// progress keep the sequential reader's order. Returns the SHA-256 of every
/// byte read, the source fingerprint the street compiler compares across passes.
pub fn for_each_block(
    path: &Path,
    on_block: &mut dyn FnMut(&Block) -> Result<()>,
    on_progress: &mut dyn FnMut(&BlockProgress) -> Result<()>,
) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    let workers = std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(2, 4);
    std::thread::scope(|scope| {
        let (raw_tx, raw_rx) = std::sync::mpsc::sync_channel::<Result<RawBlob>>(workers * 2);
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel::<(usize, Decoded)>(workers * 2);
        let reader = scope.spawn(move || {
            let mut hasher = Sha256::new();
            let mut offset = 0u64;
            let mut seq = 0usize;
            while offset < total {
                let blob = read_blob(&mut file, &mut hasher, &mut offset, seq);
                let failed = blob.is_err();
                if raw_tx.send(blob).is_err() || failed {
                    break;
                }
                seq += 1;
            }
            format!("{:x}", hasher.finalize())
        });
        let raw_rx = std::sync::Arc::new(std::sync::Mutex::new(raw_rx));
        for _ in 0..workers {
            let raw_rx = raw_rx.clone();
            let done_tx = done_tx.clone();
            scope.spawn(move || {
                loop {
                    let item = match raw_rx.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    let Ok(item) = item else { return };
                    let decoded = match item {
                        Ok(raw) => Decoded {
                            seq: raw.seq,
                            kind: raw.kind.clone(),
                            offset: raw.offset,
                            payload: decode(&raw),
                        },
                        // A read error ends the file after every blob read before it.
                        Err(error) => Decoded {
                            seq: usize::MAX,
                            kind: String::new(),
                            offset: 0,
                            payload: Err(error),
                        },
                    };
                    if done_tx.send((decoded.seq, decoded)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(done_tx);
        let mut pending: std::collections::BTreeMap<usize, Decoded> =
            std::collections::BTreeMap::new();
        let mut next = 0usize;
        let mut header_features: Option<Vec<String>> = None;
        let mut header_bounds: Option<Bounds> = None;
        let mut data_blocks = 0usize;
        let mut consume = |decoded: Decoded| -> Result<()> {
            let payload = decoded.payload?;
            match payload {
                Payload::Header(data) => {
                    if header_features.is_some() {
                        return Err(Error::new(
                            "OSM PBF contains more than one OSMHeader block.",
                        ));
                    }
                    let (required, bounds) = read_header_block(&data)?;
                    let unknown: Vec<&str> = required
                        .iter()
                        .filter(|feature| {
                            feature.as_str() != "OsmSchema-V0.6" && feature.as_str() != "DenseNodes"
                        })
                        .map(String::as_str)
                        .collect();
                    if !required.iter().any(|feature| feature == "OsmSchema-V0.6")
                        || !unknown.is_empty()
                    {
                        let listed = if unknown.is_empty() {
                            "missing OsmSchema-V0.6".to_owned()
                        } else {
                            unknown.join(", ")
                        };
                        return Err(Error::new(format!(
                            "OSM PBF declares unsupported required features: {listed}."
                        )));
                    }
                    header_features = Some(required);
                    header_bounds = bounds;
                }
                Payload::Data(mut block) => {
                    let Some(features) = header_features.as_ref() else {
                        return Err(Error::new("OSM PBF must contain OSMHeader before OSMData."));
                    };
                    data_blocks += 1;
                    block.dense_nodes_allowed = features.iter().any(|f| f == "DenseNodes");
                    block.bounds = header_bounds;
                    on_block(&block)?;
                }
                Payload::Other => {
                    return Err(Error::new(format!(
                        "OSM PBF contains unsupported block type {}.",
                        decoded.kind
                    )));
                }
            }
            on_progress(&BlockProgress {
                bytes_read: decoded.offset,
                total_bytes: total,
            })
        };
        let mut failure: Option<Error> = None;
        let mut read_error: Option<Error> = None;
        for (seq, decoded) in done_rx.iter() {
            if seq == usize::MAX {
                read_error = Some(
                    decoded
                        .payload
                        .err()
                        .unwrap_or_else(|| Error::new("OSM PBF read failed.")),
                );
                continue;
            }
            pending.insert(seq, decoded);
            while let Some(decoded) = pending.remove(&next) {
                next += 1;
                if let Err(error) = consume(decoded) {
                    failure = Some(error);
                    break;
                }
            }
            if failure.is_some() {
                break;
            }
        }
        drop(done_rx);
        let hash = reader
            .join()
            .map_err(|_| Error::new("OSM PBF reader thread failed."))?;
        if let Some(error) = failure {
            return Err(error);
        }
        // A read error follows every complete blob before it.
        if let Some(error) = read_error {
            return Err(error);
        }
        if header_features.is_none() || data_blocks == 0 {
            return Err(Error::new(
                "OSM PBF must contain one OSMHeader and at least one OSMData block.",
            ));
        }
        Ok(hash)
    })
}

fn read_header_block(data: &[u8]) -> Result<(Vec<String>, Option<Bounds>)> {
    let mut reader = Reader::new(data);
    let mut required = Vec::new();
    let mut bounds: [Option<f64>; 4] = [None; 4];
    let mut order: Vec<u8> = Vec::new();
    let mut saw_bounds = false;
    while !reader.done() {
        let (tag, wire) = reader.field()?;
        match tag {
            1 => {
                // Each bbox message is a new object in the JavaScript reader.
                saw_bounds = true;
                bounds = [None; 4];
                order.clear();
                let mut inner = Reader::new(reader.bytes()?);
                while !inner.done() {
                    let (field, field_wire) = inner.field()?;
                    if (1..=4).contains(&field) {
                        bounds[field as usize - 1] = Some(inner.svarint()? as f64 * 1e-9);
                        if !order.contains(&(field as u8)) {
                            order.push(field as u8);
                        }
                    } else {
                        inner.skip(field_wire)?;
                    }
                }
            }
            4 => required.push(String::from_utf8_lossy(reader.bytes()?).into_owned()),
            _ => reader.skip(wire)?,
        }
    }
    // Fields 1..4 are west, east, north and south.
    let bounds = match (saw_bounds, bounds) {
        (true, [Some(west), Some(east), Some(north), Some(south)])
            if west.is_finite() && east.is_finite() && north.is_finite() && south.is_finite() =>
        {
            Some(Bounds {
                west,
                east,
                north,
                south,
                order: [order[0], order[1], order[2], order[3]],
            })
        }
        _ => None,
    };
    Ok((required, bounds))
}

fn decode_blob(blob: &[u8], kind: &str) -> Result<Vec<u8>> {
    let mut reader = Reader::new(blob);
    let mut raw: Option<&[u8]> = None;
    let mut raw_size: Option<u64> = None;
    let mut zlib: Option<&[u8]> = None;
    let mut unsupported: Option<u32> = None;
    while !reader.done() {
        let (tag, wire) = reader.field()?;
        match tag {
            1 => raw = Some(reader.bytes()?),
            2 => raw_size = Some(reader.varint()?),
            3 => zlib = Some(reader.bytes()?),
            4..=7 => {
                unsupported = Some(tag);
                reader.bytes()?;
            }
            _ => reader.skip(wire)?,
        }
    }
    // A present bytes field is truthy in JavaScript even when empty.
    let representations = usize::from(raw.is_some())
        + usize::from(zlib.is_some())
        + usize::from(unsupported.is_some());
    if representations != 1 {
        return Err(Error::new(format!(
            "OSM PBF {kind} blob must contain exactly one data representation."
        )));
    }
    if let Some(field) = unsupported {
        return Err(Error::new(format!(
            "OSM PBF {kind} blob uses unsupported compression field {field}."
        )));
    }
    if let Some(raw) = raw {
        if raw.len() > BLOB_BYTES {
            return Err(Error::new(format!(
                "OSM PBF {kind} raw blob exceeds the 32 MiB limit."
            )));
        }
        if raw_size.is_some_and(|size| size != raw.len() as u64) {
            return Err(Error::new(format!(
                "OSM PBF {kind} raw_size does not match its raw payload."
            )));
        }
        return Ok(raw.to_vec());
    }
    let Some(size) = raw_size.filter(|size| *size <= BLOB_BYTES as u64) else {
        return Err(Error::new(format!(
            "OSM PBF {kind} zlib blob has an invalid raw_size."
        )));
    };
    let mut data = Vec::with_capacity(size as usize);
    let mut decoder =
        flate2::read::ZlibDecoder::new(zlib.unwrap_or_default()).take(BLOB_BYTES as u64 + 1);
    decoder.read_to_end(&mut data).map_err(|error| {
        Error::new(format!(
            "OSM PBF {kind} zlib decompression failed or exceeded 32 MiB: {error}"
        ))
    })?;
    if data.len() > BLOB_BYTES {
        return Err(Error::new(format!(
            "OSM PBF {kind} zlib decompression failed or exceeded 32 MiB: Cannot create a Buffer larger than 33554432 bytes"
        )));
    }
    if data.len() as u64 != size {
        return Err(Error::new(format!(
            "OSM PBF {kind} raw_size does not match the decompressed payload."
        )));
    }
    Ok(data)
}

#[cfg(test)]
impl Block {
    /// A block holding only a string table, for relation rule tests.
    pub fn with_strings(strings: &[&str]) -> Self {
        Self {
            strings: strings.iter().map(|value| (*value).to_owned()).collect(),
            groups: Vec::new(),
            data: Vec::new(),
            granularity: 100,
            lat_offset: 0,
            lon_offset: 0,
            dense_nodes_allowed: false,
            bounds: None,
            budget: std::cell::Cell::new(Budget::default()),
        }
    }
}
