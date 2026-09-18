#!/usr/bin/env bash
# Compatibility entry point; the documented interface is Make.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
exec make up
