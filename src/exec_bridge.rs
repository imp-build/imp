//! Frontend-side translation between JS values from `imp_core.js` and the
//! execution layer's plain-Rust specs. Everything rquickjs-flavored about
//! run() lives here so the execution crates stay JS-runtime-free.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rquickjs::Object;

use imp_execution::exec::{ExecIoSpec, ExecToolSpec};
use imp_store::cache::{named_cache_key_path_by_id, named_cache_scope_id, workspace_cache_id};

pub(crate) fn parse_io_specs<'js>(
    vals: Vec<Object<'js>>,
    shared_caches: &HashSet<String>,
) -> rquickjs::Result<Vec<ExecIoSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let kind: Option<String> = val.get("kind")?;
        let kind = kind.unwrap_or_else(|| "file".to_owned());
        let path: Option<String> = val.get("path")?;
        let digest: Option<String> = val.get("digest")?;
        // Every kind but "digest" is identified by a path; a "digest" entry
        // (a pre-merged FileSet or a chained run() output) carries its own tree
        // and has no single path, so it's the one kind allowed through without one.
        if kind != "digest" && path.is_none() {
            continue;
        }
        let named_cache = match val.get::<_, Option<Object>>("namedCache")? {
            Some(nc) => {
                let name = nc.get::<_, String>("name")?;
                let shared = shared_caches.contains(&name);
                Some(imp_store::cache::OutputNamedCache {
                    name,
                    key: nc.get::<_, String>("key")?,
                    shared,
                })
            }
            None => None,
        };
        specs.push(ExecIoSpec {
            path,
            kind,
            digest,
            named_cache,
        });
    }
    Ok(specs)
}

pub(crate) fn parse_tool_specs<'js>(
    vals: Vec<Object<'js>>,
    workspace_root: &Path,
    shared_caches: &HashSet<String>,
) -> rquickjs::Result<Vec<ExecToolSpec>> {
    let mut specs = Vec::new();
    for val in vals {
        let name: Option<String> = val.get("name")?;
        let Some(name) = name else {
            continue;
        };
        let cache: String = val.get("cache")?;
        let key: String = val.get("key")?;
        let path: Option<String> = val.get("path")?;
        let path = match path {
            Some(p) => PathBuf::from(p),
            None => {
                let workspace_id = workspace_cache_id(workspace_root);
                let scope = named_cache_scope_id(shared_caches.contains(&cache), &workspace_id);
                named_cache_key_path_by_id(scope, &cache, &key)
                    .map_err(|e| rquickjs::Error::new_loading_message("tool", format!("{e:#}")))?
            }
        };
        let bin_dirs: Option<Vec<String>> = val.get("binDirs")?;
        specs.push(ExecToolSpec {
            name,
            cache,
            key,
            path,
            bin_dirs: bin_dirs.unwrap_or_else(|| vec!["bin".to_owned()]),
        });
    }
    Ok(specs)
}
