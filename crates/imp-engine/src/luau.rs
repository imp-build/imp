//! The first production Luau graph-host slice.
//!
//! This loader is deliberately small. It hosts the graph operations used by
//! the asset pilot and keeps module resolution rooted in the workspace or the
//! installed rules tree. The existing JavaScript runtime remains the default
//! workspace runtime while the migration is in progress.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use crate::graph::GraphRoot;
use anyhow::{bail, Context, Result};
use imp_exec_api::{
    CacheOutcome, ExecAction, ExecIoSpec, ExecToolSpec, ExecutionService, SandboxRetention,
};
use imp_store::digest::{nest_directory, nest_file, DirectoryDigest, PathChange};
use lune::Runtime;
use mlua::prelude::*;
use mlua::{LuaSerdeExt, MetaMethod, UserDataFields, UserDataMethods};

#[derive(Clone, Default)]
struct ConfigurationState {
    schemas: BTreeMap<String, serde_json::Value>,
    values: BTreeMap<String, serde_json::Value>,
    declarations: BTreeMap<String, serde_json::Value>,
    sources: BTreeMap<String, String>,
    mode_axes: BTreeMap<String, serde_json::Value>,
    mode_profiles: BTreeMap<String, serde_json::Value>,
    invocation_values: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Clone)]
struct ModuleLoader {
    workspace_root: PathBuf,
    rules_root: PathBuf,
    stack: Rc<RefCell<Vec<String>>>,
    cache: Rc<RefCell<HashMap<String, LuaValue>>>,
    failure: Rc<RefCell<Option<String>>>,
}

#[derive(Clone)]
struct GraphHandle {
    id: u64,
    kind: &'static str,
    outputs: Option<LuaTable>,
}

#[derive(Clone)]
struct ExpansionHandle {
    id: u64,
    host: Rc<RefCell<HostState>>,
}

impl LuaUserData for ExpansionHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_method(
            "get",
            |lua, this, (key, workflow, facet): (String, String, Option<String>)| {
                create_expansion_projection(lua, &this.host, this.id, key, workflow, facet, false)
            },
        );
        methods.add_method(
            "all",
            |lua, this, (workflow, facet): (String, Option<String>)| {
                create_expansion_projection(
                    lua,
                    &this.host,
                    this.id,
                    String::new(),
                    workflow,
                    facet,
                    true,
                )
            },
        );
    }
}

impl LuaUserData for GraphHandle {
    fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
        fields.add_field_method_get("outputs", |_, this| {
            this.outputs
                .clone()
                .ok_or_else(|| LuaError::external(format!("{} has no named outputs", this.kind)))
        });
    }

    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(MetaMethod::Index, |_, this, key: String| {
            this.outputs
                .as_ref()
                .and_then(|outputs| outputs.get::<LuaValue>(key.clone()).ok())
                .ok_or_else(|| LuaError::external(format!("{} has no output '{key}'", this.kind)))
        });
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskOutputKind {
    Value,
    Artifact,
}

#[derive(Clone)]
enum OutputDeclaration {
    Value,
    Artifact,
    File(String),
    Directory {
        path: String,
        named_cache: Option<imp_store::cache::OutputNamedCache>,
    },
}

struct OutputDeclarationHandle(OutputDeclaration);

impl LuaUserData for OutputDeclarationHandle {}

#[derive(Clone)]
struct Task {
    exec_options: TaskExecOptions,
    run: LuaFunction,
    inputs: LuaTable,
    outputs: BTreeMap<String, TaskOutputKind>,
}

#[derive(Clone)]
struct TaskExecOptions {
    returns_outputs: bool,
    display: Option<String>,
    cache: bool,
}

impl Default for TaskExecOptions {
    fn default() -> Self {
        Self {
            returns_outputs: true,
            display: None,
            cache: true,
        }
    }
}

#[derive(Clone)]
struct Program {
    inputs: LuaTable,
    describe: LuaFunction,
    loader: ModuleLoader,
    stack: Vec<String>,
}

#[derive(Clone)]
struct Expansion {
    inputs: LuaTable,
    create: LuaFunction,
    display: String,
}

#[derive(Clone)]
struct LuauTestCase {
    name: String,
    suite: Option<String>,
    run: LuaFunction,
}

#[derive(Clone)]
struct LuauBuildGenerator {
    namespace: String,
    generate: LuaFunction,
}

#[derive(Clone)]
struct LuauBuildRule {
    module: String,
    export: String,
}

#[derive(serde::Deserialize)]
struct GeneratedLuauBuildTarget {
    name: String,
    rule: String,
    #[serde(default = "empty_json_object")]
    props: serde_json::Value,
}

fn empty_json_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// One execution unit of a resolved `TEST` root.
struct TestUnit {
    name: String,
    ok: bool,
    output: String,
}

/// A goal that a Luau workflow module registered with `core.goal`.
#[derive(Clone)]
struct LuauGoal {
    callback: LuaFunction,
    /// Declared boolean flags and their optional descriptions.
    flags: BTreeMap<String, Option<String>>,
    /// True for `selection = "none"`: the goal takes no target selectors,
    /// and the driver calls its callback with an empty roots array.
    selectorless: bool,
}

/// The state of the goal that the generic driver is running.
/// The error that `core.goal_error` raises. The driver finds it in the
/// callback error chain and shows only its message. A different error that
/// the callback raises later keeps its full context.
#[derive(Debug)]
struct GoalRefusal(String);

impl std::fmt::Display for GoalRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for GoalRefusal {}

struct GoalInvocation {
    flags: serde_json::Value,
    run_args: Vec<String>,
}

/// The root slot key for a goal name, for example `BUILD` for `build` and
/// `GENERATE_BUILD` for `generate-build`.
fn goal_slot_key(goal: &str) -> String {
    goal.to_uppercase().replace('-', "_")
}

fn is_slot_key(key: &str) -> bool {
    key.starts_with(|first: char| first.is_ascii_uppercase())
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

#[derive(Clone)]
struct FileSetSpec {
    source_root: Option<PathBuf>,
    root: String,
    include: Vec<String>,
    exclude: Vec<String>,
}

#[derive(Clone)]
enum GraphNode {
    Mode(String),
    Configured {
        source_id: u64,
        overrides: ModeScope,
    },
    Files(FileSetSpec),
    NativeTool(String),
    /// The running Imp executable, available to actions as the `imp` tool.
    SelfTool,
    Path {
        source_id: u64,
        owner_package: String,
    },
    Tool {
        name: String,
        bin_dirs: Vec<String>,
        source_id: u64,
        owner_package: String,
    },
    Task,
    Program(Program),
    TestRoot {
        package: String,
    },
    TaskOutput {
        task_id: u64,
        name: String,
    },
    ExpansionGet {
        expansion_id: u64,
        key: String,
        workflow: String,
        facet: Option<String>,
    },
    ExpansionAll {
        expansion_id: u64,
        workflow: String,
        facet: Option<String>,
    },
    Artifact(imp_store::cache::CachedArtifact),
}

struct HostState {
    cache_details: BTreeMap<String, LuaTable>,
    cached_tool_bindings: Option<HashMap<u64, imp_store::cache::OutputNamedCache>>,
    next_id: u64,
    next_expansion_id: u64,
    tasks: HashMap<u64, Task>,
    expansions: HashMap<u64, Expansion>,
    expansion_results: HashMap<(u64, String), LuaTable>,
    graph_run_active: bool,
    task_results: HashMap<(u64, String), LuaTable>,
    invocation_mode: ModeScope,
    resolved_inputs: HashMap<(u64, ModeScope), ResolvedInput>,
    configured_handles: BTreeMap<(u64, ModeScope), GraphHandle>,
    nodes: HashMap<u64, GraphNode>,
    filesets: HashMap<String, u64>,
    loaded_roots: Vec<u64>,
    action_count: usize,
    cache_hit_count: usize,
    tools: HashMap<String, u64>,
    paths: HashMap<String, u64>,
    goals: BTreeMap<String, LuauGoal>,
    goal_invocation: Option<GoalInvocation>,
    goal_callback_active: bool,
    ui_multi: Option<indicatif::MultiProgress>,
    lua: Option<mlua::WeakLua>,
    build_generators: Vec<LuauBuildGenerator>,
    build_rules: BTreeMap<String, LuauBuildRule>,
    workspace_root: PathBuf,
    workspace_id: String,
    service: Arc<dyn ExecutionService>,
    scheduler: Option<Arc<imp_scheduler::Scheduler>>,
    cancellation: Arc<AtomicBool>,
    task_failure: Option<String>,
    test_case_active: bool,
    graph_callback_depth: usize,
    program_describing: bool,
    fakes: TestFakes,
}

pub(crate) struct LuauSchedulerGuard {
    host: Rc<RefCell<HostState>>,
    previous: Option<Arc<imp_scheduler::Scheduler>>,
}

impl Drop for LuauSchedulerGuard {
    fn drop(&mut self) {
        self.host.borrow_mut().scheduler = self.previous.take();
    }
}

/// Host replacements that a running Luau test case installs with the
/// `core.test.with_fake_*` functions. Each field holds the recorder table that
/// the fake writes to. `None` means that the real host is active.
#[derive(Default)]
struct TestFakes {
    run: Option<LuaTable>,
    toolchain: Option<LuaTable>,
    platform: Option<(String, String)>,
    write_workspace: Option<LuaTable>,
    goal_flags: Option<LuaTable>,
    diff: Option<LuaTable>,
}

/// An opt-in Luau workspace runtime for the graph-host pilot.
///
/// The runtime currently exposes the narrow graph API used by `rules/asset`.
/// It is separate from [`crate::runtime::LiveWorkspace`] until the catalog
/// migration establishes the complete host contract.
pub struct LuauWorkspace {
    runtime: Runtime,
    loader: ModuleLoader,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
}

impl LuauWorkspace {
    /// Create a Luau runtime for a workspace and an on-disk installed rules
    /// tree. Rule modules are read from files; they are not embedded.
    pub fn new(workspace_root: &Path, rules_root: &Path) -> Result<Self> {
        Self::new_with_service(
            workspace_root,
            rules_root,
            Arc::new(imp_execution::service::LocalExecutionService::new()),
        )
    }

    /// Create a Luau runtime using the workspace's configured execution
    /// service. Graph actions then use Imp's hermetic executor and CAS.
    pub fn new_with_service(
        workspace_root: &Path,
        rules_root: &Path,
        service: Arc<dyn ExecutionService>,
    ) -> Result<Self> {
        let workspace_root = dunce::canonicalize(workspace_root)
            .with_context(|| format!("canonicalize workspace {}", workspace_root.display()))?;
        let rules_root = dunce::canonicalize(rules_root)
            .with_context(|| format!("canonicalize rules tree {}", rules_root.display()))?;
        let workspace_id = imp_store::cache::workspace_cache_id(&workspace_root);
        let loader = ModuleLoader {
            workspace_root: workspace_root.clone(),
            rules_root,
            stack: Rc::new(RefCell::new(Vec::new())),
            cache: Rc::new(RefCell::new(HashMap::new())),
            failure: Rc::new(RefCell::new(None)),
        };
        let host = Rc::new(RefCell::new(HostState {
            cache_details: BTreeMap::new(),
            cached_tool_bindings: None,
            next_id: 0,
            next_expansion_id: 0,
            tasks: HashMap::new(),
            expansions: HashMap::new(),
            expansion_results: HashMap::new(),
            graph_run_active: false,
            task_results: HashMap::new(),
            invocation_mode: ModeScope::new(),
            resolved_inputs: HashMap::new(),
            configured_handles: BTreeMap::new(),
            nodes: HashMap::new(),
            filesets: HashMap::new(),
            loaded_roots: Vec::new(),
            action_count: 0,
            cache_hit_count: 0,
            tools: HashMap::new(),
            paths: HashMap::new(),
            goals: BTreeMap::new(),
            goal_invocation: None,
            goal_callback_active: false,
            ui_multi: None,
            lua: None,
            build_generators: Vec::new(),
            build_rules: BTreeMap::new(),
            workspace_id,
            workspace_root: workspace_root.clone(),
            service,
            scheduler: None,
            cancellation: Arc::new(AtomicBool::new(false)),
            task_failure: None,
            test_case_active: false,
            graph_callback_depth: 0,
            program_describing: false,
            fakes: TestFakes::default(),
        }));
        let configuration = Rc::new(RefCell::new(ConfigurationState::default()));

        let core_loader = loader.clone();
        let core_host = Rc::clone(&host);
        let core_configuration = Rc::clone(&configuration);
        let runtime = Runtime::new()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .with_lib("@imp/core", move |lua| {
                create_core(
                    lua,
                    core_host.clone(),
                    core_loader.clone(),
                    core_configuration.clone(),
                )
            })
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;

        let bootstrap_loader = loader.clone();
        let bootstrap_host = Rc::clone(&host);
        let bootstrap_configuration = Rc::clone(&configuration);
        let runtime = runtime
            .with_lib("@imp/bootstrap", move |lua| {
                let core = lua
                    .globals()
                    .get::<LuaFunction>("require")?
                    .call::<LuaTable>("@imp/core")?;
                install_require(lua, core, bootstrap_loader.clone(), bootstrap_host.clone())?;
                install_task_executor(
                    lua,
                    bootstrap_host.clone(),
                    bootstrap_configuration.clone(),
                )?;
                install_expansion_executor(
                    lua,
                    bootstrap_host.clone(),
                    bootstrap_configuration.clone(),
                )?;
                Ok(LuaValue::Nil)
            })
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;

        Ok(Self {
            runtime,
            loader,
            host,
            configuration,
        })
    }

    /// Evaluate a workspace or installed-rule module by its canonical
    /// address, for example `@workspace/BUILD` or `@imp/rules/asset`.
    pub async fn evaluate(&mut self, address: &str) -> Result<LuaValue> {
        let (path, canonical) = resolve_address(&self.loader, address, None)
            .map_err(|error| anyhow::anyhow!("resolve Luau module '{address}': {error}"))?;
        let source = fs::read_to_string(&path)
            .with_context(|| format!("read Luau module {}", path.display()))?;
        self.loader.stack.borrow_mut().push(canonical.clone());
        let result = self.runtime.run_custom(&canonical, &source).await;
        self.loader.stack.borrow_mut().pop();
        if let Some(failure) = self.loader.failure.borrow_mut().take() {
            bail!("{failure}");
        }
        let result =
            result.map_err(|error| anyhow::anyhow!("evaluate Luau module {canonical}: {error}"))?;
        if !result.success() {
            bail!(
                "evaluate Luau module {canonical} failed with status {}",
                result.status()
            );
        }
        Ok(result.values.front().cloned().unwrap_or(LuaValue::Nil))
    }

    /// Evaluate Luau workspace config and BUILD modules, then return their
    /// exported build graph roots.
    pub async fn load_modules(&mut self) -> Result<Vec<GraphRoot>> {
        let roots = self
            .load_modules_with_ci_overlay(std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"))
            .await?;
        let (axes, profiles) = self.mode_registry();
        let mode = crate::spike::resolve_mode_registry(&axes, &profiles, None, &[])?;
        self.set_invocation_mode(mode, None)?;
        self.configuration.borrow_mut().invocation_values = None;
        Ok(roots)
    }

    pub fn mode_registry(
        &self,
    ) -> (
        BTreeMap<String, serde_json::Value>,
        BTreeMap<String, serde_json::Value>,
    ) {
        let state = self.configuration.borrow();
        (state.mode_axes.clone(), state.mode_profiles.clone())
    }

    pub fn set_invocation_mode(
        &mut self,
        mode: serde_json::Value,
        profile: Option<&str>,
    ) -> Result<()> {
        self.host.borrow_mut().invocation_mode = serde_json::from_value(mode.clone())?;
        let mut state = self.configuration.borrow_mut();
        let mut values = BTreeMap::new();
        values.insert("imp.mode".to_owned(), mode);
        if let Some(odin) = profile
            .and_then(|name| state.mode_profiles.get(name))
            .and_then(|p| p.get("odin"))
        {
            values.insert("odin".to_owned(), odin.clone());
        }
        state.invocation_values = Some(values);
        Ok(())
    }

    pub(crate) fn clear_invocation_mode(&mut self) {
        self.host.borrow_mut().invocation_mode.clear();
        self.configuration.borrow_mut().invocation_values = None;
    }

    pub(crate) fn scheduler_scope(
        &self,
        scheduler: Option<Arc<imp_scheduler::Scheduler>>,
    ) -> LuauSchedulerGuard {
        let previous = std::mem::replace(&mut self.host.borrow_mut().scheduler, scheduler);
        LuauSchedulerGuard {
            host: Rc::clone(&self.host),
            previous,
        }
    }

    pub fn begin_graph_run(&mut self, cancellation: Arc<AtomicBool>) {
        let mut host = self.host.borrow_mut();
        if host.invocation_mode.is_empty() {
            host.invocation_mode = self
                .configuration
                .borrow()
                .mode_axes
                .iter()
                .map(|(name, def)| {
                    (
                        name.clone(),
                        def["default"]
                            .as_str()
                            .expect("validated default")
                            .to_owned(),
                    )
                })
                .collect();
        }
        host.task_results.clear();
        host.resolved_inputs.clear();
        host.expansion_results.clear();
        host.graph_run_active = true;
        host.cancellation = cancellation;
    }

    pub fn expansion_projection_is_all(&self, handle_id: u32) -> Option<bool> {
        match unconfigured_node(&self.host.borrow(), handle_id as u64).1 {
            Some(GraphNode::ExpansionAll { .. }) => Some(true),
            Some(GraphNode::ExpansionGet { .. }) => Some(false),
            _ => None,
        }
    }

    /// Resolve one selected expansion projection to its concrete graph roots.
    /// The expansion callback runs once per graph invocation, after its input
    /// tasks have completed.
    pub async fn resolve_expansion_root(&mut self, root: &GraphRoot) -> Result<Vec<GraphRoot>> {
        let (base_id, scope) = scoped_node(
            &self.host.borrow(),
            root.handle_id as u64,
            &invocation_mode(&self.host.borrow()),
        );
        let node = self.host.borrow().nodes.get(&base_id).cloned();
        let projection = match node {
            Some(GraphNode::ExpansionGet {
                expansion_id,
                key,
                workflow,
                facet,
            }) => Some((expansion_id, Some(key), workflow, facet)),
            Some(GraphNode::ExpansionAll {
                expansion_id,
                workflow,
                facet,
            }) => Some((expansion_id, None, workflow, facet)),
            _ => None,
        };
        let Some((expansion_id, selected_key, workflow, facet)) = projection else {
            return Ok(vec![root.clone()]);
        };
        let lua = self.lua()?;
        let (children, _) = discover_mode_expansion(
            &lua,
            &self.host,
            &self.configuration,
            expansion_id,
            &scope,
            &[],
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!("discover Luau expansion for {}: {error}", root.address)
        })?;
        let keys = if let Some(key) = selected_key.as_ref() {
            if children
                .get::<Option<LuaValue>>(key.as_str())
                .map_err(|error| anyhow::anyhow!(error.to_string()))?
                .is_none()
            {
                bail!("expansion has no child '{key}'");
            }
            vec![key.clone()]
        } else {
            let mut keys = Vec::new();
            for pair in children.pairs::<String, LuaValue>() {
                keys.push(pair.map_err(|error| anyhow::anyhow!(error.to_string()))?.0);
            }
            keys.sort();
            keys
        };
        let mut roots = Vec::with_capacity(keys.len());
        for key in keys {
            let child = children.get::<LuaValue>(key.as_str()).map_err(|error| {
                anyhow::anyhow!("expansion child '{key}' could not be read: {error}")
            })?;
            let workflow_value = match child {
                LuaValue::Table(table) => table
                    .get::<LuaValue>(workflow.as_str())
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?,
                _ => bail!("expansion child '{key}' must contain workflow handles"),
            };
            let workflow_value = if let Some(facet) = facet.as_deref() {
                workflow_value
                    .as_table()
                    .with_context(|| format!("expansion child '{key}' has no facet '{facet}'"))?
                    .get::<LuaValue>(facet)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?
            } else {
                workflow_value
            };
            let LuaValue::UserData(userdata) = workflow_value else {
                bail!("expansion child '{key}' has no requested {workflow} workflow handle");
            };
            let handle = userdata
                .borrow::<GraphHandle>()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            validate_expansion_child(&self.host.borrow(), handle.id, &workflow, &key)?;
            let overrides: ModeScope = scope
                .iter()
                .filter(|(axis, value)| {
                    self.host.borrow().invocation_mode.get(*axis) != Some(*value)
                })
                .map(|(axis, value)| (axis.clone(), value.clone()))
                .collect();
            let handle = if overrides.is_empty() {
                handle.clone()
            } else {
                configured_handle(&lua, &self.host, &handle, overrides)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?
            };
            let address = if selected_key.is_some() {
                root.address.clone()
            } else {
                format!("{}#{key}", root.address)
            };
            roots.push(GraphRoot {
                address,
                workflow: root.workflow.clone(),
                facet: root.facet.clone(),
                handle_id: handle.id as u32,
                is_default: false,
            });
        }
        Ok(roots)
    }

    async fn load_modules_with_ci_overlay(
        &mut self,
        include_ci_overlay: bool,
    ) -> Result<Vec<GraphRoot>> {
        self.host.borrow_mut().loaded_roots.clear();
        let workspace_config = self.loader.workspace_root.join("imp.workspace.luau");
        if workspace_config.is_file() {
            let value = self.evaluate("@workspace/imp.workspace").await?;
            self.merge_config_value(value, "@workspace/imp.workspace")?;
        }
        self.materialize_config_defaults()?;
        if include_ci_overlay
            && self
                .loader
                .workspace_root
                .join("imp.workspace.ci.luau")
                .is_file()
        {
            let value = self.evaluate("@workspace/imp.workspace.ci").await?;
            self.merge_config_value(value, "@workspace/imp.workspace.ci")?;
        }
        self.finalize_config_values()?;

        let mut walker = ignore::WalkBuilder::new(&self.loader.workspace_root);
        walker
            .git_ignore(false)
            .add_custom_ignore_filename(".gitignore")
            .parents(false)
            .require_git(false);
        let mut build_files: Vec<PathBuf> = walker
            .build()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry.file_type().is_some_and(|kind| kind.is_file())
                    && entry.file_name() == "BUILD.luau"
            })
            .map(|entry| entry.into_path())
            .collect();
        build_files.sort();

        let mut roots = Vec::new();
        let mut slot_roots = Vec::new();
        for file in build_files {
            let relative = file
                .strip_prefix(&self.loader.workspace_root)
                .context("Luau BUILD file is outside the workspace")?
                .to_string_lossy()
                .replace('\\', "/");
            let module = format!(
                "@workspace/{}",
                relative.strip_suffix(".luau").unwrap_or(&relative)
            );
            let exports = self
                .evaluate(&module)
                .await?
                .as_table()
                .cloned()
                .with_context(|| format!("Luau BUILD module '{module}' must return a table"))?;
            let package = Path::new(&relative)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            for pair in exports.pairs::<String, LuaValue>() {
                let (name, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let address = if package.is_empty() {
                    format!("//:{name}")
                } else {
                    format!("//{package}:{name}")
                };
                let mut handles = Vec::new();
                match value {
                    LuaValue::UserData(userdata) => {
                        if let Ok(handle) = userdata.borrow::<GraphHandle>() {
                            handles.push((handle.id, "BUILD".to_owned()));
                        }
                    }
                    LuaValue::Table(table) => {
                        for pair in table.pairs::<LuaValue, LuaValue>() {
                            let (key, value) =
                                pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
                            let (LuaValue::String(key), LuaValue::UserData(userdata)) =
                                (key, value)
                            else {
                                continue;
                            };
                            let key = key.to_string_lossy().to_string();
                            if !is_slot_key(&key) {
                                continue;
                            }
                            if let Ok(handle) = userdata.borrow::<GraphHandle>() {
                                handles.push((handle.id, key));
                            }
                        }
                    }
                    _ => {}
                }
                handles.sort_by(|left, right| left.1.cmp(&right.1));
                for (handle_id, slot) in handles {
                    let state = self.host.borrow();
                    // Other values, such as tool or file handles, are not roots.
                    let valid = match unconfigured_node(&state, handle_id).1 {
                        Some(
                            GraphNode::Task
                            | GraphNode::TaskOutput { .. }
                            | GraphNode::ExpansionGet { .. }
                            | GraphNode::ExpansionAll { .. },
                        ) => true,
                        Some(GraphNode::Program(_)) => {
                            if slot != "RUN" {
                                bail!("program root {address} must use the RUN slot");
                            }
                            true
                        }
                        Some(GraphNode::TestRoot { .. }) => slot == "TEST",
                        _ => false,
                    };
                    if valid {
                        slot_roots.push((address.clone(), slot, handle_id));
                    }
                }
            }
        }
        // Resolve slots after every module has loaded, so that the result does
        // not depend on which module required a workflow first.
        let state = self.host.borrow();
        for (address, slot, handle_id) in slot_roots {
            let workflow = state
                .goals
                .keys()
                .find(|goal| goal_slot_key(goal) == slot)
                .cloned()
                .with_context(|| {
                    format!(
                        "{address} exports slot '{slot}', but no goal registers it; require @imp/rules/workflows/{}",
                        slot.to_lowercase()
                    )
                })?;
            roots.push(GraphRoot {
                address,
                workflow,
                facet: None,
                handle_id: handle_id as u32,
                is_default: false,
            });
        }
        drop(state);
        crate::graph::GraphCatalog {
            roots: roots.clone(),
        }
        .validate()?;
        self.host.borrow_mut().loaded_roots =
            roots.iter().map(|root| root.handle_id as u64).collect();
        Ok(roots)
    }

    /// Goals that Luau workflow modules registered, with their declared
    /// flags, in the form that the CLI parses.
    pub fn goal_definitions(&self) -> BTreeMap<String, crate::spike::Goal> {
        self.host
            .borrow()
            .goals
            .iter()
            .map(|(name, goal)| {
                let flags = goal
                    .flags
                    .iter()
                    .map(|(flag, description)| {
                        (
                            flag.clone(),
                            crate::spike::GoalFlagDef {
                                description: description.clone(),
                            },
                        )
                    })
                    .collect();
                (
                    name.clone(),
                    crate::spike::Goal {
                        name: name.clone(),
                        product: name.clone(),
                        flags,
                        selectorless: goal.selectorless,
                    },
                )
            })
            .collect()
    }

    /// Give streamed program output a way to suspend the live progress UI.
    pub fn set_ui_multi(&mut self, multi: Option<indicatif::MultiProgress>) {
        self.host.borrow_mut().ui_multi = multi;
    }

    /// Run a goal through its registered Luau workflow callback.
    ///
    /// The driver resolves each selected root to a value and calls the
    /// callback once with an array of `{ address, result }`. It has no list
    /// of goal names: all goal policy is in the workflow module. A string
    /// that the callback returns is the goal report.
    pub async fn execute_graph(
        &mut self,
        goal: &str,
        roots: &[GraphRoot],
        cancellation: Arc<AtomicBool>,
        flags: &serde_json::Value,
        run_args: &[String],
    ) -> Result<Option<String>> {
        if !self.host.borrow().graph_run_active {
            self.begin_graph_run(Arc::clone(&cancellation));
        } else {
            self.host.borrow_mut().cancellation = Arc::clone(&cancellation);
        }
        self.host.borrow_mut().goal_invocation = Some(GoalInvocation {
            flags: flags.clone(),
            run_args: run_args.to_vec(),
        });
        let result = self.execute_graph_inner(goal, roots, flags).await;
        let mut host = self.host.borrow_mut();
        host.graph_run_active = false;
        host.goal_invocation = None;
        host.goal_callback_active = false;
        host.invocation_mode.clear();
        self.configuration.borrow_mut().invocation_values = None;
        result
    }

    async fn execute_graph_inner(
        &mut self,
        goal: &str,
        roots: &[GraphRoot],
        flags: &serde_json::Value,
    ) -> Result<Option<String>> {
        let (callback, selectorless) = self
            .host
            .borrow()
            .goals
            .get(goal)
            .map(|goal| (goal.callback.clone(), goal.selectorless))
            .with_context(|| {
                format!(
                    "goal '{goal}' has no registered Luau workflow; require @imp/rules/workflows/{}",
                    goal.replace('-', "_")
                )
            })?;
        // As in JavaScript, a goal with no selected roots does not call its
        // workflow, unless the goal takes no selection.
        if roots.is_empty() && !selectorless {
            return Ok(None);
        }
        let lua = self.lua()?;
        let case_filter = flags.get("case").and_then(serde_json::Value::as_str);
        let suite_filter = flags.get("suite").and_then(serde_json::Value::as_str);
        let entries = lua.create_table().map_err(lua_err)?;
        let mut test_roots = 0;
        let mut test_units = 0;
        for root in roots {
            let package = match unconfigured_node(&self.host.borrow(), root.handle_id as u64).1 {
                Some(GraphNode::TestRoot { package }) => Some(package.clone()),
                _ => None,
            };
            let program = match unconfigured_node(&self.host.borrow(), root.handle_id as u64).1 {
                Some(GraphNode::Program(program)) => Some(program.clone()),
                _ => None,
            };
            let root_scope = scoped_node(
                &self.host.borrow(),
                root.handle_id as u64,
                &invocation_mode(&self.host.borrow()),
            )
            .1;
            let result = if let Some(program) = program {
                describe_program_scoped(&lua, &self.host, &self.configuration, program, &root_scope)
                    .await
                    .map_err(lua_err)?
            } else if let Some(package) = package {
                let units = self
                    .run_test_root(&package, case_filter, suite_filter, &root_scope)
                    .await?;
                test_roots += 1;
                test_units += units.len();
                test_units_value(&lua, units).map_err(lua_err)?
            } else {
                let script = format!("return __imp_execute_task({})", root.handle_id);
                let value = self
                    .run_script_value("@imp/goal-root", &script)
                    .await
                    .with_context(|| format!("execute Luau graph root {}", root.address))?;
                let value = single_output_value(&self.host.borrow(), root.handle_id as u64, value)
                    .map_err(lua_err)?;
                plain_goal_value(&lua, &self.host, value, 0).map_err(lua_err)?
            };
            push_goal_entry(&lua, &entries, &root.address, result).map_err(lua_err)?;
        }
        if test_roots > 0 && test_units == 0 && (case_filter.is_some() || suite_filter.is_some()) {
            let filter = case_filter
                .map(|name| format!("case '{name}'"))
                .or_else(|| suite_filter.map(|name| format!("suite '{name}'")))
                .unwrap_or_default();
            bail!("no {filter} found in selected test roots");
        }
        self.host.borrow_mut().goal_callback_active = true;
        let outcome = callback.call_async::<LuaValue>(entries).await;
        let mut host = self.host.borrow_mut();
        host.goal_callback_active = false;
        host.task_failure = None;
        drop(host);
        match outcome {
            Ok(LuaValue::String(report)) => Ok(Some(report.to_string_lossy().to_string())),
            Ok(_) => Ok(None),
            Err(error) => {
                let refusal = error
                    .chain()
                    .find_map(|cause| cause.downcast_ref::<GoalRefusal>());
                match refusal {
                    Some(GoalRefusal(message)) => {
                        log::debug!("goal '{goal}' callback: {error}");
                        Err(anyhow::Error::new(crate::spike::UserFacingGoalError(
                            message.clone(),
                        )))
                    }
                    None => Err(anyhow::anyhow!("goal '{goal}' callback: {error}")),
                }
            }
        }
    }

    /// Resolve a registered CLI tool through its graph path output.
    pub async fn resolve_tool_bin(
        &mut self,
        name: &str,
        scheduler: Option<Arc<imp_scheduler::Scheduler>>,
    ) -> Result<PathBuf> {
        let cancellation = scheduler
            .as_ref()
            .map(|scheduler| scheduler.cancellation_flag())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let _scheduler_guard = self.scheduler_scope(scheduler);
        let result = async {
            let resolver = self
                .run_script_value(
                    "@imp/cli-tool-registry",
                    "return require(\"@imp/rules/imp/toolchain\").resolve",
                )
                .await?;
            let resolver = resolver.as_function().context("invalid tool registry")?;
            let output: LuaValue = resolver.call(name).map_err(lua_err)?;
            let id = output
                .as_userdata()
                .and_then(|value| value.borrow::<GraphHandle>().ok())
                .filter(|handle| handle.kind == "task_output")
                .map(|handle| handle.id)
                .context("tool resolver must return a task output handle")?;
            self.begin_graph_run(cancellation);
            let value = self
                .run_script_value(
                    "@imp/cli-tool-path",
                    &format!("return __imp_execute_task({id})"),
                )
                .await?;
            let path = value
                .as_string()
                .context("tool path output must be a string")?
                .to_str()
                .map_err(lua_err)?
                .to_string();
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                bail!("tool path output must be a non-empty absolute path");
            }
            Ok(path)
        }
        .await;
        self.host.borrow_mut().graph_run_active = false;
        self.host.borrow_mut().task_failure = None;
        self.clear_invocation_mode();
        result.with_context(|| format!("resolve @{name} from Luau workspace"))
    }

    fn lua(&self) -> Result<Lua> {
        self.host
            .borrow()
            .lua
            .as_ref()
            .and_then(mlua::WeakLua::try_upgrade)
            .context("Luau runtime is not initialized")
    }

    fn configure_test_runtime(&self, runtime: &mut Self, scope: &ModeScope) -> Result<()> {
        *runtime.configuration.borrow_mut() = self.configuration.borrow().clone();
        runtime.host.borrow_mut().invocation_mode = scope.clone();
        runtime.host.borrow_mut().scheduler = self.host.borrow().scheduler.clone();
        runtime
            .configuration
            .borrow_mut()
            .invocation_values
            .get_or_insert_with(BTreeMap::new)
            .insert("imp.mode".to_owned(), serde_json::to_value(scope)?);
        Ok(())
    }

    async fn run_test_root(
        &self,
        package: &str,
        case_filter: Option<&str>,
        suite_filter: Option<&str>,
        scope: &ModeScope,
    ) -> Result<Vec<TestUnit>> {
        let directory = if package == "." {
            self.loader.workspace_root.clone()
        } else {
            self.loader.workspace_root.join(package)
        };
        let workspace_root = self.loader.workspace_root.clone();
        let package_directory = directory.clone();
        let package_depth = if package == "." {
            1
        } else {
            Path::new(package).components().count() + 1
        };
        let workspace_root_for_filter = workspace_root.clone();
        let mut walker = ignore::WalkBuilder::new(&workspace_root);
        walker
            .hidden(false)
            .ignore(true)
            .git_ignore(false)
            .add_custom_ignore_filename(".gitignore")
            .git_global(true)
            .git_exclude(true)
            .parents(false)
            .require_git(false)
            .max_depth(Some(package_depth))
            .filter_entry(move |entry| {
                entry.file_name() != ".git"
                    && (entry.path() == workspace_root_for_filter
                        || package_directory.starts_with(entry.path())
                        || entry.path().starts_with(&package_directory))
            });
        let workspace_gitignore = workspace_root.join(".gitignore");
        if workspace_gitignore.is_file() {
            walker
                .current_dir(&workspace_root)
                .add_ignore(workspace_gitignore);
        }
        let mut modules = Vec::new();
        for entry in walker.build() {
            let entry = entry
                .with_context(|| format!("discover test modules in {}", directory.display()))?;
            if entry.file_type().is_some_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().ends_with(".test.luau")
            {
                modules.push(entry.into_path());
            }
        }
        modules.sort();
        if modules.is_empty() {
            if case_filter.is_some() || suite_filter.is_some() {
                return Ok(Vec::new());
            }
            return Ok(vec![TestUnit {
                name: "discovery".to_owned(),
                ok: false,
                output: format!("no .test.luau modules found in {}", directory.display()),
            }]);
        }

        let rules_root = self.loader.rules_root.clone();
        let service = Arc::clone(&self.host.borrow().service);
        let mut units = Vec::new();
        for path in modules {
            if self.host.borrow().cancellation.load(Ordering::SeqCst) {
                bail!("Luau test run canceled");
            }
            let relative = path
                .strip_prefix(&workspace_root)
                .context("test module is outside the workspace")?
                .to_string_lossy()
                .replace('\\', "/");
            let module = format!("@workspace/{}", relative.trim_end_matches(".luau"));
            let mut discovery = LuauWorkspace::new_with_service(
                &workspace_root,
                &rules_root,
                Arc::clone(&service),
            )?;
            self.configure_test_runtime(&mut discovery, scope)?;
            let cases = match discovery.evaluate(&module).await {
                Ok(value) => match flatten_test_cases(value) {
                    Ok(cases) => cases,
                    Err(error) => {
                        units.push(TestUnit {
                            name: module.clone(),
                            ok: false,
                            output: format!("{module}: {error:#}"),
                        });
                        continue;
                    }
                },
                Err(error) => {
                    units.push(TestUnit {
                        name: module.clone(),
                        ok: false,
                        output: format!("{error:#}"),
                    });
                    continue;
                }
            };
            if cases.is_empty() {
                units.push(TestUnit {
                    name: module.clone(),
                    ok: false,
                    output: "test module returned no cases".to_owned(),
                });
                continue;
            }
            let selected = cases
                .iter()
                .enumerate()
                .filter(|(_, case)| {
                    case_filter.is_none_or(|filter| {
                        case.name == filter || case.name.ends_with(&format!(".{filter}"))
                    }) && suite_filter.is_none_or(|filter| {
                        case.suite.as_deref().is_some_and(|suite| {
                            suite == filter || suite.starts_with(&format!("{filter}."))
                        })
                    })
                })
                .map(|(ordinal, case)| {
                    let occurrence = cases[..ordinal]
                        .iter()
                        .filter(|previous| {
                            previous.name == case.name && previous.suite == case.suite
                        })
                        .count();
                    (case.name.clone(), case.suite.clone(), occurrence)
                })
                .collect::<Vec<_>>();
            for (case_name, case_suite, occurrence) in selected {
                if self.host.borrow().cancellation.load(Ordering::SeqCst) {
                    bail!("Luau test run canceled");
                }
                let mut runtime = match LuauWorkspace::new_with_service(
                    &workspace_root,
                    &rules_root,
                    Arc::clone(&service),
                ) {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        units.push(TestUnit {
                            name: format!("{module} {case_name}"),
                            ok: false,
                            output: format!("{error:#}"),
                        });
                        continue;
                    }
                };
                self.configure_test_runtime(&mut runtime, scope)?;
                runtime.host.borrow_mut().cancellation =
                    Arc::clone(&self.host.borrow().cancellation);
                let result = match runtime.evaluate(&module).await {
                    Ok(value) => match flatten_test_cases(value) {
                        Ok(cases) => {
                            let mut matches = cases
                                .into_iter()
                                .filter(|case| case.name == case_name && case.suite == case_suite);
                            if let Some(case) = matches.nth(occurrence) {
                                runtime.host.borrow_mut().test_case_active = true;
                                let result = case
                                    .run
                                    .call_async::<LuaValue>(())
                                    .await
                                    .map(|_| ())
                                    .map_err(|error| anyhow::anyhow!("{module}: {error}"));
                                runtime.host.borrow_mut().test_case_active = false;
                                result
                            } else {
                                Err(anyhow::anyhow!(
                                    "test case disappeared during isolated evaluation"
                                ))
                            }
                        }
                        Err(error) => Err(anyhow::anyhow!("{module}: {error}")),
                    },
                    Err(error) => Err(anyhow::anyhow!("{error:#}")),
                };
                units.push(match result {
                    Ok(()) => TestUnit {
                        name: format!("{module} {case_name}"),
                        ok: true,
                        output: String::new(),
                    },
                    Err(error) => TestUnit {
                        name: format!("{module} {case_name}"),
                        ok: false,
                        output: format!("{error:#}"),
                    },
                });
            }
        }
        Ok(units)
    }

    /// Query an existing named cache without acquiring tools.
    pub fn named_cache_details(
        &self,
        name: &str,
    ) -> impl std::future::Future<Output = Result<Option<String>>> + 'static {
        let options = self.host.borrow().cache_details.get(name).cloned();
        let host = Rc::clone(&self.host);
        let configuration = Rc::clone(&self.configuration);
        let name = name.to_owned();
        async move {
            let Some(options) = options else {
                return Ok(None);
            };
            match run_cache_details(&host, &configuration, options, false).await {
                Ok(value) => Ok(value),
                Err(error) => {
                    eprintln!("warning: named cache '{name}' details callback failed: {error}");
                    Ok(None)
                }
            }
        }
    }

    /// Execute a graph task created by `task()` through Imp's local or remote
    /// execution service.
    pub async fn execute_task(&mut self, handle: &LuaAnyUserData) -> Result<()> {
        let handle = handle
            .borrow::<GraphHandle>()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if handle.kind != "task" {
            bail!("expected a graph task handle, got {}", handle.kind);
        }
        let script = format!("return __imp_execute_task({})", handle.id);
        self.run_script("@imp/pilot-execute", &script).await
    }

    async fn run_script(&mut self, name: &str, source: &str) -> Result<()> {
        let result = self
            .runtime
            .run_custom(name, source)
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if let Some(failure) = self.host.borrow_mut().task_failure.take() {
            bail!("{failure}");
        }
        if !result.success() {
            bail!(
                "Luau script '{name}' failed with status {}",
                result.status()
            );
        }
        Ok(())
    }

    async fn run_script_value(&mut self, name: &str, source: &str) -> Result<LuaValue> {
        let result = self
            .runtime
            .run_custom(name, source)
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if let Some(failure) = self.host.borrow_mut().task_failure.take() {
            bail!("{failure}");
        }
        if !result.success() {
            bail!(
                "Luau script '{name}' failed with status {}",
                result.status()
            );
        }
        Ok(result.values.front().cloned().unwrap_or(LuaValue::Nil))
    }

    /// Number of actions accepted by the pilot adapter. Exposed for focused
    /// integration tests.
    pub fn action_count(&self) -> usize {
        self.host.borrow().action_count
    }

    #[cfg(test)]
    fn cache_hit_count(&self) -> usize {
        self.host.borrow().cache_hit_count
    }

    #[cfg(test)]
    fn task_result_count(&self) -> usize {
        self.host.borrow().task_results.len()
    }

    /// Return the merged and defaulted configuration exported by Luau config
    /// modules, including values configured by loaded rule or BUILD modules.
    pub fn workspace_config(&self) -> std::collections::BTreeMap<String, serde_json::Value> {
        self.configuration.borrow().values.clone()
    }

    /// Return the schemas registered by loaded Luau rule modules.
    pub fn configuration_schemas(&self) -> BTreeMap<String, serde_json::Value> {
        self.configuration.borrow().schemas.clone()
    }

    fn merge_config_value(&mut self, value: LuaValue, source: &str) -> Result<()> {
        let LuaValue::Table(table) = value else {
            bail!("{source}: workspace config must return a table");
        };
        let schemas = self.configuration.borrow().schemas.clone();
        for (namespace, schema) in schemas {
            let Some(config) = table
                .get::<Option<LuaValue>>(namespace.as_str())
                .map_err(|error| anyhow::anyhow!("{source}: read config.{namespace}: {error}"))?
            else {
                continue;
            };
            let config: serde_json::Value = serde_json::to_value(config).map_err(|error| {
                anyhow::anyhow!("{source}: config.{namespace} is not JSON-compatible: {error}")
            })?;
            let config = validate_config_value(&schema, &config, &namespace, false, false)
                .with_context(|| format!("{source}: invalid workspace configuration"))?;
            let mut state = self.configuration.borrow_mut();
            let declaration = state
                .declarations
                .entry(namespace.clone())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            merge_config_json(declaration, config.clone());
            let value = state
                .values
                .entry(namespace.clone())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            merge_config_json(value, config);
            state
                .sources
                .entry(namespace)
                .or_insert_with(|| source.to_owned());
        }
        Ok(())
    }

    fn finalize_config_values(&self) -> Result<()> {
        self.materialize_config_values(true)
    }

    fn materialize_config_defaults(&self) -> Result<()> {
        self.materialize_config_values(false)
    }

    fn materialize_config_values(&self, check_required: bool) -> Result<()> {
        let mut state = self.configuration.borrow_mut();
        let declarations = state.declarations.clone();
        for (namespace, declaration) in declarations {
            let schema = state
                .schemas
                .get(&namespace)
                .with_context(|| format!("configuration namespace '{namespace}' has no schema"))?;
            let source = state
                .sources
                .get(&namespace)
                .map(String::as_str)
                .unwrap_or("workspace configuration");
            let validated =
                validate_config_value(schema, &declaration, &namespace, true, check_required)
                    .with_context(|| format!("{source}: invalid workspace configuration"))?;
            let value = state
                .values
                .entry(namespace)
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            merge_config_json(value, validated);
        }
        Ok(())
    }
}

fn merge_config_json(existing: &mut serde_json::Value, patch: serde_json::Value) {
    match (existing, patch) {
        (serde_json::Value::Object(existing), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                if let Some(existing) = existing.get_mut(&key) {
                    merge_config_json(existing, value);
                } else {
                    existing.insert(key, value);
                }
            }
        }
        (existing, patch) => *existing = patch,
    }
}

fn validate_config_value(
    schema: &serde_json::Value,
    value: &serde_json::Value,
    path: &str,
    apply_defaults: bool,
    check_required: bool,
) -> Result<serde_json::Value> {
    if schema.get("__imp_field").is_none() {
        let input = value
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("config '{path}' must be a table"))?;
        let shape = schema
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("config schema at '{path}' must be a table"))?;
        for key in input.keys() {
            if !shape.contains_key(key) {
                bail!("config '{path}.{key}' is not declared in the schema");
            }
        }
        let mut output = serde_json::Map::new();
        for (key, field) in shape {
            let field_path = format!("{path}.{key}");
            if let Some(field_value) = input.get(key) {
                output.insert(
                    key.clone(),
                    validate_config_value(
                        field,
                        field_value,
                        &field_path,
                        apply_defaults,
                        check_required,
                    )?,
                );
            } else if apply_defaults {
                if let Some(default) = field.get("default") {
                    output.insert(
                        key.clone(),
                        validate_config_value(field, default, &field_path, true, check_required)?,
                    );
                } else if check_required
                    && field
                        .get("required")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                {
                    bail!("missing required config field '{field_path}'");
                }
            }
        }
        return Ok(serde_json::Value::Object(output));
    }

    let kind = schema
        .get("__imp_field")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("config schema at '{path}' has invalid field type"))?;
    match kind {
        "int" if value.as_i64().is_some() || value.as_u64().is_some() => Ok(value.clone()),
        "string" if value.is_string() => Ok(value.clone()),
        "bool" if value.is_boolean() => Ok(value.clone()),
        "enum" => {
            let values = schema
                .get("values")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| {
                    anyhow::anyhow!("config schema at '{path}' has invalid enum values")
                })?;
            if values.contains(value) {
                Ok(value.clone())
            } else {
                bail!("config '{path}' must be one of {values:?}");
            }
        }
        "object" => {
            let shape = schema
                .get("shape")
                .ok_or_else(|| anyhow::anyhow!("config schema at '{path}' has no object shape"))?;
            validate_config_value(shape, value, path, apply_defaults, check_required)
        }
        "map" => {
            let input = value
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("config '{path}' must be a table"))?;
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
                    apply_defaults,
                    check_required,
                )?;
                output.insert(
                    key.clone(),
                    validate_config_value(
                        value_schema,
                        item,
                        &item_path,
                        apply_defaults,
                        check_required,
                    )?,
                );
            }
            Ok(serde_json::Value::Object(output))
        }
        "array" => {
            let item_schema = schema.get("item").ok_or_else(|| {
                anyhow::anyhow!("config schema at '{path}' has no array item type")
            })?;
            if value.as_object().is_some_and(serde_json::Map::is_empty) {
                return Ok(serde_json::Value::Array(Vec::new()));
            }
            let items = value
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("config '{path}' must be an array"))?;
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    validate_config_value(
                        item_schema,
                        item,
                        &format!("{path}[{index}]"),
                        apply_defaults,
                        check_required,
                    )
                })
                .collect::<Result<Vec<_>>>()
                .map(serde_json::Value::Array)
        }
        "int" => bail!("config '{path}' must be an integer"),
        "string" => bail!("config '{path}' must be a string"),
        "bool" => bail!("config '{path}' must be a boolean"),
        other => bail!("config schema at '{path}' has unknown field type '{other}'"),
    }
}

fn install_require(
    lua: &Lua,
    core: LuaTable,
    loader: ModuleLoader,
    _host: Rc<RefCell<HostState>>,
) -> LuaResult<()> {
    let require = lua.create_function(move |lua, address: String| {
        if address == "@imp/core" {
            return Ok(LuaValue::Table(core.clone()));
        }
        let current = loader.stack.borrow().last().cloned();
        let (path, canonical) = resolve_address(&loader, &address, current.as_deref())?;
        if let Some(value) = loader.cache.borrow().get(&canonical).cloned() {
            return Ok(value);
        }
        if loader.stack.borrow().contains(&canonical) {
            let mut cycle = loader.stack.borrow().clone();
            cycle.push(canonical.clone());
            let message = format!("cyclic Luau module import: {}", cycle.join(" -> "));
            *loader.failure.borrow_mut() = Some(message.clone());
            return Err(LuaError::external(message));
        }
        let source = fs::read_to_string(&path).map_err(LuaError::external)?;
        loader.stack.borrow_mut().push(canonical.clone());
        let values = lua
            .load(source)
            .set_name(canonical.clone())
            .call::<LuaMultiValue>(());
        loader.stack.borrow_mut().pop();
        let values = values?;
        let value = values.front().cloned().unwrap_or(LuaValue::Nil);
        loader.cache.borrow_mut().insert(canonical, value.clone());
        Ok(value)
    })?;
    lua.globals().set("require", require)
}

type ModeScope = BTreeMap<String, String>;
type ModeAxes = std::collections::BTreeSet<String>;

#[derive(Clone)]
struct ResolvedInput {
    value: LuaValue,
    axes: ModeAxes,
}

fn mode_key(axes: &ModeAxes, scope: &ModeScope) -> String {
    serde_json::to_string(
        &axes
            .iter()
            .map(|axis| (axis, scope.get(axis)))
            .collect::<BTreeMap<_, _>>(),
    )
    .expect("mode values are strings")
}

fn invocation_mode(host: &HostState) -> ModeScope {
    host.invocation_mode.clone()
}

// Each edge carries its own scope. No callback reads a mutable current scope.
async fn resolve_mode_inputs(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    configuration: &Rc<RefCell<ConfigurationState>>,
    inputs: &LuaTable,
    scope: &ModeScope,
    visiting: &[u64],
) -> LuaResult<(LuaTable, ModeAxes)> {
    let resolved = lua.create_table()?;
    let mut axes = ModeAxes::new();
    for pair in inputs.pairs::<LuaValue, LuaValue>() {
        let (key, value) = pair?;
        let id = match &value {
            LuaValue::UserData(userdata) => userdata.borrow::<GraphHandle>().ok().map(|h| h.id),
            _ => None,
        };
        let leaf = id.is_some_and(|id| {
            matches!(
                host.borrow().nodes.get(&id),
                Some(
                    GraphNode::Files(_)
                        | GraphNode::NativeTool(_)
                        | GraphNode::SelfTool
                        | GraphNode::Artifact(_)
                )
            )
        });
        let value = if leaf {
            value
        } else if let Some(id) = id {
            let input = resolve_mode_handle(lua, host, configuration, id, scope, visiting).await?;
            let preserve_handle = input.axes.is_empty() && {
                let state = host.borrow();
                match state.nodes.get(&id) {
                    Some(GraphNode::Tool { source_id, .. } | GraphNode::Path { source_id, .. }) => {
                        matches!(
                            state.nodes.get(source_id),
                            Some(GraphNode::TaskOutput { .. } | GraphNode::Artifact(_))
                        )
                    }
                    _ => false,
                }
            };
            axes.extend(input.axes);
            if preserve_handle {
                value
            } else {
                input.value
            }
        } else {
            value
        };
        resolved.set(key, value)?;
    }
    Ok((resolved, axes))
}

fn resolve_mode_handle<'a>(
    lua: &'a Lua,
    host: &'a Rc<RefCell<HostState>>,
    configuration: &'a Rc<RefCell<ConfigurationState>>,
    id: u64,
    scope: &'a ModeScope,
    visiting: &'a [u64],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = LuaResult<ResolvedInput>> + 'a>> {
    Box::pin(async move {
        if visiting.contains(&id) {
            return Err(LuaError::external(format!(
                "cyclic Luau task dependency at {id}"
            )));
        }
        if let Some(result) = host
            .borrow()
            .resolved_inputs
            .get(&(id, scope.clone()))
            .cloned()
        {
            return Ok(result);
        }
        let mut visiting = visiting.to_vec();
        visiting.push(id);
        let node = host
            .borrow()
            .nodes
            .get(&id)
            .cloned()
            .ok_or_else(|| LuaError::external(format!("unknown Luau graph handle {id}")))?;
        let result = match node {
            GraphNode::Mode(axis) => {
                if !host.borrow().graph_run_active && !host.borrow().test_case_active {
                    return Err(LuaError::external(
                        "semantic input resolved outside a workflow invocation",
                    ));
                }
                Ok(ResolvedInput {
                    value: scope
                        .get(&axis)
                        .map(|v| lua.create_string(v).map(LuaValue::String))
                        .transpose()?
                        .unwrap_or(LuaValue::Nil),
                    axes: [axis].into_iter().collect(),
                })
            }
            GraphNode::Configured {
                source_id,
                overrides,
            } => {
                let mut nested = scope.clone();
                nested.extend(overrides.clone());
                let mut result =
                    resolve_mode_handle(lua, host, configuration, source_id, &nested, &visiting)
                        .await?;
                result.axes.retain(|axis| !overrides.contains_key(axis));
                Ok(result)
            }
            GraphNode::Task => {
                let task = host
                    .borrow()
                    .tasks
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| LuaError::external("unknown Luau task"))?;
                let (inputs, axes) =
                    resolve_mode_inputs(lua, host, configuration, &task.inputs, scope, &visiting)
                        .await?;
                let key = (id, mode_key(&axes, scope));
                let cached = host.borrow().task_results.get(&key).cloned();
                let outputs = if let Some(cached) = cached {
                    cached
                } else {
                    let salt = imp_store::cache::digest_json(&serde_json::json!({
                        "scope": "axes", "values": axes.iter().map(|axis| (axis, scope.get(axis))).collect::<BTreeMap<_, _>>(), "config": {}
                    })).map_err(LuaError::external)?;
                    let exec = create_task_exec(
                        lua,
                        host,
                        configuration,
                        &inputs,
                        &task.inputs,
                        &salt,
                        &task.exec_options,
                    )?;
                    host.borrow_mut().graph_callback_depth += 1;
                    let result = task.run.call_async::<LuaValue>((exec, inputs)).await;
                    host.borrow_mut().graph_callback_depth -= 1;
                    let result = result.inspect_err(|error| {
                        if !is_host_error(error) {
                            host.borrow_mut().task_failure = Some(error.to_string());
                        }
                    })?;
                    host.borrow_mut().task_failure = None;
                    let outputs = validate_task_result(lua, host, &task, result)?;
                    host.borrow_mut().task_results.insert(key, outputs.clone());
                    outputs
                };
                Ok(ResolvedInput {
                    value: LuaValue::Table(outputs),
                    axes,
                })
            }
            GraphNode::TaskOutput { task_id, name } => {
                let result =
                    resolve_mode_handle(lua, host, configuration, task_id, scope, &visiting)
                        .await?;
                let table = result
                    .value
                    .as_table()
                    .ok_or_else(|| LuaError::external("invalid task result"))?;
                Ok(ResolvedInput {
                    value: table.get(name)?,
                    axes: result.axes,
                })
            }
            GraphNode::Path {
                source_id,
                owner_package,
            }
            | GraphNode::Tool {
                source_id,
                owner_package,
                ..
            } => {
                // Bind tools and paths to the resolved artifact, rather than a
                // task output whose value can differ on another edge.
                let result =
                    resolve_mode_handle(lua, host, configuration, source_id, scope, &visiting)
                        .await?;
                let source = result
                    .value
                    .as_userdata()
                    .ok_or_else(|| LuaError::external("tool/path source is not an artifact"))?;
                let source_id = source.borrow::<GraphHandle>()?.id;
                let original = host
                    .borrow()
                    .nodes
                    .get(&id)
                    .cloned()
                    .expect("existing node");
                let (kind, node) = match original {
                    GraphNode::Tool { name, bin_dirs, .. } => (
                        "tool",
                        GraphNode::Tool {
                            name,
                            bin_dirs,
                            source_id,
                            owner_package,
                        },
                    ),
                    _ => (
                        "path",
                        GraphNode::Path {
                            source_id,
                            owner_package,
                        },
                    ),
                };
                let handle = allocate_handle(host, kind);
                host.borrow_mut().nodes.insert(handle.id, node);
                Ok(ResolvedInput {
                    value: LuaValue::UserData(lua.create_userdata(handle)?),
                    axes: result.axes,
                })
            }
            GraphNode::ExpansionGet {
                expansion_id,
                key,
                workflow,
                facet,
            } => {
                let (children, mut axes) = discover_mode_expansion(
                    lua,
                    host,
                    configuration,
                    expansion_id,
                    scope,
                    &visiting,
                )
                .await?;
                let child = expansion_child_handle(
                    &host.borrow(),
                    &children,
                    &key,
                    &workflow,
                    facet.as_deref(),
                )
                .map_err(LuaError::external)?;
                let result =
                    resolve_mode_handle(lua, host, configuration, child, scope, &visiting).await?;
                axes.extend(result.axes);
                Ok(ResolvedInput {
                    value: result.value,
                    axes,
                })
            }
            GraphNode::ExpansionAll { .. } => Err(LuaError::external(
                "an expansion:all() handle cannot be a task input; use expansion:get()",
            )),
            GraphNode::Program(_) => Err(LuaError::external("a program cannot be a task input")),
            _ => Ok(ResolvedInput {
                value: LuaValue::UserData(lua.create_userdata(GraphHandle {
                    id,
                    kind: match node {
                        GraphNode::Files(_) => "files",
                        GraphNode::NativeTool(_) => "native_tool",
                        GraphNode::SelfTool => "self_tool",
                        GraphNode::Artifact(_) => "artifact",
                        _ => "test_root",
                    },
                    outputs: None,
                })?),
                axes: ModeAxes::new(),
            }),
        }?;
        host.borrow_mut()
            .resolved_inputs
            .insert((id, scope.clone()), result.clone());
        Ok(result)
    })
}

async fn discover_mode_expansion(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    configuration: &Rc<RefCell<ConfigurationState>>,
    id: u64,
    scope: &ModeScope,
    visiting: &[u64],
) -> LuaResult<(LuaTable, ModeAxes)> {
    let expansion = host
        .borrow()
        .expansions
        .get(&id)
        .cloned()
        .ok_or_else(|| LuaError::external(format!("unknown Luau expansion {id}")))?;
    let (inputs, axes) =
        resolve_mode_inputs(lua, host, configuration, &expansion.inputs, scope, visiting).await?;
    let key = (id, mode_key(&axes, scope));
    if let Some(children) = host.borrow().expansion_results.get(&key).cloned() {
        return Ok((children, axes));
    }
    host.borrow_mut().graph_callback_depth += 1;
    let children = expansion.create.call_async::<LuaValue>(inputs).await;
    host.borrow_mut().graph_callback_depth -= 1;
    let children = children.map_err(|error| {
        LuaError::external(format!("expansion '{}' failed: {error}", expansion.display))
    })?;
    let LuaValue::Table(children) = children else {
        return Err(LuaError::external(format!(
            "expansion '{}' must return a keyed table",
            expansion.display
        )));
    };
    for pair in children.pairs::<String, LuaValue>() {
        if pair?.0.is_empty() {
            return Err(LuaError::external(
                "expansion child keys must be non-empty strings",
            ));
        }
    }
    host.borrow_mut()
        .expansion_results
        .insert(key, children.clone());
    Ok((children, axes))
}

fn install_task_executor(
    lua: &Lua,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
) -> LuaResult<()> {
    let execute = lua.create_async_function(move |lua, id: u64| {
        let host = Rc::clone(&host);
        let configuration = Rc::clone(&configuration);
        async move {
            let scope = invocation_mode(&host.borrow());
            let result = resolve_mode_handle(&lua, &host, &configuration, id, &scope, &[]).await;
            if let Err(error) = &result {
                host.borrow_mut()
                    .task_failure
                    .get_or_insert(error.to_string());
            }
            result.map(|result| result.value)
        }
    })?;
    lua.globals().set("__imp_execute_task", execute)
}

type ExecAliases = Rc<HashMap<u64, LuaAnyUserData>>;

fn execution_aliases(declared: &LuaTable, resolved: &LuaTable) -> LuaResult<ExecAliases> {
    let mut aliases = HashMap::new();
    for pair in declared.pairs::<LuaValue, LuaValue>() {
        let (key, value) = pair?;
        if let LuaValue::UserData(value) = value {
            if let Ok(handle) = value.borrow::<GraphHandle>() {
                if let LuaValue::UserData(resolved) = resolved.get::<LuaValue>(key)? {
                    aliases.insert(handle.id, resolved);
                }
            }
        }
    }
    Ok(Rc::new(aliases))
}

fn scoped_exec_handle(aliases: &ExecAliases, handle: LuaAnyUserData) -> LuaResult<LuaAnyUserData> {
    let id = handle.borrow::<GraphHandle>()?.id;
    Ok(aliases.get(&id).cloned().unwrap_or(handle))
}

fn scoped_action_options(
    lua: &Lua,
    options: &LuaTable,
    aliases: &ExecAliases,
) -> LuaResult<LuaTable> {
    let scoped = lua.create_table()?;
    for pair in options.pairs::<LuaValue, LuaValue>() {
        let (key, value) = pair?;
        scoped.set(key, value)?;
    }
    if let Some(inputs) = options.get::<Option<LuaTable>>("inputs")? {
        let bound = lua.create_table()?;
        for pair in inputs.pairs::<LuaValue, LuaValue>() {
            let (key, value) = pair?;
            let value = match value {
                LuaValue::UserData(handle) if handle.is::<GraphHandle>() => {
                    LuaValue::UserData(scoped_exec_handle(aliases, handle)?)
                }
                value => value,
            };
            bound.set(key, value)?;
        }
        scoped.set("inputs", bound)?;
    }
    Ok(scoped)
}

fn create_task_exec(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    configuration: &Rc<RefCell<ConfigurationState>>,
    inputs: &LuaTable,
    declared_inputs: &LuaTable,
    config_digest: &str,
    exec_options: &TaskExecOptions,
) -> LuaResult<LuaTable> {
    let exec = lua.create_table()?;
    let file_host = Rc::clone(host);
    exec.set(
        "file",
        lua.create_function(move |lua, options: LuaTable| {
            for pair in options.pairs::<String, LuaValue>() {
                let (key, _) = pair?;
                if key != "path" && key != "contents" {
                    return Err(LuaError::external(format!(
                        "exec.file options do not accept '{key}'"
                    )));
                }
            }
            let path: String = options.get("path")?;
            validate_output_path(&path)?;
            if imp_store::digest::is_root_artifact_path(&path) {
                return Err(LuaError::external("exec.file path must name a file"));
            }
            let contents: LuaString = options.get("contents")?;
            let bytes = contents.as_bytes();
            let digest =
                imp_store::cache::store_blob(&bytes, "file").map_err(LuaError::external)?;
            let artifact = imp_store::cache::CachedArtifact {
                artifact_id: format!("content:{digest}:{path}"),
                kind: "file".to_owned(),
                path: Some(path),
                value: None,
                digest,
                bytes: Some(bytes.len() as u64),
                mode: None,
                tree_digest: None,
                named_cache: None,
            };
            let handle = allocate_handle(&file_host, "artifact");
            file_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::Artifact(artifact));
            lua.create_userdata(handle)
        })?,
    )?;
    let aliases = execution_aliases(declared_inputs, inputs)?;
    let captures: FilesetCaptures = Rc::new(RefCell::new(HashMap::new()));
    let path_host = Rc::clone(host);
    let path_inputs = inputs.clone();
    let path_aliases = Rc::clone(&aliases);
    exec.set(
                    "path",
                    lua.create_function(move |_, handle: LuaAnyUserData| {
                        let handle = scoped_exec_handle(&path_aliases, handle)?;
                        let graph_handle = handle.borrow::<GraphHandle>()?;
                        if !matches!(path_host.borrow().nodes.get(&graph_handle.id), Some(GraphNode::Artifact(_))) {
                            require_declared_input(&path_inputs, graph_handle.id, "exec.path")?;
                        }
                        let (source_id, owner_package) = match path_host.borrow().nodes.get(&graph_handle.id) {
                            Some(GraphNode::Path { source_id, owner_package }) => (*source_id, owner_package.clone()),
                            Some(GraphNode::Artifact(_)) => (graph_handle.id, String::new()),
                            _ => return Err(LuaError::external("exec.path(handle) requires a path or artifact handle")),
                        };
                        let artifact = resolve_source_artifact(&path_host.borrow(), source_id)?;
                        artifact.path.ok_or_else(|| LuaError::external(
                            format!("exec.path(handle) artifact declared in package '{owner_package}' has no captured path"),
                        ))
                    })?,
                )?;
    let tool_dir_host = Rc::clone(host);
    let tool_dir_inputs = inputs.clone();
    let tool_dir_aliases = Rc::clone(&aliases);
    exec.set(
        "tool_dir",
        lua.create_function(move |lua, handle: LuaAnyUserData| {
            let handle = scoped_exec_handle(&tool_dir_aliases, handle)?;
            let id = handle.borrow::<GraphHandle>()?.id;
            exec_tool_dir(lua, &tool_dir_host, &tool_dir_inputs, id)
        })?,
    )?;
    for (name, want_paths) in [("paths", true), ("digest", false)] {
        let fileset_host = Rc::clone(host);
        let fileset_inputs = inputs.clone();
        let fileset_captures = Rc::clone(&captures);
        let fileset_aliases = Rc::clone(&aliases);
        exec.set(
            name,
            lua.create_function(move |lua, handle: LuaAnyUserData| {
                let handle = scoped_exec_handle(&fileset_aliases, handle)?;
                let id = handle.borrow::<GraphHandle>()?.id;
                let function = format!("exec.{name}");
                // An artifact handle is a resolved task input or
                // the output of an action in this task. Its
                // digest nests the artifact at its captured path.
                let artifact = match fileset_host.borrow().nodes.get(&id) {
                    Some(GraphNode::Artifact(artifact)) => Some(artifact.clone()),
                    _ => None,
                };
                if let Some(artifact) = artifact {
                    if want_paths {
                        return Err(LuaError::external(format!(
                            "{function}(handle) requires a files handle"
                        )));
                    }
                    let digest = normalize_luau_artifact(&artifact)
                        .map_err(|error| LuaError::external(format!("{function}: {error:#}")))?;
                    return Ok(LuaValue::String(lua.create_string(digest.digest())?));
                }
                require_declared_input(&fileset_inputs, id, &function)?;
                let captured = captured_fileset(&fileset_host.borrow(), &fileset_captures, id)
                    .map_err(|error| LuaError::external(format!("{function}: {error:#}")))?
                    .ok_or_else(|| {
                        LuaError::external(format!("{function}(handle) requires a files handle"))
                    })?;
                if want_paths {
                    Ok(LuaValue::Table(
                        lua.create_sequence_from(captured.files.iter().cloned())?,
                    ))
                } else {
                    Ok(LuaValue::String(
                        lua.create_string(captured.digest.digest())?,
                    ))
                }
            })?,
        )?;
    }
    let action_aliases = Rc::clone(&aliases);
    let action_config_digest = config_digest.to_owned();
    let action_host = Rc::clone(host);
    let action_configuration = Rc::clone(configuration);
    let action_lua = lua.clone();
    let action_inputs = inputs.clone();
    let action_captures = Rc::clone(&captures);
    let exec_options = exec_options.clone();
    exec.set(
        "action",
        lua.create_async_function(move |_, options: LuaTable| {
            let action_aliases = Rc::clone(&action_aliases);
            let config_digest = action_config_digest.clone();
            let action_host = Rc::clone(&action_host);
            let action_configuration = Rc::clone(&action_configuration);
            let action_inputs = action_inputs.clone();
            let action_lua = action_lua.clone();
            let action_captures = Rc::clone(&action_captures);
            let exec_options = exec_options.clone();
            async move {
                let options = scoped_action_options(&action_lua, &options, &action_aliases)?;
                if matches!(options.get::<LuaValue>("display")?, LuaValue::Nil) {
                    if let Some(display) = &exec_options.display {
                        options.set("display", display.as_str())?;
                    }
                }
                if !exec_options.cache {
                    options.set("cache", false)?;
                }
                match run_action(
                    action_lua,
                    Rc::clone(&action_host),
                    Rc::clone(&action_configuration),
                    options,
                    action_inputs,
                    action_captures,
                    config_digest,
                )
                .await
                {
                    Ok(result) if exec_options.returns_outputs => Ok(LuaValue::Table(result)),
                    Ok(_) => Ok(LuaValue::Nil),
                    Err(error) => {
                        action_host.borrow_mut().task_failure = Some(format!("{error:#}"));
                        Err(LuaError::external(format!("{error:#}")))
                    }
                }
            }
        })?,
    )?;
    install_worker_start(lua, host, inputs, &exec)?;
    Ok(exec)
}

async fn run_cache_details(
    host: &Rc<RefCell<HostState>>,
    configuration: &Rc<RefCell<ConfigurationState>>,
    options: LuaTable,
    fake: bool,
) -> LuaResult<Option<String>> {
    let lua = host
        .borrow()
        .lua
        .as_ref()
        .and_then(mlua::WeakLua::try_upgrade)
        .ok_or_else(|| LuaError::external("Luau runtime is not initialized"))?;
    let inputs: LuaTable = options.get("inputs")?;
    let caches: LuaTable = options.get("caches")?;
    let mut bindings = HashMap::new();
    for pair in inputs.clone().pairs::<String, LuaAnyUserData>() {
        let (key, value) = pair?;
        let handle = value.borrow::<GraphHandle>()?;
        let source_id = match host.borrow().nodes.get(&handle.id) {
            Some(GraphNode::Tool { source_id, .. }) => *source_id,
            _ => {
                return Err(LuaError::external(
                    "cache details inputs must be tool handles",
                ))
            }
        };
        let spec: LuaTable = caches.get(key)?;
        let cache = imp_store::cache::OutputNamedCache {
            name: spec.get("name")?,
            key: spec.get("key")?,
            shared: spec.get::<Option<bool>>("shared")?.unwrap_or(true),
        };
        imp_store::cache::validate_named_cache_path("shared", &cache.name, &cache.key)
            .map_err(LuaError::external)?;
        if !fake {
            let h = host.borrow();
            if h.service
                .cache_dir_get(
                    imp_store::cache::named_cache_scope_id(cache.shared, &h.workspace_id),
                    &cache.name,
                    &cache.key,
                )
                .map_err(LuaError::external)?
                .is_none()
            {
                return Ok(None);
            }
        }
        bindings.insert(source_id, cache);
    }
    let previous = host.borrow_mut().cached_tool_bindings.replace(bindings);
    let result = async {
        let exec = create_task_exec(
            &lua,
            host,
            configuration,
            &inputs,
            &inputs,
            "",
            &TaskExecOptions::default(),
        )?;
        let run: LuaFunction = options.get("run")?;
        host.borrow_mut().graph_callback_depth += 1;
        let result = run.call_async::<Option<String>>((exec, inputs)).await;
        host.borrow_mut().graph_callback_depth -= 1;
        result
    }
    .await;
    host.borrow_mut().cached_tool_bindings = previous;
    host.borrow_mut().task_failure = None;
    result
}

fn install_worker_start(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    inputs: &LuaTable,
    exec: &LuaTable,
) -> LuaResult<()> {
    let host = Rc::clone(host);
    let inputs = inputs.clone();
    exec.set(
        "worker_start",
        lua.create_async_function(move |lua, (name, options): (String, LuaTable)| {
            execute_worker_start(lua, Rc::clone(&host), inputs.clone(), name, options)
        })?,
    )
}

async fn execute_worker_start(
    lua: Lua,
    host: Rc<RefCell<HostState>>,
    inputs: LuaTable,
    name: String,
    options: LuaTable,
) -> LuaResult<LuaValue> {
    if host.borrow().graph_callback_depth == 0 {
        return Err(LuaError::external(
            "worker_start requires a running task or cache-details callback",
        ));
    }
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
    {
        return Err(LuaError::external(
            "worker name must use ASCII letters, digits, '-' or '_'",
        ));
    }
    for pair in options.pairs::<String, LuaValue>() {
        let (key, _) = pair?;
        if !["argv", "env", "health_check_argv"].contains(&key.as_str()) {
            return Err(LuaError::external(format!(
                "worker_start options do not accept '{key}'"
            )));
        }
    }
    let argv: Vec<String> = options.get("argv")?;
    let health: Vec<String> = options
        .get::<Option<Vec<String>>>("health_check_argv")?
        .unwrap_or_default();
    if argv.is_empty() {
        return Err(LuaError::external("worker_start requires non-empty argv"));
    }
    let mut dirs = Vec::new();
    for pair in inputs.clone().pairs::<LuaValue, LuaValue>() {
        if let (_, LuaValue::UserData(value)) = pair? {
            if let Ok(handle) = value.borrow::<GraphHandle>() {
                if matches!(
                    host.borrow().nodes.get(&handle.id),
                    Some(GraphNode::Tool { .. })
                ) {
                    dirs.push(exec_tool_dir(&lua, &host, &inputs, handle.id)?);
                }
            }
        }
    }
    for program in std::iter::once(&argv[0]).chain(health.first()) {
        if !dirs.iter().any(|dir| {
            Path::new(program).strip_prefix(dir).is_ok_and(|p| {
                !p.as_os_str().is_empty()
                    && p.components().all(|c| matches!(c, Component::Normal(_)))
            })
        }) {
            return Err(LuaError::external(
                "worker_start executable must be inside a declared tool input",
            ));
        }
    }
    let env_table = options.get::<Option<LuaTable>>("env")?;
    let env = action_env_entries(env_table.as_ref()).map_err(LuaError::external)?;
    let fake = {
        let h = host.borrow();
        h.fakes.toolchain.clone().or_else(|| h.fakes.run.clone())
    };
    if let Some(fake) = fake {
        let record = lua.create_table()?;
        record.set(1, "worker_start")?;
        record.set(2, name.clone())?;
        record.set(3, options)?;
        if let Some(calls) = fake.get::<Option<LuaTable>>("calls")? {
            push_record(&calls, LuaValue::Table(record.clone()))?;
        }
        push_record(&fake.get::<LuaTable>("workers")?, LuaValue::Table(record))?;
        if let Some(message) = fake.get::<Option<String>>("worker_error")? {
            return Err(LuaError::external(message));
        }
        return lua.to_value(&serde_json::json!({"home_dir": format!("/workers/{name}/home"), "tmp_dir": format!("/workers/{name}/tmp"), "port": 31000}));
    }
    let (service, workspace_id) = {
        let h = host.borrow();
        (Arc::clone(&h.service), h.workspace_id.clone())
    };
    let result = service
        .worker_start(
            &workspace_id,
            &name,
            imp_exec_api::WorkerSpec {
                argv,
                env,
                health_check_argv: health,
            },
        )
        .await
        .map_err(LuaError::external)?;
    lua.to_value(&serde_json::json!({"home_dir": result.home_dir, "tmp_dir": result.tmp_dir, "port": result.port}))
}

fn lua_err(error: LuaError) -> anyhow::Error {
    anyhow::anyhow!(error.to_string())
}

/// A resolved `TEST` root: an array of `{ name, ok, output? }` units.
fn test_units_value(lua: &Lua, units: Vec<TestUnit>) -> LuaResult<LuaValue> {
    let list = lua.create_table()?;
    for unit in units {
        let value = lua.create_table()?;
        value.set("name", unit.name)?;
        value.set("ok", unit.ok)?;
        if !unit.output.is_empty() {
            value.set("output", unit.output)?;
        }
        push_record(&list, LuaValue::Table(value))?;
    }
    Ok(LuaValue::Table(list))
}

fn push_goal_entry(
    lua: &Lua,
    entries: &LuaTable,
    address: &str,
    result: LuaValue,
) -> LuaResult<()> {
    let entry = lua.create_table()?;
    entry.set("address", address)?;
    entry.set("result", result)?;
    push_record(entries, LuaValue::Table(entry))
}

/// A task root whose task declares exactly one output resolves to that
/// output's value. Other roots keep the value that the task executor returned.
fn single_output_value(host: &HostState, handle_id: u64, value: LuaValue) -> LuaResult<LuaValue> {
    let (handle_id, node) = unconfigured_node(host, handle_id);
    let Some(GraphNode::Task) = node else {
        return Ok(value);
    };
    let Some(task) = host.tasks.get(&handle_id) else {
        return Ok(value);
    };
    if task.outputs.len() != 1 {
        return Ok(value);
    }
    let (name, _) = task.outputs.iter().next().expect("one output");
    match value {
        LuaValue::Table(table) => table.get::<LuaValue>(name.as_str()),
        other => Ok(other),
    }
}

fn require_graph_declaration(host: &Rc<RefCell<HostState>>) -> LuaResult<()> {
    if host.borrow().program_describing {
        return Err(LuaError::external(
            "a program description cannot declare graph nodes",
        ));
    }
    Ok(())
}

async fn describe_program_scoped(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    configuration: &Rc<RefCell<ConfigurationState>>,
    program: Program,
    scope: &ModeScope,
) -> LuaResult<LuaValue> {
    let (inputs, _) =
        resolve_mode_inputs(lua, host, configuration, &program.inputs, scope, &[]).await?;
    let aliases = execution_aliases(&program.inputs, &inputs)?;
    let exec = create_task_exec(
        lua,
        host,
        configuration,
        &inputs,
        &program.inputs,
        "",
        &TaskExecOptions::default(),
    )?;
    exec.set("file", LuaValue::Nil)?;
    exec.set("action", LuaValue::Nil)?;
    exec.set("worker_start", LuaValue::Nil)?;
    let previous = program.loader.stack.replace(program.stack);
    host.borrow_mut().program_describing = true;
    host.borrow_mut().graph_callback_depth += 1;
    let result = program
        .describe
        .call_async::<LuaTable>((exec, inputs.clone()))
        .await;
    host.borrow_mut().graph_callback_depth -= 1;
    host.borrow_mut().program_describing = false;
    program.loader.stack.replace(previous);
    let described = result?;
    let result = lua.create_table()?;
    for pair in described.pairs::<String, LuaValue>() {
        let (key, value) = pair?;
        result.set(key, value)?;
    }
    for field in ["argv", "inputs", "tools"] {
        let value = result.get::<LuaValue>(field)?;
        let values = match value {
            LuaValue::Nil if field != "argv" => lua.create_table()?,
            LuaValue::Table(values) => values,
            _ => {
                return Err(LuaError::external(format!(
                    "program description {field} must be a list of {}",
                    if field == "tools" {
                        "tool handles"
                    } else {
                        "strings"
                    }
                )))
            }
        };
        let length = values.raw_len();
        let mut count = 0;
        for pair in values.clone().pairs::<LuaValue, LuaValue>() {
            let (key, value) = pair?;
            let valid_value = if field == "tools" {
                matches!(value, LuaValue::UserData(_))
            } else {
                matches!(value, LuaValue::String(_))
            };
            if !matches!(key, LuaValue::Integer(index) if index >= 1 && index as usize <= length)
                || !valid_value
            {
                return Err(LuaError::external(format!(
                    "program description {field} must be a list of {}",
                    if field == "tools" {
                        "tool handles"
                    } else {
                        "strings"
                    }
                )));
            }
            count += 1;
        }
        if count != length
            || (field == "argv" && (length == 0 || values.get::<String>(1)?.is_empty()))
        {
            return Err(LuaError::external(format!(
                "program description {field} must be a {}list of strings",
                if field == "argv" {
                    "non-empty "
                } else {
                    "dense "
                }
            )));
        }
        if field == "tools" {
            let bound = lua.create_table()?;
            for (index, tool) in values.sequence_values::<LuaAnyUserData>().enumerate() {
                bound.set(index + 1, scoped_exec_handle(&aliases, tool?)?)?;
            }
            result.set(field, bound)?;
        } else {
            result.set(field, values)?;
        }
    }
    if !matches!(
        result.get::<LuaValue>("display")?,
        LuaValue::Nil | LuaValue::String(_)
    ) {
        return Err(LuaError::external(
            "program description display must be a string",
        ));
    }
    if let Some(env) = result.get::<Option<LuaTable>>("env")? {
        for pair in env.clone().pairs::<LuaValue, LuaValue>() {
            let (key, value) = pair?;
            if !matches!(key, LuaValue::String(_)) || !matches!(value, LuaValue::String(_)) {
                return Err(LuaError::external(
                    "program description env must map names to strings",
                ));
            }
        }
        action_env_entries(Some(&env))
            .map_err(|error| LuaError::external(format!("program description env: {error}")))?;
    }
    for pair in result.clone().pairs::<String, LuaValue>() {
        let (key, _) = pair?;
        if !["argv", "env", "display", "inputs", "tools"].contains(&key.as_str()) {
            return Err(LuaError::external(format!(
                "program description does not accept '{key}'"
            )));
        }
    }
    if let Some(tools) = result.get::<Option<LuaTable>>("tools")? {
        for tool in tools.sequence_values::<LuaAnyUserData>() {
            let tool = tool?;
            let handle = tool.borrow::<GraphHandle>()?;
            require_declared_input(&inputs, handle.id, "program tools")?;
            if !matches!(
                host.borrow().nodes.get(&handle.id),
                Some(GraphNode::Tool { .. } | GraphNode::NativeTool(_) | GraphNode::SelfTool)
            ) {
                return Err(LuaError::external("program tools must be tool handles"));
            }
        }
    }
    Ok(LuaValue::Table(result))
}

/// Report whether a Luau error comes from a host function, such as a failed
/// action, and not from an `error` call in Luau code.
fn is_host_error(error: &LuaError) -> bool {
    match error {
        LuaError::CallbackError { cause, .. } => is_host_error(cause),
        LuaError::ExternalError(_) => true,
        _ => false,
    }
}

/// Copy a resolved root value for a goal callback. Artifact handles become
/// plain `{ type = "artifact", digest, path }` tables, so that a workflow can
/// publish or stage them by digest. The task result cache is not changed.
fn plain_goal_value(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    value: LuaValue,
    depth: usize,
) -> LuaResult<LuaValue> {
    if depth > 64 {
        return Err(LuaError::external("goal root value is nested too deeply"));
    }
    match value {
        LuaValue::UserData(userdata) => {
            let artifact = match userdata.borrow::<GraphHandle>() {
                Ok(handle) => match host.borrow().nodes.get(&handle.id) {
                    Some(GraphNode::Artifact(artifact)) => Some(artifact.clone()),
                    _ => None,
                },
                Err(_) => None,
            };
            let Some(artifact) = artifact else {
                return Ok(LuaValue::UserData(userdata));
            };
            let digest = normalize_luau_artifact(&artifact)
                .map_err(|error| {
                    LuaError::external(format!("normalize goal root artifact: {error:#}"))
                })?
                .digest()
                .to_owned();
            let table = lua.create_table()?;
            table.set("type", "artifact")?;
            table.set("digest", digest)?;
            table.set("path", artifact.path)?;
            Ok(LuaValue::Table(table))
        }
        LuaValue::Table(table) => {
            let copy = lua.create_table()?;
            for pair in table.pairs::<LuaValue, LuaValue>() {
                let (key, value) = pair?;
                copy.raw_set(key, plain_goal_value(lua, host, value, depth + 1)?)?;
            }
            Ok(LuaValue::Table(copy))
        }
        other => Ok(other),
    }
}

/// The handle id of `children[key][workflow][facet?]`, the child that an
/// expansion projection selects.
fn expansion_child_handle(
    host: &HostState,
    children: &LuaTable,
    key: &str,
    workflow: &str,
    facet: Option<&str>,
) -> Result<u64> {
    let lua_error = |error: LuaError| anyhow::anyhow!(error.to_string());
    let child = children.get::<LuaValue>(key).map_err(lua_error)?;
    let workflow_value = match child {
        LuaValue::Nil => bail!("expansion has no child '{key}'"),
        LuaValue::Table(table) => table.get::<LuaValue>(workflow).map_err(lua_error)?,
        _ => bail!("expansion child '{key}' must contain workflow handles"),
    };
    let workflow_value = if let Some(facet) = facet {
        workflow_value
            .as_table()
            .with_context(|| format!("expansion child '{key}' has no facet '{facet}'"))?
            .get::<LuaValue>(facet)
            .map_err(lua_error)?
    } else {
        workflow_value
    };
    let LuaValue::UserData(userdata) = workflow_value else {
        bail!("expansion child '{key}' has no requested {workflow} workflow handle");
    };
    let id = userdata.borrow::<GraphHandle>().map_err(lua_error)?.id;
    validate_expansion_child(host, id, workflow, key)?;
    Ok(id)
}

fn validate_task_result(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    task: &Task,
    result: LuaValue,
) -> LuaResult<LuaTable> {
    if task.outputs.is_empty() {
        if !matches!(result, LuaValue::Nil) {
            return Err(LuaError::external(
                "Luau task with no declared outputs must return nil",
            ));
        }
        return lua.create_table();
    }
    let LuaValue::Table(result) = result else {
        return Err(LuaError::external(
            "Luau task must return its named output table",
        ));
    };
    let mut actual = Vec::new();
    for pair in result.pairs::<String, LuaValue>() {
        actual.push(pair?.0);
    }
    actual.sort();
    let expected: Vec<_> = task.outputs.keys().cloned().collect();
    if actual != expected {
        return Err(LuaError::external(format!(
            "Luau task returned outputs {actual:?}, expected {expected:?}"
        )));
    }
    for (name, kind) in &task.outputs {
        let value = result.get::<LuaValue>(name.as_str())?;
        match kind {
            TaskOutputKind::Value => {
                serde_json::to_value(&value).map_err(LuaError::external)?;
            }
            TaskOutputKind::Artifact => {
                let LuaValue::UserData(userdata) = value else {
                    return Err(LuaError::external(format!(
                        "Luau task output '{name}' must be an action artifact"
                    )));
                };
                let handle = userdata.borrow::<GraphHandle>()?;
                if handle.kind != "artifact"
                    || !matches!(
                        host.borrow().nodes.get(&handle.id),
                        Some(GraphNode::Artifact(_))
                    )
                {
                    return Err(LuaError::external(format!(
                        "Luau task output '{name}' must be an action artifact"
                    )));
                }
            }
        }
    }
    Ok(result)
}

fn install_expansion_executor(
    lua: &Lua,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
) -> LuaResult<()> {
    let discover = lua.create_async_function(move |lua, id: u64| {
        let host = Rc::clone(&host);
        let configuration = Rc::clone(&configuration);
        async move {
            let scope = invocation_mode(&host.borrow());
            discover_mode_expansion(&lua, &host, &configuration, id, &scope, &[])
                .await
                .map(|(children, _)| children)
        }
    })?;
    lua.globals().set("__imp_discover_expansion", discover)
}

fn create_core(
    lua: &Lua,
    host: Rc<RefCell<HostState>>,
    loader: ModuleLoader,
    configuration: Rc<RefCell<ConfigurationState>>,
) -> LuaResult<LuaValue> {
    host.borrow_mut().lua = Some(lua.weak());
    let core = lua.create_table()?;
    core.set("BUILD", "BUILD")?;
    core.set("PACKAGE", "PACKAGE")?;
    core.set("TEST", "TEST")?;

    let axis_config = Rc::clone(&configuration);
    let axis_host = Rc::clone(&host);
    core.set(
        "define_mode_axis",
        lua.create_function(move |_, (name, options): (String, LuaTable)| {
            validate_config_namespace(&name)?;
            let definition: serde_json::Value =
                serde_json::to_value(options).map_err(LuaError::external)?;
            crate::spike::validate_mode_axis_definition(&name, &definition)
                .map_err(LuaError::external)?;
            let effective = axis_host
                .borrow_mut()
                .invocation_mode
                .entry(name.clone())
                .or_insert_with(|| {
                    definition["default"]
                        .as_str()
                        .expect("validated default")
                        .to_owned()
                })
                .clone();
            let mut state = axis_config.borrow_mut();
            if let Some(mode) = state
                .invocation_values
                .as_mut()
                .and_then(|values| values.get_mut("imp.mode"))
                .and_then(serde_json::Value::as_object_mut)
            {
                mode.entry(name.clone())
                    .or_insert(serde_json::Value::String(effective));
            }
            state.mode_axes.insert(name, definition);
            Ok(())
        })?,
    )?;
    let profile_config = Rc::clone(&configuration);
    core.set(
        "define_profile",
        lua.create_function(move |_, (name, values): (String, LuaTable)| {
            validate_config_namespace(&name)?;
            let mut values = values
                .pairs::<String, LuaValue>()
                .map(|pair| {
                    let (key, value) = pair?;
                    Ok((
                        key,
                        serde_json::to_value(value).map_err(LuaError::external)?,
                    ))
                })
                .collect::<LuaResult<serde_json::Map<String, serde_json::Value>>>()?;
            // Empty Luau tables encode as arrays. This field is a map.
            if let Some(defines) = values
                .get_mut("odin")
                .and_then(|value| value.get_mut("defines"))
            {
                if defines.as_array().is_some_and(Vec::is_empty) {
                    *defines = serde_json::json!({});
                }
            }
            let values = serde_json::Value::Object(values);
            profile_config
                .borrow_mut()
                .mode_profiles
                .insert(name, values);
            Ok(())
        })?,
    )?;
    let semantic = lua.create_table()?;
    let mode_host = Rc::clone(&host);
    semantic.set(
        "mode",
        lua.create_function(move |lua, axis: String| {
            require_graph_declaration(&mode_host)?;
            if axis.is_empty() {
                return Err(LuaError::external(
                    "semantic.mode requires a non-empty axis name",
                ));
            }
            let handle = allocate_handle(&mode_host, "semantic");
            mode_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::Mode(axis));
            lua.create_userdata(handle)
        })?,
    )?;
    core.set("semantic", semantic)?;
    let configured_host = Rc::clone(&host);
    let configured_config = Rc::clone(&configuration);
    core.set(
        "configured",
        lua.create_function(
            move |lua, (source, overrides): (LuaAnyUserData, LuaTable)| {
                require_graph_declaration(&configured_host)?;
                let source = source.borrow::<GraphHandle>()?.clone();
                let overrides: ModeScope = overrides
                    .pairs::<LuaValue, LuaValue>()
                    .map(|pair| {
                        let (LuaValue::String(key), LuaValue::String(value)) = pair? else {
                            return Err(LuaError::external(
                                "configured overrides must map axis names to strings",
                            ));
                        };
                        Ok((key.to_str()?.to_owned(), value.to_str()?.to_owned()))
                    })
                    .collect::<LuaResult<_>>()?;
                if overrides.is_empty() {
                    return Err(LuaError::external("configured overrides must not be empty"));
                }
                let (_, output_select) = crate::spike::classify_mode_overrides(
                    &configured_config.borrow().mode_axes,
                    &overrides,
                    "configured",
                )
                .map_err(LuaError::external)?;
                if !output_select.is_empty() {
                    return Err(LuaError::external("configured only accepts rebuild axes"));
                }
                lua.create_userdata(configured_handle(
                    lua,
                    &configured_host,
                    &source,
                    overrides,
                )?)
            },
        )?,
    )?;

    let expansion_host = Rc::clone(&host);
    core.set(
        "expand",
        lua.create_function(move |lua, options: LuaTable| {
            require_graph_declaration(&expansion_host)?;
            let create = options.get::<LuaFunction>("create")?;
            let inputs = options
                .get::<Option<LuaTable>>("inputs")?
                .unwrap_or(lua.create_table()?);
            let display = options
                .get::<Option<String>>("display")?
                .unwrap_or_else(|| "Luau graph expansion".to_owned());
            if display.trim().is_empty() {
                return Err(LuaError::external(
                    "expand.display must be a non-empty string",
                ));
            }
            let id = {
                let mut host = expansion_host.borrow_mut();
                host.next_expansion_id += 1;
                let id = host.next_expansion_id;
                host.expansions.insert(
                    id,
                    Expansion {
                        inputs,
                        create,
                        display,
                    },
                );
                id
            };
            lua.create_userdata(ExpansionHandle {
                id,
                host: Rc::clone(&expansion_host),
            })
        })?,
    )?;

    let graph_host = Rc::clone(&host);
    let test_loader = loader.clone();
    core.set(
        "test_root",
        lua.create_function(move |lua, ()| {
            require_graph_declaration(&graph_host)?;
            let package = current_package_path(&test_loader);
            let handle = allocate_handle(&graph_host, "test_root");
            graph_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::TestRoot { package });
            lua.create_userdata(handle)
        })?,
    )?;

    let details_host = Rc::clone(&host);
    core.set(
        "named_cache_details",
        lua.create_function(move |_, options: LuaTable| {
            let name: String = options.get("name")?;
            options.get::<LuaFunction>("run")?;
            options.get::<LuaTable>("inputs")?;
            options.get::<LuaTable>("caches")?;
            if details_host.borrow().graph_callback_depth != 0 {
                return Err(LuaError::external(
                    "named_cache_details must be registered at declaration time",
                ));
            }
            details_host
                .borrow_mut()
                .cache_details
                .insert(name, options);
            Ok(())
        })?,
    )?;
    let test_api = lua.create_table()?;
    let cache_test_host = Rc::clone(&host);
    let cache_test_config = Rc::clone(&configuration);
    test_api.set(
        "cache_details",
        lua.create_async_function(move |_, (name, seeded): (String, bool)| {
            let host = Rc::clone(&cache_test_host);
            let config = Rc::clone(&cache_test_config);
            async move {
                if !host.borrow().test_case_active || host.borrow().fakes.toolchain.is_none() {
                    return Err(LuaError::external(
                        "test.cache_details requires a toolchain fake in a test case",
                    ));
                }
                let options = host
                    .borrow()
                    .cache_details
                    .get(&name)
                    .cloned()
                    .ok_or_else(|| LuaError::external("unknown cache details callback"))?;
                if !seeded {
                    return Ok(None);
                }
                run_cache_details(&host, &config, options, true).await
            }
        })?,
    )?;
    test_api.set(
        "case",
        lua.create_function(|lua, (name, run): (String, LuaFunction)| {
            if name.trim().is_empty() {
                return Err(LuaError::external("test.case requires a non-empty name"));
            }
            let case = lua.create_table()?;
            case.set("__imp_test_case", true)?;
            case.set("name", name)?;
            case.set("run", run)?;
            Ok(case)
        })?,
    )?;
    test_api.set(
        "suite",
        lua.create_function(|lua, (name, cases): (String, LuaTable)| {
            if name.trim().is_empty() {
                return Err(LuaError::external("test.suite requires a non-empty name"));
            }
            let suite = lua.create_table()?;
            suite.set("__imp_test_suite", true)?;
            suite.set("name", name)?;
            suite.set("cases", cases)?;
            Ok(suite)
        })?,
    )?;
    install_test_host_api(lua, &test_api, Rc::clone(&host), Rc::clone(&configuration))?;
    core.set("test", test_api)?;

    let platform_host = Rc::clone(&host);
    core.set(
        "platform_info",
        lua.create_function(move |lua, ()| {
            let (toolchain, platform, service) = {
                let host = platform_host.borrow();
                (
                    host.fakes.toolchain.clone(),
                    host.fakes.platform.clone(),
                    Arc::clone(&host.service),
                )
            };
            if let Some(toolchain) = toolchain {
                push_record(
                    &toolchain.raw_get::<LuaTable>("calls")?,
                    LuaValue::Table(lua.create_sequence_from(["platform_info"])?),
                )?;
            }
            let (os, arch) = match platform {
                Some(platform) => platform,
                None => {
                    let capabilities = service.capabilities().map_err(LuaError::external)?;
                    (capabilities.os.to_owned(), capabilities.arch.to_owned())
                }
            };
            let platform = lua.create_table()?;
            platform.set("os", os)?;
            platform.set("arch", arch)?;
            Ok(platform)
        })?,
    )?;

    let path_host = Rc::clone(&host);
    let path_loader = loader.clone();
    core.set(
        "path",
        lua.create_function(move |lua, source: LuaAnyUserData| {
            require_graph_declaration(&path_host)?;
            let source_id = artifact_output_source(&path_host, &source)?;
            let owner_package = current_package_path(&path_loader);
            let fingerprint = format!("{owner_package}\n{source_id}");
            if let Some(id) = path_host.borrow().paths.get(&fingerprint).copied() {
                return lua.create_userdata(GraphHandle {
                    id,
                    kind: "path",
                    outputs: None,
                });
            }
            let handle = allocate_handle(&path_host, "path");
            let mut host = path_host.borrow_mut();
            host.paths.insert(fingerprint, handle.id);
            host.nodes.insert(
                handle.id,
                GraphNode::Path {
                    source_id,
                    owner_package,
                },
            );
            drop(host);
            lua.create_userdata(handle)
        })?,
    )?;

    let tool_host = Rc::clone(&host);
    let tool_loader = loader.clone();
    core.set(
        "tool",
        lua.create_function(move |lua, (source, options): (LuaAnyUserData, LuaTable)| {
            require_graph_declaration(&tool_host)?;
            let source_id = artifact_output_source(&tool_host, &source)?;
            for pair in options.pairs::<String, LuaValue>() {
                let (key, _) = pair?;
                if key != "name" && key != "bin_dirs" {
                    return Err(LuaError::external(format!(
                        "tool options do not accept '{key}'"
                    )));
                }
            }
            let name = options.get::<String>("name")?;
            let bin_dirs = options
                .get::<Option<Vec<String>>>("bin_dirs")?
                .unwrap_or_else(|| vec![".".to_owned()]);
            if name.trim().is_empty() {
                return Err(LuaError::external("tool({ source, name }) requires a name"));
            }
            for directory in &bin_dirs {
                validate_tool_bin_dir(directory)?;
            }
            let owner_package = current_package_path(&tool_loader);
            let fingerprint = format!(
                "{owner_package}\n{source_id}\n{name}\n{}",
                bin_dirs.join("\n")
            );
            if let Some(id) = tool_host.borrow().tools.get(&fingerprint).copied() {
                return lua.create_userdata(GraphHandle {
                    id,
                    kind: "tool",
                    outputs: None,
                });
            }
            let handle = allocate_handle(&tool_host, "tool");
            let mut host = tool_host.borrow_mut();
            host.tools.insert(fingerprint, handle.id);
            host.nodes.insert(
                handle.id,
                GraphNode::Tool {
                    name,
                    bin_dirs,
                    source_id,
                    owner_package,
                },
            );
            drop(host);
            lua.create_userdata(handle)
        })?,
    )?;

    // Keep the CLI-owned schema available in every Luau workspace. Rule
    // modules register their own namespace schemas through this same API.
    {
        let mut state = configuration.borrow_mut();
        state.schemas.insert(
            "imp".to_owned(),
            serde_json::json!({
                "js_workers": {"__imp_field": "int", "default": 1},
                "jobs": {"__imp_field": "int", "default": 1},
                "fs_jobs": {"__imp_field": "int"},
                "passthrough_env": {
                    "__imp_field": "array",
                    "item": {"__imp_field": "string"},
                    "default": []
                },
                "log_level": {
                    "__imp_field": "enum",
                    "values": ["trace", "debug", "info", "warn", "error"],
                    "default": "info"
                }
            }),
        );
        state.schemas.insert(
            "cache".to_owned(),
            serde_json::json!({
                "gc_max_age_days": {"__imp_field": "int", "default": 30}
            }),
        );
    }

    let field = lua.create_table()?;
    for kind in ["int", "string", "bool"] {
        field.set(
            kind,
            lua.create_function(move |lua, options: Option<LuaTable>| {
                make_field_descriptor(lua, kind, options, &[])
            })?,
        )?;
    }
    field.set(
        "enum",
        lua.create_function(|lua, (values, options): (LuaTable, Option<LuaTable>)| {
            let extra = [("values", LuaValue::Table(values))];
            make_field_descriptor(lua, "enum", options, &extra)
        })?,
    )?;
    field.set(
        "object",
        lua.create_function(|lua, (shape, options): (LuaTable, Option<LuaTable>)| {
            let extra = [("shape", LuaValue::Table(shape))];
            make_field_descriptor(lua, "object", options, &extra)
        })?,
    )?;
    field.set(
        "map",
        lua.create_function(
            |lua, (key, value, options): (LuaTable, LuaTable, Option<LuaTable>)| {
                let extra = [
                    ("key", LuaValue::Table(key)),
                    ("value", LuaValue::Table(value)),
                ];
                make_field_descriptor(lua, "map", options, &extra)
            },
        )?,
    )?;
    field.set(
        "array",
        lua.create_function(|lua, (item, options): (LuaTable, Option<LuaTable>)| {
            let extra = [("item", LuaValue::Table(item))];
            make_field_descriptor(lua, "array", options, &extra)
        })?,
    )?;
    core.set("field", field)?;

    let config_state = Rc::clone(&configuration);
    core.set(
        "define_config_schema",
        lua.create_function(move |_, (namespace, shape): (String, LuaTable)| {
            validate_config_namespace(&namespace)?;
            let schema: serde_json::Value = serde_json::to_value(shape)
                .map_err(|error| LuaError::external(format!("serialize config schema: {error}")))?;
            if !schema.is_object() {
                return Err(LuaError::external(
                    "define_config_schema shape must be a table",
                ));
            }
            config_state
                .borrow_mut()
                .schemas
                .insert(namespace.clone(), schema);
            Ok(())
        })?,
    )?;

    let config_state = Rc::clone(&configuration);
    core.set(
        "configure",
        lua.create_function(move |_, (namespace, value): (String, LuaValue)| {
            validate_config_namespace(&namespace)?;
            let value: serde_json::Value = serde_json::to_value(value)
                .map_err(|error| LuaError::external(format!("serialize config value: {error}")))?;
            if namespace == "imp.mode" {
                return Err(LuaError::external("imp.mode is reserved for mode axes"));
            }
            let mut state = config_state.borrow_mut();
            let existing = state
                .values
                .entry(namespace)
                .or_insert(serde_json::Value::Null);
            merge_config_json(existing, value);
            Ok(())
        })?,
    )?;

    let config_state = Rc::clone(&configuration);
    core.set(
        "configuration",
        lua.create_function(
            move |lua, (namespace, fallback): (String, Option<LuaValue>)| {
                validate_config_namespace(&namespace)?;
                let state = config_state.borrow();
                let mut value = state.values.get(&namespace).cloned();
                if let Some(patch) = state
                    .invocation_values
                    .as_ref()
                    .and_then(|values| values.get(&namespace))
                {
                    merge_config_json(value.get_or_insert(serde_json::Value::Null), patch.clone());
                }
                match value {
                    Some(value) => lua.to_value(&value),
                    None => Ok(fallback.unwrap_or(LuaValue::Nil)),
                }
            },
        )?,
    )?;

    let config_state = Rc::clone(&configuration);
    core.set(
        "configuration_schemas",
        lua.create_function(move |lua, ()| lua.to_value(&config_state.borrow().schemas.clone()))?,
    )?;

    let output = lua.create_table()?;
    output.set(
        "value",
        lua.create_function(|lua, ()| {
            lua.create_userdata(OutputDeclarationHandle(OutputDeclaration::Value))
        })?,
    )?;
    output.set(
        "artifact",
        lua.create_function(|lua, ()| {
            lua.create_userdata(OutputDeclarationHandle(OutputDeclaration::Artifact))
        })?,
    )?;
    output.set(
        "file",
        lua.create_function(|lua, path: String| {
            validate_output_path(&path)?;
            lua.create_userdata(OutputDeclarationHandle(OutputDeclaration::File(path)))
        })?,
    )?;
    let directory_host = Rc::clone(&host);
    output.set(
        "directory",
        lua.create_function(move |lua, (path, options): (String, Option<LuaTable>)| {
            validate_output_path(&path)?;
            let named_cache = match options {
                Some(options) => {
                    for pair in options.pairs::<String, LuaValue>() {
                        let (key, _) = pair?;
                        if key != "named_cache" {
                            return Err(LuaError::external(format!(
                                "output.directory options do not accept '{key}'"
                            )));
                        }
                    }
                    parse_named_cache(&options)?
                }
                None => None,
            };
            if let Some(cache) = &named_cache {
                // GC prunes a named cache that no workspace declares.
                imp_store::usage::record_declared_cache(
                    &directory_host.borrow().workspace_id,
                    &cache.name,
                    cache.shared,
                );
            }
            lua.create_userdata(OutputDeclarationHandle(OutputDeclaration::Directory {
                path,
                named_cache,
            }))
        })?,
    )?;
    core.set("output", output)?;

    let graph_host = Rc::clone(&host);
    core.set(
        "files",
        lua.create_function(move |lua, options: LuaTable| {
            create_files_handle(lua, &graph_host, options, None)
        })?,
    )?;
    let graph_host = Rc::clone(&host);
    core.set(
        "glob",
        lua.create_function(move |lua, options: LuaTable| {
            create_files_handle(lua, &graph_host, options, None)
        })?,
    )?;
    let builtin_host = Rc::clone(&host);
    let builtin_root = loader.rules_root.clone();
    core.set(
        "builtin_files",
        lua.create_function(move |lua, options: LuaTable| {
            create_files_handle(lua, &builtin_host, options, Some(builtin_root.clone()))
        })?,
    )?;
    let unowned_host = Rc::clone(&host);
    core.set(
        "all_unowned",
        lua.create_function(move |lua, options: LuaTable| {
            let root = options
                .get::<Option<String>>("root")?
                .unwrap_or_else(|| ".".to_owned());
            let include = options.get::<Vec<String>>("include")?;
            if include.is_empty() {
                return Err(LuaError::external(
                    "all_unowned({ include }) requires glob patterns",
                ));
            }
            let exclude = options
                .get::<Option<Vec<String>>>("exclude")?
                .unwrap_or_default();
            let files = {
                let host = unowned_host.borrow();
                all_unowned_workspace_files(&host.workspace_root, &host, &root, &include, &exclude)
                    .map_err(|error| LuaError::external(format!("{error:#}")))?
            };
            let result = lua.create_table_with_capacity(files.len(), 0)?;
            for (index, file) in files.into_iter().enumerate() {
                result.raw_set(index + 1, file)?;
            }
            Ok(result)
        })?,
    )?;
    let program_host = Rc::clone(&host);
    let program_loader = loader.clone();
    core.set(
        "program",
        lua.create_function(move |lua, options: LuaTable| {
            require_graph_declaration(&program_host)?;
            for pair in options.clone().pairs::<String, LuaValue>() {
                let (key, _) = pair?;
                if key != "inputs" && key != "describe" {
                    return Err(LuaError::external(format!(
                        "program options do not accept '{key}'"
                    )));
                }
            }
            let program = Program {
                inputs: options
                    .get::<Option<LuaTable>>("inputs")?
                    .unwrap_or(lua.create_table()?),
                describe: options.get("describe")?,
                loader: program_loader.clone(),
                stack: program_loader.stack.borrow().clone(),
            };
            let handle = allocate_handle(&program_host, "program");
            program_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::Program(program));
            lua.create_userdata(handle)
        })?,
    )?;
    let graph_host = Rc::clone(&host);
    core.set(
        "task",
        lua.create_function(move |lua, options: LuaTable| {
            require_graph_declaration(&graph_host)?;
            for pair in options.pairs::<LuaValue, LuaValue>() {
                let (key, _) = pair?;
                let LuaValue::String(key) = key else {
                    return Err(LuaError::external(format!(
                        "task options require string keys, got {}",
                        key.type_name()
                    )));
                };
                let key = key.to_str()?;
                if !["run", "inputs", "outputs", "display", "cache"].contains(&key.as_ref()) {
                    return Err(LuaError::external(format!(
                        "task options do not accept '{key}'"
                    )));
                }
            }
            let display = match options.get::<LuaValue>("display")? {
                LuaValue::Nil => None,
                LuaValue::String(value) => Some(value.to_str()?.to_owned()),
                _ => return Err(LuaError::external("task.display must be a string")),
            };
            let cache = match options.get::<LuaValue>("cache")? {
                LuaValue::Nil => true,
                LuaValue::Boolean(value) => value,
                _ => return Err(LuaError::external("task.cache must be a boolean")),
            };
            let run = options.get::<LuaFunction>("run")?;
            let inputs = options
                .get::<Option<LuaTable>>("inputs")?
                .unwrap_or(lua.create_table()?);
            let mut outputs = BTreeMap::new();
            if let Some(declarations) = options.get::<Option<LuaTable>>("outputs")? {
                for pair in declarations.pairs::<String, LuaAnyUserData>() {
                    let (name, declaration) = pair?;
                    if !valid_output_name(&name) {
                        return Err(LuaError::external(format!(
                            "task.outputs has invalid slot name '{name}'"
                        )));
                    }
                    let declaration = declaration.borrow::<OutputDeclarationHandle>()?;
                    let kind = match &declaration.0 {
                        OutputDeclaration::Value => TaskOutputKind::Value,
                        OutputDeclaration::Artifact => TaskOutputKind::Artifact,
                        OutputDeclaration::File(_) | OutputDeclaration::Directory { .. } => {
                            return Err(LuaError::external(format!(
                                "task.outputs.{name} must be output.value() or output.artifact()"
                            )))
                        }
                    };
                    outputs.insert(name, kind);
                }
            }
            let handle = allocate_handle(&graph_host, "task");
            let output_handles = lua.create_table()?;
            {
                let mut host = graph_host.borrow_mut();
                host.nodes.insert(handle.id, GraphNode::Task);
                for name in outputs.keys() {
                    host.next_id += 1;
                    let output_handle = GraphHandle {
                        id: host.next_id,
                        kind: "task_output",
                        outputs: None,
                    };
                    host.nodes.insert(
                        output_handle.id,
                        GraphNode::TaskOutput {
                            task_id: handle.id,
                            name: name.clone(),
                        },
                    );
                    output_handles.set(name.as_str(), lua.create_userdata(output_handle)?)?;
                }
                host.tasks.insert(
                    handle.id,
                    Task {
                        exec_options: TaskExecOptions {
                            returns_outputs: !outputs.is_empty(),
                            display,
                            cache,
                        },
                        run,
                        inputs,
                        outputs,
                    },
                );
            }
            lua.create_userdata(GraphHandle {
                outputs: Some(output_handles),
                ..handle
            })
        })?,
    )?;
    let graph_host = Rc::clone(&host);
    core.set(
        "native_tool",
        lua.create_function(move |lua, name: String| {
            require_graph_declaration(&graph_host)?;
            if name.trim().is_empty() {
                return Err(LuaError::external(
                    "native_tool(name) requires a non-empty name",
                ));
            }
            let handle = allocate_handle(&graph_host, "native_tool");
            graph_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::NativeTool(name));
            lua.create_userdata(handle)
        })?,
    )?;
    let graph_host = Rc::clone(&host);
    core.set(
        "self_tool",
        lua.create_function(move |lua, ()| {
            require_graph_declaration(&graph_host)?;
            let handle = allocate_handle(&graph_host, "self_tool");
            graph_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::SelfTool);
            lua.create_userdata(handle)
        })?,
    )?;
    core.set(
        "memo",
        lua.create_function(|_, function: LuaFunction| Ok(function))?,
    )?;
    let read_loader = loader.clone();
    core.set(
        "read_file",
        lua.create_function(move |_, address: String| read_addressed_file(&read_loader, &address))?,
    )?;
    core.set(
        "json_decode",
        lua.create_function(|lua, text: String| {
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| LuaError::external(format!("core.json_decode: {error}")))?;
            lua.to_value_with(
                &value,
                mlua::SerializeOptions::new()
                    .serialize_none_to_null(false)
                    .serialize_unit_to_null(false),
            )
        })?,
    )?;
    core.set(
        "log_warn",
        lua.create_function(|_, message: String| {
            log::warn!(target: "imp::luau", "{message}");
            Ok(())
        })?,
    )?;
    let resolver_loader = loader.clone();
    core.set(
        "bind_tool_resolver",
        lua.create_function(move |lua, callback: LuaFunction| {
            let loader = resolver_loader.clone();
            let stack = loader.stack.borrow().clone();
            lua.create_function(move |_, ()| {
                let previous = loader.stack.replace(stack.clone());
                let result = callback.call::<LuaValue>(());
                loader.stack.replace(previous);
                result
            })
        })?,
    )?;
    core.set(
        "package_path",
        lua.create_function(move |_, ()| Ok(current_package_path(&loader)))?,
    )?;
    let rule_host = Rc::clone(&host);
    core.set(
        "register_build_rule",
        lua.create_function(move |_, options: LuaTable| {
            let rule = options.get::<String>("rule")?;
            let module = options.get::<String>("module")?;
            let export = options
                .get::<Option<String>>("export")?
                .unwrap_or_else(|| rule.clone());
            if rule.trim().is_empty()
                || export.trim().is_empty()
                || !(module.starts_with("@imp/rules/") || module.starts_with("@workspace/"))
            {
                return Err(LuaError::external(
                    "register_build_rule requires rule, export, and a file-backed module address",
                ));
            }
            rule_host
                .borrow_mut()
                .build_rules
                .insert(rule, LuauBuildRule { module, export });
            Ok(())
        })?,
    )?;
    let generator_host = Rc::clone(&host);
    let generator_configuration = Rc::clone(&configuration);
    core.set(
        "register_build_generator",
        lua.create_function(move |_, options: LuaTable| {
            let namespace = options.get::<String>("namespace")?;
            let generate = options.get::<LuaFunction>("generate")?;
            if namespace.trim().is_empty() {
                return Err(LuaError::external(
                    "register_build_generator requires a namespace",
                ));
            }
            let has_build_generate = generator_configuration
                .borrow()
                .schemas
                .get(&namespace)
                .and_then(|schema| schema.get("build_generate"))
                .and_then(|field| field.get("__imp_field"))
                .and_then(serde_json::Value::as_str)
                == Some("bool");
            if !has_build_generate {
                return Err(LuaError::external(format!(
                    "register_build_generator namespace '{namespace}' must declare a boolean build_generate field"
                )));
            }
            generator_host
                .borrow_mut()
                .build_generators
                .push(LuauBuildGenerator {
                    namespace,
                    generate,
                });
            Ok(())
        })?,
    )?;
    let generation_host = Rc::clone(&host);
    let generation_configuration = Rc::clone(&configuration);
    let generation_root = host.borrow().workspace_root.clone();
    core.set(
        "generate_build",
        lua.create_async_function(move |lua, check: bool| {
            let generators = generation_host.borrow().build_generators.clone();
            let rules = generation_host.borrow().build_rules.clone();
            let configuration = generation_configuration.borrow().values.clone();
            let workspace_root = generation_root.clone();
            let host = Rc::clone(&generation_host);
            async move {
                if !host.borrow().goal_callback_active {
                    return Err(LuaError::external(
                        "core.generate_build() can only run in a goal callback",
                    ));
                }
                let mut edits = BTreeMap::<String, Vec<GeneratedLuauBuildTarget>>::new();
                for generator in generators {
                    let enabled = configuration
                        .get(&generator.namespace)
                        .and_then(|value| value.get("build_generate"))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if !enabled {
                        continue;
                    }
                    let mut value = generator.generate.call_async::<LuaValue>(()).await?;
                    if let LuaValue::UserData(userdata) = &value {
                        let id = {
                            let handle = userdata.borrow::<GraphHandle>().map_err(|_| {
                                LuaError::external("BUILD generator requires a declaration table or task value-output handle")
                            })?;
                            if handle.kind != "task_output" {
                                return Err(LuaError::external("BUILD generator requires a declaration table or task value-output handle"));
                            }
                            let state = host.borrow();
                            let valid = match state.nodes.get(&handle.id) {
                                Some(GraphNode::TaskOutput { task_id, name }) => state
                                    .tasks
                                    .get(task_id)
                                    .and_then(|task| task.outputs.get(name))
                                    .is_some_and(|kind| matches!(kind, TaskOutputKind::Value)),
                                _ => false,
                            };
                            if !valid {
                                return Err(LuaError::external(
                                    "BUILD generator requires a task value-output handle",
                                ));
                            }
                            handle.id
                        };
                        let execute = lua.globals().get::<LuaFunction>("__imp_execute_task")?;
                        value = execute.call_async::<LuaValue>(id).await?;
                    }
                    if !matches!(value, LuaValue::Table(_)) {
                        return Err(LuaError::external("BUILD generator must produce a declaration table"));
                    }
                    let generated: BTreeMap<String, Vec<GeneratedLuauBuildTarget>> =
                        lua.from_value(value)?;
                    for (file, targets) in generated {
                        edits.entry(file).or_default().extend(targets);
                    }
                }

                let mut changed = Vec::new();
                let mut checked = Vec::new();
                for (file, targets) in edits {
                    checked.push(file.clone());
                    let destination = generated_build_destination(&workspace_root, &file)
                        .map_err(LuaError::external)?;
                    let rendered = render_generated_luau_build(&file, &targets, &rules)
                        .map_err(LuaError::external)?;
                    let existing = match fs::read_to_string(&destination) {
                        Ok(source) => source,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                        Err(error) => {
                            return Err(LuaError::external(format!(
                                "read generated BUILD file {}: {error}",
                                destination.display()
                            )))
                        }
                    };
                    if existing == rendered {
                        continue;
                    }
                    changed.push(file.clone());
                    if check {
                        continue;
                    }
                    if !existing.is_empty()
                        && !existing.starts_with("-- Generated by Imp. Do not edit.\n")
                    {
                        return Err(LuaError::external(format!(
                            "refusing to replace hand-written BUILD file '{file}'"
                        )));
                    }
                    if let Some(parent) = destination.parent() {
                        fs::create_dir_all(parent).map_err(|error| {
                            LuaError::external(format!(
                                "create generated BUILD directory {}: {error}",
                                parent.display()
                            ))
                        })?;
                    }
                    fs::write(&destination, rendered).map_err(|error| {
                        LuaError::external(format!(
                            "write generated BUILD file {}: {error}",
                            destination.display()
                        ))
                    })?;
                }
                let report = lua.create_table()?;
                report.set("changed", changed)?;
                report.set("checked", checked)?;
                Ok(report)
            }
        })?,
    )?;
    core.set(
        "sources_field",
        lua.create_function(|_, options: LuaTable| Ok(options))?,
    )?;
    let goal_host = Rc::clone(&host);
    core.set(
        "goal",
        lua.create_function(
            move |_, (name, callback, options): (String, LuaFunction, Option<LuaTable>)| {
                let valid_name = name.starts_with(|first: char| first.is_ascii_lowercase())
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
                if !valid_name {
                    return Err(LuaError::external(format!(
                        "core.goal name '{name}' must use lowercase letters, digits, and '-'"
                    )));
                }
                let (flags, selectorless) = match options {
                    Some(options) => parse_goal_options(&name, options)?,
                    None => (BTreeMap::new(), false),
                };
                let mut host = goal_host.borrow_mut();
                if host.goals.contains_key(&name) {
                    return Err(LuaError::external(format!(
                        "goal '{name}' is already registered"
                    )));
                }
                host.goals.insert(
                    name.clone(),
                    LuauGoal {
                        callback,
                        flags,
                        selectorless,
                    },
                );
                Ok(goal_slot_key(&name))
            },
        )?,
    )?;
    let flags_host = Rc::clone(&host);
    core.set(
        "goal_flags",
        lua.create_function(move |lua, ()| {
            let host = flags_host.borrow();
            if let Some(flags) = &host.fakes.goal_flags {
                return Ok(LuaValue::Table(flags.clone()));
            }
            let invocation = host.goal_invocation.as_ref().ok_or_else(|| {
                LuaError::external("core.goal_flags() can only run while a goal executes")
            })?;
            lua.to_value(&invocation.flags)
        })?,
    )?;
    let args_host = Rc::clone(&host);
    core.set(
        "run_args",
        lua.create_function(move |lua, ()| {
            // Outside a goal, as in a rule test, the program has no arguments.
            let args = args_host
                .borrow()
                .goal_invocation
                .as_ref()
                .map(|invocation| invocation.run_args.clone())
                .unwrap_or_default();
            lua.create_sequence_from(args)
        })?,
    )?;
    core.set(
        "goal_error",
        lua.create_function(|_, message: String| -> LuaResult<()> {
            Err(LuaError::external(GoalRefusal(message)))
        })?,
    )?;
    core.set(
        "read_file_in_digest",
        lua.create_function(|_, (digest, path): (String, String)| {
            let digest = DirectoryDigest::from_digest(digest);
            imp_store::digest::read_file_in_digest(&digest, &path)
                .map_err(|error| LuaError::external(format!("read_file_in_digest: {error:#}")))
        })?,
    )?;
    let diff_host = Rc::clone(&host);
    core.set(
        "diff_digests",
        lua.create_function(move |lua, (before, after): (String, String)| {
            let recorder = diff_host.borrow().fakes.diff.clone();
            if let Some(recorder) = recorder {
                let call = lua.create_table()?;
                call.set("before", before)?;
                call.set("after", after)?;
                push_record(
                    &recorder.raw_get::<LuaTable>("calls")?,
                    LuaValue::Table(call),
                )?;
                let changes = parse_fake_changes(recorder.raw_get("changes")?)?;
                return path_changes_value(lua, &changes);
            }
            let before = DirectoryDigest::from_digest(before);
            let after = DirectoryDigest::from_digest(after);
            let changes = imp_store::digest::diff_digests(&before, &after)
                .map_err(|error| LuaError::external(format!("diff_digests: {error:#}")))?
                .into_iter()
                .map(|change| match change {
                    PathChange::Added(path) => ("added", path),
                    PathChange::Removed(path) => ("removed", path),
                    PathChange::Modified(path) => ("modified", path),
                })
                .collect::<Vec<_>>();
            path_changes_value(lua, &changes)
        })?,
    )?;
    let program_host = Rc::clone(&host);
    let program_configuration = Rc::clone(&configuration);
    core.set(
        "run_program",
        lua.create_async_function(move |lua, options: LuaTable| {
            let host = Rc::clone(&program_host);
            let configuration = Rc::clone(&program_configuration);
            async move {
                run_program(lua, host, configuration, options)
                    .await
                    .map_err(|error| LuaError::external(format!("{error:#}")))
            }
        })?,
    )?;
    let workspace_for_write = host.borrow().workspace_root.clone();
    let write_host = Rc::clone(&host);
    core.set(
        "write_workspace",
        lua.create_function(
            move |lua, (path, digest, options): (String, String, Option<LuaTable>)| {
                validate_output_path(&path)?;
                let from = match options {
                    Some(options) => {
                        let mut from = None;
                        for pair in options.pairs::<String, LuaValue>() {
                            let (key, value) = pair?;
                            if key != "from" {
                                return Err(LuaError::external(format!(
                                    "write_workspace options do not accept '{key}'"
                                )));
                            }
                            from = Some(
                                value
                                    .as_string()
                                    .ok_or_else(|| {
                                        LuaError::external(
                                            "write_workspace option 'from' must be a string",
                                        )
                                    })?
                                    .to_string_lossy()
                                    .to_string(),
                            );
                        }
                        from
                    }
                    None => None,
                };
                let recorder = write_host.borrow().fakes.write_workspace.clone();
                if let Some(recorder) = recorder {
                    let call = lua.create_table()?;
                    call.set("path", path)?;
                    call.set("digest", digest)?;
                    call.set("from", from)?;
                    return push_record(
                        &recorder.raw_get::<LuaTable>("calls")?,
                        LuaValue::Table(call),
                    );
                }
                if !write_host.borrow().goal_callback_active {
                    return Err(LuaError::external(
                        "core.write_workspace() can only run in a goal callback",
                    ));
                }
                imp_store::cache::write_workspace(
                    &digest,
                    from.as_deref(),
                    &workspace_for_write.join(path),
                )
                .map_err(|error| {
                    LuaError::external(format!("publish workspace artifact: {error:#}"))
                })
            },
        )?,
    )?;
    Ok(LuaValue::Table(core))
}

/// Read the `core.goal(name, fn, { flags })` option table. Each flag is a
/// boolean CLI flag with an optional description.
/// CLI options that every goal accepts. A goal flag with one of these names
/// would make the goal command line ambiguous.
const RESERVED_GOAL_FLAGS: &[&str] = &[
    "axis",
    "case",
    "changed-since",
    "fs-jobs",
    "help",
    "jobs",
    "js-workers",
    "keep-sandbox",
    "no-cache",
    "profile",
    "suite",
    "trace-inputs",
];

fn parse_goal_options(
    goal: &str,
    options: LuaTable,
) -> LuaResult<(BTreeMap<String, Option<String>>, bool)> {
    let mut flags = BTreeMap::new();
    let mut selectorless = false;
    for pair in options.pairs::<String, LuaValue>() {
        let (key, value) = pair?;
        if key == "selection" {
            match value {
                LuaValue::String(text) if text.to_string_lossy() == "none" => selectorless = true,
                _ => {
                    return Err(LuaError::external(format!(
                        "core.goal('{goal}') selection must be \"none\""
                    )))
                }
            }
            continue;
        }
        if key != "flags" {
            return Err(LuaError::external(format!(
                "core.goal('{goal}') options do not accept '{key}'"
            )));
        }
        let LuaValue::Table(declared) = value else {
            return Err(LuaError::external(format!(
                "core.goal('{goal}') flags must be a table"
            )));
        };
        for pair in declared.pairs::<String, LuaTable>() {
            let (flag, definition) = pair.map_err(|_| {
                LuaError::external(format!(
                    "core.goal('{goal}') flags must map flag names to tables"
                ))
            })?;
            let valid = flag.starts_with(|first: char| first.is_ascii_lowercase())
                && flag
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !valid {
                return Err(LuaError::external(format!(
                    "core.goal('{goal}') flag '{flag}' must use lowercase letters, digits, and '-'"
                )));
            }
            if RESERVED_GOAL_FLAGS.contains(&flag.as_str()) {
                return Err(LuaError::external(format!(
                    "core.goal('{goal}') flag '{flag}' is reserved by the imp CLI"
                )));
            }
            let mut description = None;
            for pair in definition.pairs::<String, LuaValue>() {
                let (field, value) = pair?;
                match (field.as_str(), value) {
                    ("description", LuaValue::String(text)) => {
                        description = Some(text.to_string_lossy().to_string());
                    }
                    _ => {
                        return Err(LuaError::external(format!(
                            "core.goal('{goal}') flag '{flag}' accepts only a 'description' string"
                        )))
                    }
                }
            }
            flags.insert(flag, description);
        }
    }
    Ok((flags, selectorless))
}

/// Which host replacement a `core.test.with_fake_*` scope installs.
#[derive(Clone, Copy)]
enum FakeKind {
    Run,
    ToolchainHost,
    WriteWorkspace,
    GoalFlags,
    Diff,
}

impl FakeKind {
    fn function_name(self) -> &'static str {
        match self {
            FakeKind::Run => "core.test.with_fake_run",
            FakeKind::ToolchainHost => "core.test.with_fake_toolchain_host",
            FakeKind::WriteWorkspace => "core.test.with_fake_write_workspace",
            FakeKind::GoalFlags => "core.test.with_fake_goal_flags",
            FakeKind::Diff => "core.test.with_fake_diff",
        }
    }
}

fn require_active_test_case(host: &HostState, function: &str) -> LuaResult<()> {
    if host.test_case_active {
        Ok(())
    } else {
        Err(LuaError::external(format!(
            "{function} can only run inside a running core.test.case"
        )))
    }
}

/// Install a fake, call `body` with its recorder, and then restore the real
/// host. The fake is removed when `body` returns or fails. Task and expansion
/// results are cleared on entry and exit, so that a result computed with a
/// fake never reaches code that runs against the real host, or the reverse.
async fn with_test_fake(
    host: Rc<RefCell<HostState>>,
    kind: FakeKind,
    recorder: LuaTable,
    platform: Option<(String, String)>,
    body: LuaFunction,
) -> LuaResult<LuaMultiValue> {
    {
        let mut state = host.borrow_mut();
        require_active_test_case(&state, kind.function_name())?;
        if state.graph_callback_depth > 0 {
            return Err(LuaError::external(format!(
                "{} cannot run inside a task run or expansion create callback",
                kind.function_name()
            )));
        }
        let occupied = match kind {
            FakeKind::Run | FakeKind::ToolchainHost => state.fakes.run.is_some(),
            FakeKind::WriteWorkspace => state.fakes.write_workspace.is_some(),
            FakeKind::GoalFlags => state.fakes.goal_flags.is_some(),
            FakeKind::Diff => state.fakes.diff.is_some(),
        };
        if occupied {
            return Err(LuaError::external(format!(
                "{} cannot run while another fake replaces the same host function",
                kind.function_name()
            )));
        }
        match kind {
            FakeKind::Run => state.fakes.run = Some(recorder.clone()),
            FakeKind::ToolchainHost => {
                state.fakes.run = Some(recorder.clone());
                state.fakes.toolchain = Some(recorder.clone());
                state.fakes.platform = platform;
            }
            FakeKind::WriteWorkspace => state.fakes.write_workspace = Some(recorder.clone()),
            FakeKind::GoalFlags => state.fakes.goal_flags = Some(recorder.clone()),
            FakeKind::Diff => state.fakes.diff = Some(recorder.clone()),
        }
        state.task_results.clear();
        state.resolved_inputs.clear();
        state.expansion_results.clear();
    }
    let result = body.call_async::<LuaMultiValue>(recorder).await;
    {
        let mut state = host.borrow_mut();
        match kind {
            FakeKind::Run => state.fakes.run = None,
            FakeKind::ToolchainHost => {
                state.fakes.run = None;
                state.fakes.toolchain = None;
                state.fakes.platform = None;
            }
            FakeKind::WriteWorkspace => state.fakes.write_workspace = None,
            FakeKind::GoalFlags => state.fakes.goal_flags = None,
            FakeKind::Diff => state.fakes.diff = None,
        }
        state.task_results.clear();
        state.resolved_inputs.clear();
        state.expansion_results.clear();
    }
    result
}

/// Build the `{ type, path }` list that `core.diff_digests` returns.
fn path_changes_value(lua: &Lua, changes: &[(&str, String)]) -> LuaResult<LuaTable> {
    let list = lua.create_table()?;
    for (kind, path) in changes {
        let change = lua.create_table()?;
        change.set("type", *kind)?;
        change.set("path", path.as_str())?;
        push_record(&list, LuaValue::Table(change))?;
    }
    Ok(list)
}

/// Read the changes list of `core.test.with_fake_diff`.
fn parse_fake_changes(value: LuaValue) -> LuaResult<Vec<(&'static str, String)>> {
    let invalid = || {
        LuaError::external(
            "core.test.with_fake_diff changes must be a list of { type = \"added\"|\"removed\"|\"modified\", path = string }",
        )
    };
    let LuaValue::Table(list) = value else {
        return Err(invalid());
    };
    let len = list.raw_len();
    if list.pairs::<LuaValue, LuaValue>().count() != len {
        return Err(invalid());
    }
    let mut changes = Vec::with_capacity(len);
    for index in 1..=len {
        let LuaValue::Table(entry) = list.raw_get::<LuaValue>(index)? else {
            return Err(invalid());
        };
        let kind = match entry.raw_get::<LuaValue>("type")? {
            LuaValue::String(kind) if kind == "added" => "added",
            LuaValue::String(kind) if kind == "removed" => "removed",
            LuaValue::String(kind) if kind == "modified" => "modified",
            _ => return Err(invalid()),
        };
        let LuaValue::String(path) = entry.raw_get::<LuaValue>("path")? else {
            return Err(invalid());
        };
        changes.push((kind, path.to_str()?.to_owned()));
    }
    Ok(changes)
}

fn parse_fake_platform(value: LuaTable) -> LuaResult<(String, String)> {
    let field = |name: &str| -> LuaResult<String> {
        value
            .get::<Option<String>>(name)?
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                LuaError::external(format!(
                    "core.test.with_fake_toolchain_host platform requires a non-empty '{name}' string"
                ))
            })
    };
    Ok((field("os")?, field("arch")?))
}

fn install_test_host_api(
    lua: &Lua,
    test_api: &LuaTable,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
) -> LuaResult<()> {
    let resolve_host = Rc::clone(&host);
    let resolve_configuration = Rc::clone(&configuration);
    test_api.set(
        "resolve",
        lua.create_async_function(move |lua, handle: LuaAnyUserData| {
            let host = Rc::clone(&resolve_host);
            let configuration = Rc::clone(&resolve_configuration);
            async move {
                require_active_test_case(&host.borrow(), "core.test.resolve")?;
                let id = {
                    let handle = handle.borrow::<GraphHandle>().map_err(|_| {
                        LuaError::external(
                            "core.test.resolve requires a task or task output handle",
                        )
                    })?;
                    if handle.kind != "task"
                        && handle.kind != "task_output"
                        && handle.kind != "program"
                    {
                        return Err(LuaError::external(format!(
                            "core.test.resolve requires a task or task output handle, got {}",
                            handle.kind
                        )));
                    }
                    handle.id
                };
                let program = match unconfigured_node(&host.borrow(), id).1 {
                    Some(GraphNode::Program(program)) => Some(program.clone()),
                    _ => None,
                };
                let execute = lua.globals().get::<LuaFunction>("__imp_execute_task")?;
                let scope = scoped_node(&host.borrow(), id, &invocation_mode(&host.borrow())).1;
                let result = if let Some(program) = program {
                    describe_program_scoped(&lua, &host, &configuration, program, &scope).await
                } else {
                    execute.call_async::<LuaValue>(id).await
                };
                host.borrow_mut().task_failure = None;
                result
            }
        })?,
    )?;

    let run_host = Rc::clone(&host);
    test_api.set(
        "with_fake_run",
        lua.create_async_function(move |lua, body: LuaFunction| {
            let host = Rc::clone(&run_host);
            async move {
                let recorder = lua.create_table()?;
                recorder.set("runs", lua.create_table()?)?;
                install_run_controls(&lua, &recorder)?;
                with_test_fake(host, FakeKind::Run, recorder, None, body).await
            }
        })?,
    )?;

    let toolchain_host = Rc::clone(&host);
    test_api.set(
        "with_fake_toolchain_host",
        lua.create_async_function(
            move |lua, (first, second): (LuaValue, Option<LuaFunction>)| {
                let host = Rc::clone(&toolchain_host);
                async move {
                    let (platform, body) = match (first, second) {
                        (LuaValue::Function(body), None) => {
                            (("linux".to_owned(), "x86_64".to_owned()), body)
                        }
                        (LuaValue::Table(platform), Some(body)) => {
                            (parse_fake_platform(platform)?, body)
                        }
                        _ => {
                            return Err(LuaError::external(
                                "core.test.with_fake_toolchain_host expects ([platform,] fn)",
                            ))
                        }
                    };
                    let recorder = lua.create_table()?;
                    recorder.set("runs", lua.create_table()?)?;
                    recorder.set("calls", lua.create_table()?)?;
                    install_run_controls(&lua, &recorder)?;
                    with_test_fake(
                        host,
                        FakeKind::ToolchainHost,
                        recorder,
                        Some(platform),
                        body,
                    )
                    .await
                }
            },
        )?,
    )?;

    let write_host = Rc::clone(&host);
    test_api.set(
        "with_fake_write_workspace",
        lua.create_async_function(move |lua, body: LuaFunction| {
            let host = Rc::clone(&write_host);
            async move {
                let recorder = lua.create_table()?;
                recorder.set("calls", lua.create_table()?)?;
                with_test_fake(host, FakeKind::WriteWorkspace, recorder, None, body).await
            }
        })?,
    )?;

    let flags_host = Rc::clone(&host);
    test_api.set(
        "with_fake_goal_flags",
        lua.create_async_function(move |_, (flags, body): (LuaTable, LuaFunction)| {
            let host = Rc::clone(&flags_host);
            async move {
                for pair in flags.pairs::<LuaValue, LuaValue>() {
                    let (name, value) = pair?;
                    if !matches!(name, LuaValue::String(_))
                        || !matches!(value, LuaValue::Boolean(_))
                    {
                        return Err(LuaError::external(
                            "core.test.with_fake_goal_flags flags must map flag names to booleans",
                        ));
                    }
                }
                with_test_fake(host, FakeKind::GoalFlags, flags, None, body).await
            }
        })?,
    )?;

    let diff_host = Rc::clone(&host);
    test_api.set(
        "with_fake_diff",
        lua.create_async_function(move |lua, (changes, body): (LuaValue, LuaFunction)| {
            let host = Rc::clone(&diff_host);
            async move {
                let changes = parse_fake_changes(changes)?;
                let recorder = lua.create_table()?;
                recorder.set("changes", path_changes_value(&lua, &changes)?)?;
                recorder.set("calls", lua.create_table()?)?;
                with_test_fake(host, FakeKind::Diff, recorder, None, body).await
            }
        })?,
    )?;
    Ok(())
}

fn push_record(list: &LuaTable, record: LuaValue) -> LuaResult<()> {
    list.raw_set(list.raw_len() + 1, record)
}

fn make_field_descriptor(
    lua: &Lua,
    kind: &str,
    options: Option<LuaTable>,
    extra: &[(&str, LuaValue)],
) -> LuaResult<LuaTable> {
    let descriptor = lua.create_table()?;
    descriptor.set("__imp_field", kind)?;
    for (key, value) in extra {
        descriptor.set(*key, value.clone())?;
    }
    if let Some(options) = options {
        for pair in options.pairs::<String, LuaValue>() {
            let (key, value) = pair?;
            if key != "default" && key != "required" {
                return Err(LuaError::external(format!(
                    "field.{kind} options only accept 'default' and 'required'"
                )));
            }
            descriptor.set(key, value)?;
        }
    }
    Ok(descriptor)
}

fn validate_config_namespace(namespace: &str) -> LuaResult<()> {
    if namespace.is_empty()
        || !namespace.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(LuaError::external(format!(
            "configuration namespace '{namespace}' must use ASCII letters, digits, '.', '-', or '_'"
        )));
    }
    Ok(())
}

fn create_files_handle(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    options: LuaTable,
    source_root: Option<PathBuf>,
) -> LuaResult<LuaAnyUserData> {
    require_graph_declaration(host)?;
    let spec = FileSetSpec {
        source_root,
        root: options
            .get::<Option<String>>("root")?
            .unwrap_or_else(|| ".".to_owned()),
        include: options.get::<Vec<String>>("include")?,
        exclude: options
            .get::<Option<Vec<String>>>("exclude")?
            .unwrap_or_default(),
    };
    if spec.include.is_empty() {
        return Err(LuaError::external(
            "files({ include }) requires glob patterns",
        ));
    }
    let fingerprint = format!(
        "{:?}\n{}\n{}\n{}",
        spec.source_root,
        spec.root,
        spec.include.join("\n"),
        spec.exclude.join("\n")
    );
    if let Some(id) = host.borrow().filesets.get(&fingerprint).copied() {
        return lua.create_userdata(GraphHandle {
            id,
            kind: "files",
            outputs: None,
        });
    }
    let handle = allocate_handle(host, "files");
    let mut host = host.borrow_mut();
    host.filesets.insert(fingerprint, handle.id);
    host.nodes.insert(handle.id, GraphNode::Files(spec));
    drop(host);
    lua.create_userdata(handle)
}

fn all_unowned_workspace_files(
    workspace_root: &Path,
    host: &HostState,
    root: &str,
    include: &[String],
    exclude: &[String],
) -> Result<Vec<String>> {
    if include.is_empty() {
        bail!("all_unowned include must not be empty");
    }
    let mut owned = std::collections::BTreeSet::new();
    let mut visited_nodes = std::collections::HashSet::new();
    let mut visited_tables = std::collections::HashSet::new();
    for &root_id in &host.loaded_roots {
        collect_luau_owned_files(
            workspace_root,
            host,
            root_id,
            &mut owned,
            &mut visited_nodes,
            &mut visited_tables,
        )?;
    }

    let mut files = crate::spike::workspace_glob_files(workspace_root, root, include, exclude)?;
    files.retain(|file| !owned.contains(file));
    Ok(files)
}

fn collect_luau_owned_files(
    workspace_root: &Path,
    host: &HostState,
    node_id: u64,
    owned: &mut std::collections::BTreeSet<String>,
    visited_nodes: &mut std::collections::HashSet<u64>,
    visited_tables: &mut std::collections::HashSet<usize>,
) -> Result<()> {
    if !visited_nodes.insert(node_id) {
        return Ok(());
    }
    match host.nodes.get(&node_id) {
        Some(GraphNode::Configured { source_id, .. }) => {
            collect_luau_owned_files(
                workspace_root,
                host,
                *source_id,
                owned,
                visited_nodes,
                visited_tables,
            )?;
        }
        Some(GraphNode::Files(spec)) => {
            if spec.source_root.is_some() {
                return Ok(());
            }
            let files = crate::spike::workspace_glob_files(
                workspace_root,
                &spec.root,
                &spec.include,
                &spec.exclude,
            )
            .with_context(|| format!("expand loaded Luau sources rooted at '{}'", spec.root))?;
            owned.extend(files);
        }
        Some(GraphNode::Program(program)) => {
            collect_luau_owned_files_in_value(
                workspace_root,
                host,
                &LuaValue::Table(program.inputs.clone()),
                owned,
                visited_nodes,
                visited_tables,
            )?;
        }
        Some(GraphNode::Task) => {
            if let Some(task) = host.tasks.get(&node_id) {
                collect_luau_owned_files_in_value(
                    workspace_root,
                    host,
                    &LuaValue::Table(task.inputs.clone()),
                    owned,
                    visited_nodes,
                    visited_tables,
                )?;
            }
        }
        Some(GraphNode::TaskOutput { task_id, .. }) => {
            collect_luau_owned_files(
                workspace_root,
                host,
                *task_id,
                owned,
                visited_nodes,
                visited_tables,
            )?;
        }
        Some(GraphNode::Path { source_id, .. }) | Some(GraphNode::Tool { source_id, .. }) => {
            collect_luau_owned_files(
                workspace_root,
                host,
                *source_id,
                owned,
                visited_nodes,
                visited_tables,
            )?;
        }
        Some(GraphNode::ExpansionGet { expansion_id, .. })
        | Some(GraphNode::ExpansionAll { expansion_id, .. }) => {
            if let Some(expansion) = host.expansions.get(expansion_id) {
                collect_luau_owned_files_in_value(
                    workspace_root,
                    host,
                    &LuaValue::Table(expansion.inputs.clone()),
                    owned,
                    visited_nodes,
                    visited_tables,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn collect_luau_owned_files_in_value(
    workspace_root: &Path,
    host: &HostState,
    value: &LuaValue,
    owned: &mut std::collections::BTreeSet<String>,
    visited_nodes: &mut std::collections::HashSet<u64>,
    visited_tables: &mut std::collections::HashSet<usize>,
) -> Result<()> {
    match value {
        LuaValue::UserData(userdata) => {
            if let Ok(handle) = userdata.borrow::<GraphHandle>() {
                collect_luau_owned_files(
                    workspace_root,
                    host,
                    handle.id,
                    owned,
                    visited_nodes,
                    visited_tables,
                )?;
            }
        }
        LuaValue::Table(table) => {
            if !visited_tables.insert(table.to_pointer() as usize) {
                return Ok(());
            }
            for pair in table.pairs::<LuaValue, LuaValue>() {
                let (_, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
                collect_luau_owned_files_in_value(
                    workspace_root,
                    host,
                    &value,
                    owned,
                    visited_nodes,
                    visited_tables,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_named_cache(options: &LuaTable) -> LuaResult<Option<imp_store::cache::OutputNamedCache>> {
    let Some(cache) = options.get::<Option<LuaTable>>("named_cache")? else {
        return Ok(None);
    };
    for pair in cache.pairs::<String, LuaValue>() {
        let (key, _) = pair?;
        if key != "name" && key != "key" && key != "shared" {
            return Err(LuaError::external(format!(
                "output.directory named_cache options do not accept '{key}'"
            )));
        }
    }
    let name = cache.get::<String>("name")?;
    let key = cache.get::<String>("key")?;
    imp_store::cache::validate_named_cache_path("shared", &name, &key)
        .map_err(LuaError::external)?;
    // Toolchain installs are shared by default. Mutable state such as the
    // Kache data cache can select workspace ownership with shared = false.
    Ok(Some(imp_store::cache::OutputNamedCache {
        name,
        key,
        shared: cache.get::<Option<bool>>("shared")?.unwrap_or(true),
    }))
}

fn artifact_output_source(
    host: &Rc<RefCell<HostState>>,
    source: &LuaAnyUserData,
) -> LuaResult<u64> {
    let handle = source.borrow::<GraphHandle>()?;
    let state = host.borrow();
    let Some(GraphNode::TaskOutput { task_id, name }) = unconfigured_node(&state, handle.id).1
    else {
        return Err(LuaError::external(
            "tool/path source must be a declared task artifact output",
        ));
    };
    if !state
        .tasks
        .get(task_id)
        .and_then(|task| task.outputs.get(name))
        .is_some_and(|kind| *kind == TaskOutputKind::Artifact)
    {
        return Err(LuaError::external(
            "tool/path source must be a task output declared with output.artifact()",
        ));
    }
    Ok(handle.id)
}

fn resolve_source_artifact(
    host: &HostState,
    source_id: u64,
) -> LuaResult<imp_store::cache::CachedArtifact> {
    match host.nodes.get(&source_id) {
        Some(GraphNode::Artifact(artifact)) => Ok(artifact.clone()),
        Some(GraphNode::TaskOutput { task_id, name }) => {
            // Only sources that read no axes keep their declared tool/path
            // handles. Mode-dependent sources bind to artifacts per edge.
            let result = host
                .task_results
                .get(&(*task_id, "{}".to_owned()))
                .ok_or_else(|| {
                    LuaError::external("Luau task dependency did not produce a result")
                })?;
            let value = result.get::<LuaAnyUserData>(name.as_str())?;
            let source = value.borrow::<GraphHandle>()?;
            match host.nodes.get(&source.id) {
                Some(GraphNode::Artifact(artifact)) => Ok(artifact.clone()),
                _ => Err(LuaError::external("task output is not an artifact handle")),
            }
        }
        _ => Err(LuaError::external("invalid Luau artifact source handle")),
    }
}

fn validate_tool_bin_dir(directory: &str) -> LuaResult<()> {
    if directory.is_empty()
        || Path::new(directory).is_absolute()
        || Path::new(directory)
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(LuaError::external(
            "tool.bin_dirs entries must be relative paths inside the tool root",
        ));
    }
    Ok(())
}

/// The fileset captures of one task run, by files handle id. `exec.paths`,
/// `exec.digest`, and `exec.action` share them, so that a task sees one
/// capture of each fileset.
type FilesetCaptures = Rc<RefCell<HashMap<u64, Rc<crate::spike::GlobResult>>>>;

/// Return the capture of the files handle `id` for this task run. Capture
/// the workspace files on the first call. Return `None` when `id` is not a
/// files handle.
fn captured_fileset(
    host: &HostState,
    captures: &FilesetCaptures,
    id: u64,
) -> Result<Option<Rc<crate::spike::GlobResult>>> {
    let Some(GraphNode::Files(spec)) = host.nodes.get(&id) else {
        return Ok(None);
    };
    if let Some(captured) = captures.borrow().get(&id) {
        return Ok(Some(Rc::clone(captured)));
    }
    let captured = Rc::new(crate::spike::workspace_glob_files_captured(
        spec.source_root.as_deref().unwrap_or(&host.workspace_root),
        &spec.root,
        &spec.include,
        &spec.exclude,
    )?);
    captures.borrow_mut().insert(id, Rc::clone(&captured));
    Ok(Some(captured))
}

/// Fail unless the handle `id` is one of the task inputs.
fn require_declared_input(inputs: &LuaTable, id: u64, function: &str) -> LuaResult<()> {
    for pair in inputs.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair?;
        if let LuaValue::UserData(value) = value {
            if value
                .borrow::<GraphHandle>()
                .is_ok_and(|input| input.id == id)
            {
                return Ok(());
            }
        }
    }
    Err(LuaError::external(format!(
        "{function}(handle) requires a declared task input"
    )))
}

fn configured_handle(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    source: &GraphHandle,
    mut overrides: ModeScope,
) -> LuaResult<GraphHandle> {
    let mut source_id = source.id;
    let node = host.borrow().nodes.get(&source_id).cloned();
    if let Some(GraphNode::Configured {
        source_id: inner,
        overrides: mut merged,
    }) = node
    {
        merged.extend(overrides);
        overrides = merged;
        source_id = inner;
    }
    let key = (source_id, overrides.clone());
    if let Some(handle) = host.borrow().configured_handles.get(&key).cloned() {
        return Ok(handle);
    }
    let handle = allocate_handle(host, source.kind);
    host.borrow_mut().nodes.insert(
        handle.id,
        GraphNode::Configured {
            source_id,
            overrides: overrides.clone(),
        },
    );
    let outputs = if let Some(outputs) = &source.outputs {
        let wrapped = lua.create_table()?;
        for pair in outputs.pairs::<String, LuaAnyUserData>() {
            let (name, output) = pair?;
            let output = configured_handle(
                lua,
                host,
                &output.borrow::<GraphHandle>()?.clone(),
                overrides.clone(),
            )?;
            wrapped.set(name, lua.create_userdata(output)?)?;
        }
        Some(wrapped)
    } else {
        None
    };
    let handle = GraphHandle { outputs, ..handle };
    host.borrow_mut()
        .configured_handles
        .insert(key, handle.clone());
    Ok(handle)
}

fn scoped_node(host: &HostState, mut id: u64, scope: &ModeScope) -> (u64, ModeScope) {
    let mut scope = scope.clone();
    while let Some(GraphNode::Configured {
        source_id,
        overrides,
    }) = host.nodes.get(&id)
    {
        scope.extend(overrides.clone());
        id = *source_id;
    }
    (id, scope)
}

fn unconfigured_node(host: &HostState, mut id: u64) -> (u64, Option<&GraphNode>) {
    while let Some(GraphNode::Configured { source_id, .. }) = host.nodes.get(&id) {
        id = *source_id;
    }
    (id, host.nodes.get(&id))
}

fn allocate_handle(host: &Rc<RefCell<HostState>>, kind: &'static str) -> GraphHandle {
    let mut host = host.borrow_mut();
    host.next_id += 1;
    GraphHandle {
        id: host.next_id,
        kind,
        outputs: None,
    }
}

fn create_expansion_projection(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    expansion_id: u64,
    key: String,
    workflow: String,
    facet: Option<String>,
    all: bool,
) -> LuaResult<LuaAnyUserData> {
    require_graph_declaration(host)?;
    if !is_slot_key(&workflow) {
        return Err(LuaError::external(format!(
            "expansion workflow must be a goal slot key such as BUILD or TEST; got '{workflow}'"
        )));
    }
    if !all && key.is_empty() {
        return Err(LuaError::external(
            "expansion.get(key, workflow) requires a non-empty child key",
        ));
    }
    if facet.as_deref() == Some("") {
        return Err(LuaError::external("expansion facet must be non-empty"));
    }
    if !host.borrow().expansions.contains_key(&expansion_id) {
        return Err(LuaError::external(format!(
            "unknown Luau expansion {expansion_id}"
        )));
    }
    let kind = if all {
        "expansion_all"
    } else {
        "expansion_get"
    };
    let handle = allocate_handle(host, kind);
    host.borrow_mut().nodes.insert(
        handle.id,
        if all {
            GraphNode::ExpansionAll {
                expansion_id,
                workflow,
                facet,
            }
        } else {
            GraphNode::ExpansionGet {
                expansion_id,
                key,
                workflow,
                facet,
            }
        },
    );
    lua.create_userdata(handle)
}

fn validate_expansion_child(
    host: &HostState,
    handle_id: u64,
    workflow: &str,
    key: &str,
) -> Result<()> {
    let valid = match unconfigured_node(host, handle_id).1 {
        Some(
            GraphNode::Task
            | GraphNode::TaskOutput { .. }
            | GraphNode::ExpansionGet { .. }
            | GraphNode::ExpansionAll { .. },
        ) => true,
        Some(GraphNode::Program(_)) => workflow == "RUN",
        Some(GraphNode::TestRoot { .. }) => workflow == "TEST",
        _ => false,
    };
    if !valid {
        bail!("expansion child '{key}' has no requested {workflow} workflow handle");
    }
    Ok(())
}

fn validate_output_path(path: &str) -> LuaResult<()> {
    if path.is_empty() {
        return Err(LuaError::external(
            "output path must be a non-empty workspace-relative path",
        ));
    }
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(LuaError::external(
            "output path must stay within the workspace",
        ));
    }
    Ok(())
}

fn valid_output_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_.-".contains(ch))
}

fn configured_base_env(configuration: &ConfigurationState) -> Result<BTreeMap<String, String>> {
    imp_execution::staging::resolve_base_env(&configured_passthrough_entries(configuration)?)
}

/// The `imp.passthrough_env` entries of the workspace configuration.
fn configured_passthrough_entries(configuration: &ConfigurationState) -> Result<Vec<String>> {
    let entries = configuration
        .values
        .get("imp")
        .and_then(|config| config.get("passthrough_env"))
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|entry| {
                    entry
                        .as_str()
                        .filter(|entry| !entry.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            anyhow::anyhow!("imp.passthrough_env entries must be non-empty strings")
                        })
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(entries)
}

/// Read `exec.action({ outputs })` into the output names, their declared
/// paths, and the output specifications for the execution service.
fn parse_action_outputs(options: &LuaTable) -> Result<(BTreeMap<String, String>, Vec<ExecIoSpec>)> {
    let mut declared_outputs = BTreeMap::new();
    let mut output_paths = std::collections::HashSet::new();
    let mut output_specs = Vec::new();
    if let Some(outputs) = options
        .get::<Option<LuaTable>>("outputs")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
    {
        for pair in outputs.pairs::<String, LuaAnyUserData>() {
            let (name, declaration) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if !valid_output_name(&name) {
                bail!("exec.action().outputs has invalid name '{name}'");
            }
            let declaration = declaration
                .borrow::<OutputDeclarationHandle>()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let (kind, path, named_cache) = match &declaration.0 {
                OutputDeclaration::File(path) => ("file", path, None),
                OutputDeclaration::Directory { path, named_cache } => {
                    ("directory", path, named_cache.as_ref())
                }
                OutputDeclaration::Value | OutputDeclaration::Artifact => {
                    bail!(
                        "exec.action outputs must use output.file(path) or output.directory(path)"
                    )
                }
            };
            if !output_paths.insert(path.clone()) {
                bail!("exec.action declares output path '{path}' twice");
            }
            if declared_outputs
                .insert(name.clone(), path.clone())
                .is_some()
            {
                bail!("exec.action declares output '{name}' more than once");
            }
            output_specs.push(ExecIoSpec {
                path: Some(path.clone()),
                kind: kind.to_owned(),
                digest: None,
                named_cache: named_cache.cloned(),
            });
        }
    }
    Ok((declared_outputs, output_specs))
}

/// Return the named cache of a `core.tool()` source artifact. The fake and
/// the real action paths both use this check.
fn tool_named_cache(
    host: &HostState,
    name: &str,
    source_id: u64,
    owner_package: &str,
) -> Result<imp_store::cache::OutputNamedCache> {
    if let Some(cache) = host
        .cached_tool_bindings
        .as_ref()
        .and_then(|bindings| bindings.get(&source_id))
    {
        return Ok(cache.clone());
    }
    let artifact = resolve_source_artifact(host, source_id)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if artifact.kind != "directory" {
        bail!("tool '{name}' declared in package '{owner_package}' must use a directory artifact");
    }
    artifact.named_cache.with_context(|| {
        format!("tool '{name}' declared in package '{owner_package}' must come from an output with named_cache")
    })
}

/// Return the absolute host directory of the named cache that holds a tool
/// input. The fakes that replace `exec.action` do not populate a cache, so
/// they return `/cache/<name>/<key>` instead.
fn exec_tool_dir(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    inputs: &LuaTable,
    id: u64,
) -> LuaResult<String> {
    require_declared_input(inputs, id, "exec.tool_dir")?;
    let Some(GraphNode::Tool {
        name,
        source_id,
        owner_package,
        ..
    }) = host.borrow().nodes.get(&id).cloned()
    else {
        return Err(LuaError::external(
            "exec.tool_dir(handle) requires a tool handle",
        ));
    };
    let cache = tool_named_cache(&host.borrow(), &name, source_id, &owner_package)
        .map_err(|error| LuaError::external(format!("exec.tool_dir: {error:#}")))?;
    let (fake_run, toolchain, workspace_id, service) = {
        let host = host.borrow();
        (
            host.fakes.run.is_some(),
            host.fakes.toolchain.clone(),
            host.workspace_id.clone(),
            Arc::clone(&host.service),
        )
    };
    if fake_run {
        if let Some(toolchain) = toolchain {
            push_record(
                &toolchain.raw_get::<LuaTable>("calls")?,
                LuaValue::Table(lua.create_sequence_from([
                    "tool_dir",
                    cache.name.as_str(),
                    cache.key.as_str(),
                ])?),
            )?;
        }
        return Ok(format!("/cache/{}/{}", cache.name, cache.key));
    }
    let path = service
        .cache_dir_get(
            imp_store::cache::named_cache_scope_id(cache.shared, &workspace_id),
            &cache.name,
            &cache.key,
        )
        .map_err(|error| LuaError::external(format!("exec.tool_dir: {error:#}")))?
        .ok_or_else(|| {
            LuaError::external(format!(
                "exec.tool_dir: tool '{name}' cache '{}/{}' is missing",
                cache.name, cache.key
            ))
        })?;
    Ok(path.to_string_lossy().into_owned())
}

/// Read and validate the `exec.action({ env })` table.
fn action_env_entries(action_env: Option<&LuaTable>) -> Result<Vec<(String, String)>> {
    let mut entries = Vec::new();
    if let Some(action_env) = action_env {
        for pair in action_env.pairs::<String, String>() {
            let (name, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0')
            {
                bail!("exec.action().env requires valid environment names and values");
            }
            entries.push((name, value));
        }
    }
    Ok(entries)
}

struct FakeActionRequest {
    argv: Vec<String>,
    display: String,
    cache: bool,
    allow_failure: bool,
    env: Option<LuaTable>,
    inputs: Option<LuaTable>,
    task_inputs: LuaTable,
}

/// Record an action request in a test fake and return placeholder artifacts
/// for its declared outputs. The fake does not stage inputs, resolve tools,
/// or call the execution service.
fn run_fake_action(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    recorder: &LuaTable,
    request: FakeActionRequest,
    options: &LuaTable,
) -> Result<LuaTable> {
    let lua_error = |error: LuaError| anyhow::anyhow!(error.to_string());
    let mut input_count = 0;
    let recorded_inputs = lua.create_table().map_err(lua_error)?;
    if let Some(inputs) = &request.inputs {
        for value in inputs.sequence_values::<LuaAnyUserData>() {
            let value = value.map_err(lua_error)?;
            let handle = value.borrow::<GraphHandle>().map_err(lua_error)?;
            input_count += 1;
            if let Some(GraphNode::Artifact(artifact)) = host.borrow().nodes.get(&handle.id) {
                let record = lua.create_table().map_err(lua_error)?;
                record
                    .set("path", artifact.path.clone())
                    .map_err(lua_error)?;
                record
                    .set("digest", normalize_luau_artifact(artifact)?.digest())
                    .map_err(lua_error)?;
                recorded_inputs
                    .set(input_count, record)
                    .map_err(lua_error)?;
            }
        }
    }
    let toolchain = host.borrow().fakes.toolchain.clone();
    let toolchain_calls = toolchain
        .map(|toolchain| toolchain.raw_get::<LuaTable>("calls"))
        .transpose()
        .map_err(lua_error)?;

    let mut tool_names = Vec::new();
    let mut seen_tools = std::collections::HashSet::new();
    for pair in request.task_inputs.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair.map_err(lua_error)?;
        let LuaValue::UserData(value) = value else {
            continue;
        };
        let Ok(handle) = value.borrow::<GraphHandle>() else {
            continue;
        };
        let node = host.borrow().nodes.get(&handle.id).cloned();
        match node {
            Some(GraphNode::NativeTool(name)) => {
                if !seen_tools.insert(name.clone()) {
                    bail!("exec.action received tool name '{name}' more than once");
                }
                if let Some(calls) = &toolchain_calls {
                    push_record(
                        calls,
                        LuaValue::Table(
                            lua.create_sequence_from(["native_tool", name.as_str()])
                                .map_err(lua_error)?,
                        ),
                    )
                    .map_err(lua_error)?;
                }
                tool_names.push(name);
            }
            Some(GraphNode::SelfTool) => {
                let name = SELF_TOOL_NAME.to_owned();
                if !seen_tools.insert(name.clone()) {
                    bail!("exec.action received tool name '{name}' more than once");
                }
                if let Some(calls) = &toolchain_calls {
                    push_record(
                        calls,
                        LuaValue::Table(
                            lua.create_sequence_from(["self_tool"]).map_err(lua_error)?,
                        ),
                    )
                    .map_err(lua_error)?;
                }
                tool_names.push(name);
            }
            Some(GraphNode::Tool {
                name,
                source_id,
                owner_package,
                ..
            }) => {
                if !seen_tools.insert(name.clone()) {
                    bail!("exec.action received tool name '{name}' more than once");
                }
                tool_named_cache(&host.borrow(), &name, source_id, &owner_package)?;
                tool_names.push(name);
            }
            _ => {}
        }
    }
    tool_names.sort();

    let (declared_outputs, output_specs) = parse_action_outputs(options)?;
    let env_entries = action_env_entries(request.env.as_ref())?;

    let record = lua.create_table().map_err(lua_error)?;
    record
        .set("argv", request.argv.clone())
        .map_err(lua_error)?;
    record
        .set("display", request.display.clone())
        .map_err(lua_error)?;
    record.set("cache", request.cache).map_err(lua_error)?;
    record
        .set("allow_failure", request.allow_failure)
        .map_err(lua_error)?;
    let env = lua.create_table().map_err(lua_error)?;
    for (name, value) in env_entries {
        env.set(name, value).map_err(lua_error)?;
    }
    record.set("env", env).map_err(lua_error)?;
    record.set("input_count", input_count).map_err(lua_error)?;
    record.set("inputs", recorded_inputs).map_err(lua_error)?;
    record.set("tools", tool_names).map_err(lua_error)?;
    let recorded_outputs = lua.create_table().map_err(lua_error)?;

    let artifacts = lua.create_table().map_err(lua_error)?;
    for (name, path) in declared_outputs {
        let spec = output_specs
            .iter()
            .find(|spec| spec.path.as_deref() == Some(path.as_str()))
            .context("fake action lost a declared output")?;
        if let (Some(calls), Some(cache)) = (&toolchain_calls, &spec.named_cache) {
            push_record(
                calls,
                LuaValue::Table(
                    lua.create_sequence_from([
                        "named_cache",
                        cache.name.as_str(),
                        cache.key.as_str(),
                    ])
                    .map_err(lua_error)?,
                ),
            )
            .map_err(lua_error)?;
        }
        recorded_outputs
            .set(name.as_str(), path.as_str())
            .map_err(lua_error)?;
        let digest = format!("fake-digest:{} {name}", request.display);
        let artifact = imp_store::cache::CachedArtifact {
            artifact_id: format!("fake:{} {name}", request.display),
            kind: spec.kind.clone(),
            path: Some(path),
            value: None,
            digest: digest.clone(),
            bytes: Some(0),
            mode: None,
            tree_digest: (spec.kind == "directory").then_some(digest),
            named_cache: spec.named_cache.clone(),
        };
        let handle = allocate_handle(host, "artifact");
        host.borrow_mut()
            .nodes
            .insert(handle.id, GraphNode::Artifact(artifact));
        artifacts
            .set(name, lua.create_userdata(handle).map_err(lua_error)?)
            .map_err(lua_error)?;
    }
    record.set("outputs", recorded_outputs).map_err(lua_error)?;
    push_record(
        &recorder.raw_get::<LuaTable>("runs").map_err(lua_error)?,
        LuaValue::Table(record),
    )
    .map_err(lua_error)?;

    let (exit_code, stdout, stderr) =
        fake_run_status(recorder, &request.display).map_err(lua_error)?;
    if exit_code != 0 && !request.allow_failure {
        bail!(
            "graph action '{}' exited with {exit_code}: {stderr}",
            request.display
        );
    }
    let result = lua.create_table().map_err(lua_error)?;
    result.set("outputs", artifacts).map_err(lua_error)?;
    set_action_status(&result, exit_code, stdout, stderr).map_err(lua_error)?;
    Ok(result)
}

/// The status that a run fake returns for an action or program display. The
/// default is a successful run with empty output.
fn fake_run_status(recorder: &LuaTable, display: &str) -> LuaResult<(i32, String, String)> {
    let control = |name: &str| -> LuaResult<LuaValue> {
        recorder
            .raw_get::<LuaTable>(name)?
            .raw_get::<LuaValue>(display)
    };
    let exit_code = match control("run_exit_code")? {
        LuaValue::Integer(code) => code as i32,
        LuaValue::Number(code) => code as i32,
        _ => 0,
    };
    let text = |value: LuaValue| match value {
        LuaValue::String(text) => text.to_string_lossy().to_string(),
        _ => String::new(),
    };
    Ok((
        exit_code,
        text(control("run_stdout")?),
        text(control("run_stderr")?),
    ))
}

/// Add the run status controls of the JavaScript toolchain fake to a run
/// recorder: `set_run_stdout`, `set_run_stderr`, and `set_run_exit_code`.
/// Each control matches an action or program by its display.
fn install_run_controls(lua: &Lua, recorder: &LuaTable) -> LuaResult<()> {
    recorder.set("workers", lua.create_table()?)?;
    for (setter, field) in [
        ("set_run_stdout", "run_stdout"),
        ("set_run_stderr", "run_stderr"),
        ("set_run_exit_code", "run_exit_code"),
    ] {
        let values = lua.create_table()?;
        recorder.set(field, values.clone())?;
        let numeric = field == "run_exit_code";
        recorder.set(
            setter,
            lua.create_function(move |_, (display, value): (String, LuaValue)| {
                let valid = if numeric {
                    matches!(value, LuaValue::Integer(_))
                        || matches!(value, LuaValue::Number(number) if number.fract() == 0.0)
                } else {
                    matches!(value, LuaValue::String(_))
                };
                if !valid {
                    return Err(LuaError::external(format!(
                        "{setter}(display, value) requires a {}",
                        if numeric { "whole number" } else { "string" }
                    )));
                }
                values.raw_set(display, value)
            })?,
        )?;
    }
    Ok(())
}

async fn run_action(
    lua: Lua,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
    options: LuaTable,
    task_inputs: LuaTable,
    captures: FilesetCaptures,
    config_digest: String,
) -> Result<LuaTable> {
    let argv = options
        .get::<Option<Vec<String>>>("argv")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .filter(|argv| !argv.is_empty())
        .context("exec.action({ argv }) requires a non-empty argv")?;
    let display = options
        .get::<Option<String>>("display")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .unwrap_or_else(|| argv.join(" "));
    let cache = options
        .get::<Option<bool>>("cache")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .unwrap_or(true);
    let allow_failure = options
        .get::<Option<bool>>("allow_failure")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .unwrap_or(false);
    let cache = cache && host.borrow().cached_tool_bindings.is_none();
    let allow_failure = allow_failure || host.borrow().cached_tool_bindings.is_some();
    let action_env = options
        .get::<Option<LuaTable>>("env")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let action_inputs = options
        .get::<Option<LuaTable>>("inputs")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let fake_run = host.borrow().fakes.run.clone();
    if let Some(recorder) = fake_run {
        return run_fake_action(
            &lua,
            &host,
            &recorder,
            FakeActionRequest {
                argv,
                display,
                cache,
                allow_failure,
                env: action_env,
                inputs: action_inputs,
                task_inputs,
            },
            &options,
        );
    }
    let (root, workspace_id, service, nodes, cancellation) = {
        let host = host.borrow();
        (
            host.workspace_root.clone(),
            host.workspace_id.clone(),
            Arc::clone(&host.service),
            host.nodes.clone(),
            Arc::clone(&host.cancellation),
        )
    };

    let mut input_specs = Vec::new();
    if let Some(inputs) = action_inputs {
        for value in inputs.sequence_values::<LuaAnyUserData>() {
            let value = value.map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let handle = value
                .borrow::<GraphHandle>()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if let Some(captured) = captured_fileset(&host.borrow(), &captures, handle.id)? {
                input_specs.push(ExecIoSpec {
                    path: None,
                    kind: "digest".to_owned(),
                    digest: Some(captured.digest.digest().to_owned()),
                    named_cache: None,
                });
            } else if let Some(GraphNode::Artifact(artifact)) = nodes.get(&handle.id) {
                let tree = normalize_luau_artifact(artifact)?;
                input_specs.push(ExecIoSpec {
                    path: None,
                    kind: "digest".to_owned(),
                    digest: Some(tree.digest().to_owned()),
                    named_cache: None,
                });
            } else if let Some(GraphNode::Path { source_id, .. }) = nodes.get(&handle.id) {
                let artifact = resolve_source_artifact(&host.borrow(), *source_id)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let tree = normalize_luau_artifact(&artifact)?;
                input_specs.push(ExecIoSpec {
                    path: None,
                    kind: "digest".to_owned(),
                    digest: Some(tree.digest().to_owned()),
                    named_cache: None,
                });
            }
        }
    }
    let input_digest = imp_execution::staging::resolve_input_digest(&root, &input_specs)?;

    let mut tool_values = Vec::new();
    for pair in task_inputs.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
        tool_values.push(value);
    }
    let tools = resolve_tool_specs(&host, &service, &workspace_id, tool_values, "exec.action")?;

    let (declared_outputs, output_specs) = parse_action_outputs(&options)?;

    let mut env = configured_base_env(&configuration.borrow())?;
    env.extend(action_env_entries(action_env.as_ref())?);
    let action = ExecAction {
        argv,
        display: display.clone(),
        env,
        config_digest,
        input_digest,
        outputs: output_specs,
        tools,
        cores: 1,
        impure: false,
        force_cache: false,
        no_cache: !cache,
        sandbox_retention: SandboxRetention::OnFailure,
        allow_failure,
    };
    let scheduler = host.borrow().scheduler.clone();
    let outcome = if let Some(scheduler) = scheduler {
        scheduler
            .run(
                None,
                display.clone(),
                imp_scheduler::TaskKind::Sandbox,
                1,
                move |context| {
                    let outcome = service.execute_with_start(
                        &workspace_id,
                        action,
                        Some(cancellation.as_ref()),
                        &crate::spike::SchedulerGate(&context),
                    )?;
                    crate::spike::report_cache_telemetry(&context, outcome.cache_outcome);
                    Ok(outcome)
                },
            )
            .await?
    } else {
        tokio::task::spawn_blocking(move || {
            service.execute(&workspace_id, action, Some(cancellation.as_ref()))
        })
        .await
        .context("join hermetic graph action")??
    };
    if outcome.exit_code != 0 && !allow_failure {
        bail!(
            "graph action '{display}' exited with {}: {}",
            outcome.exit_code,
            outcome.stderr
        );
    }
    {
        let mut host = host.borrow_mut();
        host.action_count += 1;
        if matches!(
            outcome.cache_outcome,
            CacheOutcome::HitLocal | CacheOutcome::HitRemote
        ) {
            host.cache_hit_count += 1;
        }
    }
    let artifacts = lua
        .create_table()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    for (name, path) in declared_outputs {
        let artifact = outcome
            .outputs
            .iter()
            .find(|artifact| artifact.path.as_deref() == Some(path.as_str()))
            .cloned();
        let artifact = artifact.with_context(|| {
            format!("execution service did not return declared output '{name}'")
        })?;
        let handle = allocate_handle(&host, "artifact");
        host.borrow_mut()
            .nodes
            .insert(handle.id, GraphNode::Artifact(artifact));
        artifacts
            .set(
                name,
                lua.create_userdata(handle)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?,
            )
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
    let result = lua
        .create_table()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    result
        .set("outputs", artifacts)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    set_action_status(&result, outcome.exit_code, outcome.stdout, outcome.stderr)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(result)
}

fn set_action_status(
    result: &LuaTable,
    exit_code: i32,
    stdout: String,
    stderr: String,
) -> LuaResult<()> {
    result.set("exit_code", exit_code)?;
    result.set("stdout", stdout)?;
    result.set("stderr", stderr)
}

/// The tool name of the running Imp executable in an action.
const SELF_TOOL_NAME: &str = "imp";

/// Make a tool specification for a host executable. The cache key includes
/// the canonical location and the content digest of the executable, so action
/// identity follows the selected file and not the ambient `PATH`.
fn host_executable_tool_spec(
    service: &Arc<dyn ExecutionService>,
    name: String,
    resolved: PathBuf,
) -> Result<ExecToolSpec> {
    let resolved = dunce::canonicalize(&resolved)
        .with_context(|| format!("canonicalize tool '{name}' {}", resolved.display()))?;
    let content_digest = service
        .file_sha256(&resolved)
        .with_context(|| format!("digest tool '{name}' {}", resolved.display()))?;
    let path = crate::spike::singleflight_register_native_tool(service, &name, &resolved)
        .map_err(anyhow::Error::msg)?;
    let key = imp_store::cache::digest_json(&serde_json::json!({
        "path": resolved,
        "digest": content_digest,
    }))?;
    Ok(ExecToolSpec {
        name,
        cache: "native-tools".to_owned(),
        key,
        path,
        bin_dirs: vec![".".to_owned()],
    })
}

/// Resolve tool handles to tool specifications for the execution service.
/// Values that are not tool handles are ignored. A tool name may occur once.
fn resolve_tool_specs(
    host: &Rc<RefCell<HostState>>,
    service: &Arc<dyn ExecutionService>,
    workspace_id: &str,
    values: Vec<LuaValue>,
    api: &str,
) -> Result<Vec<ExecToolSpec>> {
    let mut tools = Vec::new();
    let mut tool_names = std::collections::HashSet::new();
    for value in values {
        let LuaValue::UserData(value) = value else {
            continue;
        };
        let handle = match value.borrow::<GraphHandle>() {
            Ok(handle) => handle,
            Err(_) => continue,
        };
        let node = host.borrow().nodes.get(&handle.id).cloned();
        match node {
            Some(GraphNode::NativeTool(name)) => {
                if !tool_names.insert(name.clone()) {
                    bail!("{api} received tool name '{name}' more than once");
                }
                let resolved = crate::spike::which_executable(&name)
                    .with_context(|| format!("native tool '{name}' was not found on PATH"))?;
                tools.push(host_executable_tool_spec(service, name, resolved.into())?);
            }
            Some(GraphNode::SelfTool) => {
                let name = SELF_TOOL_NAME.to_owned();
                if !tool_names.insert(name.clone()) {
                    bail!("{api} received tool name '{name}' more than once");
                }
                let resolved =
                    std::env::current_exe().context("resolve the running imp executable")?;
                tools.push(host_executable_tool_spec(service, name, resolved)?);
            }
            Some(GraphNode::Tool {
                name,
                bin_dirs,
                source_id,
                owner_package,
            }) => {
                if !tool_names.insert(name.clone()) {
                    bail!("{api} received tool name '{name}' more than once");
                }
                let cache = tool_named_cache(&host.borrow(), &name, source_id, &owner_package)?;
                let path = service
                    .cache_dir_get(
                        imp_store::cache::named_cache_scope_id(cache.shared, workspace_id),
                        &cache.name,
                        &cache.key,
                    )?
                    .with_context(|| {
                        format!(
                            "tool '{}' cache '{}/{}' is missing",
                            name, cache.name, cache.key
                        )
                    })?;
                tools.push(ExecToolSpec {
                    name,
                    cache: cache.name.clone(),
                    key: cache.key.clone(),
                    path,
                    bin_dirs,
                });
            }
            _ => {}
        }
    }
    Ok(tools)
}

/// Run one interactive program for the `run` workflow. The host owns the
/// policy, as the JavaScript `run` workflow does: the program is impure, runs
/// in a sandbox with the workspace as its working directory, streams its
/// output to the terminal, and receives the CLI arguments after `--`.
async fn run_program(
    lua: Lua,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
    options: LuaTable,
) -> Result<LuaTable> {
    if host.borrow().program_describing {
        bail!("a program description cannot launch a program");
    }
    let lua_error = |error: LuaError| anyhow::anyhow!(error.to_string());
    for pair in options.pairs::<String, LuaValue>() {
        let (key, _) = pair.map_err(lua_error)?;
        if !matches!(
            key.as_str(),
            "argv" | "display" | "env" | "inputs" | "tools"
        ) {
            bail!("core.run_program options do not accept '{key}'");
        }
    }
    let mut argv = options
        .get::<Option<Vec<String>>>("argv")
        .map_err(lua_error)?
        .filter(|argv| !argv.is_empty())
        .context("core.run_program({ argv }) requires a non-empty argv")?;
    let display = options
        .get::<Option<String>>("display")
        .map_err(lua_error)?
        .unwrap_or_else(|| argv.join(" "));
    let env = options.get::<Option<LuaTable>>("env").map_err(lua_error)?;
    let mut digests = Vec::new();
    if let Some(inputs) = options
        .get::<Option<LuaTable>>("inputs")
        .map_err(lua_error)?
    {
        for value in inputs.sequence_values::<LuaValue>() {
            let digest = match value.map_err(lua_error)? {
                LuaValue::String(digest) => Some(digest.to_string_lossy().to_string()),
                LuaValue::Table(artifact) => artifact
                    .get::<Option<String>>("digest")
                    .map_err(lua_error)?,
                _ => None,
            };
            digests.push(digest.context(
                "core.run_program inputs must be digest strings or tables with a digest",
            )?);
        }
    }
    let mut tool_values = Vec::new();
    if let Some(tools) = options
        .get::<Option<LuaTable>>("tools")
        .map_err(lua_error)?
    {
        for value in tools.sequence_values::<LuaValue>() {
            tool_values.push(value.map_err(lua_error)?);
        }
    }
    let run_args = host
        .borrow()
        .goal_invocation
        .as_ref()
        .map(|invocation| invocation.run_args.clone())
        .unwrap_or_default();
    argv.extend(run_args);
    let env_entries = action_env_entries(env.as_ref())?;

    let fake_run = host.borrow().fakes.run.clone();
    if fake_run.is_none() && !host.borrow().goal_callback_active {
        bail!("core.run_program() can only run in a goal callback");
    }
    if let Some(recorder) = fake_run {
        let record = lua.create_table().map_err(lua_error)?;
        record.set("program", true).map_err(lua_error)?;
        record.set("argv", argv).map_err(lua_error)?;
        record.set("display", display.as_str()).map_err(lua_error)?;
        let env = lua.create_table().map_err(lua_error)?;
        for (name, value) in env_entries {
            env.set(name, value).map_err(lua_error)?;
        }
        record.set("env", env).map_err(lua_error)?;
        record.set("inputs", digests).map_err(lua_error)?;
        record
            .set(
                "tools",
                lua.create_sequence_from(tool_values).map_err(lua_error)?,
            )
            .map_err(lua_error)?;
        for flag in ["impure", "sandbox", "workspace_cwd", "stream"] {
            record.set(flag, true).map_err(lua_error)?;
        }
        push_record(
            &recorder.raw_get::<LuaTable>("runs").map_err(lua_error)?,
            LuaValue::Table(record),
        )
        .map_err(lua_error)?;
        let (exit_code, stdout, stderr) =
            fake_run_status(&recorder, &display).map_err(lua_error)?;
        if exit_code != 0 {
            // The same message as a real program that fails.
            bail!("run program '{display}': {display} failed with exit code {exit_code}");
        }
        let result = lua.create_table().map_err(lua_error)?;
        set_action_status(&result, exit_code, stdout, stderr).map_err(lua_error)?;
        return Ok(result);
    }

    let (root, workspace_id, service, cancellation, ui_multi) = {
        let host = host.borrow();
        (
            host.workspace_root.clone(),
            host.workspace_id.clone(),
            Arc::clone(&host.service),
            Arc::clone(&host.cancellation),
            host.ui_multi.clone(),
        )
    };
    let tools = resolve_tool_specs(
        &host,
        &service,
        &workspace_id,
        tool_values,
        "core.run_program",
    )?;
    let mut env = configured_passthrough_entries(&configuration.borrow())?;
    env.extend(
        env_entries
            .into_iter()
            .map(|(name, value)| format!("{name}={value}")),
    );
    let opts = imp_exec_api::ExecRunOpts {
        argv,
        display: display.clone(),
        env,
        config_digest: String::new(),
        inputs: digests
            .into_iter()
            .map(|digest| ExecIoSpec {
                path: None,
                kind: "digest".to_owned(),
                digest: Some(digest),
                named_cache: None,
            })
            .collect(),
        outputs: Vec::new(),
        tools,
        cores: 1,
        impure: true,
        force_cache: false,
        sandbox: true,
        workspace_cwd: true,
        stream: true,
        no_cache: false,
        sandbox_retention: SandboxRetention::default(),
        allow_failure: false,
        materialize: false,
    };
    let scheduler = host.borrow().scheduler.clone();
    let outcome = if let Some(scheduler) = scheduler {
        scheduler
            .run(
                None,
                display.clone(),
                imp_scheduler::TaskKind::Sandbox,
                1,
                move |context| {
                    let result = imp_execution::exec::exec_run_local_with_start(
                        &root,
                        opts,
                        Some(cancellation.as_ref()),
                        Some(&crate::spike::SchedulerGate(&context)),
                        ui_multi.as_ref(),
                    )?;
                    crate::spike::report_cache_telemetry(&context, result.cache_outcome);
                    Ok(result)
                },
            )
            .await
    } else {
        tokio::task::spawn_blocking(move || {
            imp_execution::exec::exec_run_local_with_start(
                &root,
                opts,
                Some(cancellation.as_ref()),
                None,
                ui_multi.as_ref(),
            )
        })
        .await
        .context("join interactive program")?
    }
    .with_context(|| format!("run program '{display}'"))?;
    host.borrow_mut().action_count += 1;
    let result = lua.create_table().map_err(lua_error)?;
    set_action_status(&result, outcome.exit_code, outcome.stdout, outcome.stderr)
        .map_err(lua_error)?;
    Ok(result)
}

fn normalize_luau_artifact(artifact: &imp_store::cache::CachedArtifact) -> Result<DirectoryDigest> {
    let path = artifact
        .path
        .as_deref()
        .context("graph action output has no captured path")?;
    match artifact.kind.as_str() {
        "file" | "manifest" => Ok(nest_file(
            path,
            artifact.digest.clone(),
            artifact.bytes.unwrap_or_default(),
            artifact.mode,
        )?),
        "directory" => {
            let digest = artifact
                .tree_digest
                .as_ref()
                .with_context(|| format!("directory output '{path}' has no tree digest"))?;
            Ok(nest_directory(
                path,
                &DirectoryDigest::from_digest(digest.clone()),
            )?)
        }
        other => bail!("graph action output '{path}' has unsupported kind '{other}'"),
    }
}

fn flatten_test_cases(value: LuaValue) -> Result<Vec<LuauTestCase>> {
    fn visit(value: LuaValue, suite: Option<&str>, cases: &mut Vec<LuauTestCase>) -> LuaResult<()> {
        let table = match value {
            LuaValue::Table(table) => table,
            other => {
                return Err(LuaError::external(format!(
                    "test module must return a list of test cases or suites, got {}",
                    other.type_name()
                )))
            }
        };
        if table
            .get::<Option<bool>>("__imp_test_case")?
            .unwrap_or(false)
        {
            let name: String = table.get("name")?;
            let run: LuaFunction = table.get("run")?;
            cases.push(LuauTestCase {
                name: suite.map(|suite| format!("{suite}.{name}")).unwrap_or(name),
                suite: suite.map(str::to_owned),
                run,
            });
            return Ok(());
        }
        if table
            .get::<Option<bool>>("__imp_test_suite")?
            .unwrap_or(false)
        {
            let name: String = table.get("name")?;
            let nested_suite = suite.map(|parent| format!("{parent}.{name}"));
            let nested_suite = nested_suite.as_deref().unwrap_or(&name);
            let nested: LuaTable = table.get("cases")?;
            for value in nested.sequence_values::<LuaValue>() {
                visit(value?, Some(nested_suite), cases)?;
            }
            return Ok(());
        }
        for value in table.sequence_values::<LuaValue>() {
            visit(value?, suite, cases)?;
        }
        Ok(())
    }

    let mut cases = Vec::new();
    visit(value, None, &mut cases).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(cases)
}

fn current_package_path(loader: &ModuleLoader) -> String {
    let Some(address) = loader.stack.borrow().last().cloned() else {
        return ".".to_owned();
    };
    let Some(relative) = address.strip_prefix("@workspace/") else {
        return ".".to_owned();
    };
    let mut parts: Vec<&str> = relative.split('/').collect();
    parts.pop();
    if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    }
}

fn generated_build_destination(root: &Path, file: &str) -> Result<PathBuf> {
    let relative = Path::new(file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative.file_name().is_none_or(|name| name != "BUILD.luau")
    {
        bail!("generated BUILD path must be a workspace-relative BUILD.luau file: {file}");
    }
    let destination = root.join(relative);
    let mut existing = destination.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .context("generated BUILD path has no existing workspace parent")?;
    }
    let canonical = dunce::canonicalize(existing)
        .with_context(|| format!("resolve generated BUILD path {}", existing.display()))?;
    if !canonical.starts_with(root) {
        bail!("generated BUILD path escapes the workspace: {file}");
    }
    Ok(destination)
}

fn render_generated_luau_build(
    file: &str,
    targets: &[GeneratedLuauBuildTarget],
    rules: &BTreeMap<String, LuauBuildRule>,
) -> Result<String> {
    let mut modules = BTreeMap::<String, String>::new();
    let mut names = std::collections::BTreeSet::new();
    for target in targets {
        if !is_luau_identifier(&target.name) {
            bail!(
                "{file}: generated target name '{}' is not a Luau identifier",
                target.name
            );
        }
        if !names.insert(target.name.as_str()) {
            bail!("{file}: duplicate generated target name '{}'", target.name);
        }
        let rule = rules.get(&target.rule).with_context(|| {
            format!(
                "{file}: no render metadata registered for rule '{}'",
                target.rule
            )
        })?;
        if !is_luau_identifier(&rule.export) {
            bail!(
                "{file}: generated rule export '{}' is not a Luau identifier",
                rule.export
            );
        }
        modules.insert(rule.module.clone(), String::new());
    }
    let module_names = modules.keys().cloned().collect::<Vec<_>>();
    for (index, module) in module_names.into_iter().enumerate() {
        modules.insert(module, format!("__imp_rule_{index}"));
    }

    let mut rendered = String::from("-- Generated by Imp. Do not edit.\n");
    for (module, alias) in &modules {
        let address = serde_json::to_string(module)?;
        rendered.push_str(&format!("local {alias} = require({address})\n"));
    }
    rendered.push_str("\nreturn {\n");
    let mut targets = targets.iter().collect::<Vec<_>>();
    targets.sort_by(|left, right| left.name.cmp(&right.name));
    for target in targets {
        let rule = &rules[&target.rule];
        let alias = &modules[&rule.module];
        let props = render_luau_value(&target.props, 1)?;
        rendered.push_str(&format!(
            "    {} = {alias}.{}({props}),\n",
            target.name, rule.export
        ));
    }
    rendered.push_str("}\n");
    Ok(rendered)
}

fn is_luau_identifier(value: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "and", "break", "continue", "do", "else", "elseif", "end", "export", "false", "for",
        "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
        "type", "until", "while",
    ];
    if KEYWORDS.contains(&value) {
        return false;
    }
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn render_luau_value(value: &serde_json::Value, depth: usize) -> Result<String> {
    let indent = "    ".repeat(depth);
    let child_indent = "    ".repeat(depth + 1);
    match value {
        serde_json::Value::Null => Ok("nil".to_owned()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => Ok(serde_json::to_string(value)?),
        serde_json::Value::Array(values) => {
            if values.is_empty() {
                return Ok("{}".to_owned());
            }
            let mut rendered = String::from("{\n");
            for value in values {
                rendered.push_str(&child_indent);
                rendered.push_str(&render_luau_value(value, depth + 1)?);
                rendered.push_str(",\n");
            }
            rendered.push_str(&indent);
            rendered.push('}');
            Ok(rendered)
        }
        serde_json::Value::Object(values) => {
            if values.is_empty() {
                return Ok("{}".to_owned());
            }
            let mut rendered = String::from("{\n");
            for (key, value) in values {
                rendered.push_str(&child_indent);
                if is_luau_identifier(key) {
                    rendered.push_str(key);
                } else {
                    rendered.push('[');
                    rendered.push_str(&serde_json::to_string(key)?);
                    rendered.push(']');
                }
                rendered.push_str(" = ");
                rendered.push_str(&render_luau_value(value, depth + 1)?);
                rendered.push_str(",\n");
            }
            rendered.push_str(&indent);
            rendered.push('}');
            Ok(rendered)
        }
    }
}

fn resolve_address(
    loader: &ModuleLoader,
    requested: &str,
    current: Option<&str>,
) -> LuaResult<(PathBuf, String)> {
    let (namespace, relative) = if requested.starts_with("./") || requested.starts_with("../") {
        let current =
            current.ok_or_else(|| LuaError::external("relative import has no module owner"))?;
        let (namespace, path) = if let Some(path) = current.strip_prefix("@workspace/") {
            ("@workspace", path)
        } else if let Some(path) = current.strip_prefix("@imp/rules/") {
            ("@imp/rules", path)
        } else {
            return Err(LuaError::external(
                "relative import has no file-backed namespace",
            ));
        };
        let path = Path::new(path);
        let parent = path.parent().unwrap_or_else(|| Path::new(""));
        let joined = normalize_relative(parent, requested)?;
        (namespace.to_owned(), joined)
    } else if let Some(path) = requested.strip_prefix("@workspace/") {
        (
            "@workspace".to_owned(),
            normalize_relative(Path::new(""), path)?,
        )
    } else if let Some(path) = requested.strip_prefix("@imp/rules/") {
        (
            "@imp/rules".to_owned(),
            normalize_relative(Path::new(""), path)?,
        )
    } else {
        return Err(LuaError::external(format!(
            "unsupported Luau module address '{requested}'"
        )));
    };

    let root = if namespace == "@workspace" {
        &loader.workspace_root
    } else {
        &loader.rules_root
    };
    let relative_path = PathBuf::from(&relative);
    let relative_path = if relative_path
        .extension()
        .is_some_and(|extension| extension == "luau")
    {
        relative_path.with_extension("")
    } else {
        relative_path
    };
    let candidates = if relative_path.as_os_str().is_empty() {
        vec![root.join("BUILD.luau")]
    } else {
        vec![
            PathBuf::from(format!("{}.luau", relative_path.to_string_lossy())),
            relative_path.join("index.luau"),
            relative_path.join("BUILD.luau"),
        ]
        .into_iter()
        .map(|candidate| root.join(candidate))
        .collect()
    };
    let candidate = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            LuaError::external(format!(
                "module '{requested}' was not found under {}",
                root.display()
            ))
        })?;
    let path = dunce::canonicalize(&candidate).map_err(LuaError::external)?;
    if !path.starts_with(root) {
        return Err(LuaError::external(format!(
            "module '{requested}' resolves outside its namespace root"
        )));
    }
    let relative_source = path
        .strip_prefix(root)
        .map_err(LuaError::external)?
        .to_string_lossy()
        .replace('\\', "/");
    let canonical_path = relative_source
        .strip_suffix(".luau")
        .unwrap_or(&relative_source);
    let canonical = format!("{namespace}/{canonical_path}");
    Ok((path, canonical))
}

/// Read the file at an `@imp/rules/<path>` or `@workspace/<path>` address.
/// Return `nil` when no file is at the address. The address cannot escape its
/// namespace root, and a workspace file never replaces an installed rule file.
fn read_addressed_file(loader: &ModuleLoader, address: &str) -> LuaResult<Option<String>> {
    let (root, path) = if let Some(path) = address.strip_prefix("@workspace/") {
        (&loader.workspace_root, path)
    } else if let Some(path) = address.strip_prefix("@imp/rules/") {
        (&loader.rules_root, path)
    } else {
        return Err(LuaError::external(format!(
            "core.read_file('{address}') requires an @imp/rules/ or @workspace/ address"
        )));
    };
    let relative = normalize_relative(Path::new(""), path)
        .map_err(|error| LuaError::external(format!("core.read_file('{address}'): {error}")))?;
    let candidate = root.join(relative);
    if !candidate.is_file() {
        return Ok(None);
    }
    let resolved = dunce::canonicalize(&candidate).map_err(LuaError::external)?;
    let canonical_root = dunce::canonicalize(root).map_err(LuaError::external)?;
    if !resolved.starts_with(&canonical_root) {
        return Err(LuaError::external(format!(
            "core.read_file('{address}') resolves outside its namespace root"
        )));
    }
    fs::read_to_string(&resolved)
        .map(Some)
        .map_err(|error| LuaError::external(format!("core.read_file('{address}'): {error}")))
}

fn normalize_relative(base: &Path, requested: &str) -> LuaResult<String> {
    let mut parts: Vec<String> = base
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err(LuaError::external("import escapes its namespace root"));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(LuaError::external("absolute imports are not supported"));
            }
        }
    }
    if parts.is_empty() {
        return Err(LuaError::external("module address must name a source"));
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cli_tool_resolver_preserves_its_module_context_and_restores_the_caller() {
        let root = tempfile::tempdir().unwrap();
        let rules = crate::loader::RulesSource::discover();
        let mut workspace = LuauWorkspace::new(root.path(), rules.root().unwrap()).unwrap();
        let expected = root.path().join("fixture-tool");
        fs::create_dir(root.path().join("pkg")).unwrap();
        fs::write(
            root.path().join("pkg/helper.luau"),
            format!(
                "return {}",
                serde_json::to_string(expected.to_str().unwrap()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            root.path().join("pkg/tools.luau"),
            r#"
local core = require("@imp/core")
local registry = require("@imp/rules/imp/toolchain")
registry.register("fixture", function()
    assert(core.package_path() == "pkg", core.package_path())
    local path = require("./helper")
    local source = core.task({ outputs = { directory = core.output.artifact() }, run = function()
        error("unused tool must not run")
    end })
    core.tool(source.outputs.directory, { name = "context-fixture" })
    return core.task({ outputs = { value = core.output.value() }, run = function()
        return { value = path }
    end }).outputs.value
end)
registry.register("failure", function()
    assert(core.package_path() == "pkg", core.package_path())
    error("fixture resolver failed")
end)
return {}
"#,
        )
        .unwrap();
        fs::write(
            root.path().join("entry.luau"),
            "return require(\"./pkg/tools\")",
        )
        .unwrap();
        workspace.evaluate("@workspace/entry").await.unwrap();
        for name in ["fixture", "failure", "fixture"] {
            let result = workspace.resolve_tool_bin(name, None).await;
            if name == "failure" {
                assert!(format!("{:#}", result.unwrap_err()).contains("fixture resolver failed"));
            } else {
                assert_eq!(result.unwrap(), expected);
            }
            assert!(workspace.loader.stack.borrow().is_empty());
        }
        assert!(workspace
            .host
            .borrow()
            .nodes
            .values()
            .any(|node| matches!(node,
                GraphNode::Tool { name, owner_package, .. }
                    if name == "context-fixture" && owner_package == "pkg"
            )));
    }

    #[tokio::test]
    async fn cli_tool_resolution_validates_outputs_and_recovers_after_failure() {
        let root = tempfile::tempdir().unwrap();
        let rules = crate::loader::RulesSource::discover();
        let mut workspace = LuauWorkspace::new(root.path(), rules.root().unwrap()).unwrap();
        let good_path = root.path().join("fixture-tool");
        let good_literal = serde_json::to_string(good_path.to_str().unwrap()).unwrap();
        fs::write(
            root.path().join("tools.luau"),
            r#"
local core = require("@imp/core")
local registry = require("@imp/rules/imp/toolchain")
local function register(name, run)
    registry.register(name, function()
        return core.task({ outputs = { value = core.output.value() }, run = run }).outputs.value
    end)
end
register("good", function() return { value = GOOD_PATH } end)
register("relative", function() return { value = "relative/tool" } end)
register("empty", function() return { value = "" } end)
register("number", function() return { value = 7 } end)
register("failure", function() error("fixture installation failed") end)
registry.register("bad-handle", function() return "not a handle" end)
return {}
"#
            .replace("GOOD_PATH", &good_literal),
        )
        .unwrap();
        workspace.evaluate("@workspace/tools").await.unwrap();
        for (name, message) in [
            ("missing", "unknown tool '@missing'"),
            ("relative", "non-empty absolute path"),
            ("empty", "non-empty absolute path"),
            ("number", "must be a string"),
            ("failure", "fixture installation failed"),
            ("bad-handle", "must return a task output handle"),
        ] {
            let error = workspace.resolve_tool_bin(name, None).await.unwrap_err();
            assert!(format!("{error:#}").contains(message), "{error:#}");
            assert!(!workspace.host.borrow().graph_run_active);
            assert!(workspace.host.borrow().scheduler.is_none());
            assert!(workspace.host.borrow().invocation_mode.is_empty());
            assert_eq!(
                workspace.resolve_tool_bin("good", None).await.unwrap(),
                good_path
            );
        }
        let mut other = LuauWorkspace::new(root.path(), rules.root().unwrap()).unwrap();
        assert!(format!(
            "{:#}",
            other.resolve_tool_bin("good", None).await.unwrap_err()
        )
        .contains("unknown tool"));
    }

    /// A temporary rules tree with the Luau workflow modules of the
    /// repository rules tree, so that fixtures can register their goals.
    fn rules_tempdir() -> tempfile::TempDir {
        let rules_root = tempfile::tempdir().unwrap();
        let source = crate::loader::RulesSource::discover()
            .root()
            .expect("tests need the repository rules tree")
            .join("workflows");
        for module in [
            "report.luau",
            "build/index.luau",
            "fmt/index.luau",
            "generate_build/index.luau",
            "lint/index.luau",
            "lockfiles/index.luau",
            "package/index.luau",
            "publish/index.luau",
            "run/index.luau",
            "test/index.luau",
        ] {
            let destination = rules_root.path().join("workflows").join(module);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(source.join(module), destination).unwrap();
        }
        let destination = rules_root.path().join("imp/lockfile/index.luau");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(source.join("../imp/lockfile/index.luau"), destination).unwrap();
        rules_root
    }

    #[tokio::test]
    async fn unresolved_luau_goal_still_triggers_the_idle_watchdog() {
        let root = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        let mut runtime = LuauWorkspace::new(root.path(), rules.path()).unwrap();
        let lua = runtime.lua().unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let callback_entered = Arc::clone(&entered);
        let pending = lua
            .create_async_function(move |_, _: LuaValue| {
                callback_entered.store(true, Ordering::SeqCst);
                async { std::future::pending::<LuaResult<()>>().await }
            })
            .unwrap();
        let core: LuaTable = lua.load("return require('@imp/core')").eval().unwrap();
        let register: LuaFunction = core.get("goal").unwrap();
        let options = lua.create_table().unwrap();
        options.set("selection", "none").unwrap();
        register.call::<()>(("blocked", pending, options)).unwrap();
        let (events, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = imp_scheduler::Scheduler::new(1, Arc::new(AtomicBool::new(false)), events);
        let guard = runtime.scheduler_scope(Some(Arc::clone(&scheduler)));
        let flags = serde_json::json!({});
        {
            let goal =
                runtime.execute_graph("blocked", &[], scheduler.cancellation_flag(), &flags, &[]);
            tokio::pin!(goal);
            tokio::select! {
                biased;
                result = &mut goal => panic!("blocked goal returned: {result:?}"),
                _ = scheduler.wait_until_stalled(std::time::Duration::from_millis(30)) => {},
            }
        }
        assert!(entered.load(Ordering::SeqCst));
        assert_eq!(scheduler.outstanding(), 0);
        drop(guard);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_execution_jobs_report_activity_and_release_the_scheduler() {
        use imp_scheduler::{TaskEvent, TaskOutcome};
        use std::time::Duration;
        struct CancelOnDrop(Arc<AtomicBool>);
        impl Drop for CancelOnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        for program in [false, true] {
            for outcome in ["success", "failure", "cancel"] {
                let root = tempfile::tempdir().unwrap();
                let rules = rules_tempdir();
                let release = root.path().join("release");
                let release_literal = serde_json::to_string(&release.to_string_lossy()).unwrap();
                let exit = if outcome == "failure" { 7 } else { 0 };
                let command = format!("while [ ! -f \"$RELEASE\" ]; do :; done; printf job-output; printf job-error >&2; exit {exit}");
                let command_literal = serde_json::to_string(&command).unwrap();
                let source = format!(
                    r#"
local core = require("@imp/core")
local sh = core.native_tool("sh")
local options = {{ argv = {{ "sh", "-c", {command_literal} }}, env = {{ RELEASE = {release_literal} }} }}
local PROBE = core.goal("probe", function()
    if {program} then
        options.tools = {{ sh }}
        local result = core.run_program(options)
        assert(result.exit_code == 0)
    end
end)
return {{ job = {{ [PROBE] = core.task({{
    inputs = {{ sh = sh }}, outputs = {{ status = core.output.value() }}, run = function(exec)
        if not {program} then
            local result = exec.action(options)
            assert(string.find(result.stdout, "job-output", 1, true))
            assert(string.find(result.stderr, "job-error", 1, true))
        end
        return {{ status = true }}
    end,
}}) }} }}
"#
                );
                fs::write(root.path().join("BUILD.luau"), source).unwrap();
                let mut runtime = LuauWorkspace::new(root.path(), rules.path()).unwrap();
                let roots = runtime.load_modules().await.unwrap();
                let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                let scheduler =
                    imp_scheduler::Scheduler::new(1, Arc::new(AtomicBool::new(false)), events);
                let _cancel_on_drop = CancelOnDrop(scheduler.cancellation_flag());
                let guard = runtime.scheduler_scope(Some(Arc::clone(&scheduler)));
                let flags = serde_json::json!({});
                let result = {
                    let goal = runtime.execute_graph(
                        "probe",
                        &roots,
                        scheduler.cancellation_flag(),
                        &flags,
                        &[],
                    );
                    tokio::pin!(goal);
                    let observe = async {
                        while let Some(event) = receiver.recv().await {
                            if matches!(event, TaskEvent::LaneStarted { .. }) {
                                break;
                            }
                        }
                        assert_eq!(scheduler.outstanding(), 1);
                        assert!(tokio::time::timeout(
                            Duration::from_millis(60),
                            scheduler.wait_until_stalled(Duration::from_millis(20))
                        )
                        .await
                        .is_err());
                        if outcome == "cancel" {
                            scheduler.cancellation_flag().store(true, Ordering::SeqCst);
                        } else {
                            fs::write(&release, "release").unwrap();
                        }
                    };
                    tokio::select! {
                        biased;
                        result = &mut goal => panic!("job returned before release: {result:?}"),
                        result = tokio::time::timeout(Duration::from_secs(10), observe) => { result.unwrap(); },
                    }
                    tokio::time::timeout(Duration::from_secs(10), goal)
                        .await
                        .unwrap()
                };
                assert_eq!(scheduler.outstanding(), 0);
                let completed: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
                assert!(
                    completed.iter().any(|event| matches!(
                        event,
                        TaskEvent::Done {
                            cached: Some(false),
                            ..
                        }
                    )),
                    "{completed:?}"
                );
                if outcome == "success" {
                    result.unwrap();
                    if !program {
                        runtime
                            .execute_graph(
                                "probe",
                                &roots,
                                scheduler.cancellation_flag(),
                                &flags,
                                &[],
                            )
                            .await
                            .unwrap();
                        let cached: Vec<_> =
                            std::iter::from_fn(|| receiver.try_recv().ok()).collect();
                        assert!(
                            cached.iter().any(|event| matches!(
                                event,
                                TaskEvent::Done {
                                    outcome: TaskOutcome::Ok,
                                    cached: Some(true),
                                    cache_source: Some(imp_scheduler::CacheSource::Local),
                                    ..
                                }
                            )),
                            "{cached:?}"
                        );
                    }
                } else {
                    let error = format!("{:#}", result.unwrap_err());
                    assert!(
                        if outcome == "cancel" {
                            error.to_lowercase().contains("cancel")
                        } else {
                            error.contains('7')
                        },
                        "{error}"
                    );
                }
                drop(guard);
                assert!(runtime.host.borrow().scheduler.is_none());
            }
        }
    }

    async fn execute_luau_task_source(source: &str) -> anyhow::Error {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(workspace_root.path().join("bad.luau"), source).unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let handle = runtime.evaluate("@workspace/bad").await.unwrap();
        let LuaValue::UserData(handle) = handle else {
            panic!("test module must return a task handle");
        };
        runtime.execute_task(&handle).await.unwrap_err()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_modes_bind_captured_handles_to_each_execution_scope() {
        let (_, report) = run_luau_test_module(r#"
local core = require("@imp/core")
core.define_mode_axis("opt", { kind = "rebuild", ["default"] = "debug", values = { "debug", "release" } })
return { core.test.case("captured mode handles", function()
    assert(core.configuration("imp.mode").opt == "debug")
    local provider = core.task({ inputs = { opt = core.semantic.mode("opt"), sh = core.native_tool("sh"), mkdir = core.native_tool("mkdir") },
        outputs = { dir = core.output.artifact() }, run = function(exec, input)
            local dir = "runtime-" .. input.opt
            local result = exec.action({ argv = { "sh", "-c", 'mkdir "$1"; printf %s "$2" > "$1/value.txt"', "provider", dir, input.opt },
                outputs = { dir = core.output.directory(dir, { named_cache = { name = "mode-captured-review", key = input.opt } }) } })
            return { dir = result.outputs.dir }
        end })
    local path = core.path(provider.outputs.dir)
    local tool = core.tool(provider.outputs.dir, { name = "runtime", bin_dirs = {} })
    local unrelated = core.path(core.task({ outputs = { dir = core.output.artifact() }, run = function() error("must not run") end }).outputs.dir)
    local consumer = core.task({ inputs = { path = path, tool = tool, opt = core.semantic.mode("opt"), sh = core.native_tool("sh"), cat = core.native_tool("cat") },
        outputs = { text = core.output.value() }, run = function(exec, input)
            assert(exec.path(path) == "runtime-" .. input.opt)
            local ok, err = pcall(exec.path, unrelated)
            assert(not ok and string.find(tostring(err), "requires a declared task input", 1, true))
            exec.action({ argv = { "sh", "-c", 'test "$(cat "$1/value.txt")" = "$3" && test "$(cat "$2/value.txt")" = "$3"', "consumer", exec.path(path), exec.tool_dir(tool), input.opt }, inputs = { path } })
            return { text = input.opt }
        end })
    assert(core.test.resolve(consumer.outputs.text) == "debug")
    assert(core.test.resolve(core.configured(consumer, { opt = "release" }).outputs.text) == "release")
    local program = core.program({ inputs = { path = path, tool = tool, artifact = provider.outputs.dir }, describe = function(exec)
        return { argv = { "echo", exec.path(path) }, tools = { tool }, inputs = { exec.digest(provider.outputs.dir) } }
    end })
    assert(core.test.resolve(core.configured(program, { opt = "release" })).argv[2] == "runtime-release")
    local debug_path = core.configured(path, { opt = "debug" })
    local release_path = core.configured(path, { opt = "release" })
    local both = core.task({ inputs = { debug = debug_path, release = release_path }, outputs = { text = core.output.value() }, run = function(exec)
        return { text = exec.path(debug_path) .. "|" .. exec.path(release_path) }
    end })
    assert(core.test.resolve(both.outputs.text) == "runtime-debug|runtime-release")
end) }
"#).await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 1/1 unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn luau_modes_configured_test_roots_preserve_profile_and_case_isolation() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        fs::write(workspace.path().join("imp.workspace.luau"), r#"
local core = require("@imp/core")
core.define_mode_axis("opt", { kind = "rebuild", ["default"] = "debug", values = { "debug", "release" } })
core.define_profile("shipping", { odin = { defines = { SHIPPING = "true" } } })
core.configure("odin", { defines = { BASE = "true" } })
return {}
"#).unwrap();
        fs::write(
            workspace.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")
return { tests = { [test.TEST] = core.configured(core.test_root(), { opt = "release" }) } }
"#,
        )
        .unwrap();
        fs::write(workspace.path().join("mode.test.luau"), r#"
local core = require("@imp/core")
local function check()
    assert(core.configuration("imp.mode").opt == "release")
    local task = core.task({ inputs = { opt = core.semantic.mode("opt") }, outputs = { text = core.output.value() }, run = function(_, input) return { text = input.opt } end })
    assert(core.test.resolve(task.outputs.text) == "release")
    assert(core.configuration("case_private") == nil)
    core.configure("case_private", { touched = true })
    assert(core.configuration("case_private").touched)
    core.configure("odin", { defines = { LOCAL = "true", SHIPPING = "false" } })
    local defines = core.configuration("odin").defines
    assert(defines.BASE == "true" and defines.LOCAL == "true" and defines.SHIPPING == "true")
end
return { core.test.case("first", check), core.test.case("second", check) }
"#).unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        runtime
            .set_invocation_mode(serde_json::json!({"opt": "debug"}), Some("shipping"))
            .unwrap();
        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap()
            .unwrap();
        assert!(report.contains("test: 2/2 unit(s) passed"), "{report}");
        assert!(!runtime
            .configuration
            .borrow()
            .values
            .contains_key("case_private"));
        assert_eq!(
            runtime.configuration.borrow().values["odin"]["defines"]["SHIPPING"],
            serde_json::Value::Null
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_modes_repository_probe_matches_javascript_fork_and_share_contract() {
        let workspace = tempfile::tempdir().unwrap();
        let source = crate::loader::RulesSource::discover();
        let rules = source.root().unwrap();
        fs::copy(
            rules.join("imp/config/example/BUILD.luau"),
            workspace.path().join("BUILD.luau"),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), &rules).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let root_id = roots[0].handle_id as u64;
        for (opt, report, actions) in [
            ("debug", "leaf:debug|leaf:release|shared:none", 3),
            ("release", "leaf:release|leaf:release|shared:none", 5),
        ] {
            runtime
                .set_invocation_mode(serde_json::json!({"opt": opt}), None)
                .unwrap();
            runtime
                .execute_graph(
                    "build",
                    &roots,
                    Arc::new(AtomicBool::new(false)),
                    &serde_json::json!({}),
                    &[],
                )
                .await
                .unwrap();
            let state = runtime.host.borrow();
            let result = state
                .task_results
                .iter()
                .find(|((id, _), _)| *id == root_id)
                .unwrap()
                .1;
            assert_eq!(result.get::<String>("report").unwrap(), report);
            assert_eq!(state.action_count, actions);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_modes_scope_persistent_action_cache_to_read_axes() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        let source = r#"
local core = require("@imp/core")
core.define_mode_axis("opt", { kind = "rebuild", values = { "debug", "release" }, ["default"] = "debug" })
core.goal("verify", function() end)
local function stamp(name, inputs)
    inputs.sh = core.native_tool("sh")
    return core.task({ inputs = inputs, outputs = { artifact = core.output.artifact() }, run = function(exec)
        local result = exec.action({ argv = { "sh", "-c", "printf '%s' '$UNIQUE' > " .. name }, outputs = { file = core.output.file(name) } })
        return { artifact = result.outputs.file }
    end })
end
return { leaf = { VERIFY = stamp("leaf", { opt = core.semantic.mode("opt") }) }, shared = { VERIFY = stamp("shared", {}) } }
"#.replace("$UNIQUE", workspace.path().file_name().unwrap().to_str().unwrap());
        fs::write(workspace.path().join("BUILD.luau"), source).unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        for (mode, expected_hits) in [("debug", 0), ("release", 1), ("release", 3), ("debug", 5)] {
            runtime
                .set_invocation_mode(serde_json::json!({"opt": mode}), None)
                .unwrap();
            runtime
                .execute_graph(
                    "verify",
                    &roots,
                    Arc::new(AtomicBool::new(false)),
                    &serde_json::json!({}),
                    &[],
                )
                .await
                .unwrap();
            assert_eq!(runtime.cache_hit_count(), expected_hits, "mode {mode}");
        }
        assert_eq!(runtime.action_count(), 8);
    }

    #[tokio::test]
    async fn luau_modes_fork_tasks_outputs_expansions_and_program_inputs() {
        let (workspace, report) = run_luau_test_module(r#"
local core = require("@imp/core")
core.define_mode_axis("opt", { kind = "rebuild", values = { "debug", "release" }, ["default"] = "debug" })
return { core.test.case("mode graph", function()
    local counts = { leaf = 0, shared = 0, discover = 0, pinned = 0 }
    local shared = core.task({ outputs = { text = core.output.value() }, run = function()
        counts.shared += 1; return { text = "shared" }
    end })
    local leaf = core.task({ inputs = { opt = core.semantic.mode("opt"), shared = shared.outputs.text },
        outputs = { text = core.output.value() }, run = function(_, input)
            counts.leaf += 1; return { text = input.opt .. ":" .. input.shared }
        end })
    local release = core.configured(leaf, { opt = "release" })
    assert(core.test.resolve(leaf.outputs.text) == "debug:shared")
    assert(core.test.resolve(release.outputs.text) == "release:shared")
    assert(core.test.resolve(core.configured(release, { opt = "debug" }).outputs.text) == "debug:shared")
    local pinned = core.task({ inputs = { text = release.outputs.text }, outputs = { text = core.output.value() },
        run = function(_, input) counts.pinned += 1; return input end })
    assert(core.test.resolve(pinned.outputs.text) == "release:shared")
    assert(core.test.resolve(core.configured(pinned, { opt = "release" }).outputs.text) == "release:shared")
    assert(counts.pinned == 1)
    local expansion = core.expand({ inputs = { opt = core.semantic.mode("opt") }, create = function(input)
        counts.discover += 1
        return { child = { BUILD = core.task({ outputs = { text = core.output.value() }, run = function()
            return { text = input.opt }
        end }) } }
    end })
    local child = expansion:get("child", "BUILD")
    local consume = core.task({ inputs = { text = child }, outputs = { text = core.output.value() }, run = function(_, input) return input end })
    assert(core.test.resolve(consume.outputs.text).text == "debug")
    assert(core.test.resolve(core.configured(consume, { opt = "release" }).outputs.text).text == "release")
    assert(counts.discover == 2)
    local blind_expansion = core.expand({ create = function()
        counts.discover += 1; return { child = { BUILD = leaf } }
    end })
    local blind_child = core.task({ inputs = { child = blind_expansion:get("child", "BUILD") },
        outputs = { text = core.output.value() }, run = function(_, input) return { text = input.child.text } end })
    assert(core.test.resolve(core.configured(blind_child, { opt = "debug" }).outputs.text) == "debug:shared")
    assert(core.test.resolve(core.configured(blind_child, { opt = "release" }).outputs.text) == "release:shared")
    assert(counts.discover == 3)
    local program = core.program({ inputs = { text = leaf.outputs.text }, describe = function(_, input)
        return { argv = { "echo", input.text } }
    end })
    assert(core.test.resolve(core.configured(program, { opt = "release" })).argv[2] == "release:shared")
    assert(counts.leaf == 2 and counts.shared == 1)
    core.test.with_fake_run(function()
        local provider = core.task({ outputs = { dir = core.output.artifact() }, run = function(exec)
            local output = exec.action({ argv = { "unused" }, outputs = { dir = core.output.directory("runtime", { named_cache = { name = "mode-identity", key = "v1" } }) } })
            return { dir = output.outputs.dir }
        end })
        local tool = core.tool(provider.outputs.dir, { name = "runtime", bin_dirs = {} })
        local path = core.path(provider.outputs.dir)
        local consumer = core.task({ inputs = { tool = tool, path = path }, run = function(exec, input)
            assert(input.tool == tool and input.path == path)
            assert(exec.path(path) == "runtime")
            assert(string.find(exec.tool_dir(tool), "mode-identity", 1, true))
        end })
        core.test.resolve(consumer)
    end)
end) }
"#).await;
        assert!(workspace.path().exists());
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 1/1 unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn luau_modes_resolve_profiles_before_discovery_and_clear_failed_invocations() {
        use crate::spike::{self, AuthoringRuntime, GoalExecutionOptions, GoalSelection};
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("imp.workspace.luau"), r#"
local core = require("@imp/core")
core.define_profile("release", { opt = "release", odin = { defines = { SHIPPING = "true" } } })
core.define_profile("empty", { odin = { defines = {} } })
core.define_profile("defaults", {})
core.define_mode_axis("opt", { kind = "rebuild", values = { "debug", "release" }, ["default"] = "debug" })
return {}
"#).unwrap();
        fs::write(workspace.path().join("BUILD.luau"), r#"
local core = require("@imp/core")
core.goal("verify", function() end)
local child = core.task({ inputs = { opt = core.semantic.mode("opt") }, run = function(_, input)
    assert(input.opt == core.configuration("imp.mode").opt)
    if input.opt == "release" then assert(core.configuration("odin").defines.SHIPPING == "true") end
end })
local expansion = core.expand({ inputs = { opt = core.semantic.mode("opt") }, create = function(input)
    assert(input.opt == core.configuration("imp.mode").opt)
    return { child = { VERIFY = child } }
end })
local pinned_child = core.task({ inputs = { opt = core.semantic.mode("opt") }, run = function(_, input)
    assert(input.opt == "release")
end })
local pinned_expansion = core.expand({ inputs = { opt = core.semantic.mode("opt") }, create = function(input)
    assert(input.opt == "release")
    return { child = { VERIFY = pinned_child } }
end })
return { probe = { VERIFY = expansion:get("child", "VERIFY") }, pinned = { VERIFY = core.configured(pinned_expansion:all("VERIFY"), { opt = "release" }) } }
"#).unwrap();
        let live = spike::load_workspace_with_runtime(
            workspace.path(),
            crate::loader::RulesSource::discover(),
            Arc::new(imp_execution::service::LocalExecutionService::new()),
            Some(AuthoringRuntime::Luau),
        )
        .await
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        *live.scheduler.lock().unwrap() = Some(imp_scheduler::Scheduler::new(
            1,
            Arc::new(AtomicBool::new(false)),
            tx,
        ));
        for (profile, axes, expected) in [
            (None, vec![], "debug"),
            (Some("release"), vec![], "release"),
            (Some("release"), vec!["opt=debug".to_owned()], "debug"),
        ] {
            assert_eq!(
                spike::resolve_mode_axes(&live, profile, &axes).unwrap()["opt"],
                expected
            );
            spike::execute_goal_live_selection(
                &live,
                workspace.path(),
                &crate::selector::SelectorContext::root(),
                "verify",
                GoalSelection::Selectors(&["//:probe".to_owned()]),
                GoalExecutionOptions {
                    no_cache: false,
                    trace_inputs: false,
                    js_workers: 1,
                    flags: serde_json::json!({}),
                    run_args: &[],
                    axis_overrides: &axes,
                    profile,
                },
            )
            .await
            .unwrap();
            let luau = live.luau.as_ref().unwrap().borrow();
            assert!(luau.configuration.borrow().invocation_values.is_none());
            assert!(luau.host.borrow().invocation_mode.is_empty());
            assert!(luau.host.borrow().scheduler.is_none());
        }
        spike::execute_goal_live_selection(
            &live,
            workspace.path(),
            &crate::selector::SelectorContext::root(),
            "verify",
            GoalSelection::Selectors(&["//:pinned".to_owned()]),
            GoalExecutionOptions {
                no_cache: false,
                trace_inputs: false,
                js_workers: 1,
                flags: serde_json::json!({}),
                run_args: &[],
                axis_overrides: &[],
                profile: None,
            },
        )
        .await
        .unwrap();
        let error = spike::execute_goal_live_selection(
            &live,
            workspace.path(),
            &crate::selector::SelectorContext::root(),
            "verify",
            GoalSelection::Selectors(&["//:missing".to_owned()]),
            GoalExecutionOptions {
                no_cache: false,
                trace_inputs: false,
                js_workers: 1,
                flags: serde_json::json!({}),
                run_args: &[],
                axis_overrides: &[],
                profile: Some("release"),
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("missing"));
        assert!(live
            .luau
            .as_ref()
            .unwrap()
            .borrow()
            .host
            .borrow()
            .scheduler
            .is_none());
        assert!(live
            .luau
            .as_ref()
            .unwrap()
            .borrow()
            .configuration
            .borrow()
            .invocation_values
            .is_none());
        for (profile, axes, part) in [
            (Some("missing"), vec![], "undeclared mode profile"),
            (None, vec!["unknown=x".to_owned()], "undeclared mode axis"),
            (None, vec!["opt=invalid".to_owned()], "not a valid value"),
        ] {
            assert!(spike::resolve_mode_axes(&live, profile, &axes)
                .unwrap_err()
                .to_string()
                .contains(part));
        }
    }

    #[tokio::test]
    async fn luau_program_description_checks_inputs_and_has_no_execution_effects() {
        let (_, report) = run_luau_test_module(r#"
local core = require("@imp/core")
local function fails(fn, part)
    local ok, err = pcall(fn)
    assert(not ok and string.find(tostring(err), part, 1, true), tostring(err))
end
return { core.test.case("program description", function()
    local tool = core.native_tool("sh")
    local other = core.native_tool("cat")
    local program = core.program({ inputs = { sh = tool }, describe = function(exec, input)
        assert(exec.file == nil and exec.action == nil and exec.worker_start == nil)
        fails(function() core.task({ run = function() end }) end, "cannot declare graph nodes")
        fails(function() core.files({ include = { "*" } }) end, "cannot declare graph nodes")
        fails(function() core.run_program({ argv = { "false" } }) end, "cannot launch a program")
        return { argv = { "sh", "-c", "true" }, tools = { input.sh }, inputs = {} }
    end })
    core.test.with_fake_run(function(host)
        local description = core.test.resolve(program)
        assert(description.tools[1] == tool)
        assert(#host.runs == 0)
        local tool_only = core.test.resolve(core.program({ inputs = { sh = tool }, describe = function(_, input)
            return table.freeze({ argv = { "sh", "-c", "true" }, tools = { input.sh } })
        end }))
        assert(type(tool_only.inputs) == "table" and next(tool_only.inputs) == nil)
        for _, description in ipairs({ {}, { argv = {} }, { argv = { "" } }, { argv = { 42 } },
            { argv = { "sh" }, inputs = { 42 } }, { argv = { "sh" }, env = { BAD = true } },
            { argv = { "sh" }, display = 42 }, { argv = { [1] = "sh", [3] = "true" } },
            { argv = { "sh" }, tools = { extra = other } }, { argv = { "sh" }, env = { ["BAD=NAME"] = "x" } } }) do
            fails(function() core.test.resolve(core.program({ describe = function() return description end })) end, "program description")
        end
        fails(function() core.test.resolve(core.program({ describe = function()
            return { argv = { "cat" }, tools = { other } }
        end })) end, "requires a declared task input")
        fails(function() core.test.resolve(core.task({ inputs = { p = program }, run = function() end })) end, "program cannot be a task input")
        fails(function() core.test.resolve(core.program({ describe = function() error("describe failed") end })) end, "describe failed")
        -- A failed description restores declaration state.
        assert(type(core.native_tool("sh")) == "userdata")
    end)
end) }
"#).await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 1/1 unit(s) passed"), "{report}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_program_acquires_tools_stages_inputs_and_forwards_arguments() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        fs::create_dir(workspace.path().join("pkg")).unwrap();
        fs::write(workspace.path().join("pkg/one.txt"), "one").unwrap();
        fs::write(workspace.path().join("pkg/two.txt"), "two").unwrap();
        fs::write(workspace.path().join("BUILD.luau"), "return {}\n").unwrap();
        fs::write(workspace.path().join("pkg/BUILD.luau"), r#"
local core = require("@imp/core")
local run = require("@imp/rules/workflows/run")
local sh, mkdir, chmod, cat = core.native_tool("sh"), core.native_tool("mkdir"), core.native_tool("chmod"), core.native_tool("cat")
local acquire = core.task({ inputs = { sh = sh, mkdir = mkdir, chmod = chmod }, outputs = { dir = core.output.artifact() },
    run = function(exec)
        local result = exec.action({ argv = { "sh", "-c", "mkdir -p runtime; printf '#!/bin/sh\ncat \"$IMP_SANDBOX_ROOT/pkg/one.txt\" \"$IMP_SANDBOX_ROOT/pkg/two.txt\"; printf \"%%s,\" \"$@\"\n' > runtime/run; chmod +x runtime/run" },
            outputs = { dir = core.output.directory("runtime", { named_cache = { name = "program-test", key = "v1" } }) } })
        return { dir = result.outputs.dir }
    end })
local runtime = core.tool(acquire.outputs.dir, { name = "runtime", bin_dirs = { "." } })
local one = core.files({ root = "pkg", include = { "one.txt" } })
local two = core.files({ root = "pkg", include = { "two.txt" } })
return { app = { [run.RUN] = core.program({ inputs = { runtime = runtime, sh = sh, cat = cat, one = one, two = two },
    describe = function(exec, input)
        assert(core.package_path() == "pkg")
        return { argv = { "sh", "-c", 'runtime=$1; shift; "$runtime" "$@" > result.txt', "launch", exec.tool_dir(input.runtime) .. "/run" },
            tools = { input.sh, input.cat, input.runtime }, inputs = { exec.digest(input.one), exec.digest(input.two) } }
    end }) } }
"#).unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        for _ in 0..2 {
            execute_workflow(
                &mut runtime,
                &roots,
                "run",
                &["//pkg:app"],
                serde_json::json!({}),
                &["first".into(), "two words".into()],
            )
            .await
            .unwrap();
            assert_eq!(
                fs::read_to_string(workspace.path().join("result.txt")).unwrap(),
                "onetwofirst,two words,"
            );
            fs::remove_file(workspace.path().join("result.txt")).unwrap();
        }
        let source = fs::read_to_string(workspace.path().join("pkg/BUILD.luau")).unwrap();
        fs::write(
            workspace.path().join("pkg/BUILD.luau"),
            source.replace(" > result.txt'", "; exit 7'"),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let err = execute_workflow(
            &mut runtime,
            &roots,
            "run",
            &["//pkg:app"],
            serde_json::json!({}),
            &[],
        )
        .await
        .unwrap_err();
        assert!(format!("{err:#}").contains("exit code 7"), "{err:#}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_program_runs_through_expansion_get_and_all() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        fs::write(workspace.path().join("BUILD.luau"), r#"
local core = require("@imp/core")
local run = require("@imp/rules/workflows/run")
local sh = core.native_tool("sh")
local children = core.expand({ create = function()
    return { app = { [run.RUN] = core.program({ inputs = { sh = sh }, describe = function(_, input)
        return { argv = { "sh", "-c", 'printf "%s" "$1" > expanded.txt', "expanded", "ran" }, tools = { input.sh } }
    end }) } }
end })
return {
    picked = { [run.RUN] = children:get("app", run.RUN) },
    group = { [run.RUN] = children:all(run.RUN) },
}
"#).unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        for selector in ["//:picked", "//:group"] {
            let cancellation = Arc::new(AtomicBool::new(false));
            runtime.begin_graph_run(Arc::clone(&cancellation));
            let projection = roots.iter().find(|root| root.address == selector).unwrap();
            let selected = runtime.resolve_expansion_root(projection).await.unwrap();
            runtime
                .execute_graph("run", &selected, cancellation, &serde_json::json!({}), &[])
                .await
                .unwrap();
            assert_eq!(
                fs::read_to_string(workspace.path().join("expanded.txt")).unwrap(),
                "ran"
            );
            fs::remove_file(workspace.path().join("expanded.txt")).unwrap();
        }
        let program_id = runtime
            .host
            .borrow()
            .nodes
            .iter()
            .find_map(|(id, node)| matches!(node, GraphNode::Program(_)).then_some(*id))
            .unwrap();
        assert!(
            validate_expansion_child(&runtime.host.borrow(), program_id, "BUILD", "app").is_err()
        );
    }

    #[tokio::test]
    async fn luau_program_rejects_other_root_slots() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        fs::write(
            workspace.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
return { bad = core.program({ describe = function() return { argv = { "true" } } end }) }
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let err = runtime.load_modules().await.unwrap_err();
        assert!(err.to_string().contains("must use the RUN slot"), "{err:#}");
    }

    #[tokio::test]
    async fn luau_test_roots_discover_cases_and_report_through_test_goal() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("pkg/nested")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            r#"
local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")
return { tests = { [test.TEST] = core.test_root() } }
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("pkg/basic.test.luau"),
            r#"
local core = require("@imp/core")
return {
    core.test.case("passes", function() assert(2 + 2 == 4) end),
    core.test.suite("group", {
        core.test.case("nested", function() assert("ok" == "ok") end),
    }),
}
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("pkg/nested/ignored.test.luau"),
            "error('nested package has no TEST root')\n",
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].workflow, "test");
        assert_eq!(roots[0].address, "//pkg:tests");
        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap();
        assert!(report
            .as_deref()
            .unwrap()
            .contains("test: 2/2 unit(s) passed"));

        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "case": "passes" }),
                &[],
            )
            .await
            .unwrap();
        assert!(report
            .as_deref()
            .unwrap()
            .contains("test: 1/1 unit(s) passed"));
        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "suite": "group" }),
                &[],
            )
            .await
            .unwrap();
        assert!(report
            .as_deref()
            .unwrap()
            .contains("test: 1/1 unit(s) passed"));
        let error = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "case": "missing" }),
                &[],
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("no case 'missing' found"), "{error}");
    }

    async fn run_luau_test_module(source: &str) -> (tempfile::TempDir, Result<Option<String>>) {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("pkg")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            "local core = require('@imp/core')\nlocal test = require('@imp/rules/workflows/test')\nreturn { tests = { [test.TEST] = core.test_root() } }\n",
        )
        .unwrap();
        fs::write(workspace_root.path().join("pkg/fakes.test.luau"), source).unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await;
        (workspace_root, report)
    }

    #[tokio::test]
    async fn luau_test_fakes_control_goal_flags_action_status_and_programs() {
        let (_workspace_root, report) = run_luau_test_module(
            r#"
local core = require("@imp/core")
local output = core.output

local function expect_error(expected, fn, ...)
    local ok, problem = pcall(fn, ...)
    assert(not ok, "expected an error: " .. expected)
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end

local function lint_task(allow_failure)
    return core.task({
        outputs = { status = output.value() },
        run = function(exec)
            local result = exec.action({
                argv = { "lint" },
                display = "lint",
                allow_failure = allow_failure,
            })
            return {
                status = { code = result.exit_code, out = result.stdout, err = result.stderr },
            }
        end,
    })
end

return {
    core.test.case("goal flags", function()
        expect_error("core.goal_flags() can only run while a goal executes", core.goal_flags)
        core.test.with_fake_goal_flags({ check = true }, function(flags)
            assert(flags.check == true)
            assert(core.goal_flags().check == true)
            expect_error(
                "core.test.with_fake_goal_flags cannot run while another fake replaces the same host function",
                core.test.with_fake_goal_flags,
                {},
                function() end
            )
        end)
        expect_error("core.goal_flags() can only run while a goal executes", core.goal_flags)
        expect_error(
            "core.test.with_fake_goal_flags flags must map flag names to booleans",
            core.test.with_fake_goal_flags,
            { check = "yes" },
            function() end
        )
    end),
    core.test.case("action status", function()
        core.test.with_fake_run(function(host)
            host.set_run_exit_code("lint", 3)
            host.set_run_stdout("lint", "out")
            host.set_run_stderr("lint", "err")
            local status = core.test.resolve(lint_task(true).outputs.status)
            assert(status.code == 3 and status.out == "out" and status.err == "err")
            assert(host.runs[1].allow_failure == true)
            expect_error("graph action 'lint' exited with 3: err", core.test.resolve, lint_task(false))
            expect_error("set_run_exit_code(display, value) requires a whole number", host.set_run_exit_code, "lint", "x")
        end)
        core.test.with_fake_run(function()
            local status = core.test.resolve(lint_task(false).outputs.status)
            assert(status.code == 0 and status.out == "" and status.err == "")
        end)
    end),
    core.test.case("program run", function()
        core.test.with_fake_run(function(host)
            local result = core.run_program({
                argv = { "prog", "--flag" },
                display = "run //:prog",
                inputs = { "digest-a", { digest = "digest-b" } },
            })
            assert(result.exit_code == 0)
            local run = host.runs[1]
            assert(run.program == true and run.display == "run //:prog")
            assert(#run.argv == 2 and run.argv[2] == "--flag")
            assert(run.inputs[1] == "digest-a" and run.inputs[2] == "digest-b")
            assert(run.impure and run.sandbox and run.workspace_cwd and run.stream)
            host.set_run_exit_code("run //:prog", 2)
            expect_error("run program 'run //:prog': run //:prog failed with exit code 2", core.run_program, {
                argv = { "prog" },
                display = "run //:prog",
            })
            expect_error("core.run_program options do not accept 'cwd'", core.run_program, {
                argv = { "prog" },
                cwd = ".",
            })
        end)
        expect_error("core.run_program() can only run in a goal callback", core.run_program, {
            argv = { "prog" },
        })
        assert(#core.run_args() == 0)
    end),
}
"#,
        )
        .await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 3/3 unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn luau_diff_digests_compare_trees_and_fake_diff_records_calls() {
        let before = tempfile::tempdir().unwrap();
        let after = tempfile::tempdir().unwrap();
        fs::write(before.path().join("same.txt"), "same").unwrap();
        fs::write(after.path().join("same.txt"), "same").unwrap();
        fs::write(before.path().join("edit.txt"), "old").unwrap();
        fs::write(after.path().join("edit.txt"), "new").unwrap();
        fs::write(before.path().join("gone.txt"), "gone").unwrap();
        fs::write(after.path().join("new.txt"), "new").unwrap();
        fs::create_dir_all(after.path().join("gen/sub")).unwrap();
        fs::write(after.path().join("gen/sub/out.txt"), "out").unwrap();
        let before = imp_store::digest::capture_directory(before.path()).unwrap();
        let after = imp_store::digest::capture_directory(after.path()).unwrap();
        let source = r#"
local core = require("@imp/core")
local output = core.output

local function expect_error(expected, fn, ...)
    local ok, problem = pcall(fn, ...)
    assert(not ok, "expected an error: " .. expected)
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end

local function by_path(changes)
    local result = {}
    for _, change in changes do
        result[change.path] = change.type
    end
    return result
end

return {
    core.test.case("real diff", function()
        local changes = core.diff_digests("BEFORE", "AFTER")
        assert(#changes == 4, tostring(#changes))
        local types = by_path(changes)
        assert(types["edit.txt"] == "modified" and types["gone.txt"] == "removed" and types["new.txt"] == "added")
        assert(types["gen"] == "added", "a new directory is one entry")
        assert(#core.diff_digests("BEFORE", "BEFORE") == 0)
        expect_error("diff_digests: read digest node", core.diff_digests, "BEFORE", "missing-digest")
    end),
    core.test.case("fake diff", function()
        local stale = core.task({
            outputs = { stale = output.value() },
            run = function()
                return { stale = #core.diff_digests("task-before", "task-after") > 0 }
            end,
        })
        core.test.with_fake_diff({ { type = "modified", path = "gen.txt" } }, function(host)
            local changes = core.diff_digests("x", "y")
            assert(#changes == 1 and changes[1].type == "modified" and changes[1].path == "gen.txt")
            changes[1].path = "mutated"
            assert(core.diff_digests("x", "y")[1].path == "gen.txt")
            assert(core.test.resolve(stale.outputs.stale) == true)
            assert(#host.calls == 3)
            assert(host.calls[1].before == "x" and host.calls[1].after == "y")
            assert(host.calls[3].before == "task-before" and host.calls[3].after == "task-after")
            assert(host.changes[1].path == "gen.txt")
        end)
        core.test.with_fake_diff({}, function()
            assert(core.test.resolve(stale.outputs.stale) == false)
        end)
        expect_error("diff_digests:", core.diff_digests, "x", "y")
    end),
    core.test.case("fake diff misuse", function()
        core.test.with_fake_diff({}, function()
            expect_error(
                "core.test.with_fake_diff cannot run while another fake replaces the same host function",
                core.test.with_fake_diff,
                {},
                function() end
            )
        end)
        local holed = { { type = "added", path = "a" }, { type = "added", path = "b" }, { type = "added", path = "c" }, x = 1 }
        holed[2] = nil
        for _, changes in {
            "added",
            { { type = "renamed", path = "a" } },
            { { type = "added" } },
            { { type = "added", path = 42 } },
            { { type = "added", path = true } },
            { "x" },
            { name = "x" },
            holed,
        } do
            expect_error(
                "core.test.with_fake_diff changes must be a list of",
                core.test.with_fake_diff,
                changes,
                function() end
            )
        end
        expect_error("body failed", core.test.with_fake_diff, {}, function() error("body failed") end)
        expect_error("diff_digests:", core.diff_digests, "x", "y")
    end),
}
"#
        .replace("BEFORE", before.digest())
        .replace("AFTER", after.digest());
        let (_workspace_root, report) = run_luau_test_module(&source).await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 3/3 unit(s) passed"), "{report}");
    }

    /// A rules tree with an inline `hello` goal, and a workspace whose BUILD
    /// module exports two `HELLO` roots.
    async fn hello_goal_workspace() -> (tempfile::TempDir, tempfile::TempDir, LuauWorkspace) {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(rules_root.path().join("hello")).unwrap();
        fs::write(
            rules_root.path().join("hello/index.luau"),
            r#"
local core = require("@imp/core")

local function hello_goal(roots)
    local lines = {}
    for _, root in ipairs(roots) do
        local result = root.result
        if result.type == "artifact" then
            local text = core.read_file_in_digest(result.digest, result.path)
            table.insert(lines, `{root.address} artifact {text}`)
        else
            table.insert(lines, `{root.address} status {result.code} {result.out}`)
        end
    end
    table.insert(lines, `loud={core.goal_flags().loud}`)
    table.insert(lines, `args={table.concat(core.run_args(), " ")}`)
    if core.goal_flags().refuse then
        core.goal_error("hello refused on purpose")
    end
    if core.goal_flags().mask then
        pcall(core.goal_error, "caught refusal")
        error("real internal failure")
    end
    return table.concat(lines, "\n")
end

local function launch_goal(roots)
    core.run_program({
        argv = { "sh", "-c", 'test -f "$IMP_SANDBOX_ROOT/$1" && shift && printf "%s," "$@" > ran.txt', "launch", roots[1].result.path },
        display = "launch",
        inputs = { roots[1].result },
    })
end

return {
    HELLO = core.goal("hello", hello_goal, {
        flags = {
            loud = { description = "Say it loudly" },
            mask = {},
            refuse = {},
        },
    }),
    LAUNCH = core.goal("launch", launch_goal),
}
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local hello = require("@imp/rules/hello")
local output = core.output
local sh = core.native_tool("sh")

local greeting = core.task({
    inputs = { sh = sh },
    outputs = { file = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = { "sh", "-c", "mkdir -p out; printf hi > out/greeting.txt" },
            outputs = { file = output.file("out/greeting.txt") },
        })
        return { file = result.outputs.file }
    end,
})

local status = core.task({
    inputs = { sh = sh },
    outputs = { status = output.value() },
    run = function(exec)
        local result = exec.action({
            argv = { "sh", "-c", "printf partial; exit 3" },
            allow_failure = true,
            cache = false,
        })
        return { status = { code = result.exit_code, out = result.stdout } }
    end,
})

return {
    greeting = { [hello.HELLO] = greeting, [hello.LAUNCH] = greeting },
    status = { [hello.HELLO] = status },
}
"#,
        )
        .unwrap();
        let runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        (workspace_root, rules_root, runtime)
    }

    #[tokio::test]
    async fn generic_goal_driver_passes_resolved_roots_flags_and_args_to_luau() {
        let (_workspace_root, _rules_root, mut runtime) = hello_goal_workspace().await;
        let roots = runtime.load_modules().await.unwrap();
        let definitions = runtime.goal_definitions();
        let hello = definitions.get("hello").expect("hello goal is registered");
        assert_eq!(
            hello.flags.get("loud").unwrap().description.as_deref(),
            Some("Say it loudly")
        );
        assert_eq!(hello.flags.get("refuse").unwrap().description, None);
        let hello_roots: Vec<_> = roots
            .iter()
            .filter(|root| root.workflow == "hello")
            .cloned()
            .collect();
        assert_eq!(hello_roots.len(), 2);

        let report = runtime
            .execute_graph(
                "hello",
                &hello_roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "loud": true, "refuse": false }),
                &["a".to_owned(), "b".to_owned()],
            )
            .await
            .unwrap()
            .unwrap();
        assert!(report.contains("//:greeting artifact hi"), "{report}");
        assert!(report.contains("//:status status 3 partial"), "{report}");
        assert!(report.contains("loud=true"), "{report}");
        assert!(report.contains("args=a b"), "{report}");

        let error = runtime
            .execute_graph(
                "hello",
                &hello_roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "loud": false, "refuse": true }),
                &[],
            )
            .await
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<crate::spike::UserFacingGoalError>()
                .is_some(),
            "{error:#}"
        );
        assert_eq!(error.to_string(), "hello refused on purpose");

        // A caught refusal does not hide a later error.
        let error = runtime
            .execute_graph(
                "hello",
                &hello_roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "mask": true }),
                &[],
            )
            .await
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<crate::spike::UserFacingGoalError>()
                .is_none(),
            "{error:#}"
        );
        assert!(
            format!("{error:#}").contains("real internal failure"),
            "{error:#}"
        );

        // As in JavaScript, no selected roots means no workflow call.
        let report = runtime
            .execute_graph(
                "hello",
                &[],
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "refuse": true }),
                &[],
            )
            .await
            .unwrap();
        assert_eq!(report, None);

        let error = runtime
            .execute_graph(
                "lint",
                &hello_roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(
                "goal 'lint' has no registered Luau workflow; require @imp/rules/workflows/lint"
            ),
            "{error:#}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_program_runs_in_the_workspace_with_staged_inputs_and_cli_args() {
        let (workspace_root, _rules_root, mut runtime) = hello_goal_workspace().await;
        let roots: Vec<_> = runtime
            .load_modules()
            .await
            .unwrap()
            .into_iter()
            .filter(|root| root.workflow == "launch")
            .collect();
        runtime
            .execute_graph(
                "launch",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &["one".to_owned(), "two".to_owned()],
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(workspace_root.path().join("ran.txt")).unwrap(),
            "one,two,"
        );
    }

    /// Capture a directory with `files` (path, content) into CAS and return
    /// its tree digest.
    fn captured_tree(files: &[(&str, &str)]) -> String {
        let directory = tempfile::tempdir().unwrap();
        for (path, content) in files {
            let path = directory.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        imp_store::digest::capture_directory(directory.path())
            .unwrap()
            .digest()
            .to_owned()
    }

    /// Run `goal` with the loaded roots whose address is in `addresses`.
    async fn execute_workflow(
        runtime: &mut LuauWorkspace,
        roots: &[GraphRoot],
        goal: &str,
        addresses: &[&str],
        flags: serde_json::Value,
        run_args: &[String],
    ) -> Result<Option<String>> {
        let selected: Vec<_> = roots
            .iter()
            .filter(|root| root.workflow == goal && addresses.contains(&root.address.as_str()))
            .cloned()
            .collect();
        assert_eq!(
            selected.len(),
            addresses.len(),
            "{goal} roots: {addresses:?}"
        );
        runtime
            .execute_graph(
                goal,
                &selected,
                Arc::new(AtomicBool::new(false)),
                &flags,
                run_args,
            )
            .await
    }

    #[tokio::test]
    async fn fmt_and_lint_workflows_write_and_report_at_the_goal_boundary() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        let sources = captured_tree(&[("src/a.txt", "messy\n"), ("src/b.txt", "same\n")]);
        let formatted = captured_tree(&[
            ("src/a.txt", "clean\n"),
            ("src/b.txt", "same\n"),
            (
                "tool/extra.txt",
                "a sandbox entry that is not a declared path\n",
            ),
        ]);
        let fixed = captured_tree(&[("fixed/src/c.txt", "fixed\n")]);
        fs::create_dir_all(workspace_root.path().join("src")).unwrap();
        fs::write(workspace_root.path().join("src/a.txt"), "messy\n").unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            format!(
                r#"
local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local output = core.output

local function value(result)
    return core.task({{
        outputs = {{ value = output.value() }},
        run = function()
            return {{ value = result }}
        end,
    }})
end

local function fmt_result(path, requested)
    return {{
        paths = {{ path }},
        sources_digest = "{sources}",
        formatted = {{ digest = "{formatted}" }},
        check = {{ requested = requested, failed = false }},
    }}
end

return {{
    changed = {{ [fmt.FMT] = value(fmt_result("src/a.txt", false)) }},
    same = {{ [fmt.FMT] = value(fmt_result("src/b.txt", false)) }},
    checked = {{ [fmt.FMT] = value(fmt_result("src/a.txt", true)) }},
    clean = {{ [lint.LINT] = value({{ ok = true }}) }},
    dirty = {{ [lint.LINT] = value({{ ok = false, output = "bad style" }}) }},
    fixable = {{
        [lint.LINT] = value({{
            result = {{
                ok = true,
                fix_applied = true,
                paths = {{ "src/c.txt" }},
                fixed = {{ digest = "{fixed}" }},
            }},
        }}),
    }},
}}
"#
            ),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let read = |path: &str| fs::read_to_string(workspace_root.path().join(path)).unwrap();

        // A write run compares each declared path and writes the formatted
        // sources. The extra entry in the formatted tree is not a change.
        let report = execute_workflow(
            &mut runtime,
            &roots,
            "fmt",
            &["//:changed", "//:same"],
            serde_json::json!({ "check": false }),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert!(report.contains("//:changed  \u{1b}[33mCHANGED"), "{report}");
        assert!(
            report.contains("//:same     \u{1b}[32mUNCHANGED"),
            "{report}"
        );
        assert!(
            report.ends_with("fmt: 1 unchanged, 1 changed, 0 failed"),
            "{report}"
        );
        assert_eq!(read("src/a.txt"), "clean\n");
        assert!(!workspace_root.path().join("tool").exists());

        // A check run reports a changed path as failed and writes nothing.
        fs::write(workspace_root.path().join("src/a.txt"), "messy\n").unwrap();
        let error = execute_workflow(
            &mut runtime,
            &roots,
            "fmt",
            &["//:checked"],
            serde_json::json!({ "check": true }),
            &[],
        )
        .await
        .unwrap_err();
        assert!(
            error
                .downcast_ref::<crate::spike::UserFacingGoalError>()
                .is_some(),
            "{error:#}"
        );
        assert!(
            error
                .to_string()
                .ends_with("fmt: 0 unchanged, 0 changed, 1 failed"),
            "{error:#}"
        );
        assert_eq!(read("src/a.txt"), "messy\n");

        // `--fix` writes fixes from `fixed/`, also when another root fails.
        let error = execute_workflow(
            &mut runtime,
            &roots,
            "lint",
            &["//:dirty", "//:fixable"],
            serde_json::json!({ "fix": true }),
            &[],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("//:dirty:\nbad style"), "{error}");
        assert!(error.contains("\u{1b}[33mFIXED"), "{error}");
        assert!(
            error.ends_with("lint: 0 clean, 1 fixed, 1 failed"),
            "{error}"
        );
        assert_eq!(read("src/c.txt"), "fixed\n");

        fs::remove_file(workspace_root.path().join("src/c.txt")).unwrap();
        let report = execute_workflow(
            &mut runtime,
            &roots,
            "lint",
            &["//:clean", "//:fixable"],
            serde_json::json!({ "fix": false }),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            report.ends_with("lint: 1 clean, 1 fixed, 0 failed"),
            "{report}"
        );
        assert!(!workspace_root.path().join("src/c.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fmt_workflow_compares_a_real_formatter_task_with_its_sources() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("src")).unwrap();
        fs::write(workspace_root.path().join("src/b.txt"), "same\n").unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")
local output = core.output

local sources = core.files({ root = "src", include = { "*.txt" } })
local other = core.files({ root = "src", include = { "b.txt" } })

local function expect_error(expected, fn, ...)
    local ok, problem = pcall(fn, ...)
    assert(not ok, "expected an error: " .. expected)
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end

-- A toy formatter: it changes a "messy" line to "clean" in place. It uses
-- only shell builtins, because the test can run in an Imp sandbox.
local formatter = core.task({
    inputs = {
        sources = sources,
        sh = core.native_tool("sh"),
    },
    outputs = {
        paths = output.value(),
        sources_digest = output.value(),
        formatted = output.artifact(),
        check = output.value(),
        output = output.value(),
    },
    run = function(exec, inputs)
        local paths = exec.paths(inputs.sources)
        assert(#paths == 2 and paths[1] == "src/a.txt" and paths[2] == "src/b.txt")
        local sources_digest = exec.digest(inputs.sources)
        assert(exec.digest(inputs.sources) == sources_digest)
        expect_error("exec.paths(handle) requires a declared task input", exec.paths, other)
        expect_error("exec.digest(handle) requires a files handle", exec.digest, inputs.sh)
        local result = exec.action({
            argv = {
                "sh",
                "-c",
                'for path in "$@"; do read -r line < "$path"; [ "$line" = messy ] && line=clean; printf "%s\\n" "$line" > "$path"; done',
                "fmt",
                table.unpack(paths),
            },
            inputs = { inputs.sources },
            outputs = { formatted = output.directory("src") },
            allow_failure = true,
        })
        -- The digest of an action artifact nests it at its captured path.
        local formatted_digest = exec.digest(result.outputs.formatted)
        assert(core.read_file_in_digest(formatted_digest, "src/b.txt") == "same\n")
        expect_error("exec.paths(handle) requires a files handle", exec.paths, result.outputs.formatted)
        return {
            paths = paths,
            sources_digest = sources_digest,
            formatted = result.outputs.formatted,
            check = { requested = false, failed = result.exit_code ~= 0 },
            output = result.stderr,
        }
    end,
})

return { formatted = { [fmt.FMT] = formatter } }
"#,
        )
        .unwrap();
        let read = |path: &str| fs::read_to_string(workspace_root.path().join(path)).unwrap();
        let format = |content: &str| {
            fs::write(workspace_root.path().join("src/a.txt"), content).unwrap();
            let workspace_root = workspace_root.path().to_owned();
            let rules_root = rules_root.path().to_owned();
            async move {
                let mut runtime = LuauWorkspace::new(&workspace_root, &rules_root).unwrap();
                let roots = runtime.load_modules().await.unwrap();
                execute_workflow(
                    &mut runtime,
                    &roots,
                    "fmt",
                    &["//:formatted"],
                    serde_json::json!({ "check": false }),
                    &[],
                )
                .await
                .unwrap()
                .unwrap()
            }
        };

        let report = format("clean\n").await;
        assert!(
            report.ends_with("fmt: 1 unchanged, 0 changed, 0 failed"),
            "{report}"
        );

        let report = format("messy\n").await;
        assert!(
            report.ends_with("fmt: 0 unchanged, 1 changed, 0 failed"),
            "{report}"
        );
        assert_eq!(read("src/a.txt"), "clean\n");
        assert_eq!(read("src/b.txt"), "same\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_workflow_starts_one_program_with_the_cli_arguments() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        let program = captured_tree(&[("note.txt", "staged\n")]);
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            format!(
                r#"
local core = require("@imp/core")
local run = require("@imp/rules/workflows/run")
local output = core.output
local sh = core.native_tool("sh")

local tool = core.task({{
    inputs = {{ sh = sh, chmod = core.native_tool("chmod") }},
    outputs = {{ file = output.artifact() }},
    run = function(exec)
        local result = exec.action({{
            argv = {{
                "sh",
                "-c",
                "printf '#!/bin/sh\nprintf \"%%s,\" \"$@\" > staged.txt\n' > tool; chmod +x tool",
            }},
            outputs = {{ file = output.file("tool") }},
        }})
        return {{ file = result.outputs.file }}
    end,
}})

local described = core.task({{
    outputs = {{ value = output.value() }},
    run = function()
        return {{
            value = {{
                argv = {{ "sh", "-c", 'cat "$IMP_SANDBOX_ROOT/note.txt" > described.txt; printf "%s," "$@" >> described.txt', "described" }},
                digest = "{program}",
            }},
        }}
    end,
}})

return {{
    tool = {{ [run.RUN] = tool }},
    described = {{ [run.RUN] = described }},
}}
"#
            ),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let args = ["one".to_owned(), "two".to_owned()];
        let read = |path: &str| fs::read_to_string(workspace_root.path().join(path)).unwrap();

        // A built executable starts through the staged launcher, in the
        // workspace, with the CLI arguments.
        execute_workflow(
            &mut runtime,
            &roots,
            "run",
            &["//:tool"],
            serde_json::json!({}),
            &args,
        )
        .await
        .unwrap();
        assert_eq!(read("staged.txt"), "one,two,");

        // A full program description uses its own argv and stages its digest.
        execute_workflow(
            &mut runtime,
            &roots,
            "run",
            &["//:described"],
            serde_json::json!({}),
            &args,
        )
        .await
        .unwrap();
        assert_eq!(read("described.txt"), "staged\none,two,");

        let error = execute_workflow(
            &mut runtime,
            &roots,
            "run",
            &["//:tool", "//:described"],
            serde_json::json!({}),
            &[],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            error.starts_with("run requires a single target, got 2: "),
            "{error}"
        );
        assert!(
            error.contains("//:tool") && error.contains("//:described"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn luau_content_artifacts_preserve_bytes_and_feed_sandboxed_actions() {
        let source = r#"
local core = require("@imp/core")

    local producer = core.task({
        outputs = { file = core.output.artifact() },
        run = function(exec)
            for _, path in ipairs({ "", ".", "../escape", "/absolute" }) do
                assert(not pcall(exec.file, { path = path, contents = "bad" }), path)
            end
            assert(not pcall(exec.file, { path = "ok", contents = "", extra = true }))
            local empty = exec.file({ path = "empty", contents = "" })
            assert(core.read_file_in_digest(exec.digest(empty), "empty") == "")
            local contents = string.rep("payload", 40000) .. "\0é\n"
            local file = exec.file({ path = "source/data", contents = contents })
            local same = exec.file({ path = "source/data", contents = contents })
            assert(exec.digest(file) == exec.digest(same))
            local changed = exec.file({ path = "source/data", contents = contents .. "changed" })
            assert(exec.digest(file) ~= exec.digest(changed))
            return { file = file }
        end,
    })
    local consumer = core.task({
        inputs = { source = producer.outputs.file, sh = core.native_tool("sh"), cp = core.native_tool("cp") },
        outputs = { checked = core.output.value() },
        run = function(exec, inputs)
            local function copy(source)
                return exec.action({
                    argv = { "sh", "-c", 'cp "$1" "$2"', "copy", exec.path(source), "copied" },
                    inputs = { source },
                    outputs = { file = core.output.file("copied") },
                }).outputs.file
            end
            local contents = string.rep("payload", 40000) .. "\0é\n"
            local copied = copy(inputs.source)
            assert(core.read_file_in_digest(exec.digest(copied), "copied") == contents)
            local repeated = copy(inputs.source)
            assert(exec.digest(repeated) == exec.digest(copied))
            local changed = exec.file({ path = "source/data", contents = contents .. "changed" })
            assert(core.read_file_in_digest(exec.digest(copy(changed)), "copied") == contents .. "changed")
            return { checked = true }
        end,
    })
return consumer
"#;
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(workspace_root.path().join("content.luau"), source).unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let LuaValue::UserData(task) = runtime.evaluate("@workspace/content").await.unwrap() else {
            panic!("content module must return a task");
        };
        runtime.execute_task(&task).await.unwrap();
        assert_eq!(runtime.action_count(), 3);
        assert!(runtime.cache_hit_count() >= 1);
        assert!(!workspace_root.path().join("copied").exists());
        assert!(!workspace_root.path().join("source/data").exists());
    }

    /// `gen-lockfiles` downloads and hashes each artifact in a real action,
    /// keeps the versions that the lockfile has, and writes the lockfile into
    /// the workspace at the goal boundary.
    #[cfg(unix)]
    #[tokio::test]
    async fn gen_lockfiles_workflow_hashes_real_downloads_and_writes_at_the_goal_boundary() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        let downloads = tempfile::tempdir().unwrap();
        let artifact = downloads.path().join("demo.tar.gz");
        fs::write(&artifact, "hello\n").unwrap();
        fs::create_dir_all(workspace_root.path().join("tools")).unwrap();
        let existing = r#"{
  "tool": "demo",
  "versions": {
    "0.1.0": {
      "linux/x86_64": {
        "url": "https://example.test/old",
        "artifact": "old",
        "size": 1,
        "sha256": "00"
      }
    }
  }
}
"#;
        let existing = existing.replace(
            "https://example.test/old",
            &format!("https://example.test/{}", "x".repeat(270_000)),
        );
        fs::write(workspace_root.path().join("tools/demo.lock"), &existing).unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            format!(
                r#"
local lockfiles = require("@imp/rules/workflows/lockfiles")

return {{
    demo = {{
        [lockfiles.GEN_LOCKFILES] = lockfiles.graph_generate_tool_lockfile({{
            version = "1.0.0",
            name = "demo",
            platforms = {{ {{ os = "linux", arch = "x86_64" }} }},
            download_url = function()
                return "file://{artifact}"
            end,
            artifact_name = function(version, plat)
                return `demo-${{version}}-${{plat.os}}.tar.gz`
            end,
            lockfile = "@workspace/tools/demo.lock",
        }}),
    }},
}}
"#,
                artifact = artifact.display(),
            )
            .replace("${", "{"),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        assert_eq!(
            fs::read_to_string(workspace_root.path().join("tools/demo.lock")).unwrap(),
            existing
        );

        let report = execute_workflow(
            &mut runtime,
            &roots,
            "gen-lockfiles",
            &["//:demo"],
            serde_json::json!({}),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(report, "gen-lockfiles: regenerated 1 lockfile(s): demo");
        let expected = format!(
            r#"{{
  "tool": "demo",
  "versions": {{
    "0.1.0": {{
      "linux/x86_64": {{
        "url": "https://example.test/old",
        "artifact": "old",
        "size": 1,
        "sha256": "00"
      }}
    }},
    "1.0.0": {{
      "linux/x86_64": {{
        "url": "file://{artifact}",
        "artifact": "demo-1.0.0-linux.tar.gz",
        "size": 6,
        "sha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
      }}
    }}
  }}
}}
"#,
            artifact = artifact.display(),
        );
        let expected = expected.replace(
            "https://example.test/old",
            &format!("https://example.test/{}", "x".repeat(270_000)),
        );
        assert!(expected.len() > 262_144);
        assert_eq!(
            fs::read_to_string(workspace_root.path().join("tools/demo.lock")).unwrap(),
            expected
        );
    }

    /// `package` publishes real artifacts under `dist/`, and `publish`
    /// reports its selected roots.
    #[cfg(unix)]
    #[tokio::test]
    async fn package_and_publish_workflows_publish_real_artifacts() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local package = require("@imp/rules/workflows/package")
local publish = require("@imp/rules/workflows/publish")
local output = core.output

local function built(path, text)
    return core.task({
        inputs = { sh = core.native_tool("sh") },
        outputs = { artifact = output.artifact() },
        run = function(exec)
            local result = exec.action({
                argv = { "sh", "-c", 'printf %s "$2" > "$1"', "write", path, text },
                outputs = { artifact = output.file(path) },
            })
            return { artifact = result.outputs.artifact }
        end,
    }).outputs.artifact
end

local pushed = core.task({
    outputs = { value = output.value() },
    run = function()
        return { value = "pushed" }
    end,
})

return {
    app = { [package.PACKAGE] = built("app", "executable\n") },
    hello = { [package.PACKAGE] = built("libhello.so.1", "library\n") },
    image = { [publish.PUBLISH] = pushed },
}
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let read = |path: &str| fs::read_to_string(workspace_root.path().join(path)).unwrap();

        let report = execute_workflow(
            &mut runtime,
            &roots,
            "package",
            &["//:app", "//:hello"],
            serde_json::json!({}),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert!(report.starts_with("Packaged 2 targets:"), "{report}");
        assert!(report.contains("\n  //:app -> dist/app"), "{report}");
        assert!(
            report.contains("\n  //:hello -> dist/libhello.so.1"),
            "{report}"
        );
        assert_eq!(read("dist/app"), "executable\n");
        assert_eq!(read("dist/libhello.so.1"), "library\n");

        let report = execute_workflow(
            &mut runtime,
            &roots,
            "publish",
            &["//:image"],
            serde_json::json!({}),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(report, "Published 1 target:\n  //:image");
    }

    /// The Luau workspace of this repository loads, and every rule test root
    /// (`core.test_root()`) in it passes. Product test roots, such as the
    /// CMake example ctest roots, need real toolchains and are left to
    /// `IMP_RUNTIME=luau imp test //...`.
    #[tokio::test]
    async fn repository_luau_workspace_tests_pass() {
        let rules_root = crate::loader::RulesSource::discover()
            .root()
            .expect("tests need the repository rules tree")
            .to_owned();
        let workspace_root = rules_root.parent().unwrap();
        assert!(
            workspace_root.join("imp.workspace.luau").is_file(),
            "the test inputs must include imp.workspace.luau"
        );
        let mut runtime = LuauWorkspace::new(workspace_root, &rules_root).unwrap();
        let roots: Vec<_> = runtime
            .load_modules()
            .await
            .unwrap()
            .into_iter()
            .filter(|root| root.workflow == "test")
            .collect();
        let roots: Vec<_> = {
            let host = runtime.host.borrow();
            roots
                .into_iter()
                .filter(|root| {
                    matches!(
                        host.nodes.get(&(root.handle_id as u64)),
                        Some(GraphNode::TestRoot { .. })
                    )
                })
                .collect()
        };
        assert!(
            roots
                .iter()
                .any(|root| root.address == "//rules/workflows:rules_test"),
            "{:?}",
            roots.iter().map(|root| &root.address).collect::<Vec<_>>()
        );
        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap_or_else(|error| panic!("{error:#}"))
            .unwrap();
        assert!(report.contains("unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn root_slots_require_a_registered_goal() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
return { lint = { LINT = core.task({ run = function() end }) } }
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let error = runtime.load_modules().await.unwrap_err();
        assert!(
            error.to_string().contains(
                "//:lint exports slot 'LINT', but no goal registers it; require @imp/rules/workflows/lint"
            ),
            "{error:#}"
        );
    }

    #[tokio::test]
    async fn slot_registration_does_not_depend_on_module_order() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        for package in ["a", "z"] {
            fs::create_dir_all(workspace_root.path().join(package)).unwrap();
        }
        // `a` loads first and uses the slot that only `z` registers.
        fs::write(
            workspace_root.path().join("a/BUILD.luau"),
            r#"
local core = require("@imp/core")
local output = core.output
return {
    shape = {
        TEST = core.task({
            outputs = { units = output.value() },
            run = function()
                return { units = { a = 1 } }
            end,
        }),
    },
}
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("z/BUILD.luau"),
            "local test = require('@imp/rules/workflows/test')\nreturn {}\n",
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].workflow, "test");

        let error = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "//a:shape: a TEST root must resolve to a list of { name, ok, output } units"
        );
    }

    #[tokio::test]
    async fn core_goal_validates_names_options_and_flags() {
        let (_workspace_root, report) = run_luau_test_module(
            r#"
local core = require("@imp/core")

local function expect_error(expected, fn, ...)
    local ok, problem = pcall(fn, ...)
    assert(not ok, "expected an error: " .. expected)
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end

local function goal() end

return {
    core.test.case("registration", function()
        assert(core.goal("my-goal", goal) == "MY_GOAL")
        expect_error("goal 'my-goal' is already registered", core.goal, "my-goal", goal)
        expect_error("core.goal name 'Bad' must use lowercase letters", core.goal, "Bad", goal)
        expect_error("options do not accept 'help'", core.goal, "a", goal, { help = "x" })
        expect_error("flag 'Loud' must use lowercase letters", core.goal, "b", goal, { flags = { Loud = {} } })
        expect_error("flag 'loud' accepts only a 'description' string", core.goal, "c", goal, {
            flags = { loud = { default = true } },
        })
        expect_error("flag 'jobs' is reserved by the imp CLI", core.goal, "d", goal, { flags = { jobs = {} } })
    end),
}
"#,
        )
        .await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("1/1 unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn luau_self_tool_puts_the_running_executable_on_the_action_path() {
        let (_workspace_root, report) = run_luau_test_module(
            r#"
local core = require("@imp/core")
local output = core.output

local function probe(inputs)
    return core.task({
        inputs = inputs,
        outputs = { found = output.value() },
        run = function(exec)
            local result = exec.action({
                argv = { "sh", "-c", ": > marker; command -v imp" },
                display = "find imp",
                env = { PATH = "" },
                allow_failure = true,
                outputs = { marker = output.file("marker") },
            })
            return { found = result.exit_code == 0 }
        end,
    })
end

return {
    core.test.case("runs with imp on PATH", function()
        assert(core.test.resolve(probe({ imp = core.self_tool() }).outputs.found) == true)
        assert(core.test.resolve(probe({}).outputs.found) == false)
    end),
    core.test.case("fakes record the self tool", function()
        core.test.with_fake_toolchain_host(function(host)
            core.test.resolve(probe({ imp = core.self_tool() }))
            assert(#host.runs == 1)
            assert(#host.runs[1].tools == 1 and host.runs[1].tools[1] == "imp")
            local recorded = false
            for _, call in host.calls do
                if call[1] == "self_tool" then
                    recorded = true
                end
            end
            assert(recorded)
        end)
    end),
    core.test.case("rejects a second imp tool", function()
        local ok, problem = pcall(core.test.resolve, probe({ a = core.self_tool(), b = core.self_tool() }))
        assert(not ok)
        assert(string.find(tostring(problem), "tool name 'imp' more than once", 1, true), tostring(problem))
    end),
}
"#,
        )
        .await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 3/3 unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn luau_test_fakes_replace_host_functions_and_record_calls() {
        let (workspace_root, report) = run_luau_test_module(
            r#"
local core = require("@imp/core")
local output = core.output

local function toolchain()
    local install = core.task({
        inputs = { cmake = core.native_tool("cmake-not-on-path") },
        outputs = { root = output.artifact() },
        run = function(exec)
            local platform = core.platform_info()
            local result = exec.action({
                argv = { "cmake-not-on-path", "--install", platform.os },
                display = "install cmake",
                env = { MODE = "fake" },
                outputs = {
                    root = output.directory(".imp/cmake", {
                        named_cache = { name = "cmake", key = platform.os .. "-" .. platform.arch },
                    }),
                },
            })
            return { root = result.outputs.root }
        end,
    })
    local tool = core.tool(install.outputs.root, { name = "cmake" })
    local root = core.path(install.outputs.root)
    return core.task({
        inputs = { cmake = tool, root = root },
        outputs = { version = output.value() },
        run = function(exec, inputs)
            exec.action({ argv = { "cmake", "--version" }, inputs = { inputs.root } })
            return { version = exec.path(inputs.root) }
        end,
    })
end

return {
    core.test.case("toolchain host", function()
        local version = core.test.with_fake_toolchain_host({ os = "fake-os", arch = "fake-arch" }, function(host)
            local version = core.test.resolve(toolchain().outputs.version)
            assert(#host.runs == 2, "expected two runs")
            local install = host.runs[1]
            assert(install.display == "install cmake")
            assert(install.argv[3] == "fake-os")
            assert(install.env.MODE == "fake")
            assert(install.tools[1] == "cmake-not-on-path")
            assert(install.outputs.root == ".imp/cmake")
            assert(host.runs[2].display == "cmake --version")
            assert(host.runs[2].tools[1] == "cmake")
            assert(host.runs[2].input_count == 1)
            assert(host.calls[1][1] == "platform_info")
            assert(host.calls[2][1] == "native_tool" and host.calls[2][2] == "cmake-not-on-path")
            assert(host.calls[3][1] == "named_cache" and host.calls[3][2] == "cmake")
            assert(host.calls[3][3] == "fake-os-fake-arch")
            return version
        end)
        assert(version == ".imp/cmake")
        assert(core.platform_info().os ~= "fake-os", "fake platform leaked out of its scope")
    end),
    core.test.case("default toolchain platform", function()
        core.test.with_fake_toolchain_host(function(host)
            local platform = core.platform_info()
            assert(platform.os == "linux" and platform.arch == "x86_64")
            assert(#host.calls == 1)
        end)
    end),
    core.test.case("run", function()
        local failing = core.task({
            inputs = { sh = core.native_tool("sh") },
            run = function(exec)
                exec.action({ argv = { "sh", "-c", "exit 3" }, display = "exit three" })
            end,
        })
        core.test.with_fake_run(function(fake)
            core.test.resolve(failing)
            assert(#fake.runs == 1 and fake.runs[1].display == "exit three")
            assert(fake.runs[1].tools[1] == "sh")
        end)
        local ok, problem = pcall(core.test.resolve, failing)
        assert(not ok, "the real host must run the action after the fake scope")
        assert(string.find(tostring(problem), "failed with exit code 3", 1, true), tostring(problem))
    end),
    core.test.case("real result is not reused inside a fake", function()
        local real = core.task({
            inputs = { sh = core.native_tool("sh") },
            outputs = { status = output.value() },
            run = function(exec)
                exec.action({ argv = { "sh", "-c", "true" }, display = "real true", cache = false })
                return { status = "ok" }
            end,
        })
        assert(core.test.resolve(real.outputs.status) == "ok")
        core.test.with_fake_run(function(fake)
            assert(core.test.resolve(real.outputs.status) == "ok")
            assert(#fake.runs == 1, "the fake scope must run the task again")
        end)
    end),
    core.test.case("real host after a failed fake scope", function()
        local failing = core.task({
            inputs = { sh = core.native_tool("sh") },
            run = function(exec)
                exec.action({ argv = { "sh", "-c", "exit 3" }, display = "exit three" })
            end,
        })
        local ok = pcall(core.test.with_fake_run, function()
            core.test.resolve(failing)
            error("body failed")
        end)
        assert(not ok)
        local real_ok, problem = pcall(core.test.resolve, failing)
        assert(not real_ok)
        assert(string.find(tostring(problem), "failed with exit code 3", 1, true), tostring(problem))
    end),
    core.test.case("write workspace", function()
        core.test.with_fake_write_workspace(function(fake)
            core.write_workspace("dist/app", "sha256:abc", { from = "bin/app" })
            core.write_workspace("dist/lib", "sha256:def")
            assert(#fake.calls == 2)
            assert(fake.calls[1].path == "dist/app")
            assert(fake.calls[1].digest == "sha256:abc")
            assert(fake.calls[1].from == "bin/app")
            assert(fake.calls[2].from == nil)
        end)
        local ok, problem = pcall(core.write_workspace, "dist/app", "sha256:missing")
        assert(not ok, "the real host must reject writes outside a goal callback")
        assert(string.find(tostring(problem), "core.write_workspace() can only run in a goal callback", 1, true), tostring(problem))
    end),
    core.test.case("run and write workspace fakes together", function()
        local publish = core.task({
            inputs = { sh = core.native_tool("sh") },
            run = function(exec)
                local result = exec.action({
                    argv = { "sh", "-c", "build" },
                    display = "build app",
                    outputs = { app = output.file("app") },
                })
                core.write_workspace("dist/app", "fake")
                return nil
            end,
        })
        core.test.with_fake_run(function(run)
            core.test.with_fake_write_workspace(function(write)
                core.test.resolve(publish)
                assert(#run.runs == 1 and run.runs[1].outputs.app == "app")
                assert(#write.calls == 1 and write.calls[1].path == "dist/app")
            end)
        end)
    end),
}
"#,
        )
        .await;
        let report = report.unwrap();
        assert!(
            report
                .as_deref()
                .unwrap()
                .contains("test: 7/7 unit(s) passed"),
            "{report:?}"
        );
        assert!(!workspace_root.path().join("dist/app").exists());
        assert!(!workspace_root.path().join("dist/lib").exists());
    }

    #[tokio::test]
    async fn luau_test_fakes_report_misuse() {
        let (_workspace_root, report) = run_luau_test_module(
            r#"
local core = require("@imp/core")
local output = core.output

local function expect_error(expected, fn, ...)
    local ok, problem = pcall(fn, ...)
    assert(not ok, "expected an error: " .. expected)
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end

local module_level_ok, module_level_problem = pcall(core.test.with_fake_run, function() end)

return {
    core.test.case("module level", function()
        assert(not module_level_ok)
        expect_error(
            "core.test.with_fake_run can only run inside a running core.test.case",
            error,
            module_level_problem
        )
    end),
    core.test.case("nested", function()
        core.test.with_fake_run(function()
            expect_error(
                "core.test.with_fake_toolchain_host cannot run while another fake replaces the same host function",
                core.test.with_fake_toolchain_host,
                function() end
            )
        end)
    end),
    core.test.case("removed after failure", function()
        expect_error("body failed", core.test.with_fake_run, function() error("body failed") end)
        core.test.with_fake_run(function() end)
    end),
    core.test.case("bad platform", function()
        expect_error(
            "core.test.with_fake_toolchain_host platform requires a non-empty 'arch' string",
            core.test.with_fake_toolchain_host,
            { os = "linux" },
            function() end
        )
        expect_error(
            "core.test.with_fake_toolchain_host expects ([platform,] fn)",
            core.test.with_fake_toolchain_host,
            { os = "linux", arch = "x86_64" }
        )
    end),
    core.test.case("fake inside a task", function()
        local task = core.task({
            run = function()
                core.test.with_fake_run(function() end)
            end,
        })
        expect_error(
            "core.test.with_fake_run cannot run inside a task run or expansion create callback",
            core.test.resolve,
            task
        )
    end),
    core.test.case("fake validates like the real host", function()
        local file = core.task({
            outputs = { root = output.artifact() },
            run = function(exec)
                local result = exec.action({ argv = { "make" }, outputs = { root = output.file("tool") } })
                return { root = result.outputs.root }
            end,
        })
        local uses_file_tool = core.task({
            inputs = { tool = core.tool(file.outputs.root, { name = "tool" }) },
            run = function(exec)
                exec.action({ argv = { "tool" } })
            end,
        })
        local bad_env = core.task({
            run = function(exec)
                exec.action({ argv = { "true" }, env = { ["A=B"] = "x" } })
            end,
        })
        local duplicate_tool = core.task({
            inputs = { first = core.native_tool("sh"), second = core.native_tool("sh") },
            run = function(exec)
                exec.action({ argv = { "sh" }, outputs = { bad = output.value() } })
            end,
        })
        core.test.with_fake_run(function()
            expect_error("must use a directory artifact", core.test.resolve, uses_file_tool)
            expect_error("exec.action().env requires valid environment names and values", core.test.resolve, bad_env)
            expect_error("exec.action received tool name 'sh' more than once", core.test.resolve, duplicate_tool)
        end)
    end),
    core.test.case("resolve non-task", function()
        expect_error(
            "core.test.resolve requires a task or task output handle, got native_tool",
            core.test.resolve,
            core.native_tool("sh")
        )
    end),
}
"#,
        )
        .await;
        let report = report.unwrap();
        assert!(
            report
                .as_deref()
                .unwrap()
                .contains("test: 7/7 unit(s) passed"),
            "{report:?}"
        );
    }

    #[tokio::test]
    async fn luau_test_failure_reports_canonical_module_and_source_location() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("pkg")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            "local core = require('@imp/core')\nlocal test = require('@imp/rules/workflows/test')\nreturn { tests = { [test.TEST] = core.test_root() } }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("pkg/failure.test.luau"),
            "local core = require('@imp/core')\nreturn { core.test.case('fails', function()\n    error('expected failure')\nend) }\n",
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let error = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("//pkg:tests"), "{error}");
        assert!(error.contains("@workspace/pkg/failure.test"), "{error}");
        assert!(error.contains(":3:"), "{error}");
        assert!(error.contains("expected failure"), "{error}");
    }

    #[tokio::test]
    async fn opt_in_luau_workspace_loads_installed_asset_and_executes_hermetically() {
        let workspace_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "local core = require('@imp/core')\ncore.define_config_schema('pilot', { enabled = core.field.bool() })\nreturn { imp = { jobs = 3 }, pilot = { enabled = true } }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local first = require("@imp/rules/asset")
local second = require("@imp/rules/asset/index")
assert(rawequal(first, second))
local declared = first.asset({ srcs = { "*.txt" } })
return { assets = declared }
"#,
        )
        .unwrap();
        fs::write(workspace_root.path().join("payload.txt"), "pilot input\n").unwrap();
        let live = crate::spike::load_workspace_with_rules(
            workspace_root.path(),
            crate::loader::RulesSource::discover(),
        )
        .await
        .unwrap();
        assert!(live.luau.is_some());
        assert_eq!(
            live.workspace.workspace_config.get("imp"),
            Some(
                &serde_json::json!({ "jobs": 3, "js_workers": 1, "passthrough_env": [], "log_level": "info" })
            )
        );
        assert_eq!(
            live.workspace.workspace_config.get("pilot"),
            Some(&serde_json::json!({ "enabled": true }))
        );
        assert_eq!(live.workspace.graph.roots.len(), 1);
        assert_eq!(live.workspace.graph.roots[0].address, "//:assets");

        let (events, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = imp_scheduler::Scheduler::new(1, Arc::new(AtomicBool::new(false)), events);
        *live.scheduler.lock().unwrap() = Some(scheduler);
        crate::spike::execute_goal_live(
            &live,
            workspace_root.path(),
            "build",
            &["//:assets".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(
            live.luau.as_ref().unwrap().borrow().action_count(),
            1,
            "the hermetic action must run through the Luau host"
        );
    }

    #[tokio::test]
    async fn luau_configuration_schema_and_dynamic_apis_validate_values() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(rules_root.path().join("sample")).unwrap();
        fs::write(
            rules_root.path().join("sample/index.luau"),
            r#"
local core = require("@imp/core")
local field = core.field
core.define_config_schema("sample", {
    mode = field.enum({ "fast", "safe" }, { required = true }),
    nested = field.object({ enabled = field.bool({ default = false }) }),
    labels = field.map(field.string(), field.string(), { default = {} }),
    tags = field.array(field.string(), { default = {} }),
})
return {}
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/sample")
return {
    imp = {
        jobs = 3,
        fs_jobs = 4,
        passthrough_env = { "DISPLAY", "MODE=fast" },
        log_level = "warn",
    },
    cache = { gc_max_age_days = 5 },
    sample = { mode = "fast", nested = { enabled = true }, labels = { ["local"] = "yes" } },
}
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
assert(core.configuration("sample").mode == "fast")
assert(core.configuration("imp").jobs == 3)
assert(core.configuration_schemas().sample ~= nil)
core.configure("dynamic", { enabled = true })
assert(core.configuration("dynamic").enabled == true)
return {}
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        runtime.load_modules().await.unwrap();
        let config = runtime.workspace_config();
        assert_eq!(config["imp"]["jobs"], 3);
        assert_eq!(config["imp"]["fs_jobs"], 4);
        assert_eq!(config["imp"]["js_workers"], 1);
        assert_eq!(
            config["imp"]["passthrough_env"],
            serde_json::json!(["DISPLAY", "MODE=fast"])
        );
        assert_eq!(config["imp"]["log_level"], "warn");
        assert_eq!(config["cache"]["gc_max_age_days"], 5);
        assert_eq!(config["sample"]["mode"], "fast");
        assert_eq!(config["sample"]["nested"]["enabled"], true);
        assert_eq!(
            config["sample"]["nested"]["missing"],
            serde_json::Value::Null
        );
        assert_eq!(config["sample"]["tags"], serde_json::json!([]));
        assert_eq!(config["sample"]["labels"]["local"], "yes");
        assert!(runtime.configuration_schemas().contains_key("sample"));
    }

    #[tokio::test]
    async fn luau_ci_configuration_deep_merges_before_required_validation() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(rules_root.path().join("sample")).unwrap();
        fs::write(
            rules_root.path().join("sample/index.luau"),
            r#"
local core = require("@imp/core")
core.define_config_schema("sample", {
    mode = core.field.enum({ "fast", "safe" }, { required = true }),
    nested = core.field.object(
        { enabled = core.field.bool({ default = false }) },
        { default = {} }
    ),
})
return {}
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "require('@imp/rules/sample')\nreturn { sample = { mode = 'fast' } }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.ci.luau"),
            "local core = require('@imp/core')\nassert(core.configuration('sample').nested.enabled == false)\nreturn { sample = { nested = { enabled = true } } }\n",
        )
        .unwrap();

        let mut local_runtime =
            LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        local_runtime
            .load_modules_with_ci_overlay(false)
            .await
            .unwrap();
        assert_eq!(
            local_runtime.workspace_config()["sample"]["nested"]["enabled"],
            false
        );

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        runtime.load_modules_with_ci_overlay(true).await.unwrap();
        assert_eq!(
            runtime.workspace_config()["sample"],
            serde_json::json!({ "mode": "fast", "nested": { "enabled": true } })
        );

        fs::write(
            workspace_root.path().join("imp.workspace.ci.luau"),
            "return { sample = { nested = { enabled = 'yes' } } }\n",
        )
        .unwrap();
        let mut invalid_runtime =
            LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let error = format!(
            "{:#}",
            invalid_runtime
                .load_modules_with_ci_overlay(true)
                .await
                .unwrap_err()
        );
        assert!(error.contains("@workspace/imp.workspace.ci"), "{error}");
        assert!(error.contains("sample.nested.enabled"), "{error}");

        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "require('@imp/rules/sample')\nreturn { sample = {} }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.ci.luau"),
            "return { sample = { nested = { enabled = true } } }\n",
        )
        .unwrap();
        let mut missing_required_runtime =
            LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let error = format!(
            "{:#}",
            missing_required_runtime
                .load_modules_with_ci_overlay(true)
                .await
                .unwrap_err()
        );
        assert!(error.contains("@workspace/imp.workspace:"), "{error}");
        assert!(error.contains("sample.mode"), "{error}");
    }

    #[tokio::test]
    async fn luau_configuration_errors_name_source_and_field_path() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return { imp = { unknown_setting = true } }\n",
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let error = format!("{:#}", runtime.load_modules().await.unwrap_err());
        assert!(error.contains("@workspace/imp.workspace"), "{error}");
        assert!(error.contains("imp.unknown_setting"), "{error}");

        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return { imp = { jobs = 'many' } }\n",
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let error = format!("{:#}", runtime.load_modules().await.unwrap_err());
        assert!(error.contains("@workspace/imp.workspace"), "{error}");
        assert!(
            error.contains("config 'imp.jobs' must be an integer"),
            "{error}"
        );
    }

    #[test]
    fn luau_workspace_passthrough_env_entries_reach_action_environment() {
        let state = ConfigurationState {
            values: BTreeMap::from([(
                "imp".to_owned(),
                serde_json::json!({ "passthrough_env": ["IMP_LUAU_CONFIG_TEST=value"] }),
            )]),
            ..ConfigurationState::default()
        };
        let environment = configured_base_env(&state).unwrap();
        assert_eq!(
            environment.get("IMP_LUAU_CONFIG_TEST"),
            Some(&"value".to_owned())
        );
    }

    #[tokio::test]
    async fn luau_workspace_passthrough_env_reaches_sandboxed_actions() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return { imp = { passthrough_env = { 'IMP_LUAU_CONFIG_TEST=value' } } }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local check = core.task({
    run = function(exec)
        exec.action({
            argv = { "sh", "-c", "test \"$IMP_LUAU_CONFIG_TEST\" = value" },
            cache = false,
        })
    end,
})
return { check = check }
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        runtime
            .execute_graph(
                "build",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn luau_task_outputs_flow_through_cas_to_downstream_actions() {
        let workspace_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return {}\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local output = core.output
local producer = core.task({
    outputs = { generated = output.artifact(), directory = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = { "sh", "-c", "mkdir -p generated bundle; printf payload > generated/value.txt; printf bundle > bundle/item" },
            outputs = {
                generated_file = output.file("generated/value.txt"),
                generated_dir = output.directory("bundle"),
            },
        })
        return {
            generated = result.outputs.generated_file,
            directory = result.outputs.generated_dir,
        }
    end,
})
local consumer = core.task({
    inputs = { generated = producer.outputs.generated },
    outputs = { accepted = output.value() },
    run = function(exec, inputs)
        exec.action({
            argv = { "sh", "-c", "test \"$(cat generated/value.txt)\" = payload" },
            inputs = { inputs.generated },
        })
        return { accepted = "payload" }
    end,
})
local final = core.task({
    inputs = { status = consumer.outputs.accepted },
    run = function(_, inputs)
        assert(inputs.status == "payload")
    end,
})
return { final = final }
"#,
        )
        .unwrap();

        let live = crate::spike::load_workspace_with_rules(
            workspace_root.path(),
            crate::loader::RulesSource::discover(),
        )
        .await
        .unwrap();
        let (events, _receiver) = tokio::sync::mpsc::unbounded_channel();
        *live.scheduler.lock().unwrap() = Some(imp_scheduler::Scheduler::new(
            1,
            Arc::new(AtomicBool::new(false)),
            events,
        ));

        crate::spike::execute_goal_live(
            &live,
            workspace_root.path(),
            "build",
            &["//:final".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();

        let luau = live.luau.as_ref().unwrap().borrow();
        assert_eq!(luau.action_count(), 2);
        assert_eq!(luau.task_result_count(), 3);
        let first_cache_hits = luau.cache_hit_count();
        drop(luau);
        assert!(!workspace_root.path().join("generated/value.txt").exists());
        assert!(!workspace_root.path().join("bundle").exists());

        crate::spike::execute_goal_live(
            &live,
            workspace_root.path(),
            "build",
            &["//:final".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        let luau = live.luau.as_ref().unwrap().borrow();
        assert_eq!(luau.action_count(), 4);
        assert!(luau.cache_hit_count() >= first_cache_hits + 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_acquired_tool_handles_stage_in_sandbox_and_apply_action_env() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return {}\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local platform = core.platform_info()
assert(type(platform.os) == "string" and platform.os ~= "")
assert(type(platform.arch) == "string" and platform.arch ~= "")
local output = core.output
local producer = core.task({
    inputs = {
        shell = core.native_tool("sh"),
        mkdir = core.native_tool("mkdir"),
        chmod = core.native_tool("chmod"),
    },
    outputs = { tool = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = {
                "sh", "-c",
                "mkdir -p staged && printf '#!/bin/sh\n[ \"$TOOL_SETTING\" = set ]\n' > staged/fixture-tool && chmod +x staged/fixture-tool",
            },
            outputs = {
                tool = output.directory("staged", {
                    named_cache = { name = "luau-test-tools", key = "fixture-v1" },
                }),
            },
        })
        return { tool = result.outputs.tool }
    end,
})
local path = core.path(producer.outputs.tool)
local tool = core.tool(producer.outputs.tool, {
    name = "fixture-tool",
    bin_dirs = { "." },
})
-- A cache-only tool still mounts its directory, without adding it to PATH.
local data = core.tool(producer.outputs.tool, { name = "fixture-data", bin_dirs = {} })
local consumer = core.task({
    inputs = { tool = tool, path = path, data = data, shell = core.native_tool("sh") },
    run = function(exec, inputs)
        assert(exec.path(inputs.path) == "staged")
        local data_dir = exec.tool_dir(inputs.data)
        assert(string.sub(data_dir, 1, 1) == "/")
        exec.action({
            argv = { "sh", "-c", 'case ":$PATH:" in *"/.imp/tools/fixture-data:"*) exit 1 ;; esac; test -d "$DATA_DIR" && fixture-tool' },
            inputs = { inputs.path },
            env = { TOOL_SETTING = "set", DATA_DIR = data_dir },
        })
    end,
})
return { consume = consumer }
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let exports = runtime
            .evaluate("@workspace/BUILD")
            .await
            .unwrap()
            .as_table()
            .cloned()
            .unwrap();
        let root = exports.get::<LuaAnyUserData>("consume").unwrap();
        runtime.execute_task(&root).await.unwrap();
        assert_eq!(runtime.action_count(), 2);
    }

    #[cfg(unix)]
    #[cfg(unix)]
    #[tokio::test]
    async fn luau_worker_and_cache_details_use_existing_declared_tools() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = rules_tempdir();
        fs::write(workspace.path().join("imp.workspace.luau"), "return {}\n").unwrap();
        fs::write(workspace.path().join("BUILD.luau"), r#"
local core = require("@imp/core")
local output = core.output
local install = core.task({
    inputs = { sh = core.native_tool("sh"), mkdir = core.native_tool("mkdir"), chmod = core.native_tool("chmod"), cat = core.native_tool("cat") },
    outputs = { binary = output.artifact(), data = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = { "sh", "-c", [=[
set -e
mkdir -p binary data
cat > binary/fixture <<'SCRIPT'
#!/bin/sh
case "$1" in
run) printf x >> "$HOME/starts"; printf '%s\n' "$$" > "$HOME/pid"; sleep 3 ;;
status) test -f "$HOME/pid" || exit 1; read -r pid < "$HOME/pid"; kill -0 "$pid" ;;
stats) IFS= read -r value < "$DATA/value" || :; printf %s "$value" ;;
esac
SCRIPT
chmod +x binary/fixture
]=] },
            outputs = {
                binary = output.directory("binary", { named_cache = { name = "luau-worker-fixture", key = "binary", shared = false } }),
                data = output.directory("data", { named_cache = { name = "luau-worker-fixture", key = "data", shared = false } }),
            },
        })
        return { binary = result.outputs.binary, data = result.outputs.data }
    end,
})
local binary = core.tool(install.outputs.binary, { name = "fixture", bin_dirs = { "." } })
local data = core.tool(install.outputs.data, { name = "fixture-data", bin_dirs = { "." } })
local function start(exec, inputs)
    local bin = exec.tool_dir(inputs.binary) .. "/fixture"
    local spec = { argv = { bin, "run" }, health_check_argv = { bin, "status" } }
    local first = exec.worker_start("fixture", spec)
    local second = exec.worker_start("fixture", spec)
    assert(first.home_dir == second.home_dir)
    return first
end
local consume = core.task({
    inputs = { binary = binary, data = data, sh = core.native_tool("sh"), cat = core.native_tool("cat") },
    outputs = { done = output.value() },
    run = function(exec, inputs)
        local worker = start(exec, inputs)
        local dir = exec.tool_dir(inputs.data)
        for _ = 1, 2 do
            exec.action({ argv = { "sh", "-c", 'printf x >> "$DATA/value"; test "$(cat "$STARTS")" = x' }, env = { DATA = dir, STARTS = worker.home_dir .. "/starts" }, cache = false })
        end
        return { done = true }
    end,
})
core.named_cache_details({
    name = "luau-worker-fixture", inputs = { binary = binary, data = data },
    caches = { binary = { name = "luau-worker-fixture", key = "binary", shared = false }, data = { name = "luau-worker-fixture", key = "data", shared = false } },
    run = function(exec, inputs)
        start(exec, inputs)
        local result = exec.action({ argv = { exec.tool_dir(inputs.binary) .. "/fixture", "stats" }, env = { DATA = exec.tool_dir(inputs.data) }, cache = false, allow_failure = true })
        return result.stdout
    end,
})
return { consume = consume }
"#).unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        let exports = runtime
            .evaluate("@workspace/BUILD")
            .await
            .unwrap()
            .as_table()
            .unwrap()
            .clone();
        assert_eq!(
            runtime
                .named_cache_details("luau-worker-fixture")
                .await
                .unwrap(),
            None
        );
        assert_eq!(runtime.action_count(), 0);
        runtime
            .execute_task(&exports.get::<LuaAnyUserData>("consume").unwrap())
            .await
            .unwrap();
        assert_eq!(
            runtime
                .named_cache_details("luau-worker-fixture")
                .await
                .unwrap()
                .as_deref()
                .map(str::trim),
            Some("xx")
        );
        // A fresh runtime has no acquisition results. Statistics must still
        // use the existing directories without executing the install task.
        let mut fresh = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
        fresh.evaluate("@workspace/BUILD").await.unwrap();
        assert_eq!(
            fresh
                .named_cache_details("luau-worker-fixture")
                .await
                .unwrap()
                .as_deref()
                .map(str::trim),
            Some("xx")
        );
        assert_eq!(fresh.action_count(), 1);
        assert_eq!(fresh.task_result_count(), 0);
    }

    #[tokio::test]
    async fn luau_exec_tool_dir_returns_the_absolute_named_cache_directory() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return {}\n",
        )
        .unwrap();
        // A task can return only declared outputs, so the consumer reports
        // the directory in its error message for the test to read. Shared
        // slots outlive the test, and an existing slot is not written again,
        // so each run uses a new key.
        let key = format!(
            "run-{}",
            workspace_root.path().file_name().unwrap().to_string_lossy()
        );
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local output = core.output
local producer = core.task({
    inputs = {
        shell = core.native_tool("sh"),
        mkdir = core.native_tool("mkdir"),
    },
    outputs = { tool = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = { "sh", "-c", "mkdir -p staged/bin && printf 'tool' > staged/bin/fixture-tool" },
            outputs = {
                tool = output.directory("staged", {
                    named_cache = { name = "luau-test-tool-dir", key = "FIXTURE_KEY" },
                }),
            },
        })
        return { tool = result.outputs.tool }
    end,
})
local tool = core.tool(producer.outputs.tool, { name = "fixture-tool", bin_dirs = { "bin" } })
local other = core.native_tool("sh")
local function expect_error(expected, fn, ...)
    local ok, problem = pcall(fn, ...)
    assert(not ok, "expected an error: " .. expected)
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end
local consumer = core.task({
    inputs = { tool = tool, other = other },
    run = function(exec, inputs)
        expect_error("exec.tool_dir(handle) requires a tool handle", exec.tool_dir, inputs.other)
        expect_error("exec.tool_dir(handle) requires a declared task input", exec.tool_dir, producer.outputs.tool)
        error("TOOL_DIR=" .. exec.tool_dir(inputs.tool) .. "=END")
    end,
})
return { consume = consumer }
"#
            .replace("FIXTURE_KEY", &key),
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let exports = runtime
            .evaluate("@workspace/BUILD")
            .await
            .unwrap()
            .as_table()
            .cloned()
            .unwrap();
        let root = exports.get::<LuaAnyUserData>("consume").unwrap();
        let message = format!("{:#}", runtime.execute_task(&root).await.unwrap_err());
        let dir = message
            .split("TOOL_DIR=")
            .nth(1)
            .and_then(|rest| rest.split("=END").next())
            .unwrap_or_else(|| panic!("no tool directory in: {message}"));
        let dir = Path::new(dir);
        assert!(dir.is_absolute(), "{}", dir.display());
        assert!(
            dir.ends_with(format!("shared/luau-test-tool-dir/{key}")),
            "{}",
            dir.display()
        );
        assert_eq!(
            fs::read_to_string(dir.join("bin/fixture-tool")).unwrap(),
            "tool"
        );
    }

    #[tokio::test]
    async fn luau_exec_tool_dir_fakes_return_a_cache_path_and_record_the_call() {
        let (_workspace_root, report) = run_luau_test_module(
            r#"
local core = require("@imp/core")
local output = core.output

local install = core.task({
    outputs = { root = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = { "install" },
            display = "install",
            outputs = {
                root = output.directory("demo", { named_cache = { name = "demo-tools", key = "1.0/linux-x86_64" } }),
            },
        })
        return { root = result.outputs.root }
    end,
})
local tool = core.tool(install.outputs.root, { name = "demo" })
local consumer = core.task({
    inputs = { tool = tool },
    outputs = { dir = output.value() },
    run = function(exec, inputs)
        return { dir = exec.tool_dir(inputs.tool) }
    end,
})

return {
    core.test.case("toolchain host", function()
        core.test.with_fake_toolchain_host(function(host)
            assert(core.test.resolve(consumer.outputs.dir) == "/cache/demo-tools/1.0/linux-x86_64")
            local call = host.calls[#host.calls]
            assert(call[1] == "tool_dir" and call[2] == "demo-tools" and call[3] == "1.0/linux-x86_64")
        end)
    end),
    core.test.case("run fake", function()
        core.test.with_fake_run(function()
            assert(core.test.resolve(consumer.outputs.dir) == "/cache/demo-tools/1.0/linux-x86_64")
        end)
    end),
}
"#,
        )
        .await;
        let report = report.unwrap().unwrap();
        assert!(report.contains("test: 2/2 unit(s) passed"), "{report}");
    }

    #[tokio::test]
    async fn luau_tool_and_path_handles_keep_package_owner_and_stable_identity() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("pkg")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            r#"
local core = require("@imp/core")
local producer = core.task({
    outputs = { directory = core.output.artifact() },
    run = function() return { directory = nil } end,
})
return {
    path_a = core.path(producer.outputs.directory),
    path_b = core.path(producer.outputs.directory),
    tool_a = core.tool(producer.outputs.directory, { name = "sample" }),
    tool_b = core.tool(producer.outputs.directory, { name = "sample" }),
}
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let exports = runtime
            .evaluate("@workspace/pkg/BUILD")
            .await
            .unwrap()
            .as_table()
            .cloned()
            .unwrap();
        let path_a = exports.get::<LuaAnyUserData>("path_a").unwrap();
        let path_b = exports.get::<LuaAnyUserData>("path_b").unwrap();
        let tool_a = exports.get::<LuaAnyUserData>("tool_a").unwrap();
        let tool_b = exports.get::<LuaAnyUserData>("tool_b").unwrap();
        let path_a = path_a.borrow::<GraphHandle>().unwrap().id;
        let path_b = path_b.borrow::<GraphHandle>().unwrap().id;
        let tool_a = tool_a.borrow::<GraphHandle>().unwrap().id;
        let tool_b = tool_b.borrow::<GraphHandle>().unwrap().id;
        assert_eq!(path_a, path_b);
        assert_eq!(tool_a, tool_b);
        match runtime.host.borrow().nodes.get(&path_a).unwrap() {
            GraphNode::Path { owner_package, .. } => assert_eq!(owner_package, "pkg"),
            _ => panic!("expected path node"),
        }
        match runtime.host.borrow().nodes.get(&tool_a).unwrap() {
            GraphNode::Tool { owner_package, .. } => assert_eq!(owner_package, "pkg"),
            _ => panic!("expected tool node"),
        };
    }

    #[tokio::test]
    async fn workspace_discovers_root_and_nested_build_modules_by_canonical_address() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("pkg")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/shared.luau"),
            "return { name = 'shared' }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local first = require("@workspace/pkg/shared")
local same_module = require("@workspace/pkg/shared.luau")
assert(first == same_module)
return { root_task = core.task({ run = function() end }) }
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local shared = require("./shared")
assert(shared.name == "shared")
return { nested_task = core.task({ run = function() end }) }
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();

        let mut addresses = roots
            .into_iter()
            .map(|root| root.address)
            .collect::<Vec<_>>();
        addresses.sort();
        assert_eq!(addresses, ["//:root_task", "//pkg:nested_task"]);
    }

    #[tokio::test]
    async fn workspace_effects_require_a_goal_callback() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        let digest = captured_tree(&[("file.txt", "published\n")]);
        let checks = format!(
            r#"
local core = require("@imp/core")
local function rejects(fn, expected)
    local ok, problem = pcall(fn)
    assert(not ok, "expected a goal boundary error")
    assert(string.find(tostring(problem), expected, 1, true), tostring(problem))
end
local function check_boundary()
    for _, check in ipairs({{ false, true }}) do
        rejects(function() core.generate_build(check) end,
            "core.generate_build() can only run in a goal callback")
    end
    rejects(function() core.write_workspace("published.txt", "{digest}", {{ from = "file.txt" }}) end,
        "core.write_workspace() can only run in a goal callback")
end
"#
        );
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            format!(
                r#"{checks}
core.define_config_schema("sample", {{ build_generate = core.field.bool({{ default = true }}) }})
core.register_build_generator({{
    namespace = "sample",
    generate = function() error("generator must not run outside a goal") end,
}})
check_boundary()
core.goal("probe", function()
    core.write_workspace("published.txt", "{digest}", {{ from = "file.txt" }})
    if core.goal_flags().fail then error("callback failed") end
end, {{ selection = "none", flags = {{ fail = {{}} }} }})
core.goal("root", function() end)
return {{ sample = {{ build_generate = true }} }}
"#
            ),
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            format!(
                r#"{checks}
check_boundary()
return {{ probe = {{ ROOT = core.task({{ run = function() check_boundary() end }}) }} }}
"#
            ),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        execute_workflow(
            &mut runtime,
            &roots,
            "root",
            &["//:probe"],
            serde_json::json!({}),
            &[],
        )
        .await
        .unwrap();
        assert!(!workspace_root.path().join("published.txt").exists());
        for fail in [false, true] {
            let result = runtime
                .execute_graph(
                    "probe",
                    &[],
                    Arc::new(AtomicBool::new(false)),
                    &serde_json::json!({ "fail": fail }),
                    &[],
                )
                .await;
            if fail {
                let error = result.unwrap_err();
                assert!(
                    format!("{error:#}").contains("callback failed"),
                    "{error:#}"
                );
            } else {
                result.unwrap();
            }
            assert_eq!(
                fs::read_to_string(workspace_root.path().join("published.txt")).unwrap(),
                "published\n"
            );
            runtime
                .run_script_value(
                    "@imp/boundary-check",
                    &format!("{checks}\ncheck_boundary()"),
                )
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn build_generator_selection_runs_inside_the_goal_callback() {
        for setting in [None, Some(false), Some(true)] {
            let workspace_root = tempfile::tempdir().unwrap();
            let rules_root = rules_tempdir();
            let config = setting
                .map(|enabled| {
                    format!("core.configure(\"sample\", {{ build_generate = {enabled} }})")
                })
                .unwrap_or_default();
            fs::write(
                workspace_root.path().join("imp.workspace.luau"),
                format!(
                    r#"
local core = require("@imp/core")
require("@imp/rules/workflows/generate_build")
core.define_config_schema("sample", {{ build_generate = core.field.bool({{ default = false }}) }})
core.register_build_generator({{
    namespace = "sample",
    generate = function() error("enabled generator ran") end,
}})
{config}
return {{}}
"#
                ),
            )
            .unwrap();
            let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
            runtime.load_modules().await.unwrap();
            let result = generate_build(&mut runtime, true).await;
            if setting == Some(true) {
                let error = result.unwrap_err();
                assert!(
                    format!("{error:#}").contains("enabled generator ran"),
                    "{error:#}"
                );
            } else {
                assert_eq!(
                    result.unwrap().as_deref(),
                    Some("generate-build: 0 file(s) checked, 0 out of date")
                );
            }
        }
    }

    /// Run the selectorless `generate-build` goal of a loaded workspace.
    async fn generate_build(runtime: &mut LuauWorkspace, check: bool) -> Result<Option<String>> {
        runtime
            .execute_graph(
                "generate-build",
                &[],
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({ "check": check }),
                &[],
            )
            .await
    }

    #[tokio::test]
    async fn luau_build_generators_merge_targets_write_and_check_native_build_files() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/generate_build")
core.define_config_schema("sample", {
    build_generate = core.field.bool({ default = false }),
})
core.register_build_rule({
    rule = "sample",
    module = "@imp/rules/sample",
    export = "sample",
})
core.register_build_generator({
    namespace = "sample",
    generate = function()
        return {
            ["generated/BUILD.luau"] = {
                { name = "first", rule = "sample", props = { value = 1 } },
            },
        }
    end,
})
core.register_build_generator({
    namespace = "sample",
            generate = function()
                return {
                    ["generated/BUILD.luau"] = {
                        { name = "second", rule = "sample" },
                    },
                }
    end,
})
return { sample = { build_generate = true } }
"#,
        )
        .unwrap();
        fs::write(
            rules_root.path().join("sample.luau"),
            r#"
local core = require("@imp/core")
return {
    sample = function(_props)
        return core.task({ run = function() end })
    end,
}
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        runtime.load_modules().await.unwrap();
        let report = generate_build(&mut runtime, false).await.unwrap().unwrap();
        assert!(report.contains("1 file(s) written"), "{report}");
        let generated =
            fs::read_to_string(workspace_root.path().join("generated/BUILD.luau")).unwrap();
        assert!(generated.contains("first = __imp_rule_0.sample"));
        assert!(generated.contains("second = __imp_rule_0.sample"));
        assert!(generated.contains("second = __imp_rule_0.sample({})"));
        let report = generate_build(&mut runtime, true).await.unwrap().unwrap();
        assert!(
            report.contains("1 file(s) checked, 0 out of date"),
            "{report}"
        );

        let mut discovered = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = discovered.load_modules().await.unwrap();
        assert!(roots.iter().any(|root| root.address == "//generated:first"));
        assert!(roots
            .iter()
            .any(|root| root.address == "//generated:second"));

        let path = workspace_root.path().join("generated/BUILD.luau");
        fs::write(&path, "return { hand_written = true }\n").unwrap();
        let error = generate_build(&mut runtime, true).await.unwrap_err();
        assert!(
            format!("{error:#}")
                .contains("generated BUILD files are out of date: generated/BUILD.luau"),
            "{error:#}"
        );
        assert!(generate_build(&mut runtime, false).await.is_err());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "return { hand_written = true }\n"
        );
    }

    #[tokio::test]
    async fn luau_build_generator_resolves_value_outputs_and_rejects_other_handles() {
        for (body, expected) in [
            (r#"return core.task({
                inputs = { source = core.task({ outputs = { value = core.output.value() }, run = function() return { value = 7 } end }).outputs.value },
                outputs = { declarations = core.output.value() },
                run = function(_exec, input)
                    assert(input.source == 7)
                    return { declarations = { ["generated/BUILD.luau"] = { { name = "generated", rule = "sample" } } } }
                end,
            }).outputs.declarations"#, "1 file(s) written"),
            ("return core.native_tool('sh')", "task value-output handle"),
            ("return core.task({ run = function() end })", "task value-output handle"),
            ("return core.task({ outputs = { file = core.output.artifact() }, run = function() error('must not execute') end }).outputs.file", "task value-output handle"),
            ("return core.task({ outputs = { value = core.output.value() }, run = function() error('metadata failed') end }).outputs.value", "metadata failed"),
            ("return core.task({ outputs = { value = core.output.value() }, run = function() return { value = 42 } end }).outputs.value", "must produce a declaration table"),
        ] {
            let workspace = tempfile::tempdir().unwrap();
            let rules = rules_tempdir();
            fs::write(rules.path().join("sample.luau"), "return { sample = function() return {} end }").unwrap();
            fs::write(workspace.path().join("imp.workspace.luau"), format!(r#"
local core = require("@imp/core")
require("@imp/rules/workflows/generate_build")
core.define_config_schema("sample", {{ build_generate = core.field.bool({{ default = false }}) }})
core.register_build_rule({{ rule = "sample", module = "@imp/rules/sample" }})
core.register_build_generator({{ namespace = "sample", generate = function() {body} end }})
return {{ sample = {{ build_generate = true }} }}
"#)).unwrap();
            let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
            runtime.load_modules().await.unwrap();
            let result = generate_build(&mut runtime, false).await;
            let text = match result { Ok(report) => report.unwrap_or_default(), Err(error) => format!("{error:#}") };
            assert!(text.contains(expected), "expected {expected}: {text}");
            if expected == "1 file(s) written" {
                let report = generate_build(&mut runtime, true).await.unwrap().unwrap();
                assert!(report.contains("0 out of date"), "{report}");
                let mut reloaded = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
                reloaded.load_modules().await.unwrap();
            } else {
                assert!(!workspace.path().join("generated/BUILD.luau").exists());
            }
        }
    }

    #[tokio::test]
    async fn luau_rust_generator_uses_declared_metadata_tasks_and_skips_owned_manifests() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = crate::loader::RulesSource::discover();
        let rules = rules.root().unwrap();
        for package in ["app", "owned", "vendor/ignored"] {
            let path = workspace.path().join(package);
            fs::create_dir_all(path.join("src")).unwrap();
            fs::write(
                path.join("Cargo.toml"),
                "[package]\nname = 'app'\nversion = '0.1.0'\n",
            )
            .unwrap();
            fs::write(path.join("src/main.rs"), "fn main() {}\n").unwrap();
        }
        fs::write(
            workspace.path().join("imp.workspace.luau"),
            r#"
require("@imp/rules/rust/generate_build")
return {}
"#,
        )
        .unwrap();
        fs::write(
            workspace.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")
return { tests = { [test.TEST] = core.test_root() } }
"#,
        )
        .unwrap();
        fs::write(workspace.path().join("generator.test.luau"), r#"
local core = require("@imp/core")
local rust = require("@imp/rules/rust")
local generator = require("@imp/rules/rust/generate_build")
return { core.test.case("metadata tasks", function()
    core.test.with_fake_toolchain_host(function(host)
        rust.cargo_package({ path = "owned", bin = "app" })
        host.set_run_stdout("cargo metadata (generate-build) app/Cargo.toml", '{"workspace_root":"/sandbox/app","packages":[{"name":"app","manifest_path":"/sandbox/app/Cargo.toml","targets":[{"name":"app","kind":["bin"]}]}]}')
        local declarations = core.test.resolve(generator.generate_build())
        assert(declarations["app/BUILD.luau"][1].props.bin == "app")
        assert(declarations["owned/BUILD.luau"] == nil and declarations["vendor/ignored/BUILD.luau"] == nil)
        local metadata_runs = 0
        for _, action in ipairs(host.runs) do
            if action.display == "cargo metadata (generate-build) app/Cargo.toml" then
                metadata_runs += 1
                assert(action.input_count == 1 and action.env.CARGO_HOME and action.env.RUSTUP_HOME)
                assert(table.find(action.tools, "rustup-home") and table.find(action.tools, "cargo-home"))
            end
        end
        assert(metadata_runs == 1)
    end)
end) }
"#).unwrap();
        let mut runtime = LuauWorkspace::new(workspace.path(), rules).unwrap();
        let roots = runtime.load_modules().await.unwrap();
        let report = runtime
            .execute_graph(
                "test",
                &roots,
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap()
            .unwrap();
        assert!(report.contains("1/1 unit(s) passed"), "{report}");
        // The configuration default must keep the registered generator idle.
        runtime
            .evaluate("@imp/rules/workflows/generate_build")
            .await
            .unwrap();
        assert!(generate_build(&mut runtime, false).await.unwrap().is_none());
        assert!(!workspace.path().join("app/BUILD.luau").exists());
    }

    #[tokio::test]
    async fn luau_build_generator_discovers_unowned_workspace_files() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        for directory in [
            "crates/a",
            "crates/z",
            "crates/owned",
            "crates/ignored",
            "crates/vendor/vendor_crate",
        ] {
            fs::create_dir_all(workspace_root.path().join(directory)).unwrap();
            fs::write(
                workspace_root.path().join(directory).join("Cargo.toml"),
                "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
            )
            .unwrap();
        }
        fs::write(
            workspace_root.path().join(".gitignore"),
            "crates/ignored/\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/generate_build")
core.define_config_schema("rust", {
    build_generate = core.field.bool({ default = false }),
})
core.register_build_rule({
    rule = "cargoPackage",
    module = "@imp/rules/rust",
    export = "cargo_package",
})
core.register_build_generator({
    namespace = "rust",
    generate = function()
        local ok, message = pcall(function()
            core.all_unowned({ root = ".", include = {} })
        end)
        assert(not ok)
        assert(string.find(tostring(message), "all_unowned({ include }) requires glob patterns", 1, true))
        local manifests = core.all_unowned({
            root = "crates",
            include = { "**/Cargo.toml" },
            exclude = { "**/vendor/**" },
        })
        assert(#manifests == 2)
        assert(manifests[1] == "crates/a/Cargo.toml")
        assert(manifests[2] == "crates/z/Cargo.toml")
        local files = {}
        for _, manifest in ipairs(manifests) do
            local directory = string.match(manifest, "^(.*)/[^/]+$")
            local name = string.gsub(directory, "[^%w_$]", "_")
            files[directory .. "/BUILD.luau"] = {
                { name = name, rule = "cargoPackage", props = { manifest = manifest } },
            }
        end
        return files
    end,
})
return { rust = { build_generate = true } }
"#,
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
local owned_manifests = core.files({
    root = ".",
    include = { "crates/owned/Cargo.toml" },
})
return {
    owned = core.task({
        inputs = { source_sets = { owned_manifests } },
        run = function() end,
    }),
}
"#,
        )
        .unwrap();
        fs::write(
            rules_root.path().join("rust.luau"),
            r#"
local core = require("@imp/core")
return {
    cargo_package = function(_props)
        return core.task({ run = function() end })
    end,
}
"#,
        )
        .unwrap();

        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        runtime.load_modules().await.unwrap();
        generate_build(&mut runtime, false).await.unwrap();

        let generated_a =
            fs::read_to_string(workspace_root.path().join("crates/a/BUILD.luau")).unwrap();
        let generated_z =
            fs::read_to_string(workspace_root.path().join("crates/z/BUILD.luau")).unwrap();
        assert!(generated_a.contains("manifest = \"crates/a/Cargo.toml\""));
        assert!(generated_z.contains("manifest = \"crates/z/Cargo.toml\""));
        assert!(!workspace_root
            .path()
            .join("crates/owned/BUILD.luau")
            .exists());
        assert!(!workspace_root
            .path()
            .join("crates/ignored/BUILD.luau")
            .exists());
        assert!(!workspace_root
            .path()
            .join("crates/vendor/vendor_crate/BUILD.luau")
            .exists());
    }

    #[tokio::test]
    async fn luau_task_options_validate_and_apply_exec_options() {
        let (_, report) = run_luau_test_module(r#"
local core = require("@imp/core")
return { core.test.case("task options", function()
    local function rejects(options, expected)
        options.run = function() end
        local ok, message = pcall(core.task, options)
        assert(not ok, expected)
        assert(string.find(tostring(message), expected, 1, true), tostring(message))
    end
    rejects({ typo = true }, "task options do not accept 'typo'")
    rejects({ [1] = true }, "task options require string keys")
    rejects({ [true] = true }, "task options require string keys")
    for _, value in ipairs({ false, 42, {}, function() end }) do
        rejects({ display = value }, "task.display must be a string")
    end
    for _, value in ipairs({ "false", 0, {}, function() end }) do
        rejects({ cache = value }, "task.cache must be a boolean")
    end
    core.test.with_fake_run(function(host)
        local requests = {
            { argv = { "unused", "argument" } },
            { argv = { "unused" }, display = "explicit", cache = true },
            { argv = { "unused" }, display = "", cache = false },
        }
        for _, task_cache in ipairs({ true, false }) do
            local calls = 0
            local task = core.task({
                display = "task label", cache = task_cache,
                outputs = { first = core.output.value(), second = core.output.value() },
                run = function(exec)
                    calls += 1
                    for _, request in ipairs(requests) do exec.action(request) end
                    return { first = calls, second = calls }
                end,
            })
            assert(core.test.resolve(task.outputs.first) == 1)
            assert(core.test.resolve(task.outputs.second) == 1)
            assert(calls == 1)
            local offset = #host.runs - 3
            assert(host.runs[offset + 1].display == "task label")
            assert(host.runs[offset + 2].display == "explicit")
            assert(host.runs[offset + 3].display == "")
            assert(host.runs[offset + 1].cache == task_cache)
            assert(host.runs[offset + 2].cache == task_cache)
            assert(host.runs[offset + 3].cache == false)
        end
        assert(requests[1].display == nil and requests[1].cache == nil)
        assert(requests[2].cache == true)
        local dependency = core.task({ run = function(exec) exec.action(requests[1]) end })
        local parent = core.task({ cache = false, display = "parent", inputs = { dependency = dependency },
            run = function(exec) exec.action(requests[1]) end })
        core.test.resolve(parent)
        assert(host.runs[#host.runs - 1].display == "unused argument")
        assert(host.runs[#host.runs - 1].cache == true)
        assert(host.runs[#host.runs].display == "parent")
        assert(host.runs[#host.runs].cache == false)
        core.test.resolve(core.task({ display = "", run = function(exec) exec.action(requests[1]) end }))
        assert(host.runs[#host.runs].display == "")
    end)
end) }
"#).await;
        assert!(report
            .unwrap()
            .unwrap()
            .contains("test: 1/1 unit(s) passed"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn luau_task_options_control_real_action_cache_across_invocations() {
        for cache in [true, false] {
            let workspace = tempfile::tempdir().unwrap();
            let rules = rules_tempdir();
            let unique = workspace.path().to_string_lossy();
            fs::write(
                workspace.path().join("task.luau"),
                format!(
                    r#"
local core = require("@imp/core")
return core.task({{
    cache = {cache}, display = "task cache test",
    inputs = {{ sh = core.native_tool("sh") }},
    outputs = {{ digest = core.output.value() }},
    run = function(exec)
        local result = exec.action({{
            argv = {{ "sh", "-c", "printf payload > result.txt", "{unique}" }},
            cache = true,
            outputs = {{ file = core.output.file("result.txt") }},
        }})
        return {{ digest = exec.digest(result.outputs.file) }}
    end,
}})
"#
                ),
            )
            .unwrap();
            let mut digests = Vec::new();
            for invocation in 0..2 {
                let mut runtime = LuauWorkspace::new(workspace.path(), rules.path()).unwrap();
                let LuaValue::UserData(task) = runtime.evaluate("@workspace/task").await.unwrap()
                else {
                    panic!("expected task");
                };
                runtime.execute_task(&task).await.unwrap();
                assert_eq!(runtime.action_count(), 1);
                assert_eq!(
                    runtime.cache_hit_count(),
                    usize::from(cache && invocation == 1)
                );
                let results = runtime.host.borrow();
                let output = results.task_results.values().next().unwrap();
                digests.push(output.get::<String>("digest").unwrap());
            }
            assert_eq!(digests[0], digests[1]);
            assert!(!workspace.path().join("result.txt").exists());
        }
    }

    #[tokio::test]
    async fn luau_task_output_declarations_reject_action_output_descriptors() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("bad.luau"),
            r#"
local core = require("@imp/core")
local ok, message = pcall(function()
    core.task({
    outputs = { result = core.output.file("result.txt") },
    run = function() end,
})
end)
assert(not ok)
assert(string.find(tostring(message), "task.outputs.result must be output.value() or output.artifact()", 1, true))
return {}
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();

        runtime.evaluate("@workspace/bad").await.unwrap();
    }

    #[tokio::test]
    async fn task_run_that_catches_a_failed_action_does_not_fail() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("recovered.luau"),
            r#"
local core = require("@imp/core")
return core.task({
    run = function(exec)
        local ok = pcall(exec.action, {
            argv = { "sh", "-c", "exit 3" },
            outputs = { out = core.output.file("out.txt") },
            cache = false,
        })
        assert(not ok)
    end,
})
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let LuaValue::UserData(handle) = runtime.evaluate("@workspace/recovered").await.unwrap()
        else {
            panic!("test module must return a task handle");
        };
        runtime.execute_task(&handle).await.unwrap();
    }

    #[tokio::test]
    async fn task_run_error_after_a_caught_action_failure_is_the_reported_error() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        let failing_task = |decorate: &str| {
            format!(
                r#"
local core = require("@imp/core")
return core.task({{
    run = function(exec)
        local ok, err = pcall(exec.action, {{
            argv = {{ "sh", "-c", "exit 3" }},
            outputs = {{ out = core.output.file("out.txt") }},
            cache = false,
        }})
        assert(not ok)
        {decorate}
    end,
}})
"#
            )
        };
        fs::write(
            workspace_root.path().join("decorated.luau"),
            failing_task(r#"error("RULE HINT: " .. tostring(err), 0)"#),
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("rethrown.luau"),
            failing_task("error(err, 0)"),
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        for (module, expected) in [
            ("@workspace/decorated", "RULE HINT: "),
            ("@workspace/rethrown", "failed with exit code 3"),
        ] {
            let LuaValue::UserData(handle) = runtime.evaluate(module).await.unwrap() else {
                panic!("test module must return a task handle");
            };
            let error = runtime.execute_task(&handle).await.unwrap_err();
            assert!(
                format!("{error:#}").contains(expected),
                "{module}: {error:#}"
            );
        }
    }

    #[tokio::test]
    async fn read_file_reads_namespaced_files_and_decodes_json() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::create_dir_all(workspace_root.path().join("tools")).unwrap();
        fs::write(
            workspace_root.path().join("tools/pins.json"),
            r#"{ "tool": "x", "list": [1, 2], "none": null }"#,
        )
        .unwrap();
        fs::write(rules_root.path().join("shipped.lock"), "shipped\n").unwrap();
        fs::write(
            workspace_root.path().join("probe.luau"),
            r#"
local core = require("@imp/core")
local text = core.read_file("@workspace/tools/pins.json")
local pins = core.json_decode(text)
assert(pins.tool == "x")
assert(#pins.list == 2 and pins.list[2] == 2)
assert(pins.none == nil)
assert(core.read_file("@imp/rules/shipped.lock") == "shipped\n")
assert(core.read_file("@workspace/tools/missing.json") == nil)
local function failure(fn, ...)
    local ok, message = pcall(fn, ...)
    assert(not ok)
    return tostring(message)
end
assert(string.find(failure(core.read_file, "@workspace/../outside"), "escapes its namespace root", 1, true))
assert(string.find(failure(core.read_file, "//tools/pins.json"), "requires an @imp/rules/ or @workspace/ address", 1, true))
assert(string.find(failure(core.json_decode, "{"), "core.json_decode", 1, true))
return {}
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        runtime.evaluate("@workspace/probe").await.unwrap();
    }

    #[tokio::test]
    async fn goal_selection_option_accepts_only_none() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("probe.luau"),
            r#"
local core = require("@imp/core")
local ok, message = pcall(core.goal, "probe-bad", function() end, { selection = "all" })
assert(not ok)
assert(string.find(tostring(message), "selection must be \"none\"", 1, true))
core.goal("probe-none", function(roots)
    assert(#roots == 0)
    return "ran with no roots"
end, { selection = "none" })
return {}
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        runtime.evaluate("@workspace/probe").await.unwrap();
        assert!(runtime.goal_definitions()["probe-none"].selectorless);
        let report = runtime
            .execute_graph(
                "probe-none",
                &[],
                Arc::new(AtomicBool::new(false)),
                &serde_json::json!({}),
                &[],
            )
            .await
            .unwrap();
        assert_eq!(report.as_deref(), Some("ran with no roots"));
    }

    #[tokio::test]
    async fn action_output_names_follow_graph_slot_rules() {
        let error = execute_luau_task_source(
            r#"
local core = require("@imp/core")
return core.task({
    run = function(exec)
        exec.action({
            argv = { "sh", "-c", "true" },
            outputs = { ["bad name"] = core.output.file("output.txt") },
        })
    end,
})
"#,
        )
        .await;

        assert!(format!("{error:#}").contains("exec.action().outputs has invalid name 'bad name'"));
    }

    #[tokio::test]
    async fn action_outputs_reject_duplicate_paths() {
        let error = execute_luau_task_source(
            r#"
local core = require("@imp/core")
return core.task({
    run = function(exec)
        exec.action({
            argv = { "sh", "-c", "true" },
            outputs = {
                first = core.output.file("same.txt"),
                second = core.output.file("same.txt"),
            },
        })
    end,
})
"#,
        )
        .await;

        assert!(format!("{error:#}").contains("exec.action declares output path 'same.txt' twice"));
    }

    #[tokio::test]
    async fn failed_luau_output_producer_does_not_run_its_consumer() {
        let workspace_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return {}\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local output = core.output
local producer = core.task({
    outputs = { artifact = output.artifact() },
    run = function(exec)
        local result = exec.action({
            argv = { "sh", "-c", "exit 7" },
            outputs = { file = output.file("failed.txt") },
        })
        return { artifact = result.outputs.file }
    end,
})
local consumer = core.task({
    inputs = { artifact = producer.outputs.artifact },
    run = function(exec, inputs)
        exec.action({ argv = { "sh", "-c", "true" }, inputs = { inputs.artifact } })
    end,
})
return { consumer = consumer }
"#,
        )
        .unwrap();

        let live = crate::spike::load_workspace_with_rules(
            workspace_root.path(),
            crate::loader::RulesSource::discover(),
        )
        .await
        .unwrap();
        let (events, _receiver) = tokio::sync::mpsc::unbounded_channel();
        *live.scheduler.lock().unwrap() = Some(imp_scheduler::Scheduler::new(
            1,
            Arc::new(AtomicBool::new(false)),
            events,
        ));

        let error = crate::spike::execute_goal_live(
            &live,
            workspace_root.path(),
            "build",
            &["//:consumer".to_owned()],
            false,
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap_err();

        assert!(format!("{error:#}").contains("exit code 7"), "{error:#}");
        let luau = live.luau.as_ref().unwrap().borrow();
        assert_eq!(luau.action_count(), 0);
        assert_eq!(luau.task_result_count(), 0);
    }

    #[tokio::test]
    async fn cyclic_module_imports_fail_with_the_cycle_addresses() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("a.luau"),
            "require('@workspace/b')\nreturn {}\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("b.luau"),
            "require('@workspace/a')\nreturn {}\n",
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();

        let error = runtime.evaluate("@workspace/a").await.unwrap_err();

        assert!(error.to_string().contains("cyclic Luau module import"));
        assert!(error.to_string().contains("@workspace/a"));
        assert!(error.to_string().contains("@workspace/b"));
    }

    #[tokio::test]
    async fn workspace_modules_preserve_luau_local_shadowing_semantics() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("bindings.luau"),
            r#"
local binding = "first"
local binding = "second"

local nested = "outer"
do
    local nested = "inner"
    assert(nested == "inner")
end

return { binding = binding, nested = nested }
"#,
        )
        .unwrap();
        let mut runtime = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();

        let exports = runtime
            .evaluate("@workspace/bindings")
            .await
            .unwrap()
            .as_table()
            .cloned()
            .unwrap();

        assert_eq!(exports.get::<String>("binding").unwrap(), "second");
        assert_eq!(exports.get::<String>("nested").unwrap(), "outer");
    }

    #[tokio::test]
    async fn canceled_luau_actions_stop_through_the_goal_scheduler() {
        let workspace_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return {}\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
local shell = core.native_tool("sh")
return {
    slow = core.task({
        inputs = { shell = shell },
        run = function(exec)
            return exec.action({ argv = { "sh", "-c", "while :; do :; done" }, cache = false })
        end,
    }),
}
"#,
        )
        .unwrap();
        let live = crate::spike::load_workspace_with_rules(
            workspace_root.path(),
            crate::loader::RulesSource::discover(),
        )
        .await
        .unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let (events, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = imp_scheduler::Scheduler::new(1, Arc::clone(&cancellation), events);
        *live.scheduler.lock().unwrap() = Some(scheduler);

        let selectors = ["//:slow".to_owned()];
        let execution = crate::spike::execute_goal_live(
            &live,
            workspace_root.path(),
            "build",
            &selectors,
            false,
            1,
            serde_json::json!({}),
        );
        tokio::pin!(execution);
        tokio::select! {
            result = &mut execution => panic!("action returned before cancellation: {result:?}"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                cancellation.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let error = execution.await.unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("cancel"),
            "{error:#}"
        );
    }

    #[test]
    fn resolver_rejects_paths_that_escape_their_namespace() {
        let root = tempfile::tempdir().unwrap();
        let loader = ModuleLoader {
            workspace_root: root.path().to_path_buf(),
            rules_root: root.path().to_path_buf(),
            stack: Rc::new(RefCell::new(Vec::new())),
            cache: Rc::new(RefCell::new(HashMap::new())),
            failure: Rc::new(RefCell::new(None)),
        };
        let error = resolve_address(&loader, "@workspace/../outside", None).unwrap_err();
        assert!(error.to_string().contains("escapes its namespace root"));
    }

    #[test]
    fn resolver_maps_generated_build_names_to_one_canonical_module() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("pkg")).unwrap();
        fs::write(workspace.path().join("pkg/BUILD.luau"), "return {}\n").unwrap();
        let loader = ModuleLoader {
            workspace_root: workspace.path().to_path_buf(),
            rules_root: rules.path().to_path_buf(),
            stack: Rc::new(RefCell::new(Vec::new())),
            cache: Rc::new(RefCell::new(HashMap::new())),
            failure: Rc::new(RefCell::new(None)),
        };

        let generated_name = resolve_address(&loader, "@workspace/pkg", None).unwrap();
        let explicit_build = resolve_address(&loader, "@workspace/pkg/BUILD.luau", None).unwrap();

        assert_eq!(generated_name.0, workspace.path().join("pkg/BUILD.luau"));
        assert_eq!(generated_name, explicit_build);
        assert_eq!(generated_name.1, "@workspace/pkg/BUILD");
    }

    #[test]
    fn resolver_reports_missing_workspace_modules_and_keeps_rule_ownership() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("rules/sample")).unwrap();
        fs::write(
            workspace.path().join("rules/sample/index.luau"),
            "return { owner = 'workspace' }\n",
        )
        .unwrap();
        let loader = ModuleLoader {
            workspace_root: workspace.path().to_path_buf(),
            rules_root: rules.path().to_path_buf(),
            stack: Rc::new(RefCell::new(Vec::new())),
            cache: Rc::new(RefCell::new(HashMap::new())),
            failure: Rc::new(RefCell::new(None)),
        };

        let missing = resolve_address(&loader, "@workspace/missing", None).unwrap_err();
        let missing_rule = resolve_address(&loader, "@imp/rules/sample", None).unwrap_err();

        assert!(missing.to_string().contains("@workspace/missing"));
        assert!(missing
            .to_string()
            .contains(&workspace.path().display().to_string()));
        assert!(missing_rule.to_string().contains("@imp/rules/sample"));
        assert!(missing_rule
            .to_string()
            .contains(&rules.path().display().to_string()));
    }

    #[test]
    fn generated_build_paths_must_stay_in_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(generated_build_destination(workspace.path(), "pkg/BUILD.luau").is_ok());
        assert!(generated_build_destination(workspace.path(), "../outside/BUILD.luau").is_err());
        assert!(generated_build_destination(workspace.path(), "pkg/not-a-build.luau").is_err());
    }

    #[test]
    fn generated_build_identifiers_reject_luau_keywords() {
        assert!(!is_luau_identifier("end"));
        assert!(!is_luau_identifier("local"));
        assert!(is_luau_identifier("asset_rule"));
    }

    #[test]
    fn relative_imports_keep_their_file_backed_namespace() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = tempfile::tempdir().unwrap();
        fs::create_dir_all(rules.path().join("asset")).unwrap();
        fs::create_dir_all(rules.path().join("native-tool")).unwrap();
        fs::write(rules.path().join("asset/index.luau"), "return {}\n").unwrap();
        fs::write(rules.path().join("native-tool/index.luau"), "return {}\n").unwrap();
        let loader = ModuleLoader {
            workspace_root: workspace.path().to_path_buf(),
            rules_root: rules.path().to_path_buf(),
            stack: Rc::new(RefCell::new(Vec::new())),
            cache: Rc::new(RefCell::new(HashMap::new())),
            failure: Rc::new(RefCell::new(None)),
        };

        let (path, address) =
            resolve_address(&loader, "../native-tool", Some("@imp/rules/asset/index")).unwrap();

        assert_eq!(path, rules.path().join("native-tool/index.luau"));
        assert_eq!(address, "@imp/rules/native-tool/index");
    }

    #[cfg(unix)]
    #[test]
    fn resolver_rejects_symlinks_that_escape_their_namespace() {
        let workspace = tempfile::tempdir().unwrap();
        let rules = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.luau"), "return {}\n").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.luau"),
            workspace.path().join("escape.luau"),
        )
        .unwrap();
        let loader = ModuleLoader {
            workspace_root: dunce::canonicalize(workspace.path()).unwrap(),
            rules_root: dunce::canonicalize(rules.path()).unwrap(),
            stack: Rc::new(RefCell::new(Vec::new())),
            cache: Rc::new(RefCell::new(HashMap::new())),
            failure: Rc::new(RefCell::new(None)),
        };

        let error = resolve_address(&loader, "@workspace/escape", None).unwrap_err();

        assert!(error.to_string().contains("outside its namespace root"));
    }

    #[test]
    fn config_overlay_deep_merges_objects_and_replaces_values() {
        let mut config = serde_json::json!({
            "jobs": 2,
            "logging": { "level": "info", "json": false },
        });
        merge_config_json(
            &mut config,
            serde_json::json!({
                "logging": { "level": "debug" },
                "jobs": 4,
            }),
        );

        assert_eq!(
            config,
            serde_json::json!({
                "jobs": 4,
                "logging": { "level": "debug", "json": false },
            })
        );
    }
}
