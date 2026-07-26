//! A remote cache abstraction modeled on the Bazel Remote Execution API
//! (REv2): [`RemoteStore`] mirrors the `ContentAddressableStorage` and
//! `ActionCache` gRPC services closely enough that a real REv2 client could
//! implement this same trait alongside object-storage-shaped backends.
//! Correspondence:
//!
//! | here                                     | REv2                                          |
//! |-------------------------------------------|------------------------------------------------|
//! | [`Digest`]                                | `Digest{hash, size_bytes}`                      |
//! | `RemoteStore::find_missing_blobs`         | `ContentAddressableStorage.FindMissingBlobs`    |
//! | `RemoteStore::batch_update_blobs`         | `ContentAddressableStorage.BatchUpdateBlobs`    |
//! | `RemoteStore::batch_read_blobs`           | `ContentAddressableStorage.BatchReadBlobs`      |
//! | `RemoteStore::get_action_result`          | `ActionCache.GetActionResult`                   |
//! | `RemoteStore::update_action_result`       | `ActionCache.UpdateActionResult`                |
//!
//! `imp-store`'s own CAS keeps digests as bare hex SHA-256 strings (no
//! REAPI interop need there). [`Digest`] pairs that hash with a size instead,
//! because a backing store here — GitHub Actions cache, first — is an opaque
//! blob store rather than content-addressed, and being able to size a
//! download before requesting it is worth the extra field.
//!
//! This crate is a standalone building block: a caller wires a
//! `Box<dyn RemoteStore>` into whatever local CAS it wants to back, most
//! naturally as an optional remote tier passed in when that store is
//! constructed.

mod ghac;
mod opendal_store;

pub use ghac::ghac_remote_store;
pub use opendal_store::OpendalRemoteStore;

use anyhow::Result;
use async_trait::async_trait;

/// A REv2-style digest: content hash plus size, so a backing store can size
/// a transfer before making it. `hash` is caller-defined (imp's own CAS
/// uses lowercase-hex SHA-256) — this crate never hashes anything itself.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Digest {
    pub hash: String,
    pub size_bytes: u64,
}

impl Digest {
    pub fn new(hash: impl Into<String>, size_bytes: u64) -> Self {
        Self {
            hash: hash.into(),
            size_bytes,
        }
    }
}

/// A remote cache backend, shaped after REv2's `ContentAddressableStorage`
/// and `ActionCache` services. Implementations are free to store CAS blobs
/// and action results however they like; the only contract is content
/// addressing by [`Digest::hash`].
#[async_trait]
pub trait RemoteStore: Send + Sync {
    /// Return the subset of `digests` not already present remotely — REv2
    /// `FindMissingBlobs`. Callers use this to skip re-uploading blobs the
    /// remote already has.
    async fn find_missing_blobs(&self, digests: &[Digest]) -> Result<Vec<Digest>>;

    /// Upload blobs. A failure uploading one blob does not abort the others —
    /// REv2 returns a per-blob status in `BatchUpdateBlobsResponse` rather
    /// than failing the whole RPC, and this mirrors that: the outer `Result`
    /// is reserved for failures that mean no blob could be attempted (e.g.
    /// the backend is unreachable). Implementations must report a duplicate
    /// write of an immutable, content-addressed blob as success.
    async fn batch_update_blobs(
        &self,
        blobs: Vec<(Digest, Vec<u8>)>,
    ) -> Result<Vec<(Digest, Result<()>)>>;

    /// Download blobs, REv2 `BatchReadBlobs`. Same per-blob-status shape as
    /// [`Self::batch_update_blobs`]: a missing or corrupt blob is an `Err` in
    /// that blob's slot, not a failure of the whole call.
    async fn batch_read_blobs(&self, digests: &[Digest]) -> Result<Vec<(Digest, Result<Vec<u8>>)>>;

    /// Look up a cached action result by action digest — REv2
    /// `GetActionResult`. `Ok(None)` means a cache miss; the payload is an
    /// opaque, caller-defined serialization (this crate has no opinion on
    /// what an "action result" contains).
    async fn get_action_result(&self, action_digest: &Digest) -> Result<Option<Vec<u8>>>;

    /// Publish an action result for `action_digest` — REv2
    /// `UpdateActionResult`.
    async fn update_action_result(&self, action_digest: &Digest, result: Vec<u8>) -> Result<()>;
}
