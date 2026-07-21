//! Opt-in artifact-provenance tracing for diagnosing task-cache/CAS bugs
//! (imp#12: a binary present moments earlier "goes missing" under real
//! `./imp test //...` concurrency). Off by default — a full directory
//! capture/materialize can emit thousands of lines. Enable with
//! `IMP_TRACE_ARTIFACTS=1`.

use std::sync::OnceLock;

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("IMP_TRACE_ARTIFACTS").as_deref() == Ok("1"))
}

#[macro_export]
macro_rules! artifact_trace {
    ($($arg:tt)*) => {
        if $crate::trace::enabled() {
            eprintln!("[artifact-trace] {}", format_args!($($arg)*));
        }
    };
}
