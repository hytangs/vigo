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
