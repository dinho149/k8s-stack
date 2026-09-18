import pino from "pino";
import { describe, expect, it } from "vitest";
import { verifyAssertion } from "../src/identity/assertion.js";
import { McpSessionPool, assertingFetch, sessionKeyFor } from "../src/mcp/client.js";

const KEY = "k".repeat(32);
const alice = { teleportUser: "alice", email: "alice@example.com", platform: "slack" as const, platformUserId: "U1" };

interface Seen { method: string; url: string; headers: Headers; body: unknown }

/** A fake MCP server behind fetch: answers initialize and tools/list, 405 for the SSE GET. */
function fakeMcp() {
  const seen: Seen[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url: String(input), headers, body });
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (body?.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } });
    }
    if (body?.method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 202 });
  };
  return { seen, fetchImpl };
}

describe("McpSessionPool", () => {
  it("sends a fresh signed assertion and the bearer token on every request, never a user header", async () => {
    const { seen, fetchImpl } = fakeMcp();
    const pool = new McpSessionPool("http://mcp.test/mcp", "shared-token", KEY, pino({ level: "silent" }), { fetch: fetchImpl });
    const tools = await pool.tools(alice);
    expect(tools.map((t) => t.name)).toEqual(["whoami"]);
    await pool.closeAll();
    const posts = seen.filter((s) => s.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(3); // initialize, notifications/initialized, tools/list
    expect(seen.some((s) => s.method === "GET")).toBe(true); // notification stream attempt
    const del = seen.filter((s) => s.method === "DELETE");
    expect(del).toHaveLength(1); // session terminated on close
    expect(del[0].headers.get("mcp-session-id")).toBe("sess-1");
    const jtis = new Set<string>();
    for (const s of seen) {
      expect(s.headers.get("authorization")).toBe("Bearer shared-token");
      expect(s.headers.get("x-teleport-user")).toBeNull();
      expect(s.headers.get("x-teleport-user-email")).toBeNull();
      const a = s.headers.get("x-teleport-assertion");
      expect(a).toBeTruthy();
      const payload = verifyAssertion(KEY, a!, "mcp");
      expect(payload).toMatchObject({ sub: "alice", email: "alice@example.com", platform: "slack", platform_user_id: "U1", aud: "mcp" });
      jtis.add(payload.jti);
    }
    expect(jtis.size).toBe(seen.length); // one assertion per request
  });

  it("keys sessions by platform + platform user + Teleport user, never sharing a session across principals", () => {
    expect(sessionKeyFor(alice)).toBe("slack:U1:alice");
    expect(sessionKeyFor({ ...alice, platform: "teams", platformUserId: "29:x" })).toBe("teams:29:x:alice");
  });

  it("refuses a short signing key", () => {
    expect(() => new McpSessionPool("http://mcp.test/mcp", "t", "short", pino({ level: "silent" }))).toThrow(/32 bytes/);
  });

  it("assertingFetch strips legacy identity headers a caller may try to smuggle", async () => {
    let seenHeaders: Headers | undefined;
    const f = assertingFetch(async (_u, init) => ((seenHeaders = new Headers(init?.headers)), new Response("")), "tok", KEY, alice);
    await f("http://x/", { headers: { "X-Teleport-User": "admin", Authorization: "Bearer evil" } });
    expect(seenHeaders!.get("x-teleport-user")).toBeNull();
    expect(seenHeaders!.get("authorization")).toBe("Bearer tok");
    expect(verifyAssertion(KEY, seenHeaders!.get("x-teleport-assertion")!, "mcp").sub).toBe("alice");
  });
});
