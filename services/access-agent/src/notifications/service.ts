/**
 * NotificationService — turns broker events into cards, routes button clicks to the broker,
 * and keeps cards in sync with the request's state.
 */
import { randomBytes } from "node:crypto";
import type { ButtonClick, ChatAdapter, PostedMessageRef, RequestCard, RequestStatus } from "../adapters/types.js";
import type { BrokerClient, BrokerRequest } from "../broker/client.js";
import { BrokerError } from "../broker/client.js";
import type { BrokerEvent } from "../broker/webhook.js";
import type { IdentityResolver } from "../identity/resolver.js";
import type { Logger } from "../observability/logger.js";

interface Tracked {
  request: BrokerRequest;
  nonce: string;
  posts: PostedMessageRef[];
}

export class NotificationService {
  private tracked = new Map<string, Tracked>();

  constructor(
    private readonly adapters: Map<string, ChatAdapter>,
    private readonly broker: BrokerClient,
    private readonly identity: IdentityResolver,
    private readonly log: Logger,
  ) {
    for (const a of adapters.values()) a.onButtonClick((c) => this.onClick(c));
  }

  static renderCard(r: BrokerRequest, nonce: string, status: RequestStatus, footer?: string): RequestCard {
    const fields: Record<string, string> = {
      Requester: r.user,
      Roles: r.roles.join(", ") || "(none)",
      ...(r.resource_ids?.length ? { Resources: r.resource_ids.join(", ") } : {}),
      Reason: r.reason || "(none given)",
      Expires: r.access_expiry ?? r.expires,
      ...(r.decision ? { Policy: `${r.decision.rule} → ${r.decision.action}` } : {}),
    };
    return {
      requestId: r.id,
      title: status === "pending" ? `Access request ${r.id.slice(0, 8)} needs approval` : `Access request ${r.id.slice(0, 8)} ${status}`,
      fields,
      buttons: status === "pending" ? [{ id: "approve", label: "Approve", style: "primary" }, { id: "deny", label: "Deny", style: "danger" }, { id: "details", label: "Details" }] : [],
      status,
      footer,
      nonce,
    };
  }

  async handleEvent(ev: BrokerEvent): Promise<void> {
    const r = ev.request;
    if (ev.type === "request.pending_review") {
      if (this.tracked.has(r.id)) return; // broker reconcile re-sent it; cards already posted
      const nonce = randomBytes(12).toString("hex");
      const card = NotificationService.renderCard(r, nonce, "pending");
      const posts: PostedMessageRef[] = [];
      for (const ch of ev.notify?.channels ?? []) {
        const a = this.adapters.get(ch.adapter);
        if (!a) continue;
        const ref = await a.postCard({ channel: ch.target }, card).catch((e) => (this.log.warn({ err: e, ch }, "postCard failed"), null));
        if (ref) posts.push(ref);
      }
      if (ev.notify?.mention_approvers) {
        for (const email of ev.approver_emails ?? []) {
          for (const a of this.adapters.values()) {
            const ref = await a.postCard({ userEmail: email }, card).catch(() => null);
            if (ref) posts.push(ref);
          }
        }
      }
      this.tracked.set(r.id, { request: r, nonce, posts });
      return;
    }
    if (ev.type === "request.resolved") {
      const status = (ev.resolution?.state ?? (r.state === "APPROVED" ? "approved" : r.state === "DENIED" ? "denied" : "expired")) as RequestStatus;
      const footer = ev.resolution ? `${status} by ${ev.resolution.by} (${ev.resolution.mode})${ev.resolution.reason ? `: ${ev.resolution.reason}` : ""}` : undefined;
      const t = this.tracked.get(r.id);
      if (t) {
        const card = NotificationService.renderCard(r, t.nonce, status, footer);
        for (const ref of t.posts) {
          const a = this.adapters.get(ref.conversation.platform);
          await a?.updateCard(ref, card).catch((e) => this.log.warn({ err: e }, "updateCard failed"));
        }
        this.tracked.delete(r.id);
      }
      if (ev.requester_email) {
        for (const a of this.adapters.values()) {
          await a.postCard({ userEmail: ev.requester_email }, NotificationService.renderCard(r, "", status, footer)).catch(() => null);
        }
      }
    }
  }

  private async onClick(c: ButtonClick): Promise<void> {
    const t = this.tracked.get(c.requestId);
    if (c.button === "details") {
      const r = t?.request ?? (await this.broker.getRequest(c.requestId).catch(() => null));
      await c.respond(r ? `Request ${r.id}\n• requester: ${r.user}\n• roles: ${r.roles.join(", ")}\n• reason: ${r.reason}\n• state: ${r.state}\n• expires: ${r.expires}` : "request not found", true);
      return;
    }
    if (!t || t.nonce !== c.nonce) {
      await c.respond("This button is stale. Use `make requests` or ask the assistant for the current state.", true);
      return;
    }
    // Re-verify who clicked: never trust the payload.
    const adapter = this.adapters.get(c.user.platform);
    const fresh = adapter ? await adapter.resolveUser(c.user.platformUserId) : c.user;
    let principal;
    try {
      principal = await this.identity.resolve(fresh);
    } catch (e) {
      await c.respond(`Cannot map you to a Teleport user: ${(e as Error).message}`, true);
      return;
    }
    const approver = { teleport_user: principal.teleportUser, email: principal.email, adapter: c.user.platform, platform_user_id: c.user.platformUserId };
    const reason = c.reason?.trim() || `${c.button}d via ${c.user.platform} by ${principal.teleportUser}`;
    try {
      const r = c.button === "approve" ? await this.broker.approve(c.requestId, approver, reason) : await this.broker.deny(c.requestId, approver, reason);
      await c.respond(`${c.button === "approve" ? "Approved" : "Denied"} request ${r.id.slice(0, 8)}.`, true);
      // The broker will emit request.resolved which updates the cards; update optimistically too.
      const status: RequestStatus = c.button === "approve" ? "approved" : "denied";
      const card = NotificationService.renderCard(r, t.nonce, status, `${status} by ${principal.teleportUser} (chat)`);
      for (const ref of t.posts) await this.adapters.get(ref.conversation.platform)?.updateCard(ref, card).catch(() => undefined);
    } catch (e) {
      if (e instanceof BrokerError) {
        const msg = e.code === "self_approval" ? "You cannot approve your own request." : e.code === "not_approver" ? "You are not an approver for this request." : e.code === "not_pending" ? "This request is no longer pending." : e.message;
        await c.respond(msg, true);
      } else {
        this.log.error({ err: e }, "approval failed");
        await c.respond("Something went wrong talking to the access broker.", true);
      }
    }
  }
}
