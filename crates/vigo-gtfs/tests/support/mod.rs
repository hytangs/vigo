//! Minimal ZIP fixtures for GTFS tests: stored or deflated entries, with an
//! optional Unix mode, laid out like the JSZip archives the JavaScript tests
//! wrote (local headers, then the central directory and its end record).
#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Entry<'a> {
    pub name: &'a str,
    pub content: &'a [u8],
    /// `Some(mode)` writes a Unix "version made by" and `mode << 16`.
    pub unix_mode: Option<u32>,
}

pub fn entry<'a>(name: &'a str, content: &'a [u8]) -> Entry<'a> {
    Entry {
        name,
        content,
        unix_mode: None,
    }
}

pub fn zip_bytes(entries: &[Entry], deflate: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for entry in entries {
        let mut crc = flate2::Crc::new();
        crc.update(entry.content);
        let data = if deflate {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(entry.content).unwrap();
            encoder.finish().unwrap()
        } else {
            entry.content.to_vec()
        };
        let method: u16 = if deflate { 8 } else { 0 };
        let offset = out.len() as u32;
        let name = entry.name.as_bytes();
        out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&crc.sum().to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(entry.content.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&data);
        let (made_by, external) = match entry.unix_mode {
            Some(mode) => (0x0314u16, mode << 16),
            None => (0x0014u16, 0u32),
        };
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&made_by.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&crc.sum().to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(entry.content.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&external.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let directory_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&directory_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// A fresh scratch directory for one test.
pub fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("vigo-gtfs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

pub fn write_zip(directory: &Path, name: &str, entries: &[Entry]) -> PathBuf {
    let path = directory.join(name);
    std::fs::write(&path, zip_bytes(entries, true)).unwrap();
    path
}
