/**
 * Google Chat adapter (Google Workspace Chat app).
 * HTTP mode: Chat POSTs events to /gchat/events with a Google-signed JWT (audience = project number);
 * the route only exists when GCHAT_MODE=http. Each bearer JWT is accepted once (jti / token dedupe) and
 * the event's eventTime must be within ±5 minutes.
 * Identity: message.sender.email (Workspace-verified; external users have none -> fail closed), and
 * only from direct-message spaces. Card clicks are accepted from any space but only on cards this
 * process posted, and the clicker is the verified sender of the event that carried the click.
 * Cards: Cards v2 with buttons; CARD_CLICKED events carry requestId/nonce/button parameters.
 */
import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { google, type chat_v1 } from "googleapis";
import type { Config } from "../../config/schema.js";
import type { Logger } from "../../observability/logger.js";
import type { ButtonHandler, ButtonId, ChatAdapter, ChatUser, HttpRoute, MessageHandler, PostedMessageRef, RequestCard, StreamHandle } from "../types.js";

const CHAT_ISSUER = "chat@system.gserviceaccount.com";
export const EVENT_TIME_WINDOW_MS = 5 * 60_000;
export const TOKEN_REPLAY_TTL_MS = 10 * 60_000;
const TOKEN_REPLAY_MAX = 10_000;
const POSTED_CARDS_MAX = 5_000;

export interface VerifiedToken {
  jti?: string;
}
export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

/** Verified sender of the event that carried a click; the only identity a click may claim. */
export interface GchatClickContext {
  verifiedSender: GchatSender;
}
interface GchatSender {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
}

/** Bounded set of recently seen ids with a TTL. */
export class ReplayCache {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs: number, private readonly max: number) {}
  /** True when `id` was already seen within the TTL; records it otherwise. */
  seenBefore(id: string, now = Date.now()): boolean {
    this.sweep(now);
    const at = this.seen.get(id);
    if (at !== undefined && now - at < this.ttlMs) return true;
    this.seen.set(id, now);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return false;
  }
  private sweep(now: number): void {
    for (const [k, t] of this.seen) {
      if (now - t < this.ttlMs) break; // insertion order == time order
      this.seen.delete(k);
    }
  }
}

export function eventTimeFresh(eventTime: unknown, now = Date.now(), windowMs = EVENT_TIME_WINDOW_MS): boolean {
  if (typeof eventTime !== "string") return false;
  const t = Date.parse(eventTime);
  return Number.isFinite(t) && Math.abs(now - t) <= windowMs;
}

function isDmSpace(space: { type?: string; spaceType?: string; singleUserBotDm?: boolean } | undefined): boolean {
  return !!space && (space.type === "DM" || space.spaceType === "DIRECT_MESSAGE" || space.singleUserBotDm === true);
}

export class GoogleChatAdapter implements ChatAdapter {
  readonly name = "gchat" as const;
  private onMsg?: MessageHandler;
  private onBtn?: ButtonHandler;
  private readonly verifyToken: TokenVerifier;
  private readonly replay = new ReplayCache(TOKEN_REPLAY_TTL_MS, TOKEN_REPLAY_MAX);
  private readonly postedCards = new Set<string>();
  private chat!: chat_v1.Chat;
  private spacesByEmail = new Map<string, string>();

  constructor(private readonly cfg: Config, private readonly log: Logger, opts: { verifyToken?: TokenVerifier; now?: () => number } = {}) {
    const verifier = new OAuth2Client();
    this.verifyToken =
      opts.verifyToken ??
      (async (token) => {
        const ticket = await verifier.verifyIdToken({ idToken: token, audience: this.cfg.GCHAT_PROJECT_NUMBER! });
        const p = ticket.getPayload();
        if (p?.iss !== CHAT_ISSUER && p?.email !== CHAT_ISSUER) throw new Error("unexpected issuer");
        return { jti: (p as { jti?: string } | undefined)?.jti };
      });
    this.now = opts.now ?? (() => Date.now());
  }
  private readonly now: () => number;

  onMessage(h: MessageHandler): void {
    this.onMsg = h;
  }
  onButtonClick(h: ButtonHandler): void {
    this.onBtn = h;
  }

  async start(): Promise<void> {
    const creds = JSON.parse(this.cfg.GCHAT_SERVICE_ACCOUNT_JSON!);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/chat.bot"] });
    this.chat = google.chat({ version: "v1", auth });
    this.log.info({ mode: this.cfg.GCHAT_MODE }, "google chat adapter started");
  }
  async stop(): Promise<void> {}

  httpRoutes(): HttpRoute[] {
    if (this.cfg.GCHAT_MODE !== "http") return [];
    return [
      {
        method: "POST",
        path: "/gchat/events",
        handler: async (req) => {
          const authz = (Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization) ?? "";
          const token = authz.replace(/^Bearer\s+/i, "");
          if (!token) return { status: 401, body: { error: "unauthorized" } };
          let verified: VerifiedToken;
          try {
            verified = await this.verifyToken(token);
          } catch (e) {
            this.log.warn({ err: e }, "rejected google chat event: bad token");
            return { status: 401, body: { error: "unauthorized" } };
          }
          const replayKey = verified.jti ?? createHash("sha256").update(token).digest("hex");
          if (this.replay.seenBefore(replayKey, this.now())) {
            this.log.warn("rejected google chat event: replayed token");
            return { status: 401, body: { error: "replay" } };
          }
          const ev = req.body as { eventTime?: unknown } | undefined;
          if (!eventTimeFresh(ev?.eventTime, this.now())) {
            this.log.warn({ eventTime: ev?.eventTime }, "rejected google chat event: eventTime outside window");
            return { status: 401, body: { error: "stale event" } };
          }
          const body = await this.handleEvent(req.body as any);
          return { status: 200, body };
        },
      },
    ];
  }

  /** Returns the synchronous response body (a message/card or {}). Caller must have verified the event. */
  async handleEvent(ev: any): Promise<unknown> {
    if (ev.type === "MESSAGE" && this.onMsg) {
      const sender: GchatSender | undefined = ev.message?.sender ?? ev.user;
      if (sender?.type !== "HUMAN") return {};
      if (!isDmSpace(ev.space)) {
        this.log.warn({ space: ev.space?.name, spaceType: ev.space?.spaceType ?? ev.space?.type }, "ignoring google chat message outside a direct-message space");
        return { text: "Please message me directly; I only handle access questions in a direct message." };
      }
      const user: ChatUser = { platform: "gchat", platformUserId: sender.name ?? "", displayName: sender.displayName ?? sender.name ?? "", email: sender.email ?? null, emailVerified: !!sender.email };
      if (user.email) this.spacesByEmail.set(user.email.toLowerCase(), ev.space?.name);
      const text: string = (ev.message?.argumentText ?? ev.message?.text ?? "").trim();
      const thread: string | undefined = ev.message?.thread?.name;
      const space: string = ev.space?.name;
      let result = "";
      await this.onMsg(
        { id: ev.message?.name ?? `${Date.now()}`, user, conversation: { platform: "gchat", channelId: space, threadId: thread }, text, isDirectMessage: true, mentionedBot: true, receivedAt: new Date() },
        {
          text: async (t) => void (result = t),
          startStream: async (): Promise<StreamHandle> => ({ append: async () => undefined, finish: async (finalText) => void (result = finalText) }),
          card: async (card) => this.postCard({ channel: space }, card) as Promise<PostedMessageRef>,
        },
      );
      // Synchronous reply keeps the thread; Chat expects {text, thread}.
      return { text: result, thread: thread ? { name: thread } : undefined };
    }
    if (ev.type === "CARD_CLICKED" && this.onBtn) {
      const sender: GchatSender | undefined = ev.user;
      const messageName: string | undefined = ev.message?.name;
      const privateReply = (text: string) => ({ actionResponse: { type: "NEW_MESSAGE" }, text, privateMessageViewer: sender?.name ? { name: sender.name } : undefined });
      if (sender?.type !== "HUMAN" || !sender.name) return {};
      if (!messageName || !this.postedCards.has(messageName)) {
        this.log.warn({ message: messageName, space: ev.space?.name }, "ignoring google chat click on a card this agent did not post");
        return privateReply("This card is stale; ask the assistant for the current state.");
      }
      const rawParams: Array<[string, unknown]> = ev.common?.parameters ? Object.entries(ev.common.parameters) : (ev.action?.parameters ?? []).map((p: { key: string; value: unknown }) => [p.key, p.value]);
      const params = Object.fromEntries(rawParams.filter(([, v]) => typeof v === "string")) as Record<string, string>;
      if (!params.requestId || !params.nonce || !["approve", "deny", "details"].includes(params.button ?? "")) return privateReply("This button is malformed.");
      const user: ChatUser = { platform: "gchat", platformUserId: sender.name, displayName: sender.displayName ?? sender.name, email: sender.email ?? null, emailVerified: !!sender.email };
      const reason = ev.common?.formInputs?.reason?.stringInputs?.value?.[0];
      const ctx: GchatClickContext = { verifiedSender: sender };
      let response = "";
      await this.onBtn({
        user,
        button: params.button as ButtonId,
        requestId: params.requestId,
        nonce: params.nonce,
        reason: typeof reason === "string" ? reason : undefined,
        ctx,
        message: { conversation: { platform: "gchat", channelId: ev.space?.name }, messageId: messageName },
        respond: async (t) => void (response = t),
      });
      return privateReply(response);
    }
    if (ev.type === "ADDED_TO_SPACE") return { text: "Hi! Ask me about Teleport access: what you can reach, which role you need, or request a role." };
    return {};
  }

  /**
   * Google Chat has no user lookup for bots; the only trustworthy identity is the verified sender of
   * the event itself, so re-verification means "the click's user is the sender of the signed event".
   */
  async resolveUser(platformUserId: string, ctx?: unknown): Promise<ChatUser> {
    const sender = (ctx as GchatClickContext | undefined)?.verifiedSender;
    if (sender && sender.type === "HUMAN" && sender.name === platformUserId) {
      return { platform: "gchat", platformUserId, displayName: sender.displayName ?? platformUserId, email: sender.email ?? null, emailVerified: !!sender.email };
    }
    return { platform: "gchat", platformUserId, displayName: platformUserId, email: null, emailVerified: false };
  }

  private rememberCard(messageName: string): void {
    this.postedCards.add(messageName);
    while (this.postedCards.size > POSTED_CARDS_MAX) this.postedCards.delete(this.postedCards.values().next().value as string);
  }

  async postCard(target: { channel: string } | { userEmail: string }, card: RequestCard): Promise<PostedMessageRef | null> {
    let space: string | undefined;
    if ("channel" in target) space = target.channel;
    else {
      space = this.spacesByEmail.get(target.userEmail.toLowerCase());
      if (!space) {
        // Create/find the DM space with the user (requires the user to have the app available).
        const r = await this.chat.spaces.findDirectMessage({ name: `users/${target.userEmail}` }).catch(() => null);
        space = r?.data?.name ?? undefined;
      }
    }
    if (!space) return null;
    const r = await this.chat.spaces.messages.create({ parent: space, requestBody: { text: card.title, cardsV2: [renderCardV2(card)] } });
    const messageId = r.data.name ?? "";
    if (messageId) this.rememberCard(messageId);
    return { conversation: { platform: "gchat", channelId: space }, messageId };
  }

  async updateCard(ref: PostedMessageRef, card: RequestCard): Promise<void> {
    await this.chat.spaces.messages.patch({ name: ref.messageId, updateMask: "text,cardsV2", requestBody: { text: card.title, cardsV2: [renderCardV2(card)] } });
  }
}

export function renderCardV2(card: RequestCard): chat_v1.Schema$CardWithId {
  const widgets: chat_v1.Schema$GoogleAppsCardV1Widget[] = Object.entries(card.fields).map(([k, v]) => ({ decoratedText: { topLabel: k, text: v, wrapText: true } }));
  if (card.status === "pending") widgets.push({ textInput: { name: "reason", label: "Reason (optional)", type: "MULTIPLE_LINE" } } as any);
  if (card.footer) widgets.push({ textParagraph: { text: `<i>${card.footer}</i>` } });
  if (card.buttons.length) {
    widgets.push({
      buttonList: {
        buttons: card.buttons.map((b) => ({
          text: b.label,
          ...(b.style === "danger" ? { color: { red: 0.8, green: 0.1, blue: 0.1, alpha: 1 } } : b.style === "primary" ? { color: { red: 0.1, green: 0.5, blue: 0.2, alpha: 1 } } : {}),
          onClick: { action: { function: b.id, parameters: [{ key: "requestId", value: card.requestId }, { key: "nonce", value: card.nonce }, { key: "button", value: b.id }] } },
        })),
      },
    });
  }
  return { cardId: `access-${card.requestId}`, card: { header: { title: card.title, subtitle: card.status }, sections: [{ widgets }] } };
}
