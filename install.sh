#!/bin/sh
# Installs the latest imp release into ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/imp-build/imp/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/imp-build/imp/main/install.sh | sh -s -- --draft
#   ./install.sh --local

set -eu

repo="imp-build/imp"
install_dir="${IMP_INSTALL_DIR:-$HOME/.local/bin}"
draft=false
local_install=false

usage() {
    echo "usage: install.sh [--draft | --local]"
    echo "  --draft  install the rolling main-preview draft (requires authenticated gh)"
    echo "  --local  install a shim that rebuilds and runs this checkout"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --draft) draft=true ;;
        --local) local_install=true ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$draft" = true ] && [ "$local_install" = true ]; then
    echo "--draft and --local cannot be used together" >&2
    exit 2
fi

if [ "$local_install" = true ]; then
    if ! command -v cargo >/dev/null 2>&1; then
        echo "--local requires cargo" >&2
        exit 1
    fi

    repo_dir="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"
    manifest="$repo_dir/crates/imp/Cargo.toml"
    rules_dir="$repo_dir/rules"
    binary="$repo_dir/target/release/imp"

    if [ ! -f "$manifest" ] || [ ! -d "$rules_dir" ]; then
        echo "--local must be run from a checked-out imp repository" >&2
        exit 1
    fi

    echo "Building optimized local imp"
    CARGO_TARGET_DIR="$repo_dir/target" cargo build \
        --release \
        --manifest-path "$manifest"

    mkdir -p "$install_dir"
    shim_tmp="$(mktemp "$install_dir/.imp-local.XXXXXX")"
    trap 'rm -f "$shim_tmp"' EXIT
    {
        echo '#!/bin/sh'
        echo 'set -e'
        printf "export IMP_RULES_DIR='%s'\n" "$(printf '%s' "$rules_dir" | sed "s/'/'\\\\''/g")"
        printf "CARGO_TARGET_DIR='%s' cargo build --release --manifest-path '%s'\n" \
            "$(printf '%s' "$repo_dir/target" | sed "s/'/'\\\\''/g")" \
            "$(printf '%s' "$manifest" | sed "s/'/'\\\\''/g")"
        printf "exec '%s' \"\$@\"\n" "$(printf '%s' "$binary" | sed "s/'/'\\\\''/g")"
    } > "$shim_tmp"
    chmod +x "$shim_tmp"
    mv -f "$shim_tmp" "$install_dir/imp"
    trap - EXIT

    echo "Installed local imp shim to $install_dir/imp"
    echo "Binary: $binary"
    echo "Rules:  $rules_dir (live from this checkout, via IMP_RULES_DIR)"
    echo "The shim will rebuild changed Rust code before each run."
    exit 0
fi

arch="$(uname -m)"
os="$(uname -s)"

case "$os" in
    Linux) ;;
    *)
        echo "install.sh only supports Linux; see https://github.com/$repo for other platforms" >&2
        exit 1
        ;;
esac

case "$arch" in
    x86_64|amd64) target="x86_64-unknown-linux-musl" ;;
    *)
        echo "unsupported architecture: $arch" >&2
        exit 1
        ;;
esac

asset="imp-$target.tar.gz"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

if [ "$draft" = true ]; then
    if ! command -v gh >/dev/null 2>&1; then
        echo "--draft requires the GitHub CLI; install gh and authenticate with 'gh auth login'" >&2
        exit 1
    fi
    echo "Downloading $asset from the main-preview draft"
    gh release download main-preview --repo "$repo" --pattern "$asset" --dir "$tmpdir"
else
    url="https://github.com/$repo/releases/latest/download/$asset"
    echo "Downloading $url"
    curl -fsSL "$url" -o "$tmpdir/$asset"
fi

tar -C "$tmpdir" -xzf "$tmpdir/$asset"

# The archive is a self-contained prefix (bin/ + share/imp/rules/), because
# the rule library is no longer compiled into the binary. Install both, keeping
# the same relative layout so imp finds its rules next to itself.
stage="$tmpdir/imp-$target"
if [ ! -d "$stage/share/imp/rules" ]; then
    echo "$asset is missing share/imp/rules; it predates on-disk rules — upgrade install.sh" >&2
    exit 1
fi

rules_root="${IMP_RULES_INSTALL_DIR:-$(dirname "$install_dir")/share/imp/rules}"

# Replace rather than merge: a rule deleted upstream would otherwise linger and
# still resolve. Guarded so a surprising IMP_RULES_INSTALL_DIR can't take out
# an unrelated directory.
case "$rules_root" in
    */share/imp/rules) ;;
    *)
        echo "refusing to install rules to $rules_root (must end in share/imp/rules)" >&2
        exit 1
        ;;
esac

mkdir -p "$install_dir" "$(dirname "$rules_root")"
rm -rf "$rules_root"
mv "$stage/share/imp/rules" "$rules_root"
mv "$stage/bin/imp" "$install_dir/imp"
chmod +x "$install_dir/imp"

echo "Installed imp to $install_dir/imp"
echo "Installed rules to $rules_root"

case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
        echo "warning: $install_dir is not on your PATH — add it, e.g.:"
        echo "  export PATH=\"$install_dir:\$PATH\""
        ;;
esac
