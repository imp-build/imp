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

#[derive(Default)]
struct ConfigurationState {
    schemas: BTreeMap<String, serde_json::Value>,
    values: BTreeMap<String, serde_json::Value>,
    declarations: BTreeMap<String, serde_json::Value>,
    sources: BTreeMap<String, String>,
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
    run: LuaFunction,
    inputs: LuaTable,
    outputs: BTreeMap<String, TaskOutputKind>,
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
    root: String,
    include: Vec<String>,
    exclude: Vec<String>,
}

#[derive(Clone)]
enum GraphNode {
    Files(FileSetSpec),
    NativeTool(String),
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
    next_id: u64,
    next_expansion_id: u64,
    tasks: HashMap<u64, Task>,
    expansions: HashMap<u64, Expansion>,
    expansion_results: HashMap<u64, LuaTable>,
    graph_run_active: bool,
    task_results: HashMap<u64, LuaTable>,
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
    cancellation: Arc<AtomicBool>,
    task_failure: Option<String>,
    test_case_active: bool,
    graph_callback_depth: usize,
    fakes: TestFakes,
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
            next_id: 0,
            next_expansion_id: 0,
            tasks: HashMap::new(),
            expansions: HashMap::new(),
            expansion_results: HashMap::new(),
            graph_run_active: false,
            task_results: HashMap::new(),
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
            cancellation: Arc::new(AtomicBool::new(false)),
            task_failure: None,
            test_case_active: false,
            graph_callback_depth: 0,
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
                install_expansion_executor(lua, bootstrap_host.clone())?;
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
        self.load_modules_with_ci_overlay(std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"))
            .await
    }

    pub fn begin_graph_run(&mut self, cancellation: Arc<AtomicBool>) {
        let mut host = self.host.borrow_mut();
        host.task_results.clear();
        host.expansion_results.clear();
        host.graph_run_active = true;
        host.cancellation = cancellation;
    }

    pub fn expansion_projection_is_all(&self, handle_id: u32) -> Option<bool> {
        match self.host.borrow().nodes.get(&(handle_id as u64)) {
            Some(GraphNode::ExpansionAll { .. }) => Some(true),
            Some(GraphNode::ExpansionGet { .. }) => Some(false),
            _ => None,
        }
    }

    /// Resolve one selected expansion projection to its concrete graph roots.
    /// The expansion callback runs once per graph invocation, after its input
    /// tasks have completed.
    pub async fn resolve_expansion_root(&mut self, root: &GraphRoot) -> Result<Vec<GraphRoot>> {
        let node = self
            .host
            .borrow()
            .nodes
            .get(&(root.handle_id as u64))
            .cloned();
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
        let source = format!("return __imp_discover_expansion({expansion_id})");
        let children_value = self
            .run_script_value("@imp/expand", &source)
            .await
            .with_context(|| format!("discover Luau expansion for {}", root.address))?;
        let children = children_value
            .as_table()
            .cloned()
            .with_context(|| format!("expansion for {} must return a keyed table", root.address))?;
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
                    let valid = match state.nodes.get(&handle_id) {
                        Some(
                            GraphNode::Task
                            | GraphNode::TaskOutput { .. }
                            | GraphNode::ExpansionGet { .. }
                            | GraphNode::ExpansionAll { .. },
                        ) => true,
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

    pub fn has_build_generators(&self) -> bool {
        !self.host.borrow().build_generators.is_empty()
    }

    pub async fn execute_build_generation(&mut self, check: bool) -> Result<()> {
        let source = format!(
            "return require('@imp/core').generate_build({})",
            if check { "true" } else { "false" }
        );
        self.run_script("@imp/generate-build", &source).await
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
                        selectorless: false,
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
        result
    }

    async fn execute_graph_inner(
        &mut self,
        goal: &str,
        roots: &[GraphRoot],
        flags: &serde_json::Value,
    ) -> Result<Option<String>> {
        let callback = self
            .host
            .borrow()
            .goals
            .get(goal)
            .map(|goal| goal.callback.clone())
            .with_context(|| {
                format!(
                    "goal '{goal}' has no registered Luau workflow; require @imp/rules/workflows/{}",
                    goal.replace('-', "_")
                )
            })?;
        // As in JavaScript, a goal with no selected roots does not call its
        // workflow.
        if roots.is_empty() {
            return Ok(None);
        }
        let lua = self.lua()?;
        let case_filter = flags.get("case").and_then(serde_json::Value::as_str);
        let suite_filter = flags.get("suite").and_then(serde_json::Value::as_str);
        let entries = lua.create_table().map_err(lua_err)?;
        let mut test_roots = 0;
        let mut test_units = 0;
        for root in roots {
            let package = match self.host.borrow().nodes.get(&(root.handle_id as u64)) {
                Some(GraphNode::TestRoot { package }) => Some(package.clone()),
                _ => None,
            };
            let result = if let Some(package) = package {
                let units = self
                    .run_test_root(&package, case_filter, suite_filter)
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

    fn lua(&self) -> Result<Lua> {
        self.host
            .borrow()
            .lua
            .as_ref()
            .and_then(mlua::WeakLua::try_upgrade)
            .context("Luau runtime is not initialized")
    }

    async fn run_test_root(
        &self,
        package: &str,
        case_filter: Option<&str>,
        suite_filter: Option<&str>,
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

fn install_task_executor(
    lua: &Lua,
    host: Rc<RefCell<HostState>>,
    configuration: Rc<RefCell<ConfigurationState>>,
) -> LuaResult<()> {
    let execute = lua.create_async_function(move |lua, id: u64| {
        let host = Rc::clone(&host);
        let configuration = Rc::clone(&configuration);
        async move {
            let (task_id, output_name) = match host.borrow().nodes.get(&id) {
                Some(GraphNode::Task) => (id, None),
                Some(GraphNode::TaskOutput { task_id, name }) => (*task_id, Some(name.clone())),
                Some(_) => {
                    return Err(LuaError::external(format!(
                        "Luau graph handle {id} is not an executable task or task output"
                    )))
                }
                None => return Err(LuaError::external(format!("unknown Luau graph handle {id}"))),
            };
            let order = dependency_order(&host.borrow(), task_id)?;
            for task_id in order {
                if host.borrow().task_results.contains_key(&task_id) {
                    continue;
                }
                let task = host.borrow().tasks.get(&task_id).cloned().ok_or_else(|| {
                    LuaError::external(format!("unknown Luau task handle {task_id}"))
                })?;
                let inputs = resolve_task_inputs(&lua, &host, &task.inputs)?;
                let returns_outputs = !task.outputs.is_empty();
                let exec = lua.create_table()?;
                let path_host = Rc::clone(&host);
                let path_inputs = inputs.clone();
                exec.set(
                    "path",
                    lua.create_function(move |_, handle: LuaAnyUserData| {
                        let graph_handle = handle.borrow::<GraphHandle>()?;
                        let mut declared = false;
                        for pair in path_inputs.pairs::<LuaValue, LuaValue>() {
                            let (_, value) = pair?;
                            if let LuaValue::UserData(value) = value {
                                if value
                                    .borrow::<GraphHandle>()
                                    .is_ok_and(|input| input.id == graph_handle.id)
                                {
                                    declared = true;
                                    break;
                                }
                            }
                        }
                        if !declared {
                            return Err(LuaError::external(
                                "exec.path(handle) requires a declared task input",
                            ));
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
                let action_host = Rc::clone(&host);
                let action_configuration = Rc::clone(&configuration);
                let action_lua = lua.clone();
                let action_inputs = inputs.clone();
                exec.set(
                    "action",
                    lua.create_async_function(move |_, options: LuaTable| {
                        let action_host = Rc::clone(&action_host);
                        let action_configuration = Rc::clone(&action_configuration);
                        let action_inputs = action_inputs.clone();
                        let action_lua = action_lua.clone();
                        async move {
                            match run_action(
                                action_lua,
                                Rc::clone(&action_host),
                                Rc::clone(&action_configuration),
                                options,
                                action_inputs,
                            )
                            .await
                            {
                                Ok(result) if returns_outputs => Ok(LuaValue::Table(result)),
                                Ok(_) => Ok(LuaValue::Nil),
                                Err(error) => {
                                    action_host.borrow_mut().task_failure =
                                        Some(format!("{error:#}"));
                                    Err(LuaError::external(format!("{error:#}")))
                                }
                            }
                        }
                    })?,
                )?;
                host.borrow_mut().graph_callback_depth += 1;
                let result = task.run.call_async::<LuaValue>((exec, inputs)).await;
                host.borrow_mut().graph_callback_depth -= 1;
                let result = result.map_err(|error| LuaError::external(error.to_string()))?;
                let outputs = validate_task_result(&lua, &host, &task, result)?;
                host.borrow_mut().task_results.insert(task_id, outputs);
            }
            let result = host
                .borrow()
                .task_results
                .get(&task_id)
                .cloned()
                .ok_or_else(|| LuaError::external("Luau task did not produce a result"))?;
            match output_name {
                Some(name) => result.get::<LuaValue>(name),
                None => Ok(LuaValue::Table(result)),
            }
        }
    })?;
    lua.globals().set("__imp_execute_task", execute)
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
    let Some(GraphNode::Task) = host.nodes.get(&handle_id) else {
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

fn dependency_order(host: &HostState, root: u64) -> LuaResult<Vec<u64>> {
    fn visit(
        host: &HostState,
        id: u64,
        visiting: &mut Vec<u64>,
        visited: &mut std::collections::HashSet<u64>,
        order: &mut Vec<u64>,
    ) -> LuaResult<()> {
        if visited.contains(&id) {
            return Ok(());
        }
        if visiting.contains(&id) {
            return Err(LuaError::external(format!(
                "cyclic Luau task dependency at {id}"
            )));
        }
        let task = host
            .tasks
            .get(&id)
            .ok_or_else(|| LuaError::external(format!("unknown Luau task handle {id}")))?;
        visiting.push(id);
        for pair in task.inputs.pairs::<LuaValue, LuaValue>() {
            let (_, value) = pair?;
            let LuaValue::UserData(value) = value else {
                continue;
            };
            let Ok(handle) = value.borrow::<GraphHandle>() else {
                continue;
            };
            match host.nodes.get(&handle.id) {
                Some(GraphNode::TaskOutput { task_id, .. }) => {
                    visit(host, *task_id, visiting, visited, order)?;
                }
                Some(GraphNode::Path { source_id, .. })
                | Some(GraphNode::Tool { source_id, .. }) => {
                    let Some(GraphNode::TaskOutput { task_id, .. }) = host.nodes.get(source_id)
                    else {
                        return Err(LuaError::external(
                            "invalid Luau tool or path source handle",
                        ));
                    };
                    visit(host, *task_id, visiting, visited, order)?;
                }
                _ => {}
            }
        }
        visiting.pop();
        visited.insert(id);
        order.push(id);
        Ok(())
    }

    let mut order = Vec::new();
    visit(
        host,
        root,
        &mut Vec::new(),
        &mut std::collections::HashSet::new(),
        &mut order,
    )?;
    Ok(order)
}

fn resolve_task_inputs(
    lua: &Lua,
    host: &Rc<RefCell<HostState>>,
    inputs: &LuaTable,
) -> LuaResult<LuaTable> {
    let resolved = lua.create_table()?;
    for pair in inputs.pairs::<LuaValue, LuaValue>() {
        let (key, value) = pair?;
        let value = if let LuaValue::UserData(userdata) = &value {
            if let Ok(handle) = userdata.borrow::<GraphHandle>() {
                if handle.kind == "task_output" {
                    let node = host.borrow().nodes.get(&handle.id).cloned();
                    let Some(GraphNode::TaskOutput { task_id, name }) = node else {
                        return Err(LuaError::external("invalid Luau task output handle"));
                    };
                    let result = host
                        .borrow()
                        .task_results
                        .get(&task_id)
                        .cloned()
                        .ok_or_else(|| {
                            LuaError::external("Luau task dependency did not produce a result")
                        })?;
                    result.get::<LuaValue>(name)?
                } else {
                    value
                }
            } else {
                value
            }
        } else {
            value
        };
        resolved.set(key, value)?;
    }
    Ok(resolved)
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

fn install_expansion_executor(lua: &Lua, host: Rc<RefCell<HostState>>) -> LuaResult<()> {
    let execute = lua.globals().get::<LuaFunction>("__imp_execute_task")?;
    let discover = lua.create_async_function(move |lua, expansion_id: u64| {
        let existing = host.borrow().expansion_results.get(&expansion_id).cloned();
        let expansion = host.borrow().expansions.get(&expansion_id).cloned();
        let host = Rc::clone(&host);
        let execute = execute.clone();
        async move {
            if let Some(result) = existing {
                return Ok(LuaValue::Table(result));
            }
            let expansion = expansion.ok_or_else(|| {
                LuaError::external(format!("unknown Luau expansion {expansion_id}"))
            })?;
            let input_tasks = {
                let host_state = host.borrow();
                input_task_roots(&host_state, &expansion.inputs)?
            };
            for task_id in input_tasks {
                execute
                    .call_async::<()>(task_id)
                    .await
                    .map_err(|error| LuaError::external(error.to_string()))?;
            }
            let inputs = resolve_task_inputs(&lua, &host, &expansion.inputs)?;
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
                let (key, _) = pair.map_err(|error| {
                    LuaError::external(format!(
                        "expansion '{}' child keys must be strings: {error}",
                        expansion.display
                    ))
                })?;
                if key.is_empty() {
                    return Err(LuaError::external(format!(
                        "expansion '{}' returned an empty child key",
                        expansion.display
                    )));
                }
            }
            host.borrow_mut()
                .expansion_results
                .insert(expansion_id, children.clone());
            Ok(LuaValue::Table(children))
        }
    })?;
    lua.globals().set("__imp_discover_expansion", discover)
}

fn input_task_roots(host: &HostState, inputs: &LuaTable) -> LuaResult<Vec<u64>> {
    let mut roots = std::collections::BTreeSet::new();
    for pair in inputs.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair?;
        let LuaValue::UserData(userdata) = value else {
            continue;
        };
        let Ok(handle) = userdata.borrow::<GraphHandle>() else {
            continue;
        };
        match host.nodes.get(&handle.id) {
            Some(GraphNode::Task) => {
                roots.insert(handle.id);
            }
            Some(GraphNode::TaskOutput { task_id, .. }) => {
                roots.insert(*task_id);
            }
            Some(GraphNode::Path { source_id, .. }) | Some(GraphNode::Tool { source_id, .. }) => {
                if let Some(GraphNode::TaskOutput { task_id, .. }) = host.nodes.get(source_id) {
                    roots.insert(*task_id);
                }
            }
            _ => {}
        }
    }
    Ok(roots.into_iter().collect())
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

    let expansion_host = Rc::clone(&host);
    core.set(
        "expand",
        lua.create_function(move |lua, options: LuaTable| {
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
            let package = current_package_path(&test_loader);
            let handle = allocate_handle(&graph_host, "test_root");
            graph_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::TestRoot { package });
            lua.create_userdata(handle)
        })?,
    )?;

    let test_api = lua.create_table()?;
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
    install_test_host_api(lua, &test_api, Rc::clone(&host))?;
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
            if bin_dirs.is_empty() {
                return Err(LuaError::external("tool.bin_dirs must not be empty"));
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
                let value = config_state.borrow().values.get(&namespace).cloned();
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
    output.set(
        "directory",
        lua.create_function(|lua, (path, options): (String, Option<LuaTable>)| {
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
            create_files_handle(lua, &graph_host, options)
        })?,
    )?;
    let graph_host = Rc::clone(&host);
    core.set(
        "glob",
        lua.create_function(move |lua, options: LuaTable| {
            create_files_handle(lua, &graph_host, options)
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
    let graph_host = Rc::clone(&host);
    core.set(
        "task",
        lua.create_function(move |lua, options: LuaTable| {
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
    core.set(
        "memo",
        lua.create_function(|_, function: LuaFunction| Ok(function))?,
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
            async move {
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
                    let value = generator.generate.call_async::<LuaValue>(()).await?;
                    let generated: BTreeMap<String, Vec<GeneratedLuauBuildTarget>> =
                        lua.from_value(value)?;
                    for (file, targets) in generated {
                        edits.entry(file).or_default().extend(targets);
                    }
                }

                let mut changed = Vec::new();
                for (file, targets) in edits {
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
                if check && !changed.is_empty() {
                    return Err(LuaError::external(format!(
                        "generated BUILD files are out of date: {}",
                        changed.join(", ")
                    )));
                }
                let report = lua.create_table()?;
                report.set("changed", changed)?;
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
                let flags = match options {
                    Some(options) => parse_goal_options(&name, options)?,
                    None => BTreeMap::new(),
                };
                let mut host = goal_host.borrow_mut();
                if host.goals.contains_key(&name) {
                    return Err(LuaError::external(format!(
                        "goal '{name}' is already registered"
                    )));
                }
                host.goals
                    .insert(name.clone(), LuauGoal { callback, flags });
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
) -> LuaResult<BTreeMap<String, Option<String>>> {
    let mut flags = BTreeMap::new();
    for pair in options.pairs::<String, LuaValue>() {
        let (key, value) = pair?;
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
    Ok(flags)
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
) -> LuaResult<()> {
    let resolve_host = Rc::clone(&host);
    test_api.set(
        "resolve",
        lua.create_async_function(move |lua, handle: LuaAnyUserData| {
            let host = Rc::clone(&resolve_host);
            async move {
                require_active_test_case(&host.borrow(), "core.test.resolve")?;
                let id = {
                    let handle = handle.borrow::<GraphHandle>().map_err(|_| {
                        LuaError::external(
                            "core.test.resolve requires a task or task output handle",
                        )
                    })?;
                    if handle.kind != "task" && handle.kind != "task_output" {
                        return Err(LuaError::external(format!(
                            "core.test.resolve requires a task or task output handle, got {}",
                            handle.kind
                        )));
                    }
                    handle.id
                };
                let execute = lua.globals().get::<LuaFunction>("__imp_execute_task")?;
                let result = execute.call_async::<LuaValue>(id).await;
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
) -> LuaResult<LuaAnyUserData> {
    let spec = FileSetSpec {
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
        "{}\n{}\n{}",
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
        Some(GraphNode::Files(spec)) => {
            let files = crate::spike::workspace_glob_files(
                workspace_root,
                &spec.root,
                &spec.include,
                &spec.exclude,
            )
            .with_context(|| format!("expand loaded Luau sources rooted at '{}'", spec.root))?;
            owned.extend(files);
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
        if key != "name" && key != "key" {
            return Err(LuaError::external(format!(
                "output.directory named_cache options do not accept '{key}'"
            )));
        }
    }
    let name = cache.get::<String>("name")?;
    let key = cache.get::<String>("key")?;
    imp_store::cache::validate_named_cache_path("shared", &name, &key)
        .map_err(LuaError::external)?;
    Ok(Some(imp_store::cache::OutputNamedCache {
        name,
        key,
        shared: false,
    }))
}

fn artifact_output_source(
    host: &Rc<RefCell<HostState>>,
    source: &LuaAnyUserData,
) -> LuaResult<u64> {
    let handle = source.borrow::<GraphHandle>()?;
    let state = host.borrow();
    let Some(GraphNode::TaskOutput { task_id, name }) = state.nodes.get(&handle.id) else {
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
            let result = host.task_results.get(task_id).ok_or_else(|| {
                LuaError::external("Luau task dependency did not produce a result")
            })?;
            let value = result.get::<LuaValue>(name.as_str())?;
            let LuaValue::UserData(value) = value else {
                return Err(LuaError::external("task output is not an artifact handle"));
            };
            let artifact_handle = value.borrow::<GraphHandle>()?;
            match host.nodes.get(&artifact_handle.id) {
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
    let valid = match host.nodes.get(&handle_id) {
        Some(
            GraphNode::Task
            | GraphNode::TaskOutput { .. }
            | GraphNode::ExpansionGet { .. }
            | GraphNode::ExpansionAll { .. },
        ) => true,
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
    let artifact = resolve_source_artifact(host, source_id)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if artifact.kind != "directory" {
        bail!("tool '{name}' declared in package '{owner_package}' must use a directory artifact");
    }
    artifact.named_cache.with_context(|| {
        format!("tool '{name}' declared in package '{owner_package}' must come from an output with named_cache")
    })
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
    if let Some(inputs) = &request.inputs {
        for value in inputs.sequence_values::<LuaAnyUserData>() {
            let value = value.map_err(lua_error)?;
            value.borrow::<GraphHandle>().map_err(lua_error)?;
            input_count += 1;
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
            if let Some(GraphNode::Files(spec)) = nodes.get(&handle.id) {
                let captured = crate::spike::workspace_glob_files_captured(
                    &root,
                    &spec.root,
                    &spec.include,
                    &spec.exclude,
                )?;
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
        config_digest: String::new(),
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
    let execution_cancellation = cancellation;
    let outcome = tokio::task::spawn_blocking(move || {
        service.execute(&workspace_id, action, Some(execution_cancellation.as_ref()))
    })
    .await
    .context("join hermetic graph action")??;
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
                let resolved = dunce::canonicalize(&resolved)
                    .with_context(|| format!("canonicalize native tool {resolved}"))?;
                let content_digest = service
                    .file_sha256(&resolved)
                    .with_context(|| format!("digest native tool {}", resolved.display()))?;
                let path =
                    crate::spike::singleflight_register_native_tool(service, &name, &resolved)
                        .map_err(anyhow::Error::msg)?;
                let key = imp_store::cache::digest_json(&serde_json::json!({
                    "path": resolved,
                    "digest": content_digest,
                }))?;
                tools.push(ExecToolSpec {
                    name,
                    cache: "native-tools".to_owned(),
                    key,
                    path,
                    bin_dirs: vec![".".to_owned()],
                });
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
                    .cache_dir_get(workspace_id, &cache.name, &cache.key)?
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
    let outcome = tokio::task::spawn_blocking(move || {
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
            "lint/index.luau",
            "package/index.luau",
            "run/index.luau",
            "test/index.luau",
        ] {
            let destination = rules_root.path().join("workflows").join(module);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(source.join(module), destination).unwrap();
        }
        rules_root
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

    /// The Luau workspace of this repository loads, and every `TEST` root in
    /// it passes. This is `IMP_RUNTIME=luau imp test //...` without the CLI.
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
        assert(not ok, "the real host must write after the fake scope")
        assert(string.find(tostring(problem), "publish workspace artifact", 1, true), tostring(problem))
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
local consumer = core.task({
    inputs = { tool = tool, path = path },
    run = function(exec, inputs)
        assert(exec.path(inputs.path) == "staged")
        exec.action({
            argv = { "fixture-tool" },
            inputs = { inputs.path },
            env = { TOOL_SETTING = "set" },
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
    async fn luau_build_generators_merge_targets_write_and_check_native_build_files() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = rules_tempdir();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            r#"
local core = require("@imp/core")
require("@imp/rules/workflows/build")
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
        assert!(runtime.has_build_generators());
        runtime.execute_build_generation(false).await.unwrap();
        let generated =
            fs::read_to_string(workspace_root.path().join("generated/BUILD.luau")).unwrap();
        assert!(generated.contains("first = __imp_rule_0.sample"));
        assert!(generated.contains("second = __imp_rule_0.sample"));
        assert!(generated.contains("second = __imp_rule_0.sample({})"));
        runtime.execute_build_generation(true).await.unwrap();

        let mut discovered = LuauWorkspace::new(workspace_root.path(), rules_root.path()).unwrap();
        let roots = discovered.load_modules().await.unwrap();
        assert!(roots.iter().any(|root| root.address == "//generated:first"));
        assert!(roots
            .iter()
            .any(|root| root.address == "//generated:second"));

        let path = workspace_root.path().join("generated/BUILD.luau");
        fs::write(&path, "return { hand_written = true }\n").unwrap();
        assert!(runtime.execute_build_generation(false).await.is_err());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "return { hand_written = true }\n"
        );
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
        runtime.execute_build_generation(false).await.unwrap();

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
