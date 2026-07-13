use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Host-accessible primitives for JS toolchain acquisition
// ---------------------------------------------------------------------------

/// Detect the current platform. Returns (os, arch) with normalized names:
/// - os: "linux", "macos", "windows"
/// - arch: "x86_64", "aarch64"
pub fn host_detect_platform() -> Result<(&'static str, &'static str)> {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        bail!("unsupported OS");
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        bail!("unsupported architecture");
    };

    Ok((os, arch))
}

/// Download a URL to a cached local file. Uses `sha256` of the URL as the cache
/// key within a temp directory so repeated downloads of the same URL are
/// served from disk without re-fetching.
pub fn host_download(url: &str) -> Result<PathBuf> {
    let download_dir = std::env::temp_dir().join("imp-downloads");
    std::fs::create_dir_all(&download_dir)
        .with_context(|| format!("create download dir {}", download_dir.display()))?;

    let filename = format!("dl-{:x}", Sha256::digest(url.as_bytes()));
    let dest = download_dir.join(&filename);

    if dest.is_file() {
        return Ok(dest);
    }

    let status = std::process::Command::new("curl")
        .args(["-fSL", "-o", &dest.to_string_lossy(), url])
        .status()
        .with_context(|| format!("spawn curl for {url}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&dest);
        bail!(
            "curl download of {url} failed with exit code {:?}",
            status.code()
        );
    }

    Ok(dest)
}

/// Extract an archive to a destination directory.
///
/// Supported `format` values: `"tar.gz"`, `"tgz"`, `"zip"`.
///
/// `strip_components` is only supported for tar.gz archives (it maps to
/// `--strip-components=N`). For zip archives with non-zero `strip_components`,
/// extraction goes to a temporary directory first and the top-level entry is
/// moved into `dest`.
pub fn host_extract(
    archive: &Path,
    dest: &Path,
    format: &str,
    strip_components: u32,
) -> Result<()> {
    let archive_str = archive.to_string_lossy();
    let dest_str = dest.to_string_lossy();

    std::fs::create_dir_all(dest)
        .with_context(|| format!("create extract dest {}", dest.display()))?;

    match format {
        "tar.gz" | "tgz" => {
            let mut cmd = std::process::Command::new("tar");
            cmd.args(["xzf", &archive_str, "-C", &dest_str]);
            if strip_components > 0 {
                cmd.arg(format!("--strip-components={strip_components}"));
            }
            let status = cmd
                .status()
                .with_context(|| format!("spawn tar for {}", archive.display()))?;
            if !status.success() {
                bail!("tar extraction of {} failed", archive.display());
            }
        }
        "zip" => {
            if strip_components == 0 {
                let status = extract_zip_raw(archive, dest)?;
                if !status.success() {
                    bail!("unzip extraction of {} failed", archive.display());
                }
            } else {
                let tmp = dest.with_file_name(format!(
                    "{}-ziptmp-{}",
                    dest.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "extract".to_owned()),
                    std::process::id()
                ));
                let _ = std::fs::remove_dir_all(&tmp);
                std::fs::create_dir_all(&tmp)
                    .with_context(|| format!("create zip staging dir {}", tmp.display()))?;

                let status = extract_zip_raw(archive, &tmp)?;
                if !status.success() {
                    let _ = std::fs::remove_dir_all(&tmp);
                    bail!("unzip extraction of {} failed", archive.display());
                }

                let result = strip_zip_components(&tmp, dest, strip_components, archive);
                let _ = std::fs::remove_dir_all(&tmp);
                result?;
            }
        }
        other => bail!("unsupported archive format: {other}"),
    }

    Ok(())
}

/// Descend `strip_components` levels of single-entry directories from `root`,
/// then move the remaining contents into `dest`. Mirrors tar's
/// `--strip-components` for zip archives, which have no native equivalent.
fn strip_zip_components(
    root: &Path,
    dest: &Path,
    strip_components: u32,
    archive: &Path,
) -> Result<()> {
    let mut current = root.to_path_buf();
    for _ in 0..strip_components {
        let mut entries: Vec<_> = std::fs::read_dir(&current)?
            .filter_map(|e| e.ok())
            .collect();
        if entries.len() != 1 || !entries[0].path().is_dir() {
            bail!(
                "cannot strip {strip_components} path component(s) from {}: expected a single top-level directory",
                archive.display()
            );
        }
        current = entries.remove(0).path();
    }

    for child in std::fs::read_dir(&current)? {
        let child = child?;
        std::fs::rename(child.path(), dest.join(child.file_name()))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn extract_zip_raw(archive: &Path, dest: &Path) -> Result<std::process::ExitStatus> {
    std::process::Command::new("unzip")
        .args([
            "-qo",
            &archive.to_string_lossy(),
            "-d",
            &dest.to_string_lossy(),
        ])
        .status()
        .with_context(|| format!("spawn unzip for {}", archive.display()))
}

#[cfg(windows)]
fn extract_zip_raw(archive: &Path, dest: &Path) -> Result<std::process::ExitStatus> {
    std::process::Command::new("tar.exe")
        .args([
            "-xf",
            &archive.to_string_lossy(),
            "-C",
            &dest.to_string_lossy(),
        ])
        .status()
        .with_context(|| format!("spawn tar.exe for {}", archive.display()))
}

/// Compute SHA-256 hex digest of a file.
pub fn host_sha256(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

/// Size in bytes of a file.
pub fn host_file_size(path: &Path) -> Result<u64> {
    Ok(std::fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .len())
}
