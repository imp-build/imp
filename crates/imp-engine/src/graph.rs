//! Exported JavaScript graph roots and selector integration.
//!
//! Task construction and callback values stay live in QuickJS, while this
//! module owns the durable, inspectable root catalog used by native selection.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::selector::SelectorContext;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRoot {
    pub address: String,
    pub workflow: String,
    pub facet: Option<String>,
    pub handle_id: u32,
    #[serde(default)]
    pub is_default: bool,
}

impl GraphRoot {
    pub fn display(&self) -> String {
        match &self.facet {
            Some(facet) => format!("{}@{}#{}", self.address, facet, self.workflow),
            None => format!("{}#{}", self.address, self.workflow),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct GraphCatalog {
    pub roots: Vec<GraphRoot>,
}

impl GraphCatalog {
    pub fn validate(&self) -> Result<()> {
        let mut claims = BTreeSet::new();
        for root in &self.roots {
            if root.workflow.is_empty() {
                bail!("graph root '{}' has an empty workflow", root.address);
            }
            if root.facet.as_deref() == Some("") {
                bail!("graph root '{}' has an empty facet", root.address);
            }
            let claim = (
                root.address.clone(),
                root.workflow.clone(),
                root.facet.clone(),
            );
            if !claims.insert(claim) {
                bail!("duplicate exported graph root '{}'", root.display());
            }
        }
        Ok(())
    }

    pub fn workflows_at(&self, address: &str) -> BTreeSet<&str> {
        self.roots
            .iter()
            .filter(|root| root.address == address)
            .map(|root| root.workflow.as_str())
            .collect()
    }

    pub fn select(
        &self,
        workflow: &str,
        selectors: &[String],
        context: &SelectorContext,
    ) -> Result<Vec<&GraphRoot>> {
        if selectors.is_empty() {
            return Ok(Vec::new());
        }
        let mut selected: BTreeMap<(String, Option<String>), &GraphRoot> = BTreeMap::new();
        for selector in selectors {
            let (selector, facet) = split_facet(selector)?;
            // A bare exact selector's `#` suffix may be either the legacy
            // `#product` override (meaningless here — no graph root address
            // ever contains one, so it simply matches nothing) or an
            // expansion child key, once `synthetic_children` below has
            // appended `parent#childKey` roots to `self.roots`. Both cases
            // fall out of plain address matching, so no special-casing is
            // needed here.
            let parsed = context.parse(selector)?;
            let mut matches: Vec<&GraphRoot> = self
                .roots
                .iter()
                .filter(|root| root.workflow == workflow)
                .filter(|root| facet.is_none() || root.facet.as_deref() == facet)
                .filter(|root| parsed.matches_graph_address(&root.address, root.is_default))
                .collect();

            if !parsed.selects_multiple() {
                // Exact graph addresses are always named exports.
            } else if !parsed.is_recursive() {
                // A package selector prefers the BUILD module's default. If
                // it has no default for this workflow/facet, preserve the
                // familiar package-wide fallback.
                let defaults: Vec<_> = matches
                    .iter()
                    .copied()
                    .filter(|root| root.is_default)
                    .collect();
                if !defaults.is_empty() {
                    matches = defaults;
                }
            }
            for root in matches {
                selected.insert((root.address.clone(), root.facet.clone()), root);
            }
        }
        Ok(selected.into_values().collect())
    }

    pub fn select_catalog(
        &self,
        selectors: &[String],
        context: &SelectorContext,
    ) -> Result<Vec<&GraphRoot>> {
        let workflows: BTreeSet<String> = self
            .roots
            .iter()
            .map(|root| root.workflow.clone())
            .collect();
        let mut selected = BTreeMap::new();
        for workflow in workflows {
            for root in self.select(&workflow, selectors, context)? {
                selected.insert(
                    (
                        root.address.clone(),
                        root.workflow.clone(),
                        root.facet.clone(),
                    ),
                    root,
                );
            }
        }
        Ok(selected.into_values().collect())
    }
}

pub(crate) fn split_facet(selector: &str) -> Result<(&str, Option<&str>)> {
    let Some((address, facet)) = selector.rsplit_once('@') else {
        return Ok((selector, None));
    };
    if address.is_empty() || facet.is_empty() || facet.contains(['/', ':', '#', '@']) {
        bail!("invalid graph facet selector '{selector}'");
    }
    Ok((address, Some(facet)))
}

/// A declared, structural input edge discovered by
/// `__imp_walk_graph_for_introspection` (`graph_core.js`) — no task
/// execution involved, see that function's own docstring.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphWalkEdge {
    pub name: String,
    pub handle_id: u32,
}

/// One reachable handle from a discovery-only walk. `children` is only
/// populated for `"expansion-all"` nodes — the only kind with no address of
/// its own for any individual child, hence the only one worth the cost of
/// actually running discovery for (see `graph_core.js`'s
/// `_graphWalkForIntrospectionInner`). The keys are whatever `expand()`'s
/// `create()` callback returned, each mapped to its own (unexecuted) handle
/// id.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphWalkNode {
    pub id: u32,
    pub kind: String,
    #[serde(default)]
    pub edges: Vec<GraphWalkEdge>,
    #[serde(default)]
    pub children: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GraphWalk {
    pub nodes: Vec<GraphWalkNode>,
}

impl GraphWalk {
    pub fn node(&self, handle_id: u32) -> Option<&GraphWalkNode> {
        self.nodes.iter().find(|node| node.id == handle_id)
    }

    /// Synthesize `parent#childKey` roots for each `parent` root the walk
    /// found to be an `"expansion-all"` aggregate. Only the seeded roots
    /// themselves gain synthetic addresses — a handle reached transitively
    /// through a declared edge has no exported address of its own to build
    /// one from.
    pub fn synthetic_children(&self, parents: &[&GraphRoot]) -> Vec<GraphRoot> {
        let mut out = Vec::new();
        for parent in parents {
            let Some(node) = self.node(parent.handle_id) else {
                continue;
            };
            if node.kind != "expansion-all" {
                continue;
            }
            for (key, &handle_id) in &node.children {
                out.push(GraphRoot {
                    address: format!("{}#{key}", parent.address),
                    workflow: parent.workflow.clone(),
                    facet: parent.facet.clone(),
                    handle_id,
                    is_default: false,
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(address: &str, workflow: &str, facet: Option<&str>, is_default: bool) -> GraphRoot {
        root_with_handle(address, workflow, facet, is_default, 1)
    }

    fn root_with_handle(
        address: &str,
        workflow: &str,
        facet: Option<&str>,
        is_default: bool,
        handle_id: u32,
    ) -> GraphRoot {
        GraphRoot {
            address: address.to_owned(),
            workflow: workflow.to_owned(),
            facet: facet.map(str::to_owned),
            handle_id,
            is_default,
        }
    }

    #[test]
    fn package_selection_prefers_default_and_facets_are_independent() {
        let catalog = GraphCatalog {
            roots: vec![
                root("//pkg", "test", Some("unit"), true),
                root("//pkg", "test", Some("asan"), true),
                root("//pkg:library", "test", Some("unit"), false),
            ],
        };
        let selected = catalog
            .select("test", &["//pkg@asan".to_owned()], &SelectorContext::root())
            .unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].facet.as_deref(), Some("asan"));
    }

    #[test]
    fn synthetic_children_builds_parent_hash_child_key_addresses() {
        let parent = root_with_handle("//pkg:tests", "test", None, false, 10);
        let walk = GraphWalk {
            nodes: vec![GraphWalkNode {
                id: 10,
                kind: "expansion-all".to_owned(),
                edges: Vec::new(),
                children: BTreeMap::from([("crate-a".to_owned(), 11), ("crate-b".to_owned(), 12)]),
            }],
        };
        let mut children = walk.synthetic_children(&[&parent]);
        children.sort_by(|a, b| a.address.cmp(&b.address));
        assert_eq!(
            children
                .iter()
                .map(|c| c.address.as_str())
                .collect::<Vec<_>>(),
            ["//pkg:tests#crate-a", "//pkg:tests#crate-b"]
        );
        assert!(children
            .iter()
            .all(|c| c.workflow == "test" && !c.is_default));

        // A non-expansion node (e.g. an ordinary task root) contributes no
        // synthetic children.
        let plain = root_with_handle("//pkg:lib", "build", None, false, 20);
        assert!(walk.synthetic_children(&[&plain]).is_empty());
    }

    #[test]
    fn exact_selector_matches_a_synthesized_child_hash_key_address() {
        let catalog = GraphCatalog {
            roots: vec![
                root_with_handle("//pkg:tests", "test", None, false, 10),
                root_with_handle("//pkg:tests#crate-a", "test", None, false, 11),
                root_with_handle("//pkg:tests#crate-b", "test", None, false, 12),
            ],
        };
        let context = SelectorContext::root();

        let exact = catalog
            .select("test", &["//pkg:tests#crate-a".to_owned()], &context)
            .unwrap();
        assert_eq!(
            exact.iter().map(|r| r.address.as_str()).collect::<Vec<_>>(),
            ["//pkg:tests#crate-a"]
        );

        // A package/recursive selector naturally sweeps in every child
        // address alongside the parent, since matching is purely by address
        // prefix — no special-casing of `#` needed there.
        let mut swept = catalog
            .select("test", &["pkg".to_owned()], &context)
            .unwrap();
        swept.sort_by(|a, b| a.address.cmp(&b.address));
        assert_eq!(
            swept.iter().map(|r| r.address.as_str()).collect::<Vec<_>>(),
            ["//pkg:tests", "//pkg:tests#crate-a", "//pkg:tests#crate-b"]
        );
    }
}
