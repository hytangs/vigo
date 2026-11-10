//! Disposable, source-bound compiled bicycle data in the user's cache directory.
//! Prepared Cities remain read-only and retain their published SQLite layout.
//! This stores graph representation only: no coordinates from queries, routes,
//! profiles, departure times, or surface answers are retained.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
// Bump this layout when a graph field or its interpretation changes. It is a
// disposable runtime representation, never a required prepared-City format.
const MAGIC: &[u8; 8] = b"VIGOBK01";
const HEADER: usize = 80;
const MAX_BYTES: usize = 2 * 1024 * 1024 * 1024;
const MIN_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct FileStamp {
    bytes: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Binding {
    pub(super) key: String,
    pub(super) digest: [u8; 32],
}
impl Binding {
    pub(super) fn read(path: &str) -> Result<Self> {
        let canonical = fs::canonicalize(path)?;
        let path_bytes = canonical.as_os_str().as_encoded_bytes();
        let key = format!("{:x}", Sha256::digest(path_bytes));
        let mut digest = Sha256::new();
        digest.update(MAGIC);
        digest.update(std::env::consts::OS.as_bytes());
        digest.update(path_bytes);
        // WAL/journal identity participates even when the main database's
        // timestamp has not changed. The walking join belongs to its exact
        // pedestrian snapshot, including atomic replacement at the same path.
        for suffix in ["", "-wal", "-journal", ".street-accelerator-v7.bin"] {
            let file = format!("{path}{suffix}");
            let stamp = match fs::metadata(&file) {
                Ok(m) => Some(FileStamp {
                    bytes: m.len(),
                    modified: m.modified()?,
                    created: m.created().ok(),
                    #[cfg(unix)]
                    identity: {
                        use std::os::unix::fs::MetadataExt;
                        (m.dev(), m.ino(), m.ctime(), m.ctime_nsec())
                    },
                }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            digest.update(bincode::serde::encode_to_vec(
                stamp,
                bincode::config::legacy(),
            )?);
        }
        let mut header = [0u8; 100];
        File::open(path)?.read_exact(&mut header)?;
        digest.update(header);
        Ok(Self {
            key,
            digest: digest.finalize().into(),
        })
    }
}

#[derive(Serialize)]
struct StoredRef<'a> {
    kernel: &'a BikeKernel,
    walking: Option<&'a walk::WalkLinks>,
}
#[derive(Deserialize)]
struct StoredTail {
    turns: HashMap<(u32, i64), Vec<NodeTurn>>,
    windows: TurnWindows,
    edge_windows: HashMap<u32, u32>,
    timed_node_turns: bool,
    timed_way_turns: bool,
    stress_prepared: bool,
    way_turns: Vec<WayTurn>,
    way_starts: HashMap<(u32, i64), Vec<u32>>,
    index: RoadIndex,
    minimum_length_ratio: f64,
    destination_components: Vec<u32>,
    unsupported_restrictions: u64,
    walking: Option<walk::WalkLinks>,
}

pub(super) fn directory() -> Option<PathBuf> {
    let root = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("VIGO/Cache"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|p| p.join("Library/Caches/VIGO"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|p| p.join(".cache"))
            })
            .map(|p| p.join("vigo"))
    }?;
    Some(root.join("bicycle-v1"))
}

pub(super) fn read(path: &str) -> Result<BikeKernel> {
    // Small graphs already open cheaply; avoid accumulating files for tiny
    // temporary Cities and fixtures. The routing implementation is identical.
    let root = fs::metadata(path)
        .ok()
        .filter(|m| m.len() >= MIN_SOURCE_BYTES)
        .and_then(|_| directory());
    read_in(path, root.as_deref())
}

fn read_in(path: &str, directory: Option<&Path>) -> Result<BikeKernel> {
    let binding = directory.and_then(|_| Binding::read(path).ok());
    let cached = directory
        .zip(binding.as_ref())
        .map(|(root, b)| root.join(format!("{}.bin", b.key)));
    if let (Some(cached), Some(binding)) = (&cached, &binding)
        && let Ok(kernel) = load(path, cached, binding)
        && Binding::read(path).as_ref().ok() == Some(binding)
    {
        return Ok(kernel);
    }
    let kernel = BikeKernel::read_source(path)?;
    // Concurrent source replacement must never publish a mixed admission.
    if let (Some(cached), Some(binding)) = (cached, binding)
        && Binding::read(path).ok().as_ref() == Some(&binding)
    {
        // Cache storage is optional: read-only user directories and Cities
        // still open normally. A failed write cannot invalidate the graph.
        let _ = store(&cached, &binding, &kernel);
    }
    Ok(kernel)
}

fn load(source: &str, path: &Path, binding: &Binding) -> Result<BikeKernel> {
    let file = File::open(path)?;
    let size = usize::try_from(file.metadata()?.len())?;
    if !(HEADER..=MAX_BYTES).contains(&size) {
        return Err("Invalid compiled bicycle size".into());
    }
    // The cache writer only publishes completed files by atomic replacement;
    // an admitted map remains bound to that file for this whole decode.
    let mapped = std::sync::Arc::new(unsafe { memmap2::Mmap::map(&file)? });
    if &mapped[..8] != MAGIC
        || mapped[8..40] != binding.digest
        || u64::from_le_bytes(mapped[72..80].try_into()?) != (size - HEADER) as u64
    {
        return Err("Stale compiled bicycle graph".into());
    }
    #[cfg(unix)]
    let admission = index::Admission::new(path, &file.metadata()?, &mapped[..HEADER]);
    #[cfg(unix)]
    let verified = admission.verified();
    #[cfg(not(unix))]
    let verified = false;
    if !verified {
        let checksum: [u8; 32] = Sha256::digest(&mapped[HEADER..]).into();
        if checksum != mapped[40..72] {
            return Err("Damaged compiled bicycle graph".into());
        }
    }
    let mut cursor = HEADER;
    let lons = index::Column::<f64>::legacy(&mapped, &mut cursor)?;
    let lats = index::Column::<f64>::legacy(&mapped, &mut cursor)?;
    let offsets = index::Column::<u32>::legacy(&mapped, &mut cursor)?;
    let targets = index::Column::<u32>::legacy(&mapped, &mut cursor)?;
    let distances = index::Column::<u32>::legacy(&mapped, &mut cursor)?;
    let attributes = index::Column::<u32>::legacy(&mapped, &mut cursor)?;
    let ways = index::Column::<i64>::legacy(&mapped, &mut cursor)?;

    let tail = &mapped[cursor..];
    let (stored, consumed): (StoredTail, usize) = bincode::serde::decode_from_slice(
        tail,
        bincode::config::legacy().with_limit::<MAX_BYTES>(),
    )?;
    let mut kernel = BikeKernel {
        lons,
        lats,
        offsets,
        targets,
        distances,
        attributes,
        ways,
        turns: stored.turns,
        windows: stored.windows,
        edge_windows: stored.edge_windows,
        timed_node_turns: stored.timed_node_turns,
        timed_way_turns: stored.timed_way_turns,
        stress_prepared: stored.stress_prepared,
        way_turns: stored.way_turns,
        way_starts: stored.way_starts,
        index: stored.index,
        minimum_length_ratio: stored.minimum_length_ratio,
        destination_components: stored.destination_components,
        unsupported_restrictions: stored.unsupported_restrictions,
        walking: None,
        cch_prepared: Default::default(),
        cch_topology: Default::default(),
        cch_source: None,
        cch_index: Default::default(),
    };
    if consumed != tail.len() || (!verified && !valid(&kernel)) {
        return Err("Invalid compiled bicycle layout".into());
    }
    kernel.walking = stored
        .walking
        .map(|links| {
            walk::WalkNetwork::from_prepared(source, links, &kernel.lons, &kernel.lats, verified)
        })
        .transpose()?;
    #[cfg(unix)]
    if !verified {
        let _ = admission.remember(&file, &mapped[..HEADER]);
    }
    Ok(kernel)
}

fn valid(k: &BikeKernel) -> bool {
    let n = k.lons.len();
    let e = k.targets.len();
    let w = k.windows.schedules.len();
    k.lats.len() == n
        && k.offsets.len() == n + 1
        && k.offsets.first() == Some(&0)
        && k.offsets.last().copied().map(|v| v as usize) == Some(e)
        && k.offsets.windows(2).all(|v| v[0] <= v[1])
        && k.distances.len() == e
        && k.attributes.len() == e
        && k.ways.len() == e
        && k.targets.iter().all(|&v| (v as usize) < n)
        && k.distances.iter().all(|&v| v > 0)
        && k.lons.iter().all(|v| v.is_finite() && v.abs() <= 180.)
        && k.lats.iter().all(|v| v.is_finite() && v.abs() <= 90.)
        && k.minimum_length_ratio.is_finite()
        && k.minimum_length_ratio > 0.
        && k.minimum_length_ratio <= 1.
        && k.index.valid_layout(n, e)
        && (k.destination_components.len() == n
            || k.destination_components.is_empty()
                && !k.attributes.iter().any(|a| a & (1 << 22) != 0))
        && k.destination_components.iter().all(|&v| (v as usize) < n)
        && k.edge_windows.iter().all(|(&edge, &window)| {
            (edge as usize) < e
                && window > 0
                && window as usize <= w
                && k.attributes[edge as usize] & TIMED_EDGE != 0
        })
        && k.attributes
            .iter()
            .enumerate()
            .all(|(edge, a)| a & TIMED_EDGE == 0 || k.edge_windows.contains_key(&(edge as u32)))
        && k.windows.schedules.iter().all(|s| {
            !s.is_empty()
                && s.iter().all(|&(a, b)| a < b && b <= 10080)
                && s.windows(2).all(|v| v[0].1 <= v[1].0)
        })
        && k.turns.iter().all(|(&(node, _), rules)| {
            (node as usize) < n
                && rules.iter().all(|r| {
                    r.window as usize <= w
                        && r.kind & !8 <= 5
                        && (r.kind & 8 == 0 || r.kind & 1 != 0)
                })
        })
        && k.way_turns
            .iter()
            .all(|r| !r.via.is_empty() && r.window as usize <= w)
        && k.way_starts.iter().all(|(&(node, _), rules)| {
            (node as usize) < n && rules.iter().all(|&r| (r as usize) < k.way_turns.len())
        })
}

struct HashedWriter<W> {
    writer: W,
    digest: Sha256,
    bytes: u64,
}
impl<W: Write> Write for HashedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.saturating_add(bytes.len() as u64) > (MAX_BYTES - HEADER) as u64 {
            return Err(std::io::Error::other(
                "Compiled bicycle data exceeds its size bound",
            ));
        }
        let written = self.writer.write(bytes)?;
        self.digest.update(&bytes[..written]);
        self.bytes += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

fn store(path: &Path, binding: &Binding, kernel: &BikeKernel) -> Result<()> {
    let parent = path.parent().ok_or("Missing compiled bicycle directory")?;
    let mut directories = fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directories.mode(0o700);
    }
    directories.create(parent)?;
    let temporary = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&temporary)?;
    let outcome = (|| -> Result<()> {
        let mut buffered = BufWriter::with_capacity(1024 * 1024, file);
        buffered.write_all(&[0u8; HEADER])?;
        let mut writer = HashedWriter {
            writer: buffered,
            digest: Sha256::new(),
            bytes: 0,
        };
        bincode::serde::encode_into_std_write(
            StoredRef {
                kernel,
                walking: kernel
                    .walking
                    .as_ref()
                    .map(walk::WalkNetwork::prepared_links),
            },
            &mut writer,
            bincode::config::legacy(),
        )?;
        writer.flush()?;
        let mut buffered = writer.writer;
        buffered.seek(SeekFrom::Start(0))?;
        buffered.write_all(MAGIC)?;
        buffered.write_all(&binding.digest)?;
        buffered.write_all(&writer.digest.finalize())?;
        buffered.write_all(&writer.bytes.to_le_bytes())?;
        buffered.flush()?;
        drop(buffered);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiled_graph_is_exact_and_invalidates_changed_sources_and_corrupt_files() {
        let root = std::env::temp_dir().join(format!(
            "vigo-bike-cache-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("street.sqlite");
        let path = source.to_str().unwrap();
        let cache = root.join("cache");
        let db = Connection::open(&source).unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('bikeProfileVersion','1');
            CREATE TABLE bike_nodes(node_id INTEGER PRIMARY KEY,lon_e7 INTEGER,lat_e7 INTEGER); INSERT INTO bike_nodes VALUES(1,0,0),(2,10000,0);
            CREATE TABLE bike_edges(from_node INTEGER,to_node INTEGER,distance_cm INTEGER,way_id INTEGER,attributes INTEGER); INSERT INTO bike_edges VALUES(1,2,10000,1,7680);
            CREATE TABLE bike_turns(via_node INTEGER,from_way INTEGER,to_way INTEGER,only_turn INTEGER);
            CREATE TABLE bike_way_turns(from_way INTEGER,via_ways TEXT,to_way INTEGER,only_turn INTEGER);").unwrap();
        drop(db);
        let original = fs::read(&source).unwrap();
        let expected = read_in(path, Some(&cache)).unwrap();
        let binding = Binding::read(path).unwrap();
        let compiled = cache.join(format!("{}.bin", binding.key));
        let restored = load(path, &compiled, &binding).unwrap();
        assert_eq!(
            bincode::serde::encode_to_vec(&expected, bincode::config::legacy()).unwrap(),
            bincode::serde::encode_to_vec(&restored, bincode::config::legacy()).unwrap()
        );
        assert_eq!(
            fs::read(&source).unwrap(),
            original,
            "Opening a City must not alter its files"
        );
        let mut broken = fs::read(&compiled).unwrap();
        broken[HEADER + 3] ^= 1;
        fs::write(&compiled, broken).unwrap();
        assert!(load(path, &compiled, &binding).is_err());
        assert_eq!(read_in(path, Some(&cache)).unwrap().distances[..], [10000]);
        assert!(load(path, &compiled, &binding).is_ok());
        let db = Connection::open(&source).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; UPDATE bike_edges SET distance_cm=20000")
            .unwrap();
        assert!(load(path, &compiled, &Binding::read(path).unwrap()).is_err());
        assert_eq!(read_in(path, Some(&cache)).unwrap().distances[..], [20000]);
        db.execute_batch("UPDATE bike_edges SET distance_cm=30000")
            .unwrap();
        assert_eq!(read_in(path, Some(&cache)).unwrap().distances[..], [30000]);
        drop(db);
        let unavailable = root.join("not-a-directory");
        fs::write(&unavailable, b"file").unwrap();
        assert_eq!(
            read_in(path, Some(&unavailable)).unwrap().distances[..],
            [30000]
        );
        let db = Connection::open(&source).unwrap();
        db.execute_batch("UPDATE bike_edges SET distance_cm=0")
            .unwrap();
        drop(db);
        assert!(
            read_in(path, Some(&cache)).is_err(),
            "A cached City must not hide newly invalid source data"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
