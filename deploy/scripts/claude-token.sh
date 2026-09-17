#!/usr/bin/env bash
# claude-token.sh — store a Claude subscription token for the in-cluster access agent.
#
# `claude setup-token` is an interactive browser flow that draws a TUI, so it runs in YOUR terminal and
# this script does not try to scrape its output. Paste the token when asked; it is stored as the Pulumi
# secret teleport:chat.claudeCodeOauthToken and the agent is switched to auth=subscription.
source "$(dirname "$0")/_common.sh"
cd "$REPO_ROOT/infra/teleport"
ui::section "Claude subscription token for stack $STACK"
ui::require claude pulumi
ui::info "1. A browser window will open: sign in with the Claude Pro/Max account that should pay for the agent."
ui::info "2. Claude Code prints a long-lived token (valid one year). Copy it."
ui::info "3. Paste it here. It never appears in process arguments or logs."
echo
if ui::confirm "Run 'claude setup-token' now?"; then
  claude setup-token || ui::warn "setup-token exited with an error; if you already have a token you can still paste it"
  echo
fi
read -r -s -p "  Paste the token (input hidden): " tok; echo
tok="${tok//[[:space:]]/}"
[[ -n "$tok" ]] || ui::die "no token entered"
[[ "$tok" == sk-ant-oat* || "$tok" == oat* ]] || ui::warn "token does not look like a Claude Code OAuth token (expected sk-ant-oat…); storing anyway"
[[ "$tok" == sk-ant-api* ]] && ui::die "that is an Anthropic API key, not a subscription token — use teleport:chat.anthropicApiKey and auth=api-key instead"
pulumi config set --stack "$STACK" --secret --path 'teleport:chat.claudeCodeOauthToken' "$tok"
pulumi config set --stack "$STACK" --path 'teleport:services.agent.auth' subscription
pulumi config set --stack "$STACK" --path 'teleport:services.agent.enabled' true
ui::ok "stored (encrypted) in Pulumi.$STACK.yaml; agent auth=subscription, enabled=true"
ui::box "Next" "make images deploy          # roll the agent out (builds the image with the Claude Code CLI)" "make logs SVC=agent         # look for 'claude credential probe' ok=true" "" "${UI_DIM}The token is not refreshed automatically: re-run 'make claude-token' before it expires (one year).${UI_RESET}"
