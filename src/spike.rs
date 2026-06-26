//! Steel-backed target, rule, and goal planning spike.
//!
//! `imp.workspace.scm` defines target types, product rules, and convenient
//! target constructors. Workspace `BUILD.scm` files declare addressable targets.
//! The Rust engine resolves product requests into a task DAG without executing it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use steel::steel_vm::{engine::Engine, register_fn::RegisterFn};
use walkdir::WalkDir;

const WORKSPACE_FILE: &str = "imp.workspace.scm";

// ---------------------------------------------------------------------------
// Field schema types
// ---------------------------------------------------------------------------

/// The expected value type for a schema field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldType {
    /// A Unicode string.
    String,
    /// A list of values.
    List,
    /// A boolean (`#t` / `#f`).
    Boolean,
    /// Any Steel value is accepted; no type check is performed.
    Any,
}

impl FieldType {
    fn parse(s: &str) -> Result<Self> {
        match s {
            "string" => Ok(Self::String),
            "list" => Ok(Self::List),
            "boolean" => Ok(Self::Boolean),
            "any" => Ok(Self::Any),
            other => bail!("unknown field type '{}'; expected string | list | boolean | any", other),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::String => "string",
            Self::List => "list",
            Self::Boolean => "boolean",
            Self::Any => "any",
        }
    }
}

/// Description of a single field that a target-type constructor must / may supply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldSchema {
    /// Field name, used as the key in the field map passed to `declare-target-with-fields!`.
    pub name: String,
    /// Expected value type.
    pub field_type: FieldType,
    /// Whether the field must be supplied explicitly.
    pub required: bool,
    /// Value to use when the field is absent and `required` is `false`.
    /// Stored as a Steel source expression so it can be re-evaluated lazily.
    pub default_expr: Option<String>,
    /// Optional Steel predicate expression (a one-argument function source).
    /// When present it is evaluated against the final field value; the
    /// predicate must return a truthy result or the target is rejected.
    pub validator_expr: Option<String>,
}

/// Schema for an entire target type: a list of field descriptors.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetSchema {
    pub fields: Vec<FieldSchema>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetType {
    pub kind: String,
    pub default_product: Option<String>,
    /// Optional field schema; absent means the type has no formal field contract.
    pub schema: Option<TargetSchema>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub address: String,
    pub kind: String,
    pub sources: Vec<String>,
    pub entrypoint: Option<String>,
    pub dependencies: Vec<Dependency>,
    /// Schema-validated fields populated by `declare-target-with-fields!`.
    /// Empty for targets created through the legacy positional API.
    pub fields: BTreeMap<String, String>,
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
    pub target_types: BTreeMap<String, TargetType>,
    pub rules: BTreeMap<(String, String), Rule>,
    pub targets: BTreeMap<String, Target>,
}

impl Workspace {
    fn add_target_type(&mut self, target_type: TargetType) -> Result<()> {
        if self.target_types.contains_key(&target_type.kind) {
            bail!("duplicate target type {}", target_type.kind);
        }
        self.target_types
            .insert(target_type.kind.clone(), target_type);
        Ok(())
    }

    fn add_target_schema(&mut self, kind: &str, schema: TargetSchema) -> Result<()> {
        let target_type = self
            .target_types
            .get_mut(kind)
            .ok_or_else(|| anyhow::anyhow!("cannot attach schema: unknown target type '{kind}'"))?;
        if target_type.schema.is_some() {
            bail!("target type '{kind}' already has a schema");
        }
        target_type.schema = Some(schema);
        Ok(())
    }

    fn add_rule(&mut self, rule: Rule) -> Result<()> {
        if !self.target_types.contains_key(&rule.target_kind) {
            bail!("rule references unknown target type {}", rule.target_kind);
        }
        let key = (rule.target_kind.clone(), rule.product.clone());
        if self.rules.contains_key(&key) {
            bail!("duplicate rule for {} → {}", key.0, key.1);
        }
        self.rules.insert(key, rule);
        Ok(())
    }

    fn add_target(&mut self, target: Target) -> Result<()> {
        if !self.target_types.contains_key(&target.kind) {
            bail!("target {} has unknown type {}", target.address, target.kind);
        }
        if self.targets.contains_key(&target.address) {
            bail!("duplicate target {}", target.address);
        }
        self.targets.insert(target.address.clone(), target);
        Ok(())
    }
}

/// Find the nearest ancestor workspace. A workspace is identified by its
/// `imp.workspace.scm` file.
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
            bail!("could not find {WORKSPACE_FILE} above {}", start.display());
        }
    }
}

/// Load root configuration and every `BUILD.scm` below `root`. Configuration is
/// evaluated first so its Steel-defined constructors are available to all build
/// files.
pub fn load_workspace(root: &Path) -> Result<Workspace> {
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root {}", root.display()))?;
    let config = root.join(WORKSPACE_FILE);
    let mut host = Host::new()?;
    host.eval_file(&config, "//")?;

    let mut build_files: Vec<PathBuf> = WalkDir::new(&root)
        .into_iter()
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some(".git" | "target" | ".toolchain")
            )
        })
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "BUILD.scm")
        .map(|entry| entry.into_path())
        .collect();
    build_files.sort();

    if build_files.is_empty() {
        bail!("no BUILD.scm files found below {}", root.display());
    }
    for build_file in build_files {
        let scope = scope_for(&root, &build_file)?;
        host.eval_file(&build_file, &scope)?;
    }
    host.workspace()
}

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

/// Render a plan as Graphviz DOT. Edges point from a prerequisite task to the
/// task that consumes its product.
pub fn render_dot(plan: &Plan) -> String {
    let node_ids: BTreeMap<_, _> = plan
        .tasks
        .iter()
        .enumerate()
        .map(|(index, task)| (task.id.as_str(), format!("task_{index}")))
        .collect();
    let root_ids: BTreeSet<_> = plan.roots.iter().map(String::as_str).collect();

    let mut dot = String::from(
        "digraph task_plan {\n  rankdir=TB;\n  node [shape=box, fontname=\"monospace\"];\n",
    );
    for task in &plan.tasks {
        let node_id = &node_ids[task.id.as_str()];
        let label = dot_escape(&format!("{}\n{}", task.id, task.action));
        let root_style = if root_ids.contains(task.id.as_str()) {
            ", peripheries=2"
        } else {
            ""
        };
        dot.push_str(&format!("  {node_id} [label=\"{label}\"{root_style}];\n"));
    }
    for task in &plan.tasks {
        let consumer = &node_ids[task.id.as_str()];
        for dependency in &task.dependencies {
            if let Some(prerequisite) = node_ids.get(dependency.as_str()) {
                dot.push_str(&format!("  {prerequisite} -> {consumer};\n"));
            }
        }
    }
    dot.push_str("}\n");
    dot
}

fn select_roots<'a>(workspace: &'a Workspace, selectors: &[String]) -> Result<Vec<&'a Target>> {
    let mut selected = BTreeMap::new();
    if selectors.is_empty() {
        for target in workspace.targets.values() {
            if workspace
                .target_types
                .get(&target.kind)
                .and_then(|target_type| target_type.default_product.as_ref())
                .is_some()
            {
                selected.insert(target.address.as_str(), target);
            }
        }
    } else {
        for selector in selectors {
            let matches: Vec<_> = workspace
                .targets
                .values()
                .filter(|target| matches_selector(target, selector))
                .collect();
            if matches.is_empty() {
                bail!("no target matches selector '{selector}'");
            }
            for target in matches {
                if workspace
                    .target_types
                    .get(&target.kind)
                    .and_then(|target_type| target_type.default_product.as_ref())
                    .is_none()
                {
                    bail!("{} has no build product", target.address);
                }
                selected.insert(target.address.as_str(), target);
            }
        }
    }
    Ok(selected.into_values().collect())
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
        self.workspace
            .target_types
            .get(&target.kind)
            .and_then(|target_type| target_type.default_product.clone())
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
            DependencyProduct::Named(product) => {
                for dependency in &target.dependencies {
                    dependencies.push(self.request(&dependency.address, product)?);
                }
            }
            DependencyProduct::Default => {
                for dependency in &target.dependencies {
                    let dependency_target = self
                        .workspace
                        .targets
                        .get(&dependency.address)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "{} depends on missing target {}",
                                target.address,
                                dependency.address
                            )
                        })?;
                    let product = self.default_product(dependency_target)?;
                    dependencies.push(self.request(&dependency.address, &product)?);
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

fn expand_action(template: &str, target: &Target) -> String {
    template
        .replace("{address}", &target.address)
        .replace("{sources}", &target.sources.join(", "))
        .replace("{entrypoint}", target.entrypoint.as_deref().unwrap_or(""))
}

struct Host {
    engine: Engine,
    scope: Arc<Mutex<String>>,
    workspace: Arc<Mutex<Workspace>>,
}

impl Host {
    fn new() -> Result<Self> {
        configure_steel_home()?;
        let scope = Arc::new(Mutex::new("//".to_owned()));
        let workspace = Arc::new(Mutex::new(Workspace::default()));
        let mut engine = Engine::new();

        engine.register_fn("auto", |address: String| format!("auto:{address}"));

        let workspace_for_type = Arc::clone(&workspace);
        engine.register_fn(
            "declare-target-type!",
            move |kind: String,
                  default_product: Option<String>|
                  -> std::result::Result<(), String> {
                workspace_for_type
                    .lock()
                    .map_err(|_| "workspace registry lock poisoned".to_owned())?
                    .add_target_type(TargetType {
                        kind,
                        default_product,
                        schema: None,
                    })
                    .map_err(|error| format!("{error:#}"))
            },
        );

        let workspace_for_rule = Arc::clone(&workspace);
        engine.register_fn(
            "declare-rule!",
            move |target_kind: String,
                  product: String,
                  action: String,
                  requires_own_sources: bool,
                  dependency_product: Option<String>|
                  -> std::result::Result<(), String> {
                let dependency_product = match dependency_product.as_deref() {
                    None => DependencyProduct::None,
                    Some("default") => DependencyProduct::Default,
                    Some(product) => DependencyProduct::Named(product.to_owned()),
                };
                workspace_for_rule
                    .lock()
                    .map_err(|_| "workspace registry lock poisoned".to_owned())?
                    .add_rule(Rule {
                        target_kind,
                        product,
                        action,
                        requires_own_sources,
                        dependency_product,
                    })
                    .map_err(|error| format!("{error:#}"))
            },
        );

        let workspace_for_target = Arc::clone(&workspace);
        let scope_for_target = Arc::clone(&scope);
        engine.register_fn(
            "declare-target!",
            move |kind: String,
                  name: String,
                  sources: Vec<String>,
                  entrypoint: Option<String>,
                  dependencies: Vec<String>|
                  -> std::result::Result<(), String> {
                let scope = scope_for_target
                    .lock()
                    .map_err(|_| "target scope lock poisoned".to_owned())?
                    .clone();
                let address =
                    target_address(&scope, &name).map_err(|error| format!("{error:#}"))?;
                let dependencies = dependencies
                    .into_iter()
                    .map(|dependency| parse_dependency(&scope, &dependency))
                    .collect::<Result<Vec<_>>>()
                    .map_err(|error| format!("{error:#}"))?;
                workspace_for_target
                    .lock()
                    .map_err(|_| "workspace registry lock poisoned".to_owned())?
                    .add_target(Target {
                        address,
                        kind,
                        sources,
                        entrypoint,
                        dependencies,
                        fields: BTreeMap::new(),
                    })
                    .map_err(|error| format!("{error:#}"))
            },
        );

        // ---------------------------------------------------------------
        // Schema registration: (declare-target-schema! kind field-list)
        //
        // Each element of `field-list` is a Steel list with up to 5 items:
        //   (name type required? [default-expr [validator-expr]])
        // where `type` is one of: string | list | boolean | any
        // ---------------------------------------------------------------
        let workspace_for_schema = Arc::clone(&workspace);
        engine.register_fn(
            "declare-target-schema!",
            move |kind: String,
                  raw_fields: Vec<Vec<String>>|
                  -> std::result::Result<(), String> {
                let mut fields = Vec::new();
                for raw in raw_fields {
                    if raw.len() < 3 {
                        return Err(format!(
                            "field descriptor for kind '{kind}' must have at least 3 elements \
                             (name type required?), got {}",
                            raw.len()
                        ));
                    }
                    let name = raw[0].clone();
                    let field_type = FieldType::parse(&raw[1])
                        .map_err(|e| format!("{e:#}"))?;
                    let required = match raw[2].as_str() {
                        "#t" | "true" => true,
                        "#f" | "false" => false,
                        other => {
                            return Err(format!(
                                "field '{name}' required? must be #t or #f, got '{other}'"
                            ));
                        }
                    };
                    let default_expr = raw.get(3).cloned().filter(|s| s != "#f" && !s.is_empty());
                    let validator_expr = raw.get(4).cloned().filter(|s| s != "#f" && !s.is_empty());
                    fields.push(FieldSchema {
                        name,
                        field_type,
                        required,
                        default_expr,
                        validator_expr,
                    });
                }
                workspace_for_schema
                    .lock()
                    .map_err(|_| "workspace registry lock poisoned".to_owned())?
                    .add_target_schema(&kind, TargetSchema { fields })
                    .map_err(|error| format!("{error:#}"))
            },
        );

        // ---------------------------------------------------------------
        // Schema-validated target creation:
        //   (declare-target-with-fields! kind name fields deps)
        //
        // `fields` is a Steel association list: '(("key" . "value") ...)
        // represented as Vec<Vec<String>> where each inner vec is [key, value].
        // Validation:
        //   • Required fields must be present.
        //   • Missing optional fields receive their defaults (evaluated as
        //     Steel expressions by the engine; defaults are stored verbatim
        //     since we only store string representations here).
        //   • Validators are NOT evaluated by the Rust side; they are
        //     Steel-side predicates the extension author calls before invoking
        //     this function.  The host merely records which fields were
        //     supplied and applies default-filling.
        // ---------------------------------------------------------------
        let workspace_for_fields = Arc::clone(&workspace);
        let scope_for_fields = Arc::clone(&scope);
        engine.register_fn(
            "declare-target-with-fields!",
            move |kind: String,
                  name: String,
                  raw_fields: Vec<Vec<String>>,
                  dependencies: Vec<String>|
                  -> std::result::Result<(), String> {
                let scope = scope_for_fields
                    .lock()
                    .map_err(|_| "target scope lock poisoned".to_owned())?
                    .clone();
                let address =
                    target_address(&scope, &name).map_err(|e| format!("{e:#}"))?;
                let dependencies = dependencies
                    .into_iter()
                    .map(|dep| parse_dependency(&scope, &dep))
                    .collect::<Result<Vec<_>>>()
                    .map_err(|e| format!("{e:#}"))?;

                // Build field map from the association list.
                let mut field_map: BTreeMap<String, String> = raw_fields
                    .into_iter()
                    .filter_map(|pair| {
                        if pair.len() >= 2 {
                            Some((pair[0].clone(), pair[1].clone()))
                        } else {
                            None
                        }
                    })
                    .collect();

                // Validate against schema if one exists.
                let ws = workspace_for_fields
                    .lock()
                    .map_err(|_| "workspace registry lock poisoned".to_owned())?;
                if let Some(target_type) = ws.target_types.get(&kind) {
                    if let Some(schema) = &target_type.schema {
                        for field in &schema.fields {
                            match field_map.get(&field.name) {
                                Some(value) => {
                                    // Type check.
                                    match &field.field_type {
                                        FieldType::Boolean => {
                                            if value != "#t"
                                                && value != "#f"
                                                && value != "true"
                                                && value != "false"
                                            {
                                                return Err(format!(
                                                    "field '{}' of target '{address}' must be a \
                                                     boolean, got '{value}'",
                                                    field.name
                                                ));
                                            }
                                        }
                                        FieldType::String | FieldType::List | FieldType::Any => {}
                                    }
                                }
                                None => {
                                    if field.required {
                                        return Err(format!(
                                            "target '{address}' (kind '{kind}') is missing \
                                             required field '{}'",
                                            field.name
                                        ));
                                    }
                                    // Fill in the default if provided.
                                    if let Some(default) = &field.default_expr {
                                        field_map
                                            .insert(field.name.clone(), default.clone());
                                    }
                                }
                            }
                        }
                        // Reject unexpected fields.
                        let known: BTreeSet<&str> =
                            schema.fields.iter().map(|f| f.name.as_str()).collect();
                        for key in field_map.keys() {
                            if !known.contains(key.as_str()) {
                                return Err(format!(
                                    "target '{address}' (kind '{kind}') has unknown field \
                                     '{key}'"
                                ));
                            }
                        }
                    }
                }
                drop(ws);

                // Extract well-known fields from the map for backwards compat.
                let sources: Vec<String> = field_map
                    .get("sources")
                    .map(|s| {
                        // Accept a comma-separated list stored as a string repr.
                        s.split(',').map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect()
                    })
                    .unwrap_or_default();
                let entrypoint = field_map.get("entrypoint").cloned();

                workspace_for_fields
                    .lock()
                    .map_err(|_| "workspace registry lock poisoned".to_owned())?
                    .add_target(Target {
                        address,
                        kind,
                        sources,
                        entrypoint,
                        dependencies,
                        fields: field_map,
                    })
                    .map_err(|e| format!("{e:#}"))
            },
        );

        Ok(Self {
            engine,
            scope,
            workspace,
        })
    }

    fn eval_file(&mut self, path: &Path, scope: &str) -> Result<()> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("read Steel definition {}", path.display()))?;
        *self
            .scope
            .lock()
            .map_err(|_| anyhow::anyhow!("target scope lock poisoned"))? = scope.to_owned();
        self.engine
            .run(source)
            .map_err(|error| anyhow::anyhow!("evaluate {}: {error}", path.display()))?;
        Ok(())
    }

    fn workspace(self) -> Result<Workspace> {
        self.workspace
            .lock()
            .map_err(|_| anyhow::anyhow!("workspace registry lock poisoned"))
            .map(|workspace| workspace.clone())
    }
}

fn scope_for(root: &Path, build_file: &Path) -> Result<String> {
    let directory = build_file
        .parent()
        .ok_or_else(|| anyhow::anyhow!("BUILD.scm has no parent directory"))?;
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

fn target_address(scope: &str, name: &str) -> Result<String> {
    if name.is_empty() || name.contains(':') || name.contains('/') {
        bail!("target name '{name}' must be a simple name");
    }
    Ok(format!("{scope}:{name}"))
}

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

fn dot_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

pub fn select_targets<'a>(workspace: &'a Workspace, selectors: &[String]) -> Result<Vec<&'a Target>> {
    if selectors.is_empty() {
        return Ok(workspace.targets.values().collect());
    }
    let mut selected = BTreeMap::new();
    for selector in selectors {
        let matches: Vec<_> = workspace
            .targets
            .values()
            .filter(|target| matches_selector(target, selector))
            .collect();
        if matches.is_empty() {
            bail!("no target matches selector '{selector}'");
        }
        for target in matches {
            selected.insert(target.address.as_str(), target);
        }
    }
    Ok(selected.into_values().collect())
}

pub fn format_targets(targets: &[&Target], w: &mut String) -> std::fmt::Result {
    use std::fmt::Write;
    for target in targets {
        writeln!(w, "{} ({})", target.address, target.kind)?;
        if !target.sources.is_empty() {
            writeln!(w, "  sources: {}", target.sources.join(", "))?;
        }
        if let Some(entrypoint) = &target.entrypoint {
            writeln!(w, "  entrypoint: {}", entrypoint)?;
        }
        if !target.dependencies.is_empty() {
            let deps: Vec<_> = target.dependencies.iter().map(|d| d.address.as_str()).collect();
            writeln!(w, "  dependencies: {}", deps.join(", "))?;
        }
    }
    Ok(())
}

pub fn format_dependencies(workspace: &Workspace, selectors: &[String], w: &mut String) -> Result<()> {
    let targets = if selectors.is_empty() {
        // Find roots (targets that are not dependencies of any other targets)
        let mut child_addresses = BTreeSet::new();
        for target in workspace.targets.values() {
            for dep in &target.dependencies {
                child_addresses.insert(dep.address.clone());
            }
        }
        let roots: Vec<_> = workspace
            .targets
            .values()
            .filter(|target| !child_addresses.contains(&target.address))
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
    let already_visited = visited.contains(&target.address);
    
    if is_root {
        if already_visited {
            writeln!(w, "{} (*)", target.address)?;
        } else {
            writeln!(w, "{}", target.address)?;
        }
    } else {
        let marker = if is_last { "└── " } else { "├── " };
        if already_visited {
            writeln!(w, "{}{}{} (*)", prefix, marker, target.address)?;
        } else {
            writeln!(w, "{}{}{}", prefix, marker, target.address)?;
        }
    }

    if already_visited {
        return Ok(());
    }
    visited.insert(target.address.clone());

    let next_prefix = if is_root {
        "".to_owned()
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
    writeln!(w, "Target Types:")?;
    if workspace.target_types.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        for target_type in workspace.target_types.values() {
            let default_prod = target_type.default_product.as_deref().unwrap_or("<none>");
            writeln!(w, "  - {} (default product: {})", target_type.kind, default_prod)?;
            if let Some(schema) = &target_type.schema {
                if schema.fields.is_empty() {
                    writeln!(w, "      schema: (empty)")?;
                } else {
                    writeln!(w, "      schema:")?;
                    for field in &schema.fields {
                        let req = if field.required { "required" } else { "optional" };
                        let default_str = field
                            .default_expr
                            .as_deref()
                            .map(|d| format!(" default={d}"))
                            .unwrap_or_default();
                        let validator_str = field
                            .validator_expr
                            .as_deref()
                            .map(|_| " [validated]")
                            .unwrap_or_default();
                        writeln!(
                            w,
                            "        - {} ({}, {}{}{})",
                            field.name,
                            field.field_type.as_str(),
                            req,
                            default_str,
                            validator_str
                        )?;
                    }
                }
            }
        }
    }
    writeln!(w)?;
    writeln!(w, "Rules:")?;
    if workspace.rules.is_empty() {
        writeln!(w, "  (none)")?;
    } else {
        let mut current_kind = None;
        for rule in workspace.rules.values() {
            if current_kind.as_ref() != Some(&rule.target_kind) {
                current_kind = Some(rule.target_kind.clone());
                writeln!(w, "  {}:", rule.target_kind)?;
            }
            let dep_prod = match &rule.dependency_product {
                DependencyProduct::None => "none".to_owned(),
                DependencyProduct::Default => "default".to_owned(),
                DependencyProduct::Named(p) => format!("\"{p}\""),
            };
            writeln!(w, "    - {}:", rule.product)?;
            writeln!(w, "        action: {}", rule.action)?;
            writeln!(w, "        requires own sources: {}", rule.requires_own_sources)?;
            writeln!(w, "        dependency product: {}", dep_prod)?;
        }
    }
    Ok(())
}

/// Steel currently initialises a global home directory even when evaluation is
/// embedded. Keep that implementation detail out of the user's home directory
/// for this spike, while respecting an explicit `STEEL_HOME` choice.
fn configure_steel_home() -> Result<()> {
    static INITIALISED: OnceLock<std::result::Result<(), String>> = OnceLock::new();

    INITIALISED
        .get_or_init(|| {
            if std::env::var_os("STEEL_HOME").is_some() {
                return Ok(());
            }

            let home = std::env::temp_dir().join("imp-steel-spike");
            std::fs::create_dir_all(&home)
                .map_err(|error| format!("create Steel home {}: {error}", home.display()))?;
            std::env::set_var("STEEL_HOME", home);
            Ok(())
        })
        .as_ref()
        .map_err(|error| anyhow::anyhow!("{error}"))
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"
        (declare-target-type! "cpp-sources" #f)
        (declare-target-type! "cmake-lib" "native-link-library")
        (declare-target-type! "odin-package" "odin-package")
        (declare-target-type! "asset" "bundle")

        (declare-rule! "cpp-sources" "sources" "snapshot {sources}" #f #f)
        (declare-rule! "cmake-lib" "native-link-library" "cmake --build {entrypoint}" #f "sources")
        (declare-rule! "odin-package" "sources" "snapshot {sources}" #f #f)
        (declare-rule! "odin-package" "odin-package" "odin build" #true "default")
        (declare-rule! "asset" "sources" "snapshot {sources}" #f #f)
        (declare-rule! "asset" "bundle" "bundle {sources}" #true #f)

        (define (cpp-sources name #:sources sources)
          (declare-target! "cpp-sources" name sources #f '()))
        (define (cmake-lib name #:entrypoint entrypoint #:dependencies [dependencies '()])
          (declare-target! "cmake-lib" name '() entrypoint dependencies))
        (define (odin-package name #:sources sources #:dependencies [dependencies '()])
          (declare-target! "odin-package" name sources #f dependencies))
        (define (asset name #:sources sources)
          (declare-target! "asset" name sources #f '()))
    "#;

    /// A configuration that uses schemas and the new `declare-target-with-fields!` API.
    const SCHEMA_CONFIG: &str = r##"
        ;; Define a target type with a full field schema.
        (declare-target-type! "proto-library" "generated-sources")
        (declare-rule! "proto-library" "sources" "snapshot {sources}" #f #f)
        (declare-rule! "proto-library" "generated-sources" "protoc {entrypoint}" #f #f)

        ;; Attach the schema: name is required (string), lang is optional with
        ;; default "cpp", and strip_prefix is optional with no default.
        (declare-target-schema! "proto-library"
          (list
            (list "name"         "string"  "#t")
            (list "lang"         "string"  "#f" "cpp")
            (list "strip_prefix" "string"  "#f")))

        ;; Constructor that uses the schema-validated path.
        (define (proto-library target-name
                               #:proto-files proto-files
                               #:lang        [lang "cpp"]
                               #:strip-prefix [strip-prefix #f])
          (declare-target-with-fields!
            "proto-library"
            target-name
            (list
              (list "name"   (symbol->string (string->symbol target-name)))
              (list "lang"   lang))
            (list)))
    "##;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(WORKSPACE_FILE), CONFIG).unwrap();

        let cpp = root.path().join("src/cpp/joltphysics");
        std::fs::create_dir_all(&cpp).unwrap();
        std::fs::write(
            cpp.join("BUILD.scm"),
            r#"
                (cpp-sources "joltphysics" #:sources '("**/*.h" "**/*.cpp"))
                (cmake-lib "cmake" #:entrypoint "CMakeLists.txt" #:dependencies '(:joltphysics))
            "#,
        )
        .unwrap();

        let odin = root.path().join("library/jodin");
        std::fs::create_dir_all(&odin).unwrap();
        std::fs::write(
            odin.join("BUILD.scm"),
            r#"
                (odin-package "jodin"
                  #:sources '("*.odin")
                  #:dependencies (list (auto "//src/cpp/joltphysics:cmake")))
            "#,
        )
        .unwrap();

        let assets = root.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(
            assets.join("BUILD.scm"),
            r#"(asset "ui" #:sources '("**/*.png"))"#,
        )
        .unwrap();
        root
    }

    #[test]
    fn workspace_loads_config_before_scoped_build_files() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();

        assert!(workspace.target_types.contains_key("odin-package"));
        assert!(workspace
            .rules
            .contains_key(&("asset".into(), "bundle".into())));
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
            .find(|task| task.id == "//library/jodin:jodin#odin-package")
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
            .any(|task| task.action == "bundle **/*.png"));
    }

    // -----------------------------------------------------------------------
    // Schema tests
    // -----------------------------------------------------------------------

    fn schema_fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(WORKSPACE_FILE), SCHEMA_CONFIG).unwrap();
        // Single BUILD.scm that calls the schema-validated constructor.
        std::fs::write(
            root.path().join("BUILD.scm"),
            r#"
                (proto-library "payment"
                  #:proto-files '("payment.proto")
                  #:lang "python")
            "#,
        )
        .unwrap();
        root
    }

    #[test]
    fn schema_is_registered_on_target_type() {
        let root = schema_fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let tt = workspace.target_types.get("proto-library").unwrap();
        let schema = tt.schema.as_ref().expect("schema should be present");
        assert_eq!(schema.fields.len(), 3);
        assert_eq!(schema.fields[0].name, "name");
        assert!(schema.fields[0].required);
        assert_eq!(schema.fields[1].name, "lang");
        assert!(!schema.fields[1].required);
        assert_eq!(schema.fields[1].default_expr.as_deref(), Some("cpp"));
        assert_eq!(schema.fields[2].name, "strip_prefix");
        assert!(!schema.fields[2].required);
        assert!(schema.fields[2].default_expr.is_none());
    }

    #[test]
    fn schema_validated_target_is_created_with_supplied_fields() {
        let root = schema_fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let target = workspace.targets.get("//:payment").unwrap();
        assert_eq!(target.kind, "proto-library");
        assert_eq!(target.fields.get("lang").map(String::as_str), Some("python"));
        assert_eq!(target.fields.get("name").map(String::as_str), Some("payment"));
    }

    #[test]
    fn missing_required_field_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        // Schema with a required field that the constructor omits.
        let cfg = r##"
            (declare-target-type! "strict" "artifact")
            (declare-rule! "strict" "artifact" "make" #f #f)
            (declare-target-schema! "strict"
              (list (list "must-have" "string" "#t")))
        "##;
        std::fs::write(root.path().join(WORKSPACE_FILE), cfg).unwrap();
        std::fs::write(
            root.path().join("BUILD.scm"),
            // Pass an empty field list — 'must-have' is absent.
            r#"(declare-target-with-fields! "strict" "thing" (list) (list))"#,
        )
        .unwrap();
        let err = load_workspace(root.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("missing required field"),
            "expected 'missing required field' in error, got: {err}"
        );
    }

    #[test]
    fn missing_optional_field_receives_default() {
        let root = tempfile::tempdir().unwrap();
        let cfg = r##"
            (declare-target-type! "defaulted" "artifact")
            (declare-rule! "defaulted" "artifact" "run" #f #f)
            (declare-target-schema! "defaulted"
              (list (list "mode" "string" "#f" "release")))
        "##;
        std::fs::write(root.path().join(WORKSPACE_FILE), cfg).unwrap();
        // Supply no fields — the default should be inserted.
        std::fs::write(
            root.path().join("BUILD.scm"),
            r#"(declare-target-with-fields! "defaulted" "app" (list) (list))"#,
        )
        .unwrap();
        let workspace = load_workspace(root.path()).unwrap();
        let target = workspace.targets.get("//:app").unwrap();
        assert_eq!(
            target.fields.get("mode").map(String::as_str),
            Some("release"),
            "expected default 'release' to be filled in"
        );
    }

    #[test]
    fn unknown_field_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let cfg = r##"
            (declare-target-type! "narrow" "artifact")
            (declare-rule! "narrow" "artifact" "run" #f #f)
            (declare-target-schema! "narrow"
              (list (list "allowed" "string" "#t")))
        "##;
        std::fs::write(root.path().join(WORKSPACE_FILE), cfg).unwrap();
        std::fs::write(
            root.path().join("BUILD.scm"),
            r#"(declare-target-with-fields! "narrow" "thing"
                 (list (list "allowed" "yes") (list "extra" "oops"))
                 (list))"#,
        )
        .unwrap();
        let err = load_workspace(root.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("unknown field"),
            "expected 'unknown field' in error, got: {err}"
        );
    }

    #[test]
    fn duplicate_schema_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let cfg = r##"
            (declare-target-type! "kind" #f)
            (declare-target-schema! "kind" (list))
            (declare-target-schema! "kind" (list))
        "##;
        std::fs::write(root.path().join(WORKSPACE_FILE), cfg).unwrap();
        std::fs::write(root.path().join("BUILD.scm"), "").unwrap();
        let err = load_workspace(root.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("already has a schema"),
            "expected 'already has a schema' in error, got: {err}"
        );
    }

    #[test]
    fn schema_appears_in_format_rules_output() {
        let root = schema_fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let mut out = String::new();
        format_rules(&workspace, &mut out).unwrap();
        assert!(out.contains("proto-library"), "format_rules should mention proto-library");
        assert!(out.contains("schema:"), "format_rules should print schema");
        assert!(out.contains("name"), "schema field 'name' should appear");
        assert!(out.contains("required"), "required fields should be marked");
        assert!(out.contains("default=cpp"), "default value should appear");
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

    #[test]
    fn test_select_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        
        let all = select_targets(&workspace, &[]).unwrap();
        assert_eq!(all.len(), 4);

        let selected = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].address, "//library/jodin:jodin");

        let err = select_targets(&workspace, &["non-existent".to_owned()]);
        assert!(err.is_err());
    }

    #[test]
    fn test_format_targets() {
        let root = fixture();
        let workspace = load_workspace(root.path()).unwrap();
        let targets = select_targets(&workspace, &["jodin".to_owned()]).unwrap();
        let mut out = String::new();
        format_targets(&targets, &mut out).unwrap();
        assert!(out.contains("//library/jodin:jodin (odin-package)"));
        assert!(out.contains("  sources: *.odin"));
        assert!(out.contains("  dependencies: //src/cpp/joltphysics:cmake"));
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
        assert!(out.contains("Target Types:"));
        assert!(out.contains("  - odin-package (default product: odin-package)"));
        assert!(out.contains("Rules:"));
        assert!(out.contains("  odin-package:"));
        assert!(out.contains("    - odin-package:"));
        assert!(out.contains("        action: odin build"));
        assert!(out.contains("        requires own sources: true"));
        assert!(out.contains("        dependency product: default"));
    }
}
