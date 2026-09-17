#!/usr/bin/env bash
# github-sso.sh — store GitHub OAuth App credentials for the current stack and switch auth to GitHub.
source "$(dirname "$0")/_common.sh"
cd "$REPO_ROOT/infra/teleport"
ui::section "GitHub SSO for stack $STACK"
ui::info "1. https://github.com/settings/developers → New OAuth App"
ui::info "   Homepage URL:      https://$PROXY_ADDR"
ui::info "   Callback URL:      https://$PROXY_ADDR/v1/webapi/github/callback"
ui::info "2. Paste the values below. Teams are GitHub team slugs inside your organization."
echo
read -r -p "  GitHub organization: " org
read -r -p "  Client ID: " cid
read -r -s -p "  Client secret: " csec; echo
read -r -p "  Team that gets 'requester' only [engineering]: " t_req; t_req="${t_req:-engineering}"
read -r -p "  Team that also gets 'approver' [platform]: " t_appr; t_appr="${t_appr:-platform}"
read -r -p "  Team that gets full admin (editor,access,auditor,approver) [teleport-admins]: " t_adm; t_adm="${t_adm:-teleport-admins}"
[[ -n "$org" && -n "$cid" && -n "$csec" ]] || ui::die "organization, client id and client secret are required"
pulumi config set --stack "$STACK" --path 'teleport:github.clientId' "$cid"
pulumi config set --stack "$STACK" --path 'teleport:github.organization' "$org"
pulumi config set --stack "$STACK" --path 'teleport:github.teamsToRoles[0].team' "$t_req"
pulumi config set --stack "$STACK" --path 'teleport:github.teamsToRoles[0].roles[0]' requester
pulumi config set --stack "$STACK" --path 'teleport:github.teamsToRoles[1].team' "$t_appr"
pulumi config set --stack "$STACK" --path 'teleport:github.teamsToRoles[1].roles[0]' requester
pulumi config set --stack "$STACK" --path 'teleport:github.teamsToRoles[1].roles[1]' approver
pulumi config set --stack "$STACK" --path 'teleport:github.teamsToRoles[2].team' "$t_adm"
for i in 0 1 2 3; do r=(editor access auditor approver); pulumi config set --stack "$STACK" --path "teleport:github.teamsToRoles[2].roles[$i]" "${r[$i]}"; done
pulumi config set --stack "$STACK" --secret teleport:githubClientSecret "$csec"
pulumi config set --stack "$STACK" --path 'teleport:auth.type' github
ui::ok "stored in Pulumi.$STACK.yaml (secret encrypted). Apply with: make deploy   then: make login"
