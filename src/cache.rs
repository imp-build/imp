use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use walkdir::WalkDir;

pub(crate) const TASK_CACHE_VERSION: u32 = 5;

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheInputDigest {
    pub artifact_id: String,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CacheDirectoryEntry {
    pub(crate) path: String,
    pub(crate) digest: String,
    pub(crate) bytes: u64,
    #[serde(default)]
    pub(crate) mode: Option<u32>,
    /// Set instead of `digest`/`bytes`/`mode` for a symlink entry — its
    /// (possibly relative) link target, restored verbatim on materialization
    /// rather than treating it as a regular file to content-address.
    #[serde(default)]
    pub(crate) symlink_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CachedArtifact {
    pub(crate) artifact_id: String,
    pub(crate) kind: String,
    pub(crate) path: Option<String>,
    pub(crate) value: Option<String>,
    pub(crate) digest: String,
    pub(crate) bytes: Option<u64>,
    pub(crate) mode: Option<u32>,
    pub(crate) files: Vec<CacheDirectoryEntry>,
    /// When set, this output is also materialized into a named cache slot
    /// (in addition to its normal workspace-relative path), from CAS content —
    /// so it's replayed correctly on both fresh runs and task-cache hits.
    #[serde(default)]
    pub(crate) named_cache: Option<OutputNamedCache>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OutputNamedCache {
    pub(crate) name: String,
    pub(crate) key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TaskCacheRecord {
    pub(crate) version: u32,
    pub(crate) task_id: String,
    pub(crate) task_key: String,
    pub(crate) action_digest: String,
    pub(crate) input_digests: Vec<CacheInputDigest>,
    pub(crate) named_caches: Vec<NamedCacheBinding>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) outputs: Vec<CachedArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedCacheBinding {
    pub name: String,
    pub env_var: String,
    pub path: PathBuf,
}

// ---------------------------------------------------------------------------
// Named cache key path
// ---------------------------------------------------------------------------

pub(crate) fn named_cache_key_path(
    workspace_root: &Path,
    name: &str,
    key: &str,
) -> Result<PathBuf> {
    let root = cache_root()?
        .join("named")
        .join(workspace_cache_id(workspace_root))
        .join(name)
        .join(key);
    Ok(root)
}

// ---------------------------------------------------------------------------
// Embedded-output and cache-disabled materialization helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sandbox preparation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CAS and task cache functions
// ---------------------------------------------------------------------------

/// Base directory under which per-run sandbox roots are created. Defaults to
/// `/tmp/imp`; `IMP_SANDBOX_DIR` overrides it (mirroring `IMP_CACHE_DIR`)
/// so tests can point sandboxes at an isolated, inspectable location.
pub(crate) fn sandbox_base_dir() -> PathBuf {
    std::env::var_os("IMP_SANDBOX_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/imp"))
}

pub(crate) fn create_sandbox_root() -> Result<PathBuf> {
    static SANDBOX_COUNTER: AtomicU64 = AtomicU64::new(0);

    let base = sandbox_base_dir();
    std::fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;
    for _ in 0..100 {
        let unique = format!(
            "sandbox-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            SANDBOX_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let root = base.join(unique);
        match std::fs::create_dir(&root) {
            Ok(()) => return Ok(root),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create sandbox {}", root.display()));
            }
        }
    }
    bail!("failed to create unique sandbox under {}", base.display())
}

pub(crate) fn cache_root() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::var_os("IMP_CACHE_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(cache) = std::env::var_os("XDG_CACHE_HOME") {
        candidates.push(PathBuf::from(cache).join("imp"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".cache").join("imp"));
    }
    candidates.push(PathBuf::from("/tmp/imp/cache"));

    let mut last_error = None;
    for candidate in candidates {
        match std::fs::create_dir_all(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) => last_error = Some((candidate, error)),
        }
    }

    if let Some((candidate, error)) = last_error {
        bail!("create cache root {}: {error}", candidate.display());
    }
    bail!("no cache root candidates available")
}

/// Ensure `<cache_root>/native-tools/<name>/<name>` is a symlink to `resolved`,
/// creating or repairing it if missing/stale. Returns the tool-root directory.
/// Bypasses cachePut (see copy_dir_into in spike.rs) because that path
/// dereferences symlinks into real-byte copies; run()'s tool materialization
/// is expected to symlink the tool root wholesale, so the artifact itself
/// must already be the symlink, not a copy.
pub(crate) fn ensure_native_tool_artifact(name: &str, resolved: &Path) -> Result<PathBuf> {
    crate::exec::validate_tool_name(name)?;
    let root = cache_root()?.join("native-tools").join(name);
    std::fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
    let link = root.join(name);
    if std::fs::read_link(&link).ok().as_deref() != Some(resolved) {
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(resolved, &link)
            .with_context(|| format!("symlink {} -> {}", link.display(), resolved.display()))?;
        #[cfg(not(unix))]
        std::fs::copy(resolved, &link)
            .with_context(|| format!("copy {} -> {}", resolved.display(), link.display()))?;
    }
    Ok(root)
}

pub(crate) fn workspace_cache_id(workspace_root: &Path) -> String {
    digest_bytes(workspace_root.to_string_lossy().as_bytes())
}

pub(crate) fn cas_blob_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("cas").join("blobs").join(digest))
}

fn cas_meta_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?
        .join("cas")
        .join("meta")
        .join(format!("{digest}.json")))
}

pub(crate) fn task_record_path(task_key: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("tasks").join(format!("{task_key}.json")))
}

pub(crate) fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn digest_json<T: Serialize>(value: &T) -> Result<String> {
    let encoded = serde_json::to_vec(value).context("serialize digest input")?;
    Ok(digest_bytes(&encoded))
}

// ---------------------------------------------------------------------------
// Tool fingerprints
// ---------------------------------------------------------------------------

pub(crate) fn store_blob(bytes: &[u8], kind: &str) -> Result<String> {
    let digest = digest_bytes(bytes);
    let blob_path = cas_blob_path(&digest)?;
    if !blob_path.is_file() {
        if let Some(parent) = blob_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let temp = temp_sibling_path(&blob_path, "tmp-blob");
        std::fs::write(&temp, bytes).with_context(|| format!("write {}", temp.display()))?;
        std::fs::rename(&temp, &blob_path).with_context(|| {
            format!("publish blob {} to {}", temp.display(), blob_path.display())
        })?;
    }

    let meta_path = cas_meta_path(&digest)?;
    if !meta_path.is_file() {
        if let Some(parent) = meta_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let metadata = serde_json::json!({
            "digest": digest,
            "kind": kind,
            "bytes": bytes.len(),
        });
        std::fs::write(&meta_path, serde_json::to_vec_pretty(&metadata)?)
            .with_context(|| format!("write {}", meta_path.display()))?;
    }
    Ok(digest)
}

pub(crate) fn store_file_blob(path: &Path, kind: &str) -> Result<(String, u64)> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let size = bytes.len() as u64;
    Ok((store_blob(&bytes, kind)?, size))
}

pub(crate) fn directory_entries(path: &Path) -> Result<Vec<CacheDirectoryEntry>> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(path) {
        let entry = entry.with_context(|| format!("walk {}", path.display()))?;
        let is_symlink = entry.file_type().is_symlink();
        if !entry.file_type().is_file() && !is_symlink {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .with_context(|| format!("strip {} from {}", path.display(), entry.path().display()))?;
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if is_symlink {
            let target = std::fs::read_link(entry.path())
                .with_context(|| format!("read symlink {}", entry.path().display()))?;
            entries.push(CacheDirectoryEntry {
                path: relative,
                digest: String::new(),
                bytes: 0,
                mode: None,
                symlink_target: Some(target.to_string_lossy().into_owned()),
            });
            continue;
        }
        let (digest, bytes) = store_file_blob(entry.path(), "directory-entry")?;
        entries.push(CacheDirectoryEntry {
            path: relative,
            digest,
            bytes,
            mode: file_mode(entry.path())?,
            symlink_target: None,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

pub(crate) fn artifact_relative_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        bail!(
            "artifact path {} must be relative for sandbox execution",
            path.display()
        );
    }

    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(component) => relative.push(component),
            std::path::Component::CurDir => {}
            _ => bail!(
                "artifact path {} must not contain parent or prefix components",
                path.display()
            ),
        }
    }
    if relative.as_os_str().is_empty() {
        bail!("artifact path must not be empty");
    }
    Ok(relative)
}

pub(crate) fn cached_outputs_present(record: &TaskCacheRecord) -> Result<()> {
    for output in &record.outputs {
        match output.kind.as_str() {
            "file" | "manifest" => {
                let path = cas_blob_path(&output.digest)?;
                if !path.is_file() {
                    bail!(
                        "{} cached blob {} is missing",
                        output.artifact_id,
                        path.display()
                    );
                }
            }
            "directory" => {
                for file in &output.files {
                    let path = cas_blob_path(&file.digest)?;
                    if !path.is_file() {
                        bail!(
                            "{} cached directory blob {} is missing",
                            output.artifact_id,
                            path.display()
                        );
                    }
                }
            }
            "value" => {}
            other => bail!(
                "{} has unsupported cached artifact kind {other}",
                output.artifact_id
            ),
        }
    }
    Ok(())
}

pub(crate) fn write_task_cache_record(record: &TaskCacheRecord) -> Result<()> {
    let path = task_record_path(&record.task_key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(&path, "tmp-record");
    std::fs::write(&temp, serde_json::to_vec_pretty(record)?)
        .with_context(|| format!("write {}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish task cache record {}", path.display()))?;
    Ok(())
}

pub(crate) fn materialize_cached_outputs(
    record: &TaskCacheRecord,
    workspace_root: &Path,
) -> Result<()> {
    for output in &record.outputs {
        let Some(path) = &output.path else {
            continue;
        };
        let destination = workspace_root.join(artifact_relative_path(path)?);
        match output.kind.as_str() {
            "file" | "manifest" => {
                let source = cas_blob_path(&output.digest)?;
                publish_file_atomically(&source, &destination)?;
                restore_file_mode(&destination, output.mode)?;
            }
            "directory" => materialize_cached_directory(output, &destination)?,
            "value" => {}
            other => bail!(
                "{} has unsupported cached output artifact kind {other}",
                output.artifact_id
            ),
        }
    }
    Ok(())
}

/// Materialize any outputs bound to a named cache slot (via `output({ namedCache })`)
/// from their CAS content. Runs after both fresh executions and task-cache hits, so a
/// named cache wiped between runs is transparently repopulated.
pub(crate) fn materialize_named_caches(
    record: &TaskCacheRecord,
    workspace_root: &Path,
) -> Result<()> {
    for output in &record.outputs {
        let Some(named_cache) = &output.named_cache else {
            continue;
        };
        let destination =
            named_cache_key_path(workspace_root, &named_cache.name, &named_cache.key)?;
        match output.kind.as_str() {
            "directory" => materialize_cached_directory(output, &destination)?,
            "file" | "manifest" => {
                std::fs::create_dir_all(&destination)
                    .with_context(|| format!("create {}", destination.display()))?;
                let file_name = output
                    .path
                    .as_deref()
                    .and_then(|p| Path::new(p).file_name())
                    .ok_or_else(|| anyhow::anyhow!("{} has no file name", output.artifact_id))?;
                let source = cas_blob_path(&output.digest)?;
                publish_file_atomically(&source, &destination.join(file_name))?;
            }
            other => bail!(
                "{} cannot be bound to a named cache: unsupported kind {other}",
                output.artifact_id
            ),
        }
    }
    Ok(())
}

fn materialize_cached_directory(output: &CachedArtifact, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(destination, "tmp-dir");
    remove_path_if_exists(&temp)?;
    std::fs::create_dir_all(&temp).with_context(|| format!("create {}", temp.display()))?;
    for file in &output.files {
        let relative = artifact_relative_path(&file.path)?;
        let dest = temp.join(relative);
        if let Some(target) = &file.symlink_target {
            create_symlink(target, &dest)?;
            continue;
        }
        let source = cas_blob_path(&file.digest)?;
        copy_file(&source, &dest)?;
        restore_file_mode(&dest, file.mode)?;
    }
    remove_path_if_exists(destination)?;
    std::fs::rename(&temp, destination).with_context(|| {
        format!(
            "publish directory {} to {}",
            temp.display(),
            destination.display()
        )
    })?;
    Ok(())
}

pub(crate) fn remove_path_if_exists(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path)
            .with_context(|| format!("remove directory {}", path.display())),
        Ok(_) => {
            std::fs::remove_file(path).with_context(|| format!("remove file {}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("stat {}", path.display())),
    }
}

fn publish_file_atomically(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(destination, "tmp-file");
    copy_file(source, &temp)?;
    std::fs::rename(&temp, destination).with_context(|| {
        format!(
            "publish file {} to {}",
            temp.display(),
            destination.display()
        )
    })?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn create_symlink(target: &str, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::os::unix::fs::symlink(target, dest)
        .with_context(|| format!("symlink {} -> {}", dest.display(), target))
}

#[cfg(not(unix))]
pub(crate) fn create_symlink(_target: &str, _dest: &Path) -> Result<()> {
    bail!("directory outputs containing symlinks are not supported on this platform")
}

#[cfg(unix)]
pub(crate) fn file_mode(path: &Path) -> Result<Option<u32>> {
    Ok(Some(std::fs::metadata(path)?.permissions().mode() & 0o7777))
}

#[cfg(not(unix))]
pub(crate) fn file_mode(_path: &Path) -> Result<Option<u32>> {
    Ok(None)
}

#[cfg(unix)]
pub(crate) fn restore_file_mode(path: &Path, mode: Option<u32>) -> Result<()> {
    let Some(mode) = mode else {
        return Ok(());
    };
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("set permissions {:o} on {}", mode, path.display()))
}

#[cfg(not(unix))]
pub(crate) fn restore_file_mode(_path: &Path, _mode: Option<u32>) -> Result<()> {
    Ok(())
}

pub(crate) fn temp_sibling_path(destination: &Path, suffix: &str) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("artifact");
    let temp_name = format!(
        ".{file_name}.{suffix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    destination.with_file_name(temp_name)
}

pub(crate) fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::copy(source, destination)
        .with_context(|| format!("copy {} to {}", source.display(), destination.display()))?;
    Ok(())
}

pub(crate) fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    for entry in WalkDir::new(source) {
        let entry = entry.with_context(|| format!("walk {}", source.display()))?;
        let relative = entry.path().strip_prefix(source).with_context(|| {
            format!("strip {} from {}", source.display(), entry.path().display())
        })?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)
                .with_context(|| format!("create {}", target.display()))?;
        } else if entry.file_type().is_file() {
            copy_file(entry.path(), &target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cache explain (public API)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_entries_round_trips_a_symlink() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("real"), b"hello").unwrap();
        std::os::unix::fs::symlink("real", source.path().join("link")).unwrap();

        let entries = directory_entries(source.path()).unwrap();
        let link_entry = entries.iter().find(|e| e.path == "link").unwrap();
        assert_eq!(link_entry.symlink_target.as_deref(), Some("real"));

        let artifact = CachedArtifact {
            artifact_id: "test".to_owned(),
            kind: "directory".to_owned(),
            path: Some("test".to_owned()),
            value: None,
            digest: digest_json(&entries).unwrap(),
            bytes: None,
            mode: None,
            files: entries,
            named_cache: None,
        };

        let dest = tempfile::tempdir().unwrap();
        let destination = dest.path().join("out");
        materialize_cached_directory(&artifact, &destination).unwrap();

        let restored_target = std::fs::read_link(destination.join("link")).unwrap();
        assert_eq!(restored_target, Path::new("real"));
        assert_eq!(
            std::fs::read_to_string(destination.join("link")).unwrap(),
            "hello"
        );
    }
}
