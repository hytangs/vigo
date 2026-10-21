//! Studio projects open read-only as Cities (RFC 0001, "Existing Studio data").
//!
//! A project built with `vigo build --output .vigo` already is a City. A
//! project assembled by Studio imports names its routing store
//! (`routing/current.sqlite`, `routing/feed_*.sqlite`) and has no
//! `network.json`. Its manifest is derived from the project record, the store
//! and the store's prepared sidecars; every identity check of a City still
//! applies, so a stale or incomplete store fails exactly as a stale City does.
use super::{Result, fail};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) struct Layout {
    pub root: PathBuf,
    /// The routing SQLite store; every routing sidecar is named after it.
    pub routing: PathBuf,
    pub manifest: Value,
    /// The manifest was derived for a project store rather than read.
    pub derived: bool,
}

impl Layout {
    pub(crate) fn city(root: &Path) -> Result<Self> {
        Ok(Self {
            root: root.to_owned(),
            routing: root.join("routing/project.sqlite"),
            manifest: serde_json::from_slice(&fs::read(root.join("network.json"))?)?,
            derived: false,
        })
    }

    /// `store` selects one of the project's routing stores; without it the
    /// project's own ready store is used.
    pub(crate) fn project(root: &Path, store: Option<&Path>) -> Result<Self> {
        let project: Value = serde_json::from_slice(&fs::read(root.join("project.json"))?)?;
        // Older Studio projects omit the schema; none declares another one.
        if project
            .get("schemaVersion")
            .is_some_and(|schema| schema != "vigo.project.v1")
        {
            return fail("Expected a vigo.project.v1 Studio project");
        }
        let routing_dir = fs::canonicalize(root.join("routing"))?;
        let routing = match store {
            Some(store) => fs::canonicalize(if store.is_absolute() {
                store.to_owned()
            } else {
                routing_dir.join(store)
            })?,
            None => {
                let name = project["routingStore"]["fileName"]
                    .as_str()
                    .filter(|_| project["routingStore"]["status"] == "ready")
                    .ok_or("The Studio project has no ready routing store")?;
                fs::canonicalize(routing_dir.join(name))?
            }
        };
        if routing.parent() != Some(routing_dir.as_path())
            || routing.extension().is_none_or(|e| e != "sqlite")
        {
            return fail("A project routing store must be a .sqlite file in its routing directory");
        }
        // A project whose `.vigo` was written by `vigo build` keeps its own manifest.
        if routing.file_name().is_some_and(|n| n == "project.sqlite")
            && root.join("network.json").is_file()
        {
            return Self::city(root);
        }
        let street = &project["osmStreetIndex"];
        let mut modes = vec!["transit", "walk"];
        if root
            .join("osm/street-index.sqlite.drive-accelerator-v2.bin")
            .is_file()
        {
            modes.push("drive");
        }
        let manifest = json!({
            "schemaVersion": "vigo.city.v1",
            "kind": "studio-project",
            "name": project["name"],
            "modes": modes,
            "sources": project["feeds"].as_array().map(|feeds| feeds.iter().map(|feed| json!({
                "id": feed["id"], "name": feed["name"], "fileName": feed["fileName"], "hash": feed["hash"],
            })).collect::<Vec<_>>()),
            "streetStore": {"terminalAccess": street["terminalAccess"].as_object()
                .map_or_else(|| json!({"model": "public"}), |model| Value::Object(model.clone()))},
            "routingStore": {"fileName": routing.file_name().map(|n| n.to_string_lossy().into_owned())},
        });
        Ok(Self {
            root: root.to_owned(),
            routing,
            manifest,
            derived: true,
        })
    }

    pub(crate) fn sidecar(&self, suffix: &str) -> PathBuf {
        let mut name = self.routing.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    }
}

/// Whether `root` is a Studio project rather than a City or a collection.
pub(crate) fn is_project(root: &Path) -> bool {
    root.join("project.json").is_file()
}

/// The key a native access profile snapshot was prepared for: the bincode
/// `String` that opens the profile record after the 80-byte header.
fn snapshot_key(path: &Path) -> Result<Option<String>> {
    const MAGIC: &[u8; 8] = b"VIGOAP04";
    const VERSION: u32 = 6;
    let mut header = [0_u8; 88];
    let mut file = File::open(path)?;
    if file.read_exact(&mut header).is_err()
        || &header[..8] != MAGIC
        || u32::from_le_bytes(header[8..12].try_into()?) != VERSION
    {
        return Ok(None);
    }
    let length = u64::from_le_bytes(header[80..88].try_into()?);
    if length == 0 || length > 1 << 20 {
        return Ok(None);
    }
    let mut key = vec![0_u8; length as usize];
    if file.read_exact(&mut key).is_err() {
        return Ok(None);
    }
    Ok(String::from_utf8(key).ok())
}

/// The prepared coordinate access profile of a project store whose identity
/// `accepts`. Newer snapshots win; a snapshot whose file name does not match
/// its key is never used.
pub(crate) fn profile_key(
    layout: &Layout,
    accepts: impl Fn(&str) -> Result<bool>,
) -> Result<String> {
    let directory = layout.routing.parent().ok_or("Missing routing directory")?;
    let prefix = format!(
        "{}.native-access-profile.",
        layout.routing.file_name().unwrap().to_string_lossy()
    );
    let mut snapshots = vec![];
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(suffix) = name
            .strip_prefix(&prefix)
            .and_then(|rest| rest.strip_suffix(".bin"))
        {
            let modified = entry.metadata()?.modified()?;
            snapshots.push((modified, suffix.to_owned(), entry.path()));
        }
    }
    snapshots.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, suffix, path) in snapshots {
        let Some(key) = snapshot_key(&path)? else {
            continue;
        };
        if crate::route_materialization::stable_key_suffix(key.encode_utf16().collect()) == suffix
            && accepts(&key)?
        {
            return Ok(key);
        }
    }
    fail(
        "This routing store has no prepared coordinate access for its street network; prepare routing for this City in Studio first",
    )
}
