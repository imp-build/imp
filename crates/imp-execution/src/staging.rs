//! Frontend-only staging for hermetic execution requests.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Result};
use imp_exec_api::ExecIoSpec;
use imp_store::cache::{artifact_relative_path, materialize_cached_artifacts, store_file_blob};
use imp_store::digest::{
    capture_directory, merge_digests, nest_directory, nest_file, DirectoryDigest,
};

pub fn resolve_input_digest(workspace_root: &Path, inputs: &[ExecIoSpec]) -> Result<String> {
    let mut trees = Vec::with_capacity(inputs.len());
    for input in inputs {
        let tree = match input.kind.as_str() {
            "digest" => DirectoryDigest::from_digest(
                input
                    .digest
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("digest input is missing its digest"))?,
            ),
            "file" | "manifest" => {
                let path = input
                    .path
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("{} input is missing its path", input.kind))?;
                let source = workspace_root.join(artifact_relative_path(path)?);
                let (digest, size) = store_file_blob(&source, &input.kind)?;
                nest_file(path, digest, size, imp_store::cache::file_mode(&source)?)?
            }
            "directory" => {
                let path = input
                    .path
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("directory input is missing its path"))?;
                let captured =
                    capture_directory(&workspace_root.join(artifact_relative_path(path)?))?;
                nest_directory(path, &captured)?
            }
            other => bail!("unsupported input kind {other}"),
        };
        trees.push(tree);
    }
    Ok(merge_digests(trees)?.digest().to_owned())
}

pub fn resolve_base_env(entries: &[String]) -> Result<BTreeMap<String, String>> {
    let mut env = crate::exec::passthrough_env_snapshot();
    env.extend(crate::exec::resolve_env(entries)?);
    Ok(env)
}

pub fn materialize_outputs(
    outputs: &[imp_store::cache::CachedArtifact],
    workspace_root: &Path,
) -> Result<()> {
    materialize_cached_artifacts(outputs, workspace_root)
}
