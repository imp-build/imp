use std::time::Duration;

use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

const TICK_INTERVAL: Duration = Duration::from_millis(200);

pub struct Tree {
    multi: MultiProgress,
}

impl Tree {
    fn new() -> Self {
        let multi = MultiProgress::new();
        crate::logging::init_live(multi.clone());
        Self { multi }
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
