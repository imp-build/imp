use std::path::PathBuf;

use anyhow::Result;

pub async fn run(out_path: &PathBuf) -> Result<()> {
    crate::codegen::update_module_list_to(out_path).await
}
