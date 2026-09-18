import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ChatAdapter, HttpRoute } from "../src/adapters/types.js";
import { WebhookVerifier } from "../src/broker/webhook.js";
import { loadConfig } from "../src/config/schema.js";
import { buildServer, type ServerDeps } from "../src/http/server.js";

const secret = "hook-secret";
function deps(): ServerDeps & { onBrokerEvent: ReturnType<typeof vi.fn> } {
  const routes: HttpRoute[] = [
    { method: "POST", path: "/api/messages", handler: async () => ({ status: 200, body: { teams: true } }) },
    { method: "POST", path: "/gchat/events", handler: async () => ({ status: 200, body: { gchat: true } }) },
  ];
  const adapter = { name: "teams", httpRoutes: () => routes } as unknown as ChatAdapter;
  return { log: pino({ level: "silent" }), adapters: [adapter], webhook: new WebhookVerifier(secret), onBrokerEvent: vi.fn(async () => undefined), ready: async () => true };
}
const signed = (body: string, id = "e1") => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "content-type": "application/json", "x-broker-event-id": id, "x-broker-timestamp": ts, "x-broker-signature": WebhookVerifier.sign(secret, ts, body) };
};
const event = JSON.stringify({ type: "request.resolved", request: { id: "r1", user: "a", roles: [], state: "APPROVED", created: "", expires: "" } });

describe("http surfaces", () => {
  it("public listener serves only the chat webhooks and a bare /healthz", async () => {
    const d = deps();
    const pub = buildServer(d, "public");
    expect((await pub.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    expect((await pub.inject({ method: "POST", url: "/api/messages", headers: { "content-type": "application/json" }, payload: "{}" })).json()).toEqual({ teams: true });
    expect((await pub.inject({ method: "POST", url: "/gchat/events", headers: { "content-type": "application/json" }, payload: "{}" })).json()).toEqual({ gchat: true });
    expect((await pub.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(404);
    const r = await pub.inject({ method: "POST", url: "/v1/broker/events", headers: signed(event), payload: event });
    expect(r.statusCode).toBe(404);
    expect(d.onBrokerEvent).not.toHaveBeenCalled();
    await pub.close();
  });

  it("internal listener serves broker events, readiness and health but no chat webhooks", async () => {
    const d = deps();
    const internal = buildServer(d, "internal");
    expect((await internal.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    expect((await internal.inject({ method: "GET", url: "/readyz" })).json()).toEqual({ status: "ready" });
    expect((await internal.inject({ method: "POST", url: "/v1/broker/events", headers: signed(event), payload: event })).json()).toEqual({ ok: true });
    expect(d.onBrokerEvent).toHaveBeenCalledTimes(1);
    expect((await internal.inject({ method: "POST", url: "/api/messages", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(404);
    expect((await internal.inject({ method: "POST", url: "/gchat/events", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(404);
    await internal.close();
  });

  it("the single 'all' surface (no PUBLIC_PORT) serves everything, as before", async () => {
    const d = deps();
    const all = buildServer(d);
    expect((await all.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await all.inject({ method: "POST", url: "/api/messages", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(200);
    expect((await all.inject({ method: "POST", url: "/v1/broker/events", headers: signed(event), payload: event })).statusCode).toBe(200);
    await all.close();
  });

  it("applies the same body rules on both surfaces: JSON objects only, 256 KiB max", async () => {
    const d = deps();
    for (const surface of ["internal", "public"] as const) {
      const s = buildServer(d, surface);
      const url = surface === "public" ? "/api/messages" : "/v1/broker/events";
      expect((await s.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: "[1,2]" })).statusCode).toBe(400);
      expect((await s.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: "{not json" })).statusCode).toBe(400);
      expect((await s.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify({ pad: "x".repeat(300 * 1024) }) })).statusCode).toBe(413);
      await s.close();
    }
  });

  it("PUBLIC_PORT is optional, must be a port, and must differ from PORT", () => {
    const base = { MCP_SHARED_TOKEN: "t", IDENTITY_SIGNING_KEY: "k".repeat(32), ANTHROPIC_API_KEY: "k" };
    expect(loadConfig(base).PUBLIC_PORT).toBeUndefined();
    expect(loadConfig({ ...base, PUBLIC_PORT: "8083" }).PUBLIC_PORT).toBe(8083);
    expect(() => loadConfig({ ...base, PUBLIC_PORT: "8082" })).toThrow(/PUBLIC_PORT must differ from PORT/);
    expect(() => loadConfig({ ...base, PUBLIC_PORT: "http" })).toThrow(/PUBLIC_PORT/);
    expect(() => loadConfig({ ...base, PUBLIC_PORT: "70000" })).toThrow(/PUBLIC_PORT/);
  });
});
