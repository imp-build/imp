//! Opt-in artifact-provenance tracing for diagnosing task-cache/CAS bugs
//! (imp#12: a binary present moments earlier "goes missing" under real
//! `./imp test //...` concurrency). Off by default — a full directory
//! capture/materialize can emit thousands of lines. Enable with
//! `IMP_TRACE_ARTIFACTS=1`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("IMP_TRACE_ARTIFACTS").as_deref() == Ok("1"))
}

/// Process-wide materialize counters. Item (a) of the cache backlog — one
/// `create_dir_all` per directory instead of per file — has no other
/// machine-independent signal: the file and sandbox counts do not move, only
/// the directory-creation syscall count does. These count that, plus the
/// files copied out of CAS, so `ci/cache_baseline.py` can read both from a
/// single `materialize totals` line rather than counting thousands of
/// per-file trace lines. The adds are `Relaxed` and unconditional — one
/// atomic increment next to a filesystem copy is free — so the number is
/// available without `IMP_TRACE_ARTIFACTS`; only the summary line is gated.
static MATERIALIZE_FILES: AtomicU64 = AtomicU64::new(0);
static MATERIALIZE_DIR_CREATES: AtomicU64 = AtomicU64::new(0);

pub fn note_materialize_file() {
    MATERIALIZE_FILES.fetch_add(1, Ordering::Relaxed);
}

pub fn note_materialize_dir_create() {
    MATERIALIZE_DIR_CREATES.fetch_add(1, Ordering::Relaxed);
}

/// `(files copied out of CAS, directories created on the materialize path)`
/// since process start.
pub fn materialize_totals() -> (u64, u64) {
    (
        MATERIALIZE_FILES.load(Ordering::Relaxed),
        MATERIALIZE_DIR_CREATES.load(Ordering::Relaxed),
    )
}

#[macro_export]
macro_rules! artifact_trace {
    ($($arg:tt)*) => {
        if $crate::trace::enabled() {
            eprintln!("[artifact-trace] {}", format_args!($($arg)*));
        }
    };
}
