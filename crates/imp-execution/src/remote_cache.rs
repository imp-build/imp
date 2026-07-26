//! Optional GitHub-Actions-cache-backed remote tier for `exec.rs`'s
//! task-cache lookup. Purely additive on top of the local disk cache: a
//! remote miss (or any remote error) always falls through to real execution,
//! and a push failure after a real execution never fails the build — the
//! remote store is an accelerator, never a correctness gate.
//!
//! Enabled by setting `IMP_REMOTE_CACHE=ghac` (currently the only backend);
//! `IMP_REMOTE_CACHE_ROOT` optionally namespaces keys within that cache
//! (default `"imp"`). Both are read directly via `std::env::var`, never
//! folded into `run()`'s declared/passthrough env — so toggling this does not
//! change `action_digest`/`task_key` for any task, and does not invalidate
//! existing cache entries.
use std::path::PathBuf;
use std::sync::{mpsc, OnceLock};

use anyhow::{bail, Context, Result};
use imp_remote_cache::{Digest, RemoteStore};
use imp_store::cache::{
    cached_outputs_present, cas_blob_path, digest_bytes, store_blob, TaskCacheRecord,
};

fn remote_store() -> Option<&'static dyn RemoteStore> {
    static STORE: OnceLock<Option<Box<dyn RemoteStore>>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let backend = std::env::var("IMP_REMOTE_CACHE").ok()?;
            if backend != "ghac" {
                return None;
            }
            let root =
                std::env::var("IMP_REMOTE_CACHE_ROOT").unwrap_or_else(|_| "imp".to_owned());
            match imp_remote_cache::ghac_remote_store(&root) {
                Ok(store) => Some(Box::new(store) as Box<dyn RemoteStore>),
                Err(error) => {
                    eprintln!(
                        "warning: IMP_REMOTE_CACHE=ghac but failed to initialize: {error:#}"
                    );
                    None
                }
            }
        })
        .as_deref()
}

/// The CAS-blob digests a record's outputs reference, paired with their local
/// blob path — mirrors `cached_outputs_present`'s shallow, root-only
/// treatment of directory outputs (see that function's doc comment): a blob
/// missing deeper in a directory tree is an existing, accepted local-cache
/// risk, not one this module introduces.
///
/// Sizes come from the record itself rather than statting the local blob —
/// this must work before a remote-hit blob exists locally at all, and
/// `Digest::size_bytes` is purely descriptive here (`OpendalRemoteStore`
/// looks blobs up by hash alone). Directory outputs carry no size in the
/// record, so their digest is sized `0`.
fn output_blob_digests(record: &TaskCacheRecord) -> Result<Vec<(Digest, PathBuf)>> {
    let mut out = Vec::new();
    for output in &record.outputs {
        let (hash, size) = match output.kind.as_str() {
            "file" | "manifest" => (output.digest.clone(), output.bytes.unwrap_or(0)),
            "directory" => {
                let tree_digest = output.tree_digest.clone().ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} is a directory output with no tree_digest",
                        output.artifact_id
                    )
                })?;
                (tree_digest, 0)
            }
            "value" => continue,
            other => bail!(
                "{} has unsupported cached artifact kind {other}",
                output.artifact_id
            ),
        };
        let path = cas_blob_path(&hash)?;
        out.push((Digest::new(hash, size), path));
    }
    Ok(out)
}

fn action_result_digest(task_key: &str, size_bytes: u64) -> Digest {
    Digest::new(task_key.to_owned(), size_bytes)
}

/// On a local task-cache miss, try to hydrate one from the remote store. Any
/// remote error (unreachable, corrupt entry, missing blob) is treated as a
/// remote miss — the caller always has a correct fallback in real execution.
pub fn try_remote_hit(task_key: &str) -> Option<TaskCacheRecord> {
    let store = remote_store()?;
    match try_remote_hit_inner(store, task_key) {
        Ok(record) => record,
        Err(error) => {
            eprintln!("warning: remote cache lookup for {task_key} failed: {error:#}");
            None
        }
    }
}

/// Non-blocking counterpart to [`try_remote_hit`]: if a remote store is
/// configured, kicks off the lookup on a tokio blocking-pool thread and
/// returns immediately with a receiver for the eventual answer, so a caller
/// can race it against real execution instead of waiting on it. Returns
/// `None` (no thread spawned) if no remote store is configured, mirroring
/// `try_remote_hit`'s own `remote_store()?` short-circuit.
pub fn spawn_remote_hit(task_key: &str) -> Option<mpsc::Receiver<Option<TaskCacheRecord>>> {
    remote_store()?;
    let (tx, rx) = mpsc::channel();
    let task_key = task_key.to_owned();
    tokio::task::spawn_blocking(move || {
        let record = try_remote_hit(&task_key);
        // A safe no-op if the sandbox side already won and dropped its receiver.
        let _ = tx.send(record);
    });
    Some(rx)
}

fn try_remote_hit_inner(
    store: &dyn RemoteStore,
    task_key: &str,
) -> Result<Option<TaskCacheRecord>> {
    let handle = tokio::runtime::Handle::current();

    let Some(bytes) =
        handle.block_on(store.get_action_result(&action_result_digest(task_key, 0)))?
    else {
        return Ok(None);
    };
    let record: TaskCacheRecord =
        serde_json::from_slice(&bytes).context("parse remote task cache record")?;
    if record.task_key != task_key {
        bail!(
            "remote action result task_key mismatch: expected {task_key}, got {}",
            record.task_key
        );
    }

    // What's missing *locally* (not remotely — `find_missing_blobs` answers
    // the opposite question, "what does the remote not have", which is what
    // the push path needs instead) determines what to download here.
    let wanted = output_blob_digests(&record)?;
    let locally_missing: Vec<Digest> = wanted
        .into_iter()
        .filter(|(_, path)| !path.is_file())
        .map(|(digest, _)| digest)
        .collect();
    if !locally_missing.is_empty() {
        let fetched = handle.block_on(store.batch_read_blobs(&locally_missing))?;
        for (digest, result) in fetched {
            let bytes = result.with_context(|| format!("download blob {}", digest.hash))?;
            if digest_bytes(&bytes) != digest.hash {
                bail!(
                    "remote blob {} content does not match its digest",
                    digest.hash
                );
            }
            store_blob(&bytes, "remote-cache-blob")?;
        }
    }

    cached_outputs_present(&record)
        .context("remote task record references blobs missing locally after hydration")?;
    Ok(Some(record))
}

/// Schedule a best-effort push of a freshly-written local record (and the CAS
/// blobs it references) to the remote store.
///
/// Remote writes are an accelerator for *later* invocations, never a
/// prerequisite for the command that just completed. The task record has
/// already been persisted locally before this is called, and failures remain
/// diagnostic-only.
///
/// This deliberately provides no completion result. The scheduler reports a
/// task as fresh as soon as its real work is done; claiming `FreshPushed`
/// before a background upload finishes would make completion telemetry lie.
pub fn spawn_remote_push(record: TaskCacheRecord) {
    let Some(store) = remote_store() else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = push_remote_inner(store, &record).await {
            eprintln!(
                "warning: failed to push task {} to remote cache: {error:#}",
                record.task_key
            );
        }
    });
}

async fn push_remote_inner(store: &dyn RemoteStore, record: &TaskCacheRecord) -> Result<()> {
    let blobs = output_blob_digests(record)?;
    let blob_digests: Vec<Digest> = blobs.iter().map(|(digest, _)| digest.clone()).collect();
    let missing = store.find_missing_blobs(&blob_digests).await?;
    if !missing.is_empty() {
        let mut uploads = Vec::with_capacity(missing.len());
        for digest in &missing {
            let (_, path) = blobs
                .iter()
                .find(|(candidate, _)| candidate == digest)
                .expect("missing digest came from blobs");
            let bytes = tokio::fs::read(path)
                .await
                .with_context(|| format!("read {}", path.display()))?;
            uploads.push((digest.clone(), bytes));
        }
        let results = store.batch_update_blobs(uploads).await?;
        for (digest, result) in results {
            if let Err(error) = result {
                return Err(error).with_context(|| format!("upload blob {}", digest.hash));
            }
        }
    }

    let encoded = serde_json::to_vec(record).context("serialize task cache record")?;
    let action_digest = action_result_digest(&record.task_key, encoded.len() as u64);
    store.update_action_result(&action_digest, encoded).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use async_trait::async_trait;
    use opendal::services::Memory;
    use opendal::Operator;
    use imp_remote_cache::OpendalRemoteStore;
    use imp_store::cache::CachedArtifact;

    use super::*;

    fn memory_store() -> OpendalRemoteStore {
        let op = Operator::new(Memory::default()).unwrap().finish();
        OpendalRemoteStore::new(op)
    }

    fn unique_nanos() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    fn unique_bytes(tag: &str) -> Vec<u8> {
        format!("remote-cache-test-{tag}-{}", unique_nanos()).into_bytes()
    }

    fn file_record(task_key: &str, content: &[u8]) -> TaskCacheRecord {
        let digest = digest_bytes(content);
        TaskCacheRecord {
            version: 1,
            task_id: task_key.to_owned(),
            task_key: task_key.to_owned(),
            action_digest: "test-action".to_owned(),
            input_digest: "test-input".to_owned(),
            output_digest: digest.clone(),
            named_caches: vec![],
            stdout: String::new(),
            stderr: String::new(),
            outputs: vec![CachedArtifact {
                artifact_id: "out.txt".to_owned(),
                kind: "file".to_owned(),
                path: Some("out.txt".to_owned()),
                value: None,
                digest,
                bytes: Some(content.len() as u64),
                mode: None,
                tree_digest: None,
                named_cache: None,
            }],
        }
    }

    #[derive(Default)]
    struct BlobUploadFails {
        action_updates: Mutex<Vec<Digest>>,
    }

    #[async_trait]
    impl RemoteStore for BlobUploadFails {
        async fn find_missing_blobs(&self, digests: &[Digest]) -> Result<Vec<Digest>> {
            Ok(digests.to_vec())
        }

        async fn batch_update_blobs(
            &self,
            blobs: Vec<(Digest, Vec<u8>)>,
        ) -> Result<Vec<(Digest, Result<()>)>> {
            Ok(blobs
                .into_iter()
                .map(|(digest, _)| (digest, Err(anyhow::anyhow!("upload unavailable"))))
                .collect())
        }

        async fn batch_read_blobs(
            &self,
            _digests: &[Digest],
        ) -> Result<Vec<(Digest, Result<Vec<u8>>)>> {
            Ok(Vec::new())
        }

        async fn get_action_result(&self, _action_digest: &Digest) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }

        async fn update_action_result(
            &self,
            action_digest: &Digest,
            _result: Vec<u8>,
        ) -> Result<()> {
            self.action_updates
                .lock()
                .unwrap()
                .push(action_digest.clone());
            Ok(())
        }
    }

    #[test]
    fn try_remote_hit_inner_returns_none_on_remote_miss() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let result = try_remote_hit_inner(&store, "no-such-task-key").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn try_remote_hit_inner_hydrates_a_missing_local_blob_from_remote() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("hydrate-{}", unique_nanos());
        let content = unique_bytes("hydrate");
        let record = file_record(&task_key, &content);
        let digest = record.outputs[0].digest.clone();

        // This content has never been cached locally before, so the blob is
        // genuinely absent and the test exercises the remote fetch.
        assert!(!cas_blob_path(&digest).unwrap().is_file());

        let encoded = serde_json::to_vec(&record).unwrap();
        rt.block_on(store.update_action_result(
            &Digest::new(task_key.clone(), encoded.len() as u64),
            encoded,
        ))
        .unwrap();
        rt.block_on(store.batch_update_blobs(vec![(
            Digest::new(digest.clone(), content.len() as u64),
            content.clone(),
        )]))
        .unwrap();

        let hit = try_remote_hit_inner(&store, &task_key).unwrap().unwrap();
        assert_eq!(hit.task_key, task_key);
        assert_eq!(
            std::fs::read(cas_blob_path(&digest).unwrap()).unwrap(),
            content
        );
    }

    #[test]
    fn try_remote_hit_inner_rejects_a_corrupt_remote_blob() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("corrupt-{}", unique_nanos());
        let content = unique_bytes("corrupt");
        let record = file_record(&task_key, &content);
        let digest = record.outputs[0].digest.clone();

        let encoded = serde_json::to_vec(&record).unwrap();
        rt.block_on(store.update_action_result(
            &Digest::new(task_key.clone(), encoded.len() as u64),
            encoded,
        ))
        .unwrap();
        // Upload different bytes under the claimed digest — a corrupt or
        // tampered remote entry.
        rt.block_on(store.batch_update_blobs(vec![(
            Digest::new(digest, content.len() as u64),
            b"not the real content".to_vec(),
        )]))
        .unwrap();

        assert!(try_remote_hit_inner(&store, &task_key).is_err());
    }

    #[test]
    fn push_remote_inner_round_trips_a_local_record_through_the_remote_store() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("push-{}", unique_nanos());
        let content = unique_bytes("push");
        let digest = store_blob(&content, "file").unwrap();
        let record = file_record(&task_key, &content);
        assert_eq!(record.outputs[0].digest, digest);

        rt.block_on(push_remote_inner(&store, &record)).unwrap();

        let fetched = rt
            .block_on(store.get_action_result(&Digest::new(task_key.clone(), 0)))
            .unwrap()
            .unwrap();
        let fetched_record: TaskCacheRecord = serde_json::from_slice(&fetched).unwrap();
        assert_eq!(fetched_record.task_key, task_key);

        let blobs = rt
            .block_on(store.batch_read_blobs(&[Digest::new(digest, 0)]))
            .unwrap();
        assert_eq!(blobs[0].1.as_ref().unwrap().as_slice(), content.as_slice());
    }

    #[test]
    fn push_remote_inner_does_not_publish_an_action_after_a_blob_upload_failure() {
        let store = BlobUploadFails::default();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("failed-push-{}", unique_nanos());
        let content = unique_bytes("failed-push");
        let digest = store_blob(&content, "file").unwrap();
        let record = file_record(&task_key, &content);

        let error = rt.block_on(push_remote_inner(&store, &record)).unwrap_err();
        assert!(error.to_string().contains(&digest));
        assert!(store.action_updates.lock().unwrap().is_empty());
    }
}
