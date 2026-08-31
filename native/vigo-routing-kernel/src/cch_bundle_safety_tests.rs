use cch::{CchBundle, MetricBundle};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_path(suffix: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "vigo-cch-safety-{}-{unique}.{suffix}",
        std::process::id()
    ))
}

fn append_section(bytes: &mut Vec<u8>, values: &[u32]) {
    bytes.extend_from_slice(&(std::mem::size_of_val(values) as u64).to_le_bytes());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

#[test]
fn rejects_cch_section_cursor_overflow() {
    let path = temporary_path("cch-struct");
    let mut bytes = vec![0_u8; 48];
    bytes[0..8].copy_from_slice(&0x4343_485F_5354_5243_u64.to_le_bytes());
    bytes[8..12].copy_from_slice(&1_u32.to_le_bytes());
    bytes[40..48].copy_from_slice(&u64::MAX.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    let error = CchBundle::open(&path).map(|_| ()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    fs::remove_file(path).unwrap();
}

#[test]
fn rejects_metric_section_cursor_overflow() {
    let path = temporary_path("cch-metric");
    let mut bytes = vec![0_u8; 32];
    bytes[0..8].copy_from_slice(&0x4343_485F_4D45_5452_u64.to_le_bytes());
    bytes[8..12].copy_from_slice(&1_u32.to_le_bytes());
    bytes[24..32].copy_from_slice(&u64::MAX.to_le_bytes());
    fs::write(&path, bytes).unwrap();
    let error = MetricBundle::open(&path).map(|_| ()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    fs::remove_file(path).unwrap();
}

#[test]
fn rejects_semantically_invalid_cch_rank() {
    let path = temporary_path("cch-struct");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0x4343_485F_5354_5243_u64.to_le_bytes());
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u64.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    append_section(&mut bytes, &[]);
    append_section(&mut bytes, &[1]);
    append_section(&mut bytes, &[u32::MAX]);
    append_section(&mut bytes, &[0, 0]);
    append_section(&mut bytes, &[]);
    append_section(&mut bytes, &[]);
    append_section(&mut bytes, &[0, 0]);
    append_section(&mut bytes, &[]);
    append_section(&mut bytes, &[]);
    fs::write(&path, bytes).unwrap();
    let error = CchBundle::open(&path).map(|_| ()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("rank"));
    fs::remove_file(path).unwrap();
}
