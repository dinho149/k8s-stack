#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
: "${DOGFOOD_CONTEXT:?DOGFOOD_CONTEXT required}"
k() { if [[ "$DOGFOOD_CONTEXT" == in-cluster ]]; then kubectl "$@"; else kubectl --context "$DOGFOOD_CONTEXT" "$@"; fi; }
h() { if [[ "$DOGFOOD_CONTEXT" == in-cluster ]]; then helm "$@"; else helm --kube-context "$DOGFOOD_CONTEXT" "$@"; fi; }
require_owned_namespace() {
  local name=$1 owner
  owner=$(k get namespace "$name" -o jsonpath='{.metadata.labels.dogfood\.platform/managed}' 2>/dev/null || true)
  if [[ -n "$owner" && "$owner" != true ]]; then echo "Namespace is not managed by dogfood" >&2; exit 1; fi
  if k get namespace "$name" >/dev/null 2>&1 && [[ "$owner" != true ]]; then echo "Refusing to adopt existing namespace $name" >&2; exit 1; fi
}
