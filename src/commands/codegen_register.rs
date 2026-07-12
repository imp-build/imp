use std::path::Path;

use anyhow::Result;

pub async fn run(out_path: &Path) -> Result<()> {
    crate::codegen::update_module_list_to(out_path).await
}
