use std::path::{Component, Path, PathBuf};

// These names describe persisted JavaScript traces, not executable modules.
const BUILD_FILE: &str = "BUILD.js";
const WORKSPACE_FILE: &str = "imp.workspace.js";

/// Environment variable that points `//rules/...` at an on-disk directory,
/// overriding the tree shipped alongside the executable — for developing
/// against a checked-out copy of imp's rules from an external project.
pub const RULES_DIR_ENV: &str = "IMP_RULES_DIR";

/// On-disk rules library discovery. Historical trace readers also use this
/// source to locate `//rules/...` paths. Only consulted as
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
    /// shipped alongside the executable, or the checkout's `rules/` for a
    /// Cargo build in an imp checkout.
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

    /// Compact missing-library diagnostic.
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
        .find(|candidate| candidate.join("asset/index.luau").is_file())
}

/// Candidate rule libraries for an executable at `exe`, in precedence order:
/// the installed layout (`<prefix>/bin/imp` beside `<prefix>/share/imp/rules`),
/// then a `rules/` sibling so an unpacked release archive runs in place, then
/// the checkout's `rules/` for a Cargo build (`<checkout>/target/<profile>/imp`).
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
    // A Cargo build in an imp checkout uses the checkout's rules. The check
    // uses the executable path only, so the current workspace cannot supply
    // built-in rules.
    if let Some(checkout) = dir
        .parent()
        .filter(|target| target.file_name() == Some(std::ffi::OsStr::new("target")))
        .and_then(Path::parent)
    {
        if checkout.join("crates/imp/Cargo.toml").is_file() {
            candidates.push(checkout.join("rules"));
        }
    }

    let root = candidates.iter().find(|path| path.is_dir()).cloned();
    (root, candidates)
}

/// Module metadata retained for persisted trace inspection.
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

    // Keep historical trace module diagnostics compact.
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
        let found = is_file_exact_case(&path);
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

/// Like `Path::is_file`, but verifies the file name's case exactly instead
/// of trusting the OS lookup. Windows (NTFS) and default macOS (APFS) both
/// resolve paths case-insensitively, so `<rel>.js` would otherwise silently
/// match a differently-cased sibling such as `BUILD.js` — e.g. a request for
/// `rules/workflows/build.js` matching the package's own
/// `rules/workflows/BUILD.js` instead of correctly falling through to
/// `rules/workflows/build/index.js`.
fn is_file_exact_case(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let (Some(file_name), Some(parent)) = (path.file_name(), path.parent()) else {
        return false;
    };
    std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .any(|entry| entry.file_name() == file_name)
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
    #[test]
    fn exe_relative_probe_falls_back_to_sibling_rules() {
        let stage = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(stage.path().join("rules")).unwrap();

        let (root, _) = probe_exe_relative(&stage.path().join("imp"));
        assert_eq!(root.unwrap(), stage.path().join("rules"));
    }
    #[test]
    fn exe_relative_probe_finds_checkout_rules() {
        let checkout = tempfile::tempdir().unwrap();
        let debug = checkout.path().join("target/debug");
        std::fs::create_dir_all(&debug).unwrap();
        std::fs::create_dir_all(checkout.path().join("crates/imp")).unwrap();
        std::fs::write(checkout.path().join("crates/imp/Cargo.toml"), "").unwrap();
        std::fs::create_dir_all(checkout.path().join("rules")).unwrap();

        let (root, _) = probe_exe_relative(&debug.join("imp"));
        assert_eq!(root.unwrap(), checkout.path().join("rules"));
    }
    #[test]
    fn exe_relative_probe_ignores_target_without_checkout() {
        let other = tempfile::tempdir().unwrap();
        let debug = other.path().join("target/debug");
        std::fs::create_dir_all(&debug).unwrap();
        std::fs::create_dir_all(other.path().join("rules")).unwrap();

        let (root, searched) = probe_exe_relative(&debug.join("imp"));
        assert!(root.is_none());
        assert_eq!(searched.len(), 2);
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
        let normalized = message.replace('\\', "/");
        assert!(normalized.contains("share/imp/rules"), "{message}");
        assert!(normalized.contains("bin/rules"), "{message}");
    }
}
