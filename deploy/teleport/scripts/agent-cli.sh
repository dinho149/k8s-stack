#!/usr/bin/env bash
# agent-cli.sh <teleport-user> [args...] — chat with the access agent from the terminal.
#
# Backend selection (override with AUTH=api-key|subscription):
#   - ANTHROPIC_API_KEY exported            -> api-key backend (Anthropic API + tool runner)
#   - otherwise, `claude` on PATH           -> subscription backend using YOUR Claude Code login (no token needed)
source "$(dirname "$0")/_common.sh"
# The CLI adapter reads the stack's shared secrets and port-forwards into the cluster: kind only.
[[ "$STACK" == "local" ]] || ui::die "make agent-cli is only for STACK=local (current: $STACK); use the chat adapters on cloud stacks"
as="${1:-admin}"; shift || true
[[ -d "$REPO_ROOT/node_modules/@anthropic-ai" ]] || ui::die "run: make deps"
mode="${AUTH:-${CLAUDE_AUTH_MODE:-}}"
if [[ -z "$mode" ]]; then
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then mode=api-key
  elif command -v claude >/dev/null 2>&1; then mode=subscription
  else ui::die "no credentials: export ANTHROPIC_API_KEY, or install Claude Code and run 'claude' once to log in"; fi
fi
export CLAUDE_AUTH_MODE="$mode"
if [[ "$mode" == "subscription" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then export CLAUDE_ALLOW_LOCAL_LOGIN=true; fi
# Read the shared tokens from the stack unless already provided.
if [[ -z "${MCP_SHARED_TOKEN:-}" || -z "${BROKER_API_TOKEN:-}" || -z "${IDENTITY_SIGNING_KEY:-}" ]]; then
  export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-local-dev}"
  pushd "$REPO_ROOT/infra/teleport" >/dev/null || exit 1
  pulumi login "${PULUMI_BACKEND_URL:-file://$REPO_ROOT/.dogfood/teleport/pulumi}" >/dev/null 2>&1 || true
  export MCP_SHARED_TOKEN="${MCP_SHARED_TOKEN:-$(pulumi stack output mcpSharedToken --show-secrets --stack "$STACK" 2>/dev/null)}"
  export BROKER_API_TOKEN="${BROKER_API_TOKEN:-$(pulumi stack output brokerApiToken --show-secrets --stack "$STACK" 2>/dev/null)}"
  # Per-turn identity assertions (X-Teleport-Assertion) are signed with this key; MCP and broker verify it.
  export IDENTITY_SIGNING_KEY="${IDENTITY_SIGNING_KEY:-$(pulumi stack output identitySigningKey --show-secrets --stack "$STACK" 2>/dev/null)}"
  popd >/dev/null || exit 1
fi
[[ -n "$MCP_SHARED_TOKEN" ]] || ui::die "could not read mcpSharedToken from stack $STACK (is it deployed?)"
[[ -n "$IDENTITY_SIGNING_KEY" ]] || ui::die "could not read identitySigningKey from stack $STACK (redeploy: make deploy)"
# Port-forward MCP and broker unless URLs were given.
pids=()
if [[ -z "${MCP_URL:-}" ]]; then $KUBECTL -n teleport-access port-forward svc/teleport-mcp 18380:8080 >"$UI_LOG_DIR/pf-mcp.log" 2>&1 & pids+=($!); export MCP_URL=http://localhost:18380/mcp; fi
if [[ -z "${BROKER_URL:-}" ]]; then $KUBECTL -n teleport-access port-forward svc/access-broker 18381:8081 >"$UI_LOG_DIR/pf-broker.log" 2>&1 & pids+=($!); export BROKER_URL=http://localhost:18381; fi
cleanup() { local p; for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done; return 0; }
trap cleanup EXIT
(( ${#pids[@]} )) && sleep 3
ui::box "Access agent — CLI adapter" "acting as Teleport user: $as" "backend: $mode$([[ "$mode" == subscription ]] && echo " (${CLAUDE_CODE_OAUTH_TOKEN:+setup-token}${CLAUDE_CODE_OAUTH_TOKEN:-your local Claude Code login})")" "MCP: $MCP_URL   broker: $BROKER_URL" "type /help for commands, ctrl-d to quit"
cd "$REPO_ROOT/services/access-agent" && npx tsx src/cli.ts --as "$as" "$@"
