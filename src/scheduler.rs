//! Central task scheduler and the unified task-event stream.
//!
//! Every unit of tracked work — a memoized build function *and* the sandboxed
//! `run()` jobs it dispatches — is a node on one [`TaskEvent`] stream, so the UI
//! has a single source of truth for what is running, where, and under which
//! parent. Memo nodes are emitted from JavaScript (via a host hook); job nodes
//! are emitted here. Ids are disjoint (jobs set the high bit) so both share one
//! node space and a job can name its owning memo as its parent.
//!
//! JavaScript is single-runtime and yields at each `await`; the actual work
//! happens on blocking worker threads. The scheduler bounds how many run
//! concurrently (`jobs`) and tracks the number of outstanding jobs so a
//! deadlock watchdog can distinguish "between jobs" from "stuck".

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Result};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::{Notify, Semaphore};

/// High bit marks a scheduler job id, keeping it disjoint from JS memo node ids.
const JOB_ID_BIT: u64 = 1 << 63;

/// Outcome of a finished node, carried on the event stream. The typed result of
/// a job is returned to its submitter directly, so only success/failure travels
/// here.
#[derive(Debug, Clone)]
pub enum TaskOutcome {
    Ok,
    Err(String),
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneKind {
    Js,
    Sandbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Memo,
    Sandbox,
    Workspace,
}

/// One transition in the task tree. A node goes `Pending` → `Running` → `Done`;
/// the renderer creates it under `parent` on `Pending` and removes it on `Done`.
#[derive(Debug, Clone)]
pub enum TaskEvent {
    Pending {
        id: u64,
        parent: Option<u64>,
        display: String,
        kind: TaskKind,
    },
    Running {
        id: u64,
        /// e.g. the worker slot for a job; `None` for a memo.
        detail: Option<String>,
    },
    Done {
        id: u64,
        outcome: TaskOutcome,
    },
    LaneStarted {
        kind: LaneKind,
        slot: usize,
        id: u64,
        display: String,
    },
    LaneCleared {
        kind: LaneKind,
        slot: usize,
        id: u64,
    },
}

/// Bounded, observable `spawn_blocking` executor. Cloneable via `Arc`.
pub struct Scheduler {
    /// Bounds concurrent jobs to `jobs`.
    permits: Arc<Semaphore>,
    /// Stable slot ids in `[0, jobs)` handed to running jobs so the UI can show
    /// a fixed set of lanes. A permit is always held before a slot is taken.
    slots: Arc<Mutex<Vec<usize>>>,
    events: UnboundedSender<TaskEvent>,
    next_job: AtomicU64,
    /// Jobs submitted but not yet finished (queued or running). The watchdog
    /// watches this: sustained zero while the evaluation is unfinished ⇒ stuck.
    outstanding: AtomicUsize,
    /// Pulsed whenever `outstanding` changes, so the watchdog can wait cheaply.
    activity: Notify,
    cancellation: Arc<AtomicBool>,
}

/// Handle given to a scheduled job so it can announce that it actually
/// started doing work. Reserving a scheduler slot is not sufficient: a job
/// may be satisfied entirely by the execution cache.
pub struct RunContext {
    events: UnboundedSender<TaskEvent>,
    id: u64,
    display: String,
    permits: Arc<Semaphore>,
    slots: Arc<Mutex<Vec<usize>>>,
    state: Arc<RunState>,
}

struct RunState {
    slot: Mutex<Option<usize>>,
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}

impl RunContext {
    pub fn started(&self) {
        let mut slot = self.state.slot.lock().unwrap();
        if slot.is_some() {
            return;
        }
        let permit = loop {
            match self.permits.clone().try_acquire_owned() {
                Ok(permit) => break permit,
                Err(tokio::sync::TryAcquireError::NoPermits) => {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(tokio::sync::TryAcquireError::Closed) => {
                    panic!("scheduler semaphore closed")
                }
            }
        };
        let assigned = self.slots.lock().unwrap().pop().unwrap_or(0);
        *slot = Some(assigned);
        *self.state.permit.lock().unwrap() = Some(permit);
        let _ = self.events.send(TaskEvent::LaneStarted {
            kind: LaneKind::Sandbox,
            slot: assigned,
            id: self.id,
            display: self.display.clone(),
        });
        let _ = self.events.send(TaskEvent::Running {
            id: self.id,
            detail: Some(format!("slot {assigned}")),
        });
    }
}

impl Scheduler {
    /// Create a scheduler bounded to `jobs` concurrent tasks that emits node
    /// events onto `events`.
    pub fn new(
        jobs: usize,
        cancellation: Arc<AtomicBool>,
        events: UnboundedSender<TaskEvent>,
    ) -> Arc<Self> {
        let jobs = jobs.max(1);
        Arc::new(Self {
            permits: Arc::new(Semaphore::new(jobs)),
            slots: Arc::new(Mutex::new((0..jobs).collect())),
            events,
            next_job: AtomicU64::new(0),
            outstanding: AtomicUsize::new(0),
            activity: Notify::new(),
            cancellation,
        })
    }

    /// Emit a node event directly (used by the JS memo hook to report memo
    /// nodes, which are not scheduler jobs).
    pub fn emit(&self, event: TaskEvent) {
        let _ = self.events.send(event);
    }

    /// Number of jobs submitted but not yet finished.
    pub fn outstanding(&self) -> usize {
        self.outstanding.load(Ordering::SeqCst)
    }

    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancellation)
    }

    /// Wait until `outstanding` next changes. Used by the deadlock watchdog.
    pub async fn wait_for_activity(&self) {
        self.activity.notified().await;
    }

    fn bump_outstanding(&self, delta: isize) {
        if delta >= 0 {
            self.outstanding.fetch_add(delta as usize, Ordering::SeqCst);
        } else {
            self.outstanding
                .fetch_sub((-delta) as usize, Ordering::SeqCst);
        }
        self.activity.notify_waiters();
    }

    /// Submit a blocking unit of work owned by memo node `parent`. Emits
    /// `Pending` immediately, then runs `f` on a blocking worker. The job calls
    /// [`RunContext::started`] when it has crossed its actual work boundary;
    /// cache-only jobs never need to call it.
    pub async fn run<T, F>(
        &self,
        parent: Option<u64>,
        display: impl Into<String>,
        kind: TaskKind,
        f: F,
    ) -> Result<T>
    where
        F: FnOnce(RunContext) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let display = display.into();
        let id = JOB_ID_BIT | self.next_job.fetch_add(1, Ordering::Relaxed);
        self.bump_outstanding(1);
        let _ = self.events.send(TaskEvent::Pending {
            id,
            parent,
            display: display.clone(),
            kind,
        });

        if self.cancellation.load(Ordering::SeqCst) {
            let _ = self.events.send(TaskEvent::Done {
                id,
                outcome: TaskOutcome::Canceled,
            });
            self.bump_outstanding(-1);
            bail!("canceled before execution");
        }

        let state = Arc::new(RunState {
            slot: Mutex::new(None),
            permit: Mutex::new(None),
        });
        let context = RunContext {
            events: self.events.clone(),
            id,
            display: display.clone(),
            permits: Arc::clone(&self.permits),
            slots: Arc::clone(&self.slots),
            state: Arc::clone(&state),
        };
        let result = tokio::task::spawn_blocking(move || f(context)).await;
        if let Some(slot) = state.slot.lock().unwrap().take() {
            let _ = self.events.send(TaskEvent::LaneCleared {
                kind: LaneKind::Sandbox,
                slot,
                id,
            });
            self.slots.lock().unwrap().push(slot);
            drop(state.permit.lock().unwrap().take());
        }

        let outcome = match &result {
            Ok(Ok(_)) => TaskOutcome::Ok,
            Ok(Err(error)) => TaskOutcome::Err(format!("{error:#}")),
            Err(join) => TaskOutcome::Err(format!("worker panicked: {join}")),
        };
        let _ = self.events.send(TaskEvent::Done { id, outcome });
        self.bump_outstanding(-1);

        match result {
            Ok(inner) => inner,
            Err(join) => bail!("scheduler worker panicked: {join}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Scheduler, TaskEvent, TaskKind};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    #[tokio::test]
    async fn cache_only_sandbox_job_is_classified_without_starting_a_lane() {
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(1, Arc::new(AtomicBool::new(false)), tx);

        scheduler
            .run(None, "cached command", TaskKind::Sandbox, |_context| Ok(()))
            .await
            .unwrap();

        let collected: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        assert!(matches!(
            collected.first(),
            Some(TaskEvent::Pending {
                kind: TaskKind::Sandbox,
                ..
            })
        ));
        assert!(collected
            .iter()
            .all(|event| !matches!(event, TaskEvent::LaneStarted { .. })));
        assert!(collected
            .iter()
            .any(|event| matches!(event, TaskEvent::Done { .. })));
    }
}
