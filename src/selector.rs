//! Target selector parsing and resolution.
//!
//! A selector is a string like `//path:name`, `path:name`, `:name`, or a bare
//! `name`, optionally suffixed with a product override (`selector#product`).
//! This module resolves selectors against a loaded [`Workspace`]'s targets.

use std::collections::BTreeMap;

use crate::spike::{Goal, Target, Workspace};
use anyhow::{bail, Result};

pub(crate) fn select_roots<'a>(
    workspace: &'a Workspace,
    goal: &Goal,
    selectors: &[String],
) -> Result<Vec<(&'a Target, String)>> {
    let mut selected: BTreeMap<&str, (&Target, String)> = BTreeMap::new();
    if selectors.is_empty() {
        // If the workspace exports a `//:default` target, it acts as the
        // implicit root for selector-less invocations. Otherwise every target
        // that has a product for the current goal is selected.
        if let Some(default_target) = workspace.targets.get("//:default") {
            let product =
                goal_product_for_kind(workspace, goal, &default_target.kind).ok_or_else(|| {
                    anyhow::anyhow!(
                        "//:default has no {} product; add a rule for kind '{}'",
                        goal.name,
                        default_target.kind
                    )
                })?;
            selected.insert(default_target.address.as_str(), (default_target, product));
        } else {
            for target in workspace.targets.values() {
                if let Some(product) = goal_product_for_kind(workspace, goal, &target.kind) {
                    selected.insert(target.address.as_str(), (target, product));
                }
            }
        }
    } else {
        for selector in selectors {
            // A selector may contain a product override: "//:target#product".
            let (target_sel, product_override) = match selector.split_once('#') {
                Some((t, p)) => (t, Some(p)),
                None => (selector.as_str(), None),
            };
            let matches: Vec<_> = workspace
                .targets
                .values()
                .filter(|t| matches_selector(t, target_sel))
                .collect();
            if matches.is_empty() {
                bail!("no target matches selector '{selector}'");
            }
            for target in matches {
                let product = if let Some(p) = product_override {
                    let key = (target.kind.clone(), p.to_owned());
                    if !workspace.products.contains_key(&key) {
                        bail!("{} has no product '{p}'", target.address);
                    }
                    p.to_owned()
                } else {
                    goal_product_for_kind(workspace, goal, &target.kind).ok_or_else(|| {
                        anyhow::anyhow!("{} has no {} product", target.address, goal.name)
                    })?
                };
                selected.insert(target.address.as_str(), (target, product));
            }
        }
    }
    Ok(selected.into_values().collect())
}

/// Return the product a goal would request for a given target kind, or `None`
/// if the goal has nothing to produce for that kind.
fn goal_product_for_kind(workspace: &Workspace, goal: &Goal, kind: &str) -> Option<String> {
    let key = (kind.to_owned(), goal.product.clone());
    workspace.products.contains_key(&key).then(|| goal.product.clone())
}

fn matches_selector(target: &Target, selector: &str) -> bool {
    target.address == selector
        || target.address.strip_prefix("//:") == Some(selector)
        || target.address.ends_with(&format!(":{selector}"))
        || (!selector.starts_with("//") && target.address == format!("//{selector}"))
}

pub fn select_targets<'a>(
    workspace: &'a Workspace,
    selectors: &[String],
) -> Result<Vec<&'a Target>> {
    if selectors.is_empty() {
        return Ok(workspace.targets.values().collect());
    }
    let mut selected = BTreeMap::new();
    for selector in selectors {
        let matches: Vec<_> = workspace
            .targets
            .values()
            .filter(|t| matches_selector(t, selector))
            .collect();
        if matches.is_empty() {
            bail!("no target matches selector '{selector}'");
        }
        for t in matches {
            selected.insert(t.address.as_str(), t);
        }
    }
    Ok(selected.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(address: &str) -> Target {
        Target {
            address: address.to_owned(),
            kind: "dummy".to_owned(),
            attrs: serde_json::Value::Null,
            sources: Vec::new(),
            dependencies: Vec::new(),
            js_id: 0,
        }
    }

    #[test]
    fn matches_selector_recognizes_all_supported_forms() {
        let t = target("//library/jodin:jodin");
        // Full "//"-prefixed address.
        assert!(matches_selector(&t, "//library/jodin:jodin"));
        // Bare package-path form (no leading "//").
        assert!(matches_selector(&t, "library/jodin:jodin"));
        // Bare trailing target-name suffix.
        assert!(matches_selector(&t, "jodin"));
        // Non-matching package path.
        assert!(!matches_selector(&t, "other:jodin"));
        assert!(!matches_selector(&t, "nonexistent"));

        let root = target("//:pkg");
        // Root-package ":name" shorthand.
        assert!(matches_selector(&root, "pkg"));
    }
}
