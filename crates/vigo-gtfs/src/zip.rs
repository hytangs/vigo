//! Bounded GTFS ZIP admission and CSV streaming.
//!
//! Every recognized table is checked before import: entry names, types,
//! sizes and counts are bounded, and each table is verified against its
//! declared size and CRC-32 while it streams. CSV records follow the GTFS
//! reader the published compiler used: header names are trimmed, values are
//! not, and quoted records may span lines.

use crate::Error;
use crate::jsval;
use std::collections::{HashMap, HashSet};

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;
use vigo_format::js::Js;

type Result<T> = std::result::Result<T, Error>;

const EOCD_SIGNATURE: u32 = 0x06054b50;
const ZIP64_EOCD_SIGNATURE: u32 = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x07064b50;
const CENTRAL_ENTRY_SIGNATURE: u32 = 0x02014b50;
const LOCAL_ENTRY_SIGNATURE: u32 = 0x04034b50;
const LOCAL_ENTRY_HEADER_BYTES: u64 = 30;
const MAXIMUM_ZIP_COMMENT_BYTES: u64 = 65_535;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const RECOGNIZED_TABLES: &[&str] = &[
    "agency.txt",
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt",
    "calendar.txt",
    "calendar_dates.txt",
    "transfers.txt",
    "frequencies.txt",
    "shapes.txt",
    "pathways.txt",
    "location_groups.txt",
    "location_group_stops.txt",
    "locations.geojson",
    "booking_rules.txt",
    "fare_attributes.txt",
    "fare_rules.txt",
    "fare_products.txt",
    "fare_media.txt",
    "rider_categories.txt",
    "fare_leg_rules.txt",
    "fare_leg_join_rules.txt",
    "fare_transfer_rules.txt",
    "timeframes.txt",
    "areas.txt",
    "stop_areas.txt",
    "networks.txt",
    "route_networks.txt",
];

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_compressed_bytes: u64,
    pub max_entries: u64,
    pub max_central_directory_bytes: u64,
    pub max_selected_uncompressed_bytes: u64,
    pub max_single_table_uncompressed_bytes: u64,
    pub max_rows_per_table: u64,
    pub max_total_rows: u64,
    pub max_logical_record_bytes: u64,
    pub max_columns: u64,
    pub max_table_runtime_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_compressed_bytes: 1024 * 1024 * 1024,
            max_entries: 256,
            max_central_directory_bytes: 4 * 1024 * 1024,
            max_selected_uncompressed_bytes: 8 * 1024 * 1024 * 1024,
            max_single_table_uncompressed_bytes: 6 * 1024 * 1024 * 1024,
            max_rows_per_table: 100_000_000,
            max_total_rows: 150_000_000,
            max_logical_record_bytes: 1024 * 1024,
            max_columns: 256,
            max_table_runtime_ms: 30 * 60 * 1000,
        }
    }
}

fn format_bytes(value: u64) -> String {
    format!("{value} bytes")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryType {
    Regular,
    Symlink,
    Directory,
    NonRegular,
    Unknown,
}

impl EntryType {
    fn label(self) -> &'static str {
        match self {
            EntryType::Regular => "regular",
            EntryType::Symlink => "symlink",
            EntryType::Directory => "directory",
            EntryType::NonRegular => "non-regular",
            EntryType::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub crc32: u32,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub local_header_offset: u64,
    pub encrypted: bool,
    pub compression_method: u16,
    pub entry_type: EntryType,
}

/// An admitted GTFS archive and its selected tables.
pub struct Archive {
    pub zip_path: PathBuf,
    pub compressed_bytes: u64,
    pub selected_expanded_bytes: u64,
    pub entries: Vec<Entry>,
    pub limits: Limits,
    tables: HashMap<String, usize>,
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn safe_number(value: u64, field: &str) -> Result<u64> {
    if value > MAX_SAFE_INTEGER {
        return Err(Error::new(format!(
            "GTFS ZIP {field} exceeds the supported integer range."
        )));
    }
    Ok(value)
}

fn read_exactly(file: &mut File, length: u64, position: u64) -> Result<Vec<u8>> {
    let mut buffer = vec![0; length as usize];
    file.seek(SeekFrom::Start(position))?;
    let mut offset = 0;
    while offset < buffer.len() {
        let read = file.read(&mut buffer[offset..])?;
        if read == 0 {
            return Err(Error::new("GTFS ZIP ended before its declared metadata."));
        }
        offset += read;
    }
    Ok(buffer)
}

fn last_eocd_offset(tail: &[u8], tail_offset: u64, file_size: u64) -> Option<usize> {
    if tail.len() < 22 {
        return None;
    }
    (0..=tail.len() - 22).rev().find(|&offset| {
        u32_at(tail, offset) == EOCD_SIGNATURE
            && tail_offset + offset as u64 + 22 + u16_at(tail, offset + 20) as u64 == file_size
    })
}

struct Location {
    entry_count: u64,
    directory_bytes: u64,
    directory_offset: u64,
}

fn central_directory_location(
    file: &mut File,
    tail: &[u8],
    tail_offset: u64,
    eocd: usize,
) -> Result<Location> {
    let disk_number = u16_at(tail, eocd + 4);
    let directory_disk = u16_at(tail, eocd + 6);
    let entries_on_disk = u16_at(tail, eocd + 8);
    let entry_count = u16_at(tail, eocd + 10);
    let directory_bytes = u32_at(tail, eocd + 12);
    let directory_offset = u32_at(tail, eocd + 16);
    if disk_number != 0 || directory_disk != 0 || entries_on_disk != entry_count {
        return Err(Error::new("Multi-disk GTFS ZIP archives are unsupported."));
    }
    if entry_count != 0xffff && directory_bytes != 0xffffffff && directory_offset != 0xffffffff {
        return Ok(Location {
            entry_count: entry_count as u64,
            directory_bytes: directory_bytes as u64,
            directory_offset: directory_offset as u64,
        });
    }
    let absolute_eocd = tail_offset + eocd as u64;
    if absolute_eocd < 20 {
        return Err(Error::new("GTFS ZIP64 locator is missing."));
    }
    let locator = read_exactly(file, 20, absolute_eocd - 20)?;
    if u32_at(&locator, 0) != ZIP64_LOCATOR_SIGNATURE {
        return Err(Error::new("GTFS ZIP64 locator is missing."));
    }
    if u32_at(&locator, 4) != 0 || u32_at(&locator, 16) != 1 {
        return Err(Error::new(
            "Multi-disk GTFS ZIP64 archives are unsupported.",
        ));
    }
    let record_offset = safe_number(u64_at(&locator, 8), "ZIP64 record offset")?;
    let record = read_exactly(file, 56, record_offset)?;
    if u32_at(&record, 0) != ZIP64_EOCD_SIGNATURE {
        return Err(Error::new("GTFS ZIP64 end record is malformed."));
    }
    if u32_at(&record, 16) != 0 || u32_at(&record, 20) != 0 {
        return Err(Error::new(
            "Multi-disk GTFS ZIP64 archives are unsupported.",
        ));
    }
    let entries_on_zip64_disk = safe_number(u64_at(&record, 24), "entry count")?;
    let zip64_entry_count = safe_number(u64_at(&record, 32), "entry count")?;
    if entries_on_zip64_disk != zip64_entry_count {
        return Err(Error::new(
            "Multi-disk GTFS ZIP64 archives are unsupported.",
        ));
    }
    Ok(Location {
        entry_count: zip64_entry_count,
        directory_bytes: safe_number(u64_at(&record, 40), "central-directory size")?,
        directory_offset: safe_number(u64_at(&record, 48), "central-directory offset")?,
    })
}

fn zip64_entry_values(extra: &[u8], raw: (u64, u64, u64)) -> Result<(u64, u64, u64)> {
    let (mut uncompressed, mut compressed, mut local) = raw;
    let mut offset = 0;
    while offset + 4 <= extra.len() {
        let field_id = u16_at(extra, offset);
        let field_length = u16_at(extra, offset + 2) as usize;
        offset += 4;
        if offset + field_length > extra.len() {
            return Err(Error::new(
                "GTFS ZIP central-directory extra field is malformed.",
            ));
        }
        if field_id == 0x0001 {
            let field = &extra[offset..offset + field_length];
            let mut value_offset = 0;
            let mut take = |name: &str| -> Result<u64> {
                if value_offset + 8 > field.len() {
                    return Err(Error::new("GTFS ZIP64 entry metadata is incomplete."));
                }
                let value = safe_number(u64_at(field, value_offset), name)?;
                value_offset += 8;
                Ok(value)
            };
            if raw.0 == 0xffffffff {
                uncompressed = take("uncompressedBytes")?;
            }
            if raw.1 == 0xffffffff {
                compressed = take("compressedBytes")?;
            }
            if raw.2 == 0xffffffff {
                local = take("localHeaderOffset")?;
            }
            return Ok((uncompressed, compressed, local));
        }
        offset += field_length;
    }
    if raw.0 == 0xffffffff || raw.1 == 0xffffffff || raw.2 == 0xffffffff {
        return Err(Error::new("GTFS ZIP64 entry metadata is missing."));
    }
    Ok(raw)
}

fn decode_entry_name(bytes: &[u8], utf8: bool) -> Result<String> {
    if !utf8 {
        return Ok(bytes.iter().map(|b| *b as char).collect());
    }
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| Error::new("GTFS ZIP contains an invalid UTF-8 entry name."))
}

fn central_entry_type(version_made_by: u16, external: u32, name: &str) -> EntryType {
    let host = version_made_by >> 8;
    if host == 3 || host == 19 {
        match (external >> 16) & 0xf000 {
            0x8000 => return EntryType::Regular,
            0xa000 => return EntryType::Symlink,
            0x4000 => return EntryType::Directory,
            0 => {}
            _ => return EntryType::NonRegular,
        }
    }
    if name.ends_with('/') || external & 0x10 != 0 {
        EntryType::Directory
    } else {
        EntryType::Unknown
    }
}

fn parse_central_directory(buffer: &[u8], expected: u64) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut offset = 0;
    while offset < buffer.len() {
        if offset + 46 > buffer.len() || u32_at(buffer, offset) != CENTRAL_ENTRY_SIGNATURE {
            return Err(Error::new("GTFS ZIP central directory is malformed."));
        }
        let flags = u16_at(buffer, offset + 8);
        let method = u16_at(buffer, offset + 10);
        let version_made_by = u16_at(buffer, offset + 4);
        let external = u32_at(buffer, offset + 38);
        let name_length = u16_at(buffer, offset + 28) as usize;
        let extra_length = u16_at(buffer, offset + 30) as usize;
        let comment_length = u16_at(buffer, offset + 32) as usize;
        let entry_length = 46 + name_length + extra_length + comment_length;
        if offset + entry_length > buffer.len() {
            return Err(Error::new("GTFS ZIP central-directory entry is truncated."));
        }
        let name_bytes = &buffer[offset + 46..offset + 46 + name_length];
        let extra = &buffer[offset + 46 + name_length..offset + 46 + name_length + extra_length];
        let raw = (
            u32_at(buffer, offset + 24) as u64,
            u32_at(buffer, offset + 20) as u64,
            u32_at(buffer, offset + 42) as u64,
        );
        let (uncompressed, compressed, local) = zip64_entry_values(extra, raw)?;
        let name = decode_entry_name(name_bytes, flags & 0x0800 != 0)?;
        let entry_type = central_entry_type(version_made_by, external, &name);
        entries.push(Entry {
            name,
            crc32: u32_at(buffer, offset + 16),
            compressed_bytes: compressed,
            uncompressed_bytes: uncompressed,
            local_header_offset: local,
            encrypted: flags & 0x0001 != 0,
            compression_method: method,
            entry_type,
        });
        offset += entry_length;
    }
    if entries.len() as u64 != expected {
        return Err(Error::new(format!(
            "GTFS ZIP entry-count mismatch: expected {expected}, found {}.",
            entries.len()
        )));
    }
    Ok(entries)
}

/// The lower-cased basename when it names a recognized GTFS table.
pub fn selected_table_name(entry_name: &str) -> Option<String> {
    // path.posix.basename ignores trailing separators.
    let trimmed = entry_name.trim_end_matches('/');
    let base = trimmed.rsplit('/').next().unwrap_or(trimmed).to_lowercase();
    RECOGNIZED_TABLES.contains(&base.as_str()).then_some(base)
}

fn safe_selected_entry_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') || name.starts_with('-') || name.contains('\\') {
        return false;
    }
    if name.chars().any(|c| {
        let code = c as u32;
        code <= 0x1f || (0x7f..=0x9f).contains(&code) || matches!(c, '*' | '?' | '[' | ']')
    }) {
        return false;
    }
    name.split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

impl Archive {
    pub fn inspect(zip_path: &Path) -> Result<Archive> {
        Self::inspect_with(zip_path, Limits::default())
    }

    pub fn inspect_with(zip_path: &Path, limits: Limits) -> Result<Archive> {
        let resolved = resolve(zip_path);
        let stats = std::fs::symlink_metadata(&resolved)?;
        if !stats.is_file() {
            return Err(Error::new("The selected GTFS path is not a regular file."));
        }
        let size = stats.len();
        if size > limits.max_compressed_bytes {
            return Err(Error::new(format!(
                "GTFS ZIP exceeds the compressed-size limit ({}).",
                format_bytes(limits.max_compressed_bytes)
            )));
        }
        if size < 22 {
            return Err(Error::new(
                "GTFS ZIP is too small to contain an end record.",
            ));
        }
        let mut file = File::open(&resolved)?;
        let tail_length = size.min(22 + MAXIMUM_ZIP_COMMENT_BYTES + 20 + 56);
        let tail_offset = size - tail_length;
        let tail = read_exactly(&mut file, tail_length, tail_offset)?;
        let eocd = last_eocd_offset(&tail, tail_offset, size)
            .ok_or_else(|| Error::new("GTFS ZIP end record is missing or malformed."))?;
        let location = central_directory_location(&mut file, &tail, tail_offset, eocd)?;
        if location.entry_count > limits.max_entries {
            return Err(Error::new(format!(
                "GTFS ZIP exceeds the entry-count limit ({} entries).",
                limits.max_entries
            )));
        }
        if location.directory_bytes > limits.max_central_directory_bytes {
            return Err(Error::new(format!(
                "GTFS ZIP exceeds the central-directory limit ({}).",
                format_bytes(limits.max_central_directory_bytes)
            )));
        }
        if location.directory_offset + location.directory_bytes > size {
            return Err(Error::new("GTFS ZIP central-directory bounds are invalid."));
        }
        let directory = read_exactly(
            &mut file,
            location.directory_bytes,
            location.directory_offset,
        )?;
        let entries = parse_central_directory(&directory, location.entry_count)?;
        let mut tables = HashMap::new();
        let mut selected = 0u64;
        for (index, entry) in entries.iter().enumerate() {
            let Some(table) = selected_table_name(&entry.name) else {
                continue;
            };
            if !safe_selected_entry_name(&entry.name) {
                return Err(Error::new(format!(
                    "Unsafe GTFS ZIP entry name for {table}."
                )));
            }
            if entry.encrypted {
                return Err(Error::new(format!(
                    "Encrypted GTFS ZIP entry is unsupported: {table}."
                )));
            }
            if !matches!(entry.entry_type, EntryType::Regular | EntryType::Unknown) {
                return Err(Error::new(format!(
                    "Non-regular GTFS ZIP entry is unsupported: {table} ({}).",
                    entry.entry_type.label()
                )));
            }
            if tables.contains_key(&table) {
                return Err(Error::new(format!(
                    "Duplicate GTFS table basename: {table}."
                )));
            }
            if entry.uncompressed_bytes > limits.max_single_table_uncompressed_bytes {
                return Err(Error::new(format!(
                    "GTFS {table} exceeds the single-table expanded-size limit ({}).",
                    format_bytes(limits.max_single_table_uncompressed_bytes)
                )));
            }
            selected += entry.uncompressed_bytes;
            if selected > limits.max_selected_uncompressed_bytes {
                return Err(Error::new(format!(
                    "GTFS ZIP exceeds the selected expanded-size limit ({}).",
                    format_bytes(limits.max_selected_uncompressed_bytes)
                )));
            }
            tables.insert(table, index);
        }
        Ok(Archive {
            zip_path: resolved,
            compressed_bytes: size,
            selected_expanded_bytes: selected,
            entries,
            limits,
            tables,
        })
    }

    /// `gtfsTableEntry(archive, name)`.
    pub fn table(&self, name: &str) -> Option<&Entry> {
        self.tables
            .get(&name.to_lowercase())
            .map(|i| &self.entries[*i])
    }

    fn data_offset(&self, entry: &Entry) -> Result<u64> {
        let mut file = File::open(&self.zip_path)?;
        let header = read_exactly(
            &mut file,
            LOCAL_ENTRY_HEADER_BYTES,
            entry.local_header_offset,
        )?;
        if u32_at(&header, 0) != LOCAL_ENTRY_SIGNATURE {
            return Err(Error::new(format!(
                "GTFS {} has a malformed local ZIP header.",
                entry.name
            )));
        }
        let data = entry.local_header_offset
            + LOCAL_ENTRY_HEADER_BYTES
            + u16_at(&header, 26) as u64
            + u16_at(&header, 28) as u64;
        if data + entry.compressed_bytes > self.compressed_bytes {
            return Err(Error::new(format!(
                "GTFS {} exceeds its ZIP data bounds.",
                entry.name
            )));
        }
        Ok(data)
    }

    fn open_entry(&self, entry: &Entry) -> Result<Box<dyn Read + Send>> {
        if ![0, 8].contains(&entry.compression_method) {
            return Err(Error::new(format!(
                "GTFS {} uses unsupported ZIP compression method {}.",
                entry.name, entry.compression_method
            )));
        }
        let offset = self.data_offset(entry)?;
        if entry.compressed_bytes == 0 {
            return Ok(Box::new(std::io::empty()));
        }
        let mut file = File::open(&self.zip_path)?;
        file.seek(SeekFrom::Start(offset))?;
        let raw = BufReader::with_capacity(64 * 1024, file).take(entry.compressed_bytes);
        Ok(if entry.compression_method == 8 {
            Box::new(flate2::read::DeflateDecoder::new_with_buf(
                raw,
                vec![0; 64 * 1024],
            ))
        } else {
            Box::new(raw)
        })
    }

    /// `readGtfsZipJson`: a bounded, CRC-checked JSON entry.
    pub fn read_json(&self, entry: &Entry, maximum_bytes: u64) -> Result<Js> {
        let admitted = entry
            .name
            .rsplit('/')
            .next()
            .and_then(|base| self.table(base));
        if !admitted.is_some_and(|e| std::ptr::eq(e, entry))
            || entry.uncompressed_bytes > maximum_bytes
        {
            return Err(Error::new("GTFS JSON entry exceeds admission limits"));
        }
        let mut source = self.open_entry(entry)?;
        let started = Instant::now();
        let mut bytes = Vec::new();
        let mut crc = flate2::Crc::new();
        let mut chunk = vec![0; 64 * 1024];
        loop {
            let read = source.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            if started.elapsed().as_millis() > 30_000 {
                return Err(Error::new("GTFS JSON extraction timed out"));
            }
            if (bytes.len() + read) as u64 > maximum_bytes
                || (bytes.len() + read) as u64 > entry.uncompressed_bytes
            {
                return Err(Error::new("GTFS JSON expanded size exceeds limits"));
            }
            crc.update(&chunk[..read]);
            bytes.extend_from_slice(&chunk[..read]);
        }
        if bytes.len() as u64 != entry.uncompressed_bytes || crc.sum() != entry.crc32 {
            return Err(Error::new("GTFS JSON size or CRC32 mismatch"));
        }
        // TextDecoder drops one leading byte-order mark.
        let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        let text = std::str::from_utf8(body)
            .map_err(|_| Error::new("The encoded data was not valid for encoding utf-8"))?;
        jsval::parse_json(text).map_err(Error::new)
    }
}

/// Shared row budget for one feed import.
#[derive(Default, Debug)]
pub struct Budget {
    pub total_rows: u64,
}

/// CSV header names, trimmed, with their positions.
pub struct Header {
    pub names: Vec<String>,
}

impl Header {
    /// A short linear scan: GTFS tables have few columns and lookups are hot.
    pub fn position(&self, name: &str) -> Option<usize> {
        self.names.iter().position(|header| header == name)
    }
}

/// One CSV record as a JavaScript object of strings; absent fields are `undefined`.
pub struct Row<'h> {
    pub header: &'h Header,
    pub values: Vec<String>,
}

impl Row<'_> {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.header.position(name).map(|i| self.values[i].as_str())
    }
    pub fn has(&self, name: &str) -> bool {
        self.header.position(name).is_some()
    }
    pub fn set(&mut self, name: &str, value: String) {
        if let Some(i) = self.header.position(name) {
            self.values[i] = value;
        }
    }
    /// Fields in JavaScript object key order.
    pub fn keys(&self) -> Vec<&str> {
        let mut indices: Vec<&str> = Vec::new();
        let mut rest = Vec::new();
        for name in &self.header.names {
            if jsval::array_index(name).is_some() {
                indices.push(name);
            } else {
                rest.push(name.as_str());
            }
        }
        indices.sort_by_key(|name| jsval::array_index(name));
        indices.extend(rest);
        indices
    }
}

/// Field names and record count of one streamed table.
pub struct TableProfile {
    pub fields: Vec<String>,
    pub rows: u64,
}

fn complete_csv_record(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut quoted = false;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            if quoted && bytes.get(index + 1) == Some(&b'"') {
                index += 1;
            } else {
                quoted = !quoted;
            }
        }
        index += 1;
    }
    !quoted
}

fn csv_fields(record: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut value = String::new();
    let mut quoted = false;
    let mut chars = record.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if quoted && chars.peek() == Some(&'"') {
                value.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if c == ',' && !quoted {
            fields.push(std::mem::take(&mut value));
        } else {
            value.push(c);
        }
    }
    fields.push(value);
    fields
}

fn validate_headers(table: &str, values: Vec<String>, limits: &Limits) -> Result<Header> {
    let names: Vec<String> = values.iter().map(|v| jsval::trim(v).to_owned()).collect();
    if names.len() as u64 > limits.max_columns {
        return Err(Error::new(format!(
            "GTFS {table} exceeds the column limit ({} columns).",
            limits.max_columns
        )));
    }
    if names.iter().any(String::is_empty) {
        return Err(Error::new(format!(
            "GTFS {table} contains an empty CSV header name."
        )));
    }
    let mut observed = HashSet::new();
    for name in &names {
        if !observed.insert(name.to_lowercase()) {
            return Err(Error::new(format!(
                "GTFS {table} contains a duplicate CSV header: {name}."
            )));
        }
    }
    Ok(Header { names })
}

/// Stream one admitted CSV table. `on_progress` receives the row count at
/// most every 200 ms and when the table completes.
pub fn stream_csv(
    archive: &Archive,
    entry: &Entry,
    budget: &mut Budget,
    mut on_progress: Option<&mut dyn FnMut(u64, u64)>,
    on_row: &mut dyn FnMut(&mut Row) -> Result<()>,
) -> Result<TableProfile> {
    let limits = archive.limits;
    let Some(table) = selected_table_name(&entry.name) else {
        return Err(Error::new(
            "GTFS ZIP table descriptor was not admitted by preflight.",
        ));
    };
    if !archive
        .table(&table)
        .is_some_and(|e| std::ptr::eq(e, entry))
    {
        return Err(Error::new(
            "GTFS ZIP table descriptor was not admitted by preflight.",
        ));
    }
    if entry.uncompressed_bytes > limits.max_single_table_uncompressed_bytes {
        return Err(Error::new(format!(
            "GTFS {table} exceeds the single-table expanded-size limit ({}).",
            format_bytes(limits.max_single_table_uncompressed_bytes)
        )));
    }
    let source = archive.open_entry(entry)?;
    let started = Instant::now();
    let mut last_progress: Option<Instant> = None;
    let mut crc = flate2::Crc::new();
    let mut expanded = 0u64;
    let mut line_buffer: Vec<u8> = Vec::new();
    let mut pending = String::new();
    let mut header: Option<Header> = None;
    let mut rows = 0u64;
    let mut stream_start = true;
    let record_limit = limits.max_logical_record_bytes;
    let too_long = || {
        Error::new(format!(
            "GTFS {table} exceeds the logical-record limit ({}).",
            format_bytes(record_limit)
        ))
    };

    let mut buffer: Vec<String> = Vec::new();
    // Returns the parsed record once a quoted record is complete.
    let mut consume_line = |line: &[u8],
                            pending: &mut String,
                            header: &mut Option<Header>,
                            rows: &mut u64,
                            budget: &mut Budget|
     -> Result<()> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let line = std::str::from_utf8(line)
            .map_err(|_| Error::new(format!("GTFS {table} is not valid UTF-8.")))?;
        if pending.is_empty() {
            pending.push_str(line);
        } else {
            pending.push('\n');
            pending.push_str(line);
        }
        if pending.len() as u64 > record_limit {
            return Err(too_long());
        }
        let quoted = pending.as_bytes().contains(&b'"');
        if quoted && !complete_csv_record(pending) {
            return Ok(());
        }
        let record = std::mem::take(pending);
        let Some(names) = header.as_ref() else {
            let record = record.strip_prefix('\u{FEFF}').unwrap_or(&record);
            let values = if quoted {
                csv_fields(record)
            } else {
                record.split(',').map(str::to_owned).collect()
            };
            *header = Some(validate_headers(&table, values, &limits)?);
            return Ok(());
        };
        // Reuse each field's allocation from the previous record.
        let mut values = std::mem::take(&mut buffer);
        let mut count = 0;
        let mut fill = |field: &str| {
            if count < values.len() {
                values[count].clear();
                values[count].push_str(field);
            } else {
                values.push(field.to_owned());
            }
            count += 1;
        };
        if quoted {
            for field in csv_fields(&record) {
                fill(&field);
            }
        } else {
            // Fields are short: a byte scan beats a searcher per field.
            let mut start = 0;
            for (index, byte) in record.bytes().enumerate() {
                if byte == b',' {
                    fill(&record[start..index]);
                    start = index + 1;
                }
            }
            fill(&record[start..]);
        }
        if count > names.names.len() {
            return Err(Error::new(format!(
                "GTFS {table} row has {} columns but its header has {}.",
                count,
                names.names.len()
            )));
        }
        for value in values.iter_mut().skip(count) {
            value.clear();
        }
        if *rows + 1 > limits.max_rows_per_table {
            return Err(Error::new(format!(
                "GTFS {table} exceeds the row limit ({} rows).",
                limits.max_rows_per_table
            )));
        }
        if budget.total_rows + 1 > limits.max_total_rows {
            return Err(Error::new(format!(
                "GTFS ZIP exceeds the total-row limit ({} rows).",
                limits.max_total_rows
            )));
        }
        values.resize(names.names.len(), String::new());
        let mut row = Row {
            header: names,
            values,
        };
        let outcome = on_row(&mut row);
        buffer = row.values;
        outcome?;
        *rows += 1;
        budget.total_rows += 1;
        Ok(())
    };

    // Inflate on a second thread, as the published reader did on the I/O
    // pool, so decompression overlaps parsing and SQLite writes.
    std::thread::scope(|scope| -> Result<TableProfile> {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<std::io::Result<Vec<u8>>>(8);
        scope.spawn(move || {
            let mut source = source;
            loop {
                let mut chunk = vec![0u8; 256 * 1024];
                match source.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        chunk.truncate(read);
                        if sender.send(Ok(chunk)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        for message in receiver {
            let chunk = message.map_err(|error| Error::new(error.to_string()))?;
            let read = chunk.len();
            expanded += read as u64;
            if expanded > entry.uncompressed_bytes
                || expanded > limits.max_single_table_uncompressed_bytes
            {
                return Err(Error::new(format!(
                    "GTFS {table} exceeds its declared or permitted expanded size."
                )));
            }
            crc.update(&chunk);
            let mut data = &chunk[..];
            if stream_start {
                stream_start = false;
                line_buffer.extend_from_slice(data);
                data = &[];
                if line_buffer.len() >= 3 || read == 0 {
                    if line_buffer.starts_with(b"\xEF\xBB\xBF") {
                        line_buffer.drain(..3);
                    }
                } else {
                    stream_start = true;
                }
            }
            line_buffer.extend_from_slice(data);
            let mut start = 0;
            if !stream_start {
                while let Some(position) = line_buffer[start..].iter().position(|b| *b == b'\n') {
                    let end = start + position;
                    consume_line(
                        &line_buffer[start..end],
                        &mut pending,
                        &mut header,
                        &mut rows,
                        budget,
                    )?;
                    start = end + 1;
                }
                line_buffer.drain(..start);
                let open = if pending.is_empty() {
                    line_buffer.len()
                } else {
                    pending.len() + 1 + line_buffer.len()
                };
                if open as u64 > record_limit {
                    return Err(too_long());
                }
            }
            if started.elapsed().as_millis() as u64 > limits.max_table_runtime_ms {
                return Err(Error::new(format!(
                    "GTFS {table} extraction exceeded {} ms.",
                    limits.max_table_runtime_ms
                )));
            }
            if let Some(callback) = on_progress.as_deref_mut()
                && (last_progress.is_none_or(|at| at.elapsed().as_millis() >= 200)
                    || expanded == entry.uncompressed_bytes)
            {
                last_progress = Some(Instant::now());
                callback(rows, expanded);
            }
        }
        if stream_start && line_buffer.starts_with(b"\xEF\xBB\xBF") {
            line_buffer.drain(..3);
        }
        // A truncated multi-byte sequence fails decoding before the last record.
        if std::str::from_utf8(&line_buffer).is_err() {
            return Err(Error::new(format!("GTFS {table} is not valid UTF-8.")));
        }
        if !line_buffer.is_empty() {
            let line = std::mem::take(&mut line_buffer);
            consume_line(&line, &mut pending, &mut header, &mut rows, budget)?;
        }
        if !pending.is_empty() {
            return Err(Error::new(format!(
                "GTFS {table} ended inside a quoted CSV record."
            )));
        }
        if expanded != entry.uncompressed_bytes {
            return Err(Error::new(format!(
                "GTFS {table} expanded-size metadata does not match extracted bytes."
            )));
        }
        if crc.sum() != entry.crc32 {
            return Err(Error::new(format!(
                "GTFS {table} CRC32 does not match its ZIP metadata."
            )));
        }
        let Some(header) = header else {
            return Err(Error::new(format!("GTFS {table} is missing a CSV header.")));
        };
        Ok(TableProfile {
            fields: header.names,
            rows,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_records_follow_the_published_reader() {
        assert!(complete_csv_record("a,\"b\"\"c\",d"));
        assert!(!complete_csv_record("a,\"b"));
        assert_eq!(csv_fields("a,\"b,\"\"c\"\"\",d"), ["a", "b,\"c\"", "d"]);
        // Quotes toggle anywhere in a field, not only at its start.
        assert_eq!(csv_fields("x\"y,z\",w"), ["xy,z", "w"]);
        assert_eq!(
            selected_table_name("feed/Stops.TXT"),
            Some("stops.txt".into())
        );
        assert_eq!(selected_table_name("stops.txt/"), Some("stops.txt".into()));
        assert!(!safe_selected_entry_name("stops.txt/"));
        assert!(!safe_selected_entry_name("../stops.txt"));
        assert!(safe_selected_entry_name("gtfs/stops.txt"));
    }
}
