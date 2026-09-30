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

# Exercise the installed Luau loader and asset rule from a separate workspace.
# This also proves that the Luau rule files ship in the release tree.
[ -f "$rules/asset/index.luau" ] || fail "missing $rules/asset/index.luau"
mkdir -p "$work/luau"
cat >"$work/luau/imp.workspace.luau" <<'EOF'
return {}
EOF
cat >"$work/luau/BUILD.luau" <<'EOF'
local asset = require("@imp/rules/asset")

return {
    assets = asset.asset({ srcs = { "*.txt" } }),
}
EOF
echo "packaged Luau rule input" >"$work/luau/payload.txt"
cd "$work/luau"
unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" targets //:assets >"$work/luau-out" 2>"$work/luau-err" || {
    echo "smoke: Luau target discovery failed" >&2
    cat "$work/luau-out" >&2
    cat "$work/luau-err" >&2
    exit 1
}
grep -q '//:assets' "$work/luau-out" || fail "expected //:assets in Luau target list"

unset IMP_RULES_DIR
XDG_CACHE_HOME="$work/cache" "$bin" build //:assets >"$work/luau-build-out" 2>"$work/luau-build-err" || {
    echo "smoke: Luau asset build failed" >&2
    cat "$work/luau-build-out" >&2
    cat "$work/luau-build-err" >&2
    exit 1
}

echo "smoke: ok — $bin resolved packaged JS and Luau rules from $rules"
