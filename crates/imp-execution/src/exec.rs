use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use indicatif::{MultiProgress, ProgressBar};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(not(unix))]
use imp_store::cache::copy_directory;
use imp_store::cache::{
    artifact_relative_path, cached_outputs_present, create_sandbox_root, digest_json, file_mode,
    materialize_cached_outputs, materialize_named_cache_artifacts, store_file_blob,
    task_record_path, validate_tool_name, write_task_cache_record, CachedArtifact, TaskCacheRecord,
    TASK_CACHE_VERSION,
};
use imp_store::digest::{
    capture_directory, merge_digests, nest_directory, nest_file, DirectoryDigest,
};

pub use imp_exec_api::{
    ExecAction, ExecIoSpec, ExecRunOpts, ExecRunResult, ExecToolSpec, SandboxRetention,
};

/// Execute a frontend-staged action. The compatibility implementation below
/// reuses the mature sandbox runner with a digest-only input and disabled
/// workspace materialization; all filesystem paths used for staging are
/// therefore inside the executor sandbox or shared CAS.
pub fn exec_run_hermetic(
    workspace_id: &str,
    action: ExecAction,
    cancellation: Option<&AtomicBool>,
) -> Result<imp_exec_api::ExecOutcome> {
    exec_run_hermetic_with_start(workspace_id, action, cancellation, &|| {})
}

pub fn exec_run_hermetic_with_start(
    workspace_id: &str,
    action: ExecAction,
    cancellation: Option<&AtomicBool>,
    started: &dyn Fn(),
) -> Result<imp_exec_api::ExecOutcome> {
    let env = action
        .env
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect();
    let output_key: Vec<serde_json::Value> = action.outputs.iter().map(output_key_spec).collect();
    let legacy = ExecRunOpts {
        argv: action.argv.clone(),
        display: action.display.clone(),
        env,
        config_digest: action.config_digest.clone(),
        inputs: vec![ExecIoSpec {
            path: None,
            kind: "digest".to_owned(),
            digest: Some(action.input_digest.clone()),
            named_cache: None,
        }],
        outputs: action.outputs,
        tools: action.tools,
        impure: action.impure,
        force_cache: action.force_cache,
        sandbox: true,
        workspace_cwd: false,
        stream: false,
        no_cache: action.no_cache,
        sandbox_retention: action.sandbox_retention,
        allow_failure: action.allow_failure,
        materialize: false,
    };
    let action_digest = live_action_digest(&legacy, &action.env)?;
    // The dummy "/" root is never touched: inputs are digest-staged and
    // materialize is off. Named caches use the caller's workspace id.
    let result = exec_run_inner_with_start(
        Path::new("/"),
        workspace_id,
        legacy,
        cancellation,
        Some(started),
        None,
    )
    .with_context(|| format!("hermetic executor action for workspace {workspace_id}"))?;
    let task_key = imp_store::cache::digest_json(&serde_json::json!({
        "version": TASK_CACHE_VERSION,
        "action_digest": action_digest,
        "input_digest": action.input_digest,
        "outputs": output_key,
    }))?;
    let outputs = if !result.outputs.is_empty() {
        result.outputs.clone()
    } else {
        imp_store::cache::task_record_path(&task_key)
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<TaskCacheRecord>(&text).ok())
            .map(|record| record.outputs)
            .unwrap_or_default()
    };
    Ok(imp_exec_api::ExecOutcome {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        output_digest: result.output_digest.unwrap_or_default(),
        outputs,
        cache_outcome: result.cache_outcome,
    })
}

// ---------------------------------------------------------------------------
// Process I/O types and helpers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

pub struct ProcessLine {
    pub stream: ProcessStream,
    pub line: String,
}

pub fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: ProcessStream,
    sender: mpsc::Sender<ProcessLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buf = [0u8; 4096];
        // Tracks whether the previous byte was `\r`, so a following `\n` is
        // treated as the second half of the same CRLF terminator rather than
        // a second, spurious blank line.
        let mut last_was_cr = false;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // A trailing partial line with no terminator is flushed;
                    // a stream that ended exactly on a terminator must not
                    // synthesize an extra blank line here (already sent below).
                    if !pending.is_empty() {
                        send_process_output_line(stream, &mut pending, &sender);
                    }
                    break;
                }
                Ok(n) => {
                    for &byte in &buf[..n] {
                        match byte {
                            b'\n' if last_was_cr => {
                                last_was_cr = false;
                            }
                            b'\n' | b'\r' => {
                                // Always send on a real line terminator, even
                                // with empty `pending` — that's a blank line,
                                // not "no line" — so blank lines round-trip
                                // through captured stdout/stderr.
                                send_process_output_line(stream, &mut pending, &sender);
                                last_was_cr = byte == b'\r';
                            }
                            byte => {
                                pending.push(byte);
                                last_was_cr = false;
                            }
                        }
                    }
                }
                Err(error) => {
                    let _ = sender.send(ProcessLine {
                        stream: ProcessStream::Stderr,
                        line: format!("failed to read process output: {error}"),
                    });
                    break;
                }
            }
        }
    })
}

fn send_process_output_line(
    stream: ProcessStream,
    pending: &mut Vec<u8>,
    sender: &mpsc::Sender<ProcessLine>,
) {
    let line = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    sender
        .send(ProcessLine { stream, line })
        .expect("failed sending process line");
}

fn drain_process_lines(
    receiver: &mpsc::Receiver<ProcessLine>,
    stdout: &mut String,
    stderr: &mut String,
    mut progress: Option<&mut ProgressBar>,
) {
    while let Ok(line) = receiver.try_recv() {
        record_process_line(line, stdout, stderr, progress.as_deref_mut());
    }
}

fn record_process_line(
    line: ProcessLine,
    stdout: &mut String,
    stderr: &mut String,
    progress: Option<&mut ProgressBar>,
) {
    if let Some(progress) = progress {
        report_process_line(progress, &line);
    }

    match line.stream {
        ProcessStream::Stdout => {
            stdout.push_str(&line.line);
            stdout.push('\n');
        }
        ProcessStream::Stderr => {
            stderr.push_str(&line.line);
            stderr.push('\n');
        }
    }
}

pub fn report_process_line(progress: &mut ProgressBar, line: &ProcessLine) {
    if line.line.trim().is_empty() {
        return;
    }
    let stream = match line.stream {
        ProcessStream::Stdout => "out",
        ProcessStream::Stderr => "err",
    };
    progress.set_message(format!("{stream}: {}", line.line));
}

pub fn report_process_failure(progress: Option<&ProgressBar>, stdout: &str, stderr: &str) {
    let Some(progress) = progress else {
        return;
    };
    let lines: Vec<&str> = stderr
        .lines()
        .chain(stdout.lines())
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if lines.is_empty() {
        return;
    }
    progress.suspend(|| {
        for line in lines {
            eprintln!("{line}");
        }
    });
}

// ---------------------------------------------------------------------------
// Child process lifecycle
// ---------------------------------------------------------------------------

/// Outcome of racing a spawned child against an in-flight remote cache
/// lookup. `RemoteHit` means the remote side answered first — the child was
/// killed and its output discarded rather than joined.
#[derive(Debug)]
pub enum ChildRaceOutcome<T> {
    Exited(T),
    RemoteHit(Box<TaskCacheRecord>),
}

pub fn wait_for_child_output(
    child: &mut Child,
    display: &str,
    cancellation: Option<&AtomicBool>,
    mut progress: Option<&mut ProgressBar>,
    remote_hit: Option<&mpsc::Receiver<Option<TaskCacheRecord>>>,
) -> Result<ChildRaceOutcome<(ExitStatus, String, String)>> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("{display} stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("{display} stderr was not piped"))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = spawn_output_reader(stdout, ProcessStream::Stdout, sender.clone());
    let stderr_thread = spawn_output_reader(stderr, ProcessStream::Stderr, sender);

    // Cleared to `None` once the remote side resolves (hit, miss, or
    // disconnect) so the rest of the loop stops polling it.
    let mut remote_hit = remote_hit;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let status = loop {
        if cancellation
            .map(|cancellation| cancellation.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            terminate_child_and_wait(child);
            // Do not join the output reader threads on cancellation. Descendant
            // processes can inherit stdout/stderr and keep those pipes open
            // after the child process group is gone, which would make Ctrl-C
            // wait for unrelated work instead of returning promptly.
            drain_process_lines(&receiver, &mut stdout, &mut stderr, progress.as_deref_mut());
            bail!("{display} canceled");
        }
        if let Some(rx) = remote_hit {
            match rx.try_recv() {
                Ok(Some(record)) => {
                    terminate_child_and_wait(child);
                    // Same rationale as cancellation above: don't join the
                    // reader threads, a descendant may be holding the pipes open.
                    return Ok(ChildRaceOutcome::RemoteHit(Box::new(record)));
                }
                Ok(None) => {
                    // Genuine remote miss — nothing left to race, stop polling.
                    remote_hit = None;
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    remote_hit = None;
                }
            }
        }
        drain_process_lines(&receiver, &mut stdout, &mut stderr, progress.as_deref_mut());
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for {display}"))?
        {
            break status;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => {
                record_process_line(line, &mut stdout, &mut stderr, progress.as_deref_mut())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    drain_process_lines(&receiver, &mut stdout, &mut stderr, progress);
    Ok(ChildRaceOutcome::Exited((status, stdout, stderr)))
}

/// Like [`wait_for_child_output`], but for a child whose stdout/stderr were
/// inherited rather than piped — there's nothing to read, just an exit
/// status to poll for.
fn wait_for_child_status(
    child: &mut Child,
    display: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<ExitStatus> {
    loop {
        if cancellation
            .map(|cancellation| cancellation.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            terminate_child_and_wait(child);
            bail!("{display} canceled");
        }
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for {display}"))?
        {
            return Ok(status);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn terminate_child_and_wait(child: &mut Child) {
    terminate_child(child);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() >= deadline => break,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => return,
        }
    }
    kill_child(child);
    let _ = child.wait();
}

fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    {
        if signal_child_process_group(child, "TERM") {
            return;
        }
    }
    let _ = child.kill();
}

fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    {
        if signal_child_process_group(child, "KILL") {
            return;
        }
    }
    let _ = child.kill();
}

#[cfg(unix)]
fn signal_child_process_group(child: &Child, signal: &str) -> bool {
    let group = format!("-{}", child.id());
    let signal = format!("-{signal}");
    Command::new("kill")
        .args([signal.as_str(), "--", group.as_str()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// JS run() API — exec context for rule exec() functions
// ---------------------------------------------------------------------------

/// RAII guard that removes a sandbox root on drop unless the configured
/// retention policy says to keep it. `succeeded` is flipped to `true` right
/// before a successful return so the guard covers every exit path — normal
/// return, `bail!`, and panics — uniformly.
pub struct SandboxGuard {
    root: PathBuf,
    retention: SandboxRetention,
    succeeded: bool,
}

impl SandboxGuard {
    fn new(root: PathBuf, retention: SandboxRetention) -> Self {
        Self {
            root,
            retention,
            succeeded: false,
        }
    }

    fn succeed(&mut self) {
        self.succeeded = true;
    }
}

impl Drop for SandboxGuard {
    fn drop(&mut self) {
        let keep = match self.retention {
            SandboxRetention::Never => false,
            SandboxRetention::OnFailure => !self.succeeded,
            SandboxRetention::Always => true,
        };
        if keep {
            eprintln!("keeping sandbox {}", self.root.display());
            return;
        }
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to remove sandbox {}: {error}", self.root.display());
            }
        }
    }
}

pub fn materialize_tools_into_sandbox(
    tools: &[ExecToolSpec],
    sandbox_root: &Path,
) -> Result<Vec<PathBuf>> {
    let tools_root = sandbox_root.join(".imp").join("tools");
    let mut path_entries = Vec::new();

    for tool in tools {
        validate_tool_name(&tool.name)?;
        if !tool.path.is_dir() {
            bail!(
                "tool {} cache path {} is not a directory",
                tool.name,
                tool.path.display()
            );
        }

        std::fs::create_dir_all(&tools_root)
            .with_context(|| format!("create {}", tools_root.display()))?;
        let sandbox_tool_root = tools_root.join(&tool.name);
        symlink_tool_root(&tool.path, &sandbox_tool_root)?;

        for bin_dir in &tool.bin_dirs {
            path_entries.push(resolve_tool_bin_dir(&sandbox_tool_root, bin_dir)?);
        }
    }

    Ok(path_entries)
}

#[cfg(unix)]
fn symlink_tool_root(source: &Path, destination: &Path) -> Result<()> {
    std::os::unix::fs::symlink(source, destination)
        .with_context(|| format!("symlink {} -> {}", destination.display(), source.display()))
}

#[cfg(not(unix))]
fn symlink_tool_root(source: &Path, destination: &Path) -> Result<()> {
    copy_directory(source, destination)
}

fn resolve_tool_bin_dir(tool_root: &Path, bin_dir: &str) -> Result<PathBuf> {
    if bin_dir == "." {
        return Ok(tool_root.to_owned());
    }
    if bin_dir.is_empty() {
        bail!("tool binDir must not be empty");
    }
    let relative = artifact_relative_path(bin_dir)?;
    Ok(tool_root.join(relative))
}

/// Host environment variables allowed through the sandbox scrub for every
/// `run()` invocation. Anything not listed here (and not synthesized below,
/// or requested per-run via `ExecRunOpts::env` / `run({ env: [...] })`, see
/// `resolve_env`) is removed before a task runs, so undeclared ambient state
/// cannot silently affect a build. The snapshot is hashed into the action
/// digest, so a change to one of these invalidates the task cache.
pub const PASSTHROUGH_ENV_VARS: &[&str] = &[
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TZ",
    "LANG",
    "LANGUAGE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// Prefixes of host environment variables allowed through (locale family).
pub const PASSTHROUGH_ENV_PREFIXES: &[&str] = &["LC_"];

/// Snapshot the allowlisted host environment. Folded into the hashed action
/// digest so ambient state that genuinely affects output keys the cache, and
/// reused as the base env for execution.
pub fn passthrough_env_snapshot() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (key, value) in std::env::vars() {
        let allowed = PASSTHROUGH_ENV_VARS.contains(&key.as_str())
            || PASSTHROUGH_ENV_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix));
        if allowed {
            out.insert(key, value);
        }
    }
    out
}

/// Resolve a `run({ env: [...] })` entry list. Each entry is either a bare
/// name (e.g. "DISPLAY") — forwarded with its current host value if the host
/// has it set, silently omitted otherwise — or a "KEY=VALUE" pair —
/// forwarded with that literal value regardless of host state. Unlike
/// PASSTHROUGH_ENV_VARS this list is supplied per `run()` call, not global,
/// but is folded into the base env identically so it is hashed into the
/// action digest, and it wins over the global allowlist snapshot.
pub fn resolve_env(entries: &[String]) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for entry in entries {
        if let Some((key, value)) = entry.split_once('=') {
            if key.is_empty() {
                bail!("run() env entry '{entry}' has an empty key before '='");
            }
            out.insert(key.to_owned(), value.to_owned());
        } else {
            if entry.is_empty() {
                bail!("run() env entry must not be empty");
            }
            if let Some(value) = std::env::var_os(entry) {
                out.insert(entry.clone(), value.to_string_lossy().into_owned());
            }
        }
    }
    Ok(out)
}

/// Create and return per-sandbox HOME and TMPDIR directories. Pinning these
/// inside the sandbox stops tasks from reading or writing the real home/tmp.
pub fn sandbox_home_tmp(sandbox_root: &Path) -> Result<(PathBuf, PathBuf)> {
    let home = sandbox_root.join(".imp").join("home");
    let tmp = sandbox_root.join(".imp").join("tmp");
    std::fs::create_dir_all(&home).with_context(|| format!("create {}", home.display()))?;
    std::fs::create_dir_all(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    Ok((home, tmp))
}

/// Absolute, fixed locations for the one binary the sandbox resolves
/// implicitly: the system shell backing bare `sh` in argv[0]. Found once by
/// checking known absolute paths — never a `PATH` search — so it stays
/// independent of ambient host state. Every other command (`tar`, `mkdir`,
/// `cmake`, a compiler, ...) must be declared via `run({ tools: [...] })` so
/// it's tracked as a real dependency and keyed into the cache, rather than
/// silently resolved from whatever happens to be installed on the host.
#[cfg(not(windows))]
const BUILTIN_SHELL_CANDIDATES: &[&str] = &["/bin/sh", "/usr/bin/sh"];
#[cfg(windows)]
const BUILTIN_SHELL_CANDIDATES: &[&str] = &[
    r"C:\Program Files\Git\bin\sh.exe",
    r"C:\Program Files\Git\usr\bin\sh.exe",
    r"C:\Program Files (x86)\Git\bin\sh.exe",
    r"C:\Program Files (x86)\Git\usr\bin\sh.exe",
    r"C:\msys64\usr\bin\sh.exe",
];

/// Resolve `program` to the binary that should actually be spawned. Only
/// `sh` is special-cased (see `BUILTIN_SHELL_CANDIDATES`); everything else is
/// used as-is, so it must already be an absolute path (from a declared tool
/// or an explicit argument) — there is no PATH search fallback.
pub fn resolve_program(program: &str) -> Result<PathBuf> {
    if program != "sh" {
        return Ok(PathBuf::from(program));
    }
    for candidate in BUILTIN_SHELL_CANDIDATES {
        if Path::new(candidate).is_file() {
            return Ok(PathBuf::from(candidate));
        }
    }
    bail!("no built-in system shell found for bare `sh` (checked {BUILTIN_SHELL_CANDIDATES:?})")
}

/// Sandboxed runs never fall back to a host or fixed base PATH: PATH is
/// composed strictly from declared `tools`' resolved bin dirs, so an
/// undeclared command cannot silently resolve.
pub fn sandbox_command_env(
    env: &BTreeMap<String, String>,
    tool_path_entries: &[PathBuf],
) -> Result<BTreeMap<String, String>> {
    let mut command_env = env.clone();
    if tool_path_entries.is_empty() {
        return Ok(command_env);
    }

    let mut entries = tool_path_entries.to_vec();
    if let Some(existing) = env.get("PATH") {
        entries.extend(std::env::split_paths(existing));
    }
    let joined = std::env::join_paths(entries).context("join tool PATH entries")?;
    command_env.insert("PATH".to_owned(), joined.to_string_lossy().into_owned());
    Ok(command_env)
}

/// One output's contribution to the task key: path, kind, and the named-cache
/// binding (if any). Keying the binding means a rule changing where an output
/// is cached — including its shared/workspace scope — re-runs the action
/// instead of replaying a record that would materialize into the old slot.
fn output_key_spec(o: &ExecIoSpec) -> serde_json::Value {
    serde_json::json!({
        "path": o.path,
        "kind": o.kind,
        "named_cache": o.named_cache.as_ref().map(|nc| {
            serde_json::json!({ "name": nc.name, "key": nc.key, "shared": nc.shared })
        }),
    })
}

/// Digest of everything about a `run()` action other than its staged inputs
/// and declared outputs: argv, the merged env it will execute with, the
/// workspace configuration digest, display, and tool specs.
pub fn live_action_digest(
    opts: &ExecRunOpts,
    base_env: &BTreeMap<String, String>,
) -> Result<String> {
    digest_json(&serde_json::json!({
        "argv": opts.argv,
        "env": base_env,
        "config_digest": opts.config_digest,
        "display": opts.display,
        "tools": opts.tools,
        "workspace_cwd": opts.workspace_cwd,
    }))
}

pub fn exec_run_inner(
    workspace_root: &Path,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
) -> Result<ExecRunResult> {
    exec_run_local_with_start(workspace_root, opts, cancellation, None, None)
}

/// Execute locally, retaining the caller's workspace path for sandboxed
/// actions that intentionally use it as their working directory.
pub fn exec_run_local_with_start(
    workspace_root: &Path,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
    started: Option<&dyn Fn()>,
    ui_suspend: Option<&MultiProgress>,
) -> Result<ExecRunResult> {
    let workspace_id = imp_store::cache::workspace_cache_id(workspace_root);
    exec_run_inner_with_start(
        workspace_root,
        &workspace_id,
        opts,
        cancellation,
        started,
        ui_suspend,
    )
}

/// Turn a resolved cache record (local or remote) into the `ExecRunResult` a
/// cache hit returns. `source` says which tier answered, for telemetry.
fn cache_hit_result(
    record: &TaskCacheRecord,
    workspace_root: &Path,
    workspace_id: &str,
    opts: &ExecRunOpts,
    source: imp_exec_api::CacheOutcome,
) -> Result<ExecRunResult> {
    if opts.materialize && !opts.outputs.is_empty() {
        eprintln!(
            "warning: run() materialize:true for '{}' — writes directly to the workspace; \
             prefer materialize:false and a package() product for dist output",
            opts.display
        );
    }
    if opts.materialize {
        materialize_cached_outputs(record, workspace_root)?;
    }
    materialize_named_cache_artifacts(&record.outputs, workspace_id)?;
    Ok(ExecRunResult {
        stdout: record.stdout.clone(),
        stderr: record.stderr.clone(),
        exit_code: 0,
        output_digest: Some(record.output_digest.clone()),
        outputs: record.outputs.clone(),
        cache_outcome: source,
    })
}

/// Like [`cache_hit_result`], but for a record that just won the remote race
/// and isn't on local disk yet: persists it locally first so a repeat of
/// this task hits the local disk cache without another remote round-trip.
fn remote_win_result(
    record: TaskCacheRecord,
    task_key: &str,
    workspace_root: &Path,
    workspace_id: &str,
    opts: &ExecRunOpts,
) -> Result<ExecRunResult> {
    if let Err(e) = write_task_cache_record(&record) {
        imp_store::artifact_trace!(
            "failed to persist remote cache hit locally task_key={task_key}: {e:#}"
        );
    }
    cache_hit_result(
        &record,
        workspace_root,
        workspace_id,
        opts,
        imp_exec_api::CacheOutcome::HitRemote,
    )
}

fn exec_run_inner_with_start(
    workspace_root: &Path,
    workspace_id: &str,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
    started: Option<&dyn Fn()>,
    ui_suspend: Option<&MultiProgress>,
) -> Result<ExecRunResult> {
    if !opts.sandbox {
        if !opts.impure {
            bail!("run({{ sandbox: false }}) requires impure: true");
        }
        return exec_run_unsandboxed(workspace_root, opts, cancellation, None);
    }

    // Resolve each declared input to a DirectoryDigest, greedily content-addressing
    // workspace files/directories into CAS as they're captured, then merge them
    // all into one tree. Doing this before any sandbox exists lets a cache hit
    // return without materializing a sandbox at all — the sandbox is only built
    // (and staged directly from this tree) on a cache miss, below.
    let mut input_trees = Vec::with_capacity(opts.inputs.len());
    for input in &opts.inputs {
        let tree =
            match input.kind.as_str() {
                "digest" => {
                    let digest = input.digest.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("run() digest input is missing its digest")
                    })?;
                    imp_store::artifact_trace!(
                        "consume-digest-input display={:?} digest={digest}",
                        opts.display
                    );
                    DirectoryDigest::from_digest(digest.clone())
                }
                "file" | "manifest" => {
                    let path = input.path.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("run() {} input is missing its path", input.kind)
                    })?;
                    let relative = artifact_relative_path(path)?;
                    let source = workspace_root.join(&relative);
                    let (digest, size) = store_file_blob(&source, &input.kind)?;
                    let mode = file_mode(&source)?;
                    nest_file(path, digest, size, mode)?
                }
                "directory" => {
                    let path = input.path.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("run() directory input is missing its path")
                    })?;
                    let relative = artifact_relative_path(path)?;
                    let source = workspace_root.join(&relative);
                    let captured = capture_directory(&source)?;
                    nest_directory(path, &captured)?
                }
                other => bail!("run() input {:?} has unsupported kind {other}", input.path),
            };
        input_trees.push(tree);
    }
    let merged_input_digest = merge_digests(input_trees)?;
    let input_digest = merged_input_digest.digest().to_owned();

    // Compute action digest. The env is the merged map the command will run
    // with (declared env over the allowlisted host snapshot), so ambient
    // changes to passthrough vars invalidate the cache. Per-sandbox
    // HOME/TMPDIR and tool PATH entries are added after digesting — their
    // paths are nondeterministic and must not be keyed.
    let mut base_env = passthrough_env_snapshot();
    base_env.extend(resolve_env(&opts.env)?);
    let action_digest = live_action_digest(&opts, &base_env)?;

    // Compute task key. The named-cache binding is part of the key: a replayed
    // record materializes the binding captured at execution time, so a binding
    // change (name, key, or scope) must force a re-run rather than replaying
    // into the old slot.
    let out_specs: Vec<serde_json::Value> = opts.outputs.iter().map(output_key_spec).collect();
    let task_key = digest_json(&serde_json::json!({
        "version": TASK_CACHE_VERSION,
        "action_digest": action_digest,
        "input_digest": input_digest,
        "outputs": out_specs,
    }))?;
    imp_store::artifact_trace!(
        "task-key display={:?} task_key={task_key} action_digest={action_digest} input_digest={input_digest}",
        opts.display
    );

    // Check cache.
    let cacheable = !opts.impure || opts.force_cache;
    if opts.stream && cacheable {
        bail!(
            "run({{ stream: true }}) requires impure: true and no force_cache — \
             streamed output can't be replayed from a cache hit"
        );
    }
    let record_path = task_record_path(&task_key)?;
    // Set when the local cache misses and a remote cache is configured: the
    // remote lookup runs concurrently with sandbox execution below, and
    // whichever resolves first wins (see the checkpoints further down).
    let mut remote_rx: Option<mpsc::Receiver<Option<TaskCacheRecord>>> = None;
    let cached_record_opt: Option<TaskCacheRecord> = if cacheable && !opts.no_cache {
        match std::fs::read_to_string(&record_path) {
            Ok(encoded) => {
                let record: TaskCacheRecord =
                    serde_json::from_str(&encoded).with_context(|| {
                        format!("parse exec cache record {}", record_path.display())
                    })?;
                match cached_outputs_present(&record) {
                    Ok(()) => {
                        imp_store::usage::record_use_sized(
                            imp_store::usage::UsageKind::Task,
                            &task_key,
                            Some(encoded.len() as u64),
                        );
                        Some(record)
                    }
                    Err(e) => {
                        imp_store::artifact_trace!(
                            "cache-record-rejected task_key={task_key} display={:?} reason={e:#}",
                            opts.display
                        );
                        // The record itself may still be valid remotely (e.g. a
                        // locally GC'd blob) — race a remote lookup the same way
                        // as the record-not-found case below.
                        remote_rx = crate::remote_cache::spawn_remote_hit(&task_key);
                        None
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                remote_rx = crate::remote_cache::spawn_remote_hit(&task_key);
                None
            }
            Err(e) => {
                return Err(e).with_context(|| format!("read {}", record_path.display()));
            }
        }
    } else {
        None
    };

    if let Some(record) = cached_record_opt {
        imp_store::artifact_trace!(
            "cache-hit task_key={task_key} display={:?} output_digest={}",
            opts.display,
            record.output_digest
        );
        return cache_hit_result(
            &record,
            workspace_root,
            workspace_id,
            &opts,
            imp_exec_api::CacheOutcome::HitLocal,
        );
    }

    // Cache miss — build the sandbox and run the command. The guard removes the
    // sandbox on drop (per the retention policy), covering every exit path below.
    let sandbox_root = create_sandbox_root()?;
    imp_store::artifact_trace!(
        "cache-miss task_key={task_key} display={:?} sandbox={}",
        opts.display,
        sandbox_root.display()
    );
    let mut sandbox_guard = SandboxGuard::new(sandbox_root.clone(), opts.sandbox_retention);
    let tool_path_entries = materialize_tools_into_sandbox(&opts.tools, &sandbox_root)?;

    // Stage inputs directly from CAS (hardlinked where possible) using the tree
    // merged above — avoids re-touching the workspace and the duplicate I/O of
    // hashing a file just to immediately re-copy its bytes.
    //
    // NB: hardlinked sandbox files alias the shared CAS blob; a task that mutates
    // its inputs in place would corrupt that blob for every other consumer.
    // Sandboxes are treated as disposable/short-lived, so this is accepted for
    // now — worth revisiting (read-only CAS blobs, or copying for tools known to
    // mutate inputs in place) if it ever bites in practice.
    imp_store::digest::materialize_trie(merged_input_digest.tree()?, &sandbox_root, true)?;

    // Pre-create the directories named by declared outputs so rule scripts don't
    // need to `mkdir` them: the parent dir for file/manifest outputs, and the
    // directory itself for directory outputs.
    for output in &opts.outputs {
        let path = output
            .path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("run() output is missing its path"))?;
        let relative = artifact_relative_path(path)?;
        let sandbox_path = sandbox_root.join(&relative);
        let dir = match output.kind.as_str() {
            "file" | "manifest" => sandbox_path.parent().map(Path::to_path_buf),
            "directory" => Some(sandbox_path),
            other => bail!("run() output {path} has unsupported kind {other}"),
        };
        if let Some(dir) = dir {
            std::fs::create_dir_all(&dir)
                .with_context(|| format!("create output dir {}", dir.display()))?;
        }
    }

    let _cmd_display = if opts.display.is_empty() {
        opts.argv.join(" ")
    } else {
        opts.display.clone()
    };

    let (program, args) = opts
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("run() argv must not be empty"))?;

    let mut command_env = sandbox_command_env(&base_env, &tool_path_entries)?;
    let (home_dir, tmp_dir) = sandbox_home_tmp(&sandbox_root)?;
    command_env.insert("HOME".to_owned(), home_dir.to_string_lossy().into_owned());
    command_env.insert("TMPDIR".to_owned(), tmp_dir.to_string_lossy().into_owned());
    command_env.insert(
        "IMP_SANDBOX_ROOT".to_owned(),
        sandbox_root.to_string_lossy().into_owned(),
    );
    let resolved_program = resolve_program(program)?;
    add_executable_library_path(&mut command_env, &resolved_program, &sandbox_root);
    let mut command = Command::new(&resolved_program);
    let command_cwd = if opts.workspace_cwd {
        workspace_root
    } else {
        &sandbox_root
    };
    command
        .args(args)
        .current_dir(command_cwd)
        .env_clear()
        .envs(&command_env);
    if opts.stream {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    } else {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    #[cfg(unix)]
    command.process_group(0);

    // The remote race may already have resolved during sandbox staging above —
    // check once before taking a job-slot permit or spawning, so a fast
    // remote hit never counts against `--jobs` for work we're about to abandon.
    if let Some(rx) = remote_rx.as_ref() {
        if let Ok(Some(record)) = rx.try_recv() {
            imp_store::artifact_trace!(
                "remote-cache-won-race task_key={task_key} display={:?} before sandbox spawn",
                opts.display
            );
            sandbox_guard.succeed();
            return remote_win_result(record, &task_key, workspace_root, workspace_id, &opts);
        }
    }

    if let Some(started) = started {
        started();
    }

    let (status, stdout, stderr) = if opts.stream {
        let mut run_child = || -> Result<ExitStatus> {
            let mut child = command
                .spawn()
                .with_context(|| format!("run() command in {}", command_cwd.display()))?;
            wait_for_child_status(&mut child, &opts.display, cancellation)
        };
        let status = match ui_suspend {
            Some(multi) => multi.suspend(run_child),
            None => run_child(),
        }?;
        (status, String::new(), String::new())
    } else {
        let mut child = command
            .spawn()
            .with_context(|| format!("run() command in {}", command_cwd.display()))?;
        match wait_for_child_output(
            &mut child,
            &opts.display,
            cancellation,
            None,
            remote_rx.as_ref(),
        )? {
            ChildRaceOutcome::Exited(triple) => triple,
            ChildRaceOutcome::RemoteHit(record) => {
                sandbox_guard.succeed();
                return remote_win_result(*record, &task_key, workspace_root, workspace_id, &opts);
            }
        }
    };

    let exit_code = status.code().unwrap_or(-1);
    if !status.success() && !opts.allow_failure {
        if opts.stream {
            bail!("{} failed with exit code {}", opts.display, exit_code);
        } else {
            bail!(
                "{} failed with exit code {}\nstdout:\n{}\nstderr:\n{}",
                opts.display,
                exit_code,
                stdout.trim_end(),
                stderr.trim_end()
            );
        }
    }

    // Ingest outputs into CAS, and build both per-output cache records and one
    // merged digest across everything this task produced — the latter lets a
    // later run() feed this task's output straight into its own inputs (as a
    // {kind:"digest"} entry) without round-tripping through the workspace.
    let mut cached_outputs = Vec::new();
    let mut output_trees = Vec::new();
    for output in &opts.outputs {
        let path = output
            .path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("run() output is missing its path"))?;
        let relative = artifact_relative_path(path)?;
        let sandbox_path = sandbox_root.join(&relative);
        match output.kind.as_str() {
            "file" | "manifest" => {
                if !sandbox_path.is_file() {
                    bail!("run() output {path} was not created as a file in sandbox");
                }
                let (digest, bytes) = store_file_blob(&sandbox_path, &output.kind)?;
                let mode = file_mode(&sandbox_path)?;
                output_trees.push(nest_file(path, digest.clone(), bytes, mode)?);
                cached_outputs.push(CachedArtifact {
                    artifact_id: path.clone(),
                    kind: output.kind.clone(),
                    path: Some(path.clone()),
                    value: None,
                    digest,
                    bytes: Some(bytes),
                    mode,
                    tree_digest: None,
                    named_cache: output.named_cache.clone(),
                });
            }
            "directory" => {
                if !sandbox_path.is_dir() {
                    bail!("run() output {path} was not created as a directory in sandbox");
                }
                let captured = capture_directory(&sandbox_path)?;
                output_trees.push(nest_directory(path, &captured)?);
                cached_outputs.push(CachedArtifact {
                    artifact_id: path.clone(),
                    kind: output.kind.clone(),
                    path: Some(path.clone()),
                    value: None,
                    digest: captured.digest().to_owned(),
                    bytes: None,
                    mode: None,
                    tree_digest: Some(captured.digest().to_owned()),
                    named_cache: output.named_cache.clone(),
                });
            }
            other => bail!("run() output {path} has unsupported kind {other}"),
        }
    }
    let output_digest = merge_digests(output_trees)?.digest().to_owned();

    // Cache record and materialize. `allow_failure` makes a nonzero exit
    // available to the caller as data; it does not make that result a
    // successful, replayable task. In particular, cache hits have no stored
    // exit status and are therefore returned as exit code 0.
    let cache_outcome = imp_exec_api::CacheOutcome::Fresh;
    if cacheable && status.success() {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
            task_id: task_key.clone(),
            task_key,
            action_digest,
            input_digest,
            output_digest: output_digest.clone(),
            named_caches: vec![],
            stdout: stdout.clone(),
            stderr: stderr.clone(),
            outputs: cached_outputs.clone(),
        };
        let write_remote = !opts.no_cache;
        if write_remote {
            write_task_cache_record(&record)?;
        }
        if opts.materialize && !opts.outputs.is_empty() {
            eprintln!(
                "warning: run() materialize:true for '{}' — writes directly to the workspace; \
                 prefer materialize:false and a package() product for dist output",
                opts.display
            );
        }
        if opts.materialize {
            materialize_cached_outputs(&record, workspace_root)?;
        }
        materialize_named_cache_artifacts(&record.outputs, workspace_id)?;
        if write_remote {
            crate::remote_cache::spawn_remote_push(record);
        }
    }

    // Command and output ingestion succeeded — let the guard delete the sandbox.
    sandbox_guard.succeed();

    Ok(ExecRunResult {
        stdout,
        stderr,
        exit_code,
        output_digest: Some(output_digest),
        outputs: cached_outputs,
        cache_outcome,
    })
}

/// Native binaries commonly place private shared libraries beside the
/// executable (for example an Odin-built executable and `libjolt_odin.so`).
/// Sandboxes intentionally scrub the host loader path, so make that staged
/// executable directory visible to the platform loader without importing any
/// host paths.
fn add_executable_library_path(
    command_env: &mut BTreeMap<String, String>,
    program: &Path,
    sandbox_root: &Path,
) {
    #[cfg(unix)]
    {
        let program_path = if program.is_absolute() {
            program.to_owned()
        } else {
            sandbox_root.join(program)
        };
        let Some(directory) = program_path.parent() else {
            return;
        };
        let key = if cfg!(target_os = "macos") {
            "DYLD_LIBRARY_PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let mut paths = vec![directory.to_owned()];
        if let Some(existing) = command_env.get(key) {
            paths.extend(std::env::split_paths(existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command_env.insert(key.to_owned(), joined.to_string_lossy().into_owned());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (command_env, program, sandbox_root);
    }
}

pub fn exec_run_unsandboxed(
    workspace_root: &Path,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
    mut progress: Option<&mut ProgressBar>,
) -> Result<ExecRunResult> {
    let tool_path_entries = direct_tool_path_entries(&opts.tools)?;

    let _cmd_display = if opts.display.is_empty() {
        opts.argv.join(" ")
    } else {
        opts.display.clone()
    };
    //    eprintln!("[unsandboxed] {}", _cmd_display);

    let (program, args) = opts
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("run() argv must not be empty"))?;

    // Unsandboxed tasks require `impure: true` — an explicit, per-call opt-out
    // of hermeticity — so unlike the sandboxed path, ambient host PATH is
    // still inherited here for undeclared commands (e.g. a user-supplied
    // generator command in `odinGenRun`). HOME/TMPDIR, and desktop session
    // variables (needed by odinRun to launch a real GUI/audio-producing
    // binary against the real display), pass through from the host rather
    // than being pinned to a sandbox for the same reason. Not added to the
    // shared PASSTHROUGH_ENV_VARS list/passthrough_env_snapshot(), since
    // that's also used by the hermetic sandboxed path.
    let mut base_env = passthrough_env_snapshot();
    for var in [
        "HOME",
        "TMPDIR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "PULSE_SERVER",
    ] {
        if let Some(value) = std::env::var_os(var) {
            base_env.insert(var.to_owned(), value.to_string_lossy().into_owned());
        }
    }
    base_env.extend(resolve_env(&opts.env)?);
    let mut command_env = sandbox_command_env(&base_env, &tool_path_entries)?;
    if !command_env.contains_key("PATH") {
        if let Some(path) = std::env::var_os("PATH") {
            command_env.insert("PATH".to_owned(), path.to_string_lossy().into_owned());
        }
    }
    let resolved_program = resolve_program(program)?;
    let mut command = Command::new(&resolved_program);
    command
        .args(args)
        .current_dir(workspace_root)
        .env_clear()
        .envs(&command_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .with_context(|| format!("run() unsandboxed command in {}", workspace_root.display()))?;

    let (status, stdout, stderr) = match wait_for_child_output(
        &mut child,
        &opts.display,
        cancellation,
        progress.as_deref_mut(),
        None,
    )? {
        ChildRaceOutcome::Exited(triple) => triple,
        ChildRaceOutcome::RemoteHit(_) => {
            unreachable!(
                "wait_for_child_output only returns RemoteHit when passed Some(remote_hit)"
            )
        }
    };

    let exit_code = status.code().unwrap_or(-1);
    if !status.success() && !opts.allow_failure {
        if let Some(p) = progress.as_deref() {
            report_process_failure(Some(p), &stdout, &stderr);
        }
        bail!(
            "{} failed with exit code {}\nstdout:\n{}\nstderr:\n{}",
            opts.display,
            exit_code,
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    Ok(ExecRunResult {
        stdout,
        stderr,
        exit_code,
        output_digest: None,
        outputs: Vec::new(),
        cache_outcome: imp_exec_api::CacheOutcome::Fresh,
    })
}

fn direct_tool_path_entries(tools: &[ExecToolSpec]) -> Result<Vec<PathBuf>> {
    let mut path_entries = Vec::new();
    for tool in tools {
        validate_tool_name(&tool.name)?;
        if !tool.path.is_dir() {
            bail!(
                "tool {} cache path {} is not a directory",
                tool.name,
                tool.path.display()
            );
        }
        for bin_dir in &tool.bin_dirs {
            path_entries.push(resolve_tool_bin_dir(&tool.path, bin_dir)?);
        }
    }
    Ok(path_entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use imp_store::cache::named_cache_key_path;

    fn digest_opts(env: &[(&str, &str)], config_digest: &str) -> ExecRunOpts {
        ExecRunOpts {
            argv: vec!["sh".to_owned(), "-c".to_owned(), "true".to_owned()],
            display: "digest test".to_owned(),
            env: env.iter().map(|(k, v)| format!("{k}={v}")).collect(),
            config_digest: config_digest.to_owned(),
            inputs: Vec::new(),
            outputs: Vec::new(),
            tools: Vec::new(),
            impure: false,
            force_cache: false,
            sandbox: true,
            workspace_cwd: false,
            stream: false,
            materialize: true,
            no_cache: false,
            sandbox_retention: SandboxRetention::default(),
            allow_failure: false,
        }
    }

    fn env_map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn action_digest_keys_passthrough_env() {
        // The merged base env (declared env over the allowlisted host
        // snapshot) is part of the action digest, so an ambient change to a
        // passthrough var like TZ or PATH must produce a different key.
        let opts = digest_opts(&[], "cfg");
        let a = live_action_digest(&opts, &env_map(&[("TZ", "UTC")])).unwrap();
        let b = live_action_digest(&opts, &env_map(&[("TZ", "UTC")])).unwrap();
        let c = live_action_digest(&opts, &env_map(&[("TZ", "America/New_York")])).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn action_digest_keys_config_digest() {
        let base_env = env_map(&[("PATH", "/usr/bin")]);
        let a = live_action_digest(&digest_opts(&[], "cfg-1"), &base_env).unwrap();
        let b = live_action_digest(&digest_opts(&[], "cfg-1"), &base_env).unwrap();
        let c = live_action_digest(&digest_opts(&[], "cfg-2"), &base_env).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    fn run_opts(argv: &[&str], inputs: &[&str], outputs: &[&str]) -> ExecRunOpts {
        let spec = |paths: &[&str]| {
            paths
                .iter()
                .map(|p| ExecIoSpec {
                    path: Some((*p).to_owned()),
                    kind: "file".to_owned(),
                    digest: None,
                    named_cache: None,
                })
                .collect()
        };
        ExecRunOpts {
            argv: argv.iter().map(|a| (*a).to_owned()).collect(),
            display: "exec test".to_owned(),
            env: Vec::new(),
            config_digest: String::new(),
            inputs: spec(inputs),
            outputs: spec(outputs),
            tools: Vec::new(),
            impure: false,
            force_cache: false,
            sandbox: true,
            workspace_cwd: false,
            stream: false,
            materialize: true,
            no_cache: false,
            sandbox_retention: SandboxRetention::default(),
            allow_failure: false,
        }
    }

    fn marker_count(marker: &std::path::Path) -> usize {
        std::fs::read_to_string(marker)
            .map(|s| s.len())
            .unwrap_or(0)
    }

    #[test]
    fn exec_run_captures_blank_lines_in_stdout() {
        // Regression test: the process-output reader used to drop any line
        // with nothing pending (an empty `pending` buffer at a line
        // terminator), silently collapsing blank lines out of captured
        // stdout/stderr — e.g. a formatter's stdout losing every blank line
        // between declarations, corrupting any comparison against the real
        // file.
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let opts = run_opts(&["sh", "-c", "printf 'a\\n\\nb\\n\\n\\nc\\n'"], &[], &[]);
        let result = exec_run_inner(p, opts, None).unwrap();
        assert_eq!(result.stdout, "a\n\nb\n\n\nc\n");
    }

    #[test]
    fn exec_run_workspace_cwd_keeps_the_sandboxed_environment() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let mut opts = run_opts(
            &[
                "sh",
                "-c",
                "test \"$HOME\" != \"$PWD\" && printf %s \"$PWD\" > workspace-cwd.txt",
            ],
            &[],
            &[],
        );
        opts.impure = true;
        opts.workspace_cwd = true;

        exec_run_inner(p, opts, None).unwrap();

        assert_eq!(
            std::fs::read_to_string(p.join("workspace-cwd.txt")).unwrap(),
            p.to_string_lossy(),
            "the process should write through its workspace working directory"
        );
    }

    #[test]
    fn exec_run_treats_crlf_as_a_single_line_terminator() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let opts = run_opts(
            &["sh", "-c", "printf 'a\\r\\nb\\r\\n\\r\\nc\\r\\n'"],
            &[],
            &[],
        );
        let result = exec_run_inner(p, opts, None).unwrap();
        // `\r\n` must not be read as two terminators (which would double
        // every line, including manufacturing a spurious blank line where
        // there wasn't one) — the CR is swallowed by the LF that follows it.
        assert_eq!(result.stdout, "a\nb\n\nc\n");
    }

    #[test]
    fn exec_run_unchanged_rerun_hits_task_cache() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "printf r >> '{}' && printf stdout-line && printf stderr-line >&2 && mkdir -p build && printf payload > build/out.txt",
            marker.display()
        );
        let opts = || run_opts(&["sh", "-c", &cmd], &[], &["build/out.txt"]);

        let first = exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 1);
        assert_eq!(first.stdout, "stdout-line\n");
        assert_eq!(first.stderr, "stderr-line\n");
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "payload"
        );

        std::fs::remove_file(p.join("build/out.txt")).unwrap();
        let second = exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 1, "second run must be a cache hit");
        assert_eq!(second.stdout, "stdout-line\n");
        assert_eq!(second.stderr, "stderr-line\n");
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "payload",
            "cache hit must rematerialize declared outputs"
        );
    }

    #[test]
    fn exec_run_allow_failure_does_not_cache_nonzero_exit() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "if test -f '{0}'; then printf r >> '{0}'; printf success; else printf r > '{0}'; printf failure; exit 7; fi",
            marker.display()
        );
        let opts = || {
            let mut opts = run_opts(&["sh", "-c", &cmd], &[], &[]);
            opts.allow_failure = true;
            opts
        };

        let first = exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(first.exit_code, 7);
        assert_eq!(first.stdout, "failure\n");
        assert_eq!(marker_count(&marker), 1);

        let second = exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(second.exit_code, 0);
        assert_eq!(second.stdout, "success\n");
        assert_eq!(
            marker_count(&marker),
            2,
            "a nonzero allowed failure must rerun instead of hitting the cache"
        );

        let third = exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(third.exit_code, 0);
        assert_eq!(third.stdout, "success\n");
        assert_eq!(
            marker_count(&marker),
            2,
            "the subsequent successful result should still be cached"
        );
    }

    #[test]
    fn exec_run_concurrent_identical_calls_race_on_task_cache() {
        // Reproduces #11: exec_run_inner_with_start has no mutual exclusion
        // between concurrent run() calls sharing the same task_key. Two
        // threads race with byte-for-byte identical opts (so identical
        // task_key), and the shared shell command embeds the sandbox PID
        // ($$) in its output — standing in for cargo's nondeterministic
        // metadata-hashed test-binary name from the real bug report. On a
        // cold cache both threads should observe "no record yet" and both
        // actually execute, instead of one single-flighting onto the other.
        let root = tempfile::tempdir().unwrap();
        let p = root.path().to_path_buf();
        let marker = p.join("runs.txt");
        // `sleep` widens the check-cache -> write-record window so the race
        // is not a hair-trigger timing fluke.
        let cmd = format!(
            "printf r >> '{}' && sleep 0.3 && mkdir -p build && printf %s $$ > build/pid.txt",
            marker.display()
        );
        let opts = || run_opts(&["sh", "-c", &cmd], &[], &["build/pid.txt"]);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (b1, b2) = (barrier.clone(), barrier.clone());
        let (p1, p2) = (p.clone(), p.clone());
        let (o1, o2) = (opts(), opts());

        let t1 = thread::spawn(move || {
            b1.wait();
            exec_run_inner(&p1, o1, None).unwrap()
        });
        let t2 = thread::spawn(move || {
            b2.wait();
            exec_run_inner(&p2, o2, None).unwrap()
        });
        let r1 = t1.join().unwrap();
        let r2 = t2.join().unwrap();

        // The bug: both callers see a cache miss and both actually run the
        // command, rather than the second single-flighting onto the first.
        assert_eq!(
            marker_count(&marker),
            2,
            "both racing calls executed the command instead of coalescing on the shared task_key"
        );

        // Each execution ran in its own sandbox and produced a different PID
        // in its output, so the two in-memory results disagree.
        assert_ne!(
            r1.output_digest, r2.output_digest,
            "the two racing sandboxes produced different outputs for the identical task_key"
        );

        // Whichever call's write_task_cache_record landed last "wins" the
        // shared record, silently discarding the other's outputs — exactly
        // the cached-record/binary mismatch described in #11.
        let task_key = digest_json(&serde_json::json!({
            "version": TASK_CACHE_VERSION,
            "action_digest": live_action_digest(&opts(), &{
                let mut env = passthrough_env_snapshot();
                env.extend(resolve_env(&opts().env).unwrap());
                env
            })
            .unwrap(),
            "input_digest": merge_digests(Vec::new()).unwrap().digest().to_owned(),
            "outputs": opts()
                .outputs
                .iter()
                .map(output_key_spec)
                .collect::<Vec<_>>(),
        }))
        .unwrap();
        let record_path = task_record_path(&task_key).unwrap();
        let record: TaskCacheRecord =
            serde_json::from_str(&std::fs::read_to_string(&record_path).unwrap()).unwrap();
        let winner_matches_r1 = record.output_digest == r1.output_digest.clone().unwrap();
        let winner_matches_r2 = record.output_digest == r2.output_digest.clone().unwrap();
        assert!(
            winner_matches_r1 != winner_matches_r2,
            "the persisted record must match exactly one racer's output, \
             stranding the other racer's caller with a digest the cache can no longer serve"
        );
    }

    fn probe_record(task_key: &str) -> TaskCacheRecord {
        TaskCacheRecord {
            version: TASK_CACHE_VERSION,
            task_id: task_key.to_owned(),
            task_key: task_key.to_owned(),
            action_digest: "test-action".to_owned(),
            input_digest: "test-input".to_owned(),
            output_digest: "test-output".to_owned(),
            named_caches: vec![],
            stdout: String::new(),
            stderr: String::new(),
            outputs: vec![],
        }
    }

    fn spawn_probe_child(script: &str) -> Child {
        Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    #[test]
    fn wait_for_child_output_remote_hit_wins_and_kills_child() {
        // A remote answer arriving mid-execution must win the race: the
        // sandboxed child is killed before its long sleep completes, and the
        // caller gets the remote record back instead of waiting it out.
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("marker");
        let mut child = spawn_probe_child(&format!("sleep 5 && touch '{}'", marker.display()));

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            let _ = tx.send(Some(probe_record("remote-win")));
        });

        let start = Instant::now();
        let outcome = wait_for_child_output(&mut child, "probe", None, None, Some(&rx)).unwrap();
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "a remote hit should short-circuit the child's 5s sleep"
        );
        match outcome {
            ChildRaceOutcome::RemoteHit(record) => assert_eq!(record.task_key, "remote-win"),
            ChildRaceOutcome::Exited(_) => panic!("expected the remote side to win the race"),
        }
        assert!(
            !marker.exists(),
            "the child should have been killed before its sleep could finish"
        );
    }

    #[test]
    fn wait_for_child_output_sandbox_wins_when_remote_channel_disconnects() {
        // The remote lookup can resolve to "no such record" (sender sends
        // then drops) or its thread can vanish without ever sending — both
        // must fall through to the child's own exit, unchanged from today.
        let (tx, rx) = mpsc::channel::<Option<TaskCacheRecord>>();
        drop(tx);
        let mut child = spawn_probe_child("printf out");
        match wait_for_child_output(&mut child, "probe", None, None, Some(&rx)).unwrap() {
            ChildRaceOutcome::Exited((status, stdout, _)) => {
                assert!(status.success());
                assert_eq!(stdout, "out\n");
            }
            ChildRaceOutcome::RemoteHit(_) => panic!("expected the sandbox side to win the race"),
        }
    }

    #[test]
    fn wait_for_child_output_sandbox_wins_when_remote_channel_never_resolves() {
        let (tx, rx) = mpsc::channel::<Option<TaskCacheRecord>>();
        let mut child = spawn_probe_child("printf out");
        match wait_for_child_output(&mut child, "probe", None, None, Some(&rx)).unwrap() {
            ChildRaceOutcome::Exited((status, stdout, _)) => {
                assert!(status.success());
                assert_eq!(stdout, "out\n");
            }
            ChildRaceOutcome::RemoteHit(_) => panic!("expected the sandbox side to win the race"),
        }
        drop(tx); // kept alive (silent) through the wait above, exercising the Empty arm
    }

    #[test]
    fn wait_for_child_output_none_receiver_matches_pre_race_behavior() {
        let mut child = spawn_probe_child("printf out");
        match wait_for_child_output(&mut child, "probe", None, None, None).unwrap() {
            ChildRaceOutcome::Exited((status, stdout, _)) => {
                assert!(status.success());
                assert_eq!(stdout, "out\n");
            }
            ChildRaceOutcome::RemoteHit(_) => unreachable!("no receiver was passed"),
        }
    }

    #[test]
    fn wait_for_child_output_cancellation_still_bails_with_no_remote_hit_receiver() {
        let cancellation = AtomicBool::new(true);
        let mut child = spawn_probe_child("sleep 5");
        let result = wait_for_child_output(&mut child, "probe", Some(&cancellation), None, None);
        let err = result.unwrap_err();
        assert!(err.to_string().contains("canceled"), "{err:#}");
    }

    #[test]
    fn exec_run_materialize_false_populates_cas_but_not_workspace() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let mut opts = run_opts(
            &[
                "sh",
                "-c",
                "mkdir -p build && printf payload > build/out.txt",
            ],
            &[],
            &["build/out.txt"],
        );
        opts.materialize = false;

        let result = exec_run_inner(p, opts, None).unwrap();
        assert!(
            !p.join("build/out.txt").exists(),
            "materialize: false must not write to the workspace"
        );
        let output_digest = result
            .output_digest
            .expect("run must still report an output digest");

        // A later materialize: true run of the exact same task must hit cache
        // (task_key doesn't depend on materialize) and copy from CAS.
        let mut second_opts = run_opts(
            &[
                "sh",
                "-c",
                "mkdir -p build && printf payload > build/out.txt",
            ],
            &[],
            &["build/out.txt"],
        );
        second_opts.materialize = true;
        let second = exec_run_inner(p, second_opts, None).unwrap();
        assert_eq!(second.output_digest.unwrap(), output_digest);
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "payload",
            "materialize: true must copy the (already cached) output into the workspace"
        );
    }

    #[test]
    fn exec_run_materialize_false_still_populates_named_cache() {
        // Named caches live under cache_root(), not the workspace, so
        // populating one isn't "writing to the workspace" and must not
        // require materialize: true. Regression test for toolchain
        // acquisition rules (e.g. rules/c/gcc/index.js) that only set
        // materialize: true to get their named cache populated, which used
        // to also leak the same content into the workspace as a side effect.
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let mut opts = run_opts(
            &[
                "sh",
                "-c",
                "mkdir -p out && printf payload > out/toolchain.bin",
            ],
            &[],
            &[],
        );
        opts.outputs = vec![ExecIoSpec {
            path: Some("out".to_owned()),
            kind: "directory".to_owned(),
            digest: None,
            named_cache: Some(imp_store::cache::OutputNamedCache {
                name: "test-toolchains".to_owned(),
                key: "v1/linux-x86_64".to_owned(),
                shared: false,
            }),
        }];
        opts.materialize = false;

        exec_run_inner(p, opts, None).unwrap();

        assert!(
            !p.join("out").exists(),
            "materialize: false must not write the plain workspace path"
        );

        let cache_dest = named_cache_key_path(p, "test-toolchains", "v1/linux-x86_64").unwrap();
        assert_eq!(
            std::fs::read_to_string(cache_dest.join("toolchain.bin")).unwrap(),
            "payload",
            "named cache must be populated even when materialize: false"
        );
        let _ = std::fs::remove_dir_all(&cache_dest);
    }

    #[test]
    fn shared_named_cache_lands_in_shared_namespace_and_skips_existing() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let opts = || {
            let mut opts = run_opts(
                &[
                    "sh",
                    "-c",
                    "mkdir -p out && printf payload > out/toolchain.bin",
                ],
                &[],
                &[],
            );
            opts.outputs = vec![ExecIoSpec {
                path: Some("out".to_owned()),
                kind: "directory".to_owned(),
                digest: None,
                named_cache: Some(imp_store::cache::OutputNamedCache {
                    name: "test-shared-toolchains".to_owned(),
                    key: "v1/linux-x86_64".to_owned(),
                    shared: true,
                }),
            }];
            opts.materialize = false;
            opts
        };

        exec_run_inner(p, opts(), None).unwrap();

        let workspace_dest =
            named_cache_key_path(p, "test-shared-toolchains", "v1/linux-x86_64").unwrap();
        assert!(
            !workspace_dest.exists(),
            "shared slot must not appear under the workspace namespace"
        );
        let shared_dest = imp_store::cache::named_cache_key_path_by_id(
            "shared",
            "test-shared-toolchains",
            "v1/linux-x86_64",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(shared_dest.join("toolchain.bin")).unwrap(),
            "payload",
            "shared slot must land under named/shared/"
        );

        // Slots are immutable by key: a populated destination is left alone,
        // even when the run replays from the task cache.
        std::fs::write(shared_dest.join("sentinel"), "keep").unwrap();
        exec_run_inner(p, opts(), None).unwrap();
        assert!(
            shared_dest.join("sentinel").exists(),
            "existing slot must not be re-materialized over"
        );
        let _ = std::fs::remove_dir_all(&shared_dest);
    }

    #[test]
    fn exec_run_input_edit_invalidates_and_pipeline_chains() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let m1 = p.join("m1.txt");
        let m2 = p.join("m2.txt");
        std::fs::write(p.join("src.txt"), "one").unwrap();

        let cmd1 = format!(
            "printf r >> '{}' && mkdir -p build && cp src.txt build/mid.txt",
            m1.display()
        );
        let cmd2 = format!(
            "printf r >> '{}' && mkdir -p build && cp build/mid.txt build/out.txt",
            m2.display()
        );
        let stage1 = || run_opts(&["sh", "-c", &cmd1], &["src.txt"], &["build/mid.txt"]);
        let stage2 = || run_opts(&["sh", "-c", &cmd2], &["build/mid.txt"], &["build/out.txt"]);

        exec_run_inner(p, stage1(), None).unwrap();
        exec_run_inner(p, stage2(), None).unwrap();
        assert_eq!((marker_count(&m1), marker_count(&m2)), (1, 1));
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "one"
        );

        // Unchanged rerun: both stages hit.
        exec_run_inner(p, stage1(), None).unwrap();
        exec_run_inner(p, stage2(), None).unwrap();
        assert_eq!((marker_count(&m1), marker_count(&m2)), (1, 1));

        // Editing the upstream source invalidates both stages through content
        // digests: stage1 reruns, its new output changes stage2's input digest.
        std::fs::write(p.join("src.txt"), "two").unwrap();
        exec_run_inner(p, stage1(), None).unwrap();
        exec_run_inner(p, stage2(), None).unwrap();
        assert_eq!((marker_count(&m1), marker_count(&m2)), (2, 2));
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "two"
        );
    }

    #[test]
    fn exec_run_output_digest_chains_directly_into_a_later_run_without_workspace_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        std::fs::write(p.join("src.txt"), "chained").unwrap();

        let mut stage1 = run_opts(
            &["sh", "-c", "mkdir -p build && cp src.txt build/mid.txt"],
            &["src.txt"],
            &["build/mid.txt"],
        );
        stage1.no_cache = true;
        let result1 = exec_run_inner(p, stage1, None).unwrap();
        let output_digest = result1
            .output_digest
            .expect("sandboxed run must report an output digest");

        // Remove the intermediate file from the workspace entirely — stage2 must
        // still succeed by staging straight from the digest, not by re-reading it.
        std::fs::remove_dir_all(p.join("build")).unwrap();

        let mut stage2 = ExecRunOpts {
            argv: vec![
                "sh".to_owned(),
                "-c".to_owned(),
                "cat build/mid.txt".to_owned(),
            ],
            display: "exec test".to_owned(),
            env: Vec::new(),
            config_digest: String::new(),
            inputs: vec![ExecIoSpec {
                path: None,
                kind: "digest".to_owned(),
                digest: Some(output_digest),
                named_cache: None,
            }],
            outputs: Vec::new(),
            tools: Vec::new(),
            impure: false,
            force_cache: false,
            sandbox: true,
            workspace_cwd: false,
            stream: false,
            materialize: true,
            no_cache: true,
            sandbox_retention: SandboxRetention::default(),
            allow_failure: false,
        };
        stage2.no_cache = true;
        let result2 = exec_run_inner(p, stage2, None).unwrap();
        assert_eq!(result2.stdout.trim_end(), "chained");
    }

    #[test]
    fn exec_run_impure_is_not_cached() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "printf r >> '{}' && mkdir -p build && printf x > build/out.txt",
            marker.display()
        );
        let opts = || {
            let mut o = run_opts(&["sh", "-c", &cmd], &[], &["build/out.txt"]);
            o.impure = true;
            o
        };
        exec_run_inner(p, opts(), None).unwrap();
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 2, "impure runs must not be cached");
    }

    #[test]
    fn exec_run_force_cache_overrides_impure() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "printf r >> '{}' && mkdir -p build && printf x > build/out.txt",
            marker.display()
        );
        let opts = || {
            let mut o = run_opts(&["sh", "-c", &cmd], &[], &["build/out.txt"]);
            o.impure = true;
            o.force_cache = true;
            o
        };
        exec_run_inner(p, opts(), None).unwrap();
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(
            marker_count(&marker),
            1,
            "force_cache must cache impure runs"
        );
    }

    #[test]
    fn exec_run_missing_declared_output_bails() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let err = match exec_run_inner(
            p,
            run_opts(&["sh", "-c", "true"], &[], &["build/never.txt"]),
            None,
        ) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("missing declared output must fail"),
        };
        assert!(err.contains("was not created"), "got: {err}");
    }

    #[test]
    fn exec_run_stages_declared_inputs_and_omits_undeclared() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        std::fs::write(p.join("declared.txt"), "d").unwrap();
        std::fs::write(p.join("undeclared.txt"), "u").unwrap();
        let cmd = "flags=''; [ -f declared.txt ] && flags=\"${flags}A\"; [ -f undeclared.txt ] && flags=\"${flags}B\"; mkdir -p build && printf %s \"$flags\" > build/flags.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &["declared.txt"], &["build/flags.txt"]);
        opts.no_cache = true;
        exec_run_inner(p, opts, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/flags.txt")).unwrap(),
            "A",
            "declared inputs must be staged, undeclared files must be absent"
        );
    }

    #[test]
    #[cfg(unix)]
    fn exec_run_stages_inputs_as_hardlinks_from_cas() {
        use std::os::unix::fs::MetadataExt;

        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        std::fs::write(p.join("declared.txt"), "d").unwrap();
        // A sandbox-retention of Always keeps the sandbox around so its content
        // can be inspected after the run completes.
        let marker = p.join("sandbox-path.txt");
        let cmd = format!("pwd > '{}'", marker.display());
        let mut opts = run_opts(&["sh", "-c", &cmd], &["declared.txt"], &[]);
        opts.no_cache = true;
        opts.sandbox_retention = SandboxRetention::Always;
        exec_run_inner(p, opts, None).unwrap();

        let sandbox_root = std::fs::read_to_string(&marker).unwrap();
        let sandbox_root = sandbox_root.trim();
        let staged = std::path::Path::new(sandbox_root).join("declared.txt");
        let (digest, _) = store_file_blob(&p.join("declared.txt"), "file").unwrap();
        let blob_path = imp_store::cache::cas_blob_path(&digest).unwrap();
        let blob_ino = std::fs::metadata(&blob_path).unwrap().ino();
        let staged_ino = std::fs::metadata(&staged).unwrap().ino();
        assert_eq!(
            blob_ino, staged_ino,
            "declared input should be hardlinked from its CAS blob into the sandbox, not copied"
        );

        std::fs::remove_dir_all(sandbox_root).ok();
    }

    #[test]
    fn exec_run_scrubs_non_allowlisted_host_env() {
        // Not on the passthrough allowlist, so it neither reaches the task nor
        // perturbs other tests' cache keys.
        std::env::set_var("IMP_TEST_LEAK_EXEC", "leaked");
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let cmd = "mkdir -p build && printf %s \"${IMP_TEST_LEAK_EXEC:-}\" > build/out.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &[], &["build/out.txt"]);
        opts.no_cache = true;
        let result = exec_run_inner(p, opts, None);
        std::env::remove_var("IMP_TEST_LEAK_EXEC");
        result.unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            ""
        );
    }

    #[test]
    fn resolve_env_forwards_set_host_var() {
        std::env::set_var("IMP_TEST_PT_SET", "hi");
        let result = resolve_env(&["IMP_TEST_PT_SET".to_owned()]);
        std::env::remove_var("IMP_TEST_PT_SET");
        assert_eq!(
            result.unwrap().get("IMP_TEST_PT_SET"),
            Some(&"hi".to_owned())
        );
    }

    #[test]
    fn resolve_env_omits_unset_host_var() {
        std::env::remove_var("IMP_TEST_PT_UNSET");
        let result = resolve_env(&["IMP_TEST_PT_UNSET".to_owned()]).unwrap();
        assert!(!result.contains_key("IMP_TEST_PT_UNSET"));
    }

    #[test]
    fn resolve_env_forces_key_value_entry() {
        std::env::remove_var("COUNT");
        let result = resolve_env(&["COUNT=10".to_owned()]).unwrap();
        assert_eq!(result.get("COUNT"), Some(&"10".to_owned()));
    }

    #[test]
    fn resolve_env_rejects_malformed_entry() {
        assert!(resolve_env(&["".to_owned()]).is_err());
        assert!(resolve_env(&["=VALUE".to_owned()]).is_err());
    }

    #[test]
    fn exec_run_forwards_env_bare_name_when_host_set() {
        std::env::set_var("IMP_TEST_PT_E2E", "leaked-on-purpose");
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let cmd = "mkdir -p build && printf %s \"${IMP_TEST_PT_E2E:-}\" > build/out.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &[], &["build/out.txt"]);
        opts.env = vec!["IMP_TEST_PT_E2E".to_owned()];
        opts.no_cache = true;
        let result = exec_run_inner(p, opts, None);
        std::env::remove_var("IMP_TEST_PT_E2E");
        result.unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "leaked-on-purpose"
        );
    }

    #[test]
    fn exec_run_omits_env_bare_name_when_host_unset() {
        std::env::remove_var("IMP_TEST_PT_E2E_UNSET");
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let cmd = "mkdir -p build && printf %s \"${IMP_TEST_PT_E2E_UNSET:-}\" > build/out.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &[], &["build/out.txt"]);
        opts.env = vec!["IMP_TEST_PT_E2E_UNSET".to_owned()];
        opts.no_cache = true;
        exec_run_inner(p, opts, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            ""
        );
    }

    #[test]
    fn exec_run_env_forced_value_ignores_host_state() {
        std::env::set_var("FORCED", "host-value");
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let cmd = "mkdir -p build && printf %s \"${FORCED:-}\" > build/out.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &[], &["build/out.txt"]);
        opts.env = vec!["FORCED=fixed-value".to_owned()];
        opts.no_cache = true;
        let result = exec_run_inner(p, opts, None);
        std::env::remove_var("FORCED");
        result.unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "fixed-value"
        );
    }

    #[test]
    fn exec_run_env_forced_value_overrides_same_named_passthrough() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let cmd = "mkdir -p build && printf %s \"${SAME:-}\" > build/out.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &[], &["build/out.txt"]);
        // Later entries win: bare passthrough first, forced value after.
        opts.env = vec!["SAME".to_owned(), "SAME=from-forced".to_owned()];
        opts.no_cache = true;
        exec_run_inner(p, opts, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "from-forced"
        );
    }

    #[test]
    fn exec_run_env_rerun_invalidates_on_host_value_change() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "printf r >> '{}' && mkdir -p build && printf x > build/out.txt",
            marker.display()
        );
        let opts = || {
            let mut o = run_opts(&["sh", "-c", &cmd], &[], &["build/out.txt"]);
            o.env = vec!["IMP_TEST_PT_DIGEST".to_owned()];
            o
        };

        std::env::set_var("IMP_TEST_PT_DIGEST", "1");
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 1);

        std::env::set_var("IMP_TEST_PT_DIGEST", "2");
        let result = exec_run_inner(p, opts(), None);
        std::env::remove_var("IMP_TEST_PT_DIGEST");
        result.unwrap();
        assert_eq!(
            marker_count(&marker),
            2,
            "changing a passed-through host var must invalidate the cache"
        );
    }

    #[test]
    fn exec_run_materializes_directory_outputs() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "printf r >> '{}' && mkdir -p build/dir/nested && printf a > build/dir/a.txt && printf b > build/dir/nested/b.txt",
            marker.display()
        );
        let opts = || {
            let mut o = run_opts(&["sh", "-c", &cmd], &[], &[]);
            o.outputs = vec![ExecIoSpec {
                path: Some("build/dir".to_owned()),
                kind: "directory".to_owned(),
                digest: None,
                named_cache: None,
            }];
            o
        };
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/dir/a.txt")).unwrap(),
            "a"
        );
        assert_eq!(
            std::fs::read_to_string(p.join("build/dir/nested/b.txt")).unwrap(),
            "b"
        );

        // Cache hit rematerializes the directory tree.
        std::fs::remove_dir_all(p.join("build/dir")).unwrap();
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 1);
        assert_eq!(
            std::fs::read_to_string(p.join("build/dir/nested/b.txt")).unwrap(),
            "b"
        );
    }

    #[test]
    fn exec_run_precreates_nested_output_dir_without_mkdir() {
        // The script writes to a nested path and a directory output without any
        // `mkdir`: the engine must pre-create both from the declared outputs.
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let cmd = "printf x > build/nested/out.txt && printf y > build/dir/inner.txt";
        let mut opts = run_opts(&["sh", "-c", cmd], &[], &["build/nested/out.txt"]);
        opts.outputs.push(ExecIoSpec {
            path: Some("build/dir".to_owned()),
            kind: "directory".to_owned(),
            digest: None,
            named_cache: None,
        });
        opts.no_cache = true;

        exec_run_inner(p, opts, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/nested/out.txt")).unwrap(),
            "x"
        );
        assert_eq!(
            std::fs::read_to_string(p.join("build/dir/inner.txt")).unwrap(),
            "y"
        );
    }

    fn guard_sandbox_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let sandbox = root.path().join("sandbox-test");
        std::fs::create_dir(&sandbox).unwrap();
        (root, sandbox)
    }

    #[test]
    fn sandbox_guard_deletes_on_success() {
        let (_root, sandbox) = guard_sandbox_dir();
        {
            let mut guard = SandboxGuard::new(sandbox.clone(), SandboxRetention::OnFailure);
            guard.succeed();
        }
        assert!(
            !sandbox.exists(),
            "successful OnFailure run must delete sandbox"
        );
    }

    #[test]
    fn sandbox_guard_keeps_failure_by_default() {
        let (_root, sandbox) = guard_sandbox_dir();
        {
            // Not marked succeeded — simulates a failed command.
            let _guard = SandboxGuard::new(sandbox.clone(), SandboxRetention::OnFailure);
        }
        assert!(sandbox.exists(), "failed OnFailure run must keep sandbox");
    }

    #[test]
    fn sandbox_guard_never_deletes_even_on_failure() {
        let (_root, sandbox) = guard_sandbox_dir();
        {
            let _guard = SandboxGuard::new(sandbox.clone(), SandboxRetention::Never);
        }
        assert!(!sandbox.exists(), "Never retention must always delete");
    }

    #[test]
    fn sandbox_guard_always_keeps_even_on_success() {
        let (_root, sandbox) = guard_sandbox_dir();
        {
            let mut guard = SandboxGuard::new(sandbox.clone(), SandboxRetention::Always);
            guard.succeed();
        }
        assert!(sandbox.exists(), "Always retention must keep the sandbox");
    }

    #[test]
    fn sandbox_retention_u8_roundtrips() {
        for r in [
            SandboxRetention::Never,
            SandboxRetention::OnFailure,
            SandboxRetention::Always,
        ] {
            assert_eq!(SandboxRetention::from_u8(r.as_u8()), r);
        }
    }
}
