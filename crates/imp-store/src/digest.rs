//! Recursive, content-addressed directory trees ("digests"), modeled on Pants v2's
//! `DigestTrie`/`merge_digests`: a directory is a sorted list of named entries (files,
//! subdirectories, symlinks), each subdirectory entry pointing at its own CAS-stored
//! node by digest. Merging two digests is a structural, per-level operation that
//! short-circuits whenever two subtrees already have the same digest, rather than
//! re-walking and re-hashing every file.
//!
//! Digests remain plain hex SHA-256 strings (the existing imp convention — see
//! `cache::digest_bytes`) rather than a `{fingerprint, size}` struct: imp has no
//! remote-execution/REAPI interop requirement that would need the extra field.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::cache::{
    cas_blob_path, copy_file, create_symlink, file_mode, restore_file_mode, store_blob,
    store_file_blob,
};

// ---------------------------------------------------------------------------
// In-memory tree types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Entry {
    File(FileEntry),
    Directory(DirEntry),
    Symlink(SymlinkEntry),
}

impl Entry {
    pub fn name(&self) -> &str {
        match self {
            Entry::File(f) => &f.name,
            Entry::Directory(d) => &d.name,
            Entry::Symlink(s) => &s.name,
        }
    }

    fn to_node_entry(&self) -> DigestNodeEntry {
        match self {
            Entry::File(f) => DigestNodeEntry::File {
                name: f.name.clone(),
                digest: f.digest.clone(),
                size: f.size,
                mode: f.mode,
            },
            Entry::Directory(d) => DigestNodeEntry::Directory {
                name: d.name.clone(),
                digest: d.digest.clone(),
            },
            Entry::Symlink(s) => DigestNodeEntry::Symlink {
                name: s.name.clone(),
                target: s.target.clone(),
            },
        }
    }

    fn from_node_entry(entry: DigestNodeEntry) -> Entry {
        match entry {
            DigestNodeEntry::File {
                name,
                digest,
                size,
                mode,
            } => Entry::File(FileEntry {
                name,
                digest,
                size,
                mode,
            }),
            DigestNodeEntry::Directory { name, digest } => {
                Entry::Directory(DirEntry { name, digest })
            }
            DigestNodeEntry::Symlink { name, target } => {
                Entry::Symlink(SymlinkEntry { name, target })
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub name: String,
    pub digest: String,
    pub size: u64,
    pub mode: Option<u32>,
}

/// A subdirectory entry. `digest` identifies that child's own `DigestNode` blob in
/// CAS; the child tree is only loaded on demand (see `DigestTrie::load`), so merging
/// or walking a tree never eagerly pulls in subtrees it doesn't need to inspect.
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub digest: String,
}

#[derive(Debug, Clone)]
pub struct SymlinkEntry {
    pub name: String,
    pub target: String,
}

/// A single directory level: a sorted-by-name list of entries. Cheap to clone (an
/// `Arc` bump) since trees are shared structurally across merges.
#[derive(Debug, Clone)]
pub struct DigestTrie(Arc<[Entry]>);

impl DigestTrie {
    pub fn entries(&self) -> &[Entry] {
        &self.0
    }

    fn empty() -> DigestTrie {
        DigestTrie(Arc::from(Vec::<Entry>::new()))
    }

    fn to_node(&self) -> DigestNode {
        DigestNode {
            entries: self.0.iter().map(Entry::to_node_entry).collect(),
        }
    }

    /// Serialize this level's entry list and store it as a CAS blob (a no-op if the
    /// content already exists), returning its digest. Idempotent — safe to call
    /// repeatedly on the same tree.
    pub fn compute_and_store(&self) -> Result<String> {
        let node = self.to_node();
        let bytes = serde_json::to_vec(&node).context("serialize digest node")?;
        store_blob(&bytes, "digest-node")
    }

    /// Load a directory level from CAS by digest. Does not recurse into child
    /// directories — those are loaded lazily, only when something actually walks
    /// into them (merge, materialize, etc.).
    pub fn load(digest: &str) -> Result<DigestTrie> {
        crate::usage::record_use(crate::usage::UsageKind::Cas, digest);
        let path = cas_blob_path(digest)?;
        let bytes =
            std::fs::read(&path).with_context(|| format!("read digest node {}", path.display()))?;
        let node: DigestNode = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse digest node {}", path.display()))?;
        let entries: Vec<Entry> = node
            .entries
            .into_iter()
            .map(Entry::from_node_entry)
            .collect();
        Ok(DigestTrie(Arc::from(entries)))
    }
}

// ---------------------------------------------------------------------------
// CAS-serialized form
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DigestNode {
    entries: Vec<DigestNodeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum DigestNodeEntry {
    File {
        name: String,
        digest: String,
        size: u64,
        mode: Option<u32>,
    },
    Directory {
        name: String,
        digest: String,
    },
    Symlink {
        name: String,
        target: String,
    },
}

// ---------------------------------------------------------------------------
// DirectoryDigest — a digest plus an optionally-already-resolved tree
// ---------------------------------------------------------------------------

/// A digest for a directory tree, with its `DigestTrie` resolved lazily. Mirrors
/// Pants' `DirectoryDigest{digest, tree: Option<DigestTrie>}` split: a tree built
/// locally (e.g. by `capture_paths`) already knows its own structure, while a digest
/// that arrived from a stored cache record must be fetched from CAS before anything
/// can walk or merge it.
pub struct DirectoryDigest {
    digest: String,
    tree: OnceLock<DigestTrie>,
}

impl DirectoryDigest {
    pub fn from_trie(trie: DigestTrie) -> Result<Self> {
        let digest = trie.compute_and_store()?;
        let cell = OnceLock::new();
        let _ = cell.set(trie);
        Ok(Self { digest, tree: cell })
    }

    pub fn from_digest(digest: String) -> Self {
        Self {
            digest,
            tree: OnceLock::new(),
        }
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn tree(&self) -> Result<&DigestTrie> {
        if self.tree.get().is_none() {
            let loaded = DigestTrie::load(&self.digest)?;
            let _ = self.tree.set(loaded);
        }
        Ok(self.tree.get().expect("tree just set"))
    }
}

impl Clone for DirectoryDigest {
    fn clone(&self) -> Self {
        let cell = OnceLock::new();
        if let Some(tree) = self.tree.get() {
            let _ = cell.set(tree.clone());
        }
        Self {
            digest: self.digest.clone(),
            tree: cell,
        }
    }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/// Recursively merge directory trees into one. Entries that appear in only one tree
/// pass straight through. Entries with the same name in multiple trees collapse to a
/// single copy if identical (a directory with the same digest short-circuits without
/// recursing further; a file/symlink with the same content/target does the same).
/// Same-named entries that actually differ (different file content, different
/// symlink target, a file colliding with a directory, ...) are a hard error.
pub fn merge(trees: Vec<DigestTrie>) -> Result<DigestTrie> {
    merge_helper("", trees)
}

/// Convenience wrapper over `merge` for already-digest-only inputs: resolves each to
/// a tree (loading from CAS as needed), merges, and stores the result.
pub fn merge_digests(digests: Vec<DirectoryDigest>) -> Result<DirectoryDigest> {
    let mut trees = Vec::with_capacity(digests.len());
    for digest in &digests {
        trees.push(digest.tree()?.clone());
    }
    let merged = merge(trees)?;
    DirectoryDigest::from_trie(merged)
}

// ---------------------------------------------------------------------------
// Inspect — list files in a tree, read a single file's content by path
// ---------------------------------------------------------------------------

/// Recursively list every file/symlink path within a tree, in sorted order.
/// Directories are walked but not themselves listed.
pub fn list_files(trie: &DigestTrie) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    list_files_helper("", trie, &mut paths)?;
    Ok(paths)
}

fn list_files_helper(parent: &str, trie: &DigestTrie, out: &mut Vec<String>) -> Result<()> {
    for entry in trie.entries() {
        let path = if parent.is_empty() {
            entry.name().to_owned()
        } else {
            format!("{parent}/{}", entry.name())
        };
        match entry {
            Entry::File(_) | Entry::Symlink(_) => out.push(path),
            Entry::Directory(d) => {
                let child = DigestTrie::load(&d.digest)?;
                list_files_helper(&path, &child, out)?;
            }
        }
    }
    Ok(())
}

/// Read a single file's content out of a tree by its relative path — the
/// digest-backed analog of reading a real file off disk.
pub fn read_file_from_trie(trie: &DigestTrie, path: &str) -> Result<String> {
    let components: Vec<&str> = path.split('/').collect();
    let (name, parents) = components.split_last().context("path must not be empty")?;

    let mut current = trie.clone();
    for part in parents {
        let entry = current
            .entries()
            .iter()
            .find(|e| e.name() == *part)
            .with_context(|| {
                format!("path '{path}' not found in digest (missing directory '{part}')")
            })?;
        match entry {
            Entry::Directory(d) => current = DigestTrie::load(&d.digest)?,
            _ => bail!("path '{path}' not found in digest ('{part}' is not a directory)"),
        }
    }

    let entry = current
        .entries()
        .iter()
        .find(|e| e.name() == *name)
        .with_context(|| format!("path '{path}' not found in digest"))?;
    match entry {
        Entry::File(f) => {
            crate::usage::record_use(crate::usage::UsageKind::Cas, &f.digest);
            let blob_path = cas_blob_path(&f.digest)?;
            std::fs::read_to_string(&blob_path)
                .with_context(|| format!("read digest file blob for '{path}'"))
        }
        _ => bail!("path '{path}' in digest is not a file"),
    }
}

/// Whatever sits at a resolved path within a digest tree — a directory
/// (further walkable) or a leaf (file/symlink), returned by `resolve_in_trie`.
pub enum ResolvedEntry {
    Directory(DirectoryDigest),
    File { digest: String, mode: Option<u32> },
    Symlink { target: String },
}

/// Resolve `path` within `trie` to whichever entry sits there. All but the
/// last path component must be directories; the last component may be any
/// entry kind. Used by `write_workspace` so a single declared `run()` file
/// output (nested under its full output path, see `nest_file`) can be
/// published individually — without requiring its containing directory to be
/// captured/published as a whole, which would be unsafe for outputs that sit
/// alongside unrelated hand-written files (e.g. a generated header next to
/// hand-written ones in the same directory).
pub fn resolve_in_trie(trie: &DigestTrie, path: &str) -> Result<ResolvedEntry> {
    let mut current = trie.clone();
    let mut parts = path.split('/').filter(|p| !p.is_empty()).peekable();
    while let Some(part) = parts.next() {
        let entry = current
            .entries()
            .iter()
            .find(|e| e.name() == part)
            .with_context(|| format!("path '{path}' not found in digest (missing '{part}')"))?;
        if parts.peek().is_some() {
            match entry {
                Entry::Directory(d) => current = DigestTrie::load(&d.digest)?,
                _ => bail!("path '{path}' not found in digest ('{part}' is not a directory)"),
            }
        } else {
            return Ok(match entry {
                Entry::Directory(d) => {
                    ResolvedEntry::Directory(DirectoryDigest::from_digest(d.digest.clone()))
                }
                Entry::File(f) => ResolvedEntry::File {
                    digest: f.digest.clone(),
                    mode: f.mode,
                },
                Entry::Symlink(s) => ResolvedEntry::Symlink {
                    target: s.target.clone(),
                },
            });
        }
    }
    // Empty path (root) resolves to the directory itself.
    Ok(ResolvedEntry::Directory(DirectoryDigest::from_trie(
        current,
    )?))
}

// ---------------------------------------------------------------------------
// Diff — structural comparison between two trees
// ---------------------------------------------------------------------------

/// A single path-level difference between a "before" and "after" tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathChange {
    Added(String),
    Removed(String),
    Modified(String),
}

impl PathChange {
    pub fn path(&self) -> &str {
        match self {
            PathChange::Added(p) | PathChange::Removed(p) | PathChange::Modified(p) => p,
        }
    }
}

/// Structurally diff two trees, mirroring `merge_helper`'s per-level walk but
/// comparing instead of unioning. Short-circuits whenever two subtrees already
/// share a digest, so an unchanged directory is never walked.
pub fn diff(before: &DigestTrie, after: &DigestTrie) -> Result<Vec<PathChange>> {
    diff_helper("", before, after)
}

/// Convenience wrapper over `diff` for already-digest-only inputs: resolves
/// each to a tree (loading from CAS as needed), then diffs them.
pub fn diff_digests(before: &DirectoryDigest, after: &DirectoryDigest) -> Result<Vec<PathChange>> {
    diff(before.tree()?, after.tree()?)
}

/// Convenience wrapper over `list_files` for a `DirectoryDigest`.
pub fn list_files_in_digest(digest: &DirectoryDigest) -> Result<Vec<String>> {
    list_files(digest.tree()?)
}

/// Convenience wrapper over `read_file_from_trie` for a `DirectoryDigest`.
pub fn read_file_in_digest(digest: &DirectoryDigest, path: &str) -> Result<String> {
    read_file_from_trie(digest.tree()?, path)
}

fn diff_helper(parent: &str, before: &DigestTrie, after: &DigestTrie) -> Result<Vec<PathChange>> {
    let mut before_by_name: BTreeMap<&str, &Entry> =
        before.entries().iter().map(|e| (e.name(), e)).collect();
    let mut changes = Vec::new();

    for after_entry in after.entries() {
        let path = if parent.is_empty() {
            after_entry.name().to_owned()
        } else {
            format!("{parent}/{}", after_entry.name())
        };
        match before_by_name.remove(after_entry.name()) {
            None => changes.push(PathChange::Added(path)),
            Some(before_entry) => {
                changes.extend(diff_entry(&path, before_entry, after_entry)?);
            }
        }
    }
    // Whatever's left in `before_by_name` didn't appear in `after`.
    let mut removed: Vec<&str> = before_by_name.into_keys().collect();
    removed.sort_unstable();
    for name in removed {
        let path = if parent.is_empty() {
            name.to_owned()
        } else {
            format!("{parent}/{name}")
        };
        changes.push(PathChange::Removed(path));
    }
    Ok(changes)
}

fn diff_entry(path: &str, before: &Entry, after: &Entry) -> Result<Vec<PathChange>> {
    match (before, after) {
        (Entry::File(b), Entry::File(a)) => {
            if b.digest == a.digest {
                Ok(Vec::new())
            } else {
                Ok(vec![PathChange::Modified(path.to_owned())])
            }
        }
        (Entry::Symlink(b), Entry::Symlink(a)) => {
            if b.target == a.target {
                Ok(Vec::new())
            } else {
                Ok(vec![PathChange::Modified(path.to_owned())])
            }
        }
        (Entry::Directory(b), Entry::Directory(a)) => {
            if b.digest == a.digest {
                Ok(Vec::new())
            } else {
                let before_tree = DigestTrie::load(&b.digest)?;
                let after_tree = DigestTrie::load(&a.digest)?;
                diff_helper(path, &before_tree, &after_tree)
            }
        }
        // Same name, different kind (file vs. directory vs. symlink): treat
        // as a wholesale replacement rather than trying to diff across kinds.
        _ => Ok(vec![PathChange::Modified(path.to_owned())]),
    }
}

/// Wrap a single file, already stored in CAS, under `relative_path` — e.g. storing
/// `digest` at `"a/b/c.txt"` produces a one-file tree `a/b/c.txt`. Used to fold a
/// plain `{kind:"file"}` input/output into the same merged-tree representation as
/// everything else, so it composes uniformly with `merge_digests`.
pub fn nest_file(
    relative_path: &str,
    digest: String,
    size: u64,
    mode: Option<u32>,
) -> Result<DirectoryDigest> {
    let components: Vec<&str> = relative_path.split('/').collect();
    let (name, parents) = components
        .split_last()
        .context("relative path must not be empty")?;
    let leaf = Entry::File(FileEntry {
        name: (*name).to_owned(),
        digest,
        size,
        mode,
    });
    nest_under(parents, leaf)
}

/// Wrap an already-captured directory tree under `relative_path` — the directory
/// analog of `nest_file`.
pub fn nest_directory(relative_path: &str, inner: &DirectoryDigest) -> Result<DirectoryDigest> {
    let components: Vec<&str> = relative_path.split('/').collect();
    let (name, parents) = components
        .split_last()
        .context("relative path must not be empty")?;
    let leaf = Entry::Directory(DirEntry {
        name: (*name).to_owned(),
        digest: inner.digest().to_owned(),
    });
    nest_under(parents, leaf)
}

fn nest_under(parents: &[&str], leaf: Entry) -> Result<DirectoryDigest> {
    let mut current = leaf;
    for name in parents.iter().rev() {
        let trie = DigestTrie(Arc::from(vec![current]));
        let digest = trie.compute_and_store()?;
        current = Entry::Directory(DirEntry {
            name: (*name).to_owned(),
            digest,
        });
    }
    let trie = DigestTrie(Arc::from(vec![current]));
    DirectoryDigest::from_trie(trie)
}

fn merge_helper(parent: &str, mut trees: Vec<DigestTrie>) -> Result<DigestTrie> {
    trees.retain(|tree| !tree.entries().is_empty());
    if trees.is_empty() {
        return Ok(DigestTrie::empty());
    }
    if trees.len() == 1 {
        return Ok(trees.pop().expect("len checked"));
    }

    let mut by_name: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    for tree in trees {
        for entry in tree.entries().iter().cloned() {
            by_name
                .entry(entry.name().to_owned())
                .or_default()
                .push(entry);
        }
    }

    let mut merged_entries = Vec::with_capacity(by_name.len());
    for (name, group) in by_name {
        let path = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        merged_entries.push(merge_group(&path, name, group)?);
    }

    let trie = DigestTrie(Arc::from(merged_entries));
    trie.compute_and_store()?;
    Ok(trie)
}

fn merge_group(path: &str, name: String, group: Vec<Entry>) -> Result<Entry> {
    match &group[0] {
        Entry::File(first) => {
            for entry in &group[1..] {
                match entry {
                    Entry::File(f) if f.digest == first.digest => {}
                    _ => bail!("merge conflict at '{path}': differing content for the same file"),
                }
            }
            Ok(group.into_iter().next().expect("non-empty group"))
        }
        Entry::Symlink(first) => {
            for entry in &group[1..] {
                match entry {
                    Entry::Symlink(s) if s.target == first.target => {}
                    _ => bail!("merge conflict at '{path}': differing target for the same symlink"),
                }
            }
            Ok(group.into_iter().next().expect("non-empty group"))
        }
        Entry::Directory(_) => {
            let mut dirs = Vec::with_capacity(group.len());
            for entry in group {
                match entry {
                    Entry::Directory(d) => dirs.push(d),
                    _ => bail!(
                        "merge conflict at '{path}': a file/symlink collides with a directory"
                    ),
                }
            }
            if dirs.iter().all(|d| d.digest == dirs[0].digest) {
                return Ok(Entry::Directory(
                    dirs.into_iter().next().expect("non-empty group"),
                ));
            }
            let mut subtrees = Vec::with_capacity(dirs.len());
            for dir in &dirs {
                subtrees.push(DigestTrie::load(&dir.digest)?);
            }
            let merged = merge_helper(path, subtrees)?;
            let digest = merged.compute_and_store()?;
            Ok(Entry::Directory(DirEntry { name, digest }))
        }
    }
}

// ---------------------------------------------------------------------------
// Capture — greedily content-address real files into CAS, building a tree
// ---------------------------------------------------------------------------

/// Walk `root` on disk and content-address every file/symlink/subdirectory into
/// CAS, building the corresponding tree bottom-up (each level's `DigestNode` is
/// stored as it's completed). This is the direct analog of Pants capturing a
/// directory into its `Store`.
pub fn capture_directory(root: &Path) -> Result<DirectoryDigest> {
    let trie = capture_directory_trie(root)?;
    DirectoryDigest::from_trie(trie)
}

fn capture_directory_trie(dir: &Path) -> Result<DigestTrie> {
    let read_dir = std::fs::read_dir(dir).with_context(|| format!("read dir {}", dir.display()))?;
    let mut dir_entries: Vec<_> = read_dir
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("read dir {}", dir.display()))?;
    dir_entries.sort_by_key(|entry| entry.file_name());

    let mut entries = Vec::with_capacity(dir_entries.len());
    for entry in dir_entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry
            .file_type()
            .with_context(|| format!("stat {}", path.display()))?;
        if file_type.is_symlink() {
            let target = std::fs::read_link(&path)
                .with_context(|| format!("read symlink {}", path.display()))?;
            entries.push(Entry::Symlink(SymlinkEntry {
                name,
                target: target.to_string_lossy().into_owned(),
            }));
        } else if file_type.is_dir() {
            let child = capture_directory_trie(&path)?;
            let digest = child.compute_and_store()?;
            entries.push(Entry::Directory(DirEntry { name, digest }));
        } else if file_type.is_file() {
            let (digest, size) = store_file_blob(&path, "digest-file")?;
            let mode = file_mode(&path)?;
            entries.push(Entry::File(FileEntry {
                name,
                digest,
                size,
                mode,
            }));
        }
    }

    let trie = DigestTrie(Arc::from(entries));
    trie.compute_and_store()?;
    Ok(trie)
}

enum BuildNode {
    File(FileEntry),
    Symlink(SymlinkEntry),
    Dir(BTreeMap<String, BuildNode>),
}

/// Build a tree from an explicit, already-filtered list of workspace-relative
/// paths (e.g. glob matches) rather than a blanket directory walk — the direct
/// analog of Pants' `PathGlobs` capture, since glob results are typically a
/// scattered subset of files rather than one clean subtree.
///
/// Paths that don't exist on disk are silently omitted rather than erroring —
/// callers use this to snapshot a "before" state for paths that may not have
/// been generated yet (e.g. a codegen output on its first run), and a missing
/// path should just diff as `Added` once it appears, not fail the capture.
pub fn capture_paths(workspace_root: &Path, paths: &[String]) -> Result<DirectoryDigest> {
    let mut root: BTreeMap<String, BuildNode> = BTreeMap::new();
    for relative in paths {
        let absolute = workspace_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        let metadata = match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(e).with_context(|| format!("stat {}", absolute.display()));
            }
        };
        let components: Vec<&str> = relative.split('/').collect();
        insert_path(&mut root, &components, &absolute, &metadata)?;
    }
    let trie = build_trie_from_nodes(root)?;
    DirectoryDigest::from_trie(trie)
}

fn insert_path(
    node: &mut BTreeMap<String, BuildNode>,
    components: &[&str],
    absolute: &Path,
    metadata: &std::fs::Metadata,
) -> Result<()> {
    let (first, rest) = components
        .split_first()
        .expect("path must have at least one component");
    if rest.is_empty() {
        let leaf = if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(absolute)
                .with_context(|| format!("read symlink {}", absolute.display()))?;
            BuildNode::Symlink(SymlinkEntry {
                name: (*first).to_owned(),
                target: target.to_string_lossy().into_owned(),
            })
        } else {
            let (digest, size) = store_file_blob(absolute, "digest-file")?;
            let mode = file_mode(absolute)?;
            BuildNode::File(FileEntry {
                name: (*first).to_owned(),
                digest,
                size,
                mode,
            })
        };
        node.insert((*first).to_owned(), leaf);
        return Ok(());
    }
    let entry = node
        .entry((*first).to_owned())
        .or_insert_with(|| BuildNode::Dir(BTreeMap::new()));
    match entry {
        BuildNode::Dir(children) => insert_path(children, rest, absolute, metadata)?,
        _ => {
            bail!("path component '{first}' is both a file and a directory across the given paths")
        }
    }
    Ok(())
}

fn build_trie_from_nodes(nodes: BTreeMap<String, BuildNode>) -> Result<DigestTrie> {
    let mut entries = Vec::with_capacity(nodes.len());
    for (name, node) in nodes {
        let entry = match node {
            BuildNode::File(mut file) => {
                file.name = name;
                Entry::File(file)
            }
            BuildNode::Symlink(mut symlink) => {
                symlink.name = name;
                Entry::Symlink(symlink)
            }
            BuildNode::Dir(children) => {
                let trie = build_trie_from_nodes(children)?;
                let digest = trie.compute_and_store()?;
                Entry::Directory(DirEntry { name, digest })
            }
        };
        entries.push(entry);
    }
    let trie = DigestTrie(Arc::from(entries));
    trie.compute_and_store()?;
    Ok(trie)
}

// ---------------------------------------------------------------------------
// Materialize — write a tree back out to disk
// ---------------------------------------------------------------------------

/// Walk `trie` and write it out under `destination`. When `link_files` is set,
/// regular files are hardlinked from their CAS blob rather than copied (falling
/// back to a copy if hardlinking fails, e.g. across filesystems) — appropriate for
/// ephemeral, single-use sandboxes, but NOT for materializing into the workspace:
/// a hardlinked workspace file that a user or tool later edits in place would
/// silently corrupt the shared CAS blob. Workspace materialization must always
/// copy (`link_files: false`).
pub fn materialize_trie(trie: &DigestTrie, destination: &Path, link_files: bool) -> Result<()> {
    std::fs::create_dir_all(destination)
        .with_context(|| format!("create {}", destination.display()))?;
    for entry in trie.entries() {
        let dest = destination.join(entry.name());
        match entry {
            Entry::File(file) => {
                materialize_file(&file.digest, &dest, link_files)?;
                restore_file_mode(&dest, file.mode)?;
            }
            Entry::Symlink(symlink) => {
                create_symlink(&symlink.target, &dest)?;
            }
            Entry::Directory(dir) => {
                let child = DigestTrie::load(&dir.digest)?;
                materialize_trie(&child, &dest, link_files)?;
            }
        }
    }
    Ok(())
}

fn materialize_file(digest: &str, dest: &Path, link_files: bool) -> Result<()> {
    crate::usage::record_use(crate::usage::UsageKind::Cas, digest);
    let source = cas_blob_path(digest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    if link_files {
        match std::fs::hard_link(&source, dest) {
            Ok(()) => return Ok(()),
            Err(_) => return copy_file(&source, dest),
        }
    }
    copy_file(&source, dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn merge_disjoint_trees_unions_entries() {
        let dir = tempfile::tempdir().unwrap();

        let src_a = dir.path().join("a");
        write(&src_a.join("one.txt"), "one");
        let src_b = dir.path().join("b");
        write(&src_b.join("two.txt"), "two");

        let a = capture_directory(&src_a).unwrap();
        let b = capture_directory(&src_b).unwrap();
        let merged = merge_digests(vec![a, b]).unwrap();

        let names: Vec<&str> = merged
            .tree()
            .unwrap()
            .entries()
            .iter()
            .map(Entry::name)
            .collect();
        assert_eq!(names, vec!["one.txt", "two.txt"]);
    }

    #[test]
    fn merge_identical_subtree_short_circuits() {
        let dir = tempfile::tempdir().unwrap();

        let src_a = dir.path().join("a");
        write(&src_a.join("shared").join("x.txt"), "same content");
        let src_b = dir.path().join("b");
        write(&src_b.join("shared").join("x.txt"), "same content");

        let a = capture_directory(&src_a).unwrap();
        let b = capture_directory(&src_b).unwrap();
        let merged = merge_digests(vec![a, b]).unwrap();

        let entries = merged.tree().unwrap().entries();
        assert_eq!(entries.len(), 1);
        match &entries[0] {
            Entry::Directory(d) => assert_eq!(d.name, "shared"),
            other => panic!("expected a directory entry, got {other:?}"),
        }
    }

    #[test]
    fn merge_conflicting_file_errors() {
        let dir = tempfile::tempdir().unwrap();

        let src_a = dir.path().join("a");
        write(&src_a.join("x.txt"), "version a");
        let src_b = dir.path().join("b");
        write(&src_b.join("x.txt"), "version b");

        let a = capture_directory(&src_a).unwrap();
        let b = capture_directory(&src_b).unwrap();
        let result = merge_digests(vec![a, b]);
        assert!(result.is_err());
    }

    #[test]
    fn merge_conflicting_subdirectory_recurses() {
        let dir = tempfile::tempdir().unwrap();

        let src_a = dir.path().join("a");
        write(&src_a.join("shared").join("only_in_a.txt"), "a");
        let src_b = dir.path().join("b");
        write(&src_b.join("shared").join("only_in_b.txt"), "b");

        let a = capture_directory(&src_a).unwrap();
        let b = capture_directory(&src_b).unwrap();
        let merged = merge_digests(vec![a, b]).unwrap();

        let entries = merged.tree().unwrap().entries();
        assert_eq!(entries.len(), 1);
        match &entries[0] {
            Entry::Directory(d) => {
                let child = DigestTrie::load(&d.digest).unwrap();
                let names: Vec<&str> = child.entries().iter().map(Entry::name).collect();
                assert_eq!(names, vec!["only_in_a.txt", "only_in_b.txt"]);
            }
            other => panic!("expected a directory entry, got {other:?}"),
        }
    }

    #[test]
    fn capture_paths_omits_missing_entries() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("present.txt"), "here");

        let paths = vec!["present.txt".to_string(), "missing.txt".to_string()];
        let captured = capture_paths(dir.path(), &paths).unwrap();

        let names: Vec<&str> = captured
            .tree()
            .unwrap()
            .entries()
            .iter()
            .map(Entry::name)
            .collect();
        assert_eq!(names, vec!["present.txt"]);
    }

    #[test]
    fn capture_paths_all_missing_is_empty_tree() {
        let dir = tempfile::tempdir().unwrap();
        let paths = vec!["missing.txt".to_string()];
        let captured = capture_paths(dir.path(), &paths).unwrap();
        assert!(captured.tree().unwrap().entries().is_empty());
    }

    #[test]
    fn capture_paths_missing_then_present_diffs_as_added() {
        let dir = tempfile::tempdir().unwrap();
        let paths = vec!["gen.txt".to_string()];

        let before = capture_paths(dir.path(), &paths).unwrap();
        write(&dir.path().join("gen.txt"), "generated");
        let after = capture_paths(dir.path(), &paths).unwrap();

        let changes = diff_digests(&before, &after).unwrap();
        assert_eq!(changes.len(), 1);
        match &changes[0] {
            PathChange::Added(path) => assert_eq!(path, "gen.txt"),
            other => panic!("expected Added, got {other:?}"),
        }
    }

    #[test]
    fn diff_identical_trees_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("a.txt"), "same");
        write(&src.join("nested").join("b.txt"), "also same");

        let before = capture_directory(&src).unwrap();
        let after = capture_directory(&src).unwrap();

        let changes = diff_digests(&before, &after).unwrap();
        assert!(changes.is_empty());
    }

    #[test]
    fn diff_detects_modified_file() {
        let dir = tempfile::tempdir().unwrap();
        let src_a = dir.path().join("a");
        write(&src_a.join("f.txt"), "before");
        let src_b = dir.path().join("b");
        write(&src_b.join("f.txt"), "after");

        let before = capture_directory(&src_a).unwrap();
        let after = capture_directory(&src_b).unwrap();

        let changes = diff_digests(&before, &after).unwrap();
        assert_eq!(changes, vec![PathChange::Modified("f.txt".to_string())]);
    }

    #[test]
    fn diff_detects_added_and_removed_files() {
        let dir = tempfile::tempdir().unwrap();
        let src_a = dir.path().join("a");
        write(&src_a.join("only_before.txt"), "x");
        let src_b = dir.path().join("b");
        write(&src_b.join("only_after.txt"), "y");

        let before = capture_directory(&src_a).unwrap();
        let after = capture_directory(&src_b).unwrap();

        let mut changes = diff_digests(&before, &after).unwrap();
        changes.sort_by(|a, b| a.path().cmp(b.path()));
        assert_eq!(
            changes,
            vec![
                PathChange::Added("only_after.txt".to_string()),
                PathChange::Removed("only_before.txt".to_string()),
            ]
        );
    }

    #[test]
    fn diff_prefixes_nested_directory_changes() {
        let dir = tempfile::tempdir().unwrap();
        let src_a = dir.path().join("a");
        write(&src_a.join("nested").join("f.txt"), "before");
        let src_b = dir.path().join("b");
        write(&src_b.join("nested").join("f.txt"), "after");

        let before = capture_directory(&src_a).unwrap();
        let after = capture_directory(&src_b).unwrap();

        let changes = diff_digests(&before, &after).unwrap();
        assert_eq!(
            changes,
            vec![PathChange::Modified("nested/f.txt".to_string())]
        );
    }

    #[test]
    fn list_files_in_digest_lists_nested_paths() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("a.txt"), "a");
        write(&src.join("nested").join("b.txt"), "b");

        let digest = capture_directory(&src).unwrap();
        let mut files = list_files_in_digest(&digest).unwrap();
        files.sort();
        assert_eq!(files, vec!["a.txt".to_string(), "nested/b.txt".to_string()]);
    }

    #[test]
    fn read_file_in_digest_reads_nested_file_content() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("nested").join("b.txt"), "hello from nested");

        let digest = capture_directory(&src).unwrap();
        let content = read_file_in_digest(&digest, "nested/b.txt").unwrap();
        assert_eq!(content, "hello from nested");
    }

    #[test]
    fn read_file_in_digest_errors_on_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("a.txt"), "a");

        let digest = capture_directory(&src).unwrap();
        assert!(read_file_in_digest(&digest, "missing.txt").is_err());
    }

    #[test]
    fn capture_and_materialize_round_trips_a_symlink() {
        let dir = tempfile::tempdir().unwrap();

        let source = dir.path().join("source");
        write(&source.join("nested").join("real.txt"), "hello");
        #[cfg(unix)]
        std::os::unix::fs::symlink("real.txt", source.join("nested").join("link.txt")).unwrap();

        let digest = capture_directory(&source).unwrap();

        let destination = dir.path().join("dest");
        materialize_trie(digest.tree().unwrap(), &destination, false).unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("nested").join("real.txt")).unwrap(),
            "hello"
        );
        #[cfg(unix)]
        {
            let target = std::fs::read_link(destination.join("nested").join("link.txt")).unwrap();
            assert_eq!(target, Path::new("real.txt"));
        }
    }

    #[test]
    fn resolve_in_trie_strips_the_prefix_for_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("out").join("nested").join("f.txt"), "content");

        let digest = capture_directory(&src).unwrap();
        let sub = match resolve_in_trie(digest.tree().unwrap(), "out").unwrap() {
            ResolvedEntry::Directory(dir) => dir,
            _ => panic!("expected a directory"),
        };

        assert_eq!(
            read_file_from_trie(sub.tree().unwrap(), "nested/f.txt").unwrap(),
            "content"
        );
        assert!(read_file_from_trie(digest.tree().unwrap(), "nested/f.txt").is_err());
    }

    #[test]
    fn resolve_in_trie_errors_on_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("a.txt"), "a");

        let digest = capture_directory(&src).unwrap();
        assert!(resolve_in_trie(digest.tree().unwrap(), "missing").is_err());
    }

    #[test]
    fn resolve_in_trie_resolves_a_single_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("out").join("gen.h"), "generated content");

        let digest = capture_directory(&src).unwrap();
        match resolve_in_trie(digest.tree().unwrap(), "out/gen.h").unwrap() {
            ResolvedEntry::File {
                digest: file_digest,
                ..
            } => {
                assert_eq!(
                    std::fs::read_to_string(cas_blob_path(&file_digest).unwrap()).unwrap(),
                    "generated content"
                );
            }
            _ => panic!("expected a file"),
        }
    }

    #[test]
    fn resolve_in_trie_errors_when_a_middle_component_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        write(&src.join("a.txt"), "a");

        let digest = capture_directory(&src).unwrap();
        assert!(resolve_in_trie(digest.tree().unwrap(), "a.txt/nested").is_err());
    }
}
