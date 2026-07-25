//! [`RemoteStore`](crate::RemoteStore) backed by the GitHub Actions cache
//! service, via OpenDAL's `ghac` backend.

use anyhow::{Context, Result};
use opendal::services::Ghac;
use opendal::Operator;

use crate::OpendalRemoteStore;

/// Folded into every cache entry's key namespace, so a future incompatible
/// change to what's stored under `cas/`/`ac/` doesn't collide with entries an
/// older imp-remote-cache already wrote into the same GitHub Actions cache.
const CACHE_VERSION: &str = "imp-remote-cache-v1";

/// Build a [`RemoteStore`](crate::RemoteStore) over the GitHub Actions cache
/// service. Reads `ACTIONS_CACHE_URL` and `ACTIONS_RUNTIME_TOKEN` from the
/// environment — only present inside a GitHub Actions job — which is where
/// OpenDAL's `ghac` backend gets its endpoint and auth from by default.
///
/// `root` namespaces keys within the cache (e.g. `"imp"`), letting several
/// unrelated tools share one GitHub Actions cache without colliding.
pub fn ghac_remote_store(root: &str) -> Result<OpendalRemoteStore> {
    let builder = Ghac::default().root(root).version(CACHE_VERSION);
    let op = Operator::new(builder)
        .context("build GitHub Actions cache operator")?
        .finish();
    Ok(OpendalRemoteStore::new(op))
}
