mod cache;
mod codegen;
mod commands;
mod env;
mod exec;
mod executor;
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
    /// Plan a target goal from workspace BUILD.js files (QuickJS spike)
    Plan {
        /// Goal to plan; currently build
        goal: String,
        /// Target addresses or names to select; defaults to all buildable targets
        selectors: Vec<String>,
        /// Graphviz DOT output path
        #[arg(long, default_value = "plan.dot")]
        dot: PathBuf,
        /// JSON plan output path
        #[arg(long)]
        json: Option<PathBuf>,
        /// Execute the planned task graph locally after rendering it
        #[arg(long)]
        execute: bool,
        /// Exercise the executor without running commands or checking outputs
        #[arg(long)]
        dry_run: bool,
        /// Maximum number of ready tasks to execute concurrently
        #[arg(long, default_value_t = 1)]
        jobs: usize,
        /// Run actions without reading or writing the planned task cache
        #[arg(long)]
        no_cache: bool,
        /// Active execution platform (default: local)
        #[arg(long, default_value = "local")]
        platform: String,
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
    /// Inspect local cache state for planned tasks (QuickJS spike)
    Cache {
        #[command(subcommand)]
        command: CacheCmd,
    },
    /// Show the memo call tree for a product (dry-run, no commands executed)
    Explain {
        /// Target and product selector, e.g. //:app#odin-package
        product: String,
    },
    /// List the actions a product would create (dry-run, no commands executed)
    Actions {
        /// Target and product selector, e.g. //:app#odin-package
        product: String,
    },
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
    /// Build planned target selectors; defaults to the workspace default build roots
    Build {
        /// Target selectors, e.g. //:app or //:app#odin-package
        selectors: Vec<String>,
        /// Maximum number of ready planned tasks to execute concurrently
        #[arg(long, default_value_t = 1)]
        jobs: usize,
        /// Run actions without reading or writing the planned task cache
        #[arg(long)]
        no_cache: bool,
    },
}

#[derive(Subcommand)]
enum CacheCmd {
    /// Explain the cache key and hit/miss state for a planned build target
    Explain {
        /// Target selector, or a task id if it appears in the selected plan
        selector: String,
    },
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
        Cmd::Plan {
            goal,
            selectors,
            dot,
            json,
            execute,
            dry_run,
            jobs,
            no_cache,
            platform,
        } => {
            return cmd_plan(
                goal,
                selectors,
                dot,
                json.as_deref(),
                *execute,
                *dry_run,
                *jobs,
                *no_cache,
                platform,
                Arc::clone(&cancellation),
                tree,
            )
            .await;
        }
        Cmd::Targets { selectors } => {
            return cmd_targets(selectors, tree).await;
        }
        Cmd::Dependencies { selectors } => {
            return cmd_dependencies(selectors, tree).await;
        }
        Cmd::Rules => {
            return cmd_rules(tree).await;
        }
        Cmd::Cache { command } => {
            return cmd_cache(command, tree).await;
        }
        Cmd::Build {
            selectors,
            jobs,
            no_cache,
        } => {
            return cmd_build_planned(selectors, *jobs, *no_cache, Arc::clone(&cancellation), tree)
                .await;
        }
        Cmd::Explain { product } => {
            return cmd_explain(product, tree).await;
        }
        Cmd::Actions { product } => {
            return cmd_actions(product, tree).await;
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

        Cmd::Plan { .. } => unreachable!("handled before environment setup"),
        Cmd::Targets { .. } => unreachable!("handled before environment setup"),
        Cmd::Dependencies { .. } => unreachable!("handled before environment setup"),
        Cmd::Rules => unreachable!("handled before environment setup"),
        Cmd::Cache { .. } => unreachable!("handled before environment setup"),
        Cmd::Explain { .. } => unreachable!("handled before environment setup"),
        Cmd::Actions { .. } => unreachable!("handled before environment setup"),
        Cmd::GenerateBuild { .. } => unreachable!("handled before environment setup"),
        Cmd::CodegenRegister { .. } => unreachable!("handled before environment setup"),
        Cmd::Build { .. } => unreachable!("handled before environment setup"),
    }
}

async fn cmd_plan(
    goal: &str,
    selectors: &[String],
    dot: &std::path::Path,
    json: Option<&std::path::Path>,
    execute: bool,
    dry_run: bool,
    jobs: usize,
    no_cache: bool,
    platform: &str,
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = load_workspace_with_messages(&workspace_root, tree).await?;
    let plan = {
        let mut p = tree.add_child("generate plan");
        let plan =
            spike::plan_live(&workspace, &workspace_root, goal, selectors, Some(&mut p))
                .await?;
        p.done(format!("{} tasks", plan.tasks.len()));
        plan
    };

    print!("{}", spike::render_text_plan(&plan));
    std::fs::write(dot, spike::render_dot(&plan))
        .with_context(|| format!("write DOT graph {}", dot.display()))?;
    println!("  DOT: {}", dot.display());
    if let Some(json) = json {
        let encoded = serde_json::to_string_pretty(&plan).context("serialize JSON plan")?;
        std::fs::write(json, encoded)
            .with_context(|| format!("write JSON plan {}", json.display()))?;
        println!("  JSON: {}", json.display());
    }
    if execute || dry_run {
        // Validate platform against workspace before executing.
        if !workspace.platforms.contains_key(platform) {
            let known: Vec<_> = workspace.platforms.keys().map(String::as_str).collect();
            anyhow::bail!(
                "unknown platform '{platform}'; registered platforms: {}",
                known.join(", ")
            );
        }
        let mode = if dry_run {
            executor::ExecutionMode::DryRun
        } else {
            executor::ExecutionMode::Local
        };
        if cancellation.load(Ordering::SeqCst) {
            anyhow::bail!("execution canceled");
        }
        let mut progress = tree.add_child("execute plan");
        let options = executor::ExecutionOptions::new(mode, jobs)
            .with_platform(platform)
            .with_no_cache(no_cache)
            .with_cancellation(Arc::clone(&cancellation));
        let report = match executor::execute_plan_with_options(
            &plan,
            Some(&workspace),
            &workspace_root,
            options,
            Some(&mut progress),
        ) {
            Ok(report) => report,
            Err(error) => {
                progress.fail("failed");
                return Err(error);
            }
        };
        print_execution_report(&plan, report, &mut progress);
        progress.done("done");
    }
    Ok(())
}

async fn cmd_build_planned(
    selectors: &[String],
    jobs: usize,
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

    let mut progress = tree.add_child("execute build");
    if no_cache {
        // The live executor does not yet thread a cache-bypass flag through to
        // exec_run_inner; caching stays on. Surfaced rather than silently ignored.
        progress.info("note: --no-cache is not yet honored by the live executor");
    }
    if cancellation.load(Ordering::SeqCst) {
        anyhow::bail!("execution canceled");
    }

    // Install a scheduler and render its single event stream into the tree, so
    // there is one source of truth for what is running where.
    let (scheduler, mut events) = scheduler::Scheduler::new(jobs, Arc::clone(&cancellation));
    *workspace.scheduler.lock().unwrap() = Some(Arc::clone(&scheduler));

    let root = tree.root_handle();
    let render = tokio::spawn(async move {
        use scheduler::{JobOutcome, SchedulerEvent};
        let mut items: std::collections::HashMap<u64, prodash::tree::Item> =
            std::collections::HashMap::new();
        while let Some(event) = events.recv().await {
            match event {
                SchedulerEvent::Queued { .. } => {}
                SchedulerEvent::Started { job, slot, display } => {
                    let item = root.add_child(format!("[{slot}] {display}"));
                    ui::init_task(&item);
                    items.insert(job.0, item);
                }
                SchedulerEvent::Finished { job, outcome } => {
                    if let Some(mut item) = items.remove(&job.0) {
                        match outcome {
                            JobOutcome::Ok => item.done("done"),
                            JobOutcome::Err(error) => item.fail(error),
                            JobOutcome::Canceled => item.fail("canceled"),
                        }
                    }
                }
            }
        }
    });

    let result = spike::execute_goal_live(&workspace, &workspace_root, "build", selectors).await;

    // Drop every scheduler handle so the event stream closes and the renderer
    // task finishes.
    *workspace.scheduler.lock().unwrap() = None;
    drop(scheduler);
    let _ = render.await;

    match result {
        Ok(()) => {
            progress.done("done");
            Ok(())
        }
        Err(error) => {
            progress.fail("failed");
            Err(error)
        }
    }
}

fn print_execution_report(
    plan: &spike::Plan,
    report: executor::ExecutionReport,
    progress: &mut prodash::tree::Item,
) {
    progress.info("execution:");
    for task in report.tasks {
        let status = match task.status {
            executor::TaskExecutionStatus::WouldRun => "would run",
            executor::TaskExecutionStatus::CacheHit => "cache hit",
            executor::TaskExecutionStatus::Ran => "ran",
            executor::TaskExecutionStatus::Noop => "noop",
            executor::TaskExecutionStatus::SkippedPlatform => "skipped (platform)",
        };
        let label = plan
            .tasks
            .iter()
            .find(|planned| planned.id == task.task_id)
            .map(|planned| planned.action.display.as_str())
            .filter(|display| !display.is_empty())
            .unwrap_or(task.task_id.as_str());
        progress.info(format!("  {label}: {status}"));
    }
}

async fn load_workspace_with_messages(
    workspace_root: &std::path::Path,
    tree: &Tree,
) -> Result<runtime::LiveWorkspace> {
    runtime::load_workspace_with_host_log(workspace_root, tree.log_sink()).await
}

/// Load the workspace from the current directory, run `$body` with a
/// `workspace` binding and a `out: String` buffer, then print the buffer.
/// The `?` operator propagates into the enclosing `Result<()>` function.
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

async fn cmd_cache(command: &CacheCmd, tree: &Tree) -> Result<()> {
    match command {
        CacheCmd::Explain { selector } => cmd_cache_explain(selector, tree).await,
    }
}

async fn cmd_cache_explain(selector: &str, tree: &Tree) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = load_workspace_with_messages(&workspace_root, tree).await?;
    let selectors = if selector.contains('#') {
        Vec::new()
    } else {
        vec![selector.to_owned()]
    };
    let plan = {
        let mut p = tree.add_child("generate plan");
        let plan =
            spike::plan_live(&workspace, &workspace_root, "build", &selectors, Some(&mut p))
                .await?;
        p.done(format!("{} tasks", plan.tasks.len()));
        plan
    };
    let task_selector =
        if selector.contains('#') && plan.tasks.iter().any(|task| task.id == selector) {
            selector
        } else {
            plan.roots
                .first()
                .map(String::as_str)
                .ok_or_else(|| anyhow::anyhow!("planned cache explanation had no root task"))?
        };
    let explanation = cache::explain_task_cache(&plan, &workspace_root, task_selector)?;
    let mut out = String::new();
    cache::format_cache_explanation(&explanation, &mut out)?;
    print!("{out}");
    Ok(())
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

// ---------------------------------------------------------------------------
// Introspection commands
// ---------------------------------------------------------------------------

fn parse_product_selector(selector: &str) -> Result<(&str, &str)> {
    let (addr, product) = selector.rsplit_once('#').ok_or_else(|| {
        anyhow::anyhow!("selector must be <target>#<product>, e.g. //:app#odin-package")
    })?;
    Ok((addr, product))
}

async fn cmd_explain(selector: &str, tree: &Tree) -> Result<()> {
    let (addr, product_name) = parse_product_selector(selector)?;
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = load_workspace_with_messages(&workspace_root, tree).await?;
    let result = runtime::introspect_product(&live, addr, product_name).await?;
    let mut out = String::new();
    spike::format_inspect_explain(&result, &mut out).map_err(|e| anyhow::anyhow!("{e}"))?;
    print!("{out}");
    Ok(())
}

async fn cmd_actions(selector: &str, tree: &Tree) -> Result<()> {
    let (addr, product_name) = parse_product_selector(selector)?;
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = load_workspace_with_messages(&workspace_root, tree).await?;
    let result = runtime::introspect_product(&live, addr, product_name).await?;
    let mut out = String::new();
    spike::format_inspect_actions(&result, &mut out).map_err(|e| anyhow::anyhow!("{e}"))?;
    print!("{out}");
    Ok(())
}
