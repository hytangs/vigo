//! Corpus records shared by the integration tests.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// `test/corpus/recorded`, plus any directories in `VIGO_CORPUS_EXTRA`
/// (separated by the platform path separator), such as the output of
/// `node test/corpus/corpus.mjs harvest`.
fn directories() -> Vec<PathBuf> {
    let mut directories =
        vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/corpus/recorded")];
    if let Some(extra) = std::env::var_os("VIGO_CORPUS_EXTRA") {
        directories.extend(std::env::split_paths(&extra));
    }
    directories
}

/// Every record, in a stable order.
pub fn records() -> Vec<Value> {
    let mut records = vec![];
    for directory in directories() {
        let mut files: Vec<_> = std::fs::read_dir(&directory)
            .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        for file in files {
            records.push(serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap());
        }
    }
    assert!(!records.is_empty(), "no corpus records found");
    records
}

/// The request schema for a record's command, if it takes one.
pub fn request_schema(kind: &str) -> Option<&'static str> {
    match kind {
        "route" => Some("RouteRequest"),
        "matrix" => Some("MatrixRequest"),
        "reach" | "isochrone" => Some("ReachRequest"),
        "compare" => Some("CompareRequest"),
        _ => None,
    }
}
