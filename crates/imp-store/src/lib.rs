//! Content-addressed storage for imp: the CAS blob store, Merkle digest
//! trees (`digest`), and the task/named caches (`cache`). Pure
//! filesystem-backed — no process execution, no workspace knowledge beyond
//! paths handed in by callers.
pub mod cache;
pub mod digest;
pub mod gc;
pub mod usage;
