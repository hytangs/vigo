//! Source-bound, immutable bicycle hierarchy columns. These are disposable
//! indexes in the user cache, never a requirement of the City format.
use super::cache::Binding;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::io::Read;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    marker::PhantomData,
    mem::{align_of, size_of},
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
#[cfg(any(feature = "standalone", test))]
use std::{
    io::{BufWriter, Seek, SeekFrom},
    mem::size_of_val,
};

const MAGIC: &[u8; 8] = b"VGBCCH01";
const HEADER: usize = 80;
const MAX_BYTES: usize = 2 * 1024 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[derive(Clone)]
pub(super) struct Source {
    path: String,
    binding: Binding,
    directory: PathBuf,
}
impl Source {
    pub(super) fn open(path: &str) -> Option<Self> {
        if fs::metadata(path).ok()?.len() < 4 * 1024 * 1024 {
            return None;
        }
        let directory = std::env::var_os("VIGO_BIKE_INDEX_DIR")
            .map(PathBuf::from)
            .or_else(|| super::cache::directory().map(|p| p.with_file_name("bicycle-cch-v1")))?;
        Some(Self {
            path: path.to_owned(),
            binding: Binding::read(path).ok()?,
            directory,
        })
    }

    pub(super) fn current(&self) -> bool {
        Binding::read(&self.path).ok().as_ref() == Some(&self.binding)
    }

    pub(super) fn store(&self, structure: Option<&str>) -> Option<Store> {
        let structure = if let Some(path) = structure {
            let path = fs::canonicalize(path).ok()?;
            let stamp = structure_stamp(&path).ok()?;
            Some((path, stamp))
        } else {
            None
        };
        Some(Store {
            source: self.clone(),
            structure,
        })
    }
}

fn structure_stamp(path: &Path) -> io::Result<[u8; 32]> {
    let meta = fs::metadata(path)?;
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid("Invalid hierarchy modification time"))?;
    let mut digest = Sha256::new();
    digest.update(path.as_os_str().as_encoded_bytes());
    digest.update(meta.len().to_le_bytes());
    digest.update(modified.as_nanos().to_le_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(meta.dev().to_le_bytes());
        digest.update(meta.ino().to_le_bytes());
        digest.update(meta.ctime().to_le_bytes());
        digest.update(meta.ctime_nsec().to_le_bytes());
    }
    Ok(digest.finalize().into())
}

#[derive(Clone)]
pub(super) struct Store {
    source: Source,
    structure: Option<(PathBuf, [u8; 32])>,
}
impl Store {
    #[cfg(any(feature = "standalone", test))]
    fn current(&self) -> bool {
        self.source.current()
            && self
                .structure
                .as_ref()
                .is_none_or(|(path, stamp)| structure_stamp(path).ok().as_ref() == Some(stamp))
    }

    /// Read this City's index files once into the operating system's file
    /// cache, so first queries in any region do not fault their pages in.
    #[cfg(feature = "standalone")]
    pub(super) fn prefetch(&self) {
        use std::io::Read;
        let prefix = format!("{}.", self.source.binding.key);
        let Ok(entries) = std::fs::read_dir(&self.source.directory) else {
            return;
        };
        let mut buffer = vec![0; 1 << 20];
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix)
                && let Ok(mut file) = std::fs::File::open(entry.path())
            {
                while matches!(file.read(&mut buffer), Ok(n) if n > 0) {}
            }
        }
    }

    fn file(&self, kind: &str) -> PathBuf {
        self.source
            .directory
            .join(format!("{}.{kind}", self.source.binding.key))
    }

    fn binding(&self, kind: &str, key: &[u8]) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update(MAGIC);
        digest.update(if cfg!(target_endian = "little") {
            b"LE"
        } else {
            b"BE"
        });
        digest.update(self.source.binding.digest);
        digest.update(self.structure.as_ref().map_or([0; 32], |(_, stamp)| *stamp));
        digest.update(kind.as_bytes());
        digest.update(key);
        digest.finalize().into()
    }

    /// Removes an index kind this version no longer reads, with its receipt.
    #[cfg(feature = "standalone")]
    pub(super) fn remove(&self, kind: &str) {
        let file = self.file(kind);
        let mut receipt = file.clone().into_os_string();
        receipt.push(".verified");
        let _ = fs::remove_file(file);
        let _ = fs::remove_file(receipt);
    }

    pub(super) fn open(&self, kind: &str, key: &[u8]) -> io::Result<Reader> {
        let file = File::open(self.file(kind))?;
        let meta = file.metadata()?;
        let len = usize::try_from(meta.len()).map_err(|_| invalid("Invalid hierarchy length"))?;
        if !(HEADER..=MAX_BYTES).contains(&len) {
            return Err(invalid("Invalid hierarchy length"));
        }
        // Only the atomic publisher below writes these files. A reader keeps
        // the original file alive even when a new index replaces its name.
        let data = Arc::new(unsafe { memmap2::Mmap::map(&file)? });
        if &data[..8] != MAGIC
            || data[8..40] != self.binding(kind, key)
            || u64::from_le_bytes(data[72..80].try_into().unwrap()) != len as u64
        {
            return Err(invalid("Hierarchy source or profile changed"));
        }
        // An unchanged, atomically published file retains its verified
        // identity. In-place edits change ctime even if size and mtime
        // are restored. Old files and changed files are fully checked.
        #[cfg(unix)]
        let admission = Admission::new(&self.file(kind), &meta, &data[..HEADER]);
        #[cfg(unix)]
        let verified = admission.verified();
        #[cfg(not(unix))]
        let verified = false;
        if !verified {
            let digest: [u8; 32] = Sha256::digest(&data[HEADER..]).into();
            if digest != data[40..72] {
                return Err(invalid("Hierarchy index checksum mismatch"));
            }
            #[cfg(unix)]
            let _ = admission.remember(&file, &data[..HEADER]);
        }
        Ok(Reader {
            data,
            cursor: HEADER,
        })
    }

    #[cfg(any(feature = "standalone", test))]
    pub(super) fn publish(
        &self,
        kind: &str,
        key: &[u8],
        write: impl FnOnce(&mut Writer) -> io::Result<()>,
    ) -> io::Result<()> {
        if !self.current() {
            return Err(invalid("Cannot publish an index for a changed source"));
        }
        let mut directories = fs::DirBuilder::new();
        directories.recursive(true);
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
            directories.mode(0o700);
            options.mode(0o600);
        }
        directories.create(&self.source.directory)?;
        super::cache::sweep_abandoned(&self.source.directory);
        let file = self.file(kind);
        let temporary = file.with_extension(format!(
            "{kind}.{}-{}.tmp",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let mut out = BufWriter::with_capacity(1024 * 1024, options.open(&temporary)?);
        let outcome = (|| {
            out.write_all(&[0; HEADER])?;
            let mut writer = Writer {
                out,
                digest: Sha256::new(),
                bytes: HEADER,
            };
            write(&mut writer)?;
            let mut header = [0; HEADER];
            header[..8].copy_from_slice(MAGIC);
            header[8..40].copy_from_slice(&self.binding(kind, key));
            header[40..72].copy_from_slice(&writer.digest.finalize());
            header[72..80].copy_from_slice(&(writer.bytes as u64).to_le_bytes());
            writer.out.seek(SeekFrom::Start(0))?;
            writer.out.write_all(&header)?;
            writer.out.flush()?;
            drop(writer.out);
            if !self.current() {
                return Err(invalid("Hierarchy source changed during preparation"));
            }
            fs::rename(&temporary, &file)?;
            #[cfg(unix)]
            if let Ok(mut published) = File::open(&file) {
                let mut actual = [0; HEADER];
                if published.read_exact(&mut actual).is_ok()
                    && actual == header
                    && let Ok(meta) = published.metadata()
                {
                    let _ = Admission::new(&file, &meta, &actual).remember(&published, &actual);
                }
            }
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(temporary);
        }
        outcome
    }
}

#[cfg(unix)]
pub(super) struct Admission {
    receipt: PathBuf,
    identity: [u8; 32],
}

#[cfg(unix)]
impl Admission {
    pub(super) fn new(path: &Path, meta: &fs::Metadata, header: &[u8]) -> Self {
        let mut name = path.as_os_str().to_os_string();
        name.push(".verified");
        Self {
            receipt: PathBuf::from(name),
            identity: Self::identity(meta, header),
        }
    }

    fn identity(meta: &fs::Metadata, header: &[u8]) -> [u8; 32] {
        use std::os::unix::fs::MetadataExt;
        let mut digest = Sha256::new();
        digest.update(b"VIGO bicycle index verified file v1");
        digest.update(header);
        digest.update(meta.dev().to_le_bytes());
        digest.update(meta.ino().to_le_bytes());
        digest.update(meta.len().to_le_bytes());
        digest.update(meta.mtime().to_le_bytes());
        digest.update(meta.mtime_nsec().to_le_bytes());
        digest.update(meta.ctime().to_le_bytes());
        digest.update(meta.ctime_nsec().to_le_bytes());
        digest.finalize().into()
    }

    pub(super) fn verified(&self) -> bool {
        let mut bytes = [0; 32];
        File::open(&self.receipt)
            .and_then(|mut file| file.read_exact(&mut bytes))
            .is_ok()
            && bytes == self.identity
    }

    pub(super) fn remember(&self, file: &File, header: &[u8]) -> io::Result<()> {
        if Self::identity(&file.metadata()?, header) != self.identity {
            return Err(invalid("Bicycle index changed during verification"));
        }
        use std::os::unix::fs::OpenOptionsExt;
        let temporary = self.receipt.with_extension(format!(
            "verified.{}-{}.tmp",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&self.identity)?;
            drop(file);
            fs::rename(&temporary, &self.receipt)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

mod sealed {
    pub trait Word {}
    impl Word for u32 {}
    impl Word for i64 {}
    impl Word for f64 {}
}
pub(super) trait Word: sealed::Word + Copy {
    fn little_endian(bytes: &[u8]) -> Self;
}
macro_rules! words {
    ($($word:ty),* $(,)?) => {
        $(impl Word for $word {
            fn little_endian(bytes: &[u8]) -> Self {
                <$word>::from_le_bytes(bytes.try_into().unwrap())
            }
        })*
    };
}
words!(u32, i64, f64);

pub(super) struct Column<T> {
    storage: Storage<T>,
}
enum Storage<T> {
    Owned(Vec<T>),
    Mapped {
        data: Arc<memmap2::Mmap>,
        start: usize,
        count: usize,
        word: PhantomData<T>,
    },
}
impl<T> From<Vec<T>> for Column<T> {
    fn from(values: Vec<T>) -> Self {
        Self {
            storage: Storage::Owned(values),
        }
    }
}
impl<T> Column<T> {
    pub(super) fn mapped(&self) -> bool {
        matches!(self.storage, Storage::Mapped { .. })
    }
}
impl<T> Default for Column<T> {
    fn default() -> Self {
        Vec::new().into()
    }
}
impl<T: Word + serde::Serialize> serde::Serialize for Column<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&**self, serializer)
    }
}
impl<'de, T: Word + serde::Deserialize<'de>> serde::Deserialize<'de> for Column<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        <Vec<T> as serde::Deserialize>::deserialize(deserializer).map(Self::from)
    }
}
impl<T: Word> Column<T> {
    // The original compiled graph stores a fixed-width little-endian length
    // followed by a contiguous sequence. Retain an immutable view wherever
    // its original alignment permits; only a misaligned column needs copying.
    pub(super) fn legacy(data: &Arc<memmap2::Mmap>, cursor: &mut usize) -> io::Result<Self> {
        let prefix = cursor
            .checked_add(8)
            .ok_or_else(|| invalid("Invalid bicycle column offset"))?;
        let count = u64::from_le_bytes(
            data.get(*cursor..prefix)
                .ok_or_else(|| invalid("Truncated bicycle column"))?
                .try_into()
                .unwrap(),
        );
        let count = usize::try_from(count).map_err(|_| invalid("Invalid bicycle column size"))?;
        let end = count
            .checked_mul(size_of::<T>())
            .and_then(|bytes| prefix.checked_add(bytes))
            .ok_or_else(|| invalid("Invalid bicycle column length"))?;
        let bytes = data
            .get(prefix..end)
            .ok_or_else(|| invalid("Truncated bicycle column"))?;
        *cursor = end;
        if cfg!(target_endian = "little")
            && (bytes.as_ptr() as usize).is_multiple_of(align_of::<T>())
        {
            Ok(Self {
                storage: Storage::Mapped {
                    data: data.clone(),
                    start: prefix,
                    count,
                    word: PhantomData,
                },
            })
        } else {
            Ok(bytes
                .chunks_exact(size_of::<T>())
                .map(T::little_endian)
                .collect::<Vec<_>>()
                .into())
        }
    }

    #[cfg(feature = "standalone")]
    pub(super) fn mapped_file_bytes(&self) -> usize {
        match &self.storage {
            Storage::Mapped { data, .. } => data.len(),
            Storage::Owned(_) => 0,
        }
    }

    #[cfg(any(feature = "standalone", test))]
    pub(super) fn capacity(&self) -> usize {
        match &self.storage {
            Storage::Owned(values) => values.capacity(),
            Storage::Mapped { .. } => 0,
        }
    }
}
impl<T: Word> Deref for Column<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        match &self.storage {
            Storage::Owned(values) => values,
            Storage::Mapped {
                data, start, count, ..
            } => {
                // Reader checked alignment and the entire range. Word is
                // sealed to primitives with no invalid bit patterns.
                unsafe { std::slice::from_raw_parts(data.as_ptr().add(*start).cast::<T>(), *count) }
            }
        }
    }
}
impl<T: Word> DerefMut for Column<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        match &mut self.storage {
            Storage::Owned(values) => values,
            Storage::Mapped { .. } => panic!("cannot customize an immutable hierarchy column"),
        }
    }
}
pub(super) struct Reader {
    data: Arc<memmap2::Mmap>,
    cursor: usize,
}
impl Reader {
    pub(super) fn column<T: Word>(&mut self, expected: Option<usize>) -> io::Result<Column<T>> {
        let end = self
            .cursor
            .checked_add(8)
            .ok_or_else(|| invalid("Hierarchy offset overflow"))?;
        let count = usize::try_from(u64::from_le_bytes(
            self.data
                .get(self.cursor..end)
                .ok_or_else(|| invalid("Truncated hierarchy header"))?
                .try_into()
                .unwrap(),
        ))
        .map_err(|_| invalid("Hierarchy column length overflow"))?;
        let bytes = count
            .checked_mul(size_of::<T>())
            .ok_or_else(|| invalid("Hierarchy column length overflow"))?;
        if expected.is_some_and(|value| value != count)
            || !end.is_multiple_of(align_of::<T>())
            || bytes > self.data.len() - end
        {
            return Err(invalid("Hierarchy column does not match its layout"));
        }
        self.cursor = (end + bytes).next_multiple_of(8);
        Ok(Column {
            storage: Storage::Mapped {
                data: self.data.clone(),
                start: end,
                count,
                word: PhantomData,
            },
        })
    }
    pub(super) fn finish(self) -> io::Result<()> {
        if self.cursor == self.data.len() {
            Ok(())
        } else {
            Err(invalid("Unexpected hierarchy data"))
        }
    }
}
#[cfg(any(feature = "standalone", test))]
pub(super) struct Writer {
    out: BufWriter<File>,
    digest: Sha256,
    bytes: usize,
}
#[cfg(any(feature = "standalone", test))]
impl Writer {
    fn bytes(&mut self, data: &[u8]) -> io::Result<()> {
        if self.bytes.saturating_add(data.len()) > MAX_BYTES {
            return Err(invalid("Hierarchy index exceeds its storage limit"));
        }
        self.out.write_all(data)?;
        self.digest.update(data);
        self.bytes += data.len();
        Ok(())
    }

    pub(super) fn column<T: Word>(&mut self, values: &[T]) -> io::Result<()> {
        self.bytes(&(values.len() as u64).to_le_bytes())?;
        // A slice of primitive words is initialized, with no padding.
        let bytes = unsafe {
            std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), size_of_val(values))
        };
        self.bytes(bytes)?;
        self.bytes(&[0; 8][..self.bytes.next_multiple_of(8) - self.bytes])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_hierarchy_detects_an_edit_even_when_size_and_mtime_are_unchanged() {
        let root = std::env::temp_dir().join(format!(
            "vigo-bike-index-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let file = File::create(&source).unwrap();
        file.set_len(4 * 1024 * 1024).unwrap();
        drop(file);
        let source = source.to_str().unwrap();
        let store = Store {
            source: Source {
                path: source.to_owned(),
                binding: Binding::read(source).unwrap(),
                directory: root.join("cache"),
            },
            structure: None,
        };
        store
            .publish("test", b"profile", |writer| writer.column(&[1u32, 2, 3]))
            .unwrap();
        assert!(store.open("test", b"different profile").is_err());
        let mut reader = store.open("test", b"profile").unwrap();
        assert_eq!(&*reader.column::<u32>(Some(3)).unwrap(), &[1, 2, 3]);
        reader.finish().unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .open(store.file("test"))
            .unwrap();
        let previous = file.metadata().unwrap().modified().unwrap();
        file.seek(SeekFrom::Start((HEADER + 8) as u64)).unwrap();
        file.write_all(&4u32.to_ne_bytes()).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(previous))
            .unwrap();
        drop(file);
        assert!(store.open("test", b"profile").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
