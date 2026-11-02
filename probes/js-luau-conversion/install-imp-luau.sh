#!/bin/sh
# Install a frozen copy of the imp checkout as `imp-luau`, beside the old `imp`.
#
# Usage: install-imp-luau.sh <imp-checkout>
#
# Build the release binary first:
#   cargo build --release --locked --manifest-path crates/imp/Cargo.toml
#
# The script copies target/release/imp and rules/ into ~/.local/opt/imp-luau
# and writes the ~/.local/bin/imp-luau wrapper. It does not change
# ~/.local/bin/imp. Remove it when the installed imp changes to Luau
# (task 2026-10-29-flip-installed-imp-to-luau).
set -eu
repo="$(cd "$1" && pwd -P)"
prefix="$HOME/.local/opt/imp-luau"
sha="$(git -C "$repo" rev-parse --short HEAD)"

mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
stage="$(mktemp -d "$HOME/.local/opt/.imp-luau.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/share/imp"
cp "$repo/target/release/imp" "$stage/bin/imp"
cp -R "$repo/rules" "$stage/share/imp/rules"
echo "$sha" > "$stage/REVISION"

rm -rf "$prefix.old"
[ -d "$prefix" ] && mv "$prefix" "$prefix.old"
mv "$stage" "$prefix"
trap - EXIT
rm -rf "$prefix.old"

# The daemon listens on one fixed loopback port. A separate port stops imp-luau
# from sending actions to a daemon of the old imp. A separate cache root keeps
# the two cache layouts apart and gives clean benchmark times.
cat > "$HOME/.local/bin/imp-luau" <<EOF
#!/bin/sh
export IMP_DAEMON_ADDR="\${IMP_LUAU_DAEMON_ADDR:-127.0.0.1:49672}"
export IMP_CACHE_DIR="\${IMP_LUAU_CACHE_DIR:-\$HOME/.cache/imp-luau}"
exec "$prefix/bin/imp" "\$@"
EOF
chmod +x "$HOME/.local/bin/imp-luau"
echo "imp-luau $sha installed at $prefix"
