#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
: "${STACK_REPOSITORY:?Set the Git URL containing this repository}"
: "${STACK_PROFILE:=local}"
python3 "$ROOT/scripts/catalog-apps.py" "$STACK_REPOSITORY" "$STACK_PROFILE" | k apply -f -
