//! Target selector parsing and resolution.
//!
//! Exact targets use `:` (`:name`, `path:name`, `//path:name`). Package
//! selectors omit it (`.`, `path`, `path/...`, `//...`). Relative selectors
//! resolve from the invocation package; `//` anchors them at the workspace.
//! Goal selectors may also carry a product override (`selector#product`).

use std::collections::BTreeMap;
use std::path::Path;

use crate::spike::{Goal, Target, Workspace};
use anyhow::{bail, Context, Result};

/// Invocation-relative context used to resolve CLI selectors.
///
/// Selectors without a leading `//` are relative to `package`; `//`-prefixed
/// selectors are always workspace-relative.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SelectorContext {
    package: String,
}

impl SelectorContext {
    pub fn for_invocation(workspace_root: &Path, current_dir: &Path) -> Result<Self> {
        let relative = current_dir.strip_prefix(workspace_root).with_context(|| {
            format!(
                "invocation directory {} is outside workspace {}",
                current_dir.display(),
                workspace_root.display()
            )
        })?;
        let package = relative
            .iter()
            .map(|part| {
                part.to_str().ok_or_else(|| {
                    anyhow::anyhow!(
                        "invocation directory contains non-UTF-8 path component: {}",
                        current_dir.display()
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join("/");
        Ok(Self { package })
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn root() -> Self {
        Self::default()
    }

    fn parse(&self, selector: &str) -> Result<ParsedSelector> {
        if selector.is_empty() {
            bail!("target selector cannot be empty");
        }

        if let Some((package, name)) = selector.split_once(':') {
            if name.is_empty() || name.contains(':') || name.contains('/') {
                bail!("invalid exact target selector '{selector}'");
            }
            let package = if package.is_empty() { "." } else { package };
            let package = self.normalize_package(package, selector)?;
            let address = if package.is_empty() {
                format!("//:{name}")
            } else {
                format!("//{package}:{name}")
            };
            return Ok(ParsedSelector::Exact(address));
        }

        let (package, recursive) = match selector {
            "..." => (".", true),
            "//..." => ("//", true),
            other => match other.strip_suffix("/...") {
                Some(package) => (package, true),
                None => (other, false),
            },
        };
        let package = self.normalize_package(package, selector)?;
        Ok(ParsedSelector::Package { package, recursive })
    }

    fn normalize_package(&self, package: &str, selector: &str) -> Result<String> {
        let absolute = package.starts_with("//");
        let package = package.strip_prefix("//").unwrap_or(package);
        if package.starts_with('/') {
            bail!("invalid target selector '{selector}'; use '//' for workspace-relative paths");
        }

        let mut components: Vec<&str> = if absolute || self.package.is_empty() {
            Vec::new()
        } else {
            self.package.split('/').collect()
        };
        for component in package.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    if components.pop().is_none() {
                        bail!("target selector '{selector}' escapes the workspace root");
                    }
                }
                "..." => bail!(
                    "invalid target selector '{selector}'; '...' is only valid as a final path component"
                ),
                component => components.push(component),
            }
        }
        Ok(components.join("/"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ParsedSelector {
    Exact(String),
    Package { package: String, recursive: bool },
}

impl ParsedSelector {
    fn matches(&self, target: &Target) -> bool {
        match self {
            Self::Exact(address) => target.address == *address,
            Self::Package { package, recursive } => {
                let Some((target_package, _)) = target
                    .address
                    .strip_prefix("//")
                    .and_then(|address| address.split_once(':'))
                else {
                    return false;
                };
                target_package == package
                    || (*recursive
                        && (package.is_empty()
                            || target_package.starts_with(&format!("{package}/"))))
            }
        }
    }

    fn selects_multiple(&self) -> bool {
        matches!(self, Self::Package { .. })
    }
}

pub fn select_roots_in<'a>(
    workspace: &'a Workspace,
    dynamic: &'a BTreeMap<String, Target>,
    goal: &Goal,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<Vec<(&'a Target, String)>> {
    let all_targets = || workspace.targets.values().chain(dynamic.values());
    let mut selected: BTreeMap<&str, (&Target, String)> = BTreeMap::new();
    if selectors.is_empty() {
        // Selection-independent goals (declared `selection: "none"`) run
        // their callback against an empty selection; everything else needs
        // an explicit selector.
        if goal.selectorless {
            return Ok(Vec::new());
        }
        bail!(
            "goal '{}' requires a target selector; use '//...' to select every target \
             with a '{}' product",
            goal.name,
            goal.product
        );
    } else {
        for selector in selectors {
            // A selector may contain a product override: "//:target#product".
            let (target_sel, product_override) = match selector.split_once('#') {
                Some((t, p)) => (t, Some(p)),
                None => (selector.as_str(), None),
            };
            // Package selectors filter to targets that have the requested
            // product; exact selectors error when their target lacks it.
            let parsed = context.parse(target_sel)?;
            let multi = parsed.selects_multiple();
            let matches: Vec<_> = all_targets().filter(|t| parsed.matches(t)).collect();
            if matches.is_empty() {
                bail!("no target matches selector '{selector}'");
            }
            let mut with_product = 0usize;
            for target in matches {
                let product = if let Some(p) = product_override {
                    let key = (target.kind.clone(), p.to_owned());
                    if !workspace.products.contains_key(&key) {
                        if multi {
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
                        None if multi => continue,
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

#[cfg(test)]
pub fn select_roots<'a>(
    workspace: &'a Workspace,
    dynamic: &'a BTreeMap<String, Target>,
    goal: &Goal,
    selectors: &[String],
) -> Result<Vec<(&'a Target, String)>> {
    select_roots_in(
        workspace,
        dynamic,
        goal,
        selectors,
        &SelectorContext::root(),
    )
}

/// Resolve an exact, precomputed address set (e.g. changed-target detection)
/// against the workspace with wildcard semantics: targets whose kind has no
/// product for the goal are silently skipped, and an empty result is not an
/// error. Unknown addresses are ignored — the caller derived them from the
/// same workspace, so a miss only means an expander-owned address that never
/// materialized.
pub fn select_roots_for_addresses<'a>(
    workspace: &'a Workspace,
    dynamic: &'a BTreeMap<String, Target>,
    goal: &Goal,
    addresses: &std::collections::BTreeSet<String>,
) -> Vec<(&'a Target, String)> {
    let mut selected: BTreeMap<&str, (&Target, String)> = BTreeMap::new();
    for address in addresses {
        let Some(target) = workspace
            .targets
            .get(address)
            .or_else(|| dynamic.get(address))
        else {
            continue;
        };
        if let Some(product) = goal_product_for_kind(workspace, goal, &target.kind) {
            selected.insert(target.address.as_str(), (target, product));
        }
    }
    selected.into_values().collect()
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

pub fn select_targets_in<'a>(
    workspace: &'a Workspace,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<Vec<&'a Target>> {
    if selectors.is_empty() {
        bail!("a target selector is required; use '//...' to select every target");
    }
    let mut selected = BTreeMap::new();
    for selector in selectors {
        let parsed = context.parse(selector)?;
        let matches: Vec<_> = workspace
            .targets
            .values()
            .filter(|t| parsed.matches(t))
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
pub fn select_targets<'a>(
    workspace: &'a Workspace,
    selectors: &[String],
) -> Result<Vec<&'a Target>> {
    select_targets_in(workspace, selectors, &SelectorContext::default())
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
        let context = SelectorContext::root();
        let nested = target("//library/jodin:jodin");
        let sibling = target("//library/jodin:tests");
        let descendant = target("//library/jodin/internal:helper");
        let root = target("//:pkg");

        for selector in ["//library/jodin:jodin", "library/jodin:jodin"] {
            assert!(context.parse(selector).unwrap().matches(&nested));
        }
        let package = context.parse("library/jodin").unwrap();
        assert!(package.matches(&nested));
        assert!(package.matches(&sibling));
        assert!(!package.matches(&descendant));
        assert!(!package.matches(&root));

        assert!(context.parse(":pkg").unwrap().matches(&root));
        assert!(!context.parse("jodin").unwrap().matches(&nested));
    }

    #[test]
    fn relative_selectors_resolve_from_the_invocation_package() {
        let context = SelectorContext {
            package: "foo/bar".to_owned(),
        };

        assert_eq!(
            context.parse(":app").unwrap(),
            ParsedSelector::Exact("//foo/bar:app".to_owned())
        );
        assert_eq!(
            context.parse("child:app").unwrap(),
            ParsedSelector::Exact("//foo/bar/child:app".to_owned())
        );
        assert_eq!(
            context.parse("//child:app").unwrap(),
            ParsedSelector::Exact("//child:app".to_owned())
        );
        assert_eq!(
            context.parse("../sibling").unwrap(),
            ParsedSelector::Package {
                package: "foo/sibling".to_owned(),
                recursive: false,
            }
        );
        assert_eq!(
            context.parse("...").unwrap(),
            ParsedSelector::Package {
                package: "foo/bar".to_owned(),
                recursive: true,
            }
        );
        assert!(context.parse("../../../outside").is_err());
    }

    #[test]
    fn package_goal_selection_filters_products_and_stays_non_recursive() {
        let mut workspace = Workspace::default();
        let mut buildable = target("//pkg:lib");
        buildable.kind = "lib".to_owned();
        let docs = target("//pkg:docs");
        let mut nested = target("//pkg/nested:lib");
        nested.kind = "lib".to_owned();
        for target in [buildable, docs, nested] {
            workspace.targets.insert(target.address.clone(), target);
        }
        workspace.products.insert(
            ("lib".to_owned(), "build".to_owned()),
            BTreeMap::from([("lib-tool".to_owned(), "buildLib".to_owned())]),
        );
        let goal = Goal {
            name: "build".to_owned(),
            product: "build".to_owned(),
            flags: BTreeMap::new(),
            selectorless: false,
        };
        let dynamic = BTreeMap::new();
        let context = SelectorContext::root();

        let direct =
            select_roots_in(&workspace, &dynamic, &goal, &["pkg".to_owned()], &context).unwrap();
        assert_eq!(
            direct
                .iter()
                .map(|(target, _)| target.address.as_str())
                .collect::<Vec<_>>(),
            ["//pkg:lib"]
        );

        let recursive = select_roots_in(
            &workspace,
            &dynamic,
            &goal,
            &["pkg/...".to_owned()],
            &context,
        )
        .unwrap();
        assert_eq!(
            recursive
                .iter()
                .map(|(target, _)| target.address.as_str())
                .collect::<Vec<_>>(),
            ["//pkg/nested:lib", "//pkg:lib"]
        );
    }

    #[test]
    fn default_target_does_not_bypass_required_selection() {
        let mut workspace = Workspace::default();
        let mut default = target("//:default");
        default.kind = "lib".to_owned();
        workspace.targets.insert(default.address.clone(), default);
        workspace.products.insert(
            ("lib".to_owned(), "build".to_owned()),
            BTreeMap::from([("lib-tool".to_owned(), "buildLib".to_owned())]),
        );
        let goal = Goal {
            name: "build".to_owned(),
            product: "build".to_owned(),
            flags: BTreeMap::new(),
            selectorless: false,
        };

        let error = select_roots_in(
            &workspace,
            &BTreeMap::new(),
            &goal,
            &[],
            &SelectorContext::root(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("requires a target selector"), "{error}");
    }

    #[test]
    fn select_roots_for_addresses_skips_productless_kinds_and_allows_empty() {
        let mut workspace = Workspace::default();
        let mut with_product = target("//a:a");
        with_product.kind = "lib".to_owned();
        let mut without_product = target("//b:b");
        without_product.kind = "docs".to_owned();
        workspace.targets.insert("//a:a".to_owned(), with_product);
        workspace
            .targets
            .insert("//b:b".to_owned(), without_product);
        workspace.products.insert(
            ("lib".to_owned(), "build".to_owned()),
            BTreeMap::from([("lib-tool".to_owned(), "buildLib".to_owned())]),
        );
        let goal = Goal {
            name: "build".to_owned(),
            product: "build".to_owned(),
            flags: BTreeMap::new(),
            selectorless: false,
        };

        let mut dynamic = BTreeMap::new();
        let addresses: std::collections::BTreeSet<String> = ["//a:a", "//b:b", "//gone:gone"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let roots = select_roots_for_addresses(&workspace, &dynamic, &goal, &addresses);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//a:a");
        assert_eq!(roots[0].1, "build");

        // Empty input is not an error, and dynamic targets resolve too.
        assert!(
            select_roots_for_addresses(&workspace, &dynamic, &goal, &Default::default()).is_empty()
        );
        let mut dyn_target = target("//dyn:d");
        dyn_target.kind = "lib".to_owned();
        dynamic.insert("//dyn:d".to_owned(), dyn_target);
        let addresses = std::collections::BTreeSet::from(["//dyn:d".to_owned()]);
        let roots = select_roots_for_addresses(&workspace, &dynamic, &goal, &addresses);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.address, "//dyn:d");
    }

    #[test]
    fn matches_selector_supports_recursive_wildcards() {
        let context = SelectorContext::root();
        let nested = target("//library/jodin:jodin");
        let in_dir = target("//library:lib");
        let at_root = target("//:pkg");

        // `//...` matches everything.
        for t in [&nested, &in_dir, &at_root] {
            assert!(context.parse("//...").unwrap().matches(t));
        }

        // `//dir/...` matches targets in the directory and below it.
        let library = context.parse("//library/...").unwrap();
        assert!(library.matches(&nested));
        assert!(library.matches(&in_dir));
        assert!(!library.matches(&at_root));
        let jodin = context.parse("//library/jodin/...").unwrap();
        assert!(jodin.matches(&nested));
        assert!(!jodin.matches(&in_dir));

        // Bare (non-"//") form, mirroring the other bare selector forms.
        assert!(context.parse("library/...").unwrap().matches(&nested));

        // Prefixes match whole path components, not substrings.
        assert!(!context.parse("//lib/...").unwrap().matches(&nested));
    }
}
