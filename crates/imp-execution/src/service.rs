//! The in-process [`ExecutionService`] implementation: a thin adapter over
//! this crate's sandbox executor (`exec`), asset fetching (`fetch`), and
//! persistent workers (`worker`), plus `imp-store`'s named caches. All live
//! execution-layer state (the worker registry) hangs off the service value,
//! so a Stage-B daemon can own one instance per server.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result};
use imp_exec_api::{
    Capabilities, ExecAction, ExecOutcome, ExecutionService, WorkerHandle, WorkerSpec,
};
use imp_store::cache::named_cache_key_path_by_id;

use crate::exec::{exec_run_hermetic, exec_run_hermetic_with_start};
use crate::fetch;
use crate::worker::{new_worker_registry, WorkerRegistry};

pub struct LocalExecutionService {
    workers: WorkerRegistry,
}

impl LocalExecutionService {
    pub fn new() -> Self {
        Self {
            workers: new_worker_registry(),
        }
    }

    /// The live worker registry — exposed while the frontend still hands it
    /// to `LiveWorkspace` directly; goes away once workers are reached only
    /// through the service.
    pub fn workers(&self) -> &WorkerRegistry {
        &self.workers
    }
}

impl Default for LocalExecutionService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ExecutionService for LocalExecutionService {
    fn execute(
        &self,
        workspace_id: &str,
        action: ExecAction,
        cancellation: Option<&AtomicBool>,
    ) -> Result<ExecOutcome> {
        exec_run_hermetic(workspace_id, action, cancellation)
    }

    fn execute_with_start(
        &self,
        workspace_id: &str,
        action: ExecAction,
        cancellation: Option<&AtomicBool>,
        started: &dyn Fn(),
    ) -> Result<ExecOutcome> {
        exec_run_hermetic_with_start(workspace_id, action, cancellation, started)
    }

    fn cache_dir_get(&self, workspace_id: &str, name: &str, key: &str) -> Result<Option<PathBuf>> {
        match named_cache_key_path_by_id(workspace_id, name, key) {
            Ok(p) if p.is_dir() => {
                imp_store::usage::record_named_use(workspace_id, name, key);
                Ok(Some(p))
            }
            _ => Ok(None),
        }
    }

    fn cache_dir_has(&self, workspace_id: &str, name: &str, key: &str) -> Result<bool> {
        let present = named_cache_key_path_by_id(workspace_id, name, key)
            .map(|p| p.is_dir())
            .unwrap_or(false);
        if present {
            imp_store::usage::record_named_use(workspace_id, name, key);
        }
        Ok(present)
    }

    fn cache_dir_put(
        &self,
        workspace_id: &str,
        name: &str,
        key: &str,
        source: &Path,
    ) -> Result<()> {
        imp_store::usage::record_named_use(workspace_id, name, key);
        let target = named_cache_key_path_by_id(workspace_id, name, key)?;
        std::fs::create_dir_all(&target).with_context(|| format!("create {}", target.display()))?;
        if source.is_dir() {
            copy_dir_into(source, &target)
                .with_context(|| format!("copy dir {}", source.display()))?;
        } else {
            let file_name = source
                .file_name()
                .with_context(|| format!("{}: source has no filename", source.display()))?;
            std::fs::copy(source, target.join(file_name))
                .with_context(|| format!("copy {}", source.display()))?;
        }
        Ok(())
    }

    fn fetch_url(&self, url: &str) -> Result<PathBuf> {
        fetch::host_download(url)
    }

    fn extract_archive(
        &self,
        archive: &Path,
        dest: &Path,
        format: &str,
        strip_components: u32,
    ) -> Result<()> {
        fetch::host_extract(archive, dest, format, strip_components)
    }

    fn file_sha256(&self, path: &Path) -> Result<String> {
        fetch::host_sha256(path)
    }

    fn register_native_tool(&self, name: &str, resolved: &Path) -> Result<PathBuf> {
        imp_store::cache::ensure_native_tool_artifact(name, resolved)
    }

    async fn worker_start(
        &self,
        workspace_id: &str,
        name: &str,
        spec: WorkerSpec,
    ) -> Result<WorkerHandle> {
        crate::worker::worker_start(&self.workers, workspace_id, name, spec).await
    }

    fn worker_get(&self, name: &str) -> Result<Option<WorkerHandle>> {
        Ok(crate::worker::worker_get(&self.workers, name))
    }

    fn capabilities(&self) -> Result<Capabilities> {
        let (os, arch) = fetch::host_detect_platform()?;
        Ok(Capabilities { os, arch })
    }
}

fn copy_dir_into(src: &Path, dst: &Path) -> Result<()> {
    for entry in std::fs::read_dir(src).with_context(|| format!("read {}", src.display()))? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&target)?;
            copy_dir_into(&entry.path(), &target)?;
        } else {
            std::fs::copy(&entry.path(), &target).with_context(|| {
                format!("copy {} -> {}", entry.path().display(), target.display())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_dir_roundtrip_through_the_service() {
        // Named-cache slots are namespaced by workspace id under the shared
        // cache root, so a throwaway workspace dir isolates this test from
        // everything else without touching process-global env.
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let workspace_id = imp_store::cache::workspace_cache_id(root);
        let service = LocalExecutionService::new();
        assert!(!service
            .cache_dir_has(&workspace_id, "svc-test", "k1")
            .unwrap());
        assert!(service
            .cache_dir_get(&workspace_id, "svc-test", "k1")
            .unwrap()
            .is_none());

        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("tool.txt"), b"hello").unwrap();
        service
            .cache_dir_put(&workspace_id, "svc-test", "k1", src.path())
            .unwrap();

        assert!(service
            .cache_dir_has(&workspace_id, "svc-test", "k1")
            .unwrap());
        let slot = service
            .cache_dir_get(&workspace_id, "svc-test", "k1")
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read(slot.join("tool.txt")).unwrap(), b"hello");

        // The put/get above must have left a usage row for GC to consume.
        let db = imp_store::cache::cache_root().unwrap().join("usage.db");
        let conn = rusqlite::Connection::open(db).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage WHERE kind = 'named' AND id = ?1",
                [format!("{workspace_id}/svc-test/k1")],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn capabilities_reports_a_known_platform() {
        let service = LocalExecutionService::new();
        let caps = service.capabilities().unwrap();
        assert!(["linux", "macos", "windows"].contains(&caps.os));
        assert!(["x86_64", "aarch64"].contains(&caps.arch));
    }
}
