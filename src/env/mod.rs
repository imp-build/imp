pub mod file_tracker;
pub mod local;
pub mod wsl;

use std::path::Path;

use anyhow::Result;

pub use local::LocalEnv;
pub use wsl::WslEnv;

/// Unified execution environment – either local or WSL cross-compile.
pub enum Env {
    Local(LocalEnv),
    Wsl(WslEnv),
}

impl Env {
    #[allow(dead_code)]
    pub async fn copy_files(&self, src: &Path, dst: &Path) -> Result<()> {
        match self {
            Env::Local(e) => e.copy_files(src, dst).await,
            Env::Wsl(_) => LocalEnv::new().copy_files(src, dst).await,
        }
    }
}
