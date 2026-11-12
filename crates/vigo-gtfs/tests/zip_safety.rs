//! GTFS ZIP admission and CSV streaming limits, ported from the reader-level
//! cases of test/check-gtfs-import-safety.mjs with the same inputs and
//! expected messages.
mod support;

use std::collections::HashMap;
use std::path::Path;
use support::{Entry, entry, scratch, write_zip, zip_bytes};
use vigo_gtfs::zip::{Archive, Budget, Limits, stream_csv};

type Rows = Vec<HashMap<String, String>>;

/// Stream one table into owned rows, or return the error message.
fn read_table(
    archive: &Archive,
    table: &str,
    budget: &mut Budget,
) -> Result<(Vec<String>, u64, Rows), String> {
    let entry = archive.table(table).expect("table admitted");
    let mut rows = Vec::new();
    let profile = stream_csv(archive, entry, budget, None, &mut |row| {
        rows.push(
            row.header
                .names
                .iter()
                .zip(&row.values)
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        );
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok((profile.fields, profile.rows, rows))
}

fn stream_error(archive: &Archive, table: &str) -> String {
    read_table(archive, table, &mut Budget::default()).unwrap_err()
}

fn inspect_error(path: &Path, limits: Limits) -> String {
    match Archive::inspect_with(path, limits) {
        Ok(_) => panic!("{} was admitted", path.display()),
        Err(error) => error.to_string(),
    }
}

#[test]
fn quoted_and_unquoted_records_preserve_fields_across_utf8_chunks() {
    let directory = scratch("csv-records");
    // 30,000 characters is the original fixture; 120,000 also spans the
    // 256 KiB inflate chunks this reader uses.
    for repeat in [30_000, 120_000] {
        let long_name = "站".repeat(repeat);
        let content = format!(
            "\u{FEFF}stop_id,stop_name,__proto__,constructor,extra\r\n\"A\",\"{long_name}, \"\"quoted\"\"\nline\",proto,ctor,\r\nB,Plain,,,\r\nC,Missing"
        );
        let path = write_zip(
            &directory,
            "csv-records.zip",
            &[entry("stops.txt", content.as_bytes())],
        );
        let archive = Archive::inspect(&path).unwrap();
        let (fields, count, rows) =
            read_table(&archive, "stops.txt", &mut Budget::default()).unwrap();
        assert_eq!(
            fields,
            ["stop_id", "stop_name", "__proto__", "constructor", "extra"]
        );
        assert_eq!(count, 3);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0]["stop_name"],
            format!("{long_name}, \"quoted\"\nline")
        );
        assert_eq!(rows[0]["__proto__"], "proto");
        assert_eq!(rows[0]["constructor"], "ctor");
        assert_eq!(rows[1]["stop_id"], "B");
        assert_eq!(rows[1]["extra"], "");
        assert_eq!(rows[2]["stop_name"], "Missing");
        assert_eq!(rows[2]["constructor"], "");
        assert_eq!(
            rows[0]["stop_id"], "A",
            "Streaming callbacks retain independent rows."
        );
    }
}

#[test]
fn valid_looking_csv_with_corrupt_zip_contents_is_rejected() {
    let directory = scratch("corrupt-crc");
    let mut bytes = zip_bytes(
        &[entry("stops.txt", b"stop_id,stop_name\nA,Alpha\n")],
        false,
    );
    let offset = bytes
        .windows(5)
        .position(|window| window == b"Alpha")
        .unwrap();
    bytes[offset] = b'B';
    let path = directory.join("corrupt-crc.zip");
    std::fs::write(&path, bytes).unwrap();
    let archive = Archive::inspect(&path).unwrap();
    assert!(stream_error(&archive, "stops.txt").contains("CRC32 does not match"));
}

#[test]
fn safe_nested_gtfs_table_paths_remain_supported() {
    let directory = scratch("nested");
    let path = write_zip(
        &directory,
        "nested.zip",
        &[
            entry("feed/stops.txt", b"stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.9,-77.0\n"),
            entry("feed/routes.txt", b"route_id,route_short_name,route_type\nR,R,3\n"),
            entry("feed/trips.txt", b"route_id,service_id,trip_id\nR,WK,T\n"),
            entry(
                "feed/stop_times.txt",
                b"trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,A,1\n",
            ),
            entry(
                "feed/calendar.txt",
                b"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n",
            ),
        ],
    );
    let archive = Archive::inspect(&path).unwrap();
    assert_eq!(archive.table("stops.txt").unwrap().name, "feed/stops.txt");
    let (fields, count, rows) = read_table(&archive, "stops.txt", &mut Budget::default()).unwrap();
    assert_eq!(fields, ["stop_id", "stop_name", "stop_lat", "stop_lon"]);
    assert_eq!(count, 1);
    assert_eq!(rows[0]["stop_id"], "A");
}

#[test]
fn duplicate_recognized_table_basenames_are_rejected_deterministically() {
    let directory = scratch("duplicate");
    let path = write_zip(
        &directory,
        "duplicate.zip",
        &[
            entry("stops.txt", b"stop_id\nA\n"),
            entry("nested/stops.txt", b"stop_id\nB\n"),
        ],
    );
    assert_eq!(
        inspect_error(&path, Limits::default()),
        "Duplicate GTFS table basename: stops.txt."
    );
}

#[test]
fn unsafe_selected_entry_names_are_rejected_before_extraction() {
    let directory = scratch("unsafe-name");
    let path = write_zip(
        &directory,
        "unsafe-name.zip",
        &[entry("feed*/stops.txt", b"stop_id\nA\n")],
    );
    assert_eq!(
        inspect_error(&path, Limits::default()),
        "Unsafe GTFS ZIP entry name for stops.txt."
    );
}

#[test]
fn traversal_and_control_character_table_names_are_rejected() {
    let directory = scratch("patched-names");
    for (name, replacement) in [
        ("traversal-name.zip", "../stops.txt"),
        ("control-name.zip", "a\u{1}/stops.txt"),
    ] {
        assert_eq!(
            replacement.len(),
            "aa/stops.txt".len(),
            "Patched names keep their byte length."
        );
        let mut bytes = zip_bytes(&[entry("aa/stops.txt", b"stop_id\nA\n")], true);
        // The last occurrence is the central-directory name.
        let offset = bytes
            .windows(12)
            .rposition(|window| window == b"aa/stops.txt")
            .unwrap();
        bytes[offset..offset + 12].copy_from_slice(replacement.as_bytes());
        let path = directory.join(name);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            inspect_error(&path, Limits::default()),
            "Unsafe GTFS ZIP entry name for stops.txt."
        );
    }
}

#[test]
fn selected_unix_symlink_entries_are_rejected_without_extraction() {
    let directory = scratch("symlink");
    let path = directory.join("symlink-entry.zip");
    let link = Entry {
        name: "stops.txt",
        content: b"target.txt",
        unix_mode: Some(0o120777),
    };
    std::fs::write(&path, zip_bytes(&[link], true)).unwrap();
    assert_eq!(
        inspect_error(&path, Limits::default()),
        "Non-regular GTFS ZIP entry is unsupported: stops.txt (symlink)."
    );
    assert!(!directory.join("stops.txt").exists());
}

#[test]
fn invalid_utf8_is_rejected_instead_of_replacement_decoded() {
    let directory = scratch("invalid-utf8");
    let mut content = b"stop_id,stop_name\nA,".to_vec();
    content.extend_from_slice(&[0xc3, 0x28]);
    content.push(b'\n');
    let path = write_zip(
        &directory,
        "invalid-utf8.zip",
        &[entry("stops.txt", &content)],
    );
    let archive = Archive::inspect(&path).unwrap();
    assert_eq!(
        stream_error(&archive, "stops.txt"),
        "GTFS stops.txt is not valid UTF-8."
    );
}

#[test]
fn single_table_expanded_size_limits_reject_oversized_metadata() {
    let directory = scratch("oversized-table");
    let content = format!("stop_id,stop_name\nA,{}\n", "x".repeat(128));
    let path = write_zip(
        &directory,
        "oversized-table.zip",
        &[entry("stops.txt", content.as_bytes())],
    );
    let limits = Limits {
        max_single_table_uncompressed_bytes: 64,
        ..Limits::default()
    };
    assert_eq!(
        inspect_error(&path, limits),
        "GTFS stops.txt exceeds the single-table expanded-size limit (64 bytes)."
    );
}

#[test]
fn archive_compressed_and_selected_expanded_size_limits_are_enforced() {
    let directory = scratch("archive-limits");
    let agency = format!("agency_id,agency_name\nA,{}\n", "a".repeat(80));
    let stops = format!("stop_id,stop_name\nS,{}\n", "s".repeat(80));
    let path = write_zip(
        &directory,
        "archive-limits.zip",
        &[
            entry("agency.txt", agency.as_bytes()),
            entry("stops.txt", stops.as_bytes()),
        ],
    );
    assert_eq!(
        inspect_error(
            &path,
            Limits {
                max_compressed_bytes: 32,
                ..Limits::default()
            }
        ),
        "GTFS ZIP exceeds the compressed-size limit (32 bytes)."
    );
    assert_eq!(
        inspect_error(
            &path,
            Limits {
                max_single_table_uncompressed_bytes: 256,
                max_selected_uncompressed_bytes: 128,
                ..Limits::default()
            }
        ),
        "GTFS ZIP exceeds the selected expanded-size limit (128 bytes)."
    );
}

#[test]
fn logical_csv_records_are_bounded_during_streaming() {
    let directory = scratch("oversized-record");
    let content = format!("stop_id,stop_name\nA,\"{}\"\n", "x".repeat(128));
    let path = write_zip(
        &directory,
        "oversized-record.zip",
        &[entry("stops.txt", content.as_bytes())],
    );
    let archive = Archive::inspect_with(
        &path,
        Limits {
            max_logical_record_bytes: 64,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(
        stream_error(&archive, "stops.txt"),
        "GTFS stops.txt exceeds the logical-record limit (64 bytes)."
    );
}

#[test]
fn empty_and_duplicate_csv_headers_are_rejected() {
    let directory = scratch("headers");
    for (name, content, expected) in [
        (
            "empty-header.zip",
            "stop_id,,stop_name\nA,,Alpha\n",
            "empty CSV header name",
        ),
        (
            "duplicate-header.zip",
            "stop_id,stop_id\nA,B\n",
            "duplicate CSV header: stop_id",
        ),
    ] {
        let path = write_zip(&directory, name, &[entry("stops.txt", content.as_bytes())]);
        let archive = Archive::inspect(&path).unwrap();
        let error = stream_error(&archive, "stops.txt");
        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn csv_header_column_counts_are_bounded() {
    let directory = scratch("column-limit");
    let headers: Vec<String> = (0..257).map(|index| format!("field_{index}")).collect();
    let content = format!("{}\n{}\n", headers.join(","), vec![""; 257].join(","));
    let path = write_zip(
        &directory,
        "column-limit.zip",
        &[entry("stops.txt", content.as_bytes())],
    );
    let archive = Archive::inspect(&path).unwrap();
    assert_eq!(
        stream_error(&archive, "stops.txt"),
        "GTFS stops.txt exceeds the column limit (256 columns)."
    );
}

#[test]
fn row_and_total_row_budgets_are_enforced() {
    let directory = scratch("row-limit");
    let path = write_zip(
        &directory,
        "row-limit.zip",
        &[entry("stops.txt", b"stop_id\nA\nB\n")],
    );
    let limits = Limits {
        max_rows_per_table: 1,
        max_total_rows: 1,
        ..Limits::default()
    };
    let archive = Archive::inspect_with(&path, limits).unwrap();
    assert_eq!(
        read_table(&archive, "stops.txt", &mut Budget::default()).unwrap_err(),
        "GTFS stops.txt exceeds the row limit (1 rows)."
    );

    let path = write_zip(
        &directory,
        "total-row-limit.zip",
        &[
            entry("agency.txt", b"agency_id,agency_name\nA,Agency\n"),
            entry("stops.txt", b"stop_id\nA\n"),
        ],
    );
    let limits = Limits {
        max_rows_per_table: 2,
        max_total_rows: 1,
        ..Limits::default()
    };
    let archive = Archive::inspect_with(&path, limits).unwrap();
    let mut budget = Budget::default();
    read_table(&archive, "agency.txt", &mut budget).unwrap();
    assert_eq!(
        read_table(&archive, "stops.txt", &mut budget).unwrap_err(),
        "GTFS ZIP exceeds the total-row limit (1 rows)."
    );
}

/// A quoted field holding thousands of short lines, doubled quotes and CRLF
/// endings, spread across inflate chunks, reads as one field in linear time.
#[test]
fn newline_dense_quoted_records_stream_in_one_pass() {
    let directory = scratch("csv-multiline");
    let lines = 300_000;
    let mut field = String::new();
    for index in 0..lines {
        if index > 0 {
            field.push('\n');
        }
        field.push_str(if index % 7 == 0 { "\"\"q\"\"" } else { "x" });
    }
    let content = format!("stop_id,stop_name\r\nA,\"{field}\"\r\nB,\"tail\"\"\"\r\n");
    let path = write_zip(
        &directory,
        "multiline.zip",
        &[entry("stops.txt", content.as_bytes())],
    );
    let archive = Archive::inspect_with(&path, Limits::default()).unwrap();
    let started = std::time::Instant::now();
    let (_, rows, values) = read_table(&archive, "stops.txt", &mut Budget::default()).unwrap();
    assert_eq!(rows, 2);
    let expected = field.replace("\"\"", "\"");
    assert_eq!(values[0]["stop_name"], expected);
    assert_eq!(values[1]["stop_name"], "tail\"");
    // The old whole-record rescan took minutes here; one pass takes well
    // under a second even in a debug build.
    assert!(started.elapsed().as_secs() < 20, "{:?}", started.elapsed());
}
