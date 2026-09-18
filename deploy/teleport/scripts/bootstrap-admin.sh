#!/usr/bin/env bash
# bootstrap-admin.sh — (re-)enrol the LOCAL break-glass admin user headlessly: new password + TOTP.
#
# Local stack only: cloud stacks have no local users and no local auth (SSO + WebAuthn), and
# administration there goes through an approved `break-glass-editor` request.
# `make up` already enrols admin; run this to rotate the credentials or after they were lost.
source "$(dirname "$0")/_common.sh"
[[ "$STACK" == "local" ]] || ui::die "bootstrap-admin is for STACK=local only (STACK=$STACK has no local users; request break-glass-editor instead)"
user="${1:-admin}"
ui::section "Bootstrap $user"
"$REPO_ROOT/deploy/teleport/scripts/bootstrap-users.sh" "$user" --force
ui::info "log in:  make login            (tsh, no prompts)"
ui::info "         make web-login        (browser: prints user / password / TOTP)"
ui::warn "'$user' is a break-glass identity. When you are done, lock it:  deploy/teleport/scripts/tctl.sh lock --user=$user --message=\"break-glass\""
ui::info "(list locks: deploy/teleport/scripts/tctl.sh get locks   — unlock: deploy/teleport/scripts/tctl.sh rm lock/<id>)"
