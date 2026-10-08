#!/usr/bin/env python3
"""Make a local, heuristic inventory of Imp-authored JavaScript modules."""

from __future__ import annotations

import collections
import dataclasses
import pathlib
import re
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEST_SUFFIX = "_test.js"
EXCLUDED_RULE_PREFIXES = (
    "rules/js/example/",
)
ENGINE_MODULES = {
    "crates/imp-engine/src/graph_core.js",
    "crates/imp-engine/src/imp_core.js",
}


@dataclasses.dataclass(frozen=True)
class MigrationBoundary:
    title: str
    task: str
    source: str
    host_prerequisites: tuple[str, ...]


BOUNDARIES: dict[str, MigrationBoundary] = {
    "workspace-integration": MigrationBoundary(
        "Workspace, CI, documentation, and repository BUILD modules",
        "2026-09-30-integrate-luau-workspace-tests-and-docs",
        "Repository BUILD modules, workspace configuration, CI, docs, and proposed-rule examples",
        ("workspace configuration", "workspace/catalog discovery", "test discovery"),
    ),
    "catalog-discovery": MigrationBoundary(
        "Installed catalog root",
        "2026-09-30-luau-workspace-and-catalog-discovery",
        "rules/BUILD.js",
        ("workspace/catalog discovery",),
    ),
    "asset-pilot": MigrationBoundary(
        "Completed asset pilot",
        "2026-09-29-port-luau-graph-host-pilot",
        "rules/asset",
        ("graph outputs",),
    ),
    "example-decision": MigrationBoundary(
        "JavaScript application examples",
        "2026-09-30-decide-luau-example-migration",
        "rules/js/example",
        (),
    ),
    "quickjs-removal": MigrationBoundary(
        "Legacy JavaScript graph host",
        "2026-09-30-remove-quickjs-after-luau-cutover",
        "crates/imp-engine/src/{graph_core,imp_core}.js",
        (),
    ),
    "imp-host-foundation": MigrationBoundary(
        "Imp host-facing foundation",
        "2026-09-30-port-luau-imp-host-and-test-rules",
        "rules/imp/{mode,native-tool,self-tool}",
        ("tool/path host APIs", "workspace/catalog discovery"),
    ),
    "imp-core-foundation": MigrationBoundary(
        "Imp archive, generate, lockfile, and toolchain rules",
        "2026-09-30-port-luau-imp-core-rules",
        "rules/imp/{archive,codegen,generate,lockfile,toolchain}",
        ("graph outputs", "tool/path host APIs", "workspace/catalog discovery"),
    ),
    "rust-graph": MigrationBoundary(
        "Rust graph rules",
        "2026-09-30-port-luau-rust-rules",
        "The three-module static-import cycle in rules/rust, its tests, and the example BUILD module",
        (
            "graph outputs",
            "tool/path host APIs",
            "test discovery",
            "workspace/catalog discovery",
            "dynamic expansion",
            "unowned file discovery",
        ),
    ),
    "imp-validation": MigrationBoundary(
        "Imp test framework and focused validation modules",
        "2026-09-30-port-luau-imp-host-and-test-rules",
        "Remaining rules/imp BUILD and test modules",
        ("test discovery", "workspace/catalog discovery"),
    ),
    "imp-generate-validation": MigrationBoundary(
        "Imp generate tests that use Odin toolchains",
        "2026-10-07-port-luau-imp-generate-validation",
        "rules/imp/generate_test.js",
        ("test discovery", "workspace/catalog discovery"),
    ),
    "workflow-core-runtime": MigrationBoundary(
        "Core workflow implementations",
        "2026-09-30-port-luau-workflow-core",
        "rules/workflows/{build,fmt,lint,report,run,test} implementations",
        ("graph outputs", "workspace/catalog discovery", "generic goal driver"),
    ),
    "workflow-core-validation": MigrationBoundary(
        "Core workflow BUILD and test modules",
        "2026-09-30-port-luau-workflow-core",
        "Core workflow BUILD and test modules",
        ("test discovery", "workspace/catalog discovery"),
    ),
    "workflow-codegen-runtime": MigrationBoundary(
        "Code-generation workflow implementations",
        "2026-09-30-port-luau-imp-core-rules",
        "rules/workflows/{codegen,generate,generate_build} implementations",
        ("workspace/catalog discovery",),
    ),
    "workflow-codegen-validation": MigrationBoundary(
        "Code-generation workflow BUILD and test modules",
        "2026-09-30-port-luau-workflow-codegen",
        "Code-generation workflow BUILD and test modules",
        ("test discovery", "workspace/catalog discovery"),
    ),
    "workflow-lockfiles-runtime": MigrationBoundary(
        "Base lockfile workflow",
        "2026-10-07-port-luau-workflow-packaging-runtime",
        "rules/workflows/lockfiles/{index,BUILD}.js",
        ("tool/path host APIs", "workspace/catalog discovery"),
    ),
    "workflow-packaging-runtime": MigrationBoundary(
        "Package and publish workflows and their focused tests",
        "2026-10-07-port-luau-workflow-packaging-runtime",
        "rules/workflows/{package,publish} modules",
        ("graph outputs", "tool/path host APIs", "workspace/catalog discovery"),
    ),
    "workflow-vs": MigrationBoundary(
        "Visual Studio and VS Code configuration workflow",
        "2026-10-08-port-luau-odin-vscode",
        "rules/workflows/vs",
        ("graph outputs", "tool/path host APIs", "workspace/catalog discovery"),
    ),
    "workflow-packaging-validation": MigrationBoundary(
        "Lockfile validation module",
        "2026-09-30-port-luau-workflow-packaging",
        "rules/workflows/lockfiles/lockfiles_test.js",
        ("test discovery", "workspace/catalog discovery"),
    ),
    "builtin-lockfiles": MigrationBoundary(
        "Built-in lockfile aggregator",
        "2026-09-30-port-luau-workflow-packaging",
        "rules/workflows/builtin_lockfiles/index.js",
        ("tool/path host APIs", "workspace/catalog discovery"),
    ),
    "c-shared-toolchain": MigrationBoundary(
        "Shared C toolchain contract",
        "2026-09-30-port-luau-c-toolchains",
        "rules/c/toolchain.js",
        ("tool/path host APIs", "workspace/catalog discovery"),
    ),
    "c-toolchains": MigrationBoundary(
        "C compiler toolchains",
        "2026-09-30-port-luau-c-toolchains",
        "rules/c/{gcc,mold,msvc,zig}",
        ("graph outputs", "tool/path host APIs", "workspace/catalog discovery"),
    ),
    "c-cmake": MigrationBoundary(
        "CMake rules",
        "2026-09-30-port-luau-cmake-rules",
        "rules/c/cmake",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "c-catalog-root": MigrationBoundary(
        "C catalog root",
        "2026-09-30-port-luau-c-catalog-root",
        "rules/c root modules and graph example",
        ("graph outputs", "test discovery", "workspace/catalog discovery"),
    ),
    "c-generate-build": MigrationBoundary(
        "C BUILD generation",
        "2026-10-07-port-luau-c-generate-build",
        "rules/c/generate_build",
        ("workspace/catalog discovery",),
    ),
    "js-biome": MigrationBoundary(
        "Biome rules",
        "2026-09-30-port-luau-js-biome",
        "rules/js/biome and rules/js/graph_test.js",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "js-node-pnpm": MigrationBoundary(
        "JavaScript, Node, and pnpm rules",
        "2026-09-30-port-luau-js-node-pnpm",
        "rules/js root, node, and pnpm modules, except rules/js/graph_test.js",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "python-core": MigrationBoundary(
        "Python project and runtime rules",
        "2026-09-30-port-luau-python-core",
        "rules/python core, project, runtime, source, workspace, and tests, except graph_test.js and doc_test.js",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "python-pex-uv": MigrationBoundary(
        "Python lock, PEX, and uv rules",
        "2026-09-30-port-luau-python-pex-uv",
        "rules/python/{lock,pex_toolchain,uv_toolchain}",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "python-ruff": MigrationBoundary(
        "Python Ruff rules",
        "2026-09-30-port-luau-python-ruff",
        "rules/python/ruff, Ruff graph/toolchain modules, and rules/python/{graph,doc}_test.js",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "rust-toolchains": MigrationBoundary(
        "Rust toolchain, Kache, and Cargo input rules",
        "2026-10-07-port-luau-rust-toolchains",
        "rules/rust/{toolchain,kache,cargo_task_inputs} and rules/rust/BUILD.js",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "odin": MigrationBoundary(
        "Odin compiler, odinfmt, and example rules",
        "2026-09-30-port-luau-odin-rules",
        "rules/odin, except rules/odin/vscode",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "odin-vscode": MigrationBoundary(
        "Odin VS Code integration",
        "2026-10-08-port-luau-odin-vscode",
        "rules/odin/vscode",
        ("graph outputs", "test discovery", "workspace/catalog discovery"),
    ),
    "treesitter-validation": MigrationBoundary(
        "Tree-sitter BUILD and test modules",
        "2026-09-30-port-luau-treesitter",
        "Remaining rules/treesitter modules",
        ("test discovery", "workspace/catalog discovery"),
    ),
    "treesitter-runtime": MigrationBoundary(
        "Tree-sitter runtime rules",
        "2026-09-30-port-luau-treesitter",
        "rules/treesitter/index.js",
        ("graph outputs", "tool/path host APIs", "workspace/catalog discovery"),
    ),
    "oci": MigrationBoundary(
        "OCI rules",
        "2026-09-30-port-luau-oci",
        "rules/oci",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
    "zola": MigrationBoundary(
        "Zola rules",
        "2026-09-30-port-luau-zola",
        "rules/zola",
        ("graph outputs", "tool/path host APIs", "test discovery", "workspace/catalog discovery"),
    ),
}


WORKSPACE_INTEGRATION_FILES = {
    "BUILD.js",
    "ci/BUILD.js",
    "crates/imp-daemon/BUILD.js",
    "crates/imp-engine/BUILD.js",
    "crates/imp-exec-api/BUILD.js",
    "crates/imp-exec-bridge/BUILD.js",
    "crates/imp-execution/BUILD.js",
    "crates/imp-logging/BUILD.js",
    "crates/imp-remote-cache/BUILD.js",
    "crates/imp-scheduler/BUILD.js",
    "crates/imp-store/BUILD.js",
    "crates/imp/BUILD.js",
    "crates/imp/src/BUILD.js",
    "docs/BUILD.js",
    "docs/js_api_extract.js",
    "docs/js_api_extract_test.js",
    "examples/proposed-rules/BUILD.js",
    "imp.workspace.ci.js",
    "imp.workspace.js",
}

RUST_GRAPH = {
    "rules/rust/example/BUILD.js",
    "rules/rust/generate_build/index.js",
    "rules/rust/generate_build_test.js",
    "rules/rust/index.js",
    "rules/rust/index_test.js",
    "rules/rust/workspace_expansion.js",
    "rules/rust/workspace_expansion_test.js",
}

WORKFLOW_CORE_RUNTIME = {
    "rules/workflows/build/index.js",
    "rules/workflows/fmt/index.js",
    "rules/workflows/lint/index.js",
    "rules/workflows/report.js",
    "rules/workflows/run/index.js",
    "rules/workflows/test/index.js",
}

WORKFLOW_CODEGEN_RUNTIME = {
    "rules/workflows/codegen/index.js",
    "rules/workflows/generate/index.js",
    "rules/workflows/generate_build/index.js",
}

WORKFLOW_PACKAGING_RUNTIME = {
    "rules/workflows/package/BUILD.js",
    "rules/workflows/package/graph_package_test.js",
    "rules/workflows/package/index.js",
    "rules/workflows/publish/BUILD.js",
    "rules/workflows/publish/index.js",
}


def migration_boundary_for(path: str) -> str | None:
    if path in WORKSPACE_INTEGRATION_FILES:
        return "workspace-integration"
    if path == "rules/BUILD.js":
        return "catalog-discovery"
    if path.startswith("rules/asset/"):
        return "asset-pilot"
    if path.startswith("rules/js/example/"):
        return "example-decision"
    if path in ENGINE_MODULES:
        return "quickjs-removal"
    if path in {
        "rules/imp/mode/index.js",
        "rules/imp/native-tool/index.js",
        "rules/imp/self-tool/index.js",
    }:
        return "imp-host-foundation"
    if path == "rules/imp/generate_test.js":
        return "imp-generate-validation"
    if path.startswith((
        "rules/imp/archive",
        "rules/imp/codegen",
        "rules/imp/generate",
        "rules/imp/lockfile",
        "rules/imp/toolchain",
    )):
        return "imp-core-foundation"
    if path in RUST_GRAPH:
        return "rust-graph"
    if path.startswith("rules/imp/"):
        return "imp-validation"
    if path in WORKFLOW_CORE_RUNTIME:
        return "workflow-core-runtime"
    if path.startswith((
        "rules/workflows/build/",
        "rules/workflows/fmt/",
        "rules/workflows/lint/",
        "rules/workflows/run/",
        "rules/workflows/test/",
    )) or path in {"rules/workflows/BUILD.js", "rules/workflows/report_test.js"}:
        return "workflow-core-validation"
    if path in WORKFLOW_CODEGEN_RUNTIME:
        return "workflow-codegen-runtime"
    if path.startswith((
        "rules/workflows/codegen/",
        "rules/workflows/generate/",
        "rules/workflows/generate_build/",
    )):
        return "workflow-codegen-validation"
    if path in {"rules/workflows/lockfiles/BUILD.js", "rules/workflows/lockfiles/index.js"}:
        return "workflow-lockfiles-runtime"
    if path == "rules/workflows/builtin_lockfiles/index.js":
        return "builtin-lockfiles"
    if path in WORKFLOW_PACKAGING_RUNTIME:
        return "workflow-packaging-runtime"
    if path.startswith("rules/workflows/vs/"):
        return "workflow-vs"
    if path.startswith((
        "rules/workflows/lockfiles/",
        "rules/workflows/package/",
        "rules/workflows/publish/",
    )):
        return "workflow-packaging-validation"
    if path == "rules/c/toolchain.js":
        return "c-shared-toolchain"
    if path.startswith(("rules/c/gcc/", "rules/c/mold/", "rules/c/msvc/", "rules/c/zig/")):
        return "c-toolchains"
    if path.startswith("rules/c/cmake/"):
        return "c-cmake"
    if path.startswith("rules/c/generate_build/"):
        return "c-generate-build"
    if path.startswith("rules/c/"):
        return "c-catalog-root"
    # The JS graph test imports Biome, and Biome imports the JS graph.
    if path.startswith("rules/js/biome/") or path == "rules/js/graph_test.js":
        return "js-biome"
    if path.startswith(("rules/js/node/", "rules/js/pnpm/")) or path in {
        "rules/js/BUILD.js",
        "rules/js/graph.js",
        "rules/js/index.js",
        "rules/js/index_test.js",
    }:
        return "js-node-pnpm"
    # The graph test imports Ruff. The doc test imports Ruff dynamically from the
    # DOC.md setup block, so the static-import graph does not show that edge.
    if path.startswith(("rules/python/ruff/", "rules/python/ruff_")) or path in {
        "rules/python/doc_test.js",
        "rules/python/graph_test.js",
    }:
        return "python-ruff"
    if path.startswith((
        "rules/python/lock.",
        "rules/python/pex_toolchain",
        "rules/python/uv_toolchain",
    )):
        return "python-pex-uv"
    if path.startswith("rules/python/"):
        return "python-core"
    if path.startswith("rules/rust/"):
        return "rust-toolchains"
    if path.startswith("rules/odin/vscode/"):
        return "odin-vscode"
    if path.startswith("rules/odin/"):
        return "odin"
    if path == "rules/treesitter/index.js":
        return "treesitter-runtime"
    if path.startswith("rules/treesitter/"):
        return "treesitter-validation"
    if path.startswith("rules/oci/"):
        return "oci"
    if path.startswith("rules/zola/"):
        return "zola"
    return None


def tracked_javascript() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.js"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    return sorted(path.decode("utf-8") for path in result.stdout.split(b"\0") if path)


def _blank(chars: list[str], start: int, end: int) -> None:
    for index in range(start, end):
        if chars[index] not in "\r\n":
            chars[index] = " "


def _starts_regex_literal(chars: list[str], slash: int) -> bool:
    """Use the preceding token to distinguish regex literals from division."""
    previous = slash - 1
    while previous >= 0 and chars[previous].isspace():
        previous -= 1
    if previous < 0:
        return True
    if chars[previous] in "=([{,:;!?&|+-*%^~<>":
        return True
    end = previous + 1
    while previous >= 0 and (chars[previous].isalnum() or chars[previous] in "_$"):
        previous -= 1
    token = "".join(chars[previous + 1 : end])
    return token in {
        "await", "case", "delete", "do", "else", "in", "instanceof",
        "of", "return", "throw", "typeof", "void", "yield",
    }


def mask_comments_and_literals(source: str) -> str:
    """Keep code and line positions while masking comments and string bodies."""
    chars = list(source)
    mode = "code"
    quote = ""
    regex_in_class = False
    index = 0
    template_stack: list[dict[str, int | str]] = []

    while index < len(chars):
        char = chars[index]
        following = chars[index + 1] if index + 1 < len(chars) else ""

        if mode == "line_comment":
            if char in "\r\n":
                mode = "code"
            else:
                _blank(chars, index, index + 1)
            index += 1
            continue

        if mode == "block_comment":
            if char == "*" and following == "/":
                _blank(chars, index, index + 2)
                index += 2
                mode = "code"
            else:
                _blank(chars, index, index + 1)
                index += 1
            continue

        if mode == "quoted":
            _blank(chars, index, index + 1)
            if char == "\\" and index + 1 < len(chars):
                _blank(chars, index + 1, index + 2)
                index += 2
            elif char == quote:
                mode = "code"
                index += 1
            else:
                index += 1
            continue

        if mode == "regex":
            _blank(chars, index, index + 1)
            if char == "\\" and index + 1 < len(chars):
                _blank(chars, index + 1, index + 2)
                index += 2
            elif char in "\r\n":
                mode = "code"
                index += 1
            elif char == "[":
                regex_in_class = True
                index += 1
            elif char == "]":
                regex_in_class = False
                index += 1
            elif char == "/" and not regex_in_class:
                index += 1
                while index < len(chars) and chars[index].isalpha():
                    _blank(chars, index, index + 1)
                    index += 1
                mode = "code"
            else:
                index += 1
            continue

        if mode == "template":
            if char == "\\":
                _blank(chars, index, min(index + 2, len(chars)))
                index += 2
            elif char == "`":
                _blank(chars, index, index + 1)
                template_stack.pop()
                mode = "code"
                index += 1
            elif char == "$" and following == "{":
                _blank(chars, index, index + 2)
                template_stack[-1]["braces"] = 1
                mode = "code"
                index += 2
            else:
                _blank(chars, index, index + 1)
                index += 1
            continue

        # Code mode. Template interpolation braces return to template text.
        if template_stack and int(template_stack[-1]["braces"]) > 0:
            if char == "{":
                template_stack[-1]["braces"] = int(template_stack[-1]["braces"]) + 1
            elif char == "}":
                depth = int(template_stack[-1]["braces"]) - 1
                template_stack[-1]["braces"] = depth
                if depth == 0:
                    _blank(chars, index, index + 1)
                    mode = "template"
                    index += 1
                    continue

        if char == "/" and following == "/":
            _blank(chars, index, index + 2)
            mode = "line_comment"
            index += 2
        elif char == "/" and following == "*":
            _blank(chars, index, index + 2)
            mode = "block_comment"
            index += 2
        elif char == "/" and _starts_regex_literal(chars, index):
            _blank(chars, index, index + 1)
            regex_in_class = False
            mode = "regex"
            index += 1
        elif char in "'\"":
            quote = char
            _blank(chars, index, index + 1)
            mode = "quoted"
            index += 1
        elif char == "`":
            _blank(chars, index, index + 1)
            template_stack.append({"braces": 0})
            mode = "template"
            index += 1
        else:
            index += 1

    return "".join(chars)


FEATURE_PATTERNS: dict[str, re.Pattern[str]] = {
    "static_import": re.compile(r"\bimport\s+(?!\()"),
    "export": re.compile(r"\bexport\b"),
    "dynamic_import": re.compile(r"\bimport\s*\("),
    "async": re.compile(r"\basync\b"),
    "await": re.compile(r"\bawait\b"),
    "destructuring": re.compile(r"\b(?:const|let|var)\s*[\[{]"),
    "spread_or_rest": re.compile(r"\.\.\."),
    "optional_chaining": re.compile(r"\?\."),
    "nullish_coalescing": re.compile(r"\?\?"),
    "object_freeze": re.compile(r"\bObject\s*\.\s*freeze\b"),
    "class": re.compile(r"\bclass\s+[A-Za-z_$]"),
    "this": re.compile(r"\bthis\b"),
    "prototype": re.compile(r"\bprototype\b"),
    "instanceof": re.compile(r"\binstanceof\b"),
    "promise": re.compile(r"\bPromise\b"),
    "node_process": re.compile(r"\bprocess\s*\."),
    "node_buffer": re.compile(r"\bBuffer\s*\."),
    "eval_or_function_constructor": re.compile(r"\b(?:eval\s*\(|new\s+Function\s*\()"),
    "map_or_set": re.compile(r"\bnew\s+(?:Map|Set)\s*\("),
    "new_expression": re.compile(r"\bnew\s+[A-Z_$][\w$]*\s*\("),
    "catch_binding": re.compile(r"\bcatch\s*\("),
    "for_of": re.compile(r"\bfor\s*\([^)]*\bof\b"),
    "arrow_function": re.compile(r"=>"),
    "camel_case_keys": re.compile(r"[,{]\s*([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\s*:"),
    "array_or_object_methods": re.compile(
        r"\b(?:Array\s*\.\s*isArray|Object\s*\.\s*(?:keys|values|entries|assign)|"
        r"\.(?:map|filter|reduce|flatMap|includes|some|every|find|findIndex|slice|join|push|pop))\s*\("
    ),
}


MANUAL_FEATURES = {
    "class",
    "this",
    "prototype",
    "instanceof",
    "promise",
    "node_process",
    "node_buffer",
    "eval_or_function_constructor",
    "map_or_set",
}
REVIEW_FEATURES = {
    "dynamic_import",
    "async",
    "await",
    "destructuring",
    "spread_or_rest",
    "optional_chaining",
    "nullish_coalescing",
    "object_freeze",
    "catch_binding",
    "for_of",
    "camel_case_keys",
    "array_or_object_methods",
}


def role_for(path: str) -> tuple[str, str | None]:
    if path.endswith(TEST_SUFFIX):
        return "test", None
    if pathlib.PurePosixPath(path).name == "BUILD.js" or path.startswith("imp.workspace"):
        return "workspace/build", None
    if path.startswith(EXCLUDED_RULE_PREFIXES):
        return "excluded", "JavaScript application example"
    if path.startswith("rules/") or path in ENGINE_MODULES or path.startswith("docs/"):
        return "production", None
    return "excluded", "outside the rule, host, workspace, and documentation module scope"


def inspect_file(path: str) -> dict[str, object]:
    source = (ROOT / path).read_text(encoding="utf-8")
    code = mask_comments_and_literals(source)
    features = {
        name: len(pattern.findall(code))
        for name, pattern in FEATURE_PATTERNS.items()
    }
    features = {name: count for name, count in features.items() if count}
    role, reason = role_for(path)

    if role == "excluded":
        category = "excluded/non-authoring JavaScript"
    elif MANUAL_FEATURES.intersection(features):
        category = "manual redesign"
    elif REVIEW_FEATURES.intersection(features):
        category = "mechanical with review"
    else:
        category = "mechanical"

    return {
        "path": path,
        "role": role,
        "category": category,
        "reason": reason,
        "features": features,
        "boundary": migration_boundary_for(path),
    }


STATIC_RULE_IMPORT = re.compile(
    r"(?:\bfrom\s+|^\s*import\s+)(['\"])(//rules/[^'\"]+)\1",
    re.MULTILINE,
)


def static_rule_imports(source: str) -> list[str]:
    """Return static catalog imports without treating addressed data as modules."""
    code = mask_comments_and_literals(source)
    imports = []
    for match in STATIC_RULE_IMPORT.finditer(source):
        keyword_start = match.start()
        keyword = code[keyword_start : keyword_start + 6].lstrip()
        if keyword.startswith("import") or keyword.startswith("from"):
            imports.append(match.group(2))
    return imports


NAMED_RULE_IMPORT = re.compile(
    r"\bimport\s*\{([^}]*)\}\s*from\s*(['\"])(//rules/[^'\"]+)\2",
)

# The Luau host replaces the JavaScript test harness: `core.test` and
# `core.test_root` replace every export of `//rules/imp/test`. An import that
# names only replaced exports is not a Luau dependency. `None` replaces every
# export of the module.
HOST_REPLACED_IMPORTS: dict[str, frozenset[str] | None] = {
    "rules/imp/test/index.js": None,
}
# Luau BUILD modules do not declare their own JavaScript sources, so these
# exports are replaced only in BUILD modules.
BUILD_REPLACED_IMPORTS: dict[str, frozenset[str]] = {
    "rules/js/index.js": frozenset({"jsSources"}),
}
TEST_HOST_FAKE = re.compile(r"withFake\w+")
HOST_GLOBAL_PATCH = re.compile(r"\bglobalThis\.__host_\w+\s*=(?!=)")
IMPORT_ALIAS = re.compile(r"\s+as\s+")


def named_rule_imports(source: str) -> dict[str, list[set[str]]]:
    """Return the imported names of each braced static catalog import statement."""
    code = mask_comments_and_literals(source)
    imports: dict[str, list[set[str]]] = collections.defaultdict(list)
    for match in NAMED_RULE_IMPORT.finditer(source):
        if code[match.start() : match.start() + 6] != "import":
            continue
        names = {
            IMPORT_ALIAS.split(item.strip())[0]
            for item in match.group(1).split(",")
            if item.strip()
        }
        imports[match.group(3)].append(names)
    return imports


def host_replaced(path: str, target: str, names: set[str]) -> bool:
    if not names:
        return False
    if target in HOST_REPLACED_IMPORTS:
        replaced = HOST_REPLACED_IMPORTS[target]
        return replaced is None or names <= replaced
    if path.endswith("BUILD.js") and target in BUILD_REPLACED_IMPORTS:
        return names <= BUILD_REPLACED_IMPORTS[target]
    return False


def resolve_rule_import(specifier: str, tracked: set[str]) -> str | None:
    """Resolve a //rules import with the catalog's file and index conventions."""
    base = specifier.removeprefix("//")
    for candidate in (base, base + ".js", base + "/index.js", base + "/BUILD.js"):
        if candidate in tracked:
            return candidate
    return None


@dataclasses.dataclass
class ImportGraph:
    edges: dict[str, set[str]]
    replaced: int
    fake_users: set[str]


def import_graph(rows: list[dict[str, object]]) -> ImportGraph:
    """Return Luau-relevant static imports; host-replaced imports are left out."""
    tracked = {str(row["path"]) for row in rows}
    graph = ImportGraph({path: set() for path in tracked}, 0, set())
    for path in sorted(tracked):
        source = (ROOT / path).read_text(encoding="utf-8")
        if path.endswith(TEST_SUFFIX) and HOST_GLOBAL_PATCH.search(mask_comments_and_literals(source)):
            graph.fake_users.add(path)
        named = named_rule_imports(source)
        occurrences = collections.Counter(static_rule_imports(source))
        for specifier, count in sorted(occurrences.items()):
            target = resolve_rule_import(specifier, tracked)
            if target is None:
                continue
            statements = named.get(specifier, [])
            # A namespace, default, side-effect, or re-export statement keeps the edge.
            if len(statements) == count and all(
                host_replaced(path, target, names) for names in statements
            ):
                graph.replaced += count
                if any(TEST_HOST_FAKE.fullmatch(name) for names in statements for name in names):
                    graph.fake_users.add(path)
                continue
            graph.edges[path].add(target)
    return graph


def strongly_connected_components(graph: dict[str, set[str]]) -> list[list[str]]:
    """Return Tarjan components in deterministic discovery order."""
    next_index = 0
    indices: dict[str, int] = {}
    lowlinks: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    components: list[list[str]] = []

    def visit(node: str) -> None:
        nonlocal next_index
        indices[node] = next_index
        lowlinks[node] = next_index
        next_index += 1
        stack.append(node)
        on_stack.add(node)

        for target in sorted(graph[node]):
            if target not in indices:
                visit(target)
                lowlinks[node] = min(lowlinks[node], lowlinks[target])
            elif target in on_stack:
                lowlinks[node] = min(lowlinks[node], indices[target])

        if lowlinks[node] != indices[node]:
            return
        component: list[str] = []
        while True:
            member = stack.pop()
            on_stack.remove(member)
            component.append(member)
            if member == node:
                break
        components.append(sorted(component))

    for node in sorted(graph):
        if node not in indices:
            visit(node)
    return components


def module_island_stages(graph: dict[str, set[str]]) -> list[list[list[str]]]:
    """Group static-import components into prerequisite-first stages."""
    components = strongly_connected_components(graph)
    component_for = {
        path: component_index
        for component_index, component in enumerate(components)
        for path in component
    }
    component_dependencies = {index: set() for index in range(len(components))}
    for source, targets in graph.items():
        source_component = component_for[source]
        for target in targets:
            target_component = component_for[target]
            if source_component != target_component:
                component_dependencies[source_component].add(target_component)

    component_depth: dict[int, int] = {}

    def depth(component: int) -> int:
        if component not in component_depth:
            required = component_dependencies[component]
            component_depth[component] = 1 + max(
                (depth(dependency) for dependency in required),
                default=0,
            )
        return component_depth[component]

    for component in component_dependencies:
        depth(component)

    staged: dict[int, list[list[str]]] = collections.defaultdict(list)
    for component_index, component in enumerate(components):
        staged[component_depth[component_index]].append(component)
    return [
        sorted(staged[stage], key=lambda component: component)
        for stage in sorted(staged)
    ]


def boundary_graph(
    rows: list[dict[str, object]],
    graph: dict[str, set[str]],
) -> tuple[dict[str, set[str]], dict[tuple[str, str], tuple[str, str]]]:
    by_path = {str(row["path"]): row for row in rows}
    used = {
        str(row["boundary"])
        for row in rows
        if row["boundary"] is not None
    }
    dependencies = {boundary: set() for boundary in used}
    evidence: dict[tuple[str, str], tuple[str, str]] = {}
    for source_path in sorted(graph):
        targets = graph[source_path]
        source_boundary = by_path[source_path]["boundary"]
        if source_boundary is None:
            continue
        for target_path in sorted(targets):
            target_boundary = by_path[target_path]["boundary"]
            if target_boundary is None or target_boundary == source_boundary:
                continue
            source = str(source_boundary)
            target = str(target_boundary)
            dependencies[source].add(target)
            evidence.setdefault((source, target), (source_path, target_path))
    return dependencies, evidence


def owning_task(boundary: str) -> str:
    return BOUNDARIES[boundary].task.removeprefix("split from ")


def task_graph(
    dependencies: dict[str, set[str]],
    evidence: dict[tuple[str, str], tuple[str, str]],
) -> tuple[dict[str, set[str]], dict[tuple[str, str], tuple[str, str]]]:
    """Condense the boundary graph by owning task."""
    tasks = {owning_task(boundary) for boundary in dependencies}
    graph: dict[str, set[str]] = {task: set() for task in tasks}
    task_evidence: dict[tuple[str, str], tuple[str, str]] = {}
    for boundary in sorted(dependencies):
        for required in sorted(dependencies[boundary]):
            source = owning_task(boundary)
            target = owning_task(required)
            if source == target:
                continue
            graph[source].add(target)
            task_evidence.setdefault((source, target), evidence[(boundary, required)])
    return graph, task_evidence


def host_prerequisites(boundary: str, fake_boundaries: set[str]) -> str:
    prerequisites = BOUNDARIES[boundary].host_prerequisites
    if boundary in fake_boundaries:
        prerequisites += ("test host fakes",)
    return ", ".join(prerequisites) or "none"


def print_report(rows: list[dict[str, object]]) -> None:
    category_names = [
        "mechanical",
        "mechanical with review",
        "manual redesign",
        "excluded/non-authoring JavaScript",
    ]
    role_names = ["production", "workspace/build", "test", "excluded"]
    imports = import_graph(rows)
    graph = imports.edges
    dependencies, dependency_evidence = boundary_graph(rows, graph)
    by_path = {str(row["path"]): row for row in rows}
    fake_boundaries = {str(by_path[path]["boundary"]) for path in imports.fake_users}

    print("# JavaScript-to-Luau conversion inventory")
    print()
    print(f"Tracked JavaScript files: {len(rows)}")
    print()
    print("## Counts by module role and conversion category")
    print()
    print("| Role | " + " | ".join(category_names) + " | Total |")
    print("| --- | " + " | ".join("---:" for _ in category_names) + " | ---: |")
    for role in role_names:
        selected = [row for row in rows if row["role"] == role]
        counts = [sum(row["category"] == category for row in selected) for category in category_names]
        print(f"| {role} | " + " | ".join(map(str, counts)) + f" | {len(selected)} |")
    all_counts = [sum(row["category"] == category for row in rows) for category in category_names]
    print("| **All** | " + " | ".join(map(str, all_counts)) + f" | **{len(rows)}** |")

    print()
    print("## Feature evidence")
    print()
    feature_counts: collections.Counter[str] = collections.Counter()
    for row in rows:
        if row["role"] != "excluded":
            feature_counts.update(row["features"])
    for name, count in feature_counts.most_common():
        print(f"- `{name}`: {count} token match(es)")

    print()
    print("The category rules are conservative triage signals, not a semantic proof. Review every module before scheduling conversion.")

    print()
    print("## Measured rule-family sizes")
    print()
    families: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for row in rows:
        path = str(row["path"])
        if path.startswith("rules/") and row["role"] != "excluded":
            family_name = path.split("/", 2)[1]
            family = "rules (catalog root)" if family_name.endswith(".js") else "rules/" + family_name
            families[family][str(row["category"])] += 1
    print("| Family | Mechanical | Review | Redesign | Total |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for family, counts in sorted(families.items()):
        mechanical = counts["mechanical"]
        review = counts["mechanical with review"]
        redesign = counts["manual redesign"]
        print(f"| `{family}` | {mechanical} | {review} | {redesign} | {mechanical + review + redesign} |")

    print()
    print("## Migration boundary coverage")
    print()
    assigned = [row for row in rows if row["boundary"] is not None]
    unassigned = [row for row in rows if row["boundary"] is None]
    excluded = [row for row in rows if row["role"] == "excluded"]
    print(f"- Assigned tracked files: {len(assigned)}/{len(rows)}")
    print(f"- Explicit exclusions: {len(excluded)}")
    if unassigned:
        print("- Unassigned files: " + ", ".join(f"`{row['path']}`" for row in unassigned))
    else:
        print("- Unassigned files: none")

    print()
    print("| Boundary | Modules | Owning task | Host prerequisites |")
    print("| --- | ---: | --- | --- |")
    boundary_rows: dict[str, list[dict[str, object]]] = collections.defaultdict(list)
    for row in assigned:
        boundary_rows[str(row["boundary"])].append(row)
    for boundary, selected in sorted(boundary_rows.items()):
        definition = BOUNDARIES[boundary]
        prerequisites = host_prerequisites(boundary, fake_boundaries)
        print(
            f"| `{boundary}` | {len(selected)} | `{definition.task}` | {prerequisites} |"
        )

    print()
    print("Every boundary above has at most 20 tracked JavaScript files. The task names identify current ownership. Divide each `split from` task into separate tasks during backlog reconciliation.")

    print()
    print("### Files by migration boundary")
    for boundary, selected in sorted(boundary_rows.items()):
        definition = BOUNDARIES[boundary]
        print()
        print(f"#### `{boundary}` — {definition.title}")
        print()
        print(f"Source boundary: {definition.source}.")
        for row in sorted(selected, key=lambda item: str(item["path"])):
            role = row["role"]
            category = row["category"]
            print(f"- `{row['path']}` — {role}; {category}")

    print()
    print("## Static-import islands")
    print()
    cycles = [
        component
        for component in strongly_connected_components(graph)
        if len(component) > 1
    ]
    if not cycles:
        print("No multi-module static-import cycles found.")
    for component in sorted(cycles, key=lambda item: (-len(item), item)):
        print(f"- {len(component)}-module island:")
        for path in component:
            print(f"  - `{path}`")

    print()
    print("## Boundary dependency table")
    print()
    print(f"An edge means that a source boundary has a static import from the prerequisite boundary. The graph leaves out {imports.replaced} import(s) that name only host-replaced JavaScript test scaffolding (`//rules/imp/test` exports, and `jsSources` from `//rules/js` in BUILD modules). A boundary whose tests import `withFake*` helpers or replace `globalThis.__host_*` functions requires test host fakes. Host prerequisites are planning estimates recorded in BOUNDARIES; compare them with the verified host surface and gaps in docs/design/luau-authoring-contract.md before scheduling.")
    print()
    print("| Boundary | Static-import prerequisites | Example edge | Host prerequisites |")
    print("| --- | --- | --- | --- |")
    for boundary in sorted(dependencies):
        required = sorted(dependencies[boundary])
        listed = ", ".join(f"`{item}`" for item in required) or "none"
        if required:
            source, target = dependency_evidence[(boundary, required[0])]
            example = f"`{source}` → `{target}`"
        else:
            example = "none"
        host = host_prerequisites(boundary, fake_boundaries)
        print(f"| `{boundary}` | {listed} | {example} | {host} |")

    print()
    print("## Task dependency table")
    print()
    print("This table condenses the boundary graph by owning task. A task's `depends_on` list must contain each prerequisite task, and a prerequisite task must not depend on its dependent.")
    print()
    tasks, task_evidence = task_graph(dependencies, dependency_evidence)
    print("| Task | Prerequisite tasks | Example edge |")
    print("| --- | --- | --- |")
    for task in sorted(tasks):
        required = sorted(tasks[task])
        listed = ", ".join(f"`{item}`" for item in required) or "none"
        if required:
            source, target = task_evidence[(task, required[0])]
            example = f"`{source}` → `{target}`"
        else:
            example = "none"
        print(f"| `{task}` | {listed} | {example} |")
    print()
    task_cycles = [
        component
        for component in strongly_connected_components(tasks)
        if len(component) > 1
    ]
    if not task_cycles:
        print("- Task graph: acyclic")
    for component in sorted(task_cycles, key=lambda item: (-len(item), item)):
        print(f"- Task cycle ({len(component)} tasks):")
        for task in component:
            for required in sorted(tasks[task] & set(component)):
                source, target = task_evidence[(task, required)]
                print(f"  - `{task}` → `{required}`: `{source}` → `{target}`")

    print()
    print("### Module island order")
    print()
    print("Review boundaries express ownership and may contain modules from more than one dependency stage. The module islands below form the acyclic execution order.")
    print()
    for number, stage in enumerate(module_island_stages(graph), start=1):
        module_count = sum(len(component) for component in stage)
        multi_module = [component for component in stage if len(component) > 1]
        suffix = ""
        if multi_module:
            paths = ", ".join(f"`{path}`" for path in multi_module[0])
            suffix = f"; multi-module island: {paths}"
        print(f"- Stage {number}: {len(stage)} island(s), {module_count} module(s){suffix}")
    print("- Condensed module graph: acyclic")

    print()
    print("## Module paths by category")
    print()
    for category in category_names:
        selected = [row for row in rows if row["category"] == category]
        print(f"### {category} ({len(selected)})")
        for row in selected:
            features = ", ".join(sorted(row["features"])) or "no flagged syntax"
            reason = f"; {row['reason']}" if row["reason"] else ""
            print(f"- `{row['path']}` — {features}{reason}")

    print()
    print("## Cutover surfaces to review")
    print()
    print("- The engine module loader and runtime host files must load `.luau` sources and preserve module identity.")
    print("- Workspace config and generated BUILD naming must align with the Luau resolver; Imp no longer has an `imp init` command.")
    print("- `docs/BUILD.js` filters JavaScript sources for generated API references; its extractor, tests, generated `docs/content/reference/` pages, and documentation text need a migration decision.")
    print("- The installed `share/imp/rules/` tree and release smoke test must continue to package and load rule files beside the executable.")

    print()
    print("## Island and boundary policy")
    print()
    print("- Do not run JavaScript and Luau modules together in one graph.")
    print("- A boundary may land before its island is runnable. Validate the complete dependency-closed island before activation.")
    print("- Keep each review boundary at or below 20 authoring modules. Split runtime and validation files when their imports require different ordering.")
    print("- Treat conversion categories as review signals only. Review every module in its named boundary.")


def main() -> int:
    rows = [inspect_file(path) for path in tracked_javascript()]
    print_report(rows)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"inventory failed: {error}", file=sys.stderr)
        sys.exit(1)
