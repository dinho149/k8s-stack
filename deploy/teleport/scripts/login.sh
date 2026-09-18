#!/usr/bin/env bash
# login.sh — `tsh login` the way the cluster is configured: GitHub SSO when a connector exists,
# otherwise a headless local login (password + TOTP from .dogfood/teleport/state/users.json).
#
#   login.sh [user]        default user: $USER_NAME, then admin
source "$(dirname "$0")/_common.sh"
# shellcheck source=lib/tsh-login.sh
source "$REPO_ROOT/deploy/teleport/scripts/lib/tsh-login.sh"
user="${1:-${USER_NAME:-admin}}"
[[ -x "$TSH_BIN" ]] || "$REPO_ROOT/deploy/teleport/scripts/install-tsh.sh"

# shellcheck disable=SC2086 # CURL_INSECURE_FLAG is empty or -k, decided once in _common.sh
ping="$(curl -fsS $CURL_INSECURE_FLAG --max-time 5 "https://$PROXY_ADDR/webapi/ping" 2>/dev/null)" \
  || ui::die "https://$PROXY_ADDR is not answering — is the cluster up? (make teleport-up / make teleport-status)"
auth="$(printf '%s' "$ping" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("auth",{}).get("type",""))')"

case "$auth" in
  github)
    ui::step "GitHub SSO login (opens your browser)"
    $TSH login --auth github ;;
  local)
    [[ "$STACK" == "local" ]] || ui::die "auth.type=local on STACK=$STACK — configure SSO (make teleport-github-sso)"
    ui::step "Local login as $user (password + TOTP from .dogfood/teleport/state/users.json)"
    tshlogin::login "$user" ;;
  *)
    ui::die "unsupported auth type '${auth:-unknown}' — log in manually: $TSH login" ;;
esac
$TSH status
