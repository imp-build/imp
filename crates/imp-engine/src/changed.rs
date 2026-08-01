//! Changed-target detection (`--changed-since`).
//!
//! Maps the files git reports as changed since a ref onto the targets that
//! own them. Two mechanisms, both provenance rather than declaration:
//!
//! - The recorded JS module import graph (a changed rule module invalidates
//!   every package that transitively imports it; a changed BUILD.js
//!   re-selects exactly its own package).
//! - The workspace-scoped memo trace (#51, `trace_changed::TraceIndex`): a target's
//!   own goal action is itself a memoized call, so "is target T stale for
//!   goal G" reduces to walking T's own trace record — and its
//!   `input_specs` — for staleness, transitively through `deps`. This
//!   replaces declared `sources:` glob ownership and `--changed-dependents`:
//!   staleness is inherently transitive once ownership comes from the real
//!   call graph, so there is no separate direct-vs-transitive mode anymore.
//!
//! Cold start (no trace records yet) selects everything for the goal
//! being run — correct and honest, not a bug to work around.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::spike::{Workspace, BUILD_FILE, CI_WORKSPACE_FILE, WORKSPACE_FILE};
use crate::trace_changed::{LabelChangeContext, TraceIndex};

/// Import edges observed while loading the workspace's JS modules, plus the
/// file/package identity needed to map a changed file back into the graph.
/// Populated by the module resolver (every `import` resolution records an
/// edge, even for already-cached modules) and seeded with the BUILD.js roots
/// that are loaded directly rather than imported.
#[derive(Debug, Default, Clone)]
pub struct ImportGraph {
    /// Importee module name -> importer module names.
    pub importers: BTreeMap<String, BTreeSet<String>>,
    /// Workspace-relative file path (forward slashes) -> module names that
    /// resolve to it (several specifier forms may name the same file).
    pub module_files: BTreeMap<String, BTreeSet<String>>,
    /// BUILD module name -> the package scope it defines (`//dir`, or `//`
    /// for the workspace root package).
    pub build_module_scopes: BTreeMap<String, String>,
}

impl ImportGraph {
    /// Associate a workspace-relative file with a module name, marking it as
    /// a BUILD module for `scope` when given.
    pub fn record_module_file(&mut self, path: String, module: &str, scope: Option<&str>) {
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

pub struct ChangedTargets {
    pub addresses: BTreeSet<String>,
    /// Human-readable selection explanations keyed by root address. Kept
    /// separate from addresses so goal execution can ignore them while
    /// `imp targets --changed-since` remains honest.
    pub reasons: BTreeMap<String, Vec<String>>,
    /// Changed files no target/module/persisted computation accounts for,
    /// for a caller-side warning.
    pub unowned: Vec<String>,
}

/// Checked against every registered product of a target's kind (build, test,
/// fmt, lint, package, ...), not scoped to any one goal — see
/// `TraceIndex::target_is_stale` for why a goal-scoped check is unsound.
pub fn changed_target_addresses(
    workspace_root: &Path,
    workspace: &Workspace,
    graph: &ImportGraph,
    since: &str,
    label_context: Option<&LabelChangeContext<'_>>,
) -> Result<ChangedTargets> {
    let files = git_changed_files(workspace_root, since)?;
    let (mut addresses, module_owned) = module_graph_targets(workspace, graph, &files);
    let changed_owners: Vec<u32> = workspace
        .label_primary_addresses
        .iter()
        .filter(|(_, address)| addresses.contains(*address))
        .map(|(id, _)| *id)
        .collect();
    for owner_id in changed_owners {
        addresses.extend(
            workspace
                .label_discovery_children
                .get(&owner_id)
                .into_iter()
                .flatten()
                .cloned(),
        );
    }
    let mut reasons: BTreeMap<String, Vec<String>> = addresses
        .iter()
        .map(|address| {
            (
                address.clone(),
                vec!["changed BUILD file or imported workspace module".to_owned()],
            )
        })
        .collect();

    let trace =
        TraceIndex::build(workspace_root).context("build memo-trace change-detection index")?;
    let stale = trace.stale_keys(workspace_root, &files, &workspace.workspace_config);
    for target in workspace.targets.values() {
        if trace.target_is_stale(workspace, target, &stale) {
            addresses.insert(target.address.clone());
            reasons
                .entry(target.address.clone())
                .or_default()
                .push("persisted target trace is stale or missing".to_owned());
        }
    }
    for (&label_id, address) in &workspace.label_primary_addresses {
        let handler_reasons = trace.label_stale_reasons(workspace, label_id, label_context, &stale);
        if !handler_reasons.is_empty() {
            addresses.insert(address.clone());
            reasons
                .entry(address.clone())
                .or_default()
                .extend(handler_reasons);
        }
    }

    let trace_covered = trace.covered_paths(&files);
    let unowned = files
        .into_iter()
        .filter(|path| !module_owned.contains(path) && !trace_covered.contains(path))
        .collect();

    Ok(ChangedTargets {
        addresses,
        reasons,
        unowned,
    })
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/// Workspace-relative paths changed between `merge-base(since, HEAD)` and the
/// working tree (committed, staged, unstaged, deleted), plus untracked
/// non-ignored files — Pants `--changed-since` semantics. Paths outside the
/// workspace root (when it sits below the git toplevel) are dropped.
pub fn git_changed_files(workspace_root: &Path, since: &str) -> Result<Vec<String>> {
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
// JS module/package graph
// ---------------------------------------------------------------------------

/// Map changed workspace-relative paths to target addresses via BUILD.js
/// package membership and the JS module import graph — a changed rule
/// module invalidates every package that (transitively) imports it; a
/// changed `imp.workspace.js` invalidates everything. Returns the address
/// set plus the subset of `changed` this mechanism accounted for (the
/// complement, minus whatever the memo trace separately covers,
/// is reported to the caller as `unowned`).
pub(crate) fn module_graph_targets(
    workspace: &Workspace,
    graph: &ImportGraph,
    changed: &[String],
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut owners: BTreeSet<String> = BTreeSet::new();
    let mut owned_paths: BTreeSet<String> = BTreeSet::new();
    // Set when a change invalidates the whole workspace (imp.workspace.js,
    // directly or as a transitive importer of a changed module). The loop
    // still finishes so `owned_paths` reporting stays complete.
    let mut select_all = false;

    for path in changed {
        if path == WORKSPACE_FILE || path == CI_WORKSPACE_FILE {
            select_all = true;
            owned_paths.insert(path.clone());
            continue;
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
            insert_package_roots(workspace, &scope, &mut owners);
            owned_paths.insert(path.clone());
            // BUILD.js files define their package rather than reusable rule
            // modules. Their import edges are dependency declarations, not
            // reverse invalidation edges, so a BUILD.js change must stay
            // package-scoped.
            continue;
        }

        // A changed JS module invalidates every package that (transitively)
        // imports it.
        if let Some(modules) = graph.module_files.get(path) {
            for module in reverse_importer_closure(graph, modules) {
                if module == WORKSPACE_FILE || module == CI_WORKSPACE_FILE {
                    select_all = true;
                } else if let Some(scope) = graph.build_module_scopes.get(&module) {
                    insert_package_roots(workspace, scope, &mut owners);
                }
            }
            owned_paths.insert(path.clone());
        }
    }

    if select_all {
        owners = workspace
            .targets
            .keys()
            .chain(workspace.label_primary_addresses.values())
            .cloned()
            .collect();
    }
    (owners, owned_paths)
}

fn insert_package_roots(workspace: &Workspace, scope: &str, owners: &mut BTreeSet<String>) {
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
    for address in workspace.label_primary_addresses.values() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spike::Target;

    fn target(address: &str) -> Target {
        Target {
            address: address.to_owned(),
            kind: "dummy".to_owned(),
            attrs: serde_json::Value::Null,
            sources: Vec::new(),
            dependencies: Vec::new(),
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
        module_graph_targets(ws, graph, &changed).0
    }

    #[test]
    fn changed_build_js_owns_exactly_its_package() {
        let ws = workspace(vec![
            target("//app:app"),
            target("//app:extra"),
            target("//app/sub:nested"),
            target("//:root"),
        ]);
        let mut graph = ImportGraph::default();
        assert_eq!(
            owners_of(&ws, &graph, &["app/BUILD.js"]),
            BTreeSet::from(["//app:app".to_owned(), "//app:extra".to_owned()])
        );
        assert_eq!(
            owners_of(&ws, &graph, &["BUILD.js"]),
            BTreeSet::from(["//:root".to_owned()])
        );

        // A BUILD module can import rule modules, but changing the BUILD file
        // itself must not follow those importer edges into the whole workspace.
        graph.record_module_file("app/BUILD.js".to_owned(), "//app", Some("//app"));
        graph
            .importers
            .entry("//app".to_owned())
            .or_default()
            .insert(WORKSPACE_FILE.to_owned());
        assert_eq!(
            owners_of(&ws, &graph, &["app/BUILD.js"]),
            BTreeSet::from(["//app:app".to_owned(), "//app:extra".to_owned()])
        );
    }

    #[test]
    fn changed_build_js_and_workspace_modules_include_label_roots() {
        let mut ws = workspace(vec![target("//app:legacy"), target("//lib:legacy")]);
        ws.label_addresses.insert("//app:generated".to_owned(), 1);
        ws.label_addresses.insert("//lib:generated".to_owned(), 2);
        ws.label_primary_addresses
            .insert(1, "//app:generated".to_owned());
        ws.label_primary_addresses
            .insert(2, "//lib:generated".to_owned());

        assert_eq!(
            owners_of(&ws, &ImportGraph::default(), &["app/BUILD.js"]),
            BTreeSet::from(["//app:generated".to_owned(), "//app:legacy".to_owned(),])
        );
        assert_eq!(
            owners_of(&ws, &ImportGraph::default(), &[WORKSPACE_FILE]),
            BTreeSet::from([
                "//app:generated".to_owned(),
                "//app:legacy".to_owned(),
                "//lib:generated".to_owned(),
                "//lib:legacy".to_owned(),
            ])
        );
    }

    #[test]
    fn changed_workspace_file_owns_everything() {
        let ws = workspace(vec![target("//app:app"), target("//lib:lib")]);
        let owners = owners_of(&ws, &ImportGraph::default(), &["imp.workspace.js"]);
        assert_eq!(owners.len(), 2);
    }

    #[test]
    fn changed_rule_module_owns_transitively_importing_packages() {
        let ws = workspace(vec![target("//a:a"), target("//b:b"), target("//c:c")]);
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
