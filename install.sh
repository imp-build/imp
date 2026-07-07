#!/bin/sh
# Installs the latest imp release into ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/imp-build/imp/main/install.sh | sh

set -eu

repo="imp-build/imp"
install_dir="${IMP_INSTALL_DIR:-$HOME/.local/bin}"

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
url="https://github.com/$repo/releases/latest/download/$asset"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading $url"
curl -fsSL "$url" -o "$tmpdir/$asset"

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
