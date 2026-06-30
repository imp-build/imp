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

pub(crate) fn init_task(item: &prodash::tree::Item) {
    item.init(None, Some(prodash::unit::label("steps")));
}
