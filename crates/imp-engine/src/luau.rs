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
use imp_store::digest::{nest_directory, nest_file, DirectoryDigest};
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

struct TestUnit {
    name: String,
    ok: bool,
    output: String,
}

fn render_test_report(units: &mut [TestUnit], passed: usize) -> String {
    units.sort_by(|left, right| {
        left.ok
            .cmp(&right.ok)
            .then_with(|| left.name.cmp(&right.name))
    });
    let width = units
        .iter()
        .map(|unit| unit.name.len())
        .max()
        .unwrap_or_default()
        + 2;
    let mut lines = units
        .iter()
        .map(|unit| {
            let (status, color) = if unit.ok {
                ("PASS", "\x1b[32m")
            } else {
                ("FAIL", "\x1b[31m")
            };
            format!("{:<width$}{color}{status}\x1b[0m", unit.name, width = width)
        })
        .collect::<Vec<_>>();
    for unit in units.iter().filter(|unit| !unit.output.is_empty()) {
        lines.push(format!("{}:\n{}", unit.name, unit.output));
    }
    lines.push(format!("test: {passed}/{} unit(s) passed", units.len()));
    lines.join("\n")
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
    goals: HashMap<String, LuaFunction>,
    goal_root_results: Option<LuaTable>,
    build_generators: Vec<LuauBuildGenerator>,
    build_rules: BTreeMap<String, LuauBuildRule>,
    workspace_root: PathBuf,
    workspace_id: String,
    service: Arc<dyn ExecutionService>,
    cancellation: Arc<AtomicBool>,
    task_failure: Option<String>,
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
            goals: HashMap::new(),
            goal_root_results: None,
            build_generators: Vec::new(),
            build_rules: BTreeMap::new(),
            workspace_id,
            workspace_root: workspace_root.clone(),
            service,
            cancellation: Arc::new(AtomicBool::new(false)),
            task_failure: None,
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
                install_package_executor(lua, bootstrap_host.clone())?;
                install_expansion_executor(lua, bootstrap_host.clone())?;
                install_goal_executor(lua, bootstrap_host.clone())?;
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
        host.goal_root_results = None;
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
                let mut handles = Vec::new();
                match value {
                    LuaValue::UserData(userdata) => {
                        if let Ok(handle) = userdata.borrow::<GraphHandle>() {
                            handles.push((handle.id, "build"));
                        }
                    }
                    LuaValue::Table(table) => {
                        for (field, workflow) in
                            [("BUILD", "build"), ("PACKAGE", "package"), ("TEST", "test")]
                        {
                            if let Some(userdata) =
                                table.get::<Option<LuaAnyUserData>>(field).ok().flatten()
                            {
                                if let Ok(handle) = userdata.borrow::<GraphHandle>() {
                                    handles.push((handle.id, workflow));
                                }
                            }
                        }
                    }
                    _ => {}
                }
                let address = if package.is_empty() {
                    format!("//:{name}")
                } else {
                    format!("//{package}:{name}")
                };
                for (handle_id, workflow) in handles {
                    let state = self.host.borrow();
                    let node = state.nodes.get(&handle_id);
                    let valid = match workflow {
                        "build" => matches!(
                            node,
                            Some(
                                GraphNode::Task
                                    | GraphNode::TaskOutput { .. }
                                    | GraphNode::ExpansionGet { .. }
                                    | GraphNode::ExpansionAll { .. }
                            )
                        ),
                        "package" => match node {
                            Some(GraphNode::TaskOutput { task_id, name }) => state
                                .tasks
                                .get(task_id)
                                .and_then(|task| task.outputs.get(name))
                                .is_some_and(|kind| *kind == TaskOutputKind::Artifact),
                            Some(GraphNode::Task) => {
                                state.tasks.get(&handle_id).is_some_and(|task| {
                                    task.outputs
                                        .values()
                                        .filter(|kind| **kind == TaskOutputKind::Artifact)
                                        .count()
                                        == 1
                                })
                            }
                            Some(
                                GraphNode::ExpansionGet { .. } | GraphNode::ExpansionAll { .. },
                            ) => true,
                            _ => false,
                        },
                        "test" => matches!(
                            node,
                            Some(
                                GraphNode::Task
                                    | GraphNode::TaskOutput { .. }
                                    | GraphNode::TestRoot { .. }
                                    | GraphNode::ExpansionGet { .. }
                                    | GraphNode::ExpansionAll { .. }
                            )
                        ),
                        _ => false,
                    };
                    drop(state);
                    if !valid {
                        continue;
                    }
                    roots.push(GraphRoot {
                        address: address.clone(),
                        workflow: workflow.to_owned(),
                        facet: None,
                        handle_id: handle_id as u32,
                        is_default: false,
                    });
                }
            }
        }
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

    /// Run selected graph task handles and then the Luau build-goal callback.
    pub async fn execute_graph(
        &mut self,
        goal: &str,
        roots: &[GraphRoot],
        cancellation: Arc<AtomicBool>,
        case_filter: Option<&str>,
        suite_filter: Option<&str>,
    ) -> Result<Option<String>> {
        if !self.host.borrow().graph_run_active {
            self.begin_graph_run(Arc::clone(&cancellation));
        } else {
            self.host.borrow_mut().cancellation = Arc::clone(&cancellation);
        }
        let result = self
            .execute_graph_inner(goal, roots, cancellation, case_filter, suite_filter)
            .await;
        let mut host = self.host.borrow_mut();
        host.graph_run_active = false;
        host.goal_root_results = None;
        result
    }

    async fn execute_graph_inner(
        &mut self,
        goal: &str,
        roots: &[GraphRoot],
        cancellation: Arc<AtomicBool>,
        case_filter: Option<&str>,
        suite_filter: Option<&str>,
    ) -> Result<Option<String>> {
        if goal != "build" && goal != "test" && goal != "package" {
            bail!("Luau pilot does not implement the '{goal}' workflow");
        }
        self.host.borrow_mut().cancellation = cancellation;
        let mut test_units = Vec::new();
        for root in roots {
            if goal == "test" {
                let package = match self.host.borrow().nodes.get(&(root.handle_id as u64)) {
                    Some(GraphNode::TestRoot { package }) => Some(package.clone()),
                    _ => None,
                };
                if let Some(package) = package {
                    test_units.extend(
                        self.run_test_root(&root.address, &package, case_filter, suite_filter)
                            .await?,
                    );
                    continue;
                }
            }
            let script = format!("return __imp_execute_task({})", root.handle_id);
            self.run_script_value("@imp/pilot-execute", &script)
                .await
                .with_context(|| format!("execute Luau graph root {}", root.address))?;
            if goal == "package" {
                let address = serde_json::to_string(&root.address)?;
                let script = format!(
                    "return __imp_add_package_root({}, {})",
                    root.handle_id, address
                );
                self.run_script("@imp/package-root", &script)
                    .await
                    .with_context(|| format!("collect Luau package root {}", root.address))?;
            } else if goal == "test" {
                test_units.push(TestUnit {
                    name: root.address.clone(),
                    ok: true,
                    output: String::new(),
                });
            }
        }
        if goal == "test" {
            if test_units.is_empty() {
                let filter = case_filter
                    .map(|name| format!("case '{name}'"))
                    .or_else(|| suite_filter.map(|name| format!("suite '{name}'")))
                    .unwrap_or_else(|| "tests".to_owned());
                test_units.push(TestUnit {
                    name: roots
                        .first()
                        .map(|root| root.address.clone())
                        .unwrap_or_else(|| "Luau tests".to_owned()),
                    ok: false,
                    output: format!("no {filter} found in selected test roots"),
                });
            }
            let passed = test_units.iter().filter(|unit| unit.ok).count();
            let failed = test_units.len().saturating_sub(passed);
            let report = render_test_report(&mut test_units, passed);
            if failed > 0 {
                bail!("{report}");
            }
            return Ok(Some(report));
        }
        if goal == "package" && !self.host.borrow().goals.contains_key("package") {
            bail!("Luau package roots require @imp/rules/workflows/package");
        }
        if self.host.borrow().goals.contains_key(goal) {
            let script = format!(
                "return __imp_execute_goal({})",
                serde_json::to_string(goal)?
            );
            self.run_script("@imp/pilot-goal", &script).await?;
        }
        Ok(None)
    }

    async fn run_test_root(
        &self,
        address: &str,
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
                name: address.to_owned(),
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
                            name: format!("{address} {module} {case_name}"),
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
                                case.run
                                    .call_async::<LuaValue>(())
                                    .await
                                    .map(|_| ())
                                    .map_err(|error| anyhow::anyhow!("{module}: {error}"))
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
                        name: format!("{address} {module} {case_name}"),
                        ok: true,
                        output: String::new(),
                    },
                    Err(error) => TestUnit {
                        name: format!("{address} {module} {case_name}"),
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
                let result = task
                    .run
                    .call_async::<LuaValue>((exec, inputs))
                    .await
                    .map_err(|error| LuaError::external(error.to_string()))?;
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

fn install_package_executor(lua: &Lua, host: Rc<RefCell<HostState>>) -> LuaResult<()> {
    let append = lua.create_function(move |lua, (handle_id, address): (u64, String)| {
        let node = host.borrow().nodes.get(&handle_id).cloned();
        let (task_id, output_name) = match node {
            Some(GraphNode::TaskOutput { task_id, name }) => (task_id, name),
            Some(GraphNode::Task) => {
                let task = host
                    .borrow()
                    .tasks
                    .get(&handle_id)
                    .cloned()
                    .ok_or_else(|| LuaError::external("package root references an unknown task"))?;
                let outputs: Vec<_> = task
                    .outputs
                    .iter()
                    .filter(|(_, kind)| **kind == TaskOutputKind::Artifact)
                    .map(|(name, _)| name.clone())
                    .collect();
                if outputs.len() != 1 {
                    return Err(LuaError::external(format!(
                        "package root {address} must expose exactly one artifact output"
                    )));
                }
                (handle_id, outputs[0].clone())
            }
            _ => {
                return Err(LuaError::external(format!(
                    "package root {address} is not an artifact task handle"
                )))
            }
        };
        if !host
            .borrow()
            .tasks
            .get(&task_id)
            .and_then(|task| task.outputs.get(&output_name))
            .is_some_and(|kind| *kind == TaskOutputKind::Artifact)
        {
            return Err(LuaError::external(format!(
                "package root {address} must expose an artifact output"
            )));
        }
        let result = host
            .borrow()
            .task_results
            .get(&task_id)
            .cloned()
            .ok_or_else(|| LuaError::external("package root task did not produce a result"))?;
        let value = result.get::<LuaValue>(output_name.as_str())?;
        let LuaValue::UserData(value) = value else {
            return Err(LuaError::external(format!(
                "package root {address} did not return an artifact handle"
            )));
        };
        let artifact_handle = value.borrow::<GraphHandle>()?;
        let artifact = match host.borrow().nodes.get(&artifact_handle.id) {
            Some(GraphNode::Artifact(artifact)) => artifact.clone(),
            _ => {
                return Err(LuaError::external(format!(
                    "package root {address} did not return a captured artifact"
                )))
            }
        };
        let digest = normalize_luau_artifact(&artifact)
            .map_err(|error| LuaError::external(format!("normalize package artifact: {error:#}")))?
            .digest()
            .to_owned();
        let artifact_value = lua.create_table()?;
        artifact_value.set("type", "artifact")?;
        artifact_value.set("digest", digest)?;
        artifact_value.set("path", artifact.path)?;
        let root_value = lua.create_table()?;
        root_value.set("address", address)?;
        root_value.set("result", artifact_value)?;
        let roots = host
            .borrow()
            .goal_root_results
            .clone()
            .unwrap_or(lua.create_table()?);
        roots.set(roots.raw_len() + 1, root_value)?;
        host.borrow_mut().goal_root_results = Some(roots);
        Ok(())
    })?;
    lua.globals().set("__imp_add_package_root", append)
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

fn install_goal_executor(lua: &Lua, host: Rc<RefCell<HostState>>) -> LuaResult<()> {
    let execute = lua.create_async_function(move |lua, name: String| {
        let prepared = (|| {
            let state = host.borrow();
            let callback = state
                .goals
                .get(&name)
                .cloned()
                .ok_or_else(|| LuaError::external(format!("unknown Luau workflow '{name}'")))?;
            let roots = state
                .goal_root_results
                .clone()
                .unwrap_or(lua.create_table()?);
            Ok::<_, LuaError>((callback, roots))
        })();
        async move {
            let (callback, roots) = prepared?;
            callback
                .call_async::<LuaValue>(roots)
                .await
                .map_err(|error| LuaError::external(error.to_string()))
        }
    })?;
    lua.globals().set("__imp_execute_goal", execute)
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
            let children = expansion
                .create
                .call_async::<LuaValue>(inputs)
                .await
                .map_err(|error| {
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
    core.set("test", test_api)?;

    let platform_host = Rc::clone(&host);
    core.set(
        "platform_info",
        lua.create_function(move |lua, ()| {
            let capabilities = platform_host
                .borrow()
                .service
                .capabilities()
                .map_err(LuaError::external)?;
            let platform = lua.create_table()?;
            platform.set("os", capabilities.os)?;
            platform.set("arch", capabilities.arch)?;
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
        lua.create_function(move |lua, (name, callback, _options): (String, Option<LuaFunction>, Option<LuaTable>)| {
            let goal = lua.create_table()?;
            goal.set("name", name.clone())?;
            if let Some(callback) = callback {
                goal_host
                    .borrow_mut()
                    .goals
                    .insert(name.clone(), callback.clone());
                goal.set("handler", callback)?;
            }
            Ok(goal)
        })?,
    )?;
    let workspace_for_write = host.borrow().workspace_root.clone();
    core.set(
        "write_workspace",
        lua.create_function(
            move |_, (path, digest, options): (String, String, Option<LuaTable>)| {
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
    if !matches!(workflow.as_str(), "BUILD" | "PACKAGE" | "TEST") {
        return Err(LuaError::external(format!(
            "expansion workflow must be BUILD, PACKAGE, or TEST; got '{workflow}'"
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
    let kind = host.nodes.get(&handle_id);
    let valid = matches!(
        (workflow, kind),
        (
            "BUILD" | "PACKAGE",
            Some(
                GraphNode::Task
                    | GraphNode::TaskOutput { .. }
                    | GraphNode::ExpansionGet { .. }
                    | GraphNode::ExpansionAll { .. }
            )
        ) | (
            "TEST",
            Some(
                GraphNode::Task
                    | GraphNode::TaskOutput { .. }
                    | GraphNode::TestRoot { .. }
                    | GraphNode::ExpansionGet { .. }
                    | GraphNode::ExpansionAll { .. }
            )
        )
    );
    if !valid {
        bail!("expansion child '{key}' has no requested {workflow} workflow handle");
    }
    if workflow == "PACKAGE" {
        if let Some(GraphNode::TaskOutput { task_id, name }) = kind {
            if !host
                .tasks
                .get(task_id)
                .and_then(|task| task.outputs.get(name))
                .is_some_and(|output| *output == TaskOutputKind::Artifact)
            {
                bail!("expansion child '{key}' PACKAGE handle must be an artifact output");
            }
        }
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
    imp_execution::staging::resolve_base_env(&entries)
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
    let action_env = options
        .get::<Option<LuaTable>>("env")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let action_inputs = options
        .get::<Option<LuaTable>>("inputs")
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
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

    let mut tools = Vec::new();
    let mut tool_names = std::collections::HashSet::new();
    for pair in task_inputs.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let LuaValue::UserData(value) = value else {
            continue;
        };
        let handle = match value.borrow::<GraphHandle>() {
            Ok(handle) => handle,
            Err(_) => continue,
        };
        match nodes.get(&handle.id) {
            Some(GraphNode::NativeTool(name)) => {
                if !tool_names.insert(name.clone()) {
                    bail!("exec.action received tool name '{name}' more than once");
                }
                let resolved = crate::spike::which_executable(name)
                    .with_context(|| format!("native tool '{name}' was not found on PATH"))?;
                let resolved = dunce::canonicalize(&resolved)
                    .with_context(|| format!("canonicalize native tool {resolved}"))?;
                let content_digest = service
                    .file_sha256(&resolved)
                    .with_context(|| format!("digest native tool {}", resolved.display()))?;
                let path =
                    crate::spike::singleflight_register_native_tool(&service, name, &resolved)
                        .map_err(anyhow::Error::msg)?;
                let key = imp_store::cache::digest_json(&serde_json::json!({
                    "path": resolved,
                    "digest": content_digest,
                }))?;
                tools.push(ExecToolSpec {
                    name: name.clone(),
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
                    bail!("exec.action received tool name '{name}' more than once");
                }
                let artifact = resolve_source_artifact(&host.borrow(), *source_id)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                if artifact.kind != "directory" {
                    bail!("tool '{name}' declared in package '{owner_package}' must use a directory artifact");
                }
                let cache = artifact.named_cache.as_ref().with_context(|| {
                    format!("tool '{name}' declared in package '{owner_package}' must come from an output with named_cache")
                })?;
                let path = service
                    .cache_dir_get(&workspace_id, &cache.name, &cache.key)?
                    .with_context(|| {
                        format!(
                            "tool '{}' cache '{}/{}' is missing",
                            name, cache.name, cache.key
                        )
                    })?;
                tools.push(ExecToolSpec {
                    name: name.clone(),
                    cache: cache.name.clone(),
                    key: cache.key.clone(),
                    path,
                    bin_dirs: bin_dirs.clone(),
                });
            }
            _ => {}
        }
    }

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

    let mut env = configured_base_env(&configuration.borrow())?;
    if let Some(action_env) = action_env {
        for pair in action_env.pairs::<String, String>() {
            let (name, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0')
            {
                bail!("exec.action().env requires valid environment names and values");
            }
            env.insert(name, value);
        }
    }
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
        allow_failure: false,
    };
    let execution_cancellation = cancellation;
    let outcome = tokio::task::spawn_blocking(move || {
        service.execute(&workspace_id, action, Some(execution_cancellation.as_ref()))
    })
    .await
    .context("join hermetic graph action")??;
    if outcome.exit_code != 0 {
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
            .cloned()
            .with_context(|| {
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

    async fn execute_luau_task_source(source: &str) -> anyhow::Error {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace_root.path().join("pkg/nested")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            r#"
local core = require("@imp/core")
return { tests = { TEST = core.test_root() } }
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
            .execute_graph("test", &roots, Arc::new(AtomicBool::new(false)), None, None)
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
                Some("passes"),
                None,
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
                None,
                Some("group"),
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
                Some("missing"),
                None,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("no case 'missing' found"), "{error}");
    }

    #[tokio::test]
    async fn luau_test_failure_reports_canonical_module_and_source_location() {
        let workspace_root = tempfile::tempdir().unwrap();
        let rules_root = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace_root.path().join("pkg")).unwrap();
        fs::write(
            workspace_root.path().join("pkg/BUILD.luau"),
            "local core = require('@imp/core')\nreturn { tests = { TEST = core.test_root() } }\n",
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
            .execute_graph("test", &roots, Arc::new(AtomicBool::new(false)), None, None)
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return { imp = { passthrough_env = { 'IMP_LUAU_CONFIG_TEST=value' } } }\n",
        )
        .unwrap();
        fs::write(
            workspace_root.path().join("BUILD.luau"),
            r#"
local core = require("@imp/core")
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
                None,
                None,
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            r#"
local core = require("@imp/core")
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
        let rules_root = tempfile::tempdir().unwrap();
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
