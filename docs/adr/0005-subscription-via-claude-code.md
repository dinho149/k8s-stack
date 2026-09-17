# ADR 0005 — Claude subscription support through headless Claude Code, not a hand-rolled bearer

**Decision.** `CLAUDE_AUTH_MODE=subscription` runs each agent turn as a headless Claude Code process
(`claude -p --output-format stream-json --strict-mcp-config --mcp-config <per-user file> --tools "" --allowedTools
mcp__teleport__*`) authenticated with a `claude setup-token` token (or the operator's own login locally). The
API-key mode (Anthropic SDK tool runner) stays the default.

**Why.** `claude setup-token` is the documented way to use a Pro/Max subscription non-interactively, and Claude Code
supports remote HTTP MCP servers with custom headers, which preserves our identity-binding model unchanged. The
alternative seen in `yeaboi.ai` — sending the subscription OAuth token straight to the Messages API with
`anthropic-beta: oauth-2025-04-20` and a prepended "You are Claude Code" system block — works today but relies on
impersonating Claude Code and on undocumented server behaviour (a fake 429 when the block is missing), which is a
terms-of-service grey area and can break without notice. The Claude Agent SDK was not used because it is reported
to be barred from subscription auth.

**Consequences.** The agent image carries the Claude Code CLI (glibc base image), one process per turn, thread state
in Claude Code sessions (`--resume`), a one-year token with no refresh (staleness is observed via a probe and
surfaced on `/readyz`), and no subscription runs in CI (the e2e agent scenario skips there).
