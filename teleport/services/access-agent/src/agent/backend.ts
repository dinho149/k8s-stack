/**
 * A ClaudeBackend turns one chat message into one reply, using the user's MCP tools.
 *   api-key      → Anthropic API + tool runner (api-key-backend.ts)
 *   subscription → headless Claude Code CLI on a Claude Pro/Max token (claude-code-backend.ts)
 */
import type { Principal } from "../mcp/client.js";

export interface TurnInput {
  sessionKey: string;
  principal: Principal;
  platform: string;
  isApprover: boolean;
  text: string;
  onDelta?: (delta: string) => void;
}

export interface TurnResult {
  text: string;
  stopReason: string | null;
  usage?: { input: number; output: number; cacheRead: number };
  /** Claude Code session id (subscription backend) */
  sessionId?: string;
  costUsd?: number;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface ClaudeBackend {
  readonly name: "api-key" | "subscription";
  run(input: TurnInput): Promise<TurnResult>;
  /** Boot-time / readiness credential check. Must never report a failure on network errors alone. */
  probe(): Promise<ProbeResult>;
  /** True once a definite authentication failure has been observed (cleared by a successful turn). */
  readonly stale: boolean;
}
