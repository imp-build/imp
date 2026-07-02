use std::collections::{BTreeMap, VecDeque};
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
use rquickjs::Object;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::cache::{
    artifact_relative_path, cached_outputs_present, copy_directory, copy_file, create_sandbox_root,
    digest_json, directory_entries, file_mode, materialize_cached_outputs, named_cache_key_path,
    store_file_blob, task_record_path, write_task_cache_record, CacheInputDigest, CachedArtifact,
    TaskCacheRecord, TASK_CACHE_VERSION,
};

const PROCESS_OUTPUT_VISIBLE_LINES: usize = 5;

// ---------------------------------------------------------------------------
// Process I/O types and helpers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub(crate) enum ProcessStream {
    Stdout,
    Stderr,
}

pub(crate) struct ProcessLine {
    pub(crate) stream: ProcessStream,
    pub(crate) line: String,
}

pub(crate) fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: ProcessStream,
    sender: mpsc::Sender<ProcessLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    send_process_output_line(stream, &mut pending, &sender);
                    break;
                }
                Ok(n) => {
                    for byte in &buf[..n] {
                        match *byte {
                            b'\n' | b'\r' => {
                                send_process_output_line(stream, &mut pending, &sender);
                            }
                            byte => pending.push(byte),
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
    if pending.is_empty() {
        return;
    }
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
    mut progress: Option<&mut prodash::tree::Item>,
    recent_output: &mut VecDeque<prodash::tree::Item>,
) {
    while let Ok(line) = receiver.try_recv() {
        record_process_line(line, stdout, stderr, progress.as_deref_mut(), recent_output);
    }
}

fn record_process_line(
    line: ProcessLine,
    stdout: &mut String,
    stderr: &mut String,
    progress: Option<&mut prodash::tree::Item>,
    recent_output: &mut VecDeque<prodash::tree::Item>,
) {
    if let Some(progress) = progress {
        report_process_line(progress, recent_output, &line);
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

pub(crate) fn report_process_line(
    progress: &mut prodash::tree::Item,
    recent_output: &mut VecDeque<prodash::tree::Item>,
    line: &ProcessLine,
) {
    if line.line.trim().is_empty() {
        return;
    }
    let stream = match line.stream {
        ProcessStream::Stdout => "out",
        ProcessStream::Stderr => "err",
    };
    recent_output.push_back(progress.add_child(format!("{stream}: {}", line.line)));
    while recent_output.len() > PROCESS_OUTPUT_VISIBLE_LINES {
        recent_output.pop_front();
    }
}

pub(crate) fn report_process_failure(
    progress: Option<&prodash::tree::Item>,
    stdout: &str,
    stderr: &str,
) {
    let Some(progress) = progress else {
        return;
    };
    for line in stderr
        .lines()
        .chain(stdout.lines())
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        progress.message(prodash::messages::MessageLevel::Failure, line.to_owned());
    }
}

// ---------------------------------------------------------------------------
// Child process lifecycle
// ---------------------------------------------------------------------------

pub(crate) fn wait_for_child_output(
    child: &mut Child,
    display: &str,
    cancellation: Option<&AtomicBool>,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<(ExitStatus, String, String)> {
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

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut recent_output = VecDeque::new();
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
            drain_process_lines(
                &receiver,
                &mut stdout,
                &mut stderr,
                progress.as_deref_mut(),
                &mut recent_output,
            );
            bail!("{display} canceled");
        }
        drain_process_lines(
            &receiver,
            &mut stdout,
            &mut stderr,
            progress.as_deref_mut(),
            &mut recent_output,
        );
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for {display}"))?
        {
            break status;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => record_process_line(
                line,
                &mut stdout,
                &mut stderr,
                progress.as_deref_mut(),
                &mut recent_output,
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    drain_process_lines(
        &receiver,
        &mut stdout,
        &mut stderr,
        progress.as_deref_mut(),
        &mut recent_output,
    );
    Ok((status, stdout, stderr))
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

#[derive(Serialize)]
pub(crate) struct ExecRunResult {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: i32,
}

pub(crate) struct ExecRunOpts {
    pub(crate) argv: Vec<String>,
    pub(crate) display: String,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) config_digest: String,
    pub(crate) inputs: Vec<ExecIoSpec>,
    pub(crate) outputs: Vec<ExecIoSpec>,
    pub(crate) tools: Vec<ExecToolSpec>,
    pub(crate) impure: bool,
    pub(crate) force_cache: bool,
    pub(crate) sandbox: bool,
    pub(crate) no_cache: bool,
}

pub(crate) struct ExecIoSpec {
    pub(crate) path: String,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecToolSpec {
    pub name: String,
    pub cache: String,
    pub key: String,
    pub path: PathBuf,
    pub bin_dirs: Vec<String>,
}

pub(crate) fn parse_io_specs<'js>(vals: Vec<Object<'js>>) -> rquickjs::Result<Vec<ExecIoSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let path: Option<String> = val.get("path")?;
        let Some(path) = path else {
            continue;
        };
        let kind: Option<String> = val.get("kind")?;
        let kind = kind.unwrap_or_else(|| "file".to_owned());
        specs.push(ExecIoSpec { path, kind });
    }
    Ok(specs)
}

pub(crate) fn parse_tool_specs<'js>(
    vals: Vec<Object<'js>>,
    workspace_root: &Path,
) -> rquickjs::Result<Vec<ExecToolSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let name: Option<String> = val.get("name")?;
        let Some(name) = name else {
            continue;
        };
        let cache: String = val.get("cache")?;
        let key: String = val.get("key")?;
        let path: Option<String> = val.get("path")?;
        let path = match path {
            Some(p) => PathBuf::from(p),
            None => named_cache_key_path(workspace_root, &cache, &key)
                .map_err(|e| rquickjs::Error::new_loading_message("tool", format!("{e:#}")))?,
        };
        let bin_dirs: Option<Vec<String>> = val.get("binDirs")?;
        specs.push(ExecToolSpec {
            name,
            cache,
            key,
            path,
            bin_dirs: bin_dirs.unwrap_or_else(|| vec!["bin".to_owned()]),
        });
    }
    Ok(specs)
}

pub(crate) fn materialize_tools_into_sandbox(
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

fn validate_tool_name(name: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        bail!("tool name '{name}' must contain only ASCII letters, digits, '-', '_' or '.'");
    }
    Ok(())
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

/// Host environment variables allowed through the sandbox scrub. Anything not
/// listed here (and not synthesized below) is removed before a task runs, so
/// undeclared ambient state cannot silently affect a build. The snapshot is
/// hashed into the action digest, so a change to one of these invalidates the
/// task cache.
pub(crate) const PASSTHROUGH_ENV_VARS: &[&str] = &[
    "PATH",
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
pub(crate) const PASSTHROUGH_ENV_PREFIXES: &[&str] = &["LC_"];

/// Snapshot the allowlisted host environment. Folded into the hashed action
/// digest so ambient state that genuinely affects output keys the cache, and
/// reused as the base env for execution.
pub(crate) fn passthrough_env_snapshot() -> BTreeMap<String, String> {
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

/// Create and return per-sandbox HOME and TMPDIR directories. Pinning these
/// inside the sandbox stops tasks from reading or writing the real home/tmp.
pub(crate) fn sandbox_home_tmp(sandbox_root: &Path) -> Result<(PathBuf, PathBuf)> {
    let home = sandbox_root.join(".imp").join("home");
    let tmp = sandbox_root.join(".imp").join("tmp");
    std::fs::create_dir_all(&home).with_context(|| format!("create {}", home.display()))?;
    std::fs::create_dir_all(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    Ok((home, tmp))
}

/// Ensure a scrubbed env still has a PATH. Sandboxed tasks carry PATH in their
/// hashed base env; ad-hoc/uncached tasks fall back to the host PATH so bare
/// commands like `sh` still resolve after `env_clear`.
pub(crate) fn ensure_path(env: &mut BTreeMap<String, String>) {
    if env.contains_key("PATH") {
        return;
    }
    if let Some(path) = std::env::var_os("PATH") {
        env.insert("PATH".to_owned(), path.to_string_lossy().into_owned());
    }
}

pub(crate) fn sandbox_command_env(
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
    } else if let Some(existing) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(entries).context("join tool PATH entries")?;
    command_env.insert("PATH".to_owned(), joined.to_string_lossy().into_owned());
    Ok(command_env)
}

/// Digest of everything about a `run()` action other than its staged inputs
/// and declared outputs: argv, the merged env it will execute with, the
/// workspace configuration digest, display, and tool specs.
pub(crate) fn live_action_digest(
    opts: &ExecRunOpts,
    base_env: &BTreeMap<String, String>,
) -> Result<String> {
    digest_json(&serde_json::json!({
        "argv": opts.argv,
        "env": base_env,
        "config_digest": opts.config_digest,
        "display": opts.display,
        "tools": opts.tools,
    }))
}

pub(crate) fn exec_run_inner(
    workspace_root: &Path,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
) -> Result<ExecRunResult> {
    if !opts.sandbox {
        if !opts.impure {
            bail!("run({{ sandbox: false }}) requires impure: true");
        }
        return exec_run_unsandboxed(workspace_root, opts, cancellation, None);
    }

    let sandbox_root = create_sandbox_root()?;
    let tool_path_entries = materialize_tools_into_sandbox(&opts.tools, &sandbox_root)?;

    // Copy inputs into sandbox.
    for input in &opts.inputs {
        let relative = artifact_relative_path(&input.path)?;
        let source = workspace_root.join(&relative);
        let sandbox_path = sandbox_root.join(&relative);
        if let Some(parent) = sandbox_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        match input.kind.as_str() {
            "file" | "manifest" => copy_file(&source, &sandbox_path)?,
            "directory" => copy_directory(&source, &sandbox_path)?,
            other => bail!("run() input {} has unsupported kind {other}", input.path),
        }
    }

    // Compute input digests.
    let mut input_digests = Vec::new();
    for input in &opts.inputs {
        let relative = artifact_relative_path(&input.path)?;
        let sandbox_path = sandbox_root.join(&relative);
        let (digest, kind) = match input.kind.as_str() {
            "file" | "manifest" => {
                let (d, _) = store_file_blob(&sandbox_path, &input.kind)?;
                (d, input.kind.clone())
            }
            "directory" => {
                let entries = directory_entries(&sandbox_path)?;
                (digest_json(&entries)?, "directory".to_owned())
            }
            other => bail!("run() input {} has unsupported kind {other}", input.path),
        };
        input_digests.push(CacheInputDigest {
            artifact_id: input.path.clone(),
            kind,
            path: Some(input.path.clone()),
            value: None,
            digest,
        });
    }

    // Compute action digest. The env is the merged map the command will run
    // with (declared env over the allowlisted host snapshot), so ambient
    // changes to passthrough vars invalidate the cache. Per-sandbox
    // HOME/TMPDIR and tool PATH entries are added after digesting — their
    // paths are nondeterministic and must not be keyed.
    let mut base_env = passthrough_env_snapshot();
    base_env.extend(opts.env.clone());
    let action_digest = live_action_digest(&opts, &base_env)?;

    // Compute task key.
    let out_specs: Vec<serde_json::Value> = opts
        .outputs
        .iter()
        .map(|o| serde_json::json!({ "path": o.path, "kind": o.kind }))
        .collect();
    let task_key = digest_json(&serde_json::json!({
        "version": TASK_CACHE_VERSION,
        "action_digest": action_digest,
        "input_digests": input_digests,
        "outputs": out_specs,
    }))?;

    // Check cache.
    let cacheable = !opts.impure || opts.force_cache;
    let record_path = task_record_path(&task_key)?;
    let cached_outputs_opt: Option<Vec<CachedArtifact>> = if cacheable && !opts.no_cache {
        match std::fs::read_to_string(&record_path) {
            Ok(encoded) => {
                let record: TaskCacheRecord =
                    serde_json::from_str(&encoded).with_context(|| {
                        format!("parse exec cache record {}", record_path.display())
                    })?;
                match cached_outputs_present(&record) {
                    Ok(()) => Some(record.outputs),
                    Err(_) => None,
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(e).with_context(|| format!("read {}", record_path.display()));
            }
        }
    } else {
        None
    };

    if let Some(outputs) = cached_outputs_opt {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
            task_id: task_key.clone(),
            task_key,
            action_digest,
            input_digests,
            named_caches: vec![],
            outputs,
        };
        materialize_cached_outputs(&record, workspace_root)?;
        return Ok(ExecRunResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        });
    }

    // Cache miss — run the command.
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
    ensure_path(&mut command_env);
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&sandbox_root)
        .env_clear()
        .envs(&command_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .with_context(|| format!("run() command in {}", sandbox_root.display()))?;

    let (status, stdout, stderr) =
        wait_for_child_output(&mut child, &opts.display, cancellation, None)?;

    let exit_code = status.code().unwrap_or(-1);
    if !status.success() {
        bail!(
            "{} failed with exit code {}\nstdout:\n{}\nstderr:\n{}",
            opts.display,
            exit_code,
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    // Ingest outputs into CAS.
    let mut cached_outputs = Vec::new();
    for output in &opts.outputs {
        let relative = artifact_relative_path(&output.path)?;
        let sandbox_path = sandbox_root.join(&relative);
        match output.kind.as_str() {
            "file" | "manifest" => {
                if !sandbox_path.is_file() {
                    bail!(
                        "run() output {} was not created as a file in sandbox",
                        output.path
                    );
                }
                let (digest, bytes) = store_file_blob(&sandbox_path, &output.kind)?;
                cached_outputs.push(CachedArtifact {
                    artifact_id: output.path.clone(),
                    kind: output.kind.clone(),
                    path: Some(output.path.clone()),
                    value: None,
                    digest,
                    bytes: Some(bytes),
                    mode: file_mode(&sandbox_path)?,
                    files: Vec::new(),
                });
            }
            "directory" => {
                if !sandbox_path.is_dir() {
                    bail!(
                        "run() output {} was not created as a directory in sandbox",
                        output.path
                    );
                }
                let files = directory_entries(&sandbox_path)?;
                let digest = digest_json(&files)?;
                cached_outputs.push(CachedArtifact {
                    artifact_id: output.path.clone(),
                    kind: output.kind.clone(),
                    path: Some(output.path.clone()),
                    value: None,
                    digest,
                    bytes: None,
                    mode: None,
                    files,
                });
            }
            other => bail!("run() output {} has unsupported kind {other}", output.path),
        }
    }

    // Cache record and materialize.
    if cacheable {
        let record = TaskCacheRecord {
            version: TASK_CACHE_VERSION,
            task_id: task_key.clone(),
            task_key,
            action_digest,
            input_digests,
            named_caches: vec![],
            outputs: cached_outputs,
        };
        if !opts.no_cache {
            write_task_cache_record(&record)?;
        }
        materialize_cached_outputs(&record, workspace_root)?;
    }

    Ok(ExecRunResult {
        stdout,
        stderr,
        exit_code,
    })
}

pub(crate) fn exec_run_unsandboxed(
    workspace_root: &Path,
    opts: ExecRunOpts,
    cancellation: Option<&AtomicBool>,
    mut progress: Option<&mut prodash::tree::Item>,
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

    // Unsandboxed tasks are impure and run in the workspace, so HOME/TMPDIR pass
    // through from the host rather than being pinned to a sandbox. We still scrub
    // everything outside the allowlist to keep behaviour consistent with sandboxed
    // execution.
    let mut base_env = passthrough_env_snapshot();
    for var in ["HOME", "TMPDIR"] {
        if let Some(value) = std::env::var_os(var) {
            base_env.insert(var.to_owned(), value.to_string_lossy().into_owned());
        }
    }
    base_env.extend(opts.env.clone());
    let mut command_env = sandbox_command_env(&base_env, &tool_path_entries)?;
    ensure_path(&mut command_env);
    let mut command = Command::new(program);
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

    let (status, stdout, stderr) = wait_for_child_output(
        &mut child,
        &opts.display,
        cancellation,
        progress.as_deref_mut(),
    )?;

    let exit_code = status.code().unwrap_or(-1);
    if !status.success() {
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

    fn digest_opts(env: &[(&str, &str)], config_digest: &str) -> ExecRunOpts {
        ExecRunOpts {
            argv: vec!["sh".to_owned(), "-c".to_owned(), "true".to_owned()],
            display: "digest test".to_owned(),
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            config_digest: config_digest.to_owned(),
            inputs: Vec::new(),
            outputs: Vec::new(),
            tools: Vec::new(),
            impure: false,
            force_cache: false,
            sandbox: true,
            no_cache: false,
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
                    path: (*p).to_owned(),
                    kind: "file".to_owned(),
                })
                .collect()
        };
        ExecRunOpts {
            argv: argv.iter().map(|a| (*a).to_owned()).collect(),
            display: "exec test".to_owned(),
            env: BTreeMap::new(),
            config_digest: String::new(),
            inputs: spec(inputs),
            outputs: spec(outputs),
            tools: Vec::new(),
            impure: false,
            force_cache: false,
            sandbox: true,
            no_cache: false,
        }
    }

    fn marker_count(marker: &std::path::Path) -> usize {
        std::fs::read_to_string(marker).map(|s| s.len()).unwrap_or(0)
    }

    #[test]
    fn exec_run_unchanged_rerun_hits_task_cache() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let cmd = format!(
            "printf r >> '{}' && mkdir -p build && printf payload > build/out.txt",
            marker.display()
        );
        let opts = || run_opts(&["sh", "-c", &cmd], &[], &["build/out.txt"]);

        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 1);
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "payload"
        );

        std::fs::remove_file(p.join("build/out.txt")).unwrap();
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(marker_count(&marker), 1, "second run must be a cache hit");
        assert_eq!(
            std::fs::read_to_string(p.join("build/out.txt")).unwrap(),
            "payload",
            "cache hit must rematerialize declared outputs"
        );
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
        assert_eq!(std::fs::read_to_string(p.join("build/out.txt")).unwrap(), "one");

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
        assert_eq!(std::fs::read_to_string(p.join("build/out.txt")).unwrap(), "two");
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
        assert_eq!(marker_count(&marker), 1, "force_cache must cache impure runs");
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
        assert_eq!(std::fs::read_to_string(p.join("build/out.txt")).unwrap(), "");
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
                path: "build/dir".to_owned(),
                kind: "directory".to_owned(),
            }];
            o
        };
        exec_run_inner(p, opts(), None).unwrap();
        assert_eq!(std::fs::read_to_string(p.join("build/dir/a.txt")).unwrap(), "a");
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
}
