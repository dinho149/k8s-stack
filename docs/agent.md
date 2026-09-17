# The access agent

`services/access-agent` is a Claude agent (`claude-opus-5`, adaptive thinking, streaming, tool runner) whose only tools
come from the MCP server in `services/teleport-access`. It answers questions like:

- "What can I access right now?" → `whoami`, `list_accessible_resources`
- "What role do I need to reach `postgres-prod`?" → `explain_access` (roles that grant it, which you hold / may request, and the broker's prediction)
- "Who can approve prod access?" → `who_can_approve`
- "Request `dev-ssh` for 1h because I'm debugging the checkout service" → `create_access_request` (pending; the broker or an approver decides)
- "What's the status of my request?" → `get_access_request`, `list_my_access_requests`

## Guarantees

1. **Identity is not negotiable.** The chat platform's verified email is mapped to a Teleport user by the agent process
   and sent to the MCP server in transport headers. Tool arguments never carry an identity.
2. **The model cannot approve.** There are no approve/deny tools. Approvals are buttons on request cards; a click goes
   agent → broker HTTP API with the clicker's freshly re-verified identity; the broker independently authorizes it.
3. **Tool output is data.** The system prompt and tool descriptions say so; labels and request reasons can contain text
   that looks like instructions and it is ignored.

## Adapters

| Adapter | Transport | Identity | Cards |
|---|---|---|---|
| Slack (`@slack/bolt`) | Socket Mode (default) or HTTP events | `users.info` → profile email | Block Kit, approve/deny open a reason modal |
| Microsoft Teams (`botbuilder`) | `POST /api/messages` (public HTTPS, Azure Bot) | `TeamsInfo.getMember` → email/UPN | Adaptive Card `Action.Execute` |
| Google Chat | `POST /gchat/events` with Google-signed JWT, or Pub/Sub | `sender.email` (Workspace) | Cards v2, `CARD_CLICKED` |
| CLI | terminal | `--as <user>` | text cards, `/approve <id>` |

## Authentication: API key or Claude subscription

| `CLAUDE_AUTH_MODE` | How Claude is called | Credential | Billing |
|---|---|---|---|
| `api-key` (default) | Anthropic API, `@anthropic-ai/sdk` tool runner | `ANTHROPIC_API_KEY` (`teleport:chat.anthropicApiKey`) | API usage |
| `subscription` | headless **Claude Code** (`claude -p`) with our MCP server passed via `--mcp-config` | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (`make claude-token`), or your own Claude Code login locally | Claude Pro/Max subscription |

Both modes keep the same guarantees: the per-user identity headers are written by the agent process into a 0600
MCP config file (never on argv), `--tools ""` removes every built-in Claude Code tool so only `mcp__teleport__*`
exists (pre-approved with `--allowedTools`, so print mode never prompts), `--strict-mcp-config` ignores any other MCP
server, and there are no approve/deny tools. Conversation state per chat thread lives in Claude Code sessions
(`--session-id` / `--resume`) under `CLAUDE_STATE_DIR`.

Things to know about the subscription mode:

- The child process gets an explicit environment: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are removed because they
  outrank the OAuth token in Claude Code's credential precedence, and the nested-session markers
  (`CLAUDECODE`, `CLAUDE_SESSION_ID`, …) are removed so a turn started from inside Claude Code still works.
- The token lives one year and is not refreshed. A boot-time probe and every failed turn that looks like an auth
  error mark the backend stale: `/readyz` turns 503, logs say `claude subscription authentication failed`, and users
  get a friendly message. Fix with `make claude-token` again.
- Locally, `make agent-cli` uses **your** Claude Code login (keychain) with no token at all when `claude` is on PATH
  and no `ANTHROPIC_API_KEY` is exported (`AUTH=api-key` overrides). In-cluster, `CLAUDE_ALLOW_LOCAL_LOGIN` is always
  false and an isolated `CLAUDE_CONFIG_DIR` is used, so nothing from an operator's `~/.claude` can leak in.
- We deliberately do **not** call the Messages API directly with the subscription bearer token (the technique some
  tools use, which requires impersonating Claude Code's system prompt). Headless Claude Code is the documented way a
  subscription is used programmatically; see `docs/adr/0005-subscription-via-claude-code.md`.

## Running locally

```bash
make agent-cli AS=alice                 # port-forwards MCP + broker, reads the shared tokens from the stack,
                                        # uses your Claude Code login (or ANTHROPIC_API_KEY if exported)
make agent-cli AS=bob AUTH=api-key      # force the API-key backend
make agent-cli AS=alice AGENT_ARGS="--script tests/e2e/agent-questions.txt"   # non-interactive
```

Enable the in-cluster agent with `teleport:services.agent.enabled: true`, adapters in `services.agent.adapters`, and the
credentials in the `teleport:chat` secret object (`pulumi config set --secret --path teleport:chat.slackBotToken ...`).
Choose the Claude credential with `services.agent.auth: api-key` (+ `chat.anthropicApiKey`) or `make claude-token`
(sets `auth: subscription` + `chat.claudeCodeOauthToken`). `services.agent.persistSessions: true` keeps Claude Code
sessions on a PVC across restarts.

## Prompt caching

`tools` (sorted) and the frozen system prompt form a stable prefix marked with `cache_control`; per-turn facts (who the
user is, whether they are an approver, the time) go in a mid-conversation `system` message so the prefix never changes.
