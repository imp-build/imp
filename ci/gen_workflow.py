#!/usr/bin/env python3
"""Generates the repository's GitHub workflows from structured job/step data.

A small, stdlib-only stand-in for the codegen->workspace pattern this repo's
imp supports via generatedFiles()/writeWorkspace() — see //ci:docs_workflow
in ci/BUILD.js. `imp generate //ci:docs_workflow --check` fails the
build if this script's output ever drifts from the committed workflow files.

Jobs chain: `build` compiles the imp binary once and uploads it as an
artifact; `check`, `package`, and `deploy` download that artifact and run it
"installed" instead of each doing their own cargo build/run.

The release workflow builds packaged Linux and Windows binaries for main pushes
and version tags. Main pushes update one rolling draft release, while version
tags create a separate versioned draft release from the same artifacts.
"""

import sys

SITE_TARGET = "//docs:site"
SITE_CHECK_TARGET = "//ci:docs_workflow"
SITE_ARTIFACT_PATH = "dist/docs/site/public"
RUST_TOOLCHAIN = "stable"
IMP_ARTIFACT = "imp-linux"
MAIN_PUSH_ONLY = "github.ref == 'refs/heads/main' && github.event_name == 'push'"
MANUAL_ONLY = "github.event_name == 'workflow_dispatch'"
LINUX_TARGET = "x86_64-unknown-linux-musl"
WINDOWS_TARGET = "x86_64-pc-windows-msvc"
LINUX_ARCHIVE = f"imp-{LINUX_TARGET}.tar.gz"
WINDOWS_ARCHIVE = f"imp-{WINDOWS_TARGET}.zip"
ROLLING_RELEASE_TAG = "main-preview"
TAG_PUSH_ONLY = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"

DOWNLOAD_IMP_STEPS = [
    {
        "name": "Download imp binary",
        "uses": "actions/download-artifact@v4",
        "with": {"name": IMP_ARTIFACT, "path": "."},
    },
    {"name": "Make imp executable", "run": "chmod +x imp"},
]

FULL_HISTORY_CHECKOUT = {
    "uses": "actions/checkout@v4",
    "with": {"fetch-depth": 0},
}

# Everything that ends up inside the compiled binary. Notably NOT `rules/**`:
# the rule library ships beside the binary and is read from disk at runtime, so
# a rules-only change doesn't produce a different executable. `crates/**/*.js`
# stays because imp_core.js is still include_str!'d.
#
# kache already makes the *compile* mostly incremental, but a 99% cache hit
# still costs ~3.5min of rustc replay plus linking. Most pushes touch no Rust
# at all, so cache the linked artifact itself and skip the job's work outright.
IMP_BINARY_HASH = (
    "${{ hashFiles('crates/**/*.rs', 'crates/**/*.js', "
    "'**/Cargo.toml', 'Cargo.lock') }}"
)
IMP_BINARY_CACHE_MISS = "steps.imp-binary.outputs.cache-hit != 'true'"

BUILD_STEPS = [
    {"uses": "actions/checkout@v4"},
    {
        "name": "Cache imp binary",
        "id": "imp-binary",
        "uses": "actions/cache@v4",
        "with": {
            "path": "target/release/imp",
            "key": f"imp-binary-v1-${{{{ runner.os }}}}-{IMP_BINARY_HASH}",
        },
    },
    {
        "uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}",
        "if": IMP_BINARY_CACHE_MISS,
    },
    {
        "uses": "kunobi-ninja/kache-action@v1",
        "if": IMP_BINARY_CACHE_MISS,
        "with": {"cache-executables": True},
    },
    {
        "name": "Build imp",
        "if": IMP_BINARY_CACHE_MISS,
        "run": "cargo build --release --manifest-path crates/imp/Cargo.toml",
    },
    {
        "name": "Upload imp binary",
        "uses": "actions/upload-artifact@v4",
        "with": {"name": IMP_ARTIFACT, "path": "target/release/imp"},
    },
]


# The `shared` named-cache scope is the acquired-toolchain slice of the store
# (rustup/cargo homes plus every fetched gcc/zig/odin/cmake/uv/... toolchain,
# ~2.4GiB). Unlike the CAS it is a pure function of the pins in the lock files,
# so it gets a *stable* key with no run_id: after the first run the primary key
# hits exactly, and actions/cache skips saving on an exact hit — which is the
# whole point. Under the single run_id-keyed cache below, these same immutable
# bytes were re-tarred and re-uploaded on every run, ~23x/day.
#
# The key must cover Cargo.lock as well as the toolchain locks: cargo-home
# lives in this scope and tracks dependency churn, so a lockfile bump has to
# rotate the key or newly-vendored crates would never persist.
TOOLCHAIN_SCOPE_PATH = "~/.cache/imp/named/shared"
TOOLCHAIN_PINS_HASH = (
    "${{ hashFiles('imp.workspace.js', 'rules/**/*.lock', 'Cargo.lock') }}"
)


def cache_toolchains_step(job):
    prefix = f"imp-toolchains-v1-{job}-${{{{ runner.os }}}}"
    return {
        "name": "Cache imp toolchains",
        "uses": "actions/cache@v4",
        "with": {
            "path": TOOLCHAIN_SCOPE_PATH,
            "key": f"{prefix}-{TOOLCHAIN_PINS_HASH}",
            "restore-keys": f"{prefix}-",
        },
    }


# The rest of what imp-store persists: the CAS blob store and cached task
# results. Without it every run pays a from-scratch build/test graph. This half
# genuinely changes every run, so the key still includes run_id and is always a
# miss — actions/cache only saves on an exact-key miss, so a stable key would
# let the very first hit freeze the cache forever. restore-keys falls back
# first to the newest cache with matching toolchain pins, then to any same-OS
# cache, so a bump still starts from the closest prior snapshot.
#
# The `!` line excludes the toolchain scope handled above; without it the two
# caches would overlap and the immutable bytes would still ride along in the
# per-run tarball.
#
# Keyed per job (not just per run_id): `check` and `package` both only
# `needs: build`, so they run concurrently. A shared key means whichever job's
# restore lands second gets an exact primary-key hit on the first job's
# already-saved cache — and actions/cache skips saving on an exact hit, so
# that job's additions would silently never persist.
def cache_imp_step(job):
    prefix = f"imp-store-v5-{job}-${{{{ runner.os }}}}"
    pins = "${{ hashFiles('imp.workspace.js', 'rules/**/*.lock') }}"
    return {
        "name": "Cache imp store",
        "uses": "actions/cache@v4",
        "with": {
            "path": f"~/.cache/imp\n!{TOOLCHAIN_SCOPE_PATH}",
            "key": f"{prefix}-{pins}-${{{{ github.run_id }}}}",
            "restore-keys": "\n".join([f"{prefix}-{pins}-", f"{prefix}-"]),
        },
    }


FREE_DISK_SPACE_STEP = {
    "name": "Free disk space",
    "run": (
        "sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc \\\n"
        "  /usr/local/.ghcup /opt/hostedtoolcache/CodeQL /usr/share/swift\n"
        "df -h /"
    ),
}

# actions/cache's underlying GitHub Actions cache service is reachable via
# ACTIONS_CACHE_URL/ACTIONS_RUNTIME_TOKEN (cache service v1) or
# ACTIONS_RESULTS_URL/ACTIONS_CACHE_SERVICE_V2 (v1's replacement), but the
# runner only ever hands those to JS-toolkit actions (via @actions/core) —
# plain `run:` steps don't inherit them. `imp-remote-cache`'s `ghac` backend
# (see crates/imp-remote-cache/src/ghac.rs, via opendal's `services-ghac`)
# needs them as real env vars, so re-export them into $GITHUB_ENV once, up
# front, for every later step in the job to pick up.
#
# All four matter: opendal's ghac backend defaults to the v1 protocol unless
# ACTIONS_CACHE_SERVICE_V2 is a non-empty string, and v1's endpoints have
# since been retired — without this var forwarded too, every remote-cache
# request silently 400s against the dead v1 API instead of using v2.
EXPORT_GHAC_ENV_STEP = {
    "name": "Export GitHub Actions cache credentials",
    "uses": "actions/github-script@v7",
    "with": {
        "script": (
            "core.exportVariable('ACTIONS_CACHE_URL', process.env.ACTIONS_CACHE_URL || '')\n"
            "core.exportVariable('ACTIONS_RUNTIME_TOKEN', process.env.ACTIONS_RUNTIME_TOKEN || '')\n"
            "core.exportVariable('ACTIONS_RESULTS_URL', process.env.ACTIONS_RESULTS_URL || '')\n"
            "core.exportVariable('ACTIONS_CACHE_SERVICE_V2', process.env.ACTIONS_CACHE_SERVICE_V2 || '')"
        ),
    },
}

CHECK_STEPS = [
    FULL_HISTORY_CHECKOUT,
    EXPORT_GHAC_ENV_STEP,
    FREE_DISK_SPACE_STEP,
    *DOWNLOAD_IMP_STEPS,
    cache_toolchains_step("check"),
    cache_imp_step("check"),
    {
        "name": "Check generated files",
        "run": (
            f'./imp generate {SITE_CHECK_TARGET} '
            '--changed-since "$IMP_CHANGED_SINCE" --check'
        ),
    },
    {
        "name": "Check formatting",
        "run": './imp fmt --check //... --changed-since "$IMP_CHANGED_SINCE"',
    },
    {
        "name": "Lint",
        "run": './imp lint //... --changed-since "$IMP_CHANGED_SINCE"',
    },
    {
        "name": "Test",
        "run": './imp test //... --changed-since "$IMP_CHANGED_SINCE"',
    },
    {"name": "Cache stats", "run": "./imp cache stats --details"},
    {"name": "Cache gc", "run": "./imp cache gc --apply"},
]

PACKAGE_STEPS = [
    {"uses": "actions/checkout@v4"},
    EXPORT_GHAC_ENV_STEP,
    *DOWNLOAD_IMP_STEPS,
    cache_toolchains_step("package"),
    cache_imp_step("package"),
    {"name": "Package docs site", "run": f"./imp package {SITE_TARGET}"},
    {"uses": "actions/configure-pages@v5"},
    {"uses": "actions/upload-pages-artifact@v3", "with": {"path": SITE_ARTIFACT_PATH}},
]

DEPLOY_STEPS = [
    {"name": "Deploy", "id": "deploy", "uses": "actions/deploy-pages@v4"},
]

# The release workflow only runs on tags, so without this the first sign that
# packaging is broken would be a failed release. Reuses the binary `build`
# already produced, so it costs one short job rather than another compile.
PACKAGE_SMOKE_STEPS = [
    {"uses": "actions/checkout@v4"},
    *DOWNLOAD_IMP_STEPS,
    {
        "name": "Stage release tree",
        "run": "\n".join(
            [
                "mkdir -p stage/bin stage/share/imp",
                "mv imp stage/bin/imp",
                "cp -r rules stage/share/imp/rules",
            ]
        ),
    },
    {"name": "Smoke test packaged tree", "run": "ci/smoke_package.sh stage"},
]

JOBS = [
    {"id": "build", "runs_on": "ubuntu-latest", "steps": BUILD_STEPS},
    {
        "id": "check",
        "needs": "build",
        "runs_on": "ubuntu-latest",
        # Opt imp-execution's task-cache lookup into the GitHub Actions
        # cache as a remote tier (see crates/imp-remote-cache) for every
        # step in this job — purely an accelerator, read directly via
        # std::env::var and never folded into any task's action digest, so
        # this cannot invalidate cache entries. Requires
        # EXPORT_GHAC_ENV_STEP to have run first so the backend can auth.
        "env": {
            "IMP_REMOTE_CACHE": "ghac",
            "IMP_CHANGED_SINCE": "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}",
            # Temporary diagnostic: surfaces cache-record-rejected /
            # blob-missing reasons on stderr (crates/imp-store/src/trace.rs)
            # to root-cause an unexpected local task-cache miss on a
            # freshly-restored GHAC cache. Remove once confirmed.
            "IMP_TRACE_ARTIFACTS": "1",
        },
        "steps": CHECK_STEPS,
    },
    {
        "id": "package_smoke",
        "needs": "build",
        "runs_on": "ubuntu-latest",
        "steps": PACKAGE_SMOKE_STEPS,
    },
    {
        "id": "package",
        "needs": "build",
        "runs_on": "ubuntu-latest",
        "if": MAIN_PUSH_ONLY,
        # Same accelerator as `check` (see its comment above) — requires
        # EXPORT_GHAC_ENV_STEP in PACKAGE_STEPS so the backend can auth.
        "env": {"IMP_REMOTE_CACHE": "ghac"},
        "steps": PACKAGE_STEPS,
    },
    {
        "id": "deploy",
        "needs": "package",
        "runs_on": "ubuntu-latest",
        "if": MAIN_PUSH_ONLY,
        "environment": {
            "name": "github-pages",
            "url": "${{ steps.deploy.outputs.page_url }}",
        },
        # GitHub Pages allows one in-flight deployment per repo, and a
        # cancelled deploy can leave the Pages API wedged — so the `pages`
        # serialization lives here, on the only job that talks to it, rather
        # than on the whole workflow. Workflow-level it also forced every
        # `check` run repo-wide through a single queue that never cancels.
        "concurrency": {"group": "pages", "cancel-in-progress": False},
        "steps": DEPLOY_STEPS,
    },
]

# Release archives contain a self-consistent prefix, not a bare binary: the
# rule library is no longer compiled in, so it has to travel with the
# executable. `bin/` + `share/imp/rules/` is exactly what RulesSource's
# exe-relative probe expects (crates/imp-engine/src/loader.rs), which means
# an unpacked archive runs in place with no install step.
#
# Shipped unpruned, deliberately: keeping the packaged tree byte-identical to
# the in-repo one is what lets the repo's own tests stand in for it. Prune it
# and you create a divergence nothing can test.
def stage_dir(target):
    return f"imp-{target}"


def stage_release_steps(target, archive_cmd):
    """Linux staging. Runs the full scratch-workspace smoke before archiving,
    so a tree that can't resolve its own rules never reaches Upload."""
    stage = stage_dir(target)
    return [
        {
            "name": "Stage release tree",
            "run": "\n".join(
                [
                    f"mkdir -p {stage}/bin {stage}/share/imp",
                    f"cp target/{target}/release/imp {stage}/bin/imp",
                    f"cp -r rules {stage}/share/imp/rules",
                ]
            ),
        },
        {
            "name": "Smoke test packaged tree",
            "run": f"ci/smoke_package.sh {stage}",
        },
        {"name": "Package", "run": archive_cmd},
    ]


def stage_windows_release_steps(target, archive_cmd):
    """Windows staging. Only checks layout and `--help`, not the full
    scratch-workspace run: smoke_package.sh is POSIX sh, and driving it through
    Git Bash needs MSYS_NO_PATHCONV so `//...` selectors aren't rewritten into
    drive paths. The resolver logic is identical across platforms and is
    covered on Linux; what's Windows-specific is the archive layout, which is
    what these assertions check."""
    stage = stage_dir(target)
    checks = "\n".join(
        f'if (-not (Test-Path "{stage}/share/imp/{f}")) {{ throw "missing {f}" }}'
        for f in ("rules/init.js", "rules/rust/rust.lock", "rules/gen/index.js")
    )
    return [
        {
            "name": "Stage release tree",
            "run": "\n".join(
                [
                    f"New-Item -ItemType Directory -Force -Path {stage}/bin, {stage}/share/imp | Out-Null",
                    f"Copy-Item target/{target}/release/imp.exe {stage}/bin/imp.exe",
                    f"Copy-Item -Recurse rules {stage}/share/imp/rules",
                ]
            ),
        },
        {
            "name": "Smoke test packaged tree",
            "run": f"{checks}\n./{stage}/bin/imp.exe --help",
        },
        {"name": "Package", "run": archive_cmd},
    ]


RELEASE_LINUX_STEPS = [
    {"uses": "actions/checkout@v4"},
    {
        "uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}",
        "with": {"targets": LINUX_TARGET},
    },
    {
        "uses": "kunobi-ninja/kache-action@v1",
    },
    {"uses": "taiki-e/install-action@v2", "with": {"tool": "cross"}},
    {
        "name": "Build",
        "run": f"cross build --release --locked --target {LINUX_TARGET} --manifest-path crates/imp/Cargo.toml",
    },
    {"name": "Smoke test", "run": f"target/{LINUX_TARGET}/release/imp --help"},
    *stage_release_steps(
        LINUX_TARGET, f"tar -czf {LINUX_ARCHIVE} {stage_dir(LINUX_TARGET)}"
    ),
    {
        "name": "Upload artifact",
        "uses": "actions/upload-artifact@v4",
        "with": {
            "name": f"imp-{LINUX_TARGET}",
            "path": LINUX_ARCHIVE,
            "if-no-files-found": "error",
            "retention-days": 7,
            "compression-level": 0,
        },
    },
]

RELEASE_WINDOWS_STEPS = [
    {"uses": "actions/checkout@v4"},
    {
        "uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}",
        "with": {"targets": WINDOWS_TARGET},
    },
    # kache-action has no Windows build — it hard-fails the job with
    # "Unsupported platform: win32-x64" before anything compiles, which is why
    # every release run since this job was added ended in `windows: failure`
    # and skipped `rolling_release`. Skipped rather than removed so the step
    # starts working if upstream ships a win32 binary.
    {
        "uses": "kunobi-ninja/kache-action@v1",
        "if": "runner.os != 'Windows'",
    },
    {
        "name": "Build",
        "run": f"cargo build --release --locked --target {WINDOWS_TARGET} --manifest-path crates/imp/Cargo.toml",
    },
    *stage_windows_release_steps(
        WINDOWS_TARGET,
        f"Compress-Archive -Path {stage_dir(WINDOWS_TARGET)} -DestinationPath {WINDOWS_ARCHIVE}",
    ),
    {
        "name": "Upload artifact",
        "uses": "actions/upload-artifact@v4",
        "with": {
            "name": f"imp-{WINDOWS_TARGET}",
            "path": WINDOWS_ARCHIVE,
            "if-no-files-found": "error",
            "retention-days": 7,
            "compression-level": 0,
        },
    },
]

RELEASE_ARTIFACT_STEPS = [
    {
        "name": "Download artifacts",
        "uses": "actions/download-artifact@v4",
        "with": {"path": "dist", "merge-multiple": "true"},
    },
    {
        "name": "Verify artifacts",
        "run": f"test -f dist/{LINUX_ARCHIVE}\ntest -f dist/{WINDOWS_ARCHIVE}",
    },
]

ROLLING_RELEASE_STEPS = [
    {"uses": "actions/checkout@v4"},
    *RELEASE_ARTIFACT_STEPS,
    {
        "name": "Move rolling release tag",
        "run": (
            f'git tag --force {ROLLING_RELEASE_TAG} "$GITHUB_SHA"\n'
            f'git push --force origin "refs/tags/{ROLLING_RELEASE_TAG}"'
        ),
    },
    {
        "name": "Create or update rolling draft release",
        "uses": "softprops/action-gh-release@v3",
        "with": {
            "tag_name": ROLLING_RELEASE_TAG,
            "target_commitish": "${{ github.sha }}",
            "name": "Latest main build",
            "body": "Automated draft for `${{ github.sha }}` from `main`.",
            "draft": "true",
            "prerelease": "true",
            "overwrite_files": "true",
            "fail_on_unmatched_files": "true",
            "files": f"dist/{LINUX_ARCHIVE}\ndist/{WINDOWS_ARCHIVE}",
        },
    },
]

VERSION_RELEASE_STEPS = [
    {"uses": "actions/checkout@v4"},
    *RELEASE_ARTIFACT_STEPS,
    {
        "name": "Create draft release",
        "uses": "softprops/action-gh-release@v3",
        "with": {
            "draft": "true",
            "generate_release_notes": "true",
            "overwrite_files": "true",
            "fail_on_unmatched_files": "true",
            "files": f"dist/{LINUX_ARCHIVE}\ndist/{WINDOWS_ARCHIVE}",
        },
    },
]

RELEASE_JOBS = [
    {"id": "linux", "runs_on": "ubuntu-latest", "steps": RELEASE_LINUX_STEPS},
    {"id": "windows", "runs_on": "windows-latest", "steps": RELEASE_WINDOWS_STEPS},
    {
        "id": "rolling_release",
        "needs": ["linux", "windows"],
        "if": MANUAL_ONLY,
        "runs_on": "ubuntu-latest",
        "permissions": {"contents": "write"},
        "steps": ROLLING_RELEASE_STEPS,
    },
    {
        "id": "release",
        "needs": ["linux", "windows"],
        "if": TAG_PUSH_ONLY,
        "runs_on": "ubuntu-latest",
        "permissions": {"contents": "write"},
        "steps": VERSION_RELEASE_STEPS,
    },
]


def render_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return f"[{', '.join(str(item) for item in value)}]"
    return str(value)


def render_step(step, indent):
    pad = " " * indent
    lines = []
    first = True

    def emit(key, value):
        nonlocal first
        prefix = f"{pad}- " if first else f"{pad}  "
        if isinstance(value, str) and "\n" in value:
            lines.append(f"{prefix}{key}: |")
            lines.extend(f"{pad}    {line}" for line in value.splitlines())
        else:
            lines.append(f"{prefix}{key}: {render_value(value)}")
        first = False

    for key in ("name", "id", "if", "uses", "run"):
        if key in step:
            emit(key, step[key])
    if "with" in step:
        lines.append(f"{pad}  with:")
        for k, v in step["with"].items():
            if isinstance(v, str) and "\n" in v:
                lines.append(f"{pad}    {k}: |")
                lines.extend(f"{pad}      {line}" for line in v.splitlines())
            else:
                lines.append(f"{pad}    {k}: {render_value(v)}")
    if "env" in step:
        lines.append(f"{pad}  env:")
        for k, v in step["env"].items():
            lines.append(f"{pad}    {k}: {render_value(v)}")
    return lines


def render_steps(steps, indent):
    return "\n\n".join("\n".join(render_step(s, indent)) for s in steps)


def render_job(job):
    lines = [f"  {job['id']}:"]
    if "needs" in job:
        lines.append(f"    needs: {render_value(job['needs'])}")
    if "if" in job:
        lines.append(f"    if: {job['if']}")
    lines.append(f"    runs-on: {job['runs_on']}")
    if "permissions" in job:
        lines.append("    permissions:")
        for k, v in job["permissions"].items():
            lines.append(f"      {k}: {render_value(v)}")
    if "environment" in job:
        lines.append("    environment:")
        for k, v in job["environment"].items():
            lines.append(f"      {k}: {v}")
    if "concurrency" in job:
        lines.append("    concurrency:")
        for k, v in job["concurrency"].items():
            lines.append(f"      {k}: {render_value(v)}")
    if "env" in job:
        lines.append("    env:")
        for k, v in job["env"].items():
            lines.append(f"      {k}: {render_value(v)}")
    lines.append("    steps:")
    lines.append(render_steps(job["steps"], 6))
    return "\n".join(lines)


GENERATED_HEADER = [
    "# Generated by ci/gen_workflow.py — do not edit by hand.",
    "# Regenerate with: imp generate //ci:docs_workflow",
    "",
]


def render_workflow():
    lines = [
        *GENERATED_HEADER,
        "name: Deploy docs",
        "",
        "on:",
        "  push:",
        "    branches: [main]",
        "  pull_request:",
        "",
        "permissions:",
        "  contents: read",
        "  pages: write",
        "  id-token: write",
        "",
        # Supersede an in-flight run when a PR gets another push; never cancel
        # on main, where every commit's docs deploy must actually land. The
        # `pages` group that used to sit here moved onto the `deploy` job.
        "concurrency:",
        "  group: docs-${{ github.workflow }}-${{ github.ref }}",
        "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
        "",
        "jobs:",
        "\n\n".join(render_job(job) for job in JOBS),
    ]
    return "\n".join(lines) + "\n"


def render_release_workflow():
    lines = [
        *GENERATED_HEADER,
        "name: Build release artifacts",
        "",
        # Was `push: branches: [main]`, which rebuilt both platforms on every
        # commit — ~92 billed min/day — to feed a rolling draft release nobody
        # consumes per-commit. Version tags still build automatically; the
        # rolling `main-preview` draft is now on-demand via workflow_dispatch.
        "on:",
        "  push:",
        '    tags: ["v*"]',
        "  workflow_dispatch:",
        "",
        "permissions:",
        "  contents: read",
        "",
        "concurrency:",
        "  group: release-artifacts-${{ github.ref }}",
        "  cancel-in-progress: true",
        "",
        "jobs:",
        "\n\n".join(render_job(job) for job in RELEASE_JOBS),
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    docs_out_path = sys.argv[1]
    release_out_path = sys.argv[2]
    with open(docs_out_path, "w") as f:
        f.write(render_workflow())
    with open(release_out_path, "w") as f:
        f.write(render_release_workflow())
