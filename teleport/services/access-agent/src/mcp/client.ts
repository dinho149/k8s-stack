/**
 * McpSessionPool — one MCP client session per Teleport user.
 *
 * The user's identity travels as a signed, short-lived assertion header minted by THIS process on
 * every HTTP request, never in tool arguments, so a prompt-injected "act as alice" cannot change
 * who the MCP server acts for. The MCP server binds the session to the assertion's `sub` at
 * initialize and refuses a different subject later.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Platform } from "../adapters/types.js";
import { ASSERTION_HEADER, assertSigningKey, mintAssertion, type AssertionPrincipal } from "../identity/assertion.js";
import type { Logger } from "../observability/logger.js";

export interface Principal extends AssertionPrincipal {
  teleportUser: string;
  email: string | null;
  platform: Platform;
  platformUserId: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
  principal: Principal;
  lastUsed: number;
}

/** One MCP session per (platform, platform user, Teleport user): the server binds a session to one `sub`. */
export function sessionKeyFor(p: Principal): string {
  return `${p.platform}:${p.platformUserId}:${p.teleportUser}`;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Identity headers the legacy MCP contract trusted; they must never leave this process again. */
const FORBIDDEN_HEADERS = ["x-teleport-user", "x-teleport-user-email"];

/**
 * Wraps `fetch` so every request carries the bearer token plus a freshly minted assertion for
 * `principal`. Exported for tests and for the loopback proxy used by the Claude Code backend.
 */
export function assertingFetch(base: FetchLike, sharedToken: string, signingKey: string, principal: Principal): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const h of FORBIDDEN_HEADERS) headers.delete(h);
    headers.set("Authorization", `Bearer ${sharedToken}`);
    headers.set(ASSERTION_HEADER, mintAssertion(signingKey, principal, "mcp"));
    return base(input, { ...init, headers });
  };
}

export class McpSessionPool {
  private sessions = new Map<string, Session>();
  private toolsCache: { at: number; tools: McpTool[] } | null = null;
  private readonly idleMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly url: string,
    private readonly sharedToken: string,
    private readonly signingKey: string,
    private readonly log: Logger,
    opts: { idleMs?: number; fetch?: FetchLike } = {},
  ) {
    assertSigningKey(signingKey);
    this.idleMs = opts.idleMs ?? 15 * 60 * 1000;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    setInterval(() => void this.evict(), 60_000).unref();
  }

  /** A connected client acting as `principal`. */
  async for(principal: Principal): Promise<Client> {
    const key = sessionKeyFor(principal);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }
    const client = new Client({ name: "access-agent", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      fetch: assertingFetch(this.fetchImpl, this.sharedToken, this.signingKey, principal),
    });
    await client.connect(transport);
    this.sessions.set(key, { client, transport, principal, lastUsed: Date.now() });
    this.log.info({ teleportUser: principal.teleportUser, platform: principal.platform }, "mcp session opened");
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

  /** Ends the server-side session (DELETE, with its own fresh assertion) and drops the client. */
  async close(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    await s.transport.terminateSession().catch(() => undefined);
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
