import * as http from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAssertion } from "../src/identity/assertion.js";
import { startAssertionProxy, type AssertionProxy } from "../src/mcp/assertion-proxy.js";

const KEY = "p".repeat(32);
const alice = { teleportUser: "alice", email: "alice@example.com", platform: "cli" as const, platformUserId: "alice" };

describe("assertion proxy", () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let proxy: AssertionProxy;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        if (req.headers.accept?.includes("text/event-stream")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: message\ndata: {\"hello\":1}\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end(JSON.stringify({ ok: true, echoed: body }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
    proxy = await startAssertionProxy({ upstream: upstreamUrl, sharedToken: "shared", signingKey: KEY, principal: alice, log: pino({ level: "silent" }) });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("requires the per-turn token and swaps it for the shared token plus a fresh assertion", async () => {
    const bad = await fetch(proxy.url, { method: "POST", headers: { Authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(seen).toHaveLength(0);

    const r1 = await fetch(proxy.url, { method: "POST", headers: { Authorization: `Bearer ${proxy.token}`, "content-type": "application/json", "X-Teleport-User": "admin", "mcp-session-id": "s1" }, body: '{"a":1}' });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("mcp-session-id")).toBe("s1");
    expect(await r1.json()).toEqual({ ok: true, echoed: '{"a":1}' });
    const r2 = await fetch(proxy.url, { method: "GET", headers: { Authorization: `Bearer ${proxy.token}`, accept: "text/event-stream" } });
    expect(r2.headers.get("content-type")).toBe("text/event-stream");
    expect(await r2.text()).toContain('data: {"hello":1}');

    expect(seen).toHaveLength(2);
    const jtis = new Set<string>();
    for (const s of seen) {
      expect(s.url).toBe("/mcp");
      expect(s.headers.authorization).toBe("Bearer shared");
      expect(s.headers["x-teleport-user"]).toBeUndefined();
      const p = verifyAssertion(KEY, s.headers["x-teleport-assertion"] as string, "mcp");
      expect(p).toMatchObject({ sub: "alice", platform: "cli", aud: "mcp" });
      jtis.add(p.jti);
    }
    expect(seen[0].headers["mcp-session-id"]).toBe("s1");
    expect(jtis.size).toBe(2);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});
