use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;

use anyhow::{bail, Context, Result};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::cache::{
    digest_bytes, disable_task_cache, evaluate_task_cache_with_lookup, ingest_task_outputs,
    materialize_cached_outputs, materialize_embedded_output_task,
    materialize_task_outputs_without_record, prepare_sandbox, resolve_sandbox_path,
    write_task_cache_record, TaskCacheEvaluation, TaskCacheRecord, TaskCacheSummary,
    TASK_CACHE_VERSION,
};
use crate::exec::{
    ensure_path, exec_run_unsandboxed, materialize_tools_into_sandbox, report_process_failure,
    sandbox_command_env, sandbox_home_tmp, wait_for_child_output, ExecIoSpec, ExecRunOpts,
};
use crate::runtime::LiveWorkspace;
use crate::spike::{NamedCache, Plan, Task};

// ---------------------------------------------------------------------------
// Execution types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    DryRun,
    Local,
}

#[derive(Debug, Clone)]
pub struct ExecutionOptions {
    pub mode: ExecutionMode,
    pub jobs: usize,
    /// When true, planned tasks neither read from nor write to the task cache.
    pub no_cache: bool,
    /// Name of the active platform; only tasks whose `action.platform` matches
    /// (or is `None`) are executed. Defaults to `"local"`.
    pub platform: String,
    /// Shared cancellation flag set by signal handlers or executor failures.
    pub cancellation: Arc<AtomicBool>,
}

impl ExecutionOptions {
    pub fn new(mode: ExecutionMode, jobs: usize) -> Self {
        Self {
            mode,
            jobs: jobs.max(1),
            no_cache: false,
            platform: "local".to_owned(),
            cancellation: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_platform(mut self, platform: impl Into<String>) -> Self {
        self.platform = platform.into();
        self
    }

    pub fn with_no_cache(mut self, no_cache: bool) -> Self {
        self.no_cache = no_cache;
        self
    }

    pub fn with_cancellation(mut self, cancellation: Arc<AtomicBool>) -> Self {
        self.cancellation = cancellation;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskExecutionStatus {
    WouldRun,
    CacheHit,
    Ran,
    Noop,
    /// Task was not executed because its platform requirement doesn't match the
    /// active platform.
    SkippedPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskExecution {
    pub task_id: String,
    pub status: TaskExecutionStatus,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    pub tasks: Vec<TaskExecution>,
}

// ---------------------------------------------------------------------------
// Task ordering
// ---------------------------------------------------------------------------

pub(crate) fn ordered_tasks(plan: &Plan) -> Result<Vec<&Task>> {
    let mut pending: BTreeMap<&str, &Task> = plan
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let mut completed = BTreeSet::new();
    let mut ordered = Vec::with_capacity(plan.tasks.len());

    while !pending.is_empty() {
        let ready_ids: Vec<String> = pending
            .iter()
            .filter_map(|(id, task)| {
                let ready = task.dependencies.iter().all(|dep| completed.contains(dep));
                ready.then(|| (*id).to_owned())
            })
            .collect();

        if ready_ids.is_empty() {
            let unresolved = pending
                .values()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("task graph has unresolved dependencies or a cycle: {unresolved}");
        }

        for id in ready_ids {
            let task = pending
                .remove(id.as_str())
                .expect("ready id came from pending");
            for dep in &task.dependencies {
                if !completed.contains(dep)
                    && !plan.tasks.iter().any(|candidate| &candidate.id == dep)
                {
                    bail!("{} depends on missing task {dep}", task.id);
                }
            }
            completed.insert(id);
            ordered.push(task);
        }
    }

    Ok(ordered)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn execute_plan(
    plan: &Plan,
    workspace_root: &Path,
    mode: ExecutionMode,
) -> Result<ExecutionReport> {
    execute_plan_with_options(
        plan,
        None,
        workspace_root,
        ExecutionOptions::new(mode, 1),
        None,
    )
}

#[allow(dead_code)]
pub fn execute_plan_with_progress(
    plan: &Plan,
    workspace_root: &Path,
    mode: ExecutionMode,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<ExecutionReport> {
    execute_plan_with_options(
        plan,
        None,
        workspace_root,
        ExecutionOptions::new(mode, 1),
        progress.as_deref_mut(),
    )
}

pub fn execute_plan_with_options(
    plan: &Plan,
    _live: Option<&LiveWorkspace>,
    workspace_root: &Path,
    options: ExecutionOptions,
    progress: Option<&mut prodash::tree::Item>,
) -> Result<ExecutionReport> {
    let ordered = ordered_tasks(plan)?;
    if let Some(progress) = progress.as_deref() {
        progress.set(0);
        progress.set_max(Some(ordered.len()));
    }

    let executions = if options.jobs <= 1 {
        execute_ordered_tasks_sequentially(
            &ordered,
            workspace_root,
            options.mode,
            &options.platform,
            options.no_cache,
            &plan.named_caches,
            &plan.config_digest,
            &options.cancellation,
            progress,
        )?
    } else {
        execute_ordered_tasks_parallel(
            &ordered,
            workspace_root,
            options,
            &plan.named_caches,
            &plan.config_digest,
            progress,
        )?
    };
    Ok(ExecutionReport { tasks: executions })
}

fn execute_ordered_tasks_sequentially(
    ordered: &[&Task],
    workspace_root: &Path,
    mode: ExecutionMode,
    active_platform: &str,
    no_cache: bool,
    named_caches: &[NamedCache],
    config_digest: &str,
    cancellation: &AtomicBool,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<Vec<TaskExecution>> {
    let mut executions = Vec::with_capacity(ordered.len());
    let mut summaries = BTreeMap::new();
    for task in ordered {
        let mut task_progress = progress.as_deref_mut().map(|progress| {
            let item = progress.add_child(task_progress_label(task));
            crate::ui::init_task(&item);
            item
        });

        let result = execute_one_task(
            task,
            workspace_root,
            mode,
            active_platform,
            no_cache,
            named_caches,
            config_digest,
            &summaries,
            task_progress.as_mut(),
            cancellation,
        );

        let (execution, summary) = match result {
            Ok(result) => result,
            Err(error) => {
                if let Some(task_progress) = task_progress.as_mut() {
                    task_progress.fail("failed");
                }
                return Err(error);
            }
        };

        if let Some(task_progress) = task_progress.as_ref() {
            task_progress.set(1);
        }
        if let Some(progress) = progress.as_deref() {
            progress.inc();
        }
        summaries.insert(task.id.clone(), summary);
        executions.push(execution);
    }

    Ok(executions)
}

fn task_progress_label(task: &Task) -> String {
    if task.action.display.is_empty() {
        format!("execute {}", task.id)
    } else {
        task.action.display.clone()
    }
}

fn execute_ordered_tasks_parallel(
    ordered: &[&Task],
    workspace_root: &Path,
    options: ExecutionOptions,
    named_caches: &[NamedCache],
    config_digest: &str,
    mut progress: Option<&mut prodash::tree::Item>,
) -> Result<Vec<TaskExecution>> {
    let mut task_by_id: BTreeMap<&str, &Task> = ordered
        .iter()
        .map(|task| (task.id.as_str(), *task))
        .collect();
    let plan_index: BTreeMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .map(|(i, task)| (task.id.as_str(), i))
        .collect();
    let mut completed = BTreeSet::new();
    let mut summaries = BTreeMap::new();
    let mut running = BTreeSet::new();
    let mut executions: Vec<Option<TaskExecution>> = vec![None; ordered.len()];
    let (sender, receiver) = mpsc::channel();
    let cancellation = options.cancellation;
    let mut first_error = None;

    while completed.len() < ordered.len() {
        if first_error.is_none() {
            let ready_ids: Vec<String> = task_by_id
                .iter()
                .filter_map(|(id, task)| {
                    let ready = !running.contains(*id)
                        && !completed.contains(*id)
                        && task.dependencies.iter().all(|dep| completed.contains(dep));
                    ready.then(|| (*id).to_owned())
                })
                .take(options.jobs.saturating_sub(running.len()))
                .collect();

            for id in ready_ids {
                let task = task_by_id
                    .remove(id.as_str())
                    .expect("ready id came from pending tasks");
                running.insert(id.clone());
                let mut task_progress = progress.as_deref_mut().map(|progress| {
                    let item = progress.add_child(task_progress_label(task));
                    crate::ui::init_task(&item);
                    item
                });
                let sender = sender.clone();
                let workspace_root = workspace_root.to_owned();
                let mode = options.mode;
                let active_platform = options.platform.clone();
                let no_cache = options.no_cache;
                let named_caches = named_caches.to_vec();
                let config_digest = config_digest.to_owned();
                let dependency_summaries = summaries.clone();
                let task = task.clone();
                let cancellation = Arc::clone(&cancellation);
                thread::spawn(move || {
                    let id = task.id.clone();
                    let result = execute_one_task(
                        &task,
                        &workspace_root,
                        mode,
                        &active_platform,
                        no_cache,
                        &named_caches,
                        &config_digest,
                        &dependency_summaries,
                        task_progress.as_mut(),
                        &cancellation,
                    );
                    let _ = sender.send((id, result));
                });
            }
        }

        if running.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
            let unresolved = task_by_id.keys().copied().collect::<Vec<_>>().join(", ");
            bail!("task graph has unresolved dependencies or a cycle: {unresolved}");
        }

        let (id, result) = receiver
            .recv()
            .context("parallel task worker channel closed unexpectedly")?;
        running.remove(id.as_str());
        match result {
            Ok((execution, summary)) => {
                if let Some(progress) = progress.as_deref() {
                    progress.inc();
                }
                let index = *plan_index
                    .get(id.as_str())
                    .ok_or_else(|| anyhow::anyhow!("completed unknown task {id}"))?;
                executions[index] = Some(execution);
                summaries.insert(id.clone(), summary);
                completed.insert(id);
            }
            Err(error) => {
                if first_error.is_none() {
                    cancellation.store(true, Ordering::SeqCst);
                    first_error = Some(error);
                }
            }
        }
    }

    if let Some(error) = first_error {
        return Err(error);
    }

    executions
        .into_iter()
        .map(|execution| execution.ok_or_else(|| anyhow::anyhow!("missing task execution result")))
        .collect()
}

fn execute_one_task(
    task: &Task,
    workspace_root: &Path,
    mode: ExecutionMode,
    active_platform: &str,
    no_cache: bool,
    named_caches: &[NamedCache],
    config_digest: &str,
    completed_dependencies: &BTreeMap<String, TaskCacheSummary>,
    mut progress: Option<&mut prodash::tree::Item>,
    cancellation: &AtomicBool,
) -> Result<(TaskExecution, TaskCacheSummary)> {
    let command = task.action.argv.clone();

    // Platform check: tasks with a platform constraint only run on that platform.
    let task_platform = task.action.platform.as_deref().unwrap_or("local");
    if task_platform != active_platform {
        if let Some(progress) = progress.as_mut() {
            progress.done("skipped (platform)");
        }
        return Ok((
            TaskExecution {
                task_id: task.id.clone(),
                status: TaskExecutionStatus::SkippedPlatform,
                command,
            },
            TaskCacheSummary {
                task_id: task.id.clone(),
                task_key: String::new(),
            },
        ));
    }

    let status =
        match mode {
            ExecutionMode::DryRun => {
                if let Some(progress) = progress.as_mut() {
                    progress.done("would run");
                }
                TaskExecutionStatus::WouldRun
            }
            ExecutionMode::Local if command.is_empty() && task.outputs.is_empty() => {
                if let Some(progress) = progress.as_mut() {
                    progress.done("noop");
                }
                TaskExecutionStatus::Noop
            }
            ExecutionMode::Local if !task.action.sandbox => {
                if !task.action.impure {
                    bail!("{} uses sandbox: false and must set impure: true", task.id);
                }
                run_unsandboxed_task(task, workspace_root, cancellation, progress.as_deref_mut())?;
                if let Some(progress) = progress.as_mut() {
                    progress.done("done");
                }
                TaskExecutionStatus::Ran
            }
            ExecutionMode::Local if command.is_empty() => {
                let mut evaluation = evaluate_task_cache_with_lookup(
                    task,
                    workspace_root,
                    named_caches,
                    config_digest,
                    completed_dependencies,
                    !no_cache,
                )?;
                if no_cache {
                    disable_task_cache(&mut evaluation);
                }
                if evaluation.hit {
                    let record = evaluation.record.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("cache hit for {} had no record", task.id)
                    })?;
                    materialize_cached_outputs(record, workspace_root)?;
                    if let Some(progress) = progress.as_mut() {
                        progress.done("cache hit");
                    }
                    return Ok((
                        TaskExecution {
                            task_id: task.id.clone(),
                            status: TaskExecutionStatus::CacheHit,
                            command,
                        },
                        TaskCacheSummary {
                            task_id: task.id.clone(),
                            task_key: evaluation.task_key,
                        },
                    ));
                }

                materialize_embedded_output_task(task, workspace_root, &evaluation)?;
                if let Some(progress) = progress.as_mut() {
                    progress.done("done");
                }
                TaskExecutionStatus::Ran
            }
            ExecutionMode::Local => {
                let mut evaluation = evaluate_task_cache_with_lookup(
                    task,
                    workspace_root,
                    named_caches,
                    config_digest,
                    completed_dependencies,
                    !no_cache,
                )?;
                if no_cache {
                    disable_task_cache(&mut evaluation);
                }
                if evaluation.hit {
                    let record = evaluation.record.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("cache hit for {} had no record", task.id)
                    })?;
                    materialize_cached_outputs(record, workspace_root)?;
                    if let Some(progress) = progress.as_mut() {
                        progress.done("cache hit");
                    }
                    return Ok((
                        TaskExecution {
                            task_id: task.id.clone(),
                            status: TaskExecutionStatus::CacheHit,
                            command,
                        },
                        TaskCacheSummary {
                            task_id: task.id.clone(),
                            task_key: evaluation.task_key,
                        },
                    ));
                }

                if let Err(error) = run_local_task(
                    task,
                    workspace_root,
                    progress.as_deref_mut(),
                    cancellation,
                    &evaluation,
                ) {
                    if let Some(progress) = progress.as_mut() {
                        progress.fail("failed");
                    }
                    return Err(error);
                }
                if let Some(progress) = progress.as_mut() {
                    progress.done("done");
                }
                TaskExecutionStatus::Ran
            }
        };

    let summary_key = match mode {
        ExecutionMode::DryRun => digest_bytes(task.id.as_bytes()),
        ExecutionMode::Local => {
            evaluate_task_cache_with_lookup(
                task,
                workspace_root,
                named_caches,
                config_digest,
                completed_dependencies,
                !no_cache,
            )?
            .task_key
        }
    };
    Ok((
        TaskExecution {
            task_id: task.id.clone(),
            status,
            command,
        },
        TaskCacheSummary {
            task_id: task.id.clone(),
            task_key: summary_key,
        },
    ))
}

fn run_unsandboxed_task(
    task: &Task,
    workspace_root: &Path,
    cancellation: &AtomicBool,
    progress: Option<&mut prodash::tree::Item>,
) -> Result<()> {
    let opts = ExecRunOpts {
        argv: task.action.argv.clone(),
        display: task.action.display.clone(),
        env: task.action.env.clone(),
        inputs: task
            .inputs
            .iter()
            .filter_map(|artifact| {
                artifact.path.as_ref().map(|path| ExecIoSpec {
                    path: path.clone(),
                    kind: artifact.kind.clone(),
                })
            })
            .collect(),
        outputs: task
            .outputs
            .iter()
            .filter_map(|artifact| {
                artifact.path.as_ref().map(|path| ExecIoSpec {
                    path: path.clone(),
                    kind: artifact.kind.clone(),
                })
            })
            .collect(),
        tools: task.action.tools.clone(),
        impure: true,
        force_cache: false,
        sandbox: false,
    };
    exec_run_unsandboxed(workspace_root, opts, Some(cancellation), progress).map(|_| ())
}

fn run_local_task(
    task: &Task,
    workspace_root: &Path,
    mut progress: Option<&mut prodash::tree::Item>,
    cancellation: &AtomicBool,
    cache: &TaskCacheEvaluation,
) -> Result<()> {
    if cancellation.load(Ordering::SeqCst) {
        bail!("{} canceled before execution", task.id);
    }

    let sandbox = prepare_sandbox(task, workspace_root)?;
    let tool_path_entries =
        materialize_tools_into_sandbox(&task.action.tools, &sandbox.sandbox_root)?;
    let manifest_path = sandbox.sandbox_root.join("imp-sandbox.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&sandbox)?)
        .with_context(|| format!("write sandbox manifest {}", manifest_path.display()))?;

    let cwd = task
        .action
        .cwd
        .as_deref()
        .map(|cwd| resolve_sandbox_path(&sandbox.sandbox_root, cwd))
        .transpose()?
        .unwrap_or_else(|| sandbox.sandbox_root.clone());
    std::fs::create_dir_all(&cwd).with_context(|| format!("create cwd {}", cwd.display()))?;
    let cmd_display = if task.action.display.is_empty() {
        task.action.argv.join(" ")
    } else {
        task.action.display.clone()
    };
    let command_line = format_argv(&task.action.argv);

    let (program, args) = task
        .action
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("{} has no argv", task.id))?;

    let mut task_env = BTreeMap::new();
    for binding in &cache.named_caches {
        std::fs::create_dir_all(&binding.path)
            .with_context(|| format!("create named cache {}", binding.path.display()))?;
        task_env.insert(
            binding.env_var.clone(),
            binding.path.to_string_lossy().into_owned(),
        );
    }
    let command_env = sandbox_command_env(&task.action.env, &tool_path_entries)?;
    task_env.extend(command_env.clone());
    let (home_dir, tmp_dir) = sandbox_home_tmp(&sandbox.sandbox_root)?;
    task_env.insert("HOME".to_owned(), home_dir.to_string_lossy().into_owned());
    task_env.insert("TMPDIR".to_owned(), tmp_dir.to_string_lossy().into_owned());
    ensure_path(&mut task_env);
    task_env.insert(
        "IMP_SANDBOX_ROOT".to_owned(),
        sandbox.sandbox_root.to_string_lossy().into_owned(),
    );
    task_env.insert(
        "IMP_CACHE_ROOT".to_owned(),
        sandbox.cache_root.to_string_lossy().into_owned(),
    );
    task_env.insert(
        "IMP_SANDBOX_MANIFEST".to_owned(),
        manifest_path.to_string_lossy().into_owned(),
    );

    let script_path = sandbox.sandbox_root.join("imp-run.sh");
    write_sandbox_run_script(&script_path, &cwd, &task_env, &task.action.argv)?;

    let sandbox_name = sandbox
        .sandbox_root
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_else(|| "<unknown>".into());

    if let Some(progress) = progress.as_mut() {
        progress.set_name(format!("execute {cmd_display} - {}", sandbox_name));
    }

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&cwd)
        .env_clear()
        .envs(&task_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .with_context(|| format!("execute {} in {}", task.id, cwd.display()))?;

    let (status, stdout, stderr) = wait_for_child_output(
        &mut child,
        &task.id,
        Some(cancellation),
        progress.as_deref_mut(),
    )?;

    if !status.success() {
        report_process_failure(progress.as_deref(), &stdout, &stderr);
        bail!(
            "{} failed with status {}\ncommand: {}\ncwd: {}\nstdout:\n{}\nstderr:\n{}",
            task.id,
            status,
            command_line,
            cwd.display(),
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    let outputs = ingest_task_outputs(task, &sandbox)?;
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

pub(crate) fn format_argv(argv: &[String]) -> String {
    if argv.is_empty() {
        return "<no argv>".to_owned();
    }
    argv.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '='))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

pub(crate) fn write_sandbox_run_script(
    script_path: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    argv: &[String],
) -> Result<()> {
    let mut script = String::new();
    script.push_str("#!/usr/bin/env sh\n");
    script.push_str("set -eu\n");
    script.push_str(&format!("cd {}\n", shell_quote(&cwd.to_string_lossy())));
    for (key, value) in env {
        if is_shell_identifier(key) {
            script.push_str(&format!("export {key}={}\n", shell_quote(value)));
        } else {
            script.push_str(&format!(
                "# skipped non-shell env key {}={}\n",
                shell_quote(key),
                shell_quote(value)
            ));
        }
    }
    script.push_str(&format!("exec {}\n", format_argv(argv)));
    std::fs::write(script_path, script)
        .with_context(|| format!("write sandbox run script {}", script_path.display()))?;
    #[cfg(unix)]
    {
        let mut permissions = std::fs::metadata(script_path)
            .with_context(|| format!("stat sandbox run script {}", script_path.display()))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(script_path, permissions)
            .with_context(|| format!("chmod sandbox run script {}", script_path.display()))?;
    }
    Ok(())
}

fn is_shell_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(ch) if ch == '_' || ch.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}
