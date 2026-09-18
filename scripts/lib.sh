#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
: "${STACK_CONTEXT:?STACK_CONTEXT required}"
k() { if [[ "$STACK_CONTEXT" == in-cluster ]]; then kubectl "$@"; else kubectl --context "$STACK_CONTEXT" "$@"; fi; }
h() { if [[ "$STACK_CONTEXT" == in-cluster ]]; then helm "$@"; else helm --kube-context "$STACK_CONTEXT" "$@"; fi; }
require_owned_namespace() {
  local name=$1 owner
  owner=$(k get namespace "$name" -o jsonpath='{.metadata.labels.stack\.platform/managed}' 2>/dev/null || true)
  if [[ -n "$owner" && "$owner" != true ]]; then echo "Namespace is not managed by stack" >&2; exit 1; fi
  if k get namespace "$name" >/dev/null 2>&1 && [[ "$owner" != true ]]; then echo "Refusing to adopt existing namespace $name" >&2; exit 1; fi
}
