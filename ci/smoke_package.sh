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

# init.js has no importers, so a module-resolution smoke test would not catch
# it going missing — but `imp init` is unusable without it.
[ -f "$rules/init.js" ] || fail "missing $rules/init.js"

# Toolchain lockfiles are read at runtime through readAddressedFile, not
# imported, so they'd likewise slip through a resolution-only check.
for lock in rules/rust/rust.lock rules/python/uv-toolchain.lock; do
    [ -f "$stage/share/imp/$lock" ] || fail "missing $stage/share/imp/$lock"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/imp.workspace.js" <<'EOF'
import "//rules/gen";
EOF

cat >"$work/BUILD.js" <<'EOF'
import { stampFile } from "//rules/gen";

export const stamp = stampFile({
    output: "generated/smoke.txt",
    text: "packaged rules resolved from disk",
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

echo "smoke: ok — $bin resolved //rules/gen from $rules"
