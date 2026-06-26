use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

use super::file_tracker::FileTracker;
use super::local::LocalEnv;
use crate::workspace;

const WINDOWS_WORKSPACE_PATH: &str = "/mnt/c/dev/ottar-windows";

pub struct WslEnv {
    windows_workspace: PathBuf,
    root_dir: PathBuf,
    db_path: PathBuf,
    pub synced: bool,
}

impl WslEnv {
    pub fn new() -> Self {
        let root_dir = workspace::root_dir();
        Self {
            windows_workspace: PathBuf::from(WINDOWS_WORKSPACE_PATH),
            db_path: root_dir.join(".sync_state.db"),
            root_dir,
            synced: false,
        }
    }

    pub fn is_windows(&self) -> bool {
        true
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    pub async fn validate(&self) -> Result<()> {
        let local = LocalEnv::new();
        let (code, out) = local
            .execute(&["wsl.exe", "--version"], None, false)
            .await
            .unwrap_or((-1, "wsl.exe not found".to_owned()));
        if code != 0 {
            bail!("WSL not available: {out}");
        }
        let parent = self.windows_workspace.parent().unwrap();
        if !parent.exists() {
            bail!("Windows mount path not accessible: {}", parent.display());
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Command execution
    // -----------------------------------------------------------------------

    pub async fn execute(
        &self,
        cmd: &[&str],
        cwd: Option<&Path>,
        stream_output: bool,
    ) -> Result<(i32, String)> {
        let cwd: PathBuf = cwd
            .map(|p| p.to_owned())
            .unwrap_or_else(workspace::root_dir);
        let win_cwd = self.translate_path(&cwd).await?;
        let cmd_str = cmd
            .iter()
            .map(|a| {
                if a.contains(' ') {
                    format!("\"{a}\"")
                } else {
                    a.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let ps_cmd = format!("Set-Location '{win_cwd}'; {cmd_str}; exit $LASTEXITCODE");
        let ps_args = ["powershell.exe", "-NoProfile", "-Command", &ps_cmd];
        LocalEnv::new().execute(&ps_args, None, stream_output).await
    }

    #[allow(dead_code)]
    pub async fn execute_check(&self, cmd: &[&str], cwd: Option<&Path>) -> Result<String> {
        let (code, output) = self.execute(cmd, cwd, false).await?;
        if code != 0 {
            bail!(
                "command `{}` failed (code {code}):\n{output}",
                cmd.join(" ")
            );
        }
        Ok(output)
    }

    pub async fn ensure_paths(&self, paths: &[PathBuf]) -> Result<()> {
        for path in paths {
            if path.starts_with(&self.root_dir) {
                let rel = path.strip_prefix(&self.root_dir).unwrap();
                let win_path = self.windows_workspace.join(rel);
                let win_str = self.translate_path(&win_path).await?;
                let ps_cmd = format!("New-Item -ItemType Directory -Force -Path '{win_str}'");
                let (code, out) = LocalEnv::new()
                    .execute(
                        &["powershell.exe", "-NoProfile", "-Command", &ps_cmd],
                        None,
                        false,
                    )
                    .await?;
                if code != 0 {
                    bail!("failed to create dir {win_str}: {out}");
                }
            } else {
                LocalEnv::new().ensure_paths(&[path.clone()]).await?;
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Workspace sync
    // -----------------------------------------------------------------------

    pub async fn sync(&mut self, progress: &mut prodash::tree::Item) -> Result<()> {
        progress.set_name("sync: checking workspace state");

        let workspace_id = self.root_dir.to_string_lossy().into_owned();
        let sentinel = self.windows_workspace.join(".sync_sentinel");

        let db_path = self.db_path.clone();
        let need_full_sync = tokio::task::spawn_blocking({
            let workspace_id = workspace_id.clone();
            let sentinel = sentinel.clone();
            move || -> Result<bool> {
                let tracker = FileTracker::open(&db_path)?;
                let last_id = tracker.get_metadata("workspace_id")?;
                let sentinel_missing = !sentinel.exists();
                Ok(sentinel_missing || last_id.as_deref() != Some(&workspace_id))
            }
        })
        .await??;

        if need_full_sync {
            progress.set_name("sync: full sync (workspace moved or deleted)");
            let sh_cmd = format!("echo '{}' > '{}'", workspace_id, sentinel.display());
            LocalEnv::new()
                .execute_check(&["sh", "-c", &sh_cmd], None, false)
                .await?;
            let db_path = self.db_path.clone();
            let workspace_id2 = workspace_id.clone();
            tokio::task::spawn_blocking(move || -> Result<()> {
                let tracker = FileTracker::open(&db_path)?;
                tracker.clear()?;
                tracker.set_metadata("workspace_id", &workspace_id2)?;
                Ok(())
            })
            .await??;
        }

        self.sync_toolchain(progress).await?;
        self.sync_content(progress).await?;
        self.sync_sources(progress).await?;

        self.synced = true;
        Ok(())
    }

    async fn sync_toolchain(&self, progress: &mut prodash::tree::Item) -> Result<()> {
        let version = workspace::odin_version();
        let rel = format!(".toolchain/{version}/odin-windows");
        let src = self.root_dir.join(&rel);
        let dst = self.windows_workspace.join(&rel);

        if !src.exists() {
            return Ok(());
        }
        if dst.join(".ready").exists() {
            return Ok(());
        }

        progress.set_name(format!("sync: toolchain {version}"));
        std::fs::create_dir_all(&dst)?;
        self.rsync(&[
            "-rvz",
            "--delete",
            "--size-only",
            "--omit-dir-times",
            &format!("{}/", src.display()),
            &format!("{}/", dst.display()),
        ])
        .await?;
        std::fs::File::create(dst.join(".ready"))?;
        Ok(())
    }

    async fn sync_content(&self, progress: &mut prodash::tree::Item) -> Result<()> {
        progress.set_name("sync: content");
        let src = format!("{}/content/", self.root_dir.display());
        let dst = format!("{}/content/", self.windows_workspace.display());
        self.rsync(&[
            "-rvz",
            "--delete",
            "--size-only",
            "--omit-dir-times",
            &src,
            &dst,
        ])
        .await
    }

    async fn sync_sources(&self, progress: &mut prodash::tree::Item) -> Result<()> {
        progress.set_name("sync: discovering changed sources");
        let local = LocalEnv::new();

        let (code, output) = local
            .execute(
                &["git", "ls-files", "-c", "-o", "--exclude-standard"],
                Some(&self.root_dir),
                false,
            )
            .await?;
        if code != 0 {
            bail!("git ls-files failed: {output}");
        }

        let mut source_files: Vec<String> = output
            .lines()
            .map(|l| l.trim().to_owned())
            .filter(|l| {
                !l.is_empty()
                    && !l.starts_with(".git/")
                    && !l.starts_with(".toolchain/")
                    && l != ".sync_state.db"
                    && !l.starts_with("content/")
                    && !l.starts_with("build/")
                    && !l.starts_with("dist/")
                    && !l.starts_with("coverage/")
            })
            .collect();

        for dir in [".vs", ".vscode"] {
            let abs = self.root_dir.join(dir);
            if abs.is_dir() {
                for entry in walkdir::WalkDir::new(&abs) {
                    let Ok(e) = entry else { continue };
                    if e.path().is_file() {
                        if let Ok(rel) = e.path().strip_prefix(&self.root_dir) {
                            let s = rel.to_string_lossy().into_owned();
                            if !source_files.contains(&s) {
                                source_files.push(s);
                            }
                        }
                    }
                }
            }
        }

        let db_path = self.db_path.clone();
        let root_dir = self.root_dir.clone();
        let windows_ws = self.windows_workspace.clone();

        let (to_sync, to_delete, to_update_db_only) = tokio::task::spawn_blocking({
            let source_files = source_files.clone();
            move || -> Result<(Vec<(String, f64, i64, String)>, Vec<String>, Vec<(String, f64, i64, String)>)> {
                let tracker = FileTracker::open(&db_path)?;
                let tracked = tracker.get_synced_files()?;
                let current_set: HashSet<&str> = source_files.iter().map(|s| s.as_str()).collect();

                let to_delete: Vec<String> = tracked.keys()
                    .filter(|k| !current_set.contains(k.as_str()))
                    .cloned()
                    .collect();
                let mut to_sync = Vec::new();
                let mut to_update_db_only = Vec::new();

                for rel_path in &source_files {
                    let abs = root_dir.join(rel_path);
                    let Ok(st) = std::fs::metadata(&abs) else { continue };
                    let mtime = st.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0);
                    let size = st.len() as i64;

                    if let Some((old_mtime, old_size, old_hash)) = tracked.get(rel_path) {
                        if (*old_mtime - mtime).abs() < 1e-6 && *old_size == size { continue; }
                        let new_hash = compute_md5(&abs)?;
                        if *old_hash == new_hash {
                            to_update_db_only.push((rel_path.clone(), mtime, size, new_hash));
                            continue;
                        }
                        to_sync.push((rel_path.clone(), mtime, size, new_hash));
                    } else {
                        let new_hash = compute_md5(&abs)?;
                        to_sync.push((rel_path.clone(), mtime, size, new_hash));
                    }
                }
                Ok((to_sync, to_delete, to_update_db_only))
            }
        }).await??;

        if to_update_db_only.is_empty() && to_sync.is_empty() && to_delete.is_empty() {
            return Ok(());
        }

        progress.set_name(format!(
            "sync: {} changed, {} deleted",
            to_sync.len(),
            to_delete.len()
        ));

        for rel in &to_delete {
            let _ = tokio::fs::remove_file(windows_ws.join(rel)).await;
        }

        if !to_sync.is_empty() {
            let tmp = tempfile::NamedTempFile::new()?;
            {
                use std::io::Write;
                let mut f = tmp.as_file();
                for (rel, ..) in &to_sync {
                    writeln!(f, "{rel}")?;
                }
            }
            let src = format!("{}/", self.root_dir.display());
            let dst = format!("{}/", self.windows_workspace.display());
            let list_path = tmp.path().to_string_lossy().into_owned();
            self.rsync(&[
                "-rv",
                "--no-perms",
                "--no-owner",
                "--no-group",
                "--omit-dir-times",
                "--chmod=Du=rwx,Dg=rwx,Do=rx,Fu=rw,Fg=rw,Fo=r",
                &format!("--files-from={list_path}"),
                &src,
                &dst,
            ])
            .await?;
        }

        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let tracker = FileTracker::open(&db_path)?;
            if !to_update_db_only.is_empty() {
                tracker.update_files(&to_update_db_only)?;
            }
            if !to_sync.is_empty() {
                tracker.update_files(&to_sync)?;
            }
            if !to_delete.is_empty() {
                tracker.remove_files(&to_delete)?;
            }
            Ok(())
        })
        .await??;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Artifact pull-back
    // -----------------------------------------------------------------------

    pub async fn copy_artifacts_back(&self) -> Result<()> {
        let win_build = self.windows_workspace.join("build");
        let local_build = workspace::build_dir();
        LocalEnv::new().ensure_paths(&[local_build.clone()]).await?;

        let (code, out) = LocalEnv::new()
            .execute(
                &[
                    "rsync",
                    "-rv",
                    "--include=*/",
                    "--include=*.exe",
                    "--include=*.dll",
                    "--include=*.pdb",
                    "--exclude=*",
                    &format!("{}/", win_build.display()),
                    &format!("{}/", local_build.display()),
                ],
                None,
                false,
            )
            .await?;
        if code != 0 {
            eprintln!("Warning: artifact copy failed: {out}");
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    async fn rsync(&self, args: &[&str]) -> Result<()> {
        let mut cmd = vec!["rsync"];
        cmd.extend_from_slice(args);
        let (code, out) = LocalEnv::new().execute(&cmd, None, false).await?;
        if code != 0 {
            bail!("rsync failed: {out}");
        }
        Ok(())
    }

    async fn translate_path(&self, path: &Path) -> Result<String> {
        let path_str = path.to_string_lossy().into_owned();
        let (code, out) = LocalEnv::new()
            .execute(&["wslpath", "-w", &path_str], None, false)
            .await?;
        if code != 0 {
            bail!("wslpath failed: {out}");
        }
        Ok(out.trim().to_owned())
    }
}

fn compute_md5(path: &Path) -> Result<String> {
    let mut ctx = md5::Context::new();
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 4096];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.consume(&buf[..n]);
    }
    Ok(format!("{:x}", ctx.compute()))
}
