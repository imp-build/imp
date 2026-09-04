use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use app_dirs2::{AppDataType, AppInfo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use walkdir::WalkDir;

pub const TASK_CACHE_VERSION: u32 = 7;

const APP_INFO: AppInfo = AppInfo {
    name: "imp",
    author: "imp",
};

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

/// Base directory under which per-run sandbox roots are created.
/// `IMP_SANDBOX_DIR` overrides it (mirroring `IMP_CACHE_DIR`) so tests can
/// point sandboxes at an isolated, inspectable location.
///
/// Deliberately `std::env::temp_dir()`, not `cache_root()`/app_dirs2's
/// (longer, `$HOME`-rooted) `UserCache` directory: `worker_dirs_by_id()` in
/// imp-execution's worker.rs builds sccache's control socket path from this
/// same base and needs it short (a Unix-domain socket path is capped at
/// ~108 bytes, `SUN_LEN`) — `std::env::temp_dir()` gives exactly that
/// (`/tmp` on Linux, matching the old hardcoded default) while still
/// resolving correctly on Windows (`GetTempPath`, always drive-lettered,
/// unlike a bare hardcoded `/tmp/imp` string — confirmed to break any
/// `sh -c`-invoked command relying on a sandbox-rooted PATH entry: MSYS
/// bash only recognizes a drive-lettered absolute path as one needing
/// Win32-to-POSIX translation, so a bare leading `/` was silently resolved
/// inside Git's own install root instead of the real sandbox).
pub fn sandbox_base_dir() -> PathBuf {
    std::env::var_os("IMP_SANDBOX_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("imp"))
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
///
/// The three content-keyed namespaces shard one level below those parents
/// (see `shard_bucket`), and their 256 buckets each are *not* pre-created
/// here — `rename_creating_bucket` makes one the first time an entry lands in
/// it. Pre-creating 768 directories on every process start would cost more,
/// and more often, than the one `create_dir` per bucket per cache lifetime
/// that this trades it for.
pub fn cache_root() -> Result<PathBuf> {
    static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    ROOT.get_or_init(resolve_cache_root)
        .clone()
        .map_err(|msg| anyhow::anyhow!(msg))
}

// app_dirs2's UserCache resolves the real, OS-conventional cache directory
// on every platform this runs on — XDG_CACHE_HOME/$HOME/.cache on Linux
// (it honors that env var itself), ~/Library/Caches on macOS, and
// %LOCALAPPDATA%\imp\cache on Windows. That last one is the one a
// hand-rolled Unix-only fallback (the previous `/tmp/imp/cache`) could
// never get right: it has no drive letter, and Git-for-Windows' MSYS bash
// only recognizes a drive-lettered absolute path as one needing
// Win32-to-POSIX translation — a bare leading `/` silently resolves inside
// Git's own install root instead of the real directory for any `sh
// -c`-invoked command that looks it up (confirmed against a real failure:
// a sandboxed compile's PATH entry, built the same way, sent MSYS bash
// looking in the wrong place entirely).
fn resolve_cache_root() -> Result<PathBuf, String> {
    (|| -> Result<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(dir) = std::env::var_os("IMP_CACHE_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        candidates.push(
            app_dirs2::get_app_root(AppDataType::UserCache, &APP_INFO)
                .map_err(|error| anyhow::anyhow!("resolve platform cache dir: {error}"))?,
        );

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
        // Once per process, and only here: every later read consults an atomic
        // instead of the filesystem. See FLAT_LAYOUT_MAY_HAVE_ENTRIES.
        FLAT_LAYOUT_MAY_HAVE_ENTRIES.store(probe_flat_layout(&root), Ordering::Relaxed);
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
        #[cfg(not(unix))]
        {
            // A real symlink (attempted below) makes read_link above match
            // on every subsequent call, so this branch is only reached the
            // first time or when symlink creation isn't possible (e.g. no
            // SeCreateSymbolicLinkPrivilege/Developer Mode) and the artifact
            // falls back to a hard link or copy instead. If the host's PATH
            // lookup for `name` resolved to this exact cached artifact (e.g.
            // a prior registration already put this tool's own cache dir on
            // PATH — confirmed happening in practice), removing it first
            // would delete the only copy of the file, then fail to link/copy
            // from a path that no longer exists. Comparing canonical paths
            // catches that before doing anything destructive.
            let already_current = std::fs::canonicalize(&link)
                .map(|existing| existing == resolved)
                .unwrap_or(false);
            if already_current {
                return Ok(root);
            }
        }
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&resolved, &link)
            .with_context(|| format!("symlink {} -> {}", link.display(), resolved.display()))?;
        #[cfg(windows)]
        {
            // A real symlink, not a hard link: Windows resolves it at the
            // filesystem level before launching a process from it, so the
            // child's DLL search-in-application-directory step looks in
            // `resolved`'s real directory — where its companion DLLs
            // actually live (e.g. Git for Windows' git.exe/sh.exe both need
            // sibling DLLs a hard link's isolated cache dir doesn't have).
            // Falls back to the pre-existing hard-link/copy behavior when
            // symlink creation isn't permitted.
            if std::os::windows::fs::symlink_file(&resolved, &link).is_err()
                && std::fs::hard_link(&resolved, &link).is_err()
            {
                std::fs::copy(&resolved, &link).with_context(|| {
                    format!("copy {} -> {}", resolved.display(), link.display())
                })?;
            }
        }
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

// ---------------------------------------------------------------------------
// Sharded store layout
// ---------------------------------------------------------------------------

/// The on-disk contract for the three content-keyed namespaces: an entry named
/// `N` lives at `<namespace>/<bucket(N)>/<N>`, one directory level of 256
/// buckets. `cas/blobs/de/deadbeef...`, `cas/meta/de/deadbeef....json`,
/// `tasks/de/deadbeef....json`.
///
/// The **full** name stays the filename. That is load-bearing: every
/// enumerator recovers an entry's id from its file name alone and never has to
/// reassemble it from the bucket, and a file can never be read as one that
/// belongs in a different bucket.
///
/// Digests and task keys are 64-char lowercase hex (`digest_bytes`,
/// `digest_json`), so the bucket is their first two hex digits. A name that is
/// not hex in its first two characters — only test fixtures produce one — goes
/// in the reserved bucket below, which no hex name can name. The function is
/// total: it never slices, so a short or non-ASCII name cannot panic it.
const NON_HEX_BUCKET: &str = "__";

pub fn shard_bucket(name: &str) -> &str {
    let mut chars = name.char_indices();
    let hex = |c: char| c.is_ascii_hexdigit() && !c.is_ascii_uppercase();
    match (chars.next(), chars.next()) {
        (Some((_, a)), Some((end, b))) if hex(a) && hex(b) => &name[..end + b.len_utf8()],
        _ => NON_HEX_BUCKET,
    }
}

pub fn cas_blob_path_in(root: &Path, digest: &str) -> PathBuf {
    root.join("cas")
        .join("blobs")
        .join(shard_bucket(digest))
        .join(digest)
}

pub fn cas_meta_path_in(root: &Path, digest: &str) -> PathBuf {
    root.join("cas")
        .join("meta")
        .join(shard_bucket(digest))
        .join(format!("{digest}.json"))
}

pub fn task_record_path_in(root: &Path, task_key: &str) -> PathBuf {
    root.join("tasks")
        .join(shard_bucket(task_key))
        .join(format!("{task_key}.json"))
}

/// The pre-shard layout an existing cache may still hold entries in. Reads fall
/// back to these paths and promote what they find (see `resolve_sharded`); the
/// enumerators count and sweep them in place.
fn flat_cas_blob_path_in(root: &Path, digest: &str) -> PathBuf {
    root.join("cas").join("blobs").join(digest)
}

fn flat_cas_meta_path_in(root: &Path, digest: &str) -> PathBuf {
    root.join("cas").join("meta").join(format!("{digest}.json"))
}

fn flat_task_record_path_in(root: &Path, task_key: &str) -> PathBuf {
    root.join("tasks").join(format!("{task_key}.json"))
}

/// Whichever layout actually holds this entry, or `None` if neither does.
/// Used by the sites that reconstruct a path from an id they read back out of
/// `usage.db` or a GC candidate, where promoting would be a pointless write on
/// something about to be deleted.
pub fn existing_cas_blob_path_in(root: &Path, digest: &str) -> Option<PathBuf> {
    first_existing([
        cas_blob_path_in(root, digest),
        flat_cas_blob_path_in(root, digest),
    ])
}

pub fn existing_cas_meta_path_in(root: &Path, digest: &str) -> Option<PathBuf> {
    first_existing([
        cas_meta_path_in(root, digest),
        flat_cas_meta_path_in(root, digest),
    ])
}

pub fn existing_task_record_path_in(root: &Path, task_key: &str) -> Option<PathBuf> {
    first_existing([
        task_record_path_in(root, task_key),
        flat_task_record_path_in(root, task_key),
    ])
}

fn first_existing<const N: usize>(candidates: [PathBuf; N]) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

/// Set while any of the three namespaces may still hold pre-shard entries at
/// their flat paths. Probed once, in `resolve_cache_root`, so the common case —
/// a cache that was created sharded, or one that has since drained — pays
/// nothing at all on the read path. It only ever goes from set to staying set
/// for the process: clearing it the moment the last entry is promoted would
/// cost a directory scan per promotion to learn something the next `imp gc`
/// establishes for free.
static FLAT_LAYOUT_MAY_HAVE_ENTRIES: AtomicBool = AtomicBool::new(false);

fn probe_flat_layout(root: &Path) -> bool {
    ["cas/blobs", "cas/meta", "tasks"]
        .iter()
        .any(|sub| holds_a_file(&root.join(sub)))
}

/// Whether a directory holds at least one non-temp file directly. Stops at the
/// first hit, so this is a partial scan, not a full `read_dir` of a large
/// cache.
fn holds_a_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        !is_temp_name(&entry.file_name().to_string_lossy())
            && entry.file_type().is_ok_and(|kind| kind.is_file())
    })
}

/// Resolve an entry to its sharded path, promoting a pre-shard file into its
/// bucket if that is where it still lives. The returned path is always the
/// sharded one, so every caller — reader, writer, existence check — sees one
/// layout and no caller needs to know the old one exists.
///
/// Promotion is a rename, so it is atomic and cheap, and losing the race with
/// another process promoting the same entry is harmless: blobs and meta are
/// content-addressed, so the winner moved identical bytes, and a task record
/// keeps the same last-writer-wins semantics it already had.
/// `flat_layout_may_have_entries` is passed in rather than read here so the
/// promotion can be exercised deterministically against a throwaway root,
/// without a test having to drive the process-wide flag that the real callers
/// read.
fn resolve_sharded(
    flat_layout_may_have_entries: bool,
    sharded: PathBuf,
    flat: impl FnOnce() -> PathBuf,
) -> PathBuf {
    if !flat_layout_may_have_entries || sharded.exists() {
        return sharded;
    }
    let flat = flat();
    if flat.is_file() {
        let _ = rename_creating_bucket(&flat, &sharded);
    }
    sharded
}

/// Run a write that targets `path`, and if it failed only because `path`'s
/// bucket directory does not exist yet, create the bucket and run it once more.
///
/// `ensure_structural_children` creates the three namespace parents once, but
/// not their 256 buckets each — pre-creating 768 directories on every process
/// start would trade one cost for another. Paying on the miss instead costs one
/// `create_dir_all` per bucket per cache lifetime and nothing at all once the
/// bucket exists, which is the steady state for every write after the first.
///
/// Both the temp file and the rename that publishes it need this: the temp is a
/// sibling of its destination (see `temp_sibling_path`), so it lands in the same
/// not-yet-created bucket.
fn creating_bucket_on_missing<T>(
    path: &Path,
    mut write: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    match write() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let Some(bucket) = path.parent() else {
                return Err(error);
            };
            // Not `create_dir`: two workers can reach the same new bucket at
            // once, and the loser must see success, not AlreadyExists.
            std::fs::create_dir_all(bucket)?;
            write()
        }
        result => result,
    }
}

fn rename_creating_bucket(from: &Path, to: &Path) -> std::io::Result<()> {
    creating_bucket_on_missing(to, || std::fs::rename(from, to))
}

pub fn cas_blob_path(digest: &str) -> Result<PathBuf> {
    let root = cache_root()?;
    Ok(resolve_sharded(
        FLAT_LAYOUT_MAY_HAVE_ENTRIES.load(Ordering::Relaxed),
        cas_blob_path_in(&root, digest),
        || flat_cas_blob_path_in(&root, digest),
    ))
}

fn cas_meta_path(digest: &str) -> Result<PathBuf> {
    let root = cache_root()?;
    Ok(resolve_sharded(
        FLAT_LAYOUT_MAY_HAVE_ENTRIES.load(Ordering::Relaxed),
        cas_meta_path_in(&root, digest),
        || flat_cas_meta_path_in(&root, digest),
    ))
}

pub fn task_record_path(task_key: &str) -> Result<PathBuf> {
    let root = cache_root()?;
    Ok(resolve_sharded(
        FLAT_LAYOUT_MAY_HAVE_ENTRIES.load(Ordering::Relaxed),
        task_record_path_in(&root, task_key),
        || flat_task_record_path_in(&root, task_key),
    ))
}

/// True for a `temp_sibling_path` scratch file. Those live in the same
/// directory as the entries they publish, so every enumerator has to filter
/// them out rather than read them as store entries.
fn is_temp_name(name: &str) -> bool {
    name.starts_with('.')
}

/// Every entry in a sharded namespace, as `(name, path)` — including anything
/// still sitting at a flat pre-shard path, so garbage collection and statistics
/// see the whole store while the old layout drains. `name` is the file name
/// verbatim; callers strip their own suffix.
pub fn read_store_namespace(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_temp_name(&name) {
            continue;
        }
        match entry.file_type() {
            // A directory here is a bucket; one more level and no deeper.
            Ok(kind) if kind.is_dir() => {
                let Ok(bucket) = std::fs::read_dir(entry.path()) else {
                    continue;
                };
                for entry in bucket.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if is_temp_name(&name) {
                        continue;
                    }
                    if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                        found.push((name, entry.path()));
                    }
                }
            }
            // A file here is a leftover from the flat layout.
            Ok(kind) if kind.is_file() => found.push((name, entry.path())),
            _ => {}
        }
    }
    found
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
        // cache_root()'s resolution and never removed by imp gc, and its
        // bucket is created by the publishing rename below if this is the
        // first entry to land in it.
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
            let mut file = creating_bucket_on_missing(&temp, || std::fs::File::create(&temp))
                .with_context(|| format!("create {}", temp.display()))?;
            file.write_all(bytes)
                .with_context(|| format!("write {}", temp.display()))?;
            file.sync_all()
                .with_context(|| format!("sync {}", temp.display()))?;
        }
        match rename_creating_bucket(&temp, &blob_path) {
            Ok(()) => {}
            // Lost a race with a concurrent publish of the same digest (same
            // content, since CAS blobs are content-addressed): on Windows,
            // MoveFileEx's replace-existing needs to delete the file another
            // worker just published, which fails with access-denied if
            // anything (another worker's still-closing handle, an AV
            // scanner) has it open without FILE_SHARE_DELETE. POSIX rename
            // never surfaces this because replacing an existing file is
            // atomic and handle-agnostic there. Either way the winner's
            // bytes are already correct, so drop our redundant temp copy.
            Err(_) if blob_path.is_file() => {
                let _ = std::fs::remove_file(&temp);
            }
            Err(e) => {
                return Err(e).with_context(|| {
                    format!("publish blob {} to {}", temp.display(), blob_path.display())
                });
            }
        }
    }

    let meta_path = cas_meta_path(&digest)?;
    if !meta_path.is_file() {
        // No create_dir_all(parent) here either: cas/meta is created
        // alongside cas/blobs above, same rationale, bucket included.
        let metadata = serde_json::json!({
            "digest": digest,
            "kind": kind,
            "bytes": bytes.len(),
        });
        let temp = temp_sibling_path(&meta_path, "tmp-meta");
        let encoded = serde_json::to_vec_pretty(&metadata)?;
        creating_bucket_on_missing(&temp, || std::fs::write(&temp, &encoded))
            .with_context(|| format!("write {}", temp.display()))?;
        match rename_creating_bucket(&temp, &meta_path) {
            Ok(()) => {}
            // Same redundant-publish race as the blob above.
            Err(_) if meta_path.is_file() => {
                let _ = std::fs::remove_file(&temp);
            }
            Err(e) => {
                return Err(e).with_context(|| {
                    format!(
                        "publish metadata {} to {}",
                        temp.display(),
                        meta_path.display()
                    )
                });
            }
        }
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
    // cache_root()'s resolution and never removed by imp gc, and its bucket
    // is created by the write and publish below on the first entry into it.
    let encoded = serde_json::to_vec_pretty(record)?;
    let temp = temp_sibling_path(&path, "tmp-record");
    creating_bucket_on_missing(&temp, || std::fs::write(&temp, &encoded))
        .with_context(|| format!("write {}", temp.display()))?;
    rename_creating_bucket(&temp, &path)
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
    crate::digest::materialize_trie(&tree, &temp)?;
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
            crate::digest::materialize_trie(dir.tree()?, &temp)?;
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
    if permissions.mode() & 0o7777 == mode {
        return Ok(());
    }
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

/// Copy a file when the destination parent directory already exists.
///
/// `digest::collect_materialize_jobs` creates every directory before it
/// dispatches its file jobs, so materialization can use this hot-path helper
/// without repeating `create_dir_all` for every file.
pub(crate) fn copy_file_into_existing_dir(source: &Path, destination: &Path) -> Result<()> {
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
    #[cfg(any(unix, windows))]
    use super::*;
    #[cfg(windows)]
    use std::thread;

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
        let digest = store_blob(
            b"cache.rs ensure_structural_children regression test",
            "test",
        )
        .unwrap();
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

    // -----------------------------------------------------------------------
    // Sharded layout
    // -----------------------------------------------------------------------

    #[test]
    fn shard_bucket_takes_the_first_two_hex_digits() {
        assert_eq!(shard_bucket("deadbeef"), "de");
        assert_eq!(shard_bucket(&"0".repeat(64)), "00");
        assert_eq!(shard_bucket("ffabc"), "ff");
    }

    #[test]
    fn shard_bucket_is_total_over_names_that_are_not_hex() {
        // Only test fixtures produce these, but the function must never
        // panic on one, and must never collide with a real hex bucket.
        assert_eq!(shard_bucket("dead-task"), "de");
        assert_eq!(shard_bucket("live-task"), NON_HEX_BUCKET);
        assert_eq!(shard_bucket("DEADBEEF"), NON_HEX_BUCKET);
        assert_eq!(shard_bucket("a"), NON_HEX_BUCKET);
        assert_eq!(shard_bucket(""), NON_HEX_BUCKET);
        assert_eq!(shard_bucket("é-key"), NON_HEX_BUCKET);
    }

    #[test]
    fn sharded_paths_keep_the_full_name_one_level_down() {
        let root = Path::new("/cache");
        let digest = "deadbeef";
        assert_eq!(
            cas_blob_path_in(root, digest),
            Path::new("/cache/cas/blobs/de/deadbeef")
        );
        assert_eq!(
            cas_meta_path_in(root, digest),
            Path::new("/cache/cas/meta/de/deadbeef.json")
        );
        assert_eq!(
            task_record_path_in(root, digest),
            Path::new("/cache/tasks/de/deadbeef.json")
        );
    }

    #[test]
    fn store_blob_writes_into_its_shard_bucket() {
        let digest = store_blob(b"cache.rs shard-bucket layout test", "test").unwrap();
        let root = cache_root().unwrap();

        assert_eq!(
            cas_blob_path(&digest).unwrap(),
            cas_blob_path_in(&root, &digest)
        );
        assert!(cas_blob_path_in(&root, &digest).is_file());
        assert!(cas_meta_path_in(&root, &digest).is_file());
        assert_eq!(
            cas_blob_path_in(&root, &digest).parent().unwrap(),
            root.join("cas").join("blobs").join(shard_bucket(&digest))
        );
    }

    /// The compatibility path: an entry left at its pre-shard flat location is
    /// still found, and the lookup moves it into its bucket on the way through,
    /// so an upgraded cache drains itself instead of needing a migration pass.
    #[test]
    fn a_flat_entry_is_found_and_promoted_into_its_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let digest = "deadbeefcafe";
        let flat = flat_cas_blob_path_in(root, digest);
        std::fs::create_dir_all(flat.parent().unwrap()).unwrap();
        std::fs::write(&flat, b"pre-shard contents").unwrap();

        let resolved = resolve_sharded(true, cas_blob_path_in(root, digest), || {
            flat_cas_blob_path_in(root, digest)
        });

        assert_eq!(resolved, cas_blob_path_in(root, digest));
        assert_eq!(std::fs::read(&resolved).unwrap(), b"pre-shard contents");
        assert!(!flat.exists(), "the flat entry is moved, not copied");
    }

    #[test]
    fn resolution_does_not_touch_the_flat_layout_once_it_is_known_empty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let digest = "deadbeefcafe";
        let flat = flat_cas_blob_path_in(root, digest);
        std::fs::create_dir_all(flat.parent().unwrap()).unwrap();
        std::fs::write(&flat, b"pre-shard contents").unwrap();

        // The probe said the flat layout was empty, so nothing is promoted —
        // this is what keeps the fallback off the hot path.
        let resolved = resolve_sharded(false, cas_blob_path_in(root, digest), || {
            flat_cas_blob_path_in(root, digest)
        });

        assert_eq!(resolved, cas_blob_path_in(root, digest));
        assert!(flat.exists());
    }

    #[test]
    fn probe_sees_a_flat_entry_but_not_a_sharded_one_or_a_temp() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ensure_structural_children(root).unwrap();
        assert!(
            !probe_flat_layout(root),
            "a fresh cache has no flat entries"
        );

        std::fs::create_dir_all(root.join("cas/blobs/de")).unwrap();
        std::fs::write(root.join("cas/blobs/de/deadbeef"), b"x").unwrap();
        assert!(
            !probe_flat_layout(root),
            "a bucket directory is not a flat entry"
        );

        std::fs::write(root.join("cas/blobs/.deadbeef.tmp-blob-1-2"), b"x").unwrap();
        assert!(
            !probe_flat_layout(root),
            "an in-flight publish is not a flat entry"
        );

        std::fs::write(root.join("tasks/abcd.json"), b"{}").unwrap();
        assert!(probe_flat_layout(root));
    }

    #[test]
    fn concurrent_publishes_into_one_new_bucket_all_succeed() {
        // Distinct blobs sharing a bucket that does not exist yet: every
        // thread must create-or-tolerate it, not race into AlreadyExists.
        let dir = tempfile::tempdir().unwrap();
        let bucket = dir.path().join("cas").join("blobs").join("de");
        std::thread::scope(|scope| {
            for index in 0..8 {
                let bucket = &bucket;
                scope.spawn(move || {
                    let destination = bucket.join(format!("deadbeef{index}"));
                    let temp = temp_sibling_path(&destination, "tmp-blob");
                    creating_bucket_on_missing(&temp, || std::fs::write(&temp, b"contents"))
                        .unwrap();
                    rename_creating_bucket(&temp, &destination).unwrap();
                });
            }
        });

        for index in 0..8 {
            assert!(bucket.join(format!("deadbeef{index}")).is_file());
        }
    }

    #[test]
    fn read_store_namespace_reports_both_layouts_and_skips_temps() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = dir.path().join("cas").join("blobs");
        std::fs::create_dir_all(blobs.join("de")).unwrap();
        std::fs::write(blobs.join("de/deadbeef"), b"sharded").unwrap();
        std::fs::write(blobs.join("cafebabe"), b"flat").unwrap();
        std::fs::write(blobs.join("de/.deadbeef.tmp-blob-1-2"), b"temp").unwrap();
        std::fs::write(blobs.join(".cafebabe.tmp-blob-1-2"), b"temp").unwrap();

        let mut found: Vec<String> = read_store_namespace(&blobs)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        found.sort();

        assert_eq!(found, ["cafebabe", "deadbeef"]);
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

    #[test]
    #[cfg(unix)]
    fn restore_file_mode_keeps_matching_mode_and_applies_a_different_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"contents").unwrap();

        restore_file_mode(&path, Some(0o640)).unwrap();
        assert_eq!(file_mode(&path).unwrap(), Some(0o640));
        restore_file_mode(&path, Some(0o755)).unwrap();
        assert_eq!(file_mode(&path).unwrap(), Some(0o755));
    }

    // Regression for the Windows CAS-publish race: two build tasks producing
    // byte-identical output (e.g. BoringSSL's per-arch assembly stubs, which
    // compile to the same near-empty object file on a non-matching host arch)
    // both target the same content-addressed blob path. On Windows,
    // MoveFileEx's replace-existing has to delete the file the other thread
    // just published, which fails with access-denied if anything still holds
    // it open without FILE_SHARE_DELETE (Rust's default). This can't be
    // forced deterministically without a fault-injection hook into
    // store_blob's check/write/rename sequence — real repro depends on OS
    // scheduling and, in the field, an AV scanner's timing — so this drives
    // many threads at identical content instead, to confirm concurrent
    // publishes of the same digest never corrupt the blob or spuriously
    // error even under real thread contention.
    #[test]
    #[cfg(windows)]
    fn concurrent_store_blob_of_identical_content_never_corrupts_or_errors() {
        let content = b"concurrent store_blob race regression test payload";
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    store_blob(content, "test")
                })
            })
            .collect();

        let digests: Vec<String> = handles
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .collect();

        let expected = digest_bytes(content);
        for digest in &digests {
            assert_eq!(digest, &expected);
        }
        assert_eq!(
            std::fs::read(cas_blob_path(&expected).unwrap()).unwrap(),
            content
        );
        assert!(cas_meta_path(&expected).unwrap().is_file());
    }
}
