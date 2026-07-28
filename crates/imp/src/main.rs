mod codegen;
mod commands;
mod ui;

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::{Context, Result};
use clap::{Arg, ArgAction, Args, Command, FromArgMatches, Parser, Subcommand};
use rquickjs::{promise::MaybePromise, CatchResultExt, FromJs, Function, Module, Object, Value};
use imp_engine::{changed, runtime, selector, spike};
use imp_scheduler as scheduler;

type Tree = ui::Tree;

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    name = "imp",
    about = "Extensible workspace build system",
    long_about = "Extensible workspace build system.\n\n\
Run a managed toolchain binary directly with `imp @TOOL <args>` (e.g. `imp @odin build foo.odin -out:foo`); \
args are passed through verbatim, no `--` needed. TOOL is any toolchain-shaped \
top-level export in imp.workspace.js (e.g. odin, odinfmt), plus the built-in kcov."
)]
struct Cli {
    /// Route sandboxed execution through the local daemon.
    #[arg(long, global = true)]
    daemon: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Initialize an imp workspace in the current directory
    Init,
    /// List targets in the workspace
    Targets {
        /// Target or package selectors, e.g. :app, dir, dir/..., or //...
        selectors: Vec<String>,
        /// List only targets owning files changed since this git ref
        /// (merge-base against the working tree, like `git diff <ref>`)
        #[arg(long, value_name = "REF")]
        changed_since: Option<String>,
    },
    /// List target dependencies
    Dependencies {
        /// Target or package selectors, e.g. :app, dir, dir/..., or //...
        selectors: Vec<String>,
    },
    /// List target types and rules in the workspace
    Rules {
        #[command(subcommand)]
        command: Option<RulesCmd>,
    },
    /// Generate the Odin module/component/asset registration file
    CodegenRegister {
        /// Output path for the generated file
        output: PathBuf,
    },
    /// Generate or check BUILD.js files for unowned sources, per rules
    /// group's `buildGenerate` config
    GenerateBuild {
        /// Check that generated BUILD.js files are up to date without writing
        #[arg(long)]
        check: bool,
        /// Accepted for consistency with other goals, but which generators
        /// run is decided entirely by each rules group's `buildGenerate`
        /// config flag, not by selectors
        selectors: Vec<String>,
    },
    /// Build the selected targets, e.g. `imp build //...`
    #[command(disable_help_flag = true)]
    Build(RawGoalArgs),
    /// Run tests for the selected targets
    #[command(disable_help_flag = true)]
    Test(RawGoalArgs),
    /// Format the selected targets
    #[command(disable_help_flag = true)]
    Fmt(RawGoalArgs),
    /// Lint the selected targets
    #[command(disable_help_flag = true)]
    Lint(RawGoalArgs),
    /// Package the selected targets
    #[command(disable_help_flag = true)]
    Package(RawGoalArgs),
    /// Run the selected targets
    #[command(disable_help_flag = true)]
    Run(RawGoalArgs),
    /// Run any registered goal by name, e.g. `imp goal vs //:target`
    #[command(disable_help_flag = true)]
    Goal {
        /// Goal name, e.g. "vs", "build", "fmt"
        name: String,
        #[command(flatten)]
        args: RawGoalArgs,
    },
    /// Coordinate isolated JS rule tests. Invoked by the rules-test product;
    /// not for direct use.
    #[command(hide = true)]
    RulesTest {
        /// Workspace-rooted test modules, e.g. //rules/odin/index_test
        modules: Vec<String>,
    },
    /// Execute one discovered JS rules test in an isolated child process.
    #[command(hide = true)]
    RulesTestCase {
        module: String,
        ordinal: usize,
        fixture: String,
    },
    /// Run or inspect the local execution daemon.
    #[command(hide = true)]
    Daemon {
        #[command(subcommand)]
        command: DaemonCmd,
    },
    /// Inspect or clean the shared cache root
    Cache {
        #[command(subcommand)]
        command: CacheCmd,
    },
    /// Inspect declarative workspace configuration schemas
    Config {
        #[command(subcommand)]
        command: ConfigCmd,
    },
}

#[derive(Subcommand)]
enum CacheCmd {
    /// Age out unused cache entries (task records, CAS blobs, named caches).
    /// Dry run by default: prints what would be deleted.
    Gc {
        /// Delete entries not used within this many days. Defaults to the
        /// workspace's `cache.gcMaxAgeDays` config (30 if unset)
        #[arg(long)]
        max_age: Option<u64>,
        /// Actually delete; without this only a summary is printed
        #[arg(long)]
        apply: bool,
    },
    /// Print a summary of what's in the cache root: sizes and counts per
    /// category, plus how much `cache gc` could reclaim right now
    Stats {
        /// Also break named caches down per workspace/scope and cache name
        #[arg(long)]
        details: bool,
    },
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// Print registered configuration schemas
    Schema {
        /// Also include the resolved workspace configuration
        #[arg(long)]
        effective: bool,
    },
}

#[derive(Subcommand)]
enum RulesCmd {
    /// Print target kinds' composed attrs schemas (a subclass's `static
    /// schema` merged over every ancestor's, base-first)
    Schema,
}

#[derive(Subcommand)]
enum DaemonCmd {
    Serve,
    Status,
    Stop,
}

#[derive(clap::Args)]
struct GoalArgs {
    /// Target or package selectors, e.g. :app, dir, dir/..., //..., or //:app#build
    selectors: Vec<String>,
    /// Select the targets owning files changed since this git ref
    /// (merge-base against the working tree, like `git diff <ref>`)
    #[arg(long, value_name = "REF")]
    changed_since: Option<String>,
    /// Maximum number of ready tasks to execute concurrently
    #[arg(long)]
    jobs: Option<usize>,
    /// Number of concurrent JS worker slots for live evaluation
    #[arg(long)]
    js_workers: Option<usize>,
    /// Run actions without reading or writing the task cache
    #[arg(long)]
    no_cache: bool,
    /// When to delete per-run sandboxes: never, on-failure (keep only failed
    /// sandboxes for debugging, the default), or always (keep every sandbox)
    #[arg(long, value_enum, default_value_t = imp_execution::exec::SandboxRetention::default())]
    keep_sandbox: imp_execution::exec::SandboxRetention,
    /// Override a mode axis for this invocation, e.g. --axis opt=release
    /// (repeatable). See defineModeAxis/modeAxis in the JS rule API.
    #[arg(long = "axis", value_name = "KEY=VALUE")]
    axis: Vec<String>,
    /// Select a named bundle of mode-axis defaults for this invocation.
    #[arg(long, value_name = "NAME")]
    profile: Option<String>,
}

/// Opaque capture of a goal subcommand's argv tail. Goal-declared flags (e.g.
/// `fmt`'s `--check`) aren't known until the workspace/JS loads, so this
/// phase can't validate them yet — it just vacuums up everything after the
/// goal name. `parse_goal_args` re-parses this, after workspace load, against
/// a `Command` built from `GoalArgs` plus that goal's declared flags.
#[derive(clap::Args)]
struct RawGoalArgs {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    raw: Vec<String>,
}

/// Build a clap `Command` for `goal` from the static `GoalArgs` fields plus
/// its declared boolean flags, and parse `raw` against it. A parse failure
/// (including `--help`/`-h`) prints clap's normal formatted output and exits
/// the process, exactly like a top-level clap parse failure would.
fn parse_goal_args(
    goal: &str,
    flag_defs: &std::collections::BTreeMap<String, spike::GoalFlagDef>,
    raw: &[String],
) -> clap::ArgMatches {
    let mut cmd = Command::new(goal.to_owned());
    cmd = GoalArgs::augment_args(cmd);
    for (name, def) in flag_defs {
        let mut arg = Arg::new(name.clone())
            .long(name.clone())
            .action(ArgAction::SetTrue);
        if let Some(description) = &def.description {
            arg = arg.help(description.clone());
        }
        cmd = cmd.arg(arg);
    }
    let argv = std::iter::once(goal.to_owned()).chain(raw.iter().cloned());
    match cmd.try_get_matches_from(argv) {
        Ok(matches) => matches,
        Err(e) => e.exit(),
    }
}

fn validate_changed_selector_overrides(
    changed_since: Option<&str>,
    selectors: &[String],
) -> Result<()> {
    if changed_since.is_some() && selectors.iter().any(|selector| selector.contains('#')) {
        anyhow::bail!(
            "--changed-since does not support '#product' selector overrides; it always runs the goal's product"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(name) = args
        .get(1)
        .and_then(|a| a.to_str())
        .and_then(|a| a.strip_prefix('@'))
    {
        let code = match run_tool(name, &args[2..]).await {
            Ok(code) => code,
            Err(e) => {
                eprintln!("error: {e:#}");
                1
            }
        };
        std::process::exit(code);
    }

    if let Some(address) = args
        .get(1)
        .and_then(|a| a.to_str())
        .filter(|a| a.starts_with("//"))
    {
        let address = address.to_owned();
        let call_args: Vec<String> = args[2..]
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        if let Err(e) = run_address_call(&address, &call_args).await {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        }
        return;
    }

    if let Err(e) = run().await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

/// Call a `//module/path:exportName` address directly with a single path
/// argument, bypassing the target/goal/selector system entirely — the Phase
/// 4 pilot (`module:export` addressing, #52), e.g.
/// `imp //rules/rust:build crates/imp-store`. Bypasses clap the same way
/// `@TOOL` does (see `main()` above): a goal name never starts with `//`, so
/// checking `args[1]`'s shape is enough to route without ambiguity against
/// existing `//pkg:name` exact-target selectors, which only ever appear as
/// arguments *to* a goal, never in the goal position itself.
async fn run_address_call(address: &str, args: &[String]) -> Result<()> {
    let (module_path, export_name) = address.split_once(':').ok_or_else(|| {
        anyhow::anyhow!("invalid address '{address}': expected '//module/path:exportName'")
    })?;
    let [arg] = args else {
        anyhow::bail!(
            "'{address}' expects exactly one path argument, got {}",
            args.len()
        );
    };

    let cancellation = install_termination_signal_flag()?;
    let ui = ui::Session::start();
    let result = cmd_call_address_live(
        module_path,
        export_name,
        arg,
        Arc::clone(&cancellation),
        ui.tree(),
    )
    .await;
    ui.shutdown();
    result
}

/// Load the workspace, install a scheduler, and drive
/// [`spike::call_address_live`] to completion, rendering a single spinner
/// and a one-line cache/fresh/failed summary — the address-call counterpart
/// of `cmd_execute_live`'s much richer multi-slot renderer, appropriately
/// simpler since a single address call has no per-target fan-out to display.
async fn cmd_call_address_live(
    module_path: &str,
    export_name: &str,
    arg: &str,
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let workspace = load_workspace_with_messages(&workspace_root, tree).await?;
    let jobs = effective_jobs(&workspace.workspace, None)?;

    if cancellation.load(Ordering::SeqCst) {
        anyhow::bail!("execution canceled");
    }

    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel::<scheduler::TaskEvent>();
    let scheduler = scheduler::Scheduler::new(jobs, Arc::clone(&cancellation), tx);
    *workspace.scheduler.lock().unwrap() = Some(Arc::clone(&scheduler));

    let multi = tree.multi();
    let label = format!("{module_path}:{export_name}");
    let call_label = format!("call {label}");

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let render = tokio::spawn({
        let call_label = call_label.clone();
        async move {
            use indicatif::ProgressBar;
            use scheduler::{TaskEvent, TaskOutcome};

            let progress = multi.add(ProgressBar::new_spinner());
            progress.set_message(call_label.clone());
            ui::init_idle_task(&progress);

            let mut cached_count = 0usize;
            let mut fresh_count = 0usize;
            let mut failed_count = 0usize;
            let mut canceled_count = 0usize;
            let mut done_count = 0usize;
            let wall_start = std::time::Instant::now();
            let mut completion: Option<Result<(), String>> = None;

            loop {
                let event = tokio::select! {
                    ev = events.recv() => match ev {
                        Some(ev) => ev,
                        None => break,
                    },
                    signal = &mut shutdown_rx => {
                        completion = signal.ok();
                        break;
                    },
                };
                match event {
                    TaskEvent::Pending { display, .. } => {
                        ui::init_timed_task(&progress);
                        progress.set_message(display);
                    }
                    TaskEvent::Running { .. } => {}
                    TaskEvent::Done {
                        outcome, cached, ..
                    } => {
                        done_count += 1;
                        match &outcome {
                            TaskOutcome::Ok => match cached {
                                Some(true) => cached_count += 1,
                                Some(false) => fresh_count += 1,
                                None => {}
                            },
                            TaskOutcome::Err(_) => failed_count += 1,
                            TaskOutcome::Canceled => canceled_count += 1,
                        }
                        progress.set_message(call_label.clone());
                        ui::init_idle_task(&progress);
                    }
                    TaskEvent::LaneStarted { .. } | TaskEvent::LaneCleared { .. } => {}
                }
            }

            match completion {
                Some(Ok(())) => progress.finish_with_message("done"),
                Some(Err(error)) => progress.abandon_with_message(error),
                None => progress.abandon_with_message("canceled".to_owned()),
            }

            (
                cached_count,
                fresh_count,
                failed_count,
                canceled_count,
                done_count,
                wall_start.elapsed(),
            )
        }
    });

    *workspace.ui_multi.lock().unwrap() = Some(tree.multi());

    const STALL_GRACE: std::time::Duration = std::time::Duration::from_secs(30);
    let drive =
        spike::call_address_live(&workspace, &workspace_root, module_path, export_name, arg);
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
        _ = watchdog => Err(anyhow::anyhow!(
            "{label} stalled with no runnable work for {STALL_GRACE:?} — likely a dependency cycle"
        )),
    };

    if result.is_err() {
        cancellation.store(true, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    *workspace.scheduler.lock().unwrap() = None;
    *workspace.ui_multi.lock().unwrap() = None;
    drop(scheduler);
    let shutdown_result = result
        .as_ref()
        .map(|_| ())
        .map_err(|error| format!("{error:#}"));
    let _ = shutdown_tx.send(shutdown_result);
    if let Ok((cached, fresh, failed, canceled, total, wall)) = render.await {
        log::info!(
            "call {label}: {cached} cached, {fresh} fresh, {failed} failed, {canceled} canceled ({total} tasks) in {:.2}s",
            wall.as_secs_f64()
        );
    }
    result
}

/// Run a managed toolchain binary directly, passing all remaining args through
/// verbatim: `imp @odin build foo.odin -out:foo`. Bypasses clap entirely so
/// the tool's own flags never need a `--` separator.
async fn run_tool(name: &str, args: &[std::ffi::OsString]) -> Result<i32> {
    let bin = match name {
        "kcov" => std::env::var_os("KCOV_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("kcov")),
        other => resolve_workspace_tool_bin(other).await?,
    };

    Ok(run_direct_tool_command(&bin, args))
}

fn run_direct_tool_command(bin: &std::path::Path, args: &[std::ffi::OsString]) -> i32 {
    match std::process::Command::new(bin).args(args).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("error: failed to run {}: {e:#}", bin.display());
            1
        }
    }
}

/// Resolve `@name` to an absolute binary path via the workspace's own
/// declarations: `name` must be a top-level `export const <name> = ...` in
/// `imp.workspace.js` whose target kind has a registered `"toolchain"`
/// product (see `product(SomeToolchain, TOOLCHAIN, fn)` in the toolchain rule
/// modules, and `invokeToolchainProduct` in `imp_core.js`). No per-tool
/// Rust code is required to add a new `@tool`.
async fn resolve_workspace_tool_bin(name: &str) -> Result<PathBuf> {
    let cwd = std::env::current_dir().context("read current directory")?;
    let workspace_root = spike::find_workspace_root(&cwd)?;
    let live = runtime::load_workspace(&workspace_root).await?;

    // A cold toolchain resolution may need to acquire the tool — verified
    // download + install through run() — so install a minimal execution
    // context (no progress rendering; events are drained and dropped).
    *live.exec_root.lock().unwrap() = Some(workspace_root.clone());
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel::<scheduler::TaskEvent>();
    let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sched = scheduler::Scheduler::new(
        std::thread::available_parallelism().map_or(4, |n| n.get()),
        cancellation,
        tx,
    );
    *live.scheduler.lock().unwrap() = Some(sched);
    tokio::spawn(async move { while events.recv().await.is_some() {} });

    let js_id = live
        .workspace
        .targets
        .get(&format!("//:{name}"))
        .map(|target| target.js_id)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "unknown tool '@{name}'; declare `export const {name} = ...Toolchain(...)` \
                 in imp.workspace.js, or use one of the built-in tools (kcov)"
            )
        })?;

    let path = live
        .ctx
        .async_with(async |ctx| -> rquickjs::Result<String> {
            let promise = Module::import(&ctx, "imp:core")
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("imp:core", format!("{e}")))?;
            let core_ns: Object =
                promise.into_future().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("imp:core", format!("{e}"))
                })?;
            let invoke: Function = core_ns.get("invokeToolchainProduct")?;
            let promise_resolve: Function = ctx.eval("(value) => Promise.resolve(value)")?;
            let value: Value = invoke.call((js_id,)).catch(&ctx).map_err(|e| {
                rquickjs::Error::new_loading_message("invokeToolchainProduct", format!("{e}"))
            })?;
            let result: MaybePromise = promise_resolve.call((value,)).catch(&ctx).map_err(|e| {
                rquickjs::Error::new_loading_message("invokeToolchainProduct", format!("{e}"))
            })?;
            let value: Value = result.into_future().await.catch(&ctx).map_err(|e| {
                rquickjs::Error::new_loading_message("invokeToolchainProduct", format!("{e}"))
            })?;
            String::from_js(&ctx, value)
        })
        .await
        .map_err(|e| anyhow::anyhow!("resolve @{name} from workspace: {e}"))?;

    Ok(PathBuf::from(path))
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    if cli.daemon {
        std::env::set_var("IMP_DAEMON", "1");
    }
    if let Cmd::Daemon { command } = &cli.command {
        match command {
            DaemonCmd::Serve => return imp_daemon::lifecycle::serve().await,
            DaemonCmd::Status => {
                println!(
                    "{}",
                    if imp_daemon::client::RemoteExecutionService::is_running().await {
                        "running"
                    } else {
                        "stopped"
                    }
                );
                return Ok(());
            }
            DaemonCmd::Stop => {
                imp_daemon::client::RemoteExecutionService::shutdown_existing().await?;
                return Ok(());
            }
        }
    }
    // Cache maintenance is host-side work over the cache root; declarations
    // reach gc through the side tables that normal runs maintain (see
    // imp_store::usage). It loads the workspace only to read the
    // `cache.gcMaxAgeDays` config (overridable via `--max-age`), so it still
    // needs a workspace root above the current directory.
    if let Cmd::Cache { command } = &cli.command {
        match command {
            CacheCmd::Gc { max_age, apply } => return cmd_cache_gc(*max_age, *apply).await,
            CacheCmd::Stats { details } => return cmd_cache_stats(*details).await,
        }
    }
    if let Cmd::Init = &cli.command {
        return commands::init::run().await;
    }
    let cancellation = install_termination_signal_flag()?;

    let ui = ui::Session::start();
    let result = run_inner(cli, ui.tree(), cancellation).await;
    ui.shutdown();

    result
}

fn effective_gc_max_age_days(workspace: &spike::Workspace, cli_value: Option<u64>) -> u64 {
    if let Some(value) = cli_value {
        return value;
    }

    workspace
        .workspace_config
        .get("cache")
        .and_then(|config| config.get("gcMaxAgeDays"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(30)
}

async fn cmd_cache_gc(max_age_cli: Option<u64>, apply: bool) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = runtime::load_workspace(&workspace_root).await?;
    let max_age_days = effective_gc_max_age_days(&live.workspace, max_age_cli);

    let plan = imp_store::gc::plan(std::time::Duration::from_secs(max_age_days * 24 * 60 * 60))?;
    println!(
        "cache gc: {} blobs kept live by recent task records",
        plan.marked_blobs
    );
    if plan.is_empty() {
        println!("nothing to delete (max age {max_age_days} days)");
        return Ok(());
    }
    let verb = if apply { "deleting" } else { "would delete" };
    for (label, candidates) in plan.categories() {
        if candidates.is_empty() {
            continue;
        }
        let bytes: u64 = candidates.iter().map(|c| c.size_bytes).sum();
        println!(
            "  {verb} {} {label} ({})",
            candidates.len(),
            human_bytes(bytes)
        );
    }
    println!("total: {}", human_bytes(plan.total_bytes()));
    if !apply {
        println!("dry run — pass --apply to delete");
        return Ok(());
    }
    let outcome = plan.execute();
    println!(
        "deleted {} entries, freed {} ({} stale usage rows cleaned)",
        outcome.deleted,
        human_bytes(outcome.freed_bytes),
        outcome.stale_rows_removed
    );
    for error in &outcome.errors {
        eprintln!("warning: {error}");
    }
    Ok(())
}

async fn cmd_cache_stats(details: bool) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = runtime::load_workspace(&workspace_root).await?;
    let max_age_days = effective_gc_max_age_days(&live.workspace, None);

    // A namedCache() details() callback may shell out via run({ impure:
    // true, sandbox: false }), which needs an execution context — install
    // a minimal, UI-less one (same pattern as resolve_workspace_tool_bin)
    // only when there's actually a callback that might use it.
    if details && !live.workspace.named_cache_details.is_empty() {
        *live.exec_root.lock().unwrap() = Some(workspace_root.clone());
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel::<scheduler::TaskEvent>();
        let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sched = scheduler::Scheduler::new(
            std::thread::available_parallelism().map_or(4, |n| n.get()),
            cancellation,
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(sched);
        tokio::spawn(async move { while events.recv().await.is_some() {} });
    }

    let stats = imp_store::stats::collect()?;
    println!("cache root: {}", stats.root.display());
    println!(
        "  task records:  {} ({})",
        stats.task_records.count,
        human_bytes(stats.task_records.bytes)
    );
    println!(
        "  cas blobs:     {} ({})",
        stats.cas_blobs.count,
        human_bytes(stats.cas_blobs.bytes)
    );
    println!(
        "  named caches:  {} scopes ({})",
        stats.named_scopes,
        human_bytes(stats.named_bytes)
    );
    if details {
        for entry in imp_store::stats::collect_named_details()? {
            println!(
                "    {} / {}: {} ({})",
                entry.scope_label,
                entry.name,
                entry.count,
                human_bytes(entry.bytes)
            );
            if let Some(text) = spike::named_cache_details(&live, &entry.name).await? {
                for line in text.lines() {
                    println!("      {line}");
                }
            }
        }
    }
    if stats.legacy_bytes > 0 {
        println!(
            "  legacy:        {} (cas/trees; run `cache gc` to remove)",
            human_bytes(stats.legacy_bytes)
        );
    }
    println!("  usage.db:      {}", human_bytes(stats.db_bytes));
    println!("total on disk:   {}", human_bytes(stats.total_bytes));
    println!(
        "raw disk usage:  {} (allocated blocks, like `du`)",
        human_bytes(stats.raw_bytes)
    );

    let reclaimable =
        imp_store::gc::plan(std::time::Duration::from_secs(max_age_days * 24 * 60 * 60))?
            .total_bytes();
    if reclaimable > 0 {
        println!(
            "reclaimable now ({max_age_days}-day policy): {} — run `cache gc --apply` to free",
            human_bytes(reclaimable)
        );
    }
    Ok(())
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
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
    match &cli.command {
        Cmd::Init => unreachable!("handled before UI setup"),
        Cmd::Targets {
            selectors,
            changed_since,
        } => {
            return cmd_targets(selectors, changed_since.as_deref(), tree).await;
        }
        Cmd::Dependencies { selectors } => {
            return cmd_dependencies(selectors, tree).await;
        }
        Cmd::Rules { command } => {
            return cmd_rules(command.as_ref(), tree).await;
        }
        Cmd::Config { command } => {
            return cmd_config(command).await;
        }
        Cmd::Build(args) => {
            return cmd_execute_goal("build", &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Test(args) => {
            return cmd_execute_goal("test", &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Fmt(args) => {
            return cmd_execute_goal("fmt", &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Lint(args) => {
            return cmd_execute_goal("lint", &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Package(args) => {
            return cmd_execute_goal("package", &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Run(args) => {
            return cmd_execute_goal("run", &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::Goal { name, args } => {
            return cmd_execute_goal(name, &args.raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::RulesTest { modules } => {
            return cmd_rules_test(modules, Arc::clone(&cancellation), tree).await;
        }
        Cmd::RulesTestCase {
            module,
            ordinal,
            fixture,
        } => {
            return cmd_rules_test_case(module, *ordinal, fixture, Arc::clone(&cancellation)).await;
        }
        Cmd::Daemon { .. } | Cmd::Cache { .. } => {
            unreachable!("handled before UI setup")
        }
        Cmd::GenerateBuild { check, selectors } => {
            let mut raw = selectors.clone();
            if *check {
                raw.push("--check".to_owned());
            }
            return cmd_execute_goal("generate-build", &raw, Arc::clone(&cancellation), tree).await;
        }
        Cmd::CodegenRegister { output } => {
            let odinfmt = match std::env::var_os("ODINFMT_BIN") {
                Some(path) => PathBuf::from(path),
                None => resolve_workspace_tool_bin("odinfmt").await?,
            };
            return commands::codegen_register::run(output, &odinfmt).await;
        }
    }
}

async fn load_workspace_with_messages(
    workspace_root: &std::path::Path,
    _tree: &Tree,
) -> Result<runtime::LiveWorkspace> {
    runtime::load_workspace(workspace_root).await
}

fn effective_js_workers(workspace: &spike::Workspace, cli_value: Option<usize>) -> Result<usize> {
    if let Some(value) = cli_value {
        return Ok(value.max(1));
    }

    Ok(workspace
        .workspace_config
        .get("imp")
        .and_then(|config| config.get("jsWorkers"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(1))
}

fn effective_jobs(workspace: &spike::Workspace, cli_value: Option<usize>) -> Result<usize> {
    if let Some(value) = cli_value {
        return Ok(value.max(1));
    }

    Ok(workspace
        .workspace_config
        .get("imp")
        .and_then(|config| config.get("jobs"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(1))
}

async fn cmd_config(command: &ConfigCmd) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let live = runtime::load_workspace(&workspace_root).await?;
    match command {
        ConfigCmd::Schema { effective } => {
            let schemas: Vec<_> = live
                .workspace
                .config_schemas
                .iter()
                .map(|(namespace, shape)| serde_json::json!({ "namespace": namespace, "shape": shape }))
                .collect();
            if *effective {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "schemas": schemas,
                        "effective": live.workspace.workspace_config,
                    }))?
                );
            } else {
                println!("{}", serde_json::to_string_pretty(&schemas)?);
            }
        }
    }
    Ok(())
}

/// What to drive on the live evaluation path.
///
/// `Goal`'s args are the raw, unvalidated argv tail from phase 1 (see
/// `RawGoalArgs`) — `cmd_execute_live` re-parses them into selectors/flags
/// once the workspace (and the goal's declared flags) has loaded.
#[derive(Clone, Copy)]
enum LiveInvocation<'a> {
    Goal { goal: &'a str, raw: &'a [String] },
}

async fn cmd_execute_goal(
    goal: &str,
    raw: &[String],
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    cmd_execute_live(LiveInvocation::Goal { goal, raw }, cancellation, tree).await
}

async fn cmd_rules_test(
    modules: &[String],
    cancellation: Arc<AtomicBool>,
    _tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    spike::run_rules_tests_isolated(&workspace_root, modules, cancellation).await
}

async fn cmd_rules_test_case(
    module: &str,
    ordinal: usize,
    fixture: &str,
    cancellation: Arc<AtomicBool>,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    spike::run_rules_test_case(&workspace_root, module, ordinal, fixture, cancellation).await
}

/// Per-task completion counts accumulated by the render loop, printed as a
/// one-line summary once a goal finishes.
struct GoalSummary {
    cached: usize,
    cached_local: usize,
    cached_remote: usize,
    fresh: usize,
    remote_pushed: usize,
    failed: usize,
    canceled: usize,
    total: usize,
    wall: std::time::Duration,
}

async fn cmd_execute_live(
    invocation: LiveInvocation<'_>,
    cancellation: Arc<AtomicBool>,
    tree: &Tree,
) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let selector_context =
        selector::SelectorContext::for_invocation(&workspace_root, &current_dir)?;
    let workspace = {
        let start = std::time::Instant::now();
        let ws = load_workspace_with_messages(&workspace_root, tree).await?;
        log::info!("loaded workspace in {:.2}s", start.elapsed().as_secs_f64());
        ws
    };

    // Phase 2 of goal-subcommand parsing: the workspace has now loaded, so any
    // goal-declared flags (e.g. fmt's --check) are known. Re-parse the raw
    // argv tail captured in phase 1 (RawGoalArgs) for real, with full
    // validation and --help. Rule-test runs bypass this entirely — they carry
    // no CLI args of their own.
    let (args, goal_flags, run_args): (GoalArgs, serde_json::Value, Vec<String>) = match invocation
    {
        LiveInvocation::Goal { goal, raw } => {
            let goal_def = workspace.workspace.goals.get(goal).ok_or_else(|| {
                let known: Vec<&str> = workspace
                    .workspace
                    .goals
                    .keys()
                    .map(String::as_str)
                    .collect();
                anyhow::anyhow!("no '{goal}' goal; registered goals: {}", known.join(", "))
            })?;
            // `run` reserves everything after `--` for the launched program;
            // other goals retain their existing all-selector argv grammar.
            let (goal_raw, run_args) = if goal == "run" {
                match raw.iter().position(|arg| arg == "--") {
                    Some(split) => (&raw[..split], raw[split + 1..].to_vec()),
                    None => (raw, Vec::new()),
                }
            } else {
                (raw, Vec::new())
            };
            let matches = parse_goal_args(goal, &goal_def.flags, goal_raw);
            let args = GoalArgs::from_arg_matches(&matches).context("parse goal arguments")?;
            let mut flags = serde_json::Map::new();
            for name in goal_def.flags.keys() {
                flags.insert(
                    name.clone(),
                    serde_json::Value::Bool(matches.get_flag(name)),
                );
            }
            (args, serde_json::Value::Object(flags), run_args)
        }
    };
    let GoalArgs {
        selectors,
        changed_since,
        jobs: jobs_cli,
        js_workers: js_workers_cli,
        no_cache,
        keep_sandbox: sandbox_retention,
        axis,
        profile,
    } = args;
    validate_changed_selector_overrides(changed_since.as_deref(), &selectors)?;
    let js_workers = effective_js_workers(&workspace.workspace, js_workers_cli)?;
    let jobs = effective_jobs(&workspace.workspace, jobs_cli)?;

    // Resolve --changed-since into an exact address set before any execution
    // machinery spins up. Even an empty set continues through selection so
    // scoped selectors are validated and selection-independent goals run.
    let changed_addresses = match &changed_since {
        Some(since) => {
            let graph = workspace.import_graph.lock().unwrap().clone();
            let changed::ChangedTargets { addresses, unowned } = changed::changed_target_addresses(
                &workspace_root,
                &workspace.workspace,
                &graph,
                since,
            )?;
            warn_unowned_changed_files(&unowned);
            Some(addresses)
        }
        None => None,
    };

    if cancellation.load(Ordering::SeqCst) {
        anyhow::bail!("execution canceled");
    }

    // Install a scheduler and render its single task-event stream into a flat
    // list of worker slots. Each slot corresponds to one concurrent execution
    // unit (sandbox worker or JS evaluation). No parent/child nesting.
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel::<scheduler::TaskEvent>();
    let scheduler = scheduler::Scheduler::new(jobs, Arc::clone(&cancellation), tx);
    *workspace.scheduler.lock().unwrap() = Some(Arc::clone(&scheduler));

    let multi = tree.multi();
    let what = match invocation {
        LiveInvocation::Goal { goal, .. } => goal.to_owned(),
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
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let render = tokio::spawn(async move {
        use indicatif::ProgressBar;
        use scheduler::{CacheSource, LaneKind, TaskEvent, TaskKind, TaskLogLevel, TaskOutcome};

        // Bars live in a single flat `MultiProgress`; nesting is conveyed only
        // by insertion order and message indentation below.
        let add_bar = |name: &str| -> ProgressBar {
            let item = multi.add(ProgressBar::new_spinner());
            item.set_message(name.to_owned());
            item
        };

        struct SandboxStore {
            total: usize,
            done: usize,
        }
        let mut sandboxes = SandboxStore { total: 0, done: 0 };

        // ── tree structure ──────────────────────────────────────────────
        // execute <goal> (0/N sandboxes, progress bar)
        //   ├─ js tasks (done/total memos, progress bar) — if js_workers > 0
        //   │   ├─<memo name>  ← JS 0, shown when active
        //   │   └─<memo name>  ← JS 1, shown when active
        //   ├─ run: <desc>     ← SB 0, shown when active
        //   └─ run: <desc>     ← SB 1, shown when active
        // Idle workers are hidden (name set to " ").

        let progress = add_bar(&goal_label);
        ui::init_counted_task(&progress, 0);
        progress.set_message("0/0 sandboxes");

        let js_progress = {
            let js = add_bar("  js tasks");
            ui::init_counted_task(&js, 0);
            js.set_message("  js tasks 0/0");
            js
        };

        // Slot items — displayed as a flat list; indentation in the message
        // text conveys the js-tasks/sandbox grouping (no real tree nesting).
        struct SlotState {
            item: ProgressBar,
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
            state.item.set_message(label);
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
                state.item.set_message("<idle>");
                ui::init_idle_task(&state.item);
            }
            task_to_slot.remove(&id);
        }

        let mut js_slots: Vec<SlotState> = Vec::with_capacity(js_workers);
        for _ in 0..js_workers {
            let item = add_bar("    <idle>");
            ui::init_idle_task(&item);
            js_slots.push(SlotState {
                item,
                task_id: None,
            });
        }
        let mut sandbox_slots: Vec<SlotState> = Vec::with_capacity(jobs);
        for _ in 0..jobs {
            let item = add_bar("  <idle>");
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
        let mut sandbox_tasks: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut is_js_memo: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut total_js: usize = 0;
        let mut done_js: usize = 0;
        let mut completion: Option<Result<(), String>> = None;

        // Per-task completion reporting: retained across the Pending→Done gap
        // (unlike `render_labels`, sandbox_tasks, etc., which the bar-rendering
        // logic above already clears at Done) purely to print a summary line.
        let mut started_at: std::collections::HashMap<u64, std::time::Instant> =
            std::collections::HashMap::new();
        let mut task_log_levels: std::collections::HashMap<u64, TaskLogLevel> =
            std::collections::HashMap::new();
        let wall_start = std::time::Instant::now();
        let mut cached_count: usize = 0;
        let mut cached_local_count: usize = 0;
        let mut cached_remote_count: usize = 0;
        let mut fresh_count: usize = 0;
        let mut remote_pushed_count: usize = 0;
        let mut failed_count: usize = 0;
        let mut canceled_count: usize = 0;
        let mut done_count: usize = 0;

        loop {
            let event = tokio::select! {
                ev = events.recv() => match ev {
                    Some(ev) => ev,
                    None => break,
                },
                signal = &mut shutdown_rx => {
                    completion = signal.ok();
                    break;
                },
            };
            match event {
                TaskEvent::Pending {
                    id,
                    display,
                    kind,
                    log_level,
                    ..
                } => {
                    if kind == TaskKind::Sandbox {
                        sandbox_tasks.insert(id);
                        sandboxes.total += 1;
                        progress.set_length(sandboxes.total as u64);
                        progress.set_message(format!(
                            "{}/{} sandboxes",
                            sandboxes.done, sandboxes.total
                        ));
                    }
                    render_labels.lock().unwrap().insert(id, display);
                    task_log_levels.insert(id, log_level);
                    // Fallback start time, in case this task is satisfied by
                    // cache and never reaches `Running` (see below).
                    started_at.insert(id, std::time::Instant::now());
                }
                TaskEvent::Running { id, detail } => {
                    if detail.is_none() {
                        total_js += 1;
                        is_js_memo.insert(id);
                        ui::init_counted_task(&js_progress, total_js);
                        js_progress.set_position(done_js as u64);
                        js_progress.set_message(format!("js tasks {done_js}/{total_js}"));
                    }
                    // Work has actually started now (a sandbox job cleared
                    // `RunContext::started()`, or a memo's JS lane was
                    // granted and its function body began running). Reset
                    // the clock here so the reported duration is time spent
                    // doing work, not time spent queued behind other tasks.
                    started_at.insert(id, std::time::Instant::now());
                }
                TaskEvent::Done {
                    id,
                    outcome,
                    cached,
                    cache_source,
                    remote_cache_write,
                } => {
                    let label = render_labels
                        .lock()
                        .unwrap()
                        .remove(&id)
                        .unwrap_or_else(|| format!("task {id}"));
                    let elapsed = started_at.remove(&id);
                    let log_level = task_log_levels.remove(&id).unwrap_or(TaskLogLevel::Info);
                    done_count += 1;
                    match &outcome {
                        TaskOutcome::Ok => {
                            let tag = match cached {
                                Some(true) => {
                                    cached_count += 1;
                                    match cache_source {
                                        Some(CacheSource::Local) => cached_local_count += 1,
                                        Some(CacheSource::Remote) => cached_remote_count += 1,
                                        None => {}
                                    }
                                    "cached "
                                }
                                Some(false) => {
                                    fresh_count += 1;
                                    if remote_cache_write {
                                        remote_pushed_count += 1;
                                    }
                                    "fresh "
                                }
                                None => "",
                            };
                            let timing = elapsed
                                .map(|e| format!(" ({:.2?})", e.elapsed()))
                                .unwrap_or_default();
                            match log_level {
                                TaskLogLevel::Trace => log::trace!("[ok] {tag}{label}{timing}"),
                                TaskLogLevel::Debug => log::debug!("[ok] {tag}{label}{timing}"),
                                TaskLogLevel::Info => log::info!("[ok] {tag}{label}{timing}"),
                                TaskLogLevel::Warn => log::warn!("[ok] {tag}{label}{timing}"),
                                TaskLogLevel::Error => log::error!("[ok] {tag}{label}{timing}"),
                            }
                        }
                        TaskOutcome::Err(error) => {
                            failed_count += 1;
                            log::error!("[fail] {label}: {error}");
                        }
                        TaskOutcome::Canceled => {
                            // No per-line print: cancellation fans out to every
                            // in-flight task at once (see the post-failure
                            // cancellation sleep in cmd_execute_live), so this
                            // would flood the terminal. Still counted below.
                            canceled_count += 1;
                        }
                    }

                    // Cache hits never acquire a lane, but they still count as
                    // completed sandbox tasks because they were queued here.
                    if sandbox_tasks.remove(&id) {
                        sandboxes.done += 1;
                        progress.set_position(sandboxes.done as u64);
                        progress.set_message(format!(
                            "{}/{} sandboxes",
                            sandboxes.done, sandboxes.total
                        ));
                    }

                    // Track JS memo completion on the js-tasks bar.
                    if is_js_memo.remove(&id) {
                        match &outcome {
                            TaskOutcome::Ok => {
                                done_js += 1;
                                js_progress.inc(1);
                                js_progress.set_message(format!("js tasks {done_js}/{total_js}"));
                            }
                            TaskOutcome::Err(error) => {
                                js_progress.abandon_with_message(error.clone());
                            }
                            TaskOutcome::Canceled => {
                                js_progress.abandon_with_message("canceled".to_owned());
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

        match completion {
            Some(Ok(())) => {
                progress.finish_with_message("done");
                if done_js == total_js {
                    js_progress.finish_with_message("done");
                }
            }
            Some(Err(error)) => {
                progress.abandon_with_message(error.clone());
                js_progress.abandon_with_message(error);
            }
            None => {
                progress.abandon_with_message("canceled".to_owned());
                js_progress.abandon_with_message("canceled".to_owned());
            }
        }

        GoalSummary {
            cached: cached_count,
            cached_local: cached_local_count,
            cached_remote: cached_remote_count,
            fresh: fresh_count,
            remote_pushed: remote_pushed_count,
            failed: failed_count,
            canceled: canceled_count,
            total: done_count,
            wall: wall_start.elapsed(),
        }
    });

    // Sandbox retention is a process-wide policy read by live `run()` calls; set
    // it on the workspace before driving (mirrors how no_cache is threaded).
    workspace
        .exec_sandbox_retention
        .store(sandbox_retention.as_u8(), Ordering::SeqCst);
    // A streamed `run()` call suspends this MultiProgress for the duration of
    // the launched process, so it doesn't fight indicatif for the terminal.
    *workspace.ui_multi.lock().unwrap() = Some(tree.multi());

    // Drive the goal, with a deadlock watchdog: a genuine async dependency
    // cycle (which QuickJS gives us no way to detect precisely) surfaces as the
    // scheduler staying fully idle while the evaluation is unfinished. Report it
    // instead of hanging.
    const STALL_GRACE: std::time::Duration = std::time::Duration::from_secs(30);
    let drive = async {
        match invocation {
            LiveInvocation::Goal { goal, .. } => {
                let selection = match &changed_addresses {
                    Some(addresses) => spike::GoalSelection::ChangedAddresses {
                        addresses,
                        selectors: &selectors,
                    },
                    None => spike::GoalSelection::Selectors(&selectors),
                };
                spike::execute_goal_live_selection(
                    &workspace,
                    &workspace_root,
                    &selector_context,
                    goal,
                    selection,
                    spike::GoalExecutionOptions {
                        no_cache,
                        js_workers,
                        flags: goal_flags.clone(),
                        run_args: &run_args,
                        axis_overrides: &axis,
                        profile: profile.as_deref(),
                    },
                )
                .await
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
    *workspace.ui_multi.lock().unwrap() = None;
    drop(scheduler);
    let shutdown_result = result
        .as_ref()
        .map(|_| ())
        .map_err(|error| format!("{error:#}"));
    let _ = shutdown_tx.send(shutdown_result);
    if let Ok(summary) = render.await {
        // Only break out local vs. remote cache activity when there was any —
        // keeps the line unchanged for the common case of no remote cache
        // configured.
        let has_remote_activity = summary.cached_remote > 0 || summary.remote_pushed > 0;
        let cache_breakdown = if has_remote_activity {
            format!(
                " ({} local, {} remote)",
                summary.cached_local, summary.cached_remote
            )
        } else {
            String::new()
        };
        let remote_pushed_suffix = if has_remote_activity {
            format!(", {} pushed to remote cache", summary.remote_pushed)
        } else {
            String::new()
        };
        log::info!(
            "execute {what}: {} cached{cache_breakdown}, {} fresh, {} failed, {} canceled ({} tasks) in {:.2}s{remote_pushed_suffix}",
            summary.cached,
            summary.fresh,
            summary.failed,
            summary.canceled,
            summary.total,
            summary.wall.as_secs_f64()
        );
    }

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

async fn cmd_targets(selectors: &[String], changed_since: Option<&str>, tree: &Tree) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let selector_context =
        selector::SelectorContext::for_invocation(&workspace_root, &current_dir)?;
    workspace_cmd!(tree, |workspace, out| {
        if let Some(since) = changed_since {
            let graph = workspace.import_graph.lock().unwrap().clone();
            let changed::ChangedTargets { addresses, unowned } = changed::changed_target_addresses(
                &workspace_root,
                &workspace.workspace,
                &graph,
                since,
            )?;
            warn_unowned_changed_files(&unowned);
            let addresses = selector::filter_changed_addresses_in(
                &workspace.workspace,
                &addresses,
                selectors,
                &selector_context,
            )?;
            for address in &addresses {
                use std::fmt::Write as _;
                writeln!(out, "{address}")?;
            }
        } else {
            let targets = selector::select_targets_in(&workspace, selectors, &selector_context)?;
            spike::format_targets(&targets, &mut out)?;
        }
    })
}

/// One consolidated stderr warning for changed files no target or module
/// accounts for; not an error — unowned files are common (docs, CI config).
fn warn_unowned_changed_files(unowned: &[String]) {
    if unowned.is_empty() {
        return;
    }
    const SHOWN: usize = 10;
    let mut listed = unowned[..unowned.len().min(SHOWN)].join(", ");
    if unowned.len() > SHOWN {
        listed.push_str(&format!(", and {} more", unowned.len() - SHOWN));
    }
    eprintln!(
        "warning: {} changed file(s) owned by no target: {listed}",
        unowned.len()
    );
}

async fn cmd_dependencies(selectors: &[String], tree: &Tree) -> Result<()> {
    let current_dir = std::env::current_dir().context("determine current directory")?;
    let workspace_root = spike::find_workspace_root(&current_dir)?;
    let selector_context =
        selector::SelectorContext::for_invocation(&workspace_root, &current_dir)?;
    workspace_cmd!(tree, |workspace, out| {
        spike::format_dependencies(&workspace, selectors, &selector_context, &mut out)?;
    })
}

async fn cmd_rules(command: Option<&RulesCmd>, tree: &Tree) -> Result<()> {
    match command {
        None => workspace_cmd!(tree, |workspace, out| {
            spike::format_products(&workspace, &mut out)?;
        }),
        Some(RulesCmd::Schema) => {
            let current_dir = std::env::current_dir().context("determine current directory")?;
            let workspace_root = spike::find_workspace_root(&current_dir)?;
            let live = runtime::load_workspace(&workspace_root).await?;
            let schemas: Vec<_> = live
                .workspace
                .target_schemas
                .iter()
                .map(|(kind, schema)| serde_json::json!({ "kind": kind, "schema": schema }))
                .collect();
            println!("{}", serde_json::to_string_pretty(&schemas)?);
            Ok(())
        }
    }
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
    fn effective_jobs_defaults_to_one() {
        let workspace = spike::Workspace::default();
        assert_eq!(effective_jobs(&workspace, None).unwrap(), 1);
    }

    #[test]
    fn effective_jobs_uses_workspace_config() {
        let workspace = workspace_with_imp_config(json!({ "jobs": 4 }));
        assert_eq!(effective_jobs(&workspace, None).unwrap(), 4);
    }

    #[test]
    fn effective_jobs_cli_overrides_workspace_config() {
        let workspace = workspace_with_imp_config(json!({ "jobs": 4 }));
        assert_eq!(effective_jobs(&workspace, Some(1)).unwrap(), 1);
    }

    #[test]
    fn effective_gc_max_age_days_defaults_to_thirty() {
        let workspace = spike::Workspace::default();
        assert_eq!(effective_gc_max_age_days(&workspace, None), 30);
    }

    #[test]
    fn effective_gc_max_age_days_uses_workspace_config() {
        let mut workspace = spike::Workspace::default();
        workspace
            .workspace_config
            .insert("cache".to_owned(), json!({ "gcMaxAgeDays": 3 }));
        assert_eq!(effective_gc_max_age_days(&workspace, None), 3);
    }

    #[test]
    fn effective_gc_max_age_days_cli_overrides_workspace_config() {
        let mut workspace = spike::Workspace::default();
        workspace
            .workspace_config
            .insert("cache".to_owned(), json!({ "gcMaxAgeDays": 3 }));
        assert_eq!(effective_gc_max_age_days(&workspace, Some(7)), 7);
    }

    #[test]
    fn changed_since_flags_parse_and_allow_selector_scoping() {
        // The same Command shape parse_goal_args builds (minus process exit).
        let cmd = || GoalArgs::augment_args(Command::new("build"));

        let matches = cmd()
            .try_get_matches_from(["build", "--changed-since", "origin/main"])
            .unwrap();
        let args = GoalArgs::from_arg_matches(&matches).unwrap();
        assert_eq!(args.changed_since.as_deref(), Some("origin/main"));

        let args = GoalArgs::from_arg_matches(
            &cmd()
                .try_get_matches_from(["build", "//:app", "--changed-since", "main"])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(args.selectors, ["//:app"]);
        assert_eq!(args.changed_since.as_deref(), Some("main"));
        assert!(
            validate_changed_selector_overrides(Some("main"), &["//:app#check".to_owned()],)
                .is_err()
        );
        assert!(validate_changed_selector_overrides(None, &["//:app#check".to_owned()],).is_ok());
    }

    #[test]
    fn targets_subcommand_accepts_changed_since_with_selector_scope() {
        let cli = Cli::parse_from(["imp", "targets", "//pkg/...", "--changed-since", "HEAD~1"]);
        match cli.command {
            Cmd::Targets {
                selectors,
                changed_since,
            } => {
                assert_eq!(selectors, ["//pkg/..."]);
                assert_eq!(changed_since.as_deref(), Some("HEAD~1"));
            }
            _ => panic!("expected targets subcommand"),
        }
    }

    #[test]
    fn goal_subcommand_captures_raw_argv_tail() {
        // Phase 1 (top-level Cli::parse()) can't validate goal-specific flags
        // yet — the workspace/JS hasn't loaded — so it just captures
        // everything after the goal name verbatim.
        let cli = Cli::parse_from(["imp", "goal", "vs", "//:pkg", "--jobs", "2"]);
        match cli.command {
            Cmd::Goal { name, args } => {
                assert_eq!(name, "vs");
                assert_eq!(
                    args.raw,
                    vec!["//:pkg".to_owned(), "--jobs".to_owned(), "2".to_owned()]
                );
            }
            _ => panic!("expected Cmd::Goal"),
        }
    }

    #[test]
    fn run_subcommand_preserves_double_dash_in_raw_tail() {
        let cli = Cli::parse_from(["imp", "run", "//:program", "--", "--script-flag", "value"]);
        match cli.command {
            Cmd::Run(args) => {
                assert_eq!(
                    args.raw,
                    vec![
                        "//:program".to_owned(),
                        "--".to_owned(),
                        "--script-flag".to_owned(),
                        "value".to_owned(),
                    ]
                );
            }
            _ => panic!("expected run subcommand"),
        }
    }

    #[test]
    fn parse_goal_args_resolves_static_fields_and_declared_flags() {
        let raw = vec!["//:pkg".to_owned(), "--jobs".to_owned(), "2".to_owned()];
        let flag_defs = std::collections::BTreeMap::from([(
            "check".to_owned(),
            spike::GoalFlagDef {
                description: Some("Verify without writing".to_owned()),
            },
        )]);
        let matches = parse_goal_args("fmt", &flag_defs, &raw);
        let args = GoalArgs::from_arg_matches(&matches).unwrap();
        assert_eq!(args.selectors, vec!["//:pkg".to_owned()]);
        assert_eq!(args.jobs, Some(2));
        assert!(!matches.get_flag("check"));
    }

    #[test]
    fn parse_goal_args_collects_repeated_axis_overrides() {
        let raw = vec![
            "--axis".to_owned(),
            "opt=release".to_owned(),
            "--axis=target=x86_64-unknown-linux-gnu".to_owned(),
            "//:pkg".to_owned(),
        ];
        let matches = parse_goal_args("build", &Default::default(), &raw);
        let args = GoalArgs::from_arg_matches(&matches).unwrap();

        assert_eq!(args.selectors, vec!["//:pkg".to_owned()]);
        assert_eq!(
            args.axis,
            vec![
                "opt=release".to_owned(),
                "target=x86_64-unknown-linux-gnu".to_owned(),
            ]
        );
    }

    #[test]
    fn parse_goal_args_reads_profile_alongside_axis_overrides() {
        let raw = vec![
            "--profile".to_owned(),
            "windows-release".to_owned(),
            "--axis".to_owned(),
            "opt=debug".to_owned(),
            "//:pkg".to_owned(),
        ];
        let matches = parse_goal_args("build", &Default::default(), &raw);
        let args = GoalArgs::from_arg_matches(&matches).unwrap();

        assert_eq!(args.profile.as_deref(), Some("windows-release"));
        assert_eq!(args.axis, vec!["opt=debug".to_owned()]);
    }

    #[test]
    fn parse_goal_args_reads_declared_boolean_flag() {
        let raw = vec!["--check".to_owned(), "//:pkg".to_owned()];
        let flag_defs = std::collections::BTreeMap::from([(
            "check".to_owned(),
            spike::GoalFlagDef { description: None },
        )]);
        let matches = parse_goal_args("fmt", &flag_defs, &raw);
        let args = GoalArgs::from_arg_matches(&matches).unwrap();
        assert_eq!(args.selectors, vec!["//:pkg".to_owned()]);
        assert!(matches.get_flag("check"));
    }

    #[tokio::test]
    async fn workspace_js_workers_config_feeds_live_js_lanes() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(spike::WORKSPACE_FILE),
            r#"
            export const impConfig = { jsWorkers: 2 };
"#,
        );
        write_file(
            &p.join(spike::BUILD_FILE),
            r#"
import { target, product, targetKind, BUILD, toolName } from "imp:core";
const K_workspace_js_workers_test = targetKind("workspace-js-workers-test");

export const a = target({ kind: "workspace-js-workers-test" });
export const b = target({ kind: "workspace-js-workers-test" });

export const build = product(K_workspace_js_workers_test, BUILD, toolName("workspace-js-workers-test-tool"), async function build(handle) {
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

        let selectors = vec![":a".to_owned(), ":b".to_owned()];
        spike::execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            js_workers,
            serde_json::json!({}),
        )
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
