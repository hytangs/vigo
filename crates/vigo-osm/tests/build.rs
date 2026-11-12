//! End-to-end street builds on the permanent 0.5.0 fixture PBF.
use std::path::{Path, PathBuf};
use vigo_osm::{StreetOptions, build_street_store, compact_runtime_store};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/format-0.5.0/fixture.osm.pbf")
}

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("vigo-osm-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

#[test]
fn builds_seals_and_reports_like_the_javascript_compiler() {
    let directory = scratch("build");
    let store = directory.join("street-index.sqlite");
    let options = StreetOptions {
        include_biking: true,
        build_driving_profile: false,
        ..StreetOptions::default()
    };
    let mut phases = Vec::new();
    let result = build_street_store(&fixture(), &store, &options, &mut |p| {
        phases.push(p.phase.to_owned())
    })
    .unwrap();
    assert_eq!(
        result.get("walkNodeCount").and_then(|v| v.as_f64()),
        Some(3.0)
    );
    assert_eq!(result.get("edgeCount").and_then(|v| v.as_f64()), Some(4.0));
    assert_eq!(
        result.get("preparedModes").map(|v| v.stringify()),
        Some(r#"["walk","drive","bike"]"#.to_owned())
    );
    assert!(phases.contains(&"Street index ready".to_owned()));
    assert!(vigo_osm::walk_snapshot_path(&store).exists());
    let drive = vigo_osm::build_drive_store(&store, true, None).unwrap();
    assert_eq!(
        drive.get("snapshotStatus").and_then(|v| v.as_str()),
        Some("written")
    );
    let mut native_calls = 0;
    let mut native = |snapshot: &Path| {
        native_calls += 1;
        assert!(snapshot.exists());
        Ok((0.0, vigo_format::js::Js::object()))
    };
    let sealed = compact_runtime_store(&store, true, Some(&mut native)).unwrap();
    assert_eq!(
        sealed.get("storageLayout").and_then(|v| v.as_str()),
        Some("runtime-snapshots-v1")
    );
    assert_eq!(native_calls, 1);
    let metadata = vigo_osm::read_store_metadata(&store).unwrap();
    assert_eq!(metadata["driveIndexState"], "snapshot");
    // Sealing again is a no-op.
    let again = compact_runtime_store(&store, true, None).unwrap();
    assert_eq!(again.get("built"), Some(&vigo_format::js::Js::Bool(false)));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_a_source_that_changes_between_passes() {
    let directory = scratch("changing");
    let pbf = directory.join("changing.osm.pbf");
    let mut bytes = std::fs::read(fixture()).unwrap();
    std::fs::write(&pbf, &bytes).unwrap();
    let store = directory.join("street-index.sqlite");
    let mut changed = false;
    let error = build_street_store(&pbf, &store, &StreetOptions::default(), &mut |p| {
        if !changed && p.phase == "Selecting street node references" && p.progress >= 0.12 {
            changed = true;
            let at = bytes.windows(7).position(|w| w == b"service").unwrap();
            bytes[at] ^= 1;
            std::fs::write(&pbf, &bytes).unwrap();
        }
    })
    .unwrap_err();
    assert!(changed);
    assert_eq!(
        error.to_string(),
        "OSM PBF changed during street compilation; retry against a stable input."
    );
    assert!(!store.exists());
    assert!(!directory.join("street-index.sqlite.building").exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_truncated_input_without_partial_files() {
    let directory = scratch("truncated");
    let pbf = directory.join("truncated.osm.pbf");
    let bytes = std::fs::read(fixture()).unwrap();
    std::fs::write(&pbf, &bytes[..bytes.len() - 7]).unwrap();
    let store = directory.join("street-index.sqlite");
    let error =
        build_street_store(&pbf, &store, &StreetOptions::default(), &mut |_| {}).unwrap_err();
    assert_eq!(error.to_string(), "Unexpected end of OSM PBF.");
    assert!(!store.exists() && !directory.join("street-index.sqlite.building").exists());
    std::fs::remove_dir_all(directory).unwrap();
}
