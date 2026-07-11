#!/usr/bin/env python3
"""Generates .github/workflows/docs.yml from structured job/step data.

A small, stdlib-only stand-in for the codegen->workspace pattern this repo's
imp supports via generatedFiles()/writeWorkspace() — see //ci:docs_workflow
in ci/BUILD.js. `imp goal generate //ci:docs_workflow --check` fails the
build if this script's output ever drifts from the committed workflow file.

Jobs chain: `build` compiles the imp binary once and uploads it as an
artifact; `check`, `package`, and `deploy` download that artifact and run it
"installed" instead of each doing their own cargo build/run.
"""
import sys

SITE_TARGET = "//docs:site"
SITE_CHECK_TARGET = "//ci:docs_workflow"
SITE_ARTIFACT_PATH = "dist/docs/site/public"
RUST_TOOLCHAIN = "stable"
IMP_ARTIFACT = "imp-linux"
MAIN_PUSH_ONLY = "github.ref == 'refs/heads/main' && github.event_name == 'push'"

DOWNLOAD_IMP_STEPS = [
    {"name": "Download imp binary", "uses": "actions/download-artifact@v4", "with": {"name": IMP_ARTIFACT, "path": "."}},
    {"name": "Make imp executable", "run": "chmod +x imp"},
]

BUILD_STEPS = [
    {"uses": "actions/checkout@v4"},
    {"uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}"},
    {"uses": "Swatinem/rust-cache@v2"},
    {"name": "Build imp", "run": "cargo build --release"},
    {"name": "Upload imp binary", "uses": "actions/upload-artifact@v4", "with": {"name": IMP_ARTIFACT, "path": "target/release/imp"}},
]

CHECK_STEPS = [
    {"uses": "actions/checkout@v4"},
    *DOWNLOAD_IMP_STEPS,
    {"name": "Check generated files", "run": f"./imp goal generate {SITE_CHECK_TARGET} --check"},
    {"name": "Check formatting", "run": "./imp fmt --check"},
]

PACKAGE_STEPS = [
    {"uses": "actions/checkout@v4"},
    *DOWNLOAD_IMP_STEPS,
    {"name": "Package docs site", "run": f"./imp package {SITE_TARGET}"},
    {"uses": "actions/configure-pages@v5"},
    {"uses": "actions/upload-pages-artifact@v3", "with": {"path": SITE_ARTIFACT_PATH}},
]

DEPLOY_STEPS = [
    {"name": "Deploy", "id": "deploy", "uses": "actions/deploy-pages@v4"},
]

JOBS = [
    {"id": "build", "runs_on": "ubuntu-latest", "steps": BUILD_STEPS},
    {"id": "check", "needs": "build", "runs_on": "ubuntu-latest", "steps": CHECK_STEPS},
    {"id": "package", "needs": "build", "runs_on": "ubuntu-latest", "if": MAIN_PUSH_ONLY, "steps": PACKAGE_STEPS},
    {
        "id": "deploy",
        "needs": "package",
        "runs_on": "ubuntu-latest",
        "if": MAIN_PUSH_ONLY,
        "environment": {"name": "github-pages", "url": "${{ steps.deploy.outputs.page_url }}"},
        "steps": DEPLOY_STEPS,
    },
]


def render_step(step, indent):
    pad = " " * indent
    lines = []
    first = True

    def emit(key, value):
        nonlocal first
        prefix = f"{pad}- " if first else f"{pad}  "
        lines.append(f"{prefix}{key}: {value}")
        first = False

    for key in ("name", "id", "uses", "run"):
        if key in step:
            emit(key, step[key])
    if "with" in step:
        lines.append(f"{pad}  with:")
        for k, v in step["with"].items():
            lines.append(f"{pad}    {k}: {v}")
    return lines


def render_steps(steps, indent):
    return "\n\n".join("\n".join(render_step(s, indent)) for s in steps)


def render_job(job):
    lines = [f"  {job['id']}:"]
    if "needs" in job:
        lines.append(f"    needs: {job['needs']}")
    if "if" in job:
        lines.append(f"    if: {job['if']}")
    lines.append(f"    runs-on: {job['runs_on']}")
    if "environment" in job:
        lines.append("    environment:")
        for k, v in job["environment"].items():
            lines.append(f"      {k}: {v}")
    lines.append("    steps:")
    lines.append(render_steps(job["steps"], 6))
    return "\n".join(lines)


def render_workflow():
    lines = [
        "name: Deploy docs",
        "",
        "on:",
        "  push:",
        "    branches: [main]",
        "  pull_request:",
        "  workflow_dispatch:",
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


if __name__ == "__main__":
    out_path = sys.argv[1]
    with open(out_path, "w") as f:
        f.write(render_workflow())
