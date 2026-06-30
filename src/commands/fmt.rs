// MIGRATING: see rules/workflows/fmt.js

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;

use crate::env::LocalEnv;
use crate::workspace;

type Tree = Arc<prodash::tree::Root>;

pub async fn cmd_fmt(tree: &Tree) -> Result<()> {
    let odin_files = workspace::get_odin_files();

    let mut dirs: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for file in &odin_files {
        if let Some(parent) = file.parent() {
            dirs.entry(parent.to_owned())
                .or_default()
                .push(file.clone());
        }
    }

    let odinfmt = workspace::odinfmt_bin();
    let odinfmt_str = odinfmt.to_string_lossy().into_owned();
    let local = LocalEnv::new();
    let mut top_p = tree.add_child(format!("fmt {} files", odin_files.len()));

    for (dir, files) in &dirs {
        let dir_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dir.to_string_lossy().into_owned());
        let mut p = tree.add_child(format!("fmt {dir_name}"));

        for (i, file) in files.iter().enumerate() {
            let file_str = file.to_string_lossy().into_owned();
            p.set_name(format!(
                "[{}/{}] {}",
                i + 1,
                files.len(),
                file.file_name().unwrap_or_default().to_string_lossy()
            ));
            local
                .execute_check(&[&odinfmt_str, "-w", &file_str], None, false)
                .await
                .map_err(|e| anyhow::anyhow!("fmt failed for {file_str}: {e}"))?;
        }
        p.done(format!("{} files", files.len()));
    }

    top_p.done("done");
    Ok(())
}
