//! The first production Luau graph-host slice.
//!
//! This loader is deliberately small. It hosts the graph operations used by
//! the asset pilot and keeps module resolution rooted in the workspace or the
//! installed rules tree. The existing JavaScript runtime remains the default
//! workspace runtime while the migration is in progress.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::{atomic::AtomicBool, Arc};

use crate::graph::GraphRoot;
use anyhow::{bail, Context, Result};
use imp_exec_api::{ExecAction, ExecIoSpec, ExecToolSpec, ExecutionService, SandboxRetention};
use lune::Runtime;
use mlua::prelude::*;

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
}

impl LuaUserData for GraphHandle {}

struct Task {
    run: LuaFunction,
    inputs: LuaTable,
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
}

struct HostState {
    next_id: u64,
    tasks: HashMap<u64, Task>,
    nodes: HashMap<u64, GraphNode>,
    filesets: HashMap<String, u64>,
    action_count: usize,
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
    workspace_config: std::collections::BTreeMap<String, serde_json::Value>,
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
            nodes: HashMap::new(),
            filesets: HashMap::new(),
            action_count: 0,
            goals: HashMap::new(),
            workspace_id,
            workspace_root: workspace_root.clone(),
            service,
            cancellation: Arc::new(AtomicBool::new(false)),
            task_failure: None,
        }));

        let core_loader = loader.clone();
        let core_host = Rc::clone(&host);
        let runtime = Runtime::new()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .with_lib("@imp/core", move |lua| {
                create_core(lua, core_host.clone(), core_loader.clone())
            })
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;

        let bootstrap_loader = loader.clone();
        let bootstrap_host = Rc::clone(&host);
        let runtime = runtime
            .with_lib("@imp/bootstrap", move |lua| {
                let core = lua
                    .globals()
                    .get::<LuaFunction>("require")?
                    .call::<LuaTable>("@imp/core")?;
                install_require(lua, core, bootstrap_loader.clone(), bootstrap_host.clone())?;
                install_task_executor(lua, bootstrap_host.clone())?;
                install_goal_executor(lua, bootstrap_host.clone())?;
                Ok(LuaValue::Nil)
            })
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;

        Ok(Self {
            runtime,
            loader,
            host,
            workspace_config: std::collections::BTreeMap::new(),
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
        let workspace_config = self.loader.workspace_root.join("imp.workspace.luau");
        if workspace_config.is_file() {
            let value = self.evaluate("@workspace/imp.workspace").await?;
            self.merge_config_value(value)?;
        }
        if std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
            && self
                .loader
                .workspace_root
                .join("imp.workspace.ci.luau")
                .is_file()
        {
            let value = self.evaluate("@workspace/imp.workspace.ci").await?;
            self.merge_config_value(value)?;
        }

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

    /// Return the merged workspace configuration exported by Luau config
    /// modules. The loader currently accepts the Imp-owned `imp` namespace.
    pub fn workspace_config(&self) -> std::collections::BTreeMap<String, serde_json::Value> {
        self.workspace_config.clone()
    }

    fn merge_config_value(&mut self, value: LuaValue) -> Result<()> {
        let LuaValue::Table(table) = value else {
            bail!("Luau workspace config must return a table");
        };
        let Some(imp) = table
            .get::<Option<LuaValue>>("imp")
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
        else {
            return Ok(());
        };
        let config: serde_json::Value = serde_json::to_value(imp)
            .map_err(|error| anyhow::anyhow!("convert Luau imp config: {error}"))?;
        if !config.is_object() {
            bail!("Luau workspace config field 'imp' must be a table");
        }
        let existing = self
            .workspace_config
            .entry("imp".to_owned())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        merge_config_json(existing, config);
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

fn install_task_executor(lua: &Lua, host: Rc<RefCell<HostState>>) -> LuaResult<()> {
    let execute = lua.create_async_function(move |lua, id: u64| {
        let prepared = (|| {
            let task = host
                .borrow()
                .tasks
                .get(&id)
                .map(|task| (task.run.clone(), task.inputs.clone()))
                .ok_or_else(|| LuaError::external(format!("unknown Luau task handle {id}")))?;
            let action_inputs = task.1.clone();
            let exec = lua.create_table()?;
            let action_host = Rc::clone(&host);
            exec.set(
                "action",
                lua.create_async_function(move |_, options: LuaTable| {
                    let action_host = Rc::clone(&action_host);
                    let action_inputs = action_inputs.clone();
                    async move {
                        if let Err(error) =
                            run_action(Rc::clone(&action_host), options, action_inputs).await
                        {
                            action_host.borrow_mut().task_failure = Some(format!("{error:#}"));
                            return Err(LuaError::external(format!("{error:#}")));
                        }
                        Ok(())
                    }
                })?,
            )?;
            Ok::<_, LuaError>((task, exec))
        })();
        async move {
            let (task, exec) = prepared?;
            task.0
                .call_async::<()>((exec, task.1))
                .await
                .map_err(|error| LuaError::external(error.to_string()))
        }
    })?;
    lua.globals().set("__imp_execute_task", execute)
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
) -> LuaResult<LuaValue> {
    let core = lua.create_table()?;
    core.set("BUILD", "BUILD")?;

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
            let handle = allocate_handle(&graph_host, "task");
            graph_host
                .borrow_mut()
                .nodes
                .insert(handle.id, GraphNode::Task);
            graph_host
                .borrow_mut()
                .tasks
                .insert(handle.id, Task { run, inputs });
            lua.create_userdata(handle)
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
        return lua.create_userdata(GraphHandle { id, kind: "files" });
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
    }
}

async fn run_action(
    host: Rc<RefCell<HostState>>,
    options: LuaTable,
    task_inputs: LuaTable,
) -> Result<()> {
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

    let action = ExecAction {
        argv,
        display: display.clone(),
        env: imp_execution::staging::resolve_base_env(&[])?,
        config_digest: String::new(),
        input_digest,
        outputs: Vec::new(),
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
    host.borrow_mut().action_count += 1;
    Ok(())
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

    #[tokio::test]
    async fn opt_in_luau_workspace_loads_installed_asset_and_executes_hermetically() {
        let workspace_root = tempfile::tempdir().unwrap();
        fs::write(
            workspace_root.path().join("imp.workspace.luau"),
            "return { imp = { jobs = 3, pilot = { enabled = true } } }\n",
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
            Some(&serde_json::json!({ "jobs": 3, "pilot": { "enabled": true } }))
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
