//! Resident capacity respects Linux memory controllers. Swap is not RAM.
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
};

fn ancestors(root: &Path, relative: &str) -> Vec<PathBuf> {
    let relative = Path::new(relative.trim_start_matches('/'));
    if relative
        .components()
        .any(|p| matches!(p, Component::ParentDir | Component::Prefix(_)))
    {
        return vec![];
    }
    let mut path = root.join(relative);
    let mut out = vec![];
    loop {
        out.push(path.clone());
        if path == root || !path.pop() {
            break;
        }
    }
    out
}
fn read(path: &Path) -> String {
    use std::io::Read;
    let mut value = String::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(4096).read_to_string(&mut value);
    }
    value
}
fn capacity(root: &Path, membership: &str, meminfo: &str) -> Option<usize> {
    let mut limits: Vec<usize> = meminfo
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            if fields.next()? != "MemTotal:" {
                return None;
            }
            fields.next()?.parse::<usize>().ok()?.checked_mul(1024)
        })
        .collect();
    let mut paths = vec![(root.to_path_buf(), false), (root.join("memory"), true)];
    for line in membership.lines() {
        let fields: Vec<_> = line.splitn(3, ':').collect();
        if fields.len() != 3 {
            continue;
        }
        if fields[1].is_empty() {
            paths.extend(ancestors(root, fields[2]).into_iter().map(|p| (p, false)));
        } else if fields[1].split(',').any(|s| s == "memory") {
            paths.extend(
                ancestors(&root.join("memory"), fields[2])
                    .into_iter()
                    .map(|p| (p, true)),
            );
        }
    }
    for (path, legacy) in paths {
        for name in if legacy {
            &["memory.limit_in_bytes"][..]
        } else {
            &["memory.max", "memory.high"][..]
        } {
            if let Ok(n) = read(&path.join(name)).trim().parse::<usize>() {
                limits.push(n);
            }
        }
    }
    limits.into_iter().min()
}
static MEMORY: LazyLock<Option<usize>> = LazyLock::new(|| {
    if cfg!(target_os = "linux") {
        capacity(
            Path::new("/sys/fs/cgroup"),
            &read(Path::new("/proc/self/cgroup")),
            &read(Path::new("/proc/meminfo")),
        )
    } else {
        None
    }
});
pub(crate) fn memory_capacity() -> Option<usize> {
    *MEMORY
}
pub(crate) fn cache_budget(default: usize, divisor: usize) -> usize {
    memory_capacity().map_or(default, |bytes| default.min(bytes / divisor))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_controller_limits_ignore_swap_and_unlimited_leaf() {
        let root = std::env::temp_dir().join(format!("vigo-resource-test-{}", std::process::id()));
        fs::create_dir_all(root.join("parent/worker")).unwrap();
        fs::write(root.join("parent/worker/memory.max"), "max").unwrap();
        fs::write(root.join("parent/memory.max"), "2147483648").unwrap();
        fs::write(root.join("parent/memory.high"), "1073741824").unwrap();
        fs::write(root.join("parent/worker/memory.swap.max"), "68719476736").unwrap();
        assert_eq!(
            capacity(&root, "0::/parent/worker", "MemTotal: 67108864 kB"),
            Some(1073741824)
        );
        fs::write(root.join("parent/memory.high"), "0").unwrap();
        assert_eq!(
            capacity(&root, "0::/parent/worker", "MemTotal: 67108864 kB"),
            Some(0)
        );
        assert!(ancestors(&root, "/../../outside").is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_controller_limits_large_host() {
        let root = std::env::temp_dir().join(format!("vigo-resource-v1-{}", std::process::id()));
        fs::create_dir_all(root.join("memory/group")).unwrap();
        fs::write(root.join("memory/memory.limit_in_bytes"), "2147483648").unwrap();
        fs::write(
            root.join("memory/group/memory.limit_in_bytes"),
            "9223372036854771712",
        )
        .unwrap();
        assert_eq!(
            capacity(&root, "3:memory:/group", "MemTotal: 67108864 kB"),
            Some(2147483648)
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unknown_capacity_preserves_defaults() {
        assert_eq!(
            capacity(Path::new("/nonexistent-vigo-cgroup"), "bad", "bad"),
            None
        );
    }
}
