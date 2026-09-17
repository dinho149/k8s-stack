#!/usr/bin/env bash
# Shared environment for deploy scripts. Sourced, not executed.
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=lib/ui.sh
source "$REPO_ROOT/deploy/scripts/lib/ui.sh"
[[ -f "$REPO_ROOT/.env" ]] && set -a && source "$REPO_ROOT/.env" && set +a

STACK="${STACK:-local}"
KIND_CLUSTER="${KIND_CLUSTER:-teleport-local}"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-$KIND_CLUSTER}"
TELEPORT_VERSION="${TELEPORT_VERSION:-18.11.1}"
TELEPORT_NAMESPACE="${TELEPORT_NAMESPACE:-teleport}"
TELEPORT_RELEASE="${TELEPORT_RELEASE:-teleport-cluster}"
PROXY_ADDR="${PROXY_ADDR:-teleport.127.0.0.1.nip.io:3080}"
BIN_DIR="$REPO_ROOT/bin"
STATE_DIR="$REPO_ROOT/tests/.state"
TSH="${TSH:-$BIN_DIR/tsh --insecure --proxy $PROXY_ADDR}"
KUBECTL="kubectl --context $KUBE_CONTEXT"
export UI_LOG_DIR="$REPO_ROOT/.logs"

if [[ "$KIND_CLUSTER" == "kind" ]]; then ui::die "refusing to operate on the default kind cluster 'kind' (KIND_CLUSTER=kind)"; fi
true
