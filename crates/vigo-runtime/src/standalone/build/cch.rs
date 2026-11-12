//! Street and driving contraction hierarchies with their source manifests.
//!
//! Readers admit a hierarchy only through a manifest that names its source
//! snapshot by file size and header identity, so copied Cities keep working.
use super::Result;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use vigo_format::js::Js;

pub(crate) const STREET_FORMAT: &str = "street-cch-v2-u10000";
pub(crate) const DRIVE_FORMAT: &str = "drive-cch-v2-t100-d100";
const MANIFEST_SCHEMA: &str = "vigo.native-cch-manifest.v1";

/// The JSON header at the start of a street or drive snapshot.
fn snapshot_identity(path: &Path) -> Result<Js> {
    let mut header = vec![0u8; 4096];
    let read = fs::File::open(path)?.read(&mut header)?;
    if read < header.len() {
        return Ok(Js::Null);
    }
    let text = String::from_utf8_lossy(&header);
    let Ok(value) = Js::parse(text.trim_matches(|c: char| c.is_whitespace() || c == '\0')) else {
        return Ok(Js::Null);
    };
    let integral = |v: Option<&Js>| v.and_then(Js::as_f64).is_some_and(|n| n.fract() == 0.0);
    if value
        .get("magic")
        .is_none_or(|m| matches!(m, Js::Null | Js::Bool(false)))
        || !integral(value.get("version"))
    {
        return Ok(Js::Null);
    }
    let number = |key: &str| {
        Js::Number(value.get(key).map_or(-1.0, |v| match v {
            Js::Number(n) => *n,
            Js::Null => 0.0,
            _ => f64::NAN,
        }))
    };
    Ok(Js::object()
        .with("magic", value.get("magic").cloned().unwrap_or(Js::Null))
        .with("version", value.get("version").cloned().unwrap_or(Js::Null))
        .with(
            "identity",
            value.get("identity").cloned().unwrap_or(Js::Null),
        )
        .with("nodeCount", number("nodeCount"))
        .with("edgeCount", number("edgeCount"))
        .with("byteLength", number("byteLength")))
}

fn file_identity(path: &Path) -> Result<Js> {
    Ok(Js::object()
        .with(
            "file",
            path.file_name()
                .and_then(|n| n.to_str())
                .ok_or("CCH paths must be UTF-8")?,
        )
        .with("bytes", fs::metadata(path)?.len().to_string()))
}

/// `${snapshot}.${format}.${generation}`, the generation being the first 16
/// characters of the source fingerprint.
pub(crate) fn prefix(snapshot: &Path, format: &str) -> Result<PathBuf> {
    let snapshot = fs::canonicalize(snapshot)?;
    let identity = snapshot_identity(&snapshot)?;
    let fingerprint = identity
        .get("identity")
        .and_then(|i| i.get("sourceFingerprint"))
        .and_then(Js::as_str)
        .unwrap_or("");
    let generation = if fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        &fingerprint[..16]
    } else {
        "prepared"
    };
    let mut path = snapshot.into_os_string();
    path.push(format!(".{format}.{generation}"));
    Ok(PathBuf::from(path))
}

pub(crate) fn with_suffix(prefix: &Path, suffix: &str) -> PathBuf {
    let mut path = prefix.as_os_str().to_owned();
    path.push(suffix);
    PathBuf::from(path)
}

/// Write the manifest that admits a freshly built hierarchy.
pub(crate) fn publish_manifest(
    kind: &str,
    format: &str,
    source: &Path,
    manifest: &Path,
    structure: &Path,
    metrics: &[(&str, &Path)],
    edge_count: f64,
) -> Result<Js> {
    let mut header = [0u8; 32];
    fs::File::open(structure)?
        .read_exact(&mut header)
        .map_err(|_| "Native CCH structure header is truncated.")?;
    let node_count = u64::from_le_bytes(header[16..24].try_into()?);
    let arc_count = u64::from_le_bytes(header[24..32].try_into()?);
    let mut metric_files = Js::object();
    for (name, path) in metrics {
        metric_files.set(*name, file_identity(path)?);
    }
    let value = Js::object()
        .with("schemaVersion", MANIFEST_SCHEMA)
        .with("kind", kind)
        .with("format", format)
        .with("builderVersion", env!("CARGO_PKG_VERSION"))
        .with("source", file_identity(source)?)
        .with("sourceSnapshot", snapshot_identity(source)?)
        .with("structure", file_identity(structure)?)
        .with("metrics", metric_files)
        .with("nodeCount", node_count as f64)
        .with("edgeCount", edge_count)
        .with("cchArcCount", arc_count as f64);
    let temporary = with_suffix(manifest, &format!(".{}.next", std::process::id()));
    let result = (|| -> Result<()> {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(format!("{}\n", value.stringify_pretty(2)).as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, manifest)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(value)
}
