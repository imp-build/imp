use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use walkdir::WalkDir;

pub const TASK_CACHE_VERSION: u32 = 6;

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedArtifact {
    pub artifact_id: String,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
    pub digest: String,
    pub bytes: Option<u64>,
    pub mode: Option<u32>,
    /// For `kind: "directory"` outputs: the digest of the root `DigestNode` for
    /// this directory's tree (see `crate::digest`), used to materialize/verify it
    /// without walking a flat file list. `None` for every other kind.
    #[serde(default)]
    pub tree_digest: Option<String>,
    /// When set, this output is also materialized into a named cache slot
    /// (in addition to its normal workspace-relative path), from CAS content —
    /// so it's replayed correctly on both fresh runs and task-cache hits.
    #[serde(default)]
    pub named_cache: Option<OutputNamedCache>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputNamedCache {
    pub name: String,
    pub key: String,
    /// Slot lives in the cross-workspace `named/shared/` namespace instead of
    /// the per-workspace one. See `named_cache_scope_id`.
    #[serde(default)]
    pub shared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCacheRecord {
    pub version: u32,
    pub task_id: String,
    pub task_key: String,
    pub action_digest: String,
    /// Root digest of the merged tree over every declared input (see
    /// `crate::digest::merge_digests`) — replaces a flat per-file digest list.
    pub input_digest: String,
    /// Root digest of the merged tree over everything this task produced, so a
    /// later `run({inputs})` can reference it directly (as a `{kind:"digest"}`
    /// entry) without round-tripping through the workspace.
    pub output_digest: String,
    pub named_caches: Vec<NamedCacheBinding>,
    pub stdout: String,
    pub stderr: String,
    pub outputs: Vec<CachedArtifact>,
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

pub fn named_cache_key_path(workspace_root: &Path, name: &str, key: &str) -> Result<PathBuf> {
    named_cache_key_path_by_id(&workspace_cache_id(workspace_root), name, key)
}

/// Namespace segment for a named cache slot: shared caches (immutable,
/// version-keyed toolchains) collapse into a single `shared` namespace so
/// every checkout resolves the same slot; everything else stays under the
/// workspace id. "shared" cannot collide with an id — those are 64-hex digests.
pub fn named_cache_scope_id<'a>(shared: bool, workspace_id: &'a str) -> &'a str {
    if shared {
        "shared"
    } else {
        workspace_id
    }
}

pub fn named_cache_key_path_by_id(workspace_id: &str, name: &str, key: &str) -> Result<PathBuf> {
    let root = cache_root()?
        .join("named")
        .join(workspace_id)
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
pub fn sandbox_base_dir() -> PathBuf {
    std::env::var_os("IMP_SANDBOX_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/imp"))
}

pub fn create_sandbox_root() -> Result<PathBuf> {
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

pub fn cache_root() -> Result<PathBuf> {
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

/// Validate a tool name for use as a path component under the cache's
/// native-tools/tool roots. Shared by exec's tool materialization and the
/// native-tool artifact registration below.
pub fn validate_tool_name(name: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        bail!("tool name '{name}' must contain only ASCII letters, digits, '-', '_' or '.'");
    }
    Ok(())
}

/// Ensure `<cache_root>/native-tools/<name>/<name>` is a symlink to `resolved`,
/// creating or repairing it if missing/stale. Returns the tool-root directory.
/// Bypasses cachePut (see copy_dir_into in spike.rs) because that path
/// dereferences symlinks into real-byte copies; run()'s tool materialization
/// is expected to symlink the tool root wholesale, so the artifact itself
/// must already be the symlink, not a copy.
pub fn ensure_native_tool_artifact(name: &str, resolved: &Path) -> Result<PathBuf> {
    validate_tool_name(name)?;
    let root = cache_root()?.join("native-tools").join(name);
    std::fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
    let link = root.join(native_tool_artifact_filename(name, resolved));
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

#[cfg(windows)]
fn native_tool_artifact_filename(name: &str, resolved: &Path) -> String {
    resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!("{name}.{ext}"))
        .unwrap_or_else(|| name.to_owned())
}

#[cfg(not(windows))]
fn native_tool_artifact_filename(name: &str, _resolved: &Path) -> String {
    name.to_owned()
}

pub fn workspace_cache_id(workspace_root: &Path) -> String {
    digest_bytes(workspace_root.to_string_lossy().as_bytes())
}

pub fn cas_blob_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("cas").join("blobs").join(digest))
}

fn cas_meta_path(digest: &str) -> Result<PathBuf> {
    Ok(cache_root()?
        .join("cas")
        .join("meta")
        .join(format!("{digest}.json")))
}

pub fn task_record_path(task_key: &str) -> Result<PathBuf> {
    Ok(cache_root()?.join("tasks").join(format!("{task_key}.json")))
}

pub fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn digest_json<T: Serialize>(value: &T) -> Result<String> {
    let encoded = serde_json::to_vec(value).context("serialize digest input")?;
    Ok(digest_bytes(&encoded))
}

// ---------------------------------------------------------------------------
// Tool fingerprints
// ---------------------------------------------------------------------------

pub fn store_blob(bytes: &[u8], kind: &str) -> Result<String> {
    let digest = digest_bytes(bytes);
    crate::usage::record_use(crate::usage::UsageKind::Cas, &digest);
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

pub fn store_file_blob(path: &Path, kind: &str) -> Result<(String, u64)> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let size = bytes.len() as u64;
    Ok((store_blob(&bytes, kind)?, size))
}

pub fn artifact_relative_path(path: &str) -> Result<PathBuf> {
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

pub fn cached_outputs_present(record: &TaskCacheRecord) -> Result<()> {
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
                // Only the root of the tree is checked here — a cheap, constant-cost
                // check regardless of how many files the directory contains. A blob
                // missing deeper in the tree surfaces as an error at materialization
                // time instead of here; this trades a slightly later failure for
                // avoiding an O(files) walk on every cache lookup.
                let tree_digest = output.tree_digest.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} is a directory output with no tree_digest",
                        output.artifact_id
                    )
                })?;
                let path = cas_blob_path(tree_digest)?;
                if !path.is_file() {
                    bail!(
                        "{} cached directory tree {} is missing",
                        output.artifact_id,
                        path.display()
                    );
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

pub fn write_task_cache_record(record: &TaskCacheRecord) -> Result<()> {
    let path = task_record_path(&record.task_key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(&path, "tmp-record");
    std::fs::write(&temp, serde_json::to_vec_pretty(record)?)
        .with_context(|| format!("write {}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish task cache record {}", path.display()))?;
    crate::usage::record_use(crate::usage::UsageKind::Task, &record.task_key);
    Ok(())
}

pub fn materialize_cached_outputs(record: &TaskCacheRecord, workspace_root: &Path) -> Result<()> {
    materialize_cached_artifacts(&record.outputs, workspace_root)
}

pub fn materialize_cached_artifacts(
    outputs: &[CachedArtifact],
    workspace_root: &Path,
) -> Result<()> {
    for output in outputs {
        let Some(path) = &output.path else {
            continue;
        };
        let destination = workspace_root.join(artifact_relative_path(path)?);
        match output.kind.as_str() {
            "file" | "manifest" => {
                crate::usage::record_use(crate::usage::UsageKind::Cas, &output.digest);
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
pub fn materialize_named_cache_artifacts(
    outputs: &[CachedArtifact],
    workspace_id: &str,
) -> Result<()> {
    for output in outputs {
        let Some(named_cache) = &output.named_cache else {
            continue;
        };
        let scope_id = named_cache_scope_id(named_cache.shared, workspace_id);
        let destination =
            named_cache_key_path_by_id(scope_id, &named_cache.name, &named_cache.key)?;
        crate::usage::record_named_use(scope_id, &named_cache.name, &named_cache.key);
        // Slots are immutable by key and published atomically (temp + rename),
        // so an existing destination is complete — skip the re-copy. This is
        // what makes repeated task-cache hits (and concurrent acquires from
        // different workspaces on shared slots) cheap and safe.
        if destination.exists() {
            continue;
        }
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

/// Materialize a `kind: "directory"` output's tree into the workspace (or a named
/// cache slot). Always copies — never hardlinks — since a file landing in the
/// workspace may be edited by a user or tool afterward, which would silently
/// corrupt the shared CAS blob if it were linked instead of copied.
fn materialize_cached_directory(output: &CachedArtifact, destination: &Path) -> Result<()> {
    let tree_digest = output.tree_digest.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "{} is a directory output with no tree_digest",
            output.artifact_id
        )
    })?;
    let tree = crate::digest::DigestTrie::load(tree_digest)?;

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = temp_sibling_path(destination, "tmp-dir");
    remove_path_if_exists(&temp)?;
    crate::digest::materialize_trie(&tree, &temp, false)?;
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

/// Materialize an arbitrary digest (optionally narrowed via `from`) directly
/// into the workspace at `destination`, bypassing `run()` entirely — no
/// sandbox, no cache record, no process spawn. This is the primitive behind
/// `writeWorkspace()`. `from` may resolve to a directory (published wholesale
/// under `destination`, as used by `package` products publishing to `dist/`)
/// or to an individual file/symlink (published at exactly `destination`,
/// leaving any sibling paths untouched) — a digest already knows the content
/// of every file it contains, so publishing one file out of it needs no more
/// capture work than publishing the whole subtree. Always copies, never
/// hardlinks, for the same reason as `materialize_cached_directory`.
pub fn write_workspace(digest: &str, from: Option<&str>, destination: &Path) -> Result<()> {
    let root = crate::digest::DirectoryDigest::from_digest(digest.to_string());
    let resolved = match from {
        Some(path) => crate::digest::resolve_in_trie(root.tree()?, path)?,
        None => crate::digest::ResolvedEntry::Directory(root),
    };

    match resolved {
        crate::digest::ResolvedEntry::Directory(dir) => {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("create {}", parent.display()))?;
            }
            let temp = temp_sibling_path(destination, "tmp-dir");
            remove_path_if_exists(&temp)?;
            crate::digest::materialize_trie(dir.tree()?, &temp, false)?;
            remove_path_if_exists(destination)?;
            std::fs::rename(&temp, destination).with_context(|| {
                format!("publish {} to {}", temp.display(), destination.display())
            })?;
        }
        crate::digest::ResolvedEntry::File { digest, mode } => {
            crate::usage::record_use(crate::usage::UsageKind::Cas, &digest);
            let source = cas_blob_path(&digest)?;
            publish_file_atomically(&source, destination)?;
            restore_file_mode(destination, mode)?;
        }
        crate::digest::ResolvedEntry::Symlink { target } => {
            remove_path_if_exists(destination)?;
            create_symlink(&target, destination)?;
        }
    }
    Ok(())
}

pub fn remove_path_if_exists(path: &Path) -> Result<()> {
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
pub fn create_symlink(target: &str, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::os::unix::fs::symlink(target, dest)
        .with_context(|| format!("symlink {} -> {}", dest.display(), target))
}

#[cfg(not(unix))]
pub fn create_symlink(_target: &str, _dest: &Path) -> Result<()> {
    bail!("directory outputs containing symlinks are not supported on this platform")
}

#[cfg(unix)]
pub fn file_mode(path: &Path) -> Result<Option<u32>> {
    Ok(Some(std::fs::metadata(path)?.permissions().mode() & 0o7777))
}

#[cfg(not(unix))]
pub fn file_mode(_path: &Path) -> Result<Option<u32>> {
    Ok(None)
}

#[cfg(unix)]
pub fn restore_file_mode(path: &Path, mode: Option<u32>) -> Result<()> {
    let Some(mode) = mode else {
        return Ok(());
    };
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("set permissions {:o} on {}", mode, path.display()))
}

#[cfg(not(unix))]
pub fn restore_file_mode(_path: &Path, _mode: Option<u32>) -> Result<()> {
    Ok(())
}

pub fn temp_sibling_path(destination: &Path, suffix: &str) -> PathBuf {
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

pub fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::copy(source, destination)
        .with_context(|| format!("copy {} to {}", source.display(), destination.display()))?;
    Ok(())
}

pub fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
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
    #[cfg(unix)]
    use super::*;

    #[test]
    #[cfg(unix)]
    fn materialize_cached_directory_round_trips_a_symlink() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("real"), b"hello").unwrap();
        std::os::unix::fs::symlink("real", source.path().join("link")).unwrap();

        let digest = crate::digest::capture_directory(source.path()).unwrap();

        let artifact = CachedArtifact {
            artifact_id: "test".to_owned(),
            kind: "directory".to_owned(),
            path: Some("test".to_owned()),
            value: None,
            digest: digest.digest().to_owned(),
            bytes: None,
            mode: None,
            tree_digest: Some(digest.digest().to_owned()),
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

    #[test]
    #[cfg(unix)]
    fn write_workspace_narrows_to_subtree() {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("out").join("nested")).unwrap();
        std::fs::write(
            source.path().join("out").join("nested").join("f.txt"),
            b"content",
        )
        .unwrap();

        let digest = crate::digest::capture_directory(source.path()).unwrap();

        let dest = tempfile::tempdir().unwrap();
        let destination = dest.path().join("published");
        write_workspace(digest.digest(), Some("out"), &destination).unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("nested").join("f.txt")).unwrap(),
            "content"
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_workspace_errors_on_missing_subtree() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("a.txt"), b"a").unwrap();

        let digest = crate::digest::capture_directory(source.path()).unwrap();

        let dest = tempfile::tempdir().unwrap();
        let destination = dest.path().join("published");
        assert!(write_workspace(digest.digest(), Some("missing"), &destination).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn write_workspace_publishes_a_single_file_without_touching_siblings() {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("out")).unwrap();
        std::fs::write(source.path().join("out").join("gen.h"), b"generated").unwrap();

        let digest = crate::digest::capture_directory(source.path()).unwrap();

        let dest = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dest.path().join("src")).unwrap();
        std::fs::write(
            dest.path().join("src").join("handwritten.h"),
            b"handwritten",
        )
        .unwrap();
        let destination = dest.path().join("src").join("gen.h");

        write_workspace(digest.digest(), Some("out/gen.h"), &destination).unwrap();

        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "generated");
        // The sibling file that was never part of the published digest must
        // survive untouched — publishing one file must not wipe its directory.
        assert_eq!(
            std::fs::read_to_string(dest.path().join("src").join("handwritten.h")).unwrap(),
            "handwritten"
        );
    }

    #[test]
    #[cfg(unix)]
    fn write_workspace_overwrites_an_existing_file_at_the_destination() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("gen.h"), b"new content").unwrap();
        let digest = crate::digest::capture_directory(source.path()).unwrap();

        let dest = tempfile::tempdir().unwrap();
        let destination = dest.path().join("gen.h");
        std::fs::write(&destination, b"stale content").unwrap();

        write_workspace(digest.digest(), Some("gen.h"), &destination).unwrap();

        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "new content"
        );
    }
}
