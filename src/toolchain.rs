use anyhow::{bail, Result};

use crate::env::LocalEnv;
use crate::workspace;

// ---------------------------------------------------------------------------
// Existing Odin-specific setup (kept for backward compat)
// ---------------------------------------------------------------------------

pub async fn setup_odin(progress: &mut indicatif::ProgressBar) -> Result<()> {
    let version = workspace::odin_version();
    let install_dir = workspace::toolchain_dir().join(&version).join("odin");
    if install_dir.is_dir() {
        progress.set_message(format!("toolchain: odin {version} already installed"));
        return Ok(());
    }

    let (plat, arch) = detect_platform()?;
    let artifact = format!("odin-{plat}-{arch}-{version}.tar.gz");
    let url = format!("https://github.com/odin-lang/Odin/releases/download/{version}/{artifact}");

    let staging = workspace::toolchain_dir().join(&version);
    LocalEnv::new().ensure_paths(&[staging.clone()]).await?;

    progress.set_message(format!(
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
    progress.set_message(format!("toolchain: odin {version} installed"));
    Ok(())
}

pub async fn setup_odin_windows(progress: &mut indicatif::ProgressBar) -> Result<()> {
    let version = workspace::odin_version();
    let install_dir = workspace::toolchain_dir()
        .join(&version)
        .join("odin-windows");
    if install_dir.is_dir() {
        progress.set_message(format!(
            "toolchain: odin-windows {version} already installed"
        ));
        return Ok(());
    }

    let artifact = format!("odin-windows-amd64-{version}.zip");
    let url = format!("https://github.com/odin-lang/Odin/releases/download/{version}/{artifact}");

    let staging = workspace::toolchain_dir().join(&version);
    LocalEnv::new().ensure_paths(&[staging.clone()]).await?;

    progress.set_message(format!("toolchain: downloading odin-windows {version}"));

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
    progress.set_message(format!("toolchain: odin-windows {version} installed"));
    Ok(())
}

// odinfmt is distributed inside the OLS release zips, whose tags track Odin's
// monthly dev versions, so we pin it to the same `.odin-version`.
pub async fn setup_odinfmt(progress: &mut indicatif::ProgressBar) -> Result<()> {
    let version = workspace::odin_version();
    let exe = if cfg!(windows) {
        "odinfmt.exe"
    } else {
        "odinfmt"
    };
    let install_dir = workspace::toolchain_dir().join(&version).join("odinfmt");
    let dest = install_dir.join(exe);
    if dest.is_file() {
        progress.set_message(format!("toolchain: odinfmt {version} already installed"));
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
    progress.set_message(format!(
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

    progress.set_message(format!("toolchain: odinfmt {version} installed"));
    Ok(())
}

pub async fn setup_toolchains(progress: &mut indicatif::ProgressBar, windows: bool) -> Result<()> {
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
