#!/usr/bin/env bash
# web-login.sh — open the Teleport web UI and print what to type: user, password and a fresh TOTP code.
# Local stack only: the credentials are the throwaway ones seeded into tests/.state/users.json.
#
#   web-login.sh [user]    default user: $USER_NAME, then admin
source "$(dirname "$0")/_common.sh"
# shellcheck source=lib/tsh-login.sh
source "$REPO_ROOT/deploy/scripts/lib/tsh-login.sh"
[[ "$STACK" == "local" ]] || ui::die "web-login is for STACK=local only (cloud stacks log in with SSO at https://$PROXY_ADDR)"
user="${1:-${USER_NAME:-admin}}"
url="https://$PROXY_ADDR/web/login"
tshlogin::require_creds "$user"
code="$(tshlogin::code "$user")"
left=$(( 30 - $(date +%s) % 30 ))
# A code with only a few seconds left is useless for typing: take the next window instead.
if (( left < 12 )); then ui::info "code expires in ${left}s — waiting for the next one"; code="$(tshlogin::code "$user")"; left=$(( 30 - $(date +%s) % 30 )); fi
note="$(common::tls_note)"
ui::box "Web UI login as '$user'" "$url" "" \
  "user       $user" \
  "password   $(tshlogin::password "$user")" \
  "TOTP code  $code   ${UI_DIM}(valid ${left}s — run again for a new one)${UI_RESET}" "" \
  "${UI_DIM}${note}${UI_RESET}"
if [[ -t 1 ]]; then
  if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true; fi
fi
