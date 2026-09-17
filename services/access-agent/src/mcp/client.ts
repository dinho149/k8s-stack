/**
 * McpSessionPool — one MCP client session per Teleport user.
 *
 * The user's identity travels in HTTP headers set by THIS process, never in tool arguments, so a
 * prompt-injected "act as alice" cannot change who the MCP server acts for.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "../observability/logger.js";

export interface Principal {
  teleportUser: string;
  email: string | null;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

interface Session {
  client: Client;
  principal: Principal;
  lastUsed: number;
}

export class McpSessionPool {
  private sessions = new Map<string, Session>();
  private toolsCache: { at: number; tools: McpTool[] } | null = null;
  private readonly idleMs: number;

  constructor(
    private readonly url: string,
    private readonly sharedToken: string,
    private readonly log: Logger,
    opts: { idleMs?: number } = {},
  ) {
    this.idleMs = opts.idleMs ?? 15 * 60 * 1000;
    setInterval(() => void this.evict(), 60_000).unref();
  }

  /** A connected client acting as `principal`. */
  async for(principal: Principal): Promise<Client> {
    const key = principal.teleportUser;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }
    const client = new Client({ name: "access-agent", version: "0.1.0" });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.sharedToken}`,
      "X-Teleport-User": principal.teleportUser,
    };
    if (principal.email) headers["X-Teleport-User-Email"] = principal.email;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } });
    await client.connect(transport);
    this.sessions.set(key, { client, principal, lastUsed: Date.now() });
    this.log.info({ teleportUser: principal.teleportUser }, "mcp session opened");
    return client;
  }

  /** Tool catalogue (identical for every user; cached for an hour). */
  async tools(principal: Principal): Promise<McpTool[]> {
    if (this.toolsCache && Date.now() - this.toolsCache.at < 3600_000) return this.toolsCache.tools;
    const client = await this.for(principal);
    const { tools } = await client.listTools();
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name)) as unknown as McpTool[];
    for (const t of sorted) {
      // Defence in depth: identity must never be a tool argument.
      const props = t.inputSchema.properties ?? {};
      for (const k of Object.keys(props)) if (/teleport_user|username|principal/i.test(k)) throw new Error(`MCP tool ${t.name} exposes identity parameter ${k}`);
    }
    this.toolsCache = { at: Date.now(), tools: sorted };
    return sorted;
  }

  async close(teleportUser: string): Promise<void> {
    const s = this.sessions.get(teleportUser);
    if (!s) return;
    this.sessions.delete(teleportUser);
    await s.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((k) => this.close(k)));
  }

  private async evict(): Promise<void> {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (now - s.lastUsed > this.idleMs) await this.close(k);
  }
}
