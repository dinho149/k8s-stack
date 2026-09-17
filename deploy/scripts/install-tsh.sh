#!/usr/bin/env bash
# install-tsh.sh — download tsh/tctl/tbot for the pinned Teleport version into ./bin
source "$(dirname "$0")/_common.sh"
mkdir -p "$BIN_DIR"
if [[ -x "$BIN_DIR/tsh" ]] && "$BIN_DIR/tsh" version 2>/dev/null | grep -q "v$TELEPORT_VERSION"; then ui::ok "tsh v$TELEPORT_VERSION already installed in ./bin"; exit 0; fi
os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac
tarball="teleport-v${TELEPORT_VERSION}-${os}-${arch}-bin.tar.gz"
url="https://cdn.teleport.dev/$tarball"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ui::step "Downloading $tarball"
curl -fsSL --retry 3 -o "$tmp/$tarball" "$url" || ui::die "download failed: $url"
tar -xzf "$tmp/$tarball" -C "$tmp"
# macOS ships tsh/tctl as app bundles (for Touch ID); Linux ships plain binaries.
for b in tsh tctl tbot teleport; do
  if [[ -f "$tmp/teleport/$b" ]]; then install -m 0755 "$tmp/teleport/$b" "$BIN_DIR/$b"
  elif [[ -f "$tmp/teleport/$b.app/Contents/MacOS/$b" ]]; then
    rm -rf "$BIN_DIR/$b.app"; cp -R "$tmp/teleport/$b.app" "$BIN_DIR/$b.app"; ln -sf "$b.app/Contents/MacOS/$b" "$BIN_DIR/$b"
  fi
done
ui::ok "installed $(ls "$BIN_DIR" | tr '\n' ' ') into ./bin ($("$BIN_DIR/tsh" version | head -1))"
