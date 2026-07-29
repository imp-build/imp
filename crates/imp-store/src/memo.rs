use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::cache::{cache_root, digest_bytes, temp_sibling_path};

pub const MEMO_CACHE_VERSION: u32 = 1;

/// One declared read a persisted memo call made while it ran, recorded so a
/// later process can decide whether the cached `result` is still valid
/// without knowing in advance what the call would read (see
/// `_stable_function_id`/`memo()` in `imp_core.js` — the persisted key is
/// deliberately `(fn_id, args_digest)` only, since a config- or
/// read-scoped digest can't be computed before the call has actually run).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputSpecRecord {
    /// "config_namespaces" | "read_file" | "fileset" | "run_input"
    pub kind: String,
    /// For "config_namespaces": the sorted namespace list read this call.
    /// For "read_file": the path read. For "fileset": the FileSet spec
    /// object (`{__fileset, kind, root, include, exclude}` or union/literal
    /// form) that was resolved during the call. For "run_input": the
    /// `{kind, path}` declaration passed to `run({inputs})`.
    pub spec: serde_json::Value,
    /// The digest of this input's value at the time the record was written.
    /// `None` for a "fileset" spec that was returned but never resolved
    /// during the call itself (nothing to validate against; the spec is
    /// replayed as-is and resolved lazily by the caller, same as a fresh
    /// `glob()`).
    pub resolved_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoCacheRecord {
    pub version: u32,
    /// `digest_json({fn_id, args_digest})` — the bucket key. Kept alongside
    /// the hashed filename for debugging/inspection.
    pub key: String,
    pub fn_id: String,
    /// Content digest of the declaring module's source, so an edit to the
    /// rule file invalidates entries even when `fn_id`'s call-site string is
    /// unchanged (e.g. a line inserted then removed elsewhere in the file).
    pub module_digest: String,
    pub result: serde_json::Value,
    pub input_specs: Vec<InputSpecRecord>,
    /// Callee keys this call invoked (mirrors one caller's edges out of
    /// `_memo_deps` in `imp_core.js`), for reverse-dependency queries.
    pub deps: Vec<String>,
}

pub fn memo_record_path(key: &str) -> Result<PathBuf> {
    let hash = digest_bytes(key.as_bytes());
    Ok(cache_root()?.join("memo").join(format!("{hash}.json")))
}

pub fn read_memo_record(key: &str) -> Result<Option<MemoCacheRecord>> {
    let path = memo_record_path(key)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let record: MemoCacheRecord =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    if record.version != MEMO_CACHE_VERSION {
        return Ok(None);
    }
    Ok(Some(record))
}

/// Every persisted memo record, for building a change-detection index over
/// their `input_specs`/`deps` (see `imp-engine::trace_changed`). Unparsable
/// or version-mismatched entries are skipped rather than failing the scan —
/// a stale or partially written cache directory shouldn't block detection.
pub fn list_memo_records() -> Result<Vec<MemoCacheRecord>> {
    let dir = cache_root()?.join("memo");
    let mut records = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(records);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<MemoCacheRecord>(&bytes) else {
            continue;
        };
        if record.version != MEMO_CACHE_VERSION {
            continue;
        }
        records.push(record);
    }
    Ok(records)
}

pub fn write_memo_record(record: &MemoCacheRecord) -> Result<()> {
    let path = memo_record_path(&record.key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let encoded = serde_json::to_vec_pretty(record)?;
    let temp = temp_sibling_path(&path, "tmp-memo");
    std::fs::write(&temp, &encoded).with_context(|| format!("write {}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish memo record {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `cache_root()` resolves via the process-global `IMP_CACHE_DIR` env
    // var, so both cases run in one test — parallel tests setting/unsetting
    // it would race each other.
    #[test]
    fn round_trips_and_reports_missing_records() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("IMP_CACHE_DIR", dir.path());

        assert!(read_memo_record("nope").unwrap().is_none());
        assert!(list_memo_records().unwrap().is_empty());

        let record = MemoCacheRecord {
            version: MEMO_CACHE_VERSION,
            key: "abc".to_owned(),
            fn_id: "myFn@rules/foo.js:1:1".to_owned(),
            module_digest: "deadbeef".to_owned(),
            result: serde_json::json!({"ok": true}),
            input_specs: vec![InputSpecRecord {
                kind: "config_namespaces".to_owned(),
                spec: serde_json::json!(["rust"]),
                resolved_digest: Some("abc123".to_owned()),
            }],
            deps: vec!["callee@rules/bar.js:2:2".to_owned()],
        };

        write_memo_record(&record).unwrap();
        let loaded = read_memo_record(&record.key).unwrap().unwrap();
        assert_eq!(loaded, record);

        let listed = list_memo_records().unwrap();
        assert_eq!(listed, vec![record.clone()]);

        // Garbage alongside a real record is skipped, not fatal.
        let memo_dir = dir.path().join("memo");
        std::fs::write(memo_dir.join("not-json.txt"), b"ignore me").unwrap();
        std::fs::write(memo_dir.join("garbage.json"), b"{ not valid").unwrap();
        let listed = list_memo_records().unwrap();
        assert_eq!(listed, vec![record]);

        std::env::remove_var("IMP_CACHE_DIR");
    }
}
