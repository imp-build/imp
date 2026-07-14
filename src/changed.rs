//! Changed-target detection (`--changed-since` / `--changed-dependents`).
//!
//! Maps the files git reports as changed since a ref onto the targets that
//! own them: source-glob ownership, BUILD.js package membership, and the
//! recorded JS module import graph (a changed rule module invalidates every
//! package that transitively imports it). The changed set can then be
//! expanded along reverse dependency edges.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use regex::Regex;

use crate::spike::{
    compile_globs, source_field_workspace_root, Workspace, BUILD_FILE, WORKSPACE_FILE,
};

/// Import edges observed while loading the workspace's JS modules, plus the
/// file/package identity needed to map a changed file back into the graph.
/// Populated by the module resolver (every `import` resolution records an
/// edge, even for already-cached modules) and seeded with the BUILD.js roots
/// that are loaded directly rather than imported.
#[derive(Debug, Default, Clone)]
pub(crate) struct ImportGraph {
    /// Importee module name -> importer module names.
    pub(crate) importers: BTreeMap<String, BTreeSet<String>>,
    /// Workspace-relative file path (forward slashes) -> module names that
    /// resolve to it (several specifier forms may name the same file).
    pub(crate) module_files: BTreeMap<String, BTreeSet<String>>,
    /// BUILD module name -> the package scope it defines (`//dir`, or `//`
    /// for the workspace root package).
    pub(crate) build_module_scopes: BTreeMap<String, String>,
}

impl ImportGraph {
    /// Associate a workspace-relative file with a module name, marking it as
    /// a BUILD module for `scope` when given.
    pub(crate) fn record_module_file(&mut self, path: String, module: &str, scope: Option<&str>) {
        self.module_files
            .entry(path)
            .or_default()
            .insert(module.to_owned());
        if let Some(scope) = scope {
            self.build_module_scopes
                .insert(module.to_owned(), scope.to_owned());
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum DependentsMode {
    /// Only the targets owning changed files.
    #[default]
    None,
    /// Also targets directly depending on a changed target.
    Direct,
    /// Also the full reverse dependency closure of the changed targets.
    Transitive,
}

pub(crate) struct ChangedTargets {
    pub(crate) addresses: BTreeSet<String>,
    /// Changed files no target/module accounts for, for a caller-side warning.
    pub(crate) unowned: Vec<String>,
}

pub(crate) fn changed_target_addresses(
    workspace_root: &Path,
    workspace: &Workspace,
    graph: &ImportGraph,
    since: &str,
    dependents: DependentsMode,
) -> Result<ChangedTargets> {
    let files = git_changed_files(workspace_root, since)?;
    let (owners, unowned) = owning_targets(workspace, graph, &files)?;
    let addresses = expand_dependents(workspace, owners, dependents);
    Ok(ChangedTargets { addresses, unowned })
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/// Workspace-relative paths changed between `merge-base(since, HEAD)` and the
/// working tree (committed, staged, unstaged, deleted), plus untracked
/// non-ignored files — Pants `--changed-since` semantics. Paths outside the
/// workspace root (when it sits below the git toplevel) are dropped.
pub(crate) fn git_changed_files(workspace_root: &Path, since: &str) -> Result<Vec<String>> {
    let git = |args: &[&str]| -> Result<std::process::Output> {
        Command::new("git")
            .arg("-C")
            .arg(workspace_root)
            .args(args)
            .output()
            .context("run git (is git installed?)")
    };
    let stderr_line = |out: &std::process::Output| -> String {
        String::from_utf8_lossy(&out.stderr).trim().to_owned()
    };

    let toplevel = {
        let out = git(&["rev-parse", "--show-toplevel"])?;
        if !out.status.success() {
            bail!(
                "--changed-since requires a git repository at {}: {}",
                workspace_root.display(),
                stderr_line(&out)
            );
        }
        PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
    };
    // Both sides canonicalized so symlinked roots (e.g. /tmp on macOS/WSL)
    // agree before computing the workspace's prefix under the toplevel.
    let toplevel = toplevel
        .canonicalize()
        .with_context(|| format!("canonicalize git toplevel {}", toplevel.display()))?;
    let workspace_root = workspace_root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root {}", workspace_root.display()))?;
    let prefix = workspace_root
        .strip_prefix(&toplevel)
        .with_context(|| {
            format!(
                "workspace root {} is not under its git toplevel {}",
                workspace_root.display(),
                toplevel.display()
            )
        })?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");

    let merge_base = {
        let out = git(&["merge-base", since, "HEAD"])?;
        if !out.status.success() {
            bail!(
                "cannot resolve --changed-since ref '{since}': {}",
                stderr_line(&out)
            );
        }
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };

    let mut toplevel_relative: BTreeSet<String> = BTreeSet::new();
    // `diff-index` (plumbing) rather than `diff`: porcelain `git diff <commit>`
    // can drop working-tree deletions when the index has staged entries
    // (observed with git 2.43). The plumbing variant may over-report files
    // whose index stat info is merely stale, which only over-selects targets.
    let diff = git(&[
        "-c",
        "core.quotePath=false",
        "diff-index",
        "--name-only",
        "-z",
        &merge_base,
    ])?;
    if !diff.status.success() {
        bail!("git diff-index --name-only failed: {}", stderr_line(&diff));
    }
    let untracked = git(&[
        "-c",
        "core.quotePath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    ])?;
    if !untracked.status.success() {
        bail!("git ls-files --others failed: {}", stderr_line(&untracked));
    }
    for output in [&diff.stdout, &untracked.stdout] {
        for path in String::from_utf8_lossy(output).split('\0') {
            if !path.is_empty() {
                toplevel_relative.insert(path.to_owned());
            }
        }
    }

    Ok(toplevel_relative
        .into_iter()
        .filter_map(|path| {
            if prefix.is_empty() {
                Some(path)
            } else {
                path.strip_prefix(&format!("{prefix}/")).map(str::to_owned)
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/// Map changed workspace-relative paths to the addresses of the targets that
/// own them. Ownership is decided by matching each path against every
/// target's source globs (pattern match only — no filesystem walk — so
/// deleted files still find their owners), by BUILD.js package membership,
/// and by the JS module import graph. Returns the owner set plus the paths
/// nothing accounted for.
pub(crate) fn owning_targets(
    workspace: &Workspace,
    graph: &ImportGraph,
    changed: &[String],
) -> Result<(BTreeSet<String>, Vec<String>)> {
    struct SourceMatcher<'a> {
        address: &'a str,
        root: String,
        include: Vec<Regex>,
        exclude: Vec<Regex>,
    }
    let mut matchers = Vec::new();
    for target in workspace.targets.values() {
        for source in &target.sources {
            if source.include.is_empty() {
                continue;
            }
            matchers.push(SourceMatcher {
                address: &target.address,
                root: source_field_workspace_root(&target.address, &source.root)?,
                include: compile_globs("include", &source.include)?,
                exclude: compile_globs("exclude", &source.exclude)?,
            });
        }
    }

    let mut owners: BTreeSet<String> = BTreeSet::new();
    let mut unowned: Vec<String> = Vec::new();
    // Set when a change invalidates the whole workspace (imp.workspace.js,
    // directly or as a transitive importer of a changed module). The loop
    // still finishes so `unowned` reporting stays complete.
    let mut select_all = false;

    for path in changed {
        let mut owned = false;

        if path == WORKSPACE_FILE {
            select_all = true;
            continue;
        }

        for matcher in &matchers {
            let root_relative = if matcher.root == "." {
                Some(path.as_str())
            } else {
                path.strip_prefix(&format!("{}/", matcher.root))
            };
            let Some(rel) = root_relative else { continue };
            if matcher.include.iter().any(|glob| glob.is_match(rel))
                && !matcher.exclude.iter().any(|glob| glob.is_match(rel))
            {
                owners.insert(matcher.address.to_owned());
                owned = true;
            }
        }

        // A changed BUILD.js re-declares its whole package.
        let build_dir = if path == BUILD_FILE {
            Some("")
        } else {
            path.strip_suffix(&format!("/{BUILD_FILE}"))
        };
        if let Some(dir) = build_dir {
            let scope = if dir.is_empty() {
                "//".to_owned()
            } else {
                format!("//{dir}")
            };
            insert_package_targets(workspace, &scope, &mut owners);
            owned = true;
        }

        // A changed JS module invalidates every package that (transitively)
        // imports it.
        if let Some(modules) = graph.module_files.get(path) {
            for module in reverse_importer_closure(graph, modules) {
                if module == WORKSPACE_FILE {
                    select_all = true;
                } else if let Some(scope) = graph.build_module_scopes.get(&module) {
                    insert_package_targets(workspace, scope, &mut owners);
                }
            }
            owned = true;
        }

        if !owned {
            unowned.push(path.clone());
        }
    }

    if select_all {
        owners = workspace.targets.keys().cloned().collect();
    }
    Ok((owners, unowned))
}

fn insert_package_targets(workspace: &Workspace, scope: &str, owners: &mut BTreeSet<String>) {
    let prefix = if scope == "//" {
        "//:".to_owned()
    } else {
        format!("{scope}:")
    };
    // Addresses contain exactly one ':', so a prefix match implies the target
    // lives in exactly this package (no sub-directory can slip through).
    for address in workspace.targets.keys() {
        if address.starts_with(&prefix) {
            owners.insert(address.clone());
        }
    }
}

/// All modules reachable from `seeds` by walking importer edges backwards,
/// including the seeds themselves.
fn reverse_importer_closure(graph: &ImportGraph, seeds: &BTreeSet<String>) -> BTreeSet<String> {
    let mut reached = seeds.clone();
    let mut queue: VecDeque<&str> = seeds.iter().map(String::as_str).collect();
    while let Some(module) = queue.pop_front() {
        if let Some(importers) = graph.importers.get(module) {
            for importer in importers {
                if reached.insert(importer.clone()) {
                    queue.push_back(importer);
                }
            }
        }
    }
    reached
}

// ---------------------------------------------------------------------------
// Dependents
// ---------------------------------------------------------------------------

pub(crate) fn expand_dependents(
    workspace: &Workspace,
    seeds: BTreeSet<String>,
    mode: DependentsMode,
) -> BTreeSet<String> {
    if mode == DependentsMode::None || seeds.is_empty() {
        return seeds;
    }
    let mut reverse: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for target in workspace.targets.values() {
        for dep in &target.dependencies {
            reverse
                .entry(dep.address.as_str())
                .or_default()
                .push(target.address.as_str());
        }
    }

    let mut result = seeds.clone();
    let mut queue: VecDeque<String> = seeds.into_iter().collect();
    while let Some(address) = queue.pop_front() {
        for dependent in reverse.get(address.as_str()).into_iter().flatten() {
            if result.insert((*dependent).to_owned()) && mode == DependentsMode::Transitive {
                queue.push_back((*dependent).to_owned());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spike::{Dependency, DependencyMode, SourceField, Target};

    fn source(root: &str, include: &[&str], exclude: &[&str]) -> SourceField {
        SourceField {
            root: root.to_owned(),
            include: include.iter().map(|s| (*s).to_owned()).collect(),
            exclude: exclude.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn target(address: &str, sources: Vec<SourceField>, deps: &[&str]) -> Target {
        Target {
            address: address.to_owned(),
            kind: "dummy".to_owned(),
            attrs: serde_json::Value::Null,
            sources,
            dependencies: deps
                .iter()
                .map(|address| Dependency {
                    address: (*address).to_owned(),
                    mode: DependencyMode::Auto,
                })
                .collect(),
            js_id: 0,
        }
    }

    fn workspace(targets: Vec<Target>) -> Workspace {
        Workspace {
            targets: targets
                .into_iter()
                .map(|t| (t.address.clone(), t))
                .collect(),
            ..Workspace::default()
        }
    }

    fn owners_of(ws: &Workspace, graph: &ImportGraph, changed: &[&str]) -> BTreeSet<String> {
        let changed: Vec<String> = changed.iter().map(|s| (*s).to_owned()).collect();
        owning_targets(ws, graph, &changed).unwrap().0
    }

    #[test]
    fn source_globs_own_files_without_touching_the_filesystem() {
        // None of these paths exist on disk — ownership is pure pattern
        // matching, which is what makes deleted files still find owners.
        let ws = workspace(vec![
            target(
                "//app:app",
                vec![source(".", &["**/*.c"], &["gen/**"])],
                &[],
            ),
            target("//lib:lib", vec![source("src", &["*.odin"], &[])], &[]),
        ]);
        let graph = ImportGraph::default();

        assert_eq!(
            owners_of(&ws, &graph, &["app/main.c", "app/sub/util.c"]),
            BTreeSet::from(["//app:app".to_owned()])
        );
        // Excluded within the field's root.
        assert!(owners_of(&ws, &graph, &["app/gen/parser.c"]).is_empty());
        // Rooted at the package's `src` subdirectory.
        assert_eq!(
            owners_of(&ws, &graph, &["lib/src/lib.odin"]),
            BTreeSet::from(["//lib:lib".to_owned()])
        );
        // Same file name outside the source root.
        assert!(owners_of(&ws, &graph, &["lib/lib.odin"]).is_empty());
    }

    #[test]
    fn workspace_rooted_source_fields_own_files_outside_the_package() {
        let ws = workspace(vec![target(
            "//tools/gen:gen",
            vec![source("//shared", &["**/*.json"], &[])],
            &[],
        )]);
        assert_eq!(
            owners_of(&ws, &ImportGraph::default(), &["shared/schema.json"]),
            BTreeSet::from(["//tools/gen:gen".to_owned()])
        );
    }

    #[test]
    fn changed_build_js_owns_exactly_its_package() {
        let ws = workspace(vec![
            target("//app:app", vec![], &[]),
            target("//app:extra", vec![], &[]),
            target("//app/sub:nested", vec![], &[]),
            target("//:root", vec![], &[]),
        ]);
        let graph = ImportGraph::default();
        assert_eq!(
            owners_of(&ws, &graph, &["app/BUILD.js"]),
            BTreeSet::from(["//app:app".to_owned(), "//app:extra".to_owned()])
        );
        assert_eq!(
            owners_of(&ws, &graph, &["BUILD.js"]),
            BTreeSet::from(["//:root".to_owned()])
        );
    }

    #[test]
    fn changed_workspace_file_owns_everything() {
        let ws = workspace(vec![
            target("//app:app", vec![], &[]),
            target("//lib:lib", vec![], &[]),
        ]);
        let owners = owners_of(&ws, &ImportGraph::default(), &["imp.workspace.js"]);
        assert_eq!(owners.len(), 2);
    }

    #[test]
    fn unowned_files_are_reported_not_errors() {
        let ws = workspace(vec![target(
            "//app:app",
            vec![source(".", &["*.c"], &[])],
            &[],
        )]);
        let changed = vec!["docs/README.md".to_owned(), "app/main.c".to_owned()];
        let (owners, unowned) = owning_targets(&ws, &ImportGraph::default(), &changed).unwrap();
        assert_eq!(owners, BTreeSet::from(["//app:app".to_owned()]));
        assert_eq!(unowned, vec!["docs/README.md".to_owned()]);
    }

    #[test]
    fn changed_rule_module_owns_transitively_importing_packages() {
        let ws = workspace(vec![
            target("//a:a", vec![], &[]),
            target("//b:b", vec![], &[]),
            target("//c:c", vec![], &[]),
        ]);
        // c/BUILD.js imports //tools/macros, which imports //tools/base;
        // a/BUILD.js imports //tools/base directly; b imports nothing.
        let mut graph = ImportGraph::default();
        graph.record_module_file("a/BUILD.js".to_owned(), "//a", Some("//a"));
        graph.record_module_file("b/BUILD.js".to_owned(), "//b", Some("//b"));
        graph.record_module_file("c/BUILD.js".to_owned(), "//c", Some("//c"));
        graph.record_module_file("tools/macros.js".to_owned(), "//tools/macros", None);
        graph.record_module_file("tools/base.js".to_owned(), "//tools/base", None);
        for (importee, importer) in [
            ("//tools/macros", "//c"),
            ("//tools/base", "//tools/macros"),
            ("//tools/base", "//a"),
        ] {
            graph
                .importers
                .entry(importee.to_owned())
                .or_default()
                .insert(importer.to_owned());
        }

        assert_eq!(
            owners_of(&ws, &graph, &["tools/base.js"]),
            BTreeSet::from(["//a:a".to_owned(), "//c:c".to_owned()])
        );
        assert_eq!(
            owners_of(&ws, &graph, &["tools/macros.js"]),
            BTreeSet::from(["//c:c".to_owned()])
        );
        // A module imported by the workspace file invalidates everything.
        graph
            .importers
            .entry("//tools/base".to_owned())
            .or_default()
            .insert(WORKSPACE_FILE.to_owned());
        assert_eq!(owners_of(&ws, &graph, &["tools/base.js"]).len(), 3);
    }

    #[test]
    fn dependents_expansion_modes() {
        // c depends on b depends on a.
        let ws = workspace(vec![
            target("//x:a", vec![], &[]),
            target("//x:b", vec![], &["//x:a"]),
            target("//x:c", vec![], &["//x:b"]),
        ]);
        let seeds = BTreeSet::from(["//x:a".to_owned()]);
        assert_eq!(
            expand_dependents(&ws, seeds.clone(), DependentsMode::None),
            seeds
        );
        assert_eq!(
            expand_dependents(&ws, seeds.clone(), DependentsMode::Direct),
            BTreeSet::from(["//x:a".to_owned(), "//x:b".to_owned()])
        );
        assert_eq!(
            expand_dependents(&ws, seeds, DependentsMode::Transitive),
            BTreeSet::from(["//x:a".to_owned(), "//x:b".to_owned(), "//x:c".to_owned()])
        );
    }

    // ---- git ------------------------------------------------------------

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            // Isolate from user/system config (hooks, autocrlf, fsmonitor).
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn git_changed_files_covers_commits_working_tree_and_deletions() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git_in(dir, &["init", "-q", "-b", "main"]);
        write(dir, "committed.c", "old");
        write(dir, "deleted.c", "x");
        write(dir, "kept.c", "x");
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "base"]);

        write(dir, "committed.c", "new");
        git_in(dir, &["commit", "-qam", "change"]);
        write(dir, "unstaged.c", "x");
        git_in(dir, &["add", "unstaged.c"]);
        write(dir, "untracked.c", "x");
        std::fs::remove_file(dir.join("deleted.c")).unwrap();

        let changed = git_changed_files(dir, "HEAD~1").unwrap();
        assert_eq!(
            changed,
            vec![
                "committed.c".to_owned(),
                "deleted.c".to_owned(),
                "unstaged.c".to_owned(),
                "untracked.c".to_owned(),
            ]
        );
    }

    #[test]
    fn git_changed_files_scopes_to_a_workspace_below_the_git_toplevel() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git_in(dir, &["init", "-q", "-b", "main"]);
        write(dir, "ws/inside.c", "old");
        write(dir, "sibling/outside.c", "old");
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "base"]);
        write(dir, "ws/inside.c", "new");
        write(dir, "sibling/outside.c", "new");

        let changed = git_changed_files(&dir.join("ws"), "HEAD").unwrap();
        assert_eq!(changed, vec!["inside.c".to_owned()]);
    }

    #[test]
    fn git_changed_files_reports_bad_refs_and_missing_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = git_changed_files(dir, "HEAD").unwrap_err().to_string();
        assert!(err.contains("requires a git repository"), "{err}");

        git_in(dir, &["init", "-q", "-b", "main"]);
        write(dir, "a.c", "x");
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "base"]);
        let err = git_changed_files(dir, "no-such-ref")
            .unwrap_err()
            .to_string();
        assert!(err.contains("no-such-ref"), "{err}");
    }
}
