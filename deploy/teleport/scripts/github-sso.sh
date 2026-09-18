#!/usr/bin/env bash
# github-sso.sh — store GitHub OAuth App credentials for the current stack and switch auth to GitHub.
#
# Team mapping (zero standing privilege): nobody gets `editor` or `access` through SSO. Admins hold
# requester + approver + auditor and request `break-glass-editor` (approved, 1h) when they need to
# change roles/users/tokens/connectors.
source "$(dirname "$0")/_common.sh"
cd "$REPO_ROOT/infra/teleport" || ui::die "cannot cd to infra/teleport"
ui::section "GitHub SSO for stack $STACK"
ui::info "1. https://github.com/settings/developers → New OAuth App"
ui::info "   Homepage URL:      https://$PROXY_ADDR"
ui::info "   Callback URL:      https://$PROXY_ADDR/v1/webapi/github/callback"
ui::info "2. Paste the values below. Teams are GitHub team slugs inside your organization."
echo
read -r -p "  GitHub organization: " org
read -r -p "  Client ID: " cid
read -r -s -p "  Client secret: " csec; echo
read -r -p "  Team that gets 'requester' only [teleport-users]: " t_req; t_req="${t_req:-teleport-users}"
read -r -p "  Team that also gets 'approver' [teleport-approvers]: " t_appr; t_appr="${t_appr:-teleport-approvers}"
read -r -p "  Team that gets requester,approver,auditor (no editor/access) [teleport-admins]: " t_adm; t_adm="${t_adm:-teleport-admins}"
[[ -n "$org" && -n "$cid" && -n "$csec" ]] || ui::die "organization, client id and client secret are required"
cfg() { pulumi config set --stack "$STACK" --path "$@"; }
cfg 'teleport:github.clientId' "$cid"
cfg 'teleport:github.organization' "$org"
# Replace the whole mapping so stale entries (e.g. an old editor mapping) cannot survive.
pulumi config rm --stack "$STACK" --path 'teleport:github.teamsToRoles' >/dev/null 2>&1 || true
cfg 'teleport:github.teamsToRoles[0].team' "$t_req"
cfg 'teleport:github.teamsToRoles[0].roles[0]' requester
cfg 'teleport:github.teamsToRoles[1].team' "$t_appr"
cfg 'teleport:github.teamsToRoles[1].roles[0]' requester
cfg 'teleport:github.teamsToRoles[1].roles[1]' approver
cfg 'teleport:github.teamsToRoles[2].team' "$t_adm"
i=0; for r in requester approver auditor; do cfg "teleport:github.teamsToRoles[2].roles[$i]" "$r"; i=$((i + 1)); done
# The secret goes in through stdin, never argv (it would show up in `ps` and shell history).
printf '%s' "$csec" | pulumi config set --stack "$STACK" --secret teleport:githubClientSecret
unset csec
cfg 'teleport:auth.type' github
if [[ "$STACK" != "local" ]]; then
  # Off the local cluster: SSO only, WebAuthn only (the profile invariants refuse anything else).
  cfg 'teleport:auth.localAuth' false
  pulumi config rm --stack "$STACK" --path 'teleport:auth.secondFactors' >/dev/null 2>&1 || true
  cfg 'teleport:auth.secondFactors[0]' webauthn
  ui::info "auth.localAuth=false, secondFactors=[webauthn] (non-local stack)"
fi
ui::ok "stored in Pulumi.$STACK.yaml (secret encrypted). Apply with: make deploy   then: make login"
