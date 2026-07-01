use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use walkdir::WalkDir;

use crate::exec::ExecToolSpec;
use crate::spike::{Artifact, NamedCache, Plan, Task};

pub(crate) const TASK_CACHE_VERSION: u32 = 3;

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SandboxManifest {
    pub(crate) task_id: String,
    pub(crate) sandbox_root: PathBuf,
    pub(crate) cache_root: PathBuf,
    pub(crate) input_runlist: Vec<SandboxInput>,
    pub(crate) output_runlist: Vec<SandboxOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SandboxInput {
    pub(crate) artifact_id: String,
    pub(crate) source: PathBuf,
    pub(crate) sandbox_path: PathBuf,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SandboxOutput {
    pub(crate) artifact_id: String,
    pub(crate) sandbox_path: PathBuf,
    pub(crate) cache_path: PathBuf,
    pub(crate) kind: String,
}

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
    pub(crate) dependency_keys: Vec<(String, String)>,
    pub(crate) named_caches: Vec<NamedCacheBinding>,
    pub(crate) outputs: Vec<CachedArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedCacheBinding {
    pub name: String,
    pub env_var: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskCacheSummary {
    pub(crate) task_id: String,
    pub(crate) task_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskCacheEvaluation {
    pub(crate) cacheable: bool,
    pub(crate) cache_disabled: bool,
    pub(crate) task_key: String,
    pub(crate) action_digest: String,
    pub(crate) input_digests: Vec<CacheInputDigest>,
    pub(crate) dependency_keys: Vec<(String, String)>,
    pub(crate) named_caches: Vec<NamedCacheBinding>,
    pub(crate) hit: bool,
    pub(crate) miss_reason: Option<String>,
    pub(crate) record: Option<TaskCacheRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheExplanation {
    pub task_id: String,
    pub cacheable: bool,
    pub impure: bool,
    pub force_cache: bool,
    pub task_key: String,
    pub action_digest: String,
    pub input_digests: Vec<CacheInputDigest>,
    pub dependency_keys: Vec<(String, String)>,
    pub named_caches: Vec<NamedCacheBinding>,
    pub hit: bool,
    pub miss_reason: Option<String>,
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

pub(crate) fn materialize_embedded_output_task(
    task: &Task,
    workspace_root: &Path,
    cache: &TaskCacheEvaluation,
) -> Result<()> {
    if !task_has_embedded_outputs(task) {
        bail!(
            "{} has no executable argv and contains outputs that cannot be materialized from embedded values",
            task.id
        );
    }
    let mut outputs = Vec::new();
    for artifact in &task.outputs {
        let value = artifact.value.as_deref().unwrap_or_default();
        outputs.push(CachedArtifact {
            artifact_id: artifact.id.clone(),
            kind: artifact.kind.clone(),
            path: artifact.path.clone(),
            value: artifact.value.clone(),
            digest: store_blob(value.as_bytes(), &artifact.kind)?,
            bytes: Some(value.len() as u64),
            mode: None,
            files: Vec::new(),
        });
    }

    if cache.cacheable {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
            task_id: task.id.clone(),
            task_key: cache.task_key.clone(),
            action_digest: cache.action_digest.clone(),
            input_digests: cache.input_digests.clone(),
            dependency_keys: cache.dependency_keys.clone(),
            named_caches: cache.named_caches.clone(),
            outputs,
        };
        write_task_cache_record(&record)?;
        materialize_cached_outputs(&record, workspace_root)?;
    } else if cache.cache_disabled {
        materialize_task_outputs_without_record(task, cache, outputs, workspace_root)?;
    }
    Ok(())
}

pub(crate) fn materialize_task_outputs_without_record(
    task: &Task,
    cache: &TaskCacheEvaluation,
    outputs: Vec<CachedArtifact>,
    workspace_root: &Path,
) -> Result<()> {
    let record = TaskCacheRecord {
        version: TASK_CACHE_VERSION,
        task_id: task.id.clone(),
        task_key: cache.task_key.clone(),
        action_digest: cache.action_digest.clone(),
        input_digests: cache.input_digests.clone(),
        dependency_keys: cache.dependency_keys.clone(),
        named_caches: cache.named_caches.clone(),
        outputs,
    };
    materialize_cached_outputs(&record, workspace_root)
}

// ---------------------------------------------------------------------------
// Sandbox preparation
// ---------------------------------------------------------------------------

pub(crate) fn prepare_sandbox(task: &Task, workspace_root: &Path) -> Result<SandboxManifest> {
    let sandbox_root = create_sandbox_root()?;
    let cache_root = cache_root()?;
    let mut input_runlist = Vec::new();
    let mut output_runlist = Vec::new();

    for artifact in &task.inputs {
        let Some(path) = &artifact.path else {
            continue;
        };
        let relative = artifact_relative_path(path)?;
        let source = workspace_root.join(&relative);
        let sandbox_path = sandbox_root.join(&relative);
        copy_artifact_into_sandbox(artifact, &source, &sandbox_path)?;
        input_runlist.push(SandboxInput {
            artifact_id: artifact.id.clone(),
            source,
            sandbox_path,
            kind: artifact.kind.clone(),
        });
    }

    for artifact in &task.outputs {
        let Some(path) = &artifact.path else {
            continue;
        };
        let relative = artifact_relative_path(path)?;
        let sandbox_path = sandbox_root.join(&relative);
        let cache_path = cache_root.join(&relative);
        output_runlist.push(SandboxOutput {
            artifact_id: artifact.id.clone(),
            sandbox_path,
            cache_path,
            kind: artifact.kind.clone(),
        });
    }

    Ok(SandboxManifest {
        task_id: task.id.clone(),
        sandbox_root,
        cache_root,
        input_runlist,
        output_runlist,
    })
}

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

pub(crate) fn named_cache_bindings(
    workspace_root: &Path,
    named_caches: &[NamedCache],
) -> Result<Vec<NamedCacheBinding>> {
    let root = cache_root()?
        .join("named")
        .join(workspace_cache_id(workspace_root));
    let mut bindings = Vec::with_capacity(named_caches.len());
    for cache in named_caches {
        let path = root.join(&cache.name);
        bindings.push(NamedCacheBinding {
            name: cache.name.clone(),
            env_var: cache.env_var.clone(),
            path,
        });
    }
    Ok(bindings)
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

/// Identity of a tool, folded into the action digest. The fingerprint is a
/// content hash of the entire resolved tool tree, so a tool whose bytes change
/// (e.g. a new compiler build provisioned under the same named-cache key)
/// invalidates dependent tasks even though its declared `key` is unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ToolFingerprint {
    pub(crate) name: String,
    pub(crate) digest: String,
}

/// Per-process stat cache mapping (path, mtime, size) -> content digest so a
/// tool tree is hashed at most once per file per process. Mirrors Bazel's
/// stat-based digest cache; not yet persisted across invocations.
static FILE_DIGEST_CACHE: Mutex<Option<HashMap<(PathBuf, u128, u64), String>>> = Mutex::new(None);

fn cached_file_digest(path: &Path, meta: &std::fs::Metadata) -> Result<String> {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = (path.to_path_buf(), mtime, meta.len());
    {
        let mut guard = FILE_DIGEST_CACHE
            .lock()
            .expect("file digest cache poisoned");
        if let Some(hit) = guard.get_or_insert_with(HashMap::new).get(&key) {
            return Ok(hit.clone());
        }
    }
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let digest = digest_bytes(&bytes);
    FILE_DIGEST_CACHE
        .lock()
        .expect("file digest cache poisoned")
        .get_or_insert_with(HashMap::new)
        .insert(key, digest.clone());
    Ok(digest)
}

/// Content-hash an entire tool tree (every regular file under `root`, including
/// relative path and mode), using the stat cache to avoid re-reading unchanged
/// files. Errors if the tool has not been provisioned yet.
fn fingerprint_tool_path(root: &Path) -> Result<String> {
    let root_meta = std::fs::symlink_metadata(root)
        .with_context(|| format!("stat tool path {}", root.display()))?;
    if root_meta.is_file() {
        return cached_file_digest(root, &root_meta);
    }
    let mut entries: Vec<(String, Option<u32>, String)> = Vec::new();
    for entry in WalkDir::new(root) {
        let entry = entry.with_context(|| format!("walk tool path {}", root.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .with_context(|| format!("strip {} from {}", root.display(), entry.path().display()))?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let meta = entry
            .metadata()
            .with_context(|| format!("stat {}", entry.path().display()))?;
        let digest = cached_file_digest(entry.path(), &meta)?;
        entries.push((relative, file_mode(entry.path())?, digest));
    }
    entries.sort();
    digest_json(&entries)
}

/// Compute the fingerprint of every tool an action depends on. Run at task
/// cache evaluation time (after dependencies have produced the tools), not at
/// plan time, so out-of-band provisioned toolchains are present on disk.
pub(crate) fn fingerprint_tools(tools: &[ExecToolSpec]) -> Result<Vec<ToolFingerprint>> {
    let mut out = Vec::with_capacity(tools.len());
    for tool in tools {
        out.push(ToolFingerprint {
            name: tool.name.clone(),
            digest: fingerprint_tool_path(&tool.path)?,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

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

pub(crate) fn resolve_sandbox_path(root: &Path, path: &str) -> Result<PathBuf> {
    let relative = artifact_relative_path(path)?;
    Ok(root.join(relative))
}

pub(crate) fn copy_artifact_into_sandbox(
    artifact: &Artifact,
    source: &Path,
    destination: &Path,
) -> Result<()> {
    match artifact.kind.as_str() {
        "file" | "manifest" => {
            if !source.is_file() {
                bail!(
                    "{} declared {} input {} but it is not a file",
                    artifact.id,
                    artifact.kind,
                    source.display()
                );
            }
            copy_file(source, destination)?;
        }
        "directory" => {
            if !source.is_dir() {
                bail!(
                    "{} declared directory input {} but it is not a directory",
                    artifact.id,
                    source.display()
                );
            }
            copy_directory(source, destination)?;
        }
        "value" => {}
        other => bail!(
            "{} has unsupported input artifact kind {other}",
            artifact.id
        ),
    }
    Ok(())
}

pub(crate) fn evaluate_task_cache(
    task: &Task,
    workspace_root: &Path,
    named_caches: &[NamedCache],
    config_digest: &str,
    completed_dependencies: &BTreeMap<String, TaskCacheSummary>,
) -> Result<TaskCacheEvaluation> {
    evaluate_task_cache_with_lookup(
        task,
        workspace_root,
        named_caches,
        config_digest,
        completed_dependencies,
        true,
    )
}

pub(crate) fn evaluate_task_cache_with_lookup(
    task: &Task,
    workspace_root: &Path,
    named_caches: &[NamedCache],
    config_digest: &str,
    completed_dependencies: &BTreeMap<String, TaskCacheSummary>,
    lookup_cache: bool,
) -> Result<TaskCacheEvaluation> {
    let bindings = named_cache_bindings(workspace_root, named_caches)?;
    let input_digests = digest_task_inputs(task, workspace_root)?;
    let tool_fingerprints = fingerprint_tools(&task.action.tools)?;
    let mut dependency_keys = Vec::new();
    for dependency in &task.dependencies {
        if let Some(summary) = completed_dependencies.get(dependency) {
            dependency_keys.push((dependency.clone(), summary.task_key.clone()));
        } else {
            dependency_keys.push((dependency.clone(), "<missing>".to_owned()));
        }
    }
    let action_digest = digest_json(&serde_json::json!({
        "task_id": task.id,
        "target": task.target,
        "product": task.product,
        "action": task.action,
        "tool_fingerprints": tool_fingerprints,
        "outputs": task.outputs,
    }))?;
    let task_key = digest_json(&serde_json::json!({
        "version": TASK_CACHE_VERSION,
        "task_id": task.id,
        "action_digest": action_digest,
        "config_digest": config_digest,
        "input_digests": input_digests,
        "dependency_keys": dependency_keys,
        "named_caches": bindings,
    }))?;
    let cacheable = if task.action.force_cache {
        true
    } else if task.action.impure {
        false
    } else {
        !task.outputs.is_empty()
            && (!task.action.argv.is_empty() || task_has_embedded_outputs(task))
    };
    if !cacheable {
        let miss_reason = if task.action.impure && !task.action.force_cache {
            "task is marked impure (set force_cache: true to override)".to_owned()
        } else {
            "task has no executable argv or embedded declared outputs".to_owned()
        };
        return Ok(TaskCacheEvaluation {
            cacheable,
            cache_disabled: false,
            task_key,
            action_digest,
            input_digests,
            dependency_keys,
            named_caches: bindings,
            hit: false,
            miss_reason: Some(miss_reason),
            record: None,
        });
    }

    let record = if lookup_cache {
        let record_path = task_record_path(&task_key)?;
        match std::fs::read_to_string(&record_path) {
            Ok(encoded) => {
                let record: TaskCacheRecord =
                    serde_json::from_str(&encoded).with_context(|| {
                        format!("parse task cache record {}", record_path.display())
                    })?;
                Some(record)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("read task cache record {}", record_path.display()));
            }
        }
    } else {
        None
    };

    let (hit, miss_reason) = if !lookup_cache {
        (false, Some("cache disabled".to_owned()))
    } else {
        match &record {
            None => (false, Some("no task cache record".to_owned())),
            Some(record) if record.task_key != task_key => {
                (false, Some("task cache record key mismatch".to_owned()))
            }
            Some(record) => match cached_outputs_present(record) {
                Ok(()) => (true, None),
                Err(error) => (false, Some(format!("{error:#}"))),
            },
        }
    };

    Ok(TaskCacheEvaluation {
        cacheable,
        cache_disabled: false,
        task_key,
        action_digest,
        input_digests,
        dependency_keys,
        named_caches: bindings,
        hit,
        miss_reason,
        record,
    })
}

pub(crate) fn disable_task_cache(evaluation: &mut TaskCacheEvaluation) {
    evaluation.cacheable = false;
    evaluation.cache_disabled = true;
    evaluation.hit = false;
    evaluation.miss_reason = Some("cache disabled".to_owned());
    evaluation.record = None;
}

pub(crate) fn task_has_embedded_outputs(task: &Task) -> bool {
    !task.outputs.is_empty()
        && task
            .outputs
            .iter()
            .all(|artifact| match artifact.kind.as_str() {
                "file" | "manifest" => artifact.value.is_some(),
                "value" => true,
                _ => false,
            })
}

fn digest_task_inputs(task: &Task, workspace_root: &Path) -> Result<Vec<CacheInputDigest>> {
    let mut digests = Vec::new();
    for artifact in &task.inputs {
        let digest = match artifact.kind.as_str() {
            "file" | "manifest" => {
                let path = artifact
                    .path
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("{} input has no path", artifact.id))?;
                let relative = artifact_relative_path(path)?;
                let source = workspace_root.join(relative);
                if !source.is_file() {
                    bail!(
                        "{} declared {} input {} but it is not a file",
                        artifact.id,
                        artifact.kind,
                        source.display()
                    );
                }
                let (digest, _) = store_file_blob(&source, &artifact.kind)?;
                digest
            }
            "directory" => {
                let path = artifact.path.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("{} directory input has no path", artifact.id)
                })?;
                let relative = artifact_relative_path(path)?;
                let source = workspace_root.join(relative);
                if !source.is_dir() {
                    bail!(
                        "{} declared directory input {} but it is not a directory",
                        artifact.id,
                        source.display()
                    );
                }
                digest_json(&directory_entries(&source)?)?
            }
            "value" => {
                let value = artifact.value.as_deref().unwrap_or_default();
                store_blob(value.as_bytes(), "value")?
            }
            other => bail!(
                "{} has unsupported input artifact kind {other}",
                artifact.id
            ),
        };
        digests.push(CacheInputDigest {
            artifact_id: artifact.id.clone(),
            kind: artifact.kind.clone(),
            path: artifact.path.clone(),
            value: artifact.value.clone(),
            digest,
        });
    }
    Ok(digests)
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

pub(crate) fn ingest_task_outputs(
    task: &Task,
    sandbox: &SandboxManifest,
) -> Result<Vec<CachedArtifact>> {
    let outputs_by_id: BTreeMap<&str, &SandboxOutput> = sandbox
        .output_runlist
        .iter()
        .map(|output| (output.artifact_id.as_str(), output))
        .collect();
    let mut cached = Vec::new();
    for artifact in &task.outputs {
        let cached_artifact = match artifact.kind.as_str() {
            "file" | "manifest" => {
                let output = outputs_by_id.get(artifact.id.as_str()).ok_or_else(|| {
                    anyhow::anyhow!("{} output was not present in sandbox runlist", artifact.id)
                })?;
                if !output.sandbox_path.is_file() {
                    bail!(
                        "{} declared {} output {} but it was not created as a file in sandbox",
                        task.id,
                        output.kind,
                        output.sandbox_path.display()
                    );
                }
                let (digest, bytes) = store_file_blob(&output.sandbox_path, &artifact.kind)?;
                CachedArtifact {
                    artifact_id: artifact.id.clone(),
                    kind: artifact.kind.clone(),
                    path: artifact.path.clone(),
                    value: artifact.value.clone(),
                    digest,
                    bytes: Some(bytes),
                    mode: file_mode(&output.sandbox_path)?,
                    files: Vec::new(),
                }
            }
            "directory" => {
                let output = outputs_by_id.get(artifact.id.as_str()).ok_or_else(|| {
                    anyhow::anyhow!("{} output was not present in sandbox runlist", artifact.id)
                })?;
                if !output.sandbox_path.is_dir() {
                    bail!(
                        "{} declared directory output {} but it was not created in sandbox",
                        task.id,
                        output.sandbox_path.display()
                    );
                }
                let files = directory_entries(&output.sandbox_path)?;
                let digest = digest_json(&files)?;
                CachedArtifact {
                    artifact_id: artifact.id.clone(),
                    kind: artifact.kind.clone(),
                    path: artifact.path.clone(),
                    value: artifact.value.clone(),
                    digest,
                    bytes: None,
                    mode: None,
                    files,
                }
            }
            "value" => {
                let value = artifact.value.as_deref().unwrap_or_default();
                CachedArtifact {
                    artifact_id: artifact.id.clone(),
                    kind: artifact.kind.clone(),
                    path: artifact.path.clone(),
                    value: artifact.value.clone(),
                    digest: store_blob(value.as_bytes(), "value")?,
                    bytes: Some(value.len() as u64),
                    mode: None,
                    files: Vec::new(),
                }
            }
            other => bail!(
                "{} has unsupported output artifact kind {other}",
                artifact.id
            ),
        };
        cached.push(cached_artifact);
    }
    Ok(cached)
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

pub fn explain_task_cache(
    plan: &Plan,
    workspace_root: &Path,
    task_selector: &str,
) -> Result<CacheExplanation> {
    let ordered = crate::executor::ordered_tasks(plan)?;
    let selected_id = if ordered.iter().any(|task| task.id == task_selector) {
        task_selector.to_owned()
    } else if plan.roots.len() == 1 {
        plan.roots[0].clone()
    } else {
        bail!("cache explain selector '{task_selector}' did not match a task id");
    };

    let mut summaries = BTreeMap::new();
    for task in ordered {
        let evaluation = evaluate_task_cache(
            task,
            workspace_root,
            &plan.named_caches,
            &plan.config_digest,
            &summaries,
        )?;
        if task.id == selected_id {
            return Ok(CacheExplanation {
                task_id: task.id.clone(),
                cacheable: evaluation.cacheable,
                impure: task.action.impure,
                force_cache: task.action.force_cache,
                task_key: evaluation.task_key,
                action_digest: evaluation.action_digest,
                input_digests: evaluation.input_digests,
                dependency_keys: evaluation.dependency_keys,
                named_caches: evaluation.named_caches,
                hit: evaluation.hit,
                miss_reason: evaluation.miss_reason,
            });
        }
        summaries.insert(
            task.id.clone(),
            TaskCacheSummary {
                task_id: task.id.clone(),
                task_key: evaluation.task_key,
            },
        );
    }

    bail!("task {selected_id} was not present in the plan")
}

pub fn format_cache_explanation(
    explanation: &CacheExplanation,
    w: &mut String,
) -> std::fmt::Result {
    use std::fmt::Write;

    writeln!(w, "Cache explanation for {}", explanation.task_id)?;
    writeln!(w, "  cacheable: {}", explanation.cacheable)?;
    if explanation.impure {
        if explanation.force_cache {
            writeln!(w, "  impure: true (force_cache override — caching anyway)")?;
        } else {
            writeln!(w, "  impure: true (caching disabled)")?;
        }
    }
    writeln!(
        w,
        "  status: {}",
        if explanation.hit { "hit" } else { "miss" }
    )?;
    if let Some(reason) = &explanation.miss_reason {
        writeln!(w, "  miss reason: {reason}")?;
    }
    writeln!(w, "  task key: {}", explanation.task_key)?;
    writeln!(w, "  action digest: {}", explanation.action_digest)?;
    writeln!(w, "  inputs:")?;
    if explanation.input_digests.is_empty() {
        writeln!(w, "    (none)")?;
    } else {
        for input in &explanation.input_digests {
            let path = input.path.as_deref().unwrap_or("<value>");
            writeln!(
                w,
                "    {} {} {} {}",
                input.artifact_id, input.kind, path, input.digest
            )?;
        }
    }
    writeln!(w, "  dependencies:")?;
    if explanation.dependency_keys.is_empty() {
        writeln!(w, "    (none)")?;
    } else {
        for (task, key) in &explanation.dependency_keys {
            writeln!(w, "    {task} {key}")?;
        }
    }
    writeln!(w, "  named caches:")?;
    if explanation.named_caches.is_empty() {
        writeln!(w, "    (none)")?;
    } else {
        for binding in &explanation.named_caches {
            writeln!(
                w,
                "    {} {} {}",
                binding.name,
                binding.env_var,
                binding.path.display()
            )?;
        }
    }
    Ok(())
}
