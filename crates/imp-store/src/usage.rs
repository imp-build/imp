//! Cache usage tracking: a small SQLite database at `<cache_root>/usage.db`
//! recording when each named-cache slot, CAS blob, and task record was created
//! and last used. This is the baseline signal for a future `cache gc`.
//!
//! Recording is strictly best-effort — any failure (unwritable root, locked
//! db, ...) is swallowed so it can never fail a build.
//!
//! # Off the hot path
//!
//! No SQLite runs on the calling thread. Each `record_*` function does only the
//! in-process dedup (a `Mutex` over small sets, no I/O), then hands the record
//! to a single background writer thread over a bounded channel. The writer owns
//! every `rusqlite::Connection` (one per cache root, opened on first use) and is
//! the only thread that touches the database.
//!
//! - Dedup: `seen` / `seen_workspaces` / `seen_declarations` collapse repeated
//!   records within one run to one message per unique entry, so bulk tree
//!   materialization still sends at most one message per unique blob. The dedup
//!   entry is inserted before the send is confirmed; if the send later drops
//!   (see below), the entry stays "seen" for this process and the record is
//!   lost — acceptable, because GC falls back to file mtime for rows it cannot
//!   find. A rare double message under a race is harmless: the writer's
//!   `INSERT ... ON CONFLICT` upsert is idempotent.
//! - Backpressure: the channel is bounded (`CHANNEL_CAP`). A send that cannot
//!   place its message within `SEND_TIMEOUT` drops the record and counts it in
//!   `DROPPED`, which [`dropped`] reports so a run can show how much cache-usage
//!   signal it lost. A full queue never stalls a build for more than that
//!   timeout and never fails it.
//! - Batching: the writer drains up to `DRAIN_CAP` queued messages, groups them
//!   by cache root, and applies each group in one transaction.
//! - WAL checkpoint: after a committed batch, if `CHECKPOINT_TXNS` transactions
//!   have run since the last checkpoint or `CHECKPOINT_INTERVAL` has passed, the
//!   writer runs `PRAGMA wal_checkpoint(TRUNCATE)` on every open connection.
//! - Shutdown: [`flush_and_join`] tells the writer to drain its queue, commit,
//!   checkpoint, and stop. A graceful `imp` process exit must call it so no
//!   record is lost.
//!
//! # GC notes for whoever builds on this
//!
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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{Receiver, Sender};
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

// ---------------------------------------------------------------------------
// Hot-path state: in-process dedup only, no database handle.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct HotRoot {
    /// Entries already recorded by this process, mapped to whether that
    /// recording carried a size. Timestamps are per-second, so re-recording
    /// within one run buys nothing; skipping keeps bulk paths (tree
    /// materialization) at one message per unique blob. A sized recording is
    /// still allowed through after an unsized one, so a get followed by a
    /// set upgrades the row.
    seen: HashMap<(UsageKind, String), bool>,
    /// Workspace ids and `(workspace_id, name)` declarations already recorded
    /// by this process; like `seen`, re-recording within one run buys nothing.
    seen_workspaces: HashSet<String>,
    seen_declarations: HashSet<(String, String)>,
}

/// One hot state per cache root — tests use per-test roots within a single
/// process, so shared dedup sets would suppress a sibling test's writes.
static STATE: Mutex<Option<HashMap<PathBuf, HotRoot>>> = Mutex::new(None);

/// Run `f` against the hot state for `root`; `None` if the state lock is
/// poisoned. Never opens a database — that is the writer thread's job.
fn with_hot<R>(root: &Path, f: impl FnOnce(&mut HotRoot) -> R) -> Option<R> {
    let mut guard = STATE.lock().ok()?;
    let hot = guard
        .get_or_insert_with(HashMap::new)
        .entry(root.to_path_buf())
        .or_default();
    Some(f(hot))
}

// ---------------------------------------------------------------------------
// Background writer: the only thread that touches usage.db.
// ---------------------------------------------------------------------------

/// Channel capacity between the hot path and the writer.
const CHANNEL_CAP: usize = 4096;
/// Longest a `record_*` call waits to enqueue before it drops the record.
const SEND_TIMEOUT: Duration = Duration::from_millis(50);
/// Most messages the writer folds into one batch before it commits.
const DRAIN_CAP: usize = 1024;
/// Committed transactions between WAL checkpoints.
const CHECKPOINT_TXNS: u32 = 128;
/// Longest the writer waits between WAL checkpoints.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(60);

/// A database write, deferred to the writer thread. `at` is the Unix time the
/// hot path saw the event, sampled there so a backed-up writer does not drift
/// the "used just now" timestamp.
enum Msg {
    Record {
        root: PathBuf,
        at: i64,
        op: Op,
    },
    /// Ack when every earlier message has been committed. See [`flush`].
    Flush(Sender<()>),
    /// Drain, commit, checkpoint, ack, then stop.
    Shutdown(Sender<()>),
}

enum Op {
    Usage {
        kind: UsageKind,
        id: String,
        size: Option<u64>,
    },
    Workspace {
        id: String,
        path: String,
    },
    Declared {
        workspace_id: String,
        name: String,
        shared: bool,
    },
}

struct Writer {
    tx: Sender<Msg>,
    join: Mutex<Option<JoinHandle<()>>>,
}

static WRITER: OnceLock<Writer> = OnceLock::new();
/// Records dropped because the queue stayed full for `SEND_TIMEOUT`.
static DROPPED: AtomicU64 = AtomicU64::new(0);

fn writer() -> &'static Writer {
    WRITER.get_or_init(|| {
        let (tx, rx) = crossbeam_channel::bounded::<Msg>(CHANNEL_CAP);
        let join = std::thread::Builder::new()
            .name("imp-usage-db".to_owned())
            .spawn(move || writer_loop(rx))
            .ok();
        Writer {
            tx,
            join: Mutex::new(join),
        }
    })
}

/// Hand a deferred write to the writer. Drops the record (and counts it) if the
/// queue stays full for `SEND_TIMEOUT` — best-effort, never blocks a build.
fn dispatch(msg: Msg) {
    if writer().tx.send_timeout(msg, SEND_TIMEOUT).is_err() {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

fn writer_loop(rx: Receiver<Msg>) {
    let mut conns: HashMap<PathBuf, Option<Connection>> = HashMap::new();
    let mut txns_since_checkpoint: u32 = 0;
    let mut last_checkpoint = Instant::now();

    while let Ok(first) = rx.recv() {
        let mut msgs = vec![first];
        while msgs.len() < DRAIN_CAP {
            match rx.try_recv() {
                Ok(msg) => msgs.push(msg),
                Err(_) => break,
            }
        }

        let mut records: Vec<(PathBuf, i64, Op)> = Vec::new();
        let mut flush_acks: Vec<Sender<()>> = Vec::new();
        let mut shutdown_ack: Option<Sender<()>> = None;
        for msg in msgs {
            match msg {
                Msg::Record { root, at, op } => records.push((root, at, op)),
                Msg::Flush(ack) => flush_acks.push(ack),
                Msg::Shutdown(ack) => shutdown_ack = Some(ack),
            }
        }

        apply_batch(&mut conns, &records, &mut txns_since_checkpoint);

        if txns_since_checkpoint >= CHECKPOINT_TXNS
            || last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL
        {
            checkpoint_all(&conns);
            txns_since_checkpoint = 0;
            last_checkpoint = Instant::now();
        }

        for ack in flush_acks {
            let _ = ack.send(());
        }

        if let Some(ack) = shutdown_ack {
            // Senders can still be live during a slow exit; take one more pass.
            let mut tail: Vec<(PathBuf, i64, Op)> = Vec::new();
            while let Ok(msg) = rx.try_recv() {
                match msg {
                    Msg::Record { root, at, op } => tail.push((root, at, op)),
                    Msg::Flush(a) | Msg::Shutdown(a) => {
                        let _ = a.send(());
                    }
                }
            }
            apply_batch(&mut conns, &tail, &mut txns_since_checkpoint);
            checkpoint_all(&conns);
            let _ = ack.send(());
            return;
        }
    }
}

/// Apply every record in `records`, grouped by cache root, one transaction per
/// root. Every error is swallowed per the best-effort contract.
fn apply_batch(
    conns: &mut HashMap<PathBuf, Option<Connection>>,
    records: &[(PathBuf, i64, Op)],
    txns_since_checkpoint: &mut u32,
) {
    if records.is_empty() {
        return;
    }

    let mut by_root: HashMap<&Path, Vec<&(PathBuf, i64, Op)>> = HashMap::new();
    for rec in records {
        by_root.entry(rec.0.as_path()).or_default().push(rec);
    }

    for (root, group) in by_root {
        let entry = conns
            .entry(root.to_path_buf())
            .or_insert_with(|| open_db(root));
        let Some(conn) = entry.as_mut() else {
            continue;
        };
        let Ok(tx) = conn.transaction() else {
            continue;
        };
        for (_, at, op) in group {
            let _ = apply_op(&tx, *at, op);
        }
        if tx.commit().is_ok() {
            *txns_since_checkpoint = txns_since_checkpoint.saturating_add(1);
        }
    }
}

fn apply_op(conn: &Connection, at: i64, op: &Op) -> rusqlite::Result<usize> {
    match op {
        Op::Usage { kind, id, size } => conn.execute(
            "INSERT INTO usage (kind, id, created_at, last_used_at, size_bytes)
             VALUES (?1, ?2, ?3, ?3, ?4)
             ON CONFLICT(kind, id) DO UPDATE SET
                 last_used_at = excluded.last_used_at,
                 size_bytes = COALESCE(excluded.size_bytes, size_bytes)",
            rusqlite::params![kind.as_str(), id, at, size],
        ),
        Op::Workspace { id, path } => conn.execute(
            "INSERT INTO workspaces (id, path, last_seen_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                 path = excluded.path,
                 last_seen_at = excluded.last_seen_at",
            rusqlite::params![id, path, at],
        ),
        Op::Declared {
            workspace_id,
            name,
            shared,
        } => conn.execute(
            "INSERT INTO declared_caches (workspace_id, name, shared, last_declared_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(workspace_id, name) DO UPDATE SET
                 shared = excluded.shared,
                 last_declared_at = excluded.last_declared_at",
            rusqlite::params![workspace_id, name, shared, at],
        ),
    }
}

fn checkpoint_all(conns: &HashMap<PathBuf, Option<Connection>>) {
    for conn in conns.values().flatten() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
}

/// Block until the background writer has committed every record queued so far,
/// then return; the writer keeps running. The channel is FIFO, so the ack for
/// this call means all earlier records are on disk. Use it before a same-process
/// read of `usage.db` (a test, or `cache gc` / `cache stats` after a build).
/// A no-op if nothing was ever recorded.
pub fn flush() {
    let Some(w) = WRITER.get() else {
        return;
    };
    let (ack_tx, ack_rx) = crossbeam_channel::bounded(1);
    if w.tx.send(Msg::Flush(ack_tx)).is_ok() {
        let _ = ack_rx.recv_timeout(Duration::from_secs(5));
    }
}

/// Flush every queued usage record and stop the writer. Call once on a graceful
/// process exit. A no-op if nothing was ever recorded.
pub fn flush_and_join() {
    let Some(w) = WRITER.get() else {
        return;
    };
    let (ack_tx, ack_rx) = crossbeam_channel::bounded(1);
    if w.tx
        .send_timeout(Msg::Shutdown(ack_tx), Duration::from_secs(5))
        .is_ok()
    {
        // Bounded so a wedged writer can never hang the exit.
        let _ = ack_rx.recv_timeout(Duration::from_secs(5));
    }
    if let Ok(mut guard) = w.join.lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.join();
        }
    }
}

/// The number of cache-usage records this process dropped because the hot-path
/// channel stayed full for `SEND_TIMEOUT`. Best-effort: a dropped record is
/// lost signal only, and GC falls back to file mtime for a row it cannot find.
/// The count is "drops up to the read"; a `record_*` call after this read (for
/// example during post-build sandbox cleanup) is not included.
pub fn dropped() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Public recording API. Signatures are stable; each call is cheap.
// ---------------------------------------------------------------------------

/// Record a named-cache slot use under its canonical id, `<scope>/<name>/<key>`.
pub fn record_named_use(scope_id: &str, name: &str, key: &str) {
    record_use(UsageKind::Named, &format!("{scope_id}/{name}/{key}"));
}

/// Record a named-cache slot being set, sizing the row from the slot
/// directory. Walks the directory — only call on set, not on every get.
pub fn record_named_set(scope_id: &str, name: &str, key: &str, slot: &Path) {
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
    let Ok(root) = crate::cache::cache_root() else {
        return;
    };
    if !needs_sized_recording_at(&root, UsageKind::Cas, digest) {
        return;
    }
    let size = crate::cache::cas_blob_path(digest)
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    record_use_at(&root, UsageKind::Cas, digest, size);
}

/// True when `kind`/`id` still needs a recording that includes its size.
///
/// CAS reads use this before they stat the blob. A first unsized recording
/// must still be upgraded, but a sized recording is final for this process.
/// With an unusable `usage.db` this stays true, so each unique blob takes one
/// stat whose write is then dropped — a small, bounded cost on a broken root.
fn needs_sized_recording_at(root: &Path, kind: UsageKind, id: &str) -> bool {
    with_hot(root, |hot| {
        !matches!(hot.seen.get(&(kind, id.to_owned())), Some(true))
    })
    .unwrap_or(false)
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
pub fn record_workspace(workspace_id: &str, path: &Path) {
    let Ok(root) = crate::cache::cache_root() else {
        return;
    };
    record_workspace_at(&root, workspace_id, path);
}

fn record_workspace_at(root: &Path, workspace_id: &str, path: &Path) {
    let at = now_unix();
    let send = with_hot(root, |hot| {
        if hot.seen_workspaces.contains(workspace_id) {
            return false;
        }
        hot.seen_workspaces.insert(workspace_id.to_owned());
        true
    })
    .unwrap_or(false);
    if send {
        dispatch(Msg::Record {
            root: root.to_path_buf(),
            at,
            op: Op::Workspace {
                id: workspace_id.to_owned(),
                path: path.to_string_lossy().into_owned(),
            },
        });
    }
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

fn record_declared_cache_at(root: &Path, workspace_id: &str, name: &str, shared: bool) {
    let at = now_unix();
    let seen_key = (workspace_id.to_owned(), name.to_owned());
    let send = with_hot(root, |hot| {
        if hot.seen_declarations.contains(&seen_key) {
            return false;
        }
        hot.seen_declarations.insert(seen_key.clone());
        true
    })
    .unwrap_or(false);
    if send {
        dispatch(Msg::Record {
            root: root.to_path_buf(),
            at,
            op: Op::Declared {
                workspace_id: workspace_id.to_owned(),
                name: name.to_owned(),
                shared,
            },
        });
    }
}

fn record_use_at(root: &Path, kind: UsageKind, id: &str, size_bytes: Option<u64>) {
    let at = now_unix();
    let send = with_hot(root, |hot| {
        let seen_key = (kind, id.to_owned());
        if let Some(&sized) = hot.seen.get(&seen_key) {
            if sized || size_bytes.is_none() {
                return false;
            }
        }
        hot.seen.insert(seen_key, size_bytes.is_some());
        true
    })
    .unwrap_or(false);
    if send {
        dispatch(Msg::Record {
            root: root.to_path_buf(),
            at,
            op: Op::Usage {
                kind,
                id: id.to_owned(),
                size: size_bytes,
            },
        });
    }
}

/// Total byte size of a directory tree (or a single file), best-effort:
/// unreadable entries just don't count, a missing path is `None`.
pub fn dir_size_bytes(path: &Path) -> Option<u64> {
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

fn open_db(root: &Path) -> Option<Connection> {
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

    use super::flush as flush_for_test;

    fn query_row(root: &Path, kind: &str, id: &str) -> (i64, i64, Option<u64>) {
        let conn = Connection::open(root.join("usage.db")).unwrap();
        conn.query_row(
            "SELECT created_at, last_used_at, size_bytes FROM usage WHERE kind = ?1 AND id = ?2",
            rusqlite::params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    fn forget(root: &Path) {
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
        flush_for_test();
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
        flush_for_test();
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
        flush_for_test();
        let (_, _, size) = query_row(cache.path(), "named", "size-test");
        assert_eq!(size, None);
        record_use_at(cache.path(), UsageKind::Named, "size-test", Some(42));
        flush_for_test();
        let (_, _, size) = query_row(cache.path(), "named", "size-test");
        assert_eq!(size, Some(42));

        // A later unsized use (e.g. from another process) bumps the timestamp
        // but must not clear the size.
        forget(cache.path());
        record_use_at(cache.path(), UsageKind::Named, "size-test", None);
        flush_for_test();
        let (_, _, size) = query_row(cache.path(), "named", "size-test");
        assert_eq!(size, Some(42));
    }

    #[test]
    fn sized_recordings_do_not_need_a_second_cas_stat() {
        let cache = tempfile::tempdir().unwrap();
        let digest = "cas-read-test-digest";

        assert!(needs_sized_recording_at(
            cache.path(),
            UsageKind::Cas,
            digest
        ));
        record_use_at(cache.path(), UsageKind::Cas, digest, Some(7));
        flush_for_test();
        assert!(!needs_sized_recording_at(
            cache.path(),
            UsageKind::Cas,
            digest
        ));
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
        flush_for_test();
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

    fn forget_side_tables(root: &Path) {
        with_hot(root, |hot| {
            hot.seen_workspaces.clear();
            hot.seen_declarations.clear();
        });
    }

    #[test]
    fn workspaces_and_declarations_upsert() {
        let cache = tempfile::tempdir().unwrap();

        record_workspace_at(cache.path(), "w1", Path::new("/tmp/a"));
        forget_side_tables(cache.path());
        record_workspace_at(cache.path(), "w1", Path::new("/tmp/b"));
        flush_for_test();

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
        flush_for_test();

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
        flush_for_test();
    }
}
