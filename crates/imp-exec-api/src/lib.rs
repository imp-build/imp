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

use std::collections::BTreeMap;
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
    /// Keep the sandboxed environment and staged inputs, but start the child
    /// process in the real workspace root. Local-executor-only because the
    /// workspace path is deliberately absent from [`ExecAction`].
    pub workspace_cwd: bool,
    /// Inherit the real stdout/stderr instead of piping and capturing them,
    /// so the child owns the terminal directly (real-time output instead of
    /// buffer-then-return). Local-executor-only, and mutually exclusive with
    /// caching: requires `impure: true` and no `force_cache`, since streamed
    /// output can't be replayed from a cache hit.
    pub stream: bool,
    pub no_cache: bool,
    pub sandbox_retention: SandboxRetention,
    /// A nonzero exit is reported via the returned `exit_code` instead of
    /// failing the run — for callers (like lint tools) where a nonzero exit
    /// is a normal, structured outcome rather than an infra error.
    pub allow_failure: bool,
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

/// Hermetic action sent to an execution service. Input capture and output
/// materialization are frontend responsibilities; the executor receives only
/// content-addressed input and fully resolved environment state.
pub struct ExecAction {
    pub argv: Vec<String>,
    pub display: String,
    pub env: BTreeMap<String, String>,
    pub config_digest: String,
    pub input_digest: String,
    pub outputs: Vec<ExecIoSpec>,
    pub tools: Vec<ExecToolSpec>,
    pub impure: bool,
    pub force_cache: bool,
    pub no_cache: bool,
    pub sandbox_retention: SandboxRetention,
    /// A nonzero exit is reported via `ExecOutcome.exit_code` instead of
    /// failing the action — for callers (like lint tools) where a nonzero
    /// exit is a normal, structured outcome rather than an infra error.
    pub allow_failure: bool,
}

/// When a per-run sandbox root is deleted. Sandboxes are ephemeral by default;
/// keeping them around is only useful for post-mortem debugging.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "clap", derive(clap::ValueEnum))]
pub enum SandboxRetention {
    /// Always delete the sandbox, even after a failed command.
    Never,
    /// Delete on success; keep the sandbox when the command failed. A canceled
    /// command counts as neither: its sandbox is deleted, because cancellation
    /// abandons every queued action at once and those sandboxes show nothing.
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

/// Where an action's result came from — purely informational cache/remote-cache
/// telemetry that never affects the result itself. `Fresh` covers a genuine
/// miss (the command ran); `HitLocal`/`HitRemote` cover a cache replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum CacheOutcome {
    /// Ran fresh. A remote-cache write, if configured, is scheduled separately
    /// and is intentionally not part of this command's completion result.
    #[default]
    Fresh,
    /// Ran fresh and synchronously confirmed a remote-cache write. The local
    /// executor schedules writes in the background and therefore never returns
    /// this variant, but it remains part of the execution-service wire surface
    /// for implementations that do wait for a confirmed push.
    FreshPushed,
    /// Replayed from the local on-disk cache.
    HitLocal,
    /// Replayed from a remote cache (and persisted locally for next time).
    HitRemote,
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
    pub outputs: Vec<imp_store::cache::CachedArtifact>,
    pub cache_outcome: CacheOutcome,
}

#[derive(Serialize)]
pub struct ExecOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub output_digest: String,
    pub outputs: Vec<imp_store::cache::CachedArtifact>,
    pub cache_outcome: CacheOutcome,
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
// Concurrency gate
// ---------------------------------------------------------------------------

/// The visible lifecycle of a cache-miss action after it has entered the
/// executor. Input digest capture happens in the frontend, before this point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ExecutionPhase {
    SettingUpSandbox = 1,
    MaterializingInputs = 2,
    Running = 3,
    CapturingOutputs = 4,
    TearingDownSandbox = 5,
}

impl ExecutionPhase {
    pub const fn as_u32(self) -> u32 {
        self as u32
    }

    pub const fn from_u32(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::SettingUpSandbox),
            2 => Some(Self::MaterializingInputs),
            3 => Some(Self::Running),
            4 => Some(Self::CapturingOutputs),
            5 => Some(Self::TearingDownSandbox),
            _ => None,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::SettingUpSandbox => "setting up sandbox",
            Self::MaterializingInputs => "materializing inputs",
            Self::Running => "running",
            Self::CapturingOutputs => "capturing outputs",
            Self::TearingDownSandbox => "tearing down sandbox",
        }
    }
}

/// How an action tells the caller's scheduler where it is in its lifecycle.
///
/// The two calls are distinct because they bound different things. `reserve`
/// takes the concurrency slot that `--jobs` sizes, and must be held before the
/// action creates and stages its sandbox — staging is real, expensive I/O, and
/// leaving it ungated let hundreds of sandboxes be built at once. It also takes
/// the action's progress lane, so that visible staging work shows up in the
/// swimlane instead of the run looking stalled until the command spawns.
/// `started` says the action crossed into running its command, which is what
/// decides whether it counts as a cache hit — a lane taken by `reserve` can
/// still end up a cache hit (e.g. a remote hit resolving mid-stage).
///
/// An action that is satisfied from cache calls neither.
pub trait JobGate {
    /// Reserve the concurrency slot that bounds `--jobs`, and its progress
    /// lane alongside it. Idempotent. Must not mark the job started.
    fn reserve(&self) {}
    /// Report a visible executor phase. The first phase may reserve a lane for
    /// a remote action whose executor owns the actual sandbox concurrency.
    fn phase(&self, _phase: ExecutionPhase) {}
    /// Announce that the action has crossed the process-start boundary.
    fn started(&self) {}
}

/// Gate for callers with no scheduler to answer to.
pub struct NoGate;

impl JobGate for NoGate {}

/// Gate that forwards lifecycle callbacks without owning a concurrency slot —
/// for transports that report executor progress to a client scheduler.
pub struct StartedGate<F: Fn(), P: Fn(ExecutionPhase)> {
    pub started: F,
    pub phase: P,
}

impl<F: Fn(), P: Fn(ExecutionPhase)> JobGate for StartedGate<F, P> {
    fn phase(&self, phase: ExecutionPhase) {
        (self.phase)(phase)
    }

    fn started(&self) {
        (self.started)()
    }
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
        workspace_id: &str,
        action: ExecAction,
        cancellation: Option<&AtomicBool>,
    ) -> Result<ExecOutcome>;

    /// Execute against a caller-supplied [`JobGate`], so the action can reserve
    /// its concurrency slot before staging and report when it starts running.
    /// Implementations may leave the gate unused for transports that do not
    /// expose those lifecycle events yet.
    fn execute_with_start(
        &self,
        workspace_id: &str,
        action: ExecAction,
        cancellation: Option<&AtomicBool>,
        gate: &dyn JobGate,
    ) -> Result<ExecOutcome> {
        let _ = gate;
        self.execute(workspace_id, action, cancellation)
    }

    /// Persistent named cache directories keyed by (name, key) — Bazel/Pants
    /// style append-only caches (toolchain installs, compiler caches).
    fn cache_dir_get(&self, workspace_id: &str, name: &str, key: &str) -> Result<Option<PathBuf>>;
    fn cache_dir_has(&self, workspace_id: &str, name: &str, key: &str) -> Result<bool>;
    /// Copy `source` (file or directory) into the cache slot for (name, key).
    fn cache_dir_put(&self, workspace_id: &str, name: &str, key: &str, source: &Path)
        -> Result<()>;

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
    /// Size in bytes of a file on the executor's filesystem.
    fn file_size(&self, path: &Path) -> Result<u64>;
    /// Register a host-resolved executable as a symlinked native-tool
    /// artifact usable in `ExecToolSpec.path`.
    fn register_native_tool(&self, name: &str, resolved: &Path) -> Result<PathBuf>;

    /// Start (or join) a persistent named worker process.
    async fn worker_start(
        &self,
        workspace_id: &str,
        name: &str,
        spec: WorkerSpec,
    ) -> Result<WorkerHandle>;
    /// Look up an already-running worker by name.
    fn worker_get(&self, name: &str) -> Result<Option<WorkerHandle>>;

    /// Executor platform capabilities (≈ REv2 `GetCapabilities`).
    fn capabilities(&self) -> Result<Capabilities>;
}
