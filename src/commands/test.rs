// MIGRATING: see rules/workflows/test.js

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Result};

use crate::commands::build::{build_jodin, build_one, copy_jodin_beside, BuildMode};
use crate::env::Env;
use crate::workspace;

type Tree = Arc<prodash::tree::Root>;

pub async fn cmd_test(env: &Env, tree: &Tree) -> Result<()> {
    let mut jodin_p = tree.add_child("build jodin");
    build_jodin(&mut jodin_p).await?;
    jodin_p.done("libjolt_odin.so ready");

    let test_configs = workspace::get_test_configs()?;
    if test_configs.is_empty() {
        println!("No test packages found.");
        return Ok(());
    }

    let mut binaries: Vec<PathBuf> = Vec::new();
    for config in &test_configs {
        let pkg_str = config.package.to_string_lossy().into_owned();
        let mut flags = config.options.clone();
        flags.push("-build-mode:test".into());
        let out_name = format!("{}/test_binary", pkg_str);
        let mut p = tree.add_child(format!("build test {pkg_str}"));
        let binary = build_one(
            env,
            &pkg_str,
            BuildMode::Debug,
            Some(&out_name),
            &flags,
            false,
            &mut p,
        )
        .await?;
        p.done(format!("→ {}", binary.display()));
        binaries.push(binary);
    }
    copy_jodin_beside(&binaries)?;

    let mut passed = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for binary in &binaries {
        let bin_str = binary.to_string_lossy().into_owned();
        let mut p = tree.add_child(format!("run test {bin_str}"));
        p.set_name("running...");
        let (code, out) = env
            .execute(&[&bin_str], Some(&workspace::root_dir()), false)
            .await?;
        if code == 0 {
            p.done("PASSED");
            passed += 1;
        } else {
            p.fail("FAILED");
            failures.push(format!("{bin_str}:\n{out}"));
        }
    }

    let total = binaries.len();
    let mut summary = tree.add_child("test results");
    if failures.is_empty() {
        summary.done(format!("passed {passed}/{total}"));
        Ok(())
    } else {
        for f in &failures {
            summary.message(prodash::messages::MessageLevel::Failure, f.clone());
        }
        summary.fail(format!("{} of {total} suite(s) failed", failures.len()));
        bail!("{} test suite(s) failed", failures.len());
    }
}

pub async fn cmd_integration_test(env: &Env, mode: BuildMode, tree: &Tree) -> Result<()> {
    let targets = workspace::get_targets()?;
    let test_main = targets
        .iter()
        .find(|t| t.name == "test_main")
        .ok_or_else(|| anyhow::anyhow!("test_main target not found"))?
        .clone();

    let path_str = test_main.path.to_string_lossy().into_owned();
    let out_name = format!(
        "{}/{}_{}",
        test_main.path.to_string_lossy(),
        test_main.name,
        mode
    );

    let mut jodin_p = tree.add_child("build jodin");
    build_jodin(&mut jodin_p).await?;
    jodin_p.done("libjolt_odin.so ready");

    let mut build_p = tree.add_child("build integration test harness");
    let output = build_one(
        env,
        &path_str,
        mode,
        Some(&out_name),
        &test_main.options,
        test_main.file,
        &mut build_p,
    )
    .await?;
    copy_jodin_beside(std::slice::from_ref(&output))?;
    build_p.done(format!("→ {}", output.display()));

    let mut run_p = tree.add_child("run integration tests");
    run_p.set_name("running...");
    let out_str = output.to_string_lossy().into_owned();
    let (code, _) = env
        .execute(
            &[&out_str, "--visual", "--all"],
            Some(&workspace::root_dir()),
            true,
        )
        .await?;

    if code == 0 {
        run_p.done("all integration tests passed");
        Ok(())
    } else {
        run_p.fail(format!("failed (code {code})"));
        bail!("integration tests failed with code {code}");
    }
}

pub async fn cmd_coverage(env: &Env, tree: &Tree) -> Result<()> {
    if cfg!(windows) {
        bail!("coverage requires kcov (Linux only)");
    }

    let kcov = workspace::kcov_bin();
    let kcov_str = kcov.to_string_lossy().into_owned();
    let local = crate::env::LocalEnv::new();

    {
        let mut p = tree.add_child("check kcov");
        let (code, _) = local
            .execute(&[&kcov_str, "--version"], None, false)
            .await
            .unwrap_or((-1, String::new()));
        if code != 0 {
            p.fail("kcov not found");
            bail!("kcov not found; install kcov for coverage");
        }
        p.done("ok");
    }

    let mut jodin_p = tree.add_child("build jodin");
    build_jodin(&mut jodin_p).await?;
    jodin_p.done("libjolt_odin.so ready");

    let test_configs = workspace::get_test_configs()?;
    let coverage_out = workspace::coverage_dir().join("kcov-out");
    let coverage_merged = workspace::coverage_dir().join("merged");

    let mut binaries: Vec<PathBuf> = Vec::new();
    for config in &test_configs {
        let pkg_str = config.package.to_string_lossy().into_owned();
        let mut flags = config.options.clone();
        flags.push("-build-mode:test".into());
        flags.push("-file".into());
        let out_name = format!("{}/test_binary_cov", pkg_str);
        let mut p = tree.add_child(format!("build {pkg_str}"));
        let binary = build_one(
            env,
            &pkg_str,
            BuildMode::Debug,
            Some(&out_name),
            &flags,
            false,
            &mut p,
        )
        .await?;
        p.done("built");
        binaries.push(binary);
    }
    copy_jodin_beside(&binaries)?;

    let mut errors: Vec<String> = Vec::new();
    for (i, binary) in binaries.iter().enumerate() {
        let bin_str = binary.to_string_lossy().into_owned();
        let kcov_out_i = coverage_out.join(format!("kcov-{i}"));
        local.ensure_paths(&[kcov_out_i.clone()]).await?;
        let kcov_out_str = kcov_out_i.to_string_lossy().into_owned();

        let mut p = tree.add_child(format!("kcov {bin_str}"));
        let (code, out) = local
            .execute(
                &[
                    &kcov_str,
                    "--collect-only",
                    "--include-path=.",
                    &kcov_out_str,
                    &bin_str,
                ],
                Some(&workspace::root_dir()),
                false,
            )
            .await?;
        if code != 0 {
            p.fail("test failed");
            errors.push(out);
        } else {
            p.done("ok");
        }
    }

    let mut merge_p = tree.add_child("merge coverage");
    local.ensure_paths(&[coverage_merged.clone()]).await?;

    let kcov_dirs: Vec<_> = std::fs::read_dir(&coverage_out)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect();

    if kcov_dirs.is_empty() {
        merge_p.fail("no reports");
        bail!("no coverage reports");
    }

    let coverage_merged_str = coverage_merged.to_string_lossy().into_owned();
    let mut merge_cmd: Vec<&str> = vec![
        &kcov_str,
        "--include-path=.",
        "--merge",
        &coverage_merged_str,
    ];
    let dir_refs: Vec<&str> = kcov_dirs.iter().map(|s| s.as_str()).collect();
    merge_cmd.extend_from_slice(&dir_refs);

    let (code, out) = local
        .execute(&merge_cmd, Some(&workspace::root_dir()), false)
        .await?;
    if code != 0 {
        merge_p.fail("merge failed");
        bail!("kcov merge failed: {out}");
    }

    let json = coverage_merged.join("kcov-merged/coverage.json");
    let md = workspace::coverage_dir().join("coverage_report.md");
    crate::coverage::generate_report(&json, &md)?;
    merge_p.done(format!("→ {}", md.display()));

    if errors.is_empty() {
        Ok(())
    } else {
        let mut ep = tree.add_child("coverage errors");
        for e in &errors {
            ep.message(prodash::messages::MessageLevel::Failure, e.clone());
        }
        ep.fail(format!("{} test(s) failed under kcov", errors.len()));
        bail!("some tests failed under kcov")
    }
}
