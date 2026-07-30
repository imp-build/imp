//! Trace-based change detection (#51).
//!
//! Replaces the glob-matching half of `changed::owning_targets` and all of
//! `changed::expand_dependents` with an index built from the persisted memo
//! layer (#50, `imp-store::memo`): every memoized call's recorded
//! `input_specs` (config namespaces, files, FileSets it read) and `deps`
//! (callee keys it invoked).
//!
//! A target's own per-goal action is itself a memoized call — `product()`
//! (`imp_core.js`) wraps every registered product function in `memo()`
//! before registering it. So "is target T stale for goal G" reduces to "is
//! T's own persisted record for G's product function stale, transitively
//! through its `deps`" — no separate target-to-call mapping is needed,
//! just recomputing that memoized call's persisted key for T's address,
//! exactly as `memo()` computes it at call time (see `persisted_key`).
//!
//! Matching is predictive, not retrospective: a FileSet's `input_specs` entry
//! stores the glob/union/literal *spec*, and changed git paths are matched
//! against that spec, never against a re-resolved file list. A newly created
//! file matching an existing glob is caught this way; re-resolving would
//! miss it (it appeared in no prior resolution).

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::Path;

use anyhow::{Context, Result};
use regex::Regex;
use serde::Serialize;

use crate::loader::RulesSource;
use crate::spike::{
    compile_globs, module_digest_for_site, scoped_configuration_digest, Target, Workspace,
};
use imp_store::memo::{list_memo_records, InputSpecRecord, MemoCacheRecord};

/// In-memory index over every persisted memo record, rebuilt fresh each
/// invocation by scanning `memo/*.json` (see `list_memo_records`) — there is
/// no separate on-disk index file. A cold cache (no records) yields an empty
/// index, so every target is conservatively treated as stale (`target_is_stale`
/// returns `true` for a key with no record) — "cold start runs everything".
pub struct TraceIndex {
    records: HashMap<String, MemoCacheRecord>,
    /// Callee key -> caller keys, inverted from each record's own `deps`.
    reverse_deps: HashMap<String, Vec<String>>,
}

pub struct LabelChangeContext<'a> {
    pub goal: &'a str,
    pub flags: &'a serde_json::Value,
    pub args: &'a [String],
    pub mode: &'a serde_json::Value,
}

impl TraceIndex {
    pub fn build() -> Result<Self> {
        let records = list_memo_records().context("enumerate persisted memo records")?;
        let mut by_key = HashMap::with_capacity(records.len());
        let mut reverse_deps: HashMap<String, Vec<String>> = HashMap::new();
        for record in records {
            for dep in &record.deps {
                reverse_deps
                    .entry(dep.clone())
                    .or_default()
                    .push(record.key.clone());
            }
            by_key.insert(record.key.clone(), record);
        }
        Ok(Self {
            records: by_key,
            reverse_deps,
        })
    }

    pub fn records_for_function(&self, fn_id: &str) -> Vec<&MemoCacheRecord> {
        let mut records = self
            .records
            .values()
            .filter(|record| record.fn_id == fn_id)
            .collect::<Vec<_>>();
        records.sort_by(|left, right| left.key.cmp(&right.key));
        records
    }

    pub fn record(&self, key: &str) -> Option<&MemoCacheRecord> {
        self.records.get(key)
    }

    /// Keys whose own declaring module changed, or whose recorded
    /// `input_specs` cover a changed path / no-longer-matching config digest.
    /// `workspace_config` is `Workspace.workspace_config` — the currently
    /// loaded config, needed to recheck `"config_namespaces"` specs.
    fn directly_stale(
        &self,
        workspace_root: &Path,
        changed_paths: &[String],
        workspace_config: &std::collections::BTreeMap<String, serde_json::Value>,
    ) -> BTreeSet<String> {
        let rules_source = RulesSource::from_env();
        let mut module_digest_cache: HashMap<String, Option<String>> = HashMap::new();
        let mut stale = BTreeSet::new();
        for (key, record) in &self.records {
            let site = record
                .fn_id
                .split_once('@')
                .map(|(_, site)| site)
                .unwrap_or(&record.fn_id);
            let current_module_digest = module_digest_cache
                .entry(site.to_owned())
                .or_insert_with(|| module_digest_for_site(workspace_root, &rules_source, site).ok())
                .clone();
            if current_module_digest.as_deref() != Some(record.module_digest.as_str()) {
                stale.insert(key.clone());
                continue;
            }
            if record
                .input_specs
                .iter()
                .any(|spec| input_spec_is_stale(spec, changed_paths, workspace_config))
            {
                stale.insert(key.clone());
            }
        }
        stale
    }

    /// BFS over `reverse_deps` from a directly-stale seed set: every
    /// transitive caller is stale too, since its own persisted result was
    /// computed by calling (at least) this now-stale callee.
    fn stale_closure(&self, seeds: BTreeSet<String>) -> BTreeSet<String> {
        let mut reached = seeds.clone();
        let mut queue: VecDeque<String> = seeds.into_iter().collect();
        while let Some(key) = queue.pop_front() {
            for caller in self.reverse_deps.get(&key).into_iter().flatten() {
                if reached.insert(caller.clone()) {
                    queue.push_back(caller.clone());
                }
            }
        }
        reached
    }

    /// The changed paths matched by at least one persisted record's
    /// `"fileset"`/`"read_file"`/`"run_input"` input spec — i.e. paths some
    /// computation is already known to read. Used to distinguish "no
    /// computation owns this file" (worth a warning) from "this file is read,
    /// but the computation that reads it isn't stale for the goal being run"
    /// (routine).
    pub fn covered_paths(&self, changed_paths: &[String]) -> BTreeSet<String> {
        let mut covered = BTreeSet::new();
        for record in self.records.values() {
            for spec in &record.input_specs {
                match spec.kind.as_str() {
                    "read_file" => {
                        if let Some(path) = spec.spec.as_str() {
                            if changed_paths.iter().any(|c| c == path) {
                                covered.insert(path.to_owned());
                            }
                        }
                    }
                    "run_input" => {
                        for path in changed_paths {
                            if run_input_spec_is_stale(&spec.spec, std::slice::from_ref(path)) {
                                covered.insert(path.clone());
                            }
                        }
                    }
                    "fileset" => {
                        for path in changed_paths {
                            if fileset_spec_is_stale(&spec.spec, std::slice::from_ref(path)) {
                                covered.insert(path.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        covered
    }

    /// The full stale set for this invocation: every persisted key that is
    /// itself invalidated by a changed path/config/module, plus every
    /// transitive caller of one.
    pub fn stale_keys(
        &self,
        workspace_root: &Path,
        changed_paths: &[String],
        workspace_config: &std::collections::BTreeMap<String, serde_json::Value>,
    ) -> BTreeSet<String> {
        self.stale_closure(self.directly_stale(workspace_root, changed_paths, workspace_config))
    }

    /// Whether `target` needs to run for *any* of its registered products
    /// (build, test, fmt, lint, package, ...) — not scoped to the goal
    /// currently executing.
    ///
    /// A goal-scoped check (only the current goal's own product function)
    /// was tried and found unsound: a goal's product function doesn't
    /// necessarily read the target's real inputs itself. For example
    /// `cargoTest` on a `workspaceMember: true` `CargoPackage` delegates
    /// entirely to a shared doc-test runner and never calls `sources(handle)`
    /// — its own persisted record has no FileSet input spec covering the
    /// crate's `.rs` files at all, while `cargoBuild`'s does. The real unit
    /// test binaries live on a separately `expand()`-minted target that
    /// doesn't exist in `workspace.targets` yet when this runs (expansion
    /// happens later, seeded from this selection). Checking every registered
    /// product mirrors the old declared `Target.sources` field, which was
    /// goal-agnostic for the same reason: a target's inputs don't split
    /// cleanly along goal boundaries in every rule module.
    pub fn target_is_stale(
        &self,
        workspace: &Workspace,
        target: &Target,
        stale: &BTreeSet<String>,
    ) -> bool {
        workspace
            .products
            .keys()
            .filter(|(kind, _)| *kind == target.kind)
            .any(|(_, product)| self.target_product_is_stale(workspace, target, product, stale))
    }

    /// Whether any handler attached to a label is cold or stale. Goal
    /// execution supplies its exact context so flags/args/mode participate
    /// in the persisted root key. Context-free introspection checks every
    /// registered handler and every context observed for it.
    pub fn label_is_stale(
        &self,
        workspace: &Workspace,
        label_id: u32,
        context: Option<&LabelChangeContext<'_>>,
        stale: &BTreeSet<String>,
    ) -> bool {
        !self
            .label_stale_reasons(workspace, label_id, context, stale)
            .is_empty()
    }

    pub fn label_stale_reasons(
        &self,
        workspace: &Workspace,
        label_id: u32,
        context: Option<&LabelChangeContext<'_>>,
        stale: &BTreeSet<String>,
    ) -> Vec<String> {
        let Some(address) = workspace.label_primary_addresses.get(&label_id) else {
            return vec!["label has no canonical exported address".to_owned()];
        };
        workspace
            .label_handlers
            .iter()
            .filter(|((id, goal), _)| {
                *id == label_id && context.is_none_or(|context| goal == context.goal)
            })
            .flat_map(|((_, goal), handlers)| {
                handlers.iter().map(move |handler| (goal.as_str(), handler))
            })
            .filter_map(|(goal, handler)| {
                let fn_id = format!("label-handler:{goal}:{}", handler.identity);
                if let Some(context) = context {
                    let args = LabelHandlerArgs {
                        flags: context.flags,
                        selector: address,
                        args: context.args,
                        mode: context.mode,
                    };
                    return match persisted_key_for_args(&fn_id, &(address, args)) {
                        Err(_) => Some(format!(
                            "{goal}@{} has no stable trace key",
                            handler.identity
                        )),
                        Ok(key) if !self.records.contains_key(&key) => Some(format!(
                            "{goal}@{} has no trace for this invocation",
                            handler.identity
                        )),
                        Ok(key) if stale.contains(&key) => Some(format!(
                            "{goal}@{} has changed observed inputs or memo dependencies",
                            handler.identity
                        )),
                        Ok(_) => None,
                    };
                }
                let records: Vec<_> = self
                    .records
                    .values()
                    .filter(|record| record.fn_id == fn_id)
                    .collect();
                if records.is_empty() {
                    Some(format!("{goal}@{} has no observed trace", handler.identity))
                } else if records.iter().any(|record| stale.contains(&record.key)) {
                    Some(format!(
                        "{goal}@{} has changed observed inputs or memo dependencies",
                        handler.identity
                    ))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Whether `target`'s `product` action (e.g. "build") needs to run:
    /// any tool registered for `(target.kind, product)` either has no
    /// persisted record for this target's address (never built, or the
    /// cache was cleared — conservatively selected) or its key is in `stale`.
    fn target_product_is_stale(
        &self,
        workspace: &Workspace,
        target: &Target,
        product: &str,
        stale: &BTreeSet<String>,
    ) -> bool {
        let Some(tools) = workspace
            .products
            .get(&(target.kind.clone(), product.to_owned()))
        else {
            return false;
        };
        tools.keys().any(|tool| {
            let fn_id = workspace.product_fn_ids.get(&(
                target.kind.clone(),
                product.to_owned(),
                tool.clone(),
            ));
            match fn_id.and_then(|fn_id| persisted_key(fn_id, &target.address).ok()) {
                // Key couldn't be recomputed (missing fn_id registration,
                // which shouldn't happen for a live product) — conservatively stale.
                None => true,
                Some(key) => !self.records.contains_key(&key) || stale.contains(&key),
            }
        })
    }
}

#[derive(Serialize)]
struct RefOnlyArg<'a> {
    __imp_ref_addr: &'a str,
}

#[derive(Serialize)]
struct PersistKeyParts<'a> {
    fn_id: &'a str,
    args_digest: &'a str,
}

/// Recomputes the exact persisted-record key `memo()` (`imp_core.js`)
/// writes for a call whose sole argument is the addressed target handle
/// `address` — `JSON.stringify({fn_id, args_digest})` where `args_digest` is
/// `_stable_digest([handle]).digest`, i.e. `[{"__imp_ref_addr":address}]`.
/// Field order matters (must byte-match what JS wrote): both structs here
/// serialize in declaration order regardless of serde_json's map-ordering
/// feature, so this doesn't depend on any Cargo feature flag.
fn persisted_key(fn_id: &str, address: &str) -> Result<String> {
    persisted_key_for_args(
        fn_id,
        &[RefOnlyArg {
            __imp_ref_addr: address,
        }],
    )
}

fn persisted_key_for_args(fn_id: &str, args: &impl Serialize) -> Result<String> {
    let args_digest = serde_json::to_string(args)?;
    Ok(serde_json::to_string(&PersistKeyParts {
        fn_id,
        args_digest: &args_digest,
    })?)
}

#[derive(Serialize)]
struct LabelHandlerArgs<'a> {
    flags: &'a serde_json::Value,
    selector: &'a str,
    args: &'a [String],
    mode: &'a serde_json::Value,
}

fn input_spec_is_stale(
    spec: &InputSpecRecord,
    changed_paths: &[String],
    workspace_config: &std::collections::BTreeMap<String, serde_json::Value>,
) -> bool {
    match spec.kind.as_str() {
        "read_file" => spec
            .spec
            .as_str()
            .is_some_and(|path| changed_paths.iter().any(|c| c == path)),
        "run_input" => run_input_spec_is_stale(&spec.spec, changed_paths),
        "fileset" => fileset_spec_is_stale(&spec.spec, changed_paths),
        "config_namespaces" => config_namespaces_spec_is_stale(spec, workspace_config),
        _ => false,
    }
}

fn run_input_spec_is_stale(spec: &serde_json::Value, changed_paths: &[String]) -> bool {
    let Some(path) = spec.get("path").and_then(|value| value.as_str()) else {
        return false;
    };
    match spec.get("kind").and_then(|value| value.as_str()) {
        Some("directory") => {
            if path == "." {
                return !changed_paths.is_empty();
            }
            let prefix = format!("{}/", path.trim_end_matches('/'));
            changed_paths
                .iter()
                .any(|changed| changed == path || changed.starts_with(&prefix))
        }
        Some("file" | "manifest") => changed_paths.iter().any(|changed| changed == path),
        _ => false,
    }
}

fn fileset_spec_is_stale(spec: &serde_json::Value, changed_paths: &[String]) -> bool {
    match spec.get("kind").and_then(|k| k.as_str()) {
        Some("glob") => {
            let root = spec.get("root").and_then(|v| v.as_str()).unwrap_or(".");
            let include = string_array(spec.get("include"));
            let exclude = string_array(spec.get("exclude"));
            let (Ok(include), Ok(exclude)) = (
                compile_globs("include", &include),
                compile_globs("exclude", &exclude),
            ) else {
                return false;
            };
            changed_paths
                .iter()
                .any(|path| glob_matches(root, &include, &exclude, path))
        }
        Some("literal") => {
            let paths = string_array(spec.get("paths"));
            changed_paths.iter().any(|c| paths.contains(c))
        }
        Some("union") => spec
            .get("sets")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .any(|set| fileset_spec_is_stale(set, changed_paths)),
        _ => false,
    }
}

fn glob_matches(root: &str, include: &[Regex], exclude: &[Regex], path: &str) -> bool {
    let root_relative = if root == "." {
        Some(path)
    } else {
        path.strip_prefix(&format!("{root}/"))
    };
    let Some(rel) = root_relative else {
        return false;
    };
    include.iter().any(|g| g.is_match(rel)) && !exclude.iter().any(|g| g.is_match(rel))
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Recomputes a `"config_namespaces"` spec's digest against the currently
/// loaded config and compares to what was recorded. Unlike file-backed
/// specs, this needs no git-diff prediction: the current config is already
/// fully loaded in this process, so an exact digest comparison is cheap and
/// correct (no "newly created file" analog exists for a fixed namespace
/// set). Recomputed with no mode-axis overrides — a record persisted from
/// inside a `profile()`/`link()` overlay will therefore compare unequal
/// here and be (safely, conservatively) treated as stale; reproducing the
/// exact per-call overlay from a persisted record alone is unresolved, left
/// as a known limitation rather than a blocker (over-selection, not under-).
fn config_namespaces_spec_is_stale(
    spec: &InputSpecRecord,
    workspace_config: &std::collections::BTreeMap<String, serde_json::Value>,
) -> bool {
    let Some(namespaces) = spec.spec.as_array().map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    }) else {
        return true;
    };
    let Some(recorded) = spec.resolved_digest.as_deref() else {
        return true;
    };
    match scoped_configuration_digest(
        workspace_config,
        &namespaces,
        &std::collections::BTreeMap::new(),
    ) {
        Ok(current) => current != recorded,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        key: &str,
        fn_id: &str,
        deps: Vec<&str>,
        input_specs: Vec<InputSpecRecord>,
    ) -> MemoCacheRecord {
        MemoCacheRecord {
            version: imp_store::memo::MEMO_CACHE_VERSION,
            key: key.to_owned(),
            fn_id: fn_id.to_owned(),
            module_digest: "unused-in-these-tests".to_owned(),
            result: serde_json::Value::Null,
            input_specs,
            deps: deps.into_iter().map(str::to_owned).collect(),
        }
    }

    #[test]
    fn persisted_key_matches_js_field_order_and_shape() {
        let key = persisted_key("cargoBuild@rules/rust/index.js:503:2", "//app:app").unwrap();
        assert_eq!(
            key,
            r#"{"fn_id":"cargoBuild@rules/rust/index.js:503:2","args_digest":"[{\"__imp_ref_addr\":\"//app:app\"}]"}"#
        );
    }

    #[test]
    fn label_handler_roots_are_context_keyed_and_additive() {
        let handler = crate::spike::LabelHandler {
            identity: "buildLabel#0@//rules/example:10:2".to_owned(),
            origin: "//rules/example:10:2".to_owned(),
            factory: None,
            extension: None,
        };
        let mut workspace = Workspace::default();
        workspace
            .label_primary_addresses
            .insert(7, "//pkg:item".to_owned());
        workspace.label_addresses.insert("//pkg:item".to_owned(), 7);
        workspace
            .label_handlers
            .insert((7, "build".to_owned()), vec![handler.clone()]);

        let flags = serde_json::json!({"check": false});
        let mode = serde_json::json!({"opt": "debug"});
        let context = LabelChangeContext {
            goal: "build",
            flags: &flags,
            args: &[],
            mode: &mode,
        };
        let fn_id = format!("label-handler:build:{}", handler.identity);
        let args = LabelHandlerArgs {
            flags: &flags,
            selector: "//pkg:item",
            args: &[],
            mode: &mode,
        };
        let key = persisted_key_for_args(&fn_id, &("//pkg:item", args)).unwrap();
        let root_record = record(&key, &fn_id, Vec::new(), Vec::new());
        let index = TraceIndex {
            records: HashMap::from([(key.clone(), root_record)]),
            reverse_deps: HashMap::new(),
        };

        assert!(!index.label_is_stale(&workspace, 7, Some(&context), &BTreeSet::new()));
        assert!(index.label_is_stale(&workspace, 7, Some(&context), &BTreeSet::from([key])));

        let other_flags = serde_json::json!({"check": true});
        let other_context = LabelChangeContext {
            goal: "build",
            flags: &other_flags,
            args: &[],
            mode: &mode,
        };
        assert!(index.label_is_stale(&workspace, 7, Some(&other_context), &BTreeSet::new()));

        let mut second = handler;
        second.identity = "auditLabel#1@//rules/example:11:2".to_owned();
        workspace
            .label_handlers
            .get_mut(&(7, "build".to_owned()))
            .unwrap()
            .push(second);
        assert!(index.label_is_stale(&workspace, 7, Some(&context), &BTreeSet::new()));
    }

    #[test]
    fn glob_spec_matches_new_and_deleted_paths_by_pattern_only() {
        let spec = serde_json::json!({
            "__fileset": true, "kind": "glob", "root": "crates/imp-store",
            "include": ["**/*.rs"], "exclude": []
        });
        assert!(fileset_spec_is_stale(
            &spec,
            &["crates/imp-store/src/new_file.rs".to_owned()]
        ));
        assert!(!fileset_spec_is_stale(
            &spec,
            &["crates/imp-execution/src/lib.rs".to_owned()]
        ));
    }

    #[test]
    fn literal_and_union_specs() {
        let literal = serde_json::json!({"kind": "literal", "paths": ["a.txt", "b.txt"]});
        assert!(fileset_spec_is_stale(&literal, &["b.txt".to_owned()]));
        assert!(!fileset_spec_is_stale(&literal, &["c.txt".to_owned()]));

        let union = serde_json::json!({"kind": "union", "sets": [literal.clone()]});
        assert!(fileset_spec_is_stale(&union, &["a.txt".to_owned()]));
    }

    #[test]
    fn run_input_specs_match_files_and_directory_descendants() {
        let file = serde_json::json!({"kind": "file", "path": "src/main.rs"});
        assert!(run_input_spec_is_stale(&file, &["src/main.rs".to_owned()]));
        assert!(!run_input_spec_is_stale(&file, &["src/lib.rs".to_owned()]));

        let directory = serde_json::json!({"kind": "directory", "path": "src"});
        assert!(run_input_spec_is_stale(
            &directory,
            &["src/nested/module.rs".to_owned()]
        ));
        assert!(!run_input_spec_is_stale(
            &directory,
            &["tests/example.rs".to_owned()]
        ));

        let workspace = serde_json::json!({"kind": "directory", "path": "."});
        assert!(run_input_spec_is_stale(
            &workspace,
            &["anywhere/file.txt".to_owned()]
        ));
    }

    #[test]
    fn stale_closure_walks_reverse_deps_transitively() {
        let records = vec![
            record("leaf", "leaf@m.js:1:1", vec![], vec![]),
            record("mid", "mid@m.js:2:1", vec!["leaf"], vec![]),
            record("top", "top@m.js:3:1", vec!["mid"], vec![]),
        ];
        let mut by_key = HashMap::new();
        let mut reverse_deps: HashMap<String, Vec<String>> = HashMap::new();
        for r in records {
            for dep in &r.deps {
                reverse_deps
                    .entry(dep.clone())
                    .or_default()
                    .push(r.key.clone());
            }
            by_key.insert(r.key.clone(), r);
        }
        let index = TraceIndex {
            records: by_key,
            reverse_deps,
        };
        let stale = index.stale_closure(BTreeSet::from(["leaf".to_owned()]));
        assert_eq!(
            stale,
            BTreeSet::from(["leaf".to_owned(), "mid".to_owned(), "top".to_owned()])
        );
    }
}
