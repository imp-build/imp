//! `cache gc`: age-based (LRU) garbage collection over the cache root, pure
//! Rust over the filesystem plus `usage.db` — no workspace JS is evaluated.
//! Declarations and workspace paths reach us through the side tables that
//! normal runs maintain (see `crate::usage`).
//!
//! Two phases: [`plan`] is read-only and produces a [`GcPlan`] listing every
//! deletion candidate with its age and size (dry-run just prints it);
//! [`GcPlan::execute`] performs the deletions and cleans the matching
//! usage.db rows. Candidates are sorted oldest-first so a future size-budget
//! pass can keep trimming down the same lists until under a target.
//!
//! Ordering matters: task records decide first, then live records *mark* the
//! CAS blobs they can reach (outputs, tree nodes, output tree), and only
//! unmarked blobs past the cutoff are swept. The cutoff doubles as the grace
//! window: anything used (or created) more recently than `max_age` is never
//! touched, which keeps concurrent builds safe without a lock. The residual
//! race — a build re-using a blob that aged past the cutoff at the exact
//! moment gc deletes it — fails that one task, which then re-executes and
//! re-stores. A daemon-coordinated lock is future work.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::Connection;

use crate::cache::TaskCacheRecord;

/// One thing gc wants to delete.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// usage.db id where one exists (blob digest, task key,
    /// `<scope>/<name>/<key>`), otherwise a human-readable label.
    pub id: String,
    /// Absolute path to delete (file or directory).
    pub path: PathBuf,
    pub last_used_at: i64,
    pub size_bytes: u64,
}

#[derive(Debug, Default)]
pub struct GcPlan {
    root: PathBuf,
    cutoff: i64,
    /// Expired task records (`tasks/<key>.json`).
    pub task_records: Vec<Candidate>,
    /// Unmarked, expired CAS blobs. Deleting a blob also deletes its
    /// `cas/meta/<digest>.json` sidecar.
    pub cas_blobs: Vec<Candidate>,
    /// Whole `named/<scope>` namespaces whose recorded checkout path no
    /// longer exists.
    pub orphaned_scopes: Vec<Candidate>,
    /// Whole `named/<scope>/<name>` dirs whose `namedCache()` declaration has
    /// aged out of `declared_caches` (or never appeared there).
    pub undeclared_names: Vec<Candidate>,
    /// Individual expired `named/<scope>/<name>/<key>` slots.
    pub named_slots: Vec<Candidate>,
    /// Known-legacy directories deleted outright (currently `cas/trees`).
    pub legacy: Vec<Candidate>,
    /// Already-empty scope/name container dirs under `named/` (left behind
    /// by an interrupted gc or pre-gc deletions). Containers emptied *by*
    /// this run are swept during execute instead.
    pub empty_dirs: Vec<Candidate>,
    /// Blobs kept because a live task record reaches them.
    pub marked_blobs: usize,
}

impl GcPlan {
    pub fn categories(&self) -> [(&'static str, &[Candidate]); 7] {
        [
            ("task records", self.task_records.as_slice()),
            ("cas blobs", self.cas_blobs.as_slice()),
            ("orphaned workspace scopes", self.orphaned_scopes.as_slice()),
            ("undeclared named caches", self.undeclared_names.as_slice()),
            ("stale named-cache slots", self.named_slots.as_slice()),
            ("legacy dirs", self.legacy.as_slice()),
            ("empty dirs", self.empty_dirs.as_slice()),
        ]
    }

    pub fn total_bytes(&self) -> u64 {
        self.categories()
            .iter()
            .flat_map(|(_, c)| c.iter())
            .map(|c| c.size_bytes)
            .sum()
    }

    pub fn is_empty(&self) -> bool {
        self.categories().iter().all(|(_, c)| c.is_empty())
    }

    /// Delete everything the plan lists and clean up the matching usage.db
    /// rows. Deletion failures are collected, not fatal — a half-executed gc
    /// leaves the cache functional (at worst a record whose blob went missing
    /// re-executes), and the next run retries.
    pub fn execute(&self) -> GcOutcome {
        let mut outcome = GcOutcome::default();
        let mut delete = |candidate: &Candidate| {
            let result = if candidate.path.is_dir() {
                std::fs::remove_dir_all(&candidate.path)
            } else {
                match std::fs::remove_file(&candidate.path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    other => other,
                }
            };
            match result {
                Ok(()) => {
                    outcome.deleted += 1;
                    outcome.freed_bytes += candidate.size_bytes;
                    true
                }
                Err(e) => {
                    outcome
                        .errors
                        .push(format!("{}: {e}", candidate.path.display()));
                    false
                }
            }
        };

        for candidate in &self.task_records {
            delete(candidate);
        }
        for candidate in &self.cas_blobs {
            if delete(candidate) {
                let meta = self
                    .root
                    .join("cas")
                    .join("meta")
                    .join(format!("{}.json", candidate.id));
                let _ = std::fs::remove_file(meta);
            }
        }
        for candidate in self
            .orphaned_scopes
            .iter()
            .chain(&self.undeclared_names)
            .chain(&self.named_slots)
            .chain(&self.legacy)
            .chain(&self.empty_dirs)
        {
            delete(candidate);
        }
        // Nested slot keys (e.g. `1.93.0/linux-x86_64`) can leave empty
        // parent dirs behind. Only ascend from what we deleted — an empty
        // dir at key depth elsewhere may be a legitimate (if odd) slot.
        let named = self.root.join("named");
        for candidate in &self.named_slots {
            remove_empty_ancestors(&candidate.path, &named);
        }
        // Scope and name dirs, by contrast, are pure containers — slots only
        // exist at key depth — so empty ones are always safe to drop, however
        // they got that way (e.g. every name inside was undeclared).
        remove_empty_containers(&named);

        self.clean_database(&mut outcome);
        outcome
    }

    /// Remove usage.db rows for deleted entries, plus rows whose on-disk
    /// entry is already gone (pre-gc deletions, older schema turnover).
    /// Best-effort: the db is an eviction signal, not a source of truth.
    fn clean_database(&self, outcome: &mut GcOutcome) {
        let db = self.root.join("usage.db");
        let Ok(conn) = Connection::open(&db) else {
            return;
        };
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

        for candidate in &self.task_records {
            let _ = conn.execute(
                "DELETE FROM usage WHERE kind = 'task' AND id = ?1",
                [&candidate.id],
            );
        }
        for candidate in &self.cas_blobs {
            let _ = conn.execute(
                "DELETE FROM usage WHERE kind = 'cas' AND id = ?1",
                [&candidate.id],
            );
        }
        for candidate in &self.named_slots {
            let _ = conn.execute(
                "DELETE FROM usage WHERE kind = 'named' AND id = ?1",
                [&candidate.id],
            );
        }
        // Scope/name prefixes: `id` is `<scope>/<name>/<key>`, so a prefixed
        // LIKE clears every slot row underneath in one statement.
        for candidate in self.orphaned_scopes.iter().chain(&self.undeclared_names) {
            let _ = conn.execute(
                "DELETE FROM usage WHERE kind = 'named' AND id LIKE ?1 || '/%'",
                [&candidate.id],
            );
        }
        for candidate in &self.orphaned_scopes {
            let _ = conn.execute("DELETE FROM workspaces WHERE id = ?1", [&candidate.id]);
            let _ = conn.execute(
                "DELETE FROM declared_caches WHERE workspace_id = ?1",
                [&candidate.id],
            );
        }
        let _ = conn.execute(
            "DELETE FROM declared_caches WHERE last_declared_at < ?1",
            [self.cutoff],
        );

        // Rows whose entry vanished outside gc.
        let mut stale = 0usize;
        if let Ok(mut statement) = conn.prepare("SELECT kind, id FROM usage") {
            let rows: Vec<(String, String)> = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();
            for (kind, id) in rows {
                let path = match kind.as_str() {
                    "cas" => self.root.join("cas").join("blobs").join(&id),
                    "task" => self.root.join("tasks").join(format!("{id}.json")),
                    "named" => self.root.join("named").join(&id),
                    _ => continue,
                };
                if !path.exists() {
                    let _ = conn.execute(
                        "DELETE FROM usage WHERE kind = ?1 AND id = ?2",
                        rusqlite::params![kind, id],
                    );
                    stale += 1;
                }
            }
        }
        outcome.stale_rows_removed = stale;
    }
}

#[derive(Debug, Default)]
pub struct GcOutcome {
    pub deleted: usize,
    pub freed_bytes: u64,
    pub stale_rows_removed: usize,
    pub errors: Vec<String>,
}

/// Build a gc plan for the active cache root.
pub fn plan(max_age: std::time::Duration) -> Result<GcPlan> {
    let root = crate::cache::cache_root()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    plan_at(&root, now - max_age.as_secs() as i64)
}

fn plan_at(root: &Path, cutoff: i64) -> Result<GcPlan> {
    let db = Database::load(&root.join("usage.db"));

    let mut plan = GcPlan {
        root: root.to_path_buf(),
        cutoff,
        ..GcPlan::default()
    };

    let live_records = plan_task_records(root, &db, cutoff, &mut plan)?;
    let marked = mark_reachable(&live_records);
    plan.marked_blobs = marked.len();
    plan_cas(root, &db, cutoff, &marked, &mut plan)?;
    plan_named(root, &db, cutoff, &mut plan)?;

    let trees = root.join("cas").join("trees");
    if trees.is_dir() {
        plan.legacy.push(Candidate {
            id: "cas/trees (legacy)".to_owned(),
            path: trees.clone(),
            last_used_at: 0,
            size_bytes: crate::usage::dir_size_bytes(&trees).unwrap_or(0),
        });
    }

    for candidates in [
        &mut plan.task_records,
        &mut plan.cas_blobs,
        &mut plan.orphaned_scopes,
        &mut plan.undeclared_names,
        &mut plan.named_slots,
    ] {
        candidates.sort_by_key(|c| c.last_used_at);
    }
    Ok(plan)
}

/// usage.db contents, loaded once. Missing db or tables mean empty maps —
/// everything then falls back to file mtimes.
#[derive(Default)]
struct Database {
    /// `(kind, id)` → `(last_used_at, size_bytes)`.
    usage: HashMap<(String, String), (i64, Option<u64>)>,
    /// workspace id → recorded checkout path.
    workspaces: HashMap<String, String>,
    /// `(workspace_id, name)` → `(shared, last_declared_at)`.
    declared: HashMap<(String, String), (bool, i64)>,
}

impl Database {
    fn load(path: &Path) -> Database {
        let mut db = Database::default();
        let Ok(conn) = Connection::open(path) else {
            return db;
        };
        if let Ok(mut statement) =
            conn.prepare("SELECT kind, id, last_used_at, size_bytes FROM usage")
        {
            if let Ok(rows) = statement.query_map([], |row| {
                Ok((
                    (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                    (row.get::<_, i64>(2)?, row.get::<_, Option<u64>>(3)?),
                ))
            }) {
                db.usage = rows.flatten().collect();
            }
        }
        if let Ok(mut statement) = conn.prepare("SELECT id, path FROM workspaces") {
            if let Ok(rows) = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) {
                db.workspaces = rows.flatten().collect();
            }
        }
        if let Ok(mut statement) =
            conn.prepare("SELECT workspace_id, name, shared, last_declared_at FROM declared_caches")
        {
            if let Ok(rows) = statement.query_map([], |row| {
                Ok((
                    (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                    (row.get::<_, bool>(2)?, row.get::<_, i64>(3)?),
                ))
            }) {
                db.declared = rows.flatten().collect();
            }
        }
        db
    }

    fn last_used(&self, kind: &str, id: &str, fallback_mtime_of: &Path) -> i64 {
        self.usage
            .get(&(kind.to_owned(), id.to_owned()))
            .map(|&(last_used, _)| last_used)
            .unwrap_or_else(|| mtime_unix(fallback_mtime_of))
    }

    fn size(&self, kind: &str, id: &str) -> Option<u64> {
        self.usage
            .get(&(kind.to_owned(), id.to_owned()))
            .and_then(|&(_, size)| size)
    }

    /// Is `name` a freshly-declared cache for `scope` ("shared" or a
    /// workspace id)? With an entirely empty declared_caches table (feature
    /// just landed, nothing has run yet) every name passes — pruning by
    /// declaration only kicks in once declarations exist to compare against.
    fn is_declared(&self, scope: &str, name: &str, cutoff: i64) -> bool {
        if self.declared.is_empty() {
            return true;
        }
        self.declared.iter().any(|((ws, n), &(shared, declared))| {
            n == name
                && declared >= cutoff
                && if scope == "shared" {
                    shared
                } else {
                    !shared && ws == scope
                }
        })
    }
}

/// Expire old task records into `plan.task_records`; parse and return the
/// surviving ones for the mark phase. Unparsable records are treated as
/// expired garbage regardless of age.
fn plan_task_records(
    root: &Path,
    db: &Database,
    cutoff: i64,
    plan: &mut GcPlan,
) -> Result<Vec<TaskCacheRecord>> {
    let tasks = root.join("tasks");
    let mut live = Vec::new();
    let Ok(entries) = std::fs::read_dir(&tasks) else {
        return Ok(live);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(key) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".json"))
            .map(str::to_owned)
        else {
            continue;
        };
        let last_used = db.last_used("task", &key, &path);
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<TaskCacheRecord>(&s).ok());
        match parsed {
            Some(record) if last_used >= cutoff => live.push(record),
            _ => plan.task_records.push(Candidate {
                id: key.clone(),
                path: path.clone(),
                last_used_at: last_used,
                size_bytes: db
                    .size("task", &key)
                    .or_else(|| entry.metadata().ok().map(|m| m.len()))
                    .unwrap_or(0),
            }),
        }
    }
    Ok(live)
}

/// Every CAS digest a set of live records can reach: output blobs, directory
/// tree nodes and their files, and the record's merged output tree. Input
/// trees are deliberately not marked — they are recomputed and re-stored on
/// every run, so keeping them buys nothing.
fn mark_reachable(records: &[TaskCacheRecord]) -> HashSet<String> {
    let mut marked = HashSet::new();
    let mark_tree = |digest: &str, marked: &mut HashSet<String>| {
        if !digest.is_empty() && !marked.contains(digest) {
            crate::digest::tree_reachable_digests(digest, &mut |d| {
                marked.insert(d.to_owned());
            });
        }
    };
    for record in records {
        mark_tree(&record.output_digest, &mut marked);
        for output in &record.outputs {
            if !output.digest.is_empty() {
                marked.insert(output.digest.clone());
            }
            if let Some(tree) = &output.tree_digest {
                mark_tree(tree, &mut marked);
            }
        }
    }
    marked
}

fn plan_cas(
    root: &Path,
    db: &Database,
    cutoff: i64,
    marked: &HashSet<String>,
    plan: &mut GcPlan,
) -> Result<()> {
    let blobs = root.join("cas").join("blobs");
    let Ok(entries) = std::fs::read_dir(&blobs) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if marked.contains(&name) {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let last_used = db.last_used("cas", &name, &path);
        if last_used < cutoff {
            plan.cas_blobs.push(Candidate {
                size_bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
                id: name,
                path,
                last_used_at: last_used,
            });
        }
    }
    Ok(())
}

fn plan_named(root: &Path, db: &Database, cutoff: i64, plan: &mut GcPlan) -> Result<()> {
    let named = root.join("named");
    let Ok(scopes) = std::fs::read_dir(&named) else {
        return Ok(());
    };
    for scope_entry in scopes.flatten() {
        let Ok(scope) = scope_entry.file_name().into_string() else {
            continue;
        };
        let scope_path = scope_entry.path();
        if !scope_path.is_dir() {
            continue;
        }

        // A workspace scope whose recorded checkout vanished is dead
        // wholesale — every slot in it belonged to that checkout.
        if scope != "shared" {
            if let Some(workspace_path) = db.workspaces.get(&scope) {
                if !Path::new(workspace_path).exists() {
                    plan.orphaned_scopes.push(Candidate {
                        id: scope,
                        last_used_at: 0,
                        size_bytes: crate::usage::dir_size_bytes(&scope_path).unwrap_or(0),
                        path: scope_path,
                    });
                    continue;
                }
            }
        }

        let Ok(names) = std::fs::read_dir(&scope_path) else {
            continue;
        };
        let names: Vec<_> = names.flatten().collect();
        if names.is_empty() {
            plan.empty_dirs.push(Candidate {
                id: scope.clone(),
                path: scope_path,
                last_used_at: 0,
                size_bytes: 0,
            });
            continue;
        }
        for name_entry in names {
            let Ok(name) = name_entry.file_name().into_string() else {
                continue;
            };
            let name_path = name_entry.path();
            if !name_path.is_dir() {
                continue;
            }
            if std::fs::read_dir(&name_path)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
            {
                plan.empty_dirs.push(Candidate {
                    id: format!("{scope}/{name}"),
                    path: name_path,
                    last_used_at: 0,
                    size_bytes: 0,
                });
                continue;
            }
            if !db.is_declared(&scope, &name, cutoff) {
                plan.undeclared_names.push(Candidate {
                    id: format!("{scope}/{name}"),
                    last_used_at: db
                        .declared
                        .get(&(scope.clone(), name.clone()))
                        .map(|&(_, at)| at)
                        .unwrap_or(0),
                    size_bytes: db
                        .size("named", &format!("{scope}/{name}"))
                        .or_else(|| crate::usage::dir_size_bytes(&name_path))
                        .unwrap_or(0),
                    path: name_path,
                });
                continue;
            }
            plan_slots(db, cutoff, &scope, &name, &name_path, plan);
        }
    }
    Ok(())
}

/// Expire individual slots under `named/<scope>/<name>`. Keys can be nested
/// (`1.93.0/linux-x86_64`), so the unit of deletion is the key path a usage
/// row records; directories no row covers fall back to their newest mtime,
/// pruned at the first uncovered level.
fn plan_slots(
    db: &Database,
    cutoff: i64,
    scope: &str,
    name: &str,
    name_path: &Path,
    plan: &mut GcPlan,
) {
    let prefix = format!("{scope}/{name}/");
    let known: Vec<(&str, i64, Option<u64>)> = db
        .usage
        .iter()
        .filter(|((kind, id), _)| kind == "named" && id.starts_with(&prefix))
        .map(|((_, id), &(last_used, size))| (id[prefix.len()..].as_ref(), last_used, size))
        .collect();

    for &(key, last_used, size) in &known {
        let slot = name_path.join(key);
        if !slot.exists() {
            continue;
        }
        if last_used < cutoff {
            plan.named_slots.push(Candidate {
                id: format!("{prefix}{key}"),
                last_used_at: last_used,
                size_bytes: size
                    .or_else(|| crate::usage::dir_size_bytes(&slot))
                    .unwrap_or(0),
                path: slot,
            });
        }
    }

    // Directories not on any known key's path: age by newest mtime anywhere
    // inside (a slot is only as old as its most recently touched file).
    let Ok(children) = std::fs::read_dir(name_path) else {
        return;
    };
    for child in children.flatten() {
        let Ok(child_name) = child.file_name().into_string() else {
            continue;
        };
        let covered = known
            .iter()
            .any(|(key, ..)| *key == child_name || key.starts_with(&format!("{child_name}/")));
        if covered {
            continue;
        }
        let path = child.path();
        let last_used = newest_mtime(&path);
        if last_used < cutoff {
            plan.named_slots.push(Candidate {
                id: format!("{prefix}{child_name}"),
                last_used_at: last_used,
                size_bytes: crate::usage::dir_size_bytes(&path).unwrap_or(0),
                path,
            });
        }
    }
}

fn mtime_unix(path: &Path) -> i64 {
    std::fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Newest mtime of anything under `path` (including itself).
fn newest_mtime(path: &Path) -> i64 {
    let mut newest = mtime_unix(path);
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            newest = newest.max(if child.is_dir() {
                newest_mtime(&child)
            } else {
                mtime_unix(&child)
            });
        }
    }
    newest
}

/// Remove empty scope (`named/<scope>`) and name (`named/<scope>/<name>`)
/// dirs. Only these two container levels — anything deeper could be a slot.
fn remove_empty_containers(named: &Path) {
    let Ok(scopes) = std::fs::read_dir(named) else {
        return;
    };
    for scope in scopes.flatten() {
        let scope_path = scope.path();
        if !scope_path.is_dir() {
            continue;
        }
        if let Ok(names) = std::fs::read_dir(&scope_path) {
            for name in names.flatten() {
                let name_path = name.path();
                if name_path.is_dir() {
                    let _ = std::fs::remove_dir(&name_path);
                }
            }
        }
        let _ = std::fs::remove_dir(&scope_path);
    }
}

/// Walk up from `deleted`'s parent towards `stop` (exclusive), removing each
/// directory that became empty. `remove_dir` refuses non-empty dirs, which is
/// exactly the stopping condition.
fn remove_empty_ancestors(deleted: &Path, stop: &Path) {
    let mut current = deleted.parent();
    while let Some(dir) = current {
        if dir == stop || !dir.starts_with(stop) || std::fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::digest_bytes;

    /// A miniature cache root with a usage.db. Rows are inserted backdated
    /// or fresh relative to a fixed `NOW`; the cutoff sits between OLD and
    /// FRESH.
    const NOW: i64 = 1_000_000;
    const CUTOFF: i64 = 900_000;
    const OLD: i64 = 100_000;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        conn: Connection,
    }

    impl Fixture {
        fn new() -> Fixture {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().to_path_buf();
            for sub in ["cas/blobs", "cas/meta", "tasks", "named"] {
                std::fs::create_dir_all(root.join(sub)).unwrap();
            }
            let conn = Connection::open(root.join("usage.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE usage (kind TEXT NOT NULL, id TEXT NOT NULL,
                     created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
                     size_bytes INTEGER, PRIMARY KEY (kind, id));
                 CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL,
                     last_seen_at INTEGER NOT NULL);
                 CREATE TABLE declared_caches (workspace_id TEXT NOT NULL, name TEXT NOT NULL,
                     shared INTEGER NOT NULL, last_declared_at INTEGER NOT NULL,
                     PRIMARY KEY (workspace_id, name));",
            )
            .unwrap();
            Fixture {
                _dir: dir,
                root,
                conn,
            }
        }

        fn usage(&self, kind: &str, id: &str, last_used: i64) {
            self.conn
                .execute(
                    "INSERT INTO usage VALUES (?1, ?2, ?3, ?3, NULL)",
                    rusqlite::params![kind, id, last_used],
                )
                .unwrap();
        }

        fn blob(&self, contents: &[u8], last_used: i64) -> String {
            let digest = digest_bytes(contents);
            std::fs::write(self.root.join("cas/blobs").join(&digest), contents).unwrap();
            std::fs::write(
                self.root.join("cas/meta").join(format!("{digest}.json")),
                b"{}",
            )
            .unwrap();
            self.usage("cas", &digest, last_used);
            digest
        }

        fn record(&self, key: &str, output_blob: &str, last_used: i64) {
            let record = serde_json::json!({
                "version": crate::cache::TASK_CACHE_VERSION,
                "task_id": key, "task_key": key,
                "action_digest": "", "input_digest": "", "output_digest": "",
                "named_caches": [], "stdout": "", "stderr": "",
                "outputs": [{
                    "artifact_id": "out", "kind": "file", "path": "out.txt",
                    "value": null, "digest": output_blob, "bytes": 1, "mode": null,
                }],
            });
            std::fs::write(
                self.root.join("tasks").join(format!("{key}.json")),
                serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
            self.usage("task", key, last_used);
        }

        fn plan(&self) -> GcPlan {
            plan_at(&self.root, CUTOFF).unwrap()
        }
    }

    #[test]
    fn marked_blobs_survive_even_when_their_own_rows_are_old() {
        let f = Fixture::new();
        let kept = f.blob(b"kept output", OLD);
        f.record("live-task", &kept, NOW);

        let plan = f.plan();
        assert!(plan.task_records.is_empty());
        assert!(plan.cas_blobs.is_empty(), "marked blob must not be swept");
        assert_eq!(plan.marked_blobs, 1);
    }

    #[test]
    fn expired_record_and_its_unreachable_blobs_delete_together() {
        let f = Fixture::new();
        let dead = f.blob(b"dead output", OLD);
        f.record("dead-task", &dead, OLD);
        let fresh_unmarked = f.blob(b"fresh but unmarked", NOW);

        let plan = f.plan();
        assert_eq!(plan.task_records.len(), 1);
        assert_eq!(plan.cas_blobs.len(), 1);
        assert_eq!(plan.cas_blobs[0].id, dead);

        let outcome = plan.execute();
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert!(!f.root.join("cas/blobs").join(&dead).exists());
        assert!(
            !f.root
                .join("cas/meta")
                .join(format!("{dead}.json"))
                .exists(),
            "meta sidecar goes with its blob"
        );
        assert!(!f.root.join("tasks/dead-task.json").exists());
        assert!(
            f.root.join("cas/blobs").join(&fresh_unmarked).exists(),
            "recent blob survives the grace window"
        );
        let rows: i64 = f
            .conn
            .query_row("SELECT COUNT(*) FROM usage WHERE kind IN ('cas','task') AND id IN (?1, 'dead-task')",
                [&dead], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "deleted entries lose their usage rows");
    }

    #[test]
    fn orphaned_workspace_scope_deletes_wholesale() {
        let f = Fixture::new();
        let slot = f.root.join("named/deadbeef/tool-cache/v1");
        std::fs::create_dir_all(&slot).unwrap();
        std::fs::write(slot.join("bin"), b"x").unwrap();
        f.conn
            .execute(
                "INSERT INTO workspaces VALUES ('deadbeef', '/nonexistent/checkout', ?1)",
                [OLD],
            )
            .unwrap();
        f.usage("named", "deadbeef/tool-cache/v1", NOW); // recency doesn't save an orphan

        let plan = f.plan();
        assert_eq!(plan.orphaned_scopes.len(), 1);
        plan.execute();
        assert!(!f.root.join("named/deadbeef").exists());
        let rows: i64 = f
            .conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn undeclared_name_prunes_while_declared_survives() {
        let f = Fixture::new();
        for name in ["current-tools", "renamed-away"] {
            let slot = f.root.join("named/shared").join(name).join("v1");
            std::fs::create_dir_all(&slot).unwrap();
            f.usage("named", &format!("shared/{name}/v1"), NOW);
        }
        f.conn
            .execute(
                "INSERT INTO declared_caches VALUES ('w1', 'current-tools', 1, ?1)",
                [NOW],
            )
            .unwrap();

        let plan = f.plan();
        assert_eq!(plan.undeclared_names.len(), 1);
        assert_eq!(plan.undeclared_names[0].id, "shared/renamed-away");
        plan.execute();
        assert!(!f.root.join("named/shared/renamed-away").exists());
        assert!(f.root.join("named/shared/current-tools").exists());
    }

    #[test]
    fn emptied_scope_and_name_containers_are_dropped() {
        let f = Fixture::new();
        // Declarations exist (for some other cache), so name pruning is on.
        f.conn
            .execute(
                "INSERT INTO declared_caches VALUES ('w1', 'other', 1, ?1)",
                [NOW],
            )
            .unwrap();
        // A workspace scope whose only name is undeclared: pruning the name
        // must take the now-empty scope dir with it.
        std::fs::create_dir_all(f.root.join("named/somescope/junk-cache/v1")).unwrap();

        let plan = f.plan();
        assert_eq!(plan.undeclared_names.len(), 1);
        plan.execute();
        assert!(!f.root.join("named/somescope").exists());
    }

    #[test]
    fn empty_declarations_table_disables_name_pruning() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root.join("named/shared/anything/v1")).unwrap();
        f.usage("named", "shared/anything/v1", NOW);
        assert!(f.plan().undeclared_names.is_empty());
    }

    #[test]
    fn stale_slot_prunes_and_empty_parents_are_swept() {
        let f = Fixture::new();
        f.conn
            .execute(
                "INSERT INTO declared_caches VALUES ('w1', 'toolchains', 1, ?1)",
                [NOW],
            )
            .unwrap();
        // Nested keys: one stale, one fresh, sharing the version parent.
        for (key, at) in [("1.0.0/linux", OLD), ("1.0.0/windows", NOW)] {
            let slot = f.root.join("named/shared/toolchains").join(key);
            std::fs::create_dir_all(&slot).unwrap();
            f.usage("named", &format!("shared/toolchains/{key}"), at);
        }

        let plan = f.plan();
        assert_eq!(plan.named_slots.len(), 1);
        assert_eq!(plan.named_slots[0].id, "shared/toolchains/1.0.0/linux");
        plan.execute();
        assert!(!f.root.join("named/shared/toolchains/1.0.0/linux").exists());
        assert!(f
            .root
            .join("named/shared/toolchains/1.0.0/windows")
            .exists());
    }

    #[test]
    fn dry_run_deletes_nothing() {
        let f = Fixture::new();
        let dead = f.blob(b"dead", OLD);
        f.record("dead-task", &dead, OLD);

        let plan = f.plan();
        assert!(!plan.is_empty());
        assert!(plan.total_bytes() > 0);
        // No execute(): everything must still be on disk.
        assert!(f.root.join("cas/blobs").join(&dead).exists());
        assert!(f.root.join("tasks/dead-task.json").exists());
    }

    #[test]
    fn legacy_trees_dir_is_deleted() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root.join("cas/trees")).unwrap();
        std::fs::write(f.root.join("cas/trees/x"), b"old").unwrap();
        let plan = f.plan();
        assert_eq!(plan.legacy.len(), 1);
        plan.execute();
        assert!(!f.root.join("cas/trees").exists());
    }
}
