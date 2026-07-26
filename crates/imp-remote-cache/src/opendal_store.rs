//! [`RemoteStore`] over any OpenDAL [`Operator`] — an object-storage-shaped
//! backend addressed by two flat key prefixes, `cas/` and `ac/`, so CAS blobs
//! and action-cache entries never collide even though both are just bytes at
//! a path as far as the backend is concerned.

use anyhow::{Context, Result};
use async_trait::async_trait;
use opendal::{Error as OpendalError, ErrorKind, Operator};

use crate::{Digest, RemoteStore};

pub struct OpendalRemoteStore {
    op: Operator,
}

impl OpendalRemoteStore {
    pub fn new(op: Operator) -> Self {
        Self { op }
    }
}

fn cas_path(digest: &Digest) -> String {
    format!("cas/{}", digest.hash)
}

fn action_path(digest: &Digest) -> String {
    format!("ac/{}", digest.hash)
}

fn is_not_found(error: &OpendalError) -> bool {
    error.kind() == ErrorKind::NotFound
}

/// CAS entries are immutable. A concurrent writer may create the same
/// content-addressed key after `find_missing_blobs` reports it absent but
/// before this write reaches the backend; that is an equally successful
/// outcome for the caller.
fn immutable_write_outcome(outcome: std::result::Result<(), OpendalError>) -> Result<()> {
    match outcome {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[async_trait]
impl RemoteStore for OpendalRemoteStore {
    async fn find_missing_blobs(&self, digests: &[Digest]) -> Result<Vec<Digest>> {
        let mut missing = Vec::new();
        for digest in digests {
            let present = self
                .op
                .exists(&cas_path(digest))
                .await
                .with_context(|| format!("check existence of blob {}", digest.hash))?;
            if !present {
                missing.push(digest.clone());
            }
        }
        Ok(missing)
    }

    async fn batch_update_blobs(
        &self,
        blobs: Vec<(Digest, Vec<u8>)>,
    ) -> Result<Vec<(Digest, Result<()>)>> {
        let mut results = Vec::with_capacity(blobs.len());
        for (digest, bytes) in blobs {
            let write = self.op.write(&cas_path(&digest), bytes).await.map(|_| ());
            let outcome = immutable_write_outcome(write)
                .with_context(|| format!("upload blob {}", digest.hash));
            results.push((digest, outcome));
        }
        Ok(results)
    }

    async fn batch_read_blobs(&self, digests: &[Digest]) -> Result<Vec<(Digest, Result<Vec<u8>>)>> {
        let mut results = Vec::with_capacity(digests.len());
        for digest in digests {
            let outcome = self
                .op
                .read(&cas_path(digest))
                .await
                .map(|buffer| buffer.to_vec())
                .with_context(|| format!("download blob {}", digest.hash));
            results.push((digest.clone(), outcome));
        }
        Ok(results)
    }

    async fn get_action_result(&self, action_digest: &Digest) -> Result<Option<Vec<u8>>> {
        match self.op.read(&action_path(action_digest)).await {
            Ok(buffer) => Ok(Some(buffer.to_vec())),
            Err(error) if is_not_found(&error) => Ok(None),
            Err(error) => {
                Err(error).with_context(|| format!("read action result {}", action_digest.hash))
            }
        }
    }

    async fn update_action_result(&self, action_digest: &Digest, result: Vec<u8>) -> Result<()> {
        self.op
            .write(&action_path(action_digest), result)
            .await
            .map(|_| ())
            .with_context(|| format!("write action result {}", action_digest.hash))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use opendal::{services::Memory, Operator};

    use super::*;

    fn memory_store() -> OpendalRemoteStore {
        let op = Operator::new(Memory::default()).unwrap().finish();
        OpendalRemoteStore::new(op)
    }

    fn digest(hash: &str, bytes: &[u8]) -> Digest {
        Digest::new(hash, bytes.len() as u64)
    }

    #[test]
    fn immutable_write_accepts_a_concurrent_create() {
        let duplicate = OpendalError::new(ErrorKind::AlreadyExists, "already exists");
        assert!(immutable_write_outcome(Err(duplicate)).is_ok());

        let failure = OpendalError::new(ErrorKind::PermissionDenied, "denied");
        assert!(immutable_write_outcome(Err(failure)).is_err());
    }

    #[tokio::test]
    async fn find_missing_blobs_reports_absent_digests_only() {
        let store = memory_store();
        let present = digest("aaa", b"hello");
        store
            .batch_update_blobs(vec![(present.clone(), b"hello".to_vec())])
            .await
            .unwrap();

        let missing_digest = digest("bbb", b"world");
        let missing = store
            .find_missing_blobs(&[present.clone(), missing_digest.clone()])
            .await
            .unwrap();

        assert_eq!(missing, vec![missing_digest]);
    }

    #[tokio::test]
    async fn batch_round_trips_blob_contents() {
        let store = memory_store();
        let a = digest("a", b"one");
        let b = digest("b", b"two");

        let upload = store
            .batch_update_blobs(vec![
                (a.clone(), b"one".to_vec()),
                (b.clone(), b"two".to_vec()),
            ])
            .await
            .unwrap();
        assert!(upload.iter().all(|(_, result)| result.is_ok()));

        let read = store
            .batch_read_blobs(&[a.clone(), b.clone()])
            .await
            .unwrap();
        let read: HashMap<_, _> = read.into_iter().collect();
        assert_eq!(read[&a].as_ref().unwrap().as_slice(), b"one");
        assert_eq!(read[&b].as_ref().unwrap().as_slice(), b"two");
    }

    #[tokio::test]
    async fn batch_read_blobs_reports_a_missing_digest_as_a_per_blob_error() {
        let store = memory_store();
        let missing = digest("missing", b"");

        let read = store.batch_read_blobs(&[missing.clone()]).await.unwrap();
        assert_eq!(read.len(), 1);
        assert!(read[0].1.is_err());
    }

    #[tokio::test]
    async fn action_result_round_trips_and_reports_none_when_absent() {
        let store = memory_store();
        let action = digest("action-1", b"");

        assert!(store.get_action_result(&action).await.unwrap().is_none());

        store
            .update_action_result(&action, b"cached-result".to_vec())
            .await
            .unwrap();

        assert_eq!(
            store.get_action_result(&action).await.unwrap().unwrap(),
            b"cached-result"
        );
    }
}
