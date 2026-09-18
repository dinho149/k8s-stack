#!/usr/bin/env bash
# tsh-login.sh — headless `tsh login --auth local` (password + TOTP) for the local kind stack.
# Sourced after _common.sh (needs REPO_ROOT, STATE_DIR, UI_LOG_DIR, PROXY_ADDR, TSH_INSECURE_FLAG).
# Credentials come from tests/.state/users.json, written by tests/tools/seed-users (make up / make bootstrap-users).
TSH_BIN="${TSH_BIN:-$REPO_ROOT/bin/tsh}"
USERS_JSON="${USERS_JSON:-$STATE_DIR/users.json}"

tshlogin::require_creds() {
  [[ -f "$USERS_JSON" ]] || ui::die "no seeded credentials at tests/.state/users.json — run: make up  (or: make bootstrap-users)"
  python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)' "$USERS_JSON" "$1" \
    || ui::die "user '$1' is not enrolled — run: make bootstrap-users USERS=$1"
}
tshlogin::password() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["password"])' "$USERS_JSON" "$1"; }
# 30s window index in which the user was enrolled (enrolment consumes one TOTP code); 0 when unknown.
tshlogin::enrolled_window() { python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get(sys.argv[2],{}).get("enrolled_at",0))//30)' "$USERS_JSON" "$1"; }

# Teleport refuses a TOTP code that was already used. Remember only the 30s window index of the last
# code handed out (never the code itself) and wait for the next window when it is still the same one.
tshlogin::fresh_window() {
  local user="$1" now window last=0 enrolled
  local f="$UI_LOG_DIR/.totp-window-$user"
  now="$(date +%s)"; window=$(( now / 30 ))
  [[ -f "$f" ]] && last="$(cat "$f")"
  enrolled="$(tshlogin::enrolled_window "$user")"; (( enrolled > last )) && last=$enrolled
  if (( window == last )); then
    local wait=$(( 31 - now % 30 ))
    ui::info "waiting ${wait}s for a fresh TOTP window"
    sleep "$wait"; window=$(( $(date +%s) / 30 ))
  fi
  mkdir -p "$UI_LOG_DIR"; printf '%s' "$window" > "$f"
}
# tshlogin::code <user> -> prints a TOTP code that has not been used yet (may wait up to 30s)
tshlogin::code() {
  ui::require go
  tshlogin::fresh_window "$1" >&2   # callers capture stdout: only the code may go there
  go run -C "$REPO_ROOT/tests/tools" ./totp -users "$USERS_JSON" -user "$1"
}

# 0 when the active tsh profile is <user> on this proxy AND still works against the cluster. A profile left
# over from a previous cluster (make down / make up) looks valid locally but its CA no longer exists.
tshlogin::active_session_ok() {
  local user="$1"
  # shellcheck disable=SC2086
  $TSH status --format=json 2>/dev/null | python3 -c 'import json,sys; a=(json.load(sys.stdin).get("active") or {}); sys.exit(0 if a.get("username")==sys.argv[1] and a.get("profile_url","").endswith("//"+sys.argv[2]) else 1)' "$user" "$PROXY_ADDR" \
    && $TSH clusters >/dev/null 2>&1
}

# tshlogin::login <user> -> headless login into the current TELEPORT_HOME (default ~/.tsh)
# TSH_RELOGIN=1 forces a fresh login even when a working session for <user> exists.
tshlogin::login() {
  local user="$1" pw code
  # tsh insists on a terminal for password prompts, so drive it with expect (macOS ships it; CI installs it).
  command -v expect >/dev/null || ui::die "expect is required for headless tsh login (brew install expect / apt-get install expect)"
  [[ -x "$TSH_BIN" ]] || ui::die "tsh not installed (make tsh)"
  if [[ "${TSH_RELOGIN:-0}" != "1" ]] && tshlogin::active_session_ok "$user"; then
    ui::ok "already logged in as $user (TSH_RELOGIN=1 to log in again)"; return 0
  fi
  tshlogin::require_creds "$user"
  tshlogin::forget "$user"
  pw="$(tshlogin::password "$user")"
  code="$(tshlogin::code "$user")"
  mkdir -p "$UI_LOG_DIR"
  TSH_BIN="$TSH_BIN" TSH_INSECURE_FLAG="$TSH_INSECURE_FLAG" PROXY_ADDR="$PROXY_ADDR" TSH_USER="$user" TSH_PASSWORD="$pw" TSH_OTP="$code" \
    expect -f "$REPO_ROOT/deploy/scripts/lib/tsh-login.exp" >"$UI_LOG_DIR/tsh-login-$user.log" 2>&1 \
    || { ui::fail "login as $user failed — log: .logs/tsh-login-$user.log"; tail -20 "$UI_LOG_DIR/tsh-login-$user.log"; return 1; }
  # "Logged in as" on the terminal is not proof: verify the new session against the cluster.
  tshlogin::active_session_ok "$user" \
    || { ui::fail "tsh reports a session for $user but the cluster rejects it — log: .logs/tsh-login-$user.log"; tail -12 "$UI_LOG_DIR/tsh-login-$user.log"; return 1; }
  ui::ok "logged in as $user"
}

# Make `tsh login --user <user>` actually log in. While a non-expired session for this proxy exists, tsh's
# "same proxy, nothing else specified" branch ignores --user: it rewrites the profile to the new name without any
# keys and prints an EXPIRED session (tool/tsh/common/tsh.go, onLogin). So the proxy's active session is logged
# out first (`tsh logout` with --proxy is scoped to that proxy; other proxies are untouched), and a truncated key
# file left by such a run is removed. Both are needed before the prompts appear.
tshlogin::forget() {
  local user="$1" keys="${TELEPORT_HOME:-$HOME/.tsh}/keys/${PROXY_ADDR%%:*}"
  $TSH logout >/dev/null 2>&1 || true
  [[ -d "$keys" ]] || return 0
  local f; for f in "$keys/$user" "$keys/$user".* "$keys/$user"-*; do [[ -e "$f" ]] && rm -rf "$f"; done
  return 0
}
