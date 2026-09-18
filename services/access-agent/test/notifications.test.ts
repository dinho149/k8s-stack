import { describe, expect, it, vi } from "vitest";
import type { ChatAdapter, ButtonClick, RequestCard, PostedMessageRef, ChatUser } from "../src/adapters/types.js";
import { NotificationService } from "../src/notifications/service.js";
import { BrokerError, type BrokerClient, type BrokerRequest } from "../src/broker/client.js";
import type { ApproverCheck } from "../src/identity/approver.js";
import type { IdentityResolver } from "../src/identity/resolver.js";
import pino from "pino";

const req: BrokerRequest = { id: "0f3a1b2c-1111", user: "alice", roles: ["prod-ssh"], resource_ids: [], reason: "incident", state: "PENDING", created: "t0", expires: "t1", decision: { action: "require_approval", rule: "high-risk-needs-approval", reason: "", ttl_cap: "2h", approvers: { teleport_roles: ["approver"], emails: [] } } };

type Fake = ChatAdapter & { posted: RequestCard[]; postedTargets: unknown[]; updated: RequestCard[]; resolved: Array<{ id: string; ctx: unknown }>; click?: (c: ButtonClick) => Promise<void> };
function fakeAdapter(name: "slack" | "teams"): Fake {
  const a: any = {
    name,
    posted: [] as RequestCard[],
    postedTargets: [] as unknown[],
    updated: [] as RequestCard[],
    resolved: [] as Array<{ id: string; ctx: unknown }>,
    start: async () => undefined,
    stop: async () => undefined,
    onMessage: () => undefined,
    onButtonClick(h: (c: ButtonClick) => Promise<void>) {
      a.click = h;
    },
    async postCard(t: unknown, card: RequestCard): Promise<PostedMessageRef> {
      a.posted.push(card);
      a.postedTargets.push(t);
      return { conversation: { platform: name, channelId: "C1" }, messageId: `m${a.posted.length}` };
    },
    async updateCard(_r: PostedMessageRef, card: RequestCard) {
      a.updated.push(card);
    },
    async resolveUser(id: string, ctx?: unknown): Promise<ChatUser> {
      a.resolved.push({ id, ctx });
      return { platform: name, platformUserId: id, displayName: id, email: `${id}@example.com`, emailVerified: true };
    },
  };
  return a;
}

function setup(brokerOverrides: Partial<BrokerClient> = {}, approverIds: string[] = ["bob"], extra: Fake[] = []) {
  const adapter = fakeAdapter("slack");
  const broker = { approve: vi.fn(async () => ({ ...req, state: "APPROVED" })), deny: vi.fn(async () => ({ ...req, state: "DENIED" })), getRequest: vi.fn(async () => req), ...brokerOverrides } as unknown as BrokerClient;
  const identity = { resolve: async (u: ChatUser) => ({ teleportUser: u.platformUserId, email: u.email, platform: u.platform, platformUserId: u.platformUserId }) } as unknown as IdentityResolver;
  const approvers = { isApprover: vi.fn(async (p: { teleportUser: string }) => approverIds.includes(p.teleportUser)) } as unknown as ApproverCheck;
  const adapters = new Map<string, ChatAdapter>([["slack", adapter], ...extra.map((e) => [e.name, e] as [string, ChatAdapter])]);
  const svc = new NotificationService(adapters, broker, identity, approvers, pino({ level: "silent" }));
  return { adapter, broker, svc, approvers };
}
const pending = { type: "request.pending_review" as const, request: req, notify: { channels: [{ adapter: "slack", target: "#access" }] } };
const clickFrom = (id: string, over: Partial<ButtonClick> = {}): ButtonClick => ({ user: { platform: "slack", platformUserId: id, displayName: id, email: "spoofed@evil.com", emailVerified: true }, button: "approve", requestId: req.id, nonce: "", message: { conversation: { platform: "slack", channelId: "C1" }, messageId: "m1" }, respond: vi.fn(async () => undefined), ...over });

describe("NotificationService", () => {
  it("posts one pending card per channel and ignores duplicate pending events", async () => {
    const { adapter, svc } = setup();
    await svc.handleEvent(pending);
    await svc.handleEvent(pending);
    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0].status).toBe("pending");
    expect(adapter.posted[0].buttons.map((b) => b.id)).toEqual(["approve", "deny", "details"]);
    expect(adapter.posted[0].fields.Roles).toBe("prod-ssh");
  });

  it("approves through the broker with the re-verified principal (platform ctx threaded through) and updates the card", async () => {
    const { adapter, broker, svc } = setup();
    await svc.handleEvent(pending);
    const card = adapter.posted[0];
    const ctx = { fresh: true };
    const c = clickFrom("bob", { nonce: card.nonce, reason: "ok", ctx });
    await adapter.click!(c);
    expect(adapter.resolved).toEqual([{ id: "bob", ctx }]);
    expect(broker.approve).toHaveBeenCalledWith(req.id, { teleportUser: "bob", email: "bob@example.com", platform: "slack", platformUserId: "bob" }, "ok");
    expect(adapter.updated.at(-1)?.status).toBe("approved");
    expect(c.respond).toHaveBeenCalledWith(expect.stringContaining("Approved"), true);
  });

  it("rejects stale or missing nonces before any identity work, and surfaces broker authorization errors", async () => {
    const { adapter, svc, broker } = setup({ approve: vi.fn(async () => { throw new BrokerError(403, "self_approval", "no"); }) } as any);
    await svc.handleEvent(pending);
    const wrong = clickFrom("alice", { nonce: "wrong" });
    await adapter.click!(wrong);
    expect(wrong.respond).toHaveBeenLastCalledWith(expect.stringContaining("stale"), true);
    const none = clickFrom("alice", { nonce: "" });
    await adapter.click!(none);
    expect(none.respond).toHaveBeenLastCalledWith(expect.stringContaining("stale"), true);
    expect(adapter.resolved).toHaveLength(0);
    expect(broker.approve).not.toHaveBeenCalled();
    const ok = clickFrom("alice", { nonce: adapter.posted[0].nonce });
    await adapter.click!(ok);
    expect(ok.respond).toHaveBeenLastCalledWith("You cannot approve your own request.", true);
  });

  it("details requires a valid nonce and is limited to the requester or an approver", async () => {
    const { adapter, svc, broker } = setup();
    await svc.handleEvent(pending);
    const nonce = adapter.posted[0].nonce;
    const stale = clickFrom("alice", { button: "details", nonce: "" });
    await adapter.click!(stale);
    expect(stale.respond).toHaveBeenLastCalledWith(expect.stringContaining("stale"), true);
    const stranger = clickFrom("mallory", { button: "details", nonce });
    await adapter.click!(stranger);
    expect(stranger.respond).toHaveBeenLastCalledWith(expect.stringContaining("Only the requester or an approver"), true);
    const requester = clickFrom("alice", { button: "details", nonce });
    await adapter.click!(requester);
    expect(requester.respond).toHaveBeenLastCalledWith(expect.stringContaining("requester: alice"), true);
    const approver = clickFrom("bob", { button: "details", nonce });
    await adapter.click!(approver);
    expect(approver.respond).toHaveBeenLastCalledWith(expect.stringContaining("roles: prod-ssh"), true);
    expect(broker.getRequest).not.toHaveBeenCalled(); // untracked requests are stale, never fetched for strangers
  });

  it("refuses the click when platform re-verification fails", async () => {
    const { adapter, svc, broker } = setup();
    adapter.resolveUser = async () => {
      throw new Error("guest accounts cannot use this assistant");
    };
    await svc.handleEvent(pending);
    const c = clickFrom("guest", { nonce: adapter.posted[0].nonce });
    await adapter.click!(c);
    expect(c.respond).toHaveBeenLastCalledWith(expect.stringContaining("guest accounts"), true);
    expect(broker.approve).not.toHaveBeenCalled();
  });

  it("marks cards resolved on request.resolved and DMs the requester only via the adapter the request came from", async () => {
    const teams = fakeAdapter("teams");
    const { adapter, svc } = setup({}, ["bob"], [teams]);
    await svc.handleEvent(pending);
    await svc.handleEvent({ type: "request.resolved", request: { ...req, state: "APPROVED" }, requester_email: "alice@example.com", resolution: { state: "approved", by: "bob", mode: "chat", reason: "ok" } });
    expect(adapter.updated.at(-1)).toMatchObject({ status: "approved", buttons: [] });
    expect(adapter.updated.at(-1)?.footer).toContain("bob");
    expect(adapter.postedTargets).toContainEqual({ userEmail: "alice@example.com" });
    expect(teams.posted).toHaveLength(0);
    // an untracked request with a recorded platform goes to that platform only
    await svc.handleEvent({ type: "request.resolved", request: { ...req, id: "other", state: "DENIED", platform: "teams" }, requester_email: "alice@example.com" });
    expect(teams.posted).toHaveLength(1);
    expect(adapter.postedTargets.filter((t) => JSON.stringify(t).includes("alice@example.com"))).toHaveLength(1);
  });
});
