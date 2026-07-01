//! Central task scheduler: a bounded, observable executor that every live
//! `run()` / workspace-mutation flows through.
//!
//! JavaScript is single-runtime and yields at each `await`; the actual work
//! (sandboxed process execution) happens on blocking worker threads. This
//! scheduler bounds how many run concurrently (`jobs`) and emits a single
//! event stream so the UI has one source of truth for what is running where.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Result};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Semaphore;

/// Monotonic identifier for a submitted job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct JobId(pub u64);

/// Outcome of a finished job, carried on the event stream. The typed result is
/// returned to the submitter directly, so only success/failure travels here.
#[derive(Debug, Clone)]
pub enum JobOutcome {
    Ok,
    Err(String),
    Canceled,
}

/// Everything the UI needs to render "what is running where and why". A single
/// consumer drains these and maps them onto the progress tree.
#[derive(Debug, Clone)]
pub enum SchedulerEvent {
    Queued { job: JobId, display: String },
    Started { job: JobId, slot: usize, display: String },
    Finished { job: JobId, outcome: JobOutcome },
}

/// Bounded, observable `spawn_blocking` executor. Cloneable via `Arc`; the
/// event stream closes when the last `Arc<Scheduler>` is dropped.
pub struct Scheduler {
    /// Bounds concurrent jobs to `jobs`.
    permits: Semaphore,
    /// Stable slot ids in `[0, jobs)` handed to running jobs so the UI can show
    /// a fixed set of lanes. A permit is always held before a slot is taken, so
    /// a slot is guaranteed available.
    slots: Mutex<Vec<usize>>,
    events: UnboundedSender<SchedulerEvent>,
    next_job: AtomicU64,
    cancellation: Arc<AtomicBool>,
}

impl Scheduler {
    /// Create a scheduler bounded to `jobs` concurrent tasks. Returns the
    /// scheduler plus the receiver end of its event stream; drive the receiver
    /// on a separate task to render progress.
    pub fn new(
        jobs: usize,
        cancellation: Arc<AtomicBool>,
    ) -> (Arc<Self>, UnboundedReceiver<SchedulerEvent>) {
        let jobs = jobs.max(1);
        let (events, rx) = unbounded_channel();
        let scheduler = Arc::new(Self {
            permits: Semaphore::new(jobs),
            slots: Mutex::new((0..jobs).collect()),
            events,
            next_job: AtomicU64::new(0),
            cancellation,
        });
        (scheduler, rx)
    }

    /// Submit a blocking unit of work. Emits `Queued` immediately, waits for a
    /// free slot, then emits `Started`/`Finished` around running `f` on a
    /// blocking worker. Returns whatever `f` returns.
    pub async fn run<T, F>(&self, display: impl Into<String>, f: F) -> Result<T>
    where
        F: FnOnce() -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let display = display.into();
        let job = JobId(self.next_job.fetch_add(1, Ordering::Relaxed));
        let _ = self.events.send(SchedulerEvent::Queued {
            job,
            display: display.clone(),
        });

        let permit = self
            .permits
            .acquire()
            .await
            .expect("scheduler semaphore closed");

        if self.cancellation.load(Ordering::SeqCst) {
            let _ = self.events.send(SchedulerEvent::Finished {
                job,
                outcome: JobOutcome::Canceled,
            });
            bail!("canceled before execution");
        }

        let slot = self.slots.lock().unwrap().pop().unwrap_or(0);
        let _ = self.events.send(SchedulerEvent::Started {
            job,
            slot,
            display,
        });

        let result = tokio::task::spawn_blocking(f).await;
        self.slots.lock().unwrap().push(slot);
        drop(permit);

        let outcome = match &result {
            Ok(Ok(_)) => JobOutcome::Ok,
            Ok(Err(error)) => JobOutcome::Err(format!("{error:#}")),
            Err(join) => JobOutcome::Err(format!("worker panicked: {join}")),
        };
        let _ = self.events.send(SchedulerEvent::Finished { job, outcome });

        match result {
            Ok(inner) => inner,
            Err(join) => bail!("scheduler worker panicked: {join}"),
        }
    }
}
