use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Result};

use crate::commands::build::{build_one, BuildMode};
use crate::env::Env;
use crate::workspace;

type Tree = Arc<prodash::tree::Root>;

fn content_pak() -> PathBuf {
    workspace::dist_dir().join("content.pak")
}

pub async fn cmd_package(
    env: &Env,
    platforms: &[String],
    version: &str,
    skip_content_build: bool,
    tree: &Tree,
) -> Result<()> {
    let local = crate::env::LocalEnv::new();
    local.ensure_paths(&[workspace::dist_dir()]).await?;

    // Clean dist/
    let mut clean_p = tree.add_child("clean dist/");
    let dist = workspace::dist_dir();
    if dist.is_dir() {
        for entry in std::fs::read_dir(&dist)? {
            let entry = entry?;
            let p = entry.path();
            if p.is_dir() {
                std::fs::remove_dir_all(&p)?;
            } else {
                std::fs::remove_file(&p)?;
            }
        }
    }
    clean_p.done("cleaned");

    if !skip_content_build {
        let mut packer_p = tree.add_child("build vfs-pack");
        let packer = build_one(
            env,
            "tools/pack/",
            BuildMode::Debug,
            Some("vfs-pack"),
            &[],
            false,
            &mut packer_p,
        )
        .await?;
        packer_p.done(format!("→ {}", packer.display()));

        let mut pack_p = tree.add_child("pack content");
        let pak = content_pak();
        let packer_str = packer.to_string_lossy().into_owned();
        let pak_str = pak.to_string_lossy().into_owned();
        env.execute_check(
            &[&packer_str, "pack", "content", &pak_str],
            Some(&workspace::root_dir()),
        )
        .await?;
        pack_p.done(format!("→ {}", pak.display()));
    }

    for platform in platforms {
        let mut p = tree.add_child(format!("release {platform} v{version}"));
        let release_dir = workspace::dist_dir().join(format!("ottar-{platform}-{version}"));
        local.ensure_paths(&[release_dir.clone()]).await?;

        let is_win = platform == "windows";
        let game_exe = workspace::build_dir().join(if is_win {
            "ottar/ottar_shipping.exe"
        } else {
            "ottar/ottar_shipping"
        });
        let game_out = release_dir.join(if is_win { "ottar.exe" } else { "ottar" });
        let pak = content_pak();

        let mut files: Vec<(PathBuf, PathBuf)> =
            vec![(pak, release_dir.join("content.pak")), (game_exe, game_out)];

        let content_dir = workspace::root_dir().join("content");
        if content_dir.is_dir() {
            for entry in std::fs::read_dir(&content_dir)? {
                let entry = entry?;
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if name.starts_with("License") && name.ends_with(".txt") {
                    files.push((path.clone(), release_dir.join(path.file_name().unwrap())));
                }
            }
        }

        for (i, (src, dst)) in files.iter().enumerate() {
            p.set_name(format!(
                "[{}/{} {}]",
                i + 1,
                files.len(),
                src.file_name().unwrap_or_default().to_string_lossy()
            ));
            local.copy_files(src, dst).await?;
        }

        p.set_name(format!("zipping {platform}"));
        let zip_name = workspace::dist_dir().join(format!("ottar-{platform}-{version}.zip"));
        zip_directory(&release_dir, &zip_name)?;
        p.done(format!("→ {}", zip_name.display()));
    }
    Ok(())
}

fn zip_directory(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    let dst_str = dst.to_string_lossy().into_owned();
    let status = std::process::Command::new("zip")
        .args(["-r", &dst_str, "."])
        .current_dir(src)
        .status()?;
    if !status.success() {
        bail!("zip failed for {}", src.display());
    }
    Ok(())
}
