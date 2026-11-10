//! Immutable admissions are shared across Node isolates in the same process.
//! Weak entries never keep a retired City alive. Atomic file replacement gets
//! a new identity while existing readers retain their admitted data.
use super::*;
use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, Weak},
    time::SystemTime,
};

#[derive(Hash, Eq, PartialEq)]
struct FileKey {
    path: std::path::PathBuf,
    bytes: u64,
    modified: SystemTime,
    owner: usize,
    #[cfg(unix)]
    inode: (u64, u64),
}
impl FileKey {
    fn read(path: &str) -> napi::Result<Self> {
        let path = fs::canonicalize(path).map_err(|e| Error::from_reason(e.to_string()))?;
        let m = fs::metadata(&path).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self {
            path,
            bytes: m.len(),
            modified: m
                .modified()
                .map_err(|e| Error::from_reason(e.to_string()))?,
            owner: 0,
            #[cfg(unix)]
            inode: {
                use std::os::unix::fs::MetadataExt;
                (m.dev(), m.ino())
            },
        })
    }
}
struct Admissions<T>(Mutex<HashMap<FileKey, Weak<T>>>);
impl<T> Admissions<T> {
    fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
    fn open(&self, path: &str, load: impl FnOnce() -> napi::Result<T>) -> napi::Result<Arc<T>> {
        self.open_bound(path, 0, load)
    }
    fn open_bound(
        &self,
        path: &str,
        owner: usize,
        load: impl FnOnce() -> napi::Result<T>,
    ) -> napi::Result<Arc<T>> {
        let mut key = FileKey::read(path)?;
        key.owner = owner;
        let mut entries = self
            .0
            .lock()
            .map_err(|_| Error::from_reason("Street admission lock failed"))?;
        if let Some(value) = entries.get(&key).and_then(Weak::upgrade) {
            return Ok(value);
        }
        entries.retain(|_, v| v.strong_count() > 0);
        let value = Arc::new(load()?);
        entries.insert(key, Arc::downgrade(&value));
        Ok(value)
    }
}
static SNAPSHOTS: LazyLock<Admissions<Snapshot>> = LazyLock::new(Admissions::new);
static STRUCTURES: LazyLock<Admissions<cch::CchBundle>> = LazyLock::new(Admissions::new);
static METRICS: LazyLock<Admissions<cch::MetricBundle>> = LazyLock::new(Admissions::new);
static TERMINALS: LazyLock<Admissions<TerminalAccessGraph>> = LazyLock::new(Admissions::new);
pub(super) fn snapshot(path: &str) -> napi::Result<Arc<Snapshot>> {
    SNAPSHOTS.open(path, || Snapshot::open(path))
}
pub(super) fn structure(path: &str) -> napi::Result<Arc<cch::CchBundle>> {
    STRUCTURES.open(path, || {
        cch::CchBundle::open(Path::new(path)).map_err(|e| Error::from_reason(e.to_string()))
    })
}

// The bicycle connector shares the prepared pedestrian topology when present.
// Existing Cities need only their original street snapshot.
pub(super) fn pedestrian_structure_for(path: &str) -> std::result::Result<Option<String>, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let snapshot = vigo_format::Snapshot::open(&path, false).map_err(|e| e.to_string())?;
    let directory = path
        .parent()
        .ok_or("Missing pedestrian snapshot directory")?;
    let prefix = format!(
        "{}.street-cch-v2-u10000.",
        path.file_name()
            .ok_or("Missing pedestrian snapshot name")?
            .to_string_lossy()
    );
    let mut manifests = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".manifest.json"))
        })
        .collect::<Vec<_>>();
    manifests.sort_unstable();
    for path in manifests {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        if !file.metadata().is_ok_and(|m| m.len() <= 64 * 1024) {
            continue;
        }
        let Ok(manifest) = serde_json::from_reader::<_, serde_json::Value>(file) else {
            continue;
        };
        if manifest["schemaVersion"] != "vigo.native-cch-manifest.v1"
            || manifest["kind"] != "street"
            || manifest["format"] != "street-cch-v2-u10000"
            || [
                "magic",
                "version",
                "identity",
                "nodeCount",
                "edgeCount",
                "byteLength",
            ]
            .into_iter()
            .any(|key| manifest["sourceSnapshot"][key] != snapshot.header[key])
        {
            continue;
        }
        let member = &manifest["structure"];
        let name = member["file"]
            .as_str()
            .ok_or("Missing pedestrian CCH file")?;
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err("Pedestrian CCH must be adjacent to its snapshot".into());
        }
        let expected = member["bytes"]
            .as_u64()
            .or_else(|| member["bytes"].as_str()?.parse().ok());
        let file = fs::canonicalize(directory.join(name)).map_err(|e| e.to_string())?;
        if !file.starts_with(directory) || fs::metadata(&file).ok().map(|m| m.len()) != expected {
            return Err("Invalid pedestrian CCH file".into());
        }
        return file
            .into_os_string()
            .into_string()
            .map(Some)
            .map_err(|_| "Pedestrian CCH path must be UTF-8".into());
    }
    Ok(None)
}
pub(super) fn metric(path: &str) -> napi::Result<Arc<cch::MetricBundle>> {
    METRICS.open(path, || {
        cch::MetricBundle::open(Path::new(path)).map_err(|e| Error::from_reason(e.to_string()))
    })
}
pub(super) fn terminal(
    snapshot: &Arc<Snapshot>,
    path: &str,
) -> napi::Result<Arc<TerminalAccessGraph>> {
    // Each kernel retains its snapshot as long as it owns this terminal graph.
    // A live terminal entry therefore cannot outlive/reuse this owner address.
    TERMINALS.open_bound(path, Arc::as_ptr(snapshot) as usize, || {
        TerminalAccessGraph::open(snapshot, Path::new(path))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shares_live_owners_but_releases_retired_and_replaced_files() {
        let path = std::env::temp_dir().join(format!("vigo-admission-{}", std::process::id()));
        fs::write(&path, b"one").unwrap();
        let pool = Admissions::new();
        let file = path.to_str().unwrap();
        let a = pool.open(file, || Ok(1_u32)).unwrap();
        let b = pool.open(file, || panic!("duplicate admission")).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let weak = Arc::downgrade(&a);
        drop(a);
        drop(b);
        assert!(weak.upgrade().is_none());
        let c = pool.open(file, || Ok(2_u32)).unwrap();
        let replacement = path.with_extension("replacement");
        fs::write(&replacement, b"replacement").unwrap();
        fs::rename(&replacement, &path).unwrap();
        let d = pool.open(file, || Ok(3_u32)).unwrap();
        assert_eq!(*c, 2);
        assert_eq!(*d, 3);
        assert!(!Arc::ptr_eq(&c, &d));
        fs::remove_file(path).unwrap();
    }
}
