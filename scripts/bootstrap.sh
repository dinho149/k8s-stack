#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
: "${DOGFOOD_NAME:?}" "${DOGFOOD_PROVIDER:?}"
mkdir -p "$ROOT/.dogfood"
started=$(date +%s)
mode=existing
if [[ "$DOGFOOD_PROVIDER" == kind ]]; then
  if ! kind get clusters 2>/dev/null | rg -qx "$DOGFOOD_NAME"; then
    mode=cold
    kind create cluster --name "$DOGFOOD_NAME" --image kindest/node:v1.34.0 --config "$ROOT/deploy/kind/config.yaml" --wait 0s
  fi
  kind export kubeconfig --name "$DOGFOOD_NAME"
  h upgrade --install cilium cilium --repo https://helm.cilium.io --version 1.18.3 --namespace kube-system --set operator.replicas=1 --set ipam.mode=kubernetes --set kubeProxyReplacement=false --set policyCIDRMatchMode=nodes --wait --timeout 5m
fi
k wait --for=condition=Ready nodes --all --timeout=180s
cluster_ready=$(date +%s)
printf 'CLUSTER READY: %ss (%s host)\n' "$((cluster_ready-started))" "$mode"
h upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm --version 8.3.5 --namespace argocd --create-namespace -f "$ROOT/deploy/argocd-values.yaml" --wait --timeout 5m
h upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version v1.5.0 --namespace envoy-gateway-system --create-namespace --wait --timeout 5m
if [[ "$DOGFOOD_PROFILE" == local ]]; then
 k apply -f "$ROOT/deploy/gateway.yaml"
 python3 "$ROOT/scripts/tool-routes.py" --domain "${DOGFOOD_DOMAIN:-127.0.0.1.nip.io}" | k apply -f -
else
 k apply -f "$ROOT/deploy/gateway-cloud.yaml"
fi
k apply -f "$ROOT/deploy/argocd-projects.yaml"
printf '{"provider":"%s","hostMode":"%s","clusterSeconds":%s,"platformSeconds":%s,"measuredAt":"%s"}\n' "$DOGFOOD_PROVIDER" "$mode" "$((cluster_ready-started))" "$(($(date +%s)-started))" "$(date -u +%FT%TZ)" > "$ROOT/.dogfood/bootstrap-timing.json"
echo "Base platform ready. Install selected catalog components with make catalog-sync REPOSITORY=https://your-repository.git."
cat "$ROOT/.dogfood/bootstrap-timing.json"
