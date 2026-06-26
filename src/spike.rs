//! QuickJS-backed target, rule, and goal planning spike.
//!
//! `imp.workspace.js` imports plugin modules that register rules via
//! `__host_rule`.  Workspace `BUILD.js` files declare and export target handles
//! via `__host_target`.  The Rust engine resolves product requests into a task
//! DAG without executing it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use rquickjs::{
    loader::{Loader, Resolver},
    module::Declared,
    Array, Context as JsContext, Ctx, Filter, Function, Module, Object, Runtime, Value,
};
use walkdir::WalkDir;

const WORKSPACE_FILE: &str = "imp.workspace.js";
const BUILD_FILE: &str = "BUILD.js";

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
const CORE_JS: &str = r#"
export function target(opts) {
    const depIds = (opts.deps || []).map(d => {
        if (!d || d.__imp !== true) throw new Error('dep must be a target handle, got: ' + JSON.stringify(d));
        return d.__id;
    });
    return __host_target(opts.kind, opts.fields || {}, depIds);
}
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub address: String,
    pub kind: String,
    pub fields: BTreeMap<String, String>,
    pub dependencies: Vec<Dependency>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub address: String,
    pub mode: DependencyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DependencyMode {
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub target_kind: String,
    pub product: String,
    pub action: String,
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
pub struct Task {
    pub id: String,
    pub target: String,
    pub product: String,
    pub action: String,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

struct ImpResolver;
struct ImpLoader {
    workspace_root: PathBuf,
}

impl Resolver for ImpResolver {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, _base: &str, name: &str) -> rquickjs::Result<String> {
        // All module names are already canonical (absolute `//` paths or `imp:*`).
        Ok(name.to_owned())
    }
}

impl Loader for ImpLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js, Declared>> {
        if name == "imp:core" {
            return Module::declare(ctx.clone(), name, CORE_JS);
        }

        if let Some(rel) = name.strip_prefix("//") {
            // Try `{root}/{rel}.js` first (plugin / rule files like `//rules/cpp`).
            let js_path = self.workspace_root.join(format!("{rel}.js"));
            if js_path.exists() {
                let source = std::fs::read_to_string(&js_path)
                    .map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?;
                return Module::declare(ctx.clone(), name, source);
            }

            // Fall back to `{root}/{rel}/BUILD.js` (or `{root}/BUILD.js` when rel is empty).
            let build_path = if rel.is_empty() {
                self.workspace_root.join(BUILD_FILE)
            } else {
                self.workspace_root.join(rel).join(BUILD_FILE)
            };
            if build_path.exists() {
                let source = std::fs::read_to_string(&build_path)
                    .map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?;
                return Module::declare(ctx.clone(), name, source);
            }
        }

        Err(rquickjs::Error::new_loading(name))
    }
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
    rt.set_loader(ImpResolver, ImpLoader { workspace_root: root.clone() });
    let ctx = JsContext::full(&rt).context("create QuickJS context")?;

    // ----- Register host globals -----
    {
        let state_clone = Arc::clone(&state);
        ctx.with(|ctx| -> rquickjs::Result<()> {
            register_globals(ctx, state_clone)
        })
        .map_err(|e| anyhow::anyhow!("register QuickJS globals: {e}"))?;
    }

    // ----- Evaluate imp.workspace.js if present -----
    let workspace_js = root.join(WORKSPACE_FILE);
    if workspace_js.is_file() {
        let source = std::fs::read_to_string(&workspace_js)
            .with_context(|| format!("read {}", workspace_js.display()))?;
        ctx.with(|ctx| -> rquickjs::Result<()> {
            let module = Module::declare(ctx.clone(), WORKSPACE_FILE, source)?;
            let (_, promise) = module.eval()?;
            promise.finish::<rquickjs::Value>()?;
            Ok(())
        })
        .map_err(|e| anyhow::anyhow!("evaluate {}: {e}", workspace_js.display()))?;
    }

    // ----- Collect BUILD.js files -----
    let mut build_files: Vec<PathBuf> = WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| {
            !matches!(e.file_name().to_str(), Some(".git" | "target" | ".toolchain" | ".claude"))
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
            .with(|ctx| -> rquickjs::Result<Vec<(String, u32)>> {
                // dynamic import → Promise<namespace>
                let promise = Module::import(&ctx, module_name.as_str())?;
                let ns: Object = promise.finish()?;

                let mut result = Vec::new();
                for entry in ns.own_props::<String, Value>(Filter::default()) {
                    let (key, val) = entry?;
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
            .map_err(|e| {
                anyhow::anyhow!("process {}: {e}", build_file.display())
            })?;

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
                        anyhow::anyhow!("dep id {dep_id} has no address (not exported from any BUILD.js)")
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
              action: String,
              requires_own_sources: bool,
              dep_prod_val: Value<'js>|
              -> rquickjs::Result<()> {
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
                    let dep_target = self
                        .workspace
                        .targets
                        .get(&dep.address)
                        .ok_or_else(|| {
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

        let action = expand_action(&rule.action, target);
        self.tasks.insert(
            id.clone(),
            Task {
                id: id.clone(),
                target: target.address.clone(),
                product: product.to_owned(),
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
        let label = dot_escape(&format!("{}\n{}", task.id, task.action));
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
            let deps: Vec<_> = target.dependencies.iter().map(|d| d.address.as_str()).collect();
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
            format_dep_tree(workspace, dep_target, &next_prefix, dep_is_last, visited, false, w)?;
        } else {
            let marker = if dep_is_last { "└── " } else { "├── " };
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
            writeln!(w, "        action: {}", rule.action)?;
            writeln!(w, "        requires own sources: {}", rule.requires_own_sources)?;
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

fn expand_action(template: &str, target: &Target) -> String {
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

    // ---- Tests ---------------------------------------------------------

    #[test]
    fn workspace_loads_config_before_build_files() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        // Rules registered by workspace.js imports.
        assert!(workspace.rules.contains_key(&("odin-package".into(), "odin-package".into())));
        assert!(workspace.rules.contains_key(&("asset".into(), "bundle".into())));

        // Targets declared by BUILD.js files.
        assert!(workspace.targets.contains_key("//src/cpp/joltphysics:joltphysics"));
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
        assert!(plan.tasks.iter().any(|t| t.action.contains("**/*.png")));
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
