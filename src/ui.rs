use std::sync::Arc;

use crate::runtime::HostLogSink;

pub struct Tree {
    root: Arc<prodash::tree::Root>,
    log_sink: HostLogSink,
}

impl Tree {
    fn new() -> Self {
        let root = prodash::tree::Root::new();
        // Raw `add_child` (no `init_task`): this is a message log, not a
        // stepped task. Created once here so the workspace log sink is shared
        // across every command rather than re-created on each load.
        let log_item = root.add_child("workspace logs");
        let log_sink = HostLogSink::prodash(log_item);
        Self { root, log_sink }
    }

    pub fn add_child(&self, name: impl Into<String>) -> prodash::tree::Item {
        let item = self.root.add_child(name);
        init_task(&item);
        item
    }

    /// Shared sink that routes workspace host logs into the `workspace logs`
    /// node. Cheap to clone — the destination is behind an `Arc<Mutex<_>>`.
    pub fn log_sink(&self) -> HostLogSink {
        self.log_sink.clone()
    }

    /// An owned handle to the progress root, suitable for moving into a spawned
    /// task (e.g. a scheduler event renderer). Adds children via `add_child`.
    pub fn root_handle(&self) -> Arc<prodash::tree::Root> {
        Arc::clone(&self.root)
    }

    fn downgrade(&self) -> std::sync::Weak<prodash::tree::Root> {
        Arc::downgrade(&self.root)
    }
}

pub struct Session {
    tree: Tree,
    render: prodash::render::line::JoinHandle,
}

impl Session {
    pub fn start() -> Self {
        let tree = Tree::new();

        let render = prodash::render::line::render(
            std::io::stderr(),
            tree.downgrade(),
            prodash::render::line::Options {
                throughput: false,
                initial_delay: Some(std::time::Duration::from_millis(100)),
                ..prodash::render::line::Options::default()
            }
            .auto_configure(prodash::render::line::StreamKind::Stderr),
        );

        Self { tree, render }
    }

    pub fn tree(&self) -> &Tree {
        &self.tree
    }

    pub fn shutdown(self) {
        self.render.shutdown_and_wait();
    }
}

/// Renders a millis-since-epoch unit as floating point seconds.
#[derive(Copy, Clone, Default, Eq, PartialEq, Ord, PartialOrd, Debug)]
pub struct MillisAsFloatingPointSecs;

use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub fn format_workunit_duration_ms(duration: Duration) -> String {
    format!("{:.2}s", (duration.as_millis() as f64) / 1000.0)
}
use prodash::progress::Step;
use std::fmt;
impl MillisAsFloatingPointSecs {
    /// Computes a static Step from the given start time by converting it to "millis-since-epoch".
    pub fn start_time_to_step(start_time: &SystemTime) -> Step {
        start_time.duration_since(UNIX_EPOCH).unwrap().as_millis() as usize
    }
}

impl prodash::unit::DisplayValue for MillisAsFloatingPointSecs {
    fn display_current_value(
        &self,
        w: &mut dyn fmt::Write,
        value: Step,
        _upper: Option<Step>,
    ) -> fmt::Result {
        // Convert back from millis-since-epoch to millis elapsed.
        let start_time = UNIX_EPOCH + Duration::from_millis(value as u64);
        let elapsed_ms = start_time.elapsed().unwrap_or_else(|_| Duration::new(0, 0));
        w.write_str(&format_workunit_duration_ms(elapsed_ms))
    }
    fn display_unit(&self, _w: &mut dyn fmt::Write, _value: Step) -> fmt::Result {
        Ok(())
    }

    fn dyn_hash(&self, state: &mut dyn std::hash::Hasher) {
        state.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        );
    }
}

pub(crate) fn init_task(item: &prodash::tree::Item) {
    let start_time = SystemTime::now();
    item.init(
        None,
        Some(prodash::unit::dynamic(MillisAsFloatingPointSecs)),
    );
    item.set(MillisAsFloatingPointSecs::start_time_to_step(&start_time));
}
