#!/usr/bin/env bash
# The service-to-service identity contract fails closed:
#   - broker: POST /v1/requests/<id>/approve with a body-supplied `approver` -> 400 (identity must come from
#     the signed X-Teleport-Assertion header, never from the body)
#   - MCP: a request with the shared bearer token + X-Teleport-User but no X-Teleport-Assertion -> 401
# Uses localhost port-forwards and the stack's secret outputs, like deploy/scripts/agent-cli.sh.
source "$(dirname "$0")/lib.sh"
ui::section "e2e 08: service auth fails closed (no body identity, no header identity)"
[[ "$STACK" == "local" ]] || { ui::warn "skipped: only runs against the kind stack"; exit 0; }
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-${KIND_CLUSTER:-teleport-local}}"
KUBECTL="kubectl --context $KUBE_CONTEXT"
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-local-dev}"
pushd "$REPO_ROOT/infra/teleport" >/dev/null || exit 1
pulumi login "${PULUMI_BACKEND_URL:-file://$REPO_ROOT/infra/.state}" >/dev/null 2>&1 || true
broker_token="$(pulumi stack output brokerApiToken --show-secrets --stack "$STACK" 2>/dev/null || true)"
mcp_token="$(pulumi stack output mcpSharedToken --show-secrets --stack "$STACK" 2>/dev/null || true)"
popd >/dev/null || exit 1
[[ -n "$broker_token" && -n "$mcp_token" ]] || ui::die "could not read brokerApiToken/mcpSharedToken from stack $STACK"

pids=()
cleanup() { local p; for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done; return 0; }
trap cleanup EXIT
$KUBECTL -n teleport-access port-forward svc/access-broker 18081:8081 >"$UI_LOG_DIR/e2e-pf-broker.log" 2>&1 & pids+=($!)
$KUBECTL -n teleport-access port-forward svc/teleport-mcp 18080:8080 >"$UI_LOG_DIR/e2e-pf-mcp.log" 2>&1 & pids+=($!)
for _ in $(seq 1 20); do curl -fs --max-time 2 http://localhost:18081/healthz >/dev/null 2>&1 && curl -s --max-time 2 -o /dev/null http://localhost:18080/mcp 2>/dev/null && break; sleep 1; done

# 1. broker refuses a body-supplied approver (400), even with a valid API token and a real request id.
e2e::login alice
id="$(e2e::request_id --roles prod-ssh --reason "e2e: identity contract" --max-duration 1h)"
[[ -n "$id" ]] || { ui::fail "could not create request"; cat "$UI_LOG_DIR/e2e-req.log"; exit 1; }
ui::kv "request" "$id"
code="$(curl -s -o "$UI_LOG_DIR/e2e-broker-approve.log" -w '%{http_code}' --max-time 10 \
  -X POST "http://localhost:18081/v1/requests/$id/approve" \
  -H "Authorization: Bearer $broker_token" -H "Content-Type: application/json" \
  -d '{"approver":"bob","reason":"e2e body identity"}')"
# Without a signed assertion the broker answers 401 before it even parses the body; with one, the unknown
# `approver` field is a 400. Either way the body can never name the approver.
case "$code" in
  400|401) ui::ok "broker: body-supplied approver without assertion -> $code (fail closed)";;
  *) ui::fail "broker: expected 400/401, got $code"; cat "$UI_LOG_DIR/e2e-broker-approve.log"; exit 1;;
esac
st="$(e2e::state "$id")"
[[ "$st" != "APPROVED" ]] && ui::ok "request still $st" || { ui::fail "request was approved through the body identity!"; exit 1; }
"$TCTL" request deny --reason "e2e cleanup" "$id" >/dev/null 2>&1 || true

# 2. MCP refuses a bearer-only caller that names a user without a signed assertion (401).
code="$(curl -s -o "$UI_LOG_DIR/e2e-mcp-noassert.log" -w '%{http_code}' --max-time 10 \
  -X POST "http://localhost:18080/mcp" \
  -H "Authorization: Bearer $mcp_token" -H "X-Teleport-User: alice" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}')"
[[ "$code" == "401" ]] && ui::ok "mcp: bearer + X-Teleport-User without assertion -> 401" || { ui::fail "mcp: expected 401, got $code"; cat "$UI_LOG_DIR/e2e-mcp-noassert.log"; exit 1; }
