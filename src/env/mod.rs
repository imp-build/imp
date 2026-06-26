pub mod file_tracker;
pub mod local;
pub mod wsl;

use std::path::{Path, PathBuf};

use anyhow::Result;

pub use local::LocalEnv;
pub use wsl::WslEnv;

/// Unified execution environment – either local or WSL cross-compile.
pub enum Env {
    Local(LocalEnv),
    Wsl(WslEnv),
}

impl Env {
    pub fn is_windows(&self) -> bool {
        match self {
            Env::Local(_) => LocalEnv::is_windows(),
            Env::Wsl(w) => w.is_windows(),
        }
    }

    pub async fn execute(
        &self,
        cmd: &[&str],
        cwd: Option<&Path>,
        stream_output: bool,
    ) -> Result<(i32, String)> {
        match self {
            Env::Local(e) => e.execute(cmd, cwd, stream_output).await,
            Env::Wsl(e) => e.execute(cmd, cwd, stream_output).await,
        }
    }

    pub async fn execute_check(&self, cmd: &[&str], cwd: Option<&Path>) -> Result<String> {
        let (code, out) = self.execute(cmd, cwd, false).await?;
        if code != 0 {
            anyhow::bail!("command `{}` failed (code {code}):\n{out}", cmd.join(" "));
        }
        Ok(out)
    }

    pub async fn ensure_paths(&self, paths: &[PathBuf]) -> Result<()> {
        match self {
            Env::Local(e) => e.ensure_paths(paths).await,
            Env::Wsl(e) => e.ensure_paths(paths).await,
        }
    }

    #[allow(dead_code)]
    pub async fn copy_files(&self, src: &Path, dst: &Path) -> Result<()> {
        match self {
            Env::Local(e) => e.copy_files(src, dst).await,
            Env::Wsl(_) => LocalEnv::new().copy_files(src, dst).await,
        }
    }
}
