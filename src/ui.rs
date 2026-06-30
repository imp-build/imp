use std::{io::IsTerminal, sync::Arc};

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

        let output_is_terminal = std::io::stderr().is_terminal();
        let render = prodash::render::line::render(
            std::io::stderr(),
            tree.downgrade(),
            prodash::render::line::Options {
                output_is_terminal,
                colored: output_is_terminal,
                throughput: false,
                initial_delay: Some(std::time::Duration::from_millis(100)),
                ..prodash::render::line::Options::default()
            },
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
