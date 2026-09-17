#!/usr/bin/env bash
# bootstrap-admin.sh — issue a password/OTP reset link for the local admin user.
source "$(dirname "$0")/_common.sh"
user="${1:-admin}"
ui::section "Bootstrap $user"
out="$("$REPO_ROOT/deploy/scripts/tctl.sh" users reset "$user" --ttl=1h 2>&1 || "$REPO_ROOT/deploy/scripts/tctl.sh" users add "$user" --roles=editor,access,auditor,approver --logins=root,dev --ttl=1h 2>&1)"
url="$(printf '%s\n' "$out" | grep -oE 'https://[^ ]+' | head -1 | sed "s#https://[^/]*#https://$PROXY_ADDR#")"
[[ -n "$url" ]] || { printf '%s\n' "$out"; ui::die "could not extract invite URL"; }
ui::box "Open this link to set a password + OTP for '$user'" "$url" "" "${UI_DIM}The proxy uses a self-signed certificate locally: accept the browser warning.${UI_RESET}" "Then:  make login-local"
