#!/usr/bin/env bash
# Shared helpers for the tsh end-to-end scenarios. Each script gets its own TELEPORT_HOME so users
# never share a profile. Requires: make tsh, make seed-test-users (tests/.state/users.json).
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$REPO_ROOT/deploy/scripts/lib/ui.sh"
PROXY_ADDR="${PROXY_ADDR:-teleport.127.0.0.1.nip.io:3080}"
TSH_BIN="${TSH_BIN:-$REPO_ROOT/bin/tsh}"
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
  # Teleport refuses a TOTP code that was already used: wait for a fresh 30s window if needed.
  local last_file="$UI_LOG_DIR/.totp-last-$user"
  code="$(go run -C "$REPO_ROOT/tests/tools" ./totp -users "$USERS_JSON" -user "$user")"
  if [[ -f "$last_file" && "$(cat "$last_file")" == "$code" ]]; then
    local wait=$(( 31 - $(date +%s) % 30 ))
    ui::info "waiting ${wait}s for a fresh TOTP code"
    sleep "$wait"
    code="$(go run -C "$REPO_ROOT/tests/tools" ./totp -users "$USERS_JSON" -user "$user")"
  fi
  mkdir -p "$UI_LOG_DIR"; printf '%s' "$code" > "$last_file"
  # tsh insists on a terminal for password prompts, so drive it with expect (macOS ships it; CI installs it).
  command -v expect >/dev/null || ui::die "expect is required for headless tsh login (apt-get install expect / brew install expect)"
  TSH_BIN="$TSH_BIN" PROXY_ADDR="$PROXY_ADDR" TSH_USER="$user" TSH_PASSWORD="$pw" TSH_OTP="$code" expect -f "$REPO_ROOT/tests/e2e/tsh-login.exp" >"$UI_LOG_DIR/tsh-login-$user.log" 2>&1 \
    || { ui::fail "login as $user failed"; tail -20 "$UI_LOG_DIR/tsh-login-$user.log"; return 1; }
  ui::ok "logged in as $user"
}
e2e::tsh() { "$TSH_BIN" --insecure --proxy "$PROXY_ADDR" "$@"; }
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
