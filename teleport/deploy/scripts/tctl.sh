#!/usr/bin/env bash
# tctl.sh — run tctl inside the Teleport auth pod (admin identity, no login needed).
source "$(dirname "$0")/_common.sh"
pod="$($KUBECTL -n "$TELEPORT_NAMESPACE" get pods -l app.kubernetes.io/component=auth -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$pod" ]] || ui::die "no auth pod found in namespace $TELEPORT_NAMESPACE (is the stack up?)"
exec $KUBECTL -n "$TELEPORT_NAMESPACE" exec -i "$pod" -c teleport -- tctl "$@"
