import { describe, expect, it } from "vitest";
import { BrokerClient, BrokerError } from "../src/broker/client.js";
import { verifyAssertion } from "../src/identity/assertion.js";

const KEY = "b".repeat(32);
const bob = { teleportUser: "bob", email: "bob@example.com", platform: "teams" as const, platformUserId: "29:abc" };

function fakeFetch(status = 200, body: unknown = { id: "r1", state: "APPROVED" }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, f };
}

describe("BrokerClient", () => {
  it("approve sends only { reason } in the body and the approver as a broker-audience assertion", async () => {
    const { calls, f } = fakeFetch();
    const c = new BrokerClient("http://broker", "api-token", KEY, f);
    await c.approve("r1", bob, "looks fine");
    expect(calls[0].url).toBe("http://broker/v1/requests/r1/approve");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ reason: "looks fine" });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer api-token");
    expect(verifyAssertion(KEY, h["X-Teleport-Assertion"], "broker")).toMatchObject({ sub: "bob", email: "bob@example.com", platform: "teams", platform_user_id: "29:abc", aud: "broker" });
    expect(() => verifyAssertion(KEY, h["X-Teleport-Assertion"], "mcp")).toThrow(/audience/);
  });

  it("deny mints its own assertion; reads stay bearer-only", async () => {
    const { calls, f } = fakeFetch(200, { user: "alice" });
    const c = new BrokerClient("http://broker", "api-token", KEY, f);
    await c.deny("r1", bob, "no");
    await c.userByEmail("alice@example.com");
    await c.userRoles("alice");
    await c.getRequest("r1");
    const [deny, byEmail, roles, get] = calls.map((x) => x.init.headers as Record<string, string>);
    expect(deny["X-Teleport-Assertion"]).toBeTruthy();
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ reason: "no" });
    for (const h of [byEmail, roles, get]) {
      expect(h["X-Teleport-Assertion"]).toBeUndefined();
      expect(h.Authorization).toBe("Bearer api-token");
    }
  });

  it("surfaces broker error codes", async () => {
    const { f } = fakeFetch(403, { error: "nope", code: "not_approver" });
    const c = new BrokerClient("http://broker", "t", KEY, f);
    await expect(c.approve("r1", bob, "x")).rejects.toMatchObject({ status: 403, code: "not_approver" } satisfies Partial<BrokerError>);
  });
});
