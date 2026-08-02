//! Target selector parsing and resolution.
//!
//! Exact targets use `:` (`:name`, `path:name`, `//path:name`). Package
//! selectors omit it (`.`, `path`, `path/...`, `//...`). Relative selectors
//! resolve from the invocation package; `//` anchors them at the workspace.
//! Goal selectors may also carry a product override (`selector#product`).

use std::collections::{BTreeMap, BTreeSet};
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

    pub(crate) fn parse(&self, selector: &str) -> Result<ParsedSelector> {
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
pub(crate) enum ParsedSelector {
    Exact(String),
    Package { package: String, recursive: bool },
}

impl ParsedSelector {
    fn matches(&self, target: &Target) -> bool {
        self.matches_address(&target.address)
    }

    /// Pure address-pattern match, factored out of `matches` so label
    /// selection (`select_label_roots_in`) can
    /// reuse the exact same exact/package/recursive semantics `Target`
    /// selection uses, without needing a `Target` to match against.
    pub(crate) fn matches_address(&self, address: &str) -> bool {
        match self {
            Self::Exact(selector_address) => address == *selector_address,
            Self::Package { package, recursive } => {
                let Some((address_package, _)) =
                    address.strip_prefix("//").and_then(|a| a.split_once(':'))
                else {
                    return false;
                };
                address_package == package
                    || (*recursive
                        && (package.is_empty()
                            || address_package.starts_with(&format!("{package}/"))))
            }
        }
    }

    pub(crate) fn selects_multiple(&self) -> bool {
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

/// Resolve selectors against sealed label addresses, filtered to labels
/// with at least one handler attached for
/// `goal`. Parallels `select_roots_in`'s exact/package/recursive/`//...`
/// semantics, but over `workspace.label_addresses` instead of
/// `workspace.targets`, and "has the goal's product" becomes "has ≥1
/// attached handler for the goal".
///
/// An empty `selectors` list returns no roots (the caller — target
/// selection via `select_roots_in` — already owns the
/// selector-required/selectorless error for the goal as a whole). An
/// address pattern that matches no label at all is not an error here either:
/// it may simply be a target address instead, which `select_roots_in`
/// already validates. Once a selector *does* match one or more labels,
/// package/`//...` selectors silently skip the ones with no handler for
/// `goal`, while an exact selector on a handler-less label is a hard error
/// (mirroring `select_roots_in`'s exact-selector product-mismatch error).
pub fn select_label_roots_in(
    workspace: &Workspace,
    goal: &str,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<Vec<(u32, String)>> {
    if selectors.is_empty() {
        return Ok(Vec::new());
    }
    // Keyed by address, not label id: this both dedupes a label exported
    // under more than one alias (a `seen` id set below keeps only its first
    // matching address) and, crucially, makes the returned order
    // address-sorted rather than allocation-order-sorted — label ids are
    // assigned in evaluation order, which is not a stable or meaningful
    // dispatch order, and target selection (`select_roots_in` above) is
    // already address-sorted for the same reason.
    let mut selected: BTreeMap<&str, u32> = BTreeMap::new();
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    for selector in selectors {
        let parsed = context.parse(selector)?;
        let multi = parsed.selects_multiple();
        let matches: Vec<(&String, &u32)> = workspace
            .label_addresses
            .iter()
            .filter(|(address, _)| parsed.matches_address(address))
            .collect();
        for (address, &id) in matches {
            let has_handler = workspace
                .label_handlers
                .contains_key(&(id, goal.to_owned()));
            if !has_handler {
                if multi {
                    continue;
                }
                bail!("label '{address}' has no '{goal}' handler attached");
            }
            if seen.insert(id) {
                selected.insert(address.as_str(), id);
            }
        }
    }
    Ok(selected
        .into_iter()
        .map(|(address, id)| (id, address.to_owned()))
        .collect())
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

/// Intersect a changed address set with user-supplied path selectors. Unlike
/// goal-root selection, this validates only target addressing: the caller
/// applies the goal's product policy afterwards.
pub fn filter_changed_addresses_in(
    workspace: &Workspace,
    addresses: &std::collections::BTreeSet<String>,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<std::collections::BTreeSet<String>> {
    if selectors.is_empty() {
        return Ok(addresses.clone());
    }

    let mut selected = std::collections::BTreeSet::new();
    for selector in selectors {
        let parsed = context.parse(selector)?;
        let target_matches: Vec<_> = workspace
            .targets
            .values()
            .filter(|target| parsed.matches(target))
            .collect();
        let label_matches: Vec<_> = workspace
            .label_addresses
            .iter()
            .filter(|(address, _)| parsed.matches_address(address))
            .collect();
        if target_matches.is_empty() && label_matches.is_empty() {
            bail!("no target or label matches selector '{selector}'");
        }
        for target in target_matches {
            if addresses.contains(&target.address) {
                selected.insert(target.address.clone());
            }
        }
        for (_, &label_id) in label_matches {
            if let Some(primary) = workspace.label_primary_addresses.get(&label_id) {
                if addresses.contains(primary) {
                    selected.insert(primary.clone());
                }
            }
        }
    }
    Ok(selected)
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

/// Resolve selectors over exported labels without filtering by goal. Used by
/// workspace introspection, where the attached goals are the information
/// being requested rather than an input to selection.
pub fn select_labels_in(
    workspace: &Workspace,
    selectors: &[String],
    context: &SelectorContext,
) -> Result<Vec<(u32, String)>> {
    if selectors.is_empty() {
        bail!("a target or label selector is required; use '//...' to select every root");
    }
    let mut selected = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for selector in selectors {
        let parsed = context.parse(selector)?;
        let matches: Vec<_> = workspace
            .label_addresses
            .iter()
            .filter(|(address, _)| parsed.matches_address(address))
            .collect();
        for (address, &id) in matches {
            if seen.insert(id) {
                selected.insert(address.clone(), id);
            }
        }
    }
    Ok(selected
        .into_iter()
        .map(|(address, id)| (id, address))
        .collect())
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
    fn changed_addresses_can_be_scoped_by_valid_target_selectors() {
        let mut workspace = Workspace::default();
        for address in ["//app:app", "//app/sub:sub", "//lib:lib"] {
            workspace
                .targets
                .insert(address.to_owned(), target(address));
        }
        let addresses =
            std::collections::BTreeSet::from(["//app:app".to_owned(), "//lib:lib".to_owned()]);
        let context = SelectorContext::root();

        assert_eq!(
            filter_changed_addresses_in(
                &workspace,
                &addresses,
                &["//app/...".to_owned()],
                &context,
            )
            .unwrap(),
            std::collections::BTreeSet::from(["//app:app".to_owned()])
        );
        assert!(filter_changed_addresses_in(
            &workspace,
            &addresses,
            &["//app/sub".to_owned()],
            &context,
        )
        .unwrap()
        .is_empty());
        assert!(filter_changed_addresses_in(
            &workspace,
            &addresses,
            &["//missing".to_owned()],
            &context,
        )
        .is_err());
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

    // -----------------------------------------------------------------
    // select_label_roots_in
    // -----------------------------------------------------------------

    fn label_workspace() -> Workspace {
        let mut workspace = Workspace::default();
        // id 1: //pkg:hasher, build+test handlers attached.
        workspace
            .label_addresses
            .insert("//pkg:hasher".to_owned(), 1);
        workspace
            .label_primary_addresses
            .insert(1, "//pkg:hasher".to_owned());
        workspace
            .label_handlers
            .insert((1, "build".to_owned()), Vec::new());
        workspace
            .label_handlers
            .insert((1, "test".to_owned()), Vec::new());
        // id 2: //pkg/nested:docs, only a "fmt" handler (no "build").
        workspace
            .label_addresses
            .insert("//pkg/nested:docs".to_owned(), 2);
        workspace
            .label_primary_addresses
            .insert(2, "//pkg/nested:docs".to_owned());
        workspace
            .label_handlers
            .insert((2, "fmt".to_owned()), Vec::new());
        // id 3: //pkg:aliased and //pkg:also_aliased both name the same
        // label, which has a "build" handler — additive aliasing.
        workspace
            .label_addresses
            .insert("//pkg:aliased".to_owned(), 3);
        workspace
            .label_addresses
            .insert("//pkg:also_aliased".to_owned(), 3);
        workspace
            .label_primary_addresses
            .insert(3, "//pkg:aliased".to_owned());
        workspace
            .label_handlers
            .insert((3, "build".to_owned()), Vec::new());
        workspace
    }

    #[test]
    fn changed_label_addresses_scope_aliases_to_the_primary_root() {
        let workspace = label_workspace();
        let addresses = BTreeSet::from(["//pkg:aliased".to_owned()]);
        let selected = filter_changed_addresses_in(
            &workspace,
            &addresses,
            &["//pkg:also_aliased".to_owned()],
            &SelectorContext::root(),
        )
        .unwrap();
        assert_eq!(selected, addresses);
    }

    #[test]
    fn select_label_roots_in_supports_exact_package_recursive_and_relative_selectors() {
        let workspace = label_workspace();
        let root_context = SelectorContext::root();

        // Exact, absolute.
        let exact = select_label_roots_in(
            &workspace,
            "build",
            &["//pkg:hasher".to_owned()],
            &root_context,
        )
        .unwrap();
        assert_eq!(exact, vec![(1, "//pkg:hasher".to_owned())]);

        // Package selector, non-recursive: matches ids 1 and 3 (both in
        // package "pkg" with a "build" handler) but not id 2 (nested
        // package, different address).
        let mut package =
            select_label_roots_in(&workspace, "build", &["pkg".to_owned()], &root_context).unwrap();
        package.sort();
        assert_eq!(
            package,
            vec![
                (1, "//pkg:hasher".to_owned()),
                (3, "//pkg:aliased".to_owned()),
            ]
        );

        // Recursive selector picks up both packages, but only labels with a
        // "build" handler — id 2 (fmt-only) is silently skipped.
        let mut recursive =
            select_label_roots_in(&workspace, "build", &["pkg/...".to_owned()], &root_context)
                .unwrap();
        recursive.sort();
        assert_eq!(
            recursive,
            vec![
                (1, "//pkg:hasher".to_owned()),
                (3, "//pkg:aliased".to_owned()),
            ]
        );

        // `//...` matches every label in the workspace with the requested
        // handler.
        let mut everything =
            select_label_roots_in(&workspace, "build", &["//...".to_owned()], &root_context)
                .unwrap();
        everything.sort();
        assert_eq!(
            everything,
            vec![
                (1, "//pkg:hasher".to_owned()),
                (3, "//pkg:aliased".to_owned()),
            ]
        );

        // Relative selector, resolved from an invocation package.
        let relative_context = SelectorContext {
            package: "pkg".to_owned(),
        };
        let relative = select_label_roots_in(
            &workspace,
            "build",
            &[":hasher".to_owned()],
            &relative_context,
        )
        .unwrap();
        assert_eq!(relative, vec![(1, "//pkg:hasher".to_owned())]);

        // Either alias of id 3 resolves to the same label id.
        let via_other_alias = select_label_roots_in(
            &workspace,
            "build",
            &["//pkg:also_aliased".to_owned()],
            &root_context,
        )
        .unwrap();
        assert_eq!(via_other_alias, vec![(3, "//pkg:also_aliased".to_owned())]);
    }

    #[test]
    fn select_label_roots_in_package_selector_silently_skips_handlerless_labels() {
        let workspace = label_workspace();
        let context = SelectorContext::root();

        // id 2 exists (address matches) but has no "build" handler; a
        // package/recursive selector must silently omit it rather than
        // erroring, so a goal like `imp build //...` still succeeds when
        // some labels in scope don't implement that goal.
        let roots =
            select_label_roots_in(&workspace, "build", &["pkg/nested".to_owned()], &context)
                .unwrap();
        assert!(roots.is_empty());

        let recursive =
            select_label_roots_in(&workspace, "build", &["//...".to_owned()], &context).unwrap();
        assert!(!recursive.iter().any(|(id, _)| *id == 2));
    }

    #[test]
    fn select_label_roots_in_exact_selector_errors_on_handlerless_goal() {
        let workspace = label_workspace();
        let context = SelectorContext::root();

        // id 2's address matches exactly, but it has no "build" handler —
        // this is a clear, distinct error from "no label matches".
        let error = select_label_roots_in(
            &workspace,
            "build",
            &["//pkg/nested:docs".to_owned()],
            &context,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("//pkg/nested:docs"), "{error}");
        assert!(error.contains("build"), "{error}");
    }

    #[test]
    fn select_label_roots_in_returns_empty_for_address_that_matches_no_label() {
        // An address that isn't a label at all (e.g. it's a target, or
        // doesn't exist) is not this function's error to raise — that's
        // select_roots_in's job; select_label_roots_in just contributes
        // nothing.
        let workspace = label_workspace();
        let context = SelectorContext::root();
        let roots =
            select_label_roots_in(&workspace, "build", &["//not/a:label".to_owned()], &context)
                .unwrap();
        assert!(roots.is_empty());
    }
}
