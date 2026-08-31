use crate::snapshot_validation::checked_array_byte_range;
use crate::street_snapshot::{HEADER_BYTES, Snapshot};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn rejects_array_byte_length_overflow() {
    assert!(checked_array_byte_range(0, usize::MAX, 8).is_none());
}

#[test]
fn rejects_array_end_offset_overflow() {
    assert!(checked_array_byte_range(usize::MAX, 2, 1).is_none());
}

#[test]
fn preserves_valid_array_byte_range() {
    assert_eq!(checked_array_byte_range(4096, 3, 8), Some(4096..4120));
}

#[test]
fn rejects_snapshot_header_with_overflowing_array_end() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "vigo-overflowing-snapshot-{}-{unique}.bin",
        std::process::id()
    ));
    let header = serde_json::json!({
        "magic": "vigo.street.accelerator",
        "version": 7,
        "nodeCount": 0,
        "edgeCount": 0,
        "spatialMinLat": 0.0,
        "spatialMinLon": 0.0,
        "spatialCellDegrees": 0.01,
        "spatialRows": 0,
        "spatialColumns": 0,
        "spatialNodeOrder": "cell_then_source_node_id",
        "arrays": {
            "reciprocalEdgeFlags": {
                "type": "Uint8Array",
                "offset": usize::MAX,
                "length": 2
            }
        }
    });
    let encoded = serde_json::to_vec(&header).expect("test header must serialize");
    assert!(encoded.len() < HEADER_BYTES);
    let mut contents = vec![b' '; HEADER_BYTES];
    contents[..encoded.len()].copy_from_slice(&encoded);
    fs::write(&path, contents).expect("test snapshot must be writable");

    let result = Snapshot::open(path.to_str().expect("temporary path must be UTF-8"));
    let error = match result {
        Ok(_) => panic!("overflowing snapshot descriptor was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("overflows"));
    fs::remove_file(path).expect("test snapshot must be removable");
}
