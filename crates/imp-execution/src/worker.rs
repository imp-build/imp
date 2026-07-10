//! Host-managed persistent worker processes.
//!
//! Some tools rules need to shell out to (sccache's compiler-cache daemon
//! being the motivating case) are meant to be started once and reused across
//! many `run()` calls, not respawned per sandbox. `run()`'s sandboxes are
//! fresh, ephemeral directories with a forced-fresh `TMPDIR`/`HOME`
//! (`sandbox_home_tmp` in `crate::exec`) torn down at the end of each call —
//! a background daemon that outlives its spawning sandbox keeps pointing at
//! now-deleted paths, which is exactly what broke sccache when it was left
//! to auto-spawn itself from inside a sandboxed build.
//!
//! A worker here is spawned directly by the host (not from inside any
//! sandbox) into a directory that is stable both across `run()` calls and
//! across separate `imp` invocations, keyed by workspace + name. Lookup is
//! idempotent and single-flight per name via `tokio::sync::OnceCell`, so
//! concurrent `run()`s (bounded by `--jobs`) racing to request the same
//! worker only spawn it once.
//!
//! Deliberately no explicit stop: the worker outlives the `imp` process
//! that spawned it by design (that's the whole point), and is expected to
//! self-terminate on its own idle timeout (sccache defaults to 10 minutes).
//! A later request re-health-checks and, if the process died, evicts and
//! respawns.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

pub use imp_exec_api::{WorkerHandle, WorkerSpec};

pub type WorkerRegistry = Arc<Mutex<HashMap<String, Arc<OnceCell<WorkerHandle>>>>>;

pub fn new_worker_registry() -> WorkerRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

fn worker_port_by_id(workspace_id: &str, name: &str) -> u16 {
    let mut hasher = Sha256::new();
    hasher.update(workspace_id.as_bytes());
    hasher.update(b":");
    hasher.update(name.as_bytes());
    let digest = hasher.finalize();
    let n = u16::from_be_bytes([digest[0], digest[1]]);
    30000 + (n % 20000)
}

// Workers need short, stable directories: some sidecars (sccache included)
// create a Unix-domain control socket under TMPDIR, and those paths are
// capped at ~108 bytes (SUN_LEN) — a full sha256 workspace id under a
// `$HOME/.cache`-style cache_root() blows past that. Uses the same short,
// fixed `/tmp/imp` base as sandbox roots (`sandbox_base_dir`), plus a
// truncated hash, to stay well under the limit.
fn worker_dirs_by_id(workspace_id: &str, name: &str) -> Result<(PathBuf, PathBuf)> {
    let short_id = &workspace_id[..16];
    let root = imp_store::cache::sandbox_base_dir()
        .join("workers")
        .join(short_id)
        .join(name);
    let home = root.join("home");
    let tmp = root.join("tmp");
    std::fs::create_dir_all(&home).with_context(|| format!("create {}", home.display()))?;
    std::fs::create_dir_all(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    Ok((home, tmp))
}

fn run_with_worker_env(
    argv: &[String],
    handle: &WorkerHandle,
    extra_env: &[(String, String)],
) -> Result<std::process::Output> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("empty argv"))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env("HOME", &handle.home_dir)
        .env("TMPDIR", &handle.tmp_dir)
        .env("IMP_WORKER_PORT", handle.port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.output().with_context(|| format!("spawn {program}"))
}

fn is_healthy(handle: &WorkerHandle, spec: &WorkerSpec) -> bool {
    if spec.health_check_argv.is_empty() {
        return true;
    }
    run_with_worker_env(&spec.health_check_argv, handle, &spec.env)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn spawn_and_health_check(
    workspace_id: &str,
    name: &str,
    spec: &WorkerSpec,
) -> Result<WorkerHandle> {
    if spec.argv.is_empty() {
        bail!("worker '{name}' has an empty start argv");
    }
    let (home_dir, tmp_dir) = worker_dirs_by_id(workspace_id, name)?;
    let port = worker_port_by_id(workspace_id, name);
    let handle = WorkerHandle {
        home_dir,
        tmp_dir,
        port,
    };

    // The start command can legitimately fail because a worker from an
    // earlier imp invocation is still running (this process's registry is
    // always empty on a fresh start, since it doesn't persist across
    // invocations — only the worker itself does, by design; see the module
    // doc comment). So a non-zero exit here isn't fatal on its own — it's
    // only a real failure if the health check below also never succeeds.
    let start_result = run_with_worker_env(&spec.argv, &handle, &spec.env)
        .with_context(|| format!("start worker '{name}'"));

    if !spec.health_check_argv.is_empty() {
        let mut healthy = false;
        for _ in 0..20 {
            if is_healthy(&handle, spec) {
                healthy = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if !healthy {
            match start_result {
                Ok(output) if !output.status.success() => bail!(
                    "worker '{name}' start command exited with {}\nstdout:\n{}\nstderr:\n{}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr),
                ),
                Ok(_) => bail!("worker '{name}' did not become healthy after starting"),
                Err(error) => return Err(error),
            }
        }
    }

    Ok(handle)
}

/// Start a named worker, or return its existing handle if already running.
/// Single-flight per name: concurrent callers for the same name share one
/// in-flight spawn rather than racing to start it twice. If a previously
/// started worker is found to be unhealthy (e.g. it self-terminated on an
/// idle timeout), it is evicted and respawned once.
pub async fn worker_start(
    registry: &WorkerRegistry,
    workspace_id: &str,
    name: &str,
    spec: WorkerSpec,
) -> Result<WorkerHandle> {
    for attempt in 0..2 {
        let cell = {
            let mut registry = registry.lock().unwrap();
            Arc::clone(
                registry
                    .entry(name.to_owned())
                    .or_insert_with(|| Arc::new(OnceCell::new())),
            )
        };
        let result = cell
            .get_or_try_init(|| async {
                spawn_and_health_check(workspace_id, name, &spec)
                    .await
                    .map_err(|error| format!("{error:#}"))
            })
            .await;
        match result {
            Ok(handle) if is_healthy(handle, &spec) => return Ok(handle.clone()),
            Ok(_stale) => {
                registry.lock().unwrap().remove(name);
                if attempt == 1 {
                    bail!("worker '{name}' is not healthy and could not be restarted");
                }
            }
            Err(error) => bail!("worker '{name}' failed to start: {error}"),
        }
    }
    unreachable!("worker_start always returns or bails within two attempts")
}

/// Look up a worker's handle without spawning it. Returns `None` if it has
/// never been started (or never successfully so) during this process.
pub fn worker_get(registry: &WorkerRegistry, name: &str) -> Option<WorkerHandle> {
    registry.lock().unwrap().get(name)?.get().cloned()
}
