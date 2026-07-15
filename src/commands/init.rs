use std::collections::{BTreeSet, HashSet};
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use dialoguer::{theme::ColorfulTheme, Confirm, MultiSelect};
use rquickjs::{
    AsyncContext as JsContext, AsyncRuntime as JsRuntime, CatchResultExt, Function, Module, Object,
    Value,
};
use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

use crate::spike::WORKSPACE_FILE;

const INIT_CATALOG_JS: &str = include_str!("../../rules/init.js");
const CATALOG_MODULE_NAME: &str = "imp:init";
const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".venv",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    version: u32,
    groups: Vec<LanguageGroup>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LanguageGroup {
    id: String,
    label: String,
    description: String,
    detection: Detection,
    features: Vec<Feature>,
    warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Detection {
    file_names: Vec<String>,
    extensions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Feature {
    id: String,
    label: String,
    description: String,
}

#[derive(Clone, Debug, Serialize)]
struct Platform {
    os: &'static str,
    arch: &'static str,
}

impl Platform {
    fn current() -> Self {
        Self {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

pub async fn run() -> Result<()> {
    let current_dir = std::env::current_dir()
        .context("determine current directory")?
        .canonicalize()
        .context("canonicalize current directory")?;

    ensure_not_in_workspace(&current_dir)?;
    require_interactive(
        std::io::stdin().is_terminal(),
        std::io::stderr().is_terminal(),
    )?;

    let platform = Platform::current();
    let catalog = load_catalog(&platform).await?;
    let detected = detect_languages(&current_dir, &catalog);
    let Some(selected) = prompt_for_selection(&catalog, &detected)? else {
        println!("Initialization canceled; no files were written.");
        return Ok(());
    };
    let source = render_workspace(&platform, &selected, &detected).await?;
    let output = write_workspace(&current_dir, &source)?;
    println!("Created {}", output.display());
    Ok(())
}

fn require_interactive(stdin_is_terminal: bool, stderr_is_terminal: bool) -> Result<()> {
    if !stdin_is_terminal || !stderr_is_terminal {
        anyhow::bail!(
            "`imp init` requires an interactive terminal; run it directly from a terminal"
        );
    }
    Ok(())
}

fn ensure_not_in_workspace(current_dir: &Path) -> Result<()> {
    if let Some(existing) = find_workspace_in_ancestors(current_dir) {
        anyhow::bail!(
            "already inside an imp workspace rooted at {}; init does not create nested workspaces",
            existing.parent().unwrap_or(&existing).display()
        );
    }
    Ok(())
}

fn find_workspace_in_ancestors(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(|directory| directory.join(WORKSPACE_FILE))
        .find(|candidate| candidate.is_file())
}

async fn load_catalog(platform: &Platform) -> Result<Catalog> {
    let argument = serde_json::json!({ "platform": platform });
    let json = call_catalog_export("catalog", &argument).await?;
    let catalog: Catalog = serde_json::from_str(&json).context("decode init catalog")?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

async fn render_workspace(
    platform: &Platform,
    selected: &[String],
    detected: &BTreeSet<String>,
) -> Result<String> {
    let argument = serde_json::json!({
        "platform": platform,
        "selected": selected,
        "detected": detected,
    });
    let json = call_catalog_export("render", &argument).await?;
    serde_json::from_str(&json).context("decode rendered workspace source")
}

async fn call_catalog_export(export: &str, argument: &serde_json::Value) -> Result<String> {
    let runtime = JsRuntime::new().context("create init JavaScript runtime")?;
    let context = JsContext::full(&runtime)
        .await
        .context("create init JavaScript context")?;
    let argument_json = serde_json::to_string(argument)?;

    context
        .async_with(async |ctx| -> Result<String> {
            let module = Module::declare(ctx.clone(), CATALOG_MODULE_NAME, INIT_CATALOG_JS)
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("declare init catalog: {error}"))?;
            let (module, promise) = module
                .eval()
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("evaluate init catalog: {error}"))?;
            promise
                .into_future::<Value>()
                .await
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("evaluate init catalog: {error}"))?;

            let namespace: Object = module
                .namespace()
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("read init catalog exports: {error}"))?;
            let function: Function = namespace.get(export).catch(&ctx).map_err(|error| {
                anyhow::anyhow!("missing init catalog export '{export}': {error}")
            })?;
            let parse: Function = ctx
                .eval("(text) => JSON.parse(text)")
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("create JSON parser: {error}"))?;
            let stringify: Function = ctx
                .eval("(value) => JSON.stringify(value)")
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("create JSON serializer: {error}"))?;
            let argument: Value = parse
                .call((argument_json,))
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("parse init catalog argument: {error}"))?;
            let value: Value = function
                .call((argument,))
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("call init catalog export '{export}': {error}"))?;
            stringify
                .call((value,))
                .catch(&ctx)
                .map_err(|error| anyhow::anyhow!("serialize init catalog result: {error}"))
        })
        .await
}

fn validate_catalog(catalog: &Catalog) -> Result<()> {
    if catalog.version != 1 {
        anyhow::bail!(
            "unsupported init catalog protocol version {}; expected 1",
            catalog.version
        );
    }
    let mut ids = HashSet::new();
    for group in &catalog.groups {
        validate_id(&group.id, "language group")?;
        if group.label.trim().is_empty() {
            anyhow::bail!("init catalog group '{}' has an empty label", group.id);
        }
        if !ids.insert(group.id.as_str()) {
            anyhow::bail!("duplicate init catalog id '{}'", group.id);
        }
        for extension in &group.detection.extensions {
            if extension.is_empty()
                || extension.starts_with('.')
                || extension.chars().any(char::is_whitespace)
            {
                anyhow::bail!(
                    "init catalog group '{}' has invalid extension '{}'",
                    group.id,
                    extension
                );
            }
        }
        for feature in &group.features {
            validate_id(&feature.id, "feature")?;
            if !feature.id.starts_with(&format!("{}.", group.id)) {
                anyhow::bail!(
                    "init catalog feature '{}' must be nested under '{}'",
                    feature.id,
                    group.id
                );
            }
            if feature.label.trim().is_empty() {
                anyhow::bail!("init catalog feature '{}' has an empty label", feature.id);
            }
            if !ids.insert(feature.id.as_str()) {
                anyhow::bail!("duplicate init catalog id '{}'", feature.id);
            }
        }
    }
    Ok(())
}

fn validate_id(id: &str, kind: &str) -> Result<()> {
    if id.is_empty()
        || id.chars().any(|character| {
            !(character.is_ascii_lowercase() || character == '-' || character == '.')
        })
    {
        anyhow::bail!("init catalog {kind} has invalid id '{id}'");
    }
    Ok(())
}

fn detect_languages(root: &Path, catalog: &Catalog) -> BTreeSet<String> {
    let mut detected = BTreeSet::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_visit)
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let file_name = entry.file_name().to_string_lossy();
        let extension = entry
            .path()
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase);
        for group in &catalog.groups {
            if group
                .detection
                .file_names
                .iter()
                .any(|candidate| candidate == &file_name)
                || extension.as_ref().is_some_and(|extension| {
                    group
                        .detection
                        .extensions
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
                })
            {
                detected.insert(group.id.clone());
            }
        }
    }
    detected
}

fn should_visit(entry: &DirEntry) -> bool {
    entry.depth() == 0
        || !entry.file_type().is_dir()
        || !EXCLUDED_DIRECTORIES.contains(&entry.file_name().to_string_lossy().as_ref())
}

fn prompt_for_selection(
    catalog: &Catalog,
    detected: &BTreeSet<String>,
) -> Result<Option<Vec<String>>> {
    let theme = ColorfulTheme::default();
    let language_items: Vec<String> = catalog
        .groups
        .iter()
        .map(|group| {
            let detected_suffix = detected
                .contains(&group.id)
                .then_some(" (detected)")
                .unwrap_or_default();
            format!("{}{} — {}", group.label, detected_suffix, group.description)
        })
        .collect();
    let language_defaults: Vec<bool> = catalog
        .groups
        .iter()
        .map(|group| detected.contains(&group.id))
        .collect();
    let language_indices = MultiSelect::with_theme(&theme)
        .with_prompt("Languages")
        .items(&language_items)
        .defaults(&language_defaults)
        .interact()
        .context("prompt for languages")?;

    let mut selected = Vec::new();
    for index in language_indices {
        let group = &catalog.groups[index];
        selected.push(group.id.clone());
        if group.features.is_empty() {
            continue;
        }
        let feature_items: Vec<String> = group
            .features
            .iter()
            .map(|feature| format!("{} — {}", feature.label, feature.description))
            .collect();
        let feature_defaults = vec![detected.contains(&group.id); group.features.len()];
        let feature_indices = MultiSelect::with_theme(&theme)
            .with_prompt(format!("{} features", group.label))
            .items(&feature_items)
            .defaults(&feature_defaults)
            .interact()
            .with_context(|| format!("prompt for {} features", group.label))?;
        selected.extend(
            feature_indices
                .into_iter()
                .map(|feature_index| group.features[feature_index].id.clone()),
        );
    }

    print_summary(catalog, &selected);
    if !Confirm::with_theme(&theme)
        .with_prompt(format!("Create {WORKSPACE_FILE}?"))
        .default(true)
        .interact()
        .context("confirm workspace initialization")?
    {
        return Ok(None);
    }
    Ok(Some(selected))
}

fn print_summary(catalog: &Catalog, selected: &[String]) {
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut warnings = BTreeSet::new();
    eprintln!();
    if selected.is_empty() {
        eprintln!("No integrations selected; a workspace marker will be created.");
        return;
    }
    eprintln!("Selected integrations:");
    for group in &catalog.groups {
        if !selected.contains(group.id.as_str()) {
            continue;
        }
        let features: Vec<&str> = group
            .features
            .iter()
            .filter(|feature| selected.contains(feature.id.as_str()))
            .map(|feature| feature.label.as_str())
            .collect();
        if features.is_empty() {
            eprintln!("  {}", group.label);
        } else {
            eprintln!("  {}: {}", group.label, features.join(", "));
        }
        if let Some(warning) = &group.warning {
            warnings.insert(warning.as_str());
        }
    }
    for warning in warnings {
        eprintln!("  warning: {warning}");
    }
    eprintln!();
}

fn write_workspace(root: &Path, source: &str) -> Result<PathBuf> {
    let output = root.join(WORKSPACE_FILE);
    let mut temporary = tempfile::NamedTempFile::new_in(root)
        .with_context(|| format!("create temporary file in {}", root.display()))?;
    temporary
        .write_all(source.as_bytes())
        .with_context(|| format!("write temporary workspace file for {}", output.display()))?;
    temporary
        .flush()
        .context("flush temporary workspace file")?;
    temporary
        .as_file()
        .sync_all()
        .context("sync temporary workspace file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o644))
            .context("set workspace file permissions")?;
    }
    temporary.persist_noclobber(&output).map_err(|error| {
        anyhow::anyhow!(
            "create {} without overwriting an existing file: {}",
            output.display(),
            error.error
        )
    })?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux() -> Platform {
        Platform {
            os: "linux",
            arch: "x86_64",
        }
    }

    #[tokio::test]
    async fn built_in_catalog_is_valid() {
        let catalog = load_catalog(&linux()).await.unwrap();
        assert_eq!(
            catalog
                .groups
                .iter()
                .map(|group| group.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "js", "odin", "python", "rust"]
        );
        assert!(catalog.groups.iter().all(|group| group.warning.is_none()));
    }

    #[tokio::test]
    async fn empty_selection_renders_only_the_marker() {
        let source = render_workspace(&linux(), &[], &BTreeSet::new())
            .await
            .unwrap();
        assert_eq!(
            source,
            "// Generated by `imp init`.\n// Edit this file to change the workspace integrations.\n"
        );
    }

    #[tokio::test]
    async fn renderer_keeps_language_formatters_independent() {
        let selected = vec![
            "python".to_owned(),
            "rust".to_owned(),
            "rust.fmt".to_owned(),
        ];
        let source = render_workspace(&linux(), &selected, &BTreeSet::new())
            .await
            .unwrap();
        assert!(source.contains("//rules/rust/rustfmt"));
        assert!(source.contains("//rules/workflows/fmt_goal"));
        assert!(!source.contains("//rules/workflows/fmt\""));
        assert!(!source.contains("ruffToolchain"));
        assert!(!source.contains("//rules/python/ruff/fmt"));
        assert_eq!(source.matches("gccToolchain").count(), 2);
    }

    #[tokio::test]
    async fn combined_render_deduplicates_shared_workflows_and_toolchains() {
        let catalog = load_catalog(&linux()).await.unwrap();
        let selected: Vec<String> = catalog
            .groups
            .iter()
            .flat_map(|group| {
                std::iter::once(group.id.clone())
                    .chain(group.features.iter().map(|feature| feature.id.clone()))
            })
            .collect();
        let source = render_workspace(&linux(), &selected, &BTreeSet::new())
            .await
            .unwrap();
        assert_eq!(
            source.matches("import \"//rules/workflows/test\";").count(),
            1
        );
        assert_eq!(source.matches("export const gcc =").count(), 1);
        assert!(source.contains("export const cConfig = { buildGenerate: true };"));
        assert!(source.contains("export const odinConfig = { buildGenerate: true };"));
        assert!(source.contains("export const rustConfig = { buildGenerate: true };"));
    }

    #[tokio::test]
    async fn unsupported_platforms_are_warnings_not_disabled_groups() {
        let platform = Platform {
            os: "macos",
            arch: "aarch64",
        };
        let catalog = load_catalog(&platform).await.unwrap();
        for id in ["c", "odin", "rust"] {
            assert!(catalog
                .groups
                .iter()
                .find(|group| group.id == id)
                .unwrap()
                .warning
                .is_some());
        }
    }

    #[tokio::test]
    async fn detects_languages_and_skips_generated_trees() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Cargo.toml"), "").unwrap();
        std::fs::create_dir(root.path().join("web")).unwrap();
        std::fs::write(root.path().join("web/package.json"), "{}").unwrap();
        std::fs::create_dir(root.path().join("target")).unwrap();
        std::fs::write(root.path().join("target/ignored.py"), "").unwrap();
        let catalog = load_catalog(&linux()).await.unwrap();
        let detected = detect_languages(root.path(), &catalog);
        assert_eq!(
            detected,
            BTreeSet::from(["js".to_owned(), "rust".to_owned()])
        );
    }

    #[test]
    fn rejects_non_interactive_invocations() {
        assert!(require_interactive(false, true).is_err());
        assert!(require_interactive(true, false).is_err());
        assert!(require_interactive(true, true).is_ok());
    }

    #[test]
    fn finds_an_existing_ancestor_workspace() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(WORKSPACE_FILE), "").unwrap();
        let child = root.path().join("nested/child");
        std::fs::create_dir_all(&child).unwrap();
        assert_eq!(
            find_workspace_in_ancestors(&child),
            Some(root.path().join(WORKSPACE_FILE))
        );
        assert!(ensure_not_in_workspace(&child).is_err());
    }

    #[test]
    fn workspace_write_never_clobbers() {
        let root = tempfile::tempdir().unwrap();
        let output = write_workspace(root.path(), "first\n").unwrap();
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "first\n");
        assert!(write_workspace(root.path(), "second\n").is_err());
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "first\n");
    }

    #[tokio::test]
    async fn fully_generated_workspace_loads_normally() {
        let root = tempfile::tempdir().unwrap();
        let catalog = load_catalog(&linux()).await.unwrap();
        let selected: Vec<String> = catalog
            .groups
            .iter()
            .flat_map(|group| {
                std::iter::once(group.id.clone())
                    .chain(group.features.iter().map(|feature| feature.id.clone()))
            })
            .collect();
        let source = render_workspace(&linux(), &selected, &BTreeSet::new())
            .await
            .unwrap();
        std::fs::write(root.path().join(WORKSPACE_FILE), source).unwrap();
        std::fs::write(root.path().join("BUILD.js"), "").unwrap();
        let workspace = crate::runtime::load_workspace(root.path()).await.unwrap();
        for goal in ["build", "fmt", "lint", "package", "run", "test"] {
            assert!(
                workspace.workspace.goals.contains_key(goal),
                "missing {goal}"
            );
        }
    }
}
