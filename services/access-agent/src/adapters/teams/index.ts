/**
 * Microsoft Teams adapter (Bot Framework CloudAdapter, single-tenant app).
 * Needs a public HTTPS endpoint at POST /api/messages (Azure Bot registration). Identity comes from
 * Teams roster (TeamsInfo.getMember -> email / userPrincipalName, verified by Entra ID).
 * Cards are Adaptive Cards with Action.Execute; refresh via invoke response.
 */
import {
  ActivityTypes,
  CardFactory,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  MessageFactory,
  TeamsInfo,
  TurnContext,
  type Activity,
  type ConversationReference,
  type InvokeResponse,
} from "botbuilder";
import type { Config } from "../../config/schema.js";
import type { Logger } from "../../observability/logger.js";
import type { ButtonHandler, ButtonId, ChatAdapter, ChatUser, HttpRoute, MessageHandler, PostedMessageRef, RequestCard, StreamHandle } from "../types.js";

export class TeamsAdapter implements ChatAdapter {
  readonly name = "teams" as const;
  private readonly adapter: CloudAdapter;
  private onMsg?: MessageHandler;
  private onBtn?: ButtonHandler;
  /** conversation references we have seen, keyed by channel/conversation id — needed for proactive cards */
  private conversations = new Map<string, Partial<ConversationReference>>();
  private userByEmail = new Map<string, { ref: Partial<ConversationReference>; userId: string }>();

  constructor(private readonly cfg: Config, private readonly log: Logger) {
    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: cfg.TEAMS_APP_ID,
      MicrosoftAppPassword: cfg.TEAMS_APP_PASSWORD,
      MicrosoftAppType: "SingleTenant",
      MicrosoftAppTenantId: cfg.TEAMS_TENANT_ID,
    } as any);
    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (_ctx, err) => this.log.error({ err }, "teams turn error");
  }

  onMessage(h: MessageHandler): void {
    this.onMsg = h;
  }
  onButtonClick(h: ButtonHandler): void {
    this.onBtn = h;
  }
  async start(): Promise<void> {
    this.log.info("teams adapter started (expecting POST /api/messages)");
  }
  async stop(): Promise<void> {}

  httpRoutes(): HttpRoute[] {
    return [
      {
        method: "POST",
        path: "/api/messages",
        handler: async (req) => {
          let status = 200;
          let body: unknown;
          // botbuilder expects node req/res; adapt minimally.
          const fakeRes = {
            status: (s: number) => {
              status = s;
              return fakeRes;
            },
            send: (b: unknown) => {
              body = b;
              return fakeRes;
            },
            end: () => fakeRes,
            header: () => fakeRes,
            socket: {},
          };
          await this.adapter.process({ body: req.body, headers: req.headers, method: "POST" } as any, fakeRes as any, (ctx) => this.onTurn(ctx));
          return { status, body };
        },
      },
    ];
  }

  private async onTurn(ctx: TurnContext): Promise<void> {
    const a = ctx.activity;
    const ref = TurnContext.getConversationReference(a);
    this.conversations.set(a.conversation.id, ref);

    if (a.type === ActivityTypes.Message && this.onMsg) {
      const user = await this.resolveUser(a.from.id, ctx);
      if (user.email) this.userByEmail.set(user.email.toLowerCase(), { ref, userId: a.from.id });
      const text = TurnContext.removeRecipientMention(a)?.trim() ?? (a.text ?? "").trim();
      const conversation = { platform: "teams" as const, channelId: a.conversation.id, threadId: a.replyToId ?? a.id, raw: ref };
      let streamedId: string | undefined;
      await this.onMsg(
        { id: a.id ?? `${Date.now()}`, user, conversation, text, isDirectMessage: a.conversation.conversationType === "personal", mentionedBot: true, receivedAt: new Date() },
        {
          text: async (t) => void (await ctx.sendActivity(MessageFactory.text(t))),
          startStream: async (): Promise<StreamHandle> => {
            let buffer = "";
            let last = 0;
            return {
              append: async (d) => {
                buffer += d;
                if (Date.now() - last > 1500) {
                  last = Date.now();
                  if (!streamedId) streamedId = (await ctx.sendActivity(MessageFactory.text(buffer + " …")))?.id;
                  else await ctx.updateActivity({ ...MessageFactory.text(buffer + " …"), id: streamedId } as Partial<Activity>).catch(() => undefined);
                }
              },
              finish: async (finalText) => {
                if (!streamedId) await ctx.sendActivity(MessageFactory.text(finalText));
                else await ctx.updateActivity({ ...MessageFactory.text(finalText), id: streamedId } as Partial<Activity>).catch(() => undefined);
              },
            };
          },
          card: async (card) => {
            const r = await ctx.sendActivity({ attachments: [renderAdaptiveCard(card)] });
            return { conversation, messageId: r?.id ?? "" };
          },
        },
      );
      return;
    }

    if (a.type === ActivityTypes.Invoke && a.name === "adaptiveCard/action" && this.onBtn) {
      const data = (a.value?.action?.data ?? {}) as { requestId: string; nonce: string; button: ButtonId; reason?: string };
      const user = await this.resolveUser(a.from.id, ctx);
      let responseText = "";
      await this.onBtn({
        user,
        button: data.button,
        requestId: data.requestId,
        nonce: data.nonce,
        reason: data.reason,
        message: { conversation: { platform: "teams", channelId: a.conversation.id, raw: ref }, messageId: a.replyToId ?? "" },
        respond: async (t) => void (responseText = t),
      });
      const response: InvokeResponse = { status: 200, body: { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: responseText || "Done." } };
      await ctx.sendActivity({ type: ActivityTypes.InvokeResponse, value: response });
    }
  }

  async resolveUser(platformUserId: string, ctx?: unknown): Promise<ChatUser> {
    if (ctx instanceof TurnContext) {
      try {
        const m = await TeamsInfo.getMember(ctx, platformUserId);
        const email = m.email ?? m.userPrincipalName ?? null;
        return { platform: "teams", platformUserId, displayName: m.name ?? platformUserId, email, emailVerified: !!email, tenantId: m.tenantId };
      } catch (e) {
        this.log.warn({ err: e }, "TeamsInfo.getMember failed");
      }
    }
    return { platform: "teams", platformUserId, displayName: platformUserId, email: null, emailVerified: false };
  }

  async postCard(target: { channel: string } | { userEmail: string }, card: RequestCard): Promise<PostedMessageRef | null> {
    const ref = "channel" in target ? this.conversations.get(target.channel) : this.userByEmail.get(target.userEmail.toLowerCase())?.ref;
    if (!ref) {
      this.log.warn({ target }, "no known Teams conversation for target; the bot must be messaged/installed there first");
      return null;
    }
    let id = "";
    await this.adapter.continueConversationAsync(this.cfg.TEAMS_APP_ID!, ref as ConversationReference, async (ctx) => {
      const r = await ctx.sendActivity({ attachments: [renderAdaptiveCard(card)] });
      id = r?.id ?? "";
    });
    return { conversation: { platform: "teams", channelId: (ref.conversation?.id as string) ?? "", raw: ref }, messageId: id };
  }

  async updateCard(refMsg: PostedMessageRef, card: RequestCard): Promise<void> {
    const ref = (refMsg.conversation.raw as Partial<ConversationReference>) ?? this.conversations.get(refMsg.conversation.channelId);
    if (!ref) return;
    await this.adapter.continueConversationAsync(this.cfg.TEAMS_APP_ID!, ref as ConversationReference, async (ctx) => {
      await ctx.updateActivity({ id: refMsg.messageId, type: ActivityTypes.Message, attachments: [renderAdaptiveCard(card)] } as Partial<Activity>);
    });
  }
}

export function renderAdaptiveCard(card: RequestCard): ReturnType<typeof CardFactory.adaptiveCard> {
  const color = card.status === "pending" ? "Warning" : card.status === "approved" ? "Good" : "Attention";
  return CardFactory.adaptiveCard({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: card.title, weight: "Bolder", size: "Medium", color, wrap: true },
      { type: "FactSet", facts: Object.entries(card.fields).map(([title, value]) => ({ title, value })) },
      ...(card.status === "pending" ? [{ type: "Input.Text", id: "reason", placeholder: "Reason (optional)", isMultiline: true }] : []),
      ...(card.footer ? [{ type: "TextBlock", text: card.footer, isSubtle: true, wrap: true, size: "Small" }] : []),
    ],
    actions: card.buttons.map((b) => ({
      type: "Action.Execute",
      title: b.label,
      verb: b.id,
      style: b.style === "danger" ? "destructive" : b.style === "primary" ? "positive" : "default",
      data: { requestId: card.requestId, nonce: card.nonce, button: b.id },
    })),
  });
}
