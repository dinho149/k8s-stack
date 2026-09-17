#!/usr/bin/env bash
# wait-teleport.sh — block until the proxy answers /webapi/ping and the operator is ready.
source "$(dirname "$0")/_common.sh"
timeout="${WAIT_TIMEOUT:-300}"
wait_ping() { local t=0; until curl -fsk --max-time 3 "https://$PROXY_ADDR/webapi/ping" >/dev/null 2>&1; do sleep 3; t=$((t+3)); (( t >= timeout )) && return 1; done; }
ui::spinner "Waiting for Teleport proxy at https://$PROXY_ADDR" wait_ping || ui::die "proxy did not become ready — try: make logs SVC=proxy"
ui::spinner "Waiting for auth rollout" $KUBECTL -n "$TELEPORT_NAMESPACE" rollout status deploy/"$TELEPORT_RELEASE"-auth --timeout="${timeout}s"
ui::spinner "Waiting for operator rollout" $KUBECTL -n "$TELEPORT_NAMESPACE" rollout status deploy/"$TELEPORT_RELEASE"-operator --timeout="${timeout}s"
ping="$(curl -sk "https://$PROXY_ADDR/webapi/ping")"
ui::kv "cluster" "$(printf '%s' "$ping" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cluster_name"), "teleport", d.get("server_version"))' 2>/dev/null || echo "$ping" | head -c 80)"
