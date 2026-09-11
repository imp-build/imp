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
    pub memo_traces: CountBytes,
    pub cas_blobs: CountBytes,
    pub named_scopes: usize,
    pub named_bytes: u64,
    pub legacy_bytes: u64,
    /// Paths in cache namespaces that do not match their namespace contract.
    /// Not store entries; `cache gc` removes them.
    pub unrecognised: CountBytes,
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

/// One `named/<scope>/<name>` cache directory: `scope_label` is the
/// checkout path recorded for the scope in `usage.db` (or the raw scope hash
/// if unrecorded), `"shared"` for the cross-workspace namespace.
#[derive(Debug, Clone)]
pub struct NamedCacheDetail {
    pub scope_label: String,
    pub name: String,
    pub count: usize,
    pub bytes: u64,
}

/// Per-scope, per-name breakdown of `named/`, largest first. A second level
/// of detail beyond `collect`'s single `named_scopes`/`named_bytes` total.
pub fn collect_named_details() -> Result<Vec<NamedCacheDetail>> {
    let root = crate::cache::cache_root()?;
    Ok(collect_named_details_at(&root))
}

fn collect_named_details_at(root: &std::path::Path) -> Vec<NamedCacheDetail> {
    let workspace_labels = load_workspace_labels(root);
    let named_root = root.join("named");

    let mut details = Vec::new();
    for (scope, scope_path) in crate::cache::read_sharded_scopes(&named_root).scopes {
        let scope_label = if scope == "shared" {
            scope.clone()
        } else {
            workspace_labels
                .get(&scope)
                .cloned()
                .unwrap_or_else(|| scope.clone())
        };

        let Ok(name_entries) = std::fs::read_dir(&scope_path) else {
            continue;
        };
        for name_entry in name_entries.flatten() {
            if !name_entry.path().is_dir() {
                continue;
            }
            let Ok(name) = name_entry.file_name().into_string() else {
                continue;
            };
            if crate::cache::validate_named_cache_component(&name).is_err() {
                continue;
            }
            details.push(NamedCacheDetail {
                scope_label: scope_label.clone(),
                name,
                count: count_files_recursive(&name_entry.path()),
                bytes: crate::usage::dir_size_bytes(&name_entry.path()).unwrap_or(0),
            });
        }
    }
    details.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    details
}

/// Workspace id → recorded checkout path, straight from `usage.db`. Missing
/// db or table just means every scope falls back to its raw hash label.
fn load_workspace_labels(root: &std::path::Path) -> std::collections::HashMap<String, String> {
    let Ok(conn) = rusqlite::Connection::open(root.join("usage.db")) else {
        return Default::default();
    };
    let Ok(mut statement) = conn.prepare("SELECT id, path FROM workspaces") else {
        return Default::default();
    };
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// Recursive file count under `path` (named-cache slots nest to an arbitrary
/// depth, unlike the fixed one-level shard buckets `count_bytes` handles).
fn count_files_recursive(path: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            count += count_files_recursive(&entry_path);
        } else {
            count += 1;
        }
    }
    count
}

fn collect_at(root: &std::path::Path) -> CacheStats {
    let (task_records, task_foreign) = count_bytes(&root.join("tasks"), ".json");
    let memo_trace_root = root.join("memo-traces");
    let memo_traces = CountBytes {
        count: count_files_recursive(&memo_trace_root),
        bytes: crate::usage::dir_size_bytes(&memo_trace_root).unwrap_or(0),
    };
    let memo_namespace = crate::cache::read_sharded_scopes(&memo_trace_root);
    let memo_foreign = count_foreign(&memo_namespace.foreign);
    let (cas_blobs, cas_foreign) = count_bytes(&root.join("cas").join("blobs"), "");
    let named_root = root.join("named");
    let named_namespace = crate::cache::read_sharded_scopes(&named_root);
    let mut named_foreign = named_namespace.foreign;
    for (_, scope_path) in &named_namespace.scopes {
        let Ok(entries) = std::fs::read_dir(scope_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if crate::cache::is_temp_name(&name) {
                continue;
            }
            if !entry.path().is_dir()
                || crate::cache::validate_named_cache_component(&name).is_err()
            {
                named_foreign.push(entry.path());
                continue;
            }
            let Ok(keys) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            for key in keys.flatten() {
                let key_name = key.file_name().to_string_lossy().into_owned();
                if crate::cache::is_temp_name(&key_name) {
                    continue;
                }
                if !key.path().is_dir()
                    || crate::cache::validate_named_cache_component(&key_name).is_err()
                {
                    named_foreign.push(key.path());
                }
            }
        }
    }
    let named_foreign = count_foreign(&named_foreign);
    let unrecognised = CountBytes {
        count: task_foreign.count + cas_foreign.count + memo_foreign.count + named_foreign.count,
        bytes: task_foreign.bytes + cas_foreign.bytes + memo_foreign.bytes + named_foreign.bytes,
    };

    let named_scopes = named_namespace.scopes.len();
    let named_bytes = crate::usage::dir_size_bytes(&named_root).unwrap_or(0);

    let legacy_bytes = crate::usage::dir_size_bytes(&root.join("cas").join("trees")).unwrap_or(0)
        + crate::usage::dir_size_bytes(&root.join("memo")).unwrap_or(0);

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
        memo_traces,
        cas_blobs,
        named_scopes,
        named_bytes,
        legacy_bytes,
        unrecognised,
        db_bytes,
        total_bytes,
        raw_bytes,
    }
}

fn count_foreign(paths: &[std::path::PathBuf]) -> CountBytes {
    let mut count = CountBytes::default();
    for path in paths {
        count.count += 1;
        count.bytes += if path.is_dir() {
            crate::usage::dir_size_bytes(path).unwrap_or(0)
        } else {
            std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        };
    }
    count
}

/// Count and total size of one sharded store namespace (`tasks/`,
/// `cas/blobs/`), split into recognised entries and unrecognised files.
/// Counts the shard buckets and any entry still at a pre-shard flat path
/// alike, and skips in-flight temp siblings, so the figure covers the whole
/// store while the old layout drains. `suffix` is the namespace file suffix
/// passed through to `read_store_namespace`.
fn count_bytes(dir: &std::path::Path, suffix: &str) -> (CountBytes, CountBytes) {
    let namespace = crate::cache::read_store_namespace(dir, suffix);
    let mut entries = CountBytes::default();
    for (_, path) in namespace.entries {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        entries.count += 1;
        entries.bytes += meta.len();
    }
    let mut foreign = CountBytes::default();
    for path in namespace.foreign {
        foreign.count += 1;
        foreign.bytes += if path.is_dir() {
            crate::usage::dir_size_bytes(&path).unwrap_or(0)
        } else {
            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };
    }
    (entries, foreign)
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
        assert_eq!(stats.memo_traces.count, 0);
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
        let sharded_key = format!("ab{}", "0".repeat(62));
        let flat_key = format!("cd{}", "1".repeat(62));
        let blob_digest = format!("de{}", "2".repeat(62));
        // One task record in its shard bucket and one still at a pre-shard
        // flat path: both count while an upgraded cache drains.
        std::fs::create_dir_all(root.join("tasks/ab")).unwrap();
        std::fs::write(
            root.join("tasks/ab").join(format!("{sharded_key}.json")),
            b"12345",
        )
        .unwrap();
        std::fs::write(root.join("tasks").join(format!("{flat_key}.json")), b"12").unwrap();
        // Neither a task key nor a blob digest: counted as unrecognised.
        std::fs::write(root.join("tasks/ab/scratch.json"), b"1234").unwrap();

        let memo_scope = "a".repeat(64);
        std::fs::create_dir_all(root.join("memo-traces").join(&memo_scope)).unwrap();
        std::fs::write(
            root.join("memo-traces").join(&memo_scope).join("a.json"),
            b"123",
        )
        .unwrap();

        std::fs::create_dir_all(root.join("cas/blobs/de")).unwrap();
        std::fs::write(root.join("cas/blobs/de").join(&blob_digest), b"1234567").unwrap();
        // An in-flight publish is not a store entry.
        std::fs::write(
            root.join("cas/blobs/de")
                .join(format!(".{blob_digest}.tmp-blob-1-2")),
            b"xx",
        )
        .unwrap();
        // A hand-placed file, likewise unrecognised.
        std::fs::write(root.join("cas/blobs/de/notes.txt"), b"123").unwrap();

        std::fs::create_dir_all(root.join("named/shared/tool/v1")).unwrap();
        std::fs::write(root.join("named/shared/tool/v1/bin"), b"1234").unwrap();
        std::fs::create_dir_all(root.join("named").join(&memo_scope).join("other/v1")).unwrap();

        std::fs::write(root.join("usage.db"), b"12").unwrap();

        let stats = collect_at(root);
        assert_eq!(stats.task_records.count, 2);
        assert_eq!(stats.task_records.bytes, 7);
        assert_eq!(
            stats.unrecognised.count, 2,
            "one stray file in each namespace"
        );
        assert_eq!(stats.unrecognised.bytes, 7);
        assert_eq!(stats.memo_traces.count, 1);
        assert_eq!(stats.memo_traces.bytes, 3);
        assert_eq!(stats.cas_blobs.count, 1);
        assert_eq!(stats.cas_blobs.bytes, 7);
        assert_eq!(stats.named_scopes, 2);
        assert_eq!(stats.named_bytes, 4);
        assert_eq!(stats.db_bytes, 2);
        assert!(stats.total_bytes >= stats.task_records.bytes + stats.cas_blobs.bytes);
        // Block-rounded disk usage is at least the apparent file content size.
        assert!(stats.raw_bytes >= stats.task_records.bytes + stats.cas_blobs.bytes);
    }

    #[test]
    fn named_details_break_down_per_scope_and_name_largest_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::create_dir_all(root.join("named/shared/small/v1")).unwrap();
        std::fs::write(root.join("named/shared/small/v1/f"), b"12").unwrap();
        let named_scope = "b".repeat(64);
        std::fs::create_dir_all(root.join("named").join(&named_scope).join("big/v1")).unwrap();
        std::fs::write(
            root.join("named").join(&named_scope).join("big/v1/f"),
            b"1234567890",
        )
        .unwrap();

        let conn = rusqlite::Connection::open(root.join("usage.db")).unwrap();
        conn.execute(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL, last_seen_at INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, path, last_seen_at) VALUES (?1, '/checkout/a', 0)",
            [&named_scope],
        )
        .unwrap();
        drop(conn);

        let details = collect_named_details_at(root);
        assert_eq!(details.len(), 2);
        assert_eq!(details[0].scope_label, "/checkout/a");
        assert_eq!(details[0].name, "big");
        assert_eq!(details[0].count, 1);
        assert_eq!(details[0].bytes, 10);
        assert_eq!(details[1].scope_label, "shared");
        assert_eq!(details[1].name, "small");
        assert_eq!(details[1].bytes, 2);
    }

    #[test]
    fn scope_counts_span_shard_buckets_and_pre_shard_flat_scopes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // One scope in its shard bucket, one still flat.
        let sharded = crate::cache::scope_shard_dir_in(root, "named", &"a".repeat(64));
        std::fs::create_dir_all(sharded.join("tool").join("v1")).unwrap();
        std::fs::write(sharded.join("tool").join("v1").join("f"), b"12345").unwrap();
        std::fs::create_dir_all(root.join("named/shared/tool/v1")).unwrap();
        std::fs::write(root.join("named/shared/tool/v1/f"), b"12").unwrap();

        std::fs::write(root.join("usage.db"), b"1").unwrap();

        let stats = collect_at(root);
        assert_eq!(stats.named_scopes, 2, "a bucket is not counted as a scope");
        assert_eq!(stats.named_bytes, 7);

        let details = collect_named_details_at(root);
        assert_eq!(details.len(), 2);
        assert_eq!(details[0].name, "tool");
        assert_eq!(details[0].bytes, 5);
    }

    #[test]
    fn malformed_named_paths_are_unrecognised() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("named/shared/good/v1")).unwrap();
        std::fs::write(root.join("named/shared/good/v1/file"), b"valid").unwrap();
        std::fs::create_dir_all(root.join("named/not-a-scope/tool/v1")).unwrap();
        std::fs::write(root.join("named/not-a-scope/tool/v1/file"), b"scope").unwrap();
        std::fs::create_dir_all(root.join("named/shared/bad name/v1")).unwrap();
        std::fs::write(root.join("named/shared/bad name/v1/file"), b"name").unwrap();
        std::fs::create_dir_all(root.join("named/shared/good/bad key")).unwrap();
        std::fs::write(root.join("named/shared/good/bad key/file"), b"key").unwrap();

        let stats = collect_at(root);
        assert_eq!(stats.named_scopes, 1);
        assert_eq!(stats.unrecognised.count, 3);
        assert!(stats.unrecognised.bytes >= 3);
        assert_eq!(collect_named_details_at(root).len(), 1);
    }
}
