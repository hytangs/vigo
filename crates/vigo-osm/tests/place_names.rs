//! Place-name backfill safety on the permanent 0.5.0 fixture PBF. Progress
//! callbacks run inside the PBF passes here, so a source change between the
//! passes and a cancellation during one are exact.
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use vigo_osm::{Error, Progress, StreetOptions, backfill_place_names, build_street_store};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/format-0.5.0/fixture.osm.pbf")
}

fn scratch(name: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("vigo-osm-places-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

fn street_store(directory: &Path) -> PathBuf {
    let store = directory.join("street-index.sqlite");
    build_street_store(&fixture(), &store, &StreetOptions::default(), &mut |_| {}).unwrap();
    store
}

fn digest(path: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
}

fn varint(bytes: &[u8], index: &mut usize) -> u64 {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = bytes[*index];
        *index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            break;
        }
    }
    value
}

/// One framed blob's length: the 4-byte BlobHeader length, the BlobHeader
/// and the Blob its `datasize` names.
fn blob_length(bytes: &[u8]) -> usize {
    let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    let header = &bytes[4..4 + length];
    let (mut index, mut data_size) = (0, 0);
    while index < header.len() {
        let key = header[index];
        index += 1;
        let value = varint(header, &mut index) as usize;
        match key {
            // BlobHeader.datasize
            0x18 => data_size = value,
            // type and indexdata are length-delimited.
            _ => index += value,
        }
    }
    4 + length + data_size
}

/// The fixture with its first data block repeated: a valid PBF with
/// another fingerprint.
fn another_source(source: &Path, target: &Path) {
    let mut bytes = std::fs::read(source).unwrap();
    let header = blob_length(&bytes);
    let data = bytes[header..header + blob_length(&bytes[header..])].to_vec();
    bytes.extend_from_slice(&data);
    std::fs::write(target, bytes).unwrap();
}

#[test]
fn a_source_changed_between_passes_leaves_the_city_unchanged() {
    let directory = scratch("changed");
    let store = street_store(&directory);
    let source = directory.join("source.osm.pbf");
    std::fs::copy(fixture(), &source).unwrap();
    let before = digest(&store);
    let error = backfill_place_names(&store, &source, &mut |p: &Progress| {
        if p.phase == "Selecting named ways" && p.progress == 1.0 {
            another_source(&fixture(), &source);
        }
        Ok(())
    })
    .unwrap_err();
    assert!(
        error.to_string().contains("fingerprint does not match"),
        "{error}"
    );
    assert_eq!(digest(&store), before);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn cancellation_during_a_pass_leaves_the_city_unchanged() {
    let directory = scratch("cancelled");
    let store = street_store(&directory);
    let before = digest(&store);
    let error = backfill_place_names(&store, &fixture(), &mut |p: &Progress| {
        if p.phase == "Resolving named-way geometry" {
            return Err(Error::new("cancelled"));
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "cancelled");
    assert_eq!(digest(&store), before);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_complete_index_is_left_as_it_is() {
    let directory = scratch("complete");
    let store = street_store(&directory);
    let mut phases = Vec::new();
    let built = backfill_place_names(&store, &fixture(), &mut |p: &Progress| {
        phases.push(p.phase.to_owned());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        built.get("built").map(|v| v.stringify()),
        Some("true".into())
    );
    assert_eq!(
        built.get("schemaVersion").and_then(|v| v.as_str()),
        Some(vigo_osm::PLACE_NAMES_SCHEMA_VERSION)
    );
    assert!(phases.contains(&"Publishing place names".to_owned()));
    let completed = digest(&store);
    let again = backfill_place_names(&store, &fixture(), &mut |_| {
        panic!("a complete index reads no PBF")
    })
    .unwrap();
    assert_eq!(
        again.get("built").map(|v| v.stringify()),
        Some("false".into())
    );
    assert_eq!(digest(&store), completed);
    std::fs::remove_dir_all(directory).unwrap();
}
