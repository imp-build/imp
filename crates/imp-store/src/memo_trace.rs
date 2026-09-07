use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use std::collections::HashSet;

use crate::cache::{
    cache_root, digest_bytes, scope_shard_dir_in, temp_sibling_path, workspace_cache_id,
};

pub const MEMO_TRACE_VERSION: u32 = 1;

/// One declared input a memoized call observed while it ran. Persisted traces
/// retain specifications rather than only resolved values so change detection
/// can predict whether a changed path would be read on the next invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputSpecRecord {
    /// "config_namespaces" | "read_file" | "fileset" | "run_input"
    pub kind: String,
    pub spec: serde_json::Value,
    pub resolved_digest: Option<String>,
}

/// Restart-stable provenance for one successfully completed memoized call.
///
/// Results are deliberately absent: `memo()` is an in-process deduplication
/// primitive, while cross-process heavy-work reuse belongs to the task cache
/// and CAS. These records exist only for change detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoTraceRecord {
    pub version: u32,
    pub key: String,
    pub fn_id: String,
    pub module_digest: String,
    pub input_specs: Vec<InputSpecRecord>,
    pub deps: Vec<String>,
}

/// The sharded scope directory for a workspace's memo traces:
/// `memo-traces/<bucket>/<workspace-id>/`. See `scope_shard_dir_in`.
pub fn memo_trace_scope_path(workspace_root: &Path) -> Result<PathBuf> {
    let id = workspace_cache_id(workspace_root);
    Ok(scope_shard_dir_in(&cache_root()?, "memo-traces", &id))
}

/// The pre-shard flat scope directory an upgraded cache may still hold
/// records in until garbage collection drains it.
fn flat_memo_trace_scope_path(workspace_root: &Path) -> Result<PathBuf> {
    Ok(cache_root()?
        .join("memo-traces")
        .join(workspace_cache_id(workspace_root)))
}

pub fn memo_trace_record_path(workspace_root: &Path, key: &str) -> Result<PathBuf> {
    let hash = digest_bytes(key.as_bytes());
    Ok(memo_trace_scope_path(workspace_root)?.join(format!("{hash}.json")))
}

/// Every trace record for one workspace, from the sharded scope directory
/// unioned with the pre-shard flat one (sharded wins a same-name collision,
/// though the bytes are equal). Invalid or older-format records are ignored
/// so cache corruption or schema turnover only makes change detection
/// conservative.
pub fn list_memo_trace_records(workspace_root: &Path) -> Result<Vec<MemoTraceRecord>> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for dir in [
        memo_trace_scope_path(workspace_root)?,
        flat_memo_trace_scope_path(workspace_root)?,
    ] {
        collect_trace_records(&dir, &mut seen, &mut records);
    }
    Ok(records)
}

fn collect_trace_records(
    dir: &Path,
    seen: &mut HashSet<String>,
    records: &mut Vec<MemoTraceRecord>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !seen.insert(name) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<MemoTraceRecord>(&bytes) else {
            continue;
        };
        if record.version == MEMO_TRACE_VERSION {
            records.push(record);
        }
    }
}

pub fn write_memo_trace_record(workspace_root: &Path, record: &MemoTraceRecord) -> Result<()> {
    let path = memo_trace_record_path(workspace_root, &record.key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let encoded = serde_json::to_vec_pretty(record)?;
    let temp = temp_sibling_path(&path, "tmp-memo-trace");
    std::fs::write(&temp, &encoded).with_context(|| format!("write {}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish memo trace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_are_workspace_scoped_and_ignore_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_a = dir.path().join("workspace-a");
        let workspace_b = dir.path().join("workspace-b");
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();

        let record = MemoTraceRecord {
            version: MEMO_TRACE_VERSION,
            key: "abc".to_owned(),
            fn_id: "myFn@rules/foo.js:1:1".to_owned(),
            module_digest: "deadbeef".to_owned(),
            input_specs: vec![InputSpecRecord {
                kind: "config_namespaces".to_owned(),
                spec: serde_json::json!(["rust"]),
                resolved_digest: Some("abc123".to_owned()),
            }],
            deps: vec!["callee@rules/bar.js:2:2".to_owned()],
        };

        write_memo_trace_record(&workspace_a, &record).unwrap();
        assert_eq!(
            list_memo_trace_records(&workspace_a).unwrap(),
            vec![record.clone()]
        );
        assert!(list_memo_trace_records(&workspace_b).unwrap().is_empty());

        let scope = memo_trace_scope_path(&workspace_a).unwrap();
        std::fs::write(scope.join("garbage.json"), b"{ not valid").unwrap();
        std::fs::write(scope.join("not-json.txt"), b"ignore me").unwrap();
        assert_eq!(list_memo_trace_records(&workspace_a).unwrap(), vec![record]);
    }

    #[test]
    fn a_pre_shard_flat_scope_is_unioned_with_the_sharded_one() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();

        let record = |key: &str| MemoTraceRecord {
            version: MEMO_TRACE_VERSION,
            key: key.to_owned(),
            fn_id: "f@rules/x.js:1:1".to_owned(),
            module_digest: "d".to_owned(),
            input_specs: vec![],
            deps: vec![],
        };

        // A record left behind at the pre-shard flat path.
        let flat_dir = flat_memo_trace_scope_path(&workspace).unwrap();
        std::fs::create_dir_all(&flat_dir).unwrap();
        let flat_record = record("flat-key");
        std::fs::write(
            flat_dir.join(format!("{}.json", digest_bytes(b"flat-key"))),
            serde_json::to_vec(&flat_record).unwrap(),
        )
        .unwrap();

        // A record written the new way, sharded.
        let sharded_record = record("sharded-key");
        write_memo_trace_record(&workspace, &sharded_record).unwrap();

        let mut got = list_memo_trace_records(&workspace).unwrap();
        got.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(got, vec![flat_record, sharded_record]);
    }
}
