#!/usr/bin/env bash
# kind-up.sh — idempotently create the local kind cluster.
source "$(dirname "$0")/_common.sh"
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then ui::ok "kind cluster $KIND_CLUSTER already exists"; else
  # kind switches the current kube context on create; remember it and put it back so
  # other work on this machine is not disturbed. Our scripts always pass --context.
  prev_ctx="$(kubectl config current-context 2>/dev/null || true)"
  ui::spinner "Creating kind cluster $KIND_CLUSTER" kind create cluster --config "$REPO_ROOT/deploy/kind/cluster.yaml" --wait 120s
  if [[ -n "$prev_ctx" && "$prev_ctx" != "$KUBE_CONTEXT" ]]; then kubectl config use-context "$prev_ctx" >/dev/null 2>&1 && ui::info "kept your current kube context: $prev_ctx"; fi
fi
ui::kv "context" "$KUBE_CONTEXT"
