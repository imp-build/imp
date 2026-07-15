#!/bin/sh
# Installs the latest imp release into ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/imp-build/imp/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/imp-build/imp/main/install.sh | sh -s -- --draft

set -eu

repo="imp-build/imp"
install_dir="${IMP_INSTALL_DIR:-$HOME/.local/bin}"
draft=false

usage() {
    echo "usage: install.sh [--draft]"
    echo "  --draft  install the rolling main-preview draft (requires authenticated gh)"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --draft) draft=true ;;
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

mkdir -p "$install_dir"
mv "$tmpdir/imp" "$install_dir/imp"
chmod +x "$install_dir/imp"

echo "Installed imp to $install_dir/imp"

case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
        echo "warning: $install_dir is not on your PATH — add it, e.g.:"
        echo "  export PATH=\"$install_dir:\$PATH\""
        ;;
esac
