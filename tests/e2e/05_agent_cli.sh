#!/usr/bin/env bash
# The whole agent path: chat message -> Claude -> MCP tools (as alice) -> broker. Uses your Claude Code
# login (subscription) or ANTHROPIC_API_KEY; skips when neither is available (CI has no subscription).
source "$(dirname "$0")/lib.sh"
ui::section "e2e 05: access agent (CLI adapter)"
if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && ! command -v claude >/dev/null 2>&1; then ui::warn "skipped: no ANTHROPIC_API_KEY and no claude CLI"; exit 0; fi
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -n "${CI:-}" ]]; then ui::warn "skipped in CI: no Claude credentials"; exit 0; fi
out="$UI_LOG_DIR/e2e-agent.log"
before="$("$TCTL" requests ls --format=json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin) or []))')"
ui::spinner "Scripted conversation as alice" "$REPO_ROOT/deploy/scripts/agent-cli.sh" alice --script "$REPO_ROOT/tests/e2e/agent-questions.txt" || { cat "$out" 2>/dev/null; exit 1; }
cp "$UI_LOG_DIR/scripted-conversation-as-alice.log" "$out" 2>/dev/null || true
grep -qiE "requester" "$out" && ui::ok "agent reported alice's requester role" || { ui::fail "no mention of requester in the agent's answers"; tail -40 "$out"; exit 1; }
grep -qiE "prod-db|dba" "$out" && ui::ok "agent named a role granting postgres-prod" || { ui::fail "agent did not name prod-db/dba"; tail -40 "$out"; exit 1; }
after="$("$TCTL" requests ls --format=json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin) or []))')"
(( after > before )) && ui::ok "an access request was created through the agent ($before -> $after)" || { ui::fail "no new access request"; tail -40 "$out"; exit 1; }
latest="$("$TCTL" requests ls --format=json | python3 -c 'import json,sys; d=[r for r in json.load(sys.stdin) if r["spec"]["user"]=="alice" and "dev-ssh" in r["spec"]["roles"]]; d.sort(key=lambda r:r["metadata"]["name"]); print(d[-1]["metadata"]["name"] if d else "")')"
[[ -n "$latest" ]] && e2e::wait_state "$latest" APPROVED 60 && ui::ok "the broker auto-approved it ($latest)"
