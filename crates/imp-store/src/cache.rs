use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use walkdir::WalkDir;

pub const TASK_CACHE_VERSION: u32 = 7;

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
pub fn named_cache_scope_id(shared: bool, workspace_id: &str) -> &str {
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

/// Resolved once per process and cached: re-resolving (and re-verifying every
/// directory below) on every call was measurably expensive on the hot cache
/// read/write path, which calls this indirectly per file. No caller — in
/// tests or otherwise — mutates `IMP_CACHE_DIR`/`XDG_CACHE_HOME`/`HOME` after
/// process start and expects a different resolution, so caching the winner
/// for the process lifetime is safe.
///
/// The four structural children created alongside the root
/// (`cas/blobs`, `cas/meta`, `tasks`, `native-tools`) are never removed by
/// `imp gc` (only legacy dirs and empty named-cache slot leaves are), so
/// callers that write into them (`store_blob`, `write_task_cache_record`) no
/// longer need their own `create_dir_all` — they're guaranteed to exist for
/// the rest of the process once this has resolved once. If the cache root is
/// deleted out-of-band mid-process (self-inflicted; `imp gc` never does
/// this), that no longer self-heals: the next write into the missing
/// directory surfaces as a plain I/O error instead of silently recreating it.
pub fn cache_root() -> Result<PathBuf> {
    static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    ROOT.get_or_init(resolve_cache_root)
        .clone()
        .map_err(|msg| anyhow::anyhow!(msg))
}

fn resolve_cache_root() -> Result<PathBuf, String> {
    (|| -> Result<PathBuf> {
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
        let mut root = None;
        for candidate in candidates {
            match std::fs::create_dir_all(&candidate) {
                Ok(()) => {
                    root = Some(candidate);
                    break;
                }
                Err(error) => last_error = Some((candidate, error)),
            }
        }
        let root = match root {
            Some(root) => root,
            None => {
                if let Some((candidate, error)) = last_error {
                    bail!("create cache root {}: {error}", candidate.display());
                }
                bail!("no cache root candidates available")
            }
        };

        ensure_structural_children(&root)?;
        Ok(root)
    })()
    .map_err(|error| format!("{error:#}"))
}

/// Create the fixed, always-needed subdirectories under a cache root:
/// `cas/blobs`, `cas/meta`, `tasks`, `native-tools`. Split out from
/// `resolve_cache_root` so it can be exercised directly against a throwaway
/// path in tests, without touching `cache_root()`'s process-wide memoization
/// or any environment variable.
fn ensure_structural_children(root: &Path) -> Result<()> {
    for sub in ["cas/blobs", "cas/meta", "tasks", "native-tools"] {
        let dir = root.join(sub);
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    }
    Ok(())
}

/// Validate a tool name for use as a path component under the cache's
/// native-tools/tool roots. Shared by exec's tool materialization and the
/// native-tool artifact registration below.
///
/// `+` is allowed alongside the usual path-safe characters because gcc's
/// own compiler driver name is `c++` (see rules/c/gcc's `gccGraphToolSpec()`
/// and rules/c/cmake's `graph_replay.js`, which mount that exact name as a
/// tool) — a real, unavoidable tool name, not an arbitrary one this
/// validator should be inventing an alias to dodge.
pub fn validate_tool_name(name: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+'))
    {
        bail!("tool name '{name}' must contain only ASCII letters, digits, '-', '_', '.' or '+'");
    }
    Ok(())
}

/// Ensure `<cache_root>/native-tools/<name>/<name>` is a symlink to `resolved`,
/// creating or repairing it if missing/stale. Returns the tool-root directory.
/// Bypasses cachePut (see copy_dir_into in spike.rs) because that path
/// dereferences symlinks into real-byte copies; run()'s tool materialization
/// is expected to symlink the tool root wholesale, so the artifact itself
/// must already be the symlink, not a copy.
///
/// `resolved` is canonicalized first: this cache is a single global path per
/// tool name, shared between the host process and any sandboxed subprocess
/// that also resolves the same tool name for real (e.g. a rules-test suite
/// exercising nativeTool() as its own subject under test). A sandboxed
/// resolution's PATH search finds this very cache entry's sandbox-local
/// symlink first, so an uncanonicalized `resolved` would persist a path
/// inside that ephemeral sandbox — dangling, or worse, a self-referential
/// symlink loop once the sandbox is torn down. Canonicalizing collapses any
/// such alias chain back to the one real, stable system binary underneath,
/// so repeated resolutions (host or sandboxed) always converge on the same
/// value instead of drifting.
pub fn ensure_native_tool_artifact(name: &str, resolved: &Path) -> Result<PathBuf> {
    validate_tool_name(name)?;
    let resolved = std::fs::canonicalize(resolved)
        .with_context(|| format!("canonicalize {}", resolved.display()))?;
    let root = cache_root()?.join("native-tools").join(name);
    std::fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
    let link = root.join(native_tool_artifact_filename(name, &resolved));
    if std::fs::read_link(&link).ok().as_deref() != Some(resolved.as_path()) {
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&resolved, &link)
            .with_context(|| format!("symlink {} -> {}", link.display(), resolved.display()))?;
        #[cfg(not(unix))]
        std::fs::copy(&resolved, &link)
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
    crate::usage::record_use_sized(
        crate::usage::UsageKind::Cas,
        &digest,
        Some(bytes.len() as u64),
    );
    let blob_path = cas_blob_path(&digest)?;
    if !blob_path.is_file() {
        // No create_dir_all(parent) here: cas/blobs is created once by
        // cache_root()'s resolution and never removed by imp gc.
        let temp = temp_sibling_path(&blob_path, "tmp-blob");
        // Explicit sync_all() before rename, not std::fs::write(): closing a
        // handle alone doesn't guarantee NTFS has flushed the write, so a
        // rename immediately followed by a hardlink + read from a freshly
        // spawned process could in principle observe stale/torn content
        // without it. (Investigated as a candidate cause of a real "tar:
        // does not look like a tar archive" failure that turned out to be a
        // separate PATH-resolution bug — see which_executable()'s own
        // WINDOWS_BSDTAR handling — but this fsync gap is real regardless
        // and cheap to close.)
        {
            let mut file = std::fs::File::create(&temp)
                .with_context(|| format!("create {}", temp.display()))?;
            file.write_all(bytes)
                .with_context(|| format!("write {}", temp.display()))?;
            file.sync_all()
                .with_context(|| format!("sync {}", temp.display()))?;
        }
        std::fs::rename(&temp, &blob_path).with_context(|| {
            format!("publish blob {} to {}", temp.display(), blob_path.display())
        })?;
    }

    let meta_path = cas_meta_path(&digest)?;
    if !meta_path.is_file() {
        // No create_dir_all(parent) here either: cas/meta is created
        // alongside cas/blobs above, same rationale.
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
    let digest = store_blob(&bytes, kind)?;
    crate::artifact_trace!("capture {} -> digest={digest} size={size}", path.display());
    Ok((digest, size))
}

/// Normalize a rule-declared artifact path into a path relative to the
/// workspace/sandbox root, for joining onto a real filesystem root. Rejects
/// absolute paths and any `..`/prefix component. A path that normalizes to
/// nothing (`"."`, `""`, `"./."`, ...) is valid and returns an empty
/// `PathBuf` — callers that filesystem-join it get the root itself
/// (`root.join(PathBuf::new()) == root`, a no-op join); callers that need to
/// *name* an entry (`nest_file`/`nest_directory`) must check for this case
/// explicitly, since an empty path has no leaf name to give.
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

    // The merged output tree is handed to dependents as the task's
    // `output_digest` and consumed directly as a `{ kind: "digest" }` input,
    // so a record that can't produce it is unusable no matter how complete
    // `outputs` looks. Checking it here is what makes an under-hydrated record
    // degrade to a cache miss (and a real execution) instead of failing the
    // dependent task with a bare "read digest node ...: No such file".
    //
    // Root only, matching the directory case above: a cheap constant-cost
    // check, with anything deeper surfacing at materialization time.
    if !record.output_digest.is_empty() {
        let path = cas_blob_path(&record.output_digest)?;
        if !path.is_file() {
            bail!("merged output tree {} is missing", path.display());
        }
    }

    Ok(())
}

pub fn write_task_cache_record(record: &TaskCacheRecord) -> Result<()> {
    let path = task_record_path(&record.task_key)?;
    // No create_dir_all(parent) here: tasks/ is created once by
    // cache_root()'s resolution and never removed by imp gc.
    let encoded = serde_json::to_vec_pretty(record)?;
    let temp = temp_sibling_path(&path, "tmp-record");
    std::fs::write(&temp, &encoded).with_context(|| format!("write {}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish task cache record {}", path.display()))?;
    crate::usage::record_use_sized(
        crate::usage::UsageKind::Task,
        &record.task_key,
        Some(encoded.len() as u64),
    );
    crate::artifact_trace!(
        "write-record task_key={} output_digest={} outputs=[{}]",
        record.task_key,
        record.output_digest,
        record
            .outputs
            .iter()
            .map(|o| format!("{}:{}", o.artifact_id, o.digest))
            .collect::<Vec<_>>()
            .join(", ")
    );
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
                crate::usage::record_cas_read(&output.digest);
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
        // Fresh materialization is the one place a slot's on-disk size is
        // guaranteed current — record it (the pre-skip record above was
        // unsized, so this upgrades the row).
        crate::usage::record_named_set(scope_id, &named_cache.name, &named_cache.key, &destination);
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
            crate::usage::record_cas_read(&digest);
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
    // temp is a sibling of destination, so its parent was just created above.
    copy_file_into_existing_dir(source, &temp)?;
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

fn copy_file_into_existing_dir(source: &Path, destination: &Path) -> Result<()> {
    std::fs::copy(source, destination)
        .with_context(|| format!("copy {} to {}", source.display(), destination.display()))?;
    Ok(())
}

pub fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    copy_file_into_existing_dir(source, destination)
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
            // The dir entry for target's parent is always walked before its
            // file entries (WalkDir's default pre-order traversal), so the
            // parent directory already exists — no redundant create_dir_all.
            copy_file_into_existing_dir(entry.path(), &target)?;
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

    #[test]
    #[cfg(unix)]
    fn validate_tool_name_accepts_gccs_cxx_driver_name() {
        validate_tool_name("c++").unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn validate_tool_name_rejects_path_separators() {
        assert!(validate_tool_name("../escape").is_err());
        assert!(validate_tool_name("a/b").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn artifact_relative_path_root_normalizes_to_empty() {
        assert_eq!(artifact_relative_path(".").unwrap(), PathBuf::new());
        assert_eq!(artifact_relative_path("").unwrap(), PathBuf::new());
    }

    #[test]
    #[cfg(unix)]
    fn artifact_relative_path_strips_cur_dir_components() {
        assert_eq!(
            artifact_relative_path("./foo").unwrap(),
            PathBuf::from("foo")
        );
        assert_eq!(
            artifact_relative_path("foo/.").unwrap(),
            PathBuf::from("foo")
        );
    }

    #[test]
    #[cfg(unix)]
    fn artifact_relative_path_rejects_absolute() {
        assert!(artifact_relative_path("/abs").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn artifact_relative_path_rejects_parent_components() {
        assert!(artifact_relative_path("../escape").is_err());
        assert!(artifact_relative_path("a/../b").is_err());
    }

    // `ensure_structural_children` is exercised directly against a throwaway
    // tempdir rather than through `cache_root()`/`IMP_CACHE_DIR`: cache_root()
    // memoizes its resolution in a process-wide OnceLock, and `cargo test`
    // runs this binary's tests concurrently on multiple threads, so mutating
    // IMP_CACHE_DIR here could race another test file's first (real, pinned
    // for the rest of the process) call to cache_root(). Testing the pure,
    // path-parameterized helper sidesteps that entirely.
    #[test]
    #[cfg(unix)]
    fn ensure_structural_children_creates_the_fixed_cache_subdirs() {
        let root = tempfile::tempdir().unwrap();

        ensure_structural_children(root.path()).unwrap();

        for sub in ["cas/blobs", "cas/meta", "tasks", "native-tools"] {
            assert!(
                root.path().join(sub).is_dir(),
                "{sub} should have been created under the cache root"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn ensure_structural_children_is_idempotent() {
        let root = tempfile::tempdir().unwrap();

        ensure_structural_children(root.path()).unwrap();
        // Must not error the second time (mirrors store_blob/
        // write_task_cache_record now relying on this having already run).
        ensure_structural_children(root.path()).unwrap();

        assert!(root.path().join("cas/blobs").is_dir());
    }

    // store_blob/write_task_cache_record no longer create_dir_all their own
    // parent directory — this exercises the real functions (through the
    // process's real, memoized cache_root()) to confirm they still work now
    // that they rely on cache_root() having already created cas/blobs,
    // cas/meta, and tasks/. Deliberately does not set IMP_CACHE_DIR (see the
    // comment above) — it runs against whatever this process's cache_root()
    // resolves to, which is safe because both functions publish atomically
    // (temp file + rename) and are content-addressed/idempotent, so sharing
    // that directory with any other concurrently running test is harmless.
    #[test]
    #[cfg(unix)]
    fn store_blob_and_write_task_cache_record_work_without_their_own_mkdir() {
        let digest =
            store_blob(b"cache.rs ensure_structural_children regression test", "test").unwrap();
        assert!(cas_blob_path(&digest).unwrap().is_file());
        assert!(cas_meta_path(&digest).unwrap().is_file());

        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
            task_id: "test-task".to_owned(),
            task_key: "cache-rs-ensure-structural-children-regression-test".to_owned(),
            action_digest: digest.clone(),
            input_digest: digest.clone(),
            output_digest: String::new(),
            named_caches: Vec::new(),
            stdout: String::new(),
            stderr: String::new(),
            outputs: Vec::new(),
        };
        write_task_cache_record(&record).unwrap();
        assert!(task_record_path(&record.task_key).unwrap().is_file());
    }

    #[test]
    #[cfg(unix)]
    fn copy_directory_copies_nested_files() {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("sub")).unwrap();
        std::fs::write(source.path().join("top.txt"), b"top").unwrap();
        std::fs::write(source.path().join("sub").join("nested.txt"), b"nested").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let destination = dest.path().join("out");
        copy_directory(source.path(), &destination).unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("top.txt")).unwrap(),
            "top"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("sub").join("nested.txt")).unwrap(),
            "nested"
        );
    }
}
