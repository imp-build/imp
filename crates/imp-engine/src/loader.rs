use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rquickjs::{
    loader::{ImportAttributes, Loader, Resolver},
    Ctx, Module,
};

use crate::changed::ImportGraph;
use crate::spike::{BUILD_FILE, WORKSPACE_FILE};

/// The built-in `imp:core` module exposed to every plugin and BUILD file.
/// Unlike the rule library this is the engine's own source, so it stays
/// compiled in.
pub const CORE_JS: &str = concat!(include_str!("imp_core.js"), include_str!("graph_core.js"));

/// Environment variable that points `//rules/...` at an on-disk directory,
/// overriding the tree shipped alongside the executable — for developing
/// against a checked-out copy of imp's rules from an external project.
pub const RULES_DIR_ENV: &str = "IMP_RULES_DIR";

// ---------------------------------------------------------------------------
// QuickJS module resolver / loader
// ---------------------------------------------------------------------------

pub struct ImpResolver {
    pub workspace_root: PathBuf,
    pub rules_source: RulesSource,
    /// Import edges recorded for changed-target detection. QuickJS calls
    /// `resolve` for every import statement, including ones whose module is
    /// already cached, so the recorded graph is complete.
    pub import_graph: Arc<Mutex<ImportGraph>>,
}

pub struct ImpLoader {
    pub workspace_root: PathBuf,
    pub rules_source: RulesSource,
}

/// Where imp's built-in `//rules/...` modules come from. Only consulted as
/// a fallback when a `//rules/...` specifier isn't found under the workspace
/// root itself (e.g. a project vendoring/overriding its own copy).
///
/// Having no rules directory at all is a normal state, not an error: a
/// workspace that vendors every rule it uses never consults this. So the
/// absence is carried here and only reported if something actually needs a
/// built-in rule, together with the locations that were probed.
#[derive(Debug, Clone)]
pub struct RulesSource {
    root: Option<PathBuf>,
    /// Locations `discover` probed, for the not-found message. Empty when the
    /// source was named explicitly.
    searched: Vec<PathBuf>,
}

impl RulesSource {
    /// Locates the rule library: `$IMP_RULES_DIR` if set, otherwise the tree
    /// shipped alongside the executable.
    pub fn discover() -> Self {
        if let Some(value) = std::env::var_os(RULES_DIR_ENV) {
            if !value.is_empty() {
                // Used verbatim even when it doesn't exist. Falling through to
                // an installed tree would make a typo'd override look like it
                // worked, which is a miserable thing to debug.
                return Self::directory(PathBuf::from(value));
            }
        }

        let probed = std::env::current_exe().ok().map(|exe| {
            // macOS can hand back a symlink or a relative path; /proc/self/exe
            // is already resolved. The fallback covers a binary being replaced
            // underneath us, where canonicalize fails on "... (deleted)".
            let exe = exe.canonicalize().unwrap_or(exe);
            probe_exe_relative(&exe)
        });

        let searched = match probed {
            Some((Some(root), searched)) => {
                return Self {
                    root: Some(root),
                    searched,
                }
            }
            Some((None, searched)) => searched,
            None => Vec::new(),
        };

        // Test binaries live in target/debug/deps/ (or a sandbox), with no
        // installed layout around them, so fall back to the checkout. Without
        // this every tempdir test that imports a real rule would fail; the
        // not-found path is covered by explicit `RulesSource::none()` tests.
        #[cfg(any(test, feature = "test-support"))]
        if let Some(checkout) = test_rules_dir() {
            return Self::directory(checkout);
        }

        Self {
            root: None,
            searched,
        }
    }

    /// A rules tree at a known path, used verbatim.
    pub fn directory(path: impl Into<PathBuf>) -> Self {
        Self {
            root: Some(path.into()),
            searched: Vec::new(),
        }
    }

    /// No built-in rules. Correct for a fully-vendored workspace, and for
    /// callers that only resolve non-`//rules/...` addresses.
    pub fn none() -> Self {
        Self {
            root: None,
            searched: Vec::new(),
        }
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// One-line "no rule library" note, for errors thrown into JS where the
    /// whole message must fit QuickJS's 256-byte buffer.
    pub fn missing_summary(&self) -> String {
        format!("no rule library (set {RULES_DIR_ENV})")
    }

    /// The same, with every probed location — for errors surfaced in Rust,
    /// which have no length limit.
    pub fn missing_message(&self) -> String {
        if self.searched.is_empty() {
            return format!(
                "no built-in rules directory available; set {RULES_DIR_ENV} to a rules directory"
            );
        }
        let mut message = String::from("no built-in rules directory found; looked in:");
        for path in &self.searched {
            message.push_str(&format!("\n  {}", path.display()));
        }
        message.push_str(&format!(
            "\nset {RULES_DIR_ENV}, or reinstall imp with install.sh"
        ));
        message
    }

    /// Reads a file from the rule library by path relative to its root, for
    /// callers with no workspace to fall back on (see `imp init`).
    pub fn read_builtin(&self, rel: &str) -> std::result::Result<String, String> {
        let Some(root) = self.root() else {
            return Err(self.missing_message());
        };
        let path = root.join(rel);
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
    }
}

/// imp's own rule library, located from a test binary.
///
/// Deliberately not `env!("CARGO_MANIFEST_DIR")`: that bakes in an absolute
/// path at compile time, and under `imp test` the crate is compiled in one
/// ephemeral sandbox and the tests run in another, so it points at a directory
/// that no longer exists. Walking up from the working directory lands on the
/// repo root under `cargo test`, and on the sandbox root under `imp test`
/// (where the rulesTree resource dep is materialized — see BUILD.js).
#[cfg(any(test, feature = "test-support"))]
pub fn test_rules_dir() -> Option<PathBuf> {
    std::env::current_dir()
        .ok()?
        .ancestors()
        .map(|dir| dir.join("rules"))
        .find(|candidate| candidate.join("init.js").is_file())
}

/// Candidate rule libraries for an executable at `exe`, in precedence order:
/// the installed layout (`<prefix>/bin/imp` beside `<prefix>/share/imp/rules`),
/// then a `rules/` sibling so an unpacked release archive runs in place.
/// Returns the first that exists plus every path probed, for diagnostics.
///
/// Pure so it is testable without touching `current_exe` or the environment.
fn probe_exe_relative(exe: &Path) -> (Option<PathBuf>, Vec<PathBuf>) {
    let Some(dir) = exe.parent() else {
        return (None, Vec::new());
    };

    let mut candidates = Vec::new();
    if let Some(prefix) = dir.parent() {
        candidates.push(prefix.join("share").join("imp").join("rules"));
    }
    candidates.push(dir.join("rules"));

    let root = candidates.iter().find(|path| path.is_dir()).cloned();
    (root, candidates)
}

impl ImpResolver {
    fn record_import(&self, base: &str, resolution: &WorkspaceModuleResolution) {
        let mut graph = self.import_graph.lock().unwrap();
        graph
            .importers
            .entry(resolution.name.clone())
            .or_default()
            .insert(base.to_owned());
        // Only files under the workspace root can appear in a git diff; the
        // built-in rule library normally lives outside it. (Pointing
        // IMP_RULES_DIR inside a workspace does put built-in rules in the
        // graph — harmless, and already true before rules moved on-disk.)
        let path = &resolution.path;
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
pub enum ModuleKind {
    BuiltIn,
    Build,
    Extension,
    Workspace,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleForm {
    Direct,
    Index,
    Build,
}

#[derive(Debug, Clone)]
pub struct WorkspaceModuleResolution {
    pub name: String,
    pub path: PathBuf,
    pub kind: ModuleKind,
    pub form: ModuleForm,
}

pub fn resolve_workspace_module(
    root: &Path,
    rules: &RulesSource,
    name: &str,
) -> std::result::Result<WorkspaceModuleResolution, String> {
    let rel = name
        .strip_prefix("//")
        .ok_or_else(|| format!("workspace module '{name}' must start with //"))?;
    validate_workspace_module_path(name, rel)?;

    // `//rules/...` addresses fall back to imp's own rule library, which
    // lives outside the workspace.
    let builtin_rel = (rel == "rules" || rel.starts_with("rules/"))
        .then(|| rel.strip_prefix("rules").unwrap().trim_start_matches('/'));

    let mut tried = Vec::new();
    if let Some(resolution) = try_resolve_in_root(root, name, rel, &mut tried) {
        return Ok(resolution);
    }
    if let (Some(builtin_rel), Some(rules_root)) = (builtin_rel, rules.root()) {
        if let Some(resolution) = try_resolve_in_root(rules_root, name, builtin_rel, &mut tried) {
            return Ok(resolution);
        }
    }

    // QuickJS formats thrown errors through a 256-byte stack buffer, and
    // rquickjs prepends ~80 bytes of "Error resolving module 'x' from 'y': "
    // before this reaches it — leaving roughly 180. So this stays one line and
    // spends the budget on the roots, which is the part a reader can't guess.
    // The `.js` / `index.js` / `BUILD.js` candidates under each root are a
    // fixed convention (see try_resolve_in_root) and are deliberately omitted;
    // listing them twice cost ~100 bytes and pushed the paths off the end.
    let mut message = format!(
        "cannot resolve workspace module '{name}' under {}",
        root.display()
    );
    if let (Some(_), Some(rules_root)) = (builtin_rel, rules.root()) {
        message.push_str(&format!(" or {}", rules_root.display()));
    }
    if builtin_rel.is_some() && rules.root().is_none() {
        message.push_str(&format!("; {}", rules.missing_summary()));
    }
    Err(message)
}

/// Tries the `<rel>.js` / `<rel>/index.js` / `<rel>/BUILD.js` candidates for
/// `rel` under `root`, appending every path probed to `tried` so the caller
/// can build one combined not-found message across both roots.
fn try_resolve_in_root(
    root: &Path,
    name: &str,
    rel: &str,
    tried: &mut Vec<PathBuf>,
) -> Option<WorkspaceModuleResolution> {
    let mut candidates = Vec::new();

    if rel.is_empty() {
        candidates.push((root.join(BUILD_FILE), ModuleKind::Build, ModuleForm::Build));
    } else {
        // A `//pkg/BUILD` address names a build file directly; everything
        // else resolving to `<rel>.js` is a plain extension module.
        let direct_kind = if rel == "BUILD" || rel.ends_with("/BUILD") {
            ModuleKind::Build
        } else {
            ModuleKind::Extension
        };
        candidates.push((
            root.join(format!("{rel}.js")),
            direct_kind,
            ModuleForm::Direct,
        ));
        candidates.push((
            root.join(rel).join("index.js"),
            ModuleKind::Extension,
            ModuleForm::Index,
        ));
        candidates.push((
            root.join(rel).join(BUILD_FILE),
            ModuleKind::Build,
            ModuleForm::Build,
        ));
    }

    for (path, kind, form) in candidates {
        let found = path.is_file();
        tried.push(path.clone());
        if found {
            return Some(WorkspaceModuleResolution {
                name: name.to_owned(),
                path,
                kind,
                form,
            });
        }
    }
    None
}

/// Resolve a workspace-addressed data file (e.g.
/// `//rules/python/ruff-toolchain.lock`) to its contents. Unlike module
/// resolution, no `.js`/`index.js`/`BUILD.js` candidates are tried — the
/// address names the file exactly. Precedence mirrors module resolution:
/// a file under the workspace root wins, with the built-in rules tree as a
/// fallback for `//rules/...` addresses. Returns `Ok(None)` when no source
/// has the file, and `Err` when a `//rules/...` address is asked for but no
/// rule library exists to look in.
pub fn resolve_workspace_file(
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
        // Distinguish "the rule library doesn't have this file" from "there is
        // no rule library". Collapsing both into Ok(None) surfaces to the user
        // as a bogus "regenerate your lockfiles" error from
        // rules/imp/lockfile/index.js.
        let Some(rules_root) = rules.root() else {
            return Err(rules.missing_message());
        };
        let builtin_path = rules_root.join(builtin_rel);
        if builtin_path.is_file() {
            return std::fs::read_to_string(&builtin_path)
                .map(Some)
                .map_err(|e| format!("read {}: {e}", builtin_path.display()));
        }
    }

    Ok(None)
}

pub fn validate_workspace_module_path(name: &str, rel: &str) -> std::result::Result<(), String> {
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

pub fn module_kind(root: &Path, rules: &RulesSource, name: &str) -> ModuleKind {
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

pub fn module_location(root: &Path, rules: &RulesSource, name: &str) -> String {
    if name == "imp:core" {
        return "built-in imp:core".to_owned();
    }
    if name == WORKSPACE_FILE {
        return root.join(WORKSPACE_FILE).display().to_string();
    }
    if name.starts_with("//") {
        if let Ok(resolution) = resolve_workspace_module(root, rules, name) {
            return resolution.path.display().to_string();
        }
    }
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// imp's own rule library, as an installed binary would see it.
    fn repo_rules_dir() -> PathBuf {
        test_rules_dir().expect("locate the repo's rules/ tree")
    }

    #[test]
    fn workspace_file_wins_over_builtin() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("rules/workflows")).unwrap();
        std::fs::write(root.path().join("rules/workflows/fmt.js"), "sentinel").unwrap();
        let contents = resolve_workspace_file(
            root.path(),
            &RulesSource::directory(repo_rules_dir()),
            "//rules/workflows/fmt.js",
        )
        .unwrap()
        .unwrap();
        assert_eq!(contents, "sentinel");
    }

    #[test]
    fn builtin_rules_fallback() {
        let root = tempfile::tempdir().unwrap();
        let contents = resolve_workspace_file(
            root.path(),
            &RulesSource::directory(repo_rules_dir()),
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
            &RulesSource::directory(dev.path()),
            "//rules/dev.lock",
        )
        .unwrap()
        .unwrap();
        assert_eq!(contents, "{}");
    }

    #[test]
    fn missing_file_is_none_and_traversal_rejected() {
        let root = tempfile::tempdir().unwrap();
        let rules = RulesSource::directory(repo_rules_dir());
        assert!(
            resolve_workspace_file(root.path(), &rules, "//no/such.lock")
                .unwrap()
                .is_none()
        );
        assert!(resolve_workspace_file(root.path(), &rules, "//../etc/passwd").is_err());
        assert!(resolve_workspace_file(root.path(), &rules, "//").is_err());
    }

    /// A `//rules/...` read with no rule library must say so, rather than
    /// reporting the file as merely absent — callers turn `Ok(None)` into
    /// "your lockfiles are stale", which sends people down the wrong path.
    #[test]
    fn addressed_rules_file_without_library_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let err =
            resolve_workspace_file(root.path(), &RulesSource::none(), "//rules/rust/rust.lock")
                .unwrap_err();
        assert!(err.contains("no built-in rules directory"), "{err}");

        // Non-rules addresses are still a plain miss.
        assert!(
            resolve_workspace_file(root.path(), &RulesSource::none(), "//other/thing.lock")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn module_resolution_reports_both_roots_and_missing_library() {
        let root = tempfile::tempdir().unwrap();
        let rules = tempfile::tempdir().unwrap();

        let err = resolve_workspace_module(
            root.path(),
            &RulesSource::directory(rules.path()),
            "//rules/missing",
        )
        .unwrap_err();
        assert!(
            err.contains("cannot resolve workspace module '//rules/missing'"),
            "{err}"
        );
        // Both the workspace root and the rule library were probed.
        assert!(err.contains(&root.path().display().to_string()), "{err}");
        assert!(err.contains(&rules.path().display().to_string()), "{err}");
        assert!(!err.contains("no rule library"), "{err}");

        let err = resolve_workspace_module(root.path(), &RulesSource::none(), "//rules/missing")
            .unwrap_err();
        assert!(err.contains("no rule library"), "{err}");
        assert!(err.contains(RULES_DIR_ENV), "{err}");
    }

    /// QuickJS formats thrown errors through a 256-byte stack buffer and
    /// rquickjs prepends "Error resolving module 'x' from 'y': " before that,
    /// so a resolution failure has roughly 180 bytes to say anything useful.
    /// Blow the budget and the tail — which is where the paths live — is
    /// silently cut off mid-word for the user.
    #[test]
    fn resolution_error_fits_the_quickjs_message_buffer() {
        let root = Path::new("/home/someone/projects/my-service");
        let rules = Path::new("/home/someone/.local/share/imp/rules");

        for source in [RulesSource::directory(rules), RulesSource::none()] {
            let err = resolve_workspace_module(root, &source, "//rules/python/ruff_toolchain")
                .unwrap_err();
            assert!(
                err.len() <= 180,
                "resolution error is {} bytes, over the QuickJS budget:\n{err}",
                err.len()
            );
        }
    }

    /// `import "//rules"` resolves to the library's own BUILD.js. This never
    /// worked against the old embedded copy, which only ever probed
    /// `<rel>.js`/`<rel>/index.js`/`<rel>/BUILD.js` and so skipped the
    /// top-level BUILD.js when `rel` was empty.
    #[test]
    fn bare_rules_address_resolves_to_library_build_file() {
        let root = tempfile::tempdir().unwrap();
        let rules = tempfile::tempdir().unwrap();
        std::fs::write(rules.path().join(BUILD_FILE), "export const x = 1;").unwrap();

        let resolution = resolve_workspace_module(
            root.path(),
            &RulesSource::directory(rules.path()),
            "//rules",
        )
        .unwrap();
        assert_eq!(resolution.path, rules.path().join(BUILD_FILE));
        assert_eq!(resolution.kind, ModuleKind::Build);
    }

    #[test]
    fn exe_relative_probe_prefers_installed_layout() {
        let prefix = tempfile::tempdir().unwrap();
        let bin = prefix.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let share = prefix.path().join("share/imp/rules");
        std::fs::create_dir_all(&share).unwrap();

        let (root, searched) = probe_exe_relative(&bin.join("imp"));
        assert_eq!(root.unwrap(), share);
        assert_eq!(searched.len(), 2);
    }

    /// An unpacked release archive must run in place, without an install step.
    #[test]
    fn exe_relative_probe_falls_back_to_sibling_rules() {
        let stage = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(stage.path().join("rules")).unwrap();

        let (root, _) = probe_exe_relative(&stage.path().join("imp"));
        assert_eq!(root.unwrap(), stage.path().join("rules"));
    }

    #[test]
    fn exe_relative_probe_reports_every_location_it_tried() {
        let empty = tempfile::tempdir().unwrap();
        let bin = empty.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();

        let (root, searched) = probe_exe_relative(&bin.join("imp"));
        assert!(root.is_none());

        let source = RulesSource {
            root: None,
            searched,
        };
        let message = source.missing_message();
        assert!(message.contains("share/imp/rules"), "{message}");
        assert!(message.contains("bin/rules"), "{message}");
    }
}
