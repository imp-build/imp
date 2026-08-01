//! QuickJS runtime integration for workspace loading and live product evaluation.
//!
//! This module is the public home for the embedded JavaScript runtime APIs
//! while the larger runtime implementation is split down further.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU8},
    Arc, Mutex,
};

use rquickjs::{AsyncContext as JsContext, AsyncRuntime as Runtime};

use crate::changed::ImportGraph;
use crate::spike::{DiscoveredLabels, HostState, Target, Workspace};
use imp_scheduler::Scheduler;

/// A loaded workspace with a live QuickJS runtime.
///
/// Keeps the runtime and context alive so that rule `exec` functions can be
/// called during task execution. Use `Deref` to access the underlying
/// [`Workspace`] for planning and inspection.
pub struct LiveWorkspace {
    pub workspace: Workspace,
    #[allow(dead_code)]
    pub runtime: Runtime,
    pub ctx: JsContext,
    /// Workspace root made available to host functions during task execution.
    #[allow(dead_code)]
    pub exec_root: Arc<Mutex<Option<PathBuf>>>,
    /// Cache bypass for live `run()` execution. Set by command entry points for
    /// the duration of live execution.
    pub exec_no_cache: Arc<AtomicBool>,
    /// Whether memo-trace input specs should be checked against
    /// the tracked inputs declared by live `run()` calls.
    pub trace_inputs: Arc<AtomicBool>,
    /// Sandbox retention policy for live `run()` execution, encoded as a
    /// [`imp_exec_api::SandboxRetention`] via `as_u8`/`from_u8`. Set by command
    /// entry points for the duration of live execution.
    pub exec_sandbox_retention: Arc<AtomicU8>,
    /// Scheduler that live `run()` calls submit to. Installed for the duration
    /// of an execution and cleared afterward; `None` outside execution context.
    pub scheduler: Arc<Mutex<Option<Arc<Scheduler>>>>,
    /// MultiProgress handle for the live dynamic UI, so a streamed `run()`
    /// call can suspend it for the duration of the launched process.
    /// Installed for the duration of a command's execution, mirroring
    /// `scheduler`.
    pub ui_multi: Arc<Mutex<Option<indicatif::MultiProgress>>>,
    /// Targets resolved by `select_roots` for the goal currently executing,
    /// queryable from JS as `selectedTargets()`. Set for the duration of
    /// `execute_goal_live` and reset to `None` afterward — unlike `exec_root`,
    /// this must not go stale, since it's readable from other live-execution
    /// paths that share this `LiveWorkspace` (e.g. rules-test evaluation).
    pub selected_roots: Arc<Mutex<Option<Vec<serde_json::Value>>>>,
    /// Flags resolved for the goal currently executing, queryable from JS as
    /// `goalFlags()`. Set for the duration of `execute_goal_live` and reset to
    /// `None` afterward, mirroring `selected_roots`.
    pub goal_flags: Arc<Mutex<Option<serde_json::Value>>>,
    /// Arguments supplied after `--` to the current `run` invocation,
    /// queryable from JS as `runArgs()`. Kept separate from goal flags so
    /// arbitrary program argv never participates in selector parsing.
    pub run_args: Arc<Mutex<Option<Vec<String>>>>,
    /// The same host state used during workspace load, retained so
    /// `ensure_expanded` can invoke expanders live and materialize the
    /// pending targets they register via `registerTarget()`.
    pub host_state: Arc<Mutex<HostState>>,
    /// JS module import edges recorded while loading the workspace, shared
    /// with the module resolver. Read by changed-target detection to map a
    /// changed rule module onto the packages that transitively import it.
    pub import_graph: Arc<Mutex<ImportGraph>>,
    /// Session-scoped overlay of targets materialized by lazy expansion.
    /// Reset at the start of each `execute_goal_live`/`evaluate_product_json`
    /// invocation; merged with `workspace.targets` at selector-resolution time.
    pub dynamic_targets: Arc<Mutex<BTreeMap<String, Target>>>,
    /// Immediate parent → minted-children links recorded by `ensure_expanded`
    /// as `expand()` rules register targets. Lets a selector that names an
    /// expansion source directly (e.g. a `cargo_package` target addressed
    /// exactly, not via a package/wildcard selector) still pick up whatever
    /// it expanded into — an exact address match alone can't, since minted
    /// children live at different addresses.
    pub expansion_children: Arc<Mutex<BTreeMap<String, Vec<String>>>>,
    /// Labels materialized by async discovery callbacks. Kept separate from
    /// the immutable definition-phase workspace and merged for selection.
    pub discovered_labels: Arc<Mutex<DiscoveredLabels>>,
    /// The execution service live `run()`/worker/toolchain host functions go
    /// through — the in-process local executor today, a daemon client later.
    /// Owns the persistent-worker registry and all other live execution
    /// state. Held here so it lives exactly as long as the JS runtime that
    /// captured it.
    #[allow(dead_code)]
    pub service: std::sync::Arc<dyn imp_exec_api::ExecutionService>,
    /// Loaded tree-sitter grammars and parsed trees, backing `loadGrammar()`/
    /// `parseSource()`/`treeSexp()`/`tsQuery()`. Held here so grammar
    /// libraries (dlopen'd once, never unloaded) live exactly as long as the
    /// JS runtime that may still reference their parsed trees.
    pub grammar_registry: Arc<imp_treesitter::GrammarRegistry>,
}

impl std::fmt::Debug for LiveWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveWorkspace")
            .field("workspace", &self.workspace)
            .field("runtime", &"AsyncRuntime { .. }")
            .field("ctx", &"AsyncContext { .. }")
            .field("exec_root", &"Arc<Mutex<..>>")
            .field("exec_no_cache", &"Arc<AtomicBool>")
            .field("trace_inputs", &"Arc<AtomicBool>")
            .field("exec_sandbox_retention", &"Arc<AtomicU8>")
            .field("selected_roots", &"Arc<Mutex<..>>")
            .field("goal_flags", &"Arc<Mutex<..>>")
            .field("host_state", &"Arc<Mutex<..>>")
            .field("import_graph", &"Arc<Mutex<..>>")
            .field("dynamic_targets", &"Arc<Mutex<..>>")
            .field("expansion_children", &"Arc<Mutex<..>>")
            .field("discovered_labels", &"Arc<Mutex<..>>")
            .field("service", &"Arc<dyn ExecutionService>")
            .field("grammar_registry", &"Arc<GrammarRegistry>")
            .finish()
    }
}

impl std::ops::Deref for LiveWorkspace {
    type Target = Workspace;
    fn deref(&self) -> &Workspace {
        &self.workspace
    }
}

pub use crate::spike::load_workspace;
