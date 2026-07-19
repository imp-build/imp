//! `cache stats`: a read-only summary of what's on disk in the cache root —
//! counts and byte totals per category. Pure filesystem walk, no `usage.db`
//! reasoning beyond sizing its own files; unlike `gc`, nothing here ages out
//! or gets deleted.

use std::path::PathBuf;

use anyhow::Result;

#[derive(Debug, Default, Clone, Copy)]
pub struct CountBytes {
    pub count: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CacheStats {
    pub root: PathBuf,
    pub task_records: CountBytes,
    pub cas_blobs: CountBytes,
    pub named_scopes: usize,
    pub named_bytes: u64,
    pub legacy_bytes: u64,
    pub db_bytes: u64,
    pub total_bytes: u64,
    /// Actual disk usage of the whole cache root (allocated blocks, like
    /// `du`), as opposed to `total_bytes`'s sum of apparent file lengths.
    /// Diverges from `total_bytes` mainly from block-size padding across the
    /// large number of small CAS blob files.
    pub raw_bytes: u64,
}

/// Summarize the active cache root.
pub fn collect() -> Result<CacheStats> {
    let root = crate::cache::cache_root()?;
    Ok(collect_at(&root))
}

fn collect_at(root: &std::path::Path) -> CacheStats {
    let task_records = count_bytes(&root.join("tasks"));
    let cas_blobs = count_bytes(&root.join("cas").join("blobs"));

    let named_root = root.join("named");
    let named_scopes = std::fs::read_dir(&named_root)
        .map(|entries| entries.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0);
    let named_bytes = crate::usage::dir_size_bytes(&named_root).unwrap_or(0);

    let legacy_bytes = crate::usage::dir_size_bytes(&root.join("cas").join("trees")).unwrap_or(0);

    let db_bytes = ["usage.db", "usage.db-wal", "usage.db-shm"]
        .iter()
        .map(|name| {
            std::fs::metadata(root.join(name))
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum();

    let total_bytes = crate::usage::dir_size_bytes(root).unwrap_or(0);
    let raw_bytes = disk_usage_bytes(root);

    CacheStats {
        root: root.to_path_buf(),
        task_records,
        cas_blobs,
        named_scopes,
        named_bytes,
        legacy_bytes,
        db_bytes,
        total_bytes,
        raw_bytes,
    }
}

/// Count and total size of the immediate files in `dir` (non-recursive —
/// both `tasks/` and `cas/blobs/` are flat).
fn count_bytes(dir: &std::path::Path) -> CountBytes {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return CountBytes::default();
    };
    let mut result = CountBytes::default();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            result.count += 1;
            result.bytes += meta.len();
        }
    }
    result
}

/// Sum of allocated disk blocks under `path` (files and directory entries
/// alike), matching what `du` reports. Falls back to apparent size on
/// platforms without `st_blocks` (Windows).
#[cfg(unix)]
fn disk_usage_bytes(path: &std::path::Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    let mut total = meta.blocks() * 512;
    if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                total += disk_usage_bytes(&entry.path());
            }
        }
    }
    total
}

#[cfg(not(unix))]
fn disk_usage_bytes(path: &std::path::Path) -> u64 {
    crate::usage::dir_size_bytes(path).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_root_is_all_zero() {
        let dir = tempfile::tempdir().unwrap();
        let stats = collect_at(dir.path());
        assert_eq!(stats.task_records.count, 0);
        assert_eq!(stats.cas_blobs.count, 0);
        assert_eq!(stats.named_scopes, 0);
        assert_eq!(stats.named_bytes, 0);
        assert_eq!(stats.legacy_bytes, 0);
        assert_eq!(stats.total_bytes, 0);
        // The root directory itself still occupies at least one allocation
        // unit on a real filesystem, so raw_bytes isn't necessarily 0 — just
        // assert it doesn't error and stays small (no phantom file content).
        assert!(stats.raw_bytes < 1024 * 1024);
    }

    #[test]
    fn counts_and_sizes_tasks_blobs_and_named_scopes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(root.join("tasks/a.json"), b"12345").unwrap();
        std::fs::write(root.join("tasks/b.json"), b"12").unwrap();

        std::fs::create_dir_all(root.join("cas/blobs")).unwrap();
        std::fs::write(root.join("cas/blobs/deadbeef"), b"1234567").unwrap();

        std::fs::create_dir_all(root.join("named/shared/tool/v1")).unwrap();
        std::fs::write(root.join("named/shared/tool/v1/bin"), b"1234").unwrap();
        std::fs::create_dir_all(root.join("named/workspace-a/other/v1")).unwrap();

        std::fs::write(root.join("usage.db"), b"12").unwrap();

        let stats = collect_at(root);
        assert_eq!(stats.task_records.count, 2);
        assert_eq!(stats.task_records.bytes, 7);
        assert_eq!(stats.cas_blobs.count, 1);
        assert_eq!(stats.cas_blobs.bytes, 7);
        assert_eq!(stats.named_scopes, 2);
        assert_eq!(stats.named_bytes, 4);
        assert_eq!(stats.db_bytes, 2);
        assert!(stats.total_bytes >= stats.task_records.bytes + stats.cas_blobs.bytes);
        // Block-rounded disk usage is at least the apparent file content size.
        assert!(stats.raw_bytes >= stats.task_records.bytes + stats.cas_blobs.bytes);
    }
}
