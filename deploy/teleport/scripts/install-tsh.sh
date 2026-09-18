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
# Verify the tarball against the checksum Teleport publishes next to it before anything is extracted.
curl -fsSL --retry 3 -o "$tmp/$tarball.sha256" "$url.sha256" || ui::die "checksum download failed: $url.sha256"
expected="$(awk 'NR==1{print $1}' "$tmp/$tarball.sha256")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || ui::die "malformed checksum file $url.sha256: $(head -c 120 "$tmp/$tarball.sha256")"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
else actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"; fi
[[ "$actual" == "$expected" ]] || ui::die "sha256 mismatch for $tarball: expected $expected, got $actual (refusing to install)"
ui::ok "sha256 verified ($expected)"
tar -xzf "$tmp/$tarball" -C "$tmp"
# macOS ships tsh/tctl as app bundles (for Touch ID); Linux ships plain binaries.
for b in tsh tctl tbot teleport; do
  if [[ -f "$tmp/teleport/$b" ]]; then install -m 0755 "$tmp/teleport/$b" "$BIN_DIR/$b"
  elif [[ -f "$tmp/teleport/$b.app/Contents/MacOS/$b" ]]; then
    rm -rf "$BIN_DIR/$b.app"; cp -R "$tmp/teleport/$b.app" "$BIN_DIR/$b.app"; ln -sf "$b.app/Contents/MacOS/$b" "$BIN_DIR/$b"
  fi
done
ui::ok "installed $(find "$BIN_DIR" -maxdepth 1 -mindepth 1 -exec basename {} \; | tr '\n' ' ') into ./bin ($("$BIN_DIR/tsh" version | head -1))"
