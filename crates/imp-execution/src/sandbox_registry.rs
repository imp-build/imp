//! Process-wide record of sandbox roots that this process created and has not
//! yet removed. `SandboxGuard` in `exec.rs` is the primary owner and removes
//! its own sandbox on drop; this registry is the fallback for the one path a
//! guard cannot cover — `std::process::exit`, which does not unwind, so guards
//! held by blocking workers that are still running never drop at all.
//!
//! `imp`'s `main` calls `cleanup_live_sandboxes` on its way out, on both the
//! failure and the success path. Ownership is claim-based: whichever of the
//! guard or the sweep takes the entry first removes the directory, and the other
//! does nothing. That makes a double remove impossible and keeps the "keeping
//! sandbox" message to one line per sandbox.
//!
//! Once cancellation is set, guards stop removing anything and defer to the
//! sweep. Removing a large tree takes longer than an exiting process has left,
//! and a removal cut off partway leaves a half-deleted directory that nothing
//! comes back for; the sweep is synchronous and runs to completion.
//!
//! The registry only knows about directories this process created. Nothing here
//! looks at the sandbox base directory, which also holds the `/tmp/imp/cache`
//! cache-root fallback and long-lived `/tmp/imp/workers/...` sidecar
//! directories.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use imp_exec_api::SandboxRetention;

/// Sandboxes created and not yet removed. One entry per in-flight sandboxed
/// action, so this stays short — a `Vec` scan costs less than a map here.
static LIVE: Mutex<Vec<(PathBuf, SandboxRetention)>> = Mutex::new(Vec::new());

/// Does a sandbox root survive the run? A canceled action gets no say: its
/// sandbox holds no diagnostic value, and keeping one per queued action is what
/// let `/tmp/imp` grow without bound. Only an explicit `Always` keeps those.
pub fn keep_sandbox(retention: SandboxRetention, succeeded: bool, canceled: bool) -> bool {
    match retention {
        SandboxRetention::Never => false,
        SandboxRetention::Always => true,
        SandboxRetention::OnFailure => !succeeded && !canceled,
    }
}

/// Record a sandbox root as live. Called by `SandboxGuard::new`.
pub fn register(root: &Path, retention: SandboxRetention) {
    if let Ok(mut live) = LIVE.lock() {
        live.push((root.to_path_buf(), retention));
    }
}

/// Remove a sandbox tree, retrying a bounded number of times.
///
/// A child killed by cancellation can have grandchildren that outlive it by a
/// few milliseconds — a `zig build` or `ninja` still writing into its build
/// cache. `remove_dir_all` walks the tree, so a file appearing underneath it
/// mid-walk fails the whole call with `ENOTEMPTY`. Retrying clears that; a tree
/// that stays busy is reported once rather than retried forever.
pub(crate) fn remove_sandbox_tree(root: &Path) -> std::io::Result<()> {
    const ATTEMPTS: usize = 5;
    for attempt in 1..=ATTEMPTS {
        match std::fs::remove_dir_all(root) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) if attempt < ATTEMPTS => {
                std::thread::sleep(std::time::Duration::from_millis(20 * attempt as u64));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Take ownership of `root`, returning whether this caller got it. A `false`
/// return means the final sweep already claimed it, so the caller must leave
/// the directory alone.
pub fn claim(root: &Path) -> bool {
    let Ok(mut live) = LIVE.lock() else {
        // A poisoned registry must not strand the sandbox: let the guard remove
        // it, since the sweep can no longer be relied on to.
        return true;
    };
    match live.iter().position(|(path, _)| path == root) {
        Some(index) => {
            live.remove(index);
            true
        }
        None => false,
    }
}

/// Remove every sandbox still live, honouring each one's retention policy.
/// Returns how many directories were removed. Called from `main` just before a
/// failing `std::process::exit`, after in-flight children have been killed.
pub fn cleanup_live_sandboxes(canceled: bool) -> usize {
    let entries = match LIVE.lock() {
        Ok(mut live) => std::mem::take(&mut *live),
        Err(_) => return 0,
    };
    cleanup_entries(&entries, canceled)
}

/// The decision-and-remove half of `cleanup_live_sandboxes`, separated so tests
/// can exercise it without touching the process-wide registry — draining that
/// would delete the sandboxes of tests running concurrently in the same binary.
///
/// A sandbox reaching the sweep never succeeded: its guard would have claimed it
/// first if it had.
pub(crate) fn cleanup_entries(entries: &[(PathBuf, SandboxRetention)], canceled: bool) -> usize {
    let mut removed = 0;
    for (root, retention) in entries {
        if keep_sandbox(*retention, false, canceled) {
            eprintln!("keeping sandbox {}", root.display());
            continue;
        }
        match remove_sandbox_tree(root) {
            Ok(()) => removed += 1,
            Err(error) => eprintln!("failed to remove sandbox {}: {error}", root.display()),
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::{claim, cleanup_entries, keep_sandbox, register};
    use imp_exec_api::SandboxRetention;
    use std::path::PathBuf;

    fn dirs(count: usize) -> (tempfile::TempDir, Vec<PathBuf>) {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = (0..count)
            .map(|index| {
                let path = temp.path().join(format!("sandbox-{index}"));
                std::fs::create_dir(&path).expect("create sandbox dir");
                path
            })
            .collect();
        (temp, paths)
    }

    #[test]
    fn keep_sandbox_covers_every_retention_outcome_pair() {
        use SandboxRetention::{Always, Never, OnFailure};
        // (retention, succeeded, canceled) -> keep
        let cases = [
            (Never, false, false, false),
            (Never, false, true, false),
            (Never, true, false, false),
            (Never, true, true, false),
            (Always, false, false, true),
            (Always, false, true, true),
            (Always, true, false, true),
            (Always, true, true, true),
            (OnFailure, false, false, true),
            (OnFailure, false, true, false),
            (OnFailure, true, false, false),
            (OnFailure, true, true, false),
        ];
        for (retention, succeeded, canceled, expected) in cases {
            assert_eq!(
                keep_sandbox(retention, succeeded, canceled),
                expected,
                "retention={retention:?} succeeded={succeeded} canceled={canceled}"
            );
        }
    }

    #[test]
    fn cleanup_entries_honours_retention_on_cancel() {
        let (_temp, paths) = dirs(3);
        let entries = vec![
            (paths[0].clone(), SandboxRetention::Never),
            (paths[1].clone(), SandboxRetention::OnFailure),
            (paths[2].clone(), SandboxRetention::Always),
        ];
        assert_eq!(cleanup_entries(&entries, true), 2);
        assert!(!paths[0].exists());
        assert!(!paths[1].exists());
        assert!(paths[2].exists(), "--keep-sandbox=always must survive");
    }

    #[test]
    fn cleanup_entries_keeps_on_failure_when_not_canceled() {
        let (_temp, paths) = dirs(1);
        let entries = vec![(paths[0].clone(), SandboxRetention::OnFailure)];
        assert_eq!(cleanup_entries(&entries, false), 0);
        assert!(paths[0].exists(), "a real failure stays inspectable");
    }

    #[test]
    fn claim_succeeds_once_then_reports_the_entry_gone() {
        let (_temp, paths) = dirs(1);
        register(&paths[0], SandboxRetention::Never);
        assert!(claim(&paths[0]));
        assert!(!claim(&paths[0]));
    }
}
