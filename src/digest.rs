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

use crate::cache::{cas_blob_path, copy_file, create_symlink, file_mode, restore_file_mode, store_blob, store_file_blob};

// ---------------------------------------------------------------------------
// In-memory tree types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) enum Entry {
    File(FileEntry),
    Directory(DirEntry),
    Symlink(SymlinkEntry),
}

impl Entry {
    pub(crate) fn name(&self) -> &str {
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
            DigestNodeEntry::File { name, digest, size, mode } => {
                Entry::File(FileEntry { name, digest, size, mode })
            }
            DigestNodeEntry::Directory { name, digest } => Entry::Directory(DirEntry { name, digest }),
            DigestNodeEntry::Symlink { name, target } => Entry::Symlink(SymlinkEntry { name, target }),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FileEntry {
    pub(crate) name: String,
    pub(crate) digest: String,
    pub(crate) size: u64,
    pub(crate) mode: Option<u32>,
}

/// A subdirectory entry. `digest` identifies that child's own `DigestNode` blob in
/// CAS; the child tree is only loaded on demand (see `DigestTrie::load`), so merging
/// or walking a tree never eagerly pulls in subtrees it doesn't need to inspect.
#[derive(Debug, Clone)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SymlinkEntry {
    pub(crate) name: String,
    pub(crate) target: String,
}

/// A single directory level: a sorted-by-name list of entries. Cheap to clone (an
/// `Arc` bump) since trees are shared structurally across merges.
#[derive(Debug, Clone)]
pub(crate) struct DigestTrie(Arc<[Entry]>);

impl DigestTrie {
    pub(crate) fn entries(&self) -> &[Entry] {
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
    pub(crate) fn compute_and_store(&self) -> Result<String> {
        let node = self.to_node();
        let bytes = serde_json::to_vec(&node).context("serialize digest node")?;
        store_blob(&bytes, "digest-node")
    }

    /// Load a directory level from CAS by digest. Does not recurse into child
    /// directories — those are loaded lazily, only when something actually walks
    /// into them (merge, materialize, etc.).
    pub(crate) fn load(digest: &str) -> Result<DigestTrie> {
        let path = cas_blob_path(digest)?;
        let bytes =
            std::fs::read(&path).with_context(|| format!("read digest node {}", path.display()))?;
        let node: DigestNode = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse digest node {}", path.display()))?;
        let entries: Vec<Entry> = node.entries.into_iter().map(Entry::from_node_entry).collect();
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
pub(crate) struct DirectoryDigest {
    digest: String,
    tree: OnceLock<DigestTrie>,
}

impl DirectoryDigest {
    pub(crate) fn from_trie(trie: DigestTrie) -> Result<Self> {
        let digest = trie.compute_and_store()?;
        let cell = OnceLock::new();
        let _ = cell.set(trie);
        Ok(Self { digest, tree: cell })
    }

    pub(crate) fn from_digest(digest: String) -> Self {
        Self { digest, tree: OnceLock::new() }
    }

    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }

    pub(crate) fn tree(&self) -> Result<&DigestTrie> {
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
        Self { digest: self.digest.clone(), tree: cell }
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
pub(crate) fn merge(trees: Vec<DigestTrie>) -> Result<DigestTrie> {
    merge_helper("", trees)
}

/// Convenience wrapper over `merge` for already-digest-only inputs: resolves each to
/// a tree (loading from CAS as needed), merges, and stores the result.
pub(crate) fn merge_digests(digests: Vec<DirectoryDigest>) -> Result<DirectoryDigest> {
    let mut trees = Vec::with_capacity(digests.len());
    for digest in &digests {
        trees.push(digest.tree()?.clone());
    }
    let merged = merge(trees)?;
    DirectoryDigest::from_trie(merged)
}

/// Wrap a single file, already stored in CAS, under `relative_path` — e.g. storing
/// `digest` at `"a/b/c.txt"` produces a one-file tree `a/b/c.txt`. Used to fold a
/// plain `{kind:"file"}` input/output into the same merged-tree representation as
/// everything else, so it composes uniformly with `merge_digests`.
pub(crate) fn nest_file(
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
pub(crate) fn nest_directory(relative_path: &str, inner: &DirectoryDigest) -> Result<DirectoryDigest> {
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
            by_name.entry(entry.name().to_owned()).or_default().push(entry);
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
                    _ => bail!("merge conflict at '{path}': a file/symlink collides with a directory"),
                }
            }
            if dirs.iter().all(|d| d.digest == dirs[0].digest) {
                return Ok(Entry::Directory(dirs.into_iter().next().expect("non-empty group")));
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
pub(crate) fn capture_directory(root: &Path) -> Result<DirectoryDigest> {
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
            entries.push(Entry::File(FileEntry { name, digest, size, mode }));
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
pub(crate) fn capture_paths(workspace_root: &Path, paths: &[String]) -> Result<DirectoryDigest> {
    let mut root: BTreeMap<String, BuildNode> = BTreeMap::new();
    for relative in paths {
        let absolute = workspace_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        let metadata = std::fs::symlink_metadata(&absolute)
            .with_context(|| format!("stat {}", absolute.display()))?;
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
        _ => bail!("path component '{first}' is both a file and a directory across the given paths"),
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
pub(crate) fn materialize_trie(trie: &DigestTrie, destination: &Path, link_files: bool) -> Result<()> {
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

        let names: Vec<&str> = merged.tree().unwrap().entries().iter().map(Entry::name).collect();
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
}
