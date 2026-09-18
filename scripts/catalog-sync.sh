#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
: "${DOGFOOD_REPOSITORY:?Set the Git URL containing this repository}"
: "${DOGFOOD_PROFILE:=local}"
python3 "$ROOT/scripts/catalog-apps.py" "$DOGFOOD_REPOSITORY" "$DOGFOOD_PROFILE" | k apply -f -
