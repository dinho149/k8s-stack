#!/usr/bin/env bash
# Shared helpers for the tsh end-to-end scenarios. Each script gets its own TELEPORT_HOME so users
# never share a profile. Requires: make tsh and seeded credentials (make up / make seed-test-users).
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# _common.sh owns the TLS policy (TSH_INSECURE_FLAG only for STACK=local against the kind proxy), STATE_DIR and UI_LOG_DIR.
# shellcheck source=../../deploy/scripts/_common.sh
source "$REPO_ROOT/deploy/scripts/_common.sh"
# shellcheck source=../../deploy/scripts/lib/tsh-login.sh
source "$REPO_ROOT/deploy/scripts/lib/tsh-login.sh"
TCTL="$REPO_ROOT/deploy/scripts/tctl.sh"
[[ -x "$TSH_BIN" ]] || ui::die "tsh not installed (make tsh)"
[[ -f "$USERS_JSON" ]] || ui::die "tests/.state/users.json missing (make up, or: make seed-test-users)"

# e2e::login <user> -> fresh TELEPORT_HOME per user (profiles never shared), headless password + TOTP login
e2e::login() {
  export TELEPORT_HOME; TELEPORT_HOME="$(mktemp -d "${TMPDIR:-/tmp}/tsh-$1-XXXX")"
  tshlogin::login "$1"
}
# shellcheck disable=SC2086 # TSH_INSECURE_FLAG is empty or --insecure, decided once above
e2e::tsh() { "$TSH_BIN" $TSH_INSECURE_FLAG --proxy "$PROXY_ADDR" "$@"; }
# e2e::request_id <tsh request create args...> -> prints the new request id (or empty)
e2e::request_id() {
  e2e::tsh request create "$@" --nowait > "$UI_LOG_DIR/e2e-req.log" 2>&1 || true
  grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' "$UI_LOG_DIR/e2e-req.log" | head -1
}
# e2e::state <request-id> -> PENDING|APPROVED|DENIED|? (or MISSING when tctl cannot find it)
e2e::state() {
  "$TCTL" requests get "$1" --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print({1:"PENDING",2:"APPROVED",3:"DENIED"}.get(d["spec"].get("state",1),"?"))' 2>/dev/null || echo MISSING
}
e2e::expect_fail() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then ui::fail "expected failure: $desc"; return 1; else ui::ok "correctly refused: $desc"; fi; }
e2e::expect_ok() { local desc="$1"; shift; if "$@" >"$UI_LOG_DIR/e2e-last.log" 2>&1; then ui::ok "$desc"; else ui::fail "$desc"; tail -20 "$UI_LOG_DIR/e2e-last.log"; return 1; fi; }
# e2e::wait_state <request-id> <STATE> <seconds>
e2e::wait_state() {
  local id="$1" want="$2" t=0
  while (( t < ${3:-60} )); do
    local st; st="$("$TCTL" requests get "$id" --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print({1:"PENDING",2:"APPROVED",3:"DENIED"}.get(d["spec"].get("state",1),"?"))' 2>/dev/null || echo "?")"
    [[ "$st" == "$want" ]] && return 0
    sleep 3; t=$((t+3))
  done
  ui::fail "request $id not $want after ${3:-60}s"; return 1
}
