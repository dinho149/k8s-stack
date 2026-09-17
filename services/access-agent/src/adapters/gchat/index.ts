/**
 * Google Chat adapter (Google Workspace Chat app).
 * HTTP mode: Chat POSTs events to /gchat/events with a Google-signed JWT (audience = project number).
 * Identity: message.sender.email (Workspace-verified; external users have none -> fail closed).
 * Cards: Cards v2 with buttons; CARD_CLICKED events carry requestId/nonce/button parameters.
 * Proactive posts use a service account with the chat.bot scope.
 */
import { OAuth2Client } from "google-auth-library";
import { google, type chat_v1 } from "googleapis";
import type { Config } from "../../config/schema.js";
import type { Logger } from "../../observability/logger.js";
import type { ButtonHandler, ButtonId, ChatAdapter, ChatUser, HttpRoute, MessageHandler, PostedMessageRef, RequestCard, StreamHandle } from "../types.js";

const CHAT_ISSUER = "chat@system.gserviceaccount.com";

export class GoogleChatAdapter implements ChatAdapter {
  readonly name = "gchat" as const;
  private onMsg?: MessageHandler;
  private onBtn?: ButtonHandler;
  private readonly verifier = new OAuth2Client();
  private chat!: chat_v1.Chat;
  private spacesByEmail = new Map<string, string>();

  constructor(private readonly cfg: Config, private readonly log: Logger) {}

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
    return [
      {
        method: "POST",
        path: "/gchat/events",
        handler: async (req) => {
          const authz = (Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization) ?? "";
          const token = authz.replace(/^Bearer\s+/i, "");
          try {
            const ticket = await this.verifier.verifyIdToken({ idToken: token, audience: this.cfg.GCHAT_PROJECT_NUMBER! });
            if (ticket.getPayload()?.iss !== CHAT_ISSUER && ticket.getPayload()?.email !== CHAT_ISSUER) throw new Error("unexpected issuer");
          } catch (e) {
            this.log.warn({ err: e }, "rejected google chat event");
            return { status: 401, body: { error: "unauthorized" } };
          }
          const body = await this.handleEvent(req.body as any);
          return { status: 200, body };
        },
      },
    ];
  }

  /** Returns the synchronous response body (a message/card or {}). */
  async handleEvent(ev: any): Promise<unknown> {
    if (ev.type === "MESSAGE" && this.onMsg) {
      const sender = ev.message?.sender ?? ev.user;
      if (sender?.type !== "HUMAN") return {};
      const user: ChatUser = { platform: "gchat", platformUserId: sender.name, displayName: sender.displayName ?? sender.name, email: sender.email ?? null, emailVerified: !!sender.email };
      if (user.email) this.spacesByEmail.set(user.email.toLowerCase(), ev.space?.name);
      const text: string = (ev.message?.argumentText ?? ev.message?.text ?? "").trim();
      const thread: string | undefined = ev.message?.thread?.name;
      const space: string = ev.space?.name;
      let result = "";
      await this.onMsg(
        { id: ev.message?.name ?? `${Date.now()}`, user, conversation: { platform: "gchat", channelId: space, threadId: thread }, text, isDirectMessage: ev.space?.type === "DM" || ev.space?.singleUserBotDm === true, mentionedBot: true, receivedAt: new Date() },
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
      const params = Object.fromEntries((ev.common?.parameters ? Object.entries(ev.common.parameters) : (ev.action?.parameters ?? []).map((p: any) => [p.key, p.value])) as Array<[string, string]>);
      const sender = ev.user;
      const user: ChatUser = { platform: "gchat", platformUserId: sender?.name, displayName: sender?.displayName ?? sender?.name, email: sender?.email ?? null, emailVerified: !!sender?.email };
      const reason = ev.common?.formInputs?.reason?.stringInputs?.value?.[0];
      let response = "";
      await this.onBtn({
        user,
        button: params.button as ButtonId,
        requestId: params.requestId,
        nonce: params.nonce,
        reason,
        message: { conversation: { platform: "gchat", channelId: ev.space?.name }, messageId: ev.message?.name },
        respond: async (t) => void (response = t),
      });
      return { actionResponse: { type: "NEW_MESSAGE" }, text: response, privateMessageViewer: sender?.name ? { name: sender.name } : undefined };
    }
    if (ev.type === "ADDED_TO_SPACE") return { text: "Hi! Ask me about Teleport access: what you can reach, which role you need, or request a role." };
    return {};
  }

  async resolveUser(platformUserId: string): Promise<ChatUser> {
    // Google Chat gives the verified email on every event; there is no separate lookup for bots.
    return { platform: "gchat", platformUserId, displayName: platformUserId, email: null, emailVerified: false };
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
    return { conversation: { platform: "gchat", channelId: space }, messageId: r.data.name ?? "" };
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
