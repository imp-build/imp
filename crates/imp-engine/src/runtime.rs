//! Live Luau workspace and shared execution state.
//!
//! This module is the public home for the Luau runtime APIs
//! while the larger runtime implementation is split down further.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU8},
    Arc, Mutex,
};

use crate::changed::ImportGraph;
use crate::spike::{DiscoveredLabels, HostState, Target, Workspace};
use imp_scheduler::Scheduler;
pub struct LiveWorkspace {
    pub workspace: Workspace,
    pub luau: RefCell<crate::luau::LuauWorkspace>,
    #[allow(dead_code)]
    pub exec_root: Arc<Mutex<Option<PathBuf>>>,
    pub exec_no_cache: Arc<AtomicBool>,
    pub trace_inputs: Arc<AtomicBool>,
    pub exec_sandbox_retention: Arc<AtomicU8>,
    pub scheduler: Arc<Mutex<Option<Arc<Scheduler>>>>,
    pub ui_multi: Arc<Mutex<Option<indicatif::MultiProgress>>>,
    pub host_state: Arc<Mutex<HostState>>,
    pub import_graph: Arc<Mutex<ImportGraph>>,
    pub dynamic_targets: Arc<Mutex<BTreeMap<String, Target>>>,
    pub discovered_labels: Arc<Mutex<DiscoveredLabels>>,
    #[allow(dead_code)]
    pub service: std::sync::Arc<dyn imp_exec_api::ExecutionService>,
}

impl std::fmt::Debug for LiveWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveWorkspace")
            .field("workspace", &self.workspace)
            .field("luau", &"LuauWorkspace { .. }")
            .field("exec_root", &"Arc<Mutex<..>>")
            .field("exec_no_cache", &"Arc<AtomicBool>")
            .field("trace_inputs", &"Arc<AtomicBool>")
            .field("exec_sandbox_retention", &"Arc<AtomicU8>")
            .field("host_state", &"Arc<Mutex<..>>")
            .field("import_graph", &"Arc<Mutex<..>>")
            .field("dynamic_targets", &"Arc<Mutex<..>>")
            .field("discovered_labels", &"Arc<Mutex<..>>")
            .field("service", &"Arc<dyn ExecutionService>")
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
