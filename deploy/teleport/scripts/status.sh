#!/usr/bin/env bash
# status.sh — one-screen dashboard of the local stack.
source "$(dirname "$0")/_common.sh"
ui::section "k8s-teleport status  ${UI_DIM}stack=$STACK cluster=$KIND_CLUSTER${UI_RESET}"
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then ui::status ok "kind" "$KIND_CLUSTER ($($KUBECTL get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ') node)"; else ui::status fail "kind" "cluster $KIND_CLUSTER not found — make kind-up"; exit 0; fi
if (cd "$REPO_ROOT/infra/teleport" && pulumi stack ls --json 2>/dev/null | python3 -c 'import json,sys; s=[x for x in json.load(sys.stdin) if x["name"]=="'"$STACK"'"]; sys.exit(0 if s and s[0].get("lastUpdate") else 1)') ; then
  ui::status ok "pulumi" "stack $STACK, last update $(cd "$REPO_ROOT/infra/teleport" && pulumi stack ls --json 2>/dev/null | python3 -c 'import json,sys; s=[x for x in json.load(sys.stdin) if x["name"]=="'"$STACK"'"][0]; print(s.get("lastUpdate","?"), "resources:", s.get("resourceCount","?"))')"
else ui::status warn "pulumi" "stack $STACK not deployed yet — make up"; fi
# shellcheck disable=SC2086 # CURL_INSECURE_FLAG is empty or -k, decided once in _common.sh
ping="$(curl -s $CURL_INSECURE_FLAG --max-time 3 "https://$PROXY_ADDR/webapi/ping" 2>/dev/null || true)"
if [[ -n "$ping" ]]; then ui::status ok "teleport" "$(printf '%s' "$ping" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cluster_name"), "v"+d.get("server_version",""), "auth:", d.get("auth",{}).get("type"))' 2>/dev/null)"; else ui::status fail "teleport" "https://$PROXY_ADDR not answering"; fi

ui::section "Pods"
rows=("NAMESPACE|POD|READY|STATUS|RESTARTS|AGE")
for ns in teleport teleport-agent teleport-dummies teleport-access; do
  while IFS= read -r line; do [[ -n "$line" ]] && rows+=("$line"); done < <($KUBECTL -n "$ns" get pods -o json 2>/dev/null | python3 "$REPO_ROOT/deploy/teleport/scripts/lib/pods.py" "$UI_OK" "$UI_BAD")
done
(( ${#rows[@]} > 1 )) && ui::table "${rows[@]}" || ui::info "no pods yet"

if [[ -n "$ping" ]] && $KUBECTL -n "$TELEPORT_NAMESPACE" get pods -l app.kubernetes.io/component=auth --no-headers 2>/dev/null | grep -q Running; then
  ui::section "Teleport inventory"
  T="$REPO_ROOT/deploy/teleport/scripts/tctl.sh"
  ui::kv "nodes"     "$($T nodes ls --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(sorted(set(n["spec"]["hostname"] for n in d))) or "none")' 2>/dev/null || echo '?')"
  ui::kv "databases" "$($T get db --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(sorted(x["metadata"]["name"] for x in d)) or "none")' 2>/dev/null || echo '?')"
  ui::kv "apps"      "$($T get app --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(sorted(x["metadata"]["name"] for x in d)) or "none")' 2>/dev/null || echo '?')"
  ui::kv "kube"      "$($T kube ls --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(sorted(x["metadata"]["name"] for x in d)) or "none")' 2>/dev/null || echo '?')"
  ui::kv "users"     "$($T users ls --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(sorted(u["metadata"]["name"] for u in d if not u["metadata"]["name"].startswith("bot-"))))' 2>/dev/null || echo '?')"
  pend="$($T requests ls --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin) or []; p=[r for r in d if r["spec"].get("state",1)==1]; print(len(p))' 2>/dev/null || echo '?')"
  ui::kv "pending requests" "$pend  ${UI_DIM}(make requests)${UI_RESET}"
fi

ui::section "You"
if [[ -x "$BIN_DIR/tsh" ]]; then $TSH status 2>/dev/null | sed 's/^/  /' | head -12 || ui::info "not logged in — make login"; else ui::info "tsh not installed — make tsh"; fi
