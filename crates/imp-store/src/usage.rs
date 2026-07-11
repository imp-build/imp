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
//! - `size_bytes` is NULL until a sized recording happens: CAS blobs and task
//!   records are sized on write (and backfilled by a stat on read), named
//!   slots only when they are set (directory walks on every get would be
//!   wasteful). Treat NULL as unknown and fall back to du/stat.
//!
//! Beyond per-entry usage, two side tables feed `cache gc` without it having
//! to evaluate any workspace JS: `workspaces` maps hashed `named/<scope>`
//! namespaces back to checkout paths (a scope whose checkout is gone is
//! prunable wholesale), and `declared_caches` is an LRU over `namedCache()`
//! declarations (a name nothing has declared for long enough is prunable even
//! if its slots were touched recently). Both are recorded as a side effect of
//! normal runs, so they only know about workspaces that have built since this
//! feature landed.

use std::collections::HashMap;
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
    /// Entries already recorded by this process, mapped to whether that
    /// recording carried a size. Timestamps are per-second, so re-recording
    /// within one run buys nothing; skipping keeps bulk paths (tree
    /// materialization) at one write per unique blob. A sized recording is
    /// still allowed through after an unsized one, so a get followed by a
    /// set upgrades the row.
    seen: HashMap<(UsageKind, String), bool>,
    /// Workspace ids and `(workspace_id, name)` declarations already recorded
    /// by this process; like `seen`, re-recording within one run buys nothing.
    seen_workspaces: std::collections::HashSet<String>,
    seen_declarations: std::collections::HashSet<(String, String)>,
}

/// One state per cache root — tests use per-test roots within a single
/// process, so a single cached connection would write to the wrong database.
static STATE: Mutex<Option<HashMap<PathBuf, RootState>>> = Mutex::new(None);

/// Record a named-cache slot use under its canonical id, `<scope>/<name>/<key>`.
pub fn record_named_use(scope_id: &str, name: &str, key: &str) {
    record_use(UsageKind::Named, &format!("{scope_id}/{name}/{key}"));
}

/// Record a named-cache slot being set, sizing the row from the slot
/// directory. Walks the directory — only call on set, not on every get.
pub fn record_named_set(scope_id: &str, name: &str, key: &str, slot: &std::path::Path) {
    record_use_sized(
        UsageKind::Named,
        &format!("{scope_id}/{name}/{key}"),
        dir_size_bytes(slot),
    );
}

/// Record that a cache entry was created or used just now. Best-effort:
/// silently does nothing on any error.
pub fn record_use(kind: UsageKind, id: &str) {
    record_use_sized(kind, id, None);
}

/// Like [`record_use`], also recording the entry's size when known. An
/// unsized use never clears a previously recorded size.
pub fn record_use_sized(kind: UsageKind, id: &str, size_bytes: Option<u64>) {
    let Ok(root) = crate::cache::cache_root() else {
        return;
    };
    record_use_at(&root, kind, id, size_bytes);
}

/// Record a CAS blob read, sizing the row by stat-ing the blob file — this
/// backfills sizes for blobs stored before size tracking existed.
pub fn record_cas_read(digest: &str) {
    let size = crate::cache::cas_blob_path(digest)
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    record_use_sized(UsageKind::Cas, digest, size);
}

/// Run `f` against the (lazily opened) state for `root`; `None` if the state
/// lock is poisoned.
fn with_state<R>(root: &std::path::Path, f: impl FnOnce(&mut RootState) -> R) -> Option<R> {
    let mut guard = STATE.lock().ok()?;
    let state = guard
        .get_or_insert_with(HashMap::new)
        .entry(root.to_path_buf())
        .or_insert_with(|| RootState {
            connection: open_db(root),
            seen: HashMap::new(),
            seen_workspaces: std::collections::HashSet::new(),
            seen_declarations: std::collections::HashSet::new(),
        });
    Some(f(state))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Record that a workspace (by cache id) was seen at `path` just now. Gives GC
/// a reverse map from hashed `named/<scope>` namespaces to checkouts, so a
/// scope whose checkout no longer exists can be pruned wholesale.
pub fn record_workspace(workspace_id: &str, path: &std::path::Path) {
    let Ok(root) = crate::cache::cache_root() else {
        return;
    };
    record_workspace_at(&root, workspace_id, path);
}

fn record_workspace_at(root: &std::path::Path, workspace_id: &str, path: &std::path::Path) {
    with_state(root, |state| {
        if state.seen_workspaces.contains(workspace_id) {
            return;
        }
        let Some(conn) = &state.connection else {
            return;
        };
        let recorded = conn
            .execute(
                "INSERT INTO workspaces (id, path, last_seen_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                     path = excluded.path,
                     last_seen_at = excluded.last_seen_at",
                rusqlite::params![workspace_id, path.to_string_lossy(), now_unix()],
            )
            .is_ok();
        if recorded {
            state.seen_workspaces.insert(workspace_id.to_owned());
        }
    });
}

/// Record that `workspace_id`'s rules declared `namedCache({name, shared})`
/// just now. Declarations have their own LRU (`last_declared_at`): a cache
/// name no run has declared for long enough ages out and GC prunes its whole
/// directory, even if its slots were used recently.
pub fn record_declared_cache(workspace_id: &str, name: &str, shared: bool) {
    let Ok(root) = crate::cache::cache_root() else {
        return;
    };
    record_declared_cache_at(&root, workspace_id, name, shared);
}

fn record_declared_cache_at(root: &std::path::Path, workspace_id: &str, name: &str, shared: bool) {
    with_state(root, |state| {
        let seen_key = (workspace_id.to_owned(), name.to_owned());
        if state.seen_declarations.contains(&seen_key) {
            return;
        }
        let Some(conn) = &state.connection else {
            return;
        };
        let recorded = conn
            .execute(
                "INSERT INTO declared_caches (workspace_id, name, shared, last_declared_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(workspace_id, name) DO UPDATE SET
                     shared = excluded.shared,
                     last_declared_at = excluded.last_declared_at",
                rusqlite::params![workspace_id, name, shared, now_unix()],
            )
            .is_ok();
        if recorded {
            state.seen_declarations.insert(seen_key);
        }
    });
}

fn record_use_at(root: &std::path::Path, kind: UsageKind, id: &str, size_bytes: Option<u64>) {
    with_state(root, |state| {
        let seen_key = (kind, id.to_owned());
        if let Some(&sized) = state.seen.get(&seen_key) {
            if sized || size_bytes.is_none() {
                return;
            }
        }
        let Some(conn) = &state.connection else {
            return;
        };
        let recorded = conn
            .execute(
                "INSERT INTO usage (kind, id, created_at, last_used_at, size_bytes)
                 VALUES (?1, ?2, ?3, ?3, ?4)
                 ON CONFLICT(kind, id) DO UPDATE SET
                     last_used_at = excluded.last_used_at,
                     size_bytes = COALESCE(excluded.size_bytes, size_bytes)",
                rusqlite::params![kind.as_str(), id, now_unix(), size_bytes],
            )
            .is_ok();
        if recorded {
            state.seen.insert(seen_key, size_bytes.is_some());
        }
    });
}

/// Total byte size of a directory tree (or a single file), best-effort:
/// unreadable entries just don't count, a missing path is `None`.
pub fn dir_size_bytes(path: &std::path::Path) -> Option<u64> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_dir() {
        return Some(meta.len());
    }
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return Some(0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            total += dir_size_bytes(&entry.path()).unwrap_or(0);
        } else {
            total += meta.len();
        }
    }
    Some(total)
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
             size_bytes   INTEGER,
             PRIMARY KEY (kind, id)
         );
         CREATE TABLE IF NOT EXISTS workspaces (
             id           TEXT PRIMARY KEY,
             path         TEXT NOT NULL,
             last_seen_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS declared_caches (
             workspace_id     TEXT NOT NULL,
             name             TEXT NOT NULL,
             shared           INTEGER NOT NULL,
             last_declared_at INTEGER NOT NULL,
             PRIMARY KEY (workspace_id, name)
         );",
    )
    .ok()?;
    // Databases created before size tracking lack the column; the ALTER
    // fails harmlessly with "duplicate column" everywhere else.
    let _ = conn.execute("ALTER TABLE usage ADD COLUMN size_bytes INTEGER", []);
    Some(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query_row(root: &std::path::Path, kind: &str, id: &str) -> (i64, i64, Option<u64>) {
        let conn = Connection::open(root.join("usage.db")).unwrap();
        conn.query_row(
            "SELECT created_at, last_used_at, size_bytes FROM usage WHERE kind = ?1 AND id = ?2",
            rusqlite::params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    fn forget(root: &std::path::Path) {
        STATE
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .get_mut(root)
            .unwrap()
            .seen
            .clear();
    }

    #[test]
    fn record_use_inserts_then_bumps_last_used_only() {
        let cache = tempfile::tempdir().unwrap();
        record_use_at(cache.path(), UsageKind::Cas, "record-use-test-digest", None);
        let (created, used, size) = query_row(cache.path(), "cas", "record-use-test-digest");
        assert_eq!(created, used);
        assert_eq!(size, None);

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
        forget(cache.path());

        record_use_at(cache.path(), UsageKind::Cas, "record-use-test-digest", None);
        let (created, used, _) = query_row(cache.path(), "cas", "record-use-test-digest");
        assert_eq!(created, 1000);
        assert!(used > 1000);
    }

    #[test]
    fn sizes_backfill_but_never_clear() {
        let cache = tempfile::tempdir().unwrap();
        // An unsized get leaves size unknown; a later sized set fills it in
        // (the dedup set lets a sized recording through after an unsized one).
        record_use_at(cache.path(), UsageKind::Named, "size-test", None);
        let (_, _, size) = query_row(cache.path(), "named", "size-test");
        assert_eq!(size, None);
        record_use_at(cache.path(), UsageKind::Named, "size-test", Some(42));
        let (_, _, size) = query_row(cache.path(), "named", "size-test");
        assert_eq!(size, Some(42));

        // A later unsized use (e.g. from another process) bumps the timestamp
        // but must not clear the size.
        forget(cache.path());
        record_use_at(cache.path(), UsageKind::Named, "size-test", None);
        let (_, _, size) = query_row(cache.path(), "named", "size-test");
        assert_eq!(size, Some(42));
    }

    #[test]
    fn open_db_adds_the_size_column_to_a_pre_size_database() {
        let cache = tempfile::tempdir().unwrap();
        Connection::open(cache.path().join("usage.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE usage (
                     kind TEXT NOT NULL, id TEXT NOT NULL,
                     created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
                     PRIMARY KEY (kind, id));
                 INSERT INTO usage VALUES ('cas', 'old-row', 5, 5);",
            )
            .unwrap();
        record_use_at(cache.path(), UsageKind::Cas, "migrate-test", Some(7));
        assert_eq!(query_row(cache.path(), "cas", "old-row"), (5, 5, None));
        assert_eq!(query_row(cache.path(), "cas", "migrate-test").2, Some(7));
    }

    #[test]
    fn dir_size_sums_files_recursively() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"12345").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b"), b"123").unwrap();
        assert_eq!(dir_size_bytes(dir.path()), Some(8));
        assert_eq!(dir_size_bytes(&dir.path().join("missing")), None);
    }

    fn forget_side_tables(root: &std::path::Path) {
        with_state(root, |state| {
            state.seen_workspaces.clear();
            state.seen_declarations.clear();
        });
    }

    #[test]
    fn workspaces_and_declarations_upsert() {
        let cache = tempfile::tempdir().unwrap();

        record_workspace_at(cache.path(), "w1", std::path::Path::new("/tmp/a"));
        forget_side_tables(cache.path());
        record_workspace_at(cache.path(), "w1", std::path::Path::new("/tmp/b"));

        let conn = Connection::open(cache.path().join("usage.db")).unwrap();
        let (path, count): (String, i64) = conn
            .query_row(
                "SELECT path, (SELECT COUNT(*) FROM workspaces) FROM workspaces WHERE id = 'w1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((path.as_str(), count), ("/tmp/b", 1));

        record_declared_cache_at(cache.path(), "w1", "tools", false);
        forget_side_tables(cache.path());
        record_declared_cache_at(cache.path(), "w1", "tools", true);

        let (shared, count): (bool, i64) = conn
            .query_row(
                "SELECT shared, (SELECT COUNT(*) FROM declared_caches) \
                 FROM declared_caches WHERE workspace_id = 'w1' AND name = 'tools'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((shared, count), (true, 1));
    }

    #[test]
    fn record_use_survives_an_unusable_cache_root() {
        // A file where the cache root should be makes every open fail;
        // record_use must be a silent no-op, not a panic or error.
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("not-a-dir");
        std::fs::write(&bogus, b"").unwrap();
        record_use_at(&bogus, UsageKind::Task, "no-root-test", None);
    }
}
