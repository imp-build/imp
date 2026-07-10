//! The execution API boundary between imp's graph frontend and its action
//! execution layer.
//!
//! Shaped after the Bazel Remote Execution API (REv2) so a later daemon can
//! implement the same surface over gRPC and act as a caching/execution
//! middleware in front of a real remote cluster. Correspondence, roughly:
//!
//! | here                          | REv2                                    |
//! |-------------------------------|-----------------------------------------|
//! | [`ExecRunOpts`]               | `Action` + `Command`                    |
//! | `ExecRunOpts::config_digest`  | `Action.salt`                           |
//! | `ExecRunOpts::impure`         | `Action.do_not_cache`                   |
//! | [`ExecToolSpec`]              | platform properties (imp extension)   |
//! | [`ExecRunResult`]             | `ActionResult`                          |
//! | `ExecutionService::execute`   | `Execution.Execute` + `ActionCache`     |
//! | `ExecutionService::fetch_url` | Remote Asset API `Fetch`                |
//! | workers / cache dirs          | imp extensions, local-executor-only   |
//!
//! Stage-A caveats, deliberately kept for a mechanical split and to be
//! removed when the wire protocol lands:
//! - `execute` takes `workspace_root` and path-identified inputs: input
//!   capture into the CAS and output materialization currently happen inside
//!   the local executor. Stage B moves both to the frontend (the daemon must
//!   never touch the checkout), narrowing inputs to digest-only.
//! - Digests are bare hex strings (as in `imp-store`); the REv2
//!   `Digest{hash,size_bytes}` pair appears with the proto conversion.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use anyhow::Result;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Action types (REv2 Action/Command analogs)
// ---------------------------------------------------------------------------

/// A declared input or output of an action.
pub struct ExecIoSpec {
    /// Present for every kind except `"digest"`, where the pre-merged tree
    /// carries its own paths and this is meaningless.
    pub path: Option<String>,
    pub kind: String,
    /// Present only for `"digest"` inputs — a digest handle (e.g. from a
    /// `file_set.union()` evaluation or a prior `run()`'s output) to merge
    /// directly into the sandbox's input tree.
    pub digest: Option<String>,
    pub named_cache: Option<imp_store::cache::OutputNamedCache>,
}

/// A tool made visible to the sandboxed command via `PATH`. The imp analog
/// of REv2 platform properties: it routes and keys execution, and in Stage B
/// pins tool-dependent actions to executors that can materialize them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecToolSpec {
    pub name: String,
    pub cache: String,
    pub key: String,
    pub path: PathBuf,
    pub bin_dirs: Vec<String>,
}

/// Everything needed to run one action. REv2 `Action` + `Command` in one
/// struct, plus imp's non-hermetic escape hatches (`sandbox: false`) and
/// cache-control knobs.
pub struct ExecRunOpts {
    pub argv: Vec<String>,
    pub display: String,
    pub env: Vec<String>,
    /// Configuration fingerprint folded into the action's cache key — the
    /// REv2 `Action.salt`.
    pub config_digest: String,
    pub inputs: Vec<ExecIoSpec>,
    pub outputs: Vec<ExecIoSpec>,
    pub tools: Vec<ExecToolSpec>,
    /// Never replay from the task cache — REv2 `do_not_cache`.
    pub impure: bool,
    pub force_cache: bool,
    /// `false` runs the command directly in the workspace root (requires
    /// `impure`); the non-REv2 escape hatch, local-executor-only in Stage B.
    pub sandbox: bool,
    pub no_cache: bool,
    pub sandbox_retention: SandboxRetention,
    /// Whether declared outputs get copied back into the real workspace.
    /// Output capture into CAS and the `output_digest`/cache record happen
    /// either way — this only gates the workspace-copy step, so a caller can
    /// get a digest to compare or feed into a later `run({inputs})` without
    /// mutating the tree. Required at the JS `run()` boundary whenever
    /// `outputs` is non-empty (see `imp_core.js`); defaults to `true` here
    /// only as a defense-in-depth fallback for callers that bypass that JS
    /// validation.
    pub materialize: bool,
}

/// When a per-run sandbox root is deleted. Sandboxes are ephemeral by default;
/// keeping them around is only useful for post-mortem debugging.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "clap", derive(clap::ValueEnum))]
pub enum SandboxRetention {
    /// Always delete the sandbox, even after a failed command.
    Never,
    /// Delete on success; keep the sandbox when the command failed.
    #[default]
    OnFailure,
    /// Never delete — retain every sandbox for inspection.
    Always,
}

impl SandboxRetention {
    pub fn as_u8(self) -> u8 {
        match self {
            SandboxRetention::Never => 0,
            SandboxRetention::OnFailure => 1,
            SandboxRetention::Always => 2,
        }
    }

    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => SandboxRetention::Never,
            2 => SandboxRetention::Always,
            _ => SandboxRetention::OnFailure,
        }
    }
}

/// The outcome of one action — REv2 `ActionResult`.
#[derive(Serialize)]
pub struct ExecRunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// Root digest of the merged tree over everything this run produced (`None`
    /// for the unsandboxed path, which doesn't capture outputs into CAS). Lets a
    /// rule thread this run's output straight into a later `run({inputs})` call
    /// as a `{kind:"digest"}` entry, without materializing to the workspace first.
    pub output_digest: Option<String>,
}

// ---------------------------------------------------------------------------
// Worker types (persistent processes; daemon-owned state in Stage B)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHandle {
    pub home_dir: PathBuf,
    pub tmp_dir: PathBuf,
    /// A TCP port deterministically derived from (workspace, name), handed to
    /// the spawned process as `IMP_WORKER_PORT` and returned to the caller,
    /// so a client and its worker agree on an address without depending on
    /// any sandbox-scoped rendezvous file. Not every worker needs this, but
    /// it's cheap to always provide.
    pub port: u16,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerSpec {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub health_check_argv: Vec<String>,
}

// ---------------------------------------------------------------------------
// Capabilities (REv2 GetCapabilities analog)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Capabilities {
    /// Normalized OS name: "linux", "macos", "windows".
    pub os: &'static str,
    /// Normalized architecture: "x86_64", "aarch64".
    pub arch: &'static str,
}

// ---------------------------------------------------------------------------
// The service trait
// ---------------------------------------------------------------------------

/// The execution surface the frontend talks to. Stage A binds this to the
/// in-process local executor (`imp-execution`'s `LocalExecutionService`);
/// Stage B adds a gRPC client implementation pointing at the daemon.
///
/// `execute` is synchronous by design: callers are expected to drive it from
/// a blocking-capable thread (imp's scheduler runs actions on a bounded
/// blocking pool), and a remote implementation can block on the RPC there.
/// Worker startup is async because it awaits process health checks.
#[async_trait::async_trait]
pub trait ExecutionService: Send + Sync {
    /// Run one action (or replay it from the action/task cache).
    fn execute(
        &self,
        workspace_root: &Path,
        opts: ExecRunOpts,
        cancellation: Option<&AtomicBool>,
    ) -> Result<ExecRunResult>;

    /// Persistent named cache directories keyed by (name, key) — Bazel/Pants
    /// style append-only caches (toolchain installs, compiler caches).
    fn cache_dir_get(&self, workspace_root: &Path, name: &str, key: &str)
        -> Result<Option<PathBuf>>;
    fn cache_dir_has(&self, workspace_root: &Path, name: &str, key: &str) -> Result<bool>;
    /// Copy `source` (file or directory) into the cache slot for (name, key).
    fn cache_dir_put(
        &self,
        workspace_root: &Path,
        name: &str,
        key: &str,
        source: &Path,
    ) -> Result<()>;

    /// Download a URL to a local file, content-cached by URL (≈ Remote Asset
    /// API `Fetch`).
    fn fetch_url(&self, url: &str) -> Result<PathBuf>;
    /// Extract an archive ("tar.gz", "tgz", "zip") into `dest`.
    fn extract_archive(
        &self,
        archive: &Path,
        dest: &Path,
        format: &str,
        strip_components: u32,
    ) -> Result<()>;
    /// SHA-256 hex digest of a file on the executor's filesystem.
    fn file_sha256(&self, path: &Path) -> Result<String>;
    /// Register a host-resolved executable as a symlinked native-tool
    /// artifact usable in `ExecToolSpec.path`.
    fn register_native_tool(&self, name: &str, resolved: &Path) -> Result<PathBuf>;

    /// Start (or join) a persistent named worker process.
    async fn worker_start(
        &self,
        workspace_root: &Path,
        name: &str,
        spec: WorkerSpec,
    ) -> Result<WorkerHandle>;
    /// Look up an already-running worker by name.
    fn worker_get(&self, name: &str) -> Result<Option<WorkerHandle>>;

    /// Executor platform capabilities (≈ REv2 `GetCapabilities`).
    fn capabilities(&self) -> Result<Capabilities>;
}
