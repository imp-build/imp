mod cache;
mod codegen;
mod commands;
mod env;
mod exec;
mod loader;
mod runtime;
mod scheduler;
mod spike;
mod toolchain;
mod ui;
mod workspace;

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use env::{Env, LocalEnv, WslEnv};

type Tree = ui::Tree;

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    name = "imp",
    about = "Build system for the Odin game engine project"
)]
struct Cli {
    /// Use WSL cross-compilation environment (Linux → Windows)
    #[arg(long, global = true)]
    cross_compile: bool,
    /// Skip syncing workspace to target environment
    #[arg(long, global = true)]
    no_sync: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Download and install required toolchains
    Setup {
        /// Also install the Windows cross-compilation toolchain
        #[arg(long)]
        windows: bool,
    },
    /// Synchronise workspace to the target environment
    Sync,
    /// Check build environment and requirements
    EnvCheck {
        #[arg(long)]
        cross_compile: bool,
    },
    /// List targets in the workspace (QuickJS spike)
    Targets {
        /// Target addresses or names to select; defaults to all targets
        selectors: Vec<String>,
    },
    /// List target dependencies (QuickJS spike)
    Dependencies {
        /// Target addresses or names to select; defaults to all root targets
        selectors: Vec<String>,
    },
    /// List target types and rules in the workspace (QuickJS spike)
    Rules,
    /// Generate the Odin module/component/asset registration file
    CodegenRegister {
        /// Output path for the generated file
        output: PathBuf,
    },
    /// Generate or check BUILD.js files from declared generator targets
    GenerateBuild {
        /// Check that generated BUILD.js files are up to date without writing
        #[arg(long)]
        check: bool,
        /// Optional generator target selectors; defaults to all registered generate-build products
        selectors: Vec<String>,
    },
    /// Build the selected targets; defaults to the workspace default build roots
    Build(GoalArgs),
    /// Run tests for the selected targets
    Test(GoalArgs),
    /// Format the selected targets
    Fmt(GoalArgs),
    /// Lint the selected targets
    Lint(GoalArgs),
    /// Package the selected targets
    Package(GoalArgs),
    /// Run the selected targets
    Run(GoalArgs),
    /// Run any registered goal by name, e.g. `imp goal vs //:target`
    Goal {
        /// Goal name, e.g. "vs", "build", "fmt"
        name: String,
        #[command(flatten)]
        args: GoalArgs,
    },
    /// Import JS rule-test modules and run their registered tests. Invoked by
    /// the rules-test product inside a task sandbox; not for direct use.
    #[command(hide = true)]
    RulesTest {
        /// Workspace-rooted test modules, e.g. //rules/odin/index_test
        modules: Vec<String>,
    },
}

#[derive(clap::Args)]
struct GoalArgs {
    /// Target selectors, e.g. //:app or //:app#build
    selectors: Vec<String>,
    /// Maximum number of ready tasks to execute concurrently
    #[arg(long, default_value_t = 1)]
    jobs: usize,
    /// Number of concurrent JS worker slots for live evaluation
    #[arg(long)]
    js_workers: Option<usize>,
    /// Run actions without reading or writing the task cache
    #[arg(long)]
    no_cache: bool,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let cancellation = install_termination_signal_flag()?;

    let ui = ui::Session::start();
    let result = run_inner(cli, ui.tree(), cancellation).await;
    ui.shutdown();

    result
}

fn install_termination_signal_flag() -> Result<Arc<AtomicBool>> {
    let cancellation = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        for signal in signal_hook::consts::TERM_SIGNALS {
            signal_hook::flag::register(*signal, Arc::clone(&cancellation))
                .with_context(|| format!("register signal handler for {signal}"))?;
        }
    }
    #[cfg(not(unix))]
    {
        signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&cancellation))
            .context("register signal handler for SIGINT")?;
    }
    Ok(cancellation)
}

async fn run_inner(cli: Cli, tree: &Tree, cancellation: Arc<AtomicBool>) -> Result<()> {
    // The QuickJS spike only evaluates workspace definition files. It
    // must not acquire this project's toolchains or generate workspace files.
    match &cli.command {
        Cmd::Targets { selectors } => {
            return cmd_targets(selectors, tree).await;
        }
        Cmd::Dependencies { selectors } => {
            return cmd_dependencies(selectors, tree).await;
        }
        Cmd::Rules => {
            return cmd_rules(tree).await;
        }
        Cmd::Build(args) => {
            return cmd_execute_goal("build", args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Test(args) => {
            return cmd_execute_goal("test", args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Fmt(args) => {
            return cmd_execute_goal("fmt", args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Lint(args) => {
            return cmd_execute_goal("lint", args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Package(args) => {
            return cmd_execute_goal("package", args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Run(args) => {
            return cmd_execute_goal("run", args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Goal { name, args } => {
            return cmd_execute_goal(name, args, Arc::clone(&cancellation), tree).await;
        }
        Cmd::RulesTest { modules } => {
            return cmd_rules_test(modules, Arc::clone(&cancellation), tree).await;
        }
        Cmd::GenerateBuild { check, selectors } => {
            return cmd_generate_build(*check, selectors, tree).await;
        }
        Cmd::CodegenRegister { output } => {
            return commands::codegen_register::run(output).await;
        }
        _ => {}
    }

    // `setup` only needs local env + toolchain download
    if let Cmd::Setup { windows } = &cli.command {
        let mut p = tree.add_child("setup toolchains");
        toolchain::setup_toolchains(&mut p, *windows).await?;
        p.done("toolchains ready");
        return Ok(());
    }

    let cross_compile = cli.cross_compile || matches!(cli.command, Cmd::Sync);

    if cross_compile {
        let mut p = tree.add_child("validate WSL environment");
        WslEnv::new().validate().await?;
        p.done("WSL ok");
    }

    {
        let local = LocalEnv::new();
        local
            .ensure_paths(&[
                workspace::build_dir(),
                workspace::dist_dir(),
                workspace::coverage_dir(),
            ])
            .await?;
    }

    {
        let mut p = tree.add_child("check toolchains");
        toolchain::setup_toolchains(&mut p, cross_compile).await?;
    }

    {
        let mut p = tree.add_child("refresh module list");
        codegen::update_module_list(&mut p).await?;
    }

    let mut target_env = if cross_compile {
        Env::Wsl(WslEnv::new())
    } else {
        Env::Local(LocalEnv::new())
    };

    if !cli.no_sync && !matches!(cli.command, Cmd::Sync | Cmd::Setup { .. }) {
        if let Env::Wsl(wsl) = &mut target_env {
            let mut p = tree.add_child("sync workspace → Windows");
            wsl.sync(&mut p).await?;
            p.done("synced");
        }
    }

    let result = dispatch(&cli.command, &target_env, tree).await;

    if let Env::Wsl(wsl) = &target_env {
        if wsl.synced {
            let mut p = tree.add_child("copy artifacts back");
            wsl.copy_artifacts_back().await?;
            p.done("artifacts copied");
        }
    }

    result
}

async fn dispatch(cmd: &Cmd, env: &Env, tree: &Tree) -> Result<()> {
    match cmd {
        Cmd::Setup { .. } => unreachable!("handled above"),

        Cmd::Sync => {
            println!("Workspace sync complete.");
            Ok(())
        }

        Cmd::EnvCheck { cross_compile } => cmd_env_check(env, *cross_compile, tree).await,

        Cmd::Targets { .. } => unreachable!("handled before environment setup"),
        Cmd::Dependencies { .. } => unreachable!("handled before environment setup"),
        Cmd::Rules => unreachable!("handled before environment setup"),
        Cmd::GenerateBuild { .. } => unreachable!("handled before environment setup"),
        Cmd::CodegenRegister { .. } => unreachable!("handled before environment setup"),
        Cmd::Build(_)
        | Cmd::Test(_)
        | Cmd::Fmt(_)
        | Cmd::Lint(_)
        | Cmd::Package(_)
        | Cmd::Run(_)
        | Cmd::Goal { .. }
        | Cmd::RulesTest { .. } => unreachable!("handled before environment setup"),
    }
}

async fn load_workspace_with_messages(
    workspace_root: &std::path::Path,
    tree: &Tree,
) -> Result<runtime::LiveWorkspace> {
    runtime::load_workspace_with_host_log(workspace_root, tree.log_sink()).await
}

fn effective_js_workers(workspace: &spike::Workspace, cli_value: Option<usize>) -> Result<usize> {
    if let Some(value) = cli_value {
        return Ok(value.max(1));
    }

    let Some(value) = workspace
        .workspace_config
        .get("imp")
        .and_then(|config| config.get("jsWorkers"))
    else {
        return Ok(1);
    };

    let Some(count) = value.as_u64() else {
        anyhow::bail!("configure(\"imp\", {{ jsWorkers }}) must use a positive integer");
    };
    if count == 0 {
        anyhow::bail!("configure(\"imp\", {{ jsWorkers }}) must use a positive integer");
    }
    usize::try_from(count)
        .map_err(|_| anyhow::anyhow!("configure(\"imp\", {{ jsWorkers }}) is too large"))
}

/// What to drive on the live evaluation path: a goal over selected targets, or
/// a JS rule-test suite (the hidden `rules-test` subcommand, invoked by the
/// rules-test product inside a task sandbox).
#[derive(Clone, Copy)]
enum LiveInvocation<'a> {
    Goal {
        goal: &'a str,
        selectors: &'a [String],
    },
    RulesTests {
        modules: &'a [String],
    },
}

async fn cmd_execute_goal(
    goal: &str,
    args: &GoalArgs,
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    cmd_execute_live(
        LiveInvocation::Goal {
            goal,
            selectors: &args.selectors,
        },
        args.jobs,
        args.js_workers,
        args.no_cache,
        cancellation,
        tree,
    )
    .await
}

async fn cmd_rules_test(
    modules: &[String],
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    cmd_execute_live(
        LiveInvocation::RulesTests { modules },
        1,
        None,
        false,
        cancellation,
        tree,
    )
    .await
}

async fn cmd_execute_live(
    invocation: LiveInvocation<'_>,
    jobs: usize,
    js_workers: Option<usize>,
    no_cache: bool,
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = {
        let mut p = tree.add_child("load workspace");
        let ws = load_workspace_with_messages(&workspace_root, tree).await?;
        p.done("workspace loaded");
        ws
    };
    let js_workers = effective_js_workers(&workspace.workspace, js_workers)?;

    if cancellation.load(Ordering::SeqCst) {
        anyhow::bail!("execution canceled");
    }

    // Resolve selectors into concrete root targets so we know the total count
    // upfront, before the scheduler or renderer starts. Rule-test runs have no
    // target roots; they render as a single timed task.
    let total_targets = match invocation {
        LiveInvocation::Goal { goal, selectors } => {
            let goal_def = workspace.workspace.goals.get(goal).ok_or_else(|| {
                let known: Vec<&str> = workspace
                    .workspace
                    .goals
                    .keys()
                    .map(String::as_str)
                    .collect();
                anyhow::anyhow!("no '{goal}' goal; registered goals: {}", known.join(", "))
            })?;
            let roots = spike::select_roots(&workspace.workspace, goal_def, selectors)?;
            roots.len()
        }
        LiveInvocation::RulesTests { .. } => 0,
    };

    // Install a scheduler and render its single task-event stream into a flat
    // list of worker slots. Each slot corresponds to one concurrent execution
    // unit (sandbox worker or JS evaluation). No parent/child nesting.
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel::<scheduler::TaskEvent>();
    let scheduler = scheduler::Scheduler::new(jobs, Arc::clone(&cancellation), tx);
    *workspace.scheduler.lock().unwrap() = Some(Arc::clone(&scheduler));

    let root = tree.root_handle();
    let what = match invocation {
        LiveInvocation::Goal { goal, .. } => goal.to_owned(),
        LiveInvocation::RulesTests { .. } => "rules-test".to_owned(),
    };
    let goal_label = format!("execute {what}");
    // Labels of Pending-but-not-Done tasks, shared with the watchdog so a
    // stall report can say what is stuck.
    let pending_labels: Arc<std::sync::Mutex<std::collections::HashMap<u64, String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let render_labels = Arc::clone(&pending_labels);
    // Explicit render shutdown: in-flight product evaluations abandoned inside
    // the JS runtime after a failure keep scheduler handles (and thus the event
    // channel) alive forever, so waiting for channel closure would hang.
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let render = tokio::spawn(async move {
        use scheduler::{LaneKind, TaskEvent, TaskOutcome};

        // Data store: target count pre-computed from select_roots.
        struct TaskStore {
            total: usize,
            done: usize,
        }
        let mut store = TaskStore {
            total: total_targets,
            done: 0,
        };

        // ── tree structure ──────────────────────────────────────────────
        // execute <goal> (0/N targets, progress bar)
        //   ├─ js tasks (done/total memos, progress bar) — if js_workers > 0
        //   │   ├─<memo name>  ← JS 0, shown when active
        //   │   └─<memo name>  ← JS 1, shown when active
        //   ├─ run: <desc>     ← SB 0, shown when active
        //   └─ run: <desc>     ← SB 1, shown when active
        // Idle workers are hidden (name set to " ").

        let mut progress = root.add_child(goal_label.clone());
        if store.total > 0 {
            ui::init_counted_task(&progress, store.total);
            progress.set_name(format!("0/{} targets", store.total));
        } else {
            ui::init_timed_task(&progress);
            progress.set_name(goal_label);
        }

        let mut js_progress = {
            let js = progress.add_child("js tasks");
            ui::init_counted_task(&js, 0);
            js.set_name("js tasks 0/0");
            js
        };

        // Slot items — created under the appropriate parent.
        struct SlotState {
            item: prodash::tree::Item,
            task_id: Option<u64>,
        }

        fn start_lane(
            slots: &mut [SlotState],
            task_to_slot: &mut std::collections::HashMap<u64, usize>,
            slot: usize,
            id: u64,
            label: String,
        ) {
            let Some(state) = slots.get_mut(slot) else {
                return;
            };
            if let Some(prev) = state.task_id {
                task_to_slot.remove(&prev);
            }
            state.item.set_name(label);
            ui::init_timed_task(&state.item);
            state.task_id = Some(id);
            task_to_slot.insert(id, slot);
        }

        fn clear_lane(
            slots: &mut [SlotState],
            task_to_slot: &mut std::collections::HashMap<u64, usize>,
            slot: usize,
            id: u64,
        ) {
            let Some(state) = slots.get_mut(slot) else {
                task_to_slot.remove(&id);
                return;
            };
            if state.task_id == Some(id) {
                state.task_id = None;
                state.item.set_name("<idle>");
                ui::init_idle_task(&state.item);
            }
            task_to_slot.remove(&id);
        }

        let mut js_slots: Vec<SlotState> = Vec::with_capacity(js_workers);
        for _ in 0..js_workers {
            let item = js_progress.add_child("<idle>");
            ui::init_idle_task(&item);
            js_slots.push(SlotState {
                item,
                task_id: None,
            });
        }
        let mut sandbox_slots: Vec<SlotState> = Vec::with_capacity(jobs);
        for _ in 0..jobs {
            let item = progress.add_child("<idle>");
            ui::init_idle_task(&item);
            sandbox_slots.push(SlotState {
                item,
                task_id: None,
            });
        }

        let mut js_task_to_slot: std::collections::HashMap<u64, usize> =
            std::collections::HashMap::new();
        let mut sandbox_task_to_slot: std::collections::HashMap<u64, usize> =
            std::collections::HashMap::new();
        let mut root_tasks: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut is_js_memo: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut total_js: usize = 0;
        let mut done_js: usize = 0;

        loop {
            let event = tokio::select! {
                ev = events.recv() => match ev {
                    Some(ev) => ev,
                    None => break,
                },
                _ = &mut shutdown_rx => break,
            };
            match event {
                TaskEvent::Pending {
                    id,
                    parent,
                    display,
                    ..
                } => {
                    if parent.is_none() {
                        root_tasks.insert(id);
                    }
                    render_labels.lock().unwrap().insert(id, display);
                }
                TaskEvent::Running { id, detail } => {
                    if detail.is_none() {
                        total_js += 1;
                        is_js_memo.insert(id);
                        ui::init_counted_task(&js_progress, total_js);
                        js_progress.set(done_js);
                        js_progress.set_name(format!("js tasks {done_js}/{total_js}"));
                    }
                }
                TaskEvent::Done { id, outcome } => {
                    render_labels.lock().unwrap().remove(&id);

                    // Track root-task (target) completion on the goal bar.
                    if store.total > 0 && root_tasks.contains(&id) {
                        root_tasks.remove(&id);
                        match &outcome {
                            TaskOutcome::Ok => {
                                store.done += 1;
                                progress.inc();
                                progress
                                    .set_name(format!("{}/{} targets", store.done, store.total));
                                if store.done == store.total {
                                    progress.done("done");
                                }
                            }
                            TaskOutcome::Err(error) => {
                                progress.fail(error.clone());
                            }
                            TaskOutcome::Canceled => {
                                progress.fail("canceled".to_owned());
                            }
                        }
                    }

                    // Track JS memo completion on the js-tasks bar.
                    if is_js_memo.remove(&id) {
                        match &outcome {
                            TaskOutcome::Ok => {
                                done_js += 1;
                                js_progress.inc();
                                js_progress.set_name(format!("js tasks {done_js}/{total_js}"));
                                if done_js == total_js && store.done == store.total {
                                    js_progress.done("done");
                                }
                            }
                            TaskOutcome::Err(error) => {
                                js_progress.fail(error.clone());
                            }
                            TaskOutcome::Canceled => {
                                js_progress.fail("canceled".to_owned());
                            }
                        }
                    }

                    if let Some(slot) = js_task_to_slot.get(&id).copied() {
                        clear_lane(&mut js_slots, &mut js_task_to_slot, slot, id);
                    }
                    if let Some(slot) = sandbox_task_to_slot.get(&id).copied() {
                        clear_lane(&mut sandbox_slots, &mut sandbox_task_to_slot, slot, id);
                    }
                }
                TaskEvent::LaneStarted {
                    kind,
                    slot,
                    id,
                    display,
                } => match kind {
                    LaneKind::Js => {
                        start_lane(&mut js_slots, &mut js_task_to_slot, slot, id, display)
                    }
                    LaneKind::Sandbox => start_lane(
                        &mut sandbox_slots,
                        &mut sandbox_task_to_slot,
                        slot,
                        id,
                        format!("run: {display}"),
                    ),
                },
                TaskEvent::LaneCleared { kind, slot, id } => match kind {
                    LaneKind::Js => clear_lane(&mut js_slots, &mut js_task_to_slot, slot, id),
                    LaneKind::Sandbox => {
                        clear_lane(&mut sandbox_slots, &mut sandbox_task_to_slot, slot, id)
                    }
                },
            }
        }
    });

    // Drive the goal, with a deadlock watchdog: a genuine async dependency
    // cycle (which QuickJS gives us no way to detect precisely) surfaces as the
    // scheduler staying fully idle while the evaluation is unfinished. Report it
    // instead of hanging.
    const STALL_GRACE: std::time::Duration = std::time::Duration::from_secs(30);
    let drive = async {
        match invocation {
            LiveInvocation::Goal { goal, selectors } => {
                spike::execute_goal_live(
                    &workspace,
                    &workspace_root,
                    goal,
                    selectors,
                    no_cache,
                    js_workers,
                )
                .await
            }
            LiveInvocation::RulesTests { modules } => {
                spike::run_rules_tests_live(&workspace, &workspace_root, modules, js_workers).await
            }
        }
    };
    let watchdog = async {
        loop {
            if scheduler.outstanding() == 0 {
                tokio::select! {
                    _ = scheduler.wait_for_activity() => {}
                    _ = tokio::time::sleep(STALL_GRACE) => {
                        if scheduler.outstanding() == 0 {
                            return;
                        }
                    }
                }
            } else {
                scheduler.wait_for_activity().await;
            }
        }
    };
    let result = tokio::select! {
        biased;
        r = drive => r,
        _ = watchdog => {
            let mut stuck: Vec<String> =
                pending_labels.lock().unwrap().values().cloned().collect();
            stuck.sort();
            let detail = if stuck.is_empty() {
                String::new()
            } else {
                format!("; outstanding tasks: {}", stuck.join(", "))
            };
            Err(anyhow::anyhow!(
                "{what} stalled with no runnable work for {STALL_GRACE:?} — likely a dependency cycle{detail}"
            ))
        }
    };

    // On failure, cancel in-flight work so sandbox children terminate instead
    // of being orphaned by the abandoned JS evaluation. The brief sleep lets
    // blocking workers (which poll the flag every ~20ms) observe it and kill
    // their children before the process exits.
    if result.is_err() {
        cancellation.store(true, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    *workspace.scheduler.lock().unwrap() = None;
    drop(scheduler);
    let _ = shutdown_tx.send(());
    let _ = render.await;

    result
}

macro_rules! workspace_cmd {
    ($tree:expr, |$ws:ident, $out:ident| $body:block) => {{
        let current_dir = std::env::current_dir().context("determine current directory")?;
        let workspace_root = spike::find_workspace_root(&current_dir)?;
        let $ws = load_workspace_with_messages(&workspace_root, $tree).await?;
        let mut $out = String::new();
        $body
        print!("{}", $out);
        Ok(())
    }};
}

async fn cmd_generate_build(check: bool, selectors: &[String], tree: &Tree) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = load_workspace_with_messages(&workspace_root, tree).await?;
    let report =
        runtime::generate_build_files(&workspace, &workspace_root, selectors, check).await?;
    if check {
        println!(
            "generated BUILD files are up to date ({} checked)",
            report.checked_files.len()
        );
    } else if report.changed_files.is_empty() {
        println!(
            "generated BUILD files are already up to date ({} checked)",
            report.checked_files.len()
        );
    } else {
        println!("updated generated BUILD files:");
        for file in report.changed_files {
            println!("  {file}");
        }
    }
    Ok(())
}

async fn cmd_targets(selectors: &[String], tree: &Tree) -> Result<()> {
    workspace_cmd!(tree, |workspace, out| {
        let targets = spike::select_targets(&workspace, selectors)?;
        spike::format_targets(&targets, &mut out)?;
    })
}

async fn cmd_dependencies(selectors: &[String], tree: &Tree) -> Result<()> {
    workspace_cmd!(tree, |workspace, out| {
        spike::format_dependencies(&workspace, selectors, &mut out)?;
    })
}

async fn cmd_rules(tree: &Tree) -> Result<()> {
    workspace_cmd!(tree, |workspace, out| {
        spike::format_products(&workspace, &mut out)?;
    })
}

// ---------------------------------------------------------------------------
// env-check command (inlined since it's small)
// ---------------------------------------------------------------------------

async fn cmd_env_check(_env: &Env, check_cross: bool, tree: &Tree) -> Result<()> {
    let mut p = tree.add_child("environment diagnostics");

    let local = LocalEnv::new();
    let odin_str = workspace::odin_bin().to_string_lossy().into_owned();
    let odinfmt_str = workspace::odinfmt_bin().to_string_lossy().into_owned();
    let kcov_str = workspace::kcov_bin().to_string_lossy().into_owned();

    p.info("=== Build Environment ===");

    let odin_status = local
        .execute(&[&odin_str, "version"], None, false)
        .await
        .map(|(code, out)| {
            if code == 0 {
                format!("✓ {}", out.lines().next().unwrap_or("ok"))
            } else {
                "✗ not working".to_owned()
            }
        })
        .unwrap_or_else(|_| "✗ not found".to_owned());
    p.info(format!("  odin      : {odin_status}"));

    let fmt_status: String = local
        .execute(&[&odinfmt_str, "--version"], None, false)
        .await
        .map(|(code, _)| {
            if code == 0 {
                "✓ available".to_owned()
            } else {
                "✗ not working".to_owned()
            }
        })
        .unwrap_or_else(|_| "✗ not found".to_owned());
    p.info(format!("  odinfmt   : {fmt_status}"));

    if !cfg!(windows) {
        let kcov_status = local
            .execute(&[&kcov_str, "--version"], None, false)
            .await
            .map(|(code, out)| {
                if code == 0 {
                    format!("✓ {}", out.lines().next().unwrap_or("ok"))
                } else {
                    "✗ not working".to_owned()
                }
            })
            .unwrap_or_else(|_| "✗ not found (coverage unavailable)".to_owned());
        p.info(format!("  kcov      : {kcov_status}"));
    } else {
        p.info("  kcov      : N/A (Windows)");
    }

    if check_cross {
        p.info("=== Cross-Compilation ===");
        match WslEnv::new().validate().await {
            Ok(_) => {
                p.info("  WSL       : ✓ available");
                let rsync_ok = local
                    .execute(&["rsync", "--version"], None, false)
                    .await
                    .map(|(c, _)| c == 0)
                    .unwrap_or(false);
                p.info(if rsync_ok {
                    "  rsync     : ✓ available"
                } else {
                    "  rsync     : ✗ not found"
                });
                p.info("  mount     : ✓ accessible");
            }
            Err(e) => {
                p.info("  Status    : ✗ not ready");
                p.info(format!("  Error     : {e}"));
            }
        }
    }

    let targets = workspace::get_targets()?;
    let tests = workspace::get_test_configs()?;
    let odin_files = workspace::get_odin_files();
    p.info("=== Workspace ===");
    p.info(format!("  Odin files    : {}", odin_files.len()));
    p.info(format!("  Build targets : {}", targets.len()));
    p.info(format!("  Test packages : {}", tests.len()));
    if !targets.is_empty() {
        let names: Vec<_> = targets.iter().map(|t| t.name.as_str()).collect();
        p.info(format!("  Target list   : {}", names.join(", ")));
    }

    p.done("done");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::path::Path;

    fn workspace_with_imp_config(config: serde_json::Value) -> spike::Workspace {
        let mut workspace = spike::Workspace::default();
        workspace
            .workspace_config
            .insert("imp".to_owned(), config);
        workspace
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn effective_js_workers_defaults_to_one() {
        let workspace = spike::Workspace::default();
        assert_eq!(effective_js_workers(&workspace, None).unwrap(), 1);
    }

    #[test]
    fn effective_js_workers_uses_workspace_config() {
        let workspace = workspace_with_imp_config(json!({ "jsWorkers": 3 }));
        assert_eq!(effective_js_workers(&workspace, None).unwrap(), 3);
    }

    #[test]
    fn effective_js_workers_cli_overrides_workspace_config() {
        let workspace = workspace_with_imp_config(json!({ "jsWorkers": 3 }));
        assert_eq!(effective_js_workers(&workspace, Some(1)).unwrap(), 1);
    }

    #[test]
    fn effective_js_workers_rejects_invalid_workspace_config() {
        for value in [json!(0), json!(-1), json!(1.5), json!("2"), json!(true)] {
            let workspace = workspace_with_imp_config(json!({ "jsWorkers": value }));
            let error = effective_js_workers(&workspace, None).unwrap_err();
            assert!(
                error.to_string().contains("positive integer"),
                "unexpected error: {error:#}"
            );
        }
    }

    #[test]
    fn goal_subcommand_parses_name_and_selectors() {
        let cli = Cli::parse_from(["imp", "goal", "vs", "//:pkg", "--jobs", "2"]);
        match cli.command {
            Cmd::Goal { name, args } => {
                assert_eq!(name, "vs");
                assert_eq!(args.selectors, vec!["//:pkg".to_owned()]);
                assert_eq!(args.jobs, 2);
            }
            _ => panic!("expected Cmd::Goal"),
        }
    }

    #[tokio::test]
    async fn workspace_js_workers_config_feeds_live_js_lanes() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(spike::WORKSPACE_FILE),
            r#"
import { configure } from "imp:core";

configure("imp", { jsWorkers: 2 });
"#,
        );
        write_file(
            &p.join(spike::BUILD_FILE),
            r#"
import { target, product } from "imp:core";

export const a = target({ kind: "workspace-js-workers-test" });
export const b = target({ kind: "workspace-js-workers-test" });

export const build = product("workspace-js-workers-test", "build", async function build(handle) {
    await Promise.resolve();
    return handle.label.name;
});
"#,
        );

        let live = spike::load_workspace(p).await.unwrap();
        let js_workers = effective_js_workers(&live.workspace, None).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["a".to_owned(), "b".to_owned()];
        spike::execute_goal_live(&live, p, "build", &selectors, false, js_workers)
            .await
            .unwrap();

        let mut slots = BTreeSet::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::LaneStarted {
                kind: crate::scheduler::LaneKind::Js,
                slot,
                display,
                ..
            } = event
            {
                if display == "build(//:a)" || display == "build(//:b)" {
                    slots.insert(slot);
                }
            }
        }

        assert_eq!(slots, BTreeSet::from([0, 1]));
    }
}
