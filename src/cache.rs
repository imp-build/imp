use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use walkdir::WalkDir;


pub(crate) const TASK_CACHE_VERSION: u32 = 4;

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TaskCacheRecord {
    pub(crate) version: u32,
    pub(crate) task_id: String,
    pub(crate) task_key: String,
    pub(crate) action_digest: String,
    pub(crate) input_digests: Vec<CacheInputDigest>,
    pub(crate) named_caches: Vec<NamedCacheBinding>,
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

pub(crate) fn create_sandbox_root() -> Result<PathBuf> {
    static SANDBOX_COUNTER: AtomicU64 = AtomicU64::new(0);

    let base = PathBuf::from("/tmp/imp");
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
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .with_context(|| format!("strip {} from {}", path.display(), entry.path().display()))?;
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let (digest, bytes) = store_file_blob(entry.path(), "directory-entry")?;
        entries.push(CacheDirectoryEntry {
            path: relative,
            digest,
            bytes,
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

fn materialize_cached_directory(output: &CachedArtifact, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(destination, "tmp-dir");
    remove_path_if_exists(&temp)?;
    std::fs::create_dir_all(&temp).with_context(|| format!("create {}", temp.display()))?;
    for file in &output.files {
        let relative = artifact_relative_path(&file.path)?;
        let source = cas_blob_path(&file.digest)?;
        copy_file(&source, &temp.join(relative))?;
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

