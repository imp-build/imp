mod codegen;
mod commands;
mod coverage;
mod env;
mod spike;
mod toolchain;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
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
    /// Plan a target goal from workspace BUILD.scm files (Steel spike)
    Plan {
        /// Goal to plan; currently build
        goal: String,
        /// Target addresses or names to select; defaults to all buildable targets
        selectors: Vec<String>,
        /// Graphviz DOT output path
        #[arg(long, default_value = "plan.dot")]
        dot: PathBuf,
    },
    /// List targets in the workspace (Steel spike)
    Targets {
        /// Target addresses or names to select; defaults to all targets
        selectors: Vec<String>,
    },
    /// List target dependencies (Steel spike)
    Dependencies {
        /// Target addresses or names to select; defaults to all root targets
        selectors: Vec<String>,
    },
    /// List target types and rules in the workspace (Steel spike)
    Rules,
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
    // The operation-registry spike only evaluates the supplied Steel file. It
    // must not acquire this project's toolchains or generate workspace files.
    match &cli.command {
        Cmd::Plan { goal, selectors, dot } => {
            return cmd_plan(goal, selectors, dot);
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

        Cmd::Fmt => commands::fmt::cmd_fmt(tree).await,

        Cmd::Check { path } => commands::build::cmd_check(env, path, tree).await,

        Cmd::Build { mode, target } => {
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

fn cmd_plan(goal: &str, selectors: &[String], dot: &std::path::Path) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let plan = spike::plan(&workspace, goal, selectors)?;

    println!("{} plan:", plan.goal);
    println!("  roots:");
    for root in &plan.roots {
        println!("    {root}");
    }
    println!("  tasks:");
    for task in &plan.tasks {
        let dependencies = if task.dependencies.is_empty() {
            String::new()
        } else {
            format!(" ← {}", task.dependencies.join(", "))
        };
        println!("    {}: {}{}", task.id, task.action, dependencies);
    }
    std::fs::write(dot, spike::render_dot(&plan))
        .with_context(|| format!("write DOT graph {}", dot.display()))?;
    println!("  DOT: {}", dot.display());
    Ok(())
}

fn cmd_targets(selectors: &[String]) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let targets = spike::select_targets(&workspace, selectors)?;
    let mut out = String::new();
    spike::format_targets(&targets, &mut out)?;
    print!("{out}");
    Ok(())
}

fn cmd_dependencies(selectors: &[String]) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let mut out = String::new();
    spike::format_dependencies(&workspace, selectors, &mut out)?;
    print!("{out}");
    Ok(())
}

fn cmd_rules() -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = spike::load_workspace(&workspace_root)?;
    let mut out = String::new();
    spike::format_rules(&workspace, &mut out)?;
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
