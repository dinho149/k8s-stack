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
   and sent to the MCP server and the broker as a **signed identity assertion** on every HTTP request (see below).
   Tool arguments never carry an identity, and the legacy `X-Teleport-User` headers are never sent.
2. **The model cannot approve.** There are no approve/deny tools. Approvals are buttons on request cards; a click goes
   agent → broker HTTP API with the clicker's freshly re-verified identity in an assertion (`aud: broker`); the
   broker independently authorizes it. The JSON body carries only `{ reason }`.
3. **Chat identity fails closed.** Every chat adapter requires `ALLOWED_EMAIL_DOMAINS`; username-guessing strategies
   (`email-local-part`, `email-as-username`) are refused when a chat adapter is enabled; the default is `trait-lookup`
   (the broker finds the Teleport user whose `email` trait matches). Slack additionally requires
   `SLACK_ALLOWED_TEAM_IDS` and refuses guests, Slack Connect strangers, bots and deactivated accounts. Google Chat only
   takes messages from direct-message spaces, dedupes the Google-signed bearer JWT and requires `eventTime` within
   ±5 minutes.
4. **Tool output is data.** The system prompt and tool descriptions say so; labels and request reasons can contain text
   that looks like instructions and it is ignored.

## Identity assertions

Every MCP request and every broker approve/deny carries

```
X-Teleport-Assertion: <b64url(payloadJSON)>.<b64url(HMAC-SHA256(IDENTITY_SIGNING_KEY, b64url(payloadJSON)))>
```

with payload `{ sub, email, platform, platform_user_id, aud: "mcp" | "broker", iat, exp (iat+45s), jti }`. The
assertion is minted fresh per request by `src/identity/assertion.ts` (base64url without padding; the HMAC input is the
encoded payload string). The shared bearer tokens (`MCP_SHARED_TOKEN`, `BROKER_API_TOKEN`) remain as a second factor
but can no longer name a user on their own. `IDENTITY_SIGNING_KEY` (≥ 32 bytes) must match the Go services'
`TA_IDENTITY_SIGNING_KEY`. The CLI adapter mints assertions with `platform: "cli"` and needs the same key.

## Secrets from files

Every secret variable (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `TEAMS_APP_PASSWORD`, `GCHAT_SERVICE_ACCOUNT_JSON`,
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `MCP_SHARED_TOKEN`, `BROKER_API_TOKEN`, `BROKER_WEBHOOK_SECRET`,
`IDENTITY_SIGNING_KEY`) also accepts a `<NAME>_FILE` variant: when set, the file's trimmed contents are used and
the `_FILE` variable is dropped. In-cluster, secrets are mounted as 0400 files and only the `_FILE` variables appear in
the pod spec. A missing or empty file is a configuration error.

## Adapters

| Adapter | Transport | Identity | Cards |
|---|---|---|---|
| Slack (`@slack/bolt`) | Socket Mode only (outbound; no public endpoint, no signing secret) | `users.info` → profile email; workspace must be in `SLACK_ALLOWED_TEAM_IDS`; full members only; button clicks always re-fetch `users.info` | Block Kit, approve/deny open a reason modal |
| Microsoft Teams (`botbuilder`) | `POST /api/messages` (public HTTPS, Azure Bot) | `TeamsInfo.getMember` → email/UPN, re-run on every button click with the click's `TurnContext` | Adaptive Card `Action.Execute` |
| Google Chat | `POST /gchat/events` with Google-signed JWT (mounted only when `GCHAT_MODE=http`), or Pub/Sub | `sender.email` (Workspace), DM spaces only; a click's identity is the verified sender of the event that carried it, and only on cards this agent posted | Cards v2, `CARD_CLICKED` |
| CLI | terminal | `--as <user>` (platform `cli`) | text cards, `/approve <id>` |

### Listeners

| Env | Listener | Routes | Who may reach it |
|---|---|---|---|
| `PORT` (8082) | internal | `GET /healthz`, `GET /readyz`, `POST /v1/broker/events` | the broker only (NetworkPolicy) |
| `PUBLIC_PORT` (8083, optional) | public | Teams `POST /api/messages`, Google Chat `POST /gchat/events` (http mode), a bare `GET /healthz` | the ingress, only when the Teams/Google Chat adapters are enabled |

When `PUBLIC_PORT` is set the agent runs two Fastify instances: the broker webhook and `/readyz` are not served on
the public port, and the chat webhooks are not served on the internal one. Both apply the same body rules (JSON
objects only, 256 KiB limit). `PUBLIC_PORT` must differ from `PORT`. Unset (local `make agent-cli`), one listener on
`PORT` serves everything as before. Slack needs no listener at all (Socket Mode). Shutdown closes both.

Button clicks: the nonce is checked first (stale/missing nonce → refused before any lookup), then the clicker is
re-verified on the platform and mapped to a Teleport user. `Details` is limited to the requester or an approver.
Resolution cards are posted only through the adapter the request came from. Conversation sessions are keyed
`platform:channel:thread:user`, so two people in one thread never share a transcript; on-disk transcripts are 0600 in
a 0700 directory.

## Authentication: API key or Claude subscription

| `CLAUDE_AUTH_MODE` | How Claude is called | Credential | Billing |
|---|---|---|---|
| `api-key` (default) | Anthropic API, `@anthropic-ai/sdk` tool runner | `ANTHROPIC_API_KEY` (`teleport:chat.anthropicApiKey`) | API usage |
| `subscription` | headless **Claude Code** (`claude -p`) with our MCP server passed via `--mcp-config` | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (`make claude-token`), or your own Claude Code login locally | Claude Pro/Max subscription |

Both modes keep the same guarantees. Because `claude --mcp-config` can only send static headers and assertions must
be fresh (45 s), each subscription-mode turn starts a **loopback proxy** (`src/mcp/assertion-proxy.ts`) on
`127.0.0.1`: the child gets a 0600 MCP config file (never on argv) pointing at the proxy with a single-use bearer
token; the proxy swaps that for the real `MCP_SHARED_TOKEN` plus a freshly minted assertion for the turn's principal
on every request and streams the response back. The child never holds the shared token, the signing key or the
identity. `--tools ""` removes every built-in Claude Code tool so only `mcp__teleport__*` exists (pre-approved with
`--allowedTools`, so print mode never prompts), `--strict-mcp-config` ignores any other MCP server,
`--setting-sources ""` ignores user/project/local settings (hooks, extra MCP servers, permissions), and there are no
approve/deny tools. Conversation state per chat thread lives in Claude Code sessions (`--session-id` / `--resume`)
under `CLAUDE_STATE_DIR`.

Things to know about the subscription mode:

- The child process gets an allow-listed environment (`PATH`, `HOME`, `TMPDIR`, `LANG`/`LC_*`, `TERM`, `NODE_OPTIONS`,
  `NODE_EXTRA_CA_CERTS`, proxy variables, `CLAUDE_*`) plus the one credential the mode needs. Everything else,
  including `ANTHROPIC_API_KEY` (which would outrank the OAuth token in Claude Code's credential precedence), cloud
  credentials and the nested-session markers (`CLAUDECODE`, `CLAUDE_SESSION_ID`, …), never reaches the child.
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

`make agent-cli` must export `MCP_SHARED_TOKEN` and `IDENTITY_SIGNING_KEY` (the cluster's values) alongside the
port-forwards; without the key the agent refuses to start.

Enable the in-cluster agent with `teleport:services.agent.enabled: true`, adapters in `services.agent.adapters`, and the
credentials in the `teleport:chat` secret object (`pulumi config set --secret --path teleport:chat.slackBotToken ...`).
Off kind, `services.agent.allowedEmailDomains` (→ `ALLOWED_EMAIL_DOMAINS`) is required, and `slackAllowedTeamIds`
(→ `SLACK_ALLOWED_TEAM_IDS`) whenever the Slack adapter is on.
Choose the Claude credential with `services.agent.auth: api-key` (+ `chat.anthropicApiKey`) or `make claude-token`
(sets `auth: subscription` + `chat.claudeCodeOauthToken`). `services.agent.persistSessions: true` keeps Claude Code
sessions on a PVC across restarts.

## Prompt caching

`tools` (sorted) and the frozen system prompt form a stable prefix marked with `cache_control`; per-turn facts (who the
user is, whether they are an approver, the time) go in a mid-conversation `system` message so the prefix never changes.
