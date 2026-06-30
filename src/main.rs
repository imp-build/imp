mod codegen;
mod commands;
mod coverage;
mod env;
mod spike;
mod toolchain;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};

use commands::BuildMode;
use env::{Env, LocalEnv, WslEnv};

type Tree = Arc<prodash::tree::Root>;

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
    /// Generate Mermaid dependency graph
    Graph {
        #[arg(long)]
        files: bool,
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
    /// Format all Odin source files
    Fmt,
    /// Type-check an Odin package without building
    Check {
        /// Package path to check
        #[arg(default_value = "ottar")]
        path: String,
    },
    /// Build project targets
    Build {
        #[arg(short = 'm', long, default_value = "release")]
        mode: BuildMode,
        /// Build only this target
        #[arg(long)]
        target: Option<String>,
        /// Execute the QuickJS planned build graph instead of the legacy project build
        #[arg(long)]
        planned: bool,
        /// Planned target selectors; only valid with --planned
        selectors: Vec<String>,
        /// Maximum number of ready planned tasks to execute concurrently
        #[arg(long, default_value_t = 1)]
        jobs: usize,
    },
    /// Build and run ottar
    Run {
        #[arg(short = 'm', long, default_value = "release")]
        mode: BuildMode,
        /// Extra arguments forwarded to the executable
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Run unit test suites
    Test,
    /// Build and run the integration test harness
    IntegrationTest {
        #[arg(short = 'm', long, default_value = "release")]
        mode: BuildMode,
    },
    /// Generate code coverage report using kcov
    Coverage,
    /// Package a release archive
    Package {
        /// Target platform(s); defaults to current platform
        #[arg(long)]
        platform: Vec<String>,
        #[arg(long, default_value = "nightly")]
        version: String,
        #[arg(long)]
        skip_content_build: bool,
    },
    /// Generate Visual Studio and VS Code configuration files
    Vs,
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

    let tree: Tree = prodash::tree::Root::new();
    let render = prodash::render::line::render(
        std::io::stderr(),
        Arc::downgrade(&tree),
        prodash::render::line::Options {
            throughput: false,
            initial_delay: Some(std::time::Duration::from_millis(100)),
            ..prodash::render::line::Options::default()
        },
    );

    let result = run_inner(cli, &tree).await;

    // Wait for the renderer thread to finish its last frame before we return.
    // JoinHandle::drop() only signals shutdown without waiting, which would race
    // with any output printed by main() after run() returns.
    render.shutdown_and_wait();

    result
}

async fn run_inner(cli: Cli, tree: &Tree) -> Result<()> {
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
                platform,
                tree,
            );
        }
        Cmd::Targets { selectors } => {
            return cmd_targets(selectors);
        }
        Cmd::Dependencies { selectors } => {
            return cmd_dependencies(selectors);
        }
        Cmd::Rules => {
            return cmd_rules();
        }
        Cmd::Cache { command } => {
            return cmd_cache(command);
        }
        Cmd::Build {
            target,
            planned: true,
            selectors,
            jobs,
            ..
        } => {
            return cmd_build_planned(target.as_deref(), selectors, *jobs, tree);
        }
        Cmd::Explain { product } => {
            return cmd_explain(product);
        }
        Cmd::Actions { product } => {
            return cmd_actions(product);
        }
        Cmd::GenerateBuild { check, selectors } => {
            return cmd_generate_build(*check, selectors);
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

        Cmd::Graph { files } => commands::graph::cmd_graph(*files, tree).await,

        Cmd::Plan { .. } => unreachable!("handled before environment setup"),
        Cmd::Targets { .. } => unreachable!("handled before environment setup"),
        Cmd::Dependencies { .. } => unreachable!("handled before environment setup"),
        Cmd::Rules => unreachable!("handled before environment setup"),
        Cmd::Cache { .. } => unreachable!("handled before environment setup"),
        Cmd::Explain { .. } => unreachable!("handled before environment setup"),
        Cmd::Actions { .. } => unreachable!("handled before environment setup"),
        Cmd::GenerateBuild { .. } => unreachable!("handled before environment setup"),
        Cmd::CodegenRegister { .. } => unreachable!("handled before environment setup"),

        Cmd::Fmt => commands::fmt::cmd_fmt(tree).await,

        Cmd::Check { path } => commands::build::cmd_check(env, path, tree).await,

        Cmd::Build {
            mode,
            target,
            planned,
            selectors,
            jobs: _,
        } => {
            if *planned {
                unreachable!("handled before environment setup");
            }
            if !selectors.is_empty() {
                bail!("planned build selectors require --planned");
            }
            commands::build::cmd_build(env, *mode, target.as_deref(), tree).await
        }

        Cmd::Run { mode, args } => commands::build::cmd_run(env, *mode, args, tree).await,

        Cmd::Test => commands::test::cmd_test(env, tree).await,

        Cmd::IntegrationTest { mode } => {
            commands::test::cmd_integration_test(env, *mode, tree).await
        }

        Cmd::Coverage => commands::test::cmd_coverage(env, tree).await,

        Cmd::Package {
            platform,
            version,
            skip_content_build,
        } => {
            let platforms = if platform.is_empty() {
                vec![if cfg!(windows) {
                    "windows".into()
                } else {
                    "linux".into()
                }]
            } else {
                platform.clone()
            };
            commands::package::cmd_package(env, &platforms, version, *skip_content_build, tree)
                .await
        }

        Cmd::Vs => commands::vs::cmd_vs(tree).await,
    }
}

fn cmd_plan(
    goal: &str,
    selectors: &[String],
    dot: &std::path::Path,
    json: Option<&std::path::Path>,
    execute: bool,
    dry_run: bool,
    jobs: usize,
    platform: &str,
    tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let plan = spike::plan_live(&workspace, &workspace_root, goal, selectors)?;

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
            spike::ExecutionMode::DryRun
        } else {
            spike::ExecutionMode::Local
        };
        let mut progress = tree.add_child("execute plan");
        let options = spike::ExecutionOptions::new(mode, jobs).with_platform(platform);
        let report = match spike::execute_plan_with_options(
            &plan,
            Some(&workspace),
            &workspace_root,
            options,
            Some(&mut progress),
        ) {
            Ok(report) => {
                progress.done("done");
                report
            }
            Err(error) => {
                progress.fail("failed");
                return Err(error);
            }
        };
        print_execution_report(&plan, report);
    }
    Ok(())
}

fn cmd_build_planned(
    target: Option<&str>,
    selectors: &[String],
    jobs: usize,
    tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;

    let mut requested = Vec::new();
    if let Some(target) = target {
        requested.push(target.to_owned());
    }
    requested.extend(selectors.iter().cloned());

    let plan = spike::plan_live(&workspace, &workspace_root, "build", &requested)?;
    print!("{}", spike::render_text_plan(&plan));

    let mut progress = tree.add_child("execute planned build");
    let report = match spike::execute_plan_with_options(
        &plan,
        Some(&workspace),
        &workspace_root,
        spike::ExecutionOptions::new(spike::ExecutionMode::Local, jobs),
        Some(&mut progress),
    ) {
        Ok(report) => {
            progress.done("done");
            report
        }
        Err(error) => {
            progress.fail("failed");
            return Err(error);
        }
    };

    print_execution_report(&plan, report);

    Ok(())
}

fn print_execution_report(plan: &spike::Plan, report: spike::ExecutionReport) {
    println!("  execution:");
    for task in report.tasks {
        let status = match task.status {
            spike::TaskExecutionStatus::WouldRun => "would run",
            spike::TaskExecutionStatus::CacheHit => "cache hit",
            spike::TaskExecutionStatus::Ran => "ran",
            spike::TaskExecutionStatus::Noop => "noop",
            spike::TaskExecutionStatus::SkippedPlatform => "skipped (platform)",
        };
        let label = plan
            .tasks
            .iter()
            .find(|planned| planned.id == task.task_id)
            .map(|planned| planned.action.display.as_str())
            .filter(|display| !display.is_empty())
            .unwrap_or(task.task_id.as_str());
        println!("    {label}: {status}");
    }
}

/// Load the workspace from the current directory, run `$body` with a
/// `workspace` binding and a `out: String` buffer, then print the buffer.
/// The `?` operator propagates into the enclosing `Result<()>` function.
macro_rules! workspace_cmd {
    (|$ws:ident, $out:ident| $body:block) => {{
        let current_dir = std::env::current_dir().context("determine current directory")?;
        let workspace_root = spike::find_workspace_root(&current_dir)?;
        let $ws = spike::load_workspace(&workspace_root)?;
        let mut $out = String::new();
        $body
        print!("{}", $out);
        Ok(())
    }};
}

fn cmd_generate_build(check: bool, selectors: &[String]) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let report = spike::generate_build_files(&workspace, &workspace_root, selectors, check)?;
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

fn cmd_targets(selectors: &[String]) -> Result<()> {
    workspace_cmd!(|workspace, out| {
        let targets = spike::select_targets(&workspace, selectors)?;
        spike::format_targets(&targets, &mut out)?;
    })
}

fn cmd_dependencies(selectors: &[String]) -> Result<()> {
    workspace_cmd!(|workspace, out| {
        spike::format_dependencies(&workspace, selectors, &mut out)?;
    })
}

fn cmd_rules() -> Result<()> {
    workspace_cmd!(|workspace, out| {
        spike::format_products(&workspace, &mut out)?;
    })
}

fn cmd_cache(command: &CacheCmd) -> Result<()> {
    match command {
        CacheCmd::Explain { selector } => cmd_cache_explain(selector),
    }
}

fn cmd_cache_explain(selector: &str) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let selectors = if selector.contains('#') {
        Vec::new()
    } else {
        vec![selector.to_owned()]
    };
    let plan = spike::plan_live(&workspace, &workspace_root, "build", &selectors)?;
    let task_selector =
        if selector.contains('#') && plan.tasks.iter().any(|task| task.id == selector) {
            selector
        } else {
            plan.roots
                .first()
                .map(String::as_str)
                .ok_or_else(|| anyhow::anyhow!("planned cache explanation had no root task"))?
        };
    let explanation = spike::explain_task_cache(&plan, &workspace_root, task_selector)?;
    let mut out = String::new();
    spike::format_cache_explanation(&explanation, &mut out)?;
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

fn cmd_explain(selector: &str) -> Result<()> {
    let (addr, product_name) = parse_product_selector(selector)?;
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = spike::load_workspace(&workspace_root)?;
    let result = spike::introspect_product(&live, addr, product_name)?;
    let mut out = String::new();
    spike::format_inspect_explain(&result, &mut out).map_err(|e| anyhow::anyhow!("{e}"))?;
    print!("{out}");
    Ok(())
}

fn cmd_actions(selector: &str) -> Result<()> {
    let (addr, product_name) = parse_product_selector(selector)?;
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = spike::load_workspace(&workspace_root)?;
    let result = spike::introspect_product(&live, addr, product_name)?;
    let mut out = String::new();
    spike::format_inspect_actions(&result, &mut out).map_err(|e| anyhow::anyhow!("{e}"))?;
    print!("{out}");
    Ok(())
}
