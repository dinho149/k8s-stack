import { describe, expect, it, vi } from "vitest";
import type { ChatAdapter, ButtonClick, RequestCard, PostedMessageRef } from "../src/adapters/types.js";
import { NotificationService } from "../src/notifications/service.js";
import { BrokerError, type BrokerClient, type BrokerRequest } from "../src/broker/client.js";
import type { IdentityResolver } from "../src/identity/resolver.js";
import pino from "pino";

const req: BrokerRequest = { id: "0f3a1b2c-1111", user: "alice", roles: ["prod-ssh"], resource_ids: [], reason: "incident", state: "PENDING", created: "t0", expires: "t1", decision: { action: "require_approval", rule: "high-risk-needs-approval", reason: "", ttl_cap: "2h", approvers: { teleport_roles: ["approver"], emails: [] } } };

function fakeAdapter(name: "slack"): ChatAdapter & { posted: RequestCard[]; updated: RequestCard[]; click?: (c: ButtonClick) => Promise<void> } {
  const a: any = {
    name,
    posted: [] as RequestCard[],
    updated: [] as RequestCard[],
    start: async () => undefined,
    stop: async () => undefined,
    onMessage: () => undefined,
    onButtonClick(h: (c: ButtonClick) => Promise<void>) {
      a.click = h;
    },
    async postCard(_t: unknown, card: RequestCard): Promise<PostedMessageRef> {
      a.posted.push(card);
      return { conversation: { platform: name, channelId: "C1" }, messageId: `m${a.posted.length}` };
    },
    async updateCard(_r: PostedMessageRef, card: RequestCard) {
      a.updated.push(card);
    },
    async resolveUser(id: string) {
      return { platform: name, platformUserId: id, displayName: id, email: `${id}@example.com`, emailVerified: true };
    },
  };
  return a;
}

function setup(brokerOverrides: Partial<BrokerClient> = {}) {
  const adapter = fakeAdapter("slack");
  const broker = { approve: vi.fn(async () => ({ ...req, state: "APPROVED" })), deny: vi.fn(async () => ({ ...req, state: "DENIED" })), getRequest: vi.fn(async () => req), ...brokerOverrides } as unknown as BrokerClient;
  const identity = { resolve: async (u: any) => ({ teleportUser: u.platformUserId, email: u.email }) } as unknown as IdentityResolver;
  const svc = new NotificationService(new Map([["slack", adapter]]), broker, identity, pino({ level: "silent" }));
  return { adapter, broker, svc };
}

describe("NotificationService", () => {
  it("posts one pending card per channel and ignores duplicate pending events", async () => {
    const { adapter, svc } = setup();
    const ev = { type: "request.pending_review" as const, request: req, notify: { channels: [{ adapter: "slack", target: "#access" }] } };
    await svc.handleEvent(ev);
    await svc.handleEvent(ev);
    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0].status).toBe("pending");
    expect(adapter.posted[0].buttons.map((b) => b.id)).toEqual(["approve", "deny", "details"]);
    expect(adapter.posted[0].fields.Roles).toBe("prod-ssh");
  });

  it("approves through the broker with the re-verified identity and updates the card", async () => {
    const { adapter, broker, svc } = setup();
    await svc.handleEvent({ type: "request.pending_review", request: req, notify: { channels: [{ adapter: "slack", target: "#access" }] } });
    const card = adapter.posted[0];
    const respond = vi.fn(async () => undefined);
    await adapter.click!({ user: { platform: "slack", platformUserId: "bob", displayName: "Bob", email: "spoofed@evil.com", emailVerified: true }, button: "approve", requestId: req.id, nonce: card.nonce, reason: "ok", message: { conversation: { platform: "slack", channelId: "C1" }, messageId: "m1" }, respond });
    expect(broker.approve).toHaveBeenCalledWith(req.id, expect.objectContaining({ teleport_user: "bob", email: "bob@example.com" }), "ok");
    expect(adapter.updated.at(-1)?.status).toBe("approved");
    expect(respond).toHaveBeenCalledWith(expect.stringContaining("Approved"), true);
  });

  it("rejects stale nonces and surfaces broker authorization errors", async () => {
    const { adapter, svc } = setup({ approve: vi.fn(async () => { throw new BrokerError(403, "self_approval", "no"); }) } as any);
    await svc.handleEvent({ type: "request.pending_review", request: req, notify: { channels: [{ adapter: "slack", target: "#access" }] } });
    const respond = vi.fn(async () => undefined);
    const base = { user: { platform: "slack" as const, platformUserId: "alice", displayName: "a", email: null, emailVerified: false }, button: "approve" as const, requestId: req.id, message: { conversation: { platform: "slack" as const, channelId: "C1" }, messageId: "m1" }, respond };
    await adapter.click!({ ...base, nonce: "wrong" });
    expect(respond).toHaveBeenLastCalledWith(expect.stringContaining("stale"), true);
    await adapter.click!({ ...base, nonce: adapter.posted[0].nonce });
    expect(respond).toHaveBeenLastCalledWith("You cannot approve your own request.", true);
  });

  it("marks cards resolved on request.resolved", async () => {
    const { adapter, svc } = setup();
    await svc.handleEvent({ type: "request.pending_review", request: req, notify: { channels: [{ adapter: "slack", target: "#access" }] } });
    await svc.handleEvent({ type: "request.resolved", request: { ...req, state: "APPROVED" }, resolution: { state: "approved", by: "bob", mode: "chat", reason: "ok" } });
    expect(adapter.updated.at(-1)).toMatchObject({ status: "approved", buttons: [] });
    expect(adapter.updated.at(-1)?.footer).toContain("bob");
  });
});
