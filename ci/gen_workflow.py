#!/usr/bin/env python3
"""Generates .github/workflows/docs.yml from structured step data.

A small, stdlib-only stand-in for the codegen->workspace pattern this repo's
imp supports via generatedFiles()/writeWorkspace() — see //ci:docs_workflow
in ci/BUILD.js. `imp generate //ci:docs_workflow --check` fails the build if
this script's output ever drifts from the committed workflow file.
"""
import sys

SITE_TARGET = "//docs:site"
SITE_ARTIFACT_PATH = "dist/docs/site/public"
RUST_TOOLCHAIN = "stable"

BUILD_STEPS = [
    {"uses": "actions/checkout@v4"},
    {"uses": f"dtolnay/rust-toolchain@{RUST_TOOLCHAIN}"},
    {"uses": "Swatinem/rust-cache@v2"},
    {"name": "Build imp", "run": "cargo build --release"},
    {"name": "Package docs site", "run": f"./target/release/imp package {SITE_TARGET}"},
    {"uses": "actions/configure-pages@v5"},
    {"uses": "actions/upload-pages-artifact@v3", "with": {"path": SITE_ARTIFACT_PATH}},
]

DEPLOY_STEPS = [
    {"name": "Deploy", "id": "deploy", "uses": "actions/deploy-pages@v4"},
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


def render_workflow():
    lines = [
        "name: Deploy docs",
        "",
        "on:",
        "  push:",
        "    branches: [main]",
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
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        render_steps(BUILD_STEPS, 6),
        "",
        "  deploy:",
        "    needs: build",
        "    runs-on: ubuntu-latest",
        "    environment:",
        "      name: github-pages",
        "      url: ${{ steps.deploy.outputs.page_url }}",
        "    steps:",
        render_steps(DEPLOY_STEPS, 6),
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    out_path = sys.argv[1]
    with open(out_path, "w") as f:
        f.write(render_workflow())
