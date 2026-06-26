//! QuickJS-backed target, rule, and goal planning spike.
//!
//! `imp.workspace.js` imports plugin modules that register rules via
//! `__host_rule`.  Workspace `BUILD.js` files declare and export target handles
//! via `__host_target`.  The Rust engine resolves product requests into a task
//! DAG without executing it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use rquickjs::{
    loader::{Loader, Resolver},
    module::Declared,
    Array, CatchResultExt, Context as JsContext, Ctx, Filter, Function, Module, Object, Runtime,
    Value,
};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

const WORKSPACE_FILE: &str = "imp.workspace.js";
const BUILD_FILE: &str = "BUILD.js";

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
const CORE_JS: &str = r#"
/**
 * Declare a target and return a target handle.
 *
 * @param {object} opts
 * @param {string} opts.kind Stable target kind understood by extension rules.
 * @param {Record<string, string>} [opts.fields={}] String fields stored on the target.
 * @param {Array<object>} [opts.deps=[]] Dependencies as target handles returned by target().
 * @returns {object} An opaque target handle for exports and dependency lists.
 *
 * Constructors should perform domain validation in JavaScript and throw normal
 * Error objects for invalid arguments. The host validates only core invariants,
 * such as dependency values being target handles.
 */
export function target(opts) {
    const depIds = (opts.deps || []).map(d => {
        if (!d || d.__imp !== true) throw new Error('dep must be a target handle, got: ' + JSON.stringify(d));
        return d.__id;
    });
    return __host_target(opts.kind, opts.fields || {}, depIds);
}

/**
 * Register a rule for producing a product from a target kind.
 *
 * @param {object} opts
 * @param {string} opts.kind Target kind this rule applies to.
 * @param {string} opts.product Product name produced by the rule.
 * @param {string|object} opts.action Human-readable action template, or a
 * structured action object with argv/cwd/env/platform/inputs/outputs/display.
 * @param {boolean} [opts.requiresOwnSources=false] Whether non-source products depend on this target's sources product.
 * @param {string|null|undefined} [opts.dependencyProduct=null] Product requested from dependencies; use "default" for their default product.
 * @returns {void}
 */
export function rule(opts) {
    __host_rule(
        opts.kind, opts.product, opts.action,
        opts.requiresOwnSources === true,
        opts.dependencyProduct !== undefined ? opts.dependencyProduct : null
    );
}
"#;

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub address: String,
    pub kind: String,
    pub fields: BTreeMap<String, String>,
    pub dependencies: Vec<Dependency>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependency {
    pub address: String,
    pub mode: DependencyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DependencyMode {
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub target_kind: String,
    pub product: String,
    pub action: ActionSpec,
    pub requires_own_sources: bool,
    pub dependency_product: DependencyProduct,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyProduct {
    None,
    Named(String),
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionSpec {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub platform: Option<String>,
    pub inputs: Vec<ArtifactSpec>,
    pub outputs: Vec<ArtifactSpec>,
    pub display: String,
}

impl ActionSpec {
    fn legacy(display: String) -> Self {
        Self {
            argv: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            platform: None,
            inputs: Vec::new(),
            outputs: Vec::new(),
            display,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactSpec {
    pub id: Option<String>,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub value: Option<String>,
    pub producer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub platform: Option<String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub display: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub target: String,
    pub product: String,
    pub inputs: Vec<Artifact>,
    pub outputs: Vec<Artifact>,
    pub action: Action,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub goal: String,
    pub roots: Vec<String>,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub rules: BTreeMap<(String, String), Rule>,
    pub targets: BTreeMap<String, Target>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    DryRun,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskExecutionStatus {
    WouldRun,
    Ran,
    Noop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskExecution {
    pub task_id: String,
    pub status: TaskExecutionStatus,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    pub tasks: Vec<TaskExecution>,
}

// ---------------------------------------------------------------------------
// Internal host state
// ---------------------------------------------------------------------------

struct HostState {
    next_id: u32,
    pending: BTreeMap<u32, PendingTarget>,
    rules: BTreeMap<(String, String), Rule>,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            next_id: 0,
            pending: BTreeMap::new(),
            rules: BTreeMap::new(),
        }
    }
}

struct PendingTarget {
    kind: String,
    fields: BTreeMap<String, String>,
    dep_ids: Vec<u32>,
}

// ---------------------------------------------------------------------------
// QuickJS module resolver / loader
// ---------------------------------------------------------------------------

struct ImpResolver {
    workspace_root: PathBuf,
}

struct ImpLoader {
    workspace_root: PathBuf,
}

impl Resolver for ImpResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
    ) -> rquickjs::Result<String> {
        if name == "imp:core" {
            return Ok(name.to_owned());
        }

        if name.starts_with("imp:") {
            return Err(rquickjs::Error::new_resolving_message(
                base,
                name,
                format!(
                    "unknown built-in module '{name}' while importing from {}",
                    module_location(&self.workspace_root, base)
                ),
            ));
        }

        if name.starts_with("//") {
            let resolution =
                resolve_workspace_module(&self.workspace_root, name).map_err(|message| {
                    rquickjs::Error::new_resolving_message(
                        base,
                        name,
                        format!(
                            "{message} while importing from {}",
                            module_location(&self.workspace_root, base)
                        ),
                    )
                })?;
            return Ok(resolution.name);
        }

        if name.starts_with('.') {
            let importer = module_location(&self.workspace_root, base);
            let message = if module_kind(&self.workspace_root, base) == ModuleKind::Build {
                format!(
                    "relative import '{name}' is prohibited in BUILD.js module {importer}; use workspace-rooted //... imports or imp:* built-ins"
                )
            } else {
                format!(
                    "relative import '{name}' is unsupported in module {importer}; use workspace-rooted //... imports or imp:* built-ins"
                )
            };
            return Err(rquickjs::Error::new_resolving_message(base, name, message));
        }

        Err(rquickjs::Error::new_resolving_message(
            base,
            name,
            format!(
                "module specifier '{name}' is unsupported while importing from {}; use //... or imp:*",
                module_location(&self.workspace_root, base)
            ),
        ))
    }
}

impl Loader for ImpLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js, Declared>> {
        if name == "imp:core" {
            return Module::declare(ctx.clone(), name, CORE_JS);
        }

        if name.starts_with("//") {
            let resolution = resolve_workspace_module(&self.workspace_root, name)
                .map_err(|message| rquickjs::Error::new_loading_message(name, message))?;
            let source = std::fs::read_to_string(&resolution.path).map_err(|e| {
                rquickjs::Error::new_loading_message(
                    name,
                    format!("read {}: {e}", resolution.path.display()),
                )
            })?;
            return Module::declare(ctx.clone(), name, source);
        }

        Err(rquickjs::Error::new_loading(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModuleKind {
    BuiltIn,
    Build,
    Extension,
    Workspace,
    Unknown,
}

struct WorkspaceModuleResolution {
    name: String,
    path: PathBuf,
    kind: ModuleKind,
}

fn resolve_workspace_module(
    root: &Path,
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let rel = name
        .strip_prefix("//")
        .ok_or_else(|| format!("workspace module '{name}' must start with //"))?;
    validate_workspace_module_path(name, rel)?;

    let mut candidates = Vec::new();

    if rel.is_empty() {
        let build_path = root.join(BUILD_FILE);
        candidates.push(build_path.clone());
        if build_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: build_path,
                kind: ModuleKind::Build,
            });
        }
    } else {
        let js_path = root.join(format!("{rel}.js"));
        candidates.push(js_path.clone());
        if js_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: js_path,
                kind: ModuleKind::Extension,
            });
        }

        let build_path = root.join(rel).join(BUILD_FILE);
        candidates.push(build_path.clone());
        if build_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: build_path,
                kind: ModuleKind::Build,
            });
        }
    }

    let tried = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "cannot resolve workspace module '{name}'; tried {tried}"
    ))
}

fn validate_workspace_module_path(name: &str, rel: &str) -> std::result::Result<(), String> {
    if rel.starts_with('/') {
        return Err(format!("workspace module '{name}' must be relative to //"));
    }

    for component in Path::new(rel).components() {
        use std::path::Component;
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "workspace module '{name}' must not contain '.', '..', or platform prefixes"
                ));
            }
        }
    }
    Ok(())
}

fn module_kind(root: &Path, name: &str) -> ModuleKind {
    if name == "imp:core" {
        ModuleKind::BuiltIn
    } else if name == WORKSPACE_FILE {
        ModuleKind::Workspace
    } else if name.starts_with("//") {
        resolve_workspace_module(root, name)
            .map(|resolution| resolution.kind)
            .unwrap_or(ModuleKind::Unknown)
    } else {
        ModuleKind::Unknown
    }
}

fn module_location(root: &Path, name: &str) -> String {
    if name == "imp:core" {
        return "built-in imp:core".to_owned();
    }
    if name == WORKSPACE_FILE {
        return root.join(WORKSPACE_FILE).display().to_string();
    }
    if name.starts_with("//") {
        if let Ok(resolution) = resolve_workspace_module(root, name) {
            return resolution.path.display().to_string();
        }
    }
    name.to_owned()
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
pub fn load_workspace(root: &Path) -> Result<Workspace> {
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root {}", root.display()))?;

    let state: Arc<Mutex<HostState>> = Arc::new(Mutex::new(HostState::default()));

    // ----- QuickJS runtime + context -----
    let rt = Runtime::new().context("create QuickJS runtime")?;
    rt.set_loader(
        ImpResolver {
            workspace_root: root.clone(),
        },
        ImpLoader {
            workspace_root: root.clone(),
        },
    );
    let ctx = JsContext::full(&rt).context("create QuickJS context")?;

    // ----- Register host globals -----
    {
        let state_clone = Arc::clone(&state);
        ctx.with(|ctx| -> rquickjs::Result<()> { register_globals(ctx, state_clone) })
            .map_err(|e| anyhow::anyhow!("register QuickJS globals: {e}"))?;
    }

    // ----- Evaluate imp.workspace.js if present -----
    let workspace_js = root.join(WORKSPACE_FILE);
    if workspace_js.is_file() {
        let source = std::fs::read_to_string(&workspace_js)
            .with_context(|| format!("read {}", workspace_js.display()))?;
        ctx.with(|ctx| -> Result<()> {
            let module = Module::declare(ctx.clone(), WORKSPACE_FILE, source)
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let (_, promise) = module
                .eval()
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            promise
                .finish::<rquickjs::Value>()
                .catch(&ctx)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(())
        })
        .with_context(|| format!("evaluate {}", workspace_js.display()))?;
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
    let mut named_exports: Vec<(String, u32)> = Vec::new(); // (address, pending_id)

    for build_file in &build_files {
        let scope = scope_for(&root, build_file)?;
        let module_name = scope.clone();

        let exports = ctx
            .with(|ctx| -> Result<Vec<(String, u32)>> {
                // dynamic import → Promise<namespace>
                let promise = Module::import(&ctx, module_name.as_str())
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let ns: Object = promise
                    .finish()
                    .catch(&ctx)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;

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
            })
            .with_context(|| format!("process {}", build_file.display()))?;

        for (name, id) in exports {
            named_exports.push((format!("{scope}:{name}"), id));
        }
    }

    // ----- Resolve dep IDs to addresses -----
    let hs = state.lock().unwrap();
    let id_to_address: BTreeMap<u32, &str> = named_exports
        .iter()
        .map(|(addr, id)| (*id, addr.as_str()))
        .collect();

    let mut targets = BTreeMap::new();
    for (address, id) in &named_exports {
        let pending = hs
            .pending
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("no pending target for id {id}"))?;
        let deps = pending
            .dep_ids
            .iter()
            .map(|dep_id| {
                id_to_address
                    .get(dep_id)
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "dep id {dep_id} has no address (not exported from any BUILD.js)"
                        )
                    })
                    .map(|addr| Dependency {
                        address: addr.to_string(),
                        mode: DependencyMode::Auto,
                    })
            })
            .collect::<Result<Vec<_>>>()?;

        targets.insert(
            address.clone(),
            Target {
                address: address.clone(),
                kind: pending.kind.clone(),
                fields: pending.fields.clone(),
                dependencies: deps,
            },
        );
    }

    Ok(Workspace {
        rules: hs.rules.clone(),
        targets,
    })
}

/// Register `__host_target` and `__host_rule` as JS globals on `ctx`.
fn register_globals<'js>(ctx: Ctx<'js>, state: Arc<Mutex<HostState>>) -> rquickjs::Result<()> {
    let globals = ctx.globals();

    // ------------------------------------------------------------------
    // __host_target(kind, fields, depIds) → { __imp: true, __id: N }
    // ------------------------------------------------------------------
    let state_t = Arc::clone(&state);
    let host_target = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>,
              kind: String,
              fields: Object<'js>,
              dep_ids: Array<'js>|
              -> rquickjs::Result<Object<'js>> {
            let mut hs = state_t.lock().unwrap();
            let id = hs.next_id;
            hs.next_id += 1;

            // Extract string-valued fields from the JS object.
            let mut field_map: BTreeMap<String, String> = BTreeMap::new();
            for entry in fields.own_props::<String, Value>(Filter::default()) {
                let (k, v) = entry?;
                let s: String = v.get()?;
                field_map.insert(k, s);
            }

            // Extract numeric dep IDs from the JS array.
            let len = dep_ids.len();
            let mut dep_id_list = Vec::with_capacity(len);
            for i in 0..len {
                let dep_id: u32 = dep_ids.get(i)?;
                dep_id_list.push(dep_id);
            }

            hs.pending.insert(
                id,
                PendingTarget {
                    kind,
                    fields: field_map,
                    dep_ids: dep_id_list,
                },
            );

            // Return handle object.
            let handle = Object::new(ctx)?;
            handle.set("__imp", true)?;
            handle.set("__id", id)?;
            Ok(handle)
        },
    )?;
    globals.set("__host_target", host_target)?;

    // ------------------------------------------------------------------
    // __host_rule(kind, product, action, requiresOwnSources, depProduct)
    // ------------------------------------------------------------------
    let state_r = Arc::clone(&state);
    let host_rule = Function::new(
        ctx.clone(),
        move |kind: String,
              product: String,
              action_value: Value<'js>,
              requires_own_sources: bool,
              dep_prod_val: Value<'js>|
              -> rquickjs::Result<()> {
            let action = parse_rule_action(action_value)?;
            let dependency_product = if dep_prod_val.is_null() || dep_prod_val.is_undefined() {
                DependencyProduct::None
            } else {
                let s: String = dep_prod_val.get()?;
                if s == "default" {
                    DependencyProduct::Default
                } else {
                    DependencyProduct::Named(s)
                }
            };

            let key = (kind.clone(), product.clone());
            let mut hs = state_r.lock().unwrap();
            // Silently ignore duplicate rules (e.g., when a plugin is imported
            // by both workspace.js and a BUILD.js).
            if !hs.rules.contains_key(&key) {
                hs.rules.insert(
                    key,
                    Rule {
                        target_kind: kind,
                        product,
                        action,
                        requires_own_sources,
                        dependency_product,
                    },
                );
            }
            Ok(())
        },
    )?;
    globals.set("__host_rule", host_rule)?;

    Ok(())
}

fn parse_rule_action<'js>(action_value: Value<'js>) -> rquickjs::Result<ActionSpec> {
    if action_value.is_string() {
        return Ok(ActionSpec::legacy(action_value.get()?));
    }

    if !action_value.is_object() || action_value.is_array() {
        return Err(action_spec_error(format!(
            "rule action must be a string or object, got {}",
            action_value.type_name()
        )));
    }

    let action = action_value
        .as_object()
        .expect("checked object above")
        .clone();
    let argv = optional_string_array(&action, "argv", "action")?.unwrap_or_default();
    let cwd = optional_string(&action, "cwd", "action")?;
    let env = optional_string_map(&action, "env", "action")?.unwrap_or_default();
    let platform = optional_string(&action, "platform", "action")?;
    let inputs = optional_artifact_array(&action, "inputs")?.unwrap_or_default();
    let outputs = optional_artifact_array(&action, "outputs")?.unwrap_or_default();
    let display = optional_string(&action, "display", "action")?.unwrap_or_else(|| argv.join(" "));

    Ok(ActionSpec {
        argv,
        cwd,
        env,
        platform,
        inputs,
        outputs,
        display,
    })
}

fn optional_string<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<String>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_string() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be a string, got {}",
            value.type_name()
        )));
    }
    value.get().map(Some)
}

fn optional_string_array<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<Vec<String>>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_array() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be an array of strings, got {}",
            value.type_name()
        )));
    }
    let array: Array = value.get()?;
    let mut strings = Vec::with_capacity(array.len());
    for i in 0..array.len() {
        let item: Value = array.get(i)?;
        if !item.is_string() {
            return Err(action_spec_error(format!(
                "{context}.{key}[{i}] must be a string, got {}",
                item.type_name()
            )));
        }
        strings.push(item.get()?);
    }
    Ok(Some(strings))
}

fn optional_string_map<'js>(
    object: &Object<'js>,
    key: &'static str,
    context: &'static str,
) -> rquickjs::Result<Option<BTreeMap<String, String>>> {
    if !object.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = object.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_object() || value.is_array() {
        return Err(action_spec_error(format!(
            "{context}.{key} must be an object with string values, got {}",
            value.type_name()
        )));
    }
    let object = value.as_object().expect("checked object above");
    let mut strings = BTreeMap::new();
    for entry in object.own_props::<String, Value>(Filter::default()) {
        let (field, value) = entry?;
        if !value.is_string() {
            return Err(action_spec_error(format!(
                "{context}.{key}.{field} must be a string, got {}",
                value.type_name()
            )));
        }
        strings.insert(field, value.get()?);
    }
    Ok(Some(strings))
}

fn optional_artifact_array<'js>(
    action: &Object<'js>,
    key: &'static str,
) -> rquickjs::Result<Option<Vec<ArtifactSpec>>> {
    if !action.contains_key(key)? {
        return Ok(None);
    }
    let value: Value = action.get(key)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if !value.is_array() {
        return Err(action_spec_error(format!(
            "action.{key} must be an array of artifact specs, got {}",
            value.type_name()
        )));
    }
    let array: Array = value.get()?;
    let mut artifacts = Vec::with_capacity(array.len());
    for i in 0..array.len() {
        let item: Value = array.get(i)?;
        if !item.is_object() || item.is_array() {
            return Err(action_spec_error(format!(
                "action.{key}[{i}] must be an object, got {}",
                item.type_name()
            )));
        }
        let object = item.as_object().expect("checked object above");
        let kind = optional_string(object, "kind", "artifact")?
            .ok_or_else(|| action_spec_error(format!("action.{key}[{i}].kind is required")))?;
        if !matches!(kind.as_str(), "file" | "directory" | "manifest" | "value") {
            return Err(action_spec_error(format!(
                "action.{key}[{i}].kind must be file, directory, manifest, or value"
            )));
        }
        artifacts.push(ArtifactSpec {
            id: optional_string(object, "id", "artifact")?,
            kind,
            path: optional_string(object, "path", "artifact")?,
            value: optional_string(object, "value", "artifact")?,
        });
    }
    Ok(Some(artifacts))
}

fn action_spec_error(message: String) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("value", "ActionSpec", message)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

pub fn plan(workspace: &Workspace, goal: &str, selectors: &[String]) -> Result<Plan> {
    if goal != "build" {
        bail!("unknown goal '{goal}'; the spike currently implements build only");
    }

    let roots = select_roots(workspace, selectors)?;
    let mut planner = Planner {
        workspace,
        tasks: BTreeMap::new(),
    };
    let mut root_tasks = Vec::new();
    for target in roots {
        let product = planner.default_product(target)?;
        root_tasks.push(planner.request(&target.address, &product)?);
    }

    Ok(Plan {
        goal: goal.to_owned(),
        roots: root_tasks,
        tasks: planner.tasks.into_values().collect(),
    })
}

fn select_roots<'a>(workspace: &'a Workspace, selectors: &[String]) -> Result<Vec<&'a Target>> {
    let mut selected = BTreeMap::new();
    if selectors.is_empty() {
        for target in workspace.targets.values() {
            if default_product_for_kind(workspace, &target.kind).is_some() {
                selected.insert(target.address.as_str(), target);
            }
        }
    } else {
        for selector in selectors {
            let matches: Vec<_> = workspace
                .targets
                .values()
                .filter(|t| matches_selector(t, selector))
                .collect();
            if matches.is_empty() {
                bail!("no target matches selector '{selector}'");
            }
            for target in matches {
                if default_product_for_kind(workspace, &target.kind).is_none() {
                    bail!("{} has no build product", target.address);
                }
                selected.insert(target.address.as_str(), target);
            }
        }
    }
    Ok(selected.into_values().collect())
}

/// Infer the default product for a target kind from its registered rules.
/// Convention: the first non-`"sources"` rule is the default; if the only
/// rule produces `"sources"`, the kind has no build product.
fn default_product_for_kind<'a>(workspace: &'a Workspace, kind: &str) -> Option<&'a str> {
    let mut found_sources_only = false;
    let mut non_sources: Option<&str> = Option::None;

    for ((k, _), rule) in &workspace.rules {
        if k != kind {
            continue;
        }
        if rule.product != "sources" {
            non_sources = Some(rule.product.as_str());
            break;
        } else {
            found_sources_only = true;
        }
    }

    if non_sources.is_some() {
        return non_sources;
    }
    // Only "sources" rules → no build product.
    let _ = found_sources_only;
    Option::None
}

fn matches_selector(target: &Target, selector: &str) -> bool {
    target.address == selector
        || target.address.strip_prefix("//:") == Some(selector)
        || target.address.ends_with(&format!(":{selector}"))
}

struct Planner<'a> {
    workspace: &'a Workspace,
    tasks: BTreeMap<String, Task>,
}

impl Planner<'_> {
    fn default_product(&self, target: &Target) -> Result<String> {
        default_product_for_kind(self.workspace, &target.kind)
            .map(|s| s.to_owned())
            .ok_or_else(|| anyhow::anyhow!("{} has no build product", target.address))
    }

    fn request(&mut self, target_address: &str, product: &str) -> Result<String> {
        let id = format!("{target_address}#{product}");
        if self.tasks.contains_key(&id) {
            return Ok(id);
        }

        let target = self
            .workspace
            .targets
            .get(target_address)
            .ok_or_else(|| anyhow::anyhow!("target {target_address} does not exist"))?;
        let rule = self
            .workspace
            .rules
            .get(&(target.kind.clone(), product.to_owned()))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("{} cannot produce {product}", target.address))?;

        let mut dependencies = Vec::new();
        if rule.requires_own_sources && product != "sources" {
            dependencies.push(self.request(&target.address, "sources")?);
        }
        match &rule.dependency_product {
            DependencyProduct::None => {}
            DependencyProduct::Named(dep_product) => {
                let dep_product = dep_product.clone();
                for dep in &target.dependencies {
                    dependencies.push(self.request(&dep.address, &dep_product)?);
                }
            }
            DependencyProduct::Default => {
                for dep in &target.dependencies {
                    let dep_target = self.workspace.targets.get(&dep.address).ok_or_else(|| {
                        anyhow::anyhow!(
                            "{} depends on missing target {}",
                            target.address,
                            dep.address
                        )
                    })?;
                    let prod = self.default_product(dep_target)?;
                    dependencies.push(self.request(&dep.address, &prod)?);
                }
            }
        }

        let (action, inputs, outputs) = lower_action(&rule.action, target, &id);
        self.tasks.insert(
            id.clone(),
            Task {
                id: id.clone(),
                target: target.address.clone(),
                product: product.to_owned(),
                inputs,
                outputs,
                action,
                dependencies,
            },
        );
        Ok(id)
    }
}

// ---------------------------------------------------------------------------
// DOT rendering
// ---------------------------------------------------------------------------

pub fn render_dot(plan: &Plan) -> String {
    let node_ids: BTreeMap<_, _> = plan
        .tasks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), format!("task_{i}")))
        .collect();
    let root_ids: BTreeSet<_> = plan.roots.iter().map(String::as_str).collect();

    let mut dot = String::from(
        "digraph task_plan {\n  rankdir=TB;\n  node [shape=box, fontname=\"monospace\"];\n",
    );
    for task in &plan.tasks {
        let node_id = &node_ids[task.id.as_str()];
        let label = dot_escape(&format!("{}\n{}", task.id, task.action.display));
        let style = if root_ids.contains(task.id.as_str()) {
            ", peripheries=2"
        } else {
            ""
        };
        dot.push_str(&format!("  {node_id} [label=\"{label}\"{style}];\n"));
    }
    for task in &plan.tasks {
        let consumer = &node_ids[task.id.as_str()];
        for dep in &task.dependencies {
            if let Some(prereq) = node_ids.get(dep.as_str()) {
                dot.push_str(&format!("  {prereq} -> {consumer};\n"));
            }
        }
    }
    dot.push_str("}\n");
    dot
}

pub fn render_text_plan(plan: &Plan) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    writeln!(&mut out, "{} plan:", plan.goal).expect("write to String");
    writeln!(&mut out, "  roots:").expect("write to String");
    for root in &plan.roots {
        writeln!(&mut out, "    {root}").expect("write to String");
    }
    writeln!(&mut out, "  tasks:").expect("write to String");
    for task in &plan.tasks {
        let dependencies = if task.dependencies.is_empty() {
            String::new()
        } else {
            format!(" <- {}", task.dependencies.join(", "))
        };
        writeln!(
            &mut out,
            "    {}: {}{}",
            task.id, task.action.display, dependencies
        )
        .expect("write to String");
    }
    out
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

pub fn execute_plan(
    plan: &Plan,
    workspace_root: &Path,
    mode: ExecutionMode,
) -> Result<ExecutionReport> {
    let ordered = ordered_tasks(plan)?;
    let mut executions = Vec::with_capacity(ordered.len());

    for task in ordered {
        let command = task.action.argv.clone();
        let status = match mode {
            ExecutionMode::DryRun => TaskExecutionStatus::WouldRun,
            ExecutionMode::Local if command.is_empty() => TaskExecutionStatus::Noop,
            ExecutionMode::Local => {
                run_local_task(task, workspace_root)?;
                check_declared_outputs(task, workspace_root)?;
                TaskExecutionStatus::Ran
            }
        };

        executions.push(TaskExecution {
            task_id: task.id.clone(),
            status,
            command,
        });
    }

    Ok(ExecutionReport { tasks: executions })
}

fn ordered_tasks(plan: &Plan) -> Result<Vec<&Task>> {
    let mut pending: BTreeMap<&str, &Task> = plan
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let mut completed = BTreeSet::new();
    let mut ordered = Vec::with_capacity(plan.tasks.len());

    while !pending.is_empty() {
        let ready_ids: Vec<String> = pending
            .iter()
            .filter_map(|(id, task)| {
                let ready = task.dependencies.iter().all(|dep| completed.contains(dep));
                ready.then(|| (*id).to_owned())
            })
            .collect();

        if ready_ids.is_empty() {
            let unresolved = pending
                .values()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("task graph has unresolved dependencies or a cycle: {unresolved}");
        }

        for id in ready_ids {
            let task = pending
                .remove(id.as_str())
                .expect("ready id came from pending");
            for dep in &task.dependencies {
                if !completed.contains(dep)
                    && !plan.tasks.iter().any(|candidate| &candidate.id == dep)
                {
                    bail!("{} depends on missing task {dep}", task.id);
                }
            }
            completed.insert(id);
            ordered.push(task);
        }
    }

    Ok(ordered)
}

fn run_local_task(task: &Task, workspace_root: &Path) -> Result<()> {
    let cwd = task
        .action
        .cwd
        .as_deref()
        .map(|cwd| resolve_workspace_path(workspace_root, cwd))
        .unwrap_or_else(|| workspace_root.to_owned());
    let (program, args) = task
        .action
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("{} has no argv", task.id))?;

    let output = Command::new(program)
        .args(args)
        .current_dir(&cwd)
        .envs(&task.action.env)
        .output()
        .with_context(|| format!("execute {} in {}", task.id, cwd.display()))?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{} failed with status {}\nstdout:\n{}\nstderr:\n{}",
            task.id,
            output.status,
            stdout.trim_end(),
            stderr.trim_end()
        );
    }

    Ok(())
}

fn check_declared_outputs(task: &Task, workspace_root: &Path) -> Result<()> {
    for artifact in &task.outputs {
        let Some(path) = &artifact.path else {
            continue;
        };
        let path = resolve_workspace_path(workspace_root, path);
        match artifact.kind.as_str() {
            "file" | "manifest" if !path.is_file() => {
                bail!(
                    "{} declared {} output {} but it was not created as a file",
                    task.id,
                    artifact.kind,
                    path.display()
                );
            }
            "directory" if !path.is_dir() => {
                bail!(
                    "{} declared directory output {} but it was not created",
                    task.id,
                    path.display()
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn resolve_workspace_path(root: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
}

// ---------------------------------------------------------------------------
// Selection and formatting
// ---------------------------------------------------------------------------

pub fn select_targets<'a>(
    workspace: &'a Workspace,
    selectors: &[String],
) -> Result<Vec<&'a Target>> {
    if selectors.is_empty() {
        return Ok(workspace.targets.values().collect());
    }
    let mut selected = BTreeMap::new();
    for selector in selectors {
        let matches: Vec<_> = workspace
            .targets
            .values()
            .filter(|t| matches_selector(t, selector))
            .collect();
        if matches.is_empty() {
            bail!("no target matches selector '{selector}'");
        }
        for t in matches {
            selected.insert(t.address.as_str(), t);
        }
    }
    Ok(selected.into_values().collect())
}

pub fn format_targets(targets: &[&Target], w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;
    for target in targets {
        writeln!(w, "{} ({})", target.address, target.kind)?;
        if let Some(sources) = target.fields.get("sources") {
            if !sources.is_empty() {
                writeln!(w, "  sources: {sources}")?;
            }
        }
        if let Some(ep) = target.fields.get("entrypoint") {
            writeln!(w, "  entrypoint: {ep}")?;
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
        format_dep_tree(workspace, target, "", true, &mut visited, true, w)?;
    }
    Ok(())
}

fn format_dep_tree(
    workspace: &Workspace,
    target: &Target,
    prefix: &str,
    is_last: bool,
    visited: &mut BTreeSet<String>,
    is_root: bool,
    w: &mut String,
) -> Result<()> {
    use std::fmt::Write;
    let already = visited.contains(&target.address);

    if is_root {
        if already {
            writeln!(w, "{} (*)", target.address)?;
        } else {
            writeln!(w, "{}", target.address)?;
        }
    } else {
        let marker = if is_last { "└── " } else { "├── " };
        if already {
            writeln!(w, "{}{}{} (*)", prefix, marker, target.address)?;
        } else {
            writeln!(w, "{}{}{}", prefix, marker, target.address)?;
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
            format_dep_tree(
                workspace,
                dep_target,
                &next_prefix,
                dep_is_last,
                visited,
                false,
                w,
            )?;
        } else {
            let marker = if dep_is_last {
                "└── "
            } else {
                "├── "
            };
            writeln!(w, "{}{}{} <missing>", next_prefix, marker, dep.address)?;
        }
    }
    Ok(())
}

pub fn format_rules(workspace: &Workspace, w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;

    // Infer known kinds from registered rules.
    let kinds: BTreeSet<&str> = workspace.rules.keys().map(|(k, _)| k.as_str()).collect();

    writeln!(w, "Target Kinds:")?;
    if kinds.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        for kind in &kinds {
            let default_prod = default_product_for_kind(workspace, kind).unwrap_or("<none>");
            writeln!(w, "  - {kind} (default product: {default_prod})")?;
        }
    }
    writeln!(w)?;
    writeln!(w, "Rules:")?;
    if workspace.rules.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        let mut current_kind: Option<&str> = Option::None;
        for ((kind, _), rule) in &workspace.rules {
            if current_kind != Some(kind.as_str()) {
                current_kind = Some(kind.as_str());
                writeln!(w, "  {kind}:")?;
            }
            let dep_prod = match &rule.dependency_product {
                DependencyProduct::None => "none".to_owned(),
                DependencyProduct::Default => "default".to_owned(),
                DependencyProduct::Named(p) => format!("\"{p}\""),
            };
            writeln!(w, "    - {}:", rule.product)?;
            writeln!(w, "        action: {}", rule.action.display)?;
            writeln!(
                w,
                "        requires own sources: {}",
                rule.requires_own_sources
            )?;
            writeln!(w, "        dependency product: {dep_prod}")?;
        }
    }
    Ok(())
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

fn lower_action(
    spec: &ActionSpec,
    target: &Target,
    task_id: &str,
) -> (Action, Vec<Artifact>, Vec<Artifact>) {
    let inputs = lower_artifacts(&spec.inputs, target, task_id, "input", None);
    let outputs = lower_artifacts(&spec.outputs, target, task_id, "output", Some(task_id));
    let action = Action {
        argv: spec
            .argv
            .iter()
            .map(|value| expand_template(value, target))
            .collect(),
        cwd: spec
            .cwd
            .as_deref()
            .map(|value| expand_template(value, target)),
        env: spec
            .env
            .iter()
            .map(|(key, value)| (key.clone(), expand_template(value, target)))
            .collect(),
        platform: spec
            .platform
            .as_deref()
            .map(|value| expand_template(value, target)),
        inputs: inputs.iter().map(|artifact| artifact.id.clone()).collect(),
        outputs: outputs.iter().map(|artifact| artifact.id.clone()).collect(),
        display: expand_template(&spec.display, target),
    };
    (action, inputs, outputs)
}

fn lower_artifacts(
    specs: &[ArtifactSpec],
    target: &Target,
    task_id: &str,
    role: &str,
    producer: Option<&str>,
) -> Vec<Artifact> {
    specs
        .iter()
        .enumerate()
        .map(|(i, spec)| Artifact {
            id: spec
                .id
                .as_deref()
                .map(|value| expand_template(value, target))
                .unwrap_or_else(|| format!("{task_id}:{role}{i}")),
            kind: spec.kind.clone(),
            path: spec
                .path
                .as_deref()
                .map(|value| expand_template(value, target)),
            value: spec
                .value
                .as_deref()
                .map(|value| expand_template(value, target)),
            producer: producer.map(str::to_owned),
        })
        .collect()
}

fn expand_template(template: &str, target: &Target) -> String {
    let sources = target.fields.get("sources").cloned().unwrap_or_default();
    let entrypoint = target.fields.get("entrypoint").cloned().unwrap_or_default();
    template
        .replace("{address}", &target.address)
        .replace("{sources}", &sources)
        .replace("{entrypoint}", &entrypoint)
}

fn dot_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ---- Common rule JS strings ----------------------------------------

    const CPP_RULES_JS: &str = r#"
import { target, rule } from "imp:core";

rule({ kind: "cpp-sources",  product: "sources",             action: "snapshot {sources}",        requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "cmake-lib",    product: "native-link-library", action: "cmake --build {entrypoint}", requiresOwnSources: false, dependencyProduct: "sources" });

export function cppSources({ srcs }) {
    return target({ kind: "cpp-sources", fields: { sources: srcs.join(",") } });
}
export function cmakeLib({ entrypoint, deps = [] }) {
    return target({ kind: "cmake-lib", fields: { entrypoint }, deps });
}
"#;

    const ODIN_RULES_JS: &str = r#"
import { target, rule } from "imp:core";

rule({ kind: "odin-package", product: "sources",      action: "snapshot {sources}", requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "odin-package", product: "odin-package", action: "odin build",         requiresOwnSources: true,  dependencyProduct: "default" });

export function odinPackage({ srcs, deps = [] }) {
    return target({ kind: "odin-package", fields: { sources: srcs.join(",") }, deps });
}
"#;

    const ASSET_RULES_JS: &str = r#"
import { target, rule } from "imp:core";

rule({ kind: "asset", product: "sources", action: "snapshot {sources}", requiresOwnSources: false, dependencyProduct: null });
rule({ kind: "asset", product: "bundle",  action: "bundle {sources}",   requiresOwnSources: true,  dependencyProduct: null });

export function asset({ srcs }) {
    return target({ kind: "asset", fields: { sources: srcs.join(",") } });
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
import "//rules/cpp";
import "//rules/odin";
import "//rules/asset";
"#,
        )
        .unwrap();

        let rules = p.join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::write(rules.join("cpp.js"), CPP_RULES_JS).unwrap();
        std::fs::write(rules.join("odin.js"), ODIN_RULES_JS).unwrap();
        std::fs::write(rules.join("asset.js"), ASSET_RULES_JS).unwrap();

        // src/cpp/joltphysics/BUILD.js
        let cpp = p.join("src/cpp/joltphysics");
        std::fs::create_dir_all(&cpp).unwrap();
        std::fs::write(
            cpp.join(BUILD_FILE),
            r#"
import { cppSources, cmakeLib } from "//rules/cpp";

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

export const jodin = odinPackage({ srcs: ["*.odin"], deps: [cmake] });
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

    fn executable_task(id: &str, deps: &[&str], argv: &[&str], output: Option<&str>) -> Task {
        let outputs = output
            .map(|path| {
                vec![Artifact {
                    id: format!("{id}:out"),
                    kind: "file".to_owned(),
                    path: Some(path.to_owned()),
                    value: None,
                    producer: Some(id.to_owned()),
                }]
            })
            .unwrap_or_default();

        Task {
            id: id.to_owned(),
            target: "//:fixture".to_owned(),
            product: "fixture".to_owned(),
            inputs: Vec::new(),
            action: Action {
                argv: argv.iter().map(|arg| (*arg).to_owned()).collect(),
                cwd: None,
                env: BTreeMap::new(),
                platform: None,
                inputs: Vec::new(),
                outputs: outputs.iter().map(|artifact| artifact.id.clone()).collect(),
                display: argv.join(" "),
            },
            outputs,
            dependencies: deps.iter().map(|dep| (*dep).to_owned()).collect(),
        }
    }

    // ---- Tests ---------------------------------------------------------

    #[test]
    fn workspace_loads_config_before_build_files() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        // Rules registered by workspace.js imports.
        assert!(workspace
            .rules
            .contains_key(&("odin-package".into(), "odin-package".into())));
        assert!(workspace
            .rules
            .contains_key(&("asset".into(), "bundle".into())));

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

    #[test]
    fn workspace_root_is_discovered_from_a_nested_directory() {
        let root = fixture();
        let nested = root.path().join("library/jodin");
        assert_eq!(find_workspace_root(&nested).unwrap(), root.path());
    }

    #[test]
    fn build_goal_plans_transitive_products() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["//library/jodin:jodin".into()]).unwrap();

        assert_eq!(plan.roots, ["//library/jodin:jodin#odin-package"]);
        assert_eq!(plan.tasks.len(), 4);

        let jodin = plan
            .tasks
            .iter()
            .find(|t| t.id == "//library/jodin:jodin#odin-package")
            .unwrap();
        assert_eq!(
            jodin.dependencies,
            [
                "//library/jodin:jodin#sources",
                "//src/cpp/joltphysics:cmake#native-link-library",
            ]
        );
    }

    #[test]
    fn new_target_kinds_and_rules_need_no_rust_changes() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["//assets:ui".into()]).unwrap();

        assert_eq!(plan.roots, ["//assets:ui#bundle"]);
        assert_eq!(plan.tasks.len(), 2);
        assert!(plan
            .tasks
            .iter()
            .any(|t| t.action.display.contains("**/*.png")));
    }

    #[test]
    fn legacy_action_plans_round_trip_through_json() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["jodin".into()]).unwrap();

        let encoded = serde_json::to_string_pretty(&plan).unwrap();
        assert!(encoded.contains("\"goal\": \"build\""));
        assert!(encoded.contains("\"display\": \"odin build\""));

        let decoded: Plan = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, plan);
        assert_eq!(render_dot(&decoded), render_dot(&plan));
    }

    #[test]
    fn structured_rule_actions_lower_to_serializable_tasks() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "//rules/generator";
"#,
        );
        write_file(
            &p.join("rules/generator.js"),
            r#"
import { target, rule } from "imp:core";

rule({
  kind: "generator",
  product: "generated",
  action: {
    argv: ["gen-tool", "{sources}"],
    cwd: "{entrypoint}",
    env: { TARGET: "{address}" },
    platform: "local",
    inputs: [{ kind: "file", path: "{sources}" }],
    outputs: [{ id: "{address}#out", kind: "file", path: "build/{entrypoint}.out" }],
    display: "generate {sources}"
  }
});

export function generator({ srcs, entrypoint }) {
  return target({ kind: "generator", fields: { sources: srcs.join(","), entrypoint } });
}
"#,
        );
        write_file(
            &p.join(BUILD_FILE),
            r#"
import { generator } from "//rules/generator";

export const schema = generator({ srcs: ["schema.idl"], entrypoint: "schemas" });
"#,
        );

        let workspace = load_workspace(p).unwrap();
        let plan = plan(&workspace, "build", &["schema".into()]).unwrap();
        let task = plan
            .tasks
            .iter()
            .find(|task| task.id == "//:schema#generated")
            .unwrap();

        assert_eq!(task.action.argv, ["gen-tool", "schema.idl"]);
        assert_eq!(task.action.cwd.as_deref(), Some("schemas"));
        assert_eq!(task.action.env["TARGET"], "//:schema");
        assert_eq!(task.action.platform.as_deref(), Some("local"));
        assert_eq!(task.action.display, "generate schema.idl");
        assert_eq!(task.inputs[0].id, "//:schema#generated:input0");
        assert_eq!(task.inputs[0].kind, "file");
        assert_eq!(task.inputs[0].path.as_deref(), Some("schema.idl"));
        assert_eq!(task.inputs[0].producer, None);
        assert_eq!(task.outputs[0].id, "//:schema#out");
        assert_eq!(task.outputs[0].path.as_deref(), Some("build/schemas.out"));
        assert_eq!(
            task.outputs[0].producer.as_deref(),
            Some("//:schema#generated")
        );
        assert_eq!(task.action.inputs, ["//:schema#generated:input0"]);
        assert_eq!(task.action.outputs, ["//:schema#out"]);
    }

    #[test]
    fn dry_run_executor_uses_dependency_order_without_running_commands() {
        let root = tempfile::tempdir().unwrap();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec!["consumer".to_owned()],
            tasks: vec![
                executable_task("consumer", &["producer"], &["sh", "-c", "exit 1"], None),
                executable_task("producer", &[], &["sh", "-c", "exit 1"], None),
            ],
        };

        let report = execute_plan(&plan, root.path(), ExecutionMode::DryRun).unwrap();
        let ids: Vec<_> = report
            .tasks
            .iter()
            .map(|execution| execution.task_id.as_str())
            .collect();
        assert_eq!(ids, ["producer", "consumer"]);
        assert!(report
            .tasks
            .iter()
            .all(|execution| execution.status == TaskExecutionStatus::WouldRun));
    }

    #[test]
    fn local_executor_runs_commands_and_checks_declared_outputs() {
        let root = tempfile::tempdir().unwrap();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec!["write".to_owned()],
            tasks: vec![executable_task(
                "write",
                &[],
                &["sh", "-c", "mkdir -p build && printf ok > build/out.txt"],
                Some("build/out.txt"),
            )],
        };

        let report = execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap();
        assert_eq!(report.tasks[0].status, TaskExecutionStatus::Ran);
        assert_eq!(
            std::fs::read_to_string(root.path().join("build/out.txt")).unwrap(),
            "ok"
        );
    }

    #[test]
    fn local_executor_reports_missing_declared_outputs() {
        let root = tempfile::tempdir().unwrap();
        let plan = Plan {
            goal: "build".to_owned(),
            roots: vec!["missing".to_owned()],
            tasks: vec![executable_task(
                "missing",
                &[],
                &["sh", "-c", "true"],
                Some("build/missing.txt"),
            )],
        };

        let error = format!(
            "{:#}",
            execute_plan(&plan, root.path(), ExecutionMode::Local).unwrap_err()
        );
        assert!(error.contains("declared file output"), "{error}");
        assert!(error.contains("build/missing.txt"), "{error}");
    }

    #[test]
    fn root_relative_imports_can_resolve_build_directory_modules() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        let jodin = &workspace.targets["//library/jodin:jodin"];
        assert_eq!(jodin.dependencies[0].address, "//src/cpp/joltphysics:cmake");
    }

    #[test]
    fn relative_imports_from_build_files_are_rejected_with_context() {
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

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("relative import './rules/asset' is prohibited in BUILD.js"),
            "{error}"
        );
        assert!(error.contains("BUILD.js"), "{error}");
        assert!(error.contains("//..."), "{error}");
    }

    #[test]
    fn unknown_builtin_modules_are_reported_distinctly() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        write_file(
            &p.join(WORKSPACE_FILE),
            r#"
import "imp:missing";
"#,
        );
        write_file(&p.join(BUILD_FILE), "export const ignored = 1;\n");

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("unknown built-in module 'imp:missing'"),
            "{error}"
        );
        assert!(error.contains(WORKSPACE_FILE), "{error}");
    }

    #[test]
    fn missing_workspace_modules_report_importer_and_candidates() {
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

        let error = format!("{:#}", load_workspace(p).unwrap_err());
        assert!(
            error.contains("cannot resolve workspace module '//rules/missing'"),
            "{error}"
        );
        assert!(error.contains("rules/missing.js"), "{error}");
        assert!(error.contains("rules/missing/BUILD.js"), "{error}");
        assert!(error.contains(BUILD_FILE), "{error}");
    }

    #[test]
    fn test_select_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        let all = select_targets(&workspace, &[]).unwrap();
        // joltphysics, cmake, jodin, ui = 4
        assert_eq!(all.len(), 4);

        let sel = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].address, "//library/jodin:jodin");

        assert!(select_targets(&workspace, &["nonexistent".to_owned()]).is_err());
    }

    #[test]
    fn test_format_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let targets = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        let mut out = String::new();
        format_targets(&targets, &mut out).unwrap();
        assert!(out.contains("//library/jodin:jodin (odin-package)"));
        assert!(out.contains("sources: *.odin"));
        assert!(out.contains("dependencies: //src/cpp/joltphysics:cmake"));
    }

    #[test]
    fn test_format_dependencies() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let mut out = String::new();
        format_dependencies(&workspace, &["jodin".to_owned()], &mut out).unwrap();
        let expected = "\
//library/jodin:jodin
└── //src/cpp/joltphysics:cmake
    └── //src/cpp/joltphysics:joltphysics
";
        assert_eq!(out, expected);
    }

    #[test]
    fn test_format_rules() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let mut out = String::new();
        format_rules(&workspace, &mut out).unwrap();
        assert!(out.contains("Target Kinds:"));
        assert!(out.contains("  - odin-package (default product: odin-package)"));
        assert!(out.contains("Rules:"));
        assert!(out.contains("  odin-package:"));
        assert!(out.contains("    - odin-package:"));
        assert!(out.contains("        action: odin build"));
        assert!(out.contains("        requires own sources: true"));
        assert!(out.contains("        dependency product: default"));
    }

    #[test]
    fn dot_edges_flow_from_prerequisites_to_consumers() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let plan = plan(&workspace, "build", &["jodin".into()]).unwrap();
        let dot = render_dot(&plan);

        assert!(dot.contains("rankdir=TB"));
        assert!(dot.contains("//src/cpp/joltphysics:joltphysics#sources"));
        assert!(dot.contains(" -> "));
    }
}
