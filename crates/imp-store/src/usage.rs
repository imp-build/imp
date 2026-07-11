//! Cache usage tracking: a small SQLite database at `<cache_root>/usage.db`
//! recording when each named-cache slot, CAS blob, and task record was created
//! and last used. This is the baseline signal for a future `cache gc`.
//!
//! Recording is strictly best-effort — any failure (unwritable root, locked
//! db, ...) is swallowed so it can never fail a build.
//!
//! GC notes for whoever builds on this:
//! - Entries that predate this module have no row; treat "no row" as unknown
//!   and fall back to file mtime (or backfill a row on the first sweep).
//! - `usage.db` and its `-wal`/`-shm` companions live inside the cache root;
//!   GC must never delete them.
//! - CAS rows are an LRU signal only — GC must still mark live blobs from
//!   recent task records, since a record can hit without its blobs being
//!   re-read (`materialize:false` chained digests).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UsageKind {
    /// CAS blob; id is the blob digest.
    Cas,
    /// Named cache slot; id is `<scope>/<name>/<key>`.
    Named,
    /// Task cache record; id is the task key.
    Task,
}

impl UsageKind {
    fn as_str(self) -> &'static str {
        match self {
            UsageKind::Cas => "cas",
            UsageKind::Named => "named",
            UsageKind::Task => "task",
        }
    }
}

struct RootState {
    /// `None` when the database could not be opened; remembered so a broken
    /// root fails once instead of retrying on every call.
    connection: Option<Connection>,
    /// Entries already recorded by this process. Timestamps are per-second,
    /// so re-recording within one run buys nothing; skipping keeps bulk
    /// paths (tree materialization) at one write per unique blob.
    seen: HashSet<(UsageKind, String)>,
}

/// One state per cache root — tests use per-test roots within a single
/// process, so a single cached connection would write to the wrong database.
static STATE: Mutex<Option<HashMap<PathBuf, RootState>>> = Mutex::new(None);

/// Record a named-cache slot use under its canonical id, `<scope>/<name>/<key>`.
pub fn record_named_use(scope_id: &str, name: &str, key: &str) {
    record_use(UsageKind::Named, &format!("{scope_id}/{name}/{key}"));
}

/// Record that a cache entry was created or used just now. Best-effort:
/// silently does nothing on any error.
pub fn record_use(kind: UsageKind, id: &str) {
    let Ok(root) = crate::cache::cache_root() else {
        return;
    };
    record_use_at(&root, kind, id);
}

fn record_use_at(root: &std::path::Path, kind: UsageKind, id: &str) {
    let Ok(mut guard) = STATE.lock() else {
        return;
    };
    let state = guard
        .get_or_insert_with(HashMap::new)
        .entry(root.to_path_buf())
        .or_insert_with(|| RootState {
            connection: open_db(root),
            seen: HashSet::new(),
        });
    if state.seen.contains(&(kind, id.to_owned())) {
        return;
    }
    let Some(conn) = &state.connection else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let recorded = conn
        .execute(
            "INSERT INTO usage (kind, id, created_at, last_used_at) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(kind, id) DO UPDATE SET last_used_at = excluded.last_used_at",
            rusqlite::params![kind.as_str(), id, now],
        )
        .is_ok();
    if recorded {
        state.seen.insert((kind, id.to_owned()));
    }
}

fn open_db(root: &std::path::Path) -> Option<Connection> {
    let conn = Connection::open(root.join("usage.db")).ok()?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
    conn.pragma_update(None, "journal_mode", "WAL").ok()?;
    conn.pragma_update(None, "synchronous", "NORMAL").ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage (
             kind         TEXT NOT NULL,
             id           TEXT NOT NULL,
             created_at   INTEGER NOT NULL,
             last_used_at INTEGER NOT NULL,
             PRIMARY KEY (kind, id)
         );",
    )
    .ok()?;
    Some(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query_row(root: &std::path::Path, kind: &str, id: &str) -> (i64, i64) {
        let conn = Connection::open(root.join("usage.db")).unwrap();
        conn.query_row(
            "SELECT created_at, last_used_at FROM usage WHERE kind = ?1 AND id = ?2",
            rusqlite::params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn record_use_inserts_then_bumps_last_used_only() {
        let cache = tempfile::tempdir().unwrap();
        record_use_at(cache.path(), UsageKind::Cas, "record-use-test-digest");
        let (created, used) = query_row(cache.path(), "cas", "record-use-test-digest");
        assert_eq!(created, used);

        // Backdate the row and clear this process's dedup memory of it so a
        // second record_use actually writes; created_at must survive.
        {
            let conn = Connection::open(cache.path().join("usage.db")).unwrap();
            conn.execute(
                "UPDATE usage SET created_at = 1000, last_used_at = 1000 \
                 WHERE id = 'record-use-test-digest'",
                [],
            )
            .unwrap();
        }
        STATE
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(cache.path())
            .unwrap()
            .seen
            .clear();

        record_use_at(cache.path(), UsageKind::Cas, "record-use-test-digest");
        let (created, used) = query_row(cache.path(), "cas", "record-use-test-digest");
        assert_eq!(created, 1000);
        assert!(used > 1000);
    }

    #[test]
    fn record_use_survives_an_unusable_cache_root() {
        // A file where the cache root should be makes every open fail;
        // record_use must be a silent no-op, not a panic or error.
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("not-a-dir");
        std::fs::write(&bogus, b"").unwrap();
        record_use_at(&bogus, UsageKind::Task, "no-root-test");
    }
}
