#!/bin/sh
# Verifies a staged release tree actually works the way an installed imp
# does: rules resolved from disk, next to the binary, with no workspace copy
# to fall back on.
#
# This is the only check that covers that path. imp's own test suite can't:
# `resolve_workspace_module` tries <workspace_root>/rules/... first, and this
# repo has rules/ at its root, so in-repo runs never consult the shipped tree.
# Hence the scratch workspace below is created outside the repo, on purpose.
#
# Usage: ci/smoke_package.sh <staging-dir>
#   <staging-dir>/bin/imp[.exe]
#   <staging-dir>/share/imp/rules/...

set -eu
# Select each runtime explicitly, independent of the caller.
export IMP_RUNTIME=js

stage="${1:?usage: ci/smoke_package.sh <staging-dir>}"
case "$stage" in
    /*) ;;
    *) stage="$PWD/$stage" ;;
esac

bin="$stage/bin/imp"
[ -x "$bin" ] || bin="$stage/bin/imp.exe"
rules="$stage/share/imp/rules"

fail() {
    echo "smoke: $*" >&2
    exit 1
}

[ -x "$bin" ] || fail "no executable at $stage/bin/imp[.exe]"

# Toolchain lockfiles are read at runtime through readAddressedFile, not
# imported, so they'd likewise slip through a resolution-only check.
for lock in rules/rust/rust.lock rules/python/uv-toolchain.lock; do
    [ -f "$stage/share/imp/$lock" ] || fail "missing $stage/share/imp/$lock"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/imp.workspace.js" <<'EOF'
import "//rules/imp/codegen";
EOF

cat >"$work/BUILD.js" <<'EOF'
import { stampFile } from "//rules/imp/codegen";
import { rulesTest } from "//rules/imp/test";

export const stamp = stampFile({
    output: "generated/smoke.txt",
    text: "packaged rules resolved from disk",
});

export const rules_test = rulesTest({
    root: "//consumer",
});
EOF

mkdir -p "$work/consumer"
cat >"$work/consumer/rules_test.js" <<'EOF'
import { BUILD } from "//rules/workflows/build";
import { describe, test } from "//rules/imp/test";

describe("builtin rules", () => {
    test("resolve from the packaged bundle", () => {
        if (typeof BUILD !== "symbol") {
            throw new Error("expected the builtin BUILD workflow");
        }
    });
});
EOF

# Must run *from* the scratch workspace: imp discovers its root from the
# working directory, so staying in the repo would silently test the repo's own
# rules/ instead of the packaged tree — the exact blind spot this covers.
cd "$work"

# IMP_RULES_DIR would short-circuit the exe-relative lookup this exists to
# test. XDG_CACHE_HOME keeps the run from touching the caller's real cache.
unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" targets //... >"$work/out" 2>"$work/err" || {
    echo "smoke: imp targets //... failed" >&2
    tail -30 "$work/err" >&2
    exit 1
}

grep -q '//:stamp' "$work/out" || {
    echo "smoke: expected //:stamp in target list" >&2
    cat "$work/out" >&2
    exit 1
}

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" test //:rules_test >"$work/test-out" 2>"$work/test-err" || {
  echo "smoke: rulesTest failed" >&2
  cat "$work/test-out" >&2
  cat "$work/test-err" >&2
  exit 1
}

grep -q 'test: 1/1 unit(s) passed' "$work/test-out" || {
  echo "smoke: rulesTest did not report a passing unit" >&2
  cat "$work/test-out" >&2
  cat "$work/test-err" >&2
  exit 1
}

# Exercise the installed Luau catalog from a separate workspace.
export IMP_RUNTIME=luau
# This also proves that the Luau rule files ship in the release tree.
[ -f "$rules/asset/index.luau" ] || fail "missing $rules/asset/index.luau"
mkdir -p "$work/luau"
cat >"$work/luau/imp.workspace.luau" <<'EOF'
local core = require("@imp/core")
local modules = { "asset", "c", "c/cmake", "c/generate_build", "imp/codegen", "imp/generate", "imp/lockfile", "js", "js/biome", "js/node", "js/pnpm", "oci", "odin", "odin/odinfmt", "odin/vscode", "python", "python/ruff/fmt", "python/ruff/lint", "rust", "rust/generate_build", "rust/kache", "treesitter", "workflows/builtin_lockfiles", "workflows/generate_build", "workflows/test", "workflows/vs", "zola" }
for _, name in ipairs(modules) do require("@imp/rules/" .. name) end

core.define_config_schema("smoke", {
    build_generate = core.field.bool({ default = false }),
})
core.register_build_rule({
    rule = "asset",
    module = "@imp/rules/asset",
})
core.register_build_generator({
    namespace = "smoke",
    generate = function()
        return {
            ["generated/BUILD.luau"] = {
                {
                    name = "generated_assets",
                    rule = "asset",
                    props = { srcs = { "*.txt" } },
                },
            },
        }
    end,
})

return { smoke = { build_generate = true } }
EOF
cat >"$work/luau/BUILD.luau" <<'EOF'
local asset = require("@imp/rules/asset")
local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")

return {
    rules_test = { [test.TEST] = core.test_root() },
    assets = asset.asset({ srcs = { "*.txt" } }),
}
EOF
cat >"$work/luau/packaged.test.luau" <<'EOF'
local core = require("@imp/core")
return { core.test.case("installed Luau catalog resolves", function()
    assert(type(require("@imp/rules/python").python_app) == "function")
    assert(type(require("@imp/rules/rust").cargo_package) == "function")
    assert(core.configuration_schemas().rust ~= nil)
end) }
EOF
mkdir -p "$work/luau/pkg"
cat >"$work/luau/pkg/shared.luau" <<'EOF'
return { srcs = { "*.txt" } }
EOF
cat >"$work/luau/pkg/BUILD.luau" <<'EOF'
local asset = require("@imp/rules/asset")
local shared = require("@workspace/pkg/shared")

return {
    nested_assets = asset.asset(shared),
}
EOF
echo "packaged Luau rule input" >"$work/luau/payload.txt"
echo "nested Luau rule input" >"$work/luau/pkg/payload.txt"
mkdir -p "$work/luau/generated"
echo "generated Luau rule input" >"$work/luau/generated/payload.txt"
cd "$work/luau"
unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" goal generate-build >"$work/luau-generate-out" 2>"$work/luau-generate-err" || {
    echo "smoke: Luau BUILD generation failed" >&2
    cat "$work/luau-generate-out" >&2
    cat "$work/luau-generate-err" >&2
    exit 1
}
grep -q 'Generated by Imp' generated/BUILD.luau || fail "expected generated Luau BUILD file"

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" goal generate-build --check >"$work/luau-generate-check-out" 2>"$work/luau-generate-check-err" || {
    echo "smoke: Luau BUILD generation check failed" >&2
    cat "$work/luau-generate-check-out" >&2
    cat "$work/luau-generate-check-err" >&2
    exit 1
}

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" targets //... >"$work/luau-out" 2>"$work/luau-err" || {
    echo "smoke: Luau target discovery failed" >&2
    cat "$work/luau-out" >&2
    cat "$work/luau-err" >&2
    exit 1
}
grep -q '//:assets' "$work/luau-out" || fail "expected //:assets in Luau target list"
grep -q '//pkg:nested_assets' "$work/luau-out" || fail "expected nested Luau target in target list"
grep -q '//generated:generated_assets' "$work/luau-out" || fail "expected generated Luau target in target list"

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" build //:assets >"$work/luau-build-out" 2>"$work/luau-build-err" || {
    echo "smoke: Luau asset build failed" >&2
    cat "$work/luau-build-out" >&2
    cat "$work/luau-build-err" >&2
    exit 1
}

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" build //pkg:nested_assets >"$work/luau-nested-build-out" 2>"$work/luau-nested-build-err" || {
    echo "smoke: nested Luau asset build failed" >&2
    cat "$work/luau-nested-build-out" >&2
    cat "$work/luau-nested-build-err" >&2
    exit 1
}

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" build //generated:generated_assets >"$work/luau-generated-build-out" 2>"$work/luau-generated-build-err" || {
    echo "smoke: generated Luau asset build failed" >&2
    cat "$work/luau-generated-build-out" >&2
    cat "$work/luau-generated-build-err" >&2
    exit 1
}

XDG_CACHE_HOME="$work/cache" "$bin" test //:rules_test >"$work/luau-test-out" 2>"$work/luau-test-err" || {
    cat "$work/luau-test-out" "$work/luau-test-err" >&2
    fail "installed Luau tests failed"
}
grep -q 'test: 1/1 unit(s) passed' "$work/luau-test-out" || fail "installed Luau test did not run"

echo "smoke: ok — $bin resolved packaged JS and Luau rules from $rules"
