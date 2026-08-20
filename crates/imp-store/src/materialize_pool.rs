//! A small, process-wide, persistent worker pool dedicated to the blocking
//! file-copy syscalls `digest::materialize_trie` issues.
//!
//! Kept separate from both `--jobs`'s own action concurrency and from any
//! async runtime: Windows has no async variant of `CreateFile`/`CopyFile`
//! (only bulk read/write on an already-open handle can use IOCP, and
//! measurement showed `tokio::fs::copy` costs the same as a plain blocking
//! copy since it's `spawn_blocking` under the hood either way), so there's
//! nothing async buys here — this is deliberately N OS threads blocking on
//! the same syscalls. One pool, sized once for the whole process, so many
//! actions materializing concurrently under `--jobs` share a single bounded
//! degree of filesystem concurrency instead of each spinning up its own
//! pool and oversubscribing — measured on Windows: parallel hardlinks into
//! *one* directory got slower past ~16 concurrent writers, so uncapped
//! per-call parallelism is a real regression risk, not just waste.
//!
//! Every file materialized — however small the batch — is dispatched
//! through this pool rather than handled inline: measured dispatch
//! overhead (channel send + condvar wake) is in the tens of microseconds,
//! against a per-file copy syscall cost in the hundreds of microseconds on
//! Windows, so there's no batch size small enough for an inline fallback to
//! win and one worth the extra code path.

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use anyhow::Result;

struct Job {
    digest: String,
    dest: PathBuf,
    mode: Option<u32>,
    batch: Arc<Batch>,
}

struct Batch {
    state: Mutex<BatchState>,
    cv: Condvar,
}

struct BatchState {
    remaining: usize,
    error: Option<anyhow::Error>,
}

static WORKER_COUNT: OnceLock<usize> = OnceLock::new();

/// Return the automatic materialization-worker count for this machine.
pub fn default_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(4)
        .min(16)
}

/// Set the number of materialization workers before the first batch runs.
///
/// The process-wide pool cannot change size after it starts. Callers must set
/// this during process setup, before they can materialize an artifact.
pub fn configure_worker_count(worker_count: usize) -> Result<()> {
    let worker_count = worker_count.max(1);
    match WORKER_COUNT.set(worker_count) {
        Ok(()) => Ok(()),
        Err(existing) if existing == worker_count => Ok(()),
        Err(existing) => anyhow::bail!(
            "materialization worker pool already uses {existing} workers; cannot change it to {worker_count}"
        ),
    }
}

fn worker_count() -> usize {
    *WORKER_COUNT.get_or_init(default_worker_count)
}

fn sender() -> &'static crossbeam_channel::Sender<Job> {
    static SENDER: OnceLock<crossbeam_channel::Sender<Job>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        // Empirically ~16 concurrent writers was the sweet spot on a
        // 24-core Windows machine (both fewer and many more regressed);
        // available_parallelism() with a cap tracks that without hardcoding
        // a number unrelated to the actual machine.
        let threads = worker_count();
        for i in 0..threads {
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("imp-materialize-{i}"))
                .spawn(move || worker_loop(rx))
                .expect("spawn materialize worker thread");
        }
        tx
    })
}

fn worker_loop(rx: crossbeam_channel::Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        let result = crate::digest::materialize_one_file(&job.digest, &job.dest, job.mode);
        let mut state = job.batch.state.lock().unwrap();
        if let Err(error) = result {
            if state.error.is_none() {
                state.error = Some(error);
            }
        }
        state.remaining -= 1;
        if state.remaining == 0 {
            job.batch.cv.notify_all();
        }
    }
}

/// Materializes every `(digest, dest, mode)` job in parallel on the shared
/// pool, blocking the caller (parked, not spun — the caller is itself one
/// of the scheduler's bounded blocking workers, so burning a core here
/// would just starve some other action) until all complete. `dest`'s parent
/// directory must already exist for every job — this dispatches raw file
/// copies, it doesn't create directories. Returns the first error
/// encountered, if any; every job still runs to completion regardless.
pub(crate) fn materialize_batch(jobs: Vec<(String, PathBuf, Option<u32>)>) -> Result<()> {
    if jobs.is_empty() {
        return Ok(());
    }
    let batch = Arc::new(Batch {
        state: Mutex::new(BatchState {
            remaining: jobs.len(),
            error: None,
        }),
        cv: Condvar::new(),
    });
    let tx = sender();
    for (digest, dest, mode) in jobs {
        tx.send(Job {
            digest,
            dest,
            mode,
            batch: batch.clone(),
        })
        .expect("materialize worker pool receiver dropped");
    }
    let mut state = batch.state.lock().unwrap();
    while state.remaining > 0 {
        state = batch.cv.wait(state).unwrap();
    }
    match state.error.take() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A failing job (here: a digest with no backing CAS blob) must surface
    // as an error from materialize_batch, without stalling the batch or
    // silently swallowing the sibling jobs that succeeded alongside it —
    // the counter/error bookkeeping in worker_loop has to stay correct
    // under a mixed success/failure batch, not just the all-success path
    // digest.rs's own tests already cover.
    #[test]
    fn materialize_batch_reports_an_error_without_dropping_other_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let digest = crate::cache::store_blob(b"real content", "test-blob").unwrap();

        let good_dest = dir.path().join("good.txt");
        let bad_dest = dir.path().join("bad.txt");

        let result = materialize_batch(vec![
            (digest, good_dest.clone(), None),
            ("0".repeat(64), bad_dest.clone(), None),
        ]);

        assert!(
            result.is_err(),
            "a missing CAS blob must surface as an error"
        );
        assert_eq!(std::fs::read_to_string(&good_dest).unwrap(), "real content");
        assert!(!bad_dest.exists());
    }
}
