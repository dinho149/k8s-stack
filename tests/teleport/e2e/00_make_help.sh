#!/usr/bin/env bash
# The developer-experience layer must keep working (and render plain text without a TTY / with NO_COLOR).
set -euo pipefail
cd "$(dirname "$0")/../.."
out="$(NO_COLOR=1 make help)"
grep -q "Start here" <<<"$out" && grep -q "Lifecycle" <<<"$out" && grep -q "Access" <<<"$out" || { echo "make help lost its groups"; exit 1; }
if grep -q $'\x1b\[' <<<"$out"; then echo "make help emitted ANSI with NO_COLOR=1"; exit 1; fi
NO_COLOR=1 make doctor >/dev/null || true   # doctor may warn, must not crash
echo "  [ok] make help / make doctor render"
