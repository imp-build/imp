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
use std::sync::{atomic::AtomicBool, Arc};

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
    Directory(String),
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
struct FileSetSpec {
    root: String,
    include: Vec<String>,
    exclude: Vec<String>,
}

#[derive(Clone)]
enum GraphNode {
    Files(FileSetSpec),
    NativeTool(String),
    Task,
    TaskOutput { task_id: u64, name: String },
    Artifact(imp_store::cache::CachedArtifact),
}

struct HostState {
    next_id: u64,
    tasks: HashMap<u64, Task>,
    task_results: HashMap<u64, LuaTable>,
    nodes: HashMap<u64, GraphNode>,
    filesets: HashMap<String, u64>,
    action_count: usize,
    cache_hit_count: usize,
    goals: HashMap<String, LuaFunction>,
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
            tasks: HashMap::new(),
            task_results: HashMap::new(),
            nodes: HashMap::new(),
            filesets: HashMap::new(),
            action_count: 0,
            cache_hit_count: 0,
            goals: HashMap::new(),
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

    async fn load_modules_with_ci_overlay(
        &mut self,
        include_ci_overlay: bool,
    ) -> Result<Vec<GraphRoot>> {
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
                let handle = match value {
                    LuaValue::UserData(userdata) => userdata
                        .borrow::<GraphHandle>()
                        .ok()
                        .map(|h| (h.id, h.kind)),
                    LuaValue::Table(table) => table
                        .get::<Option<LuaAnyUserData>>("BUILD")
                        .ok()
                        .flatten()
                        .and_then(|userdata| {
                            userdata
                                .borrow::<GraphHandle>()
                                .ok()
                                .map(|h| (h.id, h.kind))
                        }),
                    _ => None,
                };
                let Some((handle_id, "task")) = handle else {
                    continue;
                };
                let address = if package.is_empty() {
                    format!("//:{name}")
                } else {
                    format!("//{package}:{name}")
                };
                roots.push(GraphRoot {
                    address,
                    workflow: "build".to_owned(),
                    facet: None,
                    handle_id: handle_id as u32,
                    is_default: false,
                });
            }
        }
        crate::graph::GraphCatalog {
            roots: roots.clone(),
        }
        .validate()?;
        Ok(roots)
    }

    /// Run selected graph task handles and then the Luau build-goal callback.
    pub async fn execute_graph(
        &mut self,
        goal: &str,
        roots: &[GraphRoot],
        cancellation: Arc<AtomicBool>,
    ) -> Result<()> {
        if goal != "build" {
            bail!("Luau pilot does not implement the '{goal}' workflow");
        }
        self.host.borrow_mut().task_results.clear();
        self.host.borrow_mut().cancellation = cancellation;
        for root in roots {
            let script = format!("return __imp_execute_task({})", root.handle_id);
            self.run_script("@imp/pilot-execute", &script)
                .await
                .with_context(|| format!("execute Luau graph root {}", root.address))?;
        }
        if self.host.borrow().goals.contains_key(goal) {
            let script = format!(
                "return __imp_execute_goal({})",
                serde_json::to_string(goal)?
            );
            self.run_script("@imp/pilot-goal", &script).await?;
        }
        Ok(())
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
        let order = dependency_order(&host.borrow(), id);
        let host = Rc::clone(&host);
        let configuration = Rc::clone(&configuration);
        async move {
            for task_id in order? {
                if host.borrow().task_results.contains_key(&task_id) {
                    continue;
                }
                let task = host.borrow().tasks.get(&task_id).cloned().ok_or_else(|| {
                    LuaError::external(format!("unknown Luau task handle {task_id}"))
                })?;
                let inputs = resolve_task_inputs(&lua, &host, &task.inputs)?;
                let returns_outputs = !task.outputs.is_empty();
                let exec = lua.create_table()?;
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
            Ok(())
        }
    })?;
    lua.globals().set("__imp_execute_task", execute)
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
            if handle.kind != "task_output" {
                continue;
            }
            let Some(GraphNode::TaskOutput { task_id, .. }) = host.nodes.get(&handle.id) else {
                return Err(LuaError::external("invalid Luau task output handle"));
            };
            visit(host, *task_id, visiting, visited, order)?;
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
        let prepared =
            (|| {
                let callback =
                    host.borrow().goals.get(&name).cloned().ok_or_else(|| {
                        LuaError::external(format!("unknown Luau workflow '{name}'"))
                    })?;
                let roots = lua.create_table()?;
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

fn create_core(
    lua: &Lua,
    host: Rc<RefCell<HostState>>,
    loader: ModuleLoader,
    configuration: Rc<RefCell<ConfigurationState>>,
) -> LuaResult<LuaValue> {
    let core = lua.create_table()?;
    core.set("BUILD", "BUILD")?;

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
        lua.create_function(|lua, path: String| {
            validate_output_path(&path)?;
            lua.create_userdata(OutputDeclarationHandle(OutputDeclaration::Directory(path)))
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
                        OutputDeclaration::File(_) | OutputDeclaration::Directory(_) => {
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
    core.set(
        "register_build_rule",
        lua.create_function(|_, _: LuaValue| Ok(()))?,
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
    core.set(
        "write_workspace",
        lua.create_function(|_, _: LuaValue| Ok(()))?,
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

fn allocate_handle(host: &Rc<RefCell<HostState>>, kind: &'static str) -> GraphHandle {
    let mut host = host.borrow_mut();
    host.next_id += 1;
    GraphHandle {
        id: host.next_id,
        kind,
        outputs: None,
    }
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
            }
        }
    }
    let input_digest = imp_execution::staging::resolve_input_digest(&root, &input_specs)?;

    let mut tools = Vec::new();
    for pair in task_inputs.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair.map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let LuaValue::UserData(value) = value else {
            continue;
        };
        let handle = match value.borrow::<GraphHandle>() {
            Ok(handle) => handle,
            Err(_) => continue,
        };
        let Some(GraphNode::NativeTool(name)) = nodes.get(&handle.id) else {
            continue;
        };
        let resolved = crate::spike::which_executable(name)
            .with_context(|| format!("native tool '{name}' was not found on PATH"))?;
        let resolved = dunce::canonicalize(&resolved)
            .with_context(|| format!("canonicalize native tool {resolved}"))?;
        let content_digest = service
            .file_sha256(&resolved)
            .with_context(|| format!("digest native tool {}", resolved.display()))?;
        let path = crate::spike::singleflight_register_native_tool(&service, name, &resolved)
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
            let (kind, path) = match &declaration.0 {
                OutputDeclaration::File(path) => ("file", path),
                OutputDeclaration::Directory(path) => ("directory", path),
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
                named_cache: None,
            });
        }
    }

    let action = ExecAction {
        argv,
        display: display.clone(),
        env: configured_base_env(&configuration.borrow())?,
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
            .execute_graph("build", &roots, Arc::new(AtomicBool::new(false)))
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
