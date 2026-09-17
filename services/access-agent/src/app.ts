/**
 * Wires config -> adapters -> agent -> notifications -> HTTP. Shared by index.ts and cli.ts.
 */
import type { ChatAdapter, IncomingMessage, Replier } from "./adapters/types.js";
import { ApiKeyBackend } from "./agent/api-key-backend.js";
import type { ClaudeBackend } from "./agent/backend.js";
import { ClaudeCodeBackend } from "./agent/claude-code-backend.js";
import { FileSessionIdStore, MemorySessionIdStore } from "./agent/session-ids.js";
import { FileSessionStore, MemorySessionStore, sessionKey } from "./agent/session-store.js";
import { BrokerClient } from "./broker/client.js";
import { WebhookVerifier } from "./broker/webhook.js";
import type { Config } from "./config/schema.js";
import { ApproverCheck } from "./identity/approver.js";
import { IdentityError, IdentityResolver } from "./identity/resolver.js";
import { McpSessionPool } from "./mcp/client.js";
import { NotificationService } from "./notifications/service.js";
import type { Logger } from "./observability/logger.js";

export interface App {
  adapters: Map<string, ChatAdapter>;
  backend: ClaudeBackend;
  notifications: NotificationService;
  webhook: WebhookVerifier;
  broker: BrokerClient;
  pool: McpSessionPool;
  ready(): Promise<boolean>;
  handleMessage(m: IncomingMessage, reply: Replier): Promise<void>;
  stop(): Promise<void>;
}

export function buildApp(cfg: Config, log: Logger, adapters: ChatAdapter[]): App {
  const pool = new McpSessionPool(cfg.MCP_URL, cfg.MCP_SHARED_TOKEN, log);
  const broker = new BrokerClient(cfg.BROKER_URL, cfg.BROKER_API_TOKEN);
  const backend: ClaudeBackend =
    cfg.CLAUDE_AUTH_MODE === "subscription"
      ? new ClaudeCodeBackend(cfg, cfg.SESSION_BACKEND === "file" ? new FileSessionIdStore(cfg.SESSION_FILE.replace(/\.json$/, "") + "-claude-sessions.json") : new MemorySessionIdStore(), log)
      : new ApiKeyBackend(cfg, pool, cfg.SESSION_BACKEND === "file" ? new FileSessionStore(cfg.SESSION_FILE, cfg.SESSION_MAX_TURNS) : new MemorySessionStore(cfg.SESSION_MAX_TURNS), log);
  const identity = new IdentityResolver(cfg, broker);
  const approvers = new ApproverCheck(cfg, broker);
  const map = new Map(adapters.map((a) => [a.name, a]));
  const notifications = new NotificationService(map, broker, identity, log);
  const webhook = new WebhookVerifier(cfg.BROKER_WEBHOOK_SECRET);

  const handleMessage = async (m: IncomingMessage, reply: Replier): Promise<void> => {
    let principal;
    try {
      principal = await identity.resolve(m.user);
    } catch (e) {
      if (e instanceof IdentityError) return reply.text(`I can't act for you yet: ${e.message}.`);
      throw e;
    }
    const isApprover = await approvers.isApprover(principal);
    const key = sessionKey(m.conversation.platform, m.conversation.channelId, m.conversation.threadId, m.user.platformUserId);
    const stream = await reply.startStream();
    const result = await backend.run({ sessionKey: key, principal, platform: m.conversation.platform, isApprover, text: m.text, onDelta: (d: string) => void stream.append(d) });
    await stream.finish(result.text);
  };
  for (const a of adapters) a.onMessage(handleMessage);

  return {
    adapters: map,
    backend,
    notifications,
    webhook,
    broker,
    pool,
    handleMessage,
    ready: async () => {
      await broker.health();
      return !backend.stale;
    },
    stop: async () => {
      await Promise.all(adapters.map((a) => a.stop().catch(() => undefined)));
      await pool.closeAll();
    },
  };
}
