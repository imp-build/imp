use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use futures::stream::{FuturesUnordered, StreamExt};

use crate::env::Env;
use crate::workspace::{self, Target};

type Tree = Arc<prodash::tree::Root>;

// ---------------------------------------------------------------------------
// Build modes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum BuildMode {
    Debug,
    Quick,
    Release,
    Shipping,
    Msan,
    Asan,
}

impl BuildMode {
    pub fn flags(self) -> &'static [&'static str] {
        match self {
            BuildMode::Debug => &["-debug"],
            BuildMode::Quick => &["-linker:lld", "-debug"],
            BuildMode::Release => &["-o:speed", "-no-bounds-check"],
            BuildMode::Shipping => &["-o:speed", "-no-bounds-check", "-define:SHIPPING=true"],
            BuildMode::Msan => &["-o:minimal", "-debug", "-sanitize:memory"],
            BuildMode::Asan => &["-o:minimal", "-debug", "-sanitize:address"],
        }
    }
}

impl std::fmt::Display for BuildMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            BuildMode::Debug => "debug",
            BuildMode::Quick => "quick",
            BuildMode::Release => "release",
            BuildMode::Shipping => "shipping",
            BuildMode::Msan => "msan",
            BuildMode::Asan => "asan",
        };
        write!(f, "{s}")
    }
}

// ---------------------------------------------------------------------------
// Core build primitive
// ---------------------------------------------------------------------------

pub async fn build_one(
    env: &Env,
    path: &str,
    mode: BuildMode,
    output_name: Option<&str>,
    extra_flags: &[String],
    file: bool,
    progress: &mut prodash::tree::Item,
) -> Result<PathBuf> {
    let output_name = output_name.unwrap_or(path);
    let mut output = workspace::build_dir().join(output_name);
    if env.is_windows() {
        output.set_extension("exe");
    }

    env.ensure_paths(&[output.parent().unwrap().to_owned()])
        .await?;

    let odin = if env.is_windows() {
        workspace::odin_bin_windows()
    } else {
        workspace::odin_bin()
    };

    let odin_str = odin.to_string_lossy().into_owned();
    let out_str = output.to_string_lossy().into_owned();
    let out_flag = format!("-out:{out_str}");

    let mut cmd: Vec<&str> = vec![
        &odin_str,
        "build",
        path,
        &out_flag,
        "-collection:lib=library",
        "-collection:root=.",
    ];
    cmd.extend_from_slice(mode.flags());
    let extra_refs: Vec<&str> = extra_flags.iter().map(|s| s.as_str()).collect();
    cmd.extend_from_slice(&extra_refs);
    if file {
        cmd.push("-file");
    }

    progress.set_name(format!("building {path} ({mode})"));

    let (code, out) = env
        .execute(&cmd, Some(&workspace::root_dir()), false)
        .await?;
    if code != 0 {
        // Stream each compiler line as a prodash message so it appears in the
        // scrolling log area above the progress bars, not as a raw eprintln!.
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            progress.message(prodash::messages::MessageLevel::Failure, line.to_owned());
        }
        // The prodash messages above get truncated to terminal width and scroll
        // out of view, which can hide the actual error (e.g. a linker line).
        // Include the full output in the bailed error so it prints in full after
        // the render is torn down.
        bail!("odin build failed: {path} ({mode})\n{}", out.trim_end());
    }
    Ok(output)
}

// ---------------------------------------------------------------------------
// Syntax check (odin check) with the project's collections
// ---------------------------------------------------------------------------

pub async fn cmd_check(env: &Env, path: &str, tree: &Tree) -> Result<()> {
    let odin = if env.is_windows() {
        workspace::odin_bin_windows()
    } else {
        workspace::odin_bin()
    };
    let odin_str = odin.to_string_lossy().into_owned();

    // `lib:jodin` resolves to library/jodin, which is generated from the
    // vendor submodule; stage it so the check can resolve the import without
    // requiring the native .so to be built.
    stage_jodin_bindings()?;

    let mut p = tree.add_child(format!("odin check {path}"));
    let cmd = vec![
        odin_str.as_str(),
        "check",
        path,
        "-collection:lib=library",
        "-collection:root=.",
    ];
    let (code, out) = env
        .execute(&cmd, Some(&workspace::root_dir()), false)
        .await?;
    if code != 0 {
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            p.message(prodash::messages::MessageLevel::Failure, line.to_owned());
        }
        bail!("odin check failed: {path}");
    }
    p.done("ok");
    Ok(())
}

// ---------------------------------------------------------------------------
// Native dependency: jodin (libjolt_odin.so via cmake)
// ---------------------------------------------------------------------------

pub async fn build_jodin(progress: &mut prodash::tree::Item) -> Result<()> {
    let jodin_src = workspace::jodin_dir();
    let cmake_build = workspace::build_dir().join("jodin-build");
    let src_str = jodin_src.to_string_lossy().into_owned();
    let build_str = cmake_build.to_string_lossy().into_owned();
    let local = crate::env::LocalEnv::new();

    let odin = if crate::env::LocalEnv::is_windows() {
        workspace::odin_bin_windows()
    } else {
        workspace::odin_bin()
    };
    let odin_def = format!("-DODIN_EXE={}", odin.display());

    progress.set_name("cmake configure jodin");
    let (code, out) = local
        .execute(
            &[
                "cmake",
                "-S",
                &src_str,
                "-B",
                &build_str,
                "-DCMAKE_BUILD_TYPE=Debug",
                // Match Jolt's CRT to the shim's: Jolt defaults to the static
                // MSVC runtime (/MTd) but only sets it in its own subdirectory
                // scope, so the shim stays on the dynamic CRT (/MDd) and the
                // link fails with RuntimeLibrary mismatches. Force Jolt dynamic.
                // MSVC-gated upstream, so it's a no-op on non-Windows.
                "-DUSE_STATIC_MSVC_RUNTIME_LIBRARY=OFF",
                &odin_def,
            ],
            None,
            false,
        )
        .await?;
    if code != 0 {
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            progress.message(prodash::messages::MessageLevel::Failure, line.to_owned());
        }
        anyhow::bail!("cmake configure failed for jodin");
    }

    progress.set_name("cmake build jodin");
    let (code, out) = local
        .execute(&["cmake", "--build", &build_str, "--parallel"], None, false)
        .await?;
    if code != 0 {
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            progress.message(prodash::messages::MessageLevel::Failure, line.to_owned());
        }
        anyhow::bail!("cmake build failed for jodin");
    }

    // cmake's POST_BUILD copies the shim artifacts to vendor/jodin/ under their
    // native names. Distribute them:
    //   library/jodin/  — odin package (lib:jodin) + the link artifact that the
    //                     binding's `foreign import` resolves (.so on Linux, the
    //                     import .lib on Windows) + the runtime lib
    //   build/          — the runtime lib (.so/.dll) for running in place
    let lib_jodin = workspace::root_dir().join("library/jodin");
    stage_jodin_bindings()?;

    let runtime_name = jodin_runtime_lib();
    let link_name = jodin_link_lib();

    // Link artifact beside the bindings (Odin resolves `foreign import` there).
    let link_src = jodin_src.join(link_name);
    std::fs::copy(&link_src, lib_jodin.join(link_name))
        .with_context(|| format!("copy {}", link_src.display()))?;

    // Runtime artifact beside the bindings and in build/ for run-in-place.
    let runtime_src = jodin_src.join(runtime_name);
    for dest in [
        lib_jodin.join(runtime_name),
        workspace::build_dir().join(runtime_name),
    ] {
        std::fs::copy(&runtime_src, &dest)
            .with_context(|| format!("copy {} -> {}", runtime_src.display(), dest.display()))?;
    }

    Ok(())
}

/// Name of the jodin runtime shared library (loaded at run time).
fn jodin_runtime_lib() -> &'static str {
    if crate::env::LocalEnv::is_windows() {
        "jolt_odin.dll"
    } else {
        "libjolt_odin.so"
    }
}

/// Name of the jodin link artifact that `foreign import` resolves. On Windows
/// this is the import library; on Linux the shared object serves both roles.
fn jodin_link_lib() -> &'static str {
    if crate::env::LocalEnv::is_windows() {
        "jolt_odin.lib"
    } else {
        "libjolt_odin.so"
    }
}

/// Stage the generated Odin bindings from vendor/jodin/out into library/jodin
/// (the `lib:jodin` package), rewriting the foreign import path. This is the
/// part of the jodin build that `odin check` needs; it does not require the
/// native .so to be built.
pub fn stage_jodin_bindings() -> Result<()> {
    let jodin_src = workspace::jodin_dir();
    let lib_jodin = workspace::root_dir().join("library/jodin");
    std::fs::create_dir_all(&lib_jodin)
        .with_context(|| format!("create {}", lib_jodin.display()))?;

    for entry in std::fs::read_dir(jodin_src.join("out"))? {
        let entry = entry?;
        if entry.path().extension() == Some(std::ffi::OsStr::new("odin")) {
            let content = std::fs::read_to_string(entry.path())?;
            // Rewrite the foreign import to be relative to library/jodin/ and
            // pick the right link artifact per OS (vendor/jodin/out/*.odin uses
            // "../libjolt_odin.so"): the import library on Windows, the shared
            // object elsewhere.
            let patched = content.replace(
                "foreign import jolt_shim \"../libjolt_odin.so\"",
                "when ODIN_OS == .Windows {\n\tforeign import jolt_shim \"./jolt_odin.lib\"\n} else {\n\tforeign import jolt_shim \"./libjolt_odin.so\"\n}",
            );
            let dest = lib_jodin.join(entry.file_name());
            std::fs::write(&dest, patched)
                .with_context(|| format!("write odin file -> {}", dest.display()))?;
        }
    }
    Ok(())
}

pub fn copy_jodin_beside(outputs: &[PathBuf]) -> Result<()> {
    let runtime_name = jodin_runtime_lib();
    let src = workspace::build_dir().join(runtime_name);
    if !src.exists() {
        return Ok(());
    }

    for out in outputs {
        if let Some(dir) = out.parent() {
            let dest = dir.join(runtime_name);
            if dest != src {
                std::fs::copy(&src, &dest)
                    .with_context(|| format!("copy {runtime_name} -> {}", dest.display()))?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Build command
// ---------------------------------------------------------------------------

pub async fn cmd_build(
    env: &Env,
    mode: BuildMode,
    target_filter: Option<&str>,
    tree: &Tree,
) -> Result<()> {
    let mut jodin_p = tree.add_child("build jodin");
    build_jodin(&mut jodin_p).await?;
    jodin_p.done("libjolt_odin.so ready");

    let targets = workspace::get_targets()?;
    let targets: Vec<Target> = match target_filter {
        Some(name) => {
            let filtered: Vec<_> = targets.into_iter().filter(|t| t.name == name).collect();
            if filtered.is_empty() {
                bail!("target '{name}' not found");
            }
            filtered
        }
        None => targets,
    };

    let mut set: FuturesUnordered<_> = targets
        .iter()
        .map(|target| {
            let path_str = target.path.to_string_lossy().into_owned();
            let out_name = format!("{}/{}_{}", target.path.to_string_lossy(), target.name, mode);
            let name = target.name.clone();
            let options = target.options.clone();
            let file = target.file;
            let mut p = tree.add_child(format!("build {name}"));
            async move {
                let result = build_one(
                    env,
                    &path_str,
                    mode,
                    Some(&out_name),
                    &options,
                    file,
                    &mut p,
                )
                .await;
                (name, result, p)
            }
        })
        .collect();

    let mut first_err: Option<anyhow::Error> = None;
    let mut outputs: Vec<PathBuf> = Vec::new();
    while let Some((name, result, mut p)) = set.next().await {
        match result {
            Ok(out) => {
                p.done(format!("→ {}", out.display()));
                outputs.push(out);
            }
            Err(e) => {
                p.fail(format!("FAILED: {e}"));
                first_err.get_or_insert_with(|| anyhow::anyhow!("build {name} failed: {e}"));
            }
        }
    }
    if let Some(e) = first_err {
        return Err(e);
    }

    // Copy libjolt_odin.so alongside each binary (RUNPATH=$ORIGIN).
    copy_jodin_beside(&outputs)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Run command
// ---------------------------------------------------------------------------

pub async fn cmd_run(env: &Env, mode: BuildMode, extra_args: &[String], tree: &Tree) -> Result<()> {
    let mut jodin_p = tree.add_child("build jodin");
    build_jodin(&mut jodin_p).await?;
    jodin_p.done("libjolt_odin.so ready");

    let ottar = workspace::ottar_dir();
    let path_str = ottar.to_string_lossy().into_owned();
    let output_name = format!("ottar/ottar_{mode}");

    let mut build_p = tree.add_child("build ottar");
    let output = build_one(
        env,
        &path_str,
        mode,
        Some(&output_name),
        &[],
        false,
        &mut build_p,
    )
    .await?;
    build_p.done(format!("→ {}", output.display()));

    let mut run_p = tree.add_child(format!("run {}", output.display()));
    run_p.set_name("running...");
    let out_str = output.to_string_lossy().into_owned();
    let mut cmd = vec![out_str.as_str()];
    let extra_refs: Vec<&str> = extra_args.iter().map(|s| s.as_str()).collect();
    cmd.extend_from_slice(&extra_refs);

    let (code, _) = env
        .execute(&cmd, Some(&workspace::root_dir()), true)
        .await?;
    if code != 0 {
        run_p.fail(format!("exit code {code}"));
        bail!("game exited with code {code}");
    }
    run_p.done("exited 0");
    Ok(())
}
