use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::workspace;

pub struct LocalEnv;

impl LocalEnv {
    pub fn new() -> Self {
        Self
    }

    /// Execute a command, returning (exit_code, combined_stdout+stderr).
    /// If `stream_output` is true the output is printed in real time.
    pub async fn execute(
        &self,
        cmd: &[&str],
        cwd: Option<&Path>,
        stream_output: bool,
    ) -> Result<(i32, String)> {
        let cwd: PathBuf = cwd
            .map(|p| p.to_owned())
            .unwrap_or_else(workspace::root_dir);

        let (program, args) = cmd.split_first().context("empty command")?;

        let mut child = Command::new(program)
            .args(args)
            .current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to spawn: {program}"))?;

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let mut stdout_lines = tokio::io::BufReader::new(stdout).lines();
        let mut stderr_lines = tokio::io::BufReader::new(stderr).lines();
        let mut captured = String::new();

        loop {
            tokio::select! {
                line = stdout_lines.next_line() => {
                    match line? {
                        Some(l) => {
                            if stream_output { println!("{l}"); }
                            else { captured.push_str(&l); captured.push('\n'); }
                        }
                        None => break,
                    }
                }
                line = stderr_lines.next_line() => {
                    if let Ok(Some(l)) = line {
                        if stream_output { eprintln!("{l}"); }
                        else { captured.push_str(&l); captured.push('\n'); }
                    }
                }
            }
        }
        while let Ok(Some(l)) = stderr_lines.next_line().await {
            if stream_output {
                eprintln!("{l}");
            } else {
                captured.push_str(&l);
                captured.push('\n');
            }
        }

        let status = child.wait().await?;
        Ok((status.code().unwrap_or(-1), captured))
    }

    pub async fn execute_check(
        &self,
        cmd: &[&str],
        cwd: Option<&Path>,
        stream_output: bool,
    ) -> Result<String> {
        let (code, output) = self.execute(cmd, cwd, stream_output).await?;
        if code != 0 {
            bail!(
                "command `{}` failed (code {code}):\n{output}",
                cmd.join(" ")
            );
        }
        Ok(output)
    }

    pub async fn copy_files(&self, src: &Path, dst: &Path) -> Result<()> {
        tokio::fs::copy(src, dst)
            .await
            .with_context(|| format!("copy {} -> {}", src.display(), dst.display()))?;
        Ok(())
    }

    pub async fn ensure_paths(&self, paths: &[PathBuf]) -> Result<()> {
        for p in paths {
            tokio::fs::create_dir_all(p)
                .await
                .with_context(|| format!("create_dir_all {}", p.display()))?;
        }
        Ok(())
    }
}
