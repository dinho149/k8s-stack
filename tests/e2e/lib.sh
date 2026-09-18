#!/usr/bin/env bash
# Shared helpers for the tsh end-to-end scenarios. Each script gets its own TELEPORT_HOME so users
# never share a profile. Requires: make tsh, make seed-test-users (tests/.state/users.json).
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$REPO_ROOT/deploy/scripts/lib/ui.sh"
STACK="${STACK:-local}"
PROXY_ADDR="${PROXY_ADDR:-teleport.127.0.0.1.nip.io:3080}"
TSH_BIN="${TSH_BIN:-$REPO_ROOT/bin/tsh}"
# Same TLS policy as deploy/scripts/_common.sh: skip verification only for the self-signed kind proxy.
if [[ "$STACK" == "local" && "$PROXY_ADDR" == *.127.0.0.1.nip.io* ]]; then TSH_INSECURE_FLAG="--insecure"
elif [[ "$PROXY_ADDR" == *.127.0.0.1.nip.io* ]]; then ui::die "PROXY_ADDR=$PROXY_ADDR is the loopback kind proxy but STACK=$STACK is not local"
else TSH_INSECURE_FLAG=""; fi
export TSH_INSECURE_FLAG
USERS_JSON="$REPO_ROOT/tests/.state/users.json"
TCTL="$REPO_ROOT/deploy/scripts/tctl.sh"
export UI_LOG_DIR="$REPO_ROOT/.logs"
[[ -x "$TSH_BIN" ]] || ui::die "tsh not installed (make tsh)"
[[ -f "$USERS_JSON" ]] || ui::die "tests/.state/users.json missing (make seed-test-users)"

# e2e::login <user> -> sets TELEPORT_HOME and logs in headlessly with password + TOTP
e2e::login() {
  local user="$1"
  export TELEPORT_HOME; TELEPORT_HOME="$(mktemp -d "${TMPDIR:-/tmp}/tsh-$user-XXXX")"
  local pw code
  pw="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["password"])' "$USERS_JSON" "$user")"
  # Teleport refuses a TOTP code that was already used: remember only the 30s window index of the last
  # login (never the code itself) and wait for the next window when it is the same one.
  local window_file="$UI_LOG_DIR/.totp-window-$user" now window
  now="$(date +%s)"; window=$(( now / 30 ))
  if [[ -f "$window_file" && "$(cat "$window_file")" == "$window" ]]; then
    local wait=$(( 31 - now % 30 ))
    ui::info "waiting ${wait}s for a fresh TOTP window"
    sleep "$wait"; window=$(( $(date +%s) / 30 ))
  fi
  mkdir -p "$UI_LOG_DIR"; printf '%s' "$window" > "$window_file"
  code="$(go run -C "$REPO_ROOT/tests/tools" ./totp -users "$USERS_JSON" -user "$user")"
  # tsh insists on a terminal for password prompts, so drive it with expect (macOS ships it; CI installs it).
  command -v expect >/dev/null || ui::die "expect is required for headless tsh login (apt-get install expect / brew install expect)"
  TSH_BIN="$TSH_BIN" TSH_INSECURE_FLAG="$TSH_INSECURE_FLAG" PROXY_ADDR="$PROXY_ADDR" TSH_USER="$user" TSH_PASSWORD="$pw" TSH_OTP="$code" expect -f "$REPO_ROOT/tests/e2e/tsh-login.exp" >"$UI_LOG_DIR/tsh-login-$user.log" 2>&1 \
    || { ui::fail "login as $user failed"; tail -20 "$UI_LOG_DIR/tsh-login-$user.log"; return 1; }
  ui::ok "logged in as $user"
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
