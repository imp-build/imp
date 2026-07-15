//! QuickJS-backed target, rule, and goal planning spike.
//!
//! `imp.workspace.js` imports plugin modules that register rules via
//! `product()` registrations. Workspace `BUILD.js` files declare and export target handles
//! via `__host_target`.  The Rust engine resolves product requests into a task
//! DAG without executing it.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};

use crate::exec_bridge::{parse_io_specs, parse_tool_specs};
use crate::loader::{
    resolve_workspace_module, validate_workspace_module_path, ModuleForm, ModuleKind, ModuleSource,
    RulesSource, ImpLoader, ImpResolver,
};
use crate::runtime::LiveWorkspace;
use crate::selector::{select_roots, select_roots_for_addresses, select_targets};
use anyhow::{bail, Context, Result};
use regex::Regex;
use rquickjs::{
    function::Async, promise::MaybePromise, promise::PromiseHookType, Array,
    AsyncContext as JsContext, AsyncRuntime as Runtime, CatchResultExt, Ctx, Filter, Function,
    Module, Object, Value,
};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use imp_daemon::client::RemoteExecutionService;
use imp_exec_api::{ExecAction, ExecRunOpts, ExecutionService, SandboxRetention, WorkerSpec};
use imp_execution::service::LocalExecutionService;
use imp_store::cache::{
    artifact_relative_path, digest_json, named_cache_scope_id, store_file_blob, workspace_cache_id,
};

pub(crate) const WORKSPACE_FILE: &str = "imp.workspace.js";
pub(crate) const BUILD_FILE: &str = "BUILD.js";

fn make_execution_service() -> Result<Arc<dyn ExecutionService>> {
    if std::env::var("IMP_DAEMON").ok().as_deref() == Some("1") {
        return Ok(Arc::new(RemoteExecutionService::connect()?));
    }
    Ok(Arc::new(LocalExecutionService::new()))
}

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub address: String,
    pub kind: String,
    pub attrs: serde_json::Value,
    pub sources: Vec<SourceField>,
    pub dependencies: Vec<Dependency>,
    /// The QuickJS numeric id of this target's handle object (`{ __imp: true, __id: N }`).
    /// Stored so product tasks can reconstruct a valid handle to pass to product functions.
    #[serde(skip)]
    pub js_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceField {
    #[serde(default = "default_source_root")]
    pub root: String,
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

fn default_source_root() -> String {
    ".".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependency {
    pub address: String,
    pub mode: DependencyMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DependencyMode {
    Auto,
    /// The dependency edge requests a specific named product from the dep target,
    /// overriding the rule's `dependencyProduct`. Well-known values are
    /// `"sources"`, `"link"`, and `"runtime"`.
    Named(String),
}

/// Execution backend — where task commands are dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Executor {
    /// Native `std::process::Command` on the local machine.
    Local,
    /// PowerShell bridge through WSL (model only — not yet implemented).
    Wsl,
    /// Container runtime (future).
    Container,
}

impl Executor {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "local" => Some(Self::Local),
            "wsl" => Some(Self::Wsl),
            "container" => Some(Self::Container),
            _ => None,
        }
    }
}

/// A registered platform: bundles executor (where to run) and target (what to build for).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformDef {
    pub name: String,
    pub executor: Executor,
    /// Opaque OS-arch string, e.g. `"linux-x86_64"` or `"windows-x86_64"`.
    pub target: String,
}

/// A boolean flag a goal declares for itself via `goal(name, fn, { flags })`,
/// turned into a real CLI flag (e.g. `--check`) once the goal's declaring
/// module has been evaluated. v1 scope: presence-based booleans defaulting to
/// `false`; extend if a value-carrying flag is ever needed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalFlagDef {
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Goal {
    pub name: String,
    /// Product requested from each selected target. Goals map uniformly onto
    /// products (build → "build", fmt → "fmt", …); targets whose kind lacks
    /// the product are skipped by wildcard selectors such as `//...`.
    pub product: String,
    /// Flags declared for this goal, keyed by flag name (e.g. "check").
    pub flags: BTreeMap<String, GoalFlagDef>,
    /// Declared via `goal(name, fn, { selection: "none" })`: the goal ignores
    /// target selection, so a selector-less invocation runs its callback
    /// against an empty selection instead of erroring.
    pub selectorless: bool,
}

/// A product name declared exactly once (via `productName()`/`goal()` in JS,
/// or pre-declared as a builtin). Product registrations must present the
/// declaration's id, so every product name provably originates from a single
/// importable declaration site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredProductName {
    pub id: u32,
    /// Module that declared the name (e.g. "//rules/c/products"), or None
    /// when the declaration stack couldn't be attributed to a module.
    pub module: Option<String>,
    pub builtin: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityTool {
    target_kinds: BTreeSet<String>,
    modules: BTreeSet<String>,
}

type RuleCapabilities = BTreeMap<String, BTreeMap<String, BTreeMap<String, CapabilityTool>>>;

#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub targets: BTreeMap<String, Target>,
    /// `(kind, product)` → tool → product-fn exec name; see
    /// [`HostState::products`].
    pub products: BTreeMap<(String, String), BTreeMap<String, String>>,
    // Only read by generate_build_files, a #[cfg(test)]-only integration
    // harness for apply_build_edits (production reaches that via
    // HostState.build_rules through the __host_apply_build_edits JS bridge
    // instead) — so this field is genuinely unread outside test builds.
    #[allow(dead_code)]
    pub build_rules: BTreeMap<String, BuildRuleRender>,
    #[allow(dead_code)]
    pub workspace_config: BTreeMap<String, serde_json::Value>,
    pub config_schemas: BTreeMap<String, serde_json::Value>,
    pub owned_files: BTreeSet<String>,
    #[allow(dead_code)]
    pub named_caches: BTreeMap<String, NamedCache>,
    pub goals: BTreeMap<String, Goal>,
    #[allow(dead_code)]
    pub platforms: BTreeMap<String, PlatformDef>,
    /// Goal name -> global function name for an optional pre-flight
    /// callback registered via `goal(name, fn)`. Invoked once per goal
    /// invocation, before any per-target product dispatch.
    pub goal_callbacks: BTreeMap<String, String>,
    /// Target kind -> expander registered via `expand(kind, fn, opts)`. An
    /// expander may optionally be scoped to the goals that need it.
    pub expanders: BTreeMap<String, Expander>,
    /// Every declared product name, for resolving user-typed CLI strings
    /// (`#product` overrides) against and for diagnostics.
    pub declared_product_names: BTreeMap<String, DeclaredProductName>,
}

#[derive(Debug, Clone)]
pub struct Expander {
    pub exec_name: String,
    pub goals: Option<BTreeSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildRuleRender {
    pub import_from: String,
    pub import_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildGenerateReport {
    pub changed_files: Vec<String>,
    pub checked_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedCache {
    pub name: String,
    pub env_var: String,
    /// Shared caches live under `named/shared/` instead of the per-workspace
    /// namespace — for immutable, version-keyed slots (toolchains) that are
    /// identical across checkouts.
    #[serde(default)]
    pub shared: bool,
}

// ---------------------------------------------------------------------------
// Internal host state
// ---------------------------------------------------------------------------

pub(crate) struct HostState {
    next_id: u32,
    next_exec: u32,
    pending: BTreeMap<u32, PendingTarget>,
    /// `(kind, product)` → tool → product-fn exec name. Keyed by tool so
    /// several tools can implement the same product for one kind (e.g. two
    /// formatters); dispatch fans out over the inner map.
    products: BTreeMap<(String, String), BTreeMap<String, String>>,
    product_modules: BTreeMap<(String, String, String), String>,
    build_rules: BTreeMap<String, BuildRuleRender>,
    workspace_config: BTreeMap<String, serde_json::Value>,
    config_schemas: BTreeMap<String, serde_json::Value>,
    owned_files: BTreeSet<String>,
    named_caches: BTreeMap<String, NamedCache>,
    goals: BTreeMap<String, Goal>,
    platforms: BTreeMap<String, PlatformDef>,
    id_to_address: BTreeMap<u32, String>,
    goal_callbacks: BTreeMap<String, String>,
    expanders: BTreeMap<String, Expander>,
    declared_product_names: BTreeMap<String, DeclaredProductName>,
    next_product_name_id: u32,
    /// Tool names declared via `toolName()` — same single-declaration
    /// discipline as product names: registering a product requires the
    /// declaring token, so every tool name has one importable origin.
    declared_tool_names: BTreeMap<String, DeclaredProductName>,
    next_tool_name_id: u32,
    /// `(pending id, address)` pairs appended by `__host_register_dynamic_target`
    /// as a rule's expander mints new targets. Drained by `ensure_expanded`.
    dynamic_registrations: Vec<(u32, String)>,
}

impl Default for HostState {
    fn default() -> Self {
        let mut goals = BTreeMap::new();
        for name in ["build", "test", "fmt", "lint", "package", "run"] {
            goals.insert(
                name.to_owned(),
                Goal {
                    name: name.to_owned(),
                    product: name.to_owned(),
                    flags: BTreeMap::new(),
                    selectorless: false,
                },
            );
        }
        // Builtin product names: one per pre-registered goal, plus the
        // "toolchain" role hardcoded by `imp @tool` dispatch. imp:core
        // re-fetches these tokens idempotently at module evaluation.
        let mut declared_product_names = BTreeMap::new();
        let mut next_product_name_id = 0u32;
        for name in [
            "build",
            "test",
            "fmt",
            "lint",
            "package",
            "run",
            "toolchain",
        ] {
            declared_product_names.insert(
                name.to_owned(),
                DeclaredProductName {
                    id: next_product_name_id,
                    module: None,
                    builtin: true,
                },
            );
            next_product_name_id += 1;
        }
        let mut platforms = BTreeMap::new();
        let local_target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        platforms.insert(
            "local".to_owned(),
            PlatformDef {
                name: "local".to_owned(),
                executor: Executor::Local,
                target: local_target,
            },
        );
        Self {
            next_id: 0,
            next_exec: 0,
            pending: BTreeMap::new(),
            products: BTreeMap::new(),
            product_modules: BTreeMap::new(),
            build_rules: BTreeMap::new(),
            workspace_config: BTreeMap::new(),
            config_schemas: BTreeMap::new(),
            owned_files: BTreeSet::new(),
            named_caches: BTreeMap::new(),
            goals,
            platforms,
            id_to_address: BTreeMap::new(),
            goal_callbacks: BTreeMap::new(),
            expanders: BTreeMap::new(),
            declared_product_names,
            next_product_name_id,
            declared_tool_names: BTreeMap::new(),
            next_tool_name_id: 0,
            dynamic_registrations: Vec::new(),
        }
    }
}

struct PendingTarget {
    kind: String,
    attrs: serde_json::Value,
    sources: Vec<SourceField>,
    dep_ids: Vec<(u32, Option<String>)>,
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

/// Find the nearest ancestor directory that contains `imp.workspace.js`.
pub fn find_workspace_root(start: &Path) -> Result<PathBuf> {
    let mut directory = start
        .canonicalize()
        .with_context(|| format!("canonicalize workspace start {}", start.display()))?;
    if directory.is_file() {
        directory = directory
            .parent()
            .ok_or_else(|| anyhow::anyhow!("workspace start has no parent"))?
            .to_owned();
    }
    loop {
        if directory.join(WORKSPACE_FILE).is_file() {
            return Ok(directory);
        }
        if !directory.pop() {
            bail!(
                "could not find {} above {}",
                WORKSPACE_FILE,
                start.display()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace loading
// ---------------------------------------------------------------------------

/// Load the workspace rooted at `root`.  Evaluates `imp.workspace.js` (for
/// rule registration) then every `BUILD.js` found below `root`, assigns
/// addresses from export names, and resolves dependency IDs to addresses.
///
/// Returns a [`LiveWorkspace`] that keeps the QuickJS runtime alive so rule
/// `exec` functions can be invoked during task execution.
#[allow(dead_code)]
pub async fn load_workspace(root: &Path) -> Result<LiveWorkspace> {
    load_workspace_with_rules(root, RulesSource::from_env()).await
}

/// Like [`load_workspace`], but with an explicit [`RulesSource`] instead of
/// reading `IMP_RULES_DIR` from the process environment — lets tests
/// exercise the built-in-rules fallback without mutating global state.
#[allow(dead_code)]
pub(crate) async fn load_workspace_with_rules(
    root: &Path,
    rules_source: RulesSource,
) -> Result<LiveWorkspace> {
    let service = make_execution_service()?;
    load_workspace_with_rules_and_service(root, rules_source, service).await
}

async fn create_live_runtime(
    root: &Path,
    rules_source: RulesSource,
    service: Arc<dyn ExecutionService>,
) -> Result<LiveWorkspace> {
    crate::logging::ensure_installed();

    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root {}", root.display()))?;

    let state: Arc<Mutex<HostState>> = Arc::new(Mutex::new(HostState::default()));
    let exec_root: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let exec_no_cache = Arc::new(AtomicBool::new(false));
    let exec_sandbox_retention = Arc::new(AtomicU8::new(SandboxRetention::default().as_u8()));
    let scheduler: Arc<Mutex<Option<Arc<crate::scheduler::Scheduler>>>> =
        Arc::new(Mutex::new(None));
    let selected_roots: Arc<Mutex<Option<Vec<serde_json::Value>>>> = Arc::new(Mutex::new(None));
    let goal_flags: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    let import_graph: Arc<Mutex<crate::changed::ImportGraph>> =
        Arc::new(Mutex::new(crate::changed::ImportGraph::default()));
    let rt = Runtime::new().context("create QuickJS runtime")?;
    rt.set_loader(
        ImpResolver {
            workspace_root: root.clone(),
            rules_source: rules_source.clone(),
            import_graph: Arc::clone(&import_graph),
        },
        ImpLoader {
            workspace_root: root.clone(),
            rules_source: rules_source.clone(),
        },
    )
    .await;
    let ctx = JsContext::full(&rt)
        .await
        .context("create QuickJS context")?;
    rt.set_promise_hook(Some(Box::new(|ctx, hook_type, promise, parent| {
        let globals = ctx.globals();
        match hook_type {
            PromiseHookType::Init => {
                if let Ok(function) = globals.get::<_, Function>("__imp_promise_context_init") {
                    let _ = function.call::<_, ()>((promise, parent));
                }
            }
            PromiseHookType::Before => {
                if let Ok(function) = globals.get::<_, Function>("__imp_promise_context_before") {
                    let _ = function.call::<_, ()>((promise,));
                }
            }
            PromiseHookType::After => {
                if let Ok(function) = globals.get::<_, Function>("__imp_promise_context_after") {
                    let _ = function.call::<_, ()>(());
                }
            }
            PromiseHookType::Resolve => {}
        }
    })))
    .await;

    {
        let state_clone = Arc::clone(&state);
        ctx.with(|ctx| -> rquickjs::Result<()> {
            register_globals(
                ctx,
                RegisterGlobalsArgs {
                    state: state_clone,
                    workspace_root: root.clone(),
                    rules_source: rules_source.clone(),
                    exec_root: Arc::clone(&exec_root),
                    exec_no_cache: Arc::clone(&exec_no_cache),
                    exec_sandbox_retention: Arc::clone(&exec_sandbox_retention),
                    scheduler: Arc::clone(&scheduler),
                    selected_roots: Arc::clone(&selected_roots),
                    goal_flags: Arc::clone(&goal_flags),
                    service: Arc::clone(&service),
                },
            )
        })
        .await
        .map_err(|e| anyhow::anyhow!("register QuickJS globals: {e}"))?;
    }

    let workspace = {
        let hs = state.lock().unwrap();
        Workspace {
            targets: BTreeMap::new(),
            products: hs.products.clone(),
            build_rules: hs.build_rules.clone(),
            workspace_config: hs.workspace_config.clone(),
            config_schemas: hs.config_schemas.clone(),
            owned_files: BTreeSet::new(),
            named_caches: hs.named_caches.clone(),
            goals: hs.goals.clone(),
            platforms: hs.platforms.clone(),
            goal_callbacks: hs.goal_callbacks.clone(),
            expanders: hs.expanders.clone(),
            declared_product_names: hs.declared_product_names.clone(),
        }
    };

    Ok(LiveWorkspace {
        workspace,
        runtime: rt,
        ctx,
        exec_root,
        exec_no_cache,
        exec_sandbox_retention,
        scheduler,
        selected_roots,
        goal_flags,
        host_state: state,
        import_graph,
        dynamic_targets: Arc::new(Mutex::new(BTreeMap::new())),
        service,
    })
}

async fn load_workspace_with_rules_and_service(
    root: &Path,
    rules_source: RulesSource,
    service: Arc<dyn ExecutionService>,
) -> Result<LiveWorkspace> {
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root {}", root.display()))?;
    let mut live = create_live_runtime(&root, rules_source, service).await?;
    let state = Arc::clone(&live.host_state);
    let ctx = live.ctx.clone();

    // ----- Evaluate imp.workspace.js if present, and collect its named
    // exports the same way BUILD.js exports are collected below: a
    // toolchain-shaped `export const odin = odinToolchain(...)` binding
    // becomes a top-level target address `//:odin`, discoverable like any
    // other workspace target. -----
    let mut named_exports: Vec<(String, u32)> = Vec::new(); // (address, pending_id)
    let workspace_js = root.join(WORKSPACE_FILE);
    if workspace_js.is_file() {
        let source = std::fs::read_to_string(&workspace_js)
            .with_context(|| format!("read {}", workspace_js.display()))?;
        let exports = ctx
            .async_with(async |ctx| -> Result<Vec<(String, u32)>> {
                // The core module owns the built-in `imp` schema. Import it
                // eagerly so a workspace may use `export const imp = ...`
                // without an otherwise-useless core import.
                let core_promise = Module::import(&ctx, "imp:core")
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                core_promise
                    .into_future::<Object>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let module = Module::declare(ctx.clone(), WORKSPACE_FILE, source)
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let (module, promise) = module
                    .eval()
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                promise
                    .into_future::<rquickjs::Value>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let ns = module
                    .namespace()
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let schemas = state.lock().unwrap().config_schemas.clone();
                let config_exports = collect_config_exports(&ctx, &ns, &schemas)?;
                for (namespace, value_json) in config_exports {
                    let value: serde_json::Value = serde_json::from_str(&value_json)
                        .with_context(|| format!("parse config export '{namespace}'"))?;
                    let schema = schemas.get(&namespace).expect("schema key was matched");
                    let validated = validate_config_value(schema, &value, &namespace)?;
                    let mut hs = state.lock().unwrap();
                    if let Some(existing) = hs.workspace_config.get_mut(&namespace) {
                        merge_workspace_config(existing, validated);
                    } else {
                        hs.workspace_config.insert(namespace, validated);
                    }
                }
                collect_imp_exports(&ns)
            })
            .await
            .with_context(|| format!("evaluate {}", workspace_js.display()))?;

        for (name, id) in exports {
            named_exports.push((format!("//:{name}"), id));
        }
    }

    // ----- Collect BUILD.js files -----
    let mut build_files: Vec<PathBuf> = WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(".git" | "target" | ".toolchain" | ".claude")
            )
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.file_name() == BUILD_FILE)
        .map(|e| e.into_path())
        .collect();
    build_files.sort();

    if build_files.is_empty() {
        bail!("no {} files found below {}", BUILD_FILE, root.display());
    }

    // ----- Evaluate each BUILD.js and collect named exports -----
    // We use dynamic `import()` so that QuickJS handles caching: if a BUILD.js
    // was already loaded (because another BUILD.js imported it), we get the
    // cached namespace without re-evaluating.
    for build_file in &build_files {
        let scope = scope_for(&root, build_file)?;
        let module_name = build_module_name_for(&root, build_file, &scope)?;

        // Seed the import graph: these roots are loaded directly below, so
        // the resolver never sees them as an importee.
        {
            let relative = build_file
                .strip_prefix(&root)
                .with_context(|| format!("{} is outside workspace", build_file.display()))?
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let mut graph = live.import_graph.lock().unwrap();
            graph.record_module_file(relative, &module_name, Some(&scope));
        }

        let exports = ctx
            .async_with(async |ctx| -> Result<Vec<(String, u32)>> {
                // dynamic import → Promise<namespace>
                let promise = Module::import(&ctx, module_name.as_str())
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let ns: Object = promise
                    .into_future()
                    .await
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                collect_imp_exports(&ns)
            })
            .await
            .with_context(|| format!("process {}", build_file.display()))?;

        for (name, id) in exports {
            named_exports.push((format!("{scope}:{name}"), id));
        }
    }

    // ----- Resolve dep IDs to addresses -----
    let (workspace, id_to_address_final) = {
        let hs = state.lock().unwrap();
        let mut id_to_address: BTreeMap<u32, String> = named_exports
            .iter()
            .map(|(addr, id)| (*id, addr.clone()))
            .collect();

        let mut targets = BTreeMap::new();
        let mut visiting = BTreeSet::new();
        for (address, id) in &named_exports {
            materialize_pending_target(
                &hs,
                &mut id_to_address,
                &mut targets,
                &mut visiting,
                *id,
                address.clone(),
            )?;
        }

        let owned_files = compute_owned_files(&root, &targets)?;
        let ws = Workspace {
            targets,
            products: hs.products.clone(),
            build_rules: hs.build_rules.clone(),
            workspace_config: hs.workspace_config.clone(),
            config_schemas: hs.config_schemas.clone(),
            owned_files,
            named_caches: hs.named_caches.clone(),
            goal_callbacks: hs.goal_callbacks.clone(),
            expanders: hs.expanders.clone(),
            goals: hs.goals.clone(),
            platforms: hs.platforms.clone(),
            declared_product_names: hs.declared_product_names.clone(),
        };
        (ws, id_to_address)
    };

    // Store resolved addresses in HostState so __host_target_address can read them.
    {
        let mut hs = state.lock().unwrap();
        hs.id_to_address = id_to_address_final;
        hs.owned_files = workspace.owned_files.clone();
    }

    live.workspace = workspace;
    Ok(live)
}

/// Create a rules-test runtime with no workspace or BUILD modules preloaded.
/// The test module's own imports define the complete rule graph for the test.
pub(crate) async fn load_minimal_rules_test_runtime(root: &Path) -> Result<LiveWorkspace> {
    create_live_runtime(
        root,
        RulesSource::from_env(),
        Arc::new(LocalExecutionService::new()),
    )
    .await
}

/// Load the real workspace for a rules test while still giving the test its
/// own in-process execution service rather than attaching to a daemon.
pub(crate) async fn load_workspace_rules_test_runtime(root: &Path) -> Result<LiveWorkspace> {
    load_workspace_with_rules_and_service(
        root,
        RulesSource::from_env(),
        Arc::new(LocalExecutionService::new()),
    )
    .await
}

/// Walk a module namespace object's own properties and return `(export_name,
/// js_id)` for every export that is a target handle (`{ __imp: true, __id }`).
/// Shared by workspace-file and BUILD.js export scanning so both assign
/// addresses from export names the same way.
fn collect_imp_exports(ns: &Object) -> Result<Vec<(String, u32)>> {
    let mut result = Vec::new();
    for entry in ns.own_props::<String, Value>(Filter::default()) {
        let (key, val) = entry.map_err(|e| anyhow::anyhow!("{e}"))?;
        if let Some(obj) = val.as_object() {
            if let Ok(true) = obj.get::<_, bool>("__imp") {
                if let Ok(id) = obj.get::<_, u32>("__id") {
                    result.push((key, id));
                }
            }
        }
    }
    Ok(result)
}

fn collect_config_exports<'js>(
    ctx: &rquickjs::Ctx<'js>,
    ns: &Object<'js>,
    schemas: &BTreeMap<String, serde_json::Value>,
) -> Result<Vec<(String, String)>> {
    let mut result = Vec::new();
    for entry in ns.own_props::<String, Value>(Filter::default()) {
        let (key, val) = entry.map_err(|e| anyhow::anyhow!("{e}"))?;
        let namespace = if schemas.contains_key(&key) {
            Some(key.clone())
        } else {
            key.strip_suffix("Config")
                .filter(|namespace| schemas.contains_key(*namespace))
                .map(str::to_owned)
        };
        let Some(namespace) = namespace else {
            continue;
        };
        if let Some(obj) = val.as_object() {
            if obj.get::<_, bool>("__imp").unwrap_or(false) {
                continue;
            }
        }
        let json = ctx
            .json_stringify(val)
            .map_err(|e| anyhow::anyhow!("serialize config export '{key}': {e}"))?
            .ok_or_else(|| anyhow::anyhow!("config export '{key}' is not JSON-serializable"))?
            .to_string()
            .map_err(|e| anyhow::anyhow!("serialize config export '{key}': {e}"))?;
        result.push((namespace, json));
    }
    Ok(result)
}

fn validate_config_value(
    schema: &serde_json::Value,
    value: &serde_json::Value,
    path: &str,
) -> Result<serde_json::Value> {
    if schema.get("__impField").is_none() {
        return validate_config_object(schema, value, path);
    }
    let kind = schema
        .get("__impField")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("config schema at '{path}' is missing __impField"))?;
    match kind {
        "int" => {
            if value.as_i64().is_some() || value.as_u64().is_some() {
                Ok(value.clone())
            } else {
                bail!("config '{path}' must be an integer")
            }
        }
        "string" => {
            if value.is_string() {
                Ok(value.clone())
            } else {
                bail!("config '{path}' must be a string")
            }
        }
        "bool" => {
            if value.is_boolean() {
                Ok(value.clone())
            } else {
                bail!("config '{path}' must be a boolean")
            }
        }
        "enum" => {
            let values = schema
                .get("values")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| {
                    anyhow::anyhow!("config schema at '{path}' has invalid enum values")
                })?;
            if values.iter().any(|candidate| candidate == value) {
                Ok(value.clone())
            } else {
                bail!("config '{path}' must be one of {values:?}")
            }
        }
        "object" => {
            let shape = schema.get("shape").ok_or_else(|| {
                anyhow::anyhow!("config schema at '{path}' has invalid object shape")
            })?;
            validate_config_object(shape, value, path)
        }
        "map" => {
            let input = value
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("config '{path}' must be an object"))?;
            let key_schema = schema
                .get("key")
                .ok_or_else(|| anyhow::anyhow!("config schema at '{path}' has no map key type"))?;
            let value_schema = schema.get("value").ok_or_else(|| {
                anyhow::anyhow!("config schema at '{path}' has no map value type")
            })?;
            let mut output = serde_json::Map::new();
            for (key, item) in input {
                let item_path = format!("{path}.{key}");
                validate_config_value(
                    key_schema,
                    &serde_json::Value::String(key.clone()),
                    &item_path,
                )?;
                output.insert(
                    key.clone(),
                    validate_config_value(value_schema, item, &item_path)?,
                );
            }
            Ok(serde_json::Value::Object(output))
        }
        other => bail!("config schema at '{path}' has unknown field type '{other}'"),
    }
}

fn validate_config_object(
    shape: &serde_json::Value,
    value: &serde_json::Value,
    path: &str,
) -> Result<serde_json::Value> {
    let input = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("config '{path}' must be an object"))?;
    let shape = shape
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("config schema at '{path}' has invalid object shape"))?;
    for key in input.keys() {
        if !shape.contains_key(key) {
            bail!("config '{path}.{key}' is not declared in the schema")
        }
    }
    let mut output = serde_json::Map::new();
    for (key, field_schema) in shape {
        let field_path = format!("{path}.{key}");
        if let Some(field_value) = input.get(key) {
            output.insert(
                key.clone(),
                validate_config_value(field_schema, field_value, &field_path)?,
            );
        } else if let Some(default) = field_schema.get("default") {
            output.insert(
                key.clone(),
                validate_config_value(field_schema, default, &field_path)?,
            );
        } else if field_schema
            .get("required")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            bail!("missing required config field '{field_path}'")
        }
    }
    Ok(serde_json::Value::Object(output))
}

fn materialize_pending_target(
    hs: &HostState,
    id_to_address: &mut BTreeMap<u32, String>,
    targets: &mut BTreeMap<String, Target>,
    visiting: &mut BTreeSet<u32>,
    id: u32,
    fallback_address: String,
) -> Result<String> {
    let address = id_to_address
        .entry(id)
        .or_insert_with(|| fallback_address.clone())
        .clone();
    if targets.contains_key(&address) {
        return Ok(address);
    }
    if !visiting.insert(id) {
        bail!("target dependency cycle includes pending id {id}");
    }

    let pending = hs
        .pending
        .get(&id)
        .ok_or_else(|| anyhow::anyhow!("no pending target for id {id}"))?;
    let mut deps = Vec::new();
    for (index, (dep_id, mode_str)) in pending.dep_ids.iter().enumerate() {
        let dep_address = id_to_address
            .get(dep_id)
            .cloned()
            .unwrap_or_else(|| format!("{address}__implicit{index}"));
        let dep_address =
            materialize_pending_target(hs, id_to_address, targets, visiting, *dep_id, dep_address)?;
        let mode = match mode_str.as_deref() {
            None | Some("auto") => DependencyMode::Auto,
            Some(m) => DependencyMode::Named(m.to_owned()),
        };
        deps.push(Dependency {
            address: dep_address,
            mode,
        });
    }

    visiting.remove(&id);
    targets.insert(
        address.clone(),
        Target {
            address: address.clone(),
            kind: pending.kind.clone(),
            attrs: pending.attrs.clone(),
            sources: pending.sources.clone(),
            dependencies: deps,
            js_id: id,
        },
    );
    Ok(address)
}

/// Look up a target by address in either the static workspace or the
/// session-scoped dynamic overlay.
fn lookup_dynamic_or_static(live: &LiveWorkspace, address: &str) -> Option<Target> {
    if let Some(target) = live.workspace.targets.get(address) {
        return Some(target.clone());
    }
    live.dynamic_targets.lock().unwrap().get(address).cloned()
}

/// Lazily invoke registered expanders (`expand(kind, fn)` in JS) for any
/// target reachable from `root_addresses` whose kind has one, materializing
/// whatever targets they register via `registerTarget()` into
/// `live.dynamic_targets`. A no-op walk when no rule has called `expand()`.
///
/// Idempotent per invocation: a target is only ever passed to its kind's
/// expander once (including targets minted by expansion itself, which are
/// marked already-expanded on arrival so an expander never re-triggers on
/// its own output).
async fn ensure_expanded(
    live: &LiveWorkspace,
    root_addresses: &[String],
    goal: Option<&str>,
) -> Result<()> {
    if live.workspace.expanders.is_empty() {
        return Ok(());
    }

    let mut expanded: BTreeSet<String> = BTreeSet::new();
    let mut frontier: Vec<String> = root_addresses.to_vec();

    loop {
        // Transitive closure of static+dynamic deps reachable from the frontier.
        let mut reachable: BTreeSet<String> = BTreeSet::new();
        let mut stack = frontier.clone();
        while let Some(address) = stack.pop() {
            if !reachable.insert(address.clone()) {
                continue;
            }
            if let Some(target) = lookup_dynamic_or_static(live, &address) {
                for dep in &target.dependencies {
                    stack.push(dep.address.clone());
                }
            }
        }

        let to_expand: Vec<Target> = reachable
            .into_iter()
            .filter(|address| !expanded.contains(address))
            .filter_map(|address| lookup_dynamic_or_static(live, &address))
            .filter(|target| {
                live.workspace
                    .expanders
                    .get(&target.kind)
                    .is_some_and(|expander| {
                        expander
                            .goals
                            .as_ref()
                            .is_none_or(|goals| goal.is_some_and(|name| goals.contains(name)))
                    })
            })
            .collect();

        if to_expand.is_empty() {
            break;
        }

        for target in &to_expand {
            expanded.insert(target.address.clone());
            let exec_name = live.workspace.expanders[&target.kind].exec_name.clone();
            let address = target.address.clone();
            let js_id = target.js_id;

            live.ctx
                .async_with(async |ctx| -> rquickjs::Result<()> {
                    let resolve_fn: Function = ctx.globals().get("__imp_resolve_handle")?;
                    let handle: Object = resolve_fn.call((js_id,))?;
                    let promise_resolve: Function =
                        ctx.eval("(value) => Promise.resolve(value)")?;
                    let expander_fn: Function = ctx.globals().get(exec_name.as_str())?;
                    let result_value: Value =
                        expander_fn.call((handle,)).catch(&ctx).map_err(|e| {
                            rquickjs::Error::new_loading_message("expand", format!("{e}"))
                        })?;
                    let promise: MaybePromise = promise_resolve
                        .call((result_value,))
                        .catch(&ctx)
                        .map_err(|e| {
                        rquickjs::Error::new_loading_message("expand", format!("{e}"))
                    })?;
                    promise
                        .into_future::<Value>()
                        .await
                        .catch(&ctx)
                        .map_err(|e| {
                            rquickjs::Error::new_loading_message("expand", format!("{e}"))
                        })?;
                    Ok(())
                })
                .await
                .map_err(|e| anyhow::anyhow!("expand '{address}' failed: {e}"))?;
        }

        // Drain whatever the expanders just registered and materialize them
        // into the dynamic overlay, reusing the same resolution logic used
        // at workspace-load time.
        let registrations: Vec<(u32, String)> = {
            let mut hs = live.host_state.lock().unwrap();
            std::mem::take(&mut hs.dynamic_registrations)
        };

        {
            let hs = live.host_state.lock().unwrap();
            let mut id_to_address = hs.id_to_address.clone();
            let mut dynamic = live.dynamic_targets.lock().unwrap();
            let mut visiting = BTreeSet::new();
            for (id, address) in &registrations {
                materialize_pending_target(
                    &hs,
                    &mut id_to_address,
                    &mut dynamic,
                    &mut visiting,
                    *id,
                    address.clone(),
                )?;
            }
            drop(dynamic);
            drop(hs);
            live.host_state.lock().unwrap().id_to_address = id_to_address;
        }

        // Newly-minted targets are themselves already-expanded (an expander
        // never re-triggers on its own output) but may declare deps on other
        // expandable kinds — re-walk from their addresses.
        for (_, address) in &registrations {
            expanded.insert(address.clone());
        }
        frontier = registrations
            .into_iter()
            .map(|(_, address)| address)
            .collect();
    }

    Ok(())
}

fn compute_owned_files(
    workspace_root: &Path,
    targets: &BTreeMap<String, Target>,
) -> Result<BTreeSet<String>> {
    let mut owned = BTreeSet::new();
    for target in targets.values() {
        for source in &target.sources {
            if source.include.is_empty() {
                continue;
            }
            let root = source_field_workspace_root(&target.address, &source.root)?;
            for file in
                workspace_glob_files(workspace_root, &root, &source.include, &source.exclude)
                    .with_context(|| format!("expand sources for {}", target.address))?
            {
                owned.insert(file);
            }
        }
    }
    Ok(owned)
}

pub(crate) fn source_field_workspace_root(address: &str, root: &str) -> Result<String> {
    let source_root = root.trim();
    if let Some(workspace_rooted) = source_root.strip_prefix("//") {
        let relative = workspace_relative_directory(workspace_rooted)?;
        return Ok(path_to_workspace_string(&relative));
    }

    let mut base = target_scope_path(address)?;
    let local = workspace_relative_directory(source_root)?;
    if !local.as_os_str().is_empty() {
        base.push(local);
    }
    Ok(path_to_workspace_string(&base))
}

pub(crate) fn target_scope_path(address: &str) -> Result<PathBuf> {
    let (scope, _) = address
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("target address '{address}' must include ':'"))?;
    let scope = scope
        .strip_prefix("//")
        .ok_or_else(|| anyhow::anyhow!("target address '{address}' must start with //"))?;
    workspace_relative_directory(scope)
}

pub(crate) fn path_to_workspace_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        path.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    }
}

/// Shared host-side state threaded into every global bridge function
/// registered by `register_globals` — bundled into one struct so the
/// registration function itself doesn't need a long positional parameter
/// list (`ctx` stays separate since its lifetime is tied to the QuickJS
/// context, not to this bundle's ownership).
struct RegisterGlobalsArgs {
    state: Arc<Mutex<HostState>>,
    workspace_root: PathBuf,
    rules_source: RulesSource,
    exec_root: Arc<Mutex<Option<PathBuf>>>,
    exec_no_cache: Arc<AtomicBool>,
    exec_sandbox_retention: Arc<AtomicU8>,
    scheduler: Arc<Mutex<Option<Arc<crate::scheduler::Scheduler>>>>,
    selected_roots: Arc<Mutex<Option<Vec<serde_json::Value>>>>,
    goal_flags: Arc<Mutex<Option<serde_json::Value>>>,
    service: Arc<dyn ExecutionService>,
}

/// Register host globals on `ctx`.
fn register_globals<'js>(ctx: Ctx<'js>, args: RegisterGlobalsArgs) -> rquickjs::Result<()> {
    let RegisterGlobalsArgs {
        state,
        workspace_root,
        rules_source,
        exec_root,
        exec_no_cache,
        exec_sandbox_retention,
        scheduler,
        selected_roots,
        goal_flags,
        service,
    } = args;
    let globals = ctx.globals();

    // GC side table: map this checkout's hashed cache namespace back to its
    // path, so `cache gc` can prune namespaces whose checkout is gone.
    imp_store::usage::record_workspace(&workspace_cache_id(&workspace_root), &workspace_root);

    // ------------------------------------------------------------------
    // __host_target(kind, attrsJson, sourcesJson, depIds, depModes) → u32 (handle id)
    // depIds: Array<number>, depModes: Array<string|null> (parallel arrays)
    // ------------------------------------------------------------------
    let state_t = Arc::clone(&state);
    let host_target = Function::new(
        ctx.clone(),
        move |_ctx: Ctx<'js>,
              kind: String,
              attrs_json: String,
              sources_json: String,
              dep_ids: Array<'js>,
              dep_modes: Array<'js>|
              -> rquickjs::Result<u32> {
            let mut hs = state_t.lock().unwrap();
            let id = hs.next_id;
            hs.next_id += 1;

            let attrs: serde_json::Value = serde_json::from_str(&attrs_json).map_err(|e| {
                rquickjs::Error::new_loading_message("__host_target", e.to_string())
            })?;
            let sources: Vec<SourceField> = serde_json::from_str(&sources_json).map_err(|e| {
                rquickjs::Error::new_loading_message("__host_target", e.to_string())
            })?;

            // Extract (dep_id, mode) pairs from the two parallel arrays.
            let len = dep_ids.len();
            let mut dep_id_list: Vec<(u32, Option<String>)> = Vec::with_capacity(len);
            for i in 0..len {
                let dep_id: u32 = dep_ids.get(i)?;
                let mode_val: Value = dep_modes.get(i)?;
                let mode = if mode_val.is_null() || mode_val.is_undefined() {
                    None
                } else {
                    Some(mode_val.get::<String>()?)
                };
                dep_id_list.push((dep_id, mode));
            }

            hs.pending.insert(
                id,
                PendingTarget {
                    kind,
                    attrs,
                    sources,
                    dep_ids: dep_id_list,
                },
            );
            Ok(id)
        },
    )?;
    globals.set("__host_target", host_target)?;

    // ------------------------------------------------------------------
    // __host_declare_product_name(name, stack, builtinOk) → u32 id
    //
    // Declares a product name exactly once and returns its id; tokens minted
    // from the id are the only way to register or look up products by name.
    // Re-declaring from the same module is idempotent (module re-evaluation);
    // `builtinOk` lets imp:core fetch the pre-declared builtin names.
    // ------------------------------------------------------------------
    let state_dpn = Arc::clone(&state);
    let host_declare_product_name = Function::new(
        ctx.clone(),
        move |name: String, stack: String, builtin_ok: bool| -> rquickjs::Result<u32> {
            if name.is_empty()
                || name.contains('#')
                || name.contains(':')
                || name.contains(char::is_whitespace)
            {
                return Err(action_spec_error(format!(
                    "invalid product name '{name}': must be non-empty, without '#', ':' or whitespace"
                )));
            }
            let module = declaration_module(&stack);
            let mut hs = state_dpn.lock().unwrap();
            if let Some(existing) = hs.declared_product_names.get(&name) {
                if (existing.builtin && builtin_ok) || existing.module == module {
                    return Ok(existing.id);
                }
                let declared_in = if existing.builtin {
                    "imp:core (builtin)".to_owned()
                } else {
                    existing
                        .module
                        .clone()
                        .unwrap_or_else(|| "<unknown module>".to_owned())
                };
                return Err(action_spec_error(format!(
                    "product name '{name}' is already declared in {declared_in}; \
                     import its token instead of redeclaring it"
                )));
            }
            let id = hs.next_product_name_id;
            hs.next_product_name_id += 1;
            hs.declared_product_names.insert(
                name,
                DeclaredProductName {
                    id,
                    module,
                    builtin: false,
                },
            );
            Ok(id)
        },
    )?;
    globals.set("__host_declare_product_name", host_declare_product_name)?;

    // ------------------------------------------------------------------
    // __host_declare_tool_name(name, stack) → u32 id
    //
    // Declares a tool name exactly once and returns its id — the same
    // discipline as product names: product registrations must present a
    // declared tool token, so every tool name has a single importable
    // declaration site. Re-declaring from the same module is idempotent.
    // ------------------------------------------------------------------
    let state_dtn = Arc::clone(&state);
    let host_declare_tool_name = Function::new(
        ctx.clone(),
        move |name: String, stack: String| -> rquickjs::Result<u32> {
            if name.is_empty()
                || name.contains('#')
                || name.contains(':')
                || name.contains('@')
                || name.contains(char::is_whitespace)
            {
                return Err(action_spec_error(format!(
                    "invalid tool name '{name}': must be non-empty, without '#', ':', '@' or whitespace"
                )));
            }
            let module = declaration_module(&stack);
            let mut hs = state_dtn.lock().unwrap();
            if let Some(existing) = hs.declared_tool_names.get(&name) {
                if existing.module == module {
                    return Ok(existing.id);
                }
                let declared_in = existing
                    .module
                    .clone()
                    .unwrap_or_else(|| "<unknown module>".to_owned());
                return Err(action_spec_error(format!(
                    "tool name '{name}' is already declared in {declared_in}; \
                     import its token instead of redeclaring it"
                )));
            }
            let id = hs.next_tool_name_id;
            hs.next_tool_name_id += 1;
            hs.declared_tool_names.insert(
                name,
                DeclaredProductName {
                    id,
                    module,
                    builtin: false,
                },
            );
            Ok(id)
        },
    )?;
    globals.set("__host_declare_tool_name", host_declare_tool_name)?;

    // ------------------------------------------------------------------
    // __host_product(specJson, fn, registrationStack) — specJson carries
    // { kind, name, nameId, tool, toolId, module? } (one JSON param keeps
    // the closure within rquickjs's argument-tuple arity).
    // ------------------------------------------------------------------
    let state_p = Arc::clone(&state);
    let product_workspace_root = workspace_root.clone();
    let product_rules_source = rules_source.clone();
    let host_product = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>,
              spec_json: String,
              fn_val: Value<'js>,
              registration_stack: String|
              -> rquickjs::Result<()> {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ProductSpec {
                kind: String,
                name: String,
                name_id: u32,
                tool: String,
                tool_id: u32,
                #[serde(default)]
                module: Option<String>,
            }
            let ProductSpec {
                kind,
                name,
                name_id,
                tool,
                tool_id,
                module: declared_module,
            } = serde_json::from_str(&spec_json)
                .map_err(|e| action_spec_error(format!("malformed __host_product spec: {e}")))?;
            {
                let hs = state_p.lock().unwrap();
                match hs.declared_product_names.get(&name) {
                    Some(decl) if decl.id == name_id => {}
                    _ => {
                        return Err(action_spec_error(format!(
                            "product registration for '{kind}#{name}' is not backed by a \
                             declaration — import the token from its declaring module"
                        )));
                    }
                }
                match hs.declared_tool_names.get(&tool) {
                    Some(decl) if decl.id == tool_id => {}
                    _ => {
                        return Err(action_spec_error(format!(
                            "product registration for '{kind}#{name}' names tool '{tool}' \
                             without its declaration — import the token from its declaring \
                             module (see toolName())"
                        )));
                    }
                }
            }
            let exec_name = {
                let mut hs = state_p.lock().unwrap();
                let n = format!("__imp_exec_{}", hs.next_exec);
                hs.next_exec += 1;
                n
            };
            ctx.globals().set(exec_name.as_str(), fn_val)?;
            let module_key = (kind.clone(), name.clone(), tool.clone());
            let mut hs = state_p.lock().unwrap();
            hs.products
                .entry((kind, name))
                .or_default()
                .insert(tool, exec_name);
            let module = declared_module
                .filter(|module| !module.is_empty())
                .or_else(|| product_registration_module(&registration_stack));
            if let Some(module) = module {
                let source_module = resolved_product_module(
                    &product_workspace_root,
                    &product_rules_source,
                    &module,
                );
                hs.product_modules.insert(module_key, source_module);
            } else {
                hs.product_modules.remove(&module_key);
            }
            Ok(())
        },
    )?;
    globals.set("__host_product", host_product)?;

    // ------------------------------------------------------------------
    // __host_goal_callback(name, fn) — registers an optional pre-flight
    // callback for a goal, invoked once per invocation before any
    // per-target product dispatch (see execute_goal_live).
    // ------------------------------------------------------------------
    let state_gc = Arc::clone(&state);
    let host_goal_callback = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, name: String, fn_val: Value<'js>| -> rquickjs::Result<()> {
            let exec_name = {
                let mut hs = state_gc.lock().unwrap();
                let n = format!("__imp_exec_{}", hs.next_exec);
                hs.next_exec += 1;
                n
            };
            ctx.globals().set(exec_name.as_str(), fn_val)?;
            state_gc
                .lock()
                .unwrap()
                .goal_callbacks
                .insert(name, exec_name);
            Ok(())
        },
    )?;
    globals.set("__host_goal_callback", host_goal_callback)?;

    // ------------------------------------------------------------------
    // __host_register_expander(kind, fn, goals) — registers a lazy target
    // expander for a target kind, invoked by `ensure_expanded` for any
    // statically-known target of that kind reachable from the current
    // goal's selection (see `expand()` in imp_core.js).
    // ------------------------------------------------------------------
    let state_exp = Arc::clone(&state);
    let host_register_expander = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>,
              kind: String,
              fn_val: Value<'js>,
              goals: Option<Vec<String>>|
              -> rquickjs::Result<()> {
            let exec_name = {
                let mut hs = state_exp.lock().unwrap();
                let n = format!("__imp_exec_{}", hs.next_exec);
                hs.next_exec += 1;
                n
            };
            ctx.globals().set(exec_name.as_str(), fn_val)?;
            state_exp.lock().unwrap().expanders.insert(
                kind,
                Expander {
                    exec_name,
                    goals: goals.map(|values| values.into_iter().collect()),
                },
            );
            Ok(())
        },
    )?;
    globals.set("__host_register_expander", host_register_expander)?;

    // ------------------------------------------------------------------
    // __host_register_dynamic_target(id, address) — called by
    // `registerTarget()` to give a pending target (constructed live, inside
    // an expander) an explicit, stable address. Queued for `ensure_expanded`
    // to materialize after the expander's promise resolves.
    // ------------------------------------------------------------------
    let state_reg = Arc::clone(&state);
    let host_register_dynamic_target = Function::new(
        ctx.clone(),
        move |id: u32, address: String| -> rquickjs::Result<()> {
            let mut hs = state_reg.lock().unwrap();
            if !hs.pending.contains_key(&id) {
                return Err(rquickjs::Error::new_loading_message(
                    "registerTarget",
                    format!("no pending target for id {id}"),
                ));
            }
            match hs.id_to_address.get(&id) {
                Some(existing) if existing == &address => return Ok(()),
                Some(existing) => {
                    return Err(rquickjs::Error::new_loading_message(
                        "registerTarget",
                        format!(
                            "target id {id} already registered as '{existing}', cannot re-register as '{address}'"
                        ),
                    ))
                }
                None => {}
            }
            if hs.id_to_address.values().any(|a| a == &address) {
                return Err(rquickjs::Error::new_loading_message(
                    "registerTarget",
                    format!("address '{address}' is already claimed by another target"),
                ));
            }
            hs.id_to_address.insert(id, address.clone());
            hs.dynamic_registrations.push((id, address));
            Ok(())
        },
    )?;
    globals.set(
        "__host_register_dynamic_target",
        host_register_dynamic_target,
    )?;

    let state_br = Arc::clone(&state);
    let host_register_build_rule = Function::new(
        ctx.clone(),
        move |_ctx: Ctx<'js>,
              rule: String,
              import_from: String,
              import_name: String|
              -> rquickjs::Result<()> {
            if rule.is_empty() || import_from.is_empty() || import_name.is_empty() {
                return Err(rquickjs::Error::new_loading_message(
                    "__host_register_build_rule",
                    "rule, importFrom, and importName must be non-empty",
                ));
            }
            state_br.lock().unwrap().build_rules.insert(
                rule,
                BuildRuleRender {
                    import_from,
                    import_name,
                },
            );
            Ok(())
        },
    )?;
    globals.set("__host_register_build_rule", host_register_build_rule)?;

    // ------------------------------------------------------------------
    // __host_named_cache(name)
    // ------------------------------------------------------------------
    let state_c = Arc::clone(&state);
    let workspace_id_nc = workspace_cache_id(&workspace_root);
    let host_named_cache = Function::new(
        ctx.clone(),
        move |name: String, shared: Option<bool>| -> rquickjs::Result<()> {
            let cache = named_cache_from_name(&name, shared.unwrap_or(false))?;
            // GC side table: declarations have their own LRU, so a cache
            // nothing declares anymore eventually prunes wholesale.
            imp_store::usage::record_declared_cache(&workspace_id_nc, &cache.name, cache.shared);
            let mut hs = state_c.lock().unwrap();
            if let Some(existing) = hs.named_caches.get(&cache.name) {
                if existing != &cache {
                    return Err(action_spec_error(format!(
                        "named cache '{}' was declared with conflicting metadata",
                        cache.name
                    )));
                }
                return Ok(());
            }
            if let Some(existing) = hs
                .named_caches
                .values()
                .find(|existing| existing.env_var == cache.env_var)
            {
                return Err(action_spec_error(format!(
                    "named cache '{}' maps to env var {} already used by '{}'",
                    cache.name, cache.env_var, existing.name
                )));
            }
            hs.named_caches.insert(cache.name.clone(), cache);
            Ok(())
        },
    )?;
    globals.set("__host_named_cache", host_named_cache)?;

    // ------------------------------------------------------------------
    // __host_goal(name, productPolicy, flagsJson, selectorless, stack) → u32 product-name id
    // flagsJson: JSON object of { flagName: { description?: string } },
    // merged into the goal's declared flags regardless of whether the goal
    // itself is a fresh registration (flags are additive/idempotent, unlike
    // the first-registration-wins `product` field).
    //
    // Declares the goal's product name in the declared-name registry if
    // needed and returns its id, so `goal()` can hand back a product-name
    // token. Repeat registrations return the existing id (goals are
    // first-registration-wins, so they are exempt from the
    // duplicate-declaration error).
    // ------------------------------------------------------------------
    let state_g = Arc::clone(&state);
    let host_goal = Function::new(
        ctx.clone(),
        move |name: String,
              policy_val: Value,
              flags_json: String,
              selectorless: bool,
              stack: String|
              -> rquickjs::Result<u32> {
            if name.is_empty() {
                return Err(action_spec_error("goal name must not be empty".to_owned()));
            }
            let product = {
                let s: String = policy_val.get().map_err(|_| {
                    action_spec_error("goal productPolicy must be a string".to_owned())
                })?;
                // "default" requests the product named after the goal itself.
                if s == "default" {
                    name.clone()
                } else {
                    s
                }
            };
            let declared_flags: BTreeMap<String, serde_json::Value> =
                serde_json::from_str(&flags_json).map_err(|e| {
                    action_spec_error(format!("goal flags must be a JSON object: {e}"))
                })?;
            let mut hs = state_g.lock().unwrap();
            match hs.goals.get_mut(&name) {
                Some(goal) => {
                    for (flag_name, def) in declared_flags {
                        goal.flags.entry(flag_name).or_insert(GoalFlagDef {
                            description: def
                                .get("description")
                                .and_then(|d| d.as_str())
                                .map(str::to_owned),
                        });
                    }
                }
                None => {
                    let flags = declared_flags
                        .into_iter()
                        .map(|(flag_name, def)| {
                            let flag = GoalFlagDef {
                                description: def
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .map(str::to_owned),
                            };
                            (flag_name, flag)
                        })
                        .collect();
                    hs.goals.insert(
                        name.clone(),
                        Goal {
                            name: name.clone(),
                            product: product.clone(),
                            flags,
                            selectorless,
                        },
                    );
                }
            }
            // Declare the goal's product name (idempotent for repeat goal()
            // calls and for goals shadowing an existing declaration).
            let id = match hs.declared_product_names.get(&product) {
                Some(existing) => existing.id,
                None => {
                    let id = hs.next_product_name_id;
                    hs.next_product_name_id += 1;
                    let module = declaration_module(&stack);
                    hs.declared_product_names.insert(
                        product,
                        DeclaredProductName {
                            id,
                            module,
                            builtin: false,
                        },
                    );
                    id
                }
            };
            Ok(id)
        },
    )?;
    globals.set("__host_goal", host_goal)?;

    // ------------------------------------------------------------------
    // __host_configure(namespace, valueJson)
    // __host_configuration(namespace) → JSON string | null
    // __host_configuration_digest() → hex digest
    // ------------------------------------------------------------------
    let state_cfg = Arc::clone(&state);
    let host_configure = Function::new(
        ctx.clone(),
        move |namespace: String, value_json: String| -> rquickjs::Result<()> {
            validate_config_namespace(&namespace)?;
            let value: serde_json::Value = serde_json::from_str(&value_json).map_err(|e| {
                rquickjs::Error::new_loading_message("configure", format!("parse value: {e}"))
            })?;

            let mut hs = state_cfg.lock().unwrap();
            if let Some(existing) = hs.workspace_config.get_mut(&namespace) {
                merge_workspace_config(existing, value);
            } else {
                hs.workspace_config.insert(namespace, value);
            }
            Ok(())
        },
    )?;
    globals.set("__host_configure", host_configure)?;

    // __host_define_config_schema(namespace, schemaJson)
    let state_schema = Arc::clone(&state);
    let host_define_config_schema = Function::new(
        ctx.clone(),
        move |namespace: String, schema_json: String| -> rquickjs::Result<()> {
            validate_config_namespace(&namespace)?;
            let schema: serde_json::Value = serde_json::from_str(&schema_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "defineConfigSchema",
                    format!("parse schema: {e}"),
                )
            })?;
            if !schema.is_object() {
                return Err(rquickjs::Error::new_loading_message(
                    "defineConfigSchema",
                    "schema must be an object",
                ));
            }
            state_schema
                .lock()
                .unwrap()
                .config_schemas
                .insert(namespace, schema);
            Ok(())
        },
    )?;
    globals.set("__host_define_config_schema", host_define_config_schema)?;

    let state_schema = Arc::clone(&state);
    let host_configuration_schemas =
        Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let hs = state_schema.lock().unwrap();
            serde_json::to_string(&hs.config_schemas).map_err(|e| {
                rquickjs::Error::new_loading_message("configurationSchemas", e.to_string())
            })
        })?;
    globals.set("__host_configuration_schemas", host_configuration_schemas)?;

    let state_capabilities = Arc::clone(&state);
    let host_rule_capabilities =
        Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let hs = state_capabilities.lock().unwrap();
            serde_json::to_string(&derive_rule_capabilities(&hs)).map_err(|e| {
                rquickjs::Error::new_loading_message("ruleCapabilities", e.to_string())
            })
        })?;
    globals.set("__host_rule_capabilities", host_rule_capabilities)?;

    let state_cfg = Arc::clone(&state);
    let host_configuration = Function::new(
        ctx.clone(),
        move |namespace: String| -> rquickjs::Result<Option<String>> {
            validate_config_namespace(&namespace)?;
            let hs = state_cfg.lock().unwrap();
            hs.workspace_config
                .get(&namespace)
                .map(|value| {
                    serde_json::to_string(value).map_err(|e| {
                        rquickjs::Error::new_loading_message("configuration", e.to_string())
                    })
                })
                .transpose()
        },
    )?;
    globals.set("__host_configuration", host_configuration)?;

    let state_cfg = Arc::clone(&state);
    let host_configuration_digest =
        Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let hs = state_cfg.lock().unwrap();
            digest_json(&hs.workspace_config).map_err(|e| {
                rquickjs::Error::new_loading_message("configurationDigest", format!("{e:#}"))
            })
        })?;
    globals.set("__host_configuration_digest", host_configuration_digest)?;

    // ------------------------------------------------------------------
    // __host_platform(name, executor, target)
    // ------------------------------------------------------------------
    let state_p = Arc::clone(&state);
    let host_platform = Function::new(
        ctx.clone(),
        move |name: String, executor_str: String, target: String| -> rquickjs::Result<()> {
            if name.is_empty() {
                return Err(action_spec_error(
                    "platform name must not be empty".to_owned(),
                ));
            }
            let executor = Executor::from_str(&executor_str).ok_or_else(|| {
                action_spec_error(format!(
                    "unknown executor '{executor_str}'; known: local, wsl, container"
                ))
            })?;
            let mut hs = state_p.lock().unwrap();
            if !hs.platforms.contains_key(&name) {
                hs.platforms.insert(
                    name.clone(),
                    PlatformDef {
                        name,
                        executor,
                        target,
                    },
                );
            }
            Ok(())
        },
    )?;
    globals.set("__host_platform", host_platform)?;

    // ------------------------------------------------------------------
    // __host_download(url) → path string
    // ------------------------------------------------------------------
    let service_download = Arc::clone(&service);
    let host_download = Function::new(
        ctx.clone(),
        move |url: String| -> rquickjs::Result<String> {
            let path = service_download
                .fetch_url(&url)
                .map_err(|e| rquickjs::Error::new_loading_message("download", format!("{e:#}")))?;
            Ok(path.to_string_lossy().into_owned())
        },
    )?;
    globals.set("__host_download", host_download)?;

    // ------------------------------------------------------------------
    // __host_extract(archive, dest, format, strip_components)
    // ------------------------------------------------------------------
    let service_extract = Arc::clone(&service);
    let host_extract = Function::new(
        ctx.clone(),
        move |archive: String, dest: String, format: String, strip: u32| -> rquickjs::Result<()> {
            service_extract
                .extract_archive(Path::new(&archive), Path::new(&dest), &format, strip)
                .map_err(|e| rquickjs::Error::new_loading_message("extract", format!("{e:#}")))?;
            Ok(())
        },
    )?;
    globals.set("__host_extract", host_extract)?;

    // ------------------------------------------------------------------
    // __host_platform() → JSON string { "os": "...", "arch": "..." }
    // ------------------------------------------------------------------
    let service_platform = Arc::clone(&service);
    let host_platform_fn = Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
        let caps = service_platform
            .capabilities()
            .map_err(|e| rquickjs::Error::new_loading_message("platform", format!("{e:#}")))?;
        let (os, arch) = (caps.os, caps.arch);
        Ok(format!(r#"{{"os":"{os}","arch":"{arch}"}}"#))
    })?;
    globals.set("__host_platform_info", host_platform_fn)?;

    // ------------------------------------------------------------------
    // __host_sha256(path) → hex string
    // ------------------------------------------------------------------
    let service_sha256 = Arc::clone(&service);
    let host_sha256 = Function::new(
        ctx.clone(),
        move |path: String| -> rquickjs::Result<String> {
            service_sha256
                .file_sha256(Path::new(&path))
                .map_err(|e| rquickjs::Error::new_loading_message("sha256", format!("{e:#}")))
        },
    )?;
    globals.set("__host_sha256", host_sha256)?;

    // ------------------------------------------------------------------
    // __host_file_size(path) → number (bytes; f64-exact for any real artifact)
    // ------------------------------------------------------------------
    let service_file_size = Arc::clone(&service);
    let host_file_size =
        Function::new(ctx.clone(), move |path: String| -> rquickjs::Result<f64> {
            service_file_size
                .file_size(Path::new(&path))
                .map(|n| n as f64)
                .map_err(|e| rquickjs::Error::new_loading_message("file_size", format!("{e:#}")))
        })?;
    globals.set("__host_file_size", host_file_size)?;

    // ------------------------------------------------------------------
    // __host_cache_put(name, key, source)
    // __host_cache_get(name, key) → path | null
    // __host_cache_has(name, key) → bool
    // ------------------------------------------------------------------
    // Scope resolution: shared caches (per the namedCache() registry) live
    // under the cross-workspace "shared" namespace, everything else under
    // this workspace's id.
    let wc = workspace_root.clone();
    let state_scope = Arc::clone(&state);
    let cache_scope = move |name: &str| -> String {
        let workspace_id = workspace_cache_id(&wc);
        let shared = state_scope
            .lock()
            .unwrap()
            .named_caches
            .get(name)
            .is_some_and(|cache| cache.shared);
        named_cache_scope_id(shared, &workspace_id).to_owned()
    };

    let scope_put = cache_scope.clone();
    let service_cache_put = Arc::clone(&service);
    let host_cache_put = Function::new(
        ctx.clone(),
        move |name: String, key: String, source: String| -> rquickjs::Result<()> {
            service_cache_put
                .cache_dir_put(&scope_put(&name), &name, &key, Path::new(&source))
                .map_err(|e| rquickjs::Error::new_loading_message("cache", format!("{e:#}")))
        },
    )?;
    globals.set("__host_cache_put", host_cache_put)?;

    let scope_get = cache_scope.clone();
    let service_cache_get = Arc::clone(&service);
    let host_cache_get = Function::new(
        ctx.clone(),
        move |name: String, key: String| -> rquickjs::Result<Option<String>> {
            let path = service_cache_get
                .cache_dir_get(&scope_get(&name), &name, &key)
                .map_err(|e| rquickjs::Error::new_loading_message("cache", format!("{e:#}")))?;
            Ok(path.map(|p| p.to_string_lossy().into_owned()))
        },
    )?;
    globals.set("__host_cache_get", host_cache_get)?;

    let scope_has = cache_scope.clone();
    let service_cache_has = Arc::clone(&service);
    let host_cache_has = Function::new(
        ctx.clone(),
        move |name: String, key: String| -> rquickjs::Result<bool> {
            service_cache_has
                .cache_dir_has(&scope_has(&name), &name, &key)
                .map_err(|e| rquickjs::Error::new_loading_message("cache", format!("{e:#}")))
        },
    )?;
    globals.set("__host_cache_has", host_cache_has)?;

    // ------------------------------------------------------------------
    // __host_worker_start(name, { argv, env, healthCheckArgv }) → JSON string
    //   { homeDir, tmpDir, port }
    // __host_worker_get(name) → JSON string | null
    //
    // Named, host-spawned persistent worker processes (e.g. sccache's
    // compiler-cache daemon) that outlive individual run() sandboxes. See
    // crate::worker for the lifecycle rationale.
    // ------------------------------------------------------------------
    let wc_worker_start = workspace_root.clone();
    let service_worker_start = Arc::clone(&service);
    let host_worker_start = Function::new(
        ctx.clone(),
        Async(move |ctx: Ctx<'js>, name: String, opts: Object<'js>| {
            let wc = wc_worker_start.clone();
            let service = Arc::clone(&service_worker_start);
            async move {
                let argv: Vec<String> = opts.get("argv")?;
                let env_pairs: Vec<String> = opts
                    .get::<_, Option<Vec<String>>>("env")?
                    .unwrap_or_default();
                let mut env = Vec::with_capacity(env_pairs.len());
                for entry in env_pairs {
                    let (key, value) = entry.split_once('=').ok_or_else(|| {
                        rquickjs::Exception::throw_message(
                            &ctx,
                            &format!("worker env entry '{entry}' is missing '='"),
                        )
                    })?;
                    env.push((key.to_owned(), value.to_owned()));
                }
                let health_check_argv: Vec<String> = opts
                    .get::<_, Option<Vec<String>>>("healthCheckArgv")?
                    .unwrap_or_default();
                let spec = WorkerSpec {
                    argv,
                    env,
                    health_check_argv,
                };
                let handle = service
                    .worker_start(&workspace_cache_id(&wc), &name, spec)
                    .await
                    .map_err(|e| rquickjs::Exception::throw_message(&ctx, &format!("{e:#}")))?;
                serde_json::to_string(&handle).map_err(|e| {
                    rquickjs::Exception::throw_message(&ctx, &format!("encode worker handle: {e}"))
                })
            }
        }),
    )?;
    globals.set("__host_worker_start", host_worker_start)?;

    let service_worker_get = Arc::clone(&service);
    let host_worker_get = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> {
            let handle = service_worker_get
                .worker_get(&name)
                .map_err(|e| rquickjs::Error::new_loading_message("workerGet", format!("{e:#}")))?;
            match handle {
                Some(handle) => {
                    let json = serde_json::to_string(&handle).map_err(|e| {
                        rquickjs::Error::new_loading_message("workerGet", format!("{e}"))
                    })?;
                    Ok(Some(json))
                }
                None => Ok(None),
            }
        },
    )?;
    globals.set("__host_worker_get", host_worker_get)?;

    // ------------------------------------------------------------------
    // __host_workspace_files(root, suffix, recursive) → JSON string ["//path/module"]
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_workspace_files = Function::new(
        ctx.clone(),
        move |root: String, suffix: String, recursive: bool| -> rquickjs::Result<String> {
            workspace_files(&wc, &root, &suffix, recursive)
                .and_then(|files| serde_json::to_string(&files).context("encode workspace files"))
                .map_err(|e| {
                    rquickjs::Error::new_loading_message("workspaceFiles", format!("{e:#}"))
                })
        },
    )?;
    globals.set("__host_workspace_files", host_workspace_files)?;

    // ------------------------------------------------------------------
    // __host_workspace_source_files(root, includeJson, excludeJson)
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let host_workspace_source_files = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "workspaceSourceFiles",
                    format!("parse include regexes: {e}"),
                )
            })?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "workspaceSourceFiles",
                    format!("parse exclude regexes: {e}"),
                )
            })?;
            workspace_source_files(&wc, &root, &include, &exclude)
                .and_then(|files| serde_json::to_string(&files).context("encode source files"))
                .map_err(|e| {
                    rquickjs::Error::new_loading_message("workspaceSourceFiles", format!("{e:#}"))
                })
        },
    )?;
    globals.set("__host_workspace_source_files", host_workspace_source_files)?;

    // ------------------------------------------------------------------
    // __host_all_unowned(root, includeJson, excludeJson)
    // ------------------------------------------------------------------
    let wc = workspace_root.clone();
    let state_unowned = Arc::clone(&state);
    let host_all_unowned = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "allUnowned",
                    format!("parse include globs: {e}"),
                )
            })?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "allUnowned",
                    format!("parse exclude globs: {e}"),
                )
            })?;
            let owned = state_unowned.lock().unwrap().owned_files.clone();
            let mut files = workspace_glob_files(&wc, &root, &include, &exclude).map_err(|e| {
                rquickjs::Error::new_loading_message("allUnowned", format!("{e:#}"))
            })?;
            files.retain(|file| !owned.contains(file));
            serde_json::to_string(&files).map_err(|e| {
                rquickjs::Error::new_loading_message("allUnowned", format!("encode files: {e}"))
            })
        },
    )?;
    globals.set("__host_all_unowned", host_all_unowned)?;

    // ------------------------------------------------------------------
    // __host_hydrate_target(id) → JSON { kind, fields, deps: [{handle, mode}] }
    // ------------------------------------------------------------------
    let state_h = Arc::clone(&state);
    let host_hydrate_target =
        Function::new(ctx.clone(), move |id: u32| -> rquickjs::Result<String> {
            let hs = state_h.lock().unwrap();
            let pending = hs.pending.get(&id).ok_or_else(|| {
                rquickjs::Error::new_loading_message(
                    "hydrateTarget",
                    format!("no pending target for id {id}"),
                )
            })?;
            let deps: Vec<serde_json::Value> = pending
                .dep_ids
                .iter()
                .map(|(dep_id, mode)| {
                    serde_json::json!({
                        "handle": { "__imp": true, "__id": dep_id },
                        "mode": mode,
                    })
                })
                .collect();
            let json = serde_json::json!({
                "kind": pending.kind,
                "attrs": pending.attrs,
                "deps": deps,
            });
            serde_json::to_string(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("hydrateTarget", e.to_string()))
        })?;
    globals.set("__host_hydrate_target", host_hydrate_target)?;

    // ------------------------------------------------------------------
    // __host_target_address(id) → address string
    // ------------------------------------------------------------------
    let state_addr = Arc::clone(&state);
    let host_target_address =
        Function::new(ctx.clone(), move |id: u32| -> rquickjs::Result<String> {
            let hs = state_addr.lock().unwrap();
            hs.id_to_address.get(&id).cloned().ok_or_else(|| {
                rquickjs::Error::new_loading_message(
                    "targetAddress",
                    format!("no address for target id {id}"),
                )
            })
        })?;
    globals.set("__host_target_address", host_target_address)?;

    // ------------------------------------------------------------------
    // __host_workspace_targets(kind) → JSON [{ id, address, kind, attrs }]
    // ------------------------------------------------------------------
    let state_targets = Arc::clone(&state);
    let host_workspace_targets = Function::new(
        ctx.clone(),
        move |kind: String| -> rquickjs::Result<String> {
            let hs = state_targets.lock().unwrap();
            let mut targets = Vec::new();
            for (id, address) in &hs.id_to_address {
                let Some(pending) = hs.pending.get(id) else {
                    continue;
                };
                if !kind.is_empty() && pending.kind != kind {
                    continue;
                }
                targets.push(serde_json::json!({
                    "id": id,
                    "address": address,
                    "kind": pending.kind,
                    "attrs": pending.attrs,
                }));
            }
            serde_json::to_string(&targets).map_err(|e| {
                rquickjs::Error::new_loading_message("workspaceTargets", e.to_string())
            })
        },
    )?;
    globals.set("__host_workspace_targets", host_workspace_targets)?;

    // ------------------------------------------------------------------
    // __host_selected_targets() → JSON [{ id, address, kind, product }]
    // Errors if called outside of goal execution (selected_roots is None).
    // ------------------------------------------------------------------
    let selected_roots_st = Arc::clone(&selected_roots);
    let host_selected_targets = Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
        let guard = selected_roots_st.lock().unwrap();
        let selection = guard.as_ref().ok_or_else(|| {
            action_spec_error(
                "selectedTargets() may only be called during goal execution".to_owned(),
            )
        })?;
        serde_json::to_string(selection)
            .map_err(|e| rquickjs::Error::new_loading_message("selectedTargets", e.to_string()))
    })?;
    globals.set("__host_selected_targets", host_selected_targets)?;

    // ------------------------------------------------------------------
    // __host_current_goal_flags() → JSON object of resolved goal flags
    // Errors if called outside of goal execution (goal_flags is None).
    // ------------------------------------------------------------------
    let goal_flags_gf = Arc::clone(&goal_flags);
    let host_current_goal_flags =
        Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let guard = goal_flags_gf.lock().unwrap();
            let flags = guard.as_ref().ok_or_else(|| {
                action_spec_error("goalFlags() may only be called during goal execution".to_owned())
            })?;
            serde_json::to_string(flags)
                .map_err(|e| rquickjs::Error::new_loading_message("goalFlags", e.to_string()))
        })?;
    globals.set("__host_current_goal_flags", host_current_goal_flags)?;

    // ------------------------------------------------------------------
    // Tracked runtime APIs (Phase 3)
    // ------------------------------------------------------------------

    // __host_glob(root, includeJson, excludeJson) → JSON string[]
    let wc = workspace_root.clone();
    let host_glob = Function::new(
        ctx.clone(),
        move |root: String,
              include_json: String,
              exclude_json: String|
              -> rquickjs::Result<String> {
            let include: Vec<String> = serde_json::from_str(&include_json)
                .map_err(|e| rquickjs::Error::new_loading_message("glob", e.to_string()))?;
            let exclude: Vec<String> = serde_json::from_str(&exclude_json)
                .map_err(|e| rquickjs::Error::new_loading_message("glob", e.to_string()))?;
            // Greedily captures the matched files into CAS as it walks (see
            // `workspace_glob_files_captured`), returning both the plain file list
            // (for `paths()`/display) and a digest handle (for `run()` inputs and
            // `file_set.union()` merging) — JS never sees the tree itself, just this
            // opaque hex-string fingerprint.
            workspace_glob_files_captured(&wc, &root, &include, &exclude)
                .and_then(|r| {
                    serde_json::to_string(&serde_json::json!({
                        "files": r.files,
                        "digest": r.digest.digest(),
                    }))
                    .context("encode glob results")
                })
                .map_err(|e| rquickjs::Error::new_loading_message("glob", format!("{e:#}")))
        },
    )?;
    globals.set("__host_glob", host_glob)?;

    // __host_merge_digests(digestsJson) → merged digest string
    let host_merge_digests = Function::new(
        ctx.clone(),
        move |digests_json: String| -> rquickjs::Result<String> {
            let digests: Vec<String> = serde_json::from_str(&digests_json)
                .map_err(|e| rquickjs::Error::new_loading_message("mergeDigests", e.to_string()))?;
            let trees = digests
                .into_iter()
                .map(imp_store::digest::DirectoryDigest::from_digest)
                .collect();
            imp_store::digest::merge_digests(trees)
                .map(|merged| merged.digest().to_owned())
                .map_err(|e| rquickjs::Error::new_loading_message("mergeDigests", format!("{e:#}")))
        },
    )?;
    globals.set("__host_merge_digests", host_merge_digests)?;

    // __host_diff_digests(beforeDigest, afterDigest) → JSON string of
    // [{type: "added"|"removed"|"modified", path}, ...]
    let host_diff_digests = Function::new(
        ctx.clone(),
        move |before: String, after: String| -> rquickjs::Result<String> {
            let before = imp_store::digest::DirectoryDigest::from_digest(before);
            let after = imp_store::digest::DirectoryDigest::from_digest(after);
            let changes = imp_store::digest::diff_digests(&before, &after).map_err(|e| {
                rquickjs::Error::new_loading_message("diffDigests", format!("{e:#}"))
            })?;
            let json: Vec<serde_json::Value> = changes
                .into_iter()
                .map(|change| {
                    let (kind, path) = match change {
                        imp_store::digest::PathChange::Added(p) => ("added", p),
                        imp_store::digest::PathChange::Removed(p) => ("removed", p),
                        imp_store::digest::PathChange::Modified(p) => ("modified", p),
                    };
                    serde_json::json!({ "type": kind, "path": path })
                })
                .collect();
            serde_json::to_string(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("diffDigests", e.to_string()))
        },
    )?;
    globals.set("__host_diff_digests", host_diff_digests)?;

    // __host_digest_paths(digest) → JSON string[] of every file path in the tree
    let host_digest_paths = Function::new(
        ctx.clone(),
        move |digest: String| -> rquickjs::Result<String> {
            let digest = imp_store::digest::DirectoryDigest::from_digest(digest);
            let paths = imp_store::digest::list_files_in_digest(&digest).map_err(|e| {
                rquickjs::Error::new_loading_message("digestPaths", format!("{e:#}"))
            })?;
            serde_json::to_string(&paths)
                .map_err(|e| rquickjs::Error::new_loading_message("digestPaths", e.to_string()))
        },
    )?;
    globals.set("__host_digest_paths", host_digest_paths)?;

    // __host_digest_read_file(digest, path) → string, the digest-backed
    // analog of __host_read_file for a real workspace path.
    let host_digest_read_file = Function::new(
        ctx.clone(),
        move |digest: String, path: String| -> rquickjs::Result<String> {
            let digest = imp_store::digest::DirectoryDigest::from_digest(digest);
            imp_store::digest::read_file_in_digest(&digest, &path).map_err(|e| {
                rquickjs::Error::new_loading_message("digestReadFile", format!("{e:#}"))
            })
        },
    )?;
    globals.set("__host_digest_read_file", host_digest_read_file)?;

    // __host_capture_paths(pathsJson) → digest string
    // Content-addresses an explicit, already-known-good list of workspace-relative
    // paths into CAS (used by `file_set.literal()`, which — unlike `glob()` — has
    // no root/include/exclude to re-walk).
    let wc = workspace_root.clone();
    let host_capture_paths = Function::new(
        ctx.clone(),
        move |paths_json: String| -> rquickjs::Result<String> {
            let paths: Vec<String> = serde_json::from_str(&paths_json)
                .map_err(|e| rquickjs::Error::new_loading_message("capturePaths", e.to_string()))?;
            imp_store::digest::capture_paths(&wc, &paths)
                .map(|digest| digest.digest().to_owned())
                .map_err(|e| rquickjs::Error::new_loading_message("capturePaths", format!("{e:#}")))
        },
    )?;
    globals.set("__host_capture_paths", host_capture_paths)?;

    // __host_write_workspace(path, digest, from) → null
    // Materializes `digest` (optionally narrowed to the subtree at `from`)
    // directly into the workspace at `path` — no sandbox, no cache record, no
    // process spawn. Backs `writeWorkspace()`, the one blessed way for a
    // `package` product to publish a final digest under dist/.
    let wc = workspace_root.clone();
    let host_write_workspace = Function::new(
        ctx.clone(),
        move |path: String, digest: String, from: Option<String>| -> rquickjs::Result<()> {
            let relative = artifact_relative_path(&path).map_err(|e| {
                rquickjs::Error::new_loading_message("writeWorkspace", format!("{e:#}"))
            })?;
            let destination = wc.join(&relative);
            imp_store::cache::write_workspace(&digest, from.as_deref(), &destination).map_err(
                |e| rquickjs::Error::new_loading_message("writeWorkspace", format!("{e:#}")),
            )
        },
    )?;
    globals.set("__host_write_workspace", host_write_workspace)?;

    // __host_apply_build_edits(editsJson, check) → JSON { changed, checked }
    // Renders and (unless `check`) writes generated BUILD.js edits — the
    // JS-callable entry point for the same render_raw_build_file/
    // apply_build_edits pipeline `generate-build` used to reach only via the
    // bespoke `cmd_generate_build` CLI path. Never bails on stale files
    // itself; the calling goal (rules/workflows/generate_build.js) decides
    // what a check failure means, mirroring how fmtGoal/generateGoal own
    // their own check/throw logic.
    let wc = workspace_root.clone();
    let state_abe = Arc::clone(&state);
    let host_apply_build_edits = Function::new(
        ctx.clone(),
        move |edits_json: String, check: bool| -> rquickjs::Result<String> {
            let edits: BTreeMap<String, BuildFileEdit> = serde_json::from_str(&edits_json)
                .map_err(|e| {
                    rquickjs::Error::new_loading_message(
                        "applyBuildEdits",
                        format!("parse edits: {e}"),
                    )
                })?;
            let build_rules = state_abe.lock().unwrap().build_rules.clone();
            let report = apply_build_edits(&wc, &build_rules, edits, check).map_err(|e| {
                rquickjs::Error::new_loading_message("applyBuildEdits", format!("{e:#}"))
            })?;
            serde_json::to_string(&serde_json::json!({
                "changed": report.changed_files,
                "checked": report.checked_files,
            }))
            .map_err(|e| {
                rquickjs::Error::new_loading_message("applyBuildEdits", format!("encode: {e}"))
            })
        },
    )?;
    globals.set("__host_apply_build_edits", host_apply_build_edits)?;

    // __host_env(name) → string | null
    let host_env = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> { Ok(std::env::var(&name).ok()) },
    )?;
    globals.set("__host_env", host_env)?;

    // __host_which(name) → string | null
    let host_which = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<Option<String>> { Ok(which_executable(&name)) },
    )?;
    globals.set("__host_which", host_which)?;

    // __host_native_tool_artifact(name) → tool-root directory path; throws if
    // name isn't found on PATH.
    let service_native_tool = Arc::clone(&service);
    let host_native_tool_artifact = Function::new(
        ctx.clone(),
        move |name: String| -> rquickjs::Result<String> {
            let resolved = which_executable(&name).ok_or_else(|| {
                rquickjs::Error::new_loading_message(
                    "nativeTool",
                    format!("no '{name}' executable found on PATH"),
                )
            })?;
            let root = service_native_tool
                .register_native_tool(&name, Path::new(&resolved))
                .map_err(|e| {
                    rquickjs::Error::new_loading_message("nativeTool", format!("{e:#}"))
                })?;
            Ok(root.to_string_lossy().into_owned())
        },
    )?;
    globals.set("__host_native_tool_artifact", host_native_tool_artifact)?;

    // __host_read_file(path) → string
    let exec_root_rf = Arc::clone(&exec_root);
    let wc_rf = workspace_root.clone();
    let host_read_file = Function::new(
        ctx.clone(),
        move |path: String| -> rquickjs::Result<String> {
            let p = std::path::Path::new(&path);
            let resolved = if p.is_absolute() {
                p.to_owned()
            } else {
                let root = exec_root_rf
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| wc_rf.clone());
                root.join(p)
            };
            std::fs::read_to_string(&resolved).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    "read_file",
                    format!("{}: {e}", resolved.display()),
                )
            })
        },
    )?;
    globals.set("__host_read_file", host_read_file)?;

    // __host_read_addressed_file(address) → string | null
    // Reads a workspace-addressed data file (`//path/to/file`), exact path
    // only (no .js/index.js candidates): workspace root first, then the
    // built-in rules tree for `//rules/...` — the same precedence module
    // imports use, so a checked-in lockfile next to its rule module ships
    // embedded and a workspace copy at the same address overrides it.
    // Unlike __host_read_file this never consults exec_root; addresses are
    // workspace-rooted by definition.
    let wc_raf = workspace_root.clone();
    let rules_raf = rules_source.clone();
    let host_read_addressed_file = Function::new(
        ctx.clone(),
        move |address: String| -> rquickjs::Result<Option<String>> {
            crate::loader::resolve_workspace_file(&wc_raf, &rules_raf, &address).map_err(
                |message| rquickjs::Error::new_loading_message("readAddressedFile", message),
            )
        },
    )?;
    globals.set("__host_read_addressed_file", host_read_addressed_file)?;

    // __host_run(opts) → { stdout, stderr, exitCode }
    // Submits to the active scheduler, which runs exec_run_inner on a bounded
    // blocking worker and reports the job on the shared event stream.
    let exec_root_run = Arc::clone(&exec_root);
    let exec_no_cache_run = Arc::clone(&exec_no_cache);
    let exec_sandbox_retention_run = Arc::clone(&exec_sandbox_retention);
    let scheduler_run = Arc::clone(&scheduler);
    let service_run = Arc::clone(&service);
    let state_run = Arc::clone(&state);
    let host_run = Function::new(
        ctx.clone(),
        Async(move |ctx: Ctx<'js>, opts: Object<'js>| {
            let exec_root_run = Arc::clone(&exec_root_run);
            let exec_no_cache_run = Arc::clone(&exec_no_cache_run);
            let exec_sandbox_retention_run = Arc::clone(&exec_sandbox_retention_run);
            let scheduler_run = Arc::clone(&scheduler_run);
            let service = Arc::clone(&service_run);
            let state_run = Arc::clone(&state_run);
            async move {
                let root = exec_root_run.lock().unwrap().clone().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "run",
                        "run() called outside of execution context",
                    )
                })?;
                let sched = scheduler_run.lock().unwrap().clone().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "run",
                        "run() called outside of execution context",
                    )
                })?;
                // Owning memo node (if any) so the job nests under it in the UI.
                let parent: Option<u64> = opts.get::<_, Option<f64>>("__owner")?.map(|n| n as u64);
                let shared_caches = shared_cache_names(&state_run);
                let mut run_opts = parse_exec_run_opts(opts, &root, &shared_caches)?;
                run_opts.no_cache = exec_no_cache_run.load(Ordering::SeqCst);
                run_opts.sandbox_retention =
                    SandboxRetention::from_u8(exec_sandbox_retention_run.load(Ordering::SeqCst));
                let display = run_opts.display.clone();
                let cancellation = sched.cancellation_flag();
                let workspace_id = workspace_cache_id(&root);
                let result = sched
                    .run(
                        parent,
                        display,
                        crate::scheduler::TaskKind::Sandbox,
                        move |run_context| {
                            if !run_opts.sandbox {
                                if !run_opts.impure {
                                    anyhow::bail!(
                                        "run({{ sandbox: false }}) requires impure: true"
                                    );
                                }
                                run_context.started();
                                return imp_execution::exec::exec_run_unsandboxed(
                                    &root,
                                    run_opts,
                                    Some(cancellation.as_ref()),
                                    None,
                                )
                                .map(|result| {
                                    imp_exec_api::ExecOutcome {
                                        stdout: result.stdout,
                                        stderr: result.stderr,
                                        exit_code: result.exit_code,
                                        output_digest: result.output_digest.unwrap_or_default(),
                                        outputs: Vec::new(),
                                    }
                                });
                            }
                            let input_digest = imp_execution::staging::resolve_input_digest(
                                &root,
                                &run_opts.inputs,
                            )?;
                            let env = imp_execution::staging::resolve_base_env(&run_opts.env)?;
                            let materialize = run_opts.materialize;
                            let action = ExecAction {
                                argv: run_opts.argv,
                                display: run_opts.display,
                                env,
                                config_digest: run_opts.config_digest,
                                input_digest,
                                outputs: run_opts.outputs,
                                tools: run_opts.tools,
                                impure: run_opts.impure,
                                force_cache: run_opts.force_cache,
                                no_cache: run_opts.no_cache,
                                sandbox_retention: run_opts.sandbox_retention,
                                allow_failure: run_opts.allow_failure,
                            };
                            let result = service.execute_with_start(
                                &workspace_id,
                                action,
                                Some(cancellation.as_ref()),
                                &|| run_context.started(),
                            )?;
                            if materialize {
                                imp_execution::staging::materialize_outputs(
                                    &result.outputs,
                                    &root,
                                )?;
                            }
                            // Named caches are populated by the executor itself
                            // (exec_run_hermetic gets workspace_id), including
                            // repopulation from CAS on task-cache hits.
                            Ok(result)
                        },
                    )
                    .await
                    // Throw a real JS Exception: message lives in a JS string
                    // property, so captured task output survives intact —
                    // printf-style error constructors truncate at ~256 bytes.
                    .map_err(|e| rquickjs::Exception::throw_message(&ctx, &format!("{e:#}")))?;
                let obj = Object::new(ctx)?;
                obj.set("stdout", result.stdout)?;
                obj.set("stderr", result.stderr)?;
                obj.set("exitCode", result.exit_code)?;
                obj.set("outputDigest", result.output_digest)?;
                Ok::<Object<'js>, rquickjs::Error>(obj)
            }
        }),
    )?;
    globals.set("__host_run", host_run)?;

    // __host_task_event(state, id, parent, display)
    // Lets the JS memo layer report memo nodes onto the same task-event stream
    // the scheduler uses, so both live in one tree. No-op without a scheduler
    // (e.g. plain workspace loading).
    let scheduler_ev = Arc::clone(&scheduler);
    let host_task_event = Function::new(
        ctx.clone(),
        move |state: String,
              id: f64,
              parent: Option<f64>,
              display: Option<String>|
              -> rquickjs::Result<()> {
            if let Some(sched) = scheduler_ev.lock().unwrap().clone() {
                let id = id as u64;
                let event = match state.as_str() {
                    "pending" => crate::scheduler::TaskEvent::Pending {
                        id,
                        parent: parent.map(|n| n as u64),
                        display: display.unwrap_or_default(),
                        kind: crate::scheduler::TaskKind::Memo,
                    },
                    "running" => crate::scheduler::TaskEvent::Running { id, detail: None },
                    "done" => crate::scheduler::TaskEvent::Done {
                        id,
                        outcome: crate::scheduler::TaskOutcome::Ok,
                    },
                    "fail" => crate::scheduler::TaskEvent::Done {
                        id,
                        outcome: crate::scheduler::TaskOutcome::Err(display.unwrap_or_default()),
                    },
                    _ => return Ok(()),
                };
                sched.emit(event);
            }
            Ok(())
        },
    )?;
    globals.set("__host_task_event", host_task_event)?;

    let scheduler_lane = Arc::clone(&scheduler);
    let host_js_lane_event = Function::new(
        ctx.clone(),
        move |state: String, slot: u32, id: f64, display: Option<String>| -> rquickjs::Result<()> {
            if let Some(sched) = scheduler_lane.lock().unwrap().clone() {
                let id = id as u64;
                let slot = slot as usize;
                let event = match state.as_str() {
                    "start" => crate::scheduler::TaskEvent::LaneStarted {
                        kind: crate::scheduler::LaneKind::Js,
                        slot,
                        id,
                        display: display.unwrap_or_default(),
                    },
                    "clear" => crate::scheduler::TaskEvent::LaneCleared {
                        kind: crate::scheduler::LaneKind::Js,
                        slot,
                        id,
                    },
                    _ => return Ok(()),
                };
                sched.emit(event);
            }
            Ok(())
        },
    )?;
    globals.set("__host_js_lane_event", host_js_lane_event)?;

    // __host_workspace_mutation(opts) → { stdout, stderr, exitCode, changed_files? }
    // Runs a command directly in the workspace root (not a sandbox). Always impure.
    // When opts.watch is provided (array of regex strings), snaps workspace files
    // matching those patterns before and after, and returns changed_files in the result.
    let exec_root_wm = Arc::clone(&exec_root);
    let scheduler_wm = Arc::clone(&scheduler);
    let host_workspace_mutation = Function::new(
        ctx.clone(),
        Async(move |ctx: Ctx<'js>, opts: Object<'js>| {
            let exec_root_wm = Arc::clone(&exec_root_wm);
            let scheduler_wm = Arc::clone(&scheduler_wm);
            async move {
                let root = exec_root_wm.lock().unwrap().clone().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "workspace_mutation",
                        "workspace_mutation() called outside of execution context",
                    )
                })?;
                let sched = scheduler_wm.lock().unwrap().clone().ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "workspace_mutation",
                        "workspace_mutation() called outside of execution context",
                    )
                })?;
                let argv: Vec<String> = opts.get("argv")?;
                let display: Option<String> = opts.get("display")?;
                let display = display.unwrap_or_else(|| argv.join(" "));
                let parent: Option<u64> = opts.get::<_, Option<f64>>("__owner")?.map(|n| n as u64);
                let watch: Option<Vec<String>> = opts.get("watch")?;
                let (stdout, stderr, exit_code, changed_files) = sched
                    .run(
                        parent,
                        display.clone(),
                        crate::scheduler::TaskKind::Workspace,
                        move |run_context| -> Result<_> {
                            let pre = watch
                                .as_deref()
                                .map(|patterns| {
                                    snapshot_watched_files(&root, patterns)
                                        .with_context(|| "pre-snapshot")
                                })
                                .transpose()?;

                            let (program, args) = argv
                                .split_first()
                                .ok_or_else(|| anyhow::anyhow!("argv must not be empty"))?;
                            run_context.started();
                            let output = std::process::Command::new(program)
                                .args(args)
                                .current_dir(&root)
                                .output()
                                .with_context(|| format!("spawn {display}"))?;

                            let changed_files = if let Some(pre_snap) = pre {
                                let watch = watch.as_deref().unwrap_or_default();
                                let post_snap = snapshot_watched_files(&root, watch)
                                    .with_context(|| "post-snapshot")?;
                                Some(diff_snapshots(&pre_snap, &post_snap))
                            } else {
                                None
                            };

                            Ok((
                                String::from_utf8_lossy(&output.stdout).to_string(),
                                String::from_utf8_lossy(&output.stderr).to_string(),
                                output.status.code().unwrap_or(-1),
                                changed_files,
                            ))
                        },
                    )
                    .await
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message("workspace_mutation", format!("{e:#}"))
                    })?;

                let obj = Object::new(ctx.clone())?;
                obj.set("stdout", stdout)?;
                obj.set("stderr", stderr)?;
                obj.set("exitCode", exit_code)?;

                if let Some(changed) = changed_files {
                    let arr = rquickjs::Array::new(ctx)?;
                    for (i, entry) in changed.iter().enumerate() {
                        arr.set(i, entry.as_str())?;
                    }
                    obj.set("changed_files", arr)?;
                }

                Ok::<Object<'js>, rquickjs::Error>(obj)
            }
        }),
    )?;
    globals.set("__host_workspace_mutation", host_workspace_mutation)?;

    // ------------------------------------------------------------------
    // __host_log(level, message)
    // ------------------------------------------------------------------
    let host_log = Function::new(
        ctx.clone(),
        move |_ctx: Ctx<'js>, level: String, message: String| -> rquickjs::Result<()> {
            let level = match level.trim().to_ascii_lowercase().as_str() {
                "trace" => log::Level::Trace,
                "debug" => log::Level::Debug,
                "info" => log::Level::Info,
                "warn" | "warning" => log::Level::Warn,
                "error" => log::Level::Error,
                _ => log::Level::Info,
            };
            log::log!(target: "imp::js", level, "{message}");
            Ok(())
        },
    )?;
    globals.set("__host_log", host_log)?;

    // Expose the current executable path so JS rules can invoke imp as a generator.
    if let Ok(exe) = std::env::current_exe() {
        globals.set("__imp_self_bin", exe.to_string_lossy().into_owned())?;
    }

    // Expose the resolved cache root so JS rules can hand it to nested imp
    // invocations (via IMP_CACHE_DIR) — sandboxed subprocesses see a pinned
    // HOME and would otherwise re-download named-cache contents.
    if let Ok(cache_dir) = imp_store::cache::cache_root() {
        globals.set(
            "__imp_cache_dir",
            cache_dir.to_string_lossy().into_owned(),
        )?;
    }

    Ok(())
}

fn which_executable(name: &str) -> Option<String> {
    // mut is only needed for the dirs.extend() below, which is windows-only.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();

    #[cfg(windows)]
    dirs.extend(windows_tool_search_dirs());

    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            let with_exe = dir.join(format!("{name}.exe"));
            if with_exe.is_file() {
                return Some(with_exe.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_tool_search_dirs() -> Vec<PathBuf> {
    [
        r"C:\Program Files\Git\bin",
        r"C:\Program Files\Git\usr\bin",
        r"C:\Program Files (x86)\Git\bin",
        r"C:\Program Files (x86)\Git\usr\bin",
        r"C:\msys64\usr\bin",
        r"C:\msys64\mingw64\bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn parse_exec_run_opts<'js>(
    opts: Object<'js>,
    workspace_root: &Path,
    shared_caches: &HashSet<String>,
) -> rquickjs::Result<ExecRunOpts> {
    let argv: Vec<String> = opts.get("argv")?;
    let display: Option<String> = opts.get("display")?;
    let display = display.unwrap_or_else(|| argv.join(" "));
    let env: Vec<String> = opts
        .get::<_, Option<Vec<String>>>("env")?
        .unwrap_or_default();
    let inputs = parse_io_specs(
        opts.get::<_, Option<Vec<Object>>>("inputs")?
            .unwrap_or_default(),
        shared_caches,
    )?;
    let outputs = parse_io_specs(
        opts.get::<_, Option<Vec<Object>>>("outputs")?
            .unwrap_or_default(),
        shared_caches,
    )?;
    let tools = parse_tool_specs(
        opts.get::<_, Option<Vec<Object>>>("tools")?
            .unwrap_or_default(),
        workspace_root,
        shared_caches,
    )?;
    let impure = opts.get::<_, Option<bool>>("impure")?.unwrap_or(false);
    let force_cache = opts.get::<_, Option<bool>>("forceCache")?.unwrap_or(false);
    let allow_failure = opts
        .get::<_, Option<bool>>("allowFailure")?
        .unwrap_or(false);
    let sandbox = opts.get::<_, Option<bool>>("sandbox")?.unwrap_or(true);
    // Enforcement of "must be explicit when outputs are declared" lives in
    // imp_core.js's run() wrapper; this default is only a fallback for
    // callers that reach __host_run without going through it.
    let materialize = opts.get::<_, Option<bool>>("materialize")?.unwrap_or(true);
    let config_digest = opts
        .get::<_, Option<String>>("configDigest")?
        .unwrap_or_default();
    Ok(ExecRunOpts {
        argv,
        display,
        env,
        config_digest,
        inputs,
        outputs,
        tools,
        impure,
        force_cache,
        sandbox,
        materialize,
        allow_failure,
        no_cache: false,
        // Overridden per invocation in the host_run closure (like no_cache).
        sandbox_retention: SandboxRetention::default(),
    })
}

fn workspace_files(
    workspace_root: &Path,
    root: &str,
    suffix: &str,
    recursive: bool,
) -> Result<Vec<String>> {
    let rel = root
        .strip_prefix("//")
        .ok_or_else(|| anyhow::anyhow!("workspaceFiles root '{root}' must start with //"))?;
    validate_workspace_module_path(root, rel).map_err(anyhow::Error::msg)?;

    let directory = workspace_root.join(rel);
    if !directory.is_dir() {
        bail!(
            "workspaceFiles root '{}' is not a directory",
            directory.display()
        );
    }

    let mut files = Vec::new();
    let mut walk = WalkDir::new(&directory);
    if !recursive {
        walk = walk.max_depth(1);
    }
    for entry in walk
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".js") || !name.ends_with(suffix) {
            continue;
        }
        let relative = path
            .strip_prefix(workspace_root)
            .with_context(|| format!("relativize {}", path.display()))?;
        let mut module = relative.to_string_lossy().replace('\\', "/");
        module.truncate(module.len() - ".js".len());
        files.push(format!("//{module}"));
    }
    files.sort();
    Ok(files)
}

fn workspace_source_files(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    matching_workspace_source_paths(workspace_root, root, include, exclude)
}

pub(crate) fn workspace_glob_files(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    if include.is_empty() {
        bail!("glob include must not be empty");
    }
    let include = compile_globs("include", include)?;
    let exclude = compile_globs("exclude", exclude)?;
    let directory = workspace_root.join(workspace_relative_directory(root)?);
    if !directory.is_dir() {
        bail!("glob root '{}' is not a directory", directory.display());
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&directory)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let workspace_relative = entry
            .path()
            .strip_prefix(workspace_root)
            .with_context(|| format!("relativize {}", entry.path().display()))?;
        let workspace_relative = workspace_relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let root_relative = entry
            .path()
            .strip_prefix(&directory)
            .with_context(|| format!("relativize {}", entry.path().display()))?;
        let root_relative = root_relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");

        if include.iter().any(|glob| glob.is_match(&root_relative))
            && !exclude.iter().any(|glob| glob.is_match(&root_relative))
        {
            files.push(workspace_relative);
        }
    }
    files.sort();
    Ok(files)
}

/// A glob's matched file list plus a `Digest` capturing those exact files' content
/// into CAS as they're matched — the greedy-capture counterpart of
/// `workspace_glob_files`. Used wherever the caller may go on to feed the result
/// into `run()` (which needs content, not just names), not by callers that only
/// need the path list (target ownership, unowned-file checks).
pub(crate) struct GlobResult {
    pub(crate) files: Vec<String>,
    pub(crate) digest: imp_store::digest::DirectoryDigest,
}

pub(crate) fn workspace_glob_files_captured(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<GlobResult> {
    let files = workspace_glob_files(workspace_root, root, include, exclude)?;
    let digest = imp_store::digest::capture_paths(workspace_root, &files)?;
    Ok(GlobResult { files, digest })
}

fn matching_workspace_source_paths(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    if include.is_empty() {
        bail!("workspaceSourceFiles include must not be empty");
    }
    let include = compile_regexes("include", include)?;
    let exclude = compile_regexes("exclude", exclude)?;
    let directory = workspace_root.join(workspace_relative_directory(root)?);
    if !directory.is_dir() {
        bail!(
            "workspaceSourceFiles root '{}' is not a directory",
            directory.display()
        );
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&directory)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let relative = entry
            .path()
            .strip_prefix(workspace_root)
            .with_context(|| format!("relativize {}", entry.path().display()))?;
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if include.iter().any(|regex| regex.is_match(&relative))
            && !exclude.iter().any(|regex| regex.is_match(&relative))
        {
            files.push(relative);
        }
    }
    files.sort();
    Ok(files)
}

/// Snapshot workspace files matching `patterns` (regex strings, rooted at workspace root).
/// Returns a map of relative path → content digest.
fn snapshot_watched_files(
    workspace_root: &Path,
    patterns: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    let paths = matching_workspace_source_paths(workspace_root, ".", patterns, &[])?;
    let mut snap = std::collections::HashMap::new();
    for path in paths {
        let abs = workspace_root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let (digest, _) = store_file_blob(&abs, "watch")
            .with_context(|| format!("snapshot {}", abs.display()))?;
        snap.insert(path, digest);
    }
    Ok(snap)
}

/// Diff two snapshots. Returns sorted entries prefixed with `+` (created), `-` (deleted),
/// or bare (modified).
fn diff_snapshots(
    pre: &std::collections::HashMap<String, String>,
    post: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let mut result = Vec::new();
    for (path, post_digest) in post {
        match pre.get(path) {
            None => result.push(format!("+{path}")),
            Some(pre_digest) if pre_digest != post_digest => result.push(path.clone()),
            _ => {}
        }
    }
    for path in pre.keys() {
        if !post.contains_key(path) {
            result.push(format!("-{path}"));
        }
    }
    result.sort();
    result
}

fn compile_regexes(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(pattern).with_context(|| format!("compile {label} source regex {pattern:?}"))
        })
        .collect()
}

pub(crate) fn compile_globs(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .map(|pattern| {
            let regex = glob_pattern_to_regex(pattern);
            Regex::new(&regex).with_context(|| format!("compile {label} glob {pattern:?}"))
        })
        .collect()
}

fn glob_pattern_to_regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut regex = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                if chars.get(i) == Some(&'/') {
                    i += 1;
                    regex.push_str("(?:.*/)?");
                } else {
                    regex.push_str(".*");
                }
            }
            '*' => {
                regex.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                regex.push_str("[^/]");
                i += 1;
            }
            '[' => {
                if let Some((class, next)) = glob_char_class_to_regex(&chars, i) {
                    regex.push_str(&class);
                    i = next;
                } else {
                    regex.push_str(r"\[");
                    i += 1;
                }
            }
            '\\' => {
                if let Some(next) = chars.get(i + 1) {
                    regex.push_str(&regex::escape(&next.to_string()));
                    i += 2;
                } else {
                    regex.push_str(r"\\");
                    i += 1;
                }
            }
            c => {
                regex.push_str(&regex::escape(&c.to_string()));
                i += 1;
            }
        }
    }
    regex.push('$');
    regex
}

fn glob_char_class_to_regex(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut i = start + 1;
    if i >= chars.len() {
        return None;
    }

    let mut class = String::from("[");
    if chars[i] == '!' {
        class.push('^');
        i += 1;
    } else if chars[i] == '^' {
        class.push('\\');
        class.push('^');
        i += 1;
    }

    let mut has_member = false;
    while i < chars.len() {
        let c = chars[i];
        if c == ']' && has_member {
            class.push(']');
            return Some((class, i + 1));
        }
        if c == '\\' {
            class.push('\\');
            class.push('\\');
        } else {
            class.push(c);
        }
        has_member = true;
        i += 1;
    }

    None
}

pub(crate) fn workspace_relative_directory(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path == "." {
        return Ok(PathBuf::new());
    }
    artifact_relative_path(path)
}

/// Recursively copy the contents of `src` into `dst` (which already exists as a
/// directory). Unlike `std::fs::rename` this works across mount boundaries.
/// Names of the caches declared `shared: true`, snapshotted for path
/// resolution outside the registry lock.
fn shared_cache_names(state: &Arc<Mutex<HostState>>) -> HashSet<String> {
    state
        .lock()
        .unwrap()
        .named_caches
        .values()
        .filter(|cache| cache.shared)
        .map(|cache| cache.name.clone())
        .collect()
}

fn named_cache_from_name(name: &str, shared: bool) -> rquickjs::Result<NamedCache> {
    if name.is_empty() {
        return Err(action_spec_error(
            "named cache name must not be empty".to_owned(),
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
    {
        return Err(action_spec_error(format!(
            "named cache '{name}' must contain only lowercase ASCII letters, digits, '-' or '_'"
        )));
    }
    let env_suffix = name.replace('-', "_").to_ascii_uppercase();
    Ok(NamedCache {
        name: name.to_owned(),
        env_var: format!("IMP_NAMED_CACHE_{env_suffix}"),
        shared,
    })
}

fn action_spec_error(message: String) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("value", "imp host API", message)
}

fn validate_config_namespace(namespace: &str) -> rquickjs::Result<()> {
    if namespace.is_empty()
        || !namespace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(action_spec_error(format!(
            "configuration namespace '{namespace}' must use ASCII letters, digits, '.', '-', or '_'"
        )));
    }
    Ok(())
}

fn product_registration_module(stack: &str) -> Option<String> {
    for line in stack.lines() {
        let Some(start) = line.find("//rules/") else {
            continue;
        };
        let mut location = line[start..].trim_end_matches(')').trim();
        for _ in 0..2 {
            let (prefix, suffix) = location.rsplit_once(':')?;
            if !suffix.chars().all(|c| c.is_ascii_digit()) {
                break;
            }
            location = prefix;
        }
        return Some(location.to_owned());
    }
    None
}

/// Extract the declaring module from a JS stack for declaration-identity
/// purposes. Unlike `product_registration_module` it accepts any module
/// specifier (not just `//rules/…`), so declarations in workspace files and
/// test modules still get a stable identity for duplicate detection; frames
/// inside imp:core (the `productName()` helper itself) are skipped.
fn declaration_module(stack: &str) -> Option<String> {
    for line in stack.lines() {
        let line = line.trim();
        let rest = line.strip_prefix("at ").unwrap_or(line);
        let mut location = match rest.rfind('(') {
            Some(open) => rest[open + 1..].trim_end_matches(')'),
            None => rest,
        }
        .trim();
        for _ in 0..2 {
            match location.rsplit_once(':') {
                Some((prefix, suffix))
                    if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) =>
                {
                    location = prefix;
                }
                _ => break,
            }
        }
        if location.is_empty() || location == "imp:core" || !location.contains('/') {
            continue;
        }
        return Some(location.to_owned());
    }
    None
}

/// Rule group a product module belongs to — its first path segment under
/// `//rules/`. Groups map onto the per-directory DOC.md guide tree, so they
/// stay path-derived; tool identity, by contrast, is declared at product
/// registration and never inferred from the path.
fn product_group(module: &str) -> Option<String> {
    let mut parts = module
        .strip_prefix("//rules/")?
        .split('/')
        .collect::<Vec<_>>();
    let top_level_file = (parts.len() == 1)
        .then(|| parts[0].strip_suffix(".js"))
        .flatten()
        .map(str::to_owned);
    if parts.last().is_some_and(|part| part.ends_with(".js")) {
        parts.pop();
    }
    parts
        .first()
        .map(|part| part.trim_end_matches(".js").to_owned())
        .or(top_level_file)
}

fn resolved_product_module(root: &Path, rules: &RulesSource, module: &str) -> String {
    match resolve_workspace_module(root, rules, module).map(|resolution| resolution.form) {
        Ok(ModuleForm::Direct) => format!("{module}.js"),
        Ok(ModuleForm::Index) => format!("{module}/index.js"),
        Ok(ModuleForm::Build) | Err(_) => module.to_owned(),
    }
}

fn derive_rule_capabilities(hs: &HostState) -> RuleCapabilities {
    let mut capabilities = RuleCapabilities::new();
    for ((kind, product, tool), module) in &hs.product_modules {
        let Some(group) = product_group(module) else {
            continue;
        };
        for goal in hs.goals.values().filter(|goal| goal.product == *product) {
            let entry = capabilities
                .entry(group.clone())
                .or_default()
                .entry(goal.name.clone())
                .or_default()
                .entry(tool.clone())
                .or_default();
            entry.target_kinds.insert(kind.clone());
            entry.modules.insert(module.clone());
        }
    }
    capabilities
}

fn merge_workspace_config(existing: &mut serde_json::Value, patch: serde_json::Value) {
    match (existing, patch) {
        (serde_json::Value::Object(existing), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                if let Some(existing_value) = existing.get_mut(&key) {
                    merge_workspace_config(existing_value, value);
                } else {
                    existing.insert(key, value);
                }
            }
        }
        (existing, patch) => {
            *existing = patch;
        }
    }
}

// ---------------------------------------------------------------------------
// DOT rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Selection and formatting
// ---------------------------------------------------------------------------

fn attr_str<'a>(attrs: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    attrs.get(key).and_then(|v| v.as_str())
}

pub fn format_targets(targets: &[&Target], w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;
    for target in targets {
        writeln!(w, "{} ({})", target.address, target.kind)?;
        if let Some(sources) = attr_str(&target.attrs, "sources") {
            if !sources.is_empty() {
                writeln!(w, "  sources: {sources}")?;
            }
        } else if let Some(sources) = target
            .attrs
            .get("sources")
            .and_then(|value| value.as_array())
        {
            let sources = sources
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            if !sources.is_empty() {
                writeln!(w, "  sources: {sources}")?;
            }
        }
        if let Some(ep) = attr_str(&target.attrs, "entrypoint") {
            writeln!(w, "  entrypoint: {ep}")?;
        }
        if let Some(version) = attr_str(&target.attrs, "version") {
            writeln!(w, "  version: {version}")?;
        }
        if !target.dependencies.is_empty() {
            let deps: Vec<_> = target
                .dependencies
                .iter()
                .map(|d| d.address.as_str())
                .collect();
            writeln!(w, "  dependencies: {}", deps.join(", "))?;
        }
    }
    Ok(())
}

pub fn format_dependencies(
    workspace: &Workspace,
    selectors: &[String],
    w: &mut String,
) -> Result<()> {
    let targets = if selectors.is_empty() {
        // Show roots (targets not depended on by any other target).
        let mut child_addrs: BTreeSet<&str> = BTreeSet::new();
        for t in workspace.targets.values() {
            for d in &t.dependencies {
                child_addrs.insert(d.address.as_str());
            }
        }
        let roots: Vec<_> = workspace
            .targets
            .values()
            .filter(|t| !child_addrs.contains(t.address.as_str()))
            .collect();
        if roots.is_empty() {
            workspace.targets.values().collect()
        } else {
            roots
        }
    } else {
        select_targets(workspace, selectors)?
    };

    for target in targets {
        let mut visited = BTreeSet::new();
        let pos = TreePosition {
            prefix: String::new(),
            is_last: true,
            is_root: true,
            edge_mode: None,
        };
        format_dep_tree(workspace, target, pos, &mut visited, w)?;
    }
    Ok(())
}

/// Where a target sits in the printed dependency tree — bundled so
/// `format_dep_tree` doesn't need a long positional parameter list.
struct TreePosition<'a> {
    prefix: String,
    is_last: bool,
    is_root: bool,
    edge_mode: Option<&'a DependencyMode>,
}

fn format_dep_tree(
    workspace: &Workspace,
    target: &Target,
    pos: TreePosition<'_>,
    visited: &mut BTreeSet<String>,
    w: &mut String,
) -> Result<()> {
    use std::fmt::Write;
    let TreePosition {
        prefix,
        is_last,
        is_root,
        edge_mode,
    } = pos;
    let already = visited.contains(&target.address);

    let mode_suffix = match edge_mode {
        Some(DependencyMode::Named(m)) => format!(" [{}]", m),
        _ => String::new(),
    };

    if is_root {
        if already {
            writeln!(w, "{}{} (*)", target.address, mode_suffix)?;
        } else {
            writeln!(w, "{}{}", target.address, mode_suffix)?;
        }
    } else {
        let marker = if is_last { "└── " } else { "├── " };
        if already {
            writeln!(
                w,
                "{}{}{}{} (*)",
                prefix, marker, target.address, mode_suffix
            )?;
        } else {
            writeln!(w, "{}{}{}{}", prefix, marker, target.address, mode_suffix)?;
        }
    }

    if already {
        return Ok(());
    }
    visited.insert(target.address.clone());

    let next_prefix = if is_root {
        String::new()
    } else {
        format!("{}{}", prefix, if is_last { "    " } else { "│   " })
    };

    let count = target.dependencies.len();
    for (i, dep) in target.dependencies.iter().enumerate() {
        let dep_is_last = i == count - 1;
        if let Some(dep_target) = workspace.targets.get(&dep.address) {
            let dep_pos = TreePosition {
                prefix: next_prefix.clone(),
                is_last: dep_is_last,
                is_root: false,
                edge_mode: Some(&dep.mode),
            };
            format_dep_tree(workspace, dep_target, dep_pos, visited, w)?;
        } else {
            let marker = if dep_is_last {
                "└── "
            } else {
                "├── "
            };
            let mode_sfx = match &dep.mode {
                DependencyMode::Named(m) => format!(" [{}]", m),
                DependencyMode::Auto => String::new(),
            };
            writeln!(
                w,
                "{}{}{}{} <missing>",
                next_prefix, marker, dep.address, mode_sfx
            )?;
        }
    }
    Ok(())
}

pub fn format_products(workspace: &Workspace, w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;

    let kinds: BTreeSet<&str> = workspace.products.keys().map(|(k, _)| k.as_str()).collect();

    writeln!(w, "Target Kinds:")?;
    if kinds.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        for kind in &kinds {
            let build_prod = if workspace
                .products
                .contains_key(&((*kind).to_owned(), "build".to_owned()))
            {
                "build"
            } else {
                "<none>"
            };
            writeln!(w, "  - {kind} (build product: {build_prod})")?;
        }
    }
    writeln!(w)?;
    writeln!(w, "Products:")?;
    if workspace.products.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        let mut current_kind: Option<&str> = Option::None;
        for ((kind, product), tools) in &workspace.products {
            if current_kind != Some(kind.as_str()) {
                current_kind = Some(kind.as_str());
                writeln!(w, "  {kind}:")?;
            }
            if tools.len() == 1 {
                writeln!(w, "    - {product}")?;
            } else {
                let tool_list = tools.keys().cloned().collect::<Vec<_>>().join(", ");
                writeln!(w, "    - {product} ({tool_list})")?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// BUILD.js generation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct GeneratedBuildTarget {
    name: String,
    rule: String,
    #[serde(default)]
    props: serde_json::Value,
}

/// Evaluate a product and return its JSON-serializable value.
///
/// Test-only: production dispatch goes through the golden path
/// (execute_goal_live/resolveProduct); this and its sibling helpers below
/// remain as a lighter-weight harness for generate-build product tests that
/// don't need a full scheduler.
#[cfg(test)]
pub async fn evaluate_product_json(
    live: &LiveWorkspace,
    target_addr: &str,
    product_name: &str,
) -> Result<serde_json::Value> {
    let already_known = live.workspace.targets.contains_key(target_addr)
        || live
            .dynamic_targets
            .lock()
            .unwrap()
            .contains_key(target_addr);
    if already_known {
        ensure_expanded(live, &[target_addr.to_owned()], None).await?;
    } else {
        // Unknown target — it may only exist after a rule's lazy expansion
        // (e.g. a CMake sub-target). Expand every statically-declared target
        // whose kind can produce more targets, then retry the lookup below.
        let seeds: Vec<String> = live
            .workspace
            .targets
            .values()
            .filter(|t| live.workspace.expanders.contains_key(&t.kind))
            .map(|t| t.address.clone())
            .collect();
        ensure_expanded(live, &seeds, None).await?;
    }

    let target = lookup_dynamic_or_static(live, target_addr)
        .ok_or_else(|| anyhow::anyhow!("no target '{target_addr}' in workspace"))?;

    let tools = live
        .workspace
        .products
        .get(&(target.kind.clone(), product_name.to_owned()))
        .filter(|tools| !tools.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no product '{product_name}' for kind '{}' (target '{target_addr}')",
                target.kind
            )
        })?;
    if tools.len() > 1 {
        bail!(
            "product '{product_name}' for kind '{}' is registered by several tools ({}); \
             this test helper evaluates a single product function",
            target.kind,
            tools.keys().cloned().collect::<Vec<_>>().join(", ")
        );
    }
    let product_fn_name = tools.values().next().expect("non-empty tool map").clone();

    live.ctx
        .async_with(async |ctx| -> rquickjs::Result<serde_json::Value> {
            let resolve_fn: Function = ctx.globals().get("__imp_resolve_handle")?;
            let handle: Object = resolve_fn.call((target.js_id,))?;
            let promise_resolve: Function = ctx.eval("(value) => Promise.resolve(value)")?;

            let product_fn: Function = ctx.globals().get(product_fn_name.as_str())?;
            let result_value: Value = product_fn
                .call((handle,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;
            let result: MaybePromise = promise_resolve
                .call((result_value,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;
            let value: Value = result
                .into_future()
                .await
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;

            let json: String = ctx
                .json_stringify(value)?
                .ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "product",
                        "product returned a non-JSON value",
                    )
                })?
                .to_string()?;
            serde_json::from_str(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("product", e.to_string()))
        })
        .await
        .map_err(|e| anyhow::anyhow!("evaluate_product_json failed: {e}"))
}

/// Drive a goal's root product functions live: their `run()` calls execute
/// against the active scheduler instead of being recorded. Memo state is reset
/// once up front (not per root) so a dependency shared across roots resolves to
/// a single job. All roots are started before any is awaited, so independent
/// work — and work fanned out with `group()`/`Promise.all` inside a product —
/// runs concurrently, bounded by the scheduler.
///
/// If the goal has a registered callback (`goal(name, fn)`), that callback
/// fully owns the goal: it is invoked once with the selection and, on
/// success, the native per-target dispatch loop below is skipped entirely
/// rather than also running — the callback is responsible for its own
/// dispatch logic (typically `resolveProduct()` plus its own fan-out/await
/// loop). Goals without a callback keep the native per-target dispatch loop
/// unchanged.
///
/// The caller must have installed a scheduler (and this sets `exec_root`).
///
/// Selector-string convenience wrapper around
/// [`execute_goal_live_selection`]; production callers go through the
/// selection-typed entry point, so this survives only for tests.
#[cfg(test)]
pub(crate) async fn execute_goal_live(
    live: &LiveWorkspace,
    workspace_root: &Path,
    goal: &str,
    selectors: &[String],
    no_cache: bool,
    js_workers: usize,
    flags: serde_json::Value,
) -> Result<()> {
    execute_goal_live_selection(
        live,
        workspace_root,
        goal,
        GoalSelection::Selectors(selectors),
        no_cache,
        js_workers,
        flags,
    )
    .await
}

/// How `execute_goal_live_selection` picks its root targets: user-typed
/// selector strings (normal CLI path), or an exact address set precomputed by
/// changed-target detection — resolved with wildcard semantics, where an
/// empty selection is a successful no-op rather than an error.
pub enum GoalSelection<'a> {
    Selectors(&'a [String]),
    ChangedAddresses(&'a BTreeSet<String>),
}

pub async fn execute_goal_live_selection(
    live: &LiveWorkspace,
    workspace_root: &Path,
    goal: &str,
    selection: GoalSelection<'_>,
    no_cache: bool,
    js_workers: usize,
    flags: serde_json::Value,
) -> Result<()> {
    let goal_def = live.workspace.goals.get(goal).ok_or_else(|| {
        let known: Vec<_> = live.workspace.goals.keys().map(String::as_str).collect();
        anyhow::anyhow!(
            "unknown goal '{goal}'; registered goals: {}",
            known.join(", ")
        )
    })?;

    // `ensure_expanded` may invoke a rule's expander, which can call `run()`
    // — that requires an execution context (exec_root + scheduler), so it's
    // installed before expansion runs rather than only around dispatch below.
    // The caller is required to have installed a scheduler already.
    *live.exec_root.lock().unwrap() = Some(workspace_root.to_owned());
    live.exec_no_cache.store(no_cache, Ordering::SeqCst);

    // Resolve selectors against the statically-known workspace first, to
    // find the roots that should seed lazy expansion (the common case:
    // selecting an existing target, or a selector-less default build). If a
    // selector doesn't match anything statically known, it may name a target
    // that only exists after expansion (e.g. a CMake sub-target) — fall back
    // to expanding every statically-declared target whose kind can produce
    // more targets, then retry selector resolution below.
    let empty_dynamic: BTreeMap<String, Target> = BTreeMap::new();
    let seed_addresses: Vec<String> = match &selection {
        GoalSelection::Selectors(selectors) => {
            match select_roots(&live.workspace, &empty_dynamic, goal_def, selectors) {
                Ok(roots) => roots.iter().map(|(t, _)| t.address.clone()).collect(),
                Err(_) => live
                    .workspace
                    .targets
                    .values()
                    .filter(|t| live.workspace.expanders.contains_key(&t.kind))
                    .map(|t| t.address.clone())
                    .collect(),
            }
        }
        // Changed addresses are statically known — no fallback needed.
        GoalSelection::ChangedAddresses(addresses) => addresses.iter().cloned().collect(),
    };
    ensure_expanded(live, &seed_addresses, Some(goal)).await?;

    let dynamic_snapshot: BTreeMap<String, Target> = live.dynamic_targets.lock().unwrap().clone();
    let roots = match &selection {
        GoalSelection::Selectors(selectors) => {
            select_roots(&live.workspace, &dynamic_snapshot, goal_def, selectors)?
        }
        GoalSelection::ChangedAddresses(addresses) => {
            let roots =
                select_roots_for_addresses(&live.workspace, &dynamic_snapshot, goal_def, addresses);
            if roots.is_empty() {
                eprintln!("no changed target has a '{}' product; nothing to do", goal);
                return Ok(());
            }
            roots
        }
    };
    let goal_callback_name = live.workspace.goal_callbacks.get(goal).cloned();

    // Resolve owned (js_id, product fn name, label) triples so nothing borrows
    // the workspace across the JS await below. Only needed when there's no
    // callback — a registered callback skips this native dispatch entirely.
    let mut calls = Vec::new();
    if goal_callback_name.is_none() {
        calls.reserve(roots.len());
        for (target, product) in &roots {
            let tools = live
                .workspace
                .products
                .get(&(target.kind.clone(), product.clone()))
                .filter(|tools| !tools.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "no product '{product}' for kind '{}' (target '{})'",
                        target.kind,
                        target.address
                    )
                })?;
            // Every registered tool runs; the label carries the tool only
            // when several implement the product, keeping single-tool output
            // (the common case) unchanged.
            for (tool, product_fn_name) in tools {
                let label = if tools.len() == 1 {
                    format!("{}#{}", target.address, product)
                } else {
                    format!("{}#{}@{}", target.address, product, tool)
                };
                calls.push((target.js_id, product_fn_name.clone(), label));
            }
        }
    }

    let selection: Vec<serde_json::Value> = roots
        .iter()
        .map(|(target, product)| {
            serde_json::json!({
                "id": target.js_id,
                "address": target.address,
                "kind": target.kind,
                "product": product,
            })
        })
        .collect();
    let selection_json = serde_json::to_string(&selection).context("serialize goal selection")?;

    *live.selected_roots.lock().unwrap() = Some(selection);
    *live.goal_flags.lock().unwrap() = Some(flags);

    let goal_owned = goal.to_owned();
    let result = live
        .ctx
        .async_with(async move |ctx| -> rquickjs::Result<()> {
            let set_js_workers: Function = ctx.globals().get("__imp_set_js_workers")?;
            set_js_workers.call::<_, ()>((js_workers.max(1),))?;
            let resolve_fn: Function = ctx.globals().get("__imp_resolve_handle")?;
            let promise_resolve: Function = ctx.eval("(value) => Promise.resolve(value)")?;

            if let Some(callback_fn_name) = goal_callback_name {
                let json_parse: Function = ctx.eval("(s) => JSON.parse(s)")?;
                let selection_value: Value = json_parse.call((selection_json.as_str(),))?;
                let callback_fn: Function = ctx.globals().get(callback_fn_name.as_str())?;
                let result_value: Value = callback_fn
                    .call((selection_value,))
                    .catch(&ctx)
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message(
                            "execute",
                            format!("goal '{goal_owned}' callback: {e}"),
                        )
                    })?;
                let promise: MaybePromise = promise_resolve
                    .call((result_value,))
                    .catch(&ctx)
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message(
                            "execute",
                            format!("goal '{goal_owned}' callback: {e}"),
                        )
                    })?;
                promise
                    .into_future::<Value>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message(
                            "execute",
                            format!("goal '{goal_owned}' callback: {e}"),
                        )
                    })?;
                // The callback owns the goal entirely on success — the native
                // per-target dispatch loop below never runs for a goal with a
                // registered callback (see doc comment above).
                return Ok(());
            }

            let mut promises = Vec::with_capacity(calls.len());
            for (js_id, fn_name, label) in &calls {
                let handle: Object = resolve_fn.call((*js_id,))?;
                let product_fn: Function = ctx.globals().get(fn_name.as_str())?;
                let result_value: Value = product_fn.call((handle,)).catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("execute", format!("{label}: {e}"))
                })?;
                let promise: MaybePromise = promise_resolve
                    .call((result_value,))
                    .catch(&ctx)
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message("execute", format!("{label}: {e}"))
                    })?;
                promises.push((label, promise));
            }

            for (label, promise) in promises {
                promise
                    .into_future::<Value>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| {
                        rquickjs::Error::new_loading_message("execute", format!("{label}: {e}"))
                    })?;
            }
            Ok(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("execute goal '{goal}' failed: {e}"));
    live.exec_no_cache.store(false, Ordering::SeqCst);
    live.exec_sandbox_retention
        .store(SandboxRetention::default().as_u8(), Ordering::SeqCst);
    *live.selected_roots.lock().unwrap() = None;
    *live.goal_flags.lock().unwrap() = None;
    result
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RulesTestCase {
    pub ordinal: usize,
    pub name: String,
    pub fixture: String,
    pub isolation: String,
}

async fn run_rules_test_script(
    live: &LiveWorkspace,
    workspace_root: &Path,
    script: String,
    outer_cancellation: Arc<AtomicBool>,
) -> Result<String> {
    *live.exec_root.lock().unwrap() = Some(workspace_root.to_owned());
    let local_cancellation = Arc::new(AtomicBool::new(false));
    let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
    let scheduler = crate::scheduler::Scheduler::new(1, Arc::clone(&local_cancellation), tx);
    *live.scheduler.lock().unwrap() = Some(Arc::clone(&scheduler));

    let mirror_cancel = {
        let outer = Arc::clone(&outer_cancellation);
        let local = Arc::clone(&local_cancellation);
        tokio::spawn(async move {
            while !local.load(Ordering::SeqCst) {
                if outer.load(Ordering::SeqCst) {
                    local.store(true, Ordering::SeqCst);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
    };

    let drive = live
        .ctx
        .async_with(async move |ctx| -> rquickjs::Result<String> {
            Module::import(&ctx, "imp:core")?
                .into_future::<Object>()
                .await?;
            let set_js_workers: Function = ctx.globals().get("__imp_set_js_workers")?;
            set_js_workers.call::<_, ()>((1,))?;
            let promise_resolve: Function = ctx.eval("(value) => Promise.resolve(value)")?;
            let result_value: Value = ctx
                .eval(script.as_bytes())
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("rules-test", format!("{e}")))?;
            let promise: MaybePromise = promise_resolve
                .call((result_value,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("rules-test", format!("{e}")))?;
            promise
                .into_future::<String>()
                .await
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("rules-test", format!("{e}")))
        });
    let watchdog = async {
        const STALL_GRACE: std::time::Duration = std::time::Duration::from_secs(30);
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
        result = drive => result.map_err(|error| anyhow::anyhow!("{error}")),
        _ = watchdog => Err(anyhow::anyhow!("rules test stalled with no runnable work for 30s")),
    };

    if result.is_err() && scheduler.outstanding() > 0 {
        local_cancellation.store(true, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    local_cancellation.store(true, Ordering::SeqCst);
    mirror_cancel.abort();
    *live.scheduler.lock().unwrap() = None;
    result
}

async fn discover_rules_test_module(
    workspace_root: &Path,
    module: &str,
    cancellation: Arc<AtomicBool>,
) -> Result<Vec<RulesTestCase>> {
    let live = load_minimal_rules_test_runtime(workspace_root).await?;
    let module_json = serde_json::to_string(module)?;
    let script = format!(
        r#"(async () => {{
    const harness = await import("//rules/imp/test");
    return JSON.stringify(await harness.discoverTestModule({module_json}));
}})()"#
    );
    let json = run_rules_test_script(&live, workspace_root, script, cancellation).await?;
    serde_json::from_str(&json).context("decode rules-test discovery")
}

async fn load_rules_test_fixture(workspace_root: &Path, fixture: &str) -> Result<LiveWorkspace> {
    match fixture {
        "minimal" => load_minimal_rules_test_runtime(workspace_root).await,
        "workspace" => load_workspace_rules_test_runtime(workspace_root).await,
        other => bail!("unknown rules-test fixture '{other}'"),
    }
}

pub(crate) async fn run_rules_test_case(
    workspace_root: &Path,
    module: &str,
    ordinal: usize,
    fixture: &str,
    cancellation: Arc<AtomicBool>,
) -> Result<()> {
    let live = load_rules_test_fixture(workspace_root, fixture).await?;
    let module_json = serde_json::to_string(module)?;
    let script = format!(
        r#"(async () => {{
    const harness = await import("//rules/imp/test");
    await harness.runTestCase({module_json}, {ordinal});
    return "ok";
}})()"#
    );
    run_rules_test_script(&live, workspace_root, script, cancellation)
        .await
        .map(|_| ())
}

async fn run_rules_test_case_process(
    workspace_root: &Path,
    module: &str,
    case: &RulesTestCase,
) -> Result<()> {
    let exe = std::env::current_exe().context("resolve current imp executable")?;
    let output = tokio::process::Command::new(exe)
        .current_dir(workspace_root)
        .arg("rules-test-case")
        .arg(module)
        .arg(case.ordinal.to_string())
        .arg(&case.fixture)
        .kill_on_drop(true)
        .output()
        .await
        .context("spawn isolated rules test")?;
    if output.status.success() {
        return Ok(());
    }
    bail!(
        "isolated process exited with {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    )
}

/// Discover modules in disposable runtimes, then execute every test with a
/// fresh runtime/session or, when requested, in a fresh OS process.
pub async fn run_rules_tests_isolated(
    workspace_root: &Path,
    modules: &[String],
    cancellation: Arc<AtomicBool>,
) -> Result<()> {
    let mut discovered = Vec::new();
    let mut failures = Vec::new();
    let mut seen_modules = HashSet::new();
    for module in modules {
        if !seen_modules.insert(module.clone()) {
            failures.push(format!("  {module}: module was selected more than once"));
            continue;
        }
        let result =
            discover_rules_test_module(workspace_root, module, Arc::clone(&cancellation)).await;
        match result {
            Ok(cases) => {
                discovered.extend(cases.into_iter().map(|case| (module.clone(), case)));
            }
            Err(error) => failures.push(format!("  {module} [discovery]: {error:#}")),
        }
    }

    let total = discovered.len() + failures.len();
    for (module, case) in discovered {
        if cancellation.load(Ordering::SeqCst) {
            bail!("execution canceled");
        }
        let result = if case.isolation == "process" {
            run_rules_test_case_process(workspace_root, &module, &case).await
        } else {
            run_rules_test_case(
                workspace_root,
                &module,
                case.ordinal,
                &case.fixture,
                Arc::clone(&cancellation),
            )
            .await
        };
        if let Err(error) = result {
            failures.push(format!("  {}: {error:#}", case.name));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    bail!(
        "JS tests failed: {}/{}\n{}",
        failures.len(),
        total,
        failures.join("\n")
    )
}

#[cfg(test)]
async fn evaluate_product_function_json(
    live: &LiveWorkspace,
    product_fn_name: &str,
    label: &str,
) -> Result<serde_json::Value> {
    live.ctx
        .async_with(async |ctx| -> rquickjs::Result<serde_json::Value> {
            let handle = Object::new(ctx.clone())?;
            let attrs = Object::new(ctx.clone())?;
            handle.set("attrs", attrs)?;
            let promise_resolve: Function = ctx.eval("(value) => Promise.resolve(value)")?;

            let product_fn: Function = ctx.globals().get(product_fn_name)?;
            let result_value: Value = product_fn
                .call((handle,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;
            let result: MaybePromise = promise_resolve
                .call((result_value,))
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;
            let value: Value = result
                .into_future()
                .await
                .catch(&ctx)
                .map_err(|e| rquickjs::Error::new_loading_message("product", format!("{e}")))?;

            let json: String = ctx
                .json_stringify(value)?
                .ok_or_else(|| {
                    rquickjs::Error::new_loading_message(
                        "product",
                        "product returned a non-JSON value",
                    )
                })?
                .to_string()?;
            serde_json::from_str(&json)
                .map_err(|e| rquickjs::Error::new_loading_message("product", e.to_string()))
        })
        .await
        .map_err(|e| anyhow::anyhow!("evaluate {label} failed: {e}"))
}

type BuildFileEdit = Vec<GeneratedBuildTarget>;

#[cfg(test)]
pub async fn generate_build_files(
    live: &LiveWorkspace,
    workspace_root: &Path,
    selectors: &[String],
    check: bool,
) -> Result<BuildGenerateReport> {
    let mut edits = BTreeMap::new();
    if selectors.is_empty() {
        let generators: Vec<_> = live
            .workspace
            .products
            .iter()
            .filter(|((_, name), _)| name == "generate-build")
            .flat_map(|((kind, _), tools)| {
                tools
                    .values()
                    .map(|product_fn| (kind.clone(), product_fn.clone()))
            })
            .collect();
        if generators.is_empty() {
            bail!(
                "no registered products can produce generate-build\nImport one or more rule modules that export a generate-build product, such as `await import(\"//rules/odin\");`"
            );
        }
        for (kind, product_fn) in generators {
            let label = format!("{kind}#generate-build");
            let value = evaluate_product_function_json(live, &product_fn, &label).await?;
            let product_edits: BTreeMap<String, BuildFileEdit> = serde_json::from_value(value)
                .with_context(|| format!("parse generate-build product result for {label}"))?;
            merge_build_edits(&mut edits, product_edits)?;
        }
    } else {
        for target in select_targets(&live.workspace, selectors)? {
            let value = evaluate_product_json(live, &target.address, "generate-build").await?;
            let product_edits: BTreeMap<String, BuildFileEdit> = serde_json::from_value(value)
                .with_context(|| {
                    format!("parse generate-build product result for {}", target.address)
                })?;
            merge_build_edits(&mut edits, product_edits)?;
        }
    }
    let report = apply_build_edits(workspace_root, &live.workspace.build_rules, edits, check)?;
    if check && !report.changed_files.is_empty() {
        bail!(
            "generated BUILD files are out of date: {}",
            report.changed_files.join(", ")
        );
    }
    Ok(report)
}

#[cfg(test)]
fn merge_build_edits(
    merged: &mut BTreeMap<String, BuildFileEdit>,
    incoming: BTreeMap<String, BuildFileEdit>,
) -> Result<()> {
    for (file, targets) in incoming {
        merged.entry(file).or_default().extend(targets);
    }
    Ok(())
}

fn apply_build_edits(
    workspace_root: &Path,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    edits: BTreeMap<String, BuildFileEdit>,
    check: bool,
) -> Result<BuildGenerateReport> {
    let mut changed_files = Vec::new();
    let mut checked_files = Vec::new();

    for (file, edit) in edits {
        let relative = artifact_relative_path(&file)?;
        let destination = workspace_root.join(relative);
        let existing = match std::fs::read_to_string(&destination) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("read {}", destination.display()));
            }
        };

        let rendered = render_raw_build_file(&file, &existing, build_rules, &edit)?;

        checked_files.push(file.clone());
        if existing != rendered {
            changed_files.push(file.clone());
            if !check {
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("create {}", parent.display()))?;
                }
                std::fs::write(&destination, rendered)
                    .with_context(|| format!("write {}", destination.display()))?;
            }
        }
    }

    Ok(BuildGenerateReport {
        changed_files,
        checked_files,
    })
}

fn render_raw_build_file(
    file: &str,
    existing: &str,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[GeneratedBuildTarget],
) -> Result<String> {
    let existing_exports = manual_export_names(existing)?;
    let targets = targets
        .iter()
        .filter(|target| !existing_exports.contains(&target.name))
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(existing.to_owned());
    }
    let current_module = build_file_module(file)?;
    let imports = render_missing_imports(file, &current_module, existing, build_rules, &targets)?;
    let target_block = render_generated_targets(build_rules, &targets, &current_module)?;

    let mut rendered = String::new();
    if !imports.is_empty() {
        rendered.push_str(&imports);
        if !existing.trim().is_empty() {
            rendered.push('\n');
        }
    }
    let existing = existing.trim_end();
    if !existing.is_empty() {
        rendered.push_str(existing);
        rendered.push_str("\n\n");
    }
    rendered.push_str(&target_block);
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    Ok(rendered)
}

fn manual_export_names(content: &str) -> Result<BTreeSet<String>> {
    let re = Regex::new(r"(?m)^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b")
        .context("compile export regex")?;
    Ok(re
        .captures_iter(content)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_owned()))
        .collect())
}

fn render_missing_imports(
    file: &str,
    current_module: &str,
    existing: &str,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[&GeneratedBuildTarget],
) -> Result<String> {
    let mut imports = required_imports(file, current_module, build_rules, targets)?;
    let existing_imports = existing_imports(existing)?;
    for (module, symbols) in existing_imports {
        if let Some(required) = imports.get_mut(&module) {
            for symbol in symbols {
                required.remove(&symbol);
            }
        }
    }
    imports.retain(|_, symbols| !symbols.is_empty());

    let mut rendered = String::new();
    for (from, symbols) in imports {
        let names = symbols.into_iter().collect::<Vec<_>>().join(", ");
        rendered.push_str(&format!("import {{ {names} }} from \"{from}\";\n"));
    }
    Ok(rendered)
}

fn required_imports(
    file: &str,
    current_module: &str,
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[&GeneratedBuildTarget],
) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let mut imports: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for target in targets {
        let rule = build_rules.get(&target.rule).ok_or_else(|| {
            anyhow::anyhow!(
                "{file}: no render metadata registered for rule '{}'",
                target.rule
            )
        })?;
        imports
            .entry(rule.import_from.clone())
            .or_default()
            .insert(rule.import_name.clone());

        let mut refs = BTreeSet::new();
        collect_target_refs(&target.props, &mut refs)?;
        for address in refs {
            let (module, symbol) = target_ref_parts(&address)?;
            if module != current_module {
                imports.entry(module).or_default().insert(symbol);
            }
        }
    }
    Ok(imports)
}

fn existing_imports(content: &str) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let re = Regex::new(r#"(?m)^\s*import\s+\{\s*([^}]+?)\s*\}\s+from\s+"([^"]+)";"#)
        .context("compile import regex")?;
    let mut imports: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for capture in re.captures_iter(content) {
        let names = capture.get(1).map(|m| m.as_str()).unwrap_or("");
        let module = capture.get(2).map(|m| m.as_str()).unwrap_or("");
        for name in names.split(',') {
            let name = name.trim();
            if !name.is_empty() {
                imports
                    .entry(module.to_owned())
                    .or_default()
                    .insert(name.to_owned());
            }
        }
    }
    Ok(imports)
}

fn render_generated_targets(
    build_rules: &BTreeMap<String, BuildRuleRender>,
    targets: &[&GeneratedBuildTarget],
    current_module: &str,
) -> Result<String> {
    let mut rendered = String::new();
    for target in targets {
        if !is_js_identifier(&target.name) {
            bail!(
                "generated target name '{}' is not a valid JavaScript identifier",
                target.name
            );
        }
        let rule = build_rules.get(&target.rule).ok_or_else(|| {
            anyhow::anyhow!("no render metadata registered for rule '{}'", target.rule)
        })?;
        if !is_js_identifier(&rule.import_name) {
            bail!(
                "generated rule import '{}' is not a valid JavaScript identifier",
                rule.import_name
            );
        }
        let props = render_js_value(&target.props, 0, current_module)?;
        rendered.push_str(&format!(
            "export const {} = {}({});\n",
            target.name, rule.import_name, props
        ));
    }
    Ok(rendered)
}

fn collect_target_refs(value: &serde_json::Value, refs: &mut BTreeSet<String>) -> Result<()> {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                collect_target_refs(value, refs)?;
            }
        }
        serde_json::Value::Object(object) if is_target_ref(value) => {
            let address = object
                .get("address")
                .and_then(|value| value.as_str())
                .ok_or_else(|| anyhow::anyhow!("targetRef value is missing address"))?;
            refs.insert(address.to_owned());
        }
        serde_json::Value::Object(object) => {
            for value in object.values() {
                collect_target_refs(value, refs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn render_js_value(
    value: &serde_json::Value,
    indent: usize,
    current_module: &str,
) -> Result<String> {
    match value {
        serde_json::Value::Null => Ok("null".to_owned()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => Ok(serde_json::to_string(value)?),
        serde_json::Value::Array(values) => {
            if values.is_empty() {
                return Ok("[]".to_owned());
            }
            if values.iter().all(is_simple_js_value) {
                let items = values
                    .iter()
                    .map(|value| render_js_value(value, indent, current_module))
                    .collect::<Result<Vec<_>>>()?;
                return Ok(format!("[{}]", items.join(", ")));
            }
            let child_indent = " ".repeat(indent + 4);
            let mut rendered = String::from("[\n");
            for value in values {
                rendered.push_str(&child_indent);
                rendered.push_str(&render_js_value(value, indent + 4, current_module)?);
                rendered.push_str(",\n");
            }
            rendered.push_str(&" ".repeat(indent));
            rendered.push(']');
            Ok(rendered)
        }
        serde_json::Value::Object(object) if is_target_ref(value) => {
            let address = object
                .get("address")
                .and_then(|value| value.as_str())
                .ok_or_else(|| anyhow::anyhow!("targetRef value is missing address"))?;
            let (module, symbol) = target_ref_parts(address)?;
            if module == current_module || is_js_identifier(&symbol) {
                Ok(symbol)
            } else {
                bail!("targetRef symbol '{symbol}' is not a valid JavaScript identifier")
            }
        }
        serde_json::Value::Object(object) => {
            if object.is_empty() {
                return Ok("{}".to_owned());
            }
            let child_indent = " ".repeat(indent + 4);
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let mut rendered = String::from("{\n");
            for key in keys {
                let value = object.get(key).unwrap();
                rendered.push_str(&child_indent);
                rendered.push_str(&render_js_key(key));
                rendered.push_str(": ");
                rendered.push_str(&render_js_value(value, indent + 4, current_module)?);
                rendered.push_str(",\n");
            }
            rendered.push_str(&" ".repeat(indent));
            rendered.push('}');
            Ok(rendered)
        }
    }
}

fn is_simple_js_value(value: &serde_json::Value) -> bool {
    matches!(
        value,
        serde_json::Value::Null
            | serde_json::Value::Bool(_)
            | serde_json::Value::Number(_)
            | serde_json::Value::String(_)
    ) || is_target_ref(value)
}

fn is_target_ref(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("__imp_target_ref"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn render_js_key(key: &str) -> String {
    if is_js_identifier(key) {
        key.to_owned()
    } else {
        serde_json::to_string(key).expect("serialize object key")
    }
}

fn is_js_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

fn target_ref_parts(address: &str) -> Result<(String, String)> {
    let (module, name) = address
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("targetRef address '{address}' must include ':'"))?;
    if !module.starts_with("//") || name.is_empty() {
        bail!("targetRef address '{address}' must be a workspace target address");
    }
    if !is_js_identifier(name) {
        bail!("targetRef target name '{name}' is not a valid JavaScript identifier");
    }
    Ok((module.to_owned(), name.to_owned()))
}

fn build_file_module(file: &str) -> Result<String> {
    let relative = artifact_relative_path(file)?;
    if relative.file_name().and_then(|name| name.to_str()) != Some(BUILD_FILE) {
        bail!("generated BUILD edit path must end in {BUILD_FILE}: {file}");
    }
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    if parent.as_os_str().is_empty() {
        return Ok("//".to_owned());
    }
    Ok(format!(
        "//{}",
        parent
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    ))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn scope_for(root: &Path, build_file: &Path) -> Result<String> {
    let directory = build_file
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent directory", BUILD_FILE))?;
    let relative = directory
        .strip_prefix(root)
        .with_context(|| format!("{} is outside workspace", build_file.display()))?;
    if relative.as_os_str().is_empty() {
        return Ok("//".to_owned());
    }
    Ok(format!(
        "//{}",
        relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    ))
}

fn build_module_name_for(root: &Path, build_file: &Path, scope: &str) -> Result<String> {
    if resolve_workspace_module(root, &RulesSource::Embedded, scope)
        .map(|resolution| {
            resolution.kind == ModuleKind::Build
                && matches!(resolution.source, ModuleSource::File(ref path) if path == build_file)
        })
        .unwrap_or(false)
    {
        return Ok(scope.to_owned());
    }

    let relative = build_file
        .strip_prefix(root)
        .with_context(|| format!("{} is outside workspace", build_file.display()))?;
    let mut module = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if !module.ends_with(".js") {
        bail!("{} is not a JavaScript module", build_file.display());
    }
    module.truncate(module.len() - ".js".len());
    Ok(format!("//{module}"))
}

#[allow(dead_code)]
fn target_address(scope: &str, name: &str) -> Result<String> {
    if name.is_empty() || name.contains(':') || name.contains('/') {
        bail!("target name '{name}' must be a simple name");
    }
    Ok(format!("{scope}:{name}"))
}

#[allow(dead_code)]
fn parse_dependency(scope: &str, value: &str) -> Result<Dependency> {
    let value = value.strip_prefix("auto:").unwrap_or(value);
    let address = if value.starts_with("//") {
        value.to_owned()
    } else if value.starts_with(':') {
        format!("{scope}{value}")
    } else {
        bail!("dependency '{value}' must be an absolute or local target address");
    };
    Ok(Dependency {
        address,
        mode: DependencyMode::Auto,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use imp_execution::exec::{
        report_process_line, spawn_output_reader, ProcessLine, ProcessStream,
    };

    /// Clear runtime-global memo state so a repeated goal invocation on the
    /// same LiveWorkspace re-evaluates its product functions. Production runs
    /// one goal per process and never needs this.
    async fn reset_js_memo_state(live: &LiveWorkspace) {
        live.ctx
            .async_with(async |ctx| -> rquickjs::Result<()> {
                let reset: Function = ctx.globals().get("resetMemoState")?;
                reset.call::<_, ()>(())
            })
            .await
            .unwrap();
    }

    async fn run_goal_live(
        live: &LiveWorkspace,
        root: &std::path::Path,
        goal: &str,
        selectors: &[String],
    ) -> Result<()> {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);
        execute_goal_live(live, root, goal, selectors, false, 1, serde_json::json!({})).await
    }
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::time::Duration;
    use tempfile::TempDir;

    // ---- Common rule JS strings ----------------------------------------

    const CPP_RULES_JS: &str = r#"
import { target, glob, memo, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_cmake_lib = targetKind("cmake-lib");

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const native_link_library = product(K_cmake_lib, BUILD, toolName("cmake-lib-tool"), async function native_link_library(handle) {
    const inputs = [];
    for (const dep of handle.attrs.deps || []) {
        if (dep.kind === "cpp-sources") inputs.push(await sources(dep));
    }
    return run({ argv: ["sh", "-c", "true"], inputs, display: `cmake --build ${handle.attrs.entrypoint}`, impure: true });
});

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", attrs: { sources: srcs } });
}
export function cmakeLib({ entrypoint, deps = [] }) {
    return target({ kind: "cmake-lib", attrs: { entrypoint, deps } });
}
"#;

    const ODIN_RULES_JS: &str = r#"
import { target, glob, memo, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_odin_package = targetKind("odin-package");

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const odin_package = product(K_odin_package, BUILD, toolName("odin-package-tool"), async function odin_package(handle) {
    const srcs = await sources(handle);
    return run({ argv: ["sh", "-c", "true"], inputs: [srcs], display: "odin build", impure: true });
});

export function odinPackage({ srcs, deps = [] }) {
    return target({ kind: "odin-package", attrs: { sources: srcs, deps } });
}
"#;

    const ASSET_RULES_JS: &str = r#"
import { target, glob, memo, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_asset = targetKind("asset");

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const bundle = product(K_asset, BUILD, toolName("asset-tool"), async function bundle(handle) {
    const srcs = await sources(handle);
    return run({ argv: ["sh", "-c", "true"], inputs: [srcs], display: `bundle ${handle.attrs.sources.join(",")}`, impure: true });
});

export function asset({ srcs }) {
    return target({ kind: "asset", attrs: { sources: srcs } });
}
"#;

    const GENERATE_BUILD_RULES_JS: &str = r#"
import { allUnowned, target, product, registerBuildRule, sourcesField, productName, targetKind, toolName } from "imp:core";
const K_odin_build_generator = targetKind("odin-build-generator");
export const P_generate_build = productName("generate-build");

registerBuildRule({ rule: "odinPackage", importFrom: "//rules/odin" });

const DEFAULT_EXCLUDES = ["**/vendor/**"];

function dirname(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "." : path.slice(0, index);
}

function basename(path) {
    if (path === ".") return "root";
    const index = path.lastIndexOf("/");
    return index < 0 ? path : path.slice(index + 1);
}

export const generateBuild = product(K_odin_build_generator, P_generate_build, toolName("odin-build-generator-tool"), async function generateBuild(handle) {
    const files = allUnowned({
        root: handle.attrs.root || ".",
        include: ["**/*.odin"],
        exclude: handle.attrs.exclude || DEFAULT_EXCLUDES,
    });
    const dirs = Array.from(new Set(files.map(dirname))).sort();
    const result = {};
    for (const dir of dirs) {
        result[dir === "." ? "BUILD.js" : `${dir}/BUILD.js`] = [{
                name: basename(dir).replace(/[^A-Za-z0-9_$]/g, "_") || "root",
                rule: "odinPackage",
                props: { srcs: ["*.odin"] },
            }];
    }
    return result;
});

export function odinGenerateBuild({ root = ".", exclude = DEFAULT_EXCLUDES } = {}) {
    return target({ kind: "odin-build-generator", attrs: { root, exclude } });
}

export function odinPackage(opts) {
    const attrs = opts || {};
    return target({
        kind: "odin-package",
        attrs,
        sources: sourcesField({
            root: attrs.path || ".",
            include: attrs.srcs || [],
            exclude: attrs.exclude || [],
        }),
    });
}
"#;

    // ---- Fixture -------------------------------------------------------

    fn fixture() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // imp.workspace.js
        std::fs::write(
            p.join(WORKSPACE_FILE),
            r#"
import "//rules/c/cmake";
import "//rules/odin";
import "//rules/asset";
"#,
        )
        .unwrap();

        let rules = p.join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(rules.join("c/cmake")).unwrap();
        std::fs::write(rules.join("c/cmake/index.js"), CPP_RULES_JS).unwrap();
        std::fs::write(rules.join("odin.js"), ODIN_RULES_JS).unwrap();
        std::fs::write(rules.join("asset.js"), ASSET_RULES_JS).unwrap();

        // src/cpp/joltphysics/BUILD.js
        let cpp = p.join("src/cpp/joltphysics");
        std::fs::create_dir_all(&cpp).unwrap();
        std::fs::write(
            cpp.join(BUILD_FILE),
            r#"
import { cppSources, cmakeLib } from "//rules/c/cmake";

export const joltphysics = cppSources({ srcs: ["**/*.h", "**/*.cpp"] });
export const cmake = cmakeLib({ entrypoint: "CMakeLists.txt", deps: [joltphysics] });
"#,
        )
        .unwrap();

        // library/jodin/BUILD.js
        let odin = p.join("library/jodin");
        std::fs::create_dir_all(&odin).unwrap();
        std::fs::write(
            odin.join(BUILD_FILE),
            r#"
import { odinPackage } from "//rules/odin";
import { cmake } from "//src/cpp/joltphysics";

export const jodin = odinPackage({ srcs: ["**/*.odin"], deps: [cmake] });
"#,
        )
        .unwrap();

        // assets/BUILD.js
        let assets = p.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(
            assets.join(BUILD_FILE),
            r#"
import { asset } from "//rules/asset";

export const ui = asset({ srcs: ["**/*.png"] });
"#,
        )
        .unwrap();

        root
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn js_string_path(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    }

    #[test]
    fn workspace_files_can_limit_discovery_to_one_directory() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join("rules/pkg/direct_test.js"), "");
        write_file(&p.join("rules/pkg/nested/nested_test.js"), "");

        assert_eq!(
            workspace_files(p, "//rules/pkg", "_test.js", false).unwrap(),
            ["//rules/pkg/direct_test"],
        );
        assert_eq!(
            workspace_files(p, "//rules/pkg", "_test.js", true).unwrap(),
            ["//rules/pkg/direct_test", "//rules/pkg/nested/nested_test",],
        );
    }

    #[tokio::test]
    async fn rules_tests_receive_fresh_module_state_per_test() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), "");
        write_file(
            &p.join("rules/example/isolation_test.js"),
            r#"
import { expect, test } from "//rules/imp/test";
let state = 0;
test("mutates state", () => { state = 1; expect(state).toBe(1); });
test("starts clean", () => { expect(state).toBe(0); });
"#,
        );

        run_rules_tests_isolated(
            p,
            &["//rules/example/isolation_test".to_owned()],
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn host_js_logs_are_written_through_the_log_crate() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(p.join(WORKSPACE_FILE).as_path(), "");
        write_file(
            p.join(BUILD_FILE).as_path(),
            r#"
import { target, logDebug, logInfo, logWarn, logError } from "imp:core";

logDebug("debug message");
logInfo("info message");
logWarn("warn message");
logError("error message");

export const app = target({ kind: "sample" });
"#,
        );

        let lines = crate::logging::capture();
        let _workspace = load_workspace(p).await.unwrap();

        let rendered = lines.lock().unwrap().join("\n");

        assert!(rendered.contains("[debug] debug message"));
        assert!(rendered.contains("[info] info message"));
        assert!(rendered.contains("[warn] warn message"));
        assert!(rendered.contains("[error] error message"));
    }

    #[tokio::test]
    async fn workspace_loads_config_before_build_files() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();

        // Products registered by workspace.js imports.
        assert!(workspace
            .products
            .contains_key(&("odin-package".into(), "build".into())));
        assert!(workspace
            .products
            .contains_key(&("asset".into(), "build".into())));

        // Targets declared by BUILD.js files.
        assert!(workspace
            .targets
            .contains_key("//src/cpp/joltphysics:joltphysics"));
        assert_eq!(
            workspace.targets["//src/cpp/joltphysics:cmake"].dependencies[0].address,
            "//src/cpp/joltphysics:joltphysics"
        );
        assert!(workspace.targets.contains_key("//library/jodin:jodin"));
    }

    #[tokio::test]
    async fn workspace_falls_back_to_dev_rules_dir_for_builtin_rules() {
        // `//rules/...` isn't found under the workspace root itself, so it
        // falls back to imp's built-in rules — RulesSource::Dev here
        // stands in for IMP_RULES_DIR, letting the test exercise the
        // fallback without touching process environment state.
        let root = tempfile::tempdir().unwrap();
        let dev_rules = tempfile::tempdir().unwrap();
        let p = root.path();
        let dev_rules_dir = dev_rules.path().join("rules");

        write_file(
            &dev_rules_dir.join("external/helper.js"),
            r#"
export const actionName = "external build {address}";
"#,
        );
        write_file(
            &dev_rules_dir.join("external/index.js"),
            r#"
import { target, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_external = targetKind("external");
import { actionName } from "//rules/external/helper";

export const external_product = product(K_external, BUILD, toolName("external-tool"), async function external_product(handle) {
    return run({ argv: ["sh", "-c", "true"], display: actionName.replace("{address}", handle.label.address), impure: true });
});

export function externalThing(name) {
    return target({ kind: "external", attrs: { name } });
}
"#,
        );

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"await import("//rules/external");"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { externalThing } from "//rules/external";

export const app = externalThing("app");
"#,
        );

        let workspace = load_workspace_with_rules(p, RulesSource::Dev(dev_rules_dir))
            .await
            .unwrap();
        assert!(workspace
            .products
            .contains_key(&("external".into(), "build".into())));
        assert_eq!(
            workspace.targets["//:app"].attrs["name"].as_str().unwrap(),
            "app"
        );

        // Root selection resolves through the fallback rule's product, and
        // the product function evaluates live from the dev rules dir.
        let goal_def = workspace.workspace.goals.get("build").unwrap();
        let no_dynamic_1: BTreeMap<String, Target> = BTreeMap::new();
        let roots = select_roots(
            &workspace.workspace,
            &no_dynamic_1,
            goal_def,
            &["app".into()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//:app");
        assert_eq!(roots[0].1, "build");
        run_goal_live(&workspace, p, "build", &["app".into()])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn workspace_prefers_on_disk_rules_over_the_dev_fallback() {
        // A project that vendors its own `rules/` directory should win over
        // the fallback — the fallback only kicks in when nothing is found
        // under the workspace root.
        let root = tempfile::tempdir().unwrap();
        let dev_rules = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join("rules/local.js"),
            r#"export const marker = "local";"#,
        );
        write_file(
            &dev_rules.path().join("rules/local.js"),
            r#"export const marker = "dev-fallback";"#,
        );
        write_file(&p.join(WORKSPACE_FILE), "");
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target } from "imp:core";
import { marker } from "//rules/local";

export const app = target({ kind: "asset", attrs: { marker } });
"#,
        );

        let workspace =
            load_workspace_with_rules(p, RulesSource::Dev(dev_rules.path().join("rules")))
                .await
                .unwrap();
        assert_eq!(
            workspace.targets["//:app"].attrs["marker"]
                .as_str()
                .unwrap(),
            "local"
        );
    }

    #[tokio::test]
    async fn workspace_root_is_discovered_from_a_nested_directory() {
        let root = fixture();
        let nested = root.path().join("library/jodin");
        assert_eq!(
            find_workspace_root(&nested).unwrap(),
            root.path().canonicalize().unwrap()
        );
    }

    #[tokio::test]
    async fn workspace_config_is_available_to_product_functions() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import { configure } from "imp:core";
import "//rules/configured";

configure("example", { flags: { mode: "debug" } });
            "#,
        );
        write_file(
            &p.join("rules/configured.js"),
            r#"
import { target, glob, memo, product, run, configuration, BUILD, targetKind, toolName } from "imp:core";
const K_configured = targetKind("configured");

export const sources = memo(async function sources(handle) {
    return glob({ root: ".", include: handle.attrs.sources || [] });
});

export const configured_flags = memo(async function configured_flags(handle) {
    const config = configuration("example", {}) || {};
    return Object.entries(config.flags || {}).map(([name, value]) => `--${name}=${value}`);
});

export const configured_product = product(K_configured, BUILD, toolName("configured-tool"), async function configured_product(handle) {
    const srcs = await sources(handle);
    const flags = await configured_flags(handle);
    return run({ argv: ["sh", "-c", "true"], inputs: [srcs], display: `configured ${flags.join(" ")}`, impure: true });
});

export function configured({ srcs }) {
    return target({ kind: "configured", attrs: { sources: srcs } });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { configured } from "//rules/configured";

export const pkg = configured({ srcs: ["**/*.txt"] });
"#,
        );

        let workspace = load_workspace(p).await.unwrap();
        assert_eq!(
            workspace.workspace_config["example"]["flags"]["mode"]
                .as_str()
                .unwrap(),
            "debug"
        );
        // The configured product evaluates live (its flags come from
        // configuration()), and wildcard selection picks it up.
        run_goal_live(&workspace, p, "build", &["pkg".into()])
            .await
            .unwrap();
        let goal_def = workspace.workspace.goals.get("build").unwrap();
        let no_dynamic_2: BTreeMap<String, Target> = BTreeMap::new();
        let roots = select_roots(
            &workspace.workspace,
            &no_dynamic_2,
            goal_def,
            &["//...".to_owned()],
        )
        .unwrap();
        assert!(roots
            .iter()
            .any(|(t, product)| t.address == "//:pkg" && product == "build"));
    }

    #[test]
    fn declarative_config_validation_fills_defaults() {
        let schema = serde_json::json!({
            "__impField": "object",
            "shape": {
                "mode": { "__impField": "enum", "values": ["debug", "release"], "default": "debug" },
                "enabled": { "__impField": "bool", "default": true },
            }
        });
        assert_eq!(
            validate_config_value(&schema, &serde_json::json!({}), "example").unwrap(),
            serde_json::json!({ "mode": "debug", "enabled": true })
        );
    }

    #[test]
    fn declarative_config_validation_rejects_unknown_and_wrong_types() {
        let schema = serde_json::json!({
            "__impField": "object",
            "shape": { "count": { "__impField": "int" } }
        });
        let unknown = validate_config_value(&schema, &serde_json::json!({ "other": 1 }), "example")
            .unwrap_err();
        assert!(unknown.to_string().contains("not declared"));
        let wrong = validate_config_value(&schema, &serde_json::json!({ "count": "1" }), "example")
            .unwrap_err();
        assert!(wrong.to_string().contains("must be an integer"));
    }

    #[test]
    fn declarative_config_validation_rejects_invalid_enum_and_missing_required() {
        let schema = serde_json::json!({
            "__impField": "object",
            "shape": {
                "mode": { "__impField": "enum", "values": ["debug", "release"] },
                "name": { "__impField": "string", "required": true }
            }
        });
        let invalid_enum = validate_config_value(
            &schema,
            &serde_json::json!({ "mode": "other", "name": "x" }),
            "example",
        )
        .unwrap_err();
        assert!(invalid_enum.to_string().contains("must be one of"));
        let missing =
            validate_config_value(&schema, &serde_json::json!({ "mode": "debug" }), "example")
                .unwrap_err();
        assert!(missing.to_string().contains("missing required"));
    }

    #[test]
    fn declarative_config_validation_accepts_maps_and_checks_values() {
        let schema = serde_json::json!({
            "__impField": "map",
            "key": { "__impField": "string" },
            "value": { "__impField": "string" }
        });
        assert_eq!(
            validate_config_value(
                &schema,
                &serde_json::json!({ "lib": "library", "vendor": "vendor/odin" }),
                "odin.collections"
            )
            .unwrap(),
            serde_json::json!({ "lib": "library", "vendor": "vendor/odin" })
        );
        let error = validate_config_value(
            &schema,
            &serde_json::json!({ "lib": 42 }),
            "odin.collections",
        )
        .unwrap_err();
        assert!(error.to_string().contains("must be a string"));
    }

    #[test]
    fn product_provenance_extracts_rule_modules_from_quickjs_stacks() {
        let stack = [
            "Error: product registration",
            "    at product (imp:core:1128:31)",
            "    at <anonymous> (//rules/rust/clippy/index.js:6:39)",
        ]
        .join("\n");
        assert_eq!(
            product_registration_module(&stack).as_deref(),
            Some("//rules/rust/clippy/index.js")
        );
        assert_eq!(
            product_group("//rules/rust/clippy/index.js").as_deref(),
            Some("rust")
        );
        assert_eq!(
            product_group("//rules/rust/test.js").as_deref(),
            Some("rust")
        );
        assert_eq!(
            product_group("//rules/rust/sccache/toolchain.js").as_deref(),
            Some("rust")
        );
        assert_eq!(
            product_group("//rules/odin/index.js").as_deref(),
            Some("odin")
        );
        assert_eq!(product_group("//rules/asset.js").as_deref(), Some("asset"));
        assert_eq!(product_group("//src/tool.js"), None);
    }

    #[test]
    fn rule_capabilities_are_derived_from_products_goals_and_declared_tools() {
        let mut hs = HostState::default();
        hs.product_modules.insert(
            (
                "cargo-package".to_owned(),
                "build".to_owned(),
                "rust".to_owned(),
            ),
            "//rules/rust/index.js".to_owned(),
        );
        hs.product_modules.insert(
            (
                "cargo-package".to_owned(),
                "lint".to_owned(),
                "clippy".to_owned(),
            ),
            "//rules/rust/clippy/index.js".to_owned(),
        );
        hs.product_modules.insert(
            (
                "python-app".to_owned(),
                "lint".to_owned(),
                "ruff".to_owned(),
            ),
            // Tool identity is declared, not path-derived: a flat module
            // still attributes to ruff.
            "//rules/python/lint.js".to_owned(),
        );
        // Two tools sharing one (kind, product) each get their own row.
        hs.product_modules.insert(
            ("python-app".to_owned(), "fmt".to_owned(), "ruff".to_owned()),
            "//rules/python/fmt.js".to_owned(),
        );
        hs.product_modules.insert(
            (
                "python-app".to_owned(),
                "fmt".to_owned(),
                "black".to_owned(),
            ),
            "//rules/python/black.js".to_owned(),
        );
        hs.product_modules.insert(
            (
                "cargo-package".to_owned(),
                "format-check".to_owned(),
                "rustfmt".to_owned(),
            ),
            "//rules/rust/rustfmt/index.js".to_owned(),
        );

        let capabilities = serde_json::to_value(derive_rule_capabilities(&hs)).unwrap();
        assert_eq!(
            capabilities["rust"]["build"]["rust"]["targetKinds"],
            serde_json::json!(["cargo-package"])
        );
        assert_eq!(
            capabilities["rust"]["lint"]["clippy"]["modules"],
            serde_json::json!(["//rules/rust/clippy/index.js"])
        );
        assert_eq!(
            capabilities["python"]["lint"]["ruff"]["targetKinds"],
            serde_json::json!(["python-app"])
        );
        assert_eq!(
            capabilities["python"]["fmt"]["ruff"]["modules"],
            serde_json::json!(["//rules/python/fmt.js"])
        );
        assert_eq!(
            capabilities["python"]["fmt"]["black"]["modules"],
            serde_json::json!(["//rules/python/black.js"])
        );
        assert!(capabilities["rust"].get("format-check").is_none());
    }

    #[tokio::test]
    async fn product_registration_stack_tracks_the_resolved_source_directory() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/rust/test";
import "//rules/rust/clippy";
"#,
        );
        write_file(&p.join(BUILD_FILE), "");
        write_file(
            &p.join("rules/rust/test.js"),
            r#"
import { product, TEST, targetKind, toolName } from "imp:core";
const K_rust_test = targetKind("rust_test");
product(K_rust_test, TEST, toolName("rust"), async () => ({}));
"#,
        );
        write_file(
            &p.join("rules/rust/clippy/index.js"),
            r#"
import { product, LINT, targetKind, toolName } from "imp:core";
const K_cargo_package = targetKind("cargo-package");
product(K_cargo_package, LINT, toolName("clippy"), async () => ({}));
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let capabilities = {
            let hs = live.host_state.lock().unwrap();
            serde_json::to_value(derive_rule_capabilities(&hs)).unwrap()
        };
        assert_eq!(
            capabilities["rust"]["test"]["rust"]["targetKinds"],
            serde_json::json!(["rust_test"]),
            "{capabilities}"
        );
        assert_eq!(
            capabilities["rust"]["lint"]["clippy"]["targetKinds"],
            serde_json::json!(["cargo-package"])
        );
    }

    #[tokio::test]
    async fn product_registered_via_a_shared_rules_helper_misattributes_to_the_helper() {
        // Module attribution for capability docs is derived by walking the JS
        // call stack back to the first `//rules/` frame (product_registration_module).
        // A rule module that calls product() *indirectly*, through a helper it
        // imports from a different //rules/ subtree, therefore misattributes
        // to the shared helper's own directory rather than the real caller's
        // — this is a general limitation of that stack-walk, not something
        // any one call site can opt out of. It's why
        // rules/workflows/lockfiles.js's registerToolchainLockfile()
        // deliberately does *not* call product() on a toolchain's behalf;
        // every toolchain module calls product() directly itself instead (see
        // the sibling test below). Documented here so a future "simplify
        // this by having the helper call product() too" doesn't silently
        // reintroduce the misattribution.
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/rust/toolchain";
"#,
        );
        write_file(&p.join(BUILD_FILE), "");
        write_file(
            &p.join("rules/shared/helper.js"),
            r#"
import { product } from "imp:core";
export function registerViaHelper(kindClass, name, tool, fn) {
    product(kindClass, name, tool, fn);
}
"#,
        );
        write_file(
            &p.join("rules/rust/toolchain.js"),
            r#"
import { BUILD, targetKind, toolName } from "imp:core";
import { registerViaHelper } from "//rules/shared/helper";
const K_rust_toolchain = targetKind("rust-toolchain");
registerViaHelper(K_rust_toolchain, BUILD, toolName("rust"), async () => ({}));
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let capabilities = {
            let hs = live.host_state.lock().unwrap();
            serde_json::to_value(derive_rule_capabilities(&hs)).unwrap()
        };
        assert!(
            capabilities.get("rust").is_none(),
            "expected the indirect registration to misattribute away from 'rust': {capabilities}"
        );
        assert_eq!(
            capabilities["shared"]["build"]["rust"]["targetKinds"],
            serde_json::json!(["rust-toolchain"]),
            "{capabilities}"
        );
    }

    #[tokio::test]
    async fn product_registered_directly_alongside_a_shared_lockfile_helper_attributes_correctly() {
        // Companion to the test above: a toolchain module that calls
        // product() itself, only delegating the (stack-attribution-
        // irrelevant) registerBuiltinLockfile bookkeeping to a shared helper
        // — the pattern rules/workflows/lockfiles.js's
        // registerToolchainLockfile() actually implements — attributes
        // correctly to the toolchain's own module.
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/rust/toolchain";
"#,
        );
        write_file(&p.join(BUILD_FILE), "");
        write_file(
            &p.join("rules/shared/helper.js"),
            r#"
export function registerBuiltinSpec(spec) {
    return spec;
}
"#,
        );
        write_file(
            &p.join("rules/rust/toolchain.js"),
            r#"
import { product, BUILD, targetKind, toolName } from "imp:core";
import { registerBuiltinSpec } from "//rules/shared/helper";
const K_rust_toolchain = targetKind("rust-toolchain");
const spec = registerBuiltinSpec({ name: "rust" });
product(K_rust_toolchain, BUILD, toolName("rust"), async () => spec);
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let capabilities = {
            let hs = live.host_state.lock().unwrap();
            serde_json::to_value(derive_rule_capabilities(&hs)).unwrap()
        };
        assert_eq!(
            capabilities["rust"]["build"]["rust"]["targetKinds"],
            serde_json::json!(["rust-toolchain"]),
            "{capabilities}"
        );
    }

    #[tokio::test]
    async fn expand_registers_a_lazily_materialized_dynamic_target() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(p.join(WORKSPACE_FILE).as_path(), "");
        write_file(
            p.join(BUILD_FILE).as_path(),
            r#"
import { target, expand, registerTarget, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_expandable = targetKind("expandable");

export const build = product(K_expandable, BUILD, toolName("expandable-tool"), async function build(handle) {
    return run({ argv: ["sh", "-c", "true"], display: "build", impure: true });
});

export const expandChildren = expand(K_expandable, async function expandChildren(handle) {
    registerTarget(target({ kind: "expandable", attrs: {} }), "//:child");
});

export const parent = target({ kind: "expandable", attrs: {} });
"#,
        );

        let workspace = load_workspace(p).await.unwrap();
        assert!(workspace.workspace.expanders.contains_key("expandable"));
        // Not yet materialized anywhere — only known once expansion runs.
        assert!(!workspace.workspace.targets.contains_key("//:child"));

        // Selecting the not-yet-existing child by address triggers the
        // fallback-expand-then-retry path a real CLI invocation goes
        // through (see execute_goal_live).
        run_goal_live(&workspace, p, "build", &["//:child".into()])
            .await
            .unwrap();

        let dynamic_snapshot = workspace.dynamic_targets.lock().unwrap().clone();
        assert!(dynamic_snapshot.contains_key("//:child"));

        let goal_def = workspace.workspace.goals.get("build").unwrap();
        let roots = select_roots(
            &workspace.workspace,
            &dynamic_snapshot,
            goal_def,
            &["//:child".into()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//:child");
        assert_eq!(roots[0].1, "build");
    }

    #[tokio::test]
    async fn new_target_kinds_and_products_need_no_rust_changes() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let goal_def = workspace.workspace.goals.get("build").unwrap();
        let no_dynamic_3: BTreeMap<String, Target> = BTreeMap::new();
        let roots = select_roots(
            &workspace.workspace,
            &no_dynamic_3,
            goal_def,
            &["//assets:ui".into()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//assets:ui");
        assert_eq!(roots[0].1, "build");
        run_goal_live(&workspace, root.path(), "build", &["//assets:ui".into()])
            .await
            .unwrap();
    }

    #[test]
    fn process_output_is_reported_as_the_lane_bars_message() {
        let mut progress = indicatif::ProgressBar::hidden();

        report_process_line(
            &mut progress,
            &ProcessLine {
                stream: ProcessStream::Stdout,
                line: "stdout-line".to_owned(),
            },
        );
        assert_eq!(progress.message(), "out: stdout-line");

        report_process_line(
            &mut progress,
            &ProcessLine {
                stream: ProcessStream::Stderr,
                line: "stderr-line".to_owned(),
            },
        );
        assert_eq!(progress.message(), "err: stderr-line");
    }

    #[test]
    fn process_output_reader_splits_carriage_return_progress() {
        let (sender, receiver) = mpsc::channel();
        let reader = std::io::Cursor::new(b"configure\rbuild\ninstall\r\n");
        let thread = spawn_output_reader(reader, ProcessStream::Stdout, sender);
        thread.join().unwrap();

        let lines = receiver
            .try_iter()
            .map(|line| line.line)
            .collect::<Vec<_>>();

        assert_eq!(lines, ["configure", "build", "install"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn product_run_materializes_named_cache_tools_on_path() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        let tool_dir =
            imp_store::cache::named_cache_key_path(p, "test-tools", "v1/linux-x86_64").unwrap();
        std::fs::create_dir_all(tool_dir.join("bin")).unwrap();
        let tool_bin = tool_dir.join("bin/hello-tool");
        std::fs::write(&tool_bin, "#!/bin/sh\nprintf from-tool > out.txt\n").unwrap();
        let mut perms = std::fs::metadata(&tool_bin).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tool_bin, perms).unwrap();

        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/tool";
"#,
        );
        write_file(
            &p.join("rules/tool.js"),
            r#"
import { namedCache, output, product, run, target, BUILD, targetKind, toolName } from "imp:core";
const K_tool_user = targetKind("tool-user");

namedCache({ name: "test-tools" });

export const file = product(K_tool_user, BUILD, toolName("tool-user-tool"), async function file(handle) {
    return run({
        argv: ["hello-tool"],
        tools: [{
            name: "hello",
            cache: "test-tools",
            key: "v1/linux-x86_64",
            binDirs: ["bin"],
        }],
        outputs: [output("out.txt")],
        materialize: true,
        display: "hello tool",
    });
});

export function toolUser() {
    return target({ kind: "tool-user" });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { toolUser } from "//rules/tool";
export const generated = toolUser();
"#,
        );

        let live = load_workspace(p).await.unwrap();
        run_goal_live(&live, p, "build", &["generated".to_owned()])
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("out.txt")).unwrap(),
            "from-tool"
        );
    }

    #[tokio::test]
    async fn root_relative_imports_can_resolve_build_directory_modules() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        assert!(workspace.targets.contains_key("//library/jodin:jodin"));
    }

    #[tokio::test]
    async fn root_relative_imports_can_resolve_index_js_modules() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/pkg";
"#,
        );
        write_file(
            &p.join("rules/pkg/index.js"),
            r#"
import { target } from "imp:core";
export function pkg() { return target({ kind: "pkg", attrs: {} }); }
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { pkg } from "//rules/pkg";
export const app = pkg();
"#,
        );

        let workspace = load_workspace(p).await.unwrap();
        assert!(workspace.targets.contains_key("//:app"));
    }

    #[tokio::test]
    async fn workspace_file_exports_become_top_level_workspace_targets() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import { target } from "imp:core";
export const odin = target({ kind: "odin-toolchain", attrs: { version: "dev-2026-03" } });
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target } from "imp:core";
export const app = target({ kind: "app", attrs: {} });
"#,
        );

        let workspace = load_workspace(p).await.unwrap();
        let odin = workspace
            .targets
            .get("//:odin")
            .expect("workspace.js export //:odin");
        assert_eq!(odin.kind, "odin-toolchain");
    }

    #[tokio::test]
    async fn relative_imports_from_build_files_are_rejected_with_context() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/asset";
"#,
        );
        write_file(&p.join("rules/asset.js"), ASSET_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { asset } from "./rules/asset";

export const ui = asset({ srcs: ["**/*.png"] });
"#,
        );

        let error = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            error.contains("relative import './rules/asset' is prohibited in BUILD.js"),
            "{error}"
        );
        assert!(error.contains("BUILD.js"), "{error}");
        assert!(error.contains("//..."), "{error}");
    }

    #[tokio::test]
    async fn unknown_builtin_modules_are_reported_distinctly() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "imp:missing";
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const ignored = 1;\n");

        let error = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            error.contains("unknown built-in module 'imp:missing'"),
            "{error}"
        );
        assert!(error.contains(WORKSPACE_FILE), "{error}");
    }

    #[tokio::test]
    async fn missing_workspace_modules_report_importer_and_candidates() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), "");
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { missing } from "//rules/missing";

export const ignored = missing;
"#,
        );

        let error = format!("{:#}", load_workspace(p).await.unwrap_err());
        let normalized = error.replace('\\', "/");
        assert!(
            normalized.contains("cannot resolve workspace module '//rules/missing'"),
            "{error}"
        );
        assert!(normalized.contains("rules/missing.js"), "{error}");
        assert!(normalized.contains("rules/missing/index.js"), "{error}");
        assert!(normalized.contains(BUILD_FILE), "{error}");
    }

    #[tokio::test]
    async fn test_select_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();

        let all = select_targets(&workspace, &[]).unwrap();
        // joltphysics, cmake, jodin, ui = 4
        assert_eq!(all.len(), 4);

        let sel = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].address, "//library/jodin:jodin");

        // A selector with a package path but no leading "//" should resolve
        // the same as its "//"-prefixed form.
        let sel = select_targets(&workspace, &["library/jodin:jodin".to_owned()]).unwrap();
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].address, "//library/jodin:jodin");

        assert!(select_targets(&workspace, &["nonexistent".to_owned()]).is_err());
        assert!(select_targets(&workspace, &["other:jodin".to_owned()]).is_err());
    }

    #[tokio::test]
    async fn test_format_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let targets = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        let mut out = String::new();
        format_targets(&targets, &mut out).unwrap();
        assert!(out.contains("//library/jodin:jodin (odin-package)"));
        assert!(out.contains("sources: **/*.odin"));
        assert!(out.contains("dependencies: //src/cpp/joltphysics:cmake"));
    }

    #[tokio::test]
    async fn test_format_dependencies() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let mut out = String::new();
        format_dependencies(&workspace, &["jodin".to_owned()], &mut out).unwrap();
        let expected = "\
//library/jodin:jodin
└── //src/cpp/joltphysics:cmake
    └── //src/cpp/joltphysics:joltphysics
";
        assert_eq!(out, expected);
    }

    #[tokio::test]
    async fn test_format_products() {
        let root = fixture();
        let workspace = load_workspace(root.path()).await.unwrap();
        let mut out = String::new();
        format_products(&workspace, &mut out).unwrap();
        assert!(out.contains("Target Kinds:"));
        assert!(out.contains("  - odin-package (build product: build)"));
        assert!(out.contains("Products:"));
        assert!(out.contains("  odin-package:"));
        assert!(out.contains("    - build"));
    }

    #[tokio::test]
    async fn javascript_can_use_platform_info() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/test";"#);
        write_file(
            &p.join("rules/test.js"),
            r#"
import { platformInfo } from "imp:core";
const info = platformInfo();
if (typeof info.os !== "string" || info.os.length === 0) {
    throw new Error("platformInfo().os is missing: " + JSON.stringify(info));
}
if (typeof info.arch !== "string" || info.arch.length === 0) {
    throw new Error("platformInfo().arch is missing: " + JSON.stringify(info));
}
export const ok = 1;
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).await.unwrap();
    }

    #[tokio::test]
    async fn javascript_can_use_sha256() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // Write a known file and compute its expected digest locally.
        let test_file = p.join("data.bin");
        std::fs::write(&test_file, b"hello world\n").unwrap();
        let expected_hex = format!("{:x}", Sha256::digest(b"hello world\n"));

        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ sha256 }} from "imp:core";
const digest = sha256("{path}");
if (digest !== "{expected}") {{
    throw new Error("sha256 mismatch: got " + digest + ", expected {expected}");
}}
export const ok = 1;
"#,
                path = test_file.to_string_lossy().replace('\\', "\\\\"),
                expected = expected_hex,
            ),
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).await.unwrap();
    }

    #[tokio::test]
    async fn javascript_can_use_cache_operations() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // Create a source file to cache.
        let src_dir = p.join("source");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("tool.txt"), b"cached-content").unwrap();

        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ namedCache, cachePut, cacheGet, cacheHas }} from "imp:core";
namedCache({{ name: "test-cache" }});

// Put content into the cache.
cachePut("test-cache", "v1/linux-x86_64", "{src}");

// Check it exists.
if (!cacheHas("test-cache", "v1/linux-x86_64")) {{
    throw new Error("cacheHas returned false after put");
}}

// Retrieve the path.
const path = cacheGet("test-cache", "v1/linux-x86_64");
if (path === null || path === undefined) {{
    throw new Error("cacheGet returned null after put");
}}

// Check a missing key.
if (cacheHas("test-cache", "missing-key")) {{
    throw new Error("cacheHas returned true for missing key");
}}

export const ok = 1;
"#,
                src = src_dir.to_string_lossy().replace('\\', "\\\\"),
            ),
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).await.unwrap();
    }

    #[tokio::test]
    async fn javascript_can_use_extract() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        // Create a tar.gz archive using the system tar.
        let content_dir = p.join("archive-content");
        std::fs::create_dir_all(content_dir.join("sub")).unwrap();
        std::fs::write(content_dir.join("sub/file.txt"), b"extracted").unwrap();
        let archive = p.join("test.tar.gz");

        let status = std::process::Command::new("tar")
            .args([
                "czf",
                &archive.to_string_lossy(),
                "-C",
                &content_dir.to_string_lossy(),
                "sub",
            ])
            .status()
            .unwrap();
        assert!(status.success(), "failed to create test archive");

        let extract_dir = p.join("extracted");

        let archive_js = serde_json::to_string(&archive.to_string_lossy().to_string()).unwrap();
        let dest_js = serde_json::to_string(&extract_dir.to_string_lossy().to_string()).unwrap();
        write_file(
            &p.join(WORKSPACE_FILE),
            &format!(
                r#"
import {{ extract }} from "imp:core";
extract({archive}, {dest}, {{ format: "tar.gz", strip_components: 0 }});
export const ok = 1;
"#,
                archive = archive_js,
                dest = dest_js,
            ),
        );
        write_file(&p.join(BUILD_FILE), "export const done = 1;\n");

        load_workspace(p).await.unwrap();
        // Verify the file was extracted correctly.
        let extracted_file = extract_dir.join("sub/file.txt");
        assert!(
            extracted_file.is_file(),
            "extracted file not found at {}",
            extracted_file.display()
        );
        assert_eq!(
            std::fs::read_to_string(&extracted_file).unwrap(),
            "extracted"
        );
    }

    #[tokio::test]
    async fn quickjs_host_run_promises_can_resolve_with_promise_all() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(&p.join(BUILD_FILE), r#"export const done = true;"#);

        let live = load_workspace(p).await.unwrap();
        *live.exec_root.lock().unwrap() = Some(p.to_owned());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            4,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        live.ctx
            .async_with(async |ctx| -> rquickjs::Result<()> {
                let promise = Module::evaluate(
                    ctx.clone(),
                    "host-run-promise-all",
                    r#"
import { run } from "imp:core";

const results = await Promise.all([
    run({ argv: ["sh", "-c", "printf a"], impure: true }),
    run({ argv: ["sh", "-c", "printf b"], impure: true }),
]);

if (!results[0].stdout.endsWith("a\n") || !results[1].stdout.endsWith("b\n")) {
    throw new Error(`unexpected stdout: ${results[0].stdout}/${results[1].stdout}`);
}
"#,
                )?;
                promise.into_future::<()>().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("host-run-promise-all", format!("{e}"))
                })?;
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn quickjs_host_run_cancels_running_sandbox_child() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("canceled-run.marker");

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(&p.join(BUILD_FILE), r#"export const done = true;"#);

        let live = load_workspace(p).await.unwrap();
        *live.exec_root.lock().unwrap() = Some(p.to_owned());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let cancellation = Arc::new(AtomicBool::new(false));
        let scheduler = crate::scheduler::Scheduler::new(1, Arc::clone(&cancellation), tx);
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let cancellation_thread = Arc::clone(&cancellation);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancellation_thread.store(true, Ordering::SeqCst);
        });

        let started = std::time::Instant::now();
        let result = live
            .ctx
            .async_with(async |ctx| -> rquickjs::Result<()> {
                let promise = Module::evaluate(
                    ctx.clone(),
                    "host-run-cancel",
                    format!(
                        r#"
import {{ run }} from "imp:core";

await run({{
    argv: ["sh", "-c", "sleep 5; printf slow > {marker}"],
    display: "cancel probe",
    impure: true,
}});
"#,
                        marker = js_string_path(&marker),
                    ),
                )?;
                promise.into_future::<()>().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("host-run-cancel", format!("{e}"))
                })?;
                Ok(())
            })
            .await;

        let error = format!("{}", result.unwrap_err());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "live run cancellation waited for child to finish"
        );
        assert!(error.contains("canceled"), "{error}");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quickjs_host_run_cancel_does_not_wait_for_inherited_output_pipes() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("escaped-output-pipe.marker");
        let pid_file = p.join("escaped-output-pipe.pid");

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(&p.join(BUILD_FILE), r#"export const done = true;"#);

        let live = load_workspace(p).await.unwrap();
        *live.exec_root.lock().unwrap() = Some(p.to_owned());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let cancellation = Arc::new(AtomicBool::new(false));
        let scheduler = crate::scheduler::Scheduler::new(1, Arc::clone(&cancellation), tx);
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let cancellation_thread = Arc::clone(&cancellation);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancellation_thread.store(true, Ordering::SeqCst);
        });

        let started = std::time::Instant::now();
        let result = live
            .ctx
            .async_with(async |ctx| -> rquickjs::Result<()> {
                let promise = Module::evaluate(
                    ctx.clone(),
                    "host-run-cancel-inherited-pipe",
                    format!(
                        r#"
import {{ run }} from "imp:core";

await run({{
    argv: [
        "sh",
        "-c",
        "(setsid sh -c 'sleep 5; printf escaped > \"$MARKER\"' & echo $! > \"$PID_FILE\"); sleep 10",
    ],
    env: [
        "MARKER={marker}",
        "PID_FILE={pid_file}",
    ],
    display: "cancel inherited pipe probe",
    impure: true,
}});
"#,
                        marker = js_string_path(&marker),
                        pid_file = js_string_path(&pid_file),
                    ),
                )?;
                promise.into_future::<()>().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message(
                        "host-run-cancel-inherited-pipe",
                        format!("{e}"),
                    )
                })?;
                Ok(())
            })
            .await;

        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
            let group = format!("-{}", pid.trim());
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", group.as_str()])
                .status();
        }

        let error = format!("{}", result.unwrap_err());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancellation waited for an escaped process holding output pipes"
        );
        assert!(error.contains("canceled"), "{error}");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists());
    }

    // Two memoized roots that share a memoized dependency whose body awaits a
    // real run(). The shared memo is in-flight (suspended on run()) when the
    // second root reaches it. This must resolve to the same result, not be
    // mistaken for a cycle — the regression that surfaced when live execution
    // replaced introspect mode's synchronous run().
    #[tokio::test]
    async fn concurrent_roots_share_an_in_flight_memo_without_a_false_cycle() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(&p.join(BUILD_FILE), r#"export const done = true;"#);

        let live = load_workspace(p).await.unwrap();
        *live.exec_root.lock().unwrap() = Some(p.to_owned());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            4,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        live.ctx
            .async_with(async |ctx| -> rquickjs::Result<()> {
                let promise = Module::evaluate(
                    ctx.clone(),
                    "shared-inflight-memo",
                    r#"
import { memo, run } from "imp:core";

const shared = memo(async function shared() {
    // sleep keeps the memo suspended so the second root reaches it in-flight
    await run({ argv: ["sh", "-c", "sleep 0.1; printf s"], impure: true });
    return "S";
});
const rootA = memo(async function rootA() { return await shared(); });
const rootB = memo(async function rootB() { return await shared(); });

const [a, b] = await Promise.all([rootA(), rootB()]);
if (a !== "S" || b !== "S") {
    throw new Error(`unexpected: ${a}/${b}`);
}
"#,
                )?;
                promise.into_future::<()>().await.catch(&ctx).map_err(|e| {
                    rquickjs::Error::new_loading_message("shared-inflight-memo", format!("{e}"))
                })?;
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn live_goal_nests_selected_dependencies_under_first_caller() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_root_nesting_test = targetKind("root-nesting-test");

export const lib = target({ kind: "root-nesting-test" });
export const app = target({ kind: "root-nesting-test", attrs: { dep: lib } });

export const build = product(K_root_nesting_test, BUILD, toolName("root-nesting-test-tool"), async function do_build(handle) {
    if (handle.attrs.dep) {
        await build(handle.attrs.dep);
    }
    await run({
        argv: ["sh", "-c", "true"],
        display: `run ${handle.label.address}`,
        impure: true,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            2,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned(), "lib".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut memo_ids = BTreeMap::new();
        let mut memo_parents = BTreeMap::new();
        let mut run_parents = BTreeMap::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::Pending {
                id,
                parent,
                display,
                ..
            } = event
            {
                if display.starts_with("do_build(//:") {
                    memo_ids.insert(display.clone(), id);
                    memo_parents.insert(display, parent);
                } else if display.starts_with("run //:") {
                    run_parents.insert(display, parent);
                }
            }
        }
        assert_eq!(memo_parents.len(), 2);
        assert_eq!(memo_parents["do_build(//:app)"], None);
        assert_eq!(
            memo_parents["do_build(//:lib)"],
            Some(memo_ids["do_build(//:app)"])
        );
        assert_eq!(run_parents.len(), 2);
        assert_eq!(
            run_parents["run //:app"],
            Some(memo_ids["do_build(//:app)"])
        );
        assert_eq!(
            run_parents["run //:lib"],
            Some(memo_ids["do_build(//:lib)"])
        );
    }

    #[tokio::test]
    async fn promise_all_fanout_restores_parent_context_after_await() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, memo, run, BUILD, targetKind, toolName } from "imp:core";
const K_promise_all_context_test = targetKind("promise-all-context-test");

export const app = target({ kind: "promise-all-context-test" });

const child = memo(async function child(name) {
    await run({
        argv: ["sh", "-c", "true"],
        display: `child ${name}`,
        impure: true,
    });
});

export const build = product(K_promise_all_context_test, BUILD, toolName("promise-all-context-test-tool"), async function build() {
    await Promise.all([child("a"), child("b")]);
    await run({
        argv: ["sh", "-c", "true"],
        display: "after fanout",
        impure: true,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            4,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut memo_ids = BTreeMap::new();
        let mut memo_parents = BTreeMap::new();
        let mut run_parents = BTreeMap::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::Pending {
                id,
                parent,
                display,
                ..
            } = event
            {
                if display.starts_with("build(") || display.starts_with("child(") {
                    memo_ids.insert(display.clone(), id);
                    memo_parents.insert(display, parent);
                } else if display == "after fanout" || display == "child a" || display == "child b"
                {
                    run_parents.insert(display, parent);
                }
            }
        }

        let root_id = memo_ids["build(//:app)"];
        assert_eq!(memo_parents["build(//:app)"], None);
        assert_eq!(memo_parents["child(\"a\")"], Some(root_id));
        assert_eq!(memo_parents["child(\"b\")"], Some(root_id));
        assert_eq!(run_parents["child a"], Some(memo_ids["child(\"a\")"]));
        assert_eq!(run_parents["child b"], Some(memo_ids["child(\"b\")"]));
        assert_eq!(run_parents["after fanout"], Some(root_id));
    }

    #[tokio::test]
    async fn sequential_sibling_awaits_do_not_inherit_previous_child_context() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, memo, run, BUILD, targetKind, toolName } from "imp:core";
const K_sequential_sibling_context_test = targetKind("sequential-sibling-context-test");

export const app = target({ kind: "sequential-sibling-context-test" });

const child = memo(async function child(name) {
    await run({
        argv: ["sh", "-c", "true"],
        display: `child ${name}`,
        impure: true,
    });
});

export const build = product(K_sequential_sibling_context_test, BUILD, toolName("sequential-sibling-context-test-tool"), async function build() {
    await child("a");
    await child("b");
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            2,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut memo_ids = BTreeMap::new();
        let mut memo_parents = BTreeMap::new();
        let mut run_parents = BTreeMap::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::Pending {
                id,
                parent,
                display,
                ..
            } = event
            {
                if display.starts_with("build(") || display.starts_with("child(") {
                    memo_ids.insert(display.clone(), id);
                    memo_parents.insert(display, parent);
                } else if display == "child a" || display == "child b" {
                    run_parents.insert(display, parent);
                }
            }
        }

        let root_id = memo_ids["build(//:app)"];
        assert_eq!(memo_parents["child(\"a\")"], Some(root_id));
        assert_eq!(memo_parents["child(\"b\")"], Some(root_id));
        assert_eq!(run_parents["child a"], Some(memo_ids["child(\"a\")"]));
        assert_eq!(run_parents["child b"], Some(memo_ids["child(\"b\")"]));
    }

    #[tokio::test]
    async fn live_goal_failure_propagates_instead_of_hanging() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_fail_test = targetKind("fail-test");

export const app = target({ kind: "fail-test" });

export const build = product(K_fail_test, BUILD, toolName("fail-test-tool"), async function build() {
    return run({ argv: ["sh", "-c", "echo boom >&2; exit 3"], display: "failing action", impure: true });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            execute_goal_live(
                &live,
                p,
                "build",
                &["app".to_owned()],
                false,
                1,
                serde_json::json!({}),
            ),
        )
        .await
        .expect("execute_goal_live must resolve when a root task fails");
        let err = result
            .expect_err("failed task must propagate an error")
            .to_string();
        assert!(
            err.contains("failing action") || err.contains("exit code 3"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn live_goal_shared_failing_memo_propagates_to_all_roots() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, memo, output, BUILD, targetKind, toolName } from "imp:core";
const K_shared_fail_test = targetKind("shared-fail-test");

export const a = target({ kind: "shared-fail-test", attrs: { name: "a" } });
export const b = target({ kind: "shared-fail-test", attrs: { name: "b" } });

const failing = memo(async function failing() {
    return run({
        argv: ["sh", "-c", "echo boom >&2; exit 3"],
        outputs: [output("build/never.txt")],
        materialize: true,
        display: "shared failing action",
    });
});

export const build = product(K_shared_fail_test, BUILD, toolName("shared-fail-test-tool"), async function build(handle) {
    await failing();
    return run({ argv: ["sh", "-c", "true"], display: `after ${handle.attrs.name}`, impure: true });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            execute_goal_live(
                &live,
                p,
                "build",
                &["a".to_owned(), "b".to_owned()],
                false,
                2,
                serde_json::json!({}),
            ),
        )
        .await
        .expect("execute_goal_live must resolve when a shared memo fails");
        let err = result
            .expect_err("failed shared memo must propagate")
            .to_string();
        assert!(
            err.contains("shared failing action") || err.contains("exit code 3"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn live_goal_starts_selected_roots_concurrently() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_concurrent_root_test = targetKind("concurrent-root-test");

export const a = target({ kind: "concurrent-root-test" });
export const b = target({ kind: "concurrent-root-test" });

export const build = product(K_concurrent_root_test, BUILD, toolName("concurrent-root-test-tool"), async function build(handle) {
    await run({
        argv: ["sh", "-c", "sleep 0.2"],
        display: `run ${handle.label.name}`,
        impure: true,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            2,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["a".to_owned(), "b".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut job_ids = BTreeSet::new();
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::Pending { id, display, .. } = &event {
                if display == "run a" || display == "run b" {
                    job_ids.insert(*id);
                }
            }
            events.push(event);
        }

        let mut active = BTreeSet::new();
        let mut max_active = 0;
        for event in events {
            match event {
                crate::scheduler::TaskEvent::Running { id, .. } if job_ids.contains(&id) => {
                    active.insert(id);
                    max_active = max_active.max(active.len());
                }
                crate::scheduler::TaskEvent::Done { id, .. } if job_ids.contains(&id) => {
                    active.remove(&id);
                }
                _ => {}
            }
        }

        assert_eq!(job_ids.len(), 2);
        assert_eq!(
            max_active, 2,
            "selected roots should submit both run jobs before either completes"
        );
    }

    #[tokio::test]
    async fn selected_targets_reflects_cli_selection() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, output, selectedTargets, BUILD, targetKind, toolName } from "imp:core";
const K_selected_targets_test = targetKind("selected-targets-test");

export const a = target({ kind: "selected-targets-test" });
export const b = target({ kind: "selected-targets-test" });

export const build = product(K_selected_targets_test, BUILD, toolName("selected-targets-test-tool"), async function build(handle) {
    const addresses = selectedTargets("selected-targets-test").map((t) => t.address).sort().join(",");
    await run({
        argv: ["sh", "-c", "printf %s \"$1\" > \"$2\"", "write", addresses, `selection-${handle.label.name}.txt`],
        outputs: [output(`selection-${handle.label.name}.txt`)],
        materialize: true,
        display: `selection for ${handle.label.name}`,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler.clone());

        // Explicit selector: only the selected target sees itself.
        execute_goal_live(
            &live,
            p,
            "build",
            &["a".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("selection-a.txt")).unwrap(),
            "//:a"
        );

        // Wildcard selector: every target with a product for this goal is selected.
        reset_js_memo_state(&live).await;
        *live.scheduler.lock().unwrap() = Some(scheduler);
        execute_goal_live(
            &live,
            p,
            "build",
            &["//...".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("selection-a.txt")).unwrap(),
            "//:a,//:b"
        );
        assert_eq!(
            std::fs::read_to_string(p.join("selection-b.txt")).unwrap(),
            "//:a,//:b"
        );
    }

    #[tokio::test]
    async fn selected_targets_errors_outside_goal_execution() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, selectedTargets, productName, targetKind, toolName } from "imp:core";
const K_selected_targets_outside_test = targetKind("selected-targets-outside-test");
const P_check = productName("check");

export const a = target({ kind: "selected-targets-outside-test" });

export const check = product(K_selected_targets_outside_test, P_check, toolName("selected-targets-outside-test-tool"), async function check(handle) {
    return selectedTargets();
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let err = evaluate_product_json(&live, "//:a", "check")
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("selectedTargets() may only be called during goal execution"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn selected_targets_cleared_after_goal_execution_completes() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, BUILD, targetKind, toolName } from "imp:core";
const K_selected_targets_reset_test = targetKind("selected-targets-reset-test");

export const a = target({ kind: "selected-targets-reset-test" });

export const build = product(K_selected_targets_reset_test, BUILD, toolName("selected-targets-reset-test-tool"), async function build(handle) {
    return {};
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        assert!(live.selected_roots.lock().unwrap().is_none());
        execute_goal_live(
            &live,
            p,
            "build",
            &["a".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert!(
            live.selected_roots.lock().unwrap().is_none(),
            "selected_roots must be reset once goal execution completes"
        );
    }

    #[tokio::test]
    async fn goal_callback_rejection_blocks_all_per_target_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, output, goal, targetKind, toolName } from "imp:core";
const K_callback_test = targetKind("callback-test");

const P_custom_goal = goal("custom-goal", (selection) => {
    if (selection.length > 1) {
        throw new Error(`too many: ${selection.map((t) => t.address).join(",")}`);
    }
});

export const a = target({ kind: "callback-test" });
export const b = target({ kind: "callback-test" });

export const build = product(K_callback_test, P_custom_goal, toolName("callback-test-tool"), async function build(handle) {
    await run({
        argv: ["sh", "-c", "printf %s \"$1\" > \"$2\"", "write", "ran", `ran-${handle.label.name}.txt`],
        outputs: [output(`ran-${handle.label.name}.txt`)],
        materialize: true,
        display: `ran ${handle.label.name}`,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let err = execute_goal_live(
            &live,
            p,
            "custom-goal",
            &["a".to_owned(), "b".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("too many"),
            "unexpected error: {err}"
        );
        assert!(
            !p.join("ran-a.txt").exists(),
            "callback rejection must block per-target dispatch entirely"
        );
        assert!(!p.join("ran-b.txt").exists());
    }

    #[tokio::test]
    async fn goal_callback_success_skips_native_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, output, goal, targetKind, toolName } from "imp:core";
const K_callback_test = targetKind("callback-test");

const P_custom_goal = goal("custom-goal", (selection) => {
    if (selection.length > 1) {
        throw new Error(`too many: ${selection.map((t) => t.address).join(",")}`);
    }
});

export const a = target({ kind: "callback-test" });

export const build = product(K_callback_test, P_custom_goal, toolName("callback-test-tool"), async function build(handle) {
    await run({
        argv: ["sh", "-c", "printf %s \"$1\" > \"$2\"", "write", "ran", `ran-${handle.label.name}.txt`],
        outputs: [output(`ran-${handle.label.name}.txt`)],
        materialize: true,
        display: `ran ${handle.label.name}`,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        execute_goal_live(
            &live,
            p,
            "custom-goal",
            &["a".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert!(
            !p.join("ran-a.txt").exists(),
            "a successful callback must fully own the goal; native per-target dispatch must not also run"
        );
    }

    #[tokio::test]
    async fn goal_with_no_callback_dispatches_normally() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, output, goal, targetKind, toolName } from "imp:core";
const K_plain_goal_test = targetKind("plain-goal-test");

const P_plain_goal = goal("plain-goal");

export const a = target({ kind: "plain-goal-test" });

export const build = product(K_plain_goal_test, P_plain_goal, toolName("plain-goal-test-tool"), async function build(handle) {
    await run({
        argv: ["sh", "-c", "printf %s \"$1\" > \"$2\"", "write", "ran", `ran-${handle.label.name}.txt`],
        outputs: [output(`ran-${handle.label.name}.txt`)],
        materialize: true,
        display: `ran ${handle.label.name}`,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        execute_goal_live(
            &live,
            p,
            "plain-goal",
            &["a".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(p.join("ran-a.txt")).unwrap(), "ran");
    }

    #[tokio::test]
    async fn live_goal_js_lane_events_use_configured_worker_slots() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, BUILD, targetKind, toolName } from "imp:core";
const K_js_lane_slot_test = targetKind("js-lane-slot-test");

export const a = target({ kind: "js-lane-slot-test" });
export const b = target({ kind: "js-lane-slot-test" });

export const build = product(K_js_lane_slot_test, BUILD, toolName("js-lane-slot-test-tool"), async function build(handle) {
    await Promise.resolve();
    return handle.label.name;
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["a".to_owned(), "b".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            2,
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

    #[tokio::test]
    async fn live_goal_js_lane_events_do_not_exceed_worker_count() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, memo, run, BUILD, targetKind, toolName } from "imp:core";
const K_js_lane_bound_test = targetKind("js-lane-bound-test");

export const app = target({ kind: "js-lane-bound-test" });

const child = memo(async function child(name) {
    await run({
        argv: ["sh", "-c", "true"],
        display: `run ${name}`,
        impure: true,
    });
});

export const build = product(K_js_lane_bound_test, BUILD, toolName("js-lane-bound-test-tool"), async function build() {
    await Promise.all([child("a"), child("b"), child("c")]);
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            3,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut active = BTreeSet::new();
        let mut saw_js_lane = false;
        let mut saw_memo_running = false;
        for event in std::iter::from_fn(|| rx.try_recv().ok()) {
            match event {
                crate::scheduler::TaskEvent::Running { detail: None, .. } => {
                    saw_memo_running = true;
                }
                crate::scheduler::TaskEvent::LaneStarted {
                    kind: crate::scheduler::LaneKind::Js,
                    slot,
                    id,
                    ..
                } => {
                    saw_js_lane = true;
                    assert_eq!(slot, 0);
                    active.insert((slot, id));
                    assert!(
                        active.len() <= 1,
                        "active JS lanes exceeded configured worker count"
                    );
                }
                crate::scheduler::TaskEvent::LaneCleared {
                    kind: crate::scheduler::LaneKind::Js,
                    slot,
                    id,
                } => {
                    active.remove(&(slot, id));
                }
                _ => {}
            }
        }

        assert!(saw_js_lane, "expected JS lane events");
        assert!(saw_memo_running, "expected memo lifecycle events");
    }

    #[tokio::test]
    async fn live_goal_single_js_worker_reuses_in_flight_memo_on_inherited_stack() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, memo, BUILD, targetKind, toolName } from "imp:core";
const K_single_js_worker_inflight_test = targetKind("single-js-worker-inflight-test");

export const app = target({ kind: "single-js-worker-inflight-test" });

const outer = memo(async function outer() {
    await inner();
    return "outer";
});

const inner = memo(async function inner() {
    // Touch the already in-flight outer() promise through an inherited stack.
    // This is a memo hit, not a cycle, as long as it is not awaited here.
    outer();
    return "inner";
});

export const build = product(K_single_js_worker_inflight_test, BUILD, toolName("single-js-worker-inflight-test-tool"), async function build() {
    return await outer();
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn concurrent_roots_keep_run_ownership_after_interleaved_awaits() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_interleaved_root_context_test = targetKind("interleaved-root-context-test");

export const a = target({ kind: "interleaved-root-context-test" });
export const b = target({ kind: "interleaved-root-context-test" });

export const build = product(K_interleaved_root_context_test, BUILD, toolName("interleaved-root-context-test-tool"), async function build(handle) {
    const name = handle.label.name;
    await run({
        argv: ["sh", "-c", name === "a" ? "sleep 0.05" : "sleep 0.01"],
        display: `pre ${name}`,
        impure: true,
    });
    await run({
        argv: ["sh", "-c", "true"],
        display: `post ${name}`,
        impure: true,
    });
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            2,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["a".to_owned(), "b".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut memo_ids = BTreeMap::new();
        let mut run_parents = BTreeMap::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::Pending {
                id,
                parent,
                display,
                ..
            } = event
            {
                if display.starts_with("build(") {
                    memo_ids.insert(display, id);
                } else if display == "pre a"
                    || display == "pre b"
                    || display == "post a"
                    || display == "post b"
                {
                    run_parents.insert(display, parent);
                }
            }
        }

        let a_id = memo_ids["build(//:a)"];
        let b_id = memo_ids["build(//:b)"];
        assert_eq!(run_parents["pre a"], Some(a_id));
        assert_eq!(run_parents["post a"], Some(a_id));
        assert_eq!(run_parents["pre b"], Some(b_id));
        assert_eq!(run_parents["post b"], Some(b_id));
    }

    #[tokio::test]
    async fn deferred_run_promises_have_correct_parent_after_interleaved_await() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, run, BUILD, targetKind, toolName } from "imp:core";
const K_deferred_run_context_test = targetKind("deferred-run-context-test");

export const app = target({ kind: "deferred-run-context-test" });

export const build = product(K_deferred_run_context_test, BUILD, toolName("deferred-run-context-test-tool"), async function build() {
    const p1 = run({
        argv: ["sh", "-c", "sleep 0.02"],
        display: "deferred short",
        impure: true,
    });
    const p2 = run({
        argv: ["sh", "-c", "sleep 0.05"],
        display: "deferred long",
        impure: true,
    });
    await run({
        argv: ["sh", "-c", "true"],
        display: "interstitial",
        impure: true,
    });
    await Promise.all([p1, p2]);
});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            2,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let mut memo_ids = BTreeMap::new();
        let mut run_parents = BTreeMap::new();
        while let Ok(event) = rx.try_recv() {
            if let crate::scheduler::TaskEvent::Pending {
                id,
                parent,
                display,
                ..
            } = event
            {
                if display.starts_with("build(") {
                    memo_ids.insert(display, id);
                } else if display == "deferred short"
                    || display == "deferred long"
                    || display == "interstitial"
                {
                    run_parents.insert(display, parent);
                }
            }
        }

        let root_id = memo_ids["build(//:app)"];
        assert_eq!(run_parents["deferred short"], Some(root_id));
        assert_eq!(run_parents["deferred long"], Some(root_id));
        assert_eq!(run_parents["interstitial"], Some(root_id));
    }

    #[tokio::test]
    async fn live_goal_no_cache_bypasses_run_task_cache() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let command = format!(
            "printf r >> '{}' && printf live-stdout && printf live-stderr >&2 && mkdir -p build && printf payload > build/live.txt",
            marker.display()
        );
        let command_js = command.replace('\\', "\\\\").replace('"', "\\\"");

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            &format!(
                r#"
import {{ target, product, run, output, BUILD, targetKind, toolName }} from "imp:core";
const K_live_cache_test = targetKind("live-cache-test");

export const app = target({{ kind: "live-cache-test" }});

export const build = product(K_live_cache_test, BUILD, toolName("live-cache-test-tool"), async function build() {{
    const result = await run({{
        argv: ["sh", "-c", "{command_js}"],
        outputs: [output("build/live.txt")],
        materialize: true,
        display: "live cache action",
    }});
    if (result.stdout !== "live-stdout\n") {{
        throw new Error(`unexpected stdout: ${{result.stdout}}`);
    }}
    if (result.stderr !== "live-stderr\n") {{
        throw new Error(`unexpected stderr: ${{result.stderr}}`);
    }}
    return result;
}});
"#
            ),
        );

        let live = load_workspace(p).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = crate::scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = vec!["app".to_owned()];
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            true,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.join("build/live.txt")).unwrap(),
            "payload"
        );
        std::fs::remove_file(p.join("build/live.txt")).unwrap();

        reset_js_memo_state(&live).await;
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "rr");
        std::fs::remove_file(p.join("build/live.txt")).unwrap();

        reset_js_memo_state(&live).await;
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "rr");
        assert_eq!(
            std::fs::read_to_string(p.join("build/live.txt")).unwrap(),
            "payload"
        );
        std::fs::remove_file(p.join("build/live.txt")).unwrap();

        reset_js_memo_state(&live).await;
        execute_goal_live(
            &live,
            p,
            "build",
            &selectors,
            true,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "rrr");
        assert_eq!(
            std::fs::read_to_string(p.join("build/live.txt")).unwrap(),
            "payload"
        );
    }

    #[tokio::test]
    async fn live_config_digest_change_invalidates_run_cache() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let marker = p.join("runs.txt");
        let command = format!(
            "printf r >> '{}' && mkdir -p build && printf payload > build/cfg.txt",
            marker.display()
        );
        let command_js = command.replace('\\', "\\\\").replace('"', "\\\"");

        write_file(
            &p.join(BUILD_FILE),
            &format!(
                r#"
import {{ target, product, run, output, BUILD, targetKind, toolName }} from "imp:core";
const K_config_cache_test = targetKind("config-cache-test");

export const app = target({{ kind: "config-cache-test" }});

export const build = product(K_config_cache_test, BUILD, toolName("config-cache-test-tool"), async function build() {{
    return run({{
        argv: ["sh", "-c", "{command_js}"],
        outputs: [output("build/cfg.txt")],
        materialize: true,
        display: "config cache action",
    }});
}});
"#
            ),
        );

        let selectors = vec!["app".to_owned()];
        let mut runs = Vec::new();
        // Same config twice (second must hit), then a changed config value
        // (must invalidate even though argv/inputs are unchanged).
        for mode in [1, 1, 2] {
            write_file(
                &p.join(WORKSPACE_FILE),
                &format!(
                    r#"
import {{ configure }} from "imp:core";
configure("cache_test", {{ mode: {mode} }});
"#
                ),
            );
            let live = load_workspace(p).await.unwrap();
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            let scheduler = crate::scheduler::Scheduler::new(
                1,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                tx,
            );
            *live.scheduler.lock().unwrap() = Some(scheduler);
            execute_goal_live(
                &live,
                p,
                "build",
                &selectors,
                false,
                1,
                serde_json::json!({}),
            )
            .await
            .unwrap();
            runs.push(std::fs::read_to_string(&marker).unwrap());
        }
        assert_eq!(runs, ["r", "r", "rr"]);
    }

    #[tokio::test]
    async fn product_registration_creates_dispatchable_product_task() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, productName, targetKind, toolName } from "imp:core";
const K_test_pkg = targetKind("test-pkg");
const P_report = productName("report");

export const pkg = target({ kind: "test-pkg", fields: { name: "hello" } });

export const report = product(K_test_pkg, P_report, toolName("test-pkg-tool"), async function report(handle) {
    return "ok";
});
"#,
        );

        let live = load_workspace(p).await.unwrap();

        // The product is listed in the workspace.
        assert!(
            live.products
                .contains_key(&("test-pkg".to_owned(), "report".to_owned())),
            "product should be registered in workspace"
        );

        // An explicit #product selector resolves to that product, and the goal
        // dispatches to it live.
        let goal_def = live.workspace.goals.get("build").unwrap();
        let no_dynamic_4: BTreeMap<String, Target> = BTreeMap::new();
        let roots = select_roots(
            &live.workspace,
            &no_dynamic_4,
            goal_def,
            &["//:pkg#report".to_owned()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//:pkg");
        assert_eq!(roots[0].1, "report");
        run_goal_live(&live, p, "build", &["//:pkg#report".to_owned()])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn product_selector_hash_syntax_is_parsed() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();

        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, productName, targetKind, toolName } from "imp:core";
const K_kind_a = targetKind("kind-a");
const P_check = productName("check");

export const pkg = target({ kind: "kind-a", fields: {} });

export const check = product(K_kind_a, P_check, toolName("kind-a-tool"), async function check(handle) {});
"#,
        );

        let live = load_workspace(p).await.unwrap();

        // //:pkg#check should select the "check" product explicitly.
        let goal_def = live.workspace.goals.get("build").unwrap();
        let no_dynamic_5: BTreeMap<String, Target> = BTreeMap::new();
        let roots = select_roots(
            &live.workspace,
            &no_dynamic_5,
            goal_def,
            &["//:pkg#check".to_owned()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].1, "check");

        // An unknown product in the selector should fail.
        let err = select_roots(
            &live.workspace,
            &BTreeMap::new(),
            goal_def,
            &["//:pkg#nonexistent".to_owned()],
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("'nonexistent' is not a declared product name"),
            "expected product-not-found error, got: {err}"
        );
    }

    #[tokio::test]
    async fn selection_requires_selectors_and_wildcards_filter_by_product() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, goal, targetKind, BUILD, toolName } from "imp:core";
const KindA = targetKind("wild-kind-a");
const KindB = targetKind("wild-kind-b");

export const a = target({ kind: "wild-kind-a", fields: {} });
export const b = target({ kind: "wild-kind-b", fields: {} });
export const build_a = product(KindA, BUILD, toolName("kinda-tool"), async function build_a(handle) {});

goal("nosel", async function noselGoal(selection) {}, { selection: "none" });
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let no_dynamic: BTreeMap<String, Target> = BTreeMap::new();
        let build_goal = live.workspace.goals.get("build").unwrap();

        // No selector and no //:default target is an error.
        let err = select_roots(&live.workspace, &no_dynamic, build_goal, &[])
            .unwrap_err()
            .to_string();
        assert!(err.contains("requires a target selector"), "{err}");
        assert!(err.contains("//..."), "{err}");

        // A wildcard selects every target with the goal's product and
        // silently skips the rest.
        let roots = select_roots(
            &live.workspace,
            &no_dynamic,
            build_goal,
            &["//...".to_owned()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//:a");

        // A wildcard that matches targets but no products is an error.
        let nosel_goal = live.workspace.goals.get("nosel").unwrap();
        let err = select_roots(
            &live.workspace,
            &no_dynamic,
            nosel_goal,
            &["//...".to_owned()],
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("matches no target with a 'nosel' product"),
            "{err}"
        );

        // A `selection: "none"` goal runs selector-less with an empty selection.
        assert!(nosel_goal.selectorless);
        let roots = select_roots(&live.workspace, &no_dynamic, nosel_goal, &[]).unwrap();
        assert!(roots.is_empty());
    }

    #[tokio::test]
    async fn product_name_tokens_declare_register_and_select() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join("tokens.js"),
            r#"
import { productName } from "imp:core";
export const CHECK = productName("check");
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, targetKind, toolName } from "imp:core";
import { CHECK } from "//tokens";

const KindA = targetKind("kind-a");

export const pkg = target({ kind: "kind-a", fields: {} });
export const check = product(KindA, CHECK, toolName("kinda-tool"), async function check(handle) {});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let decl = live
            .workspace
            .declared_product_names
            .get("check")
            .expect("'check' must be declared");
        assert!(!decl.builtin);
        assert_eq!(decl.module.as_deref(), Some("//tokens"));

        // Token-registered products stay selectable by CLI string.
        let goal_def = live.workspace.goals.get("build").unwrap();
        let no_dynamic: BTreeMap<String, Target> = BTreeMap::new();
        let roots = select_roots(
            &live.workspace,
            &no_dynamic,
            goal_def,
            &["//:pkg#check".to_owned()],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].1, "check");
    }

    #[tokio::test]
    async fn duplicate_product_name_declaration_across_modules_errors() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join("tokens.js"),
            r#"
import { productName } from "imp:core";
export const CHECK = productName("check");
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { productName } from "imp:core";
import { CHECK } from "//tokens";
export const CHECK2 = productName("check");
"#,
        );

        let err = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            err.contains("already declared in //tokens"),
            "expected duplicate-declaration error, got: {err}"
        );
    }

    #[tokio::test]
    async fn builtin_product_names_are_redeclaration_protected() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { productName } from "imp:core";
export const B = productName("build");
"#,
        );

        let err = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            err.contains("already declared in imp:core (builtin)"),
            "expected builtin-redeclaration error, got: {err}"
        );
    }

    #[tokio::test]
    async fn forged_product_name_token_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { product, targetKind, toolName } from "imp:core";
const KindA = targetKind("kind-a");
const forged = { __imp_product_name: true, name: "forged", __pid: 12345 };
export const x = product(KindA, forged, toolName("kinda-tool"), async function x(handle) {});
"#,
        );

        let err = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            err.contains("not backed by a declaration"),
            "expected forged-token rejection, got: {err}"
        );
    }

    #[tokio::test]
    async fn goal_returns_token_usable_for_registration() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { target, product, goal, targetKind, toolName } from "imp:core";

const CUSTOM = goal("custom-goal");
const AGAIN = goal("custom-goal");
if (CUSTOM !== AGAIN) throw new Error("goal() must return the same token for repeat registrations");

const KindA = targetKind("kind-a");
export const pkg = target({ kind: "kind-a", fields: {} });
export const custom = product(KindA, CUSTOM, toolName("kinda-tool"), async function custom(handle) {});
"#,
        );

        let live = load_workspace(p).await.unwrap();
        assert!(live.workspace.goals.contains_key("custom-goal"));
        assert!(live
            .workspace
            .declared_product_names
            .contains_key("custom-goal"));
        assert!(live
            .workspace
            .products
            .contains_key(&("kind-a".to_owned(), "custom-goal".to_owned())));
    }

    #[tokio::test]
    async fn duplicate_kind_classes_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { product, targetKind, BUILD, TEST, toolName } from "imp:core";
const KindA = targetKind("kind-a");
const KindAAgain = targetKind("kind-a");
export const a = product(KindA, BUILD, toolName("kinda-tool"), async function a(handle) {});
export const b = product(KindAAgain, TEST, toolName("kindaagain-tool"), async function b(handle) {});
"#,
        );

        let err = format!("{:#}", load_workspace(p).await.unwrap_err());
        assert!(
            err.contains("declared by two classes"),
            "expected duplicate-kind error, got: {err}"
        );
    }

    #[tokio::test]
    async fn source_fields_mark_owned_files_relative_to_declaring_package() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join("library/pkg/BUILD.js"),
            r#"
import { sourcesField, target } from "imp:core";

export const pkg = target({
    kind: "owned-source-test",
    attrs: {},
    sources: sourcesField({
        root: "src",
        include: ["*.odin"],
        exclude: ["ignored.odin"],
    }),
});
"#,
        );
        write_file(&p.join("library/pkg/src/main.odin"), "package pkg\n");
        write_file(&p.join("library/pkg/src/ignored.odin"), "package pkg\n");
        write_file(&p.join("library/pkg/other.odin"), "package pkg\n");

        let live = load_workspace(p).await.unwrap();
        assert!(live
            .workspace
            .owned_files
            .contains("library/pkg/src/main.odin"));
        assert!(!live
            .workspace
            .owned_files
            .contains("library/pkg/src/ignored.odin"));
        assert!(!live
            .workspace
            .owned_files
            .contains("library/pkg/other.odin"));
    }

    #[tokio::test]
    async fn workspace_load_records_import_graph_for_changed_detection() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "imp:core";"#);
        write_file(
            &p.join("tools/base.js"),
            "export const baseKind = \"graph-test\";\n",
        );
        write_file(
            &p.join("tools/macros.js"),
            r#"
import { target, sourcesField } from "imp:core";
import { baseKind } from "//tools/base";

export function mkTarget() {
    return target({
        kind: baseKind,
        attrs: {},
        sources: sourcesField({ root: ".", include: ["*.odin"], exclude: [] }),
    });
}
"#,
        );
        write_file(
            &p.join("a/BUILD.js"),
            r#"
import { mkTarget } from "//tools/macros";
export const a = mkTarget();
"#,
        );

        let live = load_workspace(p).await.unwrap();
        let graph = live.import_graph.lock().unwrap().clone();

        // Seeded BUILD.js root plus resolver-recorded rule modules.
        assert!(graph.module_files["a/BUILD.js"].contains("//a"));
        assert_eq!(graph.build_module_scopes["//a"], "//a");
        assert!(graph.module_files["tools/macros.js"].contains("//tools/macros"));
        assert!(graph.module_files["tools/base.js"].contains("//tools/base"));
        assert!(graph.importers["//tools/macros"].contains("//a"));
        assert!(graph.importers["//tools/base"].contains("//tools/macros"));

        // A change to the transitively imported module owns //a:a.
        let changed = vec!["tools/base.js".to_owned()];
        let (owners, unowned) =
            crate::changed::owning_targets(&live.workspace, &graph, &changed).unwrap();
        assert_eq!(owners, BTreeSet::from(["//a:a".to_owned()]));
        assert!(unowned.is_empty());
    }

    #[tokio::test]
    async fn generate_build_product_creates_raw_build_files() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/odin";"#);
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");
        write_file(&p.join("library/spall/spall.odin"), "package spall\n");
        write_file(&p.join("vendor/ignored/main.odin"), "package ignored\n");

        let live = load_workspace(p).await.unwrap();
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(
            report.changed_files,
            vec![
                "app/BUILD.js".to_owned(),
                "library/spall/BUILD.js".to_owned()
            ]
        );

        let app_build = std::fs::read_to_string(p.join("app/BUILD.js")).unwrap();
        assert!(app_build.contains(r#"import { odinPackage } from "//rules/odin";"#));
        assert!(app_build.contains("export const app = odinPackage({"));
        assert!(app_build.contains(r#"srcs: ["*.odin"]"#));
        assert!(!app_build.contains("imp generated"));
        assert!(!p.join("vendor/ignored/BUILD.js").exists());

        let live = load_workspace(p).await.unwrap();
        let check_report = generate_build_files(&live, p, &[], true).await.unwrap();
        assert!(check_report.changed_files.is_empty());
    }

    #[tokio::test]
    async fn generate_build_runs_all_registered_generate_build_products_by_default() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/odin";
import "//rules/custom";
"#,
        );
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join("rules/custom.js"),
            r#"
import { product, targetKind, toolName } from "imp:core";
import { P_generate_build } from "//rules/odin";
const K_custom_generator = targetKind("custom-generator");

export const generateBuild = product(K_custom_generator, P_generate_build, toolName("custom-generator-tool"), async function generateBuild() {
    return {
        "custom/BUILD.js": [{
                name: "custom",
                rule: "odinPackage",
                props: { srcs: ["*.odin"] },
            }],
    };
});
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");

        let live = load_workspace(p).await.unwrap();
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(
            report.changed_files,
            vec!["app/BUILD.js".to_owned(), "custom/BUILD.js".to_owned()]
        );
        assert!(p.join("app/BUILD.js").exists());
        assert!(p.join("custom/BUILD.js").exists());
    }

    #[tokio::test]
    async fn generate_build_check_fails_when_files_are_stale() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/odin";"#);
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");

        let live = load_workspace(p).await.unwrap();
        let error = generate_build_files(&live, p, &[], true)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("generated BUILD files are out of date"));
        assert!(error.contains("app/BUILD.js"));
    }

    #[tokio::test]
    async fn generate_build_skips_files_owned_by_existing_targets() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/odin";"#);
        write_file(&p.join("rules/odin.js"), GENERATE_BUILD_RULES_JS);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(&p.join("app/main.odin"), "package app\n");
        write_file(&p.join("library/spall/spall.odin"), "package spall\n");
        write_file(
            &p.join("library/spall/BUILD.js"),
            r#"
import { odinPackage } from "//rules/odin";

export const spall = odinPackage({ srcs: ["*.odin"] });
"#,
        );

        let live = load_workspace(p).await.unwrap();
        assert!(live
            .workspace
            .owned_files
            .contains("library/spall/spall.odin"));
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(report.changed_files, vec!["app/BUILD.js".to_owned()]);
        let spall_build = std::fs::read_to_string(p.join("library/spall/BUILD.js")).unwrap();
        assert_eq!(spall_build.matches("export const spall").count(), 1);
    }

    #[tokio::test]
    async fn generate_build_creates_cmake_and_raw_cc_targets() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/c";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(
            &p.join("cmake_app/CMakeLists.txt"),
            r#"
cmake_minimum_required(VERSION 3.20)
project(cmake_app C)
add_executable(cmake_app main.c)
"#,
        );
        write_file(
            &p.join("cmake_app/main.c"),
            "int main(void) { return 0; }\n",
        );
        write_file(&p.join("raw_app/main.c"), "int main(void) { return 0; }\n");
        write_file(
            &p.join("raw_lib/lib.c"),
            "int answer(void) { return 42; }\n",
        );

        let live = load_workspace(p).await.unwrap();
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(
            report.changed_files,
            vec![
                "cmake_app/BUILD.js".to_owned(),
                "raw_app/BUILD.js".to_owned(),
                "raw_lib/BUILD.js".to_owned(),
            ]
        );

        let cmake_build = std::fs::read_to_string(p.join("cmake_app/BUILD.js")).unwrap();
        assert!(cmake_build.contains(r#"import { cmakeLib } from "//rules/c/cmake";"#));
        assert!(cmake_build.contains("export const cmake_app_cmake = cmakeLib({});"));

        let app_build = std::fs::read_to_string(p.join("raw_app/BUILD.js")).unwrap();
        assert!(app_build.contains(r#"import { ccBinary } from "//rules/c";"#));
        assert!(app_build.contains("export const raw_app = ccBinary({});"));

        let lib_build = std::fs::read_to_string(p.join("raw_lib/BUILD.js")).unwrap();
        assert!(lib_build.contains(r#"import { ccLibrary } from "//rules/c";"#));
        assert!(lib_build.contains("export const raw_lib = ccLibrary({});"));
    }

    #[tokio::test]
    async fn generate_build_skips_existing_cmake_owned_cc_files() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(WORKSPACE_FILE), r#"import "//rules/c/cmake";"#);
        write_file(
            &p.join(BUILD_FILE),
            r#"
export const done = true;
"#,
        );
        write_file(
            &p.join("cmake_app/BUILD.js"),
            r#"
import { cmakeLib } from "//rules/c/cmake";

export const cmake_app = cmakeLib({});
"#,
        );
        write_file(
            &p.join("cmake_app/CMakeLists.txt"),
            r#"
cmake_minimum_required(VERSION 3.20)
project(cmake_app C)
add_executable(cmake_app main.c)
"#,
        );
        write_file(
            &p.join("cmake_app/main.c"),
            "int main(void) { return 0; }\n",
        );
        write_file(&p.join("raw_app/main.c"), "int main(void) { return 0; }\n");

        let live = load_workspace(p).await.unwrap();
        assert!(live.workspace.owned_files.contains("cmake_app/main.c"));
        let report = generate_build_files(&live, p, &[], false).await.unwrap();
        assert_eq!(report.changed_files, vec!["raw_app/BUILD.js".to_owned()]);
    }

    #[tokio::test]
    async fn raw_build_renderer_renders_target_refs_as_imports() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        let mut build_rules = BTreeMap::new();
        build_rules.insert(
            "odinPackage".to_owned(),
            BuildRuleRender {
                import_from: "//rules/odin".to_owned(),
                import_name: "odinPackage".to_owned(),
            },
        );
        let mut edits = BTreeMap::new();
        edits.insert(
            "app/BUILD.js".to_owned(),
            vec![GeneratedBuildTarget {
                name: "app".to_owned(),
                rule: "odinPackage".to_owned(),
                props: serde_json::json!({
                    "srcs": ["*.odin"],
                    "deps": [{ "__imp_target_ref": true, "address": "//library/spall:spall" }]
                }),
            }],
        );

        apply_build_edits(p, &build_rules, edits, false).unwrap();
        let content = std::fs::read_to_string(p.join("app/BUILD.js")).unwrap();
        assert!(content.contains(r#"import { spall } from "//library/spall";"#));
        assert!(content.contains("deps: [spall]"));
        assert!(!content.contains("imp generated"));
    }
}
