#!/usr/bin/env bash
# portal-forward.sh — make the in-cluster access portal API reachable by the local Backstage backend
# (make teleport-portal-forward): port-forwards svc/access-portal to 127.0.0.1:18383 and writes
# .dogfood/teleport-portal.env (TELEPORT_PORTAL_URL + TELEPORT_SERVICE_TOKEN, 0600) which scripts/local.py
# loads into the backend's environment. Foreground by default (ctrl-c stops it); --background detaches.
source "$(dirname "$0")/_common.sh"
[[ "$STACK" == "local" ]] || ui::die "portal-forward is for STACK=local only (in cloud the Backstage backend reaches the Service directly)"
local_port="${PORTAL_LOCAL_PORT:-18383}"
env_file="$REPO_ROOT/.dogfood/teleport-portal.env"
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-local-dev}"
pushd "$REPO_ROOT/infra/teleport" >/dev/null || exit 1
pulumi login "${PULUMI_BACKEND_URL:-file://$REPO_ROOT/.dogfood/teleport/pulumi}" >/dev/null 2>&1 || true
token="$(pulumi stack output portalServiceToken --show-secrets --stack "$STACK" 2>/dev/null || true)"
popd >/dev/null || exit 1
[[ -n "$token" ]] || ui::die "could not read portalServiceToken from stack $STACK (deploy first: make teleport-up)"
$KUBECTL -n teleport-access get svc access-portal >/dev/null 2>&1 || ui::die "svc/access-portal not found: the stack predates the access portal (make teleport-deploy)"
umask 077
mkdir -p "$(dirname "$env_file")"
printf 'TELEPORT_PORTAL_URL=http://127.0.0.1:%s\nTELEPORT_SERVICE_TOKEN=%s\n' "$local_port" "$token" > "$env_file"
ui::ok "wrote $env_file (0600) — the Backstage backend picks it up on make up / make restart"
if lsof -nP -iTCP:"$local_port" -sTCP:LISTEN >/dev/null 2>&1; then ui::info "127.0.0.1:$local_port already listening (a forward is running)"; exit 0; fi
if [[ "${1:-}" == "--background" ]]; then
  # shellcheck disable=SC2086 # KUBECTL is "kubectl --context <ctx>", word-split on purpose
  nohup $KUBECTL -n teleport-access port-forward svc/access-portal "$local_port:8084" >"$UI_LOG_DIR/pf-portal.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 30); do
    if curl -fs --max-time 2 "http://127.0.0.1:$local_port/healthz" >/dev/null 2>&1; then
      ui::ok "portal API forwarded to http://127.0.0.1:$local_port (pid $pid, log .dogfood/logs/teleport/pf-portal.log)"; exit 0
    fi
    sleep 0.5
  done
  ui::die "port-forward did not come up — see $UI_LOG_DIR/pf-portal.log"
fi
ui::step "forwarding 127.0.0.1:$local_port → teleport-access/access-portal:8084 (ctrl-c to stop)"
exec $KUBECTL -n teleport-access port-forward svc/access-portal "$local_port:8084"
