//! Workspace graph loading, selection, and goal execution.
//!

use crate::graph::{GraphCatalog, GraphFormat, GraphRoot, GraphView, GraphWalk, GraphWalkNode};
#[cfg(test)]
use crate::loader::validate_workspace_module_path;
use crate::loader::{resolve_workspace_module, RulesSource};
use crate::runtime::LiveWorkspace;
use crate::selector::{filter_changed_addresses_in, select_targets_in, SelectorContext};
use anyhow::{bail, Context, Result};
use imp_daemon::client::RemoteExecutionService;
use imp_exec_api::{ExecutionService, SandboxRetention};
use imp_execution::service::LocalExecutionService;
#[cfg(test)]
use imp_store::cache::CachedArtifact;
use imp_store::cache::{artifact_relative_path, digest_bytes, digest_json};
#[cfg(test)]
use imp_store::digest::{nest_directory, nest_file, DirectoryDigest};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex, OnceLock,
};

pub const WORKSPACE_FILE: &str = "imp.workspace.luau";
pub const WORKSPACE_LUAU_FILE: &str = WORKSPACE_FILE;
pub const CI_WORKSPACE_FILE: &str = "imp.workspace.ci.luau";
pub const CI_WORKSPACE_LUAU_FILE: &str = CI_WORKSPACE_FILE;
pub const BUILD_FILE: &str = "BUILD.luau";
fn daemon_execution_requested(env_value: Option<&str>) -> bool {
    env_value == Some("1")
}

fn make_execution_service() -> Result<Arc<dyn ExecutionService>> {
    if daemon_execution_requested(std::env::var("IMP_DAEMON").ok().as_deref()) {
        return Ok(Arc::new(RemoteExecutionService::connect()?));
    }
    Ok(Arc::new(LocalExecutionService::new()))
}

// Nests under the artifact's own real captured sandbox path rather than its
// declared output-slot `name`, so independently-produced outputs compose via
// ordinary merge_digests() path-union semantics when a later action consumes
// several of them together, instead of colliding on accidental slot-name
// equality. The `name` fallback is defensive only: the sole caller reaches
// this exclusively for output.file()/output.directory() artifacts, which
// always carry a real path.
#[cfg(test)]
fn normalize_graph_artifact(name: &str, artifact: &CachedArtifact) -> Result<DirectoryDigest> {
    let path = artifact.path.as_deref().unwrap_or(name);
    match artifact.kind.as_str() {
        "file" | "manifest" => nest_file(
            path,
            artifact.digest.clone(),
            artifact.bytes.unwrap_or_default(),
            artifact.mode,
        ),
        "directory" => {
            let digest = artifact
                .tree_digest
                .as_ref()
                .with_context(|| format!("directory output '{path}' has no tree digest"))?
                .clone();
            nest_directory(path, &DirectoryDigest::from_digest(digest))
        }
        other => bail!("graph action output '{path}' has unsupported kind '{other}'"),
    }
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
    Named(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalFlagDef {
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Goal {
    pub name: String,
    pub product: String,
    pub flags: BTreeMap<String, GoalFlagDef>,
    pub selectorless: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelHandler {
    pub identity: String,
    pub origin: String,
    pub factory: Option<String>,
    pub extension: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LabelDiscoverer {
    pub owner_id: u32,
    pub exec_name: String,
    pub goals: Option<BTreeSet<String>>,
    pub origin: String,
}

#[derive(Debug, Clone, Default)]
pub struct DiscoveredLabels {
    pub addresses: BTreeMap<String, u32>,
    pub primary_addresses: BTreeMap<u32, String>,
    pub handlers: BTreeMap<(u32, String), Vec<LabelHandler>>,
    pub children: BTreeMap<u32, Vec<String>>,
    pub completed_owners: BTreeSet<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredProductName {
    pub id: u32,
    pub module: Option<String>,
    pub builtin: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub targets: BTreeMap<String, Target>,
    pub graph: GraphCatalog,
    pub products: BTreeMap<(String, String), BTreeMap<String, String>>,
    pub product_fn_ids: BTreeMap<(String, String, String), String>,
    pub workspace_config: BTreeMap<String, serde_json::Value>,
    pub config_schemas: BTreeMap<String, serde_json::Value>,
    pub owned_files: BTreeSet<String>,
    pub goals: BTreeMap<String, Goal>,
    pub declared_product_names: BTreeMap<String, DeclaredProductName>,
    pub label_addresses: BTreeMap<String, u32>,
    pub label_primary_addresses: BTreeMap<u32, String>,
    pub label_handlers: BTreeMap<(u32, String), Vec<LabelHandler>>,
    pub label_discoverers: Vec<LabelDiscoverer>,
    pub label_discovery_children: BTreeMap<u32, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Internal host state
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct HostState {
    workspace_config: BTreeMap<String, serde_json::Value>,
    active_invocation_config: Option<BTreeMap<String, serde_json::Value>>,
    mode_axes: BTreeMap<String, serde_json::Value>,
    mode_profiles: BTreeMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------
pub fn find_workspace_root(start: &Path) -> Result<PathBuf> {
    let mut directory = dunce::canonicalize(start)
        .with_context(|| format!("canonicalize workspace start {}", start.display()))?;
    if directory.is_file() {
        directory.pop();
    }
    loop {
        if directory.join(WORKSPACE_FILE).is_file() {
            return Ok(directory);
        }
        if directory.join("imp.workspace.js").is_file() {
            bail!("JavaScript authoring is no longer supported in {}; migrate imp.workspace.js and BUILD.js modules to imp.workspace.luau and BUILD.luau", directory.display());
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

#[allow(dead_code)]
/// Load Luau modules with the selected execution service and installed rules.
pub async fn load_workspace(root: &Path) -> Result<LiveWorkspace> {
    let service = make_execution_service()?;
    load_workspace_with_rules_and_service(root, RulesSource::discover(), service).await
}

#[allow(dead_code)]
pub async fn load_workspace_with_rules(
    root: &Path,
    rules_source: RulesSource,
) -> Result<LiveWorkspace> {
    let service = make_execution_service()?;
    load_workspace_with_rules_and_service(root, rules_source, service).await
}

pub(crate) async fn load_workspace_with_rules_and_service(
    root: &Path,
    rules_source: RulesSource,
    service: Arc<dyn ExecutionService>,
) -> Result<LiveWorkspace> {
    imp_logging::ensure_installed(log::LevelFilter::Info);
    let root = dunce::canonicalize(root).context("canonicalize workspace root")?;
    if !root.join(WORKSPACE_FILE).is_file() {
        if root.join("imp.workspace.js").is_file() {
            bail!("JavaScript authoring is no longer supported; migrate imp.workspace.js and BUILD.js modules to imp.workspace.luau and BUILD.luau");
        }
        bail!("workspace requires {}", WORKSPACE_FILE);
    }
    let rules_root = rules_source
        .root()
        .context("Luau workspaces require an installed rules tree or IMP_RULES_DIR")?;
    let mut luau =
        crate::luau::LuauWorkspace::new_with_service(&root, rules_root, service.clone())?;
    let graph = GraphCatalog {
        roots: luau.load_modules().await?,
    };
    let workspace_config = luau.workspace_config();
    let (mode_axes, mode_profiles) = luau.mode_registry();
    let import_graph = luau.import_graph();
    let workspace = Workspace {
        graph,
        workspace_config: workspace_config.clone(),
        config_schemas: luau.configuration_schemas(),
        goals: luau.goal_definitions(),
        ..Workspace::default()
    };
    Ok(LiveWorkspace {
        workspace,
        luau: std::cell::RefCell::new(luau),
        exec_root: Arc::new(Mutex::new(Some(root))),
        exec_no_cache: Arc::new(AtomicBool::new(false)),
        trace_inputs: Arc::new(AtomicBool::new(false)),
        exec_sandbox_retention: Arc::new(AtomicU8::new(SandboxRetention::default().as_u8())),
        scheduler: Arc::new(Mutex::new(None)),
        ui_multi: Arc::new(Mutex::new(None)),
        host_state: Arc::new(Mutex::new(HostState {
            workspace_config,
            mode_axes,
            mode_profiles,
            ..HostState::default()
        })),
        import_graph: Arc::new(Mutex::new(import_graph)),
        dynamic_targets: Arc::new(Mutex::new(BTreeMap::new())),
        discovered_labels: Arc::new(Mutex::new(DiscoveredLabels::default())),
        service,
    })
}

pub fn workspace_with_discovered_labels(live: &LiveWorkspace) -> Workspace {
    let mut workspace = live.workspace.clone();
    let discovered = live.discovered_labels.lock().unwrap();
    workspace
        .label_addresses
        .extend(discovered.addresses.clone());
    workspace
        .label_primary_addresses
        .extend(discovered.primary_addresses.clone());
    workspace.label_handlers.extend(discovered.handlers.clone());
    workspace.label_discovery_children = discovered.children.clone();
    workspace
}
/// Decide what a selector that matched no target, no label and no graph root
/// means. Returns `None` when it is tolerable, `Some(error)` when the
/// invocation must fail.
///
/// `fallback` is the per-selector error target selection already produced
/// (`select_roots_in`/`select_targets_in`), which correctly distinguishes "no
/// such address" from "address exists but has no product". This adds the one
/// case those two cannot see: an address the graph catalog exports, but not
/// for the workflow this goal wants — say `imp test //:generated_stamp` where
/// the address only exports `build`. Reporting "no target matches selector"
/// there tells the user the wrong thing.
///
/// A package or recursive selector that matches addresses but no work for
/// this goal is not an error: `imp test //...` over a workspace of mostly
/// non-test targets is the normal case, and target selection already skips
/// productless targets for wildcard selectors the same way.
pub fn unmatched_selector_error(
    workspace: &Workspace,
    goal: Option<&str>,
    selector: &str,
    context: &SelectorContext,
    fallback: anyhow::Error,
) -> Option<anyhow::Error> {
    let single = [selector.to_owned()];
    // Unscoped by workflow: the question here is only whether the address
    // exists at all, not whether it does anything for this goal.
    let Ok(anywhere) = workspace.graph.select_catalog(&single, context) else {
        return Some(fallback);
    };
    if anywhere.is_empty() {
        return Some(fallback);
    }
    let selects_multiple = crate::graph::split_facet(selector)
        .ok()
        .and_then(|(address, _)| context.parse(address).ok())
        .is_some_and(|parsed| parsed.selects_multiple());
    if selects_multiple {
        return None;
    }
    let addresses: BTreeSet<&str> = anywhere.iter().map(|root| root.address.as_str()).collect();
    let (Some(goal), 1) = (goal, addresses.len()) else {
        return Some(fallback);
    };
    let address = addresses.into_iter().next().expect("one address");
    let workflows = workspace
        .graph
        .workflows_at(address)
        .into_iter()
        .collect::<Vec<_>>()
        .join(", ");
    Some(anyhow::anyhow!(
        "{address} has no '{goal}' workflow; it exports: {workflows}"
    ))
}

pub fn select_labels_with_discovered_children_in(
    workspace: &Workspace,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<Vec<(u32, String)>> {
    let mut selected = BTreeMap::new();
    for selector in selectors {
        let single = std::slice::from_ref(selector);
        for (id, address) in crate::selector::select_labels_in(workspace, single, context)? {
            selected.insert(address, id);
        }
        let parsed = context.parse(selector)?;
        if parsed.selects_multiple() {
            continue;
        }
        let owners: Vec<u32> = workspace
            .label_addresses
            .iter()
            .filter(|(address, _)| parsed.matches_address(address))
            .map(|(_, id)| *id)
            .collect();
        for owner in owners {
            for address in workspace
                .label_discovery_children
                .get(&owner)
                .into_iter()
                .flatten()
            {
                if let Some(&id) = workspace.label_addresses.get(address) {
                    selected.insert(address.clone(), id);
                }
            }
        }
    }
    Ok(selected
        .into_iter()
        .map(|(address, id)| (id, address))
        .collect())
}
/// Materialize the discovery owners needed to resolve `selectors`. Multi-root
/// selectors and explicit introspection/change-detection requests use
/// `force_all`; an exact known non-owner remains cheap.
pub async fn ensure_discovered_labels(
    _live: &LiveWorkspace,
    _workspace_root: &Path,
    _selectors: &[String],
    _goal: Option<&str>,
    _context: &SelectorContext,
    _force_all: bool,
) -> Result<()> {
    Ok(())
}
/// Return the existing empty Luau introspection view. Detailed dependency
/// walks for changed-file selection use `changed_graph_walk` instead.
pub async fn walk_graph_for_introspection(
    _live: &LiveWorkspace,
    _roots: &[&GraphRoot],
    _discover_expansion_get: bool,
    _discover_expansion_all: bool,
    _invocation_override: Option<&str>,
) -> Result<GraphWalk> {
    Ok(GraphWalk::default())
}
pub struct GraphResolution {
    pub roots: Vec<GraphRoot>,
    pub walk: GraphWalk,
    pub unmatched: Vec<String>,
}

// Lune must keep its RefCell borrow while an asynchronous host call runs.
#[allow(clippy::await_holding_refcell_ref)]
async fn resolve_luau_expansion(
    luau: &std::cell::RefCell<crate::luau::LuauWorkspace>,
    root: &GraphRoot,
) -> Result<Vec<GraphRoot>> {
    luau.borrow_mut().resolve_expansion_root(root).await
}

// Lune must keep its RefCell borrow while asynchronous discovery runs.
#[allow(clippy::await_holding_refcell_ref)]
async fn walk_luau_changed_graph(
    luau: &std::cell::RefCell<crate::luau::LuauWorkspace>,
    roots: &[&GraphRoot],
) -> Result<GraphWalk> {
    luau.borrow_mut().changed_graph_walk(roots).await
}
/// Resolve `selectors` against the graph catalog, then merge in synthetic
/// `parent#childKey` roots discovered by expanding whatever the selectors
/// reached — a package/recursive selector picks up every expansion child
/// under it, and an exact `parent#childKey` selector is resolved by walking
/// just its parent, since a child's address only exists once its parent has
/// been expanded (see `GraphWalk::synthetic_children`). Also returns the
/// union of every walk performed along the way, so a caller that needs
/// declared dependency edges (`imp dependencies`) doesn't have to re-walk.
/// `workflow`, when given, scopes resolution to one goal's workflow (e.g.
/// goal execution itself); `None` resolves across every exported workflow,
/// as `imp targets`/`imp dependencies` do. Shared by all three call sites so
/// they see the same expanded view.
///
/// Discovering an expansion's children can itself require running a task
/// (e.g. `cargo metadata`/`cmake configure`), which needs an execution
/// context — so this installs `exec_root` itself rather than trusting the
/// caller to have done it (unlike task execution proper, the caller is
/// still expected to have already installed a scheduler).
///
/// The two legacy walk options remain unused for Luau. Expansion projection
/// selection uses the Luau host; detailed graph introspection is excluded.
pub async fn resolve_graph_with_expansion(
    live: &LiveWorkspace,
    workspace_root: &Path,
    workflow: Option<&str>,
    selectors: &[String],
    context: &SelectorContext,
    _discover_expansion_get: bool,
    _invocation_override: Option<&str>,
) -> Result<GraphResolution> {
    *live.exec_root.lock().unwrap() = Some(workspace_root.to_owned());
    let catalog = &live.workspace.graph;
    let select_static = |selectors: &[String]| -> Result<Vec<&GraphRoot>> {
        match workflow {
            Some(workflow) => catalog.select(workflow, selectors, context),
            None => catalog.select_catalog(selectors, context),
        }
    };
    // Resolve expansion projections in the Luau VM that owns the handles.
    {
        let luau = &live.luau;
        let cancellation = live
            .scheduler
            .lock()
            .unwrap()
            .as_ref()
            .map(|scheduler| scheduler.cancellation_flag())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        luau.borrow_mut().begin_graph_run(cancellation);
        let mut roots = BTreeMap::new();
        let mut unmatched = Vec::new();
        for selector in selectors {
            let (address_part, facet) = crate::graph::split_facet(selector)?;
            if let Some((parent_address, child_key)) = address_part.split_once('#') {
                let parent_selector = match facet {
                    Some(facet) => format!("{parent_address}@{facet}"),
                    None => parent_address.to_owned(),
                };
                let parents: Vec<GraphRoot> =
                    select_static(std::slice::from_ref(&parent_selector))?
                        .into_iter()
                        .cloned()
                        .collect();
                let mut matched_expansion = false;
                let mut found_child = false;
                for parent in parents {
                    if luau.borrow().expansion_projection_is_all(parent.handle_id) != Some(true) {
                        continue;
                    }
                    matched_expansion = true;
                    let discovered = resolve_luau_expansion(luau, &parent).await?;
                    let expected = format!("{}#{child_key}", parent.address);
                    if let Some(child) = discovered
                        .into_iter()
                        .find(|child| child.address == expected)
                    {
                        found_child = true;
                        roots.insert(
                            (
                                child.address.clone(),
                                child.workflow.clone(),
                                child.facet.clone(),
                            ),
                            child,
                        );
                    }
                }
                if matched_expansion {
                    if !found_child {
                        bail!("expansion has no child '{child_key}'");
                    }
                } else {
                    unmatched.push(selector.clone());
                }
                continue;
            }

            let selected: Vec<GraphRoot> = select_static(std::slice::from_ref(selector))?
                .into_iter()
                .cloned()
                .collect();
            if selected.is_empty() {
                unmatched.push(selector.clone());
                continue;
            }
            for root in selected {
                let mut pending = vec![root];
                let mut seen = BTreeSet::new();
                while let Some(root) = pending.pop() {
                    let key = (root.address.clone(), root.handle_id);
                    if !seen.insert(key) {
                        bail!("cyclic Luau graph expansion at {}", root.address);
                    }
                    if luau
                        .borrow()
                        .expansion_projection_is_all(root.handle_id)
                        .is_some()
                    {
                        pending.extend(resolve_luau_expansion(luau, &root).await?);
                    } else {
                        roots.insert(
                            (
                                root.address.clone(),
                                root.workflow.clone(),
                                root.facet.clone(),
                            ),
                            root,
                        );
                    }
                }
            }
        }
        Ok(GraphResolution {
            roots: roots.into_values().collect(),
            walk: GraphWalk::default(),
            unmatched,
        })
    }
}
pub async fn resolve_graph_catalog_view(
    live: &LiveWorkspace,
    workflow: Option<&str>,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<GraphResolution> {
    let select_static = |selectors: &[String]| -> Result<Vec<&GraphRoot>> {
        match workflow {
            Some(workflow) => live.workspace.graph.select(workflow, selectors, context),
            None => live.workspace.graph.select_catalog(selectors, context),
        }
    };
    // Per-selector for the same reason as `resolve_graph_with_expansion`,
    // minus its two fallbacks: this view resolves nothing lazily, so an
    // empty result here is final.
    let mut static_roots: Vec<&GraphRoot> = Vec::new();
    let mut unmatched: Vec<String> = Vec::new();
    let mut seen: BTreeSet<(&str, &str, Option<&str>)> = BTreeSet::new();
    for selector in selectors {
        let matched = select_static(std::slice::from_ref(selector))?;
        if matched.is_empty() {
            unmatched.push(selector.clone());
            continue;
        }
        for root in matched {
            if seen.insert((
                root.address.as_str(),
                root.workflow.as_str(),
                root.facet.as_deref(),
            )) {
                static_roots.push(root);
            }
        }
    }
    // Address order, not selector order: this is what `select_catalog`'s own
    // map ordering used to give the diagram, and `format_graph_diagram`
    // renders roots in the order it receives them.
    static_roots.sort_by(|a, b| {
        (&a.address, &a.workflow, &a.facet).cmp(&(&b.address, &b.workflow, &b.facet))
    });
    let walk = walk_graph_for_introspection(live, &static_roots, false, false, None).await?;
    Ok(GraphResolution {
        roots: static_roots.into_iter().cloned().collect(),
        walk,
        unmatched,
    })
}
/// Graph-native addresses stale for `--changed-since` (#7): walks the
/// *entire* exported graph catalog (every root, not selector-scoped — #8
/// established that no command should present a subset as the whole graph),
/// running `expand()` discovery for both `"expansion-all"` and, unlike
/// `resolve_graph_with_expansion`'s callers, `"expansion-get"` roots too —
/// a Cargo crate's or Odin package's `[TEST]`/`[BUILD]` root is itself an
/// `expansion-get`, and its real dependency edges (crate path deps, inferred
/// Odin imports) only exist once discovery has run. Marks every root whose
/// declared-edge closure reaches a `"file"`/`"files"` leaf matching
/// `changed_paths`. No persisted index: recomputed fresh per invocation,
/// same "no parallel dependency graph" contract as
/// `resolve_graph_with_expansion` — the graph structure itself is the
/// dependency graph.
pub async fn stale_graph_addresses(
    live: &LiveWorkspace,
    workspace_root: &Path,
    changed_paths: &[String],
) -> Result<GraphChangedResult> {
    *live.exec_root.lock().unwrap() = Some(workspace_root.to_owned());
    let all_roots: Vec<&GraphRoot> = live.workspace.graph.roots.iter().collect();
    if all_roots.is_empty() || changed_paths.is_empty() {
        return Ok(GraphChangedResult::default());
    }
    let walk = {
        let luau = &live.luau;
        let scheduler = live.scheduler.lock().unwrap().clone();
        let _guard = luau.borrow().scheduler_scope(scheduler.clone());
        let cancellation = scheduler
            .as_ref()
            .map(|scheduler| scheduler.cancellation_flag())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        luau.borrow_mut().begin_graph_run(cancellation);
        walk_luau_changed_graph(luau, &all_roots).await?
    };
    let synthetic = walk.synthetic_children(&all_roots);
    let (stale_ids, covered_paths) = walk.stale_node_ids(changed_paths);
    let addresses = all_roots
        .iter()
        .map(|root| (*root).clone())
        .chain(synthetic)
        .filter(|root| stale_ids.contains(&root.handle_id))
        .map(|root| root.address)
        .collect();
    Ok(GraphChangedResult {
        addresses,
        covered_paths,
    })
}

#[derive(Debug, Default)]
pub struct GraphChangedResult {
    pub addresses: BTreeSet<String>,
    pub covered_paths: BTreeSet<String>,
}

pub fn source_field_workspace_root(address: &str, root: &str) -> Result<String> {
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

pub fn target_scope_path(address: &str) -> Result<PathBuf> {
    let (scope, _) = address
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("target address '{address}' must include ':'"))?;
    let scope = scope
        .strip_prefix("//")
        .ok_or_else(|| anyhow::anyhow!("target address '{address}' must start with //"))?;
    workspace_relative_directory(scope)
}

pub fn path_to_workspace_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        path.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    }
}
pub(crate) struct SchedulerGate<'a>(pub(crate) &'a imp_scheduler::RunContext);

impl imp_exec_api::JobGate for SchedulerGate<'_> {
    fn reserve(&self) {
        self.0.reserve()
    }

    fn phase(&self, phase: imp_exec_api::ExecutionPhase) {
        self.0
            .phase(format!("{}: {}", phase.label(), self.0.display()));
    }

    fn started(&self) {
        self.0.started()
    }
}

pub(crate) fn report_cache_telemetry(
    run_context: &imp_scheduler::RunContext,
    cache_outcome: imp_exec_api::CacheOutcome,
) {
    match cache_outcome {
        imp_exec_api::CacheOutcome::HitLocal => {
            run_context.report_cache_source(imp_scheduler::CacheSource::Local)
        }
        imp_exec_api::CacheOutcome::HitRemote => {
            run_context.report_cache_source(imp_scheduler::CacheSource::Remote)
        }
        imp_exec_api::CacheOutcome::Fresh | imp_exec_api::CacheOutcome::FreshPushed => {}
    }
}
type NativeToolInflightMap = HashMap<String, Arc<OnceLock<Result<PathBuf, String>>>>;

pub(crate) fn singleflight_register_native_tool(
    service: &Arc<dyn ExecutionService>,
    name: &str,
    resolved: &Path,
) -> Result<PathBuf, String> {
    static INFLIGHT: OnceLock<Mutex<NativeToolInflightMap>> = OnceLock::new();
    let map = INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()));

    let cell = {
        let mut map = map.lock().unwrap();
        Arc::clone(
            map.entry(name.to_owned())
                .or_insert_with(|| Arc::new(OnceLock::new())),
        )
    };
    cell.get_or_init(|| {
        service
            .register_native_tool(name, resolved)
            .map_err(|e| format!("{e:#}"))
    })
    .clone()
}
pub(crate) fn which_executable(name: &str) -> Option<String> {
    #[cfg(windows)]
    if name == "tar" && Path::new(WINDOWS_BSDTAR).is_file() {
        return Some(WINDOWS_BSDTAR.to_owned());
    }

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

#[cfg(test)]
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

    let mut walker = ignore::WalkBuilder::new(&directory);
    walker
        .hidden(false)
        .ignore(true)
        // Keep parent cache or temp-directory .gitignore files outside the
        // workspace from hiding this workspace. Load workspace .gitignore
        // explicitly, then use scoped files for nested directories.
        .git_ignore(false)
        .add_custom_ignore_filename(".gitignore")
        .git_global(true)
        .git_exclude(true)
        .parents(false)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    let workspace_gitignore = workspace_root.join(".gitignore");
    if workspace_gitignore.is_file() {
        walker
            .current_dir(workspace_root)
            .add_ignore(workspace_gitignore);
    }
    if !recursive {
        walker.max_depth(Some(1));
    }

    let mut files = Vec::new();
    for entry in walker
        .build()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
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

#[cfg(test)]
fn workspace_source_files(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
    recursive: bool,
) -> Result<Vec<String>> {
    matching_workspace_source_paths(workspace_root, root, include, exclude, recursive)
}

pub fn workspace_glob_files(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    if include.is_empty() {
        bail!("glob include must not be empty");
    }
    let max_depth = if include.iter().any(|pattern| pattern.contains("**")) {
        None
    } else {
        Some(
            include
                .iter()
                .map(|pattern| pattern.matches('/').count() + 1)
                .max()
                .unwrap_or(1),
        )
    };
    let include = compile_globs("include", include)?;
    let exclude = compile_globs("exclude", exclude)?;
    let directory = workspace_root.join(workspace_relative_directory(root)?);
    if !directory.is_dir() {
        bail!("glob root '{}' is not a directory", directory.display());
    }

    let mut walker = ignore::WalkBuilder::new(&directory);
    walker
        .hidden(false)
        .ignore(true)
        // Do not use the walker's Git discovery for .gitignore files. It
        // walks above the workspace root to find a repository, where an
        // unrelated parent (such as /tmp/imp's cache .gitignore) can hide the
        // whole workspace. Treat .gitignore as a scoped ignore file instead.
        .git_ignore(false)
        .add_custom_ignore_filename(".gitignore")
        .git_global(true)
        .git_exclude(true)
        .parents(false)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    let workspace_gitignore = workspace_root.join(".gitignore");
    if workspace_gitignore.is_file() {
        walker
            .current_dir(workspace_root)
            .add_ignore(workspace_gitignore);
    }
    if let Some(depth) = max_depth {
        walker.max_depth(Some(depth));
    }

    let mut files = Vec::new();
    for entry in walker
        .build()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
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
pub struct GlobResult {
    pub files: Vec<String>,
    pub digest: imp_store::digest::DirectoryDigest,
}

pub fn workspace_glob_files_captured(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<GlobResult> {
    let files = workspace_glob_files(workspace_root, root, include, exclude)?;
    let digest = imp_store::digest::capture_paths(workspace_root, &files)?;
    Ok(GlobResult { files, digest })
}

pub fn compile_globs(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
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

pub fn workspace_relative_directory(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path == "." {
        return Ok(PathBuf::new());
    }
    artifact_relative_path(path)
}
pub(crate) const MODE_AXIS_NAMESPACE: &str = "imp.mode";
pub(crate) fn scoped_configuration_digest(
    workspace_config: &BTreeMap<String, serde_json::Value>,
    namespaces: &[String],
    mode_overrides: &BTreeMap<String, String>,
) -> Result<String> {
    let mut scoped: BTreeMap<String, serde_json::Value> = namespaces
        .iter()
        .filter_map(|ns| {
            workspace_config
                .get(ns)
                .map(|value| (ns.clone(), value.clone()))
        })
        .collect();
    if namespaces.iter().any(|ns| ns == MODE_AXIS_NAMESPACE) && !mode_overrides.is_empty() {
        let mode = scoped
            .entry(MODE_AXIS_NAMESPACE.to_owned())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        let mode = mode.as_object_mut().context("imp.mode must be an object")?;
        for (axis, value) in mode_overrides {
            mode.insert(axis.clone(), serde_json::Value::String(value.clone()));
        }
    }
    digest_json(&scoped)
}
/// The bare `<module>` portion of a call-site site string. `_stableFunctionIdentity`
/// now mints ids as plain `<name>@<module>` (no line:col), but old on-disk
/// memo-trace records may still carry the previous `<name>@<module>:<line>:<col>`
/// shape, so this strips a trailing `:<line>:<col>` only when present — a
/// module string with no trailing digits passes through unchanged. Shared by
/// `__host_module_digest` and `trace_changed::directly_stale`'s
/// `module_digest` recheck.
pub(crate) fn module_name_from_site(site: &str) -> &str {
    site.rsplit_once(':')
        .and_then(|(prefix, suffix)| {
            suffix
                .chars()
                .all(|c| c.is_ascii_digit())
                .then(|| prefix.rsplit_once(':').map_or(prefix, |(p, _)| p))
        })
        .unwrap_or(site)
}
/// Content digest of the module a `<module>:<line>:<col>` call-site site
/// string names — the same digest stored in `MemoTraceRecord.module_digest`
/// is compared against. Embedded (builtin) rule modules digest their bundled
/// source text directly rather than reading from disk.
pub(crate) fn module_digest_for_site(
    workspace_root: &Path,
    rules_source: &RulesSource,
    site: &str,
) -> Result<String> {
    let module = module_name_from_site(site);
    let resolution = resolve_workspace_module(workspace_root, rules_source, module)
        .map_err(|e| anyhow::anyhow!(e))
        .context("resolve module for digest")?;
    let bytes = std::fs::read(&resolution.path)
        .with_context(|| format!("read {}", resolution.path.display()))?;
    Ok(digest_bytes(&bytes))
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

pub fn format_labels(
    workspace: &Workspace,
    labels: &[(u32, String)],
    w: &mut String,
) -> std::fmt::Result {
    use std::fmt::Write;
    for (label_id, address) in labels {
        writeln!(w, "{address} (label)")?;
        for ((id, goal), handlers) in &workspace.label_handlers {
            if id != label_id {
                continue;
            }
            writeln!(w, "  {goal}:")?;
            for handler in handlers {
                write!(
                    w,
                    "    - {} (attached at {})",
                    handler.identity, handler.origin
                )?;
                if let (Some(factory), Some(extension)) = (&handler.factory, &handler.extension) {
                    write!(w, " via {factory}.{extension}")?;
                }
                writeln!(w)?;
            }
        }
    }
    Ok(())
}

pub fn format_graph_roots(roots: &[&GraphRoot], w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;
    let mut by_address: BTreeMap<&str, BTreeMap<&str, Vec<&str>>> = BTreeMap::new();
    for root in roots {
        by_address
            .entry(root.address.as_str())
            .or_default()
            .entry(root.workflow.as_str())
            .or_default()
            .extend(root.facet.as_deref());
    }
    for (address, workflows) in by_address {
        // A `#childKey` address was synthesized by the expand()-discovery
        // walk (crate::graph::GraphWalk::synthetic_children), not exported
        // directly by a BUILD.js — label it so the view's provenance is
        // explicit rather than presenting it as an ordinary static root.
        let label = if address.contains('#') {
            "graph, expanded"
        } else {
            "graph"
        };
        writeln!(w, "{address} ({label})")?;
        for (workflow, mut facets) in workflows {
            facets.sort();
            facets.dedup();
            if facets.is_empty() {
                writeln!(w, "  {workflow}")?;
            } else {
                writeln!(w, "  {workflow}: {}", facets.join(", "))?;
            }
        }
    }
    Ok(())
}
/// Print each selected graph root's declared input edges and — for
/// expansion roots — the child keys `expand()` discovered, using the walk
/// `resolve_graph_with_expansion` already performed. Every edge here is a
/// declared handle reference (a task's own `inputs`, an expansion's, or a
/// tool's artifact); the graph model has no other kind of dependency, so
/// unlike `format_label_dependencies` there's nothing "observed" to
/// distinguish it from.
pub fn format_graph_dependencies(
    roots: &[&GraphRoot],
    walk: &GraphWalk,
    w: &mut String,
) -> std::fmt::Result {
    use std::fmt::Write;
    let address_by_handle: BTreeMap<u32, &str> = roots
        .iter()
        .map(|root| (root.handle_id, root.address.as_str()))
        .collect();
    for root in roots {
        // `root.address` alone collides when one address exports more than
        // one workflow (e.g. a `[BUILD]`/`[TEST]` pair) — `display()`
        // disambiguates with `#workflow`/`@facet#workflow`, same as
        // `GraphRoot`'s own selector syntax.
        writeln!(w, "{} (graph)", root.display())?;
        let Some(node) = walk.node(root.handle_id) else {
            continue;
        };
        for edge in &node.edges {
            match address_by_handle.get(&edge.handle_id) {
                Some(address) => writeln!(w, "  <- {}: {address}", edge.name)?,
                None => writeln!(w, "  <- {} (unaddressed {})", edge.name, node.kind)?,
            }
        }
        let mut children: Vec<_> = node.children.iter().collect();
        children.sort_by_key(|(key, _)| key.as_str());
        for (key, handle_id) in children {
            match address_by_handle.get(handle_id) {
                Some(address) => writeln!(w, "  -> #{key}: {address}")?,
                None => writeln!(w, "  -> #{key} (unaddressed)")?,
            }
        }
    }
    Ok(())
}

fn mermaid_escape(label: &str) -> String {
    label.replace('\\', "\\\\").replace('"', "&quot;")
}

fn dot_escape(label: &str) -> String {
    label.replace('\\', "\\\\").replace('"', "\\\"")
}
fn graph_diagram_node_label(
    node: &GraphWalkNode,
    rendered_id: u32,
    root_labels: &BTreeMap<u32, String>,
    expand_children: bool,
) -> String {
    if let Some(label) = root_labels.get(&rendered_id) {
        return label.clone();
    }
    if node.kind == "expansion-all" && !expand_children && !node.children.is_empty() {
        let base = node.display.as_deref().unwrap_or("expansion");
        return format!("{base} ({} children)", node.children.len());
    }
    if let Some(display) = &node.display {
        return display.clone();
    }
    match node.kind.as_str() {
        "file" => node
            .data
            .as_ref()
            .and_then(|data| data.get("path"))
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| "file".to_owned()),
        "files" => node
            .data
            .as_ref()
            .and_then(|data| data.get("root"))
            .and_then(|value| value.as_str())
            .map(|root| format!("files({root})"))
            .unwrap_or_else(|| "files()".to_owned()),
        other => other.to_owned(),
    }
}
pub fn format_graph_diagram(
    roots: &[&GraphRoot],
    walk: &GraphWalk,
    view: GraphView,
    format: GraphFormat,
    expand_children: bool,
    show_plumbing: bool,
    w: &mut String,
) -> std::fmt::Result {
    use std::fmt::Write;

    // Group roots sharing one address under a single canonical id — its
    // lowest handle id, deterministic within one render — and precompute
    // that group's label: the plain selector display for a lone workflow,
    // or the address plus every workflow it registers when there's more
    // than one.
    let mut roots_by_address: BTreeMap<&str, Vec<&GraphRoot>> = BTreeMap::new();
    for root in roots {
        roots_by_address
            .entry(root.address.as_str())
            .or_default()
            .push(root);
    }
    let mut canonical_id: BTreeMap<u32, u32> = BTreeMap::new();
    let mut root_labels: BTreeMap<u32, String> = BTreeMap::new();
    for group in roots_by_address.into_values() {
        let canonical = group.iter().map(|root| root.handle_id).min().unwrap();
        for root in &group {
            canonical_id.insert(root.handle_id, canonical);
        }
        let label = if let [only] = group.as_slice() {
            only.display()
        } else {
            let mut workflows: Vec<&str> =
                group.iter().map(|root| root.workflow.as_str()).collect();
            workflows.sort();
            workflows.dedup();
            format!("{} ({})", group[0].address, workflows.join(", "))
        };
        root_labels.insert(canonical, label);
    }
    let render_id = |id: u32| canonical_id.get(&id).copied().unwrap_or(id);

    // Re-derive which nodes are actually shown from the roots' own
    // reachability, rather than just hiding a collapsed expansion's direct
    // children: a node reachable *only* through a collapsed expansion's
    // children (e.g. the child's own producing task) must disappear too,
    // while one also reachable via an ordinary declared edge stays put.
    let by_id: BTreeMap<u32, &GraphWalkNode> =
        walk.nodes.iter().map(|node| (node.id, node)).collect();
    let is_plumbing = |node: &GraphWalkNode| {
        node.kind == "tool" || node.kind == "native-tool" || node.kind == "semantic"
    };
    let mut visible_ids: BTreeSet<u32> = BTreeSet::new();
    let mut queue: std::collections::VecDeque<u32> =
        roots.iter().map(|root| root.handle_id).collect();
    while let Some(id) = queue.pop_front() {
        if !visible_ids.insert(id) {
            continue;
        }
        let Some(node) = by_id.get(&id) else {
            continue;
        };
        for edge in &node.edges {
            if !show_plumbing {
                if let Some(target) = by_id.get(&edge.handle_id) {
                    if is_plumbing(target) {
                        continue;
                    }
                }
            }
            queue.push_back(edge.handle_id);
        }
        if expand_children || node.kind != "expansion-all" {
            for &child_id in node.children.values() {
                queue.push_back(child_id);
            }
        }
    }
    let visible = |id: u32| visible_ids.contains(&id);

    // Collect (rendered source, edge label, rendered target) triples ahead
    // of writing anything: several raw roots can now share one rendered id
    // (the address grouping above), and two of their edges can coincide
    // once redirected there — dedupe before emitting rather than printing
    // the same line twice.
    let mut rendered_edges: BTreeSet<(u32, String, u32)> = BTreeSet::new();
    for node in &walk.nodes {
        if !visible(node.id) {
            continue;
        }
        let src = render_id(node.id);
        for edge in &node.edges {
            if !visible(edge.handle_id) {
                continue;
            }
            rendered_edges.insert((src, edge.name.clone(), render_id(edge.handle_id)));
        }
        if expand_children {
            for (key, &handle_id) in &node.children {
                rendered_edges.insert((src, format!("#{key}"), render_id(handle_id)));
            }
        }
    }
    let mut emitted_nodes: BTreeSet<u32> = BTreeSet::new();

    match format {
        GraphFormat::Mermaid => {
            writeln!(w, "%% view: {}", view.label())?;
            writeln!(w, "flowchart TD")?;
            for node in &walk.nodes {
                if !visible(node.id) {
                    continue;
                }
                let rendered_id = render_id(node.id);
                if !emitted_nodes.insert(rendered_id) {
                    continue;
                }
                let label = mermaid_escape(&graph_diagram_node_label(
                    node,
                    rendered_id,
                    &root_labels,
                    expand_children,
                ));
                if root_labels.contains_key(&rendered_id) {
                    writeln!(w, "  n{rendered_id}[[\"{label}\"]]")?;
                } else {
                    writeln!(w, "  n{rendered_id}[\"{label}\"]")?;
                }
            }
            for (src, name, dst) in &rendered_edges {
                writeln!(w, "  n{src} -->|{}| n{dst}", mermaid_escape(name))?;
            }
        }
        GraphFormat::Dot => {
            writeln!(w, "// view: {}", view.label())?;
            writeln!(w, "digraph graph_view {{")?;
            for node in &walk.nodes {
                if !visible(node.id) {
                    continue;
                }
                let rendered_id = render_id(node.id);
                if !emitted_nodes.insert(rendered_id) {
                    continue;
                }
                let label = dot_escape(&graph_diagram_node_label(
                    node,
                    rendered_id,
                    &root_labels,
                    expand_children,
                ));
                if root_labels.contains_key(&rendered_id) {
                    writeln!(
                        w,
                        "  n{rendered_id} [label=\"{label}\", shape=box, peripheries=2];"
                    )?;
                } else {
                    writeln!(w, "  n{rendered_id} [label=\"{label}\"];")?;
                }
            }
            for (src, name, dst) in &rendered_edges {
                writeln!(w, "  n{src} -> n{dst} [label=\"{}\"];", dot_escape(name))?;
            }
            writeln!(w, "}}")?;
        }
    }
    Ok(())
}

pub fn format_dependencies(
    workspace: &Workspace,
    selectors: &[String],
    context: &SelectorContext,
    w: &mut String,
) -> Result<()> {
    let targets = select_targets_in(workspace, selectors, context)?;

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

pub fn format_label_dependencies(
    workspace: &Workspace,
    labels: &[(u32, String)],
    goal: &str,
    trace: &crate::trace_changed::TraceIndex,
    w: &mut String,
) -> Result<()> {
    use std::fmt::Write;
    for (label_id, address) in labels {
        let Some(handlers) = workspace.label_handlers.get(&(*label_id, goal.to_owned())) else {
            bail!("label '{address}' has no '{goal}' handler attached");
        };
        for handler in handlers {
            writeln!(
                w,
                "{address}#{goal}@{} (observed memo trace)",
                handler.identity
            )?;
            let fn_id = format!("label-handler:{goal}:{}", handler.identity);
            let records = trace.records_for_function(&fn_id);
            if records.is_empty() {
                writeln!(w, "└── <unobserved: run this goal to record dependencies>")?;
                continue;
            }
            for (record_index, record) in records.iter().enumerate() {
                if records.len() > 1 {
                    writeln!(w, "├── invocation {}", record_index + 1)?;
                }
                if record.deps.is_empty() {
                    writeln!(w, "└── <no observed memo calls>")?;
                } else {
                    for (index, dep) in record.deps.iter().enumerate() {
                        let branch = if index + 1 == record.deps.len() {
                            "└──"
                        } else {
                            "├──"
                        };
                        let observed = trace
                            .record(dep)
                            .map(|record| record.fn_id.as_str())
                            .unwrap_or(dep);
                        writeln!(w, "{branch} {observed}")?;
                    }
                }
            }
        }
    }
    Ok(())
}
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

#[cfg(any(test, feature = "test-support"))]
pub async fn execute_goal_live(
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
        &SelectorContext::root(),
        goal,
        GoalSelection::Selectors(selectors),
        GoalExecutionOptions {
            no_cache,
            trace_inputs: false,
            js_workers,
            flags,
            run_args: &[],
            axis_overrides: &[],
            profile: None,
        },
    )
    .await
    .map(|_| ())
}
pub enum GoalSelection<'a> {
    Selectors(&'a [String]),
    ChangedAddresses {
        addresses: &'a BTreeSet<String>,
        selectors: &'a [String],
    },
}

pub struct GoalExecutionOptions<'a> {
    pub no_cache: bool,
    pub trace_inputs: bool,
    pub js_workers: usize,
    pub flags: serde_json::Value,
    pub run_args: &'a [String],
    pub axis_overrides: &'a [String],
    pub profile: Option<&'a str>,
}
/// Validate an axis declaration for either authoring runtime.
pub(crate) fn validate_mode_axis_definition(name: &str, def: &serde_json::Value) -> Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        bail!("invalid mode axis name '{name}'");
    }
    let Some(obj) = def.as_object() else {
        return Err(anyhow::anyhow!("definition must be an object"));
    };
    if !obj.contains_key("default") {
        return Err(anyhow::anyhow!(
            "definition must include a \"default\" value"
        ));
    }
    let Some(default) = obj.get("default").and_then(|value| value.as_str()) else {
        return Err(anyhow::anyhow!("\"default\" must be a string"));
    };
    match obj.get("kind").and_then(|k| k.as_str()) {
        Some("rebuild") | Some("output-select") => {}
        _ => {
            return Err(anyhow::anyhow!(
                "\"kind\" must be \"rebuild\" or \"output-select\""
            ));
        }
    }
    if let Some(values) = obj.get("values") {
        let Some(values) = values.as_array() else {
            return Err(anyhow::anyhow!("\"values\" must be an array of strings"));
        };
        if !values.iter().all(|value| value.as_str().is_some()) {
            return Err(anyhow::anyhow!("\"values\" must be an array of strings"));
        }
        if !values.iter().any(|value| value.as_str() == Some(default)) {
            return Err(anyhow::anyhow!(
                "\"default\" must be included in \"values\" when values are declared"
            ));
        }
    }
    Ok(())
}
/// Split validated overrides into rebuild and output-selection axes.
pub(crate) fn classify_mode_overrides(
    mode_axes: &BTreeMap<String, serde_json::Value>,
    overrides: &BTreeMap<String, String>,
    api: &str,
) -> Result<(BTreeMap<String, String>, BTreeMap<String, String>)> {
    let mut rebuild = BTreeMap::new();
    let mut output_select = BTreeMap::new();
    for (axis, value) in overrides {
        let Some(def) = mode_axes.get(axis) else {
            let known: Vec<&str> = mode_axes.keys().map(String::as_str).collect();
            anyhow::bail!(
                "{api} overrides undeclared mode axis '{axis}'; declared axes: {}",
                known.join(", ")
            );
        };
        validate_mode_axis_value(axis, value, def, api)?;
        match def.get("kind").and_then(|kind| kind.as_str()) {
            Some("rebuild") => {
                rebuild.insert(axis.clone(), value.clone());
            }
            Some("output-select") => {
                output_select.insert(axis.clone(), value.clone());
            }
            _ => unreachable!("defineModeAxis validates axis kinds"),
        }
    }
    Ok((rebuild, output_select))
}

fn validate_mode_axis_value(
    axis: &str,
    value: &str,
    def: &serde_json::Value,
    source: &str,
) -> Result<()> {
    if let Some(values) = def.get("values").and_then(|v| v.as_array()) {
        let valid: Vec<&str> = values.iter().filter_map(|v| v.as_str()).collect();
        if !valid.contains(&value) {
            anyhow::bail!(
                "{source} sets '{axis}={value}', which is not a valid value for '{axis}'; valid values: {}",
                valid.join(", ")
            );
        }
    }
    Ok(())
}
/// Resolve invocation modes before graph discovery and install them in both hosts.
pub fn resolve_mode_axes(
    live: &LiveWorkspace,
    profile_name: Option<&str>,
    axis_overrides: &[String],
) -> Result<serde_json::Value> {
    let mut hs = live.host_state.lock().unwrap();
    let mode_axes = hs.mode_axes.clone();
    let mode_profiles = hs.mode_profiles.clone();

    let resolved = resolve_mode_registry(&mode_axes, &mode_profiles, profile_name, axis_overrides)?;
    hs.workspace_config
        .insert(MODE_AXIS_NAMESPACE.to_owned(), resolved.clone());
    drop(hs);
    {
        let luau = &live.luau;
        luau.borrow_mut()
            .set_invocation_mode(resolved.clone(), profile_name)?;
    }
    Ok(resolved)
}

pub(crate) fn resolve_mode_registry(
    mode_axes: &BTreeMap<String, serde_json::Value>,
    mode_profiles: &BTreeMap<String, serde_json::Value>,
    profile_name: Option<&str>,
    axis_overrides: &[String],
) -> Result<serde_json::Value> {
    for (profile_name, profile) in mode_profiles {
        let values = profile
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("profile '{profile_name}' values must be an object"))?;
        for (axis, value) in values {
            if axis == "odin" {
                let defines = value
                    .get("defines")
                    .and_then(|value| value.as_object())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "profile '{profile_name}' odin payload requires a `defines` object"
                        )
                    })?;
                if !defines
                    .iter()
                    .all(|(name, value)| !name.is_empty() && value.as_str().is_some())
                {
                    anyhow::bail!(
                        "profile '{profile_name}' odin defines must map non-empty names to strings"
                    );
                }
                continue;
            }
            let value = value.as_str().ok_or_else(|| {
                anyhow::anyhow!(
                    "profile '{profile_name}' values must map axes to strings; namespaced configuration must use `odin`"
                )
            })?;
            let Some(def) = mode_axes.get(axis) else {
                let known: Vec<&str> = mode_axes.keys().map(String::as_str).collect();
                anyhow::bail!(
                    "profile '{profile_name}' sets undeclared mode axis '{axis}'; declared axes: {}",
                    known.join(", ")
                );
            };
            validate_mode_axis_value(axis, value, def, &format!("profile '{profile_name}'"))?;
        }
    }

    let profile = match profile_name {
        Some(name) => Some(mode_profiles.get(name).ok_or_else(|| {
            let known: Vec<&str> = mode_profiles.keys().map(String::as_str).collect();
            anyhow::anyhow!(
                "--profile '{name}' names an undeclared mode profile; declared profiles: {}",
                known.join(", ")
            )
        })?),
        None => None,
    };

    let mut overrides: BTreeMap<String, String> = BTreeMap::new();
    for entry in axis_overrides {
        let (key, value) = entry
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("--axis '{entry}' must be in the form KEY=VALUE"))?;
        overrides.insert(key.to_owned(), value.to_owned());
    }
    for (key, value) in &overrides {
        let Some(def) = mode_axes.get(key) else {
            let known: Vec<&str> = mode_axes.keys().map(String::as_str).collect();
            anyhow::bail!(
                "--axis '{key}={value}' names an undeclared mode axis; declared axes: {}",
                known.join(", ")
            );
        };
        validate_mode_axis_value(key, value, def, "--axis")?;
    }

    let mut resolved = serde_json::Map::new();
    for (name, def) in mode_axes {
        let value = overrides
            .get(name)
            .map(|v| serde_json::Value::String(v.clone()))
            .or_else(|| profile.and_then(|profile| profile.get(name).cloned()))
            .unwrap_or_else(|| {
                def.get("default")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null)
            });
        resolved.insert(name.clone(), value);
    }
    let resolved = serde_json::Value::Object(resolved);
    Ok(resolved)
}

fn invocation_config(
    live: &LiveWorkspace,
    profile_name: Option<&str>,
) -> Result<BTreeMap<String, serde_json::Value>> {
    let hs = live.host_state.lock().unwrap();
    let mut config = hs.workspace_config.clone();
    if let Some(name) = profile_name {
        let profile = hs.mode_profiles.get(name).ok_or_else(|| {
            anyhow::anyhow!("profile '{name}' was not found while building the invocation")
        })?;
        if let Some(odin) = profile.get("odin") {
            let existing = config
                .entry("odin".to_owned())
                .or_insert_with(|| serde_json::json!({}));
            merge_workspace_config(existing, odin.clone());
        }
    }
    Ok(config)
}

struct InvocationConfigGuard<'a> {
    luau: &'a std::cell::RefCell<crate::luau::LuauWorkspace>,
    state: Arc<Mutex<HostState>>,
}

impl<'a> InvocationConfigGuard<'a> {
    fn install(live: &'a LiveWorkspace, config: BTreeMap<String, serde_json::Value>) -> Self {
        let state = Arc::clone(&live.host_state);
        state.lock().unwrap().active_invocation_config = Some(config);
        Self {
            state,
            luau: &live.luau,
        }
    }
}

impl Drop for InvocationConfigGuard<'_> {
    fn drop(&mut self) {
        self.state.lock().unwrap().active_invocation_config = None;
        {
            let luau = self.luau;
            luau.borrow_mut().clear_invocation_mode();
        }
    }
}

#[derive(Debug)]
pub(crate) struct UserFacingGoalError(pub(crate) String);

impl std::fmt::Display for UserFacingGoalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UserFacingGoalError {}

#[allow(clippy::await_holding_refcell_ref)] // Luau Runtime is single-threaded and must stay borrowed while its async VM call runs.
pub async fn execute_goal_live_selection(
    live: &LiveWorkspace,
    workspace_root: &Path,
    selector_context: &SelectorContext,
    goal: &str,
    selection: GoalSelection<'_>,
    options: GoalExecutionOptions<'_>,
) -> Result<Option<String>> {
    let GoalExecutionOptions {
        no_cache,
        trace_inputs,
        js_workers: _,
        flags,
        run_args,
        axis_overrides,
        profile,
    } = options;
    let goal_def = live
        .workspace
        .goals
        .get(goal)
        .with_context(|| format!("unknown goal '{goal}'"))?;
    if matches!(&selection, GoalSelection::Selectors(selectors) if selectors.is_empty())
        && !goal_def.selectorless
    {
        bail!("goal '{goal}' requires at least one selector");
    }
    *live.exec_root.lock().unwrap() = Some(workspace_root.to_owned());
    live.exec_no_cache.store(no_cache, Ordering::SeqCst);
    live.trace_inputs.store(trace_inputs, Ordering::SeqCst);
    resolve_mode_axes(live, profile, axis_overrides)?;
    let _scheduler_guard = live
        .luau
        .borrow()
        .scheduler_scope(live.scheduler.lock().unwrap().clone());
    let config = invocation_config(live, profile)?;
    let _config_guard = InvocationConfigGuard::install(live, config.clone());
    let invocation = serde_json::to_string(&serde_json::json!({
        "args": run_args, "flags": flags,
        "mode": config.get(MODE_AXIS_NAMESPACE).cloned().unwrap_or_else(|| serde_json::json!({})),
        "config": config,
    }))?;
    let selectors = match &selection {
        GoalSelection::Selectors(selectors) => selectors.to_vec(),
        GoalSelection::ChangedAddresses {
            addresses,
            selectors,
        } => {
            if goal_def.selectorless {
                Vec::new()
            } else {
                let selected = filter_changed_addresses_in(
                    &live.workspace,
                    addresses,
                    selectors,
                    selector_context,
                )?;
                if selected.is_empty() {
                    eprintln!("no changed target or label can run goal '{goal}'; nothing to do");
                    return Ok(None);
                }
                selected.into_iter().collect()
            }
        }
    };
    let resolution = resolve_graph_with_expansion(
        live,
        workspace_root,
        Some(goal),
        &selectors,
        selector_context,
        true,
        Some(&invocation),
    )
    .await?;
    if let GoalSelection::ChangedAddresses { selectors, .. } = &selection {
        if resolution.roots.is_empty() && !goal_def.selectorless {
            if selectors.is_empty() {
                eprintln!("no changed target or label can run goal '{goal}'; nothing to do");
            } else {
                eprintln!("no changed target or label matching the requested selectors can run goal '{goal}'; nothing to do");
            }
            return Ok(None);
        }
    }
    for selector in resolution
        .unmatched
        .iter()
        .filter(|_| matches!(selection, GoalSelection::Selectors(_)))
    {
        let error = anyhow::anyhow!("no target matches selector '{selector}'");
        if let Some(error) = unmatched_selector_error(
            &live.workspace,
            Some(goal),
            selector,
            selector_context,
            error,
        ) {
            return Err(error);
        }
    }
    if matches!(goal, "fmt" | "lint")
        && matches!(selection, GoalSelection::Selectors(_))
        && !goal_def.selectorless
        && !selectors.is_empty()
        && resolution.roots.is_empty()
        && resolution.unmatched.len() == selectors.len()
    {
        eprintln!("warning: goal '{goal}' matched targets, but none has a handler for this goal; a handler import may be missing");
    }
    let cancellation = live
        .scheduler
        .lock()
        .unwrap()
        .as_ref()
        .map(|scheduler| scheduler.cancellation_flag())
        .context("Luau graph execution requires an installed scheduler")?;
    let mut luau = live.luau.borrow_mut();
    luau.set_ui_multi(live.ui_multi.lock().unwrap().clone());
    let result = luau
        .execute_graph(goal, &resolution.roots, cancellation, &flags, run_args)
        .await;
    luau.set_ui_multi(None);
    result.map_err(|error| {
        if error.downcast_ref::<UserFacingGoalError>().is_some() {
            error
        } else {
            anyhow::anyhow!("execute goal '{goal}': {error:#}")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::selector::select_targets;
    use imp_execution::exec::{
        report_process_line, spawn_output_reader, ProcessLine, ProcessStream,
    };
    use imp_store::cache::CachedArtifact;
    use imp_store::digest::{list_files_in_digest, merge_digests};
    use std::sync::mpsc;
    #[test]
    fn daemon_execution_is_requested_only_by_the_exact_env_marker() {
        assert!(daemon_execution_requested(Some("1")));
        assert!(!daemon_execution_requested(None));
        assert!(!daemon_execution_requested(Some("0")));
        assert!(!daemon_execution_requested(Some("true")));
    }
    #[test]
    fn singleflight_register_native_tool_coalesces_concurrent_callers() {
        let service: Arc<dyn ExecutionService> = Arc::new(LocalExecutionService::new());
        let resolved = which_executable("sh").expect("sh must be on PATH for this test");
        let resolved = std::fs::canonicalize(&resolved).expect("canonicalize sh");

        let handles: Vec<_> = (0..16)
            .map(|_| {
                let service = Arc::clone(&service);
                let resolved = resolved.clone();
                std::thread::spawn(move || {
                    singleflight_register_native_tool(&service, "sh", &resolved)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let first = results[0]
            .as_ref()
            .unwrap_or_else(|e| panic!("concurrent resolution must not race: {e}"));
        for result in &results {
            assert_eq!(
                result
                    .as_ref()
                    .unwrap_or_else(|e| panic!("concurrent resolution must not race: {e}")),
                first,
                "every concurrent caller must agree on the same resolved root"
            );
        }
    }
    #[test]
    fn module_name_from_site_strips_line_col_only_when_present() {
        // Current shape: _stableFunctionIdentity mints ids with no line:col.
        assert_eq!(
            module_name_from_site("rules/rust/index.js"),
            "rules/rust/index.js"
        );
        assert_eq!(module_name_from_site("//rules/example"), "//rules/example");
        // Old on-disk shape, still supported for existing memo-trace records.
        assert_eq!(
            module_name_from_site("rules/rust/index.js:503:2"),
            "rules/rust/index.js"
        );
        assert_eq!(
            module_name_from_site("//rules/example:10:2"),
            "//rules/example"
        );
        // A single trailing ':<digits>' segment is stripped too (treated as
        // a lone col with no line to also strip).
        assert_eq!(module_name_from_site("m.js:1"), "m.js");
    }
    #[test]
    fn source_globs_respect_gitignore_and_explicit_depth() {
        let parent = tempfile::tempdir().unwrap();
        write_file(&parent.path().join(".gitignore"), "*\n");
        let root = parent.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        write_file(&root.join(".gitignore"), "ignored/\n");
        write_file(&root.join("root.rs"), "fn main() {}\n");
        write_file(&root.join("src/nested.rs"), "fn nested() {}\n");
        write_file(&root.join("ignored/hidden.rs"), "ignored\n");
        write_file(&root.join(".hidden/visible.rs"), "visible\n");

        let direct = workspace_glob_files(&root, ".", &["*.rs".to_owned()], &[]).unwrap();
        assert_eq!(direct, vec!["root.rs"]);

        let explicit_directory =
            workspace_glob_files(&root, ".", &["src/*.rs".to_owned()], &[]).unwrap();
        assert_eq!(explicit_directory, vec!["src/nested.rs"]);

        let recursive = workspace_glob_files(&root, ".", &["**/*.rs".to_owned()], &[]).unwrap();
        assert_eq!(
            recursive,
            vec![".hidden/visible.rs", "root.rs", "src/nested.rs",]
        );
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
    #[test]
    fn workspace_files_excludes_non_matching_files() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join("rules/pkg/direct_test.js"), "");
        write_file(&p.join("rules/pkg/direct.js"), "");
        write_file(&p.join("rules/pkg/direct.rs"), "");

        assert_eq!(
            workspace_files(p, "//rules/pkg", "_test.js", false).unwrap(),
            ["//rules/pkg/direct_test"],
        );
        assert_eq!(
            workspace_files(p, "//rules/pkg", "", false).unwrap(),
            ["//rules/pkg/direct", "//rules/pkg/direct_test"],
        );
    }
    #[test]
    fn workspace_discovery_respects_gitignore_and_explicit_recursion() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(&p.join(".gitignore"), "rules/pkg/ignored/\n");
        write_file(&p.join("rules/pkg/direct_test.js"), "");
        write_file(&p.join("rules/pkg/nested/nested_test.js"), "");
        write_file(&p.join("rules/pkg/ignored/ignored_test.js"), "");

        assert_eq!(
            workspace_files(p, "//rules/pkg", "_test.js", false).unwrap(),
            ["//rules/pkg/direct_test"],
        );
        assert_eq!(
            workspace_files(p, "//rules/pkg", "_test.js", true).unwrap(),
            ["//rules/pkg/direct_test", "//rules/pkg/nested/nested_test"],
        );

        let include = [r"rules/pkg/.*_test\.js$".to_owned()];
        assert_eq!(
            workspace_source_files(p, "rules/pkg", &include, &[], false).unwrap(),
            ["rules/pkg/direct_test.js"],
        );
        assert_eq!(
            workspace_source_files(p, "rules/pkg", &include, &[], true).unwrap(),
            [
                "rules/pkg/direct_test.js",
                "rules/pkg/nested/nested_test.js"
            ],
        );
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
    #[test]
    fn normalize_graph_artifact_nests_under_real_path_not_slot_name() {
        // Two exec.action() outputs declared at distinct real paths, reused
        // under colliding/reused slot names (as ccTask()'s per-source compile
        // actions do for #84) — real-path nesting means they compose via
        // ordinary merge, not the slot-name collision this used to hit.
        let a =
            normalize_graph_artifact("object", &file_artifact("build/a.o", "digest-a")).unwrap();
        let b =
            normalize_graph_artifact("object", &file_artifact("build/b.o", "digest-b")).unwrap();
        let merged = merge_digests(vec![a, b]).unwrap();
        let files = list_files_in_digest(&merged).unwrap();
        assert!(files.contains(&"build/a.o".to_owned()), "{files:?}");
        assert!(files.contains(&"build/b.o".to_owned()), "{files:?}");
    }
    #[test]
    fn normalize_graph_artifact_same_real_path_differing_content_conflicts() {
        // Two producers legitimately declaring the same real output path
        // with different content must still fail loudly, even though their
        // slot names differ — the conflict is on the real path, not the
        // slot name.
        let a =
            normalize_graph_artifact("object0", &file_artifact("build/out.o", "digest-a")).unwrap();
        let b =
            normalize_graph_artifact("object1", &file_artifact("build/out.o", "digest-b")).unwrap();
        let error = match merge_digests(vec![a, b]) {
            Ok(_) => panic!("expected a merge conflict error"),
            Err(error) => error,
        };
        let message = format!("{error:#}");
        assert!(
            message.contains("merge conflict at 'build/out.o'"),
            "{message}"
        );
    }
    #[tokio::test]
    async fn luau_dynamic_expansion_selects_children_shares_inputs_and_publishes_packages() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path();
        write_file(&workspace.join(WORKSPACE_LUAU_FILE), "return {}\n");
        write_file(
            &workspace.join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/test")
local package = require("@imp/rules/workflows/package")
local output = core.output
local sh = core.native_tool("sh")
local metadata = core.task({
    inputs = { sh = sh },
    outputs = { targets = output.value() },
    run = function(exec)
        exec.action({ argv = { "sh", "-c", "true" }, tools = { sh } })
        return { targets = { alpha = true, beta = true } }
    end,
})
local targets = core.expand({
    display = "discover Luau test targets",
    inputs = { targets = metadata.outputs.targets },
    create = function(inputs)
        local children = {}
        for name in pairs(inputs.targets) do
            local child = name
            local build = core.task({
                inputs = { sh = sh },
                outputs = { selected = output.value() },
                run = function(exec)
                    exec.action({ argv = { "sh", "-c", "true" }, tools = { sh } })
                    return { selected = child }
                end,
            })
            local package_task = core.task({
                inputs = { sh = sh },
                outputs = { artifact = output.artifact() },
                run = function(exec)
                    local path = "build/package/"
                    if child == "alpha" then
                        path ..= "libalpha.so"
                    else
                        path ..= child .. ".txt"
                    end
                    local result = exec.action({
                        argv = { "sh", "-c", "printf " .. child .. " > " .. path },
                        tools = { sh },
                        outputs = { artifact = output.file(path) },
                    })
                    return { artifact = result.outputs.artifact }
                end,
            })
            children[child] = {
                BUILD = build,
                PACKAGE = package_task.outputs.artifact,
                TEST = build.outputs.selected,
            }
        end
        return children
    end,
})
return {
    targets = {
        BUILD = targets:all(core.BUILD),
        PACKAGE = targets:all(package.PACKAGE),
        TEST = targets:all(core.TEST),
    },
    alpha = { BUILD = targets:get("alpha", core.BUILD) },
}
"#,
        );
        let live = load_workspace_with_rules(workspace, RulesSource::discover())
            .await
            .unwrap();
        assert_eq!(
            live.workspace.goals.keys().collect::<Vec<_>>(),
            ["build", "package", "test"],
            "a Luau workspace offers only the goals that its workflow modules register"
        );

        run_goal_live(&live, workspace, "build", &["//:alpha".to_owned()])
            .await
            .unwrap();
        assert_eq!(
            live.luau.borrow().action_count(),
            1,
            "equivalent producer and child actions share execution"
        );

        run_goal_live(
            &live,
            workspace,
            "build",
            &["//:targets#alpha".to_owned(), "//:targets#beta".to_owned()],
        )
        .await
        .unwrap();
        assert_eq!(
            live.luau.borrow().action_count(),
            2,
            "equivalent child and producer actions share execution"
        );

        run_goal_live(&live, workspace, "package", &["//:targets".to_owned()])
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("dist/libalpha.so")).unwrap(),
            "alpha"
        );
        assert_eq!(
            std::fs::read_to_string(workspace.join("dist/targets#beta")).unwrap(),
            "beta"
        );

        // The children are build tasks, not test units, so the test workflow
        // receives each expansion child and rejects its value.
        let error = run_goal_live(&live, workspace, "test", &["//:targets".to_owned()])
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("a TEST root must resolve to a list"),
            "{error:#}"
        );

        let error = run_goal_live(
            &live,
            workspace,
            "build",
            &["//:targets#missing".to_owned()],
        )
        .await
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("expansion has no child 'missing'"),
            "{error:#}"
        );
    }
    #[tokio::test]
    async fn luau_task_consumes_an_expansion_child_as_an_input() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path();
        write_file(&workspace.join(WORKSPACE_LUAU_FILE), "return {}\n");
        write_file(
            &workspace.join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local output = core.output
local sh = core.native_tool("sh")
local metadata = core.task({
    inputs = { sh = sh },
    outputs = { names = output.value() },
    run = function(exec)
        exec.action({ argv = { "sh", "-c", "true" } })
        return { names = { "alpha", "beta" } }
    end,
})
local targets = core.expand({
    inputs = { names = metadata.outputs.names },
    create = function(inputs)
        local children = {}
        for _, name in ipairs(inputs.names) do
            local produce = core.task({
                inputs = { sh = sh },
                outputs = { file = output.artifact() },
                run = function(exec)
                    local result = exec.action({
                        argv = { "sh", "-c", `printf {name} > build/{name}.txt` },
                        outputs = { file = output.file(`build/{name}.txt`) },
                    })
                    return { file = result.outputs.file }
                end,
            })
            children[name] = { BUILD = produce.outputs.file }
        end
        return children
    end,
})
local function consumer(key)
    return core.task({
        inputs = { sh = sh, child = targets:get(key, core.BUILD) },
        outputs = { status = output.value() },
        run = function(exec, inputs)
            local path = exec.path(inputs.child)
            assert(path == "build/alpha.txt", path)
            exec.action({
                argv = { "sh", "-c", `read -r line < {path} || true; [ "$line" = alpha ]` },
                inputs = { inputs.child },
            })
            return { status = "ok" }
        end,
    })
end
return {
    consume = { BUILD = consumer("alpha") },
    missing = { BUILD = consumer("missing") },
}
"#,
        );
        let live = load_workspace_with_rules(workspace, RulesSource::discover())
            .await
            .unwrap();

        run_goal_live(&live, workspace, "build", &["//:consume".to_owned()])
            .await
            .unwrap();
        assert_eq!(
            live.luau.borrow().action_count(),
            3,
            "the consumer must run the producer, the selected child, and itself only"
        );

        let error = run_goal_live(&live, workspace, "build", &["//:missing".to_owned()])
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("expansion has no child 'missing'"),
            "{error:#}"
        );
    }
    fn selection_fixture() -> Workspace {
        let mut workspace = Workspace::default();
        for (address, kind, dependencies) in [
            ("//src/cpp/joltphysics:joltphysics", "cmake-source", vec![]),
            (
                "//src/cpp/joltphysics:cmake",
                "cmake",
                vec!["//src/cpp/joltphysics:joltphysics"],
            ),
            (
                "//library/jodin:jodin",
                "odin-package",
                vec!["//src/cpp/joltphysics:cmake"],
            ),
            ("//ui:ui", "odin-package", vec![]),
        ] {
            workspace.targets.insert(
                address.to_owned(),
                Target {
                    address: address.to_owned(),
                    kind: kind.to_owned(),
                    attrs: serde_json::json!({ "sources": ["**/*.odin"] }),
                    sources: vec![SourceField {
                        root: ".".to_owned(),
                        include: vec!["**/*.odin".to_owned()],
                        exclude: vec![],
                    }],
                    dependencies: dependencies
                        .into_iter()
                        .map(|address| Dependency {
                            address: address.to_owned(),
                            mode: DependencyMode::Auto,
                        })
                        .collect(),
                    js_id: 0,
                },
            );
        }
        workspace.products.insert(
            ("odin-package".to_owned(), "build".to_owned()),
            BTreeMap::from([("odin".to_owned(), "build".to_owned())]),
        );
        workspace
    }
    #[test]
    fn test_select_targets() {
        let workspace = selection_fixture();

        assert!(select_targets(&workspace, &[]).is_err());
        let all = select_targets(&workspace, &["//...".to_owned()]).unwrap();
        // joltphysics, cmake, jodin, ui = 4
        assert_eq!(all.len(), 4);

        let sel = select_targets(&workspace, &["library/jodin".to_owned()]).unwrap();
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
    #[test]
    fn test_format_targets() {
        let workspace = selection_fixture();
        let targets = select_targets(&workspace, &["library/jodin".to_owned()]).unwrap();
        let mut out = String::new();
        format_targets(&targets, &mut out).unwrap();
        assert!(out.contains("//library/jodin:jodin (odin-package)"));
        assert!(out.contains("sources: **/*.odin"));
        assert!(out.contains("dependencies: //src/cpp/joltphysics:cmake"));
    }
    #[test]
    fn test_format_dependencies() {
        let workspace = selection_fixture();
        let mut out = String::new();
        format_dependencies(
            &workspace,
            &["library/jodin".to_owned()],
            &SelectorContext::root(),
            &mut out,
        )
        .unwrap();
        let expected = "\
//library/jodin:jodin
└── //src/cpp/joltphysics:cmake
    └── //src/cpp/joltphysics:joltphysics
";
        assert_eq!(out, expected);
    }
    #[test]
    fn test_format_products() {
        let workspace = selection_fixture();
        let mut out = String::new();
        format_products(&workspace, &mut out).unwrap();
        assert!(out.contains("Target Kinds:"));
        assert!(out.contains("  - odin-package (build product: build)"));
        assert!(out.contains("Products:"));
        assert!(out.contains("  odin-package:"));
        assert!(out.contains("    - build"));
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }
    fn file_artifact(path: &str, digest: &str) -> CachedArtifact {
        CachedArtifact {
            artifact_id: format!("test-{path}"),
            kind: "file".to_owned(),
            path: Some(path.to_owned()),
            value: None,
            digest: digest.to_owned(),
            bytes: Some(0),
            mode: None,
            tree_digest: None,
            named_cache: None,
        }
    }
    async fn run_goal_live(
        live: &LiveWorkspace,
        root: &std::path::Path,
        goal: &str,
        selectors: &[String],
    ) -> Result<()> {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = imp_scheduler::Scheduler::new(
            1,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        *live.scheduler.lock().unwrap() = Some(scheduler);
        execute_goal_live(live, root, goal, selectors, false, 1, serde_json::json!({})).await
    }
}

#[cfg(test)]
fn matching_workspace_source_paths(
    workspace_root: &Path,
    root: &str,
    include: &[String],
    exclude: &[String],
    recursive: bool,
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

    let mut walker = ignore::WalkBuilder::new(&directory);
    walker
        .hidden(false)
        .ignore(true)
        .git_ignore(false)
        .add_custom_ignore_filename(".gitignore")
        .git_global(true)
        .git_exclude(true)
        .parents(false)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    let workspace_gitignore = workspace_root.join(".gitignore");
    if workspace_gitignore.is_file() {
        walker
            .current_dir(workspace_root)
            .add_ignore(workspace_gitignore);
    }
    if !recursive {
        walker.max_depth(Some(1));
    }

    let mut files = Vec::new();
    for entry in walker
        .build()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
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

#[cfg(test)]
fn compile_regexes(label: &str, patterns: &[String]) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(pattern).with_context(|| format!("compile {label} source regex {pattern:?}"))
        })
        .collect()
}
