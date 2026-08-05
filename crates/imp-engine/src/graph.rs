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
            // `#product` remains the legacy product-override syntax. A graph
            // selector never consumes it.
            if selector.contains('#') {
                continue;
            }
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

fn split_facet(selector: &str) -> Result<(&str, Option<&str>)> {
    let Some((address, facet)) = selector.rsplit_once('@') else {
        return Ok((selector, None));
    };
    if address.is_empty() || facet.is_empty() || facet.contains(['/', ':', '#', '@']) {
        bail!("invalid graph facet selector '{selector}'");
    }
    Ok((address, Some(facet)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(address: &str, workflow: &str, facet: Option<&str>, is_default: bool) -> GraphRoot {
        GraphRoot {
            address: address.to_owned(),
            workflow: workflow.to_owned(),
            facet: facet.map(str::to_owned),
            handle_id: 1,
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
}
