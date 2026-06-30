use std::sync::Arc;

pub struct Tree {
    root: Arc<prodash::tree::Root>,
}

impl Tree {
    fn new() -> Self {
        Self {
            root: prodash::tree::Root::new(),
        }
    }

    pub fn add_child(&self, name: impl Into<String>) -> prodash::tree::Item {
        let item = self.root.add_child(name);
        init_task(&item);
        item
    }

    pub fn add_log_child(&self, name: impl Into<String>) -> prodash::tree::Item {
        self.root.add_child(name)
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
