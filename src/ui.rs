use std::time::Duration;

use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

use crate::runtime::HostLogSink;

const TICK_INTERVAL: Duration = Duration::from_millis(200);

pub struct Tree {
    multi: MultiProgress,
    log_sink: HostLogSink,
}

impl Tree {
    fn new() -> Self {
        let multi = MultiProgress::new();
        let log_sink = HostLogSink::live(multi.clone());
        Self { multi, log_sink }
    }

    pub fn add_child(&self, name: impl Into<String>) -> ProgressBar {
        let item = self.multi.add(ProgressBar::new_spinner());
        init_task(&item);
        item.set_message(name.into());
        item
    }

    /// Shared sink that routes workspace host logs to stderr, synchronized
    /// with the progress bars via `MultiProgress::suspend`.
    pub fn log_sink(&self) -> HostLogSink {
        self.log_sink.clone()
    }

    /// An owned handle to the progress renderer, suitable for moving into a
    /// spawned task (e.g. a scheduler event renderer). Adds bars via `add`.
    pub fn multi(&self) -> MultiProgress {
        self.multi.clone()
    }
}

pub struct Session {
    tree: Tree,
}

impl Session {
    pub fn start() -> Self {
        Self { tree: Tree::new() }
    }

    pub fn tree(&self) -> &Tree {
        &self.tree
    }

    pub fn shutdown(self) {
        let _ = self.tree.multi.clear();
    }
}

/// Prints `message` to the terminal scrollback and clears `item`'s line.
///
/// One-off setup steps (toolchain install, WSL sync, ...) shouldn't stay
/// behind as static bar rows once done — every finished step otherwise pushes
/// the interesting, still-live bars further down, so the on-screen layout
/// looks different depending on which steps happened to run first.
pub(crate) fn finish_step(item: &ProgressBar, message: &str) {
    item.suspend(|| println!("{message}"));
    item.finish_and_clear();
}

pub(crate) fn init_task(item: &ProgressBar) {
    init_timed_task(item);
}

pub(crate) fn init_counted_task(item: &ProgressBar, max: usize) {
    item.set_style(counted_style());
    item.set_length(max as u64);
    item.set_position(0);
    item.enable_steady_tick(TICK_INTERVAL);
}

pub(crate) fn init_idle_task(item: &ProgressBar) {
    item.set_style(idle_style());
    item.enable_steady_tick(TICK_INTERVAL);
}

pub(crate) fn init_timed_task(item: &ProgressBar) {
    item.set_style(timed_style());
    item.enable_steady_tick(TICK_INTERVAL);
}

fn timed_style() -> ProgressStyle {
    ProgressStyle::with_template("{spinner} {elapsed_precise} {msg}").unwrap()
}

fn counted_style() -> ProgressStyle {
    ProgressStyle::with_template("{spinner} [{bar:24.cyan/blue}] {msg}").unwrap()
}

fn idle_style() -> ProgressStyle {
    ProgressStyle::with_template("  {msg}").unwrap()
}
