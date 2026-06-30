use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rquickjs::{
    loader::{ImportAttributes, Loader, Resolver},
    Ctx, Module,
};

use crate::spike::{BUILD_FILE, WORKSPACE_FILE};

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
pub(crate) const CORE_JS: &str = include_str!("imp_core.js");

// ---------------------------------------------------------------------------
// QuickJS module resolver / loader
// ---------------------------------------------------------------------------

pub(crate) struct ImpResolver {
    pub(crate) workspace_root: PathBuf,
    pub(crate) module_mounts: Arc<Mutex<Vec<ModuleMount>>>,
}

pub(crate) struct ImpLoader {
    pub(crate) workspace_root: PathBuf,
    pub(crate) module_mounts: Arc<Mutex<Vec<ModuleMount>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModuleMount {
    pub(crate) prefix: String,
    pub(crate) root: PathBuf,
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
            let mounts = self.module_mounts.lock().unwrap();
            return Err(rquickjs::Error::new_resolving_message(
                base,
                name,
                format!(
                    "unknown built-in module '{name}' while importing from {}",
                    module_location_with_mounts(&self.workspace_root, &mounts, base)
                ),
            ));
        }

        if name.starts_with("//") {
            let mounts = self.module_mounts.lock().unwrap();
            let resolution =
                resolve_workspace_module_with_mounts(&self.workspace_root, &mounts, name).map_err(
                    |message| {
                        rquickjs::Error::new_resolving_message(
                            base,
                            name,
                            format!(
                                "{message} while importing from {}",
                                module_location_with_mounts(&self.workspace_root, &mounts, base)
                            ),
                        )
                    },
                )?;
            return Ok(resolution.name);
        }

        if name.starts_with('.') {
            let mounts = self.module_mounts.lock().unwrap();
            let importer = module_location_with_mounts(&self.workspace_root, &mounts, base);
            let message = if module_kind_with_mounts(&self.workspace_root, &mounts, base)
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
                {
                    let mounts = self.module_mounts.lock().unwrap();
                    module_location_with_mounts(&self.workspace_root, &mounts, base)
                }
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
            let resolution = {
                let mounts = self.module_mounts.lock().unwrap();
                resolve_workspace_module_with_mounts(&self.workspace_root, &mounts, name)
                    .map_err(|message| rquickjs::Error::new_loading_message(name, message))?
            };
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
pub(crate) enum ModuleKind {
    BuiltIn,
    Build,
    Extension,
    Workspace,
    Unknown,
}

pub(crate) struct WorkspaceModuleResolution {
    pub(crate) name: String,
    pub(crate) path: PathBuf,
    pub(crate) kind: ModuleKind,
}

pub(crate) fn resolve_workspace_module(
    root: &Path,
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    resolve_workspace_module_with_mounts(root, &[], name)
}

pub(crate) fn resolve_workspace_module_with_mounts(
    root: &Path,
    mounts: &[ModuleMount],
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let rel = name
        .strip_prefix("//")
        .ok_or_else(|| format!("workspace module '{name}' must start with //"))?;
    validate_workspace_module_path(name, rel)?;

    if let Some((mount, mounted_rel)) = matching_mount(mounts, name) {
        return resolve_workspace_module_in_root(&mount.root, name, &mounted_rel);
    }

    resolve_workspace_module_in_root(root, name, rel)
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
                path: build_path,
                kind: ModuleKind::Build,
            });
        }
    } else {
        if rel == "BUILD" || rel.ends_with("/BUILD") {
            let build_path = root.join(format!("{rel}.js"));
            candidates.push(build_path.clone());
            if build_path.is_file() {
                return Ok(WorkspaceModuleResolution {
                    name: name.to_owned(),
                    path: build_path,
                    kind: ModuleKind::Build,
                });
            }
        }

        let js_path = root.join(format!("{rel}.js"));
        candidates.push(js_path.clone());
        if js_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: js_path,
                kind: ModuleKind::Extension,
            });
        }

        let index_path = root.join(rel).join("index.js");
        candidates.push(index_path.clone());
        if index_path.is_file() {
            return Ok(WorkspaceModuleResolution {
                name: name.to_owned(),
                path: index_path,
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

fn matching_mount<'a>(mounts: &'a [ModuleMount], name: &str) -> Option<(&'a ModuleMount, String)> {
    let mount = mounts
        .iter()
        .filter(|mount| name == mount.prefix || name.starts_with(&format!("{}/", mount.prefix)))
        .max_by_key(|mount| mount.prefix.len())?;
    let mounted_rel = name
        .strip_prefix(&mount.prefix)
        .unwrap_or("")
        .strip_prefix('/')
        .unwrap_or("");
    Some((mount, mounted_rel.to_owned()))
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

pub(crate) fn module_kind_with_mounts(
    root: &Path,
    mounts: &[ModuleMount],
    name: &str,
) -> ModuleKind {
    if name == "imp:core" {
        ModuleKind::BuiltIn
    } else if name == WORKSPACE_FILE {
        ModuleKind::Workspace
    } else if name.starts_with("//") {
        resolve_workspace_module_with_mounts(root, mounts, name)
            .map(|resolution| resolution.kind)
            .unwrap_or(ModuleKind::Unknown)
    } else {
        ModuleKind::Unknown
    }
}

pub(crate) fn module_location_with_mounts(
    root: &Path,
    mounts: &[ModuleMount],
    name: &str,
) -> String {
    if name == "imp:core" {
        return "built-in imp:core".to_owned();
    }
    if name == WORKSPACE_FILE {
        return root.join(WORKSPACE_FILE).display().to_string();
    }
    if name.starts_with("//") {
        if let Ok(resolution) = resolve_workspace_module_with_mounts(root, mounts, name) {
            return resolution.path.display().to_string();
        }
    }
    name.to_owned()
}
