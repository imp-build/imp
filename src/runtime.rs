//! QuickJS runtime integration for workspace loading and live product evaluation.
//!
//! The task graph model and executor still live in `spike`; this module is the
//! public home for the embedded JavaScript runtime APIs while that larger file
//! is split down further.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

use rquickjs::{AsyncContext as JsContext, AsyncRuntime as Runtime};

use crate::scheduler::Scheduler;
use crate::spike::Workspace;

#[derive(Clone)]
pub struct HostLogSink {
    inner: Arc<Mutex<HostLogDestination>>,
}

enum HostLogDestination {
    #[allow(dead_code)]
    Stderr,
    Prodash(prodash::tree::Item),
}

impl HostLogSink {
    #[allow(dead_code)]
    pub fn stderr() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostLogDestination::Stderr)),
        }
    }

    pub fn prodash(item: prodash::tree::Item) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostLogDestination::Prodash(item))),
        }
    }

    pub fn writer(&self, level: impl Into<String>) -> HostLogWriter {
        HostLogWriter {
            sink: self.clone(),
            level: level.into(),
            buffer: String::new(),
        }
    }

    fn log(&self, level: &str, message: &str) {
        let level = level.trim();
        let text = format!("[{level}] {message}");
        match &mut *self.inner.lock().unwrap() {
            HostLogDestination::Stderr => eprintln!("{text}"),
            HostLogDestination::Prodash(item) => item.message(host_log_message_level(level), text),
        }
    }
}

pub struct HostLogWriter {
    sink: HostLogSink,
    level: String,
    buffer: String,
}

impl HostLogWriter {
    fn emit_complete_lines(&mut self) {
        while let Some(newline) = self.buffer.find('\n') {
            let mut line = self.buffer.drain(..=newline).collect::<String>();
            if line.ends_with('\n') {
                line.pop();
            }
            if line.ends_with('\r') {
                line.pop();
            }
            self.sink.log(&self.level, &line);
        }
    }
}

impl Write for HostLogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buffer.push_str(&String::from_utf8_lossy(buf));
        self.emit_complete_lines();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.sink.log(&self.level, &line);
        }
        Ok(())
    }
}

fn host_log_message_level(level: &str) -> prodash::messages::MessageLevel {
    match level.to_ascii_lowercase().as_str() {
        "error" | "failure" | "fail" => prodash::messages::MessageLevel::Failure,
        "success" | "done" => prodash::messages::MessageLevel::Success,
        _ => prodash::messages::MessageLevel::Info,
    }
}

/// A loaded workspace with a live QuickJS runtime.
///
/// Keeps the runtime and context alive so that rule `exec` functions can be
/// called during task execution. Use `Deref` to access the underlying
/// [`Workspace`] for planning and inspection.
pub struct LiveWorkspace {
    pub workspace: Workspace,
    #[allow(dead_code)]
    pub(crate) runtime: Runtime,
    pub(crate) ctx: JsContext,
    /// Workspace root made available to host functions during task execution.
    #[allow(dead_code)]
    pub(crate) exec_root: Arc<Mutex<Option<PathBuf>>>,
    /// Cache bypass for live `run()` execution. Set by command entry points for
    /// the duration of live execution.
    pub(crate) exec_no_cache: Arc<AtomicBool>,
    /// Scheduler that live `run()` calls submit to. Installed for the duration
    /// of an execution and cleared afterward; `None` outside execution context.
    pub(crate) scheduler: Arc<Mutex<Option<Arc<Scheduler>>>>,
}

impl std::fmt::Debug for LiveWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveWorkspace")
            .field("workspace", &self.workspace)
            .field("runtime", &"AsyncRuntime { .. }")
            .field("ctx", &"AsyncContext { .. }")
            .field("exec_root", &"Arc<Mutex<..>>")
            .field("exec_no_cache", &"Arc<AtomicBool>")
            .finish()
    }
}

impl std::ops::Deref for LiveWorkspace {
    type Target = Workspace;
    fn deref(&self) -> &Workspace {
        &self.workspace
    }
}

#[allow(unused_imports)]
pub use crate::spike::{
    evaluate_product_json, generate_build_files, introspect_product, load_workspace,
    load_workspace_with_host_log, IntrospectResult,
};
