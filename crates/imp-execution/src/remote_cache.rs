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
use std::sync::atomic::{AtomicUsize, Ordering};
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
            let root = std::env::var("IMP_REMOTE_CACHE_ROOT").unwrap_or_else(|_| "imp".to_owned());
            match imp_remote_cache::ghac_remote_store(&root) {
                Ok(store) => Some(Box::new(store) as Box<dyn RemoteStore>),
                Err(error) => {
                    eprintln!("warning: IMP_REMOTE_CACHE=ghac but failed to initialize: {error:#}");
                    None
                }
            }
        })
        .as_deref()
}

/// The CAS-blob digests a record's outputs reference, paired with their local
/// blob path — for `directory` outputs, every subdirectory node blob and
/// every leaf file, not just the root tree node. This assumes the whole tree
/// is already present *locally* (true for the push path, which is uploading
/// blobs this process just produced or already hydrated) — it is NOT safe to
/// use for a cold remote pull, where the tree may not exist locally yet; see
/// `fetch_tree_file_digests` for that case.
///
/// Sizes come from the record itself rather than statting the local blob —
/// `Digest::size_bytes` is purely descriptive here (`OpendalRemoteStore`
/// looks blobs up by hash alone). Directory-tree blobs (node blobs and
/// files alike) carry no size in the record, so they're sized `0`.
fn output_blob_digests(record: &TaskCacheRecord) -> Result<Vec<(Digest, PathBuf)>> {
    let mut out = Vec::new();
    for output in &record.outputs {
        match output.kind.as_str() {
            "file" | "manifest" => {
                let path = cas_blob_path(&output.digest)?;
                out.push((
                    Digest::new(output.digest.clone(), output.bytes.unwrap_or(0)),
                    path,
                ));
            }
            "directory" => {
                let tree_digest = output.tree_digest.clone().ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} is a directory output with no tree_digest",
                        output.artifact_id
                    )
                })?;
                for hash in imp_store::digest::tree_all_digests(&tree_digest)? {
                    let path = cas_blob_path(&hash)?;
                    out.push((Digest::new(hash, 0), path));
                }
            }
            "value" => continue,
            other => bail!(
                "{} has unsupported cached artifact kind {other}",
                output.artifact_id
            ),
        }
    }

    // The merged output tree is a blob in its own right, and it is *not*
    // reachable from any single output above — `exec.rs` builds it by merging
    // every output's tree, and hands its digest to callers as
    // `ExecRunResult::output_digest`. Downstream tasks consume that value
    // directly as a `{ kind: "digest" }` input, so a remote hit that restores
    // every output blob but not this one leaves the next task unable to load
    // its own input. Pushing it here is what makes the pull side able to
    // fetch it at all.
    for hash in merged_tree_digests(record)? {
        out.push((Digest::new(hash.clone(), 0), cas_blob_path(&hash)?));
    }

    Ok(out)
}

/// Every blob reachable from `record.output_digest`, or empty when the record
/// has no merged tree (`output_digest` is defaulted to an empty string for
/// records that never produced one — see `exec.rs`'s `unwrap_or_default`).
fn merged_tree_digests(record: &TaskCacheRecord) -> Result<Vec<String>> {
    if record.output_digest.is_empty() {
        return Ok(Vec::new());
    }
    imp_store::digest::tree_all_digests(&record.output_digest)
}

fn action_result_digest(task_key: &str, size_bytes: u64) -> Digest {
    Digest::new(task_key.to_owned(), size_bytes)
}

/// Fetch a directory tree's node blobs from the remote store as needed to
/// walk it, returning every leaf file's digest. Unlike a `file`/`manifest`
/// output (whose single digest is known upfront from the record), a
/// directory tree's full blob set can only be discovered by walking the tree
/// itself — and on a cold pull, even the root tree blob may not exist
/// locally yet.
///
/// Walks breadth-first, one `batch_read_blobs` call per tree depth rather
/// than one per node: sequential per-node round-trips made a cold pull of a
/// deep tree (e.g. a toolchain install) pay one network latency per
/// directory, serialized. Batching by level turns that into one round-trip
/// per level, all of that level's nodes fetched concurrently by the store.
fn fetch_tree_file_digests(
    store: &dyn RemoteStore,
    handle: &tokio::runtime::Handle,
    root_digest: &str,
    out: &mut Vec<Digest>,
) -> Result<()> {
    let mut frontier = vec![root_digest.to_owned()];
    while !frontier.is_empty() {
        let mut seen = std::collections::HashSet::new();
        let missing: Vec<Digest> = frontier
            .iter()
            .filter(|hash| seen.insert(hash.as_str()))
            .filter(|hash| !cas_blob_path(hash).is_ok_and(|path| path.is_file()))
            .map(|hash| Digest::new(hash.clone(), 0))
            .collect();
        if !missing.is_empty() {
            let fetched = handle.block_on(store.batch_read_blobs(&missing))?;
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
        let mut next_frontier = Vec::new();
        for node_digest in &frontier {
            let trie = imp_store::digest::DigestTrie::load(node_digest)?;
            for entry in trie.entries() {
                match entry {
                    imp_store::digest::Entry::File(f) => {
                        out.push(Digest::new(f.digest.clone(), 0));
                    }
                    imp_store::digest::Entry::Directory(d) => {
                        next_frontier.push(d.digest.clone());
                    }
                    imp_store::digest::Entry::Symlink(_) => {}
                }
            }
        }
        frontier = next_frontier;
    }
    Ok(())
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
    //
    // `directory` outputs are handled separately: their tree structure (and
    // thus their full blob set) can only be discovered by walking it, which
    // itself may require fetching node blobs from the remote store — unlike
    // `file`/`manifest` outputs, whose single digest is already known from
    // the record.
    let mut wanted: Vec<Digest> = Vec::new();
    for output in &record.outputs {
        match output.kind.as_str() {
            "file" | "manifest" => {
                wanted.push(Digest::new(
                    output.digest.clone(),
                    output.bytes.unwrap_or(0),
                ));
            }
            "directory" => {
                let tree_digest = output.tree_digest.clone().ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} is a directory output with no tree_digest",
                        output.artifact_id
                    )
                })?;
                // `fetch_tree_file_digests` already ensures the root (and
                // every subdirectory) node blob is fetched and stored as
                // part of walking it, so only the leaf file digests it
                // collects need to go through the locally-missing check
                // below.
                fetch_tree_file_digests(store, &handle, &tree_digest, &mut wanted)?;
            }
            "value" => {}
            other => bail!(
                "{} has unsupported cached artifact kind {other}",
                output.artifact_id
            ),
        }
    }

    // Mirror of the push side: the merged output tree is what downstream tasks
    // actually take as a digest input, and it hangs off the record rather than
    // off any one output, so walking `record.outputs` alone never fetches it.
    // Without this a remote hit produces a locally-written record whose
    // consumers fail with "read digest node <output_digest>: No such file".
    if !record.output_digest.is_empty() {
        fetch_tree_file_digests(store, &handle, &record.output_digest, &mut wanted)?;
    }

    // Identical content (e.g. two equal files in the same tree) can produce
    // the same digest more than once — dedupe before checking/downloading so
    // a large directory tree doesn't redundantly re-fetch a repeated blob.
    let mut seen = std::collections::HashSet::new();
    let locally_missing: Vec<Digest> = wanted
        .into_iter()
        .filter(|digest| seen.insert(digest.hash.clone()))
        .filter(|digest| !cas_blob_path(&digest.hash).is_ok_and(|path| path.is_file()))
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

/// Pushes spawned but not yet resolved (success or failure).
static PENDING_PUSHES: AtomicUsize = AtomicUsize::new(0);
/// Pushes that have actually completed successfully. Deliberately not tied
/// to any single task's completion event — see [`spawn_remote_push`].
static CONFIRMED_PUSHES: AtomicUsize = AtomicUsize::new(0);

/// Schedule a best-effort push of a freshly-written local record (and the CAS
/// blobs it references) to the remote store.
///
/// Remote writes are an accelerator for *later* invocations, never a
/// prerequisite for the command that just completed. The task record has
/// already been persisted locally before this is called, and failures remain
/// diagnostic-only.
///
/// This deliberately provides no completion result to the *task* that
/// triggered it. The scheduler reports a task as fresh as soon as its real
/// work is done; claiming `FreshPushed` before a background upload finishes
/// would make that task's completion telemetry lie. What it does provide is
/// [`confirmed_pushes`], a run-wide counter incremented only once the upload
/// genuinely finishes — see that function and [`drain_pending_pushes`] for
/// how a caller reports an accurate total without blocking on any one push.
pub fn spawn_remote_push(record: TaskCacheRecord) {
    let Some(store) = remote_store() else {
        return;
    };
    PENDING_PUSHES.fetch_add(1, Ordering::SeqCst);
    tokio::spawn(async move {
        match push_remote_inner(store, &record).await {
            Ok(()) => {
                CONFIRMED_PUSHES.fetch_add(1, Ordering::SeqCst);
            }
            Err(error) => {
                eprintln!(
                    "warning: failed to push task {} to remote cache: {error:#}",
                    record.task_key
                );
            }
        }
        PENDING_PUSHES.fetch_sub(1, Ordering::SeqCst);
    });
}

/// Count of background pushes ([`spawn_remote_push`]) that have completed
/// and been confirmed written to the remote store so far in this process.
/// Monotonic for the process lifetime — callers wanting a single run's total
/// should snapshot this before the run and diff it against the value after.
pub fn confirmed_pushes() -> usize {
    CONFIRMED_PUSHES.load(Ordering::SeqCst)
}

/// Wait (up to `timeout`) for all in-flight background pushes to finish, so
/// a [`confirmed_pushes`] reading taken afterward reflects the run's real
/// total rather than an in-progress snapshot. Best-effort: any push still
/// running after the timeout is left to finish or fail in the background,
/// same as before this existed — it just won't be counted.
pub async fn drain_pending_pushes(timeout: std::time::Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    while PENDING_PUSHES.load(Ordering::SeqCst) > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

async fn push_remote_inner(store: &dyn RemoteStore, record: &TaskCacheRecord) -> Result<()> {
    let blobs = output_blob_digests(record)?;
    // Keyed by hash (not the full `Digest`, which also carries a size) so a
    // repeated digest — e.g. two equal files in the same tree — collapses to
    // one entry instead of duplicating upload work, and so path lookup below
    // is O(1) rather than an O(n) scan per missing blob (large directory
    // trees, like toolchains, can have many entries).
    let mut by_hash: std::collections::HashMap<&str, (&Digest, &PathBuf)> =
        std::collections::HashMap::new();
    for (digest, path) in &blobs {
        by_hash.entry(&digest.hash).or_insert((digest, path));
    }
    let blob_digests: Vec<Digest> = by_hash
        .values()
        .map(|(digest, _)| (*digest).clone())
        .collect();
    let missing = store.find_missing_blobs(&blob_digests).await?;
    if !missing.is_empty() {
        let mut uploads = Vec::with_capacity(missing.len());
        for digest in &missing {
            let (_, path) = by_hash
                .get(digest.hash.as_str())
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
    use imp_remote_cache::OpendalRemoteStore;
    use imp_store::cache::CachedArtifact;
    use opendal::services::Memory;
    use opendal::Operator;

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
        // `output_digest` is a *directory node*, never a bare file digest:
        // exec.rs nests each output into a tree and merges them. The fixture
        // used to reuse the file's own digest here, which is a shape
        // production can't produce — and it hid the merged tree being left
        // out of the remote round-trip entirely.
        let merged = imp_store::digest::merge_digests(vec![imp_store::digest::nest_file(
            "out.txt",
            digest.clone(),
            content.len() as u64,
            None,
        )
        .unwrap()])
        .unwrap();
        TaskCacheRecord {
            version: 1,
            task_id: task_key.to_owned(),
            task_key: task_key.to_owned(),
            action_digest: "test-action".to_owned(),
            input_digest: "test-input".to_owned(),
            output_digest: merged.digest().to_owned(),
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

    /// Builds a nested directory (`dir/nested.txt` under a temp root),
    /// captures it into CAS via `capture_directory`, and returns a
    /// `directory`-kind `TaskCacheRecord` output referencing its tree, along
    /// with every digest reachable in that tree (root node, subdirectory
    /// node, leaf file) — the exact set the fixed `output_blob_digests`/
    /// `fetch_tree_file_digests` must fetch or push, not just the root.
    fn directory_record(task_key: &str, leaf_content: &[u8]) -> (TaskCacheRecord, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("dir");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("nested.txt"), leaf_content).unwrap();

        let directory_digest = imp_store::digest::capture_directory(dir.path()).unwrap();
        let tree_digest = directory_digest.digest().to_owned();
        let all_digests = imp_store::digest::tree_all_digests(&tree_digest).unwrap();
        // A root containing one "dir" subdirectory with one file means at
        // least the root node, the "dir" subdirectory node, and the leaf
        // file — three distinct blobs, none of which is the leaf alone.
        assert!(all_digests.len() >= 3);

        let record = TaskCacheRecord {
            version: 1,
            task_id: task_key.to_owned(),
            task_key: task_key.to_owned(),
            action_digest: "test-action".to_owned(),
            input_digest: "test-input".to_owned(),
            output_digest: tree_digest.clone(),
            named_caches: vec![],
            stdout: String::new(),
            stderr: String::new(),
            outputs: vec![CachedArtifact {
                artifact_id: "out_dir".to_owned(),
                kind: "directory".to_owned(),
                path: Some("out_dir".to_owned()),
                value: None,
                digest: String::new(),
                bytes: None,
                mode: None,
                tree_digest: Some(tree_digest),
                named_cache: None,
            }],
        };
        (record, all_digests)
    }

    /// A record shaped the way `exec.rs` actually builds one: the output's
    /// own `tree_digest` is the captured directory, while `output_digest` is
    /// that tree *nested under the output path* and merged — a genuinely
    /// different blob, plus the nesting nodes above it.
    ///
    /// `directory_record` above reuses one digest for both, which is why it
    /// cannot catch a merged root going unpushed/unhydrated. Returns the
    /// record, every blob under the output's own tree, and every blob under
    /// the merged tree.
    fn merged_record(
        task_key: &str,
        leaf_content: &[u8],
    ) -> (TaskCacheRecord, Vec<String>, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("dir");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("nested.txt"), leaf_content).unwrap();

        let captured = imp_store::digest::capture_directory(dir.path()).unwrap();
        let tree_digest = captured.digest().to_owned();

        let nested_tree = imp_store::digest::nest_directory("out_dir", &captured).unwrap();
        let merged = imp_store::digest::merge_digests(vec![nested_tree]).unwrap();
        let output_digest = merged.digest().to_owned();
        assert_ne!(
            output_digest, tree_digest,
            "fixture must model a merged root distinct from the output's own tree"
        );

        let output_blobs = imp_store::digest::tree_all_digests(&tree_digest).unwrap();
        let merged_blobs = imp_store::digest::tree_all_digests(&output_digest).unwrap();

        let record = TaskCacheRecord {
            version: 1,
            task_id: task_key.to_owned(),
            task_key: task_key.to_owned(),
            action_digest: "test-action".to_owned(),
            input_digest: "test-input".to_owned(),
            output_digest,
            named_caches: vec![],
            stdout: String::new(),
            stderr: String::new(),
            outputs: vec![CachedArtifact {
                artifact_id: "out_dir".to_owned(),
                kind: "directory".to_owned(),
                path: Some("out_dir".to_owned()),
                value: None,
                digest: String::new(),
                bytes: None,
                mode: None,
                tree_digest: Some(tree_digest),
                named_cache: None,
            }],
        };
        (record, output_blobs, merged_blobs)
    }

    /// A remote hit must hydrate the merged output tree, not just the blobs
    /// reachable from `record.outputs`. Downstream tasks take the merged
    /// digest as a `{ kind: "digest" }` input, so missing it produced
    /// "read digest node <output_digest>: No such file or directory" in the
    /// *dependent* task — far from the record that caused it.
    #[test]
    fn try_remote_hit_inner_hydrates_the_merged_output_tree() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("merged-hydrate-{}", unique_nanos());
        let leaf_content = unique_bytes("merged-hydrate");
        let (record, output_blobs, merged_blobs) = merged_record(&task_key, &leaf_content);

        let mut all: Vec<String> = output_blobs;
        all.extend(merged_blobs.iter().cloned());
        all.sort();
        all.dedup();

        for hash in &all {
            let path = cas_blob_path(hash).unwrap();
            let bytes = std::fs::read(&path).unwrap();
            rt.block_on(
                store.batch_update_blobs(vec![(
                    Digest::new(hash.clone(), bytes.len() as u64),
                    bytes,
                )]),
            )
            .unwrap();
            std::fs::remove_file(&path).unwrap();
        }

        let encoded = serde_json::to_vec(&record).unwrap();
        rt.block_on(store.update_action_result(
            &Digest::new(task_key.clone(), encoded.len() as u64),
            encoded,
        ))
        .unwrap();

        let hit = try_remote_hit_inner(&store, &task_key).unwrap().unwrap();

        for hash in &merged_blobs {
            assert!(
                cas_blob_path(hash).unwrap().is_file(),
                "merged-tree blob {hash} was not hydrated from the remote store"
            );
        }
        // The dependent task's actual operation: load the merged root as an input.
        imp_store::digest::DigestTrie::load(&hit.output_digest)
            .expect("merged output tree must be loadable after a remote hit");
    }

    /// The pull side can only fetch what the push side stored.
    #[test]
    fn push_remote_inner_uploads_the_merged_output_tree() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("merged-push-{}", unique_nanos());
        let leaf_content = unique_bytes("merged-push");
        let (record, _output_blobs, merged_blobs) = merged_record(&task_key, &leaf_content);

        rt.block_on(push_remote_inner(&store, &record)).unwrap();

        let wanted: Vec<Digest> = merged_blobs
            .iter()
            .map(|hash| Digest::new(hash.clone(), 0))
            .collect();
        let missing = rt.block_on(store.find_missing_blobs(&wanted)).unwrap();
        assert!(
            missing.is_empty(),
            "merged-tree blobs were never pushed: {missing:?}"
        );
    }

    /// A record whose merged tree is absent locally must read as unusable, so
    /// the caller falls back to real execution instead of handing a dependent
    /// task a digest it cannot load.
    #[test]
    fn cached_outputs_present_rejects_a_missing_merged_output_tree() {
        let task_key = format!("merged-guard-{}", unique_nanos());
        let leaf_content = unique_bytes("merged-guard");
        let (record, _output_blobs, merged_blobs) = merged_record(&task_key, &leaf_content);

        cached_outputs_present(&record).expect("fully-populated record should pass");

        // Remove only the merged root; every blob reachable from
        // `record.outputs` stays put, which is precisely the state a remote
        // hit used to leave behind.
        std::fs::remove_file(cas_blob_path(&record.output_digest).unwrap()).unwrap();
        let error = cached_outputs_present(&record).unwrap_err();
        assert!(
            format!("{error:#}").contains("merged output tree"),
            "unexpected error: {error:#}"
        );

        let _ = merged_blobs;
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
        store_blob(&content, "file").unwrap();
        let record = file_record(&task_key, &content);

        let error = rt.block_on(push_remote_inner(&store, &record)).unwrap_err();
        // Which blob is reported is incidental — a record pushes several
        // (the output's own plus the merged tree's nodes) and they're
        // collected through a HashMap, so iteration order isn't defined.
        // What matters is that a failed upload aborts before publishing.
        assert!(
            format!("{error:#}").contains("upload blob"),
            "unexpected error: {error:#}"
        );
        assert!(store.action_updates.lock().unwrap().is_empty());
    }

    #[test]
    fn try_remote_hit_inner_hydrates_every_blob_in_a_nested_directory_tree() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("directory-hydrate-{}", unique_nanos());
        let leaf_content = unique_bytes("directory-hydrate");
        let (record, all_digests) = directory_record(&task_key, &leaf_content);

        // Push every blob the tree references to the remote store, then
        // delete them all locally — simulating a cold pull on a fresh
        // runner, where nothing but the action result is fetched yet.
        for hash in &all_digests {
            let path = cas_blob_path(hash).unwrap();
            let bytes = std::fs::read(&path).unwrap();
            rt.block_on(
                store.batch_update_blobs(vec![(
                    Digest::new(hash.clone(), bytes.len() as u64),
                    bytes,
                )]),
            )
            .unwrap();
            std::fs::remove_file(&path).unwrap();
        }
        for hash in &all_digests {
            assert!(!cas_blob_path(hash).unwrap().is_file());
        }

        let encoded = serde_json::to_vec(&record).unwrap();
        rt.block_on(store.update_action_result(
            &Digest::new(task_key.clone(), encoded.len() as u64),
            encoded,
        ))
        .unwrap();

        let hit = try_remote_hit_inner(&store, &task_key).unwrap().unwrap();

        // Every blob in the tree — not just the root — must now be present
        // locally; this is exactly the gap that let a remote hit reach
        // materialization with a leaf file blob missing.
        for hash in &all_digests {
            assert!(
                cas_blob_path(hash).unwrap().is_file(),
                "blob {hash} was not hydrated from the remote store"
            );
        }

        let workspace_root = tempfile::tempdir().unwrap();
        imp_store::cache::materialize_cached_artifacts(&hit.outputs, workspace_root.path())
            .unwrap();
        assert_eq!(
            std::fs::read(workspace_root.path().join("out_dir/dir/nested.txt")).unwrap(),
            leaf_content
        );
    }

    #[test]
    fn push_remote_inner_uploads_every_blob_in_a_nested_directory_tree() {
        let store = memory_store();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();

        let task_key = format!("directory-push-{}", unique_nanos());
        let leaf_content = unique_bytes("directory-push");
        let (record, all_digests) = directory_record(&task_key, &leaf_content);

        rt.block_on(push_remote_inner(&store, &record)).unwrap();

        // Every blob in the tree must have reached the remote store, not
        // just the root tree node.
        let wanted: Vec<Digest> = all_digests
            .iter()
            .map(|hash| Digest::new(hash.clone(), 0))
            .collect();
        let missing = rt.block_on(store.find_missing_blobs(&wanted)).unwrap();
        assert!(
            missing.is_empty(),
            "remote store is missing blobs after push: {missing:?}"
        );
    }
}
