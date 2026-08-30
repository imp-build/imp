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

/// A type-erased unit of dispatch-pool work: run it, and it reports its own
/// outcome (a submitter's closure captures its own oneshot sender).
type PoolJob = Box<dyn FnOnce() + Send>;

struct DispatchPoolInner {
    receiver: crossbeam_channel::Receiver<PoolJob>,
    /// Upper bound on how many worker threads this pool will ever create.
    size: usize,
    /// How many worker threads have been created so far (monotonic).
    spawned: AtomicUsize,
    /// How many currently-live worker threads are parked in `recv()` right
    /// now. Read as a cheap heuristic for "does a burst need a new thread,"
    /// not as an exact count — see `grow_if_needed`.
    idle: AtomicUsize,
}

/// Small, scheduler-owned pool of OS threads that jobs are dispatched onto,
/// instead of `tokio::task::spawn_blocking` — mirrors `imp-store`'s
/// `materialize_pool` (threads parked on a channel `recv()`, not tokio's
/// uncapped, unconditionally-created blocking pool). Bounds live thread
/// count to `size` regardless of how many jobs are submitted at once, and
/// keeps jobs that never touch the `--jobs` semaphore (pure cache hits)
/// running at full pool-sized parallelism, unthrottled.
///
/// Threads are grown lazily, one at a time, only when a submission finds no
/// worker currently idle — not spawned eagerly up front. One `Scheduler` (one
/// pool) lives for a whole build in production, so eager-vs-lazy doesn't
/// matter there; it matters a great deal in this crate's own test suite,
/// which constructs a fresh `Scheduler` per test — eager spawning turned
/// every one of those into an immediate `size`-thread cost regardless of how
/// many jobs (often just one or two) the test actually submits, multiplying
/// out to hundreds of superfluous live threads under `cargo test`'s
/// parallelism and starving unrelated timing-sensitive tests of OS scheduling
/// time.
struct DispatchPool {
    sender: crossbeam_channel::Sender<PoolJob>,
    inner: Arc<DispatchPoolInner>,
}

impl DispatchPool {
    fn new(size: usize) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded::<PoolJob>();
        let inner = Arc::new(DispatchPoolInner {
            receiver: rx,
            size: size.max(1),
            spawned: AtomicUsize::new(0),
            idle: AtomicUsize::new(0),
        });
        Self { sender: tx, inner }
    }

    /// Spawn one more worker thread if no worker looks idle right now and
    /// there's still headroom under `size`. A submission racing another
    /// submission's idle-check can under- or over-grow by one thread; that's
    /// fine — this only tunes how many threads exist, never correctness (a
    /// job left in the channel is picked up by any worker, existing or new).
    fn grow_if_needed(&self) {
        if self.inner.idle.load(Ordering::SeqCst) > 0 {
            return;
        }
        let spawned_before = self.inner.spawned.fetch_add(1, Ordering::SeqCst);
        if spawned_before >= self.inner.size {
            self.inner.spawned.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let inner = Arc::clone(&self.inner);
        std::thread::Builder::new()
            .name(format!("imp-scheduler-{spawned_before}"))
            .spawn(move || loop {
                inner.idle.fetch_add(1, Ordering::SeqCst);
                let job = inner.receiver.recv();
                inner.idle.fetch_sub(1, Ordering::SeqCst);
                match job {
                    Ok(job) => job(),
                    Err(_) => break,
                }
            })
            .expect("spawn scheduler dispatch worker thread");
    }

    fn submit(&self, job: PoolJob) {
        self.grow_if_needed();
        self.sender
            .send(job)
            .expect("scheduler dispatch pool receiver dropped");
    }
}

/// Automatic dispatch-pool size for this machine, independent of `--jobs`:
/// enough physical threads that cache-hit/prep work isn't starved for
/// concurrency, without letting a wide graph create hundreds of them. Mirrors
/// `imp-store::materialize_pool::default_worker_count`'s validated `16`
/// ceiling; duplicated here rather than shared, to avoid an
/// `imp-scheduler` -> `imp-store` dependency for four lines.
fn default_pool_size() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(4)
        .min(16)
}

/// Extract a human-readable message from a caught panic payload, mirroring
/// how `std::fmt::Display` for `tokio::task::JoinError` renders one.
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        message.to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "Box<dyn Any>".to_string()
    }
}

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

/// Where a job's result came from, when it was satisfied by a cache
/// (`cached == Some(true)`). Reported via [`RunContext::report_cache_source`];
/// left unset (`None` on the event) for fresh runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheSource {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// One transition in the task tree. A node goes `Pending` → `Running` → `Done`;
/// the renderer creates it under `parent` on `Pending` and removes it on `Done`.
#[derive(Debug, Clone)]
pub enum TaskEvent {
    Pending {
        id: u64,
        // Not read by the current (flat) live renderer; plumbed through from
        // JS's memo/effect ownership system for a future tree-shaped
        // renderer. See main.rs's TaskEvent::Pending match arm.
        #[allow(dead_code)]
        parent: Option<u64>,
        display: String,
        kind: TaskKind,
        log_level: TaskLogLevel,
    },
    Running {
        id: u64,
        /// e.g. the worker slot for a job; `None` for a memo.
        detail: Option<String>,
    },
    Done {
        id: u64,
        outcome: TaskOutcome,
        /// `Some(true)`/`Some(false)` for jobs submitted via [`Scheduler::run`],
        /// based on whether [`RunContext::started`] was ever called (a cache
        /// hit never calls it). `None` for nodes emitted via [`Scheduler::emit`]
        /// (JS memo nodes) — an in-process memo hit never reaches `Done`, so a
        /// memo's `Done` is always a fresh evaluation and "cached" doesn't apply.
        cached: Option<bool>,
        /// Set alongside `cached: Some(true)` via
        /// [`RunContext::report_cache_source`] to say whether the hit was
        /// served from the local disk cache or a remote cache. `None` for
        /// fresh runs and for nodes emitted via `Scheduler::emit`.
        cache_source: Option<CacheSource>,
    },
    LaneStarted {
        kind: LaneKind,
        slot: usize,
        id: u64,
        display: String,
    },
    LaneUpdated {
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
    /// Total permit budget — the `--jobs` value, after the `max(1)` floor.
    /// Kept so a job's declared `cores` can be clamped to something the
    /// semaphore can actually grant.
    jobs: usize,
    /// Bounds concurrent jobs to `jobs` permits in total. A job takes as many
    /// permits as it declared cores, so one wide job can hold the whole budget.
    permits: Arc<Semaphore>,
    /// Stable slot ids in `[0, jobs)` handed to running jobs so the UI can show
    /// a fixed set of lanes. A job takes one slot per permit it holds. The
    /// permits are always held before the slots are taken; the reverse does not
    /// hold, since a job reserves its permits before staging and may finish
    /// without ever starting a command.
    slots: Arc<Mutex<Vec<usize>>>,
    events: UnboundedSender<TaskEvent>,
    next_job: AtomicU64,
    /// Jobs submitted but not yet finished (queued or running). The watchdog
    /// watches this: sustained zero while the evaluation is unfinished ⇒ stuck.
    outstanding: AtomicUsize,
    /// Pulsed whenever `outstanding` changes, so the watchdog can wait cheaply.
    activity: Notify,
    cancellation: Arc<AtomicBool>,
    /// Fixed-size pool jobs are dispatched onto, instead of
    /// `tokio::task::spawn_blocking` — see [`DispatchPool`].
    pool: DispatchPool,
    /// Lets a job parked on the dispatch pool block on the async `--jobs`
    /// semaphore (`RunContext::acquire_permit`) instead of busy-spinning.
    handle: tokio::runtime::Handle,
}

/// Handle given to a scheduled job so it can announce where it is in its
/// lifecycle. The two events are separate on purpose: [`RunContext::reserve`]
/// takes the concurrency slot that bounds `--jobs` and, with it, a progress
/// lane — staging a sandbox is real, visible work, and the swimlane should
/// show it rather than sit idle until the command itself spawns. But holding
/// a lane is not evidence of [`RunContext::started`]: a job may be satisfied
/// entirely by the execution cache (e.g. a remote hit that resolves mid-stage)
/// after reserving, and cache classification keys off `started` alone.
pub struct RunContext {
    events: UnboundedSender<TaskEvent>,
    id: u64,
    display: String,
    permits: Arc<Semaphore>,
    slots: Arc<Mutex<Vec<usize>>>,
    state: Arc<RunState>,
    cancellation: Arc<AtomicBool>,
    handle: tokio::runtime::Handle,
}

struct RunState {
    /// How many permits (and therefore lanes) this job costs. Already clamped
    /// to the scheduler's total budget, so it can always be granted.
    cores: usize,
    /// The lanes this job holds, `cores` of them once assigned. The first is
    /// the job's primary lane, the one `started`/`phase` report against.
    slots: Mutex<Vec<usize>>,
    /// One owned permit covering all `cores` permits — dropping it returns
    /// every one of them.
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
    started: AtomicBool,
    cache_source: Mutex<Option<CacheSource>>,
}

impl RunContext {
    pub fn display(&self) -> &str {
        &self.display
    }

    /// Take the `cores` concurrency permits that bound `--jobs`, if this job
    /// does not hold them already. Runs on a dispatch-pool thread (never a
    /// tokio async worker thread), so it's safe to genuinely block here via
    /// `Handle::block_on` rather than spin.
    ///
    /// The permits are taken as one `acquire_many_owned`, so a wide job either
    /// gets its whole allocation or waits — it can never sit half-admitted
    /// holding permits nobody else can use. `cores` is clamped to the total
    /// budget when the job is submitted, so this request is always grantable.
    ///
    /// `strict` decides what happens when the run is being canceled. A job that
    /// is only reserving gives up and returns `false`, so a cancellation does not
    /// have to wait out every queued job's turn; a job reporting `started` waits
    /// regardless, since a progress lane without a permit would break the
    /// `slots_taken == permits_held <= jobs` invariant.
    fn acquire_permit(&self, strict: bool) -> bool {
        let mut held = self.state.permit.lock().unwrap();
        if held.is_some() {
            return true;
        }
        let permits = Arc::clone(&self.permits);
        let cores = self.state.cores as u32;
        if strict {
            let permit = self
                .handle
                .block_on(permits.acquire_many_owned(cores))
                .expect("scheduler semaphore closed");
            *held = Some(permit);
            return true;
        }
        // No cancellation `Notify` exists today (just a plain `AtomicBool`), so
        // re-check it on a coarse timer instead of adding a cross-cutting
        // signal for this alone. Acquiring a freed permit is still immediate —
        // only cancellation detection is delayed, by at most one tick.
        let cancellation = Arc::clone(&self.cancellation);
        let acquired = self.handle.block_on(async move {
            let mut acquire = std::pin::pin!(permits.acquire_many_owned(cores));
            loop {
                tokio::select! {
                    res = &mut acquire => {
                        break Some(res.expect("scheduler semaphore closed"));
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                        if cancellation.load(Ordering::SeqCst) {
                            break None;
                        }
                    }
                }
            }
        });
        match acquired {
            Some(permit) => {
                *held = Some(permit);
                true
            }
            None => false,
        }
    }

    /// Assign this job one stable lane slot per permit it holds and announce
    /// each, unless it already holds its lanes. The first lane carries the
    /// job's real display; the rest carry a continuation marker, so a wide job
    /// visibly occupies the lanes it is actually consuming instead of leaving
    /// them looking idle. Idempotent, so both `reserve` and `started` can call
    /// it unconditionally. Never call this while holding the permit lock — the
    /// permits are always taken first, and the two locks must not nest.
    fn assign_slot(&self) {
        let mut slots = self.state.slots.lock().unwrap();
        if !slots.is_empty() {
            return;
        }
        {
            let mut pool = self.slots.lock().unwrap();
            for _ in 0..self.state.cores {
                slots.push(pool.pop().unwrap_or(0));
            }
        }
        for (index, &assigned) in slots.iter().enumerate() {
            let display = if index == 0 {
                self.display.clone()
            } else {
                format!("↳ {}", self.display)
            };
            let _ = self.events.send(TaskEvent::LaneStarted {
                kind: LaneKind::Sandbox,
                slot: assigned,
                id: self.id,
                display,
            });
        }
    }

    /// The lane `started`/`phase` report against — the first of the job's
    /// lanes, or `0` before any is assigned.
    fn primary_slot(&self) -> usize {
        self.state
            .slots
            .lock()
            .unwrap()
            .first()
            .copied()
            .unwrap_or(0)
    }

    /// Reserve this job's concurrency slot before it does expensive work such
    /// as staging a sandbox, and take its progress lane alongside it — staging
    /// is real work the swimlane should show, not leave looking idle until the
    /// command itself spawns. Idempotent. Deliberately does not mark the job
    /// started, so cache classification (a remote hit can still resolve mid-
    /// stage) is unaffected; the lane is cleared either way once the job ends.
    pub fn reserve(&self) {
        if self.acquire_permit(false) {
            self.assign_slot();
        }
    }

    pub fn started(&self) {
        self.state.started.store(true, Ordering::SeqCst);
        // Never hold the slot lock across the permit spin: a permit is always
        // taken first, and the two locks must not nest.
        self.acquire_permit(true);
        // Normally already assigned by `reserve`; this is a fallback for a
        // caller that jumps straight to `started`.
        self.assign_slot();
        let slot = self.primary_slot();
        let _ = self.events.send(TaskEvent::Running {
            id: self.id,
            detail: Some(format!("slot {slot}")),
        });
    }

    /// Update this job's lane without changing its cache classification. A
    /// remote executor can call this before `started`, in which case the lane
    /// takes a normal client `--jobs` permit first.
    pub fn phase(&self, display: impl Into<String>) {
        self.acquire_permit(true);
        self.assign_slot();
        let slot = self.primary_slot();
        let _ = self.events.send(TaskEvent::LaneUpdated {
            kind: LaneKind::Sandbox,
            slot,
            id: self.id,
            display: display.into(),
        });
    }

    /// Report that this job's result was served from a cache, and which one.
    /// Meaningless (and never read) unless the job also never calls
    /// [`RunContext::started`].
    pub fn report_cache_source(&self, source: CacheSource) {
        *self.state.cache_source.lock().unwrap() = Some(source);
    }
}

impl Scheduler {
    /// Create a scheduler with a total budget of `jobs` permits that emits node
    /// events onto `events`. A job costs one permit per declared core, so the
    /// bound is on total cores in flight, not on the number of jobs.
    ///
    /// Must be called from within a tokio runtime (it captures the current
    /// [`tokio::runtime::Handle`] for the dispatch pool's workers to block on
    /// the `--jobs` semaphore with).
    pub fn new(
        jobs: usize,
        cancellation: Arc<AtomicBool>,
        events: UnboundedSender<TaskEvent>,
    ) -> Arc<Self> {
        let jobs = jobs.max(1);
        let pool_size = jobs.max(default_pool_size());
        Arc::new(Self {
            jobs,
            permits: Arc::new(Semaphore::new(jobs)),
            slots: Arc::new(Mutex::new((0..jobs).collect())),
            events,
            next_job: AtomicU64::new(0),
            outstanding: AtomicUsize::new(0),
            activity: Notify::new(),
            cancellation,
            pool: DispatchPool::new(pool_size),
            handle: tokio::runtime::Handle::current(),
        })
    }

    /// Emit a node event directly (used by the JS memo hook to report memo
    /// nodes, which are not scheduler jobs).
    pub fn emit(&self, event: TaskEvent) {
        let _ = self.events.send(event);
    }

    /// The total permit budget (`--jobs`). A caller that has to tell its
    /// action how many cores it was granted needs this to apply the same clamp
    /// [`Scheduler::run`] does, so the granted count and the reported one
    /// cannot disagree.
    pub fn jobs(&self) -> usize {
        self.jobs
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
    /// [`RunContext::reserve`] before it stages anything expensive, and
    /// [`RunContext::started`] when it has crossed its actual work boundary;
    /// cache-only jobs never need to call either.
    ///
    /// `cores` is how much of the `--jobs` budget the work costs — the number
    /// of permits (and lanes) it holds while it runs. Work that keeps one core
    /// busy passes `1`; work that parallelises itself across several (a
    /// compiler driving its own job server) declares that many, so the
    /// scheduler admits proportionally fewer of them at once. It is clamped to
    /// `[1, jobs]`: an action asking for more cores than the whole budget runs
    /// alone rather than waiting on permits the semaphore can never grant.
    pub async fn run<T, F>(
        &self,
        parent: Option<u64>,
        display: impl Into<String>,
        kind: TaskKind,
        cores: usize,
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
            log_level: TaskLogLevel::Debug,
        });

        if self.cancellation.load(Ordering::SeqCst) {
            let _ = self.events.send(TaskEvent::Done {
                id,
                outcome: TaskOutcome::Canceled,
                cached: None,
                cache_source: None,
            });
            self.bump_outstanding(-1);
            bail!("canceled before execution");
        }

        let state = Arc::new(RunState {
            cores: cores.clamp(1, self.jobs),
            slots: Mutex::new(Vec::new()),
            permit: Mutex::new(None),
            started: AtomicBool::new(false),
            cache_source: Mutex::new(None),
        });
        let context = RunContext {
            events: self.events.clone(),
            id,
            display: display.clone(),
            permits: Arc::clone(&self.permits),
            slots: Arc::clone(&self.slots),
            state: Arc::clone(&state),
            cancellation: Arc::clone(&self.cancellation),
            handle: self.handle.clone(),
        };
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        self.pool.submit(Box::new(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(context)))
                .map_err(panic_message);
            let _ = result_tx.send(outcome);
        }));
        // The pool's worker threads never drop a job without sending a result
        // (the `catch_unwind` above guarantees that), so a `RecvError` here
        // would mean a worker thread died some other way — treat it the same
        // as a panic rather than unwrapping.
        let result = result_rx
            .await
            .unwrap_or_else(|_| Err("lost dispatch pool worker".to_string()));
        for slot in state.slots.lock().unwrap().drain(..) {
            let _ = self.events.send(TaskEvent::LaneCleared {
                kind: LaneKind::Sandbox,
                slot,
                id,
            });
            self.slots.lock().unwrap().push(slot);
        }
        // Unconditional, and after the slots: a job that reserved its permits
        // but never started holds no slot, and leaving those permits behind
        // would retire that much of the `--jobs` budget for the rest of the run.
        drop(state.permit.lock().unwrap().take());

        let outcome = match &result {
            Ok(Ok(_)) => TaskOutcome::Ok,
            Ok(Err(error)) => TaskOutcome::Err(format!("{error:#}")),
            Err(message) => TaskOutcome::Err(format!("worker panicked: {message}")),
        };
        let cached = Some(!state.started.load(Ordering::SeqCst));
        let cache_source = *state.cache_source.lock().unwrap();
        let _ = self.events.send(TaskEvent::Done {
            id,
            outcome,
            cached,
            cache_source,
        });
        self.bump_outstanding(-1);

        match result {
            Ok(inner) => inner,
            Err(message) => bail!("scheduler worker panicked: {message}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Scheduler, TaskEvent, TaskKind};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn cache_only_sandbox_job_is_classified_without_starting_a_lane() {
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(1, Arc::new(AtomicBool::new(false)), tx);

        scheduler
            .run(None, "cached command", TaskKind::Sandbox, 1, |_context| {
                Ok(())
            })
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
        assert!(collected.iter().any(|event| matches!(
            event,
            TaskEvent::Done {
                cached: Some(true),
                ..
            }
        )));
    }

    #[tokio::test]
    async fn started_sandbox_job_is_reported_as_not_cached() {
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(1, Arc::new(AtomicBool::new(false)), tx);

        scheduler
            .run(None, "fresh command", TaskKind::Sandbox, 1, |context| {
                context.started();
                Ok(())
            })
            .await
            .unwrap();

        let collected: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        assert!(collected.iter().any(|event| matches!(
            event,
            TaskEvent::Done {
                cached: Some(false),
                ..
            }
        )));
    }

    #[tokio::test]
    async fn phase_takes_and_updates_one_lane_without_starting_the_command() {
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(1, Arc::new(AtomicBool::new(false)), tx);

        scheduler
            .run(None, "remote command", TaskKind::Sandbox, 1, |context| {
                context.phase("setting up sandbox: remote command");
                context.phase("materializing inputs: remote command");
                Ok(())
            })
            .await
            .unwrap();

        let collected: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        assert_eq!(
            collected
                .iter()
                .filter(|event| matches!(event, TaskEvent::LaneStarted { .. }))
                .count(),
            1
        );
        assert_eq!(
            collected
                .iter()
                .filter(|event| matches!(event, TaskEvent::LaneUpdated { .. }))
                .count(),
            2
        );
        assert!(collected.iter().any(|event| matches!(
            event,
            TaskEvent::Done {
                cached: Some(true),
                ..
            }
        )));
    }

    /// `reserve()` is what bounds sandbox staging, so it must respect `--jobs`;
    /// it also now takes a progress lane (so staging shows up in the swimlane)
    /// while staying invisible to cache accounting.
    #[tokio::test]
    async fn reserve_bounds_concurrency_and_takes_a_lane() {
        const JOBS: usize = 2;
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(JOBS, Arc::new(AtomicBool::new(false)), tx);
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for index in 0..8 {
            let scheduler = Arc::clone(&scheduler);
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            handles.push(tokio::spawn(async move {
                scheduler
                    .run(
                        None,
                        format!("staging {index}"),
                        TaskKind::Sandbox,
                        1,
                        move |context| {
                            context.reserve();
                            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(now, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(20));
                            live.fetch_sub(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                    .await
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }

        assert!(
            peak.load(Ordering::SeqCst) <= JOBS,
            "reserve() must bound staging to --jobs, saw {} concurrent",
            peak.load(Ordering::SeqCst)
        );
        let collected: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        let started = collected
            .iter()
            .filter(|event| matches!(event, TaskEvent::LaneStarted { .. }))
            .count();
        let cleared = collected
            .iter()
            .filter(|event| matches!(event, TaskEvent::LaneCleared { .. }))
            .count();
        assert_eq!(started, 8, "reserve() must take a progress lane");
        assert_eq!(
            cleared, 8,
            "every lane reserve() takes must be cleared once the job ends"
        );
        let done: Vec<_> = collected
            .iter()
            .filter_map(|event| match event {
                TaskEvent::Done { cached, .. } => Some(*cached),
                _ => None,
            })
            .collect();
        assert_eq!(done.len(), 8);
        assert!(
            done.iter().all(|cached| *cached == Some(true)),
            "reserve() alone must not change cache classification"
        );
    }

    /// A wide job must cost its declared weight: on a budget of exactly its
    /// own `cores`, nothing else may run beside it, and it must occupy that
    /// many lanes rather than one.
    #[tokio::test]
    async fn a_wide_job_holds_its_whole_core_budget_and_its_lanes() {
        const JOBS: usize = 4;
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(JOBS, Arc::new(AtomicBool::new(false)), tx);
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for index in 0..4 {
            let scheduler = Arc::clone(&scheduler);
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            handles.push(tokio::spawn(async move {
                scheduler
                    .run(
                        None,
                        format!("wide {index}"),
                        TaskKind::Sandbox,
                        JOBS,
                        move |context| {
                            context.reserve();
                            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(now, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(20));
                            live.fetch_sub(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                    .await
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }

        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "a job costing the whole budget must run alone"
        );
        let collected: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        let started = collected
            .iter()
            .filter(|event| matches!(event, TaskEvent::LaneStarted { .. }))
            .count();
        let cleared = collected
            .iter()
            .filter(|event| matches!(event, TaskEvent::LaneCleared { .. }))
            .count();
        assert_eq!(
            started,
            4 * JOBS,
            "a wide job must occupy one lane per core"
        );
        assert_eq!(cleared, 4 * JOBS, "and release every one of them");
    }

    /// Two half-budget jobs must still overlap — the weight throttles, it does
    /// not serialize.
    #[tokio::test]
    async fn jobs_that_fit_the_budget_together_still_overlap() {
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(4, Arc::new(AtomicBool::new(false)), tx);
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for index in 0..2 {
            let scheduler = Arc::clone(&scheduler);
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            handles.push(tokio::spawn(async move {
                scheduler
                    .run(
                        None,
                        format!("half {index}"),
                        TaskKind::Sandbox,
                        2,
                        move |context| {
                            context.reserve();
                            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(now, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            live.fetch_sub(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                    .await
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }

        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "two 2-core jobs must run together under a 4-core budget"
        );
    }

    /// An action asking for more cores than the whole budget must be clamped
    /// and run alone. Unclamped, `acquire_many_owned` would wait forever on
    /// permits the semaphore can never grant; the timeout is what catches it.
    #[tokio::test]
    async fn a_job_wider_than_the_budget_is_clamped_instead_of_wedging() {
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(2, Arc::new(AtomicBool::new(false)), tx);

        let work = scheduler.run(None, "too wide", TaskKind::Sandbox, 64, |context| {
            context.started();
            Ok(())
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), work)
            .await
            .expect("an over-wide job must be clamped to the budget, not wait on it forever")
            .unwrap();
    }

    /// A job that reserves but never starts still holds both a permit and a
    /// slot (reserve takes both now). If either leaked instead of being
    /// released when the job ends, sequential reserve-only jobs against a
    /// single-slot scheduler would exhaust the pool and wedge; the timeout is
    /// what catches that.
    #[tokio::test]
    async fn reserve_only_jobs_release_their_permit() {
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(1, Arc::new(AtomicBool::new(false)), tx);

        let work = async {
            for index in 0..4 {
                scheduler
                    .run(
                        None,
                        format!("reserve {index}"),
                        TaskKind::Sandbox,
                        1,
                        |context| {
                            context.reserve();
                            Ok(())
                        },
                    )
                    .await
                    .unwrap();
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), work)
            .await
            .expect("reserve-only jobs must not exhaust the permit pool");
    }

    /// The dispatch pool must reuse a small, fixed set of threads no matter
    /// how many jobs fan in at once — this is the regression guard for the
    /// original bug (unconditional `spawn_blocking` letting thread count grow
    /// unbounded with the graph's width). `JOBS` is picked above
    /// `default_pool_size()`'s 16-thread ceiling so the pool size is exactly
    /// `JOBS`, making the bound deterministic and independent of the test
    /// machine's core count.
    #[tokio::test]
    async fn dispatch_pool_bounds_live_thread_count() {
        const JOBS: usize = 20;
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(JOBS, Arc::new(AtomicBool::new(false)), tx);
        let thread_ids = Arc::new(Mutex::new(std::collections::HashSet::new()));

        let mut handles = Vec::new();
        for index in 0..(JOBS * 5) {
            let scheduler = Arc::clone(&scheduler);
            let thread_ids = Arc::clone(&thread_ids);
            handles.push(tokio::spawn(async move {
                scheduler
                    .run(
                        None,
                        format!("job {index}"),
                        TaskKind::Sandbox,
                        1,
                        move |_context| {
                            thread_ids
                                .lock()
                                .unwrap()
                                .insert(std::thread::current().id());
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            Ok(())
                        },
                    )
                    .await
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }

        let seen = thread_ids.lock().unwrap().len();
        assert!(
            seen <= JOBS,
            "dispatch pool must reuse a fixed set of threads, saw {seen} distinct threads for {} jobs",
            JOBS * 5
        );
    }

    /// A job whose closure panics must be reported as a normal error, not
    /// crash the process or wedge the caller — and the worker thread that ran
    /// it must survive to run the next job. Guards the `catch_unwind` wrapper
    /// the dispatch pool needs (a naive pool would unwind straight out of the
    /// worker loop and permanently lose that thread).
    #[tokio::test]
    async fn a_panicking_job_is_reported_and_its_worker_survives() {
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let scheduler = Scheduler::new(1, Arc::new(AtomicBool::new(false)), tx);

        let panicked = scheduler
            .run(
                None,
                "boom",
                TaskKind::Sandbox,
                1,
                |_context| -> anyhow::Result<()> {
                    panic!("deliberate test panic");
                },
            )
            .await;
        let message = panicked
            .expect_err("a panicking job must surface as an error")
            .to_string();
        assert!(
            message.contains("worker panicked"),
            "unexpected error message: {message}"
        );

        scheduler
            .run(None, "after panic", TaskKind::Sandbox, 1, |_context| Ok(()))
            .await
            .expect("a later job must still run on a surviving worker thread");
    }

    /// A queued `reserve()` must give up promptly when the run is canceled,
    /// rather than waiting for the job ahead of it (which may never finish)
    /// to release its permit — the behavior `acquire_permit`'s doc comment
    /// promises. Exercises the `strict = false` `select!`/cancellation-poll
    /// path the busy-spin was replaced with.
    #[tokio::test]
    async fn reserve_gives_up_on_cancellation_without_waiting_out_the_queue() {
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let cancellation = Arc::new(AtomicBool::new(false));
        let scheduler = Scheduler::new(1, Arc::clone(&cancellation), tx);

        let (holder_ready_tx, holder_ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder_scheduler = Arc::clone(&scheduler);
        let holder = tokio::spawn(async move {
            holder_scheduler
                .run(None, "holder", TaskKind::Sandbox, 1, move |context| {
                    context.reserve();
                    let _ = holder_ready_tx.send(());
                    let _ = release_rx.recv();
                    Ok(())
                })
                .await
                .unwrap();
        });
        holder_ready_rx
            .await
            .expect("holder must reserve the sole permit before we queue behind it");

        let queued_scheduler = Arc::clone(&scheduler);
        let queued = tokio::spawn(async move {
            queued_scheduler
                .run(None, "queued", TaskKind::Sandbox, 1, |context| {
                    context.reserve();
                    Ok(())
                })
                .await
        });

        // Let the queued job actually start waiting on the held permit before
        // canceling, so this exercises the wait path and not the up-front
        // `run()` cancellation check.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cancellation.store(true, Ordering::SeqCst);

        tokio::time::timeout(std::time::Duration::from_millis(500), queued)
            .await
            .expect(
                "queued reserve() must give up on cancellation instead of \
                 waiting out the holder, which is never released before this timeout",
            )
            .unwrap()
            .unwrap();

        let _ = release_tx.send(());
        holder.await.unwrap();
    }
}
