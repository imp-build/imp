use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use crate::env::LocalEnv;
use crate::workspace;

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
            let status = extract_zip(archive, dest, strip_components)?;
            if !status.success() {
                bail!("unzip extraction of {} failed", archive.display());
            }
        }
        other => bail!("unsupported archive format: {other}"),
    }

    Ok(())
}

#[cfg(not(windows))]
fn extract_zip(
    archive: &Path,
    dest: &Path,
    _strip_components: u32,
) -> Result<std::process::ExitStatus> {
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
fn extract_zip(
    archive: &Path,
    dest: &Path,
    _strip_components: u32,
) -> Result<std::process::ExitStatus> {
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
    let output = std::process::Command::new("sha256sum")
        .arg(path)
        .output()
        .with_context(|| format!("spawn sha256sum for {}", path.display()))?;
    if !output.status.success() {
        bail!("sha256sum failed for {}", path.display());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.split_whitespace().next().unwrap_or("").to_owned())
}

// ---------------------------------------------------------------------------
// Existing Odin-specific setup (kept for backward compat)
// ---------------------------------------------------------------------------

pub async fn setup_odin(progress: &mut prodash::tree::Item) -> Result<()> {
    let version = workspace::odin_version();
    let install_dir = workspace::toolchain_dir().join(&version).join("odin");
    if install_dir.is_dir() {
        progress.set_name(format!("toolchain: odin {version} already installed"));
        return Ok(());
    }

    let (plat, arch) = detect_platform()?;
    let artifact = format!("odin-{plat}-{arch}-{version}.tar.gz");
    let url = format!("https://github.com/odin-lang/Odin/releases/download/{version}/{artifact}");

    let staging = workspace::toolchain_dir().join(&version);
    LocalEnv::new().ensure_paths(&[staging.clone()]).await?;

    progress.set_name(format!(
        "toolchain: downloading odin {version} ({plat}/{arch})"
    ));

    let staging_str = staging.to_string_lossy().into_owned();
    let (code, out) = LocalEnv::new()
        .execute(
            &[
                "bash",
                "-c",
                &format!(r#"curl -fSL "{url}" | tar xz -C "{staging_str}""#),
            ],
            Some(&workspace::root_dir()),
            false,
        )
        .await?;
    if code != 0 {
        bail!("failed to download Odin: {out}");
    }

    // Tarball extracts to odin-linux-amd64-dev-YYYY-MM; rename to "odin"
    let extracted: Vec<_> = staging
        .read_dir()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name();
            let s = n.to_string_lossy();
            e.path().is_dir() && s.starts_with("odin-") && s != "odin-windows"
        })
        .collect();

    if extracted.len() != 1 {
        bail!(
            "expected one extracted directory, found: {:?}",
            extracted.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
    }
    std::fs::rename(extracted[0].path(), &install_dir)?;
    progress.set_name(format!("toolchain: odin {version} installed"));
    Ok(())
}

pub async fn setup_odin_windows(progress: &mut prodash::tree::Item) -> Result<()> {
    let version = workspace::odin_version();
    let install_dir = workspace::toolchain_dir()
        .join(&version)
        .join("odin-windows");
    if install_dir.is_dir() {
        progress.set_name(format!(
            "toolchain: odin-windows {version} already installed"
        ));
        return Ok(());
    }

    let artifact = format!("odin-windows-amd64-{version}.zip");
    let url = format!("https://github.com/odin-lang/Odin/releases/download/{version}/{artifact}");

    let staging = workspace::toolchain_dir().join(&version);
    LocalEnv::new().ensure_paths(&[staging.clone()]).await?;

    progress.set_name(format!("toolchain: downloading odin-windows {version}"));

    let staging_str = staging.to_string_lossy().into_owned();

    #[cfg(windows)]
    {
        let tmpzip = staging.join("odin-windows-download.zip");
        let tmpzip_str = tmpzip.to_string_lossy().into_owned();
        let (code, out) = LocalEnv::new()
            .execute(
                &["curl.exe", "-fSL", &url, "-o", &tmpzip_str],
                Some(&workspace::root_dir()),
                false,
            )
            .await?;
        if code != 0 {
            bail!("failed to download Odin Windows: {out}");
        }
        let expand = format!(
            "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
            tmpzip_str.replace('\'', "''"),
            staging_str.replace('\'', "''"),
        );
        let (code, out) = LocalEnv::new()
            .execute(
                &["powershell", "-Command", &expand],
                Some(&workspace::root_dir()),
                false,
            )
            .await?;
        if code != 0 {
            bail!("failed to extract Odin Windows: {out}");
        }
        let _ = std::fs::remove_file(&tmpzip);
    }
    #[cfg(not(windows))]
    {
        let cmd = format!(
            r#"tmpzip="$(mktemp)" && curl -fSL "{url}" -o "$tmpzip" && unzip -qo "$tmpzip" -d "{staging_str}" && rm "$tmpzip""#
        );
        let (code, out) = LocalEnv::new()
            .execute(&["bash", "-c", &cmd], Some(&workspace::root_dir()), false)
            .await?;
        if code != 0 {
            bail!("failed to download Odin Windows: {out}");
        }
    }

    // Zip extracts to "dist/"; rename to "odin-windows"
    let dist_dir = staging.join("dist");
    if !dist_dir.is_dir() {
        bail!("expected 'dist' directory in {staging_str} after extraction");
    }
    std::fs::rename(&dist_dir, &install_dir)?;
    progress.set_name(format!("toolchain: odin-windows {version} installed"));
    Ok(())
}

// odinfmt is distributed inside the OLS release zips, whose tags track Odin's
// monthly dev versions, so we pin it to the same `.odin-version`.
pub async fn setup_odinfmt(progress: &mut prodash::tree::Item) -> Result<()> {
    let version = workspace::odin_version();
    let exe = if cfg!(windows) {
        "odinfmt.exe"
    } else {
        "odinfmt"
    };
    let install_dir = workspace::toolchain_dir().join(&version).join("odinfmt");
    let dest = install_dir.join(exe);
    if dest.is_file() {
        progress.set_name(format!("toolchain: odinfmt {version} already installed"));
        return Ok(());
    }

    let triple = odinfmt_triple()?;
    let bin_in_zip = format!(
        "odinfmt-{triple}{}",
        if cfg!(windows) { ".exe" } else { "" }
    );
    let url =
        format!("https://github.com/DanielGavin/ols/releases/download/{version}/ols-{triple}.zip");

    LocalEnv::new().ensure_paths(&[install_dir.clone()]).await?;
    progress.set_name(format!(
        "toolchain: downloading odinfmt {version} ({triple})"
    ));

    let install_str = install_dir.to_string_lossy().into_owned();

    #[cfg(windows)]
    {
        let tmpzip = install_dir.join("odinfmt-download.zip");
        let tmpzip_str = tmpzip.to_string_lossy().into_owned();
        let (code, out) = LocalEnv::new()
            .execute(
                &["curl.exe", "-fSL", &url, "-o", &tmpzip_str],
                Some(&workspace::root_dir()),
                false,
            )
            .await?;
        if code != 0 {
            bail!("failed to download odinfmt: {out}");
        }
        // bsdtar (tar.exe) reads zips and can extract a single entry.
        let (code, out) = LocalEnv::new()
            .execute(
                &[
                    "tar.exe",
                    "-xf",
                    &tmpzip_str,
                    "-C",
                    &install_str,
                    &bin_in_zip,
                ],
                Some(&workspace::root_dir()),
                false,
            )
            .await?;
        if code != 0 {
            bail!("failed to extract odinfmt: {out}");
        }
        let _ = std::fs::remove_file(&tmpzip);
    }
    #[cfg(not(windows))]
    {
        let cmd = format!(
            r#"tmpzip="$(mktemp)" && curl -fSL "{url}" -o "$tmpzip" && unzip -qo -j "$tmpzip" "{bin_in_zip}" -d "{install_str}" && rm "$tmpzip""#
        );
        let (code, out) = LocalEnv::new()
            .execute(&["bash", "-c", &cmd], Some(&workspace::root_dir()), false)
            .await?;
        if code != 0 {
            bail!("failed to download odinfmt: {out}");
        }
    }

    std::fs::rename(install_dir.join(&bin_in_zip), &dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms)?;
    }

    progress.set_name(format!("toolchain: odinfmt {version} installed"));
    Ok(())
}

pub async fn setup_toolchains(progress: &mut prodash::tree::Item, windows: bool) -> Result<()> {
    if cfg!(windows) {
        setup_odin_windows(progress).await?;
    } else {
        setup_odin(progress).await?;
        if windows {
            setup_odin_windows(progress).await?;
        }
    }
    setup_odinfmt(progress).await?;
    Ok(())
}

fn odinfmt_triple() -> Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "arm64-unknown-linux-gnu",
        ("macos", "x86_64") => "x86_64-darwin",
        ("macos", "aarch64") => "arm64-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        (os, arch) => bail!("no odinfmt build for {os}/{arch}"),
    })
}

fn detect_platform() -> Result<(&'static str, &'static str)> {
    let plat = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        bail!("unsupported OS for toolchain download")
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "amd64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        bail!("unsupported architecture for toolchain download")
    };

    Ok((plat, arch))
}
