use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use include_dir::{include_dir, Dir};
use rquickjs::{
    loader::{ImportAttributes, Loader, Resolver},
    Ctx, Module,
};

use crate::changed::ImportGraph;
use crate::spike::{BUILD_FILE, WORKSPACE_FILE};

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
pub(crate) const CORE_JS: &str = include_str!("imp_core.js");

/// imp's own rule library (rules/**), compiled into the binary so an
/// installed imp works outside a checkout of this repo. `RulesSource::Dev`
/// bypasses this in favor of a live on-disk directory (see below).
static EMBEDDED_RULES: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../rules");

/// Environment variable that, when set, points `//rules/...` at a live
/// on-disk directory instead of the compiled-in copy — for developing
/// against a checked-out copy of imp's rules from an external project.
pub(crate) const RULES_DIR_ENV: &str = "IMP_RULES_DIR";

// ---------------------------------------------------------------------------
// QuickJS module resolver / loader
// ---------------------------------------------------------------------------

pub(crate) struct ImpResolver {
    pub(crate) workspace_root: PathBuf,
    pub(crate) rules_source: RulesSource,
    /// Import edges recorded for changed-target detection. QuickJS calls
    /// `resolve` for every import statement, including ones whose module is
    /// already cached, so the recorded graph is complete.
    pub(crate) import_graph: Arc<Mutex<ImportGraph>>,
}

pub(crate) struct ImpLoader {
    pub(crate) workspace_root: PathBuf,
    pub(crate) rules_source: RulesSource,
}

/// Where imp's built-in `//rules/...` modules come from. Only consulted
/// as a fallback when a `//rules/...` specifier isn't found under the
/// workspace root itself (e.g. a project vendoring/overriding its own copy).
#[derive(Debug, Clone)]
pub(crate) enum RulesSource {
    Embedded,
    Dev(PathBuf),
}

impl RulesSource {
    pub(crate) fn from_env() -> Self {
        match std::env::var_os(RULES_DIR_ENV) {
            Some(value) if !value.is_empty() => RulesSource::Dev(PathBuf::from(value)),
            _ => RulesSource::Embedded,
        }
    }
}

impl ImpResolver {
    fn record_import(&self, base: &str, resolution: &WorkspaceModuleResolution) {
        let mut graph = self.import_graph.lock().unwrap();
        graph
            .importers
            .entry(resolution.name.clone())
            .or_default()
            .insert(base.to_owned());
        // Only on-disk files under the workspace root can appear in a git
        // diff; embedded rules and external dev-rules directories can't.
        let ModuleSource::File(path) = &resolution.source else {
            return;
        };
        let Ok(relative) = path.strip_prefix(&self.workspace_root) else {
            return;
        };
        let relative = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let scope = (resolution.kind == ModuleKind::Build)
            .then(|| package_scope_for_build_file(path, &self.workspace_root))
            .flatten();
        graph.record_module_file(relative, &resolution.name, scope.as_deref());
    }
}

/// The package scope (`//dir`, or `//` at the root) a BUILD.js file defines.
fn package_scope_for_build_file(path: &Path, workspace_root: &Path) -> Option<String> {
    let directory = path.parent()?.strip_prefix(workspace_root).ok()?;
    if directory.as_os_str().is_empty() {
        return Some("//".to_owned());
    }
    Some(format!(
        "//{}",
        directory
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    ))
}

impl Resolver for ImpResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
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
                    module_location(&self.workspace_root, &self.rules_source, base)
                ),
            ));
        }

        if name.starts_with("//") {
            let resolution =
                resolve_workspace_module(&self.workspace_root, &self.rules_source, name).map_err(
                    |message| {
                        rquickjs::Error::new_resolving_message(
                            base,
                            name,
                            format!(
                                "{message} while importing from {}",
                                module_location(&self.workspace_root, &self.rules_source, base)
                            ),
                        )
                    },
                )?;
            self.record_import(base, &resolution);
            return Ok(resolution.name);
        }

        if name.starts_with('.') {
            let importer = module_location(&self.workspace_root, &self.rules_source, base);
            let message = if module_kind(&self.workspace_root, &self.rules_source, base)
                == ModuleKind::Build
            {
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
                module_location(&self.workspace_root, &self.rules_source, base)
            ),
        ))
    }
}

impl Loader for ImpLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js>> {
        if name == "imp:core" {
            return Module::declare(ctx.clone(), name, CORE_JS);
        }

        if name.starts_with("//") {
            let resolution =
                resolve_workspace_module(&self.workspace_root, &self.rules_source, name)
                    .map_err(|message| rquickjs::Error::new_loading_message(name, message))?;
            let source = match resolution.source {
                ModuleSource::File(path) => std::fs::read_to_string(&path).map_err(|e| {
                    rquickjs::Error::new_loading_message(
                        name,
                        format!("read {}: {e}", path.display()),
                    )
                })?,
                ModuleSource::Embedded(contents) => contents.to_owned(),
            };
            return Module::declare(ctx.clone(), name, source);
        }

        Err(rquickjs::Error::new_loading(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModuleKind {
    BuiltIn,
    Build,
    Extension,
    Workspace,
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) enum ModuleSource {
    File(PathBuf),
    Embedded(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModuleForm {
    Direct,
    Index,
    Build,
}

pub(crate) struct WorkspaceModuleResolution {
    pub(crate) name: String,
    pub(crate) source: ModuleSource,
    pub(crate) kind: ModuleKind,
    pub(crate) form: ModuleForm,
}

pub(crate) fn resolve_workspace_module(
    root: &Path,
    rules: &RulesSource,
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let rel = name
        .strip_prefix("//")
        .ok_or_else(|| format!("workspace module '{name}' must start with //"))?;
    validate_workspace_module_path(name, rel)?;

    match resolve_workspace_module_in_root(root, name, rel) {
        Ok(resolution) => Ok(resolution),
        Err(root_err) => {
            if rel == "rules" || rel.starts_with("rules/") {
                let builtin_rel = rel.strip_prefix("rules").unwrap().trim_start_matches('/');
                resolve_builtin_rules_module(rules, name, builtin_rel)
                    .map_err(|rules_err| format!("{root_err}; {rules_err}"))
            } else {
                Err(root_err)
            }
        }
    }
}

fn resolve_workspace_module_in_root(
    root: &Path,
    name: &str,
    rel: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let mut candidates = Vec::new();

    if rel.is_empty() {
        let build_path = root.join(BUILD_FILE);
        candidates.push(build_path.clone());
        if build_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                source: ModuleSource::File(build_path),
                kind: ModuleKind::Build,
                form: ModuleForm::Build,
            });
        }
    } else {
        if rel == "BUILD" || rel.ends_with("/BUILD") {
            let build_path = root.join(format!("{rel}.js"));
            candidates.push(build_path.clone());
            if build_path.is_file() {
                return Ok(WorkspaceModuleResolution {
                    name: name.to_owned(),
                    source: ModuleSource::File(build_path),
                    kind: ModuleKind::Build,
                    form: ModuleForm::Direct,
                });
            }
        }

        let js_path = root.join(format!("{rel}.js"));
        candidates.push(js_path.clone());
        if js_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                source: ModuleSource::File(js_path),
                kind: ModuleKind::Extension,
                form: ModuleForm::Direct,
            });
        }

        let index_path = root.join(rel).join("index.js");
        candidates.push(index_path.clone());
        if index_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                source: ModuleSource::File(index_path),
                kind: ModuleKind::Extension,
                form: ModuleForm::Index,
            });
        }

        let build_path = root.join(rel).join(BUILD_FILE);
        candidates.push(build_path.clone());
        if build_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                source: ModuleSource::File(build_path),
                kind: ModuleKind::Build,
                form: ModuleForm::Build,
            });
        }
    }

    let tried = candidates
        .iter()
        .map(|path| {
            path.strip_prefix(root)
                .unwrap_or(path)
                .display()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "cannot resolve workspace module '{name}'; tried {tried}"
    ))
}

/// Resolves `//rules/<rel>` (where `rel` has the leading `rules/` already
/// stripped) against imp's built-in rule library: a live on-disk
/// directory in dev mode, or the compiled-in copy otherwise.
fn resolve_builtin_rules_module(
    rules: &RulesSource,
    name: &str,
    rel: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    match rules {
        RulesSource::Dev(dir) => resolve_workspace_module_in_root(dir, name, rel),
        RulesSource::Embedded => resolve_embedded_rules_module(name, rel),
    }
}

fn resolve_embedded_rules_module(
    name: &str,
    rel: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let mut tried = Vec::new();

    let js_path = format!("{rel}.js");
    tried.push(js_path.clone());
    if let Some(file) = EMBEDDED_RULES.get_file(&js_path) {
        return embedded_module(name, file, ModuleKind::Extension, ModuleForm::Direct);
    }

    let index_path = format!("{rel}/index.js");
    tried.push(index_path.clone());
    if let Some(file) = EMBEDDED_RULES.get_file(&index_path) {
        return embedded_module(name, file, ModuleKind::Extension, ModuleForm::Index);
    }

    let build_path = format!("{rel}/{BUILD_FILE}");
    tried.push(build_path.clone());
    if let Some(file) = EMBEDDED_RULES.get_file(&build_path) {
        return embedded_module(name, file, ModuleKind::Build, ModuleForm::Build);
    }

    Err(format!(
        "cannot resolve built-in rules module '{name}'; tried embedded rules/{}",
        tried.join(", embedded rules/")
    ))
}

fn embedded_module(
    name: &str,
    file: &'static include_dir::File<'static>,
    kind: ModuleKind,
    form: ModuleForm,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let contents = file.contents_utf8().ok_or_else(|| {
        format!(
            "embedded rules file '{}' is not valid UTF-8",
            file.path().display()
        )
    })?;
    Ok(WorkspaceModuleResolution {
        name: name.to_owned(),
        source: ModuleSource::Embedded(contents),
        kind,
        form,
    })
}

/// Resolve a workspace-addressed data file (e.g.
/// `//rules/python/ruff-toolchain.lock`) to its contents. Unlike module
/// resolution, no `.js`/`index.js`/`BUILD.js` candidates are tried — the
/// address names the file exactly. Precedence mirrors module resolution:
/// a file under the workspace root wins, with the built-in rules tree as a
/// fallback for `//rules/...` addresses. Returns `Ok(None)` when no source
/// has the file.
pub(crate) fn resolve_workspace_file(
    root: &Path,
    rules: &RulesSource,
    name: &str,
) -> std::result::Result<Option<String>, String> {
    let rel = name
        .strip_prefix("//")
        .ok_or_else(|| format!("workspace file '{name}' must start with //"))?;
    validate_workspace_module_path(name, rel)?;
    if rel.is_empty() {
        return Err(format!("workspace file '{name}' must name a file"));
    }

    let workspace_path = root.join(rel);
    if workspace_path.is_file() {
        return std::fs::read_to_string(&workspace_path)
            .map(Some)
            .map_err(|e| format!("read {}: {e}", workspace_path.display()));
    }

    if let Some(builtin_rel) = rel.strip_prefix("rules/") {
        match rules {
            RulesSource::Dev(dir) => {
                let dev_path = dir.join(builtin_rel);
                if dev_path.is_file() {
                    return std::fs::read_to_string(&dev_path)
                        .map(Some)
                        .map_err(|e| format!("read {}: {e}", dev_path.display()));
                }
            }
            RulesSource::Embedded => {
                if let Some(file) = EMBEDDED_RULES.get_file(builtin_rel) {
                    let contents = file.contents_utf8().ok_or_else(|| {
                        format!(
                            "embedded rules file '{}' is not valid UTF-8",
                            file.path().display()
                        )
                    })?;
                    return Ok(Some(contents.to_owned()));
                }
            }
        }
    }

    Ok(None)
}

pub(crate) fn validate_workspace_module_path(
    name: &str,
    rel: &str,
) -> std::result::Result<(), String> {
    if rel.starts_with('/') {
        return Err(format!("workspace module '{name}' must be relative to //"));
    }

    for component in Path::new(rel).components() {
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

pub(crate) fn module_kind(root: &Path, rules: &RulesSource, name: &str) -> ModuleKind {
    if name == "imp:core" {
        ModuleKind::BuiltIn
    } else if name == WORKSPACE_FILE {
        ModuleKind::Workspace
    } else if name.starts_with("//") {
        resolve_workspace_module(root, rules, name)
            .map(|resolution| resolution.kind)
            .unwrap_or(ModuleKind::Unknown)
    } else {
        ModuleKind::Unknown
    }
}

pub(crate) fn module_location(root: &Path, rules: &RulesSource, name: &str) -> String {
    if name == "imp:core" {
        return "built-in imp:core".to_owned();
    }
    if name == WORKSPACE_FILE {
        return root.join(WORKSPACE_FILE).display().to_string();
    }
    if let Some(stripped) = name.strip_prefix("//") {
        if let Ok(resolution) = resolve_workspace_module(root, rules, name) {
            return match resolution.source {
                ModuleSource::File(path) => path.display().to_string(),
                ModuleSource::Embedded(_) => format!("<embedded {stripped}>"),
            };
        }
    }
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_file_wins_over_embedded() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("rules/workflows")).unwrap();
        std::fs::write(root.path().join("rules/workflows/fmt.js"), "sentinel").unwrap();
        let contents = resolve_workspace_file(
            root.path(),
            &RulesSource::Embedded,
            "//rules/workflows/fmt.js",
        )
        .unwrap()
        .unwrap();
        assert_eq!(contents, "sentinel");
    }

    #[test]
    fn embedded_rules_fallback() {
        let root = tempfile::tempdir().unwrap();
        let contents = resolve_workspace_file(
            root.path(),
            &RulesSource::Embedded,
            "//rules/workflows/fmt.js",
        )
        .unwrap()
        .unwrap();
        assert!(contents.contains("fmtGoal"));
    }

    #[test]
    fn dev_rules_fallback() {
        let root = tempfile::tempdir().unwrap();
        let dev = tempfile::tempdir().unwrap();
        std::fs::write(dev.path().join("dev.lock"), "{}").unwrap();
        let contents = resolve_workspace_file(
            root.path(),
            &RulesSource::Dev(dev.path().to_owned()),
            "//rules/dev.lock",
        )
        .unwrap()
        .unwrap();
        assert_eq!(contents, "{}");
    }

    #[test]
    fn missing_file_is_none_and_traversal_rejected() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            resolve_workspace_file(root.path(), &RulesSource::Embedded, "//no/such.lock")
                .unwrap()
                .is_none()
        );
        assert!(
            resolve_workspace_file(root.path(), &RulesSource::Embedded, "//../etc/passwd").is_err()
        );
        assert!(resolve_workspace_file(root.path(), &RulesSource::Embedded, "//").is_err());
    }
}
