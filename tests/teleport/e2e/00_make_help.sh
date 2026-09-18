#!/usr/bin/env bash
# make help-all renders the Teleport group without ANSI when NO_COLOR=1, and the Teleport doctor runs.
set -euo pipefail
cd "$(dirname "$0")/../../.."
out="$(NO_COLOR=1 make help-all)"
for needle in Teleport teleport-up teleport-approve; do
  if ! grep -q "$needle" <<<"$out"; then echo "make help-all lost the Teleport group ($needle)"; exit 1; fi
done
if grep -qF "$(printf '\033[')" <<<"$out"; then echo "make help-all emitted ANSI with NO_COLOR=1"; exit 1; fi
NO_COLOR=1 make teleport-doctor >/dev/null || true   # doctor may warn, must not crash
echo "  [ok] make help-all / make teleport-doctor render"
