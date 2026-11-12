//! Atomic City publication beside the output directory.
//!
//! A City is compiled in a sibling `.NAME.vigo-building-HOST-PID-TIME`
//! directory and renamed into place. Replacing moves the old City to a
//! `previous` sibling first, so an interrupted run can always be recovered:
//! the next build restores a lost City or removes abandoned work, but never
//! touches directories owned by a live process.
use super::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

static HOST_TAG: LazyLock<String> = LazyLock::new(|| {
    let host = hostname();
    format!("{:x}", Sha256::digest(host.as_bytes()))[..8].to_owned()
});

/// `os.hostname()`.
fn hostname() -> String {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn gethostname(name: *mut std::ffi::c_char, len: usize) -> std::ffi::c_int;
        }
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is writable for its full length.
        if unsafe { gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
            return String::from_utf8_lossy(&buffer[..end]).into_owned();
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

fn unique_sibling(directory: &Path, role: &str) -> PathBuf {
    let parent = directory.parent().unwrap_or(Path::new("."));
    let name = directory
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    parent.join(format!(
        ".{name}.vigo-{role}-{}-{}-{now}",
        *HOST_TAG,
        std::process::id()
    ))
}

/// Flush a file or directory. Some network filesystems cannot; real write
/// errors still fail.
fn flush(path: &Path) -> Result<()> {
    #[cfg(windows)]
    if path.is_dir() {
        return Ok(());
    }
    let file = fs::File::open(path)?;
    match file.sync_all() {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.raw_os_error(), Some(code) if code == 22 || code == 45 || code == 38 || code == 95) => {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn sync_directory(directory: &Path) -> Result<()> {
    flush(directory)
}

/// Flush a finished tree before publishing it; stores are written without
/// synchronous commits. Hard-linked files are flushed once.
pub(crate) fn sync_directory_tree(directory: &Path) -> Result<()> {
    fn walk(directory: &Path, flushed: &mut std::collections::HashSet<(u64, u64)>) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let path = entry.path();
            if kind.is_dir() {
                walk(&path, flushed)?;
            } else if kind.is_file() {
                #[cfg(unix)]
                let identity = {
                    use std::os::unix::fs::MetadataExt;
                    let metadata = fs::metadata(&path)?;
                    (metadata.dev(), metadata.ino())
                };
                #[cfg(not(unix))]
                let identity = (0, flushed.len() as u64);
                if flushed.insert(identity) {
                    flush(&path)?;
                }
            }
        }
        sync_directory(directory)
    }
    walk(directory, &mut Default::default())
}

pub(crate) fn staging_path(output: &Path) -> PathBuf {
    unique_sibling(output, "building")
}

pub(crate) fn create_staging_directory(output: &Path, staging: &Path) -> Result<()> {
    let parent = output
        .parent()
        .ok_or("City output needs a parent directory")?;
    if !parent.exists() {
        let mut created = vec![];
        let mut cursor = parent;
        while !cursor.exists() {
            created.push(cursor.to_path_buf());
            cursor = cursor
                .parent()
                .ok_or("City output needs a parent directory")?;
        }
        fs::create_dir_all(parent)?;
        for directory in &created {
            sync_directory(directory)?;
        }
        sync_directory(cursor)?;
    }
    fs::create_dir(staging)?;
    Ok(())
}

/// `validateCityDirectory`: a complete City with matching profiles.
pub(crate) fn validate_city(directory: &Path) -> Result<Value> {
    for relative in [
        "network.json",
        "routing/project.sqlite",
        "osm/street-index.sqlite",
    ] {
        if !directory.join(relative).is_file() {
            return Err(format!("The City is incomplete: {relative} is missing.").into());
        }
    }
    let manifest: Value = serde_json::from_slice(&fs::read(directory.join("network.json"))?)?;
    if manifest["schemaVersion"] != "vigo.city.v1" {
        return Err(format!(
            "Unsupported City format {}; expected vigo.city.v1. Rebuild from the original GTFS and OSM into a new directory.",
            manifest.get("schemaVersion").map_or("undefined".into(), |v| v.to_string())
        )
        .into());
    }
    // The stores are admitted as the runtime opens them: format, service
    // model and transfer semantics.
    let routing_path = directory.join("routing/project.sqlite");
    let routing: Value =
        serde_json::from_str(&vigo_gtfs::store::read_store_metadata(&routing_path)?.stringify())?;
    let topology = super::raw::inspect_topology(&routing_path)?;
    if topology.get("ready") != Some(&vigo_format::js::Js::Bool(true)) {
        let reason = topology
            .get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("unknown")
            .to_owned();
        return Err(format!("The City routing topology must be rebuilt: {reason}.").into());
    }
    let street = Value::Object(vigo_osm::read_store_metadata(
        &directory.join("osm/street-index.sqlite"),
    )?);
    let profile = |value: &Value| {
        value["accessibility"]["profile"]
            .as_str()
            .map(str::to_owned)
    };
    let profiles = [profile(&manifest), profile(&routing), profile(&street)];
    if profiles.iter().any(|p| *p != profiles[0])
        || profiles[0]
            .as_deref()
            .is_some_and(|p| p != "wheelchair-strict-v1")
    {
        return Err("City accessibility profiles do not match; rebuild the complete City.".into());
    }
    if street["storageLayout"] != "runtime-snapshots-v1" {
        return Err("The City street index must be rebuilt into sealed runtime snapshots.".into());
    }
    Ok(manifest)
}

fn remove_working_directory(directory: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::remove_dir_all(directory) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) if attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => return Err(error),
        }
    }
}

fn discard_previous(directory: &Path, output: &Path) -> bool {
    let removing = unique_sibling(output, "removing");
    match fs::rename(directory, &removing).and_then(|()| remove_working_directory(&removing)) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "VIGO left an old copy beside {}; the next build retries removing it: {error}",
                output.display()
            );
            false
        }
    }
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { kill(pid as i32, 0) } == 0 {
            return true;
        }
        // EPERM: the process exists but belongs to another user.
        std::io::Error::last_os_error().raw_os_error() != Some(3)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

struct Abandoned {
    role: String,
    directory: PathBuf,
    created: u128,
}

fn abandoned_siblings(output: &Path) -> Vec<Abandoned> {
    let parent = output.parent().unwrap_or(Path::new("."));
    let prefix = format!(
        ".{}.vigo-",
        output
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default()
    );
    let Ok(entries) = fs::read_dir(parent) else {
        return vec![];
    };
    let mut found = vec![];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let parts: Vec<&str> = rest.split('-').collect();
        let (role, host, pid, created) = match parts.as_slice() {
            [role, host, pid, created]
                if host.len() == 8
                    && host
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
            {
                (*role, Some(*host), *pid, *created)
            }
            [role, pid, created] => (*role, None, *pid, *created),
            _ => continue,
        };
        if !["building", "previous", "removing"].contains(&role)
            || !pid.bytes().all(|b| b.is_ascii_digit())
            || !created.bytes().all(|b| b.is_ascii_digit())
        {
            continue;
        }
        let (Ok(pid), Ok(created)) = (pid.parse::<u32>(), created.parse::<u128>()) else {
            continue;
        };
        if host.is_some_and(|h| h != HOST_TAG.as_str()) || process_alive(pid) {
            continue;
        }
        found.push(Abandoned {
            role: role.into(),
            directory: entry.path(),
            created,
        });
    }
    found.sort_by_key(|item| std::cmp::Reverse(item.created));
    found
}

/// What [`recover`] did beside one output path.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Recovery {
    pub restored: bool,
    pub removed: usize,
    pub kept: usize,
}

/// Finish what a crashed publication left beside `output`. A City that lost
/// its path mid-replacement is restored; an old copy is deleted only once a
/// valid City holds the path. Directories of a live owner are untouched.
pub(crate) fn recover(output: &Path) -> Result<Recovery> {
    let abandoned = abandoned_siblings(output);
    let mut recovery = Recovery::default();
    for item in abandoned.iter().filter(|a| a.role == "previous") {
        if !output.exists() {
            fs::rename(&item.directory, output)?;
            sync_directory(output.parent().unwrap_or(Path::new(".")))?;
            recovery.restored = true;
            eprintln!(
                "VIGO restored {} after an interrupted replacement.",
                output.display()
            );
        } else if validate_city(output).is_ok() && discard_previous(&item.directory, output) {
            recovery.removed += 1;
        } else {
            recovery.kept += 1;
            eprintln!(
                "VIGO kept an old copy of the City at {} because {} is not a valid City.",
                item.directory.display(),
                output.display()
            );
        }
    }
    for item in abandoned.iter().filter(|a| a.role != "previous") {
        match remove_working_directory(&item.directory) {
            Ok(()) => recovery.removed += 1,
            Err(error) => {
                recovery.kept += 1;
                eprintln!(
                    "VIGO could not remove abandoned build files at {}: {error}",
                    item.directory.display()
                );
            }
        }
    }
    Ok(recovery)
}

pub(crate) fn publish(staged: &Path, output: &Path, replace: bool, durable: bool) -> Result<()> {
    if staged.parent() != output.parent() {
        return Err("The staged and published network directories must share one parent.".into());
    }
    if !staged.is_dir() {
        return Err("The staged network package is not a directory.".into());
    }
    validate_city(staged)?;
    let existing = output.exists();
    if existing && !replace {
        return Err(format!(
            "City already exists; pass --replace to replace it: {}",
            output.display()
        )
        .into());
    }
    if durable {
        sync_directory_tree(staged)?;
    }
    let backup = unique_sibling(output, "previous");
    let mut moved = false;
    let result = (|| -> std::io::Result<()> {
        if existing {
            fs::rename(output, &backup)?;
            moved = true;
        }
        fs::rename(staged, output)
    })();
    if let Err(error) = result {
        if moved && !output.exists() && backup.exists() {
            fs::rename(&backup, output)?;
        }
        return Err(error.into());
    }
    if durable {
        sync_directory(output.parent().unwrap_or(Path::new(".")))?;
    }
    if moved {
        discard_previous(&backup, output);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), &target).unwrap();
            }
        }
    }

    fn write_package(template: &Path, directory: &Path, marker: &str) {
        copy_tree(template, directory);
        fs::write(
            directory.join("network.json"),
            format!(r#"{{"schemaVersion":"vigo.city.v1","marker":"{marker}"}}"#),
        )
        .unwrap();
    }

    fn marker(directory: &Path) -> String {
        validate_city(directory).unwrap()["marker"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn set_routing_metadata(directory: &Path, key: &str, value: &str) {
        let db = rusqlite::Connection::open(directory.join("routing/project.sqlite")).unwrap();
        db.execute(
            "UPDATE metadata SET value=? WHERE key=?",
            rusqlite::params![value, key],
        )
        .unwrap();
    }

    /// A compiled City from the format fixture, built once.
    fn template(root: &Path) -> PathBuf {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/format-0.5.0");
        let template = root.join("template");
        fs::create_dir_all(&template).unwrap();
        let options = super::super::Options {
            feeds: vec![super::super::Feed {
                path: fixture.join("fixture.zip"),
                scope: "fixture".into(),
            }],
            osm: fixture.join("fixture.osm.pbf"),
            output: root.join("unused"),
            name: "template".into(),
            wheelchair: false,
            wheelchair_streets: "inferred".into(),
            street_modes: "walk".into(),
            private_access: "public".into(),
            streets_from: None,
            prepare_dates: vec![],
            flex_driving: false,
        };
        super::super::compile(&options, &template).unwrap();
        template
    }

    #[test]
    fn publication_rejects_before_moving_and_recovery_finishes_crashes() {
        let root = std::env::temp_dir().join(format!(
            "vigo-publish-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let template = template(&root);
        let output = root.join("city-x");
        write_package(&template, &output, "old");
        let stage = || {
            let staged = staging_path(&output);
            create_staging_directory(&output, &staged).unwrap();
            staged
        };

        let incomplete = stage();
        fs::create_dir(incomplete.join("routing")).unwrap();
        fs::write(incomplete.join("routing/project.sqlite"), "partial").unwrap();
        let error = publish(&incomplete, &output, true, true).unwrap_err();
        assert!(error.to_string().contains("incomplete"), "{error}");
        assert_eq!(marker(&output), "old");
        fs::remove_dir_all(&incomplete).unwrap();

        let outdated = stage();
        fs::remove_dir(&outdated).unwrap();
        write_package(&template, &outdated, "outdated");
        set_routing_metadata(
            &outdated,
            "transferSemanticsVersion",
            r#""vigo.routing.transfers.v2""#,
        );
        let error = publish(&outdated, &output, true, true).unwrap_err();
        assert!(error.to_string().contains("Transfer semantics"), "{error}");
        assert_eq!(marker(&output), "old");
        fs::remove_dir_all(&outdated).unwrap();

        // Old formats are rejected before the working City moves.
        for format in ["manifest", "routing"] {
            let candidate = stage();
            fs::remove_dir(&candidate).unwrap();
            write_package(&template, &candidate, "unsupported");
            if format == "manifest" {
                fs::write(
                    candidate.join("network.json"),
                    r#"{"schemaVersion":"vigo.city.v0"}"#,
                )
                .unwrap();
            } else {
                set_routing_metadata(&candidate, "schemaVersion", r#""vigo.routing.store.v3""#);
            }
            let before = fs::read(output.join("network.json")).unwrap();
            let error = publish(&candidate, &output, true, true).unwrap_err();
            assert!(error.to_string().contains("ebuild"), "{format}: {error}");
            assert_eq!(fs::read(output.join("network.json")).unwrap(), before);
            fs::remove_dir_all(&candidate).unwrap();
        }

        let staged = stage();
        fs::remove_dir(&staged).unwrap();
        write_package(&template, &staged, "new");
        publish(&staged, &output, true, true).unwrap();
        assert_eq!(marker(&output), "new");
        assert!(!staged.exists());
        assert_eq!(
            fs::read(output.join("routing/project.sqlite")).unwrap(),
            fs::read(template.join("routing/project.sqlite")).unwrap()
        );
        let leftovers = |role: &str| -> Vec<String> {
            fs::read_dir(&root)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(&format!(".city-x.vigo-{role}")))
                .collect()
        };
        assert!(
            leftovers("previous").is_empty(),
            "the replaced City is removed"
        );

        #[cfg(unix)]
        {
            // What a crash leaves: siblings owned by a process that is gone.
            let gone = std::process::Command::new("true").spawn().unwrap();
            let gone_pid = gone.id();
            let _ = { gone }.wait();
            let sibling = |role: &str, created: u32| {
                root.join(format!(
                    ".city-x.vigo-{role}-{}-{gone_pid}-{created}",
                    *HOST_TAG
                ))
            };

            // A crash between the two renames loses the path but neither City.
            fs::rename(&output, sibling("previous", 1)).unwrap();
            write_package(&template, &sibling("building", 2), "interrupted");
            let recovery = recover(&output).unwrap();
            assert_eq!(
                recovery,
                Recovery {
                    restored: true,
                    removed: 1,
                    kept: 0
                }
            );
            assert_eq!(marker(&output), "new");
            assert!(leftovers("").is_empty());

            // Once the new City holds the path, the replacement is finished, not undone.
            copy_tree(&output, &sibling("previous", 3));
            write_package(&template, &output, "second");
            assert_eq!(
                recover(&output).unwrap(),
                Recovery {
                    restored: false,
                    removed: 1,
                    kept: 0
                }
            );
            assert_eq!(marker(&output), "second");
            assert!(leftovers("").is_empty());

            // A copy that is partly deleted is never restored, even with the path empty.
            write_package(&template, &sibling("removing", 4), "partly-deleted");
            fs::remove_file(sibling("removing", 4).join("network.json")).unwrap();
            let saved = root.join("city-x.saved");
            fs::rename(&output, &saved).unwrap();
            assert_eq!(
                recover(&output).unwrap(),
                Recovery {
                    restored: false,
                    removed: 1,
                    kept: 0
                }
            );
            assert!(!output.exists());
            assert!(leftovers("").is_empty());
            fs::rename(&saved, &output).unwrap();

            // An old copy is deleted only once a valid City holds the path.
            copy_tree(&output, &sibling("previous", 5));
            let manifest = fs::read(output.join("network.json")).unwrap();
            fs::remove_file(output.join("network.json")).unwrap();
            assert_eq!(
                recover(&output).unwrap(),
                Recovery {
                    restored: false,
                    removed: 0,
                    kept: 1
                }
            );
            assert_eq!(leftovers("previous").len(), 1);
            fs::write(output.join("network.json"), manifest).unwrap();
            assert_eq!(
                recover(&output).unwrap(),
                Recovery {
                    restored: false,
                    removed: 1,
                    kept: 0
                }
            );

            // Live owners, other hosts and unrelated names are left alone.
            let untouched = [
                format!(".city-x.vigo-building-{}-1", std::process::id()),
                ".city-x.vigo-previous-00000000-1-1".to_owned(),
                ".city-x.vigo-building-not-an-owner".to_owned(),
                ".city-xy.vigo-building-99999999-1".to_owned(),
                ".city-x.vigo-previous-1.vigo-previous-2-3".to_owned(),
            ];
            for name in &untouched {
                fs::create_dir(root.join(name)).unwrap();
            }
            assert_eq!(recover(&output).unwrap(), Recovery::default());
            for name in &untouched {
                assert!(root.join(name).exists(), "{name}");
                fs::remove_dir(root.join(name)).unwrap();
            }

            // A build that older code abandoned is recognised without a host tag.
            fs::create_dir(root.join(format!(".city-x.vigo-building-{gone_pid}-1"))).unwrap();
            assert_eq!(
                recover(&output).unwrap(),
                Recovery {
                    restored: false,
                    removed: 1,
                    kept: 0
                }
            );
            assert_eq!(
                recover(&root.join("missing/parent/city")).unwrap(),
                Recovery::default()
            );
        }
        fs::remove_dir_all(&root).unwrap();
    }
}
