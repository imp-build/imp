#!/usr/bin/env python3
"""Generates the repository's GitHub workflows from structured job/step data.

A small, stdlib-only stand-in for the codegen->workspace pattern this repo's
imp supports via generatedFiles()/writeWorkspace() — see //ci:docs_workflow
in ci/BUILD.js. `imp goal generate //ci:docs_workflow --check` fails the
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

BUILD_STEPS = [
    {"uses": "actions/checkout@v4"},
    {"uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}"},
    {"uses": "Swatinem/rust-cache@v2"},
    {
        "name": "Build imp",
        "run": "cargo build --release --manifest-path crates/imp/Cargo.toml",
    },
    {
        "name": "Upload imp binary",
        "uses": "actions/upload-artifact@v4",
        "with": {"name": IMP_ARTIFACT, "path": "target/release/imp"},
    },
]


# Everything imp-store persists (downloaded toolchains, the CAS blob store,
# and cached task results) lives under this one directory; without it every
# run pays full cold toolchain acquire plus a from-scratch build/test graph.
# The key always includes run_id, so it's always a miss and this job's
# additions (new CAS blobs, task results) always get saved back at the end —
# actions/cache only saves on an exact-key miss, so a stable key would let
# the very first hit freeze the cache forever. restore-keys falls back first
# to the newest cache with matching toolchain pins, then to any same-OS
# cache, so a toolchain bump still starts from the closest prior snapshot
# instead of from scratch.
#
# Keyed per job (not just per run_id): `check` and `package` both only
# `needs: build`, so they run concurrently. A shared key means whichever job's
# restore lands second gets an exact primary-key hit on the first job's
# already-saved cache — and actions/cache skips saving on an exact hit, so
# that job's toolchain downloads would silently never persist.
def cache_imp_step(job):
    prefix = f"imp-store-v4-{job}-${{{{ runner.os }}}}"
    return {
        "name": "Cache imp store",
        "uses": "actions/cache@v4",
        "with": {
            "path": "~/.cache/imp",
            "key": f"{prefix}-${{{{ hashFiles('imp.workspace.js', 'rules/**/*.lock') }}}}-${{{{ github.run_id }}}}",
            "restore-keys": "\n".join(
                [
                    f"{prefix}-${{{{ hashFiles('imp.workspace.js', 'rules/**/*.lock') }}}}-",
                    f"{prefix}-",
                ]
            ),
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
    cache_imp_step("check"),
    {
        "name": "Check generated files",
        "run": (
            f'./imp goal generate {SITE_CHECK_TARGET} '
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
    *DOWNLOAD_IMP_STEPS,
    cache_imp_step("package"),
    {"name": "Package docs site", "run": f"./imp package {SITE_TARGET}"},
    {"uses": "actions/configure-pages@v5"},
    {"uses": "actions/upload-pages-artifact@v3", "with": {"path": SITE_ARTIFACT_PATH}},
]

DEPLOY_STEPS = [
    {"name": "Deploy", "id": "deploy", "uses": "actions/deploy-pages@v4"},
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
        },
        "steps": CHECK_STEPS,
    },
    {
        "id": "package",
        "needs": "build",
        "runs_on": "ubuntu-latest",
        "if": MAIN_PUSH_ONLY,
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
        "steps": DEPLOY_STEPS,
    },
]

RELEASE_LINUX_STEPS = [
    {"uses": "actions/checkout@v4"},
    {
        "uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}",
        "with": {"targets": LINUX_TARGET},
    },
    {
        "uses": "Swatinem/rust-cache@v2",
        "with": {"save-if": "${{ github.ref == 'refs/heads/main' }}"},
    },
    {"uses": "taiki-e/install-action@v2", "with": {"tool": "cross"}},
    {
        "name": "Build",
        "run": f"cross build --release --locked --target {LINUX_TARGET} --manifest-path crates/imp/Cargo.toml",
    },
    {"name": "Smoke test", "run": f"target/{LINUX_TARGET}/release/imp --help"},
    {
        "name": "Package",
        "run": f"tar -C target/{LINUX_TARGET}/release -czf {LINUX_ARCHIVE} imp",
    },
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
    {
        "uses": "Swatinem/rust-cache@v2",
        "with": {"save-if": "${{ github.ref == 'refs/heads/main' }}"},
    },
    {
        "name": "Build",
        "run": f"cargo build --release --locked --target {WINDOWS_TARGET} --manifest-path crates/imp/Cargo.toml",
    },
    {
        "name": "Smoke test",
        "run": f"./target/{WINDOWS_TARGET}/release/imp.exe --help",
    },
    {
        "name": "Package",
        "run": (
            f"Compress-Archive -Path target/{WINDOWS_TARGET}/release/imp.exe "
            f"-DestinationPath {WINDOWS_ARCHIVE}"
        ),
    },
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
    {
        "name": "Confirm tag matches Cargo.toml version",
        "run": "\n".join(
            [
                'tag="${GITHUB_REF_NAME#v}"',
                'crate="$(python3 -c \'import tomllib; print(tomllib.load(open("Cargo.toml", "rb"))["workspace"]["package"]["version"])\')"',
                'if [ "$tag" != "$crate" ]; then',
                '  echo "tag v$tag does not match Cargo.toml version $crate" >&2',
                "  exit 1",
                "fi",
            ]
        ),
    },
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
        "if": MAIN_PUSH_ONLY,
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
    if "env" in job:
        lines.append("    env:")
        for k, v in job["env"].items():
            lines.append(f"      {k}: {render_value(v)}")
    lines.append("    steps:")
    lines.append(render_steps(job["steps"], 6))
    return "\n".join(lines)


GENERATED_HEADER = [
    "# Generated by ci/gen_workflow.py — do not edit by hand.",
    "# Regenerate with: imp goal generate //ci:docs_workflow",
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
        "concurrency:",
        "  group: pages",
        "  cancel-in-progress: false",
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
        "on:",
        "  push:",
        "    branches: [main]",
        '    tags: ["v*"]',
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
