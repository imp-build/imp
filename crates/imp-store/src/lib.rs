//! Content-addressed storage for imp: the CAS blob store, Merkle digest
//! trees (`digest`), and the task/named caches (`cache`). Pure
//! filesystem-backed — no process execution, no workspace knowledge beyond
//! paths handed in by callers.
pub mod cache;
pub mod digest;
pub mod gc;
mod materialize_pool;
pub use materialize_pool::{configure_worker_count, default_worker_count};
pub mod memo_trace;
pub mod stats;
pub mod trace;
pub mod usage;
