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
    dynamic: &'a BTreeMap<String, Target>,
    goal: &Goal,
    selectors: &[String],
) -> Result<Vec<(&'a Target, String)>> {
    let all_targets = || workspace.targets.values().chain(dynamic.values());
    let mut selected: BTreeMap<&str, (&Target, String)> = BTreeMap::new();
    if selectors.is_empty() {
        // Selection-independent goals (declared `selection: "none"`) run
        // their callback against an empty selection; everything else needs
        // an explicit selector. If the workspace exports a `//:default`
        // target, it acts as the implicit root for selector-less invocations.
        if goal.selectorless {
            return Ok(Vec::new());
        }
        if let Some(default_target) = workspace
            .targets
            .get("//:default")
            .or_else(|| dynamic.get("//:default"))
        {
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
            bail!(
                "goal '{}' requires a target selector; use '//...' to select every target \
                 with a '{}' product, or export a //:default target",
                goal.name,
                goal.product
            );
        }
    } else {
        for selector in selectors {
            // A selector may contain a product override: "//:target#product".
            let (target_sel, product_override) = match selector.split_once('#') {
                Some((t, p)) => (t, Some(p)),
                None => (selector.as_str(), None),
            };
            // Wildcard selectors (`//...`, `//dir/...`) filter to targets
            // that have the requested product; exact selectors error when
            // their target lacks it.
            let wildcard = target_sel.ends_with("...");
            let matches: Vec<_> = all_targets()
                .filter(|t| matches_selector(t, target_sel))
                .collect();
            if matches.is_empty() {
                bail!("no target matches selector '{selector}'");
            }
            let mut with_product = 0usize;
            for target in matches {
                let product = if let Some(p) = product_override {
                    let key = (target.kind.clone(), p.to_owned());
                    if !workspace.products.contains_key(&key) {
                        if wildcard {
                            continue;
                        }
                        match workspace.declared_product_names.get(p) {
                            Some(decl) => {
                                let declared_in = match (&decl.module, decl.builtin) {
                                    (Some(module), _) => format!(" (declared in {module})"),
                                    (None, true) => " (builtin)".to_owned(),
                                    (None, false) => String::new(),
                                };
                                bail!(
                                    "{} (kind '{}') has no product '{p}'{declared_in}; \
                                     no rule registers it for this kind",
                                    target.address,
                                    target.kind
                                );
                            }
                            None => {
                                let declared = workspace
                                    .declared_product_names
                                    .keys()
                                    .map(String::as_str)
                                    .collect::<Vec<_>>()
                                    .join(", ");
                                bail!(
                                    "'{p}' is not a declared product name; declared names: {declared}. \
                                     If it comes from a rule module, import that module from \
                                     imp.workspace.js"
                                );
                            }
                        }
                    }
                    p.to_owned()
                } else {
                    match goal_product_for_kind(workspace, goal, &target.kind) {
                        Some(product) => product,
                        None if wildcard => continue,
                        None => bail!("{} has no {} product", target.address, goal.name),
                    }
                };
                with_product += 1;
                selected.insert(target.address.as_str(), (target, product));
            }
            if with_product == 0 {
                bail!(
                    "selector '{selector}' matches no target with a '{}' product",
                    product_override.unwrap_or(goal.product.as_str())
                );
            }
        }
    }
    Ok(selected.into_values().collect())
}

/// Return the product a goal would request for a given target kind, or `None`
/// if the goal has nothing to produce for that kind.
fn goal_product_for_kind(workspace: &Workspace, goal: &Goal, kind: &str) -> Option<String> {
    let key = (kind.to_owned(), goal.product.clone());
    workspace
        .products
        .contains_key(&key)
        .then(|| goal.product.clone())
}

fn matches_selector(target: &Target, selector: &str) -> bool {
    // Recursive wildcard: `//...` matches every target, `//dir/...` every
    // target at or below `dir` (`//dir:x` and `//dir/sub:y`).
    if let Some(prefix) = selector.strip_suffix("...") {
        let prefix = prefix.strip_suffix('/').unwrap_or(prefix);
        let prefix = match prefix {
            "" | "/" | "//" => return true,
            p if p.starts_with("//") => p.to_owned(),
            p => format!("//{p}"),
        };
        return target.address.starts_with(&format!("{prefix}/"))
            || target.address.starts_with(&format!("{prefix}:"));
    }
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

    #[test]
    fn matches_selector_supports_recursive_wildcards() {
        let nested = target("//library/jodin:jodin");
        let in_dir = target("//library:lib");
        let at_root = target("//:pkg");

        // `//...` matches everything.
        for t in [&nested, &in_dir, &at_root] {
            assert!(matches_selector(t, "//..."));
        }

        // `//dir/...` matches targets in the directory and below it.
        assert!(matches_selector(&nested, "//library/..."));
        assert!(matches_selector(&in_dir, "//library/..."));
        assert!(!matches_selector(&at_root, "//library/..."));
        assert!(matches_selector(&nested, "//library/jodin/..."));
        assert!(!matches_selector(&in_dir, "//library/jodin/..."));

        // Bare (non-"//") form, mirroring the other bare selector forms.
        assert!(matches_selector(&nested, "library/..."));

        // Prefixes match whole path components, not substrings.
        assert!(!matches_selector(&nested, "//lib/..."));
    }
}
