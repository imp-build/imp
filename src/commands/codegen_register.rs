use std::path::Path;

use anyhow::Result;

pub async fn run(out_path: &Path, odinfmt: &Path) -> Result<()> {
    crate::codegen::update_module_list_to(out_path, odinfmt).await
}
