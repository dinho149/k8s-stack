#!/usr/bin/env bash
# bootstrap-admin.sh — issue a password/OTP reset link for the LOCAL break-glass admin user.
#
# Local stack only: cloud stacks have no local users and no local auth (SSO + WebAuthn), and
# administration there goes through an approved `break-glass-editor` request.
source "$(dirname "$0")/_common.sh"
[[ "$STACK" == "local" ]] || ui::die "bootstrap-admin is for STACK=local only (STACK=$STACK has no local users; request break-glass-editor instead)"
user="${1:-admin}"
ui::section "Bootstrap $user"
tctl="$REPO_ROOT/deploy/scripts/tctl.sh"
# Fallback user: editor + auditor only — no `access` (no SSH/db/kube), no `approver`, no logins.
out="$("$tctl" users reset "$user" --ttl=1h 2>&1 || "$tctl" users add "$user" --roles=editor,auditor --ttl=1h 2>&1)"
url="$(printf '%s\n' "$out" | grep -oE 'https://[^ ]+' | head -1 | sed "s#https://[^/]*#https://$PROXY_ADDR#")"
[[ -n "$url" ]] || { printf '%s\n' "$out"; ui::die "could not extract invite URL"; }
ui::box "Open this link to set a password + OTP for '$user'" "$url" "" "${UI_DIM}The proxy uses a self-signed certificate locally: accept the browser warning.${UI_RESET}" "Then:  make login-local"
ui::warn "'$user' is a break-glass identity. When you are done, lock it:  deploy/scripts/tctl.sh lock --user=$user --message=\"break-glass\""
ui::info "(list locks: deploy/scripts/tctl.sh get locks   — unlock: deploy/scripts/tctl.sh rm lock/<id>)"
